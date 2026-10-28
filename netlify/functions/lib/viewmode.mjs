// 文章页右上角的“中英对照 / 仅英文”切换按钮。
// 纯前端：给 <html> 加/去 en-only 类，用 CSS 隐藏所有译文元素；选择记在 localStorage 里，下次打开、翻页、
// 翻译进度自动刷新（会替换页面内容）都保持不变。按钮挂在 <html> 下而不是 <body>，不会被刷新替换掉。
//
// 译文元素的标记：通用对照排版 .zh；保留原样式 .zh-tr；PDF 文档版式 .dz（段落）、.zt（中文表格）、.zt-cap（表格标题）。
export const VIEWMODE_CSS = `
  html.en-only .zh, html.en-only .zh-tr, html.en-only .dz, html.en-only .zt, html.en-only .zt-cap { display: none !important; }
  #vm-toggle { all: initial; position: fixed; top: 10px; right: 10px; z-index: 2147483647; display: flex; overflow: hidden;
    border-radius: 8px; background: rgba(0,0,0,.72); font: 13px/1 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }
  #vm-toggle button { all: unset; box-sizing: border-box; padding: 8px 12px; color: #fff; cursor: pointer; white-space: nowrap; }
  #vm-toggle button.on { background: #007bff; }
`;

// 放在 <head> 里：页面显示之前就应用上次的选择，避免先闪出译文再消失
export const viewModeHeadScript = (nonce) =>
  `<script nonce="${nonce}">try{if(localStorage.getItem('viewMode')==='en')document.documentElement.classList.add('en-only')}catch(e){}</script>`;

// 放在 <body> 末尾：创建按钮
export const viewModeBodyScript = (nonce) => `<script nonce="${nonce}">
(function () {
  var KEY = 'viewMode';
  function get() { try { return localStorage.getItem(KEY) === 'en' ? 'en' : 'both'; } catch (e) { return 'both'; } }
  var box = document.createElement('div');
  box.id = 'vm-toggle';
  box.innerHTML = '<button type="button" data-m="both">中英对照</button><button type="button" data-m="en">仅英文</button>';
  function paint() {
    var m = get();
    document.documentElement.classList.toggle('en-only', m === 'en');
    [].forEach.call(box.querySelectorAll('button'), function (b) { b.className = b.getAttribute('data-m') === m ? 'on' : ''; });
  }
  box.addEventListener('click', function (e) {
    var m = e.target.getAttribute && e.target.getAttribute('data-m');
    if (!m) return;
    try { localStorage.setItem(KEY, m); } catch (err) { /* 无法保存时只在本页生效 */ }
    paint();
  });
  document.documentElement.appendChild(box);
  paint();
})();
</script>`;

// 已经有中文的文章（状态 skip）没有译文可切换，不显示按钮
export const showViewMode = (meta) => meta.status !== 'skip';
