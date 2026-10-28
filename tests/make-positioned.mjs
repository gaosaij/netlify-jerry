// 生成“PDF 转 HTML”风格的测试网页（结构仿 EDGAR 备案文件：每行一个绝对定位的 <font>，页面是固定高度容器，整页图片）
const LINE = 11.4;

// 一页：lines = [{ top, text, size?, left? }]，每行拆成两个 <font>（和真实文件一样，一行里常有多个片段）
function textPage(lines, pageNo, header, extra = '') {
  const all = [
    { top: 30, text: header, size: 8, left: 72 },
    ...lines,
    { top: 760, text: String(pageNo), size: 8, left: 300 },
  ];
  const divs = all.map((l) => {
    const size = l.size || 9.5;
    const left = l.left ?? 72;
    const cut = l.text.length > 24 ? Math.floor(l.text.length * 0.6) : l.text.length;
    const first = l.text.slice(0, cut);
    const rest = l.text.slice(cut);
    const look = `font-family:'Georgia', serif;font-size:${size}pt;font-style:${l.italic ? 'italic' : 'normal'};font-weight:${l.bold ? 'bold' : 'normal'};${l.color ? `color:${l.color};` : ''}`;
    const f1 = `<font style="${look}left:${left}pt;position:absolute;white-space:pre;width:300pt">${first}</font>`;
    const f2 = rest ? `<font style="${look}left:${left + 200}pt;position:absolute;white-space:pre;width:200pt">${rest}</font>` : '';
    return `<div style="line-height:7.18pt;position:absolute;text-align:justify;top:${l.top}pt;width:612pt">${f1}${f2}</div>`;
  }).join('');
  return `<div style="background-color:#FFFFFF;border:1px solid #CCCC;content-visibility:auto;float:none;font-size:0;height:792pt;position:relative;width:612pt"><div>${divs}${extra}</div></div>`;
}

// 一个仿真实结构的表格：外层是绝对定位的容器，单元格里的文字用绝对定位的 font
const FONT = "font-family:'Georgia', serif;font-size:9.5pt;font-style:normal;font-weight:normal;text-decoration:none;white-space:pre";
const cellDiv = (rowTop, left, width, textLeft, text) =>
  `<div style="${left ? `left:${left}pt;` : ''}position:absolute;top:${rowTop}pt;width:${width}pt"><div><div style="line-height:7.18pt;position:absolute;top:3.52pt;width:${width}pt"><font style="${FONT};left:${textLeft}pt;position:absolute">${text}</font></div></div></div>`;
export function tableHtml(top) {
  const rows = [
    ['Revenue', '100%', '#ecebe3', 2.63],
    ['Compute and infrastructure', '1,056', '#ffffff', 14.63],
    ['Net loss', '(3,734)', '#ecebe3', 2.63],
  ];
  let h = `<div style="line-height:7.18pt;position:absolute;text-align:justify;top:${top}pt;width:612pt"><div><div style="font-size:0pt;left:72pt;position:absolute;width:468pt"><div>`;
  h += '<table style="border-collapse:collapse;display:inline-table;width:100%">';
  h += `<tr style="height:12pt"><td style="font-size:0;text-align:left;vertical-align:top"></td><td colspan="2" style="border-bottom:1pt solid #000;font-size:0;text-align:left;vertical-align:top">${cellDiv(0, 156, 186, 40, 'Year Ended December 31,').replace('font-weight:normal', 'font-weight:bold')}</td></tr>`;
  let rt = 12;
  for (const [label, val, bg, indent] of rows) {
    h += `<tr style="height:14.25pt"><td style="background-color:${bg};font-size:0;text-align:left;vertical-align:top">${cellDiv(rt, 0, 156, indent, label)}</td>`;
    h += `<td style="background-color:${bg};font-size:0;text-align:left;vertical-align:top">${cellDiv(rt, 156, 60, 32.19, val)}</td></tr>`;
    rt += 14.25;
  }
  return h + '</table></div></div></div></div>';
}

const imagePage = (src) =>
  `<div style="background-color:#FFFFFF;border:1px solid #CCCC;height:792pt;position:relative;width:612pt"><div style="position:absolute"><div style="position:absolute"><img style="height:792pt;width:612pt" src="${src}" alt="${src}"></div></div></div>`;

// 把一段文字排成若干行（每行最多 n 个字符），第一行缩进
function layout(text, startTop, n = 70, indent = true) {
  const words = text.split(' ');
  const rows = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > n) { rows.push(cur.trim()); cur = w; } else cur += ' ' + w;
  }
  if (cur.trim()) rows.push(cur.trim());
  return rows.map((t, i) => ({ top: startTop + i * LINE, text: t, left: indent && i === 0 ? 86 : 72 }));
}

export function samplePositionedHtml(imagePages = ['pg1a.jpg']) {
  const H = 'Sample Company, Inc.';
  const p = [];
  const pageLines = (parts) => {
    let top = 72;
    const lines = [];
    for (const part of parts) {
      if (part.heading) { lines.push({ top, text: part.heading, size: 14, left: 72, bold: true, color: '#1a1a1a' }); top += 14 * 2.2; continue; }
      const rows = part.lines
        ? part.lines.map((t, i) => ({ top: top + i * LINE, text: t, left: i === 0 ? 86 : 72 }))
        : layout(part.text, top, 70, !part.noIndent);
      lines.push(...rows);
      top += rows.length * LINE + (part.gap ?? 9);
    }
    return lines;
  };
  const filler = (k) => `Filler paragraph ${k} describes the usual risks and benefits that investors should consider before making any decision about the offering described in this document and nothing else.`;
  p.push(textPage(pageLines([
    { heading: '1 Our Mission' },
    { text: 'We believe that artificial intelligence is one of the most consequential technologies in human history. If managed well, it could accelerate science and greatly improve health outcomes for people everywhere.' },
    { lines: [
      'Our approach to building the company differs from a purely profit-maximizing company because the sur-',
      'rounding environment of safety research matters a great deal to us as we grow.',
    ] },
    { text: filler(1) }, { text: filler(2) },
  ]), 1, H));
  p.push(textPage(pageLines([
    { text: filler(3), noIndent: true }, { text: filler(4) }, { text: filler(5) }, { text: filler(6) },
    { heading: '2 Risk Factors' },
    { text: filler(7) }, { text: filler(8) },
    // 这一段写在页面底部、没写完，下一页接着写
    { text: 'The final paragraph of this page starts near the bottom and the sentence does not finish before the page', gap: 0 },
  ]), 2, H));
  p.push(textPage([
    ...layout('ends, so it must be joined with the text that appears on the following page of the filing.', 72, 70, false),
    ...pageLines([{ text: filler(9) }, { text: filler(10) }]).map((l) => ({ ...l, top: l.top + 40 })),
    { top: 380, text: 'Note: Totals of the table may not foot due to rounding.', size: 8, italic: true },
  ], 3, H, tableHtml(260)));
  imagePages.forEach((src) => p.push(imagePage(src)));   // 整页图片：文字在图里
  p.push(`<div style="background-color:#FFFFFF;border:1px solid #CCCC;height:792pt;position:relative;width:612pt"><div style="position:absolute"><img style="height:238pt;width:450pt" src="chart2a.jpg" alt="chart2a.jpg"></div></div>`); // 普通图表：不 OCR
  p.push(textPage(pageLines([{ text: filler(11) }, { text: filler(12) }, { text: filler(13) }]), 6, H));
  p.push(textPage(pageLines([{ text: filler(14) }, { text: filler(15) }, { text: filler(16) }, { text: filler(17) }]), 7, H));
  p.push(textPage(pageLines([{ text: filler(18) }, { text: filler(19) }, { text: filler(20) }]), 8, H));
  return `<?xml version="1.0"?><html><head><title>Sample Company S-1</title></head><body><div style="background-color:#E4E4E4;font-family:Arial, sans-serif;word-wrap:break-word">${p.join('\n')}</div></body></html>`;
}
