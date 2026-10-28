// SingleFile 等工具保存的网页会把图片、字体都以 data: 地址内联（base64），一份文章常常几十 MB。
// 这里把体积较大的内联资源拆出来，单独存进 Blobs（img/<slug>/<名字>），网页里改成指向本站的地址，
// 这样保存的网页只剩文字和样式，几 MB 就够，图片按需加载。
import { setBinary } from './store.mjs';

// 允许拆出来的类型 → 扩展名（只有图片和字体；脚本、HTML 之类的 data: 不动）
const EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico',
  'font/woff2': 'woff2', 'font/woff': 'woff', 'font/ttf': 'ttf', 'font/otf': 'otf', 'font/sfnt': 'ttf',
  'application/font-woff': 'woff', 'application/font-woff2': 'woff2', 'application/x-font-ttf': 'ttf',
  'application/x-font-woff': 'woff', 'application/x-font-opentype': 'otf', 'application/vnd.ms-fontobject': 'eot',
};

// 按扩展名取回 Content-Type（图片接口输出时用）
export const ASSET_TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
  woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
};

const MIN_BASE64 = 1500;   // 小于约 1KB 的内联资源（图标、占位图）不拆
const MAX_ASSETS = 1500;

// 线性扫描内联资源。不能用 /[A-Za-z0-9+/=]{1500,}/ 这样的正则去匹配 base64：遇到几 MB 的长串，V8 的正则引擎会栈溢出。
// visit(mime, b64) 返回要换上的文字；返回 null 表示保持原样。（浏览器端 admin/extract-assets.js 里有同样的实现，测试保证两边结果一致）
export function scanDataUris(html, visit) {
  const head = /data:([\w.+-]+\/[\w.+-]+);base64,/g;
  const parts = [];
  let last = 0;
  let m;
  while ((m = head.exec(html))) {
    const start = head.lastIndex;
    let i = start;
    while (i < html.length) {
      const c = html.charCodeAt(i);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47 || c === 61) i++;
      else break;
    }
    head.lastIndex = i;
    if (i - start < MIN_BASE64) continue;
    const rep = visit(m[1], html.slice(start, i));
    if (rep == null) continue;
    parts.push(html.slice(last, m.index), rep);
    last = i;
  }
  parts.push(html.slice(last));
  return parts.join('');
}

// 有没有体积较大的内联图片/字体
export function hasBigDataUri(html) {
  let found = false;
  scanDataUris(html, (mime) => { if (EXT[mime.toLowerCase()]) found = true; return null; });
  return found;
}

// 返回 { html, count }：html 里的内联资源已换成 `${origin}/api/img/${slug}/d<n>.<扩展名>`
export async function externalizeDataUris(html, slug, origin) {
  const names = new Map(); // base64 内容 → 文件名（同一张图出现多次只存一份）
  const todo = [];
  const out = scanDataUris(html, (mime, b64) => {
    const ext = EXT[mime.toLowerCase()];
    if (!ext) return null;
    let name = names.get(b64);
    if (!name) {
      if (todo.length >= MAX_ASSETS) return null;
      name = `d${todo.length}.${ext}`;
      names.set(b64, name);
      todo.push({ name, b64 });
    }
    return `${origin}/api/img/${slug}/${name}`;
  });
  for (const t of todo) await setBinary(`img/${slug}/${t.name}`, Buffer.from(t.b64, 'base64'));
  return { html: out, count: todo.length };
}

// SingleFile 会在文件开头的注释里写原网址：<!-- Page saved with SingleFile  url: https://... -->
export function singleFileUrl(html) {
  const m = html.slice(0, 4000).match(/Page saved with SingleFile[\s\S]{0,200}?\burl:\s*(https?:\/\/[^\s]+)/i);
  return m ? m[1] : '';
}
