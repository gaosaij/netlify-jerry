// 调用 OpenAI 兼容接口翻译：把若干段英文打成一批，一次请求翻译，用 <<<编号>>> 标记对应关系
import { needsTranslation } from './parse.mjs';
import { envMs, DeadlineError } from './runtime.mjs';
export { DeadlineError };

export function config() {
  return {
    key: process.env.OPENAI_API_KEY || '',
    base: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  };
}

// 待翻译字符数超过这个值时，不自动开始翻译（避免一次提交一份几百页的文件就产生一大笔费用），
// 由你在管理页确认后点“开始翻译”。可用环境变量 AUTO_TRANSLATE_MAX_CHARS 调整。
export const autoTranslateMaxChars = () => Number(process.env.AUTO_TRANSLATE_MAX_CHARS) || 300000;
export const pendingChars = (blocks) => blocks.reduce((n, b) => n + (needsTranslation(b) ? b.en.length : 0), 0);

const SYSTEM_PROMPT = `你是专业的英译中翻译，擅长学术论文和深度文章。请把用户给出的英文段落翻译成流畅、准确、符合中文表达习惯的简体中文。
要求：
1. 每个段落以 <<<编号>>> 开头。输出必须保持完全相同的编号和段落数量，一段对应一段，不要合并、拆分或遗漏。
2. 只输出译文，不要任何解释、前言或总结。
3. 人名、机构名、术语在首次出现时可保留英文原文；数字、公式、引用标记（如 [1]、(Smith, 2020)）、网址以及 Markdown 语法原样保留。
4. 如果某段本身已经是中文，原样输出即可。
5. 不要在译文开头添加任何前缀或标记（如“译文：”“【译】”），直接输出译文本身。`;

// 把待翻译的分段下标按字符数、条数分批
export function makeBatches(blocks, maxChars = 3000, maxItems = 30) {
  const batches = [];
  let cur = [];
  let chars = 0;
  blocks.forEach((b, i) => {
    if (!needsTranslation(b)) return;
    if (cur.length && (chars + b.en.length > maxChars || cur.length >= maxItems)) {
      batches.push(cur); cur = []; chars = 0;
    }
    cur.push(i);
    chars += b.en.length;
  });
  if (cur.length) batches.push(cur);
  return batches;
}

export class MismatchError extends Error {}

function parseReply(reply, count) {
  const out = [];
  const re = /<<<(\d+)>>>\s*([\s\S]*?)(?=<<<\d+>>>|$)/g;
  let m;
  // 万一模型还是加了“译文：”“【译】”之类的前缀，去掉
  while ((m = re.exec(reply))) out[Number(m[1]) - 1] = m[2].trim().replace(/^(?:【译】|译文[:：])\s*/, '');
  for (let i = 0; i < count; i++) {
    if (!out[i]) throw new MismatchError(`模型返回的段落数量与原文不一致（缺少第 ${i + 1} 段）`);
  }
  return out.slice(0, count);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 请求一次模型；遇到限流或服务端错误时指数退避重试。
// deadline（毫秒时间戳，可选）：每次请求的超时、重试前的等待都不会越过它，越过就抛 DeadlineError——
// 这样一轮翻译不会拖到平台的 15 分钟上限被强杀。
async function chat(messages, cfg, retries = 4, deadline = 0) {
  const margin = envMs('TRANSLATE_MARGIN_MS', 3000); // 留给保存进度和交棒的时间
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (deadline && Date.now() + margin > deadline) throw new DeadlineError('接近函数运行时间上限，保存进度后继续');
    try {
      const timeout = deadline ? Math.max(500, Math.min(120000, deadline - Date.now() - margin / 2)) : 120000;
      const res = await fetch(`${cfg.base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
        body: JSON.stringify({ model: cfg.model, temperature: 0.2, messages }),
        signal: AbortSignal.timeout(timeout),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`模型接口返回 ${res.status}：${(await res.text()).slice(0, 200)}`);
      } else if (!res.ok) {
        // 4xx（密钥错误、模型不存在等）重试也没用，直接抛出
        const err = new Error(`模型接口返回 ${res.status}：${(await res.text()).slice(0, 300)}`);
        err.fatal = true;
        throw err;
      } else {
        const data = await res.json();
        const content = data.choices?.[0]?.message?.content;
        if (!content) throw new Error('模型接口没有返回内容');
        return content;
      }
    } catch (e) {
      if (e.fatal) throw e;
      lastErr = e;
    }
    const wait = 1500 * 2 ** attempt;
    if (deadline && Date.now() + wait + margin > deadline) throw new DeadlineError('接近函数运行时间上限，保存进度后继续');
    await sleep(wait);
  }
  throw lastErr;
}

// 翻译一批文本，返回同样数量的译文
export async function translateTexts(texts, cfg, title = '', deadline = 0) {
  const body = texts.map((t, i) => `<<<${i + 1}>>>\n${t}`).join('\n\n');
  const user = (title ? `文章标题（仅供理解上下文）：${title}\n\n` : '') + body;
  const reply = await chat([{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: user }], cfg, 4, deadline);
  return parseReply(reply, texts.length);
}

// 批量翻译对不上号时，对半拆开重试，直到单段为止
export async function translateWithFallback(texts, cfg, title, deadline = 0) {
  try {
    return await translateTexts(texts, cfg, title, deadline);
  } catch (e) {
    if (!(e instanceof MismatchError) || texts.length === 1) throw e;
    const mid = Math.ceil(texts.length / 2);
    const [a, b] = await Promise.all([
      translateWithFallback(texts.slice(0, mid), cfg, title, deadline),
      translateWithFallback(texts.slice(mid), cfg, title, deadline),
    ]);
    return [...a, ...b];
  }
}
