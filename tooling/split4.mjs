/** Split each rawpic 2x2 contact sheet into 4 overlapping quadrants.
 * Usage: node tooling/split4.mjs
 * Input:  ../archive/rawpic/   （原始设定表已移出仓库，见 preop/archive）
 * Output: ../archive/rawpic/parts/<base>_a.png ... _d.png
 */
import { createServer } from 'node:http';
import { writeFileSync, readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5199;
const only = process.argv[2];
const onlyQ = process.argv[3]; // a/b/c/d
const RAW = join(ROOT, '..', 'archive', 'rawpic');
const files = readdirSync(RAW).filter((f) => /\.(jpe?g|png)$/i.test(f) && (!only || f.startsWith(only)));
const jobs = files.map((f) => ({ file: f, b64: readFileSync(join(RAW, f)).toString('base64'), mime: /\.png$/i.test(f) ? 'image/png' : 'image/jpeg' }));

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<pre id="log">running</pre><script>
const jobs = ${JSON.stringify(jobs.map((j) => ({ file: j.file, mime: j.mime })))};
const BIN = ${JSON.stringify(Object.fromEntries(jobs.map((j) => [j.file, j.b64])))};
(async () => {
  const names = ['a', 'b', 'c', 'd'];
  const qi = ${JSON.stringify(['a', 'b', 'c', 'd'].indexOf(onlyQ || ''))};
  for (const j of jobs) {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:' + j.mime + ';base64,' + BIN[j.file]; });
    const W = img.naturalWidth, H = img.naturalHeight;
    const ovx = 0, ovy = 0; // 无重叠：中线处本就是绿幕留白，重叠只会把邻居的肢体连进来
    const quads = [
      [0, 0, W / 2 + ovx, H / 2 + ovy],
      [W / 2 - ovx, 0, W / 2 + ovx, H / 2 + ovy],
      [0, H / 2 - ovy, W / 2 + ovx, H / 2 + ovy],
      [W / 2 - ovx, H / 2 - ovy, W / 2 + ovx, H / 2 + ovy],
    ];
    for (let k = 0; k < 4; k++) {
      if (qi >= 0 && k !== qi) continue;
      const [sx, sy, sw, sh] = quads[k].map(Math.round);
      const cv = document.createElement('canvas'); cv.width = sw; cv.height = sh;
      cv.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
      await fetch('/save?id=' + encodeURIComponent(j.file.replace(/\\.[^.]+$/, '') + '_' + names[k]), { method: 'POST', body: await blob.arrayBuffer() });
    }
  }
  document.getElementById('log').textContent = 'OK';
  document.title = 'done';
})();
</script></body></html>`;

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/save')) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const id = decodeURIComponent(req.url.split('id=')[1]);
      mkdirSync(join(RAW, 'parts'), { recursive: true });
      writeFileSync(join(RAW, 'parts', `${id}.png`), Buffer.concat(chunks));
      console.log(`ok ${id}.png`);
      res.writeHead(200); res.end('ok');
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});

server.listen(PORT, () => {
  const chrome = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const child = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    `--user-data-dir=${join(ROOT, '.cutout-profile')}`,
    '--window-size=1200,1400', '--virtual-time-budget=55000',
    `http://localhost:${PORT}/`,
  ], { stdio: 'ignore' });
  let done = false;
  const finish = (code) => { if (done) return; done = true; try { child.kill(); } catch {} server.close(() => process.exit(code)); };
  setTimeout(() => finish(0), 60000);
  child.on('exit', () => setTimeout(() => finish(0), 1500));
});
