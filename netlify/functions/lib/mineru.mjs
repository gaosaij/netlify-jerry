// MinerU 云端 API（https://mineru.net/apiManage/docs）：PDF 识别（含扫描版 OCR）→ Markdown
//   网址提交：POST /extract/task            查询：GET /extract/task/{task_id}
//   本地文件：POST /file-urls/batch 拿到上传地址 → PUT 文件 → GET /extract-results/batch/{batch_id}
//   单个文件限制：200MB、200 页；更长的文档用 page_ranges 分段提交
import { unzipSync } from 'fflate';

export const MAX_PAGES_PER_JOB = 200;

export function mineruConfig() {
  return {
    token: process.env.MINERU_API_TOKEN || '',
    base: (process.env.MINERU_BASE_URL || 'https://mineru.net/api/v4').replace(/\/+$/, ''),
    model: process.env.MINERU_MODEL_VERSION || 'vlm',
  };
}

// 调用接口；HTTP 非 2xx 或返回 code 不为 0 都当作错误，并带上 MinerU 给的说明
async function call(path, { method = 'GET', body } = {}) {
  const cfg = mineruConfig();
  const res = await fetch(cfg.base + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
  if (!res.ok || !json || json.code !== 0) {
    const detail = (json && (json.msg || json.message)) || text.slice(0, 200) || `HTTP ${res.status}`;
    throw new Error(`MinerU 接口错误：${detail}${json && json.code != null ? `（code ${json.code}）` : ''}`);
  }
  return json.data;
}

const normalize = (r) => ({
  name: r.file_name,
  state: r.state,
  zip: r.full_zip_url,
  err: r.err_msg,
  extracted: r.extract_progress && r.extract_progress.extracted_pages,
  total: r.extract_progress && r.extract_progress.total_pages,
});

// 用网址提交（MinerU 自己去下载这个 PDF，所以网址必须能公开访问）
export async function createUrlTask(url, range) {
  const cfg = mineruConfig();
  const data = await call('/extract/task', {
    method: 'POST',
    body: { url, is_ocr: true, model_version: cfg.model, ...(range ? { page_ranges: range } : {}) },
  });
  return data.task_id;
}

export async function getTask(taskId) {
  return normalize(await call(`/extract/task/${encodeURIComponent(taskId)}`));
}

// 本地文件：files = [{ name, range }]，返回 batchId 和与 files 一一对应的上传地址
export async function createUploadBatch(files) {
  const cfg = mineruConfig();
  const data = await call('/file-urls/batch', {
    method: 'POST',
    body: {
      model_version: cfg.model,
      files: files.map((f) => ({ name: f.name, is_ocr: true, ...(f.range ? { page_ranges: f.range } : {}) })),
    },
  });
  return { batchId: data.batch_id, urls: data.file_urls };
}

// 把文件内容 PUT 到上传地址（不要设置 Content-Type；上传完成后 MinerU 自动开始解析）
export async function putFile(url, buffer) {
  const res = await fetch(url, { method: 'PUT', body: buffer, signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!res.ok) throw new Error(`上传 PDF 到 MinerU 失败：HTTP ${res.status}`);
}

export async function getBatch(batchId) {
  const data = await call(`/extract-results/batch/${encodeURIComponent(batchId)}`);
  return (data.extract_result || []).map(normalize);
}

// 下载结果压缩包，取出 full.md 和 images/ 里的图片
export async function fetchResult(zipUrl) {
  const res = await fetch(zipUrl, { signal: AbortSignal.timeout(5 * 60 * 1000) });
  if (!res.ok) throw new Error(`下载 MinerU 结果失败：HTTP ${res.status}`);
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  const mdName = Object.keys(files).find((n) => /(^|\/)full\.md$/i.test(n));
  if (!mdName) throw new Error('MinerU 结果里没有 full.md');
  const images = {};
  for (const [name, data] of Object.entries(files)) {
    const m = name.match(/(?:^|\/)images\/([^/]+)$/);
    if (m) images[m[1]] = data;
  }
  return { md: new TextDecoder().decode(files[mdName]), images };
}

// 超过 200 页的文档按 200 页一段切成 page_ranges，如 ["1-200", "201-400"]；页数未知或不超限返回 [null]
export function splitRanges(pages) {
  if (!pages || pages <= MAX_PAGES_PER_JOB) return [null];
  const out = [];
  for (let a = 1; a <= pages; a += MAX_PAGES_PER_JOB) out.push(`${a}-${Math.min(a + MAX_PAGES_PER_JOB - 1, pages)}`);
  return out;
}
