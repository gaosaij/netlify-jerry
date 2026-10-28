// 存储层：线上用 Netlify Blobs；设置了 LOCAL_STORE_DIR 时改用本地文件夹（仅用于本地测试）
//   meta/<slug>  文章元信息（标题、状态、翻译进度）
//   doc/<slug>   文章分段内容（英文原文 + 已翻译的中文）
//   html/<slug>  仅搬运模式下保存的原始网页
//   pdf/<id>/<n> 上传中的 PDF 分块（交给 MinerU 后删除）
//   img/<slug>/<文件名>  MinerU 识别出的图片
//   ocrmd/<slug>/<n>     MinerU 返回的 Markdown（识别完成后删除）
//   render/<slug>        “保留原网页样式”文章的渲染结果缓存（按 meta.updatedAt 失效）
//   tbl/<slug>/<n>       PDF 转 HTML 里表格的原始 HTML
import { getStore } from '@netlify/blobs';
import fs from 'node:fs/promises';
import path from 'node:path';

const localDir = () => process.env.LOCAL_STORE_DIR;
const localFile = (key) => path.join(localDir(), encodeURIComponent(key));
// 原子写入：先写临时文件再改名。否则两个并发写入（或写入时同时读取）会读到写了一半的文件
const TMP = '.__tmp';
async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}${TMP}`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}
const blobs = () => getStore({ name: 'articles', consistency: 'strong' });

// 文章列表缓存：首页、管理页、查重都要读全部文章的元信息（每篇一次存储读取）。
// 同一个函数实例里缓存 3 秒；任何 meta/ 的写入、删除都会立刻使缓存失效；需要最新数据的地方（查重）传 fresh:true。
// 不同实例之间最多有 3 秒的延迟，只影响列表显示。
const META_TTL_MS = 3000;
let metaCache = null;
let metaGen = 0; // 写入/删除时递增，防止“读取进行中发生了写入”后把旧结果缓存起来
const touchesMeta = (key) => key.startsWith('meta/');

export async function getJSON(key) {
  if (localDir()) {
    try { return JSON.parse(await fs.readFile(localFile(key), 'utf8')); } catch { return null; }
  }
  return blobs().get(key, { type: 'json' });
}

export async function setJSON(key, value) {
  if (touchesMeta(key)) { metaCache = null; metaGen++; }
  if (localDir()) {
    await fs.mkdir(localDir(), { recursive: true });
    return writeAtomic(localFile(key), JSON.stringify(value));
  }
  return blobs().setJSON(key, value);
}

export async function getText(key) {
  if (localDir()) {
    try { return await fs.readFile(localFile(key), 'utf8'); } catch { return null; }
  }
  return blobs().get(key, { type: 'text' });
}

export async function setText(key, value) {
  if (localDir()) {
    await fs.mkdir(localDir(), { recursive: true });
    return writeAtomic(localFile(key), value);
  }
  return blobs().set(key, value);
}

// 二进制（PDF 分块、OCR 结果里的图片）
export async function getBinary(key) {
  if (localDir()) {
    try { return await fs.readFile(localFile(key)); } catch { return null; }
  }
  const ab = await blobs().get(key, { type: 'arrayBuffer' });
  return ab ? Buffer.from(ab) : null;
}

export async function setBinary(key, data) {
  if (localDir()) {
    await fs.mkdir(localDir(), { recursive: true });
    return writeAtomic(localFile(key), data);
  }
  return blobs().set(key, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
}

export async function delPrefix(prefix) {
  await Promise.all((await listKeys(prefix)).map((k) => del(k)));
}

export async function del(key) {
  if (touchesMeta(key)) { metaCache = null; metaGen++; }
  if (localDir()) {
    try { await fs.unlink(localFile(key)); } catch { /* 不存在就算了 */ }
    return;
  }
  return blobs().delete(key);
}

export async function listKeys(prefix) {
  if (localDir()) {
    try {
      return (await fs.readdir(localDir())).filter((f) => !f.endsWith(TMP)).map(decodeURIComponent).filter((k) => k.startsWith(prefix));
    } catch { return []; }
  }
  const { blobs: items } = await blobs().list({ prefix });
  return items.map((b) => b.key);
}

// 读取所有文章的元信息，新的在前
export async function listMeta({ fresh = false } = {}) {
  if (!fresh && metaCache && Date.now() - metaCache.at < META_TTL_MS) return metaCache.list;
  const gen = metaGen;
  const keys = await listKeys('meta/');
  const metas = await Promise.all(keys.map((k) => getJSON(k)));
  const list = metas.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
  if (gen === metaGen) metaCache = { at: Date.now(), list };
  return list;
}
