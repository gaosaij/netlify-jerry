// PDF 文字提取（在浏览器里用 pdf.js 完成，文件不会上传给服务器，只上传提取出的段落）
// 要去掉 PDF 支持：删除本文件，并删除 admin/index.html 里标注“PDF”的几处即可。
//
// 需要先加载 /admin/pdf-layout.js（段落还原算法，和服务器共用同一份）
(function (root, factory) {
  root.PdfExtract = factory(root);
})(this, function (root) {
  // 用 pdf.js 读取整个 PDF，返回 { title, blocks }
  async function extract(pdfjsLib, data, onProgress) {
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      pages.push({
        height: vp.height,
        items: content.items.filter((it) => typeof it.str === 'string').map((it) => ({
          str: it.str, x: it.transform[4], y: it.transform[5], w: it.width,
          h: Math.hypot(it.transform[2], it.transform[3]) || it.height,
        })),
      });
      if (onProgress) onProgress(n, pdf.numPages);
    }
    let title = '';
    try { title = ((await pdf.getMetadata()).info || {}).Title || ''; } catch { /* 没有元数据 */ }
    const blocks = root.PdfLayout.buildBlocks(pages).map(({ k, en }) => ({ k, en }));
    if (!title) { const h = blocks.find((b) => /^h[1-3]$/.test(b.k)); title = h ? h.en : ''; }
    return { title: title.trim(), blocks };
  }

  return { extract };
});
