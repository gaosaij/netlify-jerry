// “保留原网页样式”的文章和“仅搬运”的网页是原网页本身，没有我们的导航，需要在顶部放一个返回文章列表的链接。
// 在显示时（而不是保存时）处理：
//   · 页面里已经有“← 文章列表”这样的返回链接（比如从本站静态文章页翻译出来的版本，原页面顶部就有）就不再重复加；
//   · 以前保存的网页里带着旧版注入的“左下角浮动链接”，显示时一并去掉，已有文章不需要重新搬运。
const LEGACY = /<a\b[^>]*position:\s*fixed;\s*bottom:\s*12px;\s*left:\s*12px[^>]*>[^<]*文章列表<\/a>/gi;
const HAS_BACK = /<a\b[^>]*\bhref=["']\/["'][^>]*>\s*(?:←|&larr;)?\s*文章列表/i;

const TOP_LINK =
  '<div style="padding:8px 14px;font:14px/1.4 -apple-system,BlinkMacSystemFont,\'PingFang SC\',\'Microsoft YaHei\',sans-serif">' +
  '<a href="/" style="color:#666;text-decoration:none">← 文章列表</a></div>';

export function withTopBackLink(html) {
  const clean = html.replace(LEGACY, '');
  if (HAS_BACK.test(clean)) return clean;
  return /<body[^>]*>/i.test(clean) ? clean.replace(/<body[^>]*>/i, (m) => m + TOP_LINK) : TOP_LINK + clean;
}
