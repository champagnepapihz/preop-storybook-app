import { assembleBook } from '../engine/assemble.mjs';
import { composeCase, findProcedure } from '../engine/compose.mjs';
import { validateBook, auditCase } from '../engine/validate.mjs';

const $ = (s) => document.querySelector(s);

const state = {
  manifest: null,
  skeletons: {},
  catalog: null,
  presets: [],
  presetIdx: 0,
  flip: null,
  book: null,
  modules: null,
  demoIdx: -1,
  pageHeight: 0,
};

/* ---------------- 数据加载 ---------------- */

async function loadJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

async function boot() {
  const [manifest, skIndex, catalog, modules] = await Promise.all([
    loadJSON('assets/manifest.json'),
    loadJSON('engine/skeletons/index.json'),
    loadJSON('engine/catalog.json'),
    loadJSON('engine/modules.json'),
  ]);
  state.manifest = manifest;
  state.catalog = catalog;
  state.modules = modules;

  const entries = await Promise.all(
    Object.entries(skIndex).map(async ([k, file]) => [k, await loadJSON(`engine/skeletons/${file}`)])
  );
  state.skeletons = Object.fromEntries(entries);

  state.presets = catalog.presets || [];
  buildPicker();

  $('#gen').addEventListener('click', () => generate());
  $('#sample').addEventListener('click', () => applyDemo(1));
  $('#new').addEventListener('click', () => startNewCase());
  $('#prev').addEventListener('click', () => goPrev());
  $('#next').addEventListener('click', () => goNext());
  document.addEventListener('keydown', (e) => {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
    if (e.key === 'ArrowLeft') goPrev();
    if (e.key === 'ArrowRight') goNext();
  });

  // 窗口尺寸变了，页面被 PageFlip 重算，立牌基准跟着更新（防抖，翻页时不参与）
  window.addEventListener('resize', schedulePageHeightSync);

  // 默认：不预填任何东西，书位显示"待选"卡片。
  // 只有 ?case=N（演示/回归）或点「换个病例」才会填入具体值。
  const raw = new URLSearchParams(location.search).get('case');
  if (raw !== null) {
    const n = Number(raw);
    applyPreset(Number.isFinite(n) && n > 0 ? n : 0);
  } else {
    renderIdle();
  }
}

/* ---------------- 空白态 ---------------- */

function renderIdle(hint) {
  setFlipDetached(false);
  if (state.flip) { try { state.flip.destroy(); } catch {} state.flip = null; }
  state.book = null;

  const reader = document.querySelector('.reader');
  document.getElementById('book')?.remove();
  const host = document.createElement('div');
  host.className = 'book book--idle';
  host.id = 'book';
  host.innerHTML = `<div class="page page--checklist" data-density="hard">
    <div class="page__inner">
      <span class="page__cover-kicker" style="position:static;display:inline-block;margin-bottom:14px">还没有选病例</span>
      <h2 class="cl-title" style="font-size:19px;line-height:1.55">从左边选一个病种开始</h2>
      <p class="page__text" style="margin-top:16px;text-align:center;color:#6d5949">
        科室 → 病种 → 术式，再逐项确认麻醉、禁食、住院和留置针。<br />填了什么就出现什么，没填的不会出现在书里。
      </p>
      <p class="page__text" style="margin-top:auto;text-align:center;font-size:10.5px;opacity:.75">
        想先看一眼成品？点「换个病例」。
      </p>
    </div>
  </div>`;
  reader.insertBefore(host, reader.querySelector('.reader__bar'));

  const info = $('#pageinfo');
  if (info) info.textContent = '未选择';
  const st = $('#status');
  st.className = 'status status--idle';
  st.innerHTML = '<span class="status__chip">未开始</span><span class="status__text">选择科室、病种、术式后生成</span>';
  $('#audit').innerHTML = hint ? `<li class="audit__item audit__item--warn">${escapeHTML(hint)}</li>` : '';
  $('#audit').style.display = hint ? '' : 'none';
  $('#report').textContent = '';
}

/* ---------------- 选择器（受控词表） ---------------- */

function opt(value, label) {
  return `<option value="${escapeHTML(value)}">${escapeHTML(label)}</option>`;
}

function buildPicker() {
  const c = state.catalog;

  // 科室 → 病种 → 术式：三级都从「未选择」开始，
  // 不存在任何默认值 —— 每一项都必须有人亲手选一次，才算确认。
  $('#f-dept').innerHTML = opt('', '未选择') + c.departments.map((d) => opt(d.id, d.label)).join('');
  $('#f-dept').addEventListener('change', () => { fillGroups(false); });
  $('#f-group').addEventListener('change', () => { fillProcedures(false); });

  // 麻醉：默认"未确认"
  $('#f-anes').innerHTML = opt('', '未确认') + c.anesthesia.map((a) => opt(a.id, a.label)).join('');

  // 数字一律不预填：0-24 小时 / 0-10 天
  const hours = (id) => {
    const el = $(id);
    el.innerHTML = opt('', '未确认');
    for (let i = 0; i <= 24; i++) el.innerHTML += opt(String(i), `${i} 小时`);
  };
  hours('#f-fast');
  hours('#f-liquid');

  const stay = $('#f-stay');
  stay.innerHTML = opt('', '未确认');
  for (let i = 0; i <= 10; i++) stay.innerHTML += opt(String(i), `${i} 天`);

  // 留置针：确认"有"和确认"没有"都算确认，只有"未确认"才进缺口
  $('#f-device').innerHTML = opt('', '未确认')
    + opt('iv', '会留一只')
    + opt('none', '不留');

  fillGroups(false);
}

function fillGroups() {
  const dept = state.catalog.departments.find((d) => d.id === $('#f-dept').value);
  const groups = dept?.groups || [];
  $('#f-group').innerHTML = opt('', groups.length ? '未选择' : '—') + groups.map((g) => opt(g.id, g.label)).join('');
  fillProcedures();
}

function fillProcedures() {
  const dept = state.catalog.departments.find((d) => d.id === $('#f-dept').value);
  const group = (dept?.groups || []).find((g) => g.id === $('#f-group').value);
  const procs = group?.procedures || [];
  $('#f-proc').innerHTML = opt('', procs.length ? '未选择' : '—')
    + procs.map((p) => opt(p.id, p.label + (p.skeleton ? '' : '（暂无故事）'))).join('');
}

function selectProcedure(id) {
  const found = findProcedure(state.catalog, id);
  if (!found) return;
  $('#f-dept').value = found.dept.id;
  fillGroups();
  $('#f-group').value = found.group.id;
  fillProcedures();
  $('#f-proc').value = id;
}

/** 清空整个表单（回到"什么都没确认"的状态） */
function resetForm() {
  $('#f-dept').value = '';
  fillGroups();
  $('#f-name').value = '';
  $('#f-age').value = '';
  $('#f-gender').value = '';
  $('#f-anes').value = '';
  $('#f-fast').value = '';
  $('#f-liquid').value = '';
  $('#f-stay').value = '';
  $('#f-device').value = '';
}

const demoList = () => (state.presets || []).filter((p) => p.demo === 'complete');

/** 「换个病例」：只在三份完整病例之间循环，草稿 / 清单形态用 ?case=N 单独看 */
function applyDemo(step = 1) {
  const list = demoList();
  if (!list.length) return;
  const n = list.length;
  state.demoIdx = ((state.demoIdx + step) % n + n) % n;
  applyPresetByObject(list[state.demoIdx]);
  state.presetIdx = state.presets.indexOf(list[state.demoIdx]);
}

/** 「新建病例」：回到什么都没确认的状态，下一次「换个病例」从第一份开始 */
function startNewCase() {
  resetForm();
  state.demoIdx = -1;
  state.presetIdx = 0;
  renderIdle();
}

/** 演示病例：这是唯一的"预填"来源，用于演示与回归 */
function applyPreset(i) {
  if (!state.presets.length) return;
  state.presetIdx = ((i % state.presets.length) + state.presets.length) % state.presets.length;
  const p = state.presets[state.presetIdx];
  const idx = demoList().indexOf(p);   // 从 ?case=N 进来时，把演示游标对齐到这一本
  if (idx >= 0) state.demoIdx = idx;
  applyPresetByObject(p);
}

function applyPresetByObject(p) {
  selectProcedure(p.procedure);
  $('#f-name').value = p.name || '';
  $('#f-age').value = p.age ?? '';
  $('#f-gender').value = p.gender || '';
  $('#f-anes').value = p.anesthesia || '';
  $('#f-fast').value = p.fasting == null ? '' : String(p.fasting);
  $('#f-liquid').value = p.liquid == null ? '' : String(p.liquid);
  $('#f-stay').value = p.stay == null ? '' : String(p.stay);
  $('#f-device').value = (p.devices && p.devices[0]) || '';

  generate();
}

/* ---------------- 生成 ---------------- */

let generating = false;

function readForm() {
  const num = (v) => (v === '' ? null : Number(v));
  return {
    procedureId: $('#f-proc').value,
    childName: $('#f-name').value.trim(),
    gender: $('#f-gender').value || null,
    age: num($('#f-age').value),
    anesthesiaId: $('#f-anes').value || null,
    fastingHours: num($('#f-fast').value),
    liquidHours: num($('#f-liquid').value),
    stayDays: num($('#f-stay').value),
    devices: $('#f-device').value ? [$('#f-device').value] : [],
  };
}

async function generate() {
  if (generating) return;
  generating = true;
  const btn = $('#gen');
  const label = btn.textContent;
  btn.textContent = '正在缝…';

  try {
    const form = readForm();
    if (!form.procedureId) {
      renderIdle('请先选择科室、病种和术式 —— 这三项都不是默认值。');
      return;
    }
    const caseObj = composeCase({ catalog: state.catalog, ...form });
    const book = assembleBook(caseObj, state.manifest, state.skeletons, state.modules);
    const report = validateBook(book);

    state.book = book;
    renderStatus(caseObj, book, report);
    renderBook(book);
  } catch (err) {
    renderError(err);
  } finally {
    btn.textContent = label;
    generating = false;
  }
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

/* ---------------- 侧栏：事实与校验 ---------------- */

function renderStatus(caseObj, book, report) {
  const VERSION_LABEL = { confirmed: '已确认', draft: '草稿', checklist: '清单' };
  const st = $('#status');
  st.className = `status status--${book.version}`;
  st.innerHTML = `<span class="status__chip">${VERSION_LABEL[book.version] || book.version}</span>
    <span class="status__text">${book.mode === 'checklist'
      ? `${book.pages.length + 1} 面 · 这类术式还没有专属故事，只出事实与注意事项`
      : book.stats.draft_pages
        ? `${book.pages.length + 1} 面 · 其中 ${book.stats.draft_pages} 页是“如果……”`
        : `${book.pages.length + 1} 面 · 事实齐全，无“如果……”页`}</span>`;

  // 缺口：只列"未确认"，不猜
  const audit = $('#audit');
  const notes = auditCase(caseObj);
  const gaps = (caseObj.missing || []).map((k) => missingName(k));
  const items = [];
  if (gaps.length) items.push(`<li class="audit__item audit__item--warn">未确认：${gaps.map(escapeHTML).join('、')} —— 书里只会出现“如果……”，不出现数字</li>`);
  for (const n of notes) items.push(`<li class="audit__item audit__item--${n.level}">${escapeHTML(n.text)}</li>`);
  audit.innerHTML = items.join('');
  audit.style.display = items.length ? '' : 'none';

  const el2 = $('#report');
  if (report.ok) {
    el2.innerHTML = `<strong>校验通过</strong> · ${report.checked_pages + 1} 面 · 事实逐项来自你的确认，注意事项来自词表`;
  } else {
    const bad = report.issues.filter((i) => i.level === 'error');
    el2.innerHTML = `<span style="color:#b5573c">校验未通过 ${bad.length} 项</span>：${escapeHTML(bad[0].message)}`;
  }
}

function missingName(key) {
  return ({ procedure: '术式', fasting: '禁食时长', anesthesia: '麻醉方式', device: '留置针', stay: '住院时长' })[key] || key;
}

function renderError(err) {
  $('#status').className = 'status status--draft';
  $('#status').innerHTML = '<span class="status__chip">未能生成</span>';
  $('#audit').innerHTML = `<li class="audit__item audit__item--warn">${escapeHTML(err.message)}</li>`;
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
  const s = asset.scale && asset.scale !== 1 ? ` style="--s:${asset.scale}"` : '';
  return `<img class="${cls}" src="${asset.src}" alt="${escapeHTML(asset.alt || '')}" loading="lazy"${s} />`;
}

function propsHTML(props, stand) {
  if (!props?.length) return '';
  const cls = `${stand ? ` page__props--${stand}` : ''} page__props--n${props.length}`;
  return `<div class="page__props${cls}">${props.map((p) => imgTag(p)).join('')}</div>`;
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

  if (page.layout === 'checklist') {
    return `<div class="page page--checklist" data-density="hard">
      <div class="page__inner">
        <span class="page__cover-kicker" style="position:static;display:inline-block;margin-bottom:14px">还没有故事</span>
        <h2 class="cl-title" style="font-size:20px;line-height:1.5">${escapeHTML(page.title)}</h2>
        <p class="page__text" style="margin-top:16px;text-align:center;color:#6d5949">${escapeHTML(page.text)}</p>
        <div class="page__checklist-cast">${(page.props || []).map((p) => imgTag(p)).join('')}</div>
        <p class="page__text cl-questions__lead" style="margin-top:auto;text-align:center;font-size:10.5px;opacity:.75">翻到下一页：要确认的事实、要问医生的问题。</p>
      </div>
    </div>`;
  }

  if (page.layout === 'notes') {
    return `<div class="page page--notes" data-density="soft">
      <div class="page__inner">
        <h3 class="page__title" style="text-align:center">${escapeHTML(page.title)}</h3>
        <p class="page__text" style="text-align:center;font-size:11px;color:#8a7460;margin-top:6px">${escapeHTML(page.text)}</p>
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

  const imageHTML = `<div class="page__img page__img--h">${imgTag(page.image)}${propsHTML(page.props, page.stand)}</div>`;

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
  const facts = Object.values(book.case.facts || {});
  const emptyLine = '<li class="cl-empty">数值尚未确认 —— 逐项确认后，这里会按项列出，并标明来源。</li>';
  const rows = facts.length === 0 ? emptyLine : facts
    .map((f) => {
      const ev = Array.isArray(f.evidence) ? f.evidence.join(' / ') : f.evidence;
      const evLine = ev ? `原文：${escapeHTML(ev)}` : '来源：录入时逐项确认';
      return `<li class="cl-item">
        <span class="cl-label">${escapeHTML(f.label)}</span>
        <span class="cl-dots" aria-hidden="true"></span>
        <span class="cl-value">${escapeHTML(f.value_text || f.short)}</span>
        <span class="cl-ev">${evLine}</span>
      </li>`;
    })
    .join('');

  // 注意事项：原文照录，一个字不改。这一类内容不接受任何"合理改写"。
  const cauGroups = Array.isArray(book.cautions) ? book.cautions : [];
  const cautions = cauGroups
    .map((g) => `<div class="cl-cau-row">
        <span class="cl-cau-tag">${escapeHTML(g.label)}</span>
        <ul class="cl-cau-items">${g.items.map((t) => `<li>${escapeHTML(t)}</li>`).join('')}</ul>
      </div>`)
    .join('');

  // 草稿书：把"还没确认的事"变成带去问医生的问题（只问事实，不制造预期）
  const qs = Array.isArray(book.questions) ? book.questions : [];
  const questions = qs.length
    ? `<div class="cl-questions">
        <h4 class="cl-cau-head">带去问医生的几件事</h4>
        <ul class="cl-q-list">${qs.map((q) => `<li>${escapeHTML(q.question)}</li>`).join('')}</ul>
      </div>`
    : '';

  const sparse = facts.length <= 2 && cauGroups.length <= 1;
  const dense = facts.length + cauGroups.reduce((n, g) => n + g.items.length, 0) > 6;

  return `<div class="page page--colophon${sparse ? ' is-sparse' : ''}${dense ? ' is-dense' : ''}" data-density="soft">
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

let phResizeTimer = 0;
function schedulePageHeightSync() {
  clearTimeout(phResizeTimer);
  phResizeTimer = setTimeout(() => {
    const host = document.getElementById('book');
    const el = host?.querySelector('.page');
    const h = Math.round(el?.clientHeight || 0);
    if (h > 0) document.documentElement.style.setProperty('--ph', `${h}px`);
    state.pageHeight = h;
  }, 260);
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

  // 立牌尺寸以「整页高度」为单位：把实际页高写进 --ph，比例才不会受图片区高度影响。
  //
  // 只在两件事发生时重算：换书、窗口尺寸变化。绝不在翻页过程中重算 ——
  // PageFlip 翻页时会对页面做 detach / 重排，页高瞬时抖动一次，
  // 若跟着重算，所有立牌会按新值缩放，看起来就是「翻页时人物抽动一下」。
  // 变量写在 :root —— 翻页时 PageFlip 会把页面元素临时搬到 .reader 下，
  // 若变量挂在 #book 上，搬出去的瞬间就继承不到，立牌回落到 560px 默认值，
  // 于是「翻页时人物抽动一下」。挂在根节点上，搬到哪儿都还是同一个基准。
  const syncPageHeight = () => {
    const el = host.querySelector('.page');
    const h = Math.round(el?.clientHeight || 0);   // 取整：clientHeight 可能是 509.015625，避免亚像素抖动
    if (h > 0 && h !== state.pageHeight) {
      state.pageHeight = h;
      document.documentElement.style.setProperty('--ph', `${h}px`);
    }
  };
  state.pageHeight = 0;
  syncPageHeight();
  requestAnimationFrame(syncPageHeight);   // PageFlip 定尺寸可能晚一帧
  setTimeout(syncPageHeight, 120);

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
