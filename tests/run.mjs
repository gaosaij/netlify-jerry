// 自动化测试：node tests/run.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startDevServer } from './dev-server.mjs';
import { createRequire } from 'node:module';
import { showZh } from '../netlify/functions/lib/parse.mjs';
import { parseMarkdown, parseHtml, parseText, analyze } from '../netlify/functions/lib/parse.mjs';
import { renderStyledPage } from '../netlify/functions/lib/render.mjs';
import { makePdf, samplePages } from './make-pdf.mjs';
import { samplePositionedHtml } from './make-positioned.mjs';
import { looksPositioned, parsePositioned } from '../netlify/functions/lib/positioned.mjs';
import { blockedHint } from '../netlify/functions/lib/ingest.mjs';
import { assertPublicUrl, isPrivateIp } from '../netlify/functions/lib/safe-fetch.mjs';
import { externalizeDataUris, singleFileUrl, hasBigDataUri } from '../netlify/functions/lib/assets.mjs';
import { getJSON, setJSON, getText, setText, getBinary, listMeta } from '../netlify/functions/lib/store.mjs';
import { randomBytes } from 'node:crypto';
const { buildBlocks } = createRequire(import.meta.url)('../netlify/functions/lib/pdf-layout.cjs');
const { extractDataUris, b64ToBytes, scanDataUris, hasDataUri } = createRequire(import.meta.url)('../netlify/functions/lib/assets-scan.cjs');

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
  parsed.blocks.forEach((b) => { if (!b.s) b.zh = '[ZH] ' + b.en + ' 中文译文'; });
  const t0 = Date.now();
  const out = renderStyledPage({ status: 'done', total: info.total, done: info.total, updatedAt: 1 }, { blocks: parsed.blocks }, parsed.html, 'n');
  assert.equal((out.match(/class="[^"]*zh-tr/g) || []).length, info.total);
  ok(f.slice(0, 20) + '… 样式版渲染：' + info.total + ' 段，' + (Date.now() - t0) + 'ms');
}

// 译文值不值得显示：人名、DOI、参考文献这类原样返回的内容不再重复显示一遍
{
  const z = (en, zh) => showZh({ en, zh });
  assert.equal(z('2019, Vol. 117, No. 6, 1139–1144 http://dx.doi.org/10.1037/pspi0000220', '2019, Vol. 117, No. 6, 1139–1144 http://dx.doi.org/10.1037/pspi0000220'), false, '原样返回');
  assert.equal(z('Julia Minson, Harvard Kennedy School of Government', 'Julia Minson，Harvard Kennedy School of Government'), false, '只换了标点');
  assert.equal(z('Michael Yeomans, Alison Wood Brooks, and Karen Huang Harvard Business School', 'Michael Yeomans、Alison Wood Brooks 和 Karen Huang，Harvard Business School'), false, '只多了一个“和”');
  assert.equal(z('© 2019 American Psychological Association ISSN: 0022-3514', '© 2019 American Psychological Association ISSN: 0022-3514'), false);
  assert.equal(z('Abstract', '摘要'), true, '短而真实的译文要显示');
  assert.equal(z('Table 1', '表 1'), true);
  assert.equal(z('Introduction to lme4', 'lme4 简介'), true);
  assert.equal(z('Kenny, D. A., & La Voie, L. (1984). The Social Relations Model. Advances in Experimental Social Psychology, 18, 141–182.', 'Kenny, D. A., & La Voie, L. (1984). 社会关系模型. Advances in Experimental Social Psychology, 18, 141–182.'), true, '参考文献里翻译了标题的要显示');
  assert.equal(z('Despite the rapid adoption of LLM chatbots, little is known about how they are used.', '尽管大语言模型聊天机器人迅速普及，但人们对它们如何被使用知之甚少。'), true);
  assert.equal(showZh({ en: 'x', zh: '' }), false);
  assert.equal(showZh({ en: 'x', zh: '译文', s: 1 }), false);
  ok('译文显示规则：原样返回/只换标点/只多一两个字不显示，短而真实的译文和翻译了标题的参考文献要显示');
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

// SSRF 防护：地址分类（不依赖网络）
{
  assert.equal(process.env.ALLOW_PRIVATE_URLS, undefined);
  for (const bad of ['http://127.0.0.1:9/', 'http://localhost/x', 'http://foo.localhost/', 'http://[::1]/', 'http://10.1.2.3/', 'http://169.254.169.254/latest/meta-data/',
    'http://192.168.0.10/', 'http://172.16.5.5/', 'http://172.31.255.255/', 'http://100.64.0.1/', 'http://0.0.0.0/', 'http://[::ffff:7f00:1]/', 'http://[::ffff:10.0.0.1]/',
    'http://[fd00::1]/', 'http://[fe80::1]/', 'http://printer.local/', 'http://db.internal/', 'file:///etc/passwd', 'ftp://example.com/x', 'gopher://x/']) {
    await assert.rejects(() => assertPublicUrl(bad), (e) => e.status === 400, bad + ' 应被拒绝');
  }
  for (const good of ['http://8.8.8.8/', 'https://1.1.1.1/x.jpg', 'https://[2001:4860:4860::8888]/', 'http://172.32.0.1/', 'http://100.128.0.1/']) {
    assert.ok(await assertPublicUrl(good), good + ' 应被允许');
  }
  assert.equal(isPrivateIp('169.254.169.254'), true);
  assert.equal(isPrivateIp('93.184.216.34'), false);
  ok('SSRF：本机/内网/链路本地/云元数据/IPv4 映射/非 http 协议都被拒绝，公网地址放行');
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
assert.ok(pageHtml.includes(`<h2 class="d dh" style="font-family:'Georgia', serif;font-size:14pt;font-weight:bold;color:#1a1a1a;">1 Our Mission</h2><h2 class="d dh dz" style="font-family:'Georgia', 'Songti SC','Noto Serif CJK SC','SimSun',serif;font-size:14pt;font-weight:bold;color:#1a1a1a;">[ZH] 1 Our Mission 中文译文</h2>`), '标题保留字体/字号/加粗/颜色，译文紧跟其后，style 属性完整');
assert.ok(/<p class="d dz" style="font-family:'Georgia', 'Songti SC'[^"]*font-size:9.5pt;color:#17406b;">\[ZH\] We believe/.test(pageHtml), '正文译文有字号和颜色');
assert.ok(!/style="[^"]*"[a-z]/.test(pageHtml.split('<article>')[1].split('</article>')[0].replace(/<table[\s\S]*?<\/table>/g, '')), 'style 属性里不能出现未转义的双引号');
assert.ok(pageHtml.includes('<table style="border-collapse:collapse;display:inline-table;width:100%">') && pageHtml.includes('background-color:#ecebe3'), '原表格原样保留');
assert.ok(pageHtml.includes('position:relative;width:468pt;height:54.75pt'), '表格容器尺寸和原来一致');
assert.ok(pageHtml.includes('class="zt"') && pageHtml.includes('[ZH] Revenue') && pageHtml.includes('[ZH] Net loss'), '中文对照表');
assert.ok(pageHtml.includes('<td class="num">100%</td>') && pageHtml.includes('<td class="num">(3,734)</td>'), '数字原样');
assert.ok(pageHtml.includes('font-style:italic;') && pageHtml.includes('Note: Totals of the table'));
// OCR 识别出的表格（没有原始版式）在文档版式里也要显示，且去掉了危险属性
assert.ok(pageHtml.includes('<div class="raw table-wrap"><table><tbody><tr><td>cell value</td></tr></tbody></table></div>') || /<div class="raw table-wrap">[\s\S]*?cell value[\s\S]*?<\/div>/.test(pageHtml), 'OCR 表格在文档版式里显示');
assert.ok(!/<td[^>]*onclick/.test(pageHtml));
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

// ---- 右上角“中英对照 / 仅英文”切换按钮：三种版式都有；已有中文的文章没有 ----
{
  const mk = async (fn) => { const m = await fn(); await waitDone(m.slug, 30000); return (await fetch(`${origin}/t/${m.slug}`)).text(); };
  const pages = {
    通用对照排版: await mk(async () => (await (await post('/api/upload', { filename: 'vm.md', content: '# View mode\n\nToggle test paragraph for the view mode of the page.', translate: true })).json())),
    保留原样式: await mk(async () => (await (await post('/api/import', { url: origin + '/sample/en4', translate: true })).json())),
    PDF文档版式: await mk(async () => (await (await post('/api/import', { url: origin + '/sample/multi.htm?tag=T&imgs=', translate: true })).json())),
  };
  for (const [name, html] of Object.entries(pages)) {
    assert.ok(html.includes("html.en-only .zh, html.en-only .zh-tr, html.en-only .dz"), name + '：有隐藏译文的样式');
    assert.ok(html.includes("id = 'vm-toggle'") && html.includes('中英对照') && html.includes('仅英文'), name + '：有切换按钮脚本');
    assert.ok(html.includes("localStorage.getItem('viewMode')==='en'") , name + '：页面显示前就应用上次的选择');
    assert.ok(/<script nonce="[^"]+">\s*\(function \(\) \{\s+var KEY/.test(html), name + '：脚本带 nonce，符合 CSP');
  }
  const zhMeta = await (await post('/api/upload', { filename: 'zh-only.txt', content: '这是一篇已经是中文的文章，不需要再翻译。\n\n第二段同样是中文内容，用来测试检测逻辑。', translate: true })).json();
  assert.equal(zhMeta.status, 'skip');
  const skipSlug = zhMeta.slug;
  const skipHtml = await (await fetch(`${origin}/t/${skipSlug}`)).text();
  assert.ok(!skipHtml.includes('vm-toggle'), '已有中文的文章不需要切换按钮');
  ok('“中英对照 / 仅英文”按钮：通用排版、保留原样式、PDF 文档版式都有，已有中文的文章没有');
}

// ---- 原样返回的段落（人名、DOI…）不重复显示：三种版式 ----
{
  const doi = 'KEEP: 2019, Vol. 117, No. 6, 1139–1144 http://dx.doi.org/10.1037/pspi0000220';
  const count = (html, t) => html.split(t).length - 1;
  // 通用对照排版
  meta = await (await post('/api/upload', { filename: 'keep.md', content: `# Keep test\n\nA normal paragraph that should really be translated.\n\n${doi}`, translate: true })).json();
  await waitDone(meta.slug);
  let page = await (await fetch(`${origin}/t/${meta.slug}`)).text();
  assert.equal(count(page, 'KEEP: 2019, Vol. 117'), 1, '通用排版：DOI 只出现一次');
  assert.ok(page.includes('[ZH] A normal paragraph') && page.includes('中文译文'), '正常段落有译文');
  // 保留原样式
  meta = await (await post('/api/upload', { filename: 'keep.html', content: `<html><head><title>Keep Styled</title></head><body><p>A different normal paragraph for the styled layout test.</p><p>${doi}</p></body></html>`, translate: true })).json();
  await waitDone(meta.slug);
  page = await (await fetch(`${origin}/t/${meta.slug}`)).text();
  assert.equal(count(page, 'KEEP: 2019, Vol. 117'), 1, '保留样式：DOI 只出现一次');
  assert.equal(count(page, 'class="zh-tr"'), 1, '只有正常段落有译文元素');
  // PDF 文档版式
  const kp = samplePositionedHtml([]).replace('Filler paragraph 1 describes', 'KEEP: Filler paragraph 1 describes');
  assert.ok(kp !== samplePositionedHtml([]));
  meta = await (await post('/api/upload', { filename: 'keep-doc.html', content: kp.replace('Sample Company S-1', 'Sample Company S-1 Keep'), translate: true })).json();
  await waitDone(meta.slug);
  page = await (await fetch(`${origin}/t/${meta.slug}`)).text();
  assert.equal(count(page, 'KEEP: Filler paragraph 1 describes'), 1, '文档版式：原样返回的段落只出现一次');
  ok('原样返回的段落（人名、DOI 等）在三种版式里都只显示一次');
}

// ---- 站内文章的“原路径”：Netlify 会把 .html 地址跳转成小写、无后缀的地址 ----
{
  meta = await (await post('/api/import', { url: origin + '/articles-sim/Static_Article.html', translate: true, origPath: '/articles-sim/Static_Article.html' })).json();
  assert.equal((await getJSON(`meta/${meta.slug}`)).origPath, '/articles-sim/Static_Article.html', '管理页指定的原路径被如实记录，而不是跳转后的地址');
  await waitDone(meta.slug);
  assert.equal((await getJSON(`meta/${meta.slug}`)).sourceUrl, origin + '/articles-sim/static_article', '来源地址是跳转后的真实地址');
  // 管理页、首页用的宽松比较：能对上你实际遇到的两个地址
  const grab = (file, re) => new Function(`return (${file.match(re)[1].replace(/;\s*$/, '')})`)();
  const adminFn = grab(fs.readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8'), /const normPath = ([^\n]+)/);
  const homeFn = grab(fs.readFileSync(new URL('../index.template.html', import.meta.url), 'utf8'), /var norm = ([^\n]+)/);
  for (const norm of [adminFn, homeFn]) {
    assert.equal(
      norm('/articles/It_Helps_to_Ask_-_The_Cumulative_Benefits_of_Asking_Follow-Up_Questions.html'),
      norm('/articles/it_helps_to_ask_-_the_cumulative_benefits_of_asking_follow-up_questions'));
    assert.equal(norm('/articles/Intimacy_as_an_Interpersonal_Process_-_The_Importance_of_Self-Disclosure%2C_Partner_Disclosure.html'),
      norm('/articles/intimacy_as_an_interpersonal_process_-_the_importance_of_self-disclosure,_partner_disclosure'));
    assert.notEqual(norm('/articles/a.html'), norm('/articles/b.html'));
  }
  ok('站内文章原路径：指定的路径如实记录；管理页和首页的路径比较能对上被 Netlify 改写的地址');
}

// ---- 翻译：截止时间内交棒、停滞保护、限频保存文档 ----
{
  const longDoc = (tag, n) => `# ${tag}\n\n` + Array.from({ length: n }, (_, i) => `${tag} paragraph ${i} has enough plain English words to take up some space in a batch.`).join('\n\n');
  const zhCount = (html) => (html.match(/class="zh"/g) || []).length;

  // 1) 一次请求超过截止时间：不算失败，保存进度并交棒，新的一次运行接着完成
  process.env.TRANSLATE_DEADLINE_MS = '1200'; process.env.TRANSLATE_MARGIN_MS = '100';
  stats.delayOnce = 4000; // 第一次模型请求特别慢（超过截止时间被中断）
  const calls0 = stats.llmCalls;
  meta = await (await post('/api/upload', { filename: 'deadline.md', content: longDoc('Deadline', 6), translate: true })).json();
  meta = await waitDone(meta.slug, 30000);
  process.env.TRANSLATE_DEADLINE_MS = ''; process.env.TRANSLATE_MARGIN_MS = '';
  assert.equal(meta.status, 'done', JSON.stringify(meta));
  assert.ok(stats.llmCalls - calls0 >= 2, '被中断的请求之后又重新请求了');
  assert.equal(zhCount(await (await fetch(`${origin}/t/${meta.slug}`)).text()), 7, '标题+6 段都翻译了');

  // 2) 连续几次运行都在时间上限内完不成任何一批：明确报错，而不是无限交棒
  process.env.TRANSLATE_DEADLINE_MS = '600'; process.env.TRANSLATE_MARGIN_MS = '100';
  stats.delayMs = 3000;
  meta = await (await post('/api/upload', { filename: 'stall.md', content: longDoc('Stall', 3), translate: true })).json();
  meta = await waitDone(meta.slug, 30000);
  stats.delayMs = 0; process.env.TRANSLATE_DEADLINE_MS = ''; process.env.TRANSLATE_MARGIN_MS = '';
  assert.equal(meta.status, 'error');
  assert.ok(meta.error.includes('响应太慢'), meta.error);

  // 3) 限频保存：很长的文章，每轮都交棒（预算 1ms），文档只在强制点落盘；结果完整，没有重复翻译
  process.env.TRANSLATE_SAVE_MS = '100000000'; process.env.TRANSLATE_BUDGET_MS = '1';
  const callsB = stats.llmCalls;
  meta = await (await post('/api/upload', { filename: 'throttle.md', content: longDoc('Throttle', 119), translate: true })).json();
  meta = await waitDone(meta.slug, 60000);
  process.env.TRANSLATE_SAVE_MS = ''; process.env.TRANSLATE_BUDGET_MS = '';
  assert.equal(meta.status, 'done', JSON.stringify(meta));
  assert.equal(meta.done, meta.total);
  assert.equal(zhCount(await (await fetch(`${origin}/t/${meta.slug}`)).text()), 120, '120 段全部翻译，交棒不丢进度');
  assert.equal(stats.llmCalls - callsB, 4, '120 段 = 4 批，每批只请求一次（交棒前强制保存，没有重复翻译）');

  // 4) 不限频时每一轮都更新 updatedAt（页面轮询靠它判断要不要刷新）；限频时只在强制点更新
  const distinctUpdates = async (saveMs) => {
    process.env.TRANSLATE_SAVE_MS = saveMs;
    stats.delayMs = 80;
    const m = await (await post('/api/upload', { filename: 'cadence-' + saveMs + '.md', content: longDoc('Cadence' + saveMs, 400), translate: true })).json();
    const seen = new Set();
    for (;;) {
      const cur = await getJSON(`meta/${m.slug}`);
      seen.add(cur.updatedAt);
      if (['done', 'error'].includes(cur.status)) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    stats.delayMs = 0; process.env.TRANSLATE_SAVE_MS = '';
    return seen.size;
  };
  const frequent = await distinctUpdates('1');
  const throttled = await distinctUpdates('100000000');
  assert.ok(frequent >= 5, '不限频：每轮都更新（' + frequent + '）');
  assert.ok(throttled <= 3, '限频：只在开始和结束时更新（' + throttled + '）');
  ok('翻译：超截止时间不算失败而是交棒；连续停滞明确报错；文档限频保存且交棒不丢进度、不重复翻译');
}

// ---- 畸形的百分号编码：返回 4xx，不能让函数崩溃 ----
{
  for (const p of ['/api/%', '/api/articles/%E0%A4%A', '/api/img/abc/%zz.png']) {
    const r = await fetch(origin + p);
    assert.equal(r.status, 400, p);
    assert.ok((await r.json()).error.includes('路径编码'));
  }
  for (const p of ['/t/%', '/t/%E0%A4%A']) {
    const r = await fetch(origin + p);
    assert.equal(r.status, 404, p);
    assert.ok((await r.text()).includes('文章不存在'));
  }
  assert.equal((await fetch(origin + '/api/articles/%61bc')).status, 404, '合法的编码照常解码（%61 = a）');
  ok('畸形的百分号编码返回 400/404，不再崩溃');
}

// ---- SSRF 端到端：重定向到元数据地址、网页里指向内网的图片、不是图片的响应 ----
{
  // 管理员输入的网址重定向到云元数据地址：被拦截
  res = await post('/api/import', { url: origin + '/redir/internal', translate: true });
  assert.equal(res.status, 400);
  assert.ok((await res.json()).error.includes('不允许访问内网或本机地址'));
  // 被搬运网页里的整页图片指向内网、或返回的不是图片：这两张失败，正常的那张照常识别
  const b0 = mineru.batches.size;
  const html = `<html><head><title>Evil Images</title></head><body><p>A normal English paragraph so the page has text to translate.</p>
    <img src="http://169.254.169.254/latest/meta-data/a.jpg" style="width:612pt;height:792pt">
    <img src="${origin}/sample/pg-notimage.jpg" style="width:612pt;height:792pt">
    <img src="${origin}/sample/pg1a.jpg" style="width:612pt;height:792pt"></body></html>`;
  meta = await (await post('/api/upload', { filename: 'evil.html', content: html, translate: true })).json();
  meta = await waitDone(meta.slug);
  assert.equal(meta.status, 'done', JSON.stringify(meta));
  const sent = [...mineru.batches.values()].slice(b0).flatMap((b) => b.files.map((f) => f.name));
  assert.deepEqual(sent, ['img-2.jpg'], '只有正常的图片被上传给 MinerU');
  assert.ok(meta.note.includes('2 张整页图片没能识别'), meta.note);
  const j = (await getJSON(`meta/${meta.slug}`)).ocr.jobs;
  assert.ok(j[0].err.includes('不允许访问内网或本机地址') && j[1].err.includes('不是图片'), JSON.stringify(j.map((x) => x.err)));
  ok('SSRF 端到端：重定向到元数据地址被拦；网页里指向内网/非图片的整页图片下载失败而不外传');
}

// ---- 渲染缓存与轻量轮询：“保留原样式”的文章不再每次请求都重新解析整份网页 ----
{
  const NT = '__CSP_NONCE_PLACEHOLDER__';
  const styled = (await get('/api/articles')).find((m) => m.layout === 'page' && m.status === 'done');
  const slug = styled.slug;
  const nonceOf = (r) => r.headers.get('content-security-policy').match(/nonce-([^']+)'/)[1];
  await (await fetch(`${origin}/t/${slug}`)).text(); // 渲染并写入缓存
  const m1 = await getJSON(`meta/${slug}`);
  const cached = await getText(`render/${slug}`);
  assert.ok(cached && cached.startsWith(`v=${m1.updatedAt}\n`) && cached.includes(NT), '渲染结果已缓存，nonce 用占位符');
  // 用哨兵证明缓存真的被使用；每次请求的 nonce 不同，并且被替换进了页面
  await setText(`render/${slug}`, `v=${m1.updatedAt}\n<html><body>CACHED_SENTINEL<script nonce="${NT}"></script></body></html>`);
  const r1 = await fetch(`${origin}/t/${slug}`); const t1 = await r1.text();
  const r2 = await fetch(`${origin}/t/${slug}`); await r2.text();
  assert.ok(t1.includes('CACHED_SENTINEL') && t1.includes(`nonce="${nonceOf(r1)}"`) && !t1.includes(NT));
  assert.notEqual(nonceOf(r1), nonceOf(r2), '缓存不能让不同请求共用同一个 nonce');
  // updatedAt 变化后缓存失效：重新渲染并更新缓存
  m1.updatedAt += 1; await setJSON(`meta/${slug}`, m1);
  const t3 = await (await fetch(`${origin}/t/${slug}`)).text();
  assert.ok(!t3.includes('CACHED_SENTINEL') && t3.includes('class="zh-tr"'));
  assert.ok((await getText(`render/${slug}`)).startsWith(`v=${m1.updatedAt}\n`));
  // 翻译进行中的文章不缓存；轮询脚本先查状态接口，只有进度变了才下载整页
  stats.delayMs = 300;
  const hot = await (await post('/api/upload', { filename: 'hot.html', content: '<html><head><title>Hot Styled</title><style>p{color:blue}</style></head><body>' + Array.from({ length: 300 }, (_, i) => `<p>Hot styled paragraph ${i} for the cache test in the page layout.</p>`).join('') + '</body></html>', translate: true })).json();
  await new Promise((r) => setTimeout(r, 350));
  const hotHtml = await (await fetch(`${origin}/t/${hot.slug}`)).text();
  assert.ok(hotHtml.includes('data-active="1"'));
  assert.ok(hotHtml.includes("fetch('/api/articles/' + encodeURIComponent(slug)") && hotHtml.includes('String(m.updatedAt) === p.dataset.updated'), '轮询先查状态接口');
  assert.equal(await getText(`render/${hot.slug}`), null, '翻译进行中不缓存');
  stats.delayMs = 0;
  await waitDone(hot.slug);
  // 紧凑排版/文档版式的轮询脚本同样先查状态接口
  assert.ok((await (await fetch(`${origin}/t/${hot.slug}`)).text()).includes('p{color:blue}'));
  await fetch(`${origin}/t/${hot.slug}`);
  assert.ok((await getText(`render/${hot.slug}`)).startsWith('v='), '完成后才缓存');
  assert.equal((await fetch(`${origin}/api/articles/${hot.slug}`, { method: 'DELETE', headers: H })).status, 200);
  assert.equal(await getText(`render/${hot.slug}`), null, '删除文章时一并清掉缓存');
  ok('渲染缓存：完成后缓存、nonce 每次不同、updatedAt 变化即失效、翻译中不缓存、删除时清理；轮询先查状态接口');
}

// ---- 文章列表缓存：3 秒内复用；写入/删除立即失效；查重用最新数据 ----
{
  const warm = async () => { await listMeta(); return listMeta(); };
  const first = (await warm())[0];
  const file = path.join(process.env.LOCAL_STORE_DIR, encodeURIComponent(`meta/${first.slug}`));
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...raw, title: 'CHANGED_BEHIND_THE_BACK' })); // 绕过 store 直接改文件
  assert.equal((await listMeta()).find((m) => m.slug === first.slug).title, first.title, '缓存期内复用，不重新读取存储');
  assert.equal((await listMeta({ fresh: true })).find((m) => m.slug === first.slug).title, 'CHANGED_BEHIND_THE_BACK', 'fresh 强制读最新');
  await setJSON(`meta/${first.slug}`, raw); // 通过 store 写入：缓存立即失效
  assert.equal((await listMeta()).find((m) => m.slug === first.slug).title, first.title);
  ok('文章列表缓存：缓存期内复用，写入立即失效，fresh 强制读最新');
}

// ---- 上传到 MinerU 失败：重试、报出底层原因、断点续传、截止时间交棒 ----
{
  process.env.MINERU_RETRY_BASE_MS = '10';
  const imp = async (n, tag) => (await (await post('/api/import', { url: `${origin}/sample/multi.htm?tag=${tag}&imgs=${Array.from({ length: n }, (_, i) => `pg${i + 1}a.jpg`).join(',')}`, translate: true })).json());
  const english = (html) => (html.match(/>Paragraph text from b\d+-\d about habits\./g) || []).length;

  // 1) 短暂的网络失败：自动重试，最终成功
  stats.putFailTimes = 2;
  let a = await imp(3, 'RT');
  a = await waitDone(a.slug, 30000);
  assert.equal(a.status, 'done', JSON.stringify(a));
  assert.equal(english(await (await fetch(`${origin}/t/${a.slug}`)).text()), 3);

  // 2) 持续失败（第 2 个文件的连接总是被掐断）：报错里有底层原因和重试次数；已传成功的先保存；继续时只补传剩下的
  const p0 = mineru.puts.length;
  stats.putFailIndex = 1;
  a = await imp(3, 'PF');
  a = await waitDone(a.slug, 30000);
  assert.equal(a.status, 'error', JSON.stringify(a));
  assert.ok(a.error.includes('上传到 MinerU 失败') && a.error.includes('已重试 5 次'), a.error);
  assert.match(a.error, /(ECONNRESET|other side closed|UND_ERR_SOCKET|socket|terminated)/i, '带上底层原因：' + a.error);
  assert.ok(a.error.includes('已上传 2 / 3') && a.stage === 'ocr', a.error);
  assert.equal(mineru.puts.length - p0, 2, '同一组里成功的两张已经传了并保存');
  stats.putFailIndex = -1;
  res = await post(`/api/articles/${a.slug}/translate`, {}); // “继续识别”
  assert.equal(res.status, 200);
  a = await waitDone(a.slug, 30000);
  assert.equal(a.status, 'done', JSON.stringify(a));
  assert.equal(mineru.puts.length - p0, 3, '继续时只补传没传完的那一张，已传的不重传');
  assert.equal(english(await (await fetch(`${origin}/t/${a.slug}`)).text()), 3, '3 张都识别了');

  // 3) 上传太慢（超过截止时间）：保存进度并交棒；连续 3 次没有进展就明确报错，不会被平台强杀后静默卡住
  process.env.OCR_DEADLINE_MS = '1500'; process.env.DEADLINE_MARGIN_MS = '100'; process.env.OCR_GROUP_MARGIN_MS = '100';
  stats.putDelayMs = 2500;
  a = await imp(1, 'SL');
  a = await waitDone(a.slug, 40000);
  stats.putDelayMs = 0; process.env.OCR_DEADLINE_MS = ''; process.env.DEADLINE_MARGIN_MS = ''; process.env.OCR_GROUP_MARGIN_MS = ''; process.env.MINERU_RETRY_BASE_MS = '';
  assert.equal(a.status, 'error', JSON.stringify(a));
  assert.ok(a.error.includes('上传到 MinerU 太慢'), a.error);
  ok('上传到 MinerU：短暂失败自动重试；持续失败报出底层原因并保留进度、继续时只补传剩下的；太慢时交棒并明确报错');
}

// ---- 互斥：任务运行中不能再启动一个；锁过期才能重试；慢步骤期间锁持续刷新；删除后不会被心跳复活 ----
{
  const slugs = (await get('/api/articles')).filter((m) => m.status === 'done' && m.kind === 'bilingual');
  const target = slugs[0].slug;
  const withMeta = async (patch) => { const m = await getJSON(`meta/${target}`); Object.assign(m, patch); await setJSON(`meta/${target}`, m); return m; };
  const orig = await getJSON(`meta/${target}`);

  // 翻译：锁还新鲜 → 409，且不会把锁清掉
  const fresh = Date.now() - 1000;
  await withMeta({ status: 'translating', lockAt: fresh });
  res = await post(`/api/articles/${target}/translate`, {});
  assert.equal(res.status, 409);
  assert.equal((await getJSON(`meta/${target}`)).lockAt, fresh, '被拒绝时不能清掉别人的锁');
  // 锁已过期（上一次运行被强杀）→ 允许重试
  await withMeta({ status: 'translating', lockAt: Date.now() - 7 * 60 * 1000 });
  res = await post(`/api/articles/${target}/translate`, {});
  assert.equal(res.status, 200);
  assert.equal((await waitDone(target)).status, 'done');
  // OCR 阶段、抓取阶段同理
  await withMeta({ status: 'ocr', lockAt: Date.now() - 1000, ocr: { mode: 'images', jobs: [], finished: false } });
  assert.equal((await post(`/api/articles/${target}/translate`, {})).status, 409);
  await withMeta({ ocr: undefined, ingest: { url: 'http://x/', translate: true }, status: 'importing', lockAt: Date.now() - 1000 });
  assert.equal((await post(`/api/articles/${target}/translate`, {})).status, 409);
  await setJSON(`meta/${target}`, orig); // 还原

  // 心跳：下载/上传很慢时，锁在运行期间持续刷新（否则超过 6 分钟的慢组会被误判为中断）
  process.env.LOCK_HEARTBEAT_MS = '40'; stats.putDelayMs = 350;
  const hb = await (await post('/api/import', { url: `${origin}/sample/multi.htm?tag=HB&imgs=pg1a.jpg,pg2a.jpg,pg3a.jpg,pg4a.jpg,pg5a.jpg,pg6a.jpg`, translate: true })).json();
  const locks = new Set();
  for (;;) {
    const cur = await getJSON(`meta/${hb.slug}`);
    if (cur && cur.lockAt) locks.add(cur.lockAt);
    if (cur && ['done', 'error'].includes(cur.status)) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(locks.size >= 6, '慢上传期间锁被持续刷新：' + locks.size + ' 个不同的值');
  assert.equal((await getJSON(`meta/${hb.slug}`)).status, 'done');

  // 运行途中删除文章：心跳和保存都不能把它写回来
  const doomed = await (await post('/api/import', { url: `${origin}/sample/multi.htm?tag=DEL&imgs=pg1a.jpg,pg2a.jpg,pg3a.jpg`, translate: true })).json();
  await new Promise((r) => setTimeout(r, 300)); // 等后台开始上传
  assert.equal((await fetch(`${origin}/api/articles/${doomed.slug}`, { method: 'DELETE', headers: H })).status, 200);
  await new Promise((r) => setTimeout(r, 1800)); // 之后后台还会跑一阵，期间心跳（40ms）持续触发
  stats.putDelayMs = 0; process.env.LOCK_HEARTBEAT_MS = '';
  assert.equal(await getJSON(`meta/${doomed.slug}`), null, '删除后不能被心跳或保存复活');
  ok('互斥：运行中重试返回 409 且不清锁、锁过期可重试；慢步骤期间锁持续刷新；删除后不会被复活');
}

// ---- 纯图片网页：不能被当成“已有中文”而跳过 OCR ----
{
  assert.equal(analyze(parseText('12345\n\n678').blocks).alreadyChinese, false);
  assert.equal(analyze([]).alreadyChinese, false);
  const imgOnly = (src) => `<html><head><title>Image Only ${src.length}</title></head><body><img src="${origin}/sample/${src}" style="width:612pt;height:792pt"></body></html>`;
  const b0 = mineru.batches.size;
  meta = await (await post('/api/upload', { filename: 'img-only.html', content: imgOnly('pg1a.jpg'), translate: true })).json();
  assert.equal(meta.status, 'ocr', '纯图片网页应该先 OCR');
  meta = await waitDone(meta.slug);
  assert.equal(meta.status, 'done', JSON.stringify(meta));
  assert.equal(mineru.batches.size, b0 + 1);
  assert.ok((await (await fetch(`${origin}/t/${meta.slug}`)).text()).includes('[ZH] Paragraph text from'), 'OCR 文字已翻译');
  // 没选翻译：不 OCR，给出说明，状态是 idle 而不是 skip
  meta = await (await post('/api/upload', { filename: 'img-only2.html', content: imgOnly('pg2a.jpg'), translate: false })).json();
  assert.equal(meta.status, 'idle');
  assert.ok(meta.note.includes('没有选择翻译'), meta.note);
  assert.equal(mineru.batches.size, b0 + 1);
  // 没配 MinerU：提示需要配置
  process.env.MINERU_API_TOKEN = '';
  meta = await (await post('/api/upload', { filename: 'img-only3.html', content: imgOnly('pg3a.jpg'), translate: true })).json();
  process.env.MINERU_API_TOKEN = tokenBackup;
  assert.equal(meta.status, 'idle');
  assert.ok(meta.note.includes('MINERU_API_TOKEN'), meta.note);
  // 既没有文字也没有图片
  meta = await (await post('/api/upload', { filename: 'digits.txt', content: '12345\n\n67890', translate: true })).json();
  assert.equal(meta.status, 'done');
  assert.equal(meta.note, '没有需要翻译的英文内容');
  ok('纯图片网页先 OCR 再翻译；没选翻译/没配 MinerU 时给出说明；无文字内容不再显示“已有中文”');
}

// ---- 整页图片 OCR：个别失败、全部失败、超时交棒 ----
{
  const run = async (imgs, tag) => {
    const r = await post('/api/import', { url: `${origin}/sample/multi.htm?tag=${tag}&imgs=${imgs}`, translate: true });
    assert.equal(r.status, 201, await r.clone().text());
    return waitDone((await r.json()).slug, 30000);
  };
  // 一张下载失败：其它照常识别，文章完成并在备注里说明
  const b0 = mineru.batches.size;
  meta = await run('pg1a.jpg,pg-missing.jpg,pg2a.jpg', 'F');
  assert.equal(meta.status, 'done', JSON.stringify(meta));
  const bs = [...mineru.batches.values()].slice(b0);
  assert.deepEqual(bs.flatMap((b) => b.files.map((f) => f.name)), ['img-0.jpg', 'img-2.jpg'], '失败的那张不提交给 MinerU');
  assert.ok(meta.note.includes('1 张整页图片没能识别') && meta.note.includes('404'), meta.note);
  let pg = await (await fetch(`${origin}/t/${meta.slug}`)).text();
  assert.equal((pg.match(/>Paragraph text from b\d+-\d about habits\./g) || []).length, 2, '两张成功的图都有识别文字');
  // 全部失败：明确报错
  meta = await run('pg-missing.jpg', 'G');
  assert.equal(meta.status, 'error');
  assert.ok(meta.error.includes('下载失败') && meta.error.includes('404'), meta.error);
  // 超过时间预算：保存进度、交棒给新的调用，已上传的图片不重传
  process.env.OCR_BUDGET_MS = '1';
  const b1 = mineru.batches.size, put1 = mineru.puts.length;
  meta = await run('pg1a.jpg,pg2a.jpg,pg3a.jpg,pg4a.jpg,pg5a.jpg,pg6a.jpg,pg7a.jpg,pg8a.jpg', 'H');
  process.env.OCR_BUDGET_MS = '';
  assert.equal(meta.status, 'done', JSON.stringify(meta));
  const bs2 = [...mineru.batches.values()].slice(b1);
  assert.deepEqual(bs2.map((b) => b.files.length), [6, 2], '分成两组（6 + 2），中途交棒一次');
  assert.equal(mineru.puts.length - put1, 8, '每张图只上传一次');
  pg = await (await fetch(`${origin}/t/${meta.slug}`)).text();
  assert.equal((pg.match(/>Paragraph text from b\d+-\d about habits\./g) || []).length, 8, '8 张图都识别了');
  ok('整页图片 OCR：个别失败不影响其它、全部失败明确报错、超时交棒后继续且不重传');
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

// ---- 超长 base64（几 MB 的单张图）：线性扫描，不能再栈溢出；服务器与浏览器两份实现结果一致 ----
{
  const huge = randomBytes(9 * 1024 * 1024).toString('base64'); // 约 12MB 的 base64
  const src = `<p>x</p><img src="data:image/png;base64,${huge}"><div style="background:url(data:image/jpeg;base64,${huge.slice(0, 4000)})"></div><img src="data:image/gif;base64,AAAA"><img src="data:text/html;base64,${huge.slice(0, 3000)}">`;
  assert.ok(hasBigDataUri(src));
  const client = extractDataUris(src);
  assert.equal(client.assets.length, 2, '12MB 的 png 和 3KB 的 jpeg；小 gif 和非图片类型不拆');
  assert.ok(client.html.includes('__ASSET__/d0.png') && client.html.includes('__ASSET__/d1.jpg') && client.html.includes('data:image/gif;base64,AAAA') && client.html.includes('data:text/html;base64,'));
  // 服务器端的结果应该和浏览器端一致（只是占位换成了真实地址）
  const server = await externalizeDataUris(src, 'slug-x', 'https://o.example');
  assert.equal(server.count, 2);
  assert.equal(server.html, client.html.replace(/__ASSET__\//g, 'https://o.example/api/img/slug-x/'));
  assert.ok((await getBinary('img/slug-x/d0.png')).length === 9 * 1024 * 1024);
  ok('超长 base64（12MB）不再栈溢出，服务器端与浏览器端的拆分结果一致');
}

// 预检 hasBigDataUri：命中即返回，不复制整份网页；语义正确
{
  const b = (n) => 'A'.repeat(n);
  assert.equal(hasBigDataUri(`<img src="data:image/png;base64,${b(2000)}">`), true);
  assert.equal(hasBigDataUri(`<img src="data:image/png;base64,${b(1000)}">`), false, '小于约 1KB 的不算');
  assert.equal(hasBigDataUri(`<a href="data:text/html;base64,${b(5000)}">`), false, '非图片/字体类型不算');
  assert.equal(hasBigDataUri('<p>nothing here</p>'), false);
  assert.equal(hasDataUri, hasBigDataUri, '服务器和浏览器共用同一份实现');
  // 100MB 的网页，大图就在开头：必须几乎立刻返回（不能先把整页扫一遍再拼接）
  const big = `<img src="data:image/png;base64,${b(2000)}">` + 'x'.repeat(100 * 1024 * 1024);
  const t0 = Date.now();
  assert.equal(hasBigDataUri(big), true);
  assert.ok(Date.now() - t0 < 200, '命中即返回：' + (Date.now() - t0) + 'ms');
  // 没有任何替换时原样返回同一个字符串（不复制）
  let visited = 0;
  assert.equal(scanDataUris(`<img src="data:image/png;base64,${b(2000)}">`, () => { visited++; return null; }).length > 0 && visited, 1);
  ok('hasBigDataUri 命中即返回、语义正确；服务器与浏览器共用同一份扫描代码');
}

// ---- 超大 HTML（几百 MB）：浏览器端拆出图片/字体，逐个（分块）上传，再上传精简后的网页 ----
{
  const font = randomBytes(30000), big = randomBytes(5 * 1024 * 1024), img2 = randomBytes(900000);
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Huge SingleFile Page</title><style>@font-face{font-family:H;src:url(data:font/woff2;base64,${font.toString('base64')}) format('woff2')}body{font-family:H,serif}</style></head><body><p>First English paragraph of the huge page for translation.</p><img src="data:image/png;base64,${big.toString('base64')}" alt="big"><p>Another English paragraph about the huge page.</p><img src="data:image/jpeg;base64,${img2.toString('base64')}" alt="small"><img src="data:image/png;base64,${big.toString('base64')}" alt="dup"></body></html>`;
  // 1) 浏览器端拆分
  const { html: slim, assets } = extractDataUris(html);
  assert.equal(assets.length, 3, '字体 + 大图 + 小图，重复的大图只算一份');
  assert.ok(slim.length < 3000 && !slim.includes('base64,') && slim.includes('__ASSET__/d1.png'), '精简后的网页很小：' + slim.length);
  assert.ok(Buffer.from(b64ToBytes(assets[1].b64)).equals(big));
  const id = 'upload-huge0001';
  const H0 = { 'x-admin-password': 'test-pass' };
  // 2) 逐个上传资源（5MB 的大图分成 2 块）
  const manifest = [];
  for (const a of assets) {
    const bytes = b64ToBytes(a.b64);
    const parts = Math.max(1, Math.ceil(bytes.length / (4 * 1024 * 1024)));
    for (let p = 0; p < parts; p++) {
      const r = await fetch(`${origin}/api/upload/asset?id=${id}&name=${a.name}&n=${p}`, { method: 'POST', headers: H0, body: bytes.subarray(p * 4 * 1024 * 1024, (p + 1) * 4 * 1024 * 1024) });
      assert.equal(r.status, 200);
    }
    manifest.push({ name: a.name, parts });
  }
  assert.deepEqual(manifest.map((m) => m.parts), [1, 2, 1]);
  assert.equal((await fetch(`${origin}/api/upload/asset?id=${id}&name=evil.png&n=0`, { method: 'POST', headers: H0, body: 'x' })).status, 400, '资源名必须是 d数字.扩展名');
  // 3) 上传精简后的网页
  assert.equal((await fetch(`${origin}/api/upload/chunk?id=${id}&n=0`, { method: 'POST', headers: H0, body: Buffer.from(slim) })).status, 200);
  assert.equal((await post('/api/upload/start', { uploadId: id, chunks: 1, filename: 'x.html', assets: [{ name: '../x', parts: 1 }] })).status, 400, '非法清单被拒绝');
  process.env.MINERU_API_TOKEN = '';
  res = await post('/api/upload/start', { uploadId: id, chunks: 1, filename: 'Huge.html', translate: true, assets: manifest });
  assert.equal(res.status, 201, await res.clone().text());
  meta = await waitDone((await res.json()).slug);
  process.env.MINERU_API_TOKEN = tokenBackup;
  assert.equal(meta.status, 'done', JSON.stringify(meta));
  const hugePage = await (await fetch(`${origin}/t/${meta.slug}`)).text();
  const hb = `${origin}/api/img/${meta.slug}/`;
  assert.ok(hugePage.includes(`url(${hb}d0.woff2)`) && hugePage.includes(`${hb}d1.png`) && hugePage.includes(`${hb}d2.jpg`) && !hugePage.includes('__ASSET__'), '占位地址已换成本站地址');
  assert.ok(hugePage.includes('[ZH] First English paragraph'), '译文已插入');
  for (const [name, bytes] of [['d0.woff2', font], ['d1.png', big], ['d2.jpg', img2]]) {
    const r = await fetch(hb + name);
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(bytes), name + ' 内容与原文件一致（含分块拼接的 5MB 大图）');
  }
  assert.ok(fs.readdirSync(process.env.LOCAL_STORE_DIR).every((f) => !f.startsWith('pdf%2Fupload-huge0001')), '上传的分块和资源分块都已清理');

  // 资源缺块：报错，并且不留下孤立的图片
  const id2 = 'upload-huge0002';
  await fetch(`${origin}/api/upload/chunk?id=${id2}&n=0`, { method: 'POST', headers: H0, body: Buffer.from(slim.replace('Huge SingleFile Page', 'Huge Missing Page')) });
  await fetch(`${origin}/api/upload/asset?id=${id2}&name=d0.woff2&n=0`, { method: 'POST', headers: H0, body: font });
  const bad = await (await post('/api/upload/start', { uploadId: id2, chunks: 1, filename: 'missing.html', translate: false, assets: [{ name: 'd0.woff2', parts: 1 }, { name: 'd1.png', parts: 2 }] })).json();
  const badDone = await waitDone(bad.slug);
  assert.equal(badDone.status, 'error');
  assert.ok(badDone.error.includes('d1.png') && badDone.error.includes('缺少'), badDone.error);
  assert.ok(fs.readdirSync(process.env.LOCAL_STORE_DIR).every((f) => !f.startsWith(`img%2F${bad.slug}`)), '失败时不留孤立图片');
  assert.equal((await fetch(`${origin}/api/articles/${bad.slug}`, { method: 'DELETE', headers: H })).status, 200);
  assert.equal((await fetch(`${origin}/api/articles/${meta.slug}`, { method: 'DELETE', headers: H })).status, 200);
  ok('超大 HTML：浏览器端拆出图片/字体、5MB 大图分块上传、重复图片去重、占位替换、缺块报错并清理');
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
process.env.TRANSLATE_SAVE_MS = '1'; // 每轮都保存文档，才能看到中间进度
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
process.env.TRANSLATE_SAVE_MS = '';
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
