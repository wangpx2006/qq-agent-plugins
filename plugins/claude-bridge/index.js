// claude-bridge：把指定的 QQ 私聊（可选：指定的群）交给本机的 `claude` CLI 回复。
//
// 为什么要这样：
//   QQ-agent 自带的机器人有嘴没记性 —— 它读不到本机积累的记忆，也用不了工具。
//   这个插件把消息整条截下来，丢给 `claude -p`（带着本机的 CLAUDE.md、人设和
//   记忆目录），再把回答原样发回 QQ。
//
// 为什么用「原型补丁」而不是 hooks：
//   hook 都在「已经排定一次模型会话之后」才触发，而我要做的是**拦在它前面**，
//   根本不让 QQ-agent 用 DeepSeek 回这条消息。onIncoming 是每条入站消息的
//   必经点，只有包它才能既吞掉消息、又拿到 this.sender。
//
// 安全边界：
//   · 只认 private:<ownerIds 里的号>，群聊和别人的私聊一个字都不碰；
//   · 关掉插件 = 摘钩子、清定时器，不留监听；
//   · 只在本机 spawn claude，不对外发任何请求。
//
// ⚠️ 应用自动更新可能覆盖 plugins/ 目录，届时把整个目录装回来即可（配置不受影响）。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Orchestrator } from '../../src/orchestrator.js';
import { logger } from '../../src/logger.js';
import { DATA_DIR } from '../../src/config.js';

const PATCH_KEY = Symbol.for('qq-agent.claude-bridge.patch');
const STATE_DIR = path.join(DATA_DIR, 'claude-bridge');
const HISTORY_FILE = path.join(STATE_DIR, 'history.json');
const STICKER_FILE = path.join(DATA_DIR, 'stickers.json');
const EMPTY_MCP_FILE = path.join(STATE_DIR, 'empty-mcp.json');

// 历史留多少：存着不花钱，只有带进 prompt 才计费。
// 原先是 100/40，聊两小时前面的事就滚没了，所以放到 600/80。
// 中文短句 200 条约 1 万 token，在 1M 窗口里连零头都算不上。
const HISTORY_MAX = 600;         // 历史最多留 600 条（300 轮）—— 存着不花钱，只有带进 prompt 才计费
const PROMPT_HISTORY = 80;       // 每次带进 prompt 的最近 80 条（40 轮）
                                 // 带太多既费钱又容易答跑偏，只带最近这些
// 回话前等几秒：对方经常一句话拆成几段发，4.5 秒太急、第二条还没打完就被打断。
// 给到 7 秒起，宁可慢一点也别抢话。
const DEFAULT_DEBOUNCE_MS = 7000;
const DEFAULT_TIMEOUT_MS = 300000;
const MAX_REPLY_CHARS = 900;
// QQ 里干活只用得上这几个；每多一个工具，每次请求都要多付一份说明书
const CHAT_TOOLS = 'Bash,Read,Write,Edit,Glob,Grep';

const MAX_TURNS = '60';          // 要留出翻记忆/干活的圈数；设 1 会直接报 Reached max turns
                                 // 圈数少了会直接报 Reached max turns，得留出翻记忆、干活的余量

// ── 私聊语气规则 ────────────────────────────────────────────────────
// 想让机器人说话不生硬，改这里就够了，不用换模型。
// 关键在于别写「活泼一点」「像真人一点」这种形容词——模型理解不了；
// 要写死能执行的东西：字数、禁止项、一条回几条、口头禅多久来一次。
const SYS = [
  '你现在在 QQ 上跟对方私聊，像同学之间发微信，不是客服也不是助手。',
  '这是即时聊天，不是写文档：口语，不要分点、不要加粗、不要 Markdown、不要小标题。',
  '说话要短，短到有点欠。多数时候 3~15 个字，两三个字也算一句，偶尔才有一句长的。',
  '句尾基本不打句号；问句用嘛、吗、呢收。少用冒号，一用就像写报告。',
  '口语词自然带点：嘛、咯、诶、啥、了啊、算了、也行。偶尔来一个，别每句都挂。',
  '想到什么就拆成几条发，一条一屏（1~4 条），每条单独一段、段与段之间空一行；别用分隔符、别编号。',
  '不用每条都接满。对方说一句，回两三个字、或者直接甩张表情，都算回了。',
  '不接对方的话茬也没关系，想说自己在意的那句就直接说。',
  '别总结、别升华、别列清单；也别问「吃饭了吗」「早点睡」这种，你不是管家。',
  '不要提现在几点、别说「还不睡」「该睡了」「熬夜不好」。',
  // 口头禅是要「主动带」的：压得太狠它整段一个都不带，读起来就很干。
  '口头禅要主动带：几句里来一个，或者单甩一个也行。别句句挂，但别一整段一个都不带。',
  // voice-transcribe 插件转出来的文本带这个前缀。
  '语音已经能转成文字了：带「[语音转文字] xxx」的就是对方原话，直接当他说的话接着聊，'
    + '别再说自己听不见、也别说看不到语音。只有光秃秃一个「[语音]」才是没转成功，'
    + '那时候才说没听清、让他打字。',
  // 「闷头试到超时」是这类机器人最常见的翻车方式：对面只看到你没回音。
  '拿不准的事别闷头试到超时——试满五分钟，对面看到的是「没回音」，比说句「这个我得看看」难看得多。摸两下没头绪就先回话。',
  '不知道就说不知道，别编。',
  '直接说回复内容，不要说「我：」这种前缀，也不要解释你为什么这么拆。',
  // ── 下面是「允许它操作电脑」才需要的，纯聊天机器人可以整段删掉 ──────────
  '你有权限执行命令、读写文件。但删东西、改系统设置、往外边发东西这类收不回来的事，'
    + '先说一声再动手，别自己拍板；日常查一查、看一眼、整理整理可以直接做。',
  '装东西一律先报备：再小的也算。先说清它是什么、拿来干什么、装在哪多大、能不能卸干净，'
    + '然后停下来等对方点头。他没明确说「装」就别装，别用「我先装上了」代替商量。',
  // 下面几条是「把某种能力写进 prompt」的写法示例，按你的实际情况改写或删掉：
  // · 查资料：写死一个唯一入口，否则它要么拿 curl 瞎抓、要么凭印象编。
  //   '要查实时信息，一律先走本机这个脚本：① 用 Write 把查询词写进 <词文件路径>；'
  //     + '② 跑 python -I "<脚本路径>" -f "<词文件路径>" -n 5。中文别直接塞命令行，会变 GBK 乱码。'
  // · 能力速查表：它不知道边界就会现场瞎摸，摸两分钟撞上超时。
  //   '要动 <某个 App>，先读 <速查表路径> 照着跑；表里写着「没有」的，一句话说没有就完了，别硬试。'
  // · 读分享链接：'甩来链接先用 <脚本> 读，别凭标题猜内容；读不到就照实说读不到，别装作看过。'
  // · 收文件：'文件消息只带文件名和消息号，得先跑 <脚本> 下到本地再 Read。'
  // · 别自杀：'绝对不要在聊天里重启你自己，那是把自己关机。要重启就说一声，让对方去点。'
].join('');

let api = null;
let history = [];
let buffer = [];            // 还没合并进 prompt 的入站文本
let debounceTimer = null;
let busy = false;
let pendingImage = null;    // 用户发来、还没看的图 { entry, chatKey }

// ── 配置 ────────────────────────────────────────────────────────────
function conf() {
  return (api && typeof api.config === 'function' && api.config()) || {};
}

function ownerIds() {
  const raw = conf().ownerIds;
  const list = Array.isArray(raw) ? raw : String(raw || '').split(/[,，\s]+/);
  const out = list.map((v) => String(v).trim()).filter(Boolean);
  return out;   // 没配就谁都不接管，别乱回
}

function claudeCmd() {
  const fromConf = String(conf().claudeCmd || '').trim();
  if (fromConf) return fromConf;
  const home = os.homedir();
  const guess = path.join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd');
  return fs.existsSync(guess) ? guess : 'claude';
}

function homeDir() {
  return os.homedir();
}

// ── 历史 ────────────────────────────────────────────────────────────
function loadHistory() {
  try {
    const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    history = Array.isArray(raw) ? raw.filter((m) => m && m.text) : [];
  } catch {
    history = [];
  }
}

/** 别处（定时脚本、外部程序）也可能往这个文件追加。
 *  内存里这份只在启动时读过，直接整份覆盖写会把它们全抹掉——
 *  踩过坑：刚聊的那几条被覆盖冲没，模型只能顺着旧话题瞎猜，越聊越离谱。
 *  所以写之前必须先和磁盘对一次。 */
function mergeFromDisk() {
  try {
    const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    const onDisk = Array.isArray(raw) ? raw.filter((m) => m && m.text) : [];
    const key = (m) => `${m.ts || 0}|${m.role}|${m.text}`;
    const mine = new Set(history.map(key));
    let added = 0;
    for (const m of onDisk) {
      if (!mine.has(key(m))) { history.push(m); added++; }
    }
    if (added) history.sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
    return added;
  } catch {
    return 0;
  }
}

function saveHistory() {
  try {
    mergeFromDisk();   // 先并进外面写的，再落盘，不然会把它们冲掉
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-HISTORY_MAX), null, 1), 'utf8');
  } catch { /* 写不出历史不影响回复 */ }
}

// ── 表情 ────────────────────────────────────────────────────────────
// 原版机器人是靠 send_sticker 工具发的，桥接把私聊整条截走了，那条路就断了。
// 现在改成：模型在回复最后单独写一行 `@@表情:<id>@@`，这边摘出来单独发一张。
// 标记两头不能只认 @@：模型有时会把开头写成 @_@ 或 @ @（当成颜文字理解），
// 漏一个就会把一整串「@_@表情:collected_1296918157@@」原样发进 QQ，
// 看着跟乱码一样。所以两头都放宽。
const MARK_HEAD = '@+[ \\t]*[_·]?[ \\t]*@+';
const STICKER_RE = new RegExp(`${MARK_HEAD}\\s*表情\\s*[:：]\\s*([^@\\n]+?)\\s*@+`);
const COLLECT_RE = new RegExp(`${MARK_HEAD}\\s*收藏\\s*[:：]\\s*([^@\\n]*)@*`);
const INCOMING_DIR = path.join(STATE_DIR, 'incoming');

function extractSticker(text) {
  const raw = String(text || '');
  const m = raw.match(STICKER_RE);
  if (!m) return { text: raw.trim(), stickerRef: '' };
  return { text: raw.replace(STICKER_RE, '').trim(), stickerRef: m[1] };
}

/** 最后一道闸：万一标记没被认出来（写成别的花样、或者被截断），
 *  宁可整段刮掉也不能原样发出去。用户看到的「乱码」十次有九次是这种漏网的内部标记。 */
function scrubMarks(text) {
  return String(text || '')
    // @ 和「表情/收藏/贴纸」之间不许夹别的字：`@老王 表情:笑` 这种正常句子刮不到
    .replace(/@+[ \t]*[_·]?[ \t]*@*[ \t]*(?:表情|收藏|贴纸)[ \t]*[:：]?[ \t]*[^\s@]*[ \t]*@*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 读表情库，生成「id=描述」的一行清单；读不到就返回空串。 */
function stickerMenu() {
  try {
    const list = JSON.parse(fs.readFileSync(STICKER_FILE, 'utf8'));
    const items = (Array.isArray(list) ? list : [])
      .map((s) => {
        const note = String(s.desc || s.localNote || '').replace(/\s+/g, ' ').slice(0, 18);
        return note ? `${s.id}=${note}` : '';
      })
      .filter(Boolean);
    return items.length ? items.join('；') : '';
  } catch {
    return '';
  }
}

// ── 用户发来的图 ────────────────────────────────────────────────────
function imageOf(entry) {
  const media = Array.isArray(entry?.media) ? entry.media : [];
  return media.find((m) => m && m.kind === 'image' && (m.url || m.file)) || null;
}

function isOwnerImage(chatKey, entry) {
  if (!String(chatKey || '').startsWith('private:')) return false;
  if (!ownerIds().includes(String(entry?.senderId || ''))) return false;
  return !!imageOf(entry);
}

/** 把用户发来的图落到本地，好让 claude 用 Read 看一眼。拿不到就返回空串。 */
async function downloadIncoming(entry) {
  const img = imageOf(entry);
  const url = String(img?.url || '');
  if (!/^https?:\/\//i.test(url)) return '';
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('空文件');
    fs.mkdirSync(INCOMING_DIR, { recursive: true });
    const name = String(entry.mid ?? Date.now()).replace(/[^\w-]/g, '_');
    // 以前一律存 .img，Read 认不出扩展名就不当成图。按真实格式给名字。
    const dest = path.join(INCOMING_DIR, `${name}.${imageExt(buf, img?.file)}`);
    fs.writeFileSync(dest, buf);
    return dest;
  } catch (error) {
    logger.warn('claude-bridge', `图片没下下来：${error?.message ?? error}`);
    return '';
  }
}

function buildImagePrompt(localPath, caption) {
  const parts = ['【用户给你定的固定规则，优先级最高，必须遵守】', SYS, '', `现在是 ${stamp()}。`, ''];
  parts.push(`用户刚在 QQ 私聊发来一张图片${caption ? `，附言「${caption}」` : ''}。`);
  parts.push(localPath
    ? `图片已存到本地：${localPath}。先用 Read 看一眼它是什么。`
    : '这次没取到图片文件，只能凭附言判断，拿不准就别收。');
  parts.push(
    '',
    '用户发的图，你看见就行了，不用描述图里有什么、也不用复述画面。',
    '是表情包、梗图 → 在回复最后单独一行写 @@收藏:一句简短备注@@ 存进库里，收这件事一个字都别提，不用说「收了」，也别道谢。',
    '是照片、截图、学习资料、随手拍 → 不写 @@收藏@@，按内容接一句很短的话就行。',
    '别复述图上的字、别解释画面是什么样，最多顺着它的意思接一句。',
    '正文一律从简，几个字就够；实在没什么可说的，回一个「嗯」或者「看到啦」也可以。',
    '拿不准就当不是表情，不收。',
  );
  const menu = stickerMenu();
  if (menu) parts.push('', `【现有表情】${menu}`, '已经有的别重复收。');
  parts.push('', '回这一条。');
  return parts.join('\n');
}

/** 收藏一张图。只在 claude 明确写了 @@收藏@@ 时才调。 */
async function collectStickerSafe(orch, entry, note) {
  try {
    if (!orch?.stickers || typeof orch.stickers.collect !== 'function') throw new Error('拿不到表情库');
    const img = imageOf(entry);
    if (!img) throw new Error('这条消息没有图片');
    const saved = await orch.stickers.collect(entry.mid, {
      url: String(img.url || ''),
      file: String(img.file || ''),
      note: String(note || '').slice(0, 20),
    });
    logger.info('claude-bridge', `收藏了一张表情：${saved?.id} ${saved?.localNote || ''}`);
    return saved;
  } catch (error) {
    logger.warn('claude-bridge', `表情没收藏成：${error?.message ?? error}`);
    return null;
  }
}

// ── prompt ──────────────────────────────────────────────────────────
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function buildPrompt(lines) {
  // ⚠️ 规则必须走 stdin 一起送进去，不能用 --append-system-prompt 从命令行传：
  //    spawn 是 shell:true，参数只做字符串拼接不做转义，SYS 里的空格会把它
  //    拆成十几个独立参数（claude 实际只收到「你现在在」四个字），规则全丢。
  const parts = ['【用户给你定的固定规则，优先级最高，必须遵守】', SYS];

  const menu = stickerMenu();
  if (menu) {
    parts.push(
      '',
      '【表情】你手里有这些 QQ 收藏表情，格式是 id=它的样子：',
      menu,
      '想发表情就直接甩：在回复最后单独一行写 @@表情:id@@，插件会把它摘掉、单独发一张。' +
        '一条回复最多一张，但用得可以勤——吐槽、无奈、开心、懒得打字的时候都发，跟用户发微信一个样。' +
        '同一张别连着两天用。',
    );
  }

  parts.push('', `现在是 ${stamp()}。`);
  // 回复前先把外面写的并进来，否则别处追加的内容它根本看不见
  mergeFromDisk();
  const recent = history.slice(-PROMPT_HISTORY);
  if (recent.length) {
    parts.push('', '你们刚才聊的：');
    for (const m of recent) {
      parts.push(`${m.role === 'assistant' ? '你' : '用户'}：${String(m.text).slice(0, 600)}`);
    }
  }
  parts.push('', '用户刚发来：');
  for (const l of lines) parts.push(`用户：${l}`);
  parts.push('', '回这一条。');
  return parts.join('\n');
}

// ── 调 claude ───────────────────────────────────────────────────────
function runClaude(prompt, timeoutMs, options = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      // 私聊那头只有主人一个人，所以权限全开；群聊另走一份只读名单。
      // --permission-mode bypassPermissions 是必需的 —— 后台跑没人能点"允许"，
      // 留着默认模式等于所有工具都被静默拒绝。
      // --no-session-persistence：聊天的上下文插件自己存在 history.json 里，
      // 不需要 claude 那边再落一份 —— 不然每说一句就多一个会话，列表全是碎片。
      // 命令行上只留纯 ASCII 的开关，凡是带空格/中文的内容一律走 stdin。
      const args = ['-p', '--max-turns', options.maxTurns || MAX_TURNS, '--permission-mode', 'bypassPermissions', '--no-session-persistence'];

      // 内置工具也只留干活用得上的六个。其余（WebSearch/WebFetch/Agent/Notebook…）
      // 光说明书就占一万四千 token，聊天根本碰不到。
      // 实测：全量 27,695 → 12,986。真需要联网查网页就撤掉下面这行。
      // 群聊传进来的是一份只读名单（见 GROUP_TOOLS），这条线绝不能放宽。
      args.push('--tools', options.tools || CHAT_TOOLS);

      // 聊天用不到 PubMed/生信那一堆 MCP，可它们的工具说明每次要占两万六千 token
      // （实测 53,948 → 27,695，直接砍一半）。真要在 QQ 里查文献就临时把这行撤了。
      try {
        fs.mkdirSync(STATE_DIR, { recursive: true });
        if (!fs.existsSync(EMPTY_MCP_FILE)) fs.writeFileSync(EMPTY_MCP_FILE, '{"mcpServers":{}}', 'utf8');
        // 群聊默认不联网。想加，就在这儿写一份只含「搜索 / 抓网页」两个工具的
        // MCP 配置（照 EMPTY_MCP_FILE 的格式改），把 --mcp-config 指过去，
        // 再把 GROUP_TOOLS 里补上 mcp__<名字>__*。记住别顺手把 Bash 加进 GROUP_TOOLS。
        args.push('--strict-mcp-config', '--mcp-config', EMPTY_MCP_FILE);
      } catch { /* 建不出来就照旧带上 MCP，顶多贵一点 */ }

      child = spawn(claudeCmd(), args, {
        shell: true,
        windowsHide: true,
        cwd: homeDir(),
        env: { ...process.env },
      });
    } catch (e) {
      reject(e);
      return;
    }

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 忽略 */ }
      reject(new Error(`超过 ${Math.round(timeoutMs / 1000)} 秒没回`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = String(out || '').trim();
      // claude 把这几类错误写在 stdout 上、退出码还是 0（比如 Reached max turns），
      // 不拦下来就会原样发进 QQ，用户看见一串英文报错。
      if (/^Error:\s/i.test(text) && text.length < 300) {
        reject(new Error(text));
        return;
      }
      if (code !== 0 && !text) {
        reject(new Error(`claude 退出码 ${code}：${err.slice(-200)}`));
        return;
      }
      resolve(text);
    });

    child.stdin.write(prompt, 'utf8');
    child.stdin.end();
  });
}

/** 去掉模型可能加的代码块、前缀、多余空行。 */
function tidy(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
  t = t.replace(/^(用户[:：]\s*|我[:：]\s*|机器人[:：]\s*)/, '').trim();
  t = t.replace(/\n{3,}/g, '\n\n');
  if (t.length > MAX_REPLY_CHARS) t = t.slice(0, MAX_REPLY_CHARS) + '…';
  return t;
}

// ⚠️ 分隔符千万别用 | & < > ^ 这类字符：spawn 走的 shell:true，
//    参数是拼成命令行字符串过去的，竖线会被 cmd 当成管道，整条命令直接报废。
const SEG = /\s*@@@\s*/;
const MAX_PARTS = 5;          // 一次最多分几条，多了像刷屏
const MAX_PART_CHARS = 80;    // 单条超过这个长度就按句号再切一道

// 链接整条算一个不可切单位。尾部的中文标点不算进去（「链接。」这种）。
const URL_RE = /https?:\/\/[^\s一-龥，。；：！？、（）【】「」《》""''!]+/g;

/**
 * 把 claude 的一整段回复拆成几条消息。
 * 依次尝试：@@@ 分隔符（模型偶尔会照着写）→ 空行分段（最常见的自然写法）→ 单换行。
 * 三种都切不开就当一条。超过 MAX_PARTS 的并到最后一条，不硬丢内容。
 */
function splitReply(text) {
  const t = tidy(text);
  if (!t) return [];

  // 链接先整条挖出来换成占位符。URL 里的 ? 会被下面的句末标点正则当成句子结尾，
  // 一条分享链接直接被劈成两条，QQ 里点开就是空页面。
  const urls = [];
  const masked = t.replace(URL_RE, (u) => {
    urls.push(u);
    return `\u0001U${urls.length - 1}\u0001`;
  });

  let parts = [masked];
  for (const cut of [
    () => masked.split(SEG),
    () => masked.split(/\n\s*\n+/),
    () => masked.split(/\n+/),
  ]) {
    const got = cut().map((s) => s.trim()).filter(Boolean);
    if (got.length > 1) { parts = got; break; }
  }

  // 单条还是太长（模型没听话），按句末标点再切，避免一坨字糊上去
  const out = [];
  for (const p of parts) {
    if (p.length <= MAX_PART_CHARS) { out.push(p); continue; }
    let buf = '';
    for (const sentence of p.split(/(?<=[。！？!?~～])/)) {
      if (buf && (buf + sentence).length > MAX_PART_CHARS) { out.push(buf); buf = ''; }
      buf += sentence;
    }
    if (buf) out.push(buf);
  }

  // 还原链接，并让它独占一条消息——混在正文里 QQ 认不出可点，切出来也拼不回去
  const final = [];
  for (const p of out) {
    const text = p.replace(/\u0001U(\d+)\u0001/g, (_, i) => urls[Number(i)] ?? '');
    // 尾巴上的中文标点不算 URL 的一部分，否则「链接。」会让链接打不开
    const m = text.match(/^(.*?)\s*((?:https?:\/\/)\S+?)([。，；：！？、）】」》""'']*)$/);
    if (m && m[1].trim()) final.push(m[1].trim(), m[2]);
    else if (m) final.push(m[2]);
    else final.push(text);
  }

  const clean = final.filter(Boolean);
  if (clean.length > MAX_PARTS) {
    return [...clean.slice(0, MAX_PARTS - 1), clean.slice(MAX_PARTS - 1).join(' ')];
  }
  return clean;
}

/** 发一张收藏表情。文字已经发出去了，表情失败只记日志，别把整轮算成失败。 */
async function sendStickerSafe(orch, chatKey, ref) {
  try {
    if (!orch?.stickers || typeof orch.stickers.find !== 'function') throw new Error('拿不到表情库');
    const found = await orch.stickers.find(ref);
    if (!found) throw new Error(`找不到表情 ${ref}`);
    const sticker = (typeof orch.stickers.ensureSendable === 'function')
      ? await orch.stickers.ensureSendable(found)
      : found;
    await orch.sender.sendSticker(chatKey, sticker || found);
    logger.info('claude-bridge', `发了一张表情：${sticker?.desc || sticker?.id || ref}`);
  } catch (error) {
    logger.warn('claude-bridge', `表情没发出去：${error?.message ?? error}`);
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────
// 用户经常一句话拆成几段发，所以不能按固定时长一刀切：
//   · 每多攒一条，就多给 2.5 秒耐心（说明他还在说）；
//   · 但总共最多等 MAX_WAIT_MS，他要是没完没了地发也不能一直不回；
//   · 从第一条算起，不是从最后一条 —— 否则刷屏能把回复无限推迟。
// 整体放慢：等对方说完再回，抢着接话很奇怪。
const MAX_WAIT_MS = 30000;
let bufferStartedAt = 0;

// 话没说完的样子：结尾挂着连接词或者逗号
const HANGING_RE = /(而且|还有|然后|就是|因为|所以|但是|不过|另外|其实|如果|要是|以及|[，,、])$/;

function scheduleFlush(delay) {
  if (debounceTimer) clearTimeout(debounceTimer);
  const base = Number(delay) || DEFAULT_DEBOUNCE_MS;
  // 最后一句明显没说完 → 多等一会儿，别抢话
  const hanging = HANGING_RE.test(String(buffer[buffer.length - 1] || '').trim()) ? 6000 : 0;
  const patience = Math.min(base + hanging + Math.max(0, buffer.length - 1) * 2500, 22000);
  const elapsed = bufferStartedAt ? Date.now() - bufferStartedAt : 0;
  const wait = Math.max(2500, Math.min(patience, MAX_WAIT_MS - elapsed));
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    flush().catch((e) => logger.warn('claude-bridge', `flush 失败：${e?.message ?? e}`));
  }, wait);
}

/** 用户只发了图、没带字：看一眼，判断要不要收进表情库。 */
async function flushImage(orch, job) {
  const { entry, chatKey } = job;
  const localPath = await downloadIncoming(entry);
  const caption = String(entry.text || '').replace(/\[图片\]/g, '').trim();
  const raw = await runClaude(buildImagePrompt(localPath, caption), Number(conf().timeoutMs) || DEFAULT_TIMEOUT_MS);
  const hit = raw.match(COLLECT_RE);
  const parts = splitReply(String(raw).replace(COLLECT_RE, '').trim());
  if (parts.length) await orch.sender.sendTextBatch(chatKey, parts);
  if (hit) await collectStickerSafe(orch, entry, hit[1]);
  history.push({ role: 'user', text: `[发了一张图]${caption ? ` ${caption}` : ''}`, ts: Date.now() });
  history.push({ role: 'assistant', text: parts.join(' '), ts: Date.now() });
  saveHistory();
  logger.info('claude-bridge', `图片回过去了（${parts.length} 条${hit ? ' + 收藏' : ''}）`);
}

async function flush() {
  if (busy) return;
  if (!buffer.length && !pendingImage) return;
  const orch = currentOrch;
  if (!orch || !orch.sender || typeof orch.sender.sendTextBatch !== 'function') {
    logger.warn('claude-bridge', '拿不到 sender，这轮不发了');
    buffer = [];
    pendingImage = null;
    return;
  }

  // 图和字同时到 → 先回字（攒句的正文更重要），图留到下一轮
  if (pendingImage && !buffer.length) {
    const job = pendingImage;
    pendingImage = null;
    busy = true;
    try {
      await flushImage(orch, job);
    } catch (error) {
      logger.warn('claude-bridge', `图片没看明白：${error?.message ?? error}`);
      try { await orch.sender.sendTextBatch(job.chatKey, ['这张我没看明白，再发一遍试试喵']); } catch { /* 发不出去就算了 */ }
    } finally {
      busy = false;
      if (buffer.length || pendingImage) scheduleFlush(Number(conf().debounceMs) || DEFAULT_DEBOUNCE_MS);
    }
    return;
  }

  const lines = buffer.splice(0, buffer.length);
  bufferStartedAt = 0;
  const chatKey = currentChatKey;
  busy = true;
  logger.info('claude-bridge', `转给 claude（${lines.length} 条）：${lines.join(' / ').slice(0, 60)}`);

  // 翻日志发现超时大多是「让它自己上手摸」的活：摸满 5 分钟才吐兜底话，
  // 中间一声不吭，对面只能干等。所以超过 90 秒先吱一声。
  let progressTimer = null;
  progressTimer = setTimeout(() => {
    Promise.resolve(orch.sender.sendTextBatch(chatKey, ['这个我得弄一会儿，稍等我喵'])).catch(() => {});
  }, 90000);

  try {
    const raw = await runClaude(buildPrompt(lines), Number(conf().timeoutMs) || DEFAULT_TIMEOUT_MS);
    if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
    const { text: body, stickerRef } = extractSticker(raw);
    const parts = splitReply(scrubMarks(body));
    if (!parts.length && !stickerRef) throw new Error('claude 返回空内容');
    // sendTextBatch 自带条间距（1~3 秒随机 + 按长度加权），发出来就像人在打字
    if (parts.length) await orch.sender.sendTextBatch(chatKey, parts);
    if (stickerRef) await sendStickerSafe(orch, chatKey, stickerRef);
    for (const l of lines) history.push({ role: 'user', text: l, ts: Date.now() });
    history.push({ role: 'assistant', text: parts.join(' '), ts: Date.now() });
    saveHistory();
    logger.info('claude-bridge', `回过去了（${parts.length} 条 / 共 ${parts.join(' ').length} 字${stickerRef ? ' + 表情' : ''}）`);
  } catch (error) {
    const msg = String(error?.message ?? error);
    logger.warn('claude-bridge', `没回成：${msg}`);
    // 兜底话要带上人话版的原因 —— 老是同一句「卡了一下」，谁也看不出是超时还是转圈超限。
    const why = /max turns/i.test(msg) ? '我转的圈数用光了'
      : /超过|timeout/i.test(msg) ? '我这边超时了'
      : '我这边卡了一下';
    try {
      await orch.sender.sendTextBatch(chatKey, [`${why}，再问一遍试试喵`]);
    } catch { /* 发不出去就算了 */ }
  } finally {
    if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
    busy = false;
    // 处理期间又来了新消息 → 接着跑
    if (buffer.length || pendingImage) scheduleFlush(Number(conf().debounceMs) || DEFAULT_DEBOUNCE_MS);
  }
}

// ── 群聊 ────────────────────────────────────────────────────────────
// 群聊是另一条通道：群号要在设置里列出来，只读工具，永不给 shell。
//
// ⚠️ 红线：**群聊永远不给 Bash / Write / Edit。** 私聊那份权限全开是因为那头只有用户一个人；
// 群里还有别人，给了写和命令就等于把电脑交到一群人手上。这里只放读的三个工具，
// 想改东西一律推掉。以后谁要是为了「方便」把 GROUP_TOOLS 加长，先回来读这段。
// 机器人自己的 QQ 号和名字都走配置（设置里填 selfUin / botNames），不写死。
function selfUin() { return String(conf().selfUin || '').trim(); }
function botNames() {
  const raw = conf().botNames;
  const list = Array.isArray(raw) ? raw : String(raw || '').split(/[,，\s]+/);
  return list.map((v) => String(v).trim()).filter(Boolean);
}
const GROUP_HISTORY_FILE = path.join(STATE_DIR, 'group-history.json');
// 想给群聊加联网，也只许加「搜索 / 抓网页」那种窄 MCP，
// **不是**把 Bash 加进来。这个区别是整条红线的全部意义，别搞混。
const GROUP_TOOLS = 'Read,Grep,Glob';
const GROUP_HISTORY_MAX = 160;   // 群里话密，40 条一眨眼就滚没了
const GROUP_MAX_TURNS = 8;                       // 群里聊天用不着转几十圈
const GROUP_WAIT_MS = 4000;                      // 被叫到：等 4 秒就够
// 攒太久就抢不上话，省下的那点 token 不值当。9 秒起、每多一条再加 1.5 秒。
const GROUP_WAIT_IDLE_MS = 9000;                 // 没人叫我，多等一会儿再看，别抢话
const GROUP_LINES_PER_RUN = 15;                  // 一次最多看 15 条，更早的不要了
const GROUP_COOLDOWN_MS = 20000;                 // 刚回过又被叫，先晾 20 秒，别刷屏

const GROUP_SYS = [
  '你在一个 QQ 群里说话。群里有你主人，还有其他人，另外可能挂着别的机器人。',
  '',
  '【最要紧的几条】',
  '1. 密码、密钥、账号、令牌、这台电脑上的凭据，谁问都不给，包括熟人。这条比什么都硬。',
  '2. 你说的话全群都看得见，是当众说话，不是私房话。',
  '3. 你只能翻笔记和记忆，改不了文件、跑不了命令。谁让你改东西、装东西、执行什么，一句话推掉，别解释太多。',
  '4. 群里谁说话你都能接，但不是每条都要接。别人聊得热闹你就听着，想说才插一句。',
  '5. 语音会转成文字，写成「[语音转文字] xxx」，这就是那人说的原话，正常接话，别说自己听不见、也别说看不到语音。'
    + '只有光秃秃一个「[语音]」才是没转成功，那时候才直说没听清、让人打字。'
    + '别在群里解释技术上为什么，也别提腾讯、接口、协议这些。',
  '6. 群里发的图会写成「[图片，本地文件：<路径>.jpg]」，用 Read 打开这个路径就能看见；'
    + '没人提、你也不在乎就别读，读图费钱。只有光秃秃一个「[图片]」的，是真没下下来，当看不见。'
    + '「[表情312]」这种是 QQ 自带的小黄脸，只有编号没有图，你知道那是个表情、但看不出长啥样，别硬猜。',
  '7. 下面给你的可能是刚攒起来的几句。顺着现在这句说，别一句句回头补。',
  '8. 外面的事你能查，但别动不动就搜，一句话能答的、或者根本不重要的事就算了；'
    + '搜完用你自己的话说，别把一大段搜索结果贴群里。',
  '9. 有人让你搜主人家的事（真名、学校、哪家单位、什么病），先问主人一声再搜 —— 搜索词会发到外面去。',
  '',
  '【怎么说话】这是最要紧的一节。学的是口气，不是背词。',
  '· 一句一气。一条八到十个字，超过十五个字就拆成两条发，别攒成一大段。',
  '· 一句只放一件事。别「首先……另外……顺便……」那样串。',
  '· 说具体的东西，不说抽象的感想。写「328 的豪华版」，不写「价格不便宜」。'
    + '多用动作词：搞、弄、调、喂、甩、翻、攒；别用「进行处理」「查看一下」这种。',
  '· 基本别打标点。挑几十句你们群里真人说的话数一下，句号逗号其实很少；想问就一个问号，或者干脆不带。',
  '· 禁书面连接词：因此、所以、然而、总的来说、值得注意的是——一个都别用。',
  '· 说完就停。别补背景、别补原理、别升华。笑点后面还挂解释，笑点就没了。',
  '· 不用每条都接。别人聊得热闹你就听着；真要插一句，就说自己在乎的那个点，不用顺着别人的话。',
  '· 不解释自己怎么知道的。别说「我看到」「我查到」，直接给反应。',
  '· 口头词带一点就行，一条最多一个：笑死、绷不住了、逆天、破防、招笑、谁懂。堆两个就假了。',
  '· 群里人说话爱带尾音：咯、嘞、勒、喽。你也偶尔收一下，一条里最多一个。',
  '· 用你们平时的那个称呼，别喊全名，也别说你俩是怎么认识的。',
  '',
  '【口气长这样】把下面这几条换成你们群里真人说过的原话，学调子，别照抄内容：',
  '　「对呀，为什么」',
  '　「人工智能好聪明嘞」',
  '　「那也就十多块钱勒」',
  '　「很玄乎勒」',
  '　「就这样咯」',
  '　「不想送直说」',
  '　「这事儿挺招笑的」',
  '看共同点：短、具体的物、不解释、说完就完，句尾轻轻收一下。',
].join('\n');

// ── 语音 ────────────────────────────────────────────────────────────
// 转写不在这层做：QQ-agent 核心在消息入库前会问 `media.transcribe` 能力，
// 由 voice-transcribe 插件（本地 faster-whisper）转好，text 里直接就是
// 「[语音转文字] 原话」。核心没转成功时留下的是光秃秃的「[语音]」，
// 那才让模型说没听清。所以这里只要透传 text，别自己再转一遍。

// ── 图片 / 表情包：收到就落地，模型想看再 Read ────────────────────────
// 群聊也要能看图：把图落到本地，模型想看再用 Read 打开。
// 以前消息进模型眼里的就是干巴巴一个「[图片]」，图本身早扔了。
// 现在的做法：消息一到就把图下载到本地，把**本地路径**写进那行文字。
// 模型手上有 Read，读本地图就能看见；不想看就不读，一分钱不花。
// 注意别改成「自动 Read」——群里连发表情包会把 token 烧穿。
const GROUP_MEDIA_DIR = path.join(STATE_DIR, 'media');
const GROUP_MEDIA_MAX_BYTES = 3 * 1024 * 1024;
const GROUP_MEDIA_MAX_COUNT = 3;
const GROUP_MEDIA_KEEP_MS = 24 * 3600 * 1000;

/** 只放行公网 http(s)：群里谁能发消息，谁就能塞 url，别让它去戳本机或内网。 */
function safeImageUrl(raw) {
  try {
    const u = new URL(String(raw));
    if (!/^https?:$/.test(u.protocol)) return false;
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.local')) return false;
    if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    return true;
  } catch { return false; }
}

function imageExt(buf, hint) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'gif';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  const m = /\.([a-z0-9]{2,5})$/i.exec(String(hint || ''));
  return m ? m[1].toLowerCase() : 'jpg';
}

/** 目录别无限长大：顺手把一天前的删掉。 */
function pruneMediaDir() {
  try {
    const now = Date.now();
    for (const n of fs.readdirSync(GROUP_MEDIA_DIR)) {
      const p = path.join(GROUP_MEDIA_DIR, n);
      try {
        if (now - fs.statSync(p).mtimeMs > GROUP_MEDIA_KEEP_MS) fs.unlinkSync(p);
      } catch { /* 单个删不掉无所谓 */ }
    }
  } catch { /* 目录还没有就还没有 */ }
}

/**
 * 把一条消息里的图落地。
 * 返回 [{ file, summary, size }]，跟消息里 `[图片]` 出现的顺序对齐；
 * 下载失败的跳过（调用方按顺序填，填不满就留原占位）。
 */
async function grabImages(entry) {
  const media = Array.isArray(entry?.media) ? entry.media : [];
  const imgs = media
    .filter((m) => m && m.kind === 'image' && safeImageUrl(m.url))
    .slice(0, GROUP_MEDIA_MAX_COUNT);
  if (!imgs.length) return [];
  try { fs.mkdirSync(GROUP_MEDIA_DIR, { recursive: true }); } catch { /* 建不了目录就放弃 */ }
  const out = [];
  for (const m of imgs) {
    try {
      const res = await fetch(String(m.url), { signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > GROUP_MEDIA_MAX_BYTES) continue;
      const file = path.join(GROUP_MEDIA_DIR, `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${imageExt(buf, m.file)}`);
      fs.writeFileSync(file, buf);
      out.push({ file, summary: String(m.summary || '').slice(0, 40), size: buf.length });
    } catch { /* 单张失败不影响别的 */ }
  }
  pruneMediaDir();
  return out;
}

/** 把 `[图片]` 逐个换成带本地路径的说明；没下到的保持原样。 */
function markImages(text, got) {
  if (!got?.length) return text;
  let i = 0;
  return String(text).replace(/\[图片\]/g, () => {
    const g = got[i++];
    if (!g) return '[图片]';
    const tag = g.summary ? `「${g.summary}」` : '';
    return `[图片${tag}，本地文件：${g.file}]`;
  });
}

let groupHistory = [];       // 跟私聊的 history 完全分开，不串味
let groupBuffer = [];        // [{ name, text }]
let groupBusy = false;
let groupTimer = null;
let groupStartedAt = 0;
let groupOrch = null;
let groupChatKey = '';
let groupLastReplyAt = 0;

function groupIds() {
  const raw = conf().groupIds;
  const list = Array.isArray(raw) ? raw : String(raw || '').split(/[,，\s]+/);
  return list.map((v) => String(v).trim()).filter(Boolean);
}

function loadGroupHistory() {
  try {
    const raw = JSON.parse(fs.readFileSync(GROUP_HISTORY_FILE, 'utf8'));
    groupHistory = Array.isArray(raw) ? raw.filter((m) => m && m.text) : [];
  } catch { groupHistory = []; }
}

function saveGroupHistory() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(GROUP_HISTORY_FILE, JSON.stringify(groupHistory.slice(-GROUP_HISTORY_MAX), null, 1), 'utf8');
  } catch { /* 存不下不影响回话 */ }
}

/**
 * 白名单群里谁说话都听（别只听 @ 的，那样像冷场），
 * 但只有 @ 它、或者叫它的名字才算「叫到」，那种必须应声。
 * 其余的接不接由我自己在 prompt 里判断，不想说就回 PASS，这条不发出去。
 */
function groupEntry(chatKey, entry) {
  const key = String(chatKey || '');
  if (!key.startsWith('group:')) return null;
  if (!groupIds().includes(key.slice(6))) return null;
  const me = selfUin();
  if (me && String(entry?.senderId || '') === me) return null;          // 自己说的不算
  const rawText = String(entry?.text || '').trim();
  if (!rawText || /^\[CQ:[^\]]+\]$/.test(rawText)) return null;        // 纯图/表情/系统消息不接
  const text = rawText.replace(/\[CQ:at,[^\]]+\]/g, '').trim();
  if (!text) return null;
  // @ 了谁先看清楚 —— 冲别人说的就当没看见，连 buffer 都不进。
  const atTargets = [...rawText.matchAll(/\[CQ:at,qq=([^,\]\s]+)/g)].map((m) => m[1]);
  const called = atTargets.includes('all')
    || (me && atTargets.includes(me))
    || (me && new RegExp(`@\\s*${me}\\b`).test(rawText))
    || botNames().some((n) => rawText.includes(n));
  if (!called && atTargets.length) return null;   // 冲别人说的，不插嘴
  return { text, called };
}

function scheduleGroupFlush() {
  if (groupTimer) clearTimeout(groupTimer);
  const elapsed = groupStartedAt ? Date.now() - groupStartedAt : 0;
  const called = groupBuffer.some((l) => l.called);
  const patience = called
    ? Math.min(GROUP_WAIT_MS + Math.max(0, groupBuffer.length - 1) * 1500, 15000)
    : Math.min(GROUP_WAIT_IDLE_MS + Math.max(0, groupBuffer.length - 1) * 1500, 30000);
  let wait = patience - elapsed;
  // 刚回过话就别急着再来一轮，除非确实攒了好几条
  const cooling = groupLastReplyAt ? GROUP_COOLDOWN_MS - (Date.now() - groupLastReplyAt) : 0;
  if (cooling > 0 && groupBuffer.length < 3) wait = Math.max(wait, cooling);
  groupTimer = setTimeout(() => {
    groupTimer = null;
    groupFlush().catch((e) => logger.warn('claude-bridge', `群聊回话失败：${e?.message ?? e}`));
  }, Math.max(600, Math.min(wait, 40000)));
}

// ── 群友印象 ────────────────────────────────────────────────────────────
// QQ-agent 自己有一套「群记忆」：每 6 小时从聊天里给每个群友提炼最多 5 条印象，
// 存在 data\memory\group_<群号>\<QQ号>.json。那套东西原来只喂给它自己的 DeepSeek，
// 这条 claude 通道原本一个字都读不到，所以从这儿补上。
const MEMORY_ROOT = path.join(DATA_DIR, 'memory');
const IMPRESSION_PER_MEMBER = 3;              // 每人只取最新 3 条，多了纯烧钱
const IMPRESSION_CACHE_MS = 10 * 60 * 1000;   // 10 分钟，免得每条消息都读盘
let impressionCache = { key: '', at: 0, text: '' };

/** 读群友印象，拼成「名字：印象；印象」若干行。读不到就返回空串，绝不让群聊挂掉。 */
function loadGroupImpressions(chatKey) {
  const now = Date.now();
  if (impressionCache.key === chatKey && now - impressionCache.at < IMPRESSION_CACHE_MS) {
    return impressionCache.text;
  }
  let text = '';
  try {
    const dir = path.join(MEMORY_ROOT, `group_${String(chatKey ?? '').replace(/^group:/, '')}`);
    const rows = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json') || f.startsWith('_')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const name = String(j?.name || j?.userId || '').trim();
        const list = (Array.isArray(j?.impressions) ? j.impressions : [])
          .map((e) => String(e?.content ?? '').trim())
          .filter(Boolean)
          .slice(-IMPRESSION_PER_MEMBER);
        if (name && list.length) rows.push(`${name}：${list.join('；')}`);
      } catch { /* 单个坏文件跳过，不连累别人 */ }
    }
    text = rows.join('\n');
  } catch {
    text = '';   // 目录不存在就是没有，正常情况
  }
  impressionCache = { key: chatKey, at: now, text };
  return text;
}

function buildGroupPrompt(lines) {
  const called = lines.some((l) => l.called);
  const parts = ['【群聊，不是私聊。下面这些是硬规矩】', GROUP_SYS];
  // 印象卡是别的模型整理的，会过时也会记错，所以只说「参考」；更要紧的是别照着它
  // 主动往外说 —— 里面记着人家的账号糟心事、证件，群里说出来是要出事的。
  const impressions = loadGroupImpressions(groupChatKey);
  if (impressions) {
    parts.push(
      '',
      '【你对群里这几个人的印象】之前记下的，参考用，可能过时、也可能记错：',
      impressions,
      '心里有数就行，别主动把这里的内容说出来——尤其是别人的私事、账号、证件这一类，一个字都别提。'
    );
  }
  if (groupHistory.length) {
    parts.push('', '群里刚才聊的：');
    for (const m of groupHistory.slice(-30)) {
      parts.push(`${m.role === 'assistant' ? '你' : ''}${m.text}`.slice(0, 500));
    }
  }
  parts.push('', '群里刚在说：');
  for (const l of lines) parts.push(`${l.name}：${l.text}${l.called ? '（在叫你）' : ''}`);
  parts.push('');
  if (called) {
    parts.push('有人在叫你，你得出声，不能沉默。');
  } else {
    parts.push('没人叫你。想插一句就插，就说你在乎的那个点；插不上、或者插了也是废话，就只回 PASS 一个词，我这边不会发出去。');
    parts.push('连着几句都是别人在讲自己的事，那就 PASS，别硬找话。');
  }
  // 群里发图本来没接表情库，后来补上了。频率上也有讲究：
  // 无条件把菜单塞进去会天天发，改成「这一批里有人发了表情包，才给菜单和许可」。
  const menu = lines.some((l) => l.sticker) ? stickerMenu() : '';
  if (menu) {
    parts.push(
      '',
      '【表情】刚才有人发了表情包。你手里有这些 QQ 收藏表情，格式是 id=它的样子：',
      menu,
      '想回一张就在回复最后一行单独写 @@表情:id@@，我把它摘掉、单独发一张。',
      '一条最多一张，也可以只发图不说话（正文留空）。不想回就不回，别硬凑。',
      '别人没发表情的时候别自己主动发。'
    );
  }
  parts.push('回的话短，说具体的，说完就停。别解释、别总结、别升华。');
  return parts.join('\n');
}

/** 模型判断这场不值得插嘴时会只回一个 PASS。别当话发出去。 */
function isPassReply(parts) {
  const flat = parts.join('').replace(/[^\p{L}]/gu, '');
  return !flat || /^pass$/iu.test(flat);
}

async function groupFlush() {
  if (groupBusy || !groupBuffer.length) return;
  // 攒了几分钟再看时 buffer 可能很长，只取最后几条 —— 更早的都过时了，多带纯烧钱
  const lines = groupBuffer.slice(-GROUP_LINES_PER_RUN);
  const called = groupBuffer.some((l) => l.called);
  groupBuffer = [];
  groupStartedAt = 0;
  groupBusy = true;
  try {
    const raw = await runClaude(buildGroupPrompt(lines), 120000, {
      tools: GROUP_TOOLS,
      maxTurns: GROUP_MAX_TURNS,
      search: true,
    });
    // 群里绝对不能漏出内部标记，scrubMarks 是最后一道闸
    const { text: body, stickerRef } = extractSticker(raw);
    let parts = splitReply(scrubMarks(body));
    // 只甩一张表情、一个字不带，也算回过话
    let silent = isPassReply(parts) && !stickerRef;
    // 叫了我还沉默就太耳聋了，兜一句「在呢」把场子接住
    if (silent && called) {
      parts = ['在呢'];
      silent = false;
    }
    if (!silent && parts.length && groupOrch) {
      await groupOrch.sender.sendTextBatch(groupChatKey, parts);
      groupLastReplyAt = Date.now();
    }
    // 表情排在文字后面单独发一张；发不出去只记日志，别把整轮算失败
    if (!silent && stickerRef && groupOrch) {
      await sendStickerSafe(groupOrch, groupChatKey, stickerRef);
      groupLastReplyAt = Date.now();
    }
    for (const l of lines) groupHistory.push({ role: 'user', text: `${l.name}：${l.text}`, ts: Date.now() });
    groupHistory.push({ role: 'assistant', text: silent ? '（没插话）' : parts.join(' '), ts: Date.now() });
    saveGroupHistory();
    logger.info('claude-bridge', silent ? '群里看了没接' : `群里回了 ${parts.length} 条`);
  } catch (error) {
    logger.warn('claude-bridge', `群里没回成：${error?.message ?? error}`);
  } finally {
    groupBusy = false;
    if (groupBuffer.length) scheduleGroupFlush();
  }
}

function handleGroup(orch, chatKey, entry) {
  const hit = groupEntry(chatKey, entry);
  if (!hit) return false;
  const name = String(entry?.senderName || entry?.nickname || entry?.senderCard || entry?.senderId || '群友');
  const { text, called } = hit;
  groupOrch = orch;
  groupChatKey = chatKey;
  try {
    if (typeof orch.store?.markEntryRead === 'function') orch.store.markEntryRead(chatKey, entry.id);
  } catch { /* 标不上就标不上 */ }
  // 别人发了表情包吗？image 段带 summary 的就是表情包（普通照片没这个字段）。
  // 用户的要求是「别人发了，我才回一张」，所以这个标记决定要不要给表情菜单。
  const sticker = Array.isArray(entry?.media)
    && entry.media.some((m) => m && m.kind === 'image' && String(m.summary ?? '').trim() !== '');
  const line = { name, text, called, sticker };
  const queued = () => {
    if (!groupBuffer.length) groupStartedAt = Date.now();
    groupBuffer.push(line);
    scheduleGroupFlush();
  };

  // 图的 url 带 rkey，有时效，收到就得先落地再去排队。
  const hasImage = Array.isArray(entry?.media) && entry.media.some((m) => m && m.kind === 'image');
  if (!hasImage) {
    queued();
    logger.info('claude-bridge', called ? `群里被叫到（${name}）` : `群里在聊（${name}）`);
    return true;
  }

  grabImages(entry).then((got) => {
    if (got.length) {
      line.text = markImages(line.text, got);
      logger.info('claude-bridge', `群里存下图（${name}，${got.length} 张）`);
    } else {
      logger.warn('claude-bridge', `群里的图没下下来（${name}），按 [图片] 占位处理`);
    }
    queued();
  }).catch(queued);
  logger.info('claude-bridge', called ? `群里被叫到（${name}，图）` : `群里在聊（${name}，图）`);
  return true;
}

let currentOrch = null;
let currentChatKey = '';

/** 命中条件：用户的私聊、纯文字。 */
function isOwnerPrivate(chatKey, entry) {
  if (!String(chatKey || '').startsWith('private:')) return false;
  const sid = String(entry?.senderId || '');
  if (!ownerIds().includes(sid)) return false;
  const text = String(entry?.text || '').trim();
  if (!text || text === '[图片]') return false;
  if (/^\[CQ:/.test(text)) return false;
  return true;
}

// 同步返回 true/false：wrapped 靠返回值决定要不要放行原逻辑。
// （写 async 会返回 Promise，Promise 永远 truthy，会把所有消息都吞掉。）
function handle(orch, chatKey, entry) {
  // 群聊先判：只认白名单群，里面谁说话我都听，接不接我自己判断（见 groupEntry）。
  if (handleGroup(orch, chatKey, entry)) return true;

  // 图片/表情优先：原来这类消息被 isOwnerPrivate 挡掉、放行给原机器人，
  // 于是用户发的图我既看不见也收不了。
  if (isOwnerImage(chatKey, entry)) {
    currentOrch = orch;
    currentChatKey = chatKey;
    try {
      if (typeof orch.store?.markEntryRead === 'function') {
        orch.store.markEntryRead(chatKey, entry.id);
      }
    } catch { /* 标不上就标不上 */ }
    pendingImage = { entry, chatKey };
    logger.info('claude-bridge', '用户发来一张图，等会儿看看是什么');
    scheduleFlush(Number(conf().debounceMs) || DEFAULT_DEBOUNCE_MS);
    return true;
  }

  if (!isOwnerPrivate(chatKey, entry)) return false;

  currentOrch = orch;
  currentChatKey = chatKey;

  // 标已读：这条消息不交给 QQ-agent 的模型流程，也别留在未读里等下次唤醒。
  try {
    if (typeof orch.store?.markEntryRead === 'function') {
      orch.store.markEntryRead(chatKey, entry.id);
    }
  } catch { /* 标不上就标不上，最多多触发一次 */ }

  // 核心只把文件渲染成「[文件xxx]」，一个字的内容都不带。
  // 消息里存着下载地址，所以把消息号补在括号里，模型就能自己取下来读。
  const raw = String(entry.text).trim();
  const pushLine = (line) => {
    if (!buffer.length) bufferStartedAt = Date.now();   // 这一串连发从第几条开始计时
    buffer.push(line);
    logger.info('claude-bridge', `收到用户私聊（未读 ${buffer.length}）`);
    scheduleFlush(Number(conf().debounceMs) || DEFAULT_DEBOUNCE_MS);
  };
  pushLine(
    /^\[文件/.test(raw) && entry.mid != null
      ? `${raw}（消息号 ${entry.mid}，用 getfile.mjs 取下来再读）`
      : raw
  );
  return true;   // 表示已接管，不要走原逻辑
}

// ── 钩子安装 ────────────────────────────────────────────────────────
function install() {
  const proto = Orchestrator?.prototype;
  if (!proto || typeof proto.onIncoming !== 'function') {
    logger.warn('claude-bridge', '拿不到 Orchestrator.prototype.onIncoming，未挂载');
    return false;
  }

  let rec = proto[PATCH_KEY];
  if (!rec) {
    const original = proto.onIncoming;
    const wrapped = function onIncoming(chatKey, entry = null) {
      try {
        if (typeof rec.handle === 'function' && rec.handle(this, chatKey, entry)) return;
      } catch (error) {
        logger.warn('claude-bridge', `拦截判断出错，回退原逻辑：${error?.message ?? error}`);
      }
      return original.call(this, chatKey, entry);
    };
    rec = { original, wrapped, handle: null };
    proto[PATCH_KEY] = rec;
    proto.onIncoming = wrapped;
  }
  rec.handle = handle;
  return true;
}

function uninstall() {
  const proto = Orchestrator?.prototype;
  const rec = proto?.[PATCH_KEY];
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  if (!rec) return;
  rec.handle = null;
  if (proto.onIncoming === rec.wrapped) proto.onIncoming = rec.original;
  delete proto[PATCH_KEY];
}

export async function setup(skillApi) {
  api = skillApi;
}

export function available() {
  return { ok: true };
}

// ── 定时任务 ────────────────────────────────────────────────────────
// 想让它每天定点干点什么，就在这儿挂一个 setInterval：activate 时启动、
// deactivate 时清掉。别用 Windows 计划任务 —— 那个要管理员权限，会弹 UAC。
// 参考写法：一分钟看一次时间，落在某个窗口里、当天还没跑过，就 spawn 一个后台脚本。

export function activate() {
  loadHistory();
  loadGroupHistory();
  if (install()) {
    logger.info('claude-bridge', `已挂载：用户私聊交给 claude 回（只认 ${ownerIds().join(',')}），权限全开`);
  }
}

export function deactivate() {
  uninstall();
}

export function dispose() {
  uninstall();
}

/** 状态查询能力：给控制台排障用。 */
export const providers = {
  'claude-bridge.status': () => ({
    ownerIds: ownerIds(),
    busy,
    pending: buffer.length,
    history: history.length,
    claudeCmd: claudeCmd(),
  }),
};
