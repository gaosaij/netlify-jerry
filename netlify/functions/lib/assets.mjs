// SingleFile 等工具保存的网页会把图片、字体都以 data: 地址内联（base64），一份文章常常几十 MB。
// 这里把体积较大的内联资源拆出来，单独存进 Blobs（img/<slug>/<名字>），网页里改成指向本站的地址，
// 这样保存的网页只剩文字和样式，几 MB 就够，图片按需加载。
import { createHash } from 'node:crypto';
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

export const hasBigDataUri = (html) => /data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=]{1500}/.test(html);

// 返回 { html, count }：html 里的内联资源已换成 `${origin}/api/img/${slug}/d<n>.<扩展名>`
export async function externalizeDataUris(html, slug, origin) {
  const re = /data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=]{1500,})/g;
  const names = new Map(); // base64 内容的哈希 → 文件名（同一张图出现多次只存一份）
  const todo = [];
  for (const m of html.matchAll(re)) {
    const ext = EXT[m[1].toLowerCase()];
    if (!ext || names.size >= MAX_ASSETS) continue;
    const h = createHash('sha1').update(m[2]).digest('hex');
    if (!names.has(h)) {
      names.set(h, `d${names.size}.${ext}`);
      todo.push({ name: names.get(h), b64: m[2] });
    }
  }
  for (const t of todo) await setBinary(`img/${slug}/${t.name}`, Buffer.from(t.b64, 'base64'));
  const out = html.replace(re, (whole, mime, b64) => {
    if (!EXT[mime.toLowerCase()]) return whole;
    const name = names.get(createHash('sha1').update(b64).digest('hex'));
    return name ? `${origin}/api/img/${slug}/${name}` : whole;
  });
  return { html: out, count: todo.length };
}

// SingleFile 会在文件开头的注释里写原网址：<!-- Page saved with SingleFile  url: https://... -->
export function singleFileUrl(html) {
  const m = html.slice(0, 4000).match(/Page saved with SingleFile[\s\S]{0,200}?\burl:\s*(https?:\/\/[^\s]+)/i);
  return m ? m[1] : '';
}
