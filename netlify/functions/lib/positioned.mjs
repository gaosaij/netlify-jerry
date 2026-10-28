// “PDF 转 HTML”的网页：每一行文字都是一个绝对定位的元素，例如
//   <div style="position:absolute;top:279pt;width:612pt"><font style="left:72pt;position:absolute;font-size:9.5pt;white-space:pre">一行文字</font></div>
// 页面是一个固定高度（如 792pt）的容器。这类网页没有 <p>，句子被一行行切开，页眉页码也混在里面；
// 表格是真正的 <table>，但每个单元格里的文字又是绝对定位的。
// 这里用流式解析（htmlparser2，省内存，十几 MB 的网页也能处理）读出：
//   · 每行文字的位置、字号、字体样式 → 用和 PDF 共用的算法还原成段落（保留字体、字号、加粗、斜体、颜色）
//   · 每个表格：原样保留（放进一个相对定位的容器里，外观和原页面一样），再抽出文字单元格做中文对照表
//   · 图片：按页放回去，整页大图标出来给 OCR
// 结果按“页 + 纵坐标”排好，显示时每一页是一张白色卡片，像原页面一样。
import { Parser } from 'htmlparser2';
import { mkBlock, cssLength, isPageImage, absoluteHttpUrl } from './parse.mjs';
import layout from './pdf-layout.cjs'; // 必须用静态 import，Netlify 打包函数时才会把它带进去

const { buildBlocks } = layout;

// 有的网页为了加粗会把同一行文字叠两层，提取出来整段重复了一遍（"X X"）：只留一份
const undouble = (t) => { const m = t.match(/^(.{3,}?)\s+\1$/s); return m ? m[1] : t; };

// 是否是这种网页：有大量“绝对定位 + white-space:pre”的 <font>
export function looksPositioned(html) {
  const re = /<font\b(?=[^>]*position:\s*absolute)(?=[^>]*white-space:\s*pre)[^>]*>/gi;
  let n = 0;
  while (re.exec(html)) if (++n >= 100) return true;
  return false;
}

// 字体样式：只留显示需要的几项，并限制取值，后面会直接写进页面的 style 里
function fontStyle(style) {
  const family = (style.match(/font-family:\s*['"]?([^,;'"]+)/i) || [])[1];
  const color = (style.match(/(?:^|;)\s*color:\s*(#[0-9a-f]{3,8}\b)/i) || [])[1];
  return {
    f: family && /^[\w .-]{1,40}$/.test(family.trim()) ? family.trim() : '',
    sz: cssLength(style, 'font-size') ?? 10,
    b: /font-weight:\s*(bold|[6-9]00)/i.test(style) ? 1 : 0,
    i: /font-style:\s*italic/i.test(style) ? 1 : 0,
    c: color || '',
  };
}

// 数字、百分比、货币符号等：不需要翻译
const hasWords = (t) => /[A-Za-z]{2,}/.test(t);

export function parsePositioned(html, baseUrl = '') {
  const pages = [];
  let page = null;
  let pageDepth = -1;
  let depth = 0;
  let font = null;
  let fontDepth = 0;
  let title = '';
  let inTitle = false;
  let tableDepth = 0;
  let tbl = null;
  let cell = null;
  let tableSeq = 0;
  const stack = []; // 每个打开的标签：{ top, width } ——当前所处的“行”的纵坐标、最近的定宽绝对定位容器的宽度

  const parser = new Parser({
    onopentag(name, attrs) {
      depth++;
      const style = attrs.style || '';
      const parent = stack.length ? stack[stack.length - 1] : { top: null, width: null };
      let top = parent.top;
      let width = parent.width;
      if (name === 'title') inTitle = true;
      if (name === 'div') {
        const h = cssLength(style, 'height');
        if (pageDepth < 0 && h != null && h >= 500) {
          page = { height: h, items: [], images: [], tables: [] }; // 页面容器：高度像一页纸
          pages.push(page);
          pageDepth = depth;
        }
        if (/position\s*:\s*absolute/i.test(style)) {
          const t = cssLength(style, 'top');
          if (t != null) top = t;
          const w = cssLength(style, 'width');
          if (w != null && w < 600) width = w; // 表格外面的定宽容器（如 468pt）
        }
      }
      if (name === 'table' && page && tableDepth === 0) {
        tbl = { start: parser.startIndex, top, width: width || 468, height: 0, rows: [], curRow: null };
      }
      if (name === 'table') tableDepth++;
      if (tableDepth > 0) {
        if (name === 'tr') {
          tbl.curRow = [];
          tbl.height += cssLength(style, 'height') ?? 0;
        }
        if (name === 'td' || name === 'th') cell = { text: '', span: Number(attrs.colspan) || 1 };
      } else {
        if (name === 'font') {
          if (font) fontDepth++;
          else if (page && top != null) {
            font = { x: cssLength(style, 'left') ?? 0, w: cssLength(style, 'width') ?? 0, top, st: fontStyle(style), str: '' };
            fontDepth = 1;
          }
        }
        if (name === 'img' && page && attrs.src) {
          const w = cssLength(style, 'width') ?? (attrs.width ? Number(attrs.width) * 0.75 : null);
          const h = cssLength(style, 'height') ?? (attrs.height ? Number(attrs.height) * 0.75 : null);
          page.images.push({ src: attrs.src, alt: attrs.alt || '', w, h, top });
        }
      }
      stack.push({ top, width });
    },
    ontext(t) {
      if (inTitle) title += t;
      else if (tableDepth > 0) { if (cell) cell.text += t; }
      else if (font) font.str += t;
    },
    onclosetag(name) {
      stack.pop();
      if (name === 'title') inTitle = false;
      if (tableDepth > 0) {
        if ((name === 'td' || name === 'th') && cell) {
          cell.text = cell.text.replace(/\s+/g, ' ').trim();
          if (tbl.curRow) tbl.curRow.push(cell);
          cell = null;
        }
        if (name === 'tr' && tbl.curRow) { tbl.rows.push(tbl.curRow); tbl.curRow = null; }
        if (name === 'table') {
          tableDepth--;
          if (tableDepth === 0 && page) {
            tbl.end = parser.endIndex + 1;
            page.tables.push(tbl);
            tbl = null;
          }
        }
      } else if (name === 'font' && font) {
        fontDepth--;
        if (fontDepth === 0) {
          if (font.str.trim() && page) page.items.push({ str: font.str, x: font.x, y: page.height - font.top, w: font.w, h: font.st.sz, st: font.st });
          font = null;
        }
      }
      if (name === 'div' && depth === pageDepth) { pageDepth = -1; page = null; }
      depth--;
    },
  }, { decodeEntities: true });
  parser.write(html);
  parser.end();

  // ---- 文字：还原成段落 ----
  const textBlocks = buildBlocks(pages.map((p) => ({ height: p.height, items: p.items })));

  // ---- 按页组装：段落、表格、图片按纵坐标排好 ----
  const blocks = [];
  const tables = {}; // 表格原始 HTML：key -> html（单独存放，不放进文章分段里）
  pages.forEach((p, pi) => {
    const els = [];
    textBlocks.filter((b) => b.page === pi).forEach((b, n) => els.push({ y: b.y, o: n, text: b }));
    p.tables.forEach((t, n) => els.push({ y: t.top != null ? p.height - t.top : -1, o: 1000 + n, table: t }));
    p.images.forEach((im, n) => els.push({ y: im.top != null ? p.height - im.top : -1, o: 2000 + n, image: im }));
    els.sort((a, b) => b.y - a.y || a.o - b.o);
    for (const el of els) {
      if (el.text) {
        const b = mkBlock(el.text.k, undouble(el.text.en), { page: pi });
        if (el.text.st) b.st = el.text.st;
        blocks.push(b);
      } else if (el.table) {
        const t = el.table;
        const key = String(tableSeq++);
        tables[key] = html.slice(t.start, t.end).replace(/\son[a-z]+="[^"]*"/gi, '');
        const tb = mkBlock('table', '', { page: pi, tkey: key, w: t.width, h: t.height, rows: [] });
        blocks.push(tb);
        // 表格里有字母的单元格单独成为分段（会被翻译），中文对照表按它们生成
        for (const row of t.rows) {
          tb.rows.push(row.map((c) => {
            if (!c.text) return [null, null, c.span];
            if (!hasWords(c.text)) return [c.text, null, c.span];
            blocks.push(mkBlock('cell', c.text, { page: pi }));
            return [null, blocks.length - 1, c.span];
          }));
        }
      } else {
        const im = el.image;
        const src = absoluteHttpUrl(im.src, baseUrl);
        if (!src || (im.w != null && im.w < 30) || (im.h != null && im.h < 30)) continue;
        const b = mkBlock('img', im.alt.trim(), { src, page: pi });
        if (im.w != null) b.w = im.w;
        if (im.h != null) b.h = im.h;
        if (im.w != null && im.h != null && isPageImage(im.w, im.h)) b.big = 1;
        blocks.push(b);
      }
    }
  });
  return { title: title.replace(/\s+/g, ' ').trim(), blocks, tables, pages: pages.length };
}
