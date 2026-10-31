/**
 * 批量烘焙：data/raw/*.txt → data/books/*.json
 * 每本书都过一遍事实保真校验，有 error 直接以非零退出码结束。
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNotice } from '../web/engine/parse.mjs';
import { attachDisease } from '../web/engine/compose.mjs';
import { assembleBook } from '../web/engine/assemble.mjs';
import { validateBook, formatReport } from '../web/engine/validate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rawDir = join(ROOT, 'data/raw');
const outDir = join(ROOT, 'data/books');
mkdirSync(outDir, { recursive: true });

const manifest = JSON.parse(readFileSync(join(ROOT, 'assets/manifest.json'), 'utf8'));
// 词表也要读：反派挂在病种上，B 路径同样要能查到
const catalog = JSON.parse(readFileSync(join(ROOT, 'web/engine/catalog.json'), 'utf8'));

// 骨架：与浏览器共用同一批 JSON
const skDir = join(ROOT, 'web/engine/skeletons');
const skeletons = {};
for (const f of readdirSync(skDir).filter((x) => x.endsWith('.json') && x !== 'index.json')) {
  const sk = JSON.parse(readFileSync(join(skDir, f), 'utf8'));
  skeletons[sk.key] = sk;
}

// —— 素材引用校验：骨架里写到的 id 必须在 manifest 里，否则页面会静默空白 ——
const referenced = new Map();
for (const [key, sk] of Object.entries(skeletons)) {
  for (const pg of sk.pages || []) {
    const ids = [pg.asset, ...(pg.props || [])].filter(Boolean);
    for (const id of ids) {
      if (id.startsWith('kid:')) continue;               // kid:* 运行时展开
      if (!manifest.assets[id]) {
        console.error(`✗ MISSING_ASSET  骨架 ${key} 第 ${pg.id} 页引用了不存在的素材：${id}`);
        process.exitCode = 1;
      }
      referenced.set(id, (referenced.get(id) || 0) + 1);
    }
  }
}
// —— 体型比例校验：每个会用到的角色都必须在 proportions.json 里有明确系数，
//    否则会静默回落到 1.0（医生和孩子一样高）——这种错最不容易被发现。
const roles = manifest?.proportions?.roles || {};
const checkRole = (id) => {
  if (id.startsWith('kid:')) return true;             // 运行时展开为 kid_boy / kid_girl
  const role = id.split('__')[0];
  if (!roles[role]) {
    console.error(`✗ MISSING_PROPORTION  素材 ${id} 在 proportions.json 里没有角色系数`);
    return false;
  }
  return true;
};
for (const [key, sk] of Object.entries(skeletons)) {
  for (const pg of sk.pages || []) {
    for (const id of pg.props || []) {
      if (!checkRole(id)) process.exitCode = 1;
    }
  }
}

// —— 设计语言硬约束：反派不得高于患儿（怪兽比孩子大，故事就变成威胁）
for (const [role, meta] of Object.entries(roles)) {
  if (role.startsWith('villain_') && Number(meta.scale) > 1) {
    console.error(`✗ VILLAIN_TOO_BIG  ${role} 的体型系数 ${meta.scale} > 1.00（患儿基准），不符合"小怪兽"设定`);
    process.exitCode = 1;
  }
}

if (process.exitCode === 1) {
  console.error('素材引用 / 体型比例校验未通过，构建中止。');
  process.exit(1);
}

const modules = JSON.parse(readFileSync(join(ROOT, 'web/engine/modules.json'), 'utf8'));

const files = readdirSync(rawDir).filter((f) => f.endsWith('.txt'));
let failed = 0;
const index = [];

for (const f of files) {
  const raw = readFileSync(join(rawDir, f), 'utf8');
  const caseObj = attachDisease(parseNotice(raw), catalog);
  const book = assembleBook(caseObj, manifest, skeletons, modules);
  const result = validateBook(book);

  const slug = basename(f, '.txt');
  book.slug = slug;
  writeFileSync(join(outDir, `${slug}.json`), JSON.stringify(book, null, 2), 'utf8');

  index.push({
    slug,
    title: book.cover.title,
    procedure: book.skeleton.label,
    child: book.case.child.name,
    pages: book.stats.page_count,
    valid: result.ok,
  });

  console.log(`\n▸ ${slug}`);
  console.log(`  ${book.cover.title} · ${book.stats.page_count} 页 · ${book.skeleton.label}`);
  console.log('  ' + formatReport(result).replace(/\n/g, '\n  '));
  if (!result.ok) failed++;
}

writeFileSync(join(outDir, 'index.json'), JSON.stringify({ books: index }, null, 2), 'utf8');
console.log(`\n共 ${files.length} 本，失败 ${failed} 本`);
if (failed) process.exit(1);
