// 生成测试用 PDF（只用标准字体 Helvetica，不依赖任何库）
import fs from 'node:fs';

// pages: [[{ x, y, size, text }]]；y 从页面底部往上数
export function makePdf(pages) {
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };
  const catalog = add('');                // 1
  const pagesObj = add('');               // 2
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'); // 3
  const kids = [];
  for (const lines of pages) {
    const stream = lines.map((l) => `BT /F1 ${l.size} Tf ${l.x} ${l.y} Td (${l.text.replace(/[()\\]/g, '\\$&')}) Tj ET`).join('\n');
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((b, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${b}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// 一份像论文的样例：页眉、页码、大标题、小标题、首行缩进的段落、连字符断行、跨页段落
export function samplePages() {
  const header = (n) => [
    { x: 72, y: 760, size: 9, text: 'Journal of Sample Research' },
    { x: 300, y: 30, size: 9, text: String(n) },
  ];
  const para = (lines, y, indent = false) =>
    lines.map((t, i) => ({ x: 72 + (indent && i === 0 ? 20 : 0), y: y - i * 14, size: 11, text: t }));
  const p1 = [
    ...header(1),
    { x: 72, y: 700, size: 20, text: 'Habits and Environment' },
    { x: 72, y: 660, size: 14, text: '1 Introduction' },
    ...para([
      'Habits are formed through repetition and small actions repeated every day compound',
      'into large results over a long period of time and across many different contexts.',
    ], 630, true),
    ...para([
      'The second paragraph explains why the surrounding environ-',
      'ment matters more than simple willpower in most situations that people face',
      'every day.',
    ], 586, true),
    ...para([
      'A third paragraph starts near the bottom of the page and the sentence does not',
      'finish before the page',
    ], 530, true),
  ];
  const p2 = [
    ...header(2),
    ...para(['ends, so it must be joined with the text on the following page.'], 700),
    { x: 72, y: 660, size: 14, text: '2 Method' },
    ...para([
      'We tracked one hundred participants for twelve weeks and measured how often they',
      'completed the target behaviour in each condition of the experiment.',
    ], 630, true),
  ];
  const p3 = [
    ...header(3),
    ...para([
      'Results were consistent across all groups, which supports the main hypothesis',
      'of the study.',
    ], 700, true),
  ];
  return [p1, p2, p3];
}

if (process.argv[1] && process.argv[1].endsWith('make-pdf.mjs')) {
  fs.writeFileSync(new URL('./sample.pdf', import.meta.url), makePdf(samplePages()));
  console.log('已生成 tests/sample.pdf');
}
