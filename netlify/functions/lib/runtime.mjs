// 后台任务共用的几个小工具：时间配置、任务锁、锁心跳。

// 读取以毫秒为单位的环境变量（测试里用来缩短时间）；没设置或不是数字就用默认值，允许设为 0
export function envMs(name, fallback) {
  const v = process.env[name];
  return v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : fallback;
}

import { getJSON, setJSON } from './store.mjs';

// 任务锁：meta.lockAt 在任务运行期间不断刷新；超过这个时间没刷新，就视为上一次运行已经异常中断（被平台强杀等），可以重新启动
export const LOCK_MS = 6 * 60 * 1000;          // 翻译、OCR
export const INGEST_LOCK_MS = 10 * 60 * 1000;  // 抓取解析大网页

export const isLocked = (meta, ms = LOCK_MS) => !!(meta.lockAt && Date.now() - meta.lockAt < ms);

// 心跳：运行期间每隔一段时间调用一次 refresh（刷新 lockAt），避免一个慢步骤超过锁的有效期而被误判为中断。返回停止函数
export function startHeartbeat(refresh, everyMs = envMs('LOCK_HEARTBEAT_MS', 60 * 1000)) {
  const timer = setInterval(() => { Promise.resolve(refresh()).catch(() => {}); }, everyMs);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

// 刷新锁（心跳用）。先确认文章还在：用户在任务运行途中删除了文章，不能再把 meta 写回去
export async function touchLock(slug, meta) {
  if (!(await getJSON(`meta/${slug}`))) return;
  meta.lockAt = Date.now();
  await setJSON(`meta/${slug}`, meta);
}
