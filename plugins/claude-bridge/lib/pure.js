/**
 * 纯函数：不碰文件、不碰网络、不依赖宿主。
 * 单独放一份是为了能脱机自测（见 ../selftest.mjs），也方便其他插件复用。
 */

/**
 * 把 `[图片]` 逐个换成带本地路径的说明。
 * got 必须和消息里 `[图片]` 的顺序一一对应，失败位置放 null —— 这样第 1 张没下到时
 * 第 2 张的路径不会被贴到第 1 个 `[图片]` 上（2026-10-28 issue #3 修）。
 */
export function markImages(text, got) {
  if (!got?.length) return text;
  let i = 0;
  return String(text).replace(/\[图片\]/g, () => {
    const g = got[i++];
    if (!g) return '[图片]';
    const tag = g.summary ? `「${g.summary}」` : '';
    return `[图片${tag}，本地文件：${g.file}]`;
  });
}

/**
 * 模型判断这场不值得插嘴时会只回一个 PASS。别当话发出去。
 *
 * 2026-10-28：原来用 `[^\p{L}]` 剥字符，数字和 emoji 全被剥掉，于是回「666」「+1」「😂」
 * 都会变成空串被判成 PASS 静默吞掉。现在只有整条规范化后就是 pass 才算；
 * 真一个字都没有（parts 为空 / 全空白）也算不回。
 */
export function isPassReply(parts) {
  const s = String((parts || []).join('')).trim();
  if (!s) return true;
  const norm = s.replace(/[\s\p{P}\p{S}]/gu, '');   // 去掉空白、标点、符号（emoji 也归符号）
  return /^pass$/iu.test(norm);
}

/** 只放行公网 http(s)：群里谁能发消息，谁就能塞 url，别让它去戳本机或内网。 */
export function safeImageUrl(raw) {
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
