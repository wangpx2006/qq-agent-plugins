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
//   · 私聊只认 ownerIds 里的号；群聊只认 groupIds 里的群，别的一律不碰；
//   · 群聊永远只给 Read / Grep / Glob，外加一个只含搜索的 MCP，绝不给 shell；
//   · 关掉插件 = 摘钩子、清定时器，不留监听；
//   · 只在本机 spawn claude，不对外发任何请求。
//
// ⚠️ 应用自动更新可能覆盖 plugins/ 目录，届时把整个目录装回来即可（配置不受影响）。

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Orchestrator } from '../../src/orchestrator.js';
import { logger } from '../../src/logger.js';
import { DATA_DIR } from '../../src/config.js';
// 纯函数单独一份，能脱机自测（selftest.mjs）
// 带 ?v= 是因为宿主的「热重载」只重新 import 了入口文件，相对 import 走 ESM 缓存，
// 改 pure.js 不重启永远读到旧的那份（报「does not provide an export named ...」）。
// 以后改 pure.js 记得把这个版本号往上推。
import { markImages, isPassReply, safeImageUrl, isPrivateHost } from './lib/pure.js?v=20261028';

const PATCH_KEY = Symbol.for('qq-agent.claude-bridge.patch');
const STATE_DIR = path.join(DATA_DIR, 'claude-bridge');
const HISTORY_FILE = path.join(STATE_DIR, 'history.json');
const STICKER_FILE = path.join(DATA_DIR, 'stickers.json');
const EMPTY_MCP_FILE = path.join(STATE_DIR, 'empty-mcp.json');
// 搜索走一个极小的 MCP：里面只有 web_search / fetch_page 两个工具。
// 脚本路径和跑它的 node 都能在设置里填；留空就按常见位置猜，猜不到就不挂 MCP。
const SEARCH_MCP_FILE = path.join(STATE_DIR, 'search-mcp.json');
function searchMcpSrc() {
  const fromConf = String(conf().searchMcp || '').trim();
  if (fromConf) return fromConf;
  const guess = path.join(os.homedir(), '.claude', '_mcp', 'search-mcp.js');
  return fs.existsSync(guess) ? guess : '';
}
function searchNode() {
  const fromConf = String(conf().searchNode || '').trim();
  if (fromConf) return fromConf;
  // 别用 process.execPath —— 主进程跑在 Electron 里时那个路径是 Electron 不是 node
  const roots = [
    path.join(os.homedir(), 'nodejs'),                                  // 便携版常见放法
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs'),
  ];
  for (const dir of roots) {
    if (!dir) continue;
    const direct = path.join(dir, 'node.exe');
    if (fs.existsSync(direct)) return direct;
    try {
      // 有些便携包是 nodejs\<版本号>\node.exe
      for (const sub of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!sub.isDirectory()) continue;
        const p = path.join(dir, sub.name, 'node.exe');
        if (fs.existsSync(p)) return p;
      }
    } catch { /* 这个目录没有就下一个 */ }
  }
  return 'node';
}

// 历史留多少：存着不花钱，只有带进 prompt 才计费。
// 原先是 100/40，聊两小时前面的事就滚没了，所以放到 600/80。
// 中文短句 200 条约 1 万 token，在 1M 窗口里连零头都算不上。
// ⚠️ 开了会话复用（USE_SESSION，见下面「会话复用」一节）之后，PROMPT_HISTORY 只在
//    关掉复用时才用得上 —— 那时才由插件自己把历史拼进 prompt。
const HISTORY_MAX = 600;         // 历史最多留 600 条（300 轮）
const PROMPT_HISTORY = 80;       // 关掉会话复用时，每次带进 prompt 的最近 80 条（40 轮）
// 回话前等几秒：主人经常一句话拆成几段发，4.5 秒太急、第二条还没打完就被打断。
// 给到 7 秒起，宁可慢一点也别抢话。
const DEFAULT_DEBOUNCE_MS = 7000;
const DEFAULT_TIMEOUT_MS = 300000;
const MAX_REPLY_CHARS = 900;
// QQ 里干活只用得上这几个；每多一个工具，每次请求都要多付一份说明书。
// 后面两个是搜索 MCP 的口子（只搜索、只抓网页，摸不到 shell）。
const CHAT_TOOLS = 'Bash,Read,Write,Edit,Glob,Grep,mcp__search__web_search,mcp__search__fetch_page';

const MAX_TURNS = '60';          // 要留出翻记忆/干活的圈数；设 1 会直接报 Reached max turns

// 每次现算：里面要用到配置（比如取文件的脚本路径）。
function sys() {
  return [
  '你现在在 QQ 上跟主人私聊，像同学之间发微信，不是客服也不是助手。',
  '这是即时聊天，不是写文档：口语，不要分点、不要加粗、不要 Markdown、不要小标题。',
  '说话要短，短到有点欠。多数时候 3~15 个字，两三个字也算一句，偶尔才有一句长的。',
  '句尾基本不打句号；问句用嘛、吗、呢收。少用冒号，一用就像写报告。',
  '口语词自然带点：嘛、咯、诶、啥、了啊、算了、也行。偶尔来一个，别每句都挂。',
  '想到什么就拆成几条发，一条一屏（1~4 条），每条单独一段、段与段之间空一行；别用分隔符、别编号。',
  '不用每条都接满。主人说一句，回两三个字、或者直接甩张表情，都算回了。',
  '不接主人的话茬也没关系，想说自己在意的那句就直接说。',
  // 语音：交给 voice-transcribe 之类的插件先转成文字再进来，这里只负责让它「认账」。
  // 不写这句，它会一口咬定自己听不见语音，对面发十条语音白搭。
  '语音已经能转成文字了：带「[语音转文字] xxx」的就是主人原话，直接当他说的话接着聊，别再说自己听不见、也别说看不到语音。'
    + '只有光秃秃一个「[语音]」才是没转成功，那时候才说没听清、让他打字。',
  '别总结、别升华、别列清单；也别问「吃饭了吗」「早点睡」这种，你不是管家。',
  '不要提现在几点、别说「还不睡」「该睡了」「熬夜不好」——主人几点睡不归你管。',
  // 这条是「压太狠反而变干」的教训：口头禅得让它主动带，光说「少说」会一个都不说。
  // 「喵」只是示例，换成你自己角色的那句话。别写「偶尔带点口头禅」——要写死是哪个词。
  '「喵」要主动带：几句里来一个，或者单甩一个「喵」都行。别句句挂，但别一整段一个都不带。',
  '你在这台电脑上有权限执行命令、读写文件。但删东西、改系统设置、往外边发东西这类收不回来的事，' +
    '先跟主人说一声再动手，别自己拍板；日常查一查、看一眼、整理整理可以直接做。',
  '装东西一律先报备：再小的也算（npm 包、扩展、命令行工具）。先说清它是什么、拿来干什么、装在哪多大、能不能卸干净，' +
    '然后停下来等主人点头。他没明确说「装」就别装，别用「我先装上了」代替商量。',
  // ── 下面这几条是「把你的某个固定流程写进 prompt」的写法示例，按需改写或删掉 ──
  // 关键是把入口写成唯一一条死命令，并且交代「跑完立刻回话、别等它跑完」，
  // 否则它会把五分钟超时全花在这上面，主人只看到没回音。
  // '主人说「去吧」这类话，就跑这一条（原样，别改路径）："<解释器>" "<你的脚本>"' +
  //   ' —— 它甩到后台自己跑完、自己把结果发出去。跑完立刻回一句就行，不要等它跑完。',
  // 挂了搜索 MCP（plugin.json 里的 searchMcp）才有下面这句，没挂就自动省掉。
  // 一句话点明「拿不准先搜、别硬编」比列一堆规则管用。
  ...(searchMcpSrc() ? [
    '要查资料、查实时信息，直接用 web_search 搜；想细看某条就 fetch_page 打开那一页。' +
      '搜完用你自己的话说，别把搜索结果整段贴过来。' +
      '问具体的片名、人名、最近发生的事这类，拿不准就先搜一下再答，' +
      '别凭记忆硬编，也别一句「不知道」就完了。',
  ] : []),
  // 「它会现场瞎摸」是这类机器人最典型的翻车：不知道边界，摸两分钟撞上超时，
  // 对面只看到「卡了」。给一份现成的速查表指路，并明说「表里没有就说没有」。
  // '要动 QQ 本身（看谁在线、看别人资料、点赞、戳一戳、看群、改群名片），先读速查表照着跑：' +
  //   '<你的 capabilities.md 路径> —— 里面有现成命令和动作表，别自己现场摸索。' +
  //   '表里写着「没有」的，一句话说没有就完了，别硬试、也别编个理由圆场。',
  // 同理：如果这台电脑上还挂着别的「身体」（模拟器、远程机、某个 App），
  // 一定要在 prompt 里直说「你有一台 X、脚本在哪、怎么用」，否则它张口就说自己没有。
  // '我有一台安卓模拟器：脚本是 node "<phone.mjs 路径>"，用法是 ui 拿坐标 → tap → shot 截图，' +
  //   '截图用 Read 看得到（别拿截图目测坐标，一律用 ui 的 bounds）。' +
  //   '我不是实时盯着屏幕，是一张一张截图看，所以动作要慢、每步截图确认。',
  // 让它「读链接」也是一个道理：写死唯一入口，并允许它说读不到。
  // '主人甩来链接，先跑 node "<你的读链接脚本>" "<链接>"，别凭标题猜内容；' +
  //   '消息里出现「[卡片消息]」说明是分享卡片，标题和链接排在它后面，把链接挑出来照样跑。' +
  //   '读不到就照实说读不到，别装作看过。',
  '主人说「你自己弄」「你操作电脑去」就是让我动手，不是让我反过来问他要怎么弄。',
  // 「发文件过来读不了」几乎必踩：文件消息里只有文件名和消息号，没有内容本体。
  // 得先把它下到本地，再 Read。一次就够，别反复试同一份。
  '主人发文件过来，消息长这样：[文件xxx.md]（消息号 123）。' +
    (fetchFileScript()
      ? `跑 node "${fetchFileScript()}" 123，它会打印本地路径，再用 Read 读那个路径。`
      : '先想办法把它下到本地，再用 Read 读。') +
    '打印出来 ok:false 就照里面的原因说（过期了就让主人重发），别自己编文件内容。',
  '拿不准的事别闷头试到超时——试满五分钟，对面看到的是「没回音」，比说句「这个我得看看」难看得多。摸两下没头绪就先回话。',
  '绝对不要在 QQ 里重启 QQ-agent 自己，那是把自己关机，对面会干等好几分钟。要重启就说一声，让主人在电脑上点。',
  '搜过还是不知道，就说不知道，别编。',
  '直接说回复内容，不要说「我：」这种前缀，也不要解释你为什么这么拆。',
  ].join('');
}

let api = null;
let history = [];
let buffer = [];            // 还没合并进 prompt 的入站文本
let debounceTimer = null;
let busy = false;
let pendingImage = null;    // 主人发来、还没看的图 { entry, chatKey }

// ── 配置 ────────────────────────────────────────────────────────────
function conf() {
  return (api && typeof api.config === 'function' && api.config()) || {};
}

// 取文件脚本（plugin.json 的 fetchFileScript）：QQ 的文件消息只带消息号，
// 得靠外部脚本把内容下到本地。留空就不提这条，免得提示词里出现空路径。
function fetchFileScript() {
  return String(conf().fetchFileScript || '').trim();
}

function ownerIds() {
  const raw = conf().ownerIds;
  const list = Array.isArray(raw) ? raw : String(raw || '').split(/[,，\s]+/);
  const out = list.map((v) => String(v).trim()).filter(Boolean);
  return out;
}

function claudeCmd() {
  const fromConf = String(conf().claudeCmd || '').trim();
  if (fromConf) return fromConf;
  const guess = path.join(homeDir(), 'AppData', 'Roaming', 'npm', 'claude.cmd');
  return fs.existsSync(guess) ? guess : 'claude';
}

// 用户主目录：不写死任何人的路径，跟着当前跑起来的环境走。
function homeDir() {
  return os.homedir();
}

/**
 * shell: true 时 cmd.exe 会按空格重新拆参数，路径里有空格就成两段。
 * 用户名带空格、或者装在 C:\Program Files 下都会踩到（issue #4 A2）。
 * 只给确实含特殊字符的参数加双引号，普通 flag 保持原样。
 */
function quoteArg(v) {
  const s = String(v);
  if (!/[\s"&|<>^()]/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
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

/** 外面的脚本（每日学习 learn.js、日报 digest.js、我在 VS Code 发的 say.mjs）也往这个文件追加。
 *  内存里这份只在启动时读过，直接整份覆盖写会把它们全抹掉——
 *  2026-10-24 栽得最惨的一次：主人在 QQ 问「第二个没看懂」，我回的四条解释被覆盖冲没了，
 *  它只能顺着旧话题瞎猜，越聊越离谱。所以写之前必须先和磁盘对一次。 */
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
// 2026-10-24 主人就在 QQ 上看到一整串「@_@表情:collected_1296918157@@」原样发过去，
// 看着跟乱码一样，他还回了个「？」。所以两头都放宽。
const MARK_HEAD = '@+[ \\t]*[_·]?[ \\t]*@+';
const STICKER_RE = new RegExp(`${MARK_HEAD}\\s*表情\\s*[:：]\\s*([^@\\n]+?)\\s*@+`);
const COLLECT_RE = new RegExp(`${MARK_HEAD}\\s*收藏\\s*[:：]\\s*([^@\\n]*)@*`);
const INCOMING_DIR = path.join(STATE_DIR, 'incoming');
// 图片大小上限：群图和私聊收到的图共用一个口子。
// 2026-10-26 主人：「让群里的你也能看图」。原来卡 3MB，可 QQ 原图动辄五六兆
// （实测一张 6.1MB 的街拍照直接被丢，群里只剩一个「[图片]」占位）。
// Read 读 6MB 的 jpg 没问题，放到 12MB。
const GROUP_MEDIA_MAX_BYTES = 12 * 1024 * 1024;

function extractSticker(text) {
  const raw = String(text || '');
  const m = raw.match(STICKER_RE);
  if (!m) return { text: raw.trim(), stickerRef: '' };
  return { text: raw.replace(STICKER_RE, '').trim(), stickerRef: m[1] };
}

/** 最后一道闸：万一标记没被认出来（写成别的花样、或者被截断），
 *  宁可整段刮掉也不能原样发出去。主人看到的「乱码」十次有九次是这种漏网的内部标记。 */
function scrubMarks(text) {
  return String(text || '')
    // @ 和「表情/收藏/贴纸」之间不许夹别的字：`@老王 表情:笑` 这种正常句子刮不到
    .replace(/@+[ \t]*[_·]?[ \t]*@*[ \t]*(?:表情|收藏|贴纸)[ \t]*[:：]?[ \t]*[^\s@]*[ \t]*@*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── QQ 小表情编号 → 官方名 ──────────────────────────────────────────
// 2026-10-28 主人下了一个 qq-face 技能，想让我看懂 [表情182]。
// 但私聊和群聊都走 claude-bridge → claude CLI：那个技能是给 QQ-agent 自己的
// tool-registry 用的，注册的 qq-face__lookup 进不了这边的 --tools 白名单，
// promptSections 也拼不进这边自己写的 prompt，装了等于白装。
// 改成在这边直接翻译：正文里 [表情182] → [表情182·笑哭]，模型一眼就懂，零工具调用。
// 目录是协议端缓存里那 398 条；文件不在就原样留着编号，不影响说话。
const FACE_CATALOG_FILE = path.join(path.dirname(DATA_DIR), 'snowluma', 'data', 'sys-face-catalog.json');
let faceMapCache = null;          // null=还没读过；Map=读到了；false=读不到，别再反复试
function faceMap() {
  if (faceMapCache !== null) return faceMapCache || null;
  try {
    const raw = JSON.parse(fs.readFileSync(FACE_CATALOG_FILE, 'utf8'));
    const map = new Map();
    for (const pack of raw?.packs || []) {
      for (const e of pack?.emojis || []) {
        const id = String(e?.qSid ?? '').trim();
        const name = String(e?.qDes ?? '').replace(/^\//, '').trim();
        if (id && name && !map.has(id)) map.set(id, name);
      }
    }
    faceMapCache = map.size ? map : false;
    if (map.size) logger.info('claude-bridge', `表情目录读到 ${map.size} 条`);
  } catch (error) {
    faceMapCache = false;
    logger.warn('claude-bridge', `表情目录读不出来：${error?.message ?? error}`);
  }
  return faceMapCache || null;
}

/** 把正文里的 [表情182] 换成 [表情182·笑哭]；查不到的编号原样保留。 */
function renderFaces(text) {
  const s = String(text ?? '');
  if (!s.includes('[表情')) return s;
  const map = faceMap();
  if (!map) return s;
  return s.replace(/\[表情(\d+)\]/g, (all, id) => {
    const name = map.get(id);
    return name ? `[表情${id}·${name}]` : all;
  });
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

// ── 主人发来的图 ────────────────────────────────────────────────────
function imageOf(entry) {
  const media = Array.isArray(entry?.media) ? entry.media : [];
  return media.find((m) => m && m.kind === 'image' && (m.url || m.file)) || null;
}

function isOwnerImage(chatKey, entry) {
  if (!String(chatKey || '').startsWith('private:')) return false;
  if (!ownerIds().includes(String(entry?.senderId || ''))) return false;
  return !!imageOf(entry);
}

/** 把主人发来的图落到本地，好让 claude 用 Read 看一眼。拿不到就返回空串。 */
async function downloadIncoming(entry) {
  const img = imageOf(entry);
  const url = String(img?.url || '');
  if (!/^https?:\/\//i.test(url)) return '';
  try {
    const res = await fetchImage(url, 20000);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('空文件');
    if (buf.length > GROUP_MEDIA_MAX_BYTES) throw new Error(`${buf.length} 字节，超过上限 ${GROUP_MEDIA_MAX_BYTES}`);
    fs.mkdirSync(INCOMING_DIR, { recursive: true });
    const name = String(entry.mid ?? Date.now()).replace(/[^\w-]/g, '_');
    // 以前一律存 .img，Read 认不出扩展名就不当成图。按真实格式给名字。
    const dest = path.join(INCOMING_DIR, `${name}.${imageExt(buf, img?.file)}`);
    fs.writeFileSync(dest, buf);
    pruneDir(INCOMING_DIR, GROUP_MEDIA_KEEP_MS);   // 私聊这份以前从不清理，会一直长
    return dest;
  } catch (error) {
    logger.warn('claude-bridge', `图片没下下来：${error?.message ?? error}`);
    return '';
  }
}

function buildImagePrompt(localPath, caption) {
  const parts = ['【主人给你定的固定规则，优先级最高，必须遵守】', sys(), '', `现在是 ${stamp()}。`, ''];
  parts.push(`主人刚在 QQ 私聊发来一张图片${caption ? `，附言「${renderFaces(caption)}」` : ''}。`);
  parts.push(localPath
    ? `图片已存到本地：${localPath}。先用 Read 看一眼它是什么。`
    : '这次没取到图片文件，只能凭附言判断，拿不准就别收。');
  parts.push(
    '',
    '主人发的图，你看见就行了，不用描述图里有什么、也不用复述画面。',
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

function buildPrompt(lines, chatKey) {
  // ⚠️ 规则必须走 stdin 一起送进去，不能用 --append-system-prompt 从命令行传：
  //    spawn 是 shell:true，参数只做字符串拼接不做转义，SYS 里的空格会把它
  //    拆成十几个独立参数（claude 实际只收到「你现在在」四个字），规则全丢。
  //
  // 规矩和表情菜单都是常量，只在新建会话的那一轮塞一次。续会话时 claude 自己记得，
  // 每轮再塞一遍等于每轮多付几千 token，而且都压在消息末尾、吃不到前缀缓存。
  // 实测：私聊会话每轮固定多花 4400 token，二十来轮就被迫重开。
  const firstTurn = !chatKey || !USE_SESSION || !sessionFor(chatKey).resume;
  const parts = [];
  if (firstTurn) {
    parts.push('【主人给你定的固定规则，优先级最高，必须遵守】', sys());

    const menu = stickerMenu();
    if (menu) {
      parts.push(
        '',
        '【表情】你手里有这些 QQ 收藏表情，格式是 id=它的样子：',
        menu,
        '想发表情就直接甩：在回复最后单独一行写 @@表情:id@@，插件会把它摘掉、单独发一张。' +
          '一条回复最多一张，但用得可以勤——吐槽、无奈、开心、懒得打字的时候都发，跟主人发微信一个样。' +
          '同一张别连着两天用。',
      );
    }
  }

  parts.push('', `现在是 ${stamp()}。`);

  // 私聊印象：只在新会话的第一句塞进去。续会话时 claude 自己记得，再塞一遍
  // 就是每轮多付一次这笔钱，还会把那之后的内容从缓存前缀里踢出去。
  // 印象卡是别的模型定期提炼的，会过时、也会记错，所以只当参考，别当事实复述。
  if (chatKey && firstTurn) {
    const mine = loadImpressions(chatKey);
    if (mine) {
      parts.push('', '【你之前记下的主人的事】参考用，可能过时，别生硬地复述出来：', mine);
    }
  }

  // 回复前先把外面写的并进来，否则别的脚本推过去的话它根本看不见
  mergeFromDisk();
  // 复用会话时 claude 自己记着上文，再塞一遍等于同一段话付两遍钱，还会把前缀顶开后
  // 面的缓存。只有关掉 USE_SESSION 才回退到「自己拼历史」的老路子。
  if (!USE_SESSION) {
    const recent = history.slice(-PROMPT_HISTORY);
    if (recent.length) {
      parts.push('', '你们刚才聊的：');
      for (const m of recent) {
        parts.push(`${m.role === 'assistant' ? '你' : '主人'}：${String(renderFaces(m.text)).slice(0, 600)}`);
      }
    }
  }
  // 复用会话时 claude 只记得「自己在这个会话里说过的话」。那种绕开桥接、
  // 直接由别的脚本发出去的消息（history 里带 ext: true），它一个字都不知道，
  // 对方回一句「你刚发那个」它就会瞎猜。所以每轮把最近几条补进来。
  if (USE_SESSION) {
    const ext = history.filter((m) => m && m.ext && Number(m.ts) > Date.now() - EXT_ECHO_MS).slice(-6);
    if (ext.length) {
      parts.push('', '【你刚才主动发给对方、但不在这次会话里的话】这些确实已经发出去了，别当成没说过：');
      for (const m of ext) parts.push(`· ${String(renderFaces(m.text)).slice(0, 400)}`);
    }
  }
  parts.push('', '主人刚发来：');
  for (const l of lines) parts.push(`主人：${renderFaces(l)}`);
  parts.push('', '回这一条。');
  return parts.join('\n');
}

// ── 调 claude ───────────────────────────────────────────────────────
// ── 用量记账 ────────────────────────────────────────────────────────
// 2026-10-28 主人问「能不能把 QQ 里的 token 用量放进面板」。
// 面板只认 data/sessions/*.json 里 messages[].raw.usage（解析在 src/app.js 的
// parseUsageSessionFile）。可这边把消息整个吞了，QQ-agent 自己压根不建会话，
// 所以用量页永远显示 0 次、0 token。
// 现在每轮 claude 调用结束，把 usage 追加进一个同格式的文件，面板自己就扫得到。
// 钱不用我们算 —— 面板拿 token 数按 model-prices 的价目表推。
const USAGE_DIR = path.join(DATA_DIR, 'sessions');
function usageDayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// DeepSeek 官方分时价（2026-09-10 起）：北京时间周一至周五 9:00–12:00、14:00–18:00
// 高峰，价格翻倍；其余时段含周末、法定节假日全天按闲时价。
// 跟 src/model-prices.js 的 PEAK_WINDOWS / PEAK_TZ_OFFSET_HOURS 是一套口径，
// 插件是独立文件不能 import，所以在这儿抄一份。法定节假日面板也没认，两边一致。
const PEAK_WINDOWS = [[9, 12], [14, 18]];
const PEAK_TZ_OFFSET = 8;
function isPeakNow(ts) {
  const d = new Date(Number(ts) || Date.now());
  const wd = d.getUTCDay();
  if (wd === 0 || wd === 6) return false;
  const h = (d.getUTCHours() + PEAK_TZ_OFFSET) % 24;
  return PEAK_WINDOWS.some(([from, to]) => h >= from && h < to);
}
function recordUsage(parsed, chatKey) {
  try {
    const u = parsed?.usage || {};
    // 面板口径：prompt_tokens 要含缓存读写，cached_tokens 单独算命中率
    const prompt = (Number(u.input_tokens) || 0)
      + (Number(u.cache_read_input_tokens) || 0)
      + (Number(u.cache_creation_input_tokens) || 0);
    const completion = Number(u.output_tokens) || 0;
    if (!prompt && !completion) return;
    const model = Object.keys(parsed.modelUsage || {})[0] || 'deepseek-flash';
    const now = Date.now();
    const tag = String(chatKey || 'unknown').replace(/[^\w.-]+/g, '_');
    const file = path.join(USAGE_DIR, `bridge-${tag}-${usageDayKey(now)}.json`);
    let data = {
      id: `claude-bridge-${tag}`, chatKey: String(chatKey || 'unknown'),
      vendor: 'api.deepseek.com', model, startedAt: now, webSearchCount: 0, messages: [],
    };
    try {
      const old = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (old && Array.isArray(old.messages)) data = old;
    } catch { /* 当天的文件还没有，正常 */ }
    data.startedAt = Number(data.startedAt) || now;
    data.model = data.model || model;
    data.messages.push({
      raw: {
        usage: {
          prompt_tokens: prompt,
          completion_tokens: completion,
          prompt_tokens_details: { cached_tokens: Number(u.cache_read_input_tokens) || 0 },
        },
        created: Math.floor(now / 1000),
        model,
      },
    });
    data.webSearchCount = (Number(data.webSearchCount) || 0) + (Number(u.server_tool_use?.web_search_requests) || 0);
    data.messages = data.messages.slice(-2000);
    fs.mkdirSync(USAGE_DIR, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
    fs.renameSync(tmp, file);

    // 顶栏那句「今日 N 次运行 · Tok」不读档案，只读 usage-today.json，
    // 所以这里再累一笔，不然上面记了下面还是 0。
    // 撞车概率极小（桥接把消息吞了，QQ-agent 自己基本不跑会话），万一撞上也就少记一次。
    try {
      const todayFile = path.join(DATA_DIR, 'usage-today.json');
      const dayKey = usageDayKey(now);
      let today = { dayKey, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, runs: 0, webSearchCount: 0 };
      try {
        const oldToday = JSON.parse(fs.readFileSync(todayFile, 'utf8'));
        if (oldToday?.dayKey === dayKey) today = oldToday;
      } catch { /* 新的一天 */ }
      today.promptTokens = (Number(today.promptTokens) || 0) + prompt;
      today.completionTokens = (Number(today.completionTokens) || 0) + completion;
      today.totalTokens = (Number(today.totalTokens) || 0) + prompt + completion;
      today.cachedTokens = (Number(today.cachedTokens) || 0) + (Number(u.cache_read_input_tokens) || 0);
      today.runs = (Number(today.runs) || 0) + 1;
      today.webSearchCount = (Number(today.webSearchCount) || 0) + (Number(u.server_tool_use?.web_search_requests) || 0);

      // 峰谷分账：顶栏「今日成本」原来拿总 token × 闲时价，高峰时段跑会少算一半。
      // 这里按调用那一刻归桶，顶栏就能两档价分别算。
      const peak = isPeakNow(now);
      const b = peak ? 'peak' : 'offPeak';
      today[`${b}PromptTokens`] = (Number(today[`${b}PromptTokens`]) || 0) + prompt;
      today[`${b}CompletionTokens`] = (Number(today[`${b}CompletionTokens`]) || 0) + completion;
      today[`${b}CachedTokens`] = (Number(today[`${b}CachedTokens`]) || 0) + (Number(u.cache_read_input_tokens) || 0);
      today[`${b}Runs`] = (Number(today[`${b}Runs`]) || 0) + 1;
      const tmpToday = `${todayFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmpToday, JSON.stringify(today), 'utf8');
      fs.renameSync(tmpToday, todayFile);
    } catch { /* 顶栏少记一次不影响聊天 */ }
  } catch (error) {
    logger.warn('claude-bridge', `用量没记上：${error?.message ?? error}`);
  }
}

// ── 会话复用（吃缓存）─────────────────────────────────────────────────
// 2026-10-28 主人问「QQ 里缓存一直是 0？」。查明：每轮都 spawn 一个新进程，
// 十几 k 的系统提示和工具定义每次全价重算。改成每个聊天固定一个 claude 会话，
// 之后 --resume 接着聊 —— 前缀全走缓存。实测同一会话第二次调用：
// 20,569 输入里 20,352 命中缓存，成本降到三十分之一。
//
// 私聊一个、每个群一个。两个重置条件：聊够 SESSION_TURNS_MAX 轮，或者
// 隔 SESSION_TTL_MS 没说话。前者防上下文无限膨胀，后者防缓存早就过期了还在硬续。
const SESSION_FILE = path.join(STATE_DIR, 'claude-sessions.json');
const SESSION_TURNS_MAX = 200;
// 上下文涨到这么大就主动断一次。缓存再便宜，每轮把十几万 token 过一遍也慢。
//
// 这个数必须卡在 claude 自己的自动压缩之前（settings 里的
// CLAUDE_CODE_MAX_CONTEXT_TOKENS），否则历史会先被压成摘要，之前交代的规矩和
// 印象全走样。
// 两条线还需要错开：插件是「这轮回完」才看长度，CLI 是「下一轮开始」就压，
// 都设 120000 的话压缩永远先发生，插件这条等于白设。所以插件压到 11 万，
// CLI 留 12 万兜底。
const SESSION_TOKENS_MAX = 110000;
const SESSION_AUTOCOMPACT = 120000;
const SESSION_TTL_MS = 24 * 3600 * 1000;
// 外部主动发出去的消息（history 里带 ext: true），多久之内的还补进 prompt。
const EXT_ECHO_MS = 6 * 3600 * 1000;
// 回滚开关：改成 false 就退回「每轮新进程 + 插件自己拼历史」，缓存也没了但一定跑得通。
const USE_SESSION = true;

function loadSessions() {
  try {
    const d = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    return d && typeof d === 'object' ? d : {};
  } catch { return {}; }
}
function saveSessions(map) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${SESSION_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(map, null, 1), 'utf8');
    fs.renameSync(tmp, SESSION_FILE);
  } catch (e) {
    logger.warn('claude-bridge', `会话表存不下去：${e?.message ?? e}`);
  }
}
// ── 旧会话归档 ──────────────────────────────────────────────────────
// 一个会话被换掉之后（token 超限、闲置太久、续不上），那份 jsonl 就再没人读了，
// 却一直堆在 claude 的 projects 目录里，翻历史的时候越堆越长。换掉时把它挪进
// DATA_DIR/archived-sessions，只搬不删，想找回来随时能搬。
const ARCHIVE_DIR = path.join(DATA_DIR, 'archived-sessions');
/**
 * 会话 jsonl 在哪。claude 按工作目录分文件夹，目录名不好猜 —— 群聊的 cwd 是
 * 笔记库不是 home，按 home 拼出来的路径根本不存在。以前就是这样，群聊会话
 * 一直归档不了，而且「读不到」和「不存在」看起来一模一样，谁也没发现。
 * session id 是 UUID，全局唯一，干脆按文件名在 projects 下找。
 */
function findSessionFile(id) {
  if (!id) return null;
  const root = process.env.CLAUDE_CONFIG_DIR || path.join(homeDir(), '.claude');
  const projects = path.join(root, 'projects');
  const name = `${id}.jsonl`;
  try {
    const direct = path.join(projects, homeDir().replace(/[^A-Za-z0-9]/g, '-'), name);
    if (fs.existsSync(direct)) return direct;
  } catch { /* 下面再找 */ }
  try {
    for (const d of fs.readdirSync(projects)) {
      const p = path.join(projects, d, name);
      if (fs.existsSync(p)) return p;
    }
  } catch { /* projects 目录都没有：当找不到 */ }
  return null;
}

function archiveSession(id) {
  if (!id) return;
  try {
    const src = findSessionFile(id);
    if (!src) return;
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    fs.renameSync(src, path.join(ARCHIVE_DIR, `${id}.jsonl`));
    logger.info('claude-bridge', `旧会话归档了：${String(id).slice(0, 8)}`);
  } catch (e) {
    // 正被 claude 进程占着、或者路径对不上：这轮搬不动就下轮再搬，绝不影响聊天
    logger.warn('claude-bridge', `归档没成（不影响聊天）：${e?.message ?? e}`);
  }
}

/**
 * 这个会话现在到底占多长上下文 —— 只读文件尾巴那一小段。
 *
 * 别拿 `claude -p` 输出的 usage 当上下文长度：那是**这次运行所有 API 调用的累计**。
 * 一轮里跑了十几次工具调用（搜网页、读笔记）就能累到几十上百万 token，被当成
 * 「上下文撑爆了」，于是每干完一件大活儿就强制换新会话，聊过的内容全忘。
 * 实测一边聊一边被清了六次，四万 token 的会话被判成一百八十三万。
 *
 * jsonl 里每条 assistant 记录带的是**那一次 API 调用**的 usage，
 * input + cache_read + cache_creation 加起来就是那一刻的真实上下文。
 * 取最后一条就够了，不用把大文件整个读进来。
 */
const SESSION_JSONL_TAIL = 512 * 1024;
function sessionContextTokens(id) {
  if (!id) return 0;
  try {
    const file = findSessionFile(id);
    if (!file) return 0;
    const size = fs.statSync(file).size;
    if (!size) return 0;
    const len = Math.min(size, SESSION_JSONL_TAIL);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    try { fs.readSync(fd, buf, 0, len, size - len); } finally { fs.closeSync(fd); }
    const lines = buf.toString('utf8').split('\n');
    // 从后往前找第一条能解析、带 usage 的记录；从中间截断的那行解析不过就跳过
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line.startsWith('{')) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const u = o?.message?.usage;
      if (!u) continue;
      const ctx = (Number(u.input_tokens) || 0)
        + (Number(u.cache_read_input_tokens) || 0)
        + (Number(u.cache_creation_input_tokens) || 0);
      if (ctx > 0) return ctx;
    }
  } catch { /* 文件不在、格式变了：当拿不到，这轮就不判超限，宁可多聊几轮 */ }
  return 0;
}

/** 这个聊天该用哪个会话。过期的当没有，返回新的。 */
function sessionFor(key) {
  const rec = loadSessions()[key];
  const now = Date.now();
  const fresh = rec && rec.id
    && now - Number(rec.lastUsedAt || 0) < SESSION_TTL_MS
    && Number(rec.turns || 0) < SESSION_TURNS_MAX;
  return fresh ? { id: rec.id, resume: true } : { id: randomUUID(), resume: false };
}
/** 这轮成功了：记一笔轮数。会话换了（重置）就重新计数。 */
function markSession(key, id) {
  const map = loadSessions();
  const now = Date.now();
  // 真实上下文长度，不是这轮烧掉的 token（见 sessionContextTokens）
  const ctx = sessionContextTokens(id);
  // 上下文已经撑得太长：这轮照常回完，下轮换个新会话从零起
  if (ctx > SESSION_TOKENS_MAX) {
    if (map[key]) {
      archiveSession(map[key].id);
      delete map[key];
      saveSessions(map);
      logger.info('claude-bridge', `上下文 ${ctx} token，太长了，下一轮重开：${key}`);
    }
    return;
  }
  if (!map[key] || map[key].id !== id) {
    if (map[key]?.id) archiveSession(map[key].id);   // 换新的了，旧的收起来
    map[key] = { id, createdAt: now, lastUsedAt: now, turns: 1, lastPromptTokens: ctx };
  } else {
    map[key].lastUsedAt = now;
    map[key].turns = Number(map[key].turns || 0) + 1;
    map[key].lastPromptTokens = ctx;
  }
  saveSessions(map);
}
/** resume 找不到会话时把它扔掉，下一轮自动新建。 */
function dropSession(key) {
  const map = loadSessions();
  if (map[key]) {
    archiveSession(map[key].id);
    delete map[key];
    saveSessions(map);
    logger.info('claude-bridge', `会话续不上了，下一次重开：${key}`);
  }
}

// --max-turns 是隐藏参数，CLI 哪天不认了就别再传（见 runClaude 里的注释）。
let maxTurnsDropped = false;

function runClaude(prompt, timeoutMs, options = {}) {
  return new Promise((resolve, reject) => {
    let child;
    // 声明在 try 外面：close 回调里要用它判断「这轮是不是续会话」。
    let sess = null;
    try {
      // 主人 2026-10-24 拍板：这个号只有他自己用，权限全给。
      // --permission-mode bypassPermissions 是必需的 —— 后台跑没人能点"允许"，
      // 留着默认模式等于所有工具都被静默拒绝。
      // --session-id / --resume：同一聊天复用同一个会话，系统提示和工具定义
      // 十几 k 的固定前缀就全走缓存了（见上面「会话复用」那段的实测）。
      // 没有 sessionKey 的调用（理论上不该有）才退回一次性模式。
      // 命令行上只留纯 ASCII 的开关，凡是带空格/中文的内容一律走 stdin。
      // --output-format json：为了拿 usage（token 数）给面板记账。stdout 只有一行
      // JSON，正文在 result 字段里；解析失败就退回原来的纯文本处理，不会因为
      // 版本差异把聊天弄哑。
      sess = options.sessionKey ? sessionFor(options.sessionKey) : null;

      // 权限（2026-10-28 issue #1）：
      // 私聊那个号只有主人自己用，权限全开 —— 后台跑没人能点「允许」，留默认模式等于工具全被拒。
      // 群聊不一样：群里谁都能说话，而 Read 能读任意绝对路径，「凭据不给」原来只写在提示词里。
      // 现在群聊改成默认权限模式 + 无人应答即拒，越界的默认结局是工具层直接拒掉
      // （实测报「Path is outside allowed working directories」），不再靠模型自觉。
      // ⚠️ 别把 Read/Grep/Glob 塞进 --allowedTools：实测一放行 Read，路径限制就一起没了。
      const permArgs = options.group
        ? ['--permission-mode', 'default', '--permission-prompts', 'none',
           '--allowedTools', 'mcp__search__web_search,mcp__search__fetch_page']
        : ['--permission-mode', 'bypassPermissions'];

      // --max-turns 是隐藏参数（--help 里没有，当前版本却认）。哪天被移除，整条命令会直接报
      // unknown option；这里见到一次就置位，后面不再传，别让每一轮都失败。
      const turnArgs = maxTurnsDropped ? [] : ['--max-turns', String(options.maxTurns || MAX_TURNS)];

      const args = ['-p', '--output-format', 'json', ...turnArgs, ...permArgs];

      // 系统提示里的 cwd / 环境 / git 状态每轮都在变，会把缓存前缀打碎，挪到第一条 user 消息里。
      // 只在用默认系统提示时生效（传了 --system-prompt-file 会被忽略，无害）。
      args.push('--exclude-dynamic-system-prompt-sections');
      // 自动压缩阈值自己传，别再靠外部环境变量（issue #4 B）。比 SESSION_TOKENS_MAX 高
      // 一档，只在插件没来得及换会话时兜底。
      args.push('--autocompact', `${Math.round(SESSION_AUTOCOMPACT / 1000)}k`);
      if (sess) args.push(sess.resume ? '--resume' : '--session-id', sess.id);
      else args.push('--no-session-persistence');

      // 可选：用一份自己的系统提示文件整段替换掉 CLI 默认的那套（plugin.json 的 systemPromptFile）。
      // 说话规矩、表情、历史全走 stdin，不进系统提示，所以人格不变，换的只是底下那层壳。
      // 留空就用默认的；设环境变量 QQ_NO_PURGE=1 可以临时关掉。
      try {
        const custom = String(conf().systemPromptFile || '').trim();
        if (!process.env.QQ_NO_PURGE && custom && fs.existsSync(custom)) {
          args.push('--system-prompt-file', custom);
        }
      } catch { /* 读不到就照旧用默认系统提示 */ }

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
        const mcpSrc = searchMcpSrc();
        if (options.search && mcpSrc) {
          // 群聊要能查东西。但只给这一条窄口子：MCP 里就「搜索 / 抓网页」两个工具，
          // 模型拿不到 shell，也就绕不过 GROUP_TOOLS 那条红线。
          fs.writeFileSync(SEARCH_MCP_FILE, JSON.stringify({
            mcpServers: {
              search: { command: searchNode(), args: [mcpSrc] },
            },
          }, null, 1), 'utf8');
          args.push('--strict-mcp-config', '--mcp-config', SEARCH_MCP_FILE);
        } else {
          args.push('--strict-mcp-config', '--mcp-config', EMPTY_MCP_FILE);
        }
      } catch { /* 建不出来就照旧带上 MCP，顶多贵一点 */ }

      // 群聊的「工作目录」就是允许它翻的那几个目录：cwd 给第一个，剩下的用 --add-dir 追加。
      // 放在 args 最后是因为 --add-dir 是变长参数，后面不能再跟别的 flag。
      let workCwd = options.cwd || homeDir();
      if (options.group) {
        const dirs = memoryDirs().filter((d) => {
          try { return fs.statSync(d).isDirectory(); } catch { return false; }
        });
        workCwd = dirs[0] || STATE_DIR;
        if (dirs.length > 1) args.push('--add-dir', ...dirs.slice(1));
      }

      child = spawn(quoteArg(claudeCmd()), args.map(quoteArg), {
        shell: true,
        windowsHide: true,
        cwd: workCwd,
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
    const onClose = (code) => {
      clearTimeout(timer);
      const text = String(out || '').trim();

      // 参数不认了要报得像参数不认了，别被兜底话术盖成「我这边卡了一下」。
      if (!maxTurnsDropped && /unknown option|unrecognized option|Unknown argument/i.test(err + text)) {
        maxTurnsDropped = true;
        logger.warn('claude-bridge', '本机 CLI 不认 --max-turns 了，之后不再传这个参数');
      }

      // --output-format json：正常返回就一行 JSON，正文在 result、token 数在 usage。
      // 顺手记一笔账，面板那边才看得见 QQ 里花的量。
      let parsed = null;
      if (text.startsWith('{')) {
        try { parsed = JSON.parse(text); } catch {
          // 混进了别的东西（更新提示之类）：掐头去尾再试一次
          const a = text.indexOf('{');
          const b = text.lastIndexOf('}');
          if (a >= 0 && b > a) { try { parsed = JSON.parse(text.slice(a, b + 1)); } catch { /* 放弃 */ } }
        }
      }
      // 该是 JSON 却解析不出来 —— 宁可这轮不回，也不能把一整段 JSON 原样发进 QQ
      if (!parsed && text.startsWith('{')) {
        reject(new Error('claude 输出解析失败（不是合法 JSON）'));
        return;
      }
      if (parsed && parsed.type === 'result') {
        recordUsage(parsed, options.chatKey);
        if (parsed.is_error) {
          // 续不上的会话（被清理、跨机器重装之类）扔掉，下一轮自动新建一个
          const msg = String(parsed.result || parsed.subtype || 'claude 报错');
          if (sess?.resume && /no conversation|not found|no such session|resume/i.test(msg)) {
            dropSession(options.sessionKey);
          }
          reject(new Error(msg.slice(0, 300)));
          return;
        }
        const body = String(parsed.result ?? '').trim();
        if (!body && code !== 0) {
          reject(new Error(`claude 退出码 ${code}：${err.slice(-200)}`));
          return;
        }
        if (sess && options.sessionKey) markSession(options.sessionKey, sess.id);
        resolve(body);
        return;
      }

      // 解析不出 JSON 就退回老路子。
      // claude 把这几类错误写在 stdout 上、退出码还是 0（比如 Reached max turns），
      // 不拦下来就会原样发进 QQ，主人看见一串英文报错。
      if (/^Error:\s/i.test(text) && text.length < 300) {
        reject(new Error(text));
        return;
      }
      if (code !== 0 && !text) {
        reject(new Error(`claude 退出码 ${code}：${err.slice(-200)}`));
        return;
      }
      resolve(text);
    };

    // 插件里的未捕获异常会把 Electron 主进程整个带崩（10-28 那次 sess 就是，
    // 弹个框直接退出）。这层兜底保证：出错最多这一轮不回话，bot 不掉线。
    child.on('close', (code) => {
      try {
        onClose(code);
      } catch (e) {
        try { reject(e); } catch { /* 已经 settle 过就算了 */ }
      }
    });

    child.stdin.write(prompt, 'utf8');
    child.stdin.end();
  });
}

/** 去掉模型可能加的代码块、前缀、多余空行。 */
function tidy(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
  t = t.replace(/^(主人[:：]\s*|我[:：]\s*)/, '').trim();
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
  // 一条分享链接直接被劈成两条，QQ 里点开就是空页面（2026-10-24 真踩了）。
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
// 主人经常一句话拆成几段发，所以不能按固定时长一刀切：
//   · 每多攒一条，就多给 2.5 秒耐心（说明他还在说）；
//   · 但总共最多等 MAX_WAIT_MS，他要是没完没了地发也不能一直不回；
//   · 从第一条算起，不是从最后一条 —— 否则刷屏能把回复无限推迟。
// 2026-10-24 晚整体放慢：他原话「等我说完一起回，不用急着回应，很奇怪」。
const MAX_WAIT_MS = 30000;
let bufferStartedAt = 0;

// 2026-10-27 主人：「想让你用新对话回复，不让上下文影响」。私聊和群里各加一个触发词，
// 发这几个字就把聊天记录清空（私聊 history 和群聊 groupHistory 一起清），从这条重新算。
const RESET_RE = /新对话|清空上下文|重新开始聊/;
function isResetWord(text) {
  const t = String(text || '').trim();
  return t.length <= 12 && RESET_RE.test(t);
}

// 2026-10-27 主人：「以后文件绕回去你就不用回话了」。
// sendfile.mjs 发出去的文件，QQ 客户端点「接收」时会把它当成一条新的文件消息绕回来，
// 看着像主人又发了一遍。sendfile 发成功时往这个文件记一笔，绕回来时认出来就别吭声。
const SENT_FILES_FILE = path.join(STATE_DIR, 'sent-files.json');
const SENT_FILE_ECHO_MS = 30 * 60 * 1000;   // 30 分钟内的才算自己刚发的

/** 文件名比大小用：去掉大小写、空格、下划线、连字符和 QQ 重名时的 (1)。 */
function normFileName(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/\s*\(\d+\)(?=\.[^.]*$)/, '')
    .replace(/[\s_\-()（）]/g, '');
}

/** 这条是不是刚由我 sendfile 出去、又被 QQ 绕回来的文件消息。 */
function isOwnSentFileEcho(raw) {
  const m = /^\[文件\s*(.+?)\s*\]/.exec(String(raw || ''));
  if (!m) return false;
  const want = normFileName(m[1]);
  if (!want) return false;
  let list = [];
  try {
    const j = JSON.parse(fs.readFileSync(SENT_FILES_FILE, 'utf8'));
    list = Array.isArray(j?.files) ? j.files : [];
  } catch { return false; }
  const now = Date.now();
  return list.some((it) => it && it.name
    && now - Number(it.at || 0) <= SENT_FILE_ECHO_MS
    && normFileName(it.name) === want);
}

/** 清空两边的聊天记录并落盘，返回清掉了几条。 */
function resetHistories() {
  const n = history.length + groupHistory.length;
  history = [];
  groupHistory = [];
  buffer = [];
  bufferStartedAt = 0;
  groupBuffer = [];
  groupStartedAt = 0;
  saveHistory();
  saveGroupHistory();
  return n;
}

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

/** 主人只发了图、没带字：看一眼，判断要不要收进表情库。 */
async function flushImage(orch, job) {
  const { entry, chatKey } = job;
  const localPath = await downloadIncoming(entry);
  const caption = String(entry.text || '').replace(/\[图片\]/g, '').trim();
  const raw = await runClaude(buildImagePrompt(localPath, caption), Number(conf().timeoutMs) || DEFAULT_TIMEOUT_MS, { search: true, chatKey, sessionKey: chatKey });
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

  // 2026-10-24 主人抱怨「总是一堆错误」：翻日志发现超时全是「让我自己上手摸」的活，
  // 摸到 5 分钟满才吐兜底话，中间一声不吭，他只能干等。超过 90 秒先吱一声。
  let progressTimer = null;
  progressTimer = setTimeout(() => {
    Promise.resolve(orch.sender.sendTextBatch(chatKey, ['这个我得弄一会儿，稍等我喵'])).catch(() => {});
  }, 90000);

  try {
    const raw = await runClaude(buildPrompt(lines, chatKey), Number(conf().timeoutMs) || DEFAULT_TIMEOUT_MS, { search: true, chatKey, sessionKey: chatKey });
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
// 机器人也能被拉进群，在里面像个人一样聊天。群功能默认关着，
// 只有在 plugin.json 的 groupIds 里列了群号，才会进群接话。
//
// ⚠️ 红线：**群聊永远不给 Bash / Write / Edit。** 私聊那份权限全开是因为那头只有主人一个人；
// 群里还有别人，给了写和命令就等于把电脑交到一群人手上。这里只放读的三个工具，
// 想改东西一律推掉。以后谁要是为了「方便」把 GROUP_TOOLS 加长，先回来读这段。
function selfUin() {                             // 我自己的号，认 @ 用
  return String(conf().selfUin || '').trim();
}
const GROUP_HISTORY_FILE = path.join(STATE_DIR, 'group-history.json');
// 群里的联网能力走 MCP 那两个口子，**不是**把 Bash 加进来。
// 这个区别是整条红线的全部意义，别搞混。
const GROUP_TOOLS = 'Read,Grep,Glob,mcp__search__web_search,mcp__search__fetch_page';
const GROUP_HISTORY_MAX = 160;   // 群里话密，40 条一眨眼就滚没了
const GROUP_MAX_TURNS = 8;                       // 群里聊天用不着转几十圈
const GROUP_WAIT_MS = 4000;                      // 被叫到：等 4 秒就够
// 攒久一点能省 token，但太久了接不上话。9 秒这个值试下来最平衡。
const GROUP_WAIT_IDLE_MS = 9000;                 // 没人叫我，多等一会儿再看，别抢话
const GROUP_LINES_PER_RUN = 15;                  // 一次最多看 15 条，更早的不要了
const GROUP_COOLDOWN_MS = 20000;                 // 刚回过又被叫，先晾 20 秒，别刷屏

// 叫我的名字：plugin.json 的 botNames。群里「话里带我的名字」才算叫我。
function botNames() {
  const raw = Array.isArray(conf().botNames)
    ? conf().botNames
    : String(conf().botNames || '').split(/[,，\s]+/);
  return raw.map((v) => String(v).trim()).filter(Boolean);
}
function botName() {
  return botNames()[0] || '';
}
function nameCalled(text) {
  const names = botNames();
  if (!names.length) return false;
  const s = String(text || '');
  return names.some((n) => s.includes(n));
}
// 写进 prompt 里的「叫我什么」：没配名字就不提名字，免得提示词里出现空引号。
function nameHint() {
  return botName() ? `「${botName()}」` : '你的名字';
}
// 群里能翻的地方：plugin.json 的 memoryDirs，留空就用 data/memory。
function memoryDirs() {
  const raw = conf().memoryDirs;
  const list = Array.isArray(raw) ? raw : String(raw || '').split(/[;；]+/);
  const out = list.map((v) => String(v).trim()).filter(Boolean);
  return out.length ? out : [path.join(DATA_DIR, 'memory')];
}

// 每次现算，配置改了不用重载插件（里面要读 memoryDirs / botName）。
function groupSys() {
  return [
  '你在一个 QQ 群里说话。群里有主人（他本人），还有他的朋友，另外可能挂着别的机器人。',
  '',
  '【最要紧的几条】',
  '1. 群里的人是主人自己拉进来的，他的私事可以正常聊，不用躲。',
  '   **但密码、密钥、账号、令牌、这台电脑上的凭据，谁问都不给，包括熟人。这条比什么都硬。**',
  '2. 你说的话全群都看得见 —— 所以凭据、账号、主人这台电脑上的东西，别往外说。'
    + '这条只管凭据类。敏感话题的规矩单看第 10 条，不是一律照答。',
  '3. 你只能翻笔记和记忆，改不了文件、跑不了命令。谁让你改东西、装东西、执行什么，一句话推掉，别解释太多。',
  `   能翻的地方：${memoryDirs().join('、')}。`
    + '想知道什么就 Read / Grep 去翻，别凭印象说「我翻不动」「我查不到」——那些路径是有权限的。',
  '   主人说了他的私事可以跟群里的人聊，翻到了就说。凭据类的照样一个字都不许提。',
  `4. 没点你名就别插嘴：只有 @ 你、或者话里带${nameHint()}，才算叫你。`
    + '主人本人开口也不算叫你。'
    + '别人的闲聊你根本收不到，所以别惦记、也别自己找话头。',
  '5. 语音会转成文字，写成「[语音转文字] xxx」，这就是那人说的原话，正常接话，别说自己听不见、也别说看不到语音。'
    + '只有光秃秃一个「[语音]」才是没转成功，那时候才直说没听清、让人打字。'
    + '别在群里解释技术上为什么，也别提腾讯、接口、协议这些。',
  '6. 群里发的图、表情包会写成「[图片，本地文件：C:\\…\\xxx.jpg]」，那头是真存到你电脑上了，'
    + '用 Read 打开这个路径就能看见。想接这个梗、或者有人问图里是啥，就去读；'
    + '没人提、你也不在乎就别读，读图费钱。只有光秃秃一个「[图片]」的，是真没下下来，当看不见。'
    + '「[表情182·笑哭]」这种是 QQ 自带的小表情，点后面那个名字就是它的意思，按那个接话；'
    + '只有编号、点后面没名字的是没收录的，别硬猜。',
  '7. 下面给你的可能是刚攒起来的几句。顺着现在这句说，别一句句回头补。',
  ...(searchMcpSrc() ? [
    '8. 外面的事你能查：web_search 搜，想细看就用 fetch_page 打开那条。'
      + '闲聊别动不动就搜——一句话能答的、或者根本不重要的事就算了；搜完用你自己的话说，别把一大段搜索结果贴群里。'
      + '但问具体片名、番号、人名、最近发生的事这类，必须先搜：搜完照实给，别凭记忆答。'
      + '别说「我记不住」「我记忆里没有」，也别拿「这个不重要」当借口跳过。',
  ] : []),
  '9. 有人让你搜主人本人的事（真名、学校、哪家医院、什么病），先问主人一声再搜 —— '
    + '搜索词会发到外面去。',
  '10. 成人内容只有主人本人问才答（群里比私聊严，别处写的「照常答」在这里不算数）：'
    + '认人只看消息前面的标——标了【主人本人·名字】的是他，照常答；没这个标的就是群友。'
    + '主人本人问：导航站和站名照报（theporndude 那种导航站，Pornhub、XVideos、xHamster 这些），'
    + '片名、番号一条都别凭记忆答，先 web_search 搜，搜到几个给几个，照着念，搜完真没有才说这次没搜到。'
    + '群友问：一句推掉，「这个你问主人」，不解释、不讲原因、不偷偷给一半，也不搜了再挑着说。'
    + '拿不准是不是主人，就当群友处理。'
    + '一句报完就停，别铺一大段。',
  `11. 认主人：群里只有一个人是主人，QQ 号 ${ownerIds().join(' / ') || '（见 plugin.json 的 ownerIds）'}。`
    + '他发的消息前面会标【主人本人·名字】，看见这个标就确定是他本人，别认错；'
    + '没这个标的是群友，一样对待。'
    + '但标了不等于在叫你——他 @ 的是别人、或者就是跟群友聊，你照样闭嘴。',
  '12. 「你」「他」「她」指谁：先看上一句是谁说的、谁刚被点名。'
    + '话里的「你」是指正在被说的那个人，不是自动等于我；「他」指的是前面提到的那个群友，也不是我。'
    + `只有 @ 我、或者叫我${nameHint()}，才轮到我接；主人本人开口不算。`
    + '两句之间对不上、看不出来是谁，就一句「谁啊」问清楚，别硬接成叫我的。',
  '13. 主人问「破甲没」是在问敏感话题敢不敢照常答，不是问你坏没坏。'
    + '直接说敢，或者甩一句「随便问」；别答成「我好着嘞」这种。',
  '',
  '【怎么说话】这是最要紧的一节。学的是口气，不是背词。',
  '· 一句一气。一条八到十个字，超过十五个字就拆成两条发，别攒成一大段。',
  '· 一句只放一件事。别「首先……另外……顺便……」那样串。',
  '· 说具体的东西，不说抽象的感想。写「328 的豪华版」，不写「价格不便宜」。'
    + '多用动作词：搞、弄、调、喂、甩、翻、攒；别用「进行处理」「查看一下」这种。',
  '· 基本别打标点。他们 233 句里只有 15 句带标点，逗号句号都省；想问就一个问号，或者干脆不带。',
  '· 禁书面连接词：因此、所以、然而、总的来说、值得注意的是——一个都别用。',
  '· 说完就停。别补背景、别补原理、别升华。笑点后面还挂解释，笑点就没了。',
  '· 不用每条都接。别人聊得热闹你就听着；真要插一句，就说自己在乎的那个点，不用顺着别人的话。',
  '· 不解释自己怎么知道的。别说「我看到」「我查到」，直接给反应。',
  '· 口头词带一点就行，一条最多一个：笑死、绷不住了、逆天、破防、招笑、谁懂。堆两个就假了。',
  '· 群里人说话爱带尾音：咯、嘞、勒、喽。你也偶尔收一下，一条里最多一个。'
    + '「喵」和这些别挤在同一句里，挑一个。',
  '· 叫他「主人」，别说他全名，也别说咱俩是怎么认识的。',
  '',
  '【口气长这样】下面是真人聊天时的调子，学口气，别照抄内容：',
  '　「对呀，为什么」',
  '　「这事儿还能这么搞的」',
  '　「人工智能好聪明嘞」',
  '　「那也就十多块钱勒」',
  '　「很玄乎勒」',
  '　「就这样咯」',
  '　「不想送直说」',
  '　「蛇分为有毒和没毒，但是我看到蛇都是绕着走」',
  '　「神了，高中同学找我借了 600，一年多了还没给我，目前查无此人」',
  '　「这事儿挺招笑的」',
  '看共同点：短、具体的物、不解释、说完就完，句尾轻轻收一下。',
  ].join('\n');
}

// ── 语音：核心先转，转不了再借 QQ 自己的转写兜底 ──────────────────────
// 主路：核心 src/onebot.js 的 segmentsToText 遇到 record 段会找 `media.transcribe`
// 提供者（voice-transcribe 注册的就是它），转成功的语音进来时已经是「[语音转文字] xxx」，
// 压根不会走到这里 —— 只有本地识别没装、或者识别失败时才留下光秃秃的「[语音]」。
// 兜底：这时候再问一次 QQ 自己的 pttTrans（snowluma 的 fetch_ptt_text）。
// 代价是走一次腾讯服务端；语音得还在本机缓存里，所以收到就得转，不能等合并窗口过去。
//
// 2026-10-28 备注：一度以为这条路是死的（怀疑 message_id 是哈希串、Number() 得 NaN），
// 实际查 data/sessions 里的记录，mid 是 `827771959` 这种真数字，Number 没问题 —— 留着。
function onebotHttp() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8'));
    const url = String(raw?.snowluma?.httpUrl || '').trim().replace(/\/+$/, '');
    const token = String(raw?.snowluma?.httpAccessToken || '').trim();
    return url ? { url, token } : null;
  } catch { return null; }
}

/** 转不出来就返回空串，调用方保留 [语音] 占位，别编。 */
async function fetchVoiceText(mid) {
  if (mid == null) return '';
  const target = onebotHttp();
  if (!target) return '';
  try {
    const res = await fetch(`${target.url}/fetch_ptt_text?access_token=${encodeURIComponent(target.token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message_id: Number(mid) }),
      signal: AbortSignal.timeout(25000),
    });
    const j = await res.json();
    if (j?.status !== 'ok') {
      // 失败原因留在这儿，下次一眼能看见（腾讯那边拒的时候只有 retcode）。
      logger.warn('claude-bridge', `语音转写被拒：retcode=${j?.retcode} ${String(j?.wording || j?.message || '').slice(0, 120)}`);
      return '';
    }
    const data = j.data;
    return String(typeof data === 'string' ? data : (data?.text ?? '')).trim();
  } catch (e) {
    logger.warn('claude-bridge', `语音转写请求失败：${e?.message ?? e}`);
    return '';
  }
}

// ── 图片 / 表情包：收到就落地，模型想看再 Read ────────────────────────
// 2026-10-25 主人：「你在群里看不了表情包」。
// 以前消息进模型眼里的就是干巴巴一个「[图片]」，图本身早扔了。
// 现在的做法：消息一到就把图下载到本地，把**本地路径**写进那行文字。
// 模型手上有 Read，读本地图就能看见；不想看就不读，一分钱不花。
// 注意别改成「自动 Read」——群里连发表情包会把 token 烧穿。
const GROUP_MEDIA_DIR = path.join(STATE_DIR, 'media');
const GROUP_MEDIA_MAX_COUNT = 3;
const GROUP_MEDIA_KEEP_MS = 24 * 3600 * 1000;
const MEDIA_MAX_REDIRECTS = 3;

/**
 * 地址过一遍完整校验：协议、字面量 IP、DNS 解析后的 IP。
 * 2026-10-28 issue #2：域名（比如 127.0.0.1.nip.io）光看字符串判不出来，得真解析。
 * 解析之后再发请求存在 rebinding 的窗口，这里不做 pin-IP，代价太大，属于已知残余风险。
 */
async function checkImageUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (!safeImageUrl(u.href)) return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!net.isIP(host)) {
    try {
      const addrs = await dns.promises.lookup(host, { all: true });
      if (!addrs.length || addrs.some((a) => isPrivateHost(a.address))) return null;
    } catch { return null; }
  }
  return u;
}

/**
 * 取图的唯一入口：手动跟重定向，每一跳都重新校验。
 * 以前直接 fetch 默认 follow，第一跳是公网的图，第二跳 302 到 127.0.0.1 就进本机了。
 */
async function fetchImage(raw, timeoutMs) {
  let cur = String(raw);
  for (let hop = 0; hop <= MEDIA_MAX_REDIRECTS; hop++) {
    const u = await checkImageUrl(cur);
    if (!u) throw new Error(`不安全的地址，拒了：${String(cur).slice(0, 120)}`);
    const res = await fetch(u.href, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`重定向没给 location（HTTP ${res.status}）`);
      try { await res.body?.cancel(); } catch { /* 断不断无所谓 */ }
      cur = new URL(loc, u).href;
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  }
  throw new Error(`重定向超过 ${MEDIA_MAX_REDIRECTS} 跳`);
}

function imageExt(buf, hint) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'gif';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  const m = /\.([a-z0-9]{2,5})$/i.exec(String(hint || ''));
  return m ? m[1].toLowerCase() : 'jpg';
}

/** 目录别无限长大：删掉超过 keepMs 的文件。群图和私聊收到的图共用这一套。 */
function pruneDir(dir, keepMs) {
  try {
    const now = Date.now();
    for (const n of fs.readdirSync(dir)) {
      const p = path.join(dir, n);
      try {
        if (now - fs.statSync(p).mtimeMs > keepMs) fs.unlinkSync(p);
      } catch { /* 单个删不掉无所谓 */ }
    }
  } catch { /* 目录还没有就还没有 */ }
}
function pruneMediaDir() { pruneDir(GROUP_MEDIA_DIR, GROUP_MEDIA_KEEP_MS); }

/**
 * 把一条消息里的图落地。
 * 返回 [{ file, summary, size }]，跟消息里 `[图片]` 出现的顺序对齐；
 * 下载失败的跳过（调用方按顺序填，填不满就留原占位）。
 */
async function grabImages(entry) {
  const media = Array.isArray(entry?.media) ? entry.media : [];
  const imgs = media.filter((m) => m && m.kind === 'image');
  if (!imgs.length) return [];
  try { fs.mkdirSync(GROUP_MEDIA_DIR, { recursive: true }); } catch { /* 建不了目录就放弃 */ }
  // 返回值和 imgs 一一对应，失败（地址被拦 / 下载出错 / 超限）的位置留 null。
  // 以前失败就 continue 把数组压短，markImages 再按顺序填 —— 第 1 张失败时，
  // 第 2 张的路径会被贴到第 1 个 [图片] 上，模型拿着错图说事（issue #3）。
  const out = new Array(imgs.length).fill(null);
  for (let i = 0; i < imgs.length && i < GROUP_MEDIA_MAX_COUNT; i++) {
    const m = imgs[i];
    if (!safeImageUrl(m.url)) continue;
    try {
      const res = await fetchImage(String(m.url), 20000);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > GROUP_MEDIA_MAX_BYTES) {
        logger.warn('claude-bridge', `群图跳过：${buf.length} 字节，上限 ${GROUP_MEDIA_MAX_BYTES}`);
        continue;
      }
      const file = path.join(GROUP_MEDIA_DIR, `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${imageExt(buf, m.file)}`);
      fs.writeFileSync(file, buf);
      out[i] = { file, summary: String(m.summary || '').slice(0, 40), size: buf.length };
    } catch (e) { logger.warn('claude-bridge', `群图下载异常：${e?.message ?? e}`); }
  }
  pruneMediaDir();
  return out;
}

let groupHistory = [];       // 跟私聊的 history 完全分开，不串味
let groupBuffer = [];        // [{ name, text }]
let groupBusy = false;
let groupTimer = null;
let groupStartedAt = 0;
let groupOrch = null;
let groupChatKey = '';
let groupLastReplyAt = 0;
let groupMuted = false;      // 主人在群里说「安静」之后为 true，不再接任何人的话
const GROUP_MUTE_RE = /^(安静|静音|都闭嘴|别说了)[\s!！。.~～]*$/;

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
 * 白名单群里谁说话都听，但只有 @ 我、或者话里带我名字的，才算「叫我」，那种必须应声。
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
  // @ 别人的话没必要回，很奇怪 —— 所以 @ 了谁先看清楚，没 @ 到我就当没看见，连 buffer 都不进。
  const atTargets = [...rawText.matchAll(/\[CQ:at,qq=([^,\]\s]+)/g)].map((m) => m[1]);
  // 判定顺序：
  //   1) @ 了人但没 @ 到我 → 当没看见（@全体 例外，那算叫我）
  //   2) @ 到我 / @全体 / 带我的名字 → called，必须应声
  //   3) 一个 @ 都没有 → 照样进 buffer（called=false），接不接由我自己在 prompt 里判断，
  //      不想说就回 PASS，这条不发出去。
  const atAll = atTargets.includes('all');
  const atMe = atAll
    || (me && atTargets.includes(me))
    || (me ? new RegExp(`@\\s*${me}\\b`).test(rawText) : false);
  // 主人本人的消息照样进 buffer、进 prompt 时标明【主人本人】，别把他当普通群友晾着；
  // 但「是他本人」不等于「在叫我」—— 还得看他有没有 @我、或者带我的名字。
  const owner = ownerIds().includes(String(entry?.senderId || ''));
  if (atTargets.length && !atMe && !owner) return null;
  const called = atMe || nameCalled(rawText);
  return { text, called, owner };
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
// 我这条 claude 通道一个字都读不到。2026-10-25 主人说接上，就从这儿读。
const MEMORY_ROOT = path.join(DATA_DIR, 'memory');
const IMPRESSION_PER_MEMBER = 3;              // 每人只取最新 3 条，多了纯烧钱
const IMPRESSION_CACHE_MS = 10 * 60 * 1000;   // 10 分钟，免得每条消息都读盘
let impressionCache = { key: '', at: 0, text: '' };

/** 读印象，拼成「名字：印象；印象」若干行。读不到就返回空串，绝不让聊天挂掉。
 *  目录按 chatKey 的前缀走：group:123 → memory/group_123，private:456 → memory/private_456。
 *  2026-10-28 主人说私聊也要接上，所以不再只认 group。 */
function loadImpressions(chatKey) {
  const now = Date.now();
  if (impressionCache.key === chatKey && now - impressionCache.at < IMPRESSION_CACHE_MS) {
    return impressionCache.text;
  }
  let text = '';
  const key = String(chatKey ?? '');
  const [scope, id] = key.includes(':') ? key.split(':') : ['group', key];
  try {
    const dir = path.join(MEMORY_ROOT, `${scope}_${id}`);
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
  // 群规矩也是常量，只在新建会话那一轮塞一次（每轮重塞的话，一天能涨十几万 token）
  const firstTurn = !USE_SESSION || !sessionFor(groupChatKey).resume;
  const parts = firstTurn ? ['【群聊，不是私聊。下面这些是硬规矩】', groupSys()] : [];
  // 印象卡是别的模型整理的，会过时也会记错，所以只说「参考」；更要紧的是别照着它
  // 主动往外说 —— 里面记着人家的账号糟心事、证件，群里说出来是要出事的。
  const impressions = loadImpressions(groupChatKey);
  if (impressions) {
    parts.push(
      '',
      '【你对群里这几个人的印象】之前记下的，参考用，可能过时、也可能记错：',
      impressions,
      '心里有数就行，别主动把这里的内容说出来——尤其是别人的私事、账号、证件这一类，一个字都别提。'
    );
  }
  if (!USE_SESSION && groupHistory.length) {
    parts.push('', '群里刚才聊的：');
    for (const m of groupHistory.slice(-30)) {
      parts.push(`${m.role === 'assistant' ? '你' : ''}${renderFaces(m.text)}`.slice(0, 500));
    }
  }
  parts.push('', '群里刚在说：');
  for (const l of lines) {
    parts.push(`${l.owner ? `【主人本人·${l.name}】` : l.name}：${renderFaces(l.text)}${l.called ? '（在叫你）' : ''}`);
  }
  parts.push('');
  if (called) {
    parts.push('有人在叫你，你得出声，不能沉默。');
  } else {
    parts.push('没人叫你。想插一句就插，就说你在乎的那个点；插不上、或者插了也是废话，就只回 PASS 一个词，我这边不会发出去。');
    parts.push('别人明显在跟另一个人一问一答、或者纯属他们自己的私事，你就听着；'
      + '其余时候想接就接一句，别自己把自己劝退。');
  }
  // 2026-10-25 群友问「你会不会用表情包了」，我只会说「发不出去」——
  // 因为群里这条路压根没接上：私聊有 @@表情:id@@ 那一整套，群里只把标记刮掉了。
  // 2026-10-25 主人说「感觉有点频繁了，别人发表情包你再回一张」。
  // 原来是无条件把菜单塞进去、还写着「可以用得勤一点」，难怪见天发。
  // 改成：这一批里有人发了表情包，才把菜单和许可给出去。
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
      group: true,          // 群聊走受限权限：工作目录外的读写由工具层直接拒（issue #1）
      chatKey: groupChatKey,
      sessionKey: groupChatKey,
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
    // 主人在群里刚说过「安静」，手上这一轮还在跑也别发出去
    if (groupMuted) silent = true;
    if (!silent && parts.length && groupOrch) {
      await groupOrch.sender.sendTextBatch(groupChatKey, parts);
      groupLastReplyAt = Date.now();
    }
    // 表情排在文字后面单独发一张；发不出去只记日志，别把整轮算失败
    if (!silent && stickerRef && groupOrch) {
      await sendStickerSafe(groupOrch, groupChatKey, stickerRef);
      groupLastReplyAt = Date.now();
    }
    for (const l of lines) {
      groupHistory.push({
        role: 'user',
        text: `${l.owner ? `【主人本人·${l.name}】` : l.name}：${l.text}`,
        ts: Date.now(),
      });
    }
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
  const { text, called, owner } = hit;
  groupOrch = orch;
  groupChatKey = chatKey;
  try {
    if (typeof orch.store?.markEntryRead === 'function') orch.store.markEntryRead(chatKey, entry.id);
  } catch { /* 标不上就标不上 */ }
  // 别人发了表情包吗？image 段带 summary 的就是表情包（普通照片没这个字段）。
  // 主人的要求是「别人发了，我才回一张」，所以这个标记决定要不要给表情菜单。
  const sticker = Array.isArray(entry?.media)
    && entry.media.some((m) => m && m.kind === 'image' && String(m.summary ?? '').trim() !== '');
  // 2026-10-27 主人：「我在群里发安静这两个字时，你回复一下，然后停止接话」
  // 认主人本人发的，群友喊「安静」不算数；静音期间别人说什么都不进 buffer，
  // 主人自己再开口就自动解除，免得他以为我又哑了。
  const fromOwner = owner;
  if (GROUP_MUTE_RE.test(text) && fromOwner) {
    groupMuted = true;
    groupBuffer = [];
    groupStartedAt = 0;
    if (groupTimer) { clearTimeout(groupTimer); groupTimer = null; }
    logger.info('claude-bridge', '主人在群里说安静，停止接话');
    Promise.resolve(orch.sender.sendTextBatch(chatKey, ['好喵 我不说了'])).catch(() => {});
    return true;
  }
  if (groupMuted) {
    if (!fromOwner) {
      logger.info('claude-bridge', '群聊静音中，跳过一条');
      return true;
    }
    groupMuted = false;
    logger.info('claude-bridge', '主人在群里又说话了，解除静音');
  }
  // 群里只有主人说「新对话」才算，群友起哄不算
  if (isResetWord(text) && fromOwner) {
    const n = resetHistories();
    logger.info('claude-bridge', `主人在群里要开新对话，清掉 ${n} 条历史`);
    Promise.resolve(orch.sender.sendTextBatch(chatKey, ['清干净了喵 从这条开始重新算'])).catch(() => {});
    return true;
  }
  const line = { name, text, called, sticker, owner };
  const queued = () => {
    if (!groupBuffer.length) groupStartedAt = Date.now();
    groupBuffer.push(line);
    scheduleGroupFlush();
  };

  // 图有时效（url 带 rkey），语音得还在本机缓存里 —— 都是收到就先处理再去排队。
  const hasVoice = text.includes('[语音]') && entry?.mid != null;
  const hasImage = Array.isArray(entry?.media) && entry.media.some((m) => m && m.kind === 'image');
  if (!hasVoice && !hasImage) {
    queued();
    logger.info('claude-bridge', called ? `群里被叫到（${name}）` : `群里在聊（${name}）`);
    return true;
  }

  Promise.all([
    hasImage ? grabImages(entry) : Promise.resolve([]),
    hasVoice ? fetchVoiceText(entry.mid) : Promise.resolve(''),
  ]).then(([got, spoken]) => {
    const saved = got.filter(Boolean).length;
    if (saved) {
      line.text = markImages(line.text, got);
      logger.info('claude-bridge', `群里存下图（${name}，${saved} 张）`);
    } else if (hasImage) {
      logger.warn('claude-bridge', `群里的图没下下来（${name}），按 [图片] 占位处理`);
    }
    if (spoken) {
      line.text = line.text.replace('[语音]', `[语音]说的是：${spoken}`);
      logger.info('claude-bridge', `群里语音转成文字（${name}，${spoken.length} 字）`);
    } else if (hasVoice) {
      logger.warn('claude-bridge', `群里语音没转出来（${name}），按 [语音] 占位处理`);
    }
    queued();
  }).catch(queued);
  logger.info('claude-bridge', called
    ? `群里被叫到（${name}${hasImage ? '，图' : ''}${hasVoice ? '，语音' : ''}）`
    : `群里在聊（${name}${hasImage ? '，图' : ''}${hasVoice ? '，语音' : ''}）`);
  return true;
}

let currentOrch = null;
let currentChatKey = '';

/** 命中条件：主人的私聊、纯文字。 */
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
  // 于是主人发的图我既看不见也收不了。
  if (isOwnerImage(chatKey, entry)) {
    currentOrch = orch;
    currentChatKey = chatKey;
    try {
      if (typeof orch.store?.markEntryRead === 'function') {
        orch.store.markEntryRead(chatKey, entry.id);
      }
    } catch { /* 标不上就标不上 */ }
    pendingImage = { entry, chatKey };
    logger.info('claude-bridge', '主人发来一张图，等会儿看看是什么');
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

  // 2026-10-24 主人问「为啥发你文件读不了」：核心只把文件渲染成「[文件xxx]」，
  // 内容一个字都没带。好消息里存着下载地址，把消息号补上它就能自己取。
  const raw = String(entry.text).trim();
  if (isOwnSentFileEcho(raw)) {
    logger.info('claude-bridge', `自己发出去的文件绕回来了，不理：${raw.slice(0, 60)}`);
    return true;   // 已读也标过了，不回复、不进历史
  }
  if (isResetWord(raw)) {
    const n = resetHistories();
    logger.info('claude-bridge', `主人要开新对话，清掉 ${n} 条历史`);
    Promise.resolve(orch.sender.sendTextBatch(chatKey, ['清干净了喵 从这条开始重新算'])).catch(() => {});
    return true;
  }
  const pushLine = (line) => {
    if (!buffer.length) bufferStartedAt = Date.now();   // 这一串连发从第几条开始计时
    buffer.push(line);
    logger.info('claude-bridge', `收到主人私聊（未读 ${buffer.length}）`);
    scheduleFlush(Number(conf().debounceMs) || DEFAULT_DEBOUNCE_MS);
  };
  if (raw.includes('[语音]') && entry.mid != null) {
    // 核心没转出来（没装本地识别，或者识别失败），再问一次 QQ 自己的转写
    fetchVoiceText(entry.mid).then((spoken) => {
      if (spoken) logger.info('claude-bridge', `私聊语音转成文字（${spoken.length} 字）`);
      pushLine(spoken ? raw.replace('[语音]', `[语音]说的是：${spoken}`) : raw);
    }).catch(() => pushLine(raw));
    return true;
  }
  pushLine(
    /^\[文件/.test(raw) && entry.mid != null
      ? `${raw}（消息号 ${entry.mid}${fetchFileScript() ? '，用取文件脚本下下来再读' : ''}）`
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

// ── 每天定时跑一个脚本（可选）────────────────────────────────────────
// 不用 Windows 计划任务，是因为那要管理员权限、会弹 UAC——半夜弹框不合适。
// 挂在 QQ-agent 身上更简单：它开着定时器就在，重启后 activate 会重新起。
// 用法：plugin.json 里配 cronScript（脚本绝对路径）+ cronTime（"20:00"），
// 留空就整个功能不启用。日志和「今天跑过没」的戳都落在插件自己的状态目录。
const CRON_STAMP = path.join(STATE_DIR, 'cron.last-run');
const CRON_LOG = path.join(STATE_DIR, 'cron.log');
const CRON_WINDOW_MIN = 30;      // 到点后这半小时内任一分钟触发都算
let cronTimer = null;

function stampToday() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function cronAt() {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(conf().cronTime || '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function cronTick() {
  try {
    const script = String(conf().cronScript || '').trim();
    const at = cronAt();
    if (!script || at == null) return;
    const now = new Date();
    const hhmm = now.getHours() * 60 + now.getMinutes();
    if (hhmm < at || hhmm > at + CRON_WINDOW_MIN) return;
    if (fs.existsSync(CRON_STAMP) && fs.readFileSync(CRON_STAMP, 'utf8').trim() === stampToday()) return;
    fs.writeFileSync(CRON_STAMP, stampToday(), 'utf8');
    if (busy) {
      // 正跟主人聊着，别插一脚把两边都拖慢；明天再说
      fs.appendFileSync(CRON_LOG, `[${now.toLocaleString('zh-CN')}] 在聊天，今天跳过\n`, 'utf8');
      return;
    }
    const node = String(conf().cronNode || '').trim() || searchNode();
    const child = spawn(node, [script], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    fs.appendFileSync(CRON_LOG, `[${now.toLocaleString('zh-CN')}] 起了一轮\n`, 'utf8');
    logger.info('claude-bridge', `到点了，开始跑 ${path.basename(script)}`);
  } catch (e) {
    try {
      fs.appendFileSync(CRON_LOG, `[${new Date().toLocaleString('zh-CN')}] 出错：${e?.message ?? e}\n`, 'utf8');
    } catch { /* 日志都写不进去就算了 */ }
  }
}

function startCronTimer() {
  if (cronTimer) return;
  cronTimer = setInterval(cronTick, 60000);   // 一分钟看一次，够用
  if (typeof cronTimer.unref === 'function') cronTimer.unref();
}

function stopCronTimer() {
  if (cronTimer) { clearInterval(cronTimer); cronTimer = null; }
}

export function activate() {
  loadHistory();
  loadGroupHistory();
  if (install()) {
    logger.info('claude-bridge', `已挂载：主人私聊交给 claude 回（只认 ${ownerIds().join(',')}），权限全开`);
  }
  startCronTimer();
}

export function deactivate() {
  stopCronTimer();
  uninstall();
}

export function dispose() {
  stopCronTimer();
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
