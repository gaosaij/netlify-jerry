// 本地模拟环境（不依赖 Netlify）：把 /api、/t、后台翻译函数路由到真实的处理函数，
// 并提供一个假的 OpenAI 接口、一个供“搬运”用的样例网页。仅用于测试，不会被部署。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import { samplePositionedHtml } from './make-positioned.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function startDevServer({ port = 0, mockLlm = true } = {}) {
  process.env.LOCAL_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
  process.env.ADMIN_PASSWORD = 'test-pass';
  // 假的 MinerU：任务经过 pending → running → done 三次轮询；记录收到的请求供测试检查
  const mineru = { tasks: new Map(), batches: new Map(), n: 0, puts: [], lastAuth: '' };
  const zipFor = (key) => zipSync({
    'full.md': strToU8(`# Doc ${key}\n\nParagraph text from ${key} about habits.\n\n![](images/img-${key}.jpg)\n\n<table><tr><td onclick="x()">cell value</td></tr></table>\n\n$$\nE=mc^2\n$$\n`),
    [`images/img-${key}.jpg`]: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]),
    'layout.json': strToU8('{}'),
  });
  const stats = { imageUAs: [], llmCalls: 0, mismatchOnce: false, rateLimitOnce: false, delayMs: 0 };

  const api = (await import('../netlify/functions/api.mjs')).default;
  const page = (await import('../netlify/functions/page.mjs')).default;
  const bg = (await import('../netlify/functions/translate-background.mjs')).default;
  const ocr = (await import('../netlify/functions/ocr-background.mjs')).default;
  const ingest = (await import('../netlify/functions/ingest-background.mjs')).default;

  const sampleEn = `<html><head><title>Sample Article About Habits</title><style>p{color:red}</style></head><body>
    <nav>menu</nav><article><h1>Sample Article About Habits</h1>
    <p>Habits are formed through repetition. Small actions repeated daily compound into large results.</p>
    <p>The second paragraph explains why environment matters more than willpower.</p>
    <ul><li>Make it obvious</li><li>Make it easy</li></ul>
    <pre>const x = 1;</pre>
    <p>Finally, track your progress &amp; reflect weekly.</p></article>
    <script>alert(1)</script></body></html>`;
  const sampleDual = `<html><head><title>已有翻译</title></head><body><article>
    <p>Habits are formed through repetition and practice.</p><p>习惯是通过重复和练习养成的。</p>
    <p>Environment matters more than willpower in most cases.</p><p>在大多数情况下，环境比意志力更重要。</p>
    <p>Track your progress every single week.</p><p>每周都要记录你的进展。</p></article></body></html>`;

  const server = http.createServer(async (nodeReq, nodeRes) => {
    const chunks = [];
    for await (const c of nodeReq) chunks.push(c);
    const body = Buffer.concat(chunks);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const url = new URL(nodeReq.url, origin);
    const send = async (res) => {
      nodeRes.writeHead(res.status, Object.fromEntries(res.headers));
      nodeRes.end(Buffer.from(await res.arrayBuffer()));
    };
    const mkReq = () => new Request(url, {
      method: nodeReq.method,
      headers: nodeReq.headers,
      body: ['GET', 'HEAD'].includes(nodeReq.method) ? undefined : body,
    });
    const text = (s, type = 'text/html; charset=utf-8', status = 200) => {
      nodeRes.writeHead(status, { 'content-type': type });
      nodeRes.end(s);
    };

    if (url.pathname.startsWith('/api/')) return send(await api(mkReq()));
    if (url.pathname.startsWith('/t/')) return send(await page(mkReq()));
    if (url.pathname === '/.netlify/functions/translate-background') {
      bg(mkReq()).catch((e) => console.error('后台函数异常', e)); // 不等待，立刻 202
      return text('', 'text/plain', 202);
    }
    if (url.pathname === '/.netlify/functions/ingest-background') {
      ingest(mkReq()).catch((e) => console.error('导入后台函数异常', e));
      return text('', 'text/plain', 202);
    }
    if (url.pathname === '/.netlify/functions/ocr-background') {
      ocr(mkReq()).catch((e) => console.error('OCR 后台函数异常', e));
      return text('', 'text/plain', 202);
    }
    if (url.pathname === '/sample/paper.pdf') { nodeRes.writeHead(200, { 'content-type': 'application/pdf' }); return nodeRes.end('%PDF-1.4 fake'); }
    if (url.pathname === '/sample/en') return text(sampleEn);
    if (url.pathname === '/sample/s1.htm') return text(samplePositionedHtml());
    if (url.pathname === '/sample/s1b.htm') return text(samplePositionedHtml().replace(/Filler paragraph/g, 'Variant paragraph').replace('Sample Company S-1', 'Sample Company S-1 Big'));
    // 多张整页图片的测试页：pgN.jpg 正常，pg-missing.jpg 返回 404
    if (url.pathname === '/sample/multi.htm') {
      const names = (url.searchParams.get('imgs') || '').split(',').filter(Boolean);
      const tag = url.searchParams.get('tag') || 'M';
      return text(samplePositionedHtml(names).replace(/Filler paragraph/g, `${tag} paragraph`).replace('Sample Company S-1', `Sample Company S-1 ${tag}`));
    }
    if (url.pathname === '/sample/pg-missing.jpg') return text('nope', 'text/plain', 404);
    if (/^\/sample\/pg\d+a\.jpg$/.test(url.pathname) || url.pathname === '/sample/pg1a.jpg' || url.pathname === '/sample/chart2a.jpg') {
      stats.imageUAs.push(nodeReq.headers['user-agent']);
      nodeRes.writeHead(200, { 'content-type': 'image/jpeg' });
      return nodeRes.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    }
    // 模拟 SEC：User-Agent 里没有联系邮箱就拒绝
    if (url.pathname === '/sample/sec-blocked.htm') {
      if (!/@/.test(nodeReq.headers['user-agent'] || '')) return text('<html><title>Undeclared Automated Tool</title></html>', 'text/html', 403);
      return text(sampleEn.replace('Habits are formed through repetition', 'Markets are formed through repetition'));
    }
    // 模拟 Netlify 的 pretty URLs：.html 地址 301 跳转成小写、无后缀的地址
    if (url.pathname === '/articles-sim/Static_Article.html') {
      nodeRes.writeHead(301, { location: '/articles-sim/static_article' });
      return nodeRes.end();
    }
    if (url.pathname === '/articles-sim/static_article') return text(sampleEn.replace('Habits are formed through repetition', 'Redirects are followed correctly'));
    if (url.pathname === '/sample/en4') return text(sampleEn.replace('Habits are formed through repetition', 'Toggles are tested through repetition'));
    if (url.pathname === '/sample/en2') return text(sampleEn.replace('Habits are formed through repetition', 'Sleep is restored through rest'));
    if (url.pathname === '/sample/dual') return text(sampleDual);
    if (url.pathname === '/sample/notfound') return text('nope', 'text/plain', 404);
    if (url.pathname === '/sample/sample.pdf') return text(fs.readFileSync(path.join(root, 'tests/sample.pdf')), 'application/pdf');
    if (url.pathname === '/admin/pdf-layout.js') return text(fs.readFileSync(path.join(root, 'netlify/functions/lib/pdf-layout.cjs')), 'text/javascript');
    if (url.pathname === '/admin/pdf-extract.js') return text(fs.readFileSync(path.join(root, 'admin/pdf-extract.js')), 'text/javascript');
    // 其余静态文件来自 node build.js 生成的 dist/（没构建就只有管理页）
    const dist = path.join(root, 'dist');
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(dist, rel);
    if (file.startsWith(dist) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const types = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript' };
      return text(fs.readFileSync(file), types[path.extname(file)] || 'application/octet-stream');
    }
    if (url.pathname === '/admin/' || url.pathname === '/admin') return text(fs.readFileSync(path.join(root, 'admin/index.html')));

    // 假的 MinerU（/mineru/...）
    if (url.pathname.startsWith('/mineru/')) {
      const j = (data, status = 200) => text(JSON.stringify(data), 'application/json', status);
      const m = url.pathname.slice('/mineru'.length);
      if (m.startsWith('/put/')) { mineru.puts.push({ path: m, bytes: body.length }); return text('', 'text/plain', 200); }
      if (m.startsWith('/zip/')) {
        nodeRes.writeHead(200, { 'content-type': 'application/zip' });
        return nodeRes.end(Buffer.from(zipFor(decodeURIComponent(m.slice(5)))));
      }
      mineru.lastAuth = nodeReq.headers.authorization || '';
      if (mineru.lastAuth !== 'Bearer mtoken') return j({ code: 'A0202', msg: 'Token 错误' }, 401);
      const req0 = body.length ? JSON.parse(body) : {};
      if (m === '/extract/task' && nodeReq.method === 'POST') {
        if (String(req0.url).includes('toolong')) return j({ code: -60006, msg: '文件页数超过限制' });
        const id = 't' + ++mineru.n;
        mineru.tasks.set(id, { polls: 0, body: req0, fail: String(req0.url).includes('failme') });
        return j({ code: 0, data: { task_id: id }, msg: 'ok' });
      }
      let mm;
      if ((mm = m.match(/^\/extract\/task\/(\w+)$/))) {
        const t = mineru.tasks.get(mm[1]);
        t.polls++;
        if (t.fail && t.polls > 1) return j({ code: 0, data: { state: 'failed', err_msg: '文件损坏' } });
        if (t.polls === 1) return j({ code: 0, data: { state: 'pending' } });
        if (t.polls === 2) return j({ code: 0, data: { state: 'running', extract_progress: { extracted_pages: 3, total_pages: 10 } } });
        return j({ code: 0, data: { state: 'done', full_zip_url: `${origin}/mineru/zip/${mm[1]}`, extract_progress: { extracted_pages: 10, total_pages: 10 } } });
      }
      if (m === '/file-urls/batch') {
        const id = 'b' + ++mineru.n;
        mineru.batches.set(id, { files: req0.files, polls: 0, body: req0 });
        return j({ code: 0, data: { batch_id: id, file_urls: req0.files.map((f, i) => `${origin}/mineru/put/${id}/${i}`) } });
      }
      if ((mm = m.match(/^\/extract-results\/batch\/(\w+)$/))) {
        const b = mineru.batches.get(mm[1]);
        b.polls++;
        const uploaded = mineru.puts.filter((p) => p.path.startsWith(`/put/${mm[1]}/`)).length;
        return j({ code: 0, data: { batch_id: mm[1], extract_result: b.files.map((f, i) => (
          uploaded < b.files.length ? { file_name: f.name, state: 'waiting-file' }
            : b.polls < 2 ? { file_name: f.name, state: 'running', extract_progress: { extracted_pages: 2, total_pages: 200 } }
              : { file_name: f.name, state: 'done', full_zip_url: `${origin}/mineru/zip/${mm[1]}-${i}`, extract_progress: { extracted_pages: 200, total_pages: 200 } })) } });
      }
      return j({ code: -1, msg: 'unknown' }, 404);
    }

    // 假的 OpenAI 接口
    if (mockLlm && url.pathname === '/v1/chat/completions') {
      stats.llmCalls++;
      if (stats.delayMs) await new Promise((r) => setTimeout(r, stats.delayMs));
      if (stats.rateLimitOnce) { stats.rateLimitOnce = false; return text('{"error":"rate"}', 'application/json', 429); }
      const user = JSON.parse(body).messages[1].content;
      const parts = [...user.matchAll(/<<<(\d+)>>>\n([\s\S]*?)(?=\n\n<<<\d+>>>|$)/g)];
      let out = parts.map((m) => `<<<${m[1]}>>>\n[ZH] ${m[2]}`);
      if (stats.mismatchOnce && parts.length > 1) { stats.mismatchOnce = false; out = out.slice(0, -1); }
      return text(JSON.stringify({ choices: [{ message: { content: out.join('\n\n') } }] }), 'application/json');
    }
    text('not found', 'text/plain', 404);
  });

  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.OPENAI_BASE_URL = `${origin}/v1`;
  process.env.OPENAI_MODEL = 'mock';
  process.env.MINERU_BASE_URL = `${origin}/mineru`;
  process.env.MINERU_API_TOKEN = 'mtoken';
  process.env.OCR_POLL_MS = '30';
  return { origin, stats, mineru, close: () => server.close() };
}

// 直接运行：启动一个可在浏览器里查看的本地环境
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { origin } = await startDevServer({ port: 8790 });
  console.log(`本地模拟环境：${origin}/admin/  （管理密码 test-pass）`);
}
