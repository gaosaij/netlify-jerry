// 防 SSRF 的抓取：服务器要请求的地址如果来自不可信的内容（被搬运网页里的 <img src>、重定向的 Location），
// 不能让它访问本机、内网、云厂商的元数据地址等。做法：只允许 http/https；解析出的每个 IP 都必须是公网地址；
// 重定向不自动跟随，而是每一跳都重新检查。
// 本地测试需要访问 127.0.0.1 上的模拟服务器：用环境变量 ALLOW_PRIVATE_URLS 列出允许的主机名（逗号分隔），生产环境不要设置。
import dns from 'node:dns/promises';
import net from 'node:net';

const blocked = (host) => Object.assign(new Error(`不允许访问内网或本机地址：${host}`), { status: 400 });
const allowedHosts = () => (process.env.ALLOW_PRIVATE_URLS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

function isPrivateV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||   // 运营商级 NAT
    (a === 169 && b === 254) ||             // 链路本地，含云元数据 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19));
}

function isPrivateV6(ip) {
  const x = ip.toLowerCase();
  if (x === '::1' || x === '::') return true;
  if (x.startsWith('::ffff:')) {                 // IPv4 映射地址：按里面的 IPv4 判断
    const rest = x.slice(7);
    if (rest.includes('.')) return isPrivateV4(rest);
    const [hi, lo] = rest.split(':').map((h) => parseInt(h, 16));
    return Number.isNaN(hi) || isPrivateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff'); // 唯一本地、链路本地、组播
}

export const isPrivateIp = (ip) => (net.isIPv4(ip) ? isPrivateV4(ip) : net.isIPv6(ip) ? isPrivateV6(ip) : true);

// 地址合法且指向公网才返回 URL 对象，否则抛错（status 400）
export async function assertPublicUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw Object.assign(new Error('网址格式不正确'), { status: 400 }); }
  if (!/^https?:$/.test(u.protocol)) throw Object.assign(new Error('只支持 http / https 网址'), { status: 400 });
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (allowedHosts().includes(host)) return u;
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home)$/.test(host)) throw blocked(host);
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw blocked(host);
    return u;
  }
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); } catch { throw Object.assign(new Error(`无法解析域名：${host}`), { status: 502 }); }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw blocked(host);
  return u;
}

// fetch 的替代：手动处理重定向（最多 5 跳），每一跳都检查；返回的 Response 上有 finalUrl
export async function safeFetch(url, init = {}, maxRedirects = 5) {
  let cur = String(url);
  for (let i = 0; i <= maxRedirects; i++) {
    await assertPublicUrl(cur);
    const res = await fetch(cur, { ...init, redirect: 'manual' });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      await res.body?.cancel();
      cur = new URL(loc, cur).href;
      continue;
    }
    Object.defineProperty(res, 'finalUrl', { value: cur });
    return res;
  }
  throw Object.assign(new Error('重定向次数太多'), { status: 502 });
}
