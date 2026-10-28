// 后台翻译函数（文件名带 -background，Netlify 允许最长运行 15 分钟，调用后立即返回 202）
// 每翻译完一轮就把进度写回存储，文章页因此能看到最新进度。
// 文章很长时：运行时间接近上限就保存进度并重新调用自己，分多次翻完。
//   · 每次请求都带截止时间（默认第 13 分钟），一轮翻译不会拖过平台的 15 分钟上限而被强杀；
//   · 第 9 分钟之后不再开始新的一轮；
//   · 整份文档（可能几 MB）限频保存（默认 25 秒一次），其余时间只写很小的 meta；
//   · 连续几次运行都没有完成任何一批，就报错，而不是无限交棒。
import { getJSON, setJSON } from './lib/store.mjs';
import { requireAdmin } from './lib/auth.mjs';
import { needsTranslation, validSlug } from './lib/parse.mjs';
import { config, makeBatches, translateWithFallback, DeadlineError } from './lib/translate.mjs';
import { kick } from './lib/kick.mjs';
import { envMs, isLocked, startHeartbeat, touchLock } from './lib/runtime.mjs';

const CONCURRENCY = 3;     // 同时进行的翻译请求数
const MAX_STALLS = 3;      // 连续这么多次运行都没完成任何一批就放弃

export default async (req) => {
  if (requireAdmin(req)) return;
  const { slug } = await req.json();
  if (!validSlug(slug)) return;
  const origin = new URL(req.url).origin;
  const started = Date.now();
  const softBudget = envMs('TRANSLATE_BUDGET_MS', 9 * 60 * 1000);   // 超过它不再开始新的一轮
  const deadline = started + envMs('TRANSLATE_DEADLINE_MS', 13 * 60 * 1000); // 所有请求必须在它之前结束
  const saveEvery = envMs('TRANSLATE_SAVE_MS', 25 * 1000);

  const meta = await getJSON(`meta/${slug}`);
  const doc = await getJSON(`doc/${slug}`);
  if (!meta || !doc) return;
  if (isLocked(meta)) return; // 已有一个翻译任务在跑

  const cfg = config();
  let lastDocSave = 0;
  // force 或距离上次保存文档已经够久：写文档并更新进度；否则只写小小的 meta（刷新锁）
  const save = async (force = false) => {
    // 翻译途中文章被删除，就不要再写回去
    if (!(await getJSON(`meta/${slug}`))) return false;
    const now = Date.now();
    if (force || now - lastDocSave >= saveEvery) {
      meta.done = meta.total - doc.blocks.filter(needsTranslation).length;
      meta.updatedAt = now;
      await setJSON(`doc/${slug}`, doc);
      lastDocSave = now;
    }
    await setJSON(`meta/${slug}`, meta);
    return true;
  };
  // 心跳：翻译请求慢的时候也定期刷新锁，避免被误判为已中断
  let stopBeat = () => {};

  try {
    if (!cfg.key) throw new Error('尚未配置 OPENAI_API_KEY');
    meta.status = 'translating'; meta.error = ''; meta.lockAt = Date.now();
    if (!(await save(true))) return;
    stopBeat = startHeartbeat(() => touchLock(slug, meta));

    for (;;) {
      const batches = makeBatches(doc.blocks);
      if (!batches.length) {
        meta.status = 'done'; meta.lockAt = 0; meta.stalls = 0;
        await save(true);
        return;
      }
      const round = batches.slice(0, CONCURRENCY);
      const results = await Promise.allSettled(
        round.map((idx) => translateWithFallback(idx.map((i) => doc.blocks[i].en), cfg, meta.title, deadline)),
      );
      let failure = null;
      let timeUp = false;
      let progressed = 0;
      results.forEach((r, n) => {
        if (r.status === 'fulfilled') {
          round[n].forEach((blockIdx, j) => { doc.blocks[blockIdx].zh = r.value[j]; });
          progressed += round[n].length;
        } else if (r.reason instanceof DeadlineError) {
          timeUp = true;
        } else {
          failure = failure || r.reason;
        }
      });
      meta.lockAt = Date.now();
      if (failure) { await save(true); throw failure; } // 已成功的部分先保存了，剩下的下次继续
      if (!(await save(false))) return;

      if (timeUp || Date.now() - started > softBudget) {
        // 时间快到了：保存进度，交棒给新的一次调用继续翻译
        if (timeUp && !progressed) {
          meta.stalls = (meta.stalls || 0) + 1;
          if (meta.stalls >= MAX_STALLS) throw new Error(`模型接口响应太慢：连续 ${MAX_STALLS} 次运行都没有在时间上限内完成任何一批翻译，请检查接口或换个模型后点“继续翻译”`);
        } else if (progressed) {
          meta.stalls = 0;
        }
        meta.status = 'queued'; meta.lockAt = 0;
        await save(true);
        await kick(origin, 'translate-background', slug); // 会检查响应状态；失败会进入下面的 catch 显示为错误，而不是静默停在“排队”
        return;
      }
      if (progressed) meta.stalls = 0;
    }
  } catch (e) {
    meta.status = 'error'; meta.error = e.message || String(e); meta.lockAt = 0;
    await save(true);
  } finally {
    stopBeat();
  }
};
