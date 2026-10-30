import { parseNotice, parseWithLLM } from '../engine/parse.mjs';
import { assembleBook } from '../engine/assemble.mjs';
import { validateBook } from '../engine/validate.mjs';

const $ = (s) => document.querySelector(s);

const state = {
  manifest: null,
  skeletons: {},
  samples: [],
  sampleIdx: 0,
  flip: null,
  book: null,
};

/* ---------------- 数据加载 ---------------- */

async function loadJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

async function boot() {
  const [manifest, skIndex] = await Promise.all([
    loadJSON('assets/manifest.json'),
    loadJSON('engine/skeletons/index.json'),
  ]);
  state.manifest = manifest;

  const entries = await Promise.all(
    Object.entries(skIndex).map(async ([k, file]) => [k, await loadJSON(`engine/skeletons/${file}`)])
  );
  state.skeletons = Object.fromEntries(entries);

  try {
    const idx = await loadJSON('data/books/index.json');
    state.samples = idx.books.map((b) => b.slug);
  } catch {
    state.samples = [];
  }

  await loadSample(0);

  $('#gen').addEventListener('click', () => generate($('#notice').value));
  $('#sample').addEventListener('click', () => loadSample(state.sampleIdx + 1));
  $('#prev').addEventListener('click', () => goPrev());
  $('#next').addEventListener('click', () => goNext());
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'ArrowLeft') goPrev();
    if (e.key === 'ArrowRight') goNext();
  });
}

/* ---------------- 封面/封底位姿：先挪书、停稳、再翻 ---------------- */

const POSE_GLIDE_MS = 900; // glide .8s + 100ms 停稳再翻，节拍：点-移-停-翻
let seqBusy = false;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const readerEl = () => document.querySelector('.reader');

// landscape 下封面（右半单页）/封底（左半单页）把可见单页挪到阅读区正中；portrait 不处理
function syncPose(pageIdx) {
  const flip = state.flip;
  if (!flip) return;
  if (pageIdx === undefined) pageIdx = flip.getCurrentPageIndex();
  const landscape = flip.getOrientation() === 'landscape';
  const last = flip.getPageCount() - 1;
  readerEl().classList.toggle('reader--cover', landscape && pageIdx === 0);
  readerEl().classList.toggle('reader--back', landscape && pageIdx === last);
}

// Detach flip layer: move .stf__block children (pages + 4 flip shadows) to .reader
// with position:fixed for the flip duration. Offsets come from --blkL/--blkT (block
// viewport origin, refreshed every flip). fixed boxes never grow document scroll;
// paint is identical. Restored on landing. Temp clones created mid-detach via
// parentElement.appendChild (e.g. portrait drags) are covered by the .reader.flip-on
// selector automatically and culled here so no orphans survive. A transparent
// .flip-catcher stays in the emptied block so PageFlip's mousedown/touchstart
// listeners (bound to .stf__block) keep receiving drag starts.
const flipStash = [];
function setFlipDetached(on) {
  const block = document.querySelector('#book .stf__block');
  const reader = document.querySelector('.reader');
  if (!block || !reader) return;
  if (on) {
    if (flipStash.length) return;
    const r = block.getBoundingClientRect();
    document.body.style.setProperty('--blkL', r.left + 'px');
    document.body.style.setProperty('--blkT', r.top + 'px');
    reader.classList.add('flip-on');
    [...block.children].forEach((el) => {
      flipStash.push(el);
      reader.appendChild(el);
    });
    const catcher = document.createElement('div');
    catcher.className = 'flip-catcher';
    block.appendChild(catcher);
  } else {
    if (!flipStash.length) return;
    reader.classList.remove('flip-on');
    block.querySelector('.flip-catcher')?.remove();
    [...reader.children].forEach((el) => {
      if (el.classList?.contains('stf__item') && !flipStash.includes(el)) el.remove();
    });
    flipStash.forEach((el) => {
      if (el.isConnected) block.appendChild(el);
    });
    flipStash.length = 0;
  }
}

async function goNext() {
  const flip = state.flip;
  if (!flip || seqBusy) return;
  if (readerEl().classList.contains('reader--cover')) {
    seqBusy = true;
    readerEl().classList.remove('reader--cover');
    await wait(POSE_GLIDE_MS);
    seqBusy = false;
    if (flip.getCurrentPageIndex() === 0) flip.flipNext();
    return;
  }
  flip.flipNext();
}

// 从封底往前翻：先向左挪书、停稳，再翻回（落在封面是翻完再往中挪，由 flip 事件处理）
async function goPrev() {
  const flip = state.flip;
  if (!flip || seqBusy) return;
  if (readerEl().classList.contains('reader--back')) {
    seqBusy = true;
    readerEl().classList.remove('reader--back');
    await wait(POSE_GLIDE_MS);
    seqBusy = false;
    if (flip.getCurrentPageIndex() === flip.getPageCount() - 1) flip.flipPrev();
    return;
  }
  flip.flipPrev();
}

async function loadSample(i) {
  if (!state.samples.length) { generate($('#notice').value || ''); return; }
  state.sampleIdx = ((i % state.samples.length) + state.samples.length) % state.samples.length;
  const slug = state.samples[state.sampleIdx];
  try {
    const txt = await (await fetch(`data/raw/${encodeURIComponent(slug)}.txt`)).text();
    $('#notice').value = txt;
  } catch { /* 原文缺失时用当前文本框内容 */ }
  generate($('#notice').value);
}

/* ---------------- 生成 ---------------- */

let generating = false;

async function generate(text) {
  if (generating) return;
  generating = true;
  const btn = $('#gen');
  const label = btn.textContent;
  btn.textContent = '正在缝…';

  try {
    let caseObj = await parseWithLLM(text).catch(() => null);
    if (!caseObj) caseObj = parseNotice(text);

    const book = assembleBook(caseObj, state.manifest, state.skeletons);
    const report = validateBook(book);

    state.book = book;
    renderFacts(caseObj, report);
    renderBook(book);
  } catch (err) {
    renderError(err);
  } finally {
    btn.textContent = label;
    generating = false;
  }
}

/* ---------------- 侧栏：事实与校验 ---------------- */

function renderFacts(caseObj, report) {
  const ul = $('#facts');
  ul.innerHTML = '';
  const facts = Object.values(caseObj.facts || {});

  for (const f of facts) {
    const li = document.createElement('li');
    li.className = 'fact';
    const ev = Array.isArray(f.evidence) ? f.evidence.join(' / ') : f.evidence;
    li.innerHTML = `
      <span class="fact__label">${escapeHTML(f.label)}</span>
      <span class="fact__value">${escapeHTML(f.value_text || f.short || '')}</span>
      <span class="fact__ev">原文：${escapeHTML(ev || '—')}</span>`;
    ul.appendChild(li);
  }

  for (const key of caseObj.missing || []) {
    const li = document.createElement('li');
    li.className = 'fact fact--missing';
    li.innerHTML = `
      <span class="fact__label">未取到</span>
      <span class="fact__value">${escapeHTML(missingName(key))}</span>
      <span class="fact__ev">对应页会自动跳过，绝不编造数字</span>`;
    ul.appendChild(li);
  }

  const el = $('#report');
  if (report.ok) {
    el.innerHTML = `<strong>事实保真校验通过</strong> · ${report.checked_pages} 页 · 每条数字均可溯源到原文`;
  } else {
    const bad = report.issues.filter((i) => i.level === 'error');
    el.innerHTML = `<span style="color:#b5573c">校验未通过 ${bad.length} 项</span>：${escapeHTML(bad[0].message)}`;
  }
}

function missingName(key) {
  return ({ procedure: '术式', fasting: '禁食时长', anesthesia: '麻醉方式', device: '手上装置', stay: '住院时长' })[key] || key;
}

function renderError(err) {
  $('#facts').innerHTML = `<li class="fact fact--missing"><span class="fact__label">装配失败</span><span class="fact__value">${escapeHTML(err.message)}</span><span class="fact__ev">换个支持的术式，或补充缺失字段</span></li>`;
  $('#report').textContent = '';
}

/* ---------------- 书页渲染 ---------------- */

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function imgTag(asset, cls = '') {
  if (!asset?.src) return '';
  return `<img class="${cls}" src="${asset.src}" alt="${escapeHTML(asset.alt || '')}" loading="lazy" />`;
}

function propsHTML(props) {
  if (!props?.length) return '';
  return `<div class="page__props">${props.map((p) => imgTag(p)).join('')}</div>`;
}

function pageHTML(page, book) {
  if (page.layout === 'cover') {
    return `<div class="page page--cover cover--${book.skeleton.key}" data-density="hard">
      <div class="page__inner">
        <div class="page__cover-art">${imgTag(page.image)}</div>
        <div class="page__cover-veil"></div>
        <div class="page__cover-cast">${(page.props || []).map((p) => imgTag(p)).join('')}</div>
        <div class="page__cover-ribbon">术前 · 故事</div>
        <div class="page__cover-plate">
          <span class="page__cover-kicker">${escapeHTML(book.skeleton.label)}</span>
          <h2 class="page__cover-title">${escapeHTML(book.cover.title)}</h2>
          <p class="page__cover-sub">${escapeHTML(book.cover.subtitle)}</p>
        </div>
      </div>
    </div>`;
  }

  if (page.layout === 'full') {
    const standCls = page.stand === 'high' ? ' page--stand-high' : '';
    return `<div class="page page--full${standCls}" data-density="soft">
      <div class="page__inner">
        <div class="page__img">${imgTag(page.image)}${propsHTML(page.props)}</div>
        <div class="page__caption">
          <h3 class="page__title">${escapeHTML(page.title)}</h3>
          <p class="page__text">${escapeHTML(page.text)}</p>
        </div>
      </div>
    </div>`;
  }

  if (page.layout === 'badge') {
    return `<div class="page page--badge" data-density="soft">
      <div class="page__inner">
        <div class="badge-art">${imgTag(page.image)}</div>
        <div class="badge-name">${escapeHTML(page.badge?.name || '小勇士')}</div>
        <div class="badge-engrave">${escapeHTML(page.badge?.engrave || '')}</div>
        <p class="page__text badge-text">${escapeHTML(page.text)}</p>
      </div>
    </div>`;
  }

  const factHTML = page.fact
    ? `<div class="page__fact">
         <span class="page__fact-label">${escapeHTML(page.fact.label)}</span>
         <span class="page__fact-value">${escapeHTML(page.fact.value)}</span>
       </div>`
    : '';

  const imageHTML = `<div class="page__img page__img--h">${imgTag(page.image)}${propsHTML(page.props)}</div>`;

  if (page.layout === 'image_left') {
    return `<div class="page page--imgleft" data-density="soft">
      <div class="page__inner">
        <h3 class="page__title">${escapeHTML(page.title)}</h3>
        <p class="page__text">${escapeHTML(page.text)}</p>
        ${factHTML}
        ${imageHTML}
      </div>
    </div>`;
  }

  return `<div class="page" data-density="soft">
    <div class="page__inner">
      ${imageHTML}
      <h3 class="page__title">${escapeHTML(page.title)}</h3>
      <p class="page__text">${escapeHTML(page.text)}</p>
      ${factHTML}
    </div>
  </div>`;
}

function colophonHTML(book) {
  const rows = Object.values(book.case.facts || {})
    .map((f) => {
      const ev = Array.isArray(f.evidence) ? f.evidence.join(' / ') : f.evidence;
      return `<li><b>${escapeHTML(f.label)}</b> · ${escapeHTML(f.value_text || f.short)}<br><span style="opacity:.7">原文：${escapeHTML(ev || '—')}</span></li>`;
    })
    .join('');

  return `<div class="page page--colophon" data-density="soft">
    <div class="page__inner">
      <h3 class="page__title" style="text-align:center">家长陪护说明</h3>
      <ul class="colophon-list">${rows}</ul>
      <p class="page__text" style="text-align:center;margin-top:10px;font-size:11px">陪护请对照上表落实术前准备；住院期间孩子如有不适，或您有任何疑问，请及时告知医护人员。</p>
    </div>
  </div>`;
}

function renderBook(book) {
  setFlipDetached(false); // 换病例时若正处翻页先把搬走的节点送回去避免孤儿
  if (state.flip) { try { state.flip.destroy(); } catch {} state.flip = null; }

  // PageFlip.destroy() 会把宿主节点一起摘掉，换病例时重建一个新的
  const reader = document.querySelector('.reader');
  document.getElementById('book')?.remove();
  const host = document.createElement('div');
  host.className = 'book';
  host.id = 'book';
  reader.insertBefore(host, reader.querySelector('.reader__bar'));

  const frag = document.createDocumentFragment();
  for (const p of book.pages) frag.appendChild(el(pageHTML(p, book)));
  frag.appendChild(el(colophonHTML(book)));
  host.appendChild(frag);

  // 封面守卫：封面位姿下接管一切指针手势，先挪书、停稳、再自动翻开，
  // 与按钮/键盘手感一致；挪开后守卫自动隐藏，书内翻页恢复 PageFlip 直接操控。
  const guard = document.createElement('div');
  guard.className = 'cover-guard';
  guard.addEventListener('mousedown', (e) => { if (e.button !== 0) return; e.preventDefault(); goNext(); });
  let gY = 0, gT = 0;
  guard.addEventListener('touchstart', (e) => { const t = e.changedTouches[0]; gY = t.clientY; gT = Date.now(); }, { passive: true });
  guard.addEventListener('touchend', (e) => {
    const t = e.changedTouches[0];
    if (Math.abs(t.clientY - gY) < 10 && Date.now() - gT < 400) { e.preventDefault(); goNext(); }
  });
  host.appendChild(guard);

  const pages = host.querySelectorAll('.page');
  const flip = new St.PageFlip(host, {
    width: 430,
    height: 560,
    size: 'stretch',
    minWidth: 300,
    maxWidth: 460,
    minHeight: 390,
    maxHeight: 599,
    showCover: true,
    usePortrait: true,
    drawShadow: true,
    maxShadowOpacity: 0.32,
    flippingTime: 820,
    mobileScrollSupport: true,
  });
  flip.loadFromHTML(pages);
  state.flip = flip;
  flip.on('flip', (e) => {
    const i = e.data;
    const total = book.pages.length + 1;
    $('#pageinfo').textContent = i === 0 ? '封面' : `${i + 1} / ${total}`;
    setFlipDetached(false);
    syncPose(i); // 落在封面/封底：翻完再往中间挪
  });
  flip.on('changeState', (e) => {
    const s = e.data;
    if (s === 'flipping' || s === 'user_fold' || s === 'fold_corner') {
      setFlipDetached(true); // 书页/阴影不再撑大 scrollHeight绘制位置不变
      const c = flip.getCurrentPageIndex();
      if (s === 'flipping') {
        if (c === 0) reader.classList.remove('reader--cover');
        if (c === flip.getPageCount() - 1) reader.classList.remove('reader--back');
      }
    } else if (s === 'read') {
      setFlipDetached(false);
      syncPose(); // 兜住被取消的手动折页
    }
  });
  flip.on('changeOrientation', () => syncPose());
  flip.on('init', (e) => syncPose(e.data?.page ?? 0));
  syncPose(0);
  $('#pageinfo').textContent = '封面';

  // ?page=N 直接翻到某页（演示/截图用）
  const want = Number(new URLSearchParams(location.search).get('page'));
  if (want > 0 && want < book.pages.length + 1) {
    setTimeout(() => { try { flip.turnToPage(want); } catch {} }, 60);
  }
}

function escapeHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

boot().catch((e) => {
  console.error(e);
  $('#report').textContent = `初始化失败：${e.message}`;
});
