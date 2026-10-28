// 接口：/api/*
//   公开：GET /api/articles、GET /api/articles/:slug（首页和文章页读进度用）
//             GET /api/img/:slug/:文件名（PDF 识别出的图片）
//   需要管理密码：GET /api/status、POST /api/upload、POST /api/import、
//                 POST /api/ocr/chunk、POST /api/ocr/start（PDF 分块上传并交给 MinerU 识别）、
//                 POST /api/articles/:slug/translate、DELETE /api/articles/:slug
import { getJSON, setJSON, setText, getBinary, setBinary, delPrefix, del, listMeta } from './lib/store.mjs';
import { kick } from './lib/kick.mjs';
import { mineruConfig, splitRanges } from './lib/mineru.mjs';
import { json, requireAdmin } from './lib/auth.mjs';
import {
  parseByFormat, blocksFromClient, makeSlug, validSlug,
} from './lib/parse.mjs';
import { config as translateConfig } from './lib/translate.mjs';
import { fetchPage, ingestHtml, saveBilingual, saveRaw, syncLimit, MAX_UPLOAD_HTML_BYTES } from './lib/ingest.mjs';
import { ASSET_TYPES } from './lib/assets.mjs';

// 公开列表里只给必要字段
const publicMeta = (m) => ({
  slug: m.slug, title: m.title, kind: m.kind, status: m.status, total: m.total, done: m.done,
  note: m.note, origPath: m.origPath, layout: m.layout, ocrDone: m.ocrDone, ocrTotal: m.ocrTotal, stage: m.ingest ? 'import' : m.ocr && !m.ocr.finished ? 'ocr' : '', createdAt: m.createdAt, updatedAt: m.updatedAt, error: m.error,
});


// PDF：交给 MinerU 识别（后台函数 ocr-background），识别完自动翻译。
// url 模式让 MinerU 自己去下载；upload 模式使用浏览器分块上传的 PDF（uploadId + chunks）
async function createOcrArticle({ origin, title, url, uploadId, chunks, filename, pages, translate }) {
  if (!mineruConfig().token) {
    throw Object.assign(new Error('处理 PDF 需要配置 MINERU_API_TOKEN（也可以取消勾选“用 MinerU 识别”，改用浏览器本地提取文字）'), { status: 503 });
  }
  if (url) {
    const dup = (await listMeta()).find((m) => m.sourceUrl === url);
    if (dup) throw Object.assign(new Error(`这个网址已经搬运过：${dup.title}`), { status: 409, slug: dup.slug });
  }
  const base = (filename || 'document.pdf').replace(/\.pdf$/i, '');
  const ranges = splitRanges(pages);
  const now = Date.now();
  const given = (title || '').trim();
  const meta = {
    slug: makeSlug(given || base || 'pdf'), title: given || base || '未命名 PDF', titleAuto: !given,
    kind: 'bilingual', source: 'pdf', sourceUrl: url, status: 'ocr', total: 0, done: 0,
    ocrDone: 0, ocrTotal: pages || 0, createdAt: now, updatedAt: now,
    ocr: {
      mode: url ? 'url' : 'upload', url, uploadId, chunks, translate, pages: pages || 0,
      jobs: ranges.map((range, i) => ({
        range, state: 'pending', name: range ? `${base}-p${range}.pdf` : `${base}.pdf`, index: i,
      })),
    },
  };
  await setJSON(`doc/${meta.slug}`, { blocks: [] });
  await setJSON(`meta/${meta.slug}`, meta);
  try { await kick(origin, 'ocr-background', meta.slug); } catch (e) {
    meta.status = 'error'; meta.error = e.message; await setJSON(`meta/${meta.slug}`, meta);
  }
  return meta;
}

async function route(req, path) {
  const origin = new URL(req.url).origin;
  const [a, slug, action] = path;

  // ---- 公开接口 ----
  if (req.method === 'GET' && a === 'articles' && !slug) {
    return json((await listMeta()).map(publicMeta));
  }
  if (req.method === 'GET' && a === 'articles' && validSlug(slug) && !action) {
    const meta = await getJSON(`meta/${slug}`);
    return meta ? json(publicMeta(meta)) : json({ error: '文章不存在' }, 404);
  }

  if (req.method === 'GET' && a === 'img' && validSlug(slug) && /^[\w.-]+$/.test(path[2] || '')) {
    const data = await getBinary(`img/${slug}/${path[2]}`);
    if (!data) return json({ error: '图片不存在' }, 404);
    const ext = path[2].split('.').pop().toLowerCase();
    return new Response(data, { headers: {
      'content-type': ASSET_TYPES[ext] || 'application/octet-stream',
      'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff',
      // SVG 里可能带脚本：直接打开时不让它执行（作为 <img> 或 CSS 背景使用不受影响）
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    } });
  }

  // ---- 管理接口 ----
  const denied = requireAdmin(req);
  if (denied) return denied;

  if (req.method === 'GET' && a === 'status') {
    const c = translateConfig();
    return json({ hasKey: !!c.key, base: c.base, model: c.model, hasMineru: !!mineruConfig().token, mineruModel: mineruConfig().model });
  }

  // 分块上传（PDF、大 HTML 都用）：浏览器每次发一块（≤4MB，二进制），全部传完再调用 /api/ocr/start（PDF）或 /api/upload/start（HTML）
  if (req.method === 'POST' && (a === 'ocr' || a === 'upload') && slug === 'chunk') {
    const q = new URL(req.url).searchParams;
    const id = q.get('id') || '';
    const n = Number(q.get('n'));
    if (!/^[a-z0-9-]{8,64}$/.test(id) || !Number.isInteger(n) || n < 0 || n >= 100) return json({ error: '分块参数不正确' }, 400);
    const data = Buffer.from(await req.arrayBuffer());
    if (!data.length) return json({ error: '分块为空' }, 400);
    await setBinary(`pdf/${id}/${n}`, data);
    return json({ ok: true });
  }
  if (req.method === 'POST' && a === 'ocr' && slug === 'start') {
    const { uploadId = '', chunks = 0, filename = 'document.pdf', title = '', pages = 0, translate = true } = await req.json();
    if (!/^[a-z0-9-]{8,64}$/.test(uploadId) || !Number.isInteger(chunks) || chunks < 1 || chunks > 100) return json({ error: '参数不正确' }, 400);
    if (!(await getBinary(`pdf/${uploadId}/${chunks - 1}`))) return json({ error: 'PDF 还没有上传完整' }, 400);
    const meta = await createOcrArticle({ origin, title, uploadId, chunks, filename, pages: Number(pages) || 0, translate });
    return json(publicMeta(meta), 201);
  }

  if (req.method === 'POST' && a === 'upload' && slug === 'start') {
    // 大 HTML（如 SingleFile 保存的网页）：分块传完后建一个占位，交给后台函数拼接、拆出内联图片、解析、翻译
    const { uploadId = '', chunks = 0, filename = 'page.html', title = '', translate = true } = await req.json();
    if (!/^[a-z0-9-]{8,64}$/.test(uploadId) || !Number.isInteger(chunks) || chunks < 1 || chunks > Math.ceil(MAX_UPLOAD_HTML_BYTES / (4 * 1024 * 1024))) {
      return json({ error: `参数不正确，或文件超过 ${Math.round(MAX_UPLOAD_HTML_BYTES / 1048576)}MB` }, 400);
    }
    if (!(await getBinary(`pdf/${uploadId}/${chunks - 1}`))) return json({ error: '文件还没有上传完整' }, 400);
    const name = filename.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ');
    const now = Date.now();
    const meta = {
      slug: makeSlug(title.trim() || name), kind: 'bilingual', source: 'upload', title: title.trim() || name,
      status: 'importing', total: 0, done: 0, createdAt: now, updatedAt: now,
      ingest: { mode: 'upload', uploadId, chunks, filename, translate, title },
    };
    await setJSON(`doc/${meta.slug}`, { blocks: [] });
    await setJSON(`meta/${meta.slug}`, meta);
    try { await kick(origin, 'ingest-background', meta.slug); } catch (e) {
      meta.status = 'error'; meta.error = e.message; await setJSON(`meta/${meta.slug}`, meta);
    }
    return json(publicMeta(meta), 201);
  }

  if (req.method === 'POST' && a === 'upload') {
    const { filename = 'article.txt', content = '', blocks: clientBlocks, title = '', translate = true } = await req.json();
    // blocks：浏览器端已经分好段（如 PDF）；否则按文件内容解析
    if (!clientBlocks && !String(content).trim()) return json({ error: '内容为空' }, 400);
    const name = filename.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ');
    if (!clientBlocks && (/\.html?$/i.test(filename) || /^\s*(<!doctype html|<html|<\?xml)/i.test(content))) {
      const meta = await ingestHtml({ origin, html: String(content), title: title.trim() || name, translate, source: 'upload' });
      return json(publicMeta(meta), 201);
    }
    const parsed = clientBlocks ? { title: '', blocks: blocksFromClient(clientBlocks) } : parseByFormat(filename, String(content));
    const meta = await saveBilingual({ origin, title: title.trim() || parsed.title || name, blocks: parsed.blocks, source: 'upload', translate });
    return json(publicMeta(meta), 201);
  }

  if (req.method === 'POST' && a === 'import') {
    const body = await req.json();
    const { url, translate = true, title: givenTitle = '' } = body;
    const origPath = /^\/[^\s]{0,500}$/.test(body.origPath || '') ? body.origPath : ''; // 站内文章的原路径（管理页指定）
    const page = await fetchPage(url, { syncLimit: syncLimit() });
    if (page.pdf) {
      const meta = await createOcrArticle({ origin, title: givenTitle, url: page.finalUrl, translate, filename: decodeURIComponent(new URL(page.finalUrl).pathname.split('/').pop() || 'document.pdf') });
      return json(publicMeta(meta), 201);
    }
    if (page.large) {
      // 网页很大（如几百页的备案文件）：同步函数处理不完，先建一个占位，交给后台函数抓取和解析
      const dup = (await listMeta()).find((m) => m.sourceUrl === page.finalUrl);
      if (dup) return json({ error: `这个网址已经搬运过：${dup.title}`, slug: dup.slug }, 409);
      const now = Date.now();
      const meta = {
        slug: makeSlug(givenTitle || new URL(page.finalUrl).hostname), kind: 'bilingual', source: 'import', sourceUrl: page.finalUrl,
        title: givenTitle.trim() || page.finalUrl, status: 'importing', total: 0, done: 0, createdAt: now, updatedAt: now,
        ingest: { url: page.finalUrl, translate, title: givenTitle, origPath },
      };
      await setJSON(`doc/${meta.slug}`, { blocks: [] });
      await setJSON(`meta/${meta.slug}`, meta);
      try { await kick(origin, 'ingest-background', meta.slug); } catch (e) {
        meta.status = 'error'; meta.error = e.message; await setJSON(`meta/${meta.slug}`, meta);
      }
      return json(publicMeta(meta), 201);
    }
    if (!translate) {
      const meta = await saveRaw({ html: page.html, finalUrl: page.finalUrl, title: givenTitle });
      return json(publicMeta(meta), 201);
    }
    const meta = await ingestHtml({ origin, html: page.html, finalUrl: page.finalUrl, title: givenTitle, translate: true, origPath });
    return json(publicMeta(meta), 201);
  }

  if (a === 'articles' && validSlug(slug)) {
    const meta = await getJSON(`meta/${slug}`);
    if (!meta) return json({ error: '文章不存在' }, 404);

    if (req.method === 'POST' && action === 'translate') {
      if (meta.kind !== 'bilingual') return json({ error: '这篇是仅搬运的网页，不能翻译' }, 400);
      if (meta.ingest) {
        // 还在抓取解析阶段出错：重新抓取
        meta.status = 'importing'; meta.error = ''; meta.lockAt = 0; meta.updatedAt = Date.now();
        await setJSON(`meta/${slug}`, meta);
        await kick(origin, 'ingest-background', slug);
        return json(publicMeta(meta));
      }
      if (meta.ocr && !meta.ocr.finished) {
        // 还在 OCR 阶段（识别中断或出错）：继续识别，识别完会自动翻译
        if (!mineruConfig().token) return json({ error: '尚未配置 MINERU_API_TOKEN' }, 503);
        meta.status = 'ocr'; meta.error = ''; meta.lockAt = 0; meta.updatedAt = Date.now();
        await setJSON(`meta/${slug}`, meta);
        await kick(origin, 'ocr-background', slug);
        return json(publicMeta(meta));
      }
      if (!translateConfig().key) return json({ error: '尚未配置 OPENAI_API_KEY' }, 503);
      meta.status = 'queued'; meta.error = ''; meta.lockAt = 0; meta.updatedAt = Date.now();
      await setJSON(`meta/${slug}`, meta);
      await kick(origin, 'translate-background', slug);
      return json(publicMeta(meta));
    }
    if (req.method === 'DELETE' && !action) {
      await Promise.all([
        del(`meta/${slug}`), del(`doc/${slug}`), del(`html/${slug}`), delPrefix(`img/${slug}/`), delPrefix(`tbl/${slug}/`),
        meta.ocr && meta.ocr.uploadId ? delPrefix(`pdf/${meta.ocr.uploadId}/`) : null,
        meta.ingest && meta.ingest.uploadId ? delPrefix(`pdf/${meta.ingest.uploadId}/`) : null,
      ]);
      return json({ ok: true });
    }
  }
  return json({ error: '接口不存在' }, 404);
}

export default async (req) => {
  const path = new URL(req.url).pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  try {
    return await route(req, path);
  } catch (e) {
    return json({ error: e.message || String(e), slug: e.slug }, e.status || 500);
  }
};

export const config = { path: '/api/*' };
