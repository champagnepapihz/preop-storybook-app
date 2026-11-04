#!/usr/bin/env node
/**
 * MCP 接口（stdio JSON-RPC，零依赖）
 *
 * 设计原则：接口只收「枚举 + 整数」，不收自由文本。
 *   —— 调用方可以是大模型，但它没法把"大概禁食 8 小时吧"变成数字，
 *      因为 fasting_hours 要么是 0-24 的整数，要么不存在。
 *      揣测在 schema 层被挡住，不靠提示词祈祷。
 *
 * 注册到 WorkBuddy / Claude Desktop：
 *   { "command": "node", "args": ["<绝对路径>/mcp/server.mjs"] }
 *
 * 工具：
 *   list_catalog      科室/病种/术式树 + 麻醉/留置针枚举（调用方先查可选值）
 *   build_preop_book  受控参数 → 绘本 JSON（含缺失项、建议提问、版本）
 *   render_pdf        受控参数 → 真的 PDF 文件（compose → assemble → 渲染页 → headless Chrome）
 *
 * render_pdf 的实现路线（零 npm 依赖）：
 *   1. 起一个只监听 127.0.0.1 的临时静态服务器，docroot 是 web/ 与仓库根
 *      （等价于 dist/ 的合并布局：/print.html + /assets/… + /css/…）；
 *   2. 书 JSON 不走磁盘，直接从内存发到 /_book.json；
 *   3. 用 headless Chrome 的 --print-to-pdf 打 http://127.0.0.1:<port>/print.html?book=/_book.json；
 *   4. 落盘后自己解析 PDF 校验页数（页数对不上就加预算重试一次，仍不对就报错，不静默）。
 *   找不到 Chrome 时不静默失败：写一份自包含 HTML（样式内联、图片 base64）并返回它的路径。
 */
import { createInterface } from 'node:readline';
import {
  readFileSync, readdirSync, mkdirSync, writeFileSync, statSync, rmSync, existsSync,
} from 'node:fs';
import { join, dirname, resolve, extname, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { composeCase, flattenProcedures } from '../web/engine/compose.mjs';
import { assembleBook } from '../web/engine/assemble.mjs';
import { validateBook } from '../web/engine/validate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'out');   // .gitignore 已忽略
const WEB_DIR = join(ROOT, 'web');

const manifest = JSON.parse(readFileSync(join(ROOT, 'assets/manifest.json'), 'utf8'));
const modules = JSON.parse(readFileSync(join(ROOT, 'web/engine/modules.json'), 'utf8'));
const catalog = JSON.parse(readFileSync(join(ROOT, 'web/engine/catalog.json'), 'utf8'));

const skDir = join(ROOT, 'web/engine/skeletons');
const skeletons = {};
for (const f of readdirSync(skDir).filter((x) => x.endsWith('.json') && x !== 'index.json')) {
  const sk = JSON.parse(readFileSync(join(skDir, f), 'utf8'));
  skeletons[sk.key] = sk;
}

const PROCEDURE_IDS = flattenProcedures(catalog).map((p) => p.id);
const ANESTHESIA_IDS = (catalog.anesthesia || []).map((a) => a.id);
// 'none' = 已确认不留留置针（与未确认不同，前者算已确认）
const DEVICE_IDS = [...(catalog.devices || []).map((d) => d.id), 'none'];

/** 两个工具共用一套入参 schema：受控枚举 + 整数，additionalProperties:false 的立场不变 */
const BOOK_INPUT_PROPS = {
  procedure_id: { type: 'string', enum: PROCEDURE_IDS, description: '术式 id（来自 list_catalog）' },
  child_name: { type: 'string', description: '患儿昵称，可省略' },
  age: { type: 'integer', minimum: 0, maximum: 18, description: '年龄（岁）' },
  anesthesia_id: { type: 'string', enum: ANESTHESIA_IDS },
  gender: { type: 'string', enum: ['m', 'f'], description: '患儿性别：决定书里孩子用男孩还是女孩的立牌' },
  parent: { type: 'string', enum: ['mom', 'dad'], description: '陪同家长：决定封面上站妈妈还是爸爸，默认 mom' },
  fasting_hours: { type: 'integer', minimum: 0, maximum: 24, description: '术前禁食小时数：确认过才传' },
  liquid_hours: { type: 'integer', minimum: 0, maximum: 24, description: '术前禁水小时数：确认过才传' },
  stay_days: { type: 'integer', minimum: 0, maximum: 30 },
  devices: { type: 'array', items: { type: 'string', enum: DEVICE_IDS }, description: '确定会留留置针传 ["iv"]；确定不留传 ["none"]；未确认则不传' },
};

const TOOLS = [
  {
    name: 'list_catalog',
    description:
      '返回受控词表：科室/病种/术式（含是否有专属故事）+ 麻醉方式 + 留置针枚举。任何生成前先调它拿可选值。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'build_preop_book',
    description:
      '用受控参数生成一本术前绘本。只接受枚举与整数，不接受自由文本；未提供的字段不会出现在书里，' +
      '只会在 missing 与 questions 中体现。返回 { version, mode, missing, questions, book }。',
    inputSchema: {
      type: 'object',
      properties: BOOK_INPUT_PROPS,
      required: ['procedure_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'render_pdf',
    description:
      '用受控参数直接产出一本术前绘本的 PDF 文件（一次调用拿到一本书）。' +
      '入参与 build_preop_book 完全一致；返回 PDF 的绝对路径、页数、以及 resource_link。' +
      'missing / questions 仍会出现在返回文本里（这是产品特性：没确认的事实不会出现在书里，只会变成该问的问题）。' +
      '依赖本机 Chrome / Edge；找不到浏览器时降级返回一份可直接打印的自包含 HTML 路径。',
    inputSchema: {
      type: 'object',
      properties: BOOK_INPUT_PROPS,
      required: ['procedure_id'],
      additionalProperties: false,
    },
  },
];

/* ============================================================
   装配（build_preop_book 与 render_pdf 共用）
   ============================================================ */

function buildBook(args) {
  // 未知术式直接拒，不做任何猜测
  if (!PROCEDURE_IDS.includes(args.procedure_id)) {
    throw new Error(`procedure_id 不在词表内：${args.procedure_id}`);
  }
  const caseObj = composeCase({
    catalog,
    procedureId: args.procedure_id,
    childName: args.child_name,
    age: args.age ?? null,
    gender: args.gender ?? null,
    parent: args.parent ?? null,
    anesthesiaId: args.anesthesia_id ?? null,
    fastingHours: args.fasting_hours ?? null,
    liquidHours: args.liquid_hours ?? null,
    stayDays: args.stay_days ?? null,
    devices: args.devices ?? [],
  });
  const book = assembleBook(caseObj, manifest, skeletons, modules);
  const report = validateBook(book);
  if (!report.ok) {
    throw new Error(
      `事实校验未通过：${report.issues.filter((i) => i.level === 'error').map((i) => i.message).join('；')}`
    );
  }
  return { version: book.version, mode: book.mode, missing: book.missing, questions: book.questions, book };
}

/* ============================================================
   临时静态服务器：docroot = web/（页面、样式、字体）+ 仓库根（assets/）
   等价于 dist/ 的合并布局，所以 print.html 里的相对路径与线上完全一致。
   ============================================================ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

function startStaticServer(bookJson) {
  const roots = [WEB_DIR, ROOT];
  const server = createServer((req, res) => {
    const raw = (req.url || '/').split('?')[0];
    if (raw === '/_book.json') {
      const buf = Buffer.from(bookJson, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
      return res.end(buf);
    }
    let path = raw;
    try { path = decodeURIComponent(raw); } catch { /* 保持原样 */ }
    if (path === '/' || path === '') path = '/print.html';

    for (const root of roots) {
      const abs = resolve(root, `.${path.startsWith('/') ? '' : '/'}${path}`);
      if (abs !== root && !abs.startsWith(root + (process.platform === 'win32' ? '\\' : '/'))) continue; // 防目录穿越
      try {
        if (!statSync(abs).isFile()) continue;
      } catch { continue; }
      const buf = readFileSync(abs);
      res.writeHead(200, {
        'Content-Type': MIME[extname(abs).toLowerCase()] || 'application/octet-stream',
        'Content-Length': buf.length,
        'Cache-Control': 'no-store',
      });
      return res.end(buf);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  });

  return new Promise((ok, bad) => {
    server.once('error', bad);
    server.listen(0, '127.0.0.1', () => ok({ server, port: server.address().port }));
  });
}

/* ============================================================
   Chrome 探测
   CHROME_PATH → 常见安装路径 → PATH 上的 chrome / msedge
   ============================================================ */

function playwrightChromes() {
  const base = process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA || '', 'ms-playwright')
    : join(process.env.HOME || '', '.cache/ms-playwright');
  const out = [];
  try {
    for (const d of readdirSync(base).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
      out.push(join(base, d, process.platform === 'win32' ? 'chrome-win64/chrome.exe' : 'chrome-linux/chrome'));
    }
  } catch { /* 没装 playwright 就算了 */ }
  return out;
}

function chromeCandidates() {
  const win = process.platform === 'win32';
  return [
    process.env.CHROME_PATH,
    win && join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
    win && join(process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
    win && join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    win && join(process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
    win && join(process.env.PROGRAMFILES || 'C:/Program Files', 'Microsoft/Edge/Application/msedge.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    ...playwrightChromes(),
  ].filter(Boolean);
}

function findChrome() {
  // CHROME_PATH 一旦设置就只认它：设错了要明说，别偷偷用别的浏览器，
  // 否则"为什么打出来的和我指定的不一样"根本查不出来。
  const forced = process.env.CHROME_PATH;
  if (forced) {
    try { if (statSync(forced).isFile()) return { path: forced, source: 'CHROME_PATH' }; } catch { /* 落到下面的报错 */ }
    return { path: null, source: 'CHROME_PATH', bad: forced };
  }
  const rest = chromeCandidates().filter((p) => p && p !== forced);
  for (const p of rest) {
    try { if (statSync(p).isFile()) return { path: p, source: 'candidate' }; } catch { /* next */ }
  }
  // PATH 上的可执行名（Windows 需要带扩展名）
  const names = process.platform === 'win32'
    ? ['chrome.exe', 'msedge.exe']
    : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'chrome'];
  for (const dir of String(process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const p = join(dir, n);
      try { if (statSync(p).isFile()) return { path: p, source: 'PATH' }; } catch { /* next */ }
    }
  }
  return null;
}

/* ============================================================
   headless Chrome → PDF
   ============================================================ */

/**
 * --virtual-time-budget 实测（Windows 11 / Chrome 156 headless=new，9 页书 + 封底）：
 *   300 / 500 / 800 / 1000 / 1500 / 2000 / 3000 / 5000 ms 八档全部产出
 *   10 页、323.04×420pt、9,983,135 字节的**完全相同**文件。
 *
 * 结论：Chrome 的 virtual time 在网络请求（book JSON、字体、图片）未落地时会暂停，
 * 所以预算不是"等多久"，而是"最多等多久"——书页渲染完就立刻落盘，不会再空转。
 * 300ms 已经够；取 3000 是给冷启动/杀毒扫描留余量（实测整次调用 ≈3.5s，其中
 * 预算本身不额外耗时）。页数对不上时按 ×2 重试一次，仍不对就报错，绝不静默产出坏文件。
 */
const PDF_VIRTUAL_TIME_BUDGET_MS = Number(process.env.PREOP_PDF_BUDGET_MS || 3000);
const PDF_TIMEOUT_MS = 90000;

function runChrome(chromePath, url, pdfPath, budgetMs) {
  const profile = join(tmpdir(), `preop-chrome-${process.pid}-${Date.now()}`);
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--force-device-scale-factor=1',
    '--run-all-compositor-stages-before-draw',
    '--no-pdf-header-footer',
    '--print-to-pdf-no-header',       // 旧版 Chrome 的等价开关，留着不影响
    `--user-data-dir=${profile}`,
    `--virtual-time-budget=${budgetMs}`,
    `--print-to-pdf=${pdfPath}`,
    url,
  ];

  return new Promise((ok, bad) => {
    let err = '';
    const child = spawn(chromePath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      bad(new Error(`Chrome 超时（${PDF_TIMEOUT_MS}ms）`));
    }, PDF_TIMEOUT_MS);

    child.stderr.on('data', (d) => { err += d.toString(); if (err.length > 4000) err = err.slice(-4000); });
    child.on('error', (e) => { clearTimeout(timer); bad(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome 偶尔还占着，留给系统临时目录 */ }
      ok({ code, stderr: err.trim() });
    });
  });
}

/** 只做最小的 PDF 结构解析：版本头、页数、页面尺寸（pt）。不引依赖。 */
function inspectPdf(buf) {
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error('产出的文件不是 PDF（缺少 %PDF- 头）');
  }
  const s = buf.toString('latin1');
  // 直接数页对象；个别版本会把页字典塞进对象流，那就退回到根 Pages 的 /Count
  const direct = (s.match(/\/Type\s*\/Page[^s]/g) || []).length;
  const counts = [...s.matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  const pages = direct || (counts.length ? Math.max(...counts) : 0);
  const box = s.match(/\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/);
  const size = box ? { w: Number(box[3]) - Number(box[1]), h: Number(box[4]) - Number(box[2]) } : null;
  return { pages, size };
}

/* ============================================================
   降级：没有 Chrome 时，写一份自包含 HTML（样式内联 / 图片 base64）
   ============================================================ */

const IMG_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.gif': 'image/gif' };

function makeAssetInliner() {
  const cache = new Map();
  return (src) => {
    if (typeof src !== 'string' || src.startsWith('data:')) return src;
    if (cache.has(src)) return cache.get(src);
    let out = src;
    try {
      const abs = resolve(ROOT, src.replace(/^\.?\//, ''));
      if (statSync(abs).isFile()) {
        out = `data:${IMG_MIME[extname(abs).toLowerCase()] || 'application/octet-stream'};base64,${readFileSync(abs).toString('base64')}`;
      }
    } catch { /* 找不到就留原路径，至少不崩 */ }
    cache.set(src, out);
    return out;
  };
}

/** 递归把资源对象里的 src 换成 data URL */
function inlineBookAssets(node, inline, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return node;
  seen.add(node);
  if (Array.isArray(node)) return node.map((n) => inlineBookAssets(n, inline, seen));
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    out[k] = k === 'src' && typeof v === 'string' ? inline(v) : inlineBookAssets(v, inline, seen);
  }
  return out;
}

function buildFallbackHtml(book) {
  const css = [readFileSync(join(WEB_DIR, 'css/fabric.css'), 'utf8'), readFileSync(join(WEB_DIR, 'css/book.css'), 'utf8')].join('\n');
  // 内联后没有外部字体文件可解析，剥掉 @font-face，让 --font-round 落到系统圆体
  const safeCss = css.replace(/@font-face\s*\{[^}]*\}/g, '');
  // 降级路径要把「书页渲染 + 打印副本」两段源码按顺序内联。两者都是零依赖源码，
  // 去掉 export / import 之后就是普通脚本，拼起来即可（顺序不能反：后者用前者的函数）。
  const stripModule = (rel) =>
    readFileSync(join(WEB_DIR, rel), 'utf8')
      .replace(/^export\s+/gm, '')
      .replace(/^import\s+.*?;\s*$/gm, '');
  const renderSrc = `${stripModule('js/book-render.mjs')}\n${stripModule('print-render.mjs')}`;
  const inlined = inlineBookAssets(book, makeAssetInliner());
  const json = JSON.stringify(inlined).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${String(book.cover?.title || '术前绘本').replace(/[<>&]/g, '')}</title>
<style>
${safeCss}
</style>
</head>
<body>
<div id="print-root" aria-hidden="true"></div>
<div class="print-boot" style="position:fixed;inset:auto 0 0 0;padding:10px 16px;background:#fdf4e3;border-top:1px dashed rgba(150,112,74,.35);font:12px/1.6 system-ui,sans-serif;color:#5a4636">
  这份 HTML 是 <b>render_pdf 的降级产物</b>（本机没找到 Chrome）：样式与图片已全部内联，
  双击打开后直接 <b>Ctrl+P → 另存为 PDF</b> 即可，纸张无需调整（@page 已锁 430×560）。
</div>
<script>window.__BOOK__ = ${json};</script>
<script type="module">
${renderSrc}
mountPrint();
</script>
</body>
</html>
`;
}

/* ============================================================
   render_pdf
   ============================================================ */

function safeName(s) {
  return String(s || 'preop-book')
    .replace(/[《》「」【】]/g, '')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'preop-book';
}

/** 文件名时间戳精确到毫秒：同一秒内并发两次 render_pdf 也不能互相覆盖。
 *  （实测撞过一次：两个请求同秒进来，后一个把前一个的 PDF 覆盖了，返回的路径却是各自的。） */
function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '-').slice(0, 19);
}

/** 毫秒也可能撞（同进程批量调用），落盘前再确认一次没用过 —— 进程内先占位，避免两个
 *  并发请求同时判定"这个文件名还空着"。 */
const RESERVED = new Set();
function uniquePath(dir, base, ext) {
  let p = join(dir, `${base}${ext}`);
  for (let i = 2; existsSync(p) || RESERVED.has(p); i++) p = join(dir, `${base}-${i}${ext}`);
  RESERVED.add(p);
  return p;
}

function summaryLines(built, book, extra) {
  const lines = [];
  const raw = String(book.cover?.title || book.book_id || '');
  const title = raw.startsWith('《') ? raw : `《${raw}》`;   // 骨架标题自带书名号，别套两层
  lines.push(`${title} → ${extra.path}`);
  // 一行三件事：几面、多大、什么版本 —— 调用方是人或模型，得能一眼判断这本书完不完整
  lines.push(`页数：${extra.pages} 面（书页 ${book.pages.length} + 封底「家长陪护说明」 1）`);
  lines.push(`尺寸：${extra.size}`);
  lines.push(`版本：${built.version} · 形态：${built.mode} · 事实${built.missing.length ? `有 ${built.missing.length} 项未确认` : '齐全'}`);
  if (built.missing.length) lines.push(`未确认：${built.missing.join('、')}`);
  if (built.questions.length) {
    lines.push('建议提问：');
    built.questions.forEach((q, i) => lines.push(`  ${i + 1}. ${q.question}`));
  }
  if (extra.note) lines.push(extra.note);
  lines.push('');
  lines.push(JSON.stringify({
    version: built.version,
    mode: built.mode,
    missing: built.missing,
    questions: built.questions,
    // 引擎按取值整页不出时不写"如果"——原样带出 reason，别自己改写成"缺页/失败"
    skipped: book.skipped,
    book_pages: book.pages.length,
    pdf: extra.meta,
  }, null, 2));
  return lines.join('\n');
}

async function renderPdf(args) {
  const built = buildBook(args);
  const book = built.book;
  const sheets = book.pages.length + 1;   // 封底：家长陪护说明
  const slug = safeName(String(book.cover?.title || '').replace(/^《|》$/g, '') || book.book_id);

  mkdirSync(OUT_DIR, { recursive: true });
  const base = `${slug}-${stamp()}`;
  const chrome = findChrome();

  // —— 降级：没有浏览器，给一份能直接打印的自包含 HTML，并说清楚为什么 ——
  if (!chrome?.path) {
    const htmlPath = uniquePath(OUT_DIR, base, '.html');
    writeFileSync(htmlPath, buildFallbackHtml(book), 'utf8');
    const why = chrome?.bad
      ? `CHROME_PATH 指向的文件不存在：${chrome.bad}（不会回退到别的浏览器，避免"打出来不是我要的那份"）`
      : '没找到 Chrome/Edge（CHROME_PATH、常见安装路径、PATH 都没有）';
    const text = summaryLines(built, book, {
      path: htmlPath,
      pages: sheets,
      size: '114×148 mm（430×560 CSS px，@page 已锁；打印时选"适合纸张"即可）',
      note: `⚠ ${why}，未能直接产出 PDF。已降级为自包含 HTML（样式与图片全部内联）：`
        + '打开后 Ctrl+P → 另存为 PDF。设置 CHROME_PATH 环境变量可恢复直接出 PDF。',
      meta: { degraded: 'no-chrome', reason: why, html: htmlPath, sheets },
    });
    return {
      content: [
        { type: 'text', text },
        {
          type: 'resource_link',
          uri: pathToFileURL(htmlPath).href,
          name: `${slug}.html`,
          mimeType: 'text/html',
          size: statSync(htmlPath).size,
          description: '降级产物：自包含 HTML，可直接在浏览器打印成 PDF',
        },
      ],
    };
  }

  const bookJson = JSON.stringify(book);
  const { server, port } = await startStaticServer(bookJson);
  const pdfPath = uniquePath(OUT_DIR, base, '.pdf');   // 同秒并发也不撞（撞了会互相覆盖 PDF）
  const url = `http://127.0.0.1:${port}/print.html?book=${encodeURIComponent('/_book.json')}`;

  let last = null;
  try {
    for (const budget of [PDF_VIRTUAL_TIME_BUDGET_MS, PDF_VIRTUAL_TIME_BUDGET_MS * 2]) {
      try { rmSync(pdfPath, { force: true }); } catch { /* ignore */ }
      const run = await runChrome(chrome.path, url, pdfPath, budget);
      if (!existsSync(pdfPath)) {
        last = new Error(`Chrome 退出码 ${run.code}，没有产出 PDF。stderr：${run.stderr || '（空）'}`);
        continue;
      }
      const buf = readFileSync(pdfPath);
      const info = inspectPdf(buf);
      last = { budget, run, bytes: buf.length, ...info };
      if (info.pages === sheets) break;      // 页数对上才算成功
      last = new Error(
        `PDF 页数不符：期望 ${sheets} 页，实际 ${info.pages} 页（budget=${budget}ms，Chrome 退出码 ${run.code}）`
        + (run.stderr ? `。stderr：${run.stderr}` : '')
      );
    }
  } finally {
    server.close();
  }

  if (last instanceof Error) throw last;

  const { budget, run, bytes, pages, size } = last;
  const sizeText = size
    ? `${Math.round(size.w / 72 * 25.4)}×${Math.round(size.h / 72 * 25.4)} mm`
      + `（${Math.round(size.w)}×${Math.round(size.h)} pt，= 430×560 CSS px @96dpi）`
    : '未知';
  const notes = [];
  if (budget !== PDF_VIRTUAL_TIME_BUDGET_MS) notes.push(`渲染预算已自动提升到 ${budget}ms（首轮页数不足）。`);
  if (run.code !== 0) notes.push(`Chrome 退出码 ${run.code}（PDF 已产出且页数正确，按成功处理）。`);

  const text = summaryLines(built, book, {
    path: pdfPath,
    pages,
    size: sizeText,
    note: notes.length ? notes.join(' ') : undefined,
    meta: {
      path: pdfPath,
      pages,
      sheets,
      bytes,
      page_pt: size,
      chrome: chrome.path,
      chrome_source: chrome.source,
      virtual_time_budget_ms: budget,
    },
  });

  return {
    content: [
      { type: 'text', text },
      {
        type: 'resource_link',
        uri: pathToFileURL(pdfPath).href,
        name: `${slug}.pdf`,
        mimeType: 'application/pdf',
        size: bytes,
        description: `${pages} 页 · 430×560 · ${built.version}`,
      },
    ],
  };
}

/* ============================================================
   JSON-RPC
   ============================================================ */

async function call(name, args) {
  if (name === 'list_catalog') {
    return {
      note: catalog.note,
      review: catalog.review,
      departments: (catalog.departments || []).map((d) => ({
        id: d.id,
        label: d.label,
        groups: (d.groups || []).map((g) => ({
          id: g.id,
          label: g.label,
          procedures: (g.procedures || []).map((p) => ({
            id: p.id,
            label: p.label,
            has_story: Boolean(p.skeleton),
          })),
        })),
      })),
      anesthesia: catalog.anesthesia,
      devices: catalog.devices,
    };
  }

  if (name === 'build_preop_book') return buildBook(args);

  if (name === 'render_pdf') return renderPdf(args);

  throw new Error(`未知工具：${name}`);
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;

  if (method === 'initialize') {
    return send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'preop-storybook', version: '0.3.0' },
      },
    });
  }
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    try {
      const data = await call(params.name, params.arguments || {});
      // 工具自己组好了 content（render_pdf 要带 resource_link），其余工具统一包 JSON 文本
      if (data && Array.isArray(data.content)) {
        return send({ jsonrpc: '2.0', id, result: { content: data.content } });
      }
      return send({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] },
      });
    } catch (e) {
      return send({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: `错误：${e.message}` }], isError: true },
      });
    }
  }
  if (method === 'notifications/initialized' || method === 'ping') {
    if (id != null) send({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (id != null) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未支持：${method}` } });
});
