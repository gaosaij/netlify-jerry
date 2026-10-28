// 版面文字 → 段落：把“一行一行带坐标的文字”还原成标题和段落。
// 浏览器（pdf.js 提取的 PDF）和服务器（PDF 转出来的 HTML，每行一个绝对定位元素）共用这一份。
//   pages = [{ height, items: [{ str, x, y, w, h }] }]，y 向上增长（离页面底部的距离），h 为字号
//   返回 [{ k: 'p'|'h1'|'h2'|'h3', en, page }]，page 是段落开始的页码（0 起）
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PdfLayout = factory();
})(this, function () {
  const END_PUNCT = /[.!?:;”"')\]。！？]$/;

  const median = (arr) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  // 把一页的文字块按纵坐标合并成行
  function pageLines(page) {
    const items = page.items.filter((it) => it.str !== '' && it.h > 0)
      .sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const it of items) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.y - it.y) < 0.5 * Math.max(last.h, it.h)) {
        last.items.push(it);
        last.h = Math.max(last.h, it.h);
      } else {
        lines.push({ y: it.y, h: it.h, items: [it] });
      }
    }
    return lines.map((ln) => {
      ln.items.sort((a, b) => a.x - b.x);
      let text = '';
      let prevEnd = null;
      for (const it of ln.items) {
        if (prevEnd !== null && it.x - prevEnd > ln.h * 0.2 && !/\s$/.test(text) && !/^\s/.test(it.str)) text += ' ';
        text += it.str;
        prevEnd = it.x + it.w;
      }
      const first = ln.items[0];
      const lastIt = ln.items[ln.items.length - 1];
      return { text: text.replace(/\s+/g, ' ').trim(), x: first.x, xEnd: lastIt.x + lastIt.w, y: ln.y, h: ln.h, pageH: page.height };
    }).filter((l) => l.text);
  }

  function buildBlocks(pages) {
    const pageLinesList = pages.map(pageLines);

    // 去掉页眉页脚：页面最上/最下 8% 里，在多页重复出现的行，以及单独的页码
    const norm = (t) => t.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ');
    const inMargin = (l) => l.y > l.pageH * 0.92 || l.y < l.pageH * 0.08;
    const counts = new Map();
    pageLinesList.forEach((lines) => {
      new Set(lines.filter(inMargin).map((l) => norm(l.text))).forEach((k) => counts.set(k, (counts.get(k) || 0) + 1));
    });
    const repeatMin = Math.max(3, Math.ceil(pages.length * 0.3));
    const cleaned = pageLinesList.map((lines) => lines.filter((l) => {
      if (!inMargin(l)) return true;
      if (/^(page\s+)?\d+(\s+of\s+\d+)?$/i.test(l.text)) return false;
      return (counts.get(norm(l.text)) || 0) < repeatMin;
    }));

    // 正文字号 = 按字符数加权最常见的行高
    const weight = new Map();
    cleaned.flat().forEach((l) => {
      const k = Math.round(l.h * 2) / 2;
      weight.set(k, (weight.get(k) || 0) + l.text.length);
    });
    let bodyH = 0, best = -1;
    weight.forEach((w, k) => { if (w > best) { best = w; bodyH = k; } });
    if (!bodyH) return [];

    const out = [];
    cleaned.forEach((lines, pageNo) => {
      if (!lines.length) return;
      const spacings = [];
      for (let i = 1; i < lines.length; i++) {
        const d = lines[i - 1].y - lines[i].y;
        if (d > 0 && d < bodyH * 3) spacings.push(d);
      }
      const spacing = median(spacings) || bodyH * 1.3;
      const lefts = lines.map((l) => l.x).sort((a, b) => a - b);
      const rights = lines.map((l) => l.xEnd).sort((a, b) => a - b);
      const left = lefts[Math.floor(lefts.length * 0.1)];
      const right = rights[Math.floor(rights.length * 0.9)];

      let cur = null;
      const flush = () => { if (cur) out.push({ ...cur, page: pageNo }); cur = null; };
      let prev = null;
      for (const l of lines) {
        const ratio = l.h / bodyH;
        const heading = ratio >= 1.2 && l.text.length < 160;
        const level = ratio >= 1.6 ? 'h1' : ratio >= 1.35 ? 'h2' : 'h3';
        let startNew = !cur;
        if (cur) {
          if (heading !== (cur.k !== 'p')) startNew = true;
          else if (heading && cur.k !== level) startNew = true;
          else if (!heading) {
            const gap = prev.y - l.y;
            const indented = l.x > left + bodyH * 0.8;
            const prevShort = prev.xEnd < left + (right - left) * 0.8;
            if (gap > spacing * 1.6) startNew = true;
            else if (END_PUNCT.test(prev.text) && (indented || prevShort)) startNew = true;
          }
        }
        if (startNew) { flush(); cur = { k: heading ? level : 'p', en: l.text }; }
        else if (/[A-Za-z]-$/.test(cur.en) && /^[a-z]/.test(l.text)) cur.en = cur.en.slice(0, -1) + l.text; // 行尾连字符
        else cur.en += ' ' + l.text;
        prev = l;
      }
      flush();
    });

    // 跨页的段落接起来：上一页最后一段没写完（没有句末标点），下一页第一段以小写字母开头
    // 结果里的 page 是段落开始的页码（0 起），用于把图片插到正确位置
    const merged = [];
    for (const b of out) {
      const last = merged[merged.length - 1];
      if (last && last.k === 'p' && b.k === 'p' && b.page === last.end + 1 &&
          !END_PUNCT.test(last.en) && /^[a-z]/.test(b.en)) {
        last.en = /[A-Za-z]-$/.test(last.en) ? last.en.slice(0, -1) + b.en : last.en + ' ' + b.en;
        last.end = b.page;
      } else merged.push({ ...b, end: b.page });
    }
    return merged.map(({ k, en, page }) => ({ k, en, page }));
  }


  return { buildBlocks };
});
