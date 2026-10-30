/**
 * 批量烘焙：data/raw/*.txt → data/books/*.json
 * 每本书都过一遍事实保真校验，有 error 直接以非零退出码结束。
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNotice } from '../web/engine/parse.mjs';
import { assembleBook } from '../web/engine/assemble.mjs';
import { validateBook, formatReport } from '../web/engine/validate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rawDir = join(ROOT, 'data/raw');
const outDir = join(ROOT, 'data/books');
mkdirSync(outDir, { recursive: true });

const manifest = JSON.parse(readFileSync(join(ROOT, 'assets/manifest.json'), 'utf8'));

// 骨架：与浏览器共用同一批 JSON
const skDir = join(ROOT, 'web/engine/skeletons');
const skeletons = {};
for (const f of readdirSync(skDir).filter((x) => x.endsWith('.json') && x !== 'index.json')) {
  const sk = JSON.parse(readFileSync(join(skDir, f), 'utf8'));
  skeletons[sk.key] = sk;
}

const files = readdirSync(rawDir).filter((f) => f.endsWith('.txt'));
let failed = 0;
const index = [];

for (const f of files) {
  const raw = readFileSync(join(rawDir, f), 'utf8');
  const caseObj = parseNotice(raw);
  const book = assembleBook(caseObj, manifest, skeletons);
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
