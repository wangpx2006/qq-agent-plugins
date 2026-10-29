// 自测：纯函数层面的回归保护（issue #3 那几个 bug 的现场）。
// 跑法：node plugins/claude-bridge/selftest.mjs
//
// 不加载插件本体 —— index.js 静态依赖宿主的 ../../src/orchestrator.js，
// 仓库里没有那份，直接 import 会失败。纯函数都放在 lib/pure.js，这里单独测。

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

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
