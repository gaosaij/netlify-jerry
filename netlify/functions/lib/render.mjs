// 渲染中英对照页：一段英文、一段中文；翻译未完成时顶部显示进度并自动刷新
import { Marked } from 'marked';
import * as cheerio from 'cheerio';
import { showZh } from './parse.mjs';
import { VIEWMODE_CSS, viewModeHeadScript, viewModeBodyScript, showViewMode } from './viewmode.mjs';

export const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Markdown 渲染器：原文里夹带的 HTML 一律转义，链接/图片只允许安全协议
const safeUrl = (u) => /^(https?:|mailto:|\/|#)/i.test(u || '');
const md = new Marked({
  gfm: true,
  renderer: {
    html: (t) => esc(t.text ?? t),
    link({ href, title, tokens }) {
      const inner = this.parser.parseInline(tokens);
      if (!safeUrl(href)) return inner;
      return `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ''} target="_blank" rel="noopener noreferrer">${inner}</a>`;
    },
    image({ href, text }) {
      return /^(https?:|\/api\/img\/)/i.test(href || '') ? `<img src="${esc(href)}" alt="${esc(text)}" loading="lazy">` : esc(text);
    },
  },
});

// OCR 得到的表格是 HTML：只保留表格相关标签，去掉所有属性（colspan/rowspan 除外）
function safeTable(html) {
  const $ = cheerio.load(html, null, false);
  $('*').each((_, el) => {
    if (!/^(table|thead|tbody|tfoot|tr|th|td|caption|br)$/.test(el.tagName)) { $(el).replaceWith($(el).text()); return; }
    for (const name of Object.keys(el.attribs || {})) if (!/^(colspan|rowspan)$/.test(name)) $(el).removeAttr(name);
  });
  return $.html();
}

const inline = (b, text) => (b.md ? md.parseInline(text) : esc(text));

function blockHtml(b) {
  if (b.k === 'img') return /^https?:/i.test(b.src || '') ? `<figure class="fig"><img src="${esc(b.src)}" alt="${esc(b.en || '')}" loading="lazy"></figure>` : '';
  if (b.k === 'raw') return `<div class="raw">${md.parse(b.en)}</div>`;
  if (b.k === 'table') return `<div class="raw table-wrap">${safeTable(b.en)}</div>`;
  if (b.k === 'pre') return `<pre>${esc(b.en)}</pre>`;
  const isHeading = /^h[1-6]$/.test(b.k);
  const tag = isHeading ? b.k : b.k === 'quote' ? 'blockquote' : 'p';
  const cls = b.k === 'li' ? ' li' : '';
  const en = `<${tag} class="en${cls}">${inline(b, b.en)}</${tag}>`;
  if (!showZh(b)) return `<section class="pair">${en}</section>`;
  return `<section class="pair">${en}<${tag} class="zh${cls}">${inline(b, b.zh)}</${tag}></section>`;
}

const STATUS_TEXT = {
  importing: '正在抓取并解析网页',
  ocr: 'OCR 识别中',
  queued: '排队等待翻译…',
  translating: '正在翻译',
  error: '翻译中断',
  idle: '尚未翻译',
};

function banner(meta) {
  const active = ['importing', 'ocr', 'queued', 'translating'].includes(meta.status);
  const total = meta.total || 0;
  const done = Math.min(meta.done || 0, total);
  const pct = total ? Math.floor((done / total) * 100) : 0;
  let inner = '';
  if (meta.status === 'done' || meta.status === 'skip') {
    inner = '';
  } else {
    inner = meta.status === 'importing'
      ? `<div class="bar-text">正在抓取并解析网页（大文件可能要几分钟），页面会自动更新${meta.error ? `<br><span class="err">${esc(meta.error)}</span>` : ''}</div>`
      : meta.status === 'ocr'
      ? `<div class="bar-text">OCR 识别中：${meta.ocrDone || 0} / ${meta.ocrTotal || '?'} 页，识别完成后自动开始翻译，页面会自动更新${meta.error ? `<br><span class="err">${esc(meta.error)}</span>` : ''}</div>`
      : `<div class="bar-text">${STATUS_TEXT[meta.status] || ''}：${done} / ${total} 段（${pct}%）${
      active ? '，页面会自动更新' : ''
    }${meta.error ? `<br><span class="err">${esc(meta.error)}</span>` : ''}</div>
      <div class="bar"><div style="width:${pct}%"></div></div>`;
  }
  const note = meta.note && ['skip', 'idle'].includes(meta.status) ? `<div class="bar-text">${esc(meta.note)}</div>` : '';
  return `<div id="progress" data-active="${active ? 1 : 0}" data-updated="${meta.updatedAt}"${
    inner || note ? ' class="show"' : ''
  }>${inner}${note}</div>`;
}

const CSS = `
  :root { --bg:#fff; --fg:#1a1a1a; --muted:#666; --border:#e5e5e5; --accent:#007bff; --code-bg:#f4f4f5; --zh:#0b4a8f; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#14161a; --fg:#e8e8e8; --muted:#9a9a9a; --border:#2a2d33; --accent:#4c9aff; --code-bg:#1f2228; --zh:#8ec0ff; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font-size:17px; line-height:1.75;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,"PingFang SC","Microsoft YaHei",sans-serif; }
  main { max-width:760px; margin:0 auto; padding:32px 20px 96px; overflow-wrap:break-word; }
  .back { display:inline-block; margin-bottom:20px; font-size:14px; color:var(--muted); text-decoration:none; }
  .back:hover { color:var(--accent); }
  #progress { display:none; margin:0 0 24px; padding:12px 16px; border:1px solid var(--border); border-radius:10px; font-size:14px; color:var(--muted); }
  #progress.show { display:block; }
  .bar { height:6px; margin-top:8px; background:var(--border); border-radius:3px; overflow:hidden; }
  .bar div { height:100%; background:var(--accent); transition:width .4s; }
  .err { color:#d33; }
  .pair { margin:0 0 1.3em; }
  .pair > * { margin:0 0 .35em; }
  h1,h2,h3,h4,h5,h6 { line-height:1.35; }
  h1 { font-size:28px; } h2 { font-size:23px; } h3 { font-size:20px; } h4,h5,h6 { font-size:18px; }
  .zh { color:var(--zh); }
  .li::before { content:"•"; margin-right:.6em; color:var(--muted); }
  blockquote { padding:.1em 1em; border-left:4px solid var(--border); color:var(--muted); }
  .fig { margin:0 0 1.3em; } .fig img { display:block; max-width:100%; height:auto; border-radius:6px; }
  .pager { display:flex; justify-content:space-between; gap:12px; margin:0 0 24px; font-size:14px; color:var(--muted); }
  .pager a { color:var(--accent); text-decoration:none; }
  .table-wrap { overflow-x:auto; margin:0 0 1.3em; }
  .table-wrap table { border-collapse:collapse; } .table-wrap td, .table-wrap th { border:1px solid var(--border); padding:4px 10px; }
  pre { background:var(--code-bg); padding:14px 16px; border-radius:8px; overflow-x:auto; font-size:14px; }
  code { background:var(--code-bg); padding:.15em .35em; border-radius:4px; font-size:.9em; }
  a { color:var(--accent); } img { max-width:100%; height:auto; }
`;

// 翻译进行中时，每 8 秒拉取一次最新页面，只替换进度条和正文，不打断阅读位置
// 翻译进行中时的自动刷新：每 8 秒先查一个很小的状态接口，只有进度（updatedAt）真的变了才下载整页并替换进度条和正文，
// 不打断阅读位置，也不会每 8 秒都让服务器重新渲染整份文章
const POLL = `
(function () {
  var timer = setInterval(function () {
    var p = document.getElementById('progress');
    if (!p || p.dataset.active !== '1') { clearInterval(timer); return; }
    var slug = decodeURIComponent(location.pathname.replace(/^\\/t\\//, '').replace(/\\/$/, ''));
    fetch('/api/articles/' + encodeURIComponent(slug), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (m) {
        if (!m || String(m.updatedAt) === p.dataset.updated) return null;
        return fetch(location.pathname + location.search + (location.search ? '&' : '?') + '_=' + Date.now(), { cache: 'no-store' })
          .then(function (r) { return r.text(); });
      })
      .then(function (t) {
        if (!t) return;
        var d = new DOMParser().parseFromString(t, 'text/html');
        var np = d.getElementById('progress');
        if (!np || np.dataset.updated === p.dataset.updated) return;
        p.replaceWith(np);
        document.querySelector('article').innerHTML = d.querySelector('article').innerHTML;
      }).catch(function () {});
  }, 8000);
})();`;

export const PAGE_SIZE = 400;

// 整页图片 OCR 出来的段落（ocrAfter = 图片在 blocks 里的下标）放回对应图片后面
function ordered(blocks) {
  const after = new Map();
  blocks.forEach((b) => { if (b.ocrAfter != null) (after.get(b.ocrAfter) || after.set(b.ocrAfter, []).get(b.ocrAfter)).push(b); });
  const out = [];
  blocks.forEach((b, i) => {
    if (b.ocrAfter != null) return;
    out.push(b);
    (after.get(i) || []).forEach((x) => out.push(x));
  });
  return out;
}

export function renderPage(meta, doc, nonce, pageNo = 1) {
  const list = ordered(doc.blocks);
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const cur = Math.min(Math.max(1, pageNo), pages);
  const body = list.slice((cur - 1) * PAGE_SIZE, cur * PAGE_SIZE).map(blockHtml).join('\n');
  const pager = pages > 1
    ? `<nav class="pager">${cur > 1 ? `<a href="?p=${cur - 1}">← 上一页</a>` : '<span></span>'}<span>第 ${cur} / ${pages} 页</span>${cur < pages ? `<a href="?p=${cur + 1}">下一页 →</a>` : '<span></span>'}</nav>`
    : '';
  const active = ['importing', 'ocr', 'queued', 'translating'].includes(meta.status);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(meta.title)}</title>
<style>${CSS}${showViewMode(meta) ? VIEWMODE_CSS : ''}</style>
${showViewMode(meta) ? viewModeHeadScript(nonce) : ''}
</head>
<body>
  <main>
    <a class="back" href="/">← 文章列表</a>
    ${banner(meta)}
    ${pager}
    <article>
${body}
    </article>
    ${pager}
  </main>
${active ? `<script nonce="${nonce}">${POLL}</script>` : ''}
${showViewMode(meta) ? viewModeBodyScript(nonce) : ''}
</body>
</html>`;
}

// 保留原网页样式：在每个已翻译元素后面插入同标签、同 class 的译文元素，样式和原文完全一致
const FIXED_BOX = 'position:fixed;right:12px;bottom:12px;z-index:99999;max-width:260px;padding:8px 12px;' +
  'background:rgba(0,0,0,.78);color:#fff;font:13px/1.5 -apple-system,"PingFang SC",sans-serif;border-radius:8px';

const STYLED_POLL = `
(function () {
  var timer = setInterval(function () {
    var p = document.getElementById('progress');
    if (!p || p.dataset.active !== '1') { clearInterval(timer); return; }
    var slug = decodeURIComponent(location.pathname.replace(/^\\/t\\//, '').replace(/\\/$/, ''));
    fetch('/api/articles/' + encodeURIComponent(slug), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (m) {
        if (!m || String(m.updatedAt) === p.dataset.updated) return null;
        return fetch(location.pathname + location.search + (location.search ? '&' : '?') + '_=' + Date.now(), { cache: 'no-store' })
          .then(function (r) { return r.text(); });
      })
      .then(function (t) {
        if (!t) return;
        var d = new DOMParser().parseFromString(t, 'text/html');
        var np = d.getElementById('progress');
        if (np && np.dataset.updated === p.dataset.updated) return;
        document.body.innerHTML = d.body.innerHTML;
      }).catch(function () {});
  }, 8000);
})();`;

export function renderStyledPage(meta, doc, html, nonce) {
  const $ = cheerio.load(html);
  $('title').first().text(meta.title); // 原网页标题可能是 full 之类，用文章标题
  const byId = new Map();
  $('[data-tid]').each((_, el) => byId.set(el.attribs['data-tid'], el));
  doc.blocks.forEach((b, i) => {
    if (!showZh(b)) return;
    const el = byId.get(String(i));
    if (!el) return;
    const $el = $(el);
    if (el.tagName === 'td' || el.tagName === 'th') {
      $el.append($('<div class="zh-tr"></div>').text(b.zh)); // 表格单元格里不能再插新单元格
      return;
    }
    const c = $el.clone();
    c.removeAttr('data-tid').removeAttr('id').removeAttr('name').addClass('zh-tr').text(b.zh);
    $el.after(c);
  });
  // 整页图片 OCR 出来的文字：放在对应图片后面，一段原文一段译文
  const ocr = new Map();
  doc.blocks.forEach((b) => { if (b.ocrAfter != null) (ocr.get(String(b.ocrAfter)) || ocr.set(String(b.ocrAfter), []).get(String(b.ocrAfter))).push(b); });
  ocr.forEach((list, tid) => {
    const el = byId.get(tid);
    if (!el) return;
    const wrap = $('<div class="ocr-text" style="font-family:Georgia,serif;font-size:11pt;line-height:1.6;margin:8px 0 18px"></div>');
    wrap.append(list.map((b) => blockHtml(b)).join(''));
    wrap.find('.zh').each((_, z) => { $(z).css('color', '#0b4a8f'); });
    $(el).after(wrap);
  });
  $('[data-tid]').removeAttr('data-tid'); // 内部标记，输出前去掉

  const active = ['importing', 'ocr', 'queued', 'translating'].includes(meta.status);
  const total = meta.total || 0;
  const done = Math.min(meta.done || 0, total);
  const pct = total ? Math.floor((done / total) * 100) : 0;
  const text = meta.status === 'done' || meta.status === 'skip' ? '' :
    `${STATUS_TEXT[meta.status] || ''}：${done} / ${total} 段（${pct}%）${active ? '，页面自动更新' : ''}` +
    (meta.error ? `<br>${esc(meta.error)}` : '');
  const box = `<div id="progress" data-active="${active ? 1 : 0}" data-updated="${meta.updatedAt}"` +
    (text ? ` style="${FIXED_BOX}">${text}` : ' style="display:none">') + '</div>';
  $('body').append(box);
  if (active) $('body').append(`<script nonce="${nonce}">${STYLED_POLL}</script>`);
  if (showViewMode(meta)) {
    $('head').append(`<style>${VIEWMODE_CSS}</style>${viewModeHeadScript(nonce)}`);
    $('body').append(viewModeBodyScript(nonce));
  }
  return $.html();
}

// ================= PDF 转 HTML 的“文档版式”：每页一张白色卡片，像原页面一样 =================
// 段落保留原来的字体、字号、加粗、斜体、颜色，译文紧跟在后面；
// 表格原样保留（放在相对定位的容器里，外观和原页面一样），下面再放一个中文对照表。
export const DOC_PAGES_PER_VIEW = 20;

// 把分段按原页码分组；OCR 识别出的文字（ocrAfter）跟在对应图片后面，表格单元格不单独显示
export function docPages(blocks) {
  const pages = [];
  let cur = null;
  let curKey = null;
  for (const b of ordered(blocks)) {
    if (b.k === 'cell') continue;
    const key = b.page != null ? b.page : curKey != null ? curKey : 0;
    if (!cur || key !== curKey) { cur = { page: key, blocks: [] }; pages.push(cur); curKey = key; }
    cur.blocks.push(b);
  }
  return pages;
}

// 当前这一屏要显示哪些页，以及需要读取哪些表格的原始 HTML
export function docView(blocks, viewNo = 1) {
  const all = docPages(blocks);
  const total = Math.max(1, Math.ceil(all.length / DOC_PAGES_PER_VIEW));
  const cur = Math.min(Math.max(1, viewNo), total);
  const pages = all.slice((cur - 1) * DOC_PAGES_PER_VIEW, cur * DOC_PAGES_PER_VIEW);
  const keys = pages.flatMap((p) => p.blocks.filter((b) => b.k === 'table').map((b) => b.tkey));
  return { pages, total, cur, keys };
}

const safeFamily = (f) => (f && /^[\w .-]{1,40}$/.test(f) ? f : '');
const safeColor = (c) => (c && /^#[0-9a-f]{3,8}$/i.test(c) ? c : '');

function docCss(st, zh) {
  if (!st) return '';
  const fam = safeFamily(st.f);
  const stack = zh ? `${fam ? `'${fam}', ` : ''}'Songti SC','Noto Serif CJK SC','SimSun',serif` : `${fam ? `'${fam}', ` : ''}serif`;
  const color = safeColor(st.c) || (zh ? '#17406b' : '');
  return `font-family:${stack};font-size:${Number(st.sz) || 9.5}pt;${st.b ? 'font-weight:bold;' : ''}${st.i ? 'font-style:italic;' : ''}${color ? `color:${color};` : ''}`;
}

const NUMERIC = /^[\s$()\d,.%—–-]+$/;

// 中文对照表：按原表格的行列生成；文字单元格显示译文（没翻译完就先显示原文），数字原样；全空的列去掉
function zhTable(b, blocks) {
  const text = (c) => (c[1] != null ? (showZh(blocks[c[1]]) ? blocks[c[1]].zh : blocks[c[1]].en) : c[0] || '');
  const grid = b.rows.map((r) => { let col = 0; return r.map((c) => { const o = { c, c0: col, span: c[2] || 1 }; col += o.span; return o; }); });
  const used = new Set();
  grid.forEach((r) => r.forEach((o) => { if (text(o.c)) for (let k = 0; k < o.span; k++) used.add(o.c0 + k); }));
  const rows = [];
  for (const r of grid) {
    if (!r.some((o) => text(o.c))) continue;
    const tds = [];
    for (const o of r) {
      let span = 0;
      for (let k = 0; k < o.span; k++) if (used.has(o.c0 + k)) span++;
      if (!span) continue;
      const t = text(o.c);
      tds.push(`<td${span > 1 ? ` colspan="${span}"` : ''}${NUMERIC.test(t) ? ' class="num"' : ''}>${esc(t)}</td>`);
    }
    rows.push(`<tr>${tds.join('')}</tr>`);
  }
  return rows.length ? `<div class="zt-cap">中文对照</div><table class="zt">${rows.join('')}</table>` : '';
}

function docBlockHtml(b, blocks, tables) {
  if (b.k === 'table') {
    // 没有 tkey 的表格是 OCR 识别出来的（MinerU 返回的 <table>），没有原始版式可还原，按通用方式（去掉所有属性）显示
    if (b.tkey == null) return blockHtml(b);
    const raw = tables.get(b.tkey);
    if (!raw) return '';
    return `<div class="tscroll"><div class="torig" style="position:relative;width:${Number(b.w) || 468}pt;height:${Number(b.h) || 0}pt;margin:0 auto">${raw}</div>${zhTable(b, blocks)}</div>`;
  }
  if (b.k === 'img') {
    if (!/^https?:/i.test(b.src || '')) return '';
    const w = Number(b.w) > 0 ? `width:${Number(b.w)}pt;` : '';
    return `<figure class="fig"><img src="${esc(b.src)}" alt="${esc(b.en || '')}" loading="lazy" style="${w}max-width:100%;height:auto"></figure>`;
  }
  if (b.k === 'raw' || b.k === 'pre') return blockHtml(b);
  const tag = /^h[1-6]$/.test(b.k) ? b.k : 'p';
  const cls = tag === 'p' ? 'd' : 'd dh';
  const en = `<${tag} class="${cls}" style="${docCss(b.st, false)}">${inline(b, b.en)}</${tag}>`;
  if (!showZh(b)) return en;
  return en + `<${tag} class="${cls} dz" style="${docCss(b.st || { sz: 9.5 }, true)}">${inline(b, b.zh)}</${tag}>`;
}

const DOC_CSS = `
  * { box-sizing: border-box; }
  body { margin:0; background:#E4E4E4; color:#000; font-family:Arial, sans-serif; }
  main { padding:16px 8px 80px; }
  .back { display:inline-block; margin:0 0 10px; font-size:14px; color:#555; text-decoration:none; }
  #progress { display:none; max-width:612pt; margin:0 auto 12px; padding:12px 16px; background:#fff; border:1px solid #ccc; border-radius:8px; font-size:14px; color:#555; }
  #progress.show { display:block; }
  .bar { height:6px; margin-top:8px; background:#ddd; border-radius:3px; overflow:hidden; } .bar div { height:100%; background:#007bff; }
  .err { color:#d33; }
  .pager { display:flex; justify-content:space-between; gap:12px; max-width:612pt; margin:0 auto 10px; font-size:14px; color:#555; } .pager a { color:#007bff; text-decoration:none; }
  .wrap { max-width:612pt; margin:0 auto; } .wrap-top { max-width:612pt; margin:0 auto; }
  .pgcard { --justify:justify; background:#fff; border:1px solid #ccc; width:612pt; max-width:100%; margin:10px auto; padding:48pt 72pt; overflow-wrap:break-word; }
  @media (max-width: 800px) { .pgcard { padding:24pt 5vw; } }
  .pgno { margin:-38pt 0 22pt; text-align:right; font:8pt/1 Arial,sans-serif; color:#aaa; }
  .d { margin:0 0 .55em; text-align:justify; line-height:1.4; font-family:Georgia,serif; font-size:9.5pt; }
  .dh { margin-top:1.1em; text-align:left; line-height:1.3; }
  .dz { margin-top:-.15em; }
  .fig { margin:.6em 0 1em; text-align:center; } .fig img { display:inline-block; }
  .tscroll, .table-wrap { overflow-x:auto; margin:.4em 0 1em; }
  .table-wrap table { border-collapse:collapse; font:9pt Georgia,serif; } .table-wrap td, .table-wrap th { border:1px solid #ccc; padding:3px 8px; vertical-align:top; }
  .zt-cap { margin:.5em 0 .2em; font:8pt Arial,sans-serif; color:#17406b; }
  .zt { border-collapse:collapse; width:100%; font:9pt Georgia,"Songti SC","Noto Serif CJK SC",serif; color:#17406b; }
  .zt td { padding:2px 6px; border-bottom:1px solid #e3e3e3; vertical-align:top; } .zt td.num { text-align:right; white-space:nowrap; }
  pre { background:#f4f4f5; padding:8px 10px; overflow-x:auto; font-size:8pt; }
`;

export function renderDocPage(meta, doc, tables, nonce, viewNo = 1) {
  const { pages, total, cur } = docView(doc.blocks, viewNo);
  const body = pages.map((p) =>
    `<section class="pgcard"><div class="pgno">第 ${p.page + 1} 页</div>${p.blocks.map((b) => docBlockHtml(b, doc.blocks, tables)).join('\n')}</section>`).join('\n');
  const pager = total > 1
    ? `<nav class="pager">${cur > 1 ? `<a href="?p=${cur - 1}">← 上一部分</a>` : '<span></span>'}<span>第 ${cur} / ${total} 部分（每部分 ${DOC_PAGES_PER_VIEW} 页）</span>${cur < total ? `<a href="?p=${cur + 1}">下一部分 →</a>` : '<span></span>'}</nav>`
    : '';
  const active = ['importing', 'ocr', 'queued', 'translating'].includes(meta.status);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(meta.title)}</title>
<style>${DOC_CSS}${showViewMode(meta) ? VIEWMODE_CSS : ''}</style>
${showViewMode(meta) ? viewModeHeadScript(nonce) : ''}
</head>
<body>
  <main>
    <div class="wrap-top"><a class="back" href="/">← 文章列表</a></div>
    ${banner(meta)}
    ${pager}
    <article>
${body}
    </article>
    ${pager}
  </main>
${active ? `<script nonce="${nonce}">${POLL}</script>` : ''}
${showViewMode(meta) ? viewModeBodyScript(nonce) : ''}
</body>
</html>`;
}
