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

/** IPv4 点分十进制 → 整数；畸形返回 null。 */
function v4ToInt(ip) {
  const p = String(ip).split('.');
  if (p.length !== 4) return null;
  const n = [];
  for (const s of p) {
    if (!/^\d{1,3}$/.test(s)) return null;
    const v = Number(s);
    if (v > 255) return null;
    n.push(v);
  }
  return ((n[0] << 24) >>> 0) + (n[1] << 16) + (n[2] << 8) + n[3];
}

function inCidr(n, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((n & mask) >>> 0) === ((base & mask) >>> 0);
}

/** 这个 IPv4 是不是「本机/内网/保留」——是就别去请求。 */
export function isPrivateIpv4(ip) {
  const n = v4ToInt(ip);
  if (n == null) return true;                     // 认不出来按私处理
  return (
    inCidr(n, 0x00000000, 8) ||                   // 0.0.0.0/8
    inCidr(n, 0x0a000000, 8) ||                   // 10/8
    inCidr(n, 0x64400000, 10) ||                  // 100.64/10 CGNAT
    inCidr(n, 0x7f000000, 8) ||                   // 127/8
    inCidr(n, 0xa9fe0000, 16) ||                  // 169.254/16 链路本地
    inCidr(n, 0xac100000, 12) ||                  // 172.16/12
    inCidr(n, 0xc0a80000, 16) ||                  // 192.168/16
    inCidr(n, 0xc0000000, 24) ||                  // 192.0.0/24
    inCidr(n, 0xc6336400, 24) ||                  // 192.0.2/24 TEST-NET-1
    inCidr(n, 0xcb007100, 24) ||                  // 203.0.113/24 TEST-NET-3
    inCidr(n, 0xe0000000, 4) ||                   // 224/4 组播
    inCidr(n, 0xf0000000, 4)                      // 240/4 保留
  );
}

/**
 * host 是不是本机/内网。传 IP 字面量（v4 或 v6）最准；
 * 传域名时会做字符串层面的判断，解析后指向内网的那种得靠调用方 dns.lookup 再说。
 *
 * 2026-10-28 issue #2：原来只做字符串黑名单（`127.` / `10.` 之类），
 * IPv6（`[::1]`、`[::ffff:127.0.0.1]`）和 DNS 指向内网的域名都能过。
 * 十进制/十六进制写法（`http://2130706433/`）其实已经被 WHATWG URL 规范化成 127.0.0.1 了，
 * 黑名单本来就挡住了 —— 真正漏的是 v6 和域名这两种。
 */
export function isPrivateHost(host) {
  let h = String(host || '').trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.endsWith('.')) h = h.slice(0, -1);          // FQDN 末尾的点
  if (!h) return true;

  if (!h.includes(':')) {
    if (v4ToInt(h) != null) return isPrivateIpv4(h);
    // 域名：localhost 家族和 mDNS 直接挡，其余交给 DNS 解析那一步
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
    return false;
  }

  // ── IPv6 ──
  if (h === '::' || h === '::1') return true;
  if (h.startsWith('::ffff:')) {                    // IPv4-mapped：取出后 32 位按 v4 判
    const tail = h.slice(7);
    if (v4ToInt(tail) != null) return isPrivateIpv4(tail);
    const g = tail.split(':');
    if (g.length === 2 && g.every((x) => /^[0-9a-f]{1,4}$/.test(x))) {
      const hi = parseInt(g[0], 16), lo = parseInt(g[1], 16);
      return isPrivateIpv4([hi >> 8, hi & 255, lo >> 8, lo & 255].join('.'));
    }
    return true;                                    // 认不出来按私处理
  }
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;    // fc00::/7 ULA
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;    // fe80::/10 链路本地
  if (/^ff[0-9a-f]{2}:/.test(h)) return true;       // ff00::/8 组播
  return false;
}

/** 只放行公网 http(s)：群里谁能发消息，谁就能塞 url，别让它去戳本机或内网。 */
export function safeImageUrl(raw) {
  try {
    const u = new URL(String(raw));
    if (!/^https?:$/.test(u.protocol)) return false;
    return !isPrivateHost(u.hostname);
  } catch { return false; }
}
