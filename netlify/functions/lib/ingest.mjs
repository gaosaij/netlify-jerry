// 把抓取到（或上传的）HTML 变成一篇待翻译的文章：解析 → 检测已有中文/重复 → 保存 → 整页图片 OCR 或直接翻译
import { getJSON, setJSON, setText, delPrefix, listMeta } from './store.mjs';
import { kick } from './kick.mjs';
import {
  parseHtml, analyze, contentHash, makeSlug, decodeBody, sanitizeRawHtml, BACK_LINK,
} from './parse.mjs';
import { looksPositioned, parsePositioned } from './positioned.mjs';
import { config as translateConfig, autoTranslateMaxChars, pendingChars } from './translate.mjs';
import { mineruConfig } from './mineru.mjs';
import { externalizeDataUris, hasBigDataUri, singleFileUrl } from './assets.mjs';

export const syncLimit = () => Number(process.env.SYNC_LIMIT_BYTES) || 3 * 1024 * 1024;        // 超过这个大小的网页交给后台函数处理（同步函数有超时限制）
export const MAX_IMPORT_BYTES = 40 * 1024 * 1024;
const PAGE_LAYOUT_MAX = 8 * 1024 * 1024;           // 太大的网页不保留原样式，改用通用对照排版（输出时超过 4MB 会走流式响应，上限 20MB）
export const MAX_UPLOAD_HTML_BYTES = 80 * 1024 * 1024; // 分块上传的 HTML 文件上限（SingleFile 保存的网页内联了图片，体积很大）
const MAX_OCR_IMAGES = 80;
export const MAX_RAW_BYTES = 18 * 1024 * 1024; // “仅搬运”的网页上限：输出时走流式响应，最大 20MB

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// 抓取网页和图片时的请求头。有些网站（如 SEC）要求 User-Agent 里写明身份和联系邮箱，可用环境变量 FETCH_USER_AGENT 设置
export const fetchHeaders = (accept = 'text/html,application/xhtml+xml') => ({
  'user-agent': process.env.FETCH_USER_AGENT || BROWSER_UA,
  accept,
  'accept-language': 'en-US,en;q=0.9',
});

export function blockedHint(url, status) {
  if (status === 403 && /(^|\.)sec\.gov$/i.test(new URL(url).hostname)) {
    return '（SEC 要求 User-Agent 里带上联系方式：请在 Netlify 环境变量里设置 FETCH_USER_AGENT，例如 “你的名字 你的邮箱”，然后重新部署）';
  }
  return '';
}

const httpError = (message, status) => Object.assign(new Error(message), { status });

// 抓取网页。syncLimit：读到超过这个大小就放弃并返回 { large: true }，让调用方改走后台处理
export async function fetchPage(url, { syncLimit = 0, timeoutMs = 25000 } = {}) {
  let u;
  try { u = new URL(url); } catch { throw httpError('网址格式不正确', 400); }
  if (!/^https?:$/.test(u.protocol)) throw httpError('只支持 http / https 网址', 400);
  const res = await fetch(u, { redirect: 'follow', headers: fetchHeaders(), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw httpError(`抓取失败：对方网站返回 ${res.status}${blockedHint(u.href, res.status)}`, 502);
  const type = res.headers.get('content-type') || '';
  const finalUrl = res.url || u.href;
  if (/pdf/i.test(type)) {
    await res.body?.cancel(); // PDF 不在这里下载，交给 MinerU 自己去取
    return { pdf: true, finalUrl };
  }
  if (!/html|xml/i.test(type)) throw httpError(`这个网址不是网页（${type || '未知类型'}）`, 400);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_IMPORT_BYTES) { await reader.cancel(); throw httpError('网页超过 40MB，无法搬运', 413); }
    if (syncLimit && total > syncLimit) { await reader.cancel(); return { large: true, finalUrl }; }
    chunks.push(value);
  }
  return { html: decodeBody(Buffer.concat(chunks), type), finalUrl };
}

// 保存一篇需要对照翻译的文章。slug 已存在（后台导入先建了占位）时更新它
export async function saveBilingual({ origin, slug, title, blocks, html, tables, source, sourceUrl, translate, ocrImages = true }) {
  const textBlocks = blocks.filter((b) => b.k !== 'img');
  const candidates = blocks.map((b, i) => (b.big ? { tid: i, src: b.src } : null)).filter(Boolean).slice(0, MAX_OCR_IMAGES);
  if (!textBlocks.length && !candidates.length) throw httpError('没有从文章里提取到正文', 400);

  const hash = contentHash(blocks);
  const dup = (await listMeta()).find((m) => m.hash === hash && m.slug !== slug);
  if (dup) throw Object.assign(new Error(`这篇文章已经存在：${dup.title}`), { status: 409, slug: dup.slug });

  const info = analyze(blocks);
  const now = Date.now();
  const old = slug ? await getJSON(`meta/${slug}`) : null;
  const meta = {
    ...(old || {}),
    slug: slug || makeSlug(title), title: title || (old && old.title) || '未命名文章', kind: 'bilingual',
    source, sourceUrl, hash, total: info.total, done: 0, createdAt: (old && old.createdAt) || now, updatedAt: now,
    status: 'idle', error: '', note: '', lockAt: 0, ingest: undefined,
  };
  // 版式：page = 保留原网页样式；doc = PDF 转 HTML（页面卡片 + 原表格）；没有 = 通用对照排版
  if (tables) meta.layout = 'doc';
  else if (html) meta.layout = 'page';
  else delete meta.layout;
  // 搬运的是本站自己的静态文章：记下原路径，首页据此隐藏英文原版
  if (sourceUrl && new URL(sourceUrl).origin === origin) meta.origPath = new URL(sourceUrl).pathname;

  let next = null; // 保存后要启动的后台任务
  if (info.alreadyChinese) {
    meta.status = 'skip';
    meta.note = '检测到文章已经包含中文，无需重复翻译，已按原文保存';
    meta.done = meta.total;
  } else if (translate && candidates.length && ocrImages && mineruConfig().token) {
    // 里面有整页图片（PDF 页面截图）：文字在图里，先 OCR 再翻译
    meta.status = 'ocr';
    meta.ocrDone = 0; meta.ocrTotal = candidates.length;
    meta.ocr = { mode: 'images', translate, jobs: candidates.map((c, i) => ({ ...c, state: 'pending', name: `img-${i}${imageExt(c.src)}` })) };
    next = 'ocr-background';
  } else if (translate) {
    if (!translateConfig().key) {
      meta.error = '尚未配置 OPENAI_API_KEY，文章已保存，配置后在管理页点“开始翻译”';
    } else if (pendingChars(blocks) > autoTranslateMaxChars()) {
      meta.note = `文章很长（约 ${Math.round(pendingChars(blocks) / 1000)} 千字符、${info.total} 段），为避免意外产生大额费用，没有自动开始翻译。确认后点“开始翻译”`;
    } else {
      meta.status = 'queued';
      next = 'translate-background';
    }
  }
  if (candidates.length && !meta.ocr && !info.alreadyChinese) {
    const why = !translate ? '因为没有选择翻译，没有识别' : '配置 MINERU_API_TOKEN 后可自动识别';
    meta.note = (meta.note ? meta.note + '；' : '') + `里面有 ${candidates.length} 张整页图片（可能是 PDF 页面），文字在图里没有被翻译（${why}）`;
  }

  if (html) await setText(`html/${meta.slug}`, html);
  if (tables) {
    await delPrefix(`tbl/${meta.slug}/`);
    for (const [key, raw] of Object.entries(tables)) await setText(`tbl/${meta.slug}/${key}`, raw);
  }
  await setJSON(`doc/${meta.slug}`, { blocks });
  await setJSON(`meta/${meta.slug}`, meta);
  if (next) {
    try { await kick(origin, next, meta.slug); } catch (e) {
      meta.status = 'error'; meta.error = e.message; await setJSON(`meta/${meta.slug}`, meta);
    }
  }
  return meta;
}

export const imageExt = (src) => {
  const m = new URL(src).pathname.match(/\.(png|jpe?g|jp2|webp|gif|bmp)$/i);
  return m ? m[0].toLowerCase() : '.jpg';
};

// 解析一篇 HTML 并保存。PDF 转出来的网页（逐行绝对定位）按坐标还原段落；普通网页保留原样式
export async function ingestHtml({ origin, html, finalUrl, title, translate, slug, source = 'import' }) {
  // SingleFile 保存的网页：文件开头的注释里有原网址，用它做来源和相对链接的基准
  const sourceUrl = finalUrl || singleFileUrl(html) || undefined;
  let externalized = false;
  if (hasBigDataUri(html)) {
    // 内联的 base64 图片、字体拆出来单独存放，网页只剩文字和样式
    slug = slug || makeSlug((title || '').trim() || (sourceUrl ? new URL(sourceUrl).hostname : 'page'));
    html = (await externalizeDataUris(html, slug, origin)).html;
    externalized = true;
  }
  try {
    let parsed, page = null;
    if (looksPositioned(html)) {
      parsed = parsePositioned(html, sourceUrl); // 带 tables：文档版式
    } else {
      parsed = parseHtml(html, { annotate: true, images: true, baseUrl: sourceUrl });
      if (html.length <= PAGE_LAYOUT_MAX) page = sanitizeRawHtml(parsed.html, sourceUrl);
    }
    return await saveBilingual({
      origin, slug, title: (title || '').trim() || parsed.title || (sourceUrl ? new URL(sourceUrl).hostname : ''),
      blocks: parsed.blocks, html: page, tables: parsed.tables, source, sourceUrl, translate,
    });
  } catch (e) {
    if (externalized) await delPrefix(`img/${slug}/`); // 失败（如重复文章）时不留下孤立的图片
    throw e;
  }
}

// 大网页的轻量清理：不用 DOM 解析（十几 MB 的网页会占用太多内存），只去掉脚本、加 <base> 和返回链接。
// 页面输出时还带 CSP: script-src 'none'，脚本本来也执行不了。
export function lightSanitize(html, sourceUrl) {
  let out = html.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '');
  const base = `<base href="${String(sourceUrl).replace(/"/g, '&quot;')}">`;
  out = /<head[^>]*>/i.test(out) ? out.replace(/<head[^>]*>/i, (m) => m + base) : base + out;
  return /<body[^>]*>/i.test(out) ? out.replace(/<body[^>]*>/i, (m) => m + BACK_LINK) : BACK_LINK + out;
}

const decodeEntities = (t) => t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

// “仅搬运”：原样保存网页（去掉脚本），不翻译、不 OCR。slug 已存在（后台导入先建了占位）时更新它
export async function saveRaw({ slug, html, finalUrl, title }) {
  if (html.length > MAX_RAW_BYTES) {
    throw httpError(`网页太大（${Math.round(html.length / 1048576)}MB），“仅搬运”最大支持 18MB；可以选“搬运并翻译”`, 413);
  }
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const name = (title || '').trim() || (m && decodeEntities(m[1]).replace(/\s+/g, ' ').trim()) || new URL(finalUrl).hostname;
  const old = slug ? await getJSON(`meta/${slug}`) : null;
  const now = Date.now();
  const meta = {
    slug: slug || makeSlug(name), title: name, kind: 'raw', source: 'import', sourceUrl: finalUrl,
    status: 'done', total: 0, done: 0, createdAt: (old && old.createdAt) || now, updatedAt: now, note: '仅搬运，未翻译',
  };
  const clean = html.length > 3 * 1024 * 1024 ? lightSanitize(html, finalUrl) : sanitizeRawHtml(html, finalUrl);
  await setText(`html/${meta.slug}`, clean);
  await setJSON(`meta/${meta.slug}`, meta);
  return meta;
}
