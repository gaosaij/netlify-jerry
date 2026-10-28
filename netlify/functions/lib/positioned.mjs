// “PDF 转 HTML”的网页：每一行文字都是一个绝对定位的元素，例如
//   <div style="position:absolute;top:279pt;width:612pt"><font style="left:72pt;position:absolute;font-size:9.5pt;white-space:pre">一行文字</font></div>
// 页面是一个固定高度（如 792pt）的容器。这类网页没有 <p>，句子被一行行切开，页眉页码也混在里面。
// 这里用流式解析（htmlparser2，省内存，十几 MB 的网页也能处理）读出每行的位置和字号，
// 再用和 PDF 共用的算法还原成段落，并把图片按页放回去。
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

export function parsePositioned(html, baseUrl = '') {
  const pages = [];
  let page = null;
  let pageDepth = -1;
  let depth = 0;
  let font = null;
  let title = '';
  let inTitle = false;
  const stack = []; // 每个打开的标签：{ top } 当前所处的“行”的纵坐标

  const parser = new Parser({
    onopentag(name, attrs) {
      depth++;
      const style = attrs.style || '';
      const parentTop = stack.length ? stack[stack.length - 1].top : null;
      let top = parentTop;
      if (name === 'title') inTitle = true;
      if (name === 'div') {
        const h = cssLength(style, 'height');
        if (pageDepth < 0 && h != null && h >= 500) {
          page = { height: h, items: [], images: [] }; // 页面容器：高度像一页纸
          pages.push(page);
          pageDepth = depth;
        }
        const t = cssLength(style, 'top');
        if (/position\s*:\s*absolute/i.test(style) && t != null) top = t;
      }
      if (name === 'font' && page && top != null) {
        font = { x: cssLength(style, 'left') ?? 0, w: cssLength(style, 'width') ?? 0, h: cssLength(style, 'font-size') ?? 10, top, str: '' };
      }
      if (name === 'img' && page && attrs.src) {
        const w = cssLength(style, 'width') ?? (attrs.width ? Number(attrs.width) * 0.75 : null);
        const h = cssLength(style, 'height') ?? (attrs.height ? Number(attrs.height) * 0.75 : null);
        page.images.push({ src: attrs.src, alt: attrs.alt || '', w, h });
      }
      stack.push({ top });
    },
    ontext(t) {
      if (inTitle) title += t;
      else if (font) font.str += t;
    },
    onclosetag(name) {
      stack.pop();
      if (name === 'title') inTitle = false;
      if (name === 'font' && font) {
        if (font.str.trim() && page) page.items.push({ str: font.str, x: font.x, y: page.height - font.top, w: font.w, h: font.h });
        font = null;
      }
      if (name === 'div' && depth === pageDepth) { pageDepth = -1; page = null; }
      depth--;
    },
  }, { decodeEntities: true });
  parser.write(html);
  parser.end();

  const textBlocks = buildBlocks(pages.map((p) => ({ height: p.height, items: p.items })));
  const blocks = [];
  let ti = 0;
  pages.forEach((p, pi) => {
    // 先放“从这一页之前开始”的段落，再放这一页的图片，所以图片出现在该页文字之后
    while (ti < textBlocks.length && textBlocks[ti].page <= pi) { blocks.push(mkBlock(textBlocks[ti].k, undouble(textBlocks[ti].en))); ti++; }
    for (const im of p.images) {
      const src = absoluteHttpUrl(im.src, baseUrl);
      if (!src || (im.w != null && im.w < 30) || (im.h != null && im.h < 30)) continue;
      const b = mkBlock('img', im.alt.trim(), { src });
      if (im.w != null && im.h != null && isPageImage(im.w, im.h)) b.big = 1;
      blocks.push(b);
    }
  });
  while (ti < textBlocks.length) { blocks.push(mkBlock(textBlocks[ti].k, undouble(textBlocks[ti].en))); ti++; }
  return { title: title.replace(/\s+/g, ' ').trim(), blocks, pages: pages.length };
}
