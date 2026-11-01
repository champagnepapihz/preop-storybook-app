/**
 * 书页渲染：翻页阅读器（js/app.js）与打印副本（print-render.mjs）共用这一份。
 *
 * 为什么合并：这两处原本各有一份 pageHTML / colophonHTML，差异只有转义函数名和
 * 懒加载属性，却必须"改一处、记得改另一处"。留置针那次修复就是被这个结构拖成
 * 两个提交。现在只有一份，改版面只改这里。
 *
 * 本文件必须保持零 import：mcp/server.mjs 的降级路径会把它的源码去 export 后
 * 内联进自包含 HTML，一旦它自己 import 别的东西，那条路就断了。
 */

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * 图片标签。lazy=true 用于阅读器（进视口才加载）；打印副本必须 eager ——
 * 懒加载的图不在视口里就不解码，打出来是空白。
 */
export function imgTag(asset, cls = '', { lazy = false } = {}) {
  if (!asset?.src) return '';
  const vars = [];
  if (asset.scale && asset.scale !== 1) vars.push(`--s:${asset.scale}`);
  if (asset.dy) vars.push(`--dy:${asset.dy}`);
  const s = vars.length ? ` style="${vars.join(';')}"` : '';
  return `<img class="${cls}" src="${esc(asset.src)}" alt="${esc(asset.alt || '')}"${lazy ? ' loading="lazy"' : ''}${s} />`;
}

export function propsHTML(props, stand, opts = {}) {
  if (!props?.length) return '';
  const cls = `${stand ? ` page__props--${stand}` : ''} page__props--n${props.length}`;
  return `<div class="page__props${cls}">${props.map((p) => imgTag(p, '', opts)).join('')}</div>`;
}

export function pageHTML(page, book, opts = {}) {
  // 图片标签按调用方选择懒加载（阅读器要懒，打印必须 eager）
  const img = (a, c) => imgTag(a, c, opts);
  if (page.layout === 'cover') {
    // 清单书没有骨架，封面文案由页面自带；故事书沿用骨架的 cover
    const cv = page.cover || {};
    const kicker = cv.kicker || book.skeleton?.kicker || book.skeleton?.label || '';
    const title = cv.title || book.cover?.title || '';
    const sub = cv.subtitle || book.cover?.subtitle || '';
    const ribbon = cv.ribbon || '术前 · 故事';
    return `<div class="page page--cover cover--${esc(book.skeleton?.key || 'generic')}" data-density="hard">
      <div class="page__inner">
        <div class="page__cover-art">${img(page.image)}</div>
        <div class="page__cover-veil"></div>
        <div class="page__cover-cast">${(page.props || []).map((p) => img(p)).join('')}</div>
        <div class="page__cover-ribbon">${esc(ribbon)}</div>
        <div class="page__cover-plate">
          <h2 class="page__cover-title">${esc(title)}</h2>
          <span class="page__cover-kicker">${esc(kicker)}</span>
          <p class="page__cover-sub">${esc(sub)}</p>
        </div>
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
        <div class="page__img">${img(page.image)}${propsHTML(page.props, page.stand, opts)}</div>
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
        <div class="badge-art">${img(page.image)}</div>
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

  const imageHTML = `<div class="page__img page__img--h">${img(page.image)}${propsHTML(page.props, page.stand, opts)}</div>`;

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

  // 注意事项：原文照录，一个字不改。这一类内容不接受任何"合理改写"。
  const cauGroups = Array.isArray(book.cautions) ? book.cautions : [];
  const cautions = cauGroups
    .map((g) => `<div class="cl-cau-row">
        <span class="cl-cau-tag">${esc(g.label)}</span>
        <ul class="cl-cau-items">${g.items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
      </div>`)
    .join('');

  // 草稿书：把"还没确认的事"变成带去问医生的问题（只问事实，不制造预期）
  const qs = Array.isArray(book.questions) ? book.questions : [];
  const questions = qs.length
    ? `<div class="cl-questions">
        <h4 class="cl-cau-head">带去问医生的几件事</h4>
        <ul class="cl-q-list">${qs.map((q) => `<li>${esc(q.question)}</li>`).join('')}</ul>
      </div>`
    : '';

  // 版面压力按「行数」算：事实行（无事实时算占位那一行）+ 提问行 + 注意事项条目
  const total = Math.max(facts.length, 1)
    + qs.length
    + cauGroups.reduce((n, g) => n + g.items.length, 0);
  const sparse = facts.length <= 2 && cauGroups.length <= 1;
  const dense = total > 6;
  const xdense = total > 10;   // 条目特别多时再压一档，避免页脚被挤出去

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
