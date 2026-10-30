/**
 * 素材归一化（webp 版）：把透明留白裁掉，让「图片高度 = 角色视觉高度」。
 *
 * 为什么需要：png 角色已经过 tooling/normalize.mjs 裁过包围盒，但 doctor / nurse /
 * villain_* 这批是 webp，留白没裁。结果同一套 height 规则下，webp 角色视觉上比 png
 * 角色矮一截 —— 医生看起来跟孩子差不多高，比例就错了。
 *
 * 做法：Chrome headless 里用 canvas 解码（Node 不认 webp alpha），算 alpha>12 的包围盒，
 * 裁切后按原格式（webp q0.92）重新编码，Node 落盘覆盖同名文件。
 *
 *   node tooling/trim-webp.mjs            # 处理 assets/characters 下全部 webp
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'assets/characters');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = process.env.PORT || 5173;

const files = readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.webp'));
if (!files.length) {
  console.log('没有 webp 需要处理');
  process.exit(0);
}

// 关键：图片用 <img> 直接写在文档里，让 load 事件等它们解码完；
// 处理放在 window.onload 里同步跑完 —— Chrome 的 --dump-dom 才会拿到终态。
const page = `<!DOCTYPE html><meta charset="utf-8">
${files.map((f) => `<img id="${f.replace(/[^\w]/g, '_')}" data-name="${f}" src="/assets/characters/${f}">`).join('\n')}
<pre id="o">working</pre>
<script>
const THRESH = 12, PAD = 0.01;
window.addEventListener('load', () => {
  const out = {};
  for (const img of document.querySelectorAll('img[data-name]')) {
    const f = img.dataset.name;
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) { out[f] = { error: 'decode' }; continue; }
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] > THRESH) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) { out[f] = { error: 'empty' }; continue; }
    const pad = Math.round(Math.min(x1 - x0, y1 - y0) * PAD);
    const cx = Math.max(0, x0 - pad), cy = Math.max(0, y0 - pad);
    const cw = Math.min(w - cx, x1 - x0 + 1 + pad * 2);
    const chh = Math.min(h - cy, y1 - y0 + 1 + pad * 2);
    const c2 = document.createElement('canvas'); c2.width = cw; c2.height = chh;
    c2.getContext('2d').drawImage(c, cx, cy, cw, chh, 0, 0, cw, chh);
    out[f] = { src: c2.toDataURL('image/webp', 0.92), w: cw, h: chh, was: w + 'x' + h };
  }
  document.getElementById('o').textContent = 'JSON:' + JSON.stringify(out);
  document.title = 'done';
});
</script>`;

const tmp = join(ROOT, 'dist', '_trim.html');
mkdirSync(join(ROOT, 'dist'), { recursive: true });
writeFileSync(tmp, page, 'utf8');

const r = spawnSync(
  CHROME,
  [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    `--user-data-dir=${join(ROOT, '.trim-profile')}`,
    '--virtual-time-budget=15000',
    '--dump-dom',
    `http://localhost:${PORT}/_trim.html`,
  ],
  { encoding: 'utf8', maxBuffer: 200 * 1024 * 1024 }
);

const dom = r.stdout || '';
const m = dom.match(/JSON:(\{[\s\S]*?\})<\/pre>/);
if (!m) {
  console.error('✗ 没拿到结果，检查本地服务是否在跑（npm run dev）');
  console.error(dom.slice(0, 400));
  process.exit(1);
}

const out = JSON.parse(m[1]);
let n = 0;
for (const [f, v] of Object.entries(out)) {
  if (v.error) { console.warn(`跳过 ${f}: ${v.error}`); continue; }
  const b64 = v.src.split(',')[1];
  writeFileSync(join(DIR, f), Buffer.from(b64, 'base64'));
  console.log(`${f.padEnd(28)} ${v.was} → ${v.w}x${v.h}`);
  n++;
}
console.log(`\n已归一化 ${n} / ${files.length} 张 webp`);
