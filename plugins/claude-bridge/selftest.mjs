// 自测：纯函数及群聊权限、图片下载的离线回归。
// 跑法：node plugins/claude-bridge/selftest.mjs
//
// 集成部分用临时数据目录和替身宿主，不启动 QQ-agent 或 Claude，也不上网。

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { markImages, isPassReply, safeImageUrl } from './lib/pure.js';

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  const A = JSON.stringify(actual), E = JSON.stringify(expected);
  if (A === E) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       期望 ${E}\n       实际 ${A}`); }
};

console.log('\n[1] markImages：第 1 张失败时，第 2 张不能被贴到第 1 个占位上');
check('第 1 张为 null', markImages('[图片][图片]', [null, { file: 'b.jpg' }]),
  '[图片][图片，本地文件：b.jpg]');
check('只剩第 2 张', markImages('[图片][图片]', [null, { file: 'b.jpg', summary: '猫' }]),
  '[图片][图片「猫」，本地文件：b.jpg]');
check('两张都成功', markImages('[图片][图片]', [{ file: 'a.jpg' }, { file: 'b.jpg' }]),
  '[图片，本地文件：a.jpg][图片，本地文件：b.jpg]');
check('全失败保持原样', markImages('[图片][图片]', [null, null]), '[图片][图片]');
check('空数组不动原文本', markImages('没图', []), '没图');

console.log('\n[2] isPassReply：只认整条就是 PASS，不吞 666 和纯表情');
check('空数组 = 不回', isPassReply([]), true);
check('空白 = 不回', isPassReply(['   ']), true);
check('pass', isPassReply(['pass']), true);
check('PASS 大写', isPassReply(['PASS']), true);
check('pass 带标点', isPassReply(['PASS。']), true);
check('pass 带表情', isPassReply(['pass😂']), true);
check('666 要发', isPassReply(['666']), false);
check('+1 要发', isPassReply(['+1']), false);
check('纯表情要发', isPassReply(['😂']), false);
check('纯标点要发', isPassReply(['！！']), false);
check('正常文字要发', isPassReply(['好啊']), false);

console.log('\n[3] safeImageUrl：公网放行、本机内网拦住');
check('公网 https', safeImageUrl('https://multimedia.nt.qq.com.cn/x.jpg'), true);
check('公网 http', safeImageUrl('http://example.com/a.png'), true);
check('公网 IP', safeImageUrl('http://8.8.8.8/x.png'), true);
check('127.0.0.1', safeImageUrl('http://127.0.0.1:6099/x'), false);
check('localhost', safeImageUrl('http://localhost/x'), false);
check('10.x', safeImageUrl('http://10.0.0.5/x'), false);
check('192.168', safeImageUrl('http://192.168.1.2/x'), false);
check('172.16', safeImageUrl('http://172.16.0.1/x'), false);
check('172.32 是公网', safeImageUrl('http://172.32.0.1/x'), true);
check('169.254', safeImageUrl('http://169.254.169.254/latest'), false);
check('100.64 CGNAT', safeImageUrl('http://100.64.0.1/x'), false);
check('非 http 协议', safeImageUrl('file:///C:/x.jpg'), false);

console.log('\n[4] IPv6 和非十进制写法（issue #2 修）');
check('[::1]', safeImageUrl('http://[::1]/x'), false);
check('[::]', safeImageUrl('http://[::]/x'), false);
check('[::ffff:127.0.0.1]', safeImageUrl('http://[::ffff:127.0.0.1]/x'), false);
check('[::ffff:7f00:1] 规范化写法', safeImageUrl('http://[::ffff:7f00:1]/x'), false);
check('[fc00::1] ULA', safeImageUrl('http://[fc00::1]/x'), false);
check('[fe80::1] 链路本地', safeImageUrl('http://[fe80::1]/x'), false);
check('[ff02::1] 组播', safeImageUrl('http://[ff02::1]/x'), false);
check('[2001:4860:4860::8888] 公网', safeImageUrl('http://[2001:4860:4860::8888]/x'), true);
check('十进制 2130706433', safeImageUrl('http://2130706433/x'), false);
check('十六进制 0x7f.0.0.1', safeImageUrl('http://0x7f.0.0.1/x'), false);
check('八进制 0177.0.0.1', safeImageUrl('http://0177.0.0.1/x'), false);

// 域名要看 DNS 才知道指哪，pure 层判不了 —— index.js 的 checkImageUrl 会 lookup 后再判。
// 重定向也一样，fetchImage 是 redirect:'manual' 逐跳校验，这些没法脱机测。
console.log('\n[5] pure 层判不了的（交给 DNS 和逐跳校验）');
console.log(`  INFO  ${'127.0.0.1.nip.io'} 字面量判定 -> ${safeImageUrl('http://127.0.0.1.nip.io/x')}`);

console.log('\n[6] 插件集成：群聊权限和流式图片下载');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-bridge-test-')));
const entryUrl = new URL('./index.js', import.meta.url);
const stubUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
const stubs = new Map([
  ['../../src/config.js', stubUrl(`export const DATA_DIR = ${JSON.stringify(root)};`)],
  ['../../src/orchestrator.js', stubUrl('export class Orchestrator {}')],
  ['../../src/logger.js', stubUrl('export const logger = { warn() {} };')],
  ['node:child_process', stubUrl('export const spawn = (...args) => globalThis.bridgeTestSpawn(...args);')],
]);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return context.parentURL === entryUrl.href && stubs.has(specifier)
      ? { url: stubs.get(specifier), shortCircuit: true }
      : next(specifier, context);
  },
  load(url, context, next) {
    if (url !== entryUrl.href) return next(url, context);
    return { format: 'module', shortCircuit: true, source: fs.readFileSync(entryUrl, 'utf8')
      + '\nexport { runClaude, grabImages, downloadIncoming };' };
  },
});
const realFetch = globalThis.fetch;
try {
  const bridge = await import(entryUrl.href);
  const privateDir = path.join(root, 'claude-bridge');
  const noteDir = path.join(root, 'test-notes');
  fs.mkdirSync(privateDir);
  fs.mkdirSync(noteDir);
  const history = path.join(privateDir, 'history.json');
  fs.writeFileSync(history, 'fixture');
  let memoryDirs = [path.join(root, 'missing'), history];
  await bridge.setup({ config: () => ({ memoryDirs }) });

  const invocations = [];
  globalThis.bridgeTestSpawn = (_command, args, { cwd }) => {
    invocations.push({ args: args.map((arg) => arg.replace(/^"|"$/g, '')), cwd });
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {},
    });
    child.stdin.once('finish', () => {
      child.stdout.write('正常群聊回复');
      child.emit('close', 0);
    });
    return child;
  };
  const group = { group: true, tools: 'Read,Grep,Glob' };
  check('无有效笔记目录时仍能返回文字', await bridge.runClaude('测试', 1000, group), '正常群聊回复');
  const mediaDir = path.join(root, 'claude-bridge-group-media');
  const fallback = invocations.at(-1);
  check('群聊工作目录只包含群图，私聊记录在授权目录外',
    [fallback.cwd, fallback.args.includes('--add-dir'), path.relative(fallback.cwd, history)],
    [mediaDir, false, path.join('..', 'claude-bridge', 'history.json')]);
  check('群聊保留默认权限与拒绝无人审批',
    ['--permission-mode', '--permission-prompts', '--allowedTools'].map((arg) => fallback.args[fallback.args.indexOf(arg) + 1]),
    ['default', 'none', 'mcp__search__web_search,mcp__search__fetch_page']);

  const image = { mid: 'fixture', media: [{ kind: 'image', url: 'https://8.8.8.8/image.png' }] };
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/9GQAAAAASUVORK5CYII=', 'base64');
  globalThis.fetch = async (_url, opts) => {
    assert.equal(opts.redirect, 'manual');
    return new Response(png);
  };
  const [saved] = await bridge.grabImages(image);
  check('普通群图在 fallback 工作目录中且内容完整',
    [path.dirname(saved.file), fs.readFileSync(saved.file).equals(png)], [mediaDir, true]);
  memoryDirs = [root, privateDir, noteDir];
  await bridge.runClaude('测试', 1000, group);
  const withNotes = invocations.at(-1);
  check('有笔记目录时只额外开放群图目录，拒绝私聊目录及其父目录',
    [withNotes.cwd, withNotes.args.slice(withNotes.args.indexOf('--add-dir'))],
    [noteDir, ['--add-dir', mediaDir]]);

  const limit = 12 * 1024 * 1024;
  const fullChunk = new Uint8Array(limit);
  for (const [label, download, expected] of [
    ['群聊', bridge.grabImages, [null]], ['私聊', bridge.downloadIncoming, ''],
  ]) {
    for (const declared of [false, true]) {
      let pulls = 0, cancelled = 0;
      globalThis.fetch = async () => new Response(new ReadableStream({
        pull(controller) { controller.enqueue(++pulls === 1 ? fullChunk : new Uint8Array(1)); },
        cancel() { cancelled++; },
      }, { highWaterMark: 0 }), { headers: declared ? { 'Content-Length': String(limit + 1) } : {} });
      check(`${label}超限立即取消（${declared ? '有' : '无'}长度头）`,
        [await download(image), pulls, cancelled], [expected, declared ? 0 : 2, 1]);
    }
  }
  check('被拒的图片没有落盘', [fs.readdirSync(mediaDir).length, fs.existsSync(path.join(privateDir, 'incoming'))], [1, false]);
} finally {
  hooks.deregister();
  globalThis.fetch = realFetch;
  delete globalThis.bridgeTestSpawn;
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
