// 渲染中英对照页：一段英文、一段中文；翻译未完成时顶部显示进度并自动刷新
import { Marked } from 'marked';
import * as cheerio from 'cheerio';

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
  if (b.s || !b.zh) return `<section class="pair">${en}</section>`;
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
const POLL = `
(function () {
  var timer = setInterval(function () {
    var p = document.getElementById('progress');
    if (!p || p.dataset.active !== '1') { clearInterval(timer); return; }
    fetch(location.pathname + location.search + (location.search ? '&' : '?') + '_=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.text(); })
      .then(function (t) {
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
<style>${CSS}</style>
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
    fetch(location.pathname + location.search + (location.search ? '&' : '?') + '_=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.text(); })
      .then(function (t) {
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
    if (!b.zh || b.s) return;
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
  return $.html();
}
