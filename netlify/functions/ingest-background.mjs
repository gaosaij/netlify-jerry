// 后台导入函数：大网页（几 MB 到几十 MB）在这里抓取、解析、保存，不受同步函数超时限制；
// 也处理浏览器分块上传的大 HTML 文件（如 SingleFile 保存的网页）。
// 流程和同步导入一样：解析 → 检测已有中文 → 整页图片 OCR 或翻译。
import { getJSON, setJSON, getBinary, delPrefix } from './lib/store.mjs';
import { requireAdmin } from './lib/auth.mjs';
import { validSlug, decodeBody } from './lib/parse.mjs';
import { fetchPage, ingestHtml, saveRaw } from './lib/ingest.mjs';

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
    const { url, translate, title, mode, uploadId, chunks } = meta.ingest;
    let page;
    if (mode === 'upload') {
      // 浏览器分块上传的 HTML：把分块拼起来
      const parts = [];
      for (let i = 0; i < chunks; i++) {
        const part = await getBinary(`pdf/${uploadId}/${i}`);
        if (!part) throw new Error(`上传的文件缺少第 ${i + 1} 块，请重新上传`);
        parts.push(part);
      }
      page = { html: decodeBody(Buffer.concat(parts), ''), finalUrl: undefined };
    } else {
      page = await fetchPage(url, { timeoutMs: 5 * 60 * 1000 });
      if (!page.html) throw new Error('这个网址不是网页');
    }
    if (mode !== 'upload' && translate === false) {
      // 选的是“仅搬运”：只保存网页，不解析、不 OCR、不翻译
      await saveRaw({ slug, html: page.html, finalUrl: page.finalUrl, title });
    } else {
      await ingestHtml({ origin, html: page.html, finalUrl: page.finalUrl, title, translate, slug, source: mode === 'upload' ? 'upload' : 'import' });
    }
    if (mode === 'upload') await delPrefix(`pdf/${uploadId}/`); // 处理完成，分块不再需要
  } catch (e) {
    await fail(e.message || String(e));
  }
};
