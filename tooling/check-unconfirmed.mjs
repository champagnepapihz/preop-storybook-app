/**
 * 回归：只给术式、四个事实一个都不选时，书里到底出现了什么。
 *
 * 盯的是一条产品原则：未确认的字段，不得以肯定句、也不得以「该字段的既成配图」
 * 出现在书里。宁缺页，不编事实。
 *
 * 跑法：node tooling/check-unconfirmed.mjs
 * 任一断言不过 → 退出码 1。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeCase, requiredFields } from '../web/engine/compose.mjs';
import { assembleBook } from '../web/engine/assemble.mjs';
import { validateBook } from '../web/engine/validate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const catalog = read('web/engine/catalog.json');
const manifest = read('assets/manifest.json');
const modules = read('web/engine/modules.json');

const skeletons = {};
const skDir = join(ROOT, 'web/engine/skeletons');
for (const f of readdirSync(skDir).filter((x) => x.endsWith('.json') && x !== 'index.json')) {
  const sk = JSON.parse(readFileSync(join(skDir, f), 'utf8'));
  skeletons[sk.key] = sk;
}

/** 字段 → 只在确认后才允许出现的「该字段专属配图」。
 *  一张图如果画的就是这个事实本身（手背上的留置针），没确认就等同于把未确认写成既成。 */
const FIELD_ASSETS = {
  device: ['scene_butterfly_hand'],
};

/** 词：未确认时不得出现在正文/标题里的确定说法 */
const FIELD_WORDS = {
  device: ['留置针', '小蝴蝶'],
};

const problems = [];
const fail = (where, msg) => problems.push(`[${where}] ${msg}`);

// 三个有骨架的术式各跑一遍：词表 id → 骨架 key
const PROCEDURES = ['tonsillectomy', 'appendectomy', 'iv-infusion'];

for (const procedureId of PROCEDURES) {
  // 事实一个都不给：只剩术式本身
  const caseObj = composeCase({ catalog, procedureId });
  const book = assembleBook(caseObj, manifest, skeletons, modules);
  const report = validateBook(book);
  const faces = book.pages.length + 1; // +1 = 封底

  console.log(`\n=== ${procedureId}｜mode=${book.mode}｜version=${book.version} ===`);
  console.log(`missing: [${book.missing.join(', ')}]`);
  console.log(`pages: ${book.pages.length}｜faces: ${faces}`);
  console.log('  id           draft  condition              本页配图                  字段专属配图');
  for (const p of book.pages) {
    const cond = p.condition
      ? p.condition.map((c) => (typeof c === 'string' ? c : `${c.fact}=${c.has_id}`)).join(',')
      : '-';
    const own = Object.entries(FIELD_ASSETS)
      .filter(([, ids]) => ids.includes(p.image?.id))
      .map(([k]) => k);
    console.log(
      `  ${String(p.id).padEnd(12)} ${(p.draft ? 'Y' : '-').padEnd(5)}  ${cond.padEnd(22)} ${String(p.image?.id || '-').padEnd(24)} ${own.join(',') || '-'}`
    );
    for (const prop of p.props || []) {
      if (Object.values(FIELD_ASSETS).flat().includes(prop.id)) {
        fail(procedureId, `页 ${p.id} 的立牌里出现了字段专属素材 ${prop.id}`);
      }
    }
  }
  console.log(`  cautions: ${book.cautions.map((g) => `${g.label}[${g.items.join(' / ')}]`).join(' ') || '（无）'}`);
  if (book.skipped.length) {
    console.log(`  skipped: ${book.skipped.map((s) => `${s.id}（${s.reason}）`).join('；')}`);
  }

  /* ---------- 断言 ---------- */

  // 1. 缺什么就写缺什么：missing 不得被渲染步骤悄悄抹掉
  for (const k of requiredFields(caseObj.procedure.key)) {
    if (!book.missing.includes(k)) fail(procedureId, `missing 里缺了 ${k}`);
  }

  // 2. 未确认的字段，不得有「把该字段当既成事实」的页
  for (const p of book.pages) {
    for (const [field, ids] of Object.entries(FIELD_ASSETS)) {
      if (caseObj.facts[field]) continue;             // 已确认 → 允许
      if (ids.includes(p.image?.id)) {
        fail(procedureId, `页 ${p.id} 用了未确认字段 ${field} 的专属配图 ${p.image.id}`);
      }
    }
    for (const [field, words] of Object.entries(FIELD_WORDS)) {
      if (caseObj.facts[field]) continue;
      const prose = `${p.title || ''} ${p.text || ''}`;
      const hit = words.filter((w) => prose.includes(w));
      if (hit.length) fail(procedureId, `页 ${p.id} 正文/标题出现未确认字段 ${field} 的说法：${hit.join('、')}`);
    }
  }

  // 3. 留下来的条件页，事实卡必须是空的（不能一边说"如果"一边贴事实）
  for (const p of book.pages) {
    if (p.draft && p.fact) fail(procedureId, `页 ${p.id} 是条件页却带了事实卡`);
    if (p.draft && !p.condition?.length) fail(procedureId, `页 ${p.id} 标了 draft 却没有 condition`);
  }

  // 4. 页数与面数自洽
  if (book.stats.page_count !== book.pages.length) {
    fail(procedureId, `stats.page_count=${book.stats.page_count} 与 pages.length=${book.pages.length} 不一致`);
  }
  if (faces % 2 !== 0) fail(procedureId, `总面数 ${faces} 是奇数，封底会被并进跨页`);
  const ids = book.pages.map((p) => p.id);
  if (new Set(ids).size !== ids.length) fail(procedureId, `页 id 重复：${ids.join(',')}`);
  if (book.stats.draft_pages !== book.pages.filter((p) => p.draft).length) {
    fail(procedureId, 'stats.draft_pages 与实际条件页数不一致');
  }

  // 5. 事实保真校验不能因为改动而放宽
  if (!report.ok) {
    fail(procedureId, `validate 未通过：${report.issues.filter((i) => i.level === 'error').map((i) => i.code).join(',')}`);
  }

  // 6. 封底 / 清单页的「术前准备」清单同样是正文：清单里写进去 = 告诉家长要这么做
  const cautionText = book.cautions.flatMap((g) => g.items).join(' | ');
  for (const [field, words] of Object.entries(FIELD_WORDS)) {
    if (caseObj.facts[field]) continue;
    const hit = words.filter((w) => cautionText.includes(w));
    if (hit.length) fail(procedureId, `注意事项（封底/清单页）出现未确认字段 ${field} 的条目：${hit.join('、')} → ${cautionText}`);
  }
  // 与 device 无关的通用准备不能跟着被误删
  const generic = { tonsillectomy: ['更换病号服', '取下饰物'], appendectomy: ['脐部及下腹备皮', '术前排空小便'] }[procedureId];
  for (const g of generic || []) {
    if (!cautionText.includes(g)) fail(procedureId, `与 device 无关的通用准备「${g}」被误删`);
  }
  for (const group of book.cautions) {
    if (!group.items.length) fail(procedureId, `注意事项分组「${group.label}」被清空却仍留在书里`);
  }

  console.log(`  validate: ${report.ok ? '通过' : '未通过'}｜issues=${report.issues.length}｜UI 页码分母=${book.pages.length + 1}`);
}

/* ---------- 已确认的字段不受影响 ---------- */
{
  const caseObj = composeCase({
    catalog,
    procedureId: 'tonsillectomy',
    childName: '朵朵',
    anesthesiaId: 'general',
    fastingHours: 6,
    liquidHours: 2,
    stayDays: 3,
    devices: ['iv'],
  });
  const book = assembleBook(caseObj, manifest, skeletons, modules);
  const ids = book.pages.map((p) => p.id);
  console.log(`\n=== 已确认（全选）对照｜pages=${book.pages.length}｜draft=${book.stats.draft_pages}｜${ids.join(' → ')} ===`);
  console.log(`  cautions: ${book.cautions.flatMap((g) => g.items).join(' | ')}`);
  for (const need of ['fasting', 'cloud', 'needle', 'wake']) {
    if (!ids.includes(need)) fail('confirmed', `四个事实都已确认，${need} 页却不见了`);
  }
  if (book.stats.draft_pages !== 0) fail('confirmed', `事实齐全却仍有 ${book.stats.draft_pages} 个条件页`);
  if (!validateBook(book).ok) fail('confirmed', 'validate 未通过');
  const needle = book.pages.find((p) => p.id === 'needle');
  if (needle && needle.image?.id !== 'scene_butterfly_hand') fail('confirmed', 'needle 页配图不是小蝴蝶');
  // 确认会留 → 封底清单里那条准备也要在（清单与故事页必须同口径）
  const cau = book.cautions.flatMap((g) => g.items).join(' | ');
  if (!/留置针/.test(cau)) fail('confirmed', 'device=iv 已确认，术前准备里却没有留置针条目');
}

/* ---------- 已确认「不留」：清单里也不该出现 ---------- */
{
  const caseObj = composeCase({
    catalog,
    procedureId: 'tonsillectomy',
    anesthesiaId: 'general',
    fastingHours: 6,
    liquidHours: 2,
    stayDays: 3,
    devices: ['none'],
  });
  const book = assembleBook(caseObj, manifest, skeletons, modules);
  const cau = book.cautions.flatMap((g) => g.items).join(' | ');
  const ids = book.pages.map((p) => p.id);
  console.log(`\n=== 已确认「不留留置针」对照｜pages=${book.pages.length}｜${ids.join(' → ')} ===`);
  console.log(`  cautions: ${cau}`);
  if (/留置针|小蝴蝶/.test(cau)) fail('device=none', `已确认不留，注意事项里仍有：${cau}`);
  if (ids.includes('needle')) fail('device=none', '已确认不留，needle 页却还在');
  if (book.missing.includes('device')) fail('device=none', '已确认不留，device 不该进 missing');
}

console.log('');
if (problems.length) {
  console.log(`✗ ${problems.length} 项不合格：`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log('✓ 全部通过：未确认的字段没有以肯定句或既成配图出现在书里。');
