/**
 * 静态构建：web/ + assets/ + data/ → dist/
 * netlify.toml 里 publish = "dist"，所以构建产物必须落在这里。
 */
import { cpSync, mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

// 0. 素材与书籍先刷新
execFileSync(process.execPath, [join(ROOT, 'tooling/placeholders.mjs')], { stdio: 'inherit' });
execFileSync(process.execPath, [join(ROOT, 'tooling/make-cases.mjs')], { stdio: 'inherit' });

// 1. 目标目录（增量覆盖，不做整目录删除：某些环境把 rm 拦截成回收站操作，会超时）
mkdirSync(DIST, { recursive: true });

// 2. 拷贝（assets/_src 是原始大图母版，不进发布包）
cpSync(join(ROOT, 'web'), DIST, { recursive: true });
cpSync(join(ROOT, 'assets'), join(DIST, 'assets'), {
  recursive: true,
  filter: (src) => !src.split(/[\\/]/).includes('_src'),
});
cpSync(join(ROOT, 'data'), join(DIST, 'data'), { recursive: true });

// 3. 翻页库（MIT, Nodlik/StPageFlip）
const flip = join(ROOT, 'node_modules/page-flip/dist/js/page-flip.browser.js');
if (existsSync(flip)) {
  mkdirSync(join(DIST, 'vendor'), { recursive: true });
  cpSync(flip, join(DIST, 'vendor/page-flip.browser.js'));
} else {
  console.warn('⚠ 未找到 page-flip，先 npm install');
}

// 4. 构建信息
writeFileSync(
  join(DIST, 'build.json'),
  JSON.stringify({ built_at: new Date().toISOString(), pages: readFileSync(join(ROOT, 'data/books/index.json'), 'utf8') }, null, 2),
  'utf8'
);

console.log('\n✓ 构建完成 → dist/');
