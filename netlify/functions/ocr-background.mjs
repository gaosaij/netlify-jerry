// 后台 OCR 函数：把 PDF 交给 MinerU 识别成 Markdown，再转成分段，识别完自动接着翻译。
// 状态保存在 meta.ocr 里：每个 job 对应 MinerU 的一个任务（超过 200 页的 PDF 会按页码拆成多个 job）。
// 运行接近 12 分钟还没识别完，就保存状态并重新调用自己，继续轮询。
import { getJSON, setJSON, getBinary, setBinary, delPrefix } from './lib/store.mjs';
import { requireAdmin } from './lib/auth.mjs';
import { validSlug, parseMarkdown, analyze, contentHash } from './lib/parse.mjs';
import { config as translateConfig, autoTranslateMaxChars, pendingChars } from './lib/translate.mjs';
import { fetchHeaders, blockedHint } from './lib/ingest.mjs';
import { safeFetch } from './lib/safe-fetch.mjs';
import { kick } from './lib/kick.mjs';
import { envMs, isLocked, startHeartbeat, touchLock } from './lib/runtime.mjs';
import { mineruConfig, createUrlTask, getTask, createUploadBatch, putFile, getBatch, fetchResult } from './lib/mineru.mjs';

const budgetMs = () => envMs('OCR_BUDGET_MS', 12 * 60 * 1000);
const POLL_MS = Number(process.env.OCR_POLL_MS) || 5000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 并发执行：同时最多 size 个
async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// 整页图片：每 6 张一组——并发下载（服务器自己带 User-Agent 抓图，有的网站如 SEC 不允许 MinerU 直接取），
// 为这一组申请上传地址并并发上传，然后保存进度。可以随时中断、从断点继续（已上传的图片不会重传）；
// 单张图片下载失败只会让这一张失败，不影响其它。
const GROUP = 6;
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
async function submitImages(o, ctx) {
  o.batches = o.batches || [];
  const todo = o.jobs.filter((j) => !j.batch && j.state !== 'failed');
  for (let i = 0; i < todo.length; i += GROUP) {
    const got = await pool(todo.slice(i, i + GROUP), 3, async (j) => {
      try {
        // 图片地址来自被搬运网页的内容（不可信）：safeFetch 拒绝本机/内网地址，并且只接受图片、限制大小
        const res = await safeFetch(j.src, { headers: fetchHeaders('image/*'), signal: AbortSignal.timeout(90000) });
        if (!res.ok) throw new Error(`下载图片失败（HTTP ${res.status}）${blockedHint(j.src, res.status)}`);
        const type = res.headers.get('content-type') || '';
        if (type && !/^image\//i.test(type) && !/octet-stream/i.test(type)) throw new Error(`下载图片失败：这个地址返回的不是图片（${type.split(';')[0]}）`);
        if (Number(res.headers.get('content-length') || 0) > MAX_IMAGE_BYTES) throw new Error('下载图片失败：图片太大');
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_IMAGE_BYTES) throw new Error('下载图片失败：图片太大');
        return { j, buf };
      } catch (e) {
        j.state = 'failed'; j.err = e.message;
        return null;
      }
    });
    const ok = got.filter(Boolean);
    if (ok.length) {
      const { batchId, urls } = await createUploadBatch(ok.map((g) => ({ name: g.j.name })));
      if (!urls || urls.length !== ok.length) throw new Error('MinerU 返回的上传地址数量不对');
      await pool(ok, 3, (g, k) => putFile(urls[k], g.buf));
      o.batches.push({ id: batchId, names: ok.map((g) => g.j.name) });
      ok.forEach((g) => { g.j.batch = batchId; });
    }
    ctx.meta.note = `正在把整页图片上传给 MinerU：${o.jobs.filter((j) => j.batch).length} / ${o.jobs.length}`;
    ctx.meta.lockAt = Date.now();
    if (!(await ctx.save())) return 'deleted';
    if (i + GROUP < todo.length && Date.now() - ctx.started > budgetMs()) return 'handoff';
  }
  return 'done';
}

// 提交：网址模式逐个提交任务；上传模式先把分块拼成完整 PDF，申请上传地址后 PUT 上去
async function submit(o) {
  if (o.mode === 'images') {
    throw new Error('整页图片模式请使用 submitImages');
  }
  if (o.mode === 'url') {
    for (const j of o.jobs) if (!j.taskId) j.taskId = await createUrlTask(o.url, j.range);
    return;
  }
  const parts = [];
  for (let i = 0; i < o.chunks; i++) {
    const part = await getBinary(`pdf/${o.uploadId}/${i}`);
    if (!part) throw new Error(`上传的 PDF 缺少第 ${i + 1} 块，请重新上传`);
    parts.push(part);
  }
  const pdf = Buffer.concat(parts);
  const { batchId, urls } = await createUploadBatch(o.jobs.map((j) => ({ name: j.name, range: j.range })));
  if (!urls || urls.length !== o.jobs.length) throw new Error('MinerU 返回的上传地址数量不对');
  for (let i = 0; i < urls.length; i++) await putFile(urls[i], pdf);
  o.batchId = batchId;
}

// 轮询所有 job 的状态，返回已识别页数/总页数
async function poll(o) {
  let results;
  if (o.mode === 'images') {
    const all = [];
    for (const b of o.batches) all.push(...(await getBatch(b.id)));
    results = o.jobs.map((j, i) => all.find((r) => r.name === j.name) || all[i] || { state: 'waiting-file' });
  } else if (o.mode === 'url') {
    results = await Promise.all(o.jobs.map((j) => getTask(j.taskId)));
  } else {
    const batch = await getBatch(o.batchId);
    results = o.jobs.map((j, i) => batch.find((r) => r.name === j.name) || batch[i] || { state: 'waiting-file' });
  }
  let pagesDone = 0, pagesTotal = 0;
  o.jobs.forEach((j, i) => {
    if (o.mode === 'images' && !j.batch) return; // 下载失败的图片保持“失败”状态
    const r = results[i];
    j.state = r.state === 'done' ? 'done' : r.state === 'failed' ? 'failed' : 'running';
    j.zip = r.zip || j.zip;
    j.err = r.err || '';
    if (r.total) { j.pages = r.total; }
    if (o.mode === 'images') { j.pages = 1; } // 一张图算一页
    pagesDone += j.state === 'done' ? (j.pages || 0) : (r.extracted || 0);
    pagesTotal += j.pages || 0;
  });
  return { pagesDone, pagesTotal };
}

// 把识别出的图片存起来，Markdown 里的 images/xx 改成本站地址
async function collect(slug, o) {
  const mds = [];
  for (const j of o.jobs.filter((x) => x.state === 'done')) {
    const { md, images } = await fetchResult(j.zip);
    for (const [name, data] of Object.entries(images)) await setBinary(`img/${slug}/${name}`, Buffer.from(data));
    mds.push(md.replace(/\]\((?:\.\/)?images\/([^)\s]+)\)/g, `](/api/img/${slug}/$1)`));
  }
  return mds.join('\n\n');
}

export default async (req) => {
  if (requireAdmin(req)) return;
  const { slug } = await req.json();
  if (!validSlug(slug)) return;
  const origin = new URL(req.url).origin;
  const started = Date.now();

  const meta = await getJSON(`meta/${slug}`);
  if (!meta || !meta.ocr || meta.ocr.finished) return;
  if (isLocked(meta)) return; // 已有一个识别任务在跑
  const o = meta.ocr;

  const save = async () => {
    if (!(await getJSON(`meta/${slug}`))) return false; // 识别途中文章被删了
    meta.updatedAt = Date.now();
    await setJSON(`meta/${slug}`, meta);
    return true;
  };

  // 心跳：下载/上传很慢的时候也定期刷新锁，避免被误判为已中断而被重复启动
  let stopBeat = () => {};
  try {
    if (!mineruConfig().token) throw new Error('尚未配置 MINERU_API_TOKEN');
    meta.status = 'ocr'; meta.error = ''; meta.lockAt = Date.now();
    if (!(await save())) return;
    stopBeat = startHeartbeat(() => touchLock(slug, meta));

    if (o.mode === 'images') {
      if (!o.jobs.every((j) => j.batch || j.state === 'failed')) {
        const r = await submitImages(o, { meta, save, started });
        if (r === 'deleted') return;
        if (r === 'handoff') { // 时间快到了：保存进度，交给新的一次调用继续上传剩下的图片
          meta.lockAt = 0;
          await save();
          await kick(origin, 'ocr-background', slug);
          return;
        }
      }
      meta.note = '';
      if (o.jobs.every((j) => j.state === 'failed')) throw new Error(`所有整页图片都下载失败：${o.jobs[0].err}`);
    } else {
      const submitted = o.mode === 'url' ? o.jobs.every((j) => j.taskId) : !!o.batchId;
      if (!submitted) { await submit(o); if (!(await save())) return; }
    }

    let failures = 0;
    for (;;) {
      try {
        const { pagesDone, pagesTotal } = await poll(o);
        failures = 0;
        meta.ocrDone = pagesDone; meta.ocrTotal = pagesTotal || o.pages || 0;
      } catch (e) {
        if (++failures >= 5) throw e; // 偶发的网络错误忽略，连续 5 次才算失败
      }
      meta.lockAt = Date.now();
      if (!(await save())) return;
      const bad = o.jobs.find((j) => j.state === 'failed');
      if (o.mode === 'images') {
        // 整页图片：个别失败不影响其它，全部失败才算失败
        const live = o.jobs.filter((j) => j.state !== 'failed');
        if (!live.length) throw new Error(`MinerU 识别失败：${bad.err || '未知原因'}`);
        if (live.every((j) => j.state === 'done')) break;
      } else {
        if (bad) throw new Error(`MinerU 识别失败：${bad.err || '未知原因'}${bad.range ? `（页码 ${bad.range}）` : ''}`);
        if (o.jobs.every((j) => j.state === 'done')) break;
      }
      if (Date.now() - started > budgetMs()) {
        meta.lockAt = 0;
        await save();
        await kick(origin, 'ocr-background', slug);
        return;
      }
      await sleep(POLL_MS);
    }

    // 识别完成：取回 Markdown → 分段
    let blocks;
    if (o.mode === 'images') {
      // 每张图识别出的文字追加到文章末尾（ocrAfter = 这张图在文章里的位置），显示时放回图片后面
      const doc = (await getJSON(`doc/${slug}`)) || { blocks: [] };
      doc.blocks = doc.blocks.filter((b) => b.ocrAfter == null); // 重试时避免重复追加
      for (const j of o.jobs.filter((x) => x.state === 'done')) { // 下载/识别失败的图片跳过
        const { md } = await fetchResult(j.zip);
        const text = md.replace(/!\[[^\]]*\]\([^)]*\)/g, ''); // 图片里再裁出的小图不保留
        for (const b of parseMarkdown(text).blocks) doc.blocks.push({ ...b, ocrAfter: j.tid });
      }
      blocks = doc.blocks;
      await setJSON(`doc/${slug}`, doc);
      if (!blocks.some((b) => b.ocrAfter != null)) meta.note = 'MinerU 没有从这些整页图片里识别出文字';
      const failedImgs = o.jobs.filter((j) => j.state === 'failed');
      if (failedImgs.length) meta.note = (meta.note ? meta.note + '；' : '') + `${failedImgs.length} 张整页图片没能识别（${failedImgs[0].err}）`;
    } else {
      const md = await collect(slug, o);
      const parsed = parseMarkdown(md);
      if (!parsed.blocks.length) throw new Error('MinerU 没有识别出文字');
      if (meta.titleAuto && parsed.title) meta.title = parsed.title;
      blocks = parsed.blocks;
      meta.hash = contentHash(blocks);
      await setJSON(`doc/${slug}`, { blocks });
    }
    const info = analyze(blocks);
    meta.total = info.total; meta.done = 0;
    meta.lockAt = 0; o.finished = true;
    if (info.alreadyChinese) {
      meta.status = 'skip'; meta.done = meta.total;
      meta.note = '识别出的文字已经包含中文，无需重复翻译';
    } else if (o.translate && translateConfig().key) {
      if (pendingChars(blocks) > autoTranslateMaxChars()) {
        meta.status = 'idle';
        meta.note = `识别完成，文章很长（约 ${Math.round(pendingChars(blocks) / 1000)} 千字符、${info.total} 段），为避免意外产生大额费用，没有自动开始翻译。确认后点“开始翻译”`;
      } else {
        meta.status = 'queued';
      }
    } else {
      meta.status = 'idle';
      if (o.translate) meta.error = '尚未配置 OPENAI_API_KEY，识别结果已保存，配置后点“开始翻译”';
    }
    if (!(await save())) return;
    if (o.mode === 'upload') await delPrefix(`pdf/${o.uploadId}/`);
    if (meta.status === 'queued') await kick(origin, 'translate-background', slug);
  } catch (e) {
    meta.status = 'error'; meta.error = e.message || String(e); meta.lockAt = 0;
    await save();
  } finally {
    stopBeat();
  }
};
