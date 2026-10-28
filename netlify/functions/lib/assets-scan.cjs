// 内联资源（data: 地址里的 base64 图片、字体）的扫描与拆分。
// 浏览器（管理页上传大 HTML 前先拆）和服务器（兜底路径）共用这一份，由 build.js 复制到 dist/admin/extract-assets.js。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ExtractAssets = factory();
})(this, function () {
  // 只拆图片和字体；脚本、HTML 之类的 data: 不动
  const EXT = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico',
    'font/woff2': 'woff2', 'font/woff': 'woff', 'font/ttf': 'ttf', 'font/otf': 'otf', 'font/sfnt': 'ttf',
    'application/font-woff': 'woff', 'application/font-woff2': 'woff2', 'application/x-font-ttf': 'ttf',
    'application/x-font-woff': 'woff', 'application/x-font-opentype': 'otf', 'application/vnd.ms-fontobject': 'eot',
  };
  const MIN_BASE64 = 1500; // 小于约 1KB 的内联资源（图标、占位图）不拆
  const MAX_ASSETS = 1500;

  const isB64 = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47 || c === 61;

  // 线性扫描。不能用 /[A-Za-z0-9+/=]{1500,}/ 这样的正则匹配 base64：遇到几 MB 的长串，V8 的正则引擎会栈溢出。
  // visit(mime, b64) 返回要换上的文字；返回 null 表示保持原样。一处都没换时原样返回 html（不复制几十 MB 的字符串）。
  function scanDataUris(html, visit) {
    const head = /data:([\w.+-]+\/[\w.+-]+);base64,/g;
    let parts = null;
    let last = 0;
    let m;
    while ((m = head.exec(html))) {
      const start = head.lastIndex;
      let i = start;
      while (i < html.length && isB64(html.charCodeAt(i))) i++;
      head.lastIndex = i;
      if (i - start < MIN_BASE64) continue;
      const rep = visit(m[1], html.slice(start, i));
      if (rep == null) continue;
      (parts || (parts = [])).push(html.slice(last, m.index), rep);
      last = i;
    }
    if (!parts) return html;
    parts.push(html.slice(last));
    return parts.join('');
  }

  // 有没有值得拆的内联图片/字体：命中第一个就返回，并且最多只看每个候选的前 MIN_BASE64 个字符
  function hasDataUri(html) {
    const head = /data:([\w.+-]+\/[\w.+-]+);base64,/g;
    let m;
    while ((m = head.exec(html))) {
      if (!EXT[m[1].toLowerCase()]) continue;
      let i = head.lastIndex;
      const need = i + MIN_BASE64;
      while (i < html.length && i < need && isB64(html.charCodeAt(i))) i++;
      if (i >= need) return true;
    }
    return false;
  }

  // 返回 { html, assets: [{ name, ext, b64 }] }：资源换成 `${prefix}${名字}`；同一份内容出现多次只算一个资源
  function extractDataUris(html, prefix = '__ASSET__/') {
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
      return prefix + name;
    });
    return { html: out, assets };
  }

  // base64 → 字节（浏览器用 atob，Node 用 Buffer）
  function b64ToBytes(b64) {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  return { EXT, scanDataUris, hasDataUri, extractDataUris, b64ToBytes };
});
