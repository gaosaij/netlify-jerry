// 后台导入函数：大网页（几 MB 到几十 MB）在这里抓取、解析、保存，不受同步函数超时限制；
// 也处理浏览器分块上传的大 HTML 文件（如 SingleFile 保存的网页）。
// 流程和同步导入一样：解析 → 检测已有中文 → 整页图片 OCR 或翻译。
import { getJSON, setJSON, getBinary, setBinary, delPrefix } from './lib/store.mjs';
import { requireAdmin } from './lib/auth.mjs';
import { validSlug, decodeBody } from './lib/parse.mjs';
import { fetchPage, ingestHtml, saveRaw } from './lib/ingest.mjs';
import { INGEST_LOCK_MS, isLocked, startHeartbeat, touchLock } from './lib/runtime.mjs';


export default async (req) => {
  if (requireAdmin(req)) return;
  const { slug } = await req.json();
  if (!validSlug(slug)) return;
  const origin = new URL(req.url).origin;

  const meta = await getJSON(`meta/${slug}`);
  if (!meta || !meta.ingest) return;
  if (isLocked(meta, INGEST_LOCK_MS)) return;

  const fail = async (message) => {
    const cur = await getJSON(`meta/${slug}`);
    if (!cur) return; // 导入途中文章被删了
    cur.status = 'error'; cur.error = message; cur.lockAt = 0; cur.updatedAt = Date.now();
    await setJSON(`meta/${slug}`, cur);
    if (cur.ingest && cur.ingest.mode === 'upload') await delPrefix(`img/${slug}/`); // 失败时不留孤立的图片（重试会重新生成）
  };

  let stopBeat = () => {};
  try {
    meta.status = 'importing'; meta.error = ''; meta.lockAt = Date.now(); meta.updatedAt = Date.now();
    await setJSON(`meta/${slug}`, meta);
    stopBeat = startHeartbeat(() => touchLock(slug, meta));
    const { url, translate, title, mode, uploadId, chunks, origPath, assets = [] } = meta.ingest;
    let page;
    if (mode === 'upload') {
      // 浏览器分块上传的 HTML：把分块拼起来
      const parts = [];
      for (let i = 0; i < chunks; i++) {
        const part = await getBinary(`pdf/${uploadId}/${i}`);
        if (!part) throw new Error(`上传的文件缺少第 ${i + 1} 块，请重新上传`);
        parts.push(part);
      }
      let html = decodeBody(Buffer.concat(parts), '');
      // 浏览器已经拆出来单独上传的图片/字体：组装起来存好，网页里的占位地址换成本站地址
      const known = new Set();
      for (const a of assets) {
        const pieces = [];
        for (let n = 0; n < a.parts; n++) {
          const piece = await getBinary(`pdf/${uploadId}/asset/${a.name}/${n}`);
          if (!piece) throw new Error(`上传的图片 ${a.name} 缺少第 ${n + 1} 块，请重新上传`);
          pieces.push(piece);
        }
        await setBinary(`img/${slug}/${a.name}`, Buffer.concat(pieces));
        known.add(a.name);
      }
      if (known.size) html = html.replace(/__ASSET__\/(d\d{1,5}\.[a-z0-9]{2,5})/g, (m, name) => (known.has(name) ? `${origin}/api/img/${slug}/${name}` : m));
      page = { html, finalUrl: undefined };
    } else {
      page = await fetchPage(url, { timeoutMs: 5 * 60 * 1000 });
      if (!page.html) throw new Error('这个网址不是网页');
    }
    if (mode !== 'upload' && translate === false) {
      // 选的是“仅搬运”：只保存网页，不解析、不 OCR、不翻译
      await saveRaw({ slug, html: page.html, finalUrl: page.finalUrl, title });
    } else {
      await ingestHtml({ origin, html: page.html, finalUrl: page.finalUrl, title, translate, slug, source: mode === 'upload' ? 'upload' : 'import', origPath });
    }
    if (mode === 'upload') await delPrefix(`pdf/${uploadId}/`); // 处理完成，分块不再需要
  } catch (e) {
    stopBeat();
    await fail(e.message || String(e));
  } finally {
    stopBeat();
  }
};
