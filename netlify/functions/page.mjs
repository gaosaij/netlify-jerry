// 文章页：/t/<文章名>
//   bilingual：从存储读取分段，实时渲染中英对照页（翻译到哪就显示到哪）
//   bilingual + layout=page：保留原网页样式，每段原文后面插入同样式的译文
//   bilingual + layout=doc：PDF 转 HTML 的文档版式（每页一张卡片，原字体样式，原表格 + 中文对照表）
//   raw：直接输出搬运来的原网页（带 CSP 禁止脚本）
import { randomBytes } from 'node:crypto';
import { getJSON, getText } from './lib/store.mjs';
import { renderPage, renderStyledPage, renderDocPage, docView, esc } from './lib/render.mjs';
import { validSlug } from './lib/parse.mjs';

// 超过 4MB 的页面用流式响应输出（Netlify 普通响应上限 6MB，流式可到 20MB）
const streamed = (text) => {
  const bytes = Buffer.from(text);
  return new ReadableStream({
    start(ctrl) {
      for (let i = 0; i < bytes.length; i += 262144) ctrl.enqueue(bytes.subarray(i, i + 262144));
      ctrl.close();
    },
  });
};
const html = (body, status, headers = {}) =>
  new Response(typeof body === 'string' && body.length > 4 * 1024 * 1024 ? streamed(body) : body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

export default async (req) => {
  const slug = decodeURIComponent(new URL(req.url).pathname.replace(/^\/t\/?/, '').replace(/\/$/, ''));
  const notFound = () =>
    html(`<!DOCTYPE html><meta charset="utf-8"><title>文章不存在</title><p style="font:16px sans-serif;padding:40px">文章不存在：${esc(slug)}　<a href="/">返回文章列表</a></p>`, 404);
  if (!validSlug(slug)) return notFound();

  const meta = await getJSON(`meta/${slug}`);
  if (!meta) return notFound();

  if (meta.kind === 'raw') {
    const page = await getText(`html/${slug}`);
    if (page == null) return notFound();
    return html(page, 200, { 'content-security-policy': "script-src 'none'; object-src 'none'" });
  }

  const doc = await getJSON(`doc/${slug}`);
  if (!doc) return notFound();
  const nonce = randomBytes(12).toString('base64');
  if (meta.layout === 'doc') {
    // PDF 转 HTML 的文档版式：只读取当前这一屏用到的表格
    const viewNo = Number(new URL(req.url).searchParams.get('p')) || 1;
    const { keys } = docView(doc.blocks, viewNo);
    const tables = new Map();
    await Promise.all(keys.map(async (k) => { const raw = await getText(`tbl/${slug}/${k}`); if (raw != null) tables.set(k, raw); }));
    return html(renderDocPage(meta, doc, tables, nonce, viewNo), 200, {
      'content-security-policy': `default-src 'none'; img-src https: data: 'self'; style-src 'unsafe-inline'; font-src https: data:; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'`,
    });
  }
  if (meta.layout === 'page') {
    // 保留原网页样式的对照页：原网页 + 每段后面插入译文
    const original = await getText(`html/${slug}`);
    if (original == null) return notFound();
    return html(renderStyledPage(meta, doc, original, nonce), 200, {
      'content-security-policy': `script-src 'nonce-${nonce}'; object-src 'none'`,
    });
  }
  const pageNo = Number(new URL(req.url).searchParams.get('p')) || 1;
  return html(renderPage(meta, doc, nonce, pageNo), 200, {
    'content-security-policy': `default-src 'none'; img-src https: data: 'self'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'`,
  });
};

export const config = { path: '/t/*' };
