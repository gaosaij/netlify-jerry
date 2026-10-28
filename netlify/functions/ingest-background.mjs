// 后台导入函数：大网页（几 MB 到几十 MB）在这里抓取、解析、保存，不受同步函数超时限制。
// 流程和同步导入一样：解析 → 检测已有中文 → 整页图片 OCR 或翻译。
import { getJSON, setJSON } from './lib/store.mjs';
import { requireAdmin } from './lib/auth.mjs';
import { validSlug } from './lib/parse.mjs';
import { fetchPage, ingestHtml } from './lib/ingest.mjs';

const LOCK_MS = 10 * 60 * 1000;

export default async (req) => {
  if (requireAdmin(req)) return;
  const { slug } = await req.json();
  if (!validSlug(slug)) return;
  const origin = new URL(req.url).origin;

  const meta = await getJSON(`meta/${slug}`);
  if (!meta || !meta.ingest) return;
  if (meta.lockAt && Date.now() - meta.lockAt < LOCK_MS) return;

  const fail = async (message) => {
    const cur = await getJSON(`meta/${slug}`);
    if (!cur) return; // 导入途中文章被删了
    cur.status = 'error'; cur.error = message; cur.lockAt = 0; cur.updatedAt = Date.now();
    await setJSON(`meta/${slug}`, cur);
  };

  try {
    meta.status = 'importing'; meta.error = ''; meta.lockAt = Date.now(); meta.updatedAt = Date.now();
    await setJSON(`meta/${slug}`, meta);
    const { url, translate, title } = meta.ingest;
    const page = await fetchPage(url, { timeoutMs: 5 * 60 * 1000 });
    if (!page.html) throw new Error('这个网址不是网页');
    await ingestHtml({ origin, html: page.html, finalUrl: page.finalUrl, title, translate, slug });
  } catch (e) {
    await fail(e.message || String(e));
  }
};
