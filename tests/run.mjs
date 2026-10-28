// 自动化测试：node tests/run.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startDevServer } from './dev-server.mjs';
import { createRequire } from 'node:module';
import { parseMarkdown, parseHtml, analyze } from '../netlify/functions/lib/parse.mjs';
import { renderStyledPage } from '../netlify/functions/lib/render.mjs';
import { makePdf, samplePages } from './make-pdf.mjs';
import { samplePositionedHtml } from './make-positioned.mjs';
import { looksPositioned, parsePositioned } from '../netlify/functions/lib/positioned.mjs';
import { blockedHint } from '../netlify/functions/lib/ingest.mjs';
import { externalizeDataUris, singleFileUrl } from '../netlify/functions/lib/assets.mjs';
import { getJSON, getText } from '../netlify/functions/lib/store.mjs';
import { randomBytes } from 'node:crypto';
const { buildBlocks } = createRequire(import.meta.url)('../netlify/functions/lib/pdf-layout.cjs');

let passed = 0;
const ok = (name) => { passed++; console.log('  ✓', name); };

// ---- 解析与检测 ----
const md = parseMarkdown(fs.readFileSync(new URL('../articles/What is Active Constructive Responding.md', import.meta.url), 'utf8'));
assert.ok(md.title.includes('Active Constructive Responding'));
assert.ok(md.blocks.length > 20);
assert.equal(analyze(md.blocks).alreadyChinese, false);
ok('解析英文 Markdown 文章，识别为需翻译');

const dualFile = fs.readFileSync(new URL('../articles/HOW PEOPLE USE CHATGPT-zh-CN-dual.html', import.meta.url), 'utf8');
const dual = parseHtml(dualFile);
assert.equal(analyze(dual.blocks).alreadyChinese, true);
ok('现有的中英对照文章被检测为“已有中文”');

const pandoc = parseHtml(fs.readFileSync(new URL('../articles/It_Helps_to_Ask_-_The_Cumulative_Benefits_of_Asking_Follow-Up_Questions.html', import.meta.url), 'utf8'));
assert.equal(analyze(pandoc.blocks).alreadyChinese, false);
assert.ok(pandoc.blocks.length > 20);
ok('纯英文 HTML 文章被检测为需翻译（' + pandoc.blocks.length + ' 段）');

// 真实的英文文章：样式版对照页——每个待翻译元素都有标记，译文紧跟在原文后面且样式一致
for (const f of ['It_Helps_to_Ask_-_The_Cumulative_Benefits_of_Asking_Follow-Up_Questions.html', 'Intimacy_as_an_Interpersonal_Process_-_The_Importance_of_Self-Disclosure,_Partner_Disclosure,_and_Perceived_Partner_Responsiveness_in_Interpersonal_Exchanges.html']) {
  const parsed = parseHtml(fs.readFileSync(new URL('../articles/' + f, import.meta.url), 'utf8'), { annotate: true });
  const info = analyze(parsed.blocks);
  assert.equal(info.alreadyChinese, false);
  assert.equal((parsed.html.match(/data-tid="/g) || []).length, info.total);
  parsed.blocks.forEach((b) => { if (!b.s) b.zh = '[ZH] ' + b.en; });
  const t0 = Date.now();
  const out = renderStyledPage({ status: 'done', total: info.total, done: info.total, updatedAt: 1 }, { blocks: parsed.blocks }, parsed.html, 'n');
  assert.equal((out.match(/class="[^"]*zh-tr/g) || []).length, info.total);
  ok(f.slice(0, 20) + '… 样式版渲染：' + info.total + ' 段，' + (Date.now() - t0) + 'ms');
}

// 公式：MathML 的渲染文字和 LaTeX 注释不能叠在一起，统一取 LaTeX
{
  const r = parseHtml('<article><p>The estimate <math><semantics><mrow><msub><mi>b</mi><mn>10</mn></msub></mrow><annotation encoding="application/x-tex">b_{10}</annotation></semantics></math>, is high.</p></article>');
  assert.equal(r.blocks[0].en, 'The estimate $b_{10}$, is high.');
  const real = parseHtml(fs.readFileSync(new URL('../articles/Intimacy_as_an_Interpersonal_Process_-_The_Importance_of_Self-Disclosure,_Partner_Disclosure,_and_Perceived_Partner_Responsiveness_in_Interpersonal_Exchanges.html', import.meta.url), 'utf8'));
  assert.ok(real.blocks.every((b) => !/\b(\w+)_\{[^}]*\}\s*\1\b/.test(b.en) && !/[a-z]\d+[a-z]_\{/.test(b.en)), '不应再有公式叠字');
  ok('公式只保留 LaTeX（$b_{10}$），不再出现 b10b_{10} 这样的叠字');
}

// PDF 转出来的 HTML（逐行绝对定位）：按坐标还原段落
{
  const html = samplePositionedHtml();
  assert.ok(looksPositioned(html) && !looksPositioned('<html><body><p>plain</p></body></html>'));
  const r = parsePositioned(html, 'https://example.com/docs/a.htm');
  const texts = r.blocks.filter((b) => b.k === 'p' || /^h\d$/.test(b.k));
  assert.equal(r.title, 'Sample Company S-1');
  assert.ok(texts.every((b) => !b.en.includes('Sample Company, Inc.') && !/^\d$/.test(b.en)), '页眉页码被去掉');
  assert.ok(texts.some((b) => b.en.includes('because the surrounding environment of safety research')), '连字符断行接上');
  assert.ok(texts.some((b) => b.en.includes('before the page ends, so it must be joined')), '跨页段落合并');
  assert.deepEqual(texts.filter((b) => /^h\d$/.test(b.k)).map((b) => b.en), ['1 Our Mission', '2 Risk Factors']);
  const imgs = r.blocks.filter((b) => b.k === 'img');
  assert.deepEqual(imgs.map((b) => [b.src, !!b.big]), [['https://example.com/docs/pg1a.jpg', true], ['https://example.com/docs/chart2a.jpg', false]]);
  assert.ok(texts.length < 30, '每行不再是一个段落');
  // 样式：标题加粗 14pt，说明斜体 8pt
  const h1 = texts.find((b) => b.en === '1 Our Mission');
  assert.deepEqual([h1.st.f, h1.st.sz, h1.st.b, h1.st.c], ['Georgia', 14, 1, '#1a1a1a']);
  assert.deepEqual([texts.find((b) => b.en.startsWith('Note:')).st.i, texts.find((b) => b.en.startsWith('Note:')).st.sz], [1, 8]);
  // 表格：原样保留 + 文字单元格单独成块，数字单元格不翻译；表格排在说明之前
  const tb = r.blocks.find((b) => b.k === 'table');
  assert.equal(r.blocks.filter((b) => b.k === 'table').length, 1);
  assert.deepEqual([tb.w, tb.h], [468, 54.75]);
  assert.ok(r.tables[tb.tkey].startsWith('<table') && r.tables[tb.tkey].includes('background-color:#ecebe3') && r.tables[tb.tkey].includes('Year Ended December 31,'));
  assert.deepEqual(r.blocks.filter((b) => b.k === 'cell').map((b) => b.en), ['Year Ended December 31,', 'Revenue', 'Compute and infrastructure', 'Net loss']);
  assert.ok(r.blocks.indexOf(tb) < r.blocks.findIndex((b) => b.en && b.en.startsWith('Note:')), '按纵坐标排序');
  assert.ok(!texts.some((b) => b.en.includes('Revenue') || b.en.includes('1,056')), '表格里的文字不会混进正文段落');
  assert.equal(parsePositioned(html.replace('1 Our Mission</font>', '1 Our Mission 1 Our Mission</font>')).blocks[0].en, '1 Our Mission', '叠两层造成的整段重复被去掉');
  assert.match(blockedHint('https://www.sec.gov/x.htm', 403), /FETCH_USER_AGENT/);
  assert.equal(blockedHint('https://example.com/x.htm', 403), '');
  ok('PDF 转 HTML：按坐标还原段落、去页眉页码、接连字符、合并跨页、标出整页图片');
}

// PDF：页眉页码被去掉、连字符接上、跨页段落合并、标题识别
{
  const pages = samplePages().map((lines) => ({ height: 792, items: lines.map((l) => ({ str: l.text, x: l.x, y: l.y, w: l.text.length * l.size * 0.5, h: l.size })) }));
  const blocks = buildBlocks(pages);
  assert.equal(blocks.length, 8);
  assert.equal(blocks[0].k, 'h1');
  assert.ok(blocks.every((b) => !b.en.includes('Journal of Sample') && !/^\d$/.test(b.en)));
  assert.ok(blocks[3].en.includes('surrounding environment matters'));
  assert.ok(blocks[4].en.includes('before the page ends, so it must be joined'));
  ok('PDF 段落还原：去页眉页码、接连字符、合并跨页段落、识别标题');
  assert.ok(makePdf(samplePages()).length > 500);
}

// ---- 端到端 ----
let before2;
const tokenBackup = 'mtoken';
const { origin, stats, mineru, close } = await startDevServer();
const H = { 'content-type': 'application/json', 'x-admin-password': 'test-pass' };
const post = (p, body, headers = H) => fetch(origin + p, { method: 'POST', headers, body: JSON.stringify(body) });
const get = (p) => fetch(origin + p).then((r) => r.json());
const waitDone = async (slug, ms = 15000) => {
  const t = Date.now();
  for (;;) {
    const m = await get('/api/articles/' + slug);
    if (['done', 'error'].includes(m.status)) return m;
    if (Date.now() - t > ms) throw new Error('等待翻译超时：' + JSON.stringify(m));
    await new Promise((r) => setTimeout(r, 100));
  }
};

// 鉴权
assert.equal((await post('/api/upload', { content: 'x' }, { 'content-type': 'application/json' })).status, 401);
assert.equal((await fetch(origin + '/api/status', { headers: { 'x-admin-password': 'bad' } })).status, 401);
ok('没有/错误的管理密码被拒绝');

// 搬运并翻译（含：一次限流重试、一次段落数不一致回退）
stats.rateLimitOnce = true;
stats.mismatchOnce = true;
let res = await post('/api/import', { url: origin + '/sample/en', translate: true });
assert.equal(res.status, 201, await res.clone().text());
let meta = await res.json();
assert.equal(meta.title, 'Sample Article About Habits');
meta = await waitDone(meta.slug);
assert.equal(meta.status, 'done', JSON.stringify(meta));
assert.equal(meta.done, meta.total);
let pageHtml = await (await fetch(`${origin}/t/${meta.slug}`)).text();
assert.ok(pageHtml.includes('Habits are formed through repetition'));
assert.ok(pageHtml.includes('[ZH] Habits are formed through repetition'));
assert.ok(pageHtml.includes('p{color:red}'), '应保留原网页的样式');
assert.match(pageHtml, /<p>Habits are formed[^<]*<\/p><p class="zh-tr">\[ZH\] Habits are formed/, '译文紧跟在原文后面');
assert.ok(pageHtml.includes('<nav>menu</nav>'));
assert.ok(pageHtml.includes('const x = 1;') && !pageHtml.includes('[ZH] const x'));
assert.ok(!pageHtml.includes('alert(1)'));
ok('搬运网址 → 分块翻译 → 保留原样式的中英对照页；限流重试、段落数不一致回退都正常');
const slugEn = meta.slug;

// 搬运本站自己的文章：记录原路径，首页据此隐藏英文原版
meta = await (await post('/api/import', { url: origin + '/sample/en2', translate: true })).json();
assert.equal(meta.origPath, '/sample/en2');
assert.equal(meta.layout, 'page');
await waitDone(meta.slug);
ok('搬运本站文章会记录原路径（首页据此隐藏英文原版）');

// 上传 .html 文件同样保留样式
meta = await (await post('/api/upload', { filename: 'styled.html', content: '<html><head><title>Styled Upload</title><style>h1{color:green}</style></head><body><h1>Styled Upload</h1><p>This paragraph keeps the original styling after translation.</p></body></html>', translate: true })).json();
await waitDone(meta.slug);
pageHtml = await (await fetch(`${origin}/t/${meta.slug}`)).text();
assert.ok(pageHtml.includes('h1{color:green}') && pageHtml.includes('class="zh-tr"'));
ok('上传 .html 文件翻译后保留原样式');

// 浏览器端提取的 PDF 分段直接上传
meta = await (await post('/api/upload', { filename: 'paper.pdf', title: 'PDF Paper', blocks: [{ k: 'h1', en: 'A PDF Paper' }, { k: 'p', en: 'This is the first extracted paragraph of the paper.' }, { k: 'evil', en: 'ignored kind' }], translate: true })).json();
assert.equal(meta.total, 2);
assert.equal((await waitDone(meta.slug)).status, 'done');
pageHtml = await (await fetch(`${origin}/t/${meta.slug}`)).text();
assert.ok(pageHtml.includes('[ZH] This is the first extracted paragraph'));
ok('PDF 分段上传并翻译');

// ---- MinerU：PDF 网址 → OCR → 翻译 ----
res = await post('/api/import', { url: origin + '/sample/paper.pdf', translate: true });
assert.equal(res.status, 201, await res.clone().text());
meta = await res.json();
assert.equal(meta.status, 'ocr');
const pdfSlug = meta.slug;
meta = await waitDone(pdfSlug);
assert.equal(meta.status, 'done', JSON.stringify(meta));
assert.equal(mineru.lastAuth, 'Bearer mtoken');
const task = [...mineru.tasks.values()][0].body;
assert.equal(task.url, origin + '/sample/paper.pdf');
assert.equal(task.model_version, 'vlm');
assert.equal(task.is_ocr, true);
pageHtml = await (await fetch(`${origin}/t/${pdfSlug}`)).text();
assert.ok(pageHtml.includes('Paragraph text from t1 about habits.'));
assert.ok(pageHtml.includes('[ZH] Paragraph text from t1'));
assert.ok(pageHtml.includes(`/api/img/${pdfSlug}/img-t1.jpg`), '图片地址应改成本站');
assert.ok(pageHtml.includes('<td>cell value</td>') && !pageHtml.includes('onclick'), '表格保留且去掉属性');
assert.ok(pageHtml.includes('E=mc^2'));
assert.equal(meta.title, 'Doc t1');
const img = await fetch(`${origin}/api/img/${pdfSlug}/img-t1.jpg`);
assert.equal(img.status, 200);
assert.equal(img.headers.get('content-type'), 'image/jpeg');
assert.equal((await img.arrayBuffer()).byteLength, 7);
ok('PDF 网址 → MinerU 识别 → 图片/表格/公式保留 → 自动翻译');

res = await post('/api/import', { url: origin + '/sample/paper.pdf', translate: true });
assert.equal(res.status, 409);
ok('同一个 PDF 网址不会重复提交');

// 识别失败、页数超限：给出 MinerU 的原因
meta = await (await post('/api/import', { url: origin + '/sample/paper.pdf?failme', translate: true })).json();
meta = await waitDone(meta.slug);
assert.equal(meta.status, 'error');
assert.ok(meta.error.includes('文件损坏'), meta.error);
meta = await (await post('/api/import', { url: origin + '/sample/paper.pdf?toolong', translate: true })).json();
meta = await waitDone(meta.slug);
assert.ok(meta.status === 'error' && meta.error.includes('页数超过限制') && meta.error.includes('-60006'), JSON.stringify(meta));
ok('MinerU 识别失败/页数超限时显示具体原因');

// 本地上传：浏览器分块上传 → 后台转交给 MinerU；450 页自动拆成 3 段（每段 ≤200 页）
const upId = 'upload-abcdef12';
const chunk = (n, size) => fetch(`${origin}/api/ocr/chunk?id=${upId}&n=${n}`, { method: 'POST', headers: { 'x-admin-password': 'test-pass' }, body: Buffer.alloc(size, n + 1) });
assert.equal((await chunk(0, 1000)).status, 200);
assert.equal((await chunk(1, 500)).status, 200);
assert.equal((await fetch(`${origin}/api/ocr/chunk?id=bad&n=0`, { method: 'POST', headers: { 'x-admin-password': 'test-pass' }, body: 'x' })).status, 400);
res = await post('/api/ocr/start', { uploadId: upId, chunks: 2, filename: 'big.pdf', pages: 450, translate: true });
assert.equal(res.status, 201, await res.clone().text());
meta = await waitDone((await res.json()).slug);
assert.equal(meta.status, 'done', JSON.stringify(meta));
const batch = [...mineru.batches.values()][0];
assert.deepEqual(batch.files.map((f) => f.page_ranges), ['1-200', '201-400', '401-450']);
assert.deepEqual(batch.files.map((f) => f.name), ['big-p1-200.pdf', 'big-p201-400.pdf', 'big-p401-450.pdf']);
assert.ok(batch.files.every((f) => f.is_ocr === true));
assert.equal(mineru.puts.length, 3);
assert.ok(mineru.puts.every((p) => p.bytes === 1500), '每段都上传完整 PDF（1000+500 字节）');
pageHtml = await (await fetch(`${origin}/t/${meta.slug}`)).text();
const order = ['b', '-0', '-1', '-2'].map((k, i) => i === 0 ? 0 : pageHtml.indexOf(`Paragraph text from ${[...mineru.batches.keys()][0]}${k} about`));
assert.ok(order[1] > 0 && order[2] > order[1] && order[3] > order[2], '三段结果按页码顺序拼接');
assert.ok(fs.readdirSync(process.env.LOCAL_STORE_DIR).every((f) => !f.startsWith('pdf%2F')), '上传的 PDF 分块应已清理');
ok('本地 PDF：分块上传、超过 200 页自动按 page_ranges 拆 3 段、结果按顺序合并');

// 未配置令牌
const tok = process.env.MINERU_API_TOKEN;
process.env.MINERU_API_TOKEN = '';
res = await post('/api/import', { url: origin + '/sample/paper.pdf?notoken', translate: true });
assert.equal(res.status, 503);
assert.ok((await res.json()).error.includes('MINERU_API_TOKEN'));
process.env.MINERU_API_TOKEN = tok;
ok('未配置 MINERU_API_TOKEN 时给出明确提示');

// 删除文章会一并删掉识别出的图片
res = await fetch(`${origin}/api/articles/${pdfSlug}`, { method: 'DELETE', headers: H });
assert.equal(res.status, 200);
assert.equal((await fetch(`${origin}/api/img/${pdfSlug}/img-t1.jpg`)).status, 404);
ok('删除文章时连带删除图片');

// ---- PDF 转出来的 HTML + 整页图片 OCR（仿 SEC 备案文件）----
const UA = 'Test Reader contact@example.com';
process.env.FETCH_USER_AGENT = UA;
mineru.puts.length = 0;
res = await post('/api/import', { url: origin + '/sample/s1.htm', translate: true });
assert.equal(res.status, 201, await res.clone().text());
meta = await res.json();
assert.equal(meta.status, 'ocr', '有整页图片，先 OCR');
meta = await waitDone(meta.slug);
assert.equal(meta.status, 'done', JSON.stringify(meta));
assert.equal(meta.layout, 'doc', 'PDF 转 HTML 使用文档版式');
const batchS1 = [...mineru.batches.values()].pop();
assert.deepEqual(batchS1.files.map((f) => f.name), ['img-0.jpg'], '只有整页图片交给 OCR，普通图表不交');
assert.equal(mineru.puts.at(-1).bytes, 7, '服务器抓到图片并传给 MinerU');
assert.ok(stats.imageUAs.every((u) => u === UA) && stats.imageUAs.length === 1, '抓图用的是 FETCH_USER_AGENT');
pageHtml = await (await fetch(`${origin}/t/${meta.slug}`)).text();
assert.ok(pageHtml.includes('before the page ends, so it must be joined'));
assert.ok(!pageHtml.includes('Sample Company, Inc.'));
const iImg = pageHtml.indexOf('/sample/pg1a.jpg');
const iOcr = pageHtml.indexOf('Paragraph text from ' + [...mineru.batches.keys()].pop() + '-0');
assert.ok(iImg > 0 && iOcr > iImg, '图片里识别出的文字放在图片后面');
assert.ok(pageHtml.includes('[ZH] Paragraph text from') && pageHtml.includes('[ZH] 1 Our Mission'));
assert.ok(pageHtml.includes('/sample/chart2a.jpg'));
// 文档版式：页面卡片、原字体样式、原表格 + 中文对照表
assert.ok(pageHtml.includes('class="pgcard"') && pageHtml.includes('第 1 页'));
assert.ok(pageHtml.includes(`<h2 class="d dh" style="font-family:'Georgia', serif;font-size:14pt;font-weight:bold;color:#1a1a1a;">1 Our Mission</h2><h2 class="d dh dz" style="font-family:'Georgia', 'Songti SC','Noto Serif CJK SC','SimSun',serif;font-size:14pt;font-weight:bold;color:#1a1a1a;">[ZH] 1 Our Mission</h2>`), '标题保留字体/字号/加粗/颜色，译文紧跟其后，style 属性完整');
assert.ok(/<p class="d dz" style="font-family:'Georgia', 'Songti SC'[^"]*font-size:9.5pt;color:#17406b;">\[ZH\] We believe/.test(pageHtml), '正文译文有字号和颜色');
assert.ok(!/style="[^"]*"[a-z]/.test(pageHtml.split('<article>')[1].split('</article>')[0].replace(/<table[\s\S]*?<\/table>/g, '')), 'style 属性里不能出现未转义的双引号');
assert.ok(pageHtml.includes('<table style="border-collapse:collapse;display:inline-table;width:100%">') && pageHtml.includes('background-color:#ecebe3'), '原表格原样保留');
assert.ok(pageHtml.includes('position:relative;width:468pt;height:54.75pt'), '表格容器尺寸和原来一致');
assert.ok(pageHtml.includes('class="zt"') && pageHtml.includes('[ZH] Revenue') && pageHtml.includes('[ZH] Net loss'), '中文对照表');
assert.ok(pageHtml.includes('<td class="num">100%</td>') && pageHtml.includes('<td class="num">(3,734)</td>'), '数字原样');
assert.ok(pageHtml.includes('font-style:italic;') && pageHtml.includes('Note: Totals of the table'));
ok('PDF 转 HTML：文档版式（页面卡片、字体样式）+ 原表格 + 中文对照表 + 整页图片 OCR 放回图片后面');

// 大网页：同步函数处理不了，改走后台导入
process.env.SYNC_LIMIT_BYTES = '20000';
res = await post('/api/import', { url: origin + '/sample/s1b.htm', translate: true });
assert.equal(res.status, 201, await res.clone().text());
meta = await res.json();
assert.equal(meta.status, 'importing');
meta = await waitDone(meta.slug);
assert.equal(meta.status, 'done', JSON.stringify(meta));
assert.equal(meta.title, 'Sample Company S-1 Big');
pageHtml = await (await fetch(`${origin}/t/${meta.slug}`)).text();
assert.ok(pageHtml.includes('Variant paragraph'));
process.env.SYNC_LIMIT_BYTES = '';
assert.ok(pageHtml.includes('class="zt"'), '大网页同样带表格');
ok('大网页：先建占位，后台抓取解析，再 OCR 和翻译');

// “仅搬运”：大网页也只保存，不 OCR、不翻译（之前的 bug：大网页的后台导入忽略了这个选项）
{
  const batchesBefore = mineru.batches.size, llmBefore = stats.llmCalls;
  process.env.SYNC_LIMIT_BYTES = '20000';
  res = await post('/api/import', { url: origin + '/sample/s1.htm?raw', translate: false });
  assert.equal(res.status, 201, await res.clone().text());
  meta = await res.json();
  assert.equal(meta.status, 'importing');
  meta = await waitDone(meta.slug);
  process.env.SYNC_LIMIT_BYTES = '';
  assert.equal(meta.status, 'done', JSON.stringify(meta));
  assert.equal(meta.kind, 'raw');
  assert.equal(mineru.batches.size, batchesBefore, '仅搬运不能触发 OCR');
  assert.equal(stats.llmCalls, llmBefore, '仅搬运不能触发翻译');
  const raw = await fetch(`${origin}/t/${meta.slug}`);
  const rawText = await raw.text();
  assert.equal(raw.status, 200);
  assert.ok(rawText.includes('Filler paragraph 1') && rawText.includes('<base href="'));
  assert.ok(raw.headers.get('content-security-policy').includes("script-src 'none'"));
  // 不勾“自动翻译”的上传：有整页图片也不 OCR
  meta = await (await post('/api/upload', { filename: 'img-doc.html', translate: false, content: '<html><head><title>Img Doc</title></head><body><p>A normal English paragraph is here to translate later.</p><img src="https://example.com/p.jpg" style="width:612pt;height:792pt"></body></html>' })).json();
  assert.equal(meta.status, 'idle');
  assert.ok(meta.note.includes('没有识别'), meta.note);
  assert.equal(mineru.batches.size, batchesBefore, '没选翻译就不 OCR');
  ok('仅搬运（含大网页）不 OCR、不翻译；不自动翻译的上传也不 OCR');
}

// ---- 大 HTML 分块上传（SingleFile 保存的网页：图片、字体以 base64 内联）----
{
  const font = randomBytes(40000), img1 = randomBytes(1500000), img2 = randomBytes(1500000), img3 = randomBytes(1500000);
  const svgText = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script>' + '<rect width="1" height="1"/>'.repeat(120) + '</svg>';
  const small = Buffer.from('tiny').toString('base64');
  const html = `<!DOCTYPE html>\n<!--\n Page saved with SingleFile \n url: https://example.com/blog/post \n saved date: Wed Oct 28 2026\n-->\n<html><head><meta charset="utf-8"><title>SingleFile Post</title><style>@font-face{font-family:X;src:url(data:font/woff2;base64,${font.toString('base64')}) format('woff2')} body{font-family:X,serif;color:#222}</style></head><body><h1>SingleFile Post</h1><p>English paragraph one that should be translated into Chinese.</p><img src="data:image/png;base64,${img1.toString('base64')}" alt="a"><p>Second paragraph about the same subject matter.</p><img src="data:image/jpeg;base64,${img2.toString('base64')}" alt="b"><img src="data:image/png;base64,${img1.toString('base64')}" alt="same as first"><img src="data:image/gif;base64,${small}" alt="tiny"><img src="data:image/svg+xml;base64,${Buffer.from(svgText).toString('base64')}" alt="svg"><img src="data:image/png;base64,${img3.toString('base64')}" style="width:612pt;height:792pt" alt="page"></body></html>`;
  assert.ok(html.length > 6 * 1024 * 1024, '测试页应超过 6MB');
  assert.equal(singleFileUrl(html), 'https://example.com/blog/post');

  const raw = Buffer.from(html);
  const id = 'upload-sf000001';
  const size = 2 * 1024 * 1024;
  const n = Math.ceil(raw.length / size);
  for (let i = 0; i < n; i++) {
    const r = await fetch(`${origin}/api/upload/chunk?id=${id}&n=${i}`, { method: 'POST', headers: { 'x-admin-password': 'test-pass' }, body: raw.subarray(i * size, (i + 1) * size) });
    assert.equal(r.status, 200);
  }
  const llmBefore2 = stats.llmCalls, batchesBefore2 = mineru.batches.size;
  process.env.MINERU_API_TOKEN = '';            // 这一段不测 OCR，避免整页大图触发
  assert.equal((await post('/api/upload/start', { uploadId: id, chunks: 9999, filename: 'x.html' })).status, 400);
  res = await post('/api/upload/start', { uploadId: id, chunks: n, filename: 'post.singlefile.html', translate: true });
  assert.equal(res.status, 201, await res.clone().text());
  meta = await res.json();
  assert.equal(meta.status, 'importing');
  meta = await waitDone(meta.slug);
  process.env.MINERU_API_TOKEN = tokenBackup;
  assert.equal(meta.status, 'done', JSON.stringify(meta));
  assert.equal(meta.title, 'SingleFile Post');
  assert.equal(meta.layout, 'page');
  assert.ok(stats.llmCalls > llmBefore2 && mineru.batches.size === batchesBefore2);
  const sfPage = await (await fetch(`${origin}/t/${meta.slug}`)).text();
  assert.ok(!sfPage.includes('base64,') || sfPage.includes('data:image/gif;base64,'), '大的内联资源都已拆出（只剩小图标）');
  assert.ok(sfPage.length < 30000, '页面只剩文字和样式：' + sfPage.length);
  assert.ok(sfPage.includes('font-family:X') && sfPage.includes('[ZH] English paragraph one'), '样式保留，译文已插入');
  const base = `${origin}/api/img/${meta.slug}/`;
  assert.ok(sfPage.includes(`url(${base}d0.woff2)`), '字体改为本站地址');
  assert.ok(sfPage.includes(`${base}d1.png`) && sfPage.includes(`${base}d2.jpg`));
  // 同一张图出现两次只存一份；资源内容与原文件一致
  const names = [...sfPage.matchAll(/\/api\/img\/[\w-]+\/(d\d+\.\w+)/g)].map((m) => m[1]);
  assert.equal(new Set(names).size, 5, '字体 + png + jpg + svg + 整页 png，共 5 份：' + [...new Set(names)]);
  const fetchAsset = async (name) => { const r = await fetch(base + name); return { r, bytes: Buffer.from(await r.arrayBuffer()) }; };
  let a = await fetchAsset('d0.woff2');
  assert.ok(a.bytes.equals(font) && a.r.headers.get('content-type') === 'font/woff2');
  a = await fetchAsset('d1.png');
  assert.ok(a.bytes.equals(img1) && a.r.headers.get('content-type') === 'image/png');
  a = await fetchAsset('d2.jpg');
  assert.ok(a.bytes.equals(img2) && a.r.headers.get('content-type') === 'image/jpeg');
  a = await fetchAsset('d3.svg');
  assert.equal(a.r.headers.get('content-type'), 'image/svg+xml');
  assert.match(a.r.headers.get('content-security-policy'), /sandbox/, 'SVG 直接打开时被沙箱限制');
  assert.ok(fs.readdirSync(process.env.LOCAL_STORE_DIR).every((f) => !f.startsWith('pdf%2Fupload-sf000001')), '上传分块已清理');
  assert.ok((await getText(`html/${meta.slug}`)).length < 30000, '存储的网页很小');

  // 来源网址取自 SingleFile 的注释；相同内容再传一次会被识别为重复，并且不留下孤立图片
  assert.equal((await getJSON(`meta/${meta.slug}`)).sourceUrl, 'https://example.com/blog/post', '来源网址取自 SingleFile 的注释');
  const id2 = 'upload-sf000002';
  for (let i = 0; i < n; i++) await fetch(`${origin}/api/upload/chunk?id=${id2}&n=${i}`, { method: 'POST', headers: { 'x-admin-password': 'test-pass' }, body: raw.subarray(i * size, (i + 1) * size) });
  process.env.MINERU_API_TOKEN = '';
  const dup2 = await (await post('/api/upload/start', { uploadId: id2, chunks: n, filename: 'again.html', translate: true })).json();
  const dupDone = await waitDone(dup2.slug);
  process.env.MINERU_API_TOKEN = tokenBackup;
  assert.equal(dupDone.status, 'error');
  assert.ok(dupDone.error.includes('已经存在'), dupDone.error);
  assert.ok(fs.readdirSync(process.env.LOCAL_STORE_DIR).every((f) => !f.startsWith(`img%2F${dup2.slug}`)), '重复文章不留孤立图片');

  // 删除文章时一并删掉拆出来的图片
  assert.equal((await fetch(`${origin}/api/articles/${meta.slug}`, { method: 'DELETE', headers: H })).status, 200);
  assert.equal((await fetch(base + 'd1.png')).status, 404);
  assert.equal((await fetch(`${origin}/api/articles/${dup2.slug}`, { method: 'DELETE', headers: H })).status, 200);
  ok('大 HTML 分块上传：拼接、拆出内联图片/字体（去重）、样式保留、译文插入、来源网址、重复识别、清理');
}

// SEC 式限制：没有联系方式的 User-Agent 被拒；设置 FETCH_USER_AGENT 后可以
process.env.FETCH_USER_AGENT = '';
res = await post('/api/import', { url: origin + '/sample/sec-blocked.htm', translate: false });
assert.equal(res.status, 502);
process.env.FETCH_USER_AGENT = UA;
res = await post('/api/import', { url: origin + '/sample/sec-blocked.htm', translate: true });
assert.equal(res.status, 201, await res.clone().text());
await waitDone((await res.json()).slug);
ok('SEC 式 403：设置 FETCH_USER_AGENT 后可抓取');

// 超长文章：先估算，不自动翻译，确认后再翻
process.env.AUTO_TRANSLATE_MAX_CHARS = '100';
const longTxt = Array.from({ length: 12 }, (_, i) => `Confirmation test paragraph ${i} has enough English words to be counted toward the limit.`).join('\n\n');
meta = await (await post('/api/upload', { filename: 'long-confirm.txt', content: longTxt, translate: true })).json();
assert.equal(meta.status, 'idle');
assert.ok(meta.note.includes('没有自动开始翻译'), meta.note);
before2 = stats.llmCalls;
await new Promise((r) => setTimeout(r, 300));
assert.equal(stats.llmCalls, before2, '没确认前不调用模型');
process.env.AUTO_TRANSLATE_MAX_CHARS = '';
res = await post(`/api/articles/${meta.slug}/translate`, {});
assert.equal(res.status, 200);
assert.equal((await waitDone(meta.slug)).status, 'done');
ok('超长文章先给出估算，不自动翻译；确认后才翻译');

// 分页：段落很多时分页显示（Netlify 响应体 6MB 上限）
const manyTxt = Array.from({ length: 450 }, (_, i) => `Pagination paragraph number ${i} in a very long text.`).join('\n\n');
meta = await (await post('/api/upload', { filename: 'many.txt', content: manyTxt, translate: false })).json();
let p1 = await (await fetch(`${origin}/t/${meta.slug}`)).text();
let p2 = await (await fetch(`${origin}/t/${meta.slug}?p=2`)).text();
assert.ok(p1.includes('第 1 / 2 页') && p1.includes('number 0 in') && !p1.includes('number 449 in'));
assert.ok(p2.includes('第 2 / 2 页') && p2.includes('number 449 in') && !p2.includes('number 0 in'));
ok('长文章分页显示');

// 重复搬运同一篇
res = await post('/api/import', { url: origin + '/sample/en', translate: true });
assert.equal(res.status, 409);
ok('重复搬运同一篇被拦截');

// 已有中文翻译的文章：不调用大模型
const before = stats.llmCalls;
res = await post('/api/import', { url: origin + '/sample/dual', translate: true });
meta = await res.json();
assert.equal(meta.status, 'skip');
await new Promise((r) => setTimeout(r, 300));
assert.equal(stats.llmCalls, before);
ok('已有中文翻译的文章不会重复翻译（0 次模型调用）');

// 仅搬运
res = await post('/api/import', { url: origin + '/sample/en?raw', translate: false });
meta = await res.json();
assert.equal(meta.kind, 'raw');
const raw = await fetch(`${origin}/t/${meta.slug}`);
const rawHtml = await raw.text();
assert.ok(rawHtml.includes('<base href="' + origin + '/sample/en?raw">'));
assert.ok(!rawHtml.includes('alert(1)'));
assert.ok(raw.headers.get('content-security-policy').includes("script-src 'none'"));
ok('仅搬运：保留网页、去掉脚本、带 CSP');

// 抓取失败
res = await post('/api/import', { url: origin + '/sample/notfound', translate: true });
assert.equal(res.status, 502);
ok('抓取失败给出明确错误');

// 上传 Markdown：长文分多轮翻译、进度可见
const longMd = '# Long Doc\n\n' + Array.from({ length: 40 }, (_, i) => `Paragraph number ${i} has some English words in it for testing purposes. `.repeat(8)).join('\n\n');
stats.delayMs = 60;
res = await post('/api/upload', { filename: 'long.md', content: longMd, translate: true });
meta = await res.json();
assert.equal(res.status, 201);
let sawPartial = false;
for (;;) {
  const m = await get('/api/articles/' + meta.slug);
  if (m.done > 0 && m.done < m.total) sawPartial = true;
  if (m.status === 'done') { meta = m; break; }
  await new Promise((r) => setTimeout(r, 50));
}
stats.delayMs = 0;
assert.ok(sawPartial, '应能看到中间进度');
assert.equal(meta.done, meta.total);
ok('长文分多轮翻译，翻译中途进度可见（' + meta.total + ' 段）');

// 翻译中途页面：带进度条与自动刷新脚本
stats.delayMs = 400;
const longMd2 = longMd.replace('Long Doc', 'Another Long Doc').replace(/Paragraph/g, 'Section');
meta = await (await post('/api/upload', { filename: 'long2.md', content: longMd2, translate: true })).json();
await new Promise((r) => setTimeout(r, 600));
pageHtml = await (await fetch(`${origin}/t/${meta.slug}`)).text();
assert.ok(pageHtml.includes('id="progress"') && pageHtml.includes('data-active="1"'));
assert.ok(pageHtml.includes('<script nonce='));
ok('翻译中的页面显示进度并带自动刷新脚本');
await waitDone(meta.slug, 30000);
stats.delayMs = 0;

// XSS：原文里的 HTML 不会被执行
meta = await (await post('/api/upload', { filename: 'x.md', content: '# T\n\nHello <img src=x onerror=alert(1)> world [bad](javascript:alert(1)) text here.', translate: false })).json();
pageHtml = await (await fetch(`${origin}/t/${meta.slug}`)).text();
assert.ok(!pageHtml.includes('<img src=x') && !pageHtml.includes('href="javascript'));
ok('原文中的脚本/危险链接被转义');

// 未配置 API Key：保存文章并提示
const key = process.env.OPENAI_API_KEY;
process.env.OPENAI_API_KEY = '';
meta = await (await post('/api/upload', { filename: 'nokey.txt', content: 'This is a plain English text without any key configured.', translate: true })).json();
assert.ok(meta.error.includes('OPENAI_API_KEY'));
process.env.OPENAI_API_KEY = key;
res = await post(`/api/articles/${meta.slug}/translate`, {});
assert.equal(res.status, 200);
assert.equal((await waitDone(meta.slug)).status, 'done');
ok('未配置密钥时先保存，配置后可手动开始翻译');

// 列表、删除
const list = await get('/api/articles');
assert.ok(list.length >= 5);
res = await fetch(`${origin}/api/articles/${slugEn}`, { method: 'DELETE', headers: H });
assert.equal(res.status, 200);
assert.equal((await fetch(`${origin}/t/${slugEn}`)).status, 404);
ok('列表与删除');

close();
console.log(`\n全部通过：${passed} 项`);
process.exit(0);
