// SingleFile 等工具保存的网页会把图片、字体都以 data: 地址内联（base64），一份文章常常几十 MB。
// 这里把体积较大的内联资源拆出来，单独存进 Blobs（img/<slug>/<名字>），网页里改成指向本站的地址，
// 这样保存的网页只剩文字和样式，几 MB 就够，图片按需加载。
import { setBinary } from './store.mjs';
import scan from './assets-scan.cjs'; // 必须用静态 import，Netlify 打包函数时才会把它带进去；浏览器端用的是同一份源码

// 按扩展名取回 Content-Type（图片接口输出时用）
export const ASSET_TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
  woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
};

// 有没有体积较大的内联图片/字体（命中即返回，不复制整份网页）
export const hasBigDataUri = scan.hasDataUri;

// 返回 { html, count }：html 里的内联资源已换成 `${origin}/api/img/${slug}/d<n>.<扩展名>`，资源存进 Blobs
export async function externalizeDataUris(html, slug, origin) {
  const { html: out, assets } = scan.extractDataUris(html, `${origin}/api/img/${slug}/`);
  for (const a of assets) await setBinary(`img/${slug}/${a.name}`, Buffer.from(a.b64, 'base64'));
  return { html: out, count: assets.length };
}

// SingleFile 会在文件开头的注释里写原网址：<!-- Page saved with SingleFile  url: https://... -->
export function singleFileUrl(html) {
  const m = html.slice(0, 4000).match(/Page saved with SingleFile[\s\S]{0,200}?\burl:\s*(https?:\/\/[^\s]+)/i);
  return m ? m[1] : '';
}
