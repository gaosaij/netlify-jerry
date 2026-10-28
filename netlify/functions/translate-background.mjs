// 后台翻译函数（文件名带 -background，Netlify 允许最长运行 15 分钟，调用后立即返回 202）
// 每翻译完一轮就把进度写回存储，文章页因此能看到最新进度。
// 文章很长时：运行接近 12 分钟就保存进度并重新调用自己，分多次翻完。
import { getJSON, setJSON } from './lib/store.mjs';
import { requireAdmin } from './lib/auth.mjs';
import { needsTranslation, validSlug } from './lib/parse.mjs';
import { config, makeBatches, translateWithFallback } from './lib/translate.mjs';

const CONCURRENCY = 3;               // 同时进行的翻译请求数
const BUDGET_MS = 12 * 60 * 1000;    // 单次运行的时间预算
const LOCK_MS = 6 * 60 * 1000;       // 锁超过这个时间没更新，视为上一次异常中断

export default async (req) => {
  if (requireAdmin(req)) return;
  const { slug } = await req.json();
  if (!validSlug(slug)) return;
  const origin = new URL(req.url).origin;
  const started = Date.now();

  let meta = await getJSON(`meta/${slug}`);
  const doc = await getJSON(`doc/${slug}`);
  if (!meta || !doc) return;
  if (meta.lockAt && Date.now() - meta.lockAt < LOCK_MS) return; // 已有一个翻译任务在跑

  const cfg = config();
  const save = async () => {
    // 翻译途中文章被删除，就不要再写回去
    if (!(await getJSON(`meta/${slug}`))) return false;
    meta.done = meta.total - doc.blocks.filter(needsTranslation).length;
    meta.updatedAt = Date.now();
    await setJSON(`doc/${slug}`, doc);
    await setJSON(`meta/${slug}`, meta);
    return true;
  };

  try {
    if (!cfg.key) throw new Error('尚未配置 OPENAI_API_KEY');
    meta.status = 'translating'; meta.error = ''; meta.lockAt = Date.now();
    if (!(await save())) return;

    for (;;) {
      const batches = makeBatches(doc.blocks);
      if (!batches.length) {
        meta.status = 'done'; meta.lockAt = 0;
        await save();
        return;
      }
      const round = batches.slice(0, CONCURRENCY);
      const results = await Promise.allSettled(
        round.map((idx) => translateWithFallback(idx.map((i) => doc.blocks[i].en), cfg, meta.title)),
      );
      let failure = null;
      results.forEach((r, n) => {
        if (r.status === 'fulfilled') round[n].forEach((blockIdx, j) => { doc.blocks[blockIdx].zh = r.value[j]; });
        else failure = failure || r.reason;
      });
      meta.lockAt = Date.now();
      if (!(await save())) return;
      if (failure) throw failure; // 已成功的部分先保存了，剩下的下次继续

      if (Date.now() - started > BUDGET_MS) {
        // 时间快到了：交棒给新的一次调用，继续翻译剩下的
        meta.status = 'queued'; meta.lockAt = 0;
        await save();
        await fetch(`${origin}/.netlify/functions/translate-background`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-admin-password': process.env.ADMIN_PASSWORD },
          body: JSON.stringify({ slug }),
        });
        return;
      }
    }
  } catch (e) {
    meta.status = 'error'; meta.error = e.message || String(e); meta.lockAt = 0;
    await save();
  }
};
