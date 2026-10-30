import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5201;
const files = process.argv.slice(2);
const outName = '_review_' + files[0].split('__')[0] + '.png';
const BIN = {};
for (const f of files) BIN[f] = readFileSync(join(ROOT, 'assets/characters', f)).toString('base64');

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><pre id="log">run</pre><script>
const BIN = ${JSON.stringify(BIN)};
const BIN_COUNT = ${files.length};
(async () => {
  const cv = document.createElement('canvas'); cv.width = 840 * 2 + 20; cv.height = 1040 * Math.ceil(BIN_COUNT / 2) + 20;
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
  g.fillStyle = '#f00';
  let i = 0;
  for (const [name, b64] of Object.entries(BIN)) {
    const img = new Image();
    await new Promise((res) => { img.onload = res; img.src = 'data:image/png;base64,' + b64; });
    const dx = (i % 2) * (840 + 20), dy = ((i / 2) | 0) * (1040 + 20);
    g.drawImage(img, dx, dy);
    i++;
  }
  const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
  await fetch('/save', { method: 'POST', body: await blob.arrayBuffer() });
  document.getElementById('log').textContent = 'OK';
  document.title = 'done';
})();
</script></body></html>`;

const server = createServer((req, res) => {
  if (req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      writeFileSync(join(ROOT, outName), Buffer.concat(chunks));
      console.log('saved review');
      res.writeHead(200); res.end('ok');
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});
server.listen(PORT, () => {
  const chrome = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars',
    `--user-data-dir=${join(ROOT, '.cutout-profile')}`,
    '--window-size=1300,1600', '--virtual-time-budget=20000', `http://localhost:${PORT}/`], { stdio: 'ignore' });
  let done = false;
  const finish = (c) => { if (done) return; done = true; try { child.kill(); } catch {} server.close(() => process.exit(c)); };
  setTimeout(() => finish(0), 22000);
  child.on('exit', () => setTimeout(() => finish(0), 1500));
});
