/**
 * 打印渲染：把一个已装配好的 book 排成一叠静态页面（一页一张，430×560）
 *
 * 为什么单独一份而不是直接用 web/js/app.js：
 *   app.js 的数字全部挂在 PageFlip 上（绝对定位 + transform），打印会重影/裁切，
 *   所以它另建了 #print-root 副本。这里把那段逻辑原样搬出来，供无浏览器 UI 的
 *   路径（MCP → headless Chrome）复用。**pageHTML / colophonHTML 与 app.js 必须
 *   保持同构**，改书页结构时两处要一起改。
 *
 * 本文件刻意零 import：
 *   1) 正常路径：print.html 用 <script type="module"> 引它，book 从 ?book=<url> 取；
 *   2) 降级路径：mcp/server.mjs 把源码（去掉 export 关键字）内联进自包含 HTML，
 *      此时 book 由 window.__BOOK__ 直接给出，图片已是 data URL，无需联网。
 *
 * 就绪信号：document.fonts.ready + 每张图 decode 完成 + 两次 rAF 之后才把
 * <html data-print-ready="1">，并置 window.__PRINT_READY__。headless Chrome 靠
 * --virtual-time-budget 快进到这个状态再落盘，所以这里不要用长延时/动画。
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function imgTag(asset, cls = '') {
  if (!asset?.src) return '';
  const vars = [];
  if (asset.scale && asset.scale !== 1) vars.push(`--s:${asset.scale}`);
  if (asset.dy) vars.push(`--dy:${asset.dy}`);
  const s = vars.length ? ` style="${vars.join(';')}"` : '';
  // 打印副本一律 eager：懒加载的图不进视口就不解码，打出来是空白
  return `<img class="${cls}" src="${esc(asset.src)}" alt="${esc(asset.alt || '')}"${s} />`;
}

function propsHTML(props, stand) {
  if (!props?.length) return '';
  const cls = `${stand ? ` page__props--${stand}` : ''} page__props--n${props.length}`;
  return `<div class="page__props${cls}">${props.map((p) => imgTag(p)).join('')}</div>`;
}

export function pageHTML(page, book) {
  if (page.layout === 'cover') {
    const cv = page.cover || {};
    const kicker = cv.kicker || book.skeleton?.label || '';
    const title = cv.title || book.cover?.title || '';
    const sub = cv.subtitle || book.cover?.subtitle || '';
    const ribbon = cv.ribbon || '术前 · 故事';
    return `<div class="page page--cover cover--${esc(book.skeleton?.key || 'generic')}" data-density="hard">
      <div class="page__inner">
        <div class="page__cover-art">${imgTag(page.image)}</div>
        <div class="page__cover-veil"></div>
        <div class="page__cover-cast">${(page.props || []).map((p) => imgTag(p)).join('')}</div>
        <div class="page__cover-ribbon">${esc(ribbon)}</div>
        <div class="page__cover-plate">
          <h2 class="page__cover-title">${esc(title)}</h2>
          <span class="page__cover-kicker">${esc(kicker)}</span>
          <p class="page__cover-sub">${esc(sub)}</p>
        </div>
      </div>
    </div>`;
  }

  if (page.layout === 'checklist') {
    return `<div class="page page--checklist" data-density="hard">
      <div class="page__inner">
        <span class="page__cover-kicker" style="position:static;display:inline-block;margin-bottom:14px">还没有故事</span>
        <h2 class="cl-title" style="font-size:20px;line-height:1.5">${esc(page.title)}</h2>
        <p class="page__text" style="margin-top:16px;text-align:center;color:#6d5949">${esc(page.text)}</p>
        <div class="page__checklist-cast">${(page.props || []).map((p) => imgTag(p)).join('')}</div>
        <p class="page__text cl-questions__lead" style="margin-top:auto;text-align:center;font-size:10.5px;opacity:.75">翻到下一页：要确认的事实、要问医生的问题。</p>
      </div>
    </div>`;
  }

  if (page.layout === 'notes') {
    return `<div class="page page--notes" data-density="soft">
      <div class="page__inner">
        <h3 class="page__title" style="text-align:center">${esc(page.title)}</h3>
        <p class="page__text" style="text-align:center;font-size:11px;color:#8a7460;margin-top:6px">${esc(page.text)}</p>
        <div class="notes-lines" aria-hidden="true"></div>
      </div>
    </div>`;
  }

  if (page.layout === 'full') {
    const standCls = page.stand === 'high' ? ' page--stand-high' : '';
    return `<div class="page page--full${standCls}" data-density="soft">
      <div class="page__inner">
        <div class="page__img">${imgTag(page.image)}${propsHTML(page.props, page.stand)}</div>
        <div class="page__caption">
          <h3 class="page__title">${esc(page.title)}</h3>
          <p class="page__text">${esc(page.text)}</p>
        </div>
      </div>
    </div>`;
  }

  if (page.layout === 'badge') {
    return `<div class="page page--badge" data-density="soft">
      <div class="page__inner">
        <div class="badge-art">${imgTag(page.image)}</div>
        <div class="badge-name">${esc(page.badge?.name || '小勇士')}</div>
        <div class="badge-engrave">${esc(page.badge?.engrave || '')}</div>
        <p class="page__text badge-text">${esc(page.text)}</p>
      </div>
    </div>`;
  }

  // 便签 = 标签 + 值。值和标签重复（如「术前禁食 / 禁食6小时」）时只留值，别读两遍。
  const factLabel = page.fact?.label || '';
  const factValue = page.fact?.value || '';
  const factHTML = page.fact
    ? `<div class="page__fact">
         ${factLabel && factLabel !== factValue && !factValue.startsWith(factLabel)
      ? `<span class="page__fact-label">${esc(factLabel)}</span>`
      : ''}
         <span class="page__fact-value">${esc(factValue)}</span>
       </div>`
    : '';

  const imageHTML = `<div class="page__img page__img--h">${imgTag(page.image)}${propsHTML(page.props, page.stand)}</div>`;

  if (page.layout === 'image_left') {
    return `<div class="page page--imgleft" data-density="soft">
      <div class="page__inner">
        <h3 class="page__title">${esc(page.title)}</h3>
        <p class="page__text">${esc(page.text)}</p>
        ${factHTML}
        ${imageHTML}
      </div>
    </div>`;
  }

  return `<div class="page page--imgright" data-density="soft">
    <div class="page__inner">
      ${imageHTML}
      <h3 class="page__title">${esc(page.title)}</h3>
      <p class="page__text">${esc(page.text)}</p>
      ${factHTML}
    </div>
  </div>`;
}

export function colophonHTML(book) {
  const facts = Object.values(book.case?.facts || {});
  const emptyLine = '<li class="cl-empty">数值尚未确认 —— 逐项确认后，这里会按项列出，并标明来源。</li>';
  const rows = facts.length === 0 ? emptyLine : facts
    .map((f) => {
      const ev = Array.isArray(f.evidence) ? f.evidence.join(' / ') : f.evidence;
      const evLine = ev ? `原文：${esc(ev)}` : '来源：录入时逐项确认';
      return `<li class="cl-item">
        <span class="cl-label">${esc(f.label)}</span>
        <span class="cl-dots" aria-hidden="true"></span>
        <span class="cl-value">${esc(f.value_text || f.short)}</span>
        <span class="cl-ev">${evLine}</span>
      </li>`;
    })
    .join('');

  // 注意事项：原文照录，一个字不改
  const cauGroups = Array.isArray(book.cautions) ? book.cautions : [];
  const cautions = cauGroups
    .map((g) => `<div class="cl-cau-row">
        <span class="cl-cau-tag">${esc(g.label)}</span>
        <ul class="cl-cau-items">${g.items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
      </div>`)
    .join('');

  const qs = Array.isArray(book.questions) ? book.questions : [];
  const questions = qs.length
    ? `<div class="cl-questions">
        <h4 class="cl-cau-head">带去问医生的几件事</h4>
        <ul class="cl-q-list">${qs.map((q) => `<li>${esc(q.question)}</li>`).join('')}</ul>
      </div>`
    : '';

  const total = Math.max(facts.length, 1)
    + qs.length
    + cauGroups.reduce((n, g) => n + g.items.length, 0);
  const sparse = facts.length <= 2 && cauGroups.length <= 1;
  const dense = total > 6;
  const xdense = total > 10;

  return `<div class="page page--colophon${sparse ? ' is-sparse' : ''}${dense ? ' is-dense' : ''}${xdense ? ' is-xdense' : ''}" data-density="soft">
    <div class="page__inner">
      <div class="cl-head">
        <span class="cl-kicker">术前准备 · 陪护</span>
        <h3 class="cl-title">家长陪护说明</h3>
        <span class="cl-flourish" aria-hidden="true"></span>
      </div>
      <ul class="cl-list${facts.length === 0 ? ' cl-list--empty' : ''}">${rows}</ul>
      ${questions}
      ${cautions ? `<div class="cl-cautions"><h4 class="cl-cau-head">家长还要做的 · 原文照录</h4>${cautions}</div>` : ''}
      <p class="cl-note">陪护请对照上表落实术前准备；住院期间孩子如有不适，或您有任何疑问，请及时告知医护人员。</p>
    </div>
  </div>`;
}

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
