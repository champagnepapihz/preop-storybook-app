/**
 * 打印渲染：把一个已装配好的 book 排成一叠静态页面（一页一张，430×560）
 *
 * 为什么单独一份而不是直接用 web/js/app.js：
 *   app.js 的数字全部挂在 PageFlip 上（绝对定位 + transform），打印会重影/裁切，
 *   所以它另建了 #print-root 副本，把装配好的书排成一叠静态页。
 *   书页结构本身（pageHTML / colophonHTML）在 js/book-render.mjs，与阅读器共用一份。
 *
 * 为什么只 import 一个模块：
 *   1) 正常路径：print.html 用 <script type="module"> 引它，book 从 ?book=<url> 取；
 *   2) 降级路径：mcp/server.mjs 把 book-render.mjs 与本文（去掉 export/import 行）
 *      按顺序内联进自包含 HTML，此时 book 由 window.__BOOK__ 给出，图片已是 data URL。
 *
 * 就绪信号：document.fonts.ready + 每张图 decode 完成 + 两次 rAF 之后才把
 * <html data-print-ready="1">，并置 window.__PRINT_READY__。headless Chrome 靠
 * --virtual-time-budget 快进到这个状态再落盘，所以这里不要用长延时/动画。
 */

import { pageHTML, colophonHTML } from './js/book-render.mjs';






/** 一页一张 .print-sheet：book.pages + 封底（家长陪护说明） */
export function buildSheetHTML(book) {
  return [...(book.pages || []).map((p) => pageHTML(p, book)), colophonHTML(book)];
}

/* ---------------- 图片内联：打印是同步快照，不能有"还没下载完"的图 ---------------- */

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function inlineImages(root) {
  const imgs = [...root.querySelectorAll('img')];
  await Promise.all(imgs.map(async (img) => {
    const src = img.getAttribute('src');
    if (!src || src.startsWith('data:')) return;
    try {
      const r = await fetch(src);
      if (!r.ok) return;
      const type = r.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
      img.src = `data:${type};base64,${toBase64(await r.arrayBuffer())}`;
    } catch { /* 拿不到就保留原 src，不因为一张图卡死整本书 */ }
  }));
  await Promise.all(imgs.map((i) => new Promise((res) => {
    if (i.complete && i.naturalWidth) return res();
    i.onload = i.onerror = res;
  })));
}

function fail(msg) {
  document.documentElement.dataset.printReady = 'error';
  window.__PRINT_ERROR__ = msg;
  document.title = 'ERROR';
  const box = document.createElement('pre');
  box.id = 'print-error';
  box.style.cssText = 'position:absolute;top:0;left:0;right:0;z-index:99;margin:0;padding:12px;'
    + 'background:#fff3f0;color:#a33;font:12px/1.6 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap';
  box.textContent = `打印渲染失败：${msg}`;
  document.body.appendChild(box);
}

/**
 * @param {{book?:object}} [opts] 不传则从 window.__BOOK__ 或 ?book=<url> 取
 */
export async function mountPrint(opts = {}) {
  try {
    let book = opts.book || window.__BOOK__;
    if (!book) {
      const src = new URLSearchParams(location.search).get('book');
      if (!src) throw new Error('缺少 book：请用 ?book=<url> 指定，或在页面里先置 window.__BOOK__');
      const r = await fetch(src, { cache: 'no-store' });
      if (!r.ok) throw new Error(`取 book 失败：${src} → HTTP ${r.status}`);
      book = await r.json();
    }
    if (!Array.isArray(book.pages) || !book.pages.length) throw new Error('book.pages 为空，没有可打印的页面');

    const root = document.getElementById('print-root') || (() => {
      const d = document.createElement('div');
      d.id = 'print-root';
      document.body.appendChild(d);
      return d;
    })();

    root.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const html of buildSheetHTML(book)) {
      const sheet = document.createElement('div');
      sheet.className = 'print-sheet';
      sheet.innerHTML = html;
      frag.appendChild(sheet);
    }
    root.appendChild(frag);
    root.dataset.bookId = book.book_id || '';

    // 面数自检：一页 book.pages + 一张封底，多一张少一张都是渲染层出问题，
    // 别等到"PDF 少一页"再回头找原因（服务端还会再核一次 PDF 的真实页数）。
    const expected = (book.pages || []).length + 1;
    const sheets = root.querySelectorAll('.print-sheet').length;
    if (sheets !== expected) throw new Error(`打印面数不符：book.pages(${book.pages.length}) + 封底 1 = ${expected}，实际 ${sheets}`);

    // 文件名：打印/存 PDF 时浏览器用 document.title 命名
    const title = String(book.cover?.title || book.pages[0]?.title || '术前绘本').replace(/[《》]/g, '');
    document.title = title;

    await inlineImages(root);
    if (document.fonts?.ready) await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    document.documentElement.dataset.printReady = '1';
    window.__PRINT_READY__ = true;
    window.__PRINT_SHEETS__ = root.querySelectorAll('.print-sheet').length;
    return { sheets: window.__PRINT_SHEETS__, title };
  } catch (e) {
    fail(e?.message || String(e));
    throw e;
  }
}
