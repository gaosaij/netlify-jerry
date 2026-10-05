// Netlify 构建脚本：扫描仓库里的文章，生成首页文章列表到 dist/
//   - articles/ 文件夹放文章：
//       *.html = 一篇文章，标题取文件名
//       *.md   = 一篇文章，构建时自动渲染成网页（样式见 article.template.html），标题取第一个 # 标题
//       子文件夹/index.html = 一篇文章（带页面的小工具），标题取 <title>
//   - 仓库根目录下的 *.html、*.md、子文件夹/index.html（如 options-calculator/）规则相同
//   - articles.json 可选，用来给某篇文章指定标题/简介，或用 "pin": true 置顶（key 为相对路径）
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { marked } = require('marked');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'dist');
const ARTICLES_DIR = 'articles';
const SKIP = new Set([
  '.git', '.github', '.netlify', '.claude', '.DS_Store', 'node_modules', 'dist',
  'netlify-deploy', 'build.js', 'netlify.toml', 'articles.json', 'index.template.html', 'article.template.html',
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
const urlPath = (rel) => '/' + rel.split('/').map(encodeURIComponent).join('/');

function addedTime(rel) {
  try {
    const lines = execFileSync('git', ['log', '--follow', '--diff-filter=A', '--format=%ct', '--', rel], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split('\n').filter(Boolean);
    return lines.length ? Number(lines[lines.length - 1]) : 0;
  } catch {
    return 0;
  }
}

function titleFor(rel, kind, name) {
  if (meta[rel] && meta[rel].title) return meta[rel].title;
  if (kind === 'md') {
    const h = fs.readFileSync(path.join(ROOT, rel), 'utf8').match(/^#\s+(.+?)\s*#*\s*$/m);
    if (h) return h[1].trim();
  }
  if (kind === 'dir') {
    const html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    if (m && m[1].trim()) return unescapeHtml(m[1].trim());
  }
  return name.replace(/\.(html|md)$/i, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

const articles = [];
function scan(base) {
  const dir = path.join(ROOT, base);
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    if (!base && (SKIP.has(e.name) || e.name === ARTICLES_DIR)) continue;
    const prefix = base ? `${base}/` : '';
    let rel, href, kind;
    if (e.isFile() && /\.html$/i.test(e.name) && e.name !== 'index.html') {
      rel = prefix + e.name; href = urlPath(rel); kind = 'file';
    } else if (e.isFile() && /\.md$/i.test(e.name)) {
      rel = prefix + e.name; href = urlPath(rel.replace(/\.md$/i, '.html')); kind = 'md';
    } else if (e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'index.html'))) {
      rel = `${prefix}${e.name}/index.html`; href = urlPath(prefix + e.name) + '/'; kind = 'dir';
    } else continue;
    articles.push({
      rel, href, kind,
      title: titleFor(rel, kind, e.name),
      desc: (meta[rel] && meta[rel].desc) || '',
      pinned: !!(meta[rel] && meta[rel].pin),
      added: addedTime(rel),
    });
  }
}
scan('');
scan(ARTICLES_DIR);

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
  if (SKIP.has(e) || e.startsWith('.') || /\.md$/i.test(e)) continue;
  fs.cpSync(path.join(ROOT, e), path.join(OUT, e), { recursive: true, filter: (src) => !/\.md$/i.test(src) });
}

const articleTemplate = fs.readFileSync(path.join(ROOT, 'article.template.html'), 'utf8');
for (const a of articles.filter((x) => x.kind === 'md')) {
  const body = marked.parse(fs.readFileSync(path.join(ROOT, a.rel), 'utf8'), { gfm: true })
    .replace(/(<img\b[^>]*\ssrc=")http:\/\//gi, '$1https://');
  const page = articleTemplate.replace('{{TITLE}}', escapeHtml(a.title)).replace('{{CONTENT}}', () => body);
  const outFile = path.join(OUT, a.rel.replace(/\.md$/i, '.html'));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, page);
}

const template = fs.readFileSync(path.join(ROOT, 'index.template.html'), 'utf8');
fs.writeFileSync(path.join(OUT, 'index.html'), template.replace('<!--ARTICLES-->', items));
console.log(`生成首页：${articles.length} 篇文章`);
articles.forEach((a) => console.log(`  - ${a.title}  ->  ${a.href}`));
