// 存储层：线上用 Netlify Blobs；设置了 LOCAL_STORE_DIR 时改用本地文件夹（仅用于本地测试）
//   meta/<slug>  文章元信息（标题、状态、翻译进度）
//   doc/<slug>   文章分段内容（英文原文 + 已翻译的中文）
//   html/<slug>  仅搬运模式下保存的原始网页
//   pdf/<id>/<n> 上传中的 PDF 分块（交给 MinerU 后删除）
//   img/<slug>/<文件名>  MinerU 识别出的图片
//   ocrmd/<slug>/<n>     MinerU 返回的 Markdown（识别完成后删除）
import { getStore } from '@netlify/blobs';
import fs from 'node:fs/promises';
import path from 'node:path';

const localDir = () => process.env.LOCAL_STORE_DIR;
const localFile = (key) => path.join(localDir(), encodeURIComponent(key));
const blobs = () => getStore({ name: 'articles', consistency: 'strong' });

export async function getJSON(key) {
  if (localDir()) {
    try { return JSON.parse(await fs.readFile(localFile(key), 'utf8')); } catch { return null; }
  }
  return blobs().get(key, { type: 'json' });
}

export async function setJSON(key, value) {
  if (localDir()) {
    await fs.mkdir(localDir(), { recursive: true });
    return fs.writeFile(localFile(key), JSON.stringify(value));
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
    return fs.writeFile(localFile(key), value);
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
    return fs.writeFile(localFile(key), data);
  }
  return blobs().set(key, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
}

export async function delPrefix(prefix) {
  await Promise.all((await listKeys(prefix)).map((k) => del(k)));
}

export async function del(key) {
  if (localDir()) {
    try { await fs.unlink(localFile(key)); } catch { /* 不存在就算了 */ }
    return;
  }
  return blobs().delete(key);
}

export async function listKeys(prefix) {
  if (localDir()) {
    try {
      return (await fs.readdir(localDir())).map(decodeURIComponent).filter((k) => k.startsWith(prefix));
    } catch { return []; }
  }
  const { blobs: items } = await blobs().list({ prefix });
  return items.map((b) => b.key);
}

// 读取所有文章的元信息，新的在前
export async function listMeta() {
  const keys = await listKeys('meta/');
  const metas = await Promise.all(keys.map((k) => getJSON(k)));
  return metas.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
}
