/**
 * 把 ZCOOL KuaiLe 从 Google Fonts 本地化到 web/fonts/zcool/。
 * 目的：演示现场不依赖外网与字体 CDN，书页的圆体不会掉回系统黑体。
 * 用法：node tooling/fonts.mjs
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const CSS_URL = 'https://fonts.googleapis.com/css2?family=ZCOOL+KuaiLe&display=swap';

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const curlOnce = (url, out) => {
  const args = ['-s', '-m', '25', '--retry', '3', '--retry-delay', '1', '-A', UA, url];
  if (out) args.push('-o', out);
  return execFileSync('curl', args, { encoding: out ? 'buffer' : 'utf8', maxBuffer: 32 * 1024 * 1024 });
};

const curl = (url, out) => {
  for (let i = 0; i < 4; i++) {
    try { return curlOnce(url, out); } catch (e) { if (i === 3) throw e; sleep(400 * (i + 1)); }
  }
};

const css = curl(CSS_URL);
const urls = [...new Set((css.match(/https:\/\/fonts\.gstatic\.com\/[^)]+/g) || []))];
console.log(`子集数量：${urls.length}`);

const dir = join(ROOT, 'web/fonts/zcool');
mkdirSync(dir, { recursive: true });

let out = css;
let n = 0;
for (const u of urls) {
  const name = u.split('/').pop();
  const file = join(dir, name);
  if (!existsSync(file)) { curl(u, file); sleep(60); }
  out = out.split(u).join(`../fonts/zcool/${name}`);
  n++;
}

writeFileSync(join(ROOT, 'web/css/fonts-zcool.css'), out, 'utf8');
console.log(`完成：${n} 个子集 → web/fonts/zcool/，样式表 → web/css/fonts-zcool.css`);
