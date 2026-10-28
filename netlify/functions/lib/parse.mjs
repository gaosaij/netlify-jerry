// 把 HTML / Markdown / 纯文本 解析成“分段”列表，并检测文章是否已经有中文
//   分段字段：k=类型(p/h1-h6/li/quote/pre/raw)  en=原文  zh=译文  md=原文含 Markdown 行内语法  s=1 表示无需翻译
import * as cheerio from 'cheerio';
import { randomBytes, createHash } from 'node:crypto';

const CJK = /[㐀-鿿豈-﫿]/g;
const LATIN = /[A-Za-z]/g;

// 中文字符占（中文+英文字母）的比例
export function cjkRatio(text) {
  const c = (text.match(CJK) || []).length;
  const l = (text.match(LATIN) || []).length;
  return c + l === 0 ? 0 : c / (c + l);
}

// 段落已经是中文，或中英混排（常见于浏览器翻译插件保存的网页：译文和原文在同一段里）
function hasChinese(text) {
  const r = cjkRatio(text);
  return r > 0.3 || (r > 0.12 && (text.match(CJK) || []).length >= 6);
}

export function mkBlock(k, en, extra = {}) {
  en = en.trim();
  const b = { k, en, ...extra };
  // 代码块、图片表格等原样内容、没有英文字母的（纯数字符号）、本身已是中文的，都不需要翻译
  if (k === 'pre' || k === 'raw' || k === 'table' || k === 'img' || !/[A-Za-z]/.test(en) || hasChinese(en)) b.s = 1;
  return b;
}

export const needsTranslation = (b) => !b.s && !b.zh;

export function parseMarkdown(src) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  let fence = null;
  let block = null; // 正在收集的多行块（表格、公式）
  const flush = () => {
    if (para.length) blocks.push(mkBlock('p', para.join(' ').replace(/\s+/g, ' '), { md: 1 }));
    para = [];
  };
  const push = (k, text, extra) => blocks.push(mkBlock(k, text.replace(/&amp;/g, '&'), { md: 1, ...extra }));
  for (const line of lines) {
    if (fence) {
      fence.push(line);
      if (/^\s*```/.test(line)) { blocks.push(mkBlock('pre', fence.join('\n'))); fence = null; }
      continue;
    }
    if (/^\s*```/.test(line)) { flush(); fence = [line]; continue; }
    if (block) {
      block.lines.push(line);
      if (block.end.test(line)) { blocks.push(mkBlock(block.k, block.lines.join('\n'))); block = null; }
      continue;
    }
    if (/^\s*<table\b/i.test(line)) {
      flush();
      if (/<\/table>/i.test(line)) blocks.push(mkBlock('table', line));
      else block = { k: 'table', lines: [line], end: /<\/table>/i };
      continue;
    }
    if (/^\s*\$\$/.test(line)) {
      flush();
      const t = line.trim();
      if (t.length > 2 && t.endsWith('$$')) blocks.push(mkBlock('pre', t));
      else block = { k: 'pre', lines: [line], end: /\$\$\s*$/ };
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/))) { flush(); push('h' + m[1].length, m[2]); continue; }
    if ((m = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/))) { flush(); push('li', m[1]); continue; }
    if ((m = line.match(/^\s*>\s?(.*)$/))) { flush(); push('quote', m[1]); continue; }
    if (/^\s*(!\[.*\]\(.*\)|<img\b.*>|\|.*\||[-*_]{3,}\s*$)/.test(line)) {
      flush(); blocks.push(mkBlock('raw', line)); continue;
    }
    para.push(line.trim());
  }
  flush();
  if (fence) blocks.push(mkBlock('pre', fence.join('\n')));
  if (block) blocks.push(mkBlock(block.k, block.lines.join('\n')));
  const h1 = blocks.find((b) => b.k === 'h1');
  return { title: h1 ? h1.en : '', blocks };
}

export function parseText(src) {
  const blocks = src.replace(/\r\n?/g, '\n').split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((p) => mkBlock('p', p));
  return { title: '', blocks };
}

// 图片显示尺寸（pt）：优先看 style 里的 width/height（pt 或 px），其次看 width/height 属性（px）
export function cssLength(style, prop) {
  const m = String(style || '').match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*(-?[\\d.]+)\\s*(pt|px)?`, 'i'));
  if (!m) return null;
  return m[2] && m[2].toLowerCase() === 'px' ? Number(m[1]) * 0.75 : Number(m[1]);
}
const imgSize = (style, attrs) => ({
  w: cssLength(style, 'width') ?? (attrs.width ? Number(attrs.width) * 0.75 : null),
  h: cssLength(style, 'height') ?? (attrs.height ? Number(attrs.height) * 0.75 : null),
});
// “整页大图”：接近一页纸大小（PDF 转 HTML 时整页做成图片，文字在图里，需要 OCR）
export const isPageImage = (w, h) => w >= 400 && h >= 550;
export function absoluteHttpUrl(src, baseUrl) {
  try {
    const u = new URL(src, baseUrl || undefined);
    return /^https?:$/.test(u.protocol) ? u.href : '';
  } catch { return ''; }
}

// 取元素文字。公式（MathML / KaTeX / MathJax）会同时带“渲染文字”和“LaTeX 注释”，直接 .text() 会叠成乱码
// （如 b10b_{10}），所以公式统一换成 $LaTeX$，没有 LaTeX 注释的才用渲染文字
function textOf($, $el) {
  const c = $el.clone();
  c.find('.katex-html,.MathJax_Preview,.MathJax_Display,mjx-assistive-mml').remove();
  c.find('math,.katex,mjx-container').each((_, m) => {
    const $m = $(m);
    const tex = $m.find('annotation[encoding="application/x-tex"]').first().text().trim() || $m.attr('alttext') || '';
    $m.replaceWith(tex ? ` $${tex.replace(/\s+/g, ' ')}$ ` : ` ${$m.text()} `);
  });
  return c.text();
}

// 从网页里抽取正文分段（标题、段落、列表项、引用、代码块）
// annotate=true 时，在每个需要翻译的元素上写 data-tid=分段下标，并返回完整网页 html，
// 之后渲染时就能在原元素后面插入同样式的译文，保留原网页的样式和图片
export function parseHtml(html, { annotate = false, images = false, baseUrl = '' } = {}) {
  const $ = cheerio.load(html);
  const title = $('title').first().text().replace(/\s+/g, ' ').trim();
  let root = $('article').first();
  if (!root.length) root = $('main').first();
  if (!root.length) root = $('body').first();

  const nested = 'p,li,h1,h2,h3,h4,h5,h6,pre,blockquote,table,ul,ol';
  const ignored = 'script,style,noscript,svg,nav,footer,aside,form,iframe,template,head';
  const blocks = [];
  root.find('p,li,h1,h2,h3,h4,h5,h6,pre,blockquote,figcaption,td,th,img').each((_, el) => {
    const tag = el.tagName.toLowerCase();
    const $el = $(el);
    if ($el.closest(ignored).length) return; // 导航、页脚、侧栏等不翻译
    if (tag === 'img') {
      // 图片标记：保持图片在文章里的位置；整页大图会被标记出来交给 OCR
      const src = images ? absoluteHttpUrl($el.attr('src'), baseUrl) : '';
      if (!src) return;
      const { w, h } = imgSize($el.attr('style'), el.attribs || {});
      if ((w != null && w < 30) || (h != null && h < 30)) return;
      const b = mkBlock('img', ($el.attr('alt') || '').trim(), { src });
      if (w != null && h != null && isPageImage(w, h)) b.big = 1;
      if (annotate) $el.attr('data-tid', blocks.length);
      blocks.push(b);
      return;
    }
    // 内部还有段落/列表的容器不单独取，避免重复
    if (['li', 'blockquote', 'td', 'th'].includes(tag) && $el.find(nested).length) return;
    const text = tag === 'pre' ? $el.text() : textOf($, $el).replace(/\s+/g, ' ').replace(/\s+([.,;:!?)])/g, '$1').trim();
    if (!text.trim()) return;
    if ((tag === 'td' || tag === 'th') && text.length < 60) return; // 表格里的短单元格多为数据，不翻译
    const k = tag === 'pre' ? 'pre' : /^h[1-6]$/.test(tag) ? tag : tag === 'li' ? 'li' : tag === 'blockquote' ? 'quote' : 'p';
    const b = mkBlock(k, text);
    if (annotate && !b.s) $el.attr('data-tid', blocks.length);
    blocks.push(b);
  });
  // <title> 为空或是“full / untitled”这类没意义的词时，改用正文第一个 h1
  const useful = title && !/^(full|untitled|index|document|home)$/i.test(title);
  return {
    title: useful ? title : (blocks.find((b) => b.k === 'h1') || {}).en || title,
    blocks,
    html: annotate ? $.html() : undefined,
  };
}

// 浏览器端（如 PDF 提取）直接给出分段时，校验后使用
const KINDS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'quote']);
export function blocksFromClient(list) {
  if (!Array.isArray(list) || list.length > 50000) throw new Error('分段数据不正确');
  return list
    .filter((b) => b && KINDS.has(b.k) && typeof b.en === 'string' && b.en.trim())
    .map((b) => mkBlock(b.k, b.en.slice(0, 20000)));
}

// 按扩展名选择解析器
export function parseByFormat(filename, content) {
  if (/\.html?$/i.test(filename) || /^\s*(<!doctype html|<html)/i.test(content)) return parseHtml(content, { annotate: true });
  if (/\.(md|markdown)$/i.test(filename)) return parseMarkdown(content);
  return parseText(content);
}

// 检测文章是否已有中文：含中文的段落占 20% 以上，或全文中文字符占比 12% 以上
// （纯英文文章里偶尔出现的中文人名、引文不会触发）
export function analyze(blocks) {
  let zh = 0, en = 0, toTranslate = 0;
  const all = [];
  for (const b of blocks) {
    if (b.k === 'pre' || b.k === 'raw' || b.k === 'table' || b.k === 'img') continue;
    all.push(b.en);
    if (hasChinese(b.en)) zh++;
    else if (/[A-Za-z]/.test(b.en)) en++;
    if (needsTranslation(b)) toTranslate++;
  }
  const alreadyChinese = zh + en === 0 || zh / (zh + en) >= 0.2 || cjkRatio(all.join(' ')) >= 0.12;
  return { zhBlocks: zh, enBlocks: en, total: toTranslate, alreadyChinese };
}

export const contentHash = (blocks) =>
  createHash('sha1').update(blocks.filter((b) => b.k !== 'img').map((b) => b.en).join('\n')).digest('hex');

export function makeSlug(title) {
  const base = String(title || '').toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'article';
  return `${base}-${randomBytes(3).toString('hex')}`;
}

export const validSlug = (s) => /^[a-z0-9-]{1,80}$/.test(s || '');

// 按响应头 / meta 声明的编码解码网页字节
export function decodeBody(buf, contentType = '') {
  let charset = (contentType.match(/charset=([^;\s]+)/i) || [])[1];
  if (!charset) {
    const head = Buffer.from(buf.slice(0, 4096)).toString('latin1');
    charset = (head.match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1];
  }
  try {
    return new TextDecoder(charset || 'utf-8').decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

export const BACK_LINK =
  '<a href="/" style="position:fixed;bottom:12px;left:12px;z-index:99999;padding:4px 10px;font:13px sans-serif;' +
  'background:rgba(0,0,0,.65);color:#fff;border-radius:6px;text-decoration:none">← 文章列表</a>';

// “仅搬运”模式：保留原网页样式，去掉脚本，并用 <base> 让相对路径的图片/样式继续指向原站
export function sanitizeRawHtml(html, sourceUrl) {
  const $ = cheerio.load(html);
  $('script').remove();
  $('*').each((_, el) => {
    for (const name of Object.keys(el.attribs || {})) {
      if (/^on/i.test(name)) $(el).removeAttr(name);
    }
  });
  $('meta[http-equiv]').filter((_, el) => /refresh/i.test($(el).attr('http-equiv'))).remove();
  const existing = $('base[href]').first();
  let baseHref = sourceUrl;
  if (existing.length) {
    try { baseHref = new URL(existing.attr('href'), sourceUrl || undefined).href; } catch { baseHref = sourceUrl; }
    existing.remove();
  }
  if (baseHref) $('head').prepend(`<base href="${baseHref.replace(/"/g, '&quot;')}">`);
  $('body').prepend(BACK_LINK);
  return $.html();
}
