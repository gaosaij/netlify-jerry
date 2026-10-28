// 在浏览器里把网页里内联的 base64 图片、字体拆出来（SingleFile 保存的网页常有几十到上百 MB）。
// 拆出来的资源逐个单独上传，网页里原来的位置换成占位地址 __ASSET__/<名字>，服务器收到后再换成本站地址。
// 这样上传的 HTML 只剩文字和样式，几 MB 就够，文件大小不再受服务器内存限制。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ExtractAssets = factory();
})(this, function () {
  // 只拆图片和字体（和服务器端 lib/assets.mjs 保持一致）
  const EXT = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico',
    'font/woff2': 'woff2', 'font/woff': 'woff', 'font/ttf': 'ttf', 'font/otf': 'otf', 'font/sfnt': 'ttf',
    'application/font-woff': 'woff', 'application/font-woff2': 'woff2', 'application/x-font-ttf': 'ttf',
    'application/x-font-woff': 'woff', 'application/x-font-opentype': 'otf', 'application/vnd.ms-fontobject': 'eot',
  };
  const MAX_ASSETS = 1500;

  // 线性扫描内联资源。不能用 /[A-Za-z0-9+/=]{1500,}/ 这样的正则去匹配 base64：遇到几 MB 的长串，V8 的正则引擎会栈溢出。
  // visit(mime, b64) 返回要换上的文字；返回 null 表示保持原样。
  function scanDataUris(html, visit) {
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
      if (i - start < 1500) continue; // 小于约 1KB 的不拆
      const rep = visit(m[1], html.slice(start, i));
      if (rep == null) continue;
      parts.push(html.slice(last, m.index), rep);
      last = i;
    }
    parts.push(html.slice(last));
    return parts.join('');
  }

  // 返回 { html, assets: [{ name, ext, b64 }] }；同一份内容出现多次只算一个资源
  function extractDataUris(html) {
    const names = new Map(); // base64 内容 → 名字
    const assets = [];
    const out = scanDataUris(html, (mime, b64) => {
      const ext = EXT[mime.toLowerCase()];
      if (!ext) return null;
      let name = names.get(b64);
      if (!name) {
        if (assets.length >= MAX_ASSETS) return null;
        name = `d${assets.length}.${ext}`;
        names.set(b64, name);
        assets.push({ name, ext, b64 });
      }
      return `__ASSET__/${name}`;
    });
    return { html: out, assets };
  }

  // base64 → 字节（浏览器用 atob，Node 测试用 Buffer）
  function b64ToBytes(b64) {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  return { extractDataUris, b64ToBytes, scanDataUris };
});
