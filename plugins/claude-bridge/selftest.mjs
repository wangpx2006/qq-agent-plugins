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
check('127.0.0.1', safeImageUrl('http://127.0.0.1:6099/x'), false);
check('localhost', safeImageUrl('http://localhost/x'), false);
check('10.x', safeImageUrl('http://10.0.0.5/x'), false);
check('192.168', safeImageUrl('http://192.168.1.2/x'), false);
check('172.16', safeImageUrl('http://172.16.0.1/x'), false);
check('169.254', safeImageUrl('http://169.254.169.254/latest'), false);
check('非 http 协议', safeImageUrl('file:///C:/x.jpg'), false);

// 已知未修（issue #2）：IPv6、十进制 IP、DNS 指向内网、重定向跳转都还没挡。
// 这里只记录现状，别当通过 —— 改 issue #2 时把下面几条断言翻成 false。
console.log('\n[4] 已知缺口（issue #2，未修，仅记录现状）');
console.log(`  INFO  ${'http://[::1]/x'} -> ${safeImageUrl('http://[::1]/x')}`);
console.log(`  INFO  ${'http://2130706433/x'} -> ${safeImageUrl('http://2130706433/x')}`);

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
