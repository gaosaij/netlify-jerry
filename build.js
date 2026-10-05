// Netlify 构建脚本：扫描仓库里的文章，生成首页文章列表到 dist/
//   - 根目录下的 *.html（除 index.html）= 一篇文章，标题取文件名
//   - 一级子目录里的 index.html = 一篇文章（如 options-calculator/），标题取 <title>
//   - articles.json 可选，用来给某篇文章指定标题/简介，或用 "pin": true 置顶（key 为相对路径）
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'dist');
const SKIP = new Set([
  '.git', '.github', '.netlify', '.claude', '.DS_Store', 'node_modules', 'dist',
  'netlify-deploy', 'build.js', 'netlify.toml', 'articles.json', 'index.template.html',
  'package.json', 'package-lock.json', 'README.md',
]);

const meta = fs.existsSync(path.join(ROOT, 'articles.json'))
  ? JSON.parse(fs.readFileSync(path.join(ROOT, 'articles.json'), 'utf8'))
  : {};
const metaOrder = Object.keys(meta);

const unescapeHtml = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function addedTime(rel) {
  try {
    const lines = execFileSync('git', ['log', '--diff-filter=A', '--format=%ct', '--', rel], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split('\n').filter(Boolean);
    return lines.length ? Number(lines[lines.length - 1]) : 0;
  } catch {
    return 0;
  }
}

function titleFor(rel, kind, name) {
  if (meta[rel] && meta[rel].title) return meta[rel].title;
  if (kind === 'dir') {
    const html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    if (m && m[1].trim()) return unescapeHtml(m[1].trim());
  }
  return name.replace(/\.html$/i, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

const articles = [];
for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
  let rel, href, kind;
  if (e.isFile() && /\.html$/i.test(e.name) && e.name !== 'index.html') {
    rel = e.name; href = '/' + encodeURIComponent(e.name); kind = 'file';
  } else if (e.isDirectory() && fs.existsSync(path.join(ROOT, e.name, 'index.html'))) {
    rel = `${e.name}/index.html`; href = '/' + encodeURIComponent(e.name) + '/'; kind = 'dir';
  } else continue;
  articles.push({
    rel, href,
    title: titleFor(rel, kind, e.name),
    desc: (meta[rel] && meta[rel].desc) || '',
    pinned: !!(meta[rel] && meta[rel].pin),
    added: addedTime(rel),
  });
}

// 置顶的在最前；其余新上传的在前；同一时间（或拿不到 git 历史）时，没写进 articles.json 的排在前面
const rank = (a) => (metaOrder.includes(a.rel) ? metaOrder.indexOf(a.rel) + 1 : -1);
articles.sort((a, b) => b.pinned - a.pinned || b.added - a.added || rank(a) - rank(b) || a.title.localeCompare(b.title, 'zh'));

const items = articles.map((a) => `      <li>
        <a class="article" href="${escapeHtml(a.href)}">
          <div class="title">${escapeHtml(a.title)}</div>${a.desc ? `
          <div class="desc">${escapeHtml(a.desc)}</div>` : ''}
        </a>
      </li>`).join('\n') || '      <li class="empty">暂无文章</li>';

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT);
for (const e of fs.readdirSync(ROOT)) {
  if (SKIP.has(e) || e.startsWith('.')) continue;
  fs.cpSync(path.join(ROOT, e), path.join(OUT, e), { recursive: true });
}

const template = fs.readFileSync(path.join(ROOT, 'index.template.html'), 'utf8');
fs.writeFileSync(path.join(OUT, 'index.html'), template.replace('<!--ARTICLES-->', items));
console.log(`生成首页：${articles.length} 篇文章`);
articles.forEach((a) => console.log(`  - ${a.title}  ->  ${a.href}`));
