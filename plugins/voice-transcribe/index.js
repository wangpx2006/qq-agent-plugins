/**
 * voice-transcribe —— 让机器人听得懂 QQ 语音。
 *
 * ── 背景 ──────────────────────────────────────────────────────────────
 * QQ 自带的语音转文字在这套协议端上是坏的：OneBot 的 message_id 是哈希合成的，
 * 不是 QQ 真实 msgId，服务端拿它查不到这条语音，请求发出即被拒。
 * 但语音文件本身拿得到 —— `get_record` + `out_format=wav` 会返回完整音频。
 * 所以这里换一条路：拿音频 → 本机 faster-whisper 识别 → 喂给模型。
 *
 * ── 结构 ──────────────────────────────────────────────────────────────
 *   index.js      这个文件：注册 `media.transcribe` 能力，管服务的生死
 *   asr_server.py 常驻的 HTTP 服务（127.0.0.1:18791），模型只在首次请求时加载
 *   models/       模型文件（独立下载，不碰 BiliNote 那份）
 *
 * 注册的是能力而不是工具：src/onebot.js 的 segmentsToText 遇到 record 段会
 * 主动找 `media.transcribe` 的提供者。插件关掉 = 没有提供者 = 退回 `[语音]`
 * 占位，核心代码一行都不用改，也不会因为识别失败打断消息入库。
 *
 * ── 失败策略 ──────────────────────────────────────────────────────────
 * 任何一步失败（服务起不来 / 取音频失败 / 识别超时）都返回 null，
 * 上层照常显示 `[语音]`，绝不抛错。
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = path.join(__dirname, 'asr_server.py');
const DEFAULT_PORT = 18791;

let cfg = () => ({});
let log = () => {};
let warn = () => {};

let child = null;          // 自己拉起来的 python 进程
let starting = null;       // 启动中的 Promise，避免并发重复 spawn
let lastFailAt = 0;        // 上次启动失败时间，用于退避

function settings() {
  const s = (typeof cfg === 'function' ? cfg() : null) || {};
  return {
    enabled: s.enabled !== false,
    port: Number(s.port) || DEFAULT_PORT,
    python: String(s.pythonPath || '').trim() || 'python',
    model: String(s.model || 'small').trim(),
    language: String(s.language || 'zh').trim(),
    timeoutMs: Math.max(5000, Number(s.timeoutMs) || 60000),
    debug: s.debug === true
  };
}

function dbg(...a) {
  if (settings().debug) {
    try { log('[voice-transcribe]', ...a); } catch { /* ignore */ }
  }
}

// ── 与服务通信 ────────────────────────────────────────────────────────────

function request(method, urlPath, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: settings().port,
      path: urlPath,
      method,
      timeout: timeoutMs,
      headers: body
        ? { 'Content-Type': 'application/octet-stream', 'Content-Length': Buffer.byteLength(body) }
        : {}
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error(`返回不是 JSON：${raw.slice(0, 120)}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function ping(timeoutMs = 1500) {
  try {
    const r = await request('GET', '/health', null, timeoutMs);
    return r?.ok === true;
  } catch {
    return false;
  }
}

/** 保证服务在跑。返回 true 表示可以用了。 */
async function ensureServer() {
  if (await ping()) return true;
  if (starting) return starting;
  // 5 秒内刚失败过就别再拉，避免每条语音都白等一轮
  if (Date.now() - lastFailAt < 5000) return false;

  starting = (async () => {
    const s = settings();
    dbg('拉起本地识别服务', s.python, SERVER_SCRIPT);
    try {
      child = spawn(s.python, [SERVER_SCRIPT], {
        cwd: __dirname,
        env: {
          ...process.env,
          ASR_PORT: String(s.port),
          ASR_MODEL: s.model,
          ASR_LANG: s.language,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUNBUFFERED: '1'
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      child.stdout.on('data', (b) => dbg('py:', String(b).trim()));
      child.stderr.on('data', (b) => {
        const t = String(b).trim();
        if (t) dbg('py err:', t);
      });
      child.on('exit', (code) => {
        dbg('识别服务退出', code);
        child = null;
      });

      // 首次可能要下载模型（几百兆），给足够长的等待窗口
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        if (await ping(1000)) return true;
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error('启动超时');
    } catch (e) {
      lastFailAt = Date.now();
      warn('[voice-transcribe] 识别服务起不来：', e?.message ?? e);
      stopServer();
      return false;
    } finally {
      starting = null;
    }
  })();
  return starting;
}

function stopServer() {
  if (!child) return;
  try { child.kill(); } catch { /* ignore */ }
  child = null;
}

// ── 能力：语音转文字 ──────────────────────────────────────────────────────

/**
 * @param {{record: object, onebot: object}} args record 是 OneBot 的 record 段 data
 * @returns {Promise<{ok: boolean, text?: string}|null>} 失败一律 null
 */
async function transcribe({ record, onebot } = {}) {
  if (!settings().enabled) return null;
  if (!record || !onebot) return null;

  try {
    const audio = await fetchAudio(record, onebot);
    if (!audio || !audio.length) {
      dbg('拿不到音频', record?.file);
      return null;
    }
    const up = await ensureServer();
    if (!up) return null;

    const r = await request('POST', '/transcribe', audio, settings().timeoutMs);
    const text = String(r?.text ?? '').trim();
    if (!r?.ok) {
      dbg('识别失败', r?.error);
      return null;
    }
    if (!text) {
      dbg('识别结果为空（可能是纯噪音/纯音乐）');
      return null;
    }
    dbg(`识别 ${audio.length}B → ${r.ms}ms：${text.slice(0, 40)}`);
    return { ok: true, text };
  } catch (e) {
    dbg('转写异常', e?.message ?? e);
    return null;
  }
}

/** 取语音文件：优先协议端 get_record，失败再退回 record.url 直链。 */
async function fetchAudio(record, onebot) {
  const file = record.file || record.path || '';
  if (file) {
    try {
      const r = await onebot.call('get_record', { file, out_format: 'wav' }, 30000);
      const b64 = r?.base64 || r?.data?.base64 || '';
      if (b64) return Buffer.from(b64, 'base64');
    } catch (e) {
      dbg('get_record 失败，尝试直链', e?.message ?? e);
    }
  }
  const url = record.url || record.file_url || '';
  if (url) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      dbg('直链下载失败', e?.message ?? e);
    }
  }
  return null;
}

// ── 生命周期 ──────────────────────────────────────────────────────────────

export function setup(api) {
  cfg = api.config;
  log = api.log;
  warn = api.warn;
  // 提前把服务拉起来，别等第一条语音进来才现加载模型
  setTimeout(() => { ensureServer().catch(() => {}); }, 3000);
  log('[voice-transcribe] 已加载，识别服务端口', settings().port);
}

export function deactivate() {
  stopServer();
}

export function dispose() {
  stopServer();
}

export function available() {
  return { ok: true };
}

export const providers = {
  'media.transcribe': transcribe
};
