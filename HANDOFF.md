# 交接文档：翻页抽动修复 + 全分辨率适配

> 项目：`C:\Users\35975\Desktop\hacks\wmu-hack-workbuddy`
> 交接时间：2026-10-30
> 交接原因：上一代理（Qoder）执行较慢，用户将手动把本文件转交给其他代理继续。
> 目标：1) 彻底消除点击翻页时整页“抽动/缩放”；2) 保证常见分辨率下版式美观、无横向溢出。

---

## 0. 当前状态 TL;DR

- **翻页抽动根因已找到并修复（源码）**：PageFlip 的翻页影子/硬页在动画期间会伸出书框，撑大 `document.scrollHeight`，浏览器竖向滚动条出现/消失 → 内容宽度变化 → 看起来像整页缩放抽动。
- 修复方式：`.book { overflow: hidden; }` 裁掉影子溢出 + 桌面端 `scrollbar-gutter: stable` 稳定槽位。已验证：翻页全程 `scrollHeight / clientWidth` 不变。
- **短屏适配已写进源码，但 `dist/` 还没重新构建**（最后一次 `npm run build` 被用户中断）。**先构建再验收！**
- 源码中已做：短视口书宽按 `100vh` 收紧、941–1120 收窄左栏、≤940 单列且绘本排在面板前面（手机首屏就能看到整本书和翻页条）。
- 待办：重新构建 → 跑验收脚本 → 看截图 → 确认无回归 → 交付。若发现小问题按第 6 节“允许的微调”处理。

---

## 1. 项目速览

- 纯静态站：`web/` 是源码；`npm run build` 生成 `dist/`；`npm run dev` 启动本地预览（**服务的是 `dist/`，不是 `web/`**）。
- 预览地址：http://localhost:5173 （当前已在运行）。
- 页面结构：左侧控制台（术前须知 + 解析事实）+ 右侧 StPageFlip 布艺绘本书。
- 关键脚本：`web/vendor/page-flip.browser.js`（构建时从 `node_modules` 拷入 dist）。
- 2 个示例病例：豆豆（阑尾）、果果（扁桃体）；每次构建都会跑事实保真校验，当前通过。

### 常用命令

```bash
cd C:/Users/35975/Desktop/hacks/wmu-hack-workbuddy
npm run build      # web/ -> dist/（会顺带校验两本绘本）
npm run dev        # http://localhost:5173，服务 dist/
```

### 视觉/素材约束（不要违反）

- 网站背景是**唯一一张 AIGC 舞台图** `web/assets/ui/stage.webp`（1792×1024）。项目刻意节省生图成本，**不要再生成新背景或重做素材**。
- 素材母版在 `assets/_src/`（.gitignore），不要在交付里引用。
- UI 文案保持简体中文。

---

## 2. 抽动问题的根因与证据

### 根因

StPageFlip 在翻页时会创建 `.stf__outerShadow` / `.stf__innerShadow` / `.stf__hardShadow` 等绝对定位元素，动画中它们的旋转包围盒会向书下方伸出很远。书宿主 `.book` 没有裁剪时：

- 翻页约 800ms 内 `document.scrollHeight` 从 1000 涨到 1218；
- 浏览器竖向滚动条出现 → 视口可用宽度少约 15px；
- 栅格重新分配（左栏/右栏/书宽都变）→ 视觉上像“整页缩放抽动”。

用户手动确认了现象描述：“可翻动的页面会把浏览器上下滑动条调出来，导致屏幕产生缩放，看起来就像抽动。”

### 已落地修复

1. `web/css/fabric.css` 的 `.book` 增加 `overflow: hidden`，裁掉所有翻页影子溢出（约第 389–396 行）：

```css
.book {
  position: relative;
  width: min(1000px, 100%);
  overflow: hidden; /* 裁掉翻页影子溢出，避免翻页时整页出现/消失滚动条 */
  filter:
    drop-shadow(0 4px 10px rgba(92, 58, 34, .16))
    drop-shadow(0 26px 44px rgba(92, 58, 34, .24));
}
```

2. 桌面端给滚动条预留固定槽位（**只在 ≥941px 生效**，避免手机被白吃 15px 宽），`fabric.css` 第 41–46 行：

```css
@media (min-width: 941px) {
  html { scrollbar-gutter: stable; }
}
```

3. `.theater` 背景加 `width: 100vw`，盖住滚动条槽位，避免桌面右侧出现一条 15px 米色空白（`fabric.css` 第 57–65 行）。

4. 翻页影子裁切对画面无影响：中帧截图对比裁/不裁一致；书自身的投影来自 `.book` 的 `filter: drop-shadow`，不受影响。

### 复现/验证方法

用 Playwright 在翻页前启动 rAF 采样，点击 `#next` 后逐帧记录：

```js
{ scrollHeight: document.documentElement.scrollHeight,
  clientWidth: document.documentElement.clientWidth,
  innerWidth }
```

修复前：`1000 → 1218`，且 PerformanceObserver 能抓到 layout-shift。
修复后：1440×900、1440×1000、1920×1080、1366×768、1280×800 等尺寸全程恒定，无 horizontal overflow。

> 注意：本机 Chromium 是 overlay 滚动条，`clientWidth === innerWidth`。要模拟经典滚动条宽度可加启动参数 `--disable-features=OverlayScrollbar`。
> 但因为 `.book` 已裁掉溢出，翻页本身不再改变 scrollHeight；`scrollbar-gutter` 只是保险。

---

## 3. 本次响应式改动（已写入 web/，尚未进 dist）

### 3.1 短视口按高度收紧书宽

`fabric.css` 第 437–440 行：

```css
/* 短视口：按高度收紧书宽，标题 + 书 + 翻页条都能留在首屏内，不触发滚动条 */
@media (min-width: 660px) and (min-height: 600px) and (max-height: 960px) {
  .book { max-width: min(100%, calc((100vh - 326px) * 1.536)) !important; }
}
```

公式来源：

- 书是双页展开，书宽 = 页宽 × 2，书高 = 页宽 × 560/430 = 书宽 × 0.651。
- 书上方栈高 + 翻页条 + 底部留白 ≈ 326px（标题 94 + marquee 约 122 + reader padding 18 + gap 10 + bar 56 + 底部 26）。
- 要让 `barBottom ≤ 100vh`，书高 ≤ `100vh - 326`，所以书宽 ≤ `(100vh - 326) × 1.536`。

**必须保留 `!important`**：PageFlip 初始化会给宿主写内联 `width: 100%; max-width: 920px;`，普通 CSS 优先级覆盖不了。若不想用 `!important`，可改成外层 `.book-frame` 限宽（需要同步改 HTML/JS，不推荐现在做）。

### 3.2 941–1120px 收窄左侧控制台

`fabric.css` 第 442–445 行：

```css
@media (min-width: 941px) and (max-width: 1120px) {
  .workbench { grid-template-columns: minmax(232px, 260px) minmax(0, 1fr); gap: 16px; }
}
```

原因：PageFlip 在宿主宽度 < `2 × minWidth(=300)`，即 < 600px 时会切到 portrait（单页竖排）。1024px 宽时若左栏仍为 344px，右栏只有约 580px → portrait 580×755，翻页条被挤到首屏外。左栏收窄到 260px 后右栏约 663px → 恢复双页展开，书 663×432，翻页条约在 730px。

### 3.3 ≤940px 单列、绘本优先

`fabric.css` 第 447–453 行：

```css
@media (max-width: 940px) {
  .workbench { grid-template-columns: 1fr; }
  .panel { position: static; }
  .stage { padding-top: 96px; }
  .reader { order: -1; }
}
```

原因：之前手机上首屏只有输入面板，绘本要滚过整块面板才看得到。现在首屏是“标题 + 完整绘本 + 翻页条”，面板随后。实测 390×844 与 768×1024 都能完整放下绘本和翻页条（390 宽时 portrait 单页）。

### 3.4 其他小修

- `.book-glow` 改为 `left: 50%; transform: translateX(-50%)`，书变窄时光晕仍居中（`fabric.css` 第 376–387 行）。

---

## 4. 当前 dist 与源码的差异（重要！）

`dist/` 最后一次成功构建是在以下 3 处修改**之前**：

1. `scrollbar-gutter` 从全局改为仅 `≥941px`（全局版会让手机 390px 视口的内容宽度只剩 375px，实测书从 358→343）。
2. `.theater` 加 `width: 100vw`（覆盖滚动条槽位的米色条）。
3. `.book` 的短屏限宽从 `width: ...`（无效，被内联样式覆盖）改成 `max-width: ... !important`（生效）。

所以现在打开 http://localhost:5173 看到的仍是旧布局：1366×768 书仍为 782×509、翻页条 809（超出首屏）。

**接手后第一步必须先 `npm run build`。**

---

## 5. 验收步骤（可直接照做）

### 5.1 构建 + 基础指标

```bash
cd C:/Users/35975/Desktop/hacks/wmu-hack-workbuddy
npm run build
node .shots/check.mjs
```

`.shots/check.mjs` 会遍历下列视口，打印方向/书尺寸/翻页条底边/scrollHeight/滚动条宽度/横向溢出，并在 `.shots/fit_<W>x<H>.png` 截图：

`1920×1080, 1440×900, 1536×864, 1366×768, 1280×800, 1280×720, 1024×768, 940×768, 768×1024, 390×844, 360×780`

**构建后的预期（允许 ±3px）**：

| 视口 | 方向 | 书尺寸 | 翻页条底边 | 说明 |
|---|---|---|---|---|
| 1920×1080 | landscape | 782×509 | ~916 | 不受限宽影响 |
| 1440×900 | landscape | 782×509 | ~820 | 首屏完整 |
| 1536×864 | landscape | 782×509 | ~809 | 首屏完整；页面可能因左栏略高仍有滚动条 |
| 1366×768 | landscape | **约 679×442** | **~742** | 限宽生效，翻页条必须完整可见 |
| 1280×800 | landscape | **约 728×474** | **~774** | 限宽生效 |
| 1280×720 | landscape | **约 605×394** | **~694** | 限宽生效 |
| 1024×768 | landscape | 663×432 | ~730 | 左栏 260 宽；不再 portrait |
| 940×768 | landscape | 679×442 | ~740 | 单列，书在上、面板在下 |
| 768×1024 | landscape | 701×456 | ~781 | 单列；首屏完整 |
| 390×844 | portrait | 约 358×466 | ~751 | 单列；首屏完整 |
| 360×780 | portrait | 约 328×427 | ~700 | 首屏完整 |

所有尺寸都必须 `hOver=false`（无横向溢出）。纵向滚动允许：短屏左栏内容（事实清单）本身高于视口，页面可纵向滚动是正常的；关键是**翻页不得改变 scrollHeight**。

### 5.2 翻页防抽动回归

```bash
node .shots/probe4.mjs   # 有头 Chromium，1440×1000，点击 #next 前后逐帧采样
```

再手动跑一次 1366×768（把 `probe2.mjs` 的 viewport 改成 1366×768 即可）：
- 翻页前后 `scrollHeight` 保持 879；`clientWidth` 不变；
- 不应出现新的 layout-shift entry；
- 若模拟经典滚动条（`--disable-features=OverlayScrollbar`），`clientWidth` 在翻页前后也必须恒定（`scrollbar-gutter: stable` 应保证这一点）。

### 5.3 视觉验收

至少检查这些截图/页面：

1. `fit_1366x768.png`：标题 + 书 + 翻页条完整；左栏底部可被裁切（正常）。
2. `fit_1024x768.png`：书是双页展开（不是大竖版封面）；翻页条完整。
3. `fit_390x844.png`、`fit_768x1024.png`：首屏是绘本不是输入面板；书和翻页条完整。
4. 桌面右侧边缘：不能出现 15px 米色竖条（`.theater` 100vw 是否生效）。
5. 点击 `#next` 翻到第 2–5 页，检查跨页文字/立牌无裁切、无溢出；重点看豆豆“战斗”全幅页与徽章页。
6. 点击 `#sample` 换病例：书必须重新出现且可翻页（渲染逻辑不要改坏，见第 7 节）。

### 5.4 控制台/网络

```bash
node .shots/errors.mjs   # 若无此脚本，用 Playwright 监听 console/pageerror/requestfailed 自建
```

要求：无 console error、无 pageerror、无 failed response（Google Fonts 被墙时的字体请求失败可忽略，但页面必须正常显示中文字体回退）。

---

## 6. 允许的微调（若验收发现小问题）

- **941–1120px 书内文字偏小**：双页每页约 300–380px（设计基准 430px，缩放 0.70–0.88）。若认为不可读，可把该区间的左栏再收窄到 240px，或把 `PageFlip` 的 `minWidth` 从 300 降到 280（需确认 portrait 切换阈值后同步调整）。不要在没截图对比的情况下大改。
- **短屏桌面仍有纵向滚动条**：因为左栏 `.panel` 固定高约 641px，加上标题后 768px 高不够。若想首屏完全无滚动条，可只对 `(max-height: 860px)` 压缩左栏（hint 字号/间距/事实卡 padding）。属于可选优化，改前先截图。
- **手机小高度（如 390×667）**：portrait 书高 466 + 标题 ≈ 750 > 667，需要滚动，属正常；不要为了塞进首屏把书缩得过小。
- **横屏手机（如 844×390）**：高度 < 600，限宽规则不生效，书会较大并需要滚动，可接受。

---

## 7. 不要改坏的东西 / 已知坑

1. **`renderBook()` 的销毁重建逻辑**（`web/js/app.js:249-294`）
   `PageFlip.destroy()` 会把宿主 `#book` 从 DOM 里摘掉；代码必须重新创建 `.book` 并插到 `.reader__bar` 之前。这是换病例时书消失 bug 的修复，不要回退。
2. **PageFlip 初始化参数**（`web/js/app.js:266-280`）
   `width:430/height:560`、`size:'stretch'`、`minWidth:300`、`maxWidth:460`、`minHeight:390`、`maxHeight:599`、`usePortrait:true`。`maxWidth` 会变成宿主内联 `max-width:920px`，这也是短屏限宽必须 `!important` 的原因。
3. **`.book { overflow: hidden }`**：不要删。它是抽动修复的核心。
4. **立牌构图**（`web/css/book.css:77-107`）
   `object-position: center bottom`、`page--full` 的 `bottom:26%`、双立牌 `max-width:46%/38%`、第二只 `scaleX(-1)`。这些是之前逐页验收修好的，不要为了适配随手改。
5. **背景图不要重新生成**：`web/assets/ui/stage.webp` 已定稿；`docs/prompts.md` 里记录了生成 prompt，但交付阶段不需要再跑。
6. **`.shots/` 是 gitignore 的 QA 脚本目录**，Playwright 路径是硬编码的：
   - Chromium：`C:/Users/35975/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe`
   - Playwright 模块：`C:/Users/35975/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright`（用 `createRequire` 引入）
   如果换机器/版本，改这两个路径。
7. **dev server 的 `Cache-Control: no-store`**，但服务的是 dist；CSS 改动后不 build 就不会生效。
8. 不要 `git reset/checkout`：工作区里有大量前序未提交的成果（背景替换、立牌、书页、构建产物）。提交前先 `git status`，且只有用户明确要求才提交。

---

## 8. 关键文件与位置

| 文件 | 作用 | 关键行 |
|---|---|---|
| `web/css/fabric.css` | 页面布局、背景、响应式 | 滚动条槽位 41–46；背景 57–65；书容器 389–396；光晕 376–387；短屏限宽 437–440；941–1120 左栏 442–445；单列绘本优先 447–453 |
| `web/css/book.css` | 书页、立牌、封面、尾页样式 | 书页基准 6–20；立牌 77–107；封面 173–247；全幅页 249–271 |
| `web/js/app.js` | 渲染/翻页/换病例 | 翻页按钮 47–48；`renderBook` 249–294；PageFlip 配置 266–280 |
| `web/index.html` | 页面骨架 | 面板/阅读区 28–52；vendor 脚本 59 |
| `web/assets/ui/stage.webp` | 舞台背景（唯一 AIGC 背景） | — |
| `tooling/serve.mjs` | dev server（服务 dist） | 第 1–6 行注释 |
| `tooling/build.mjs` | 构建 + 事实校验 | — |
| `.shots/check.mjs` | 全尺寸指标 + 截图 | 视口列表 |
| `.shots/probe2.mjs` / `probe4.mjs` | 翻页滚动条/scrollHeight 采样 | — |
| `.shots/panel.mjs` / `widths.mjs` / `gutter.mjs` | 左栏高度、宽度、gutter 诊断 | — |

---

## 9. 完成标准（Definition of Done）

- [ ] `npm run build` 成功，2 本绘本事实校验通过。
- [ ] 第 5.1 节所有尺寸 `hOver=false`；1366×768 / 1280×800 / 1280×720 / 1024×768 的翻页条完整可见（表格预期 ±3px）。
- [ ] 翻页全程 `scrollHeight` 与 `clientWidth` 恒定（含 1366×768 和模拟经典滚动条）。
- [ ] 桌面右侧无 15px 空白条；手机不再被 gutter 白吃 15px。
- [ ] ≤940px 首屏为“标题 + 完整绘本 + 翻页条”，面板在下方。
- [ ] 换病例、前后翻页、键盘左右键、`?page=N` 均正常。
- [ ] 无 console/page error、无 failed response（字体请求除外）。
- [ ] 至少目检：1366×768、1024×768、768×1024、390×844 四张首屏 + 一张跨页内容页。
- [ ] 最终 `dist/` 与 `web/` 同步（在交付前再跑一次 build）。

---

## 10. 下一步（按顺序）

1. `npm run build`
2. `node .shots/check.mjs`，对照第 5.1 节表格核对，看 `.shots/fit_*.png`
3. 发现偏差 → 按第 6 节微调 CSS → 回第 1 步
4. `node .shots/probe4.mjs` + 1366×768 采样，确认翻页零抖动
5. 目检桌面右侧边缘与移动端首屏
6. 最后再 `npm run build`，交付；把本文件删除或留档由用户决定

---

## 11. 追加（2026-10-30）：封面居中 + 先挪书后翻页

用户反馈：封面单页在书容器右半边，视觉偏右。已改成两段式：

- **封面/封底居中**：`showCover` 下封面是右半单页、封底（colophon）是左半单页。`landscape` 时给 `.reader` 加 `reader--cover` / `reader--back` class，`.book` 用 `translateX(∓25%)`（正好半页宽）把可见单页挪到阅读区正中。`transform` 不触发布局，防抽动修复不受影响。`portrait`（手机单页全宽）不处理。
- **先挪后翻**：`web/js/app.js` 的 `goNext` / `goPrev` 收敛了按钮 + 键盘入口。从封面往后翻先挪书、停稳 850ms（`.book` 过渡 .8s + 50ms 余量）再 `flipNext()`；连点由 `seqBusy` 守卫只翻一页。落在封面/封底是翻完再往中挪（由 `flip` 事件收尾），直接拖拽翻页不走排序、就地同步（`changeState` 只做移除不做添加，`read` 兜住被取消的手动折页）。
- 文件：`web/css/fabric.css`（`.book` 过渡 + 两个位姿 class）、`web/js/app.js`（`syncPose` / `goNext` / `goPrev`，`state.flip` 先赋值再初始同步）。
- 验证：封面偏移 -1px、尾页 0px；翻页+滑书全程 `scrollH/clientW` 恒定；11 视口回归与 §5.1 一致；手机端无位移；无 console/page error。

---

## 12. Appended (2026-10-30): flip leaf no longer boxed in

User complaint: mid-flip the turning page was hard-cut at the book box, looking trapped.
Root cause: `.book { overflow:hidden }` (the anti-jitter clip from section 2) cuts the leaf
that swings outside the box. Tried `overflow:clip + overflow-clip-margin` - measured that
Chromium counts the margin area toward document scroll, so jitter returned. Reverted.

Final mechanism - temporary detach during flip (`web/js/app.js` setFlipDetached +
`web/css/fabric.css` .flip-detached): on flipping/user_fold/fold_corner, all direct children
of `.stf__block` (pages + 4 PageFlip shadow divs) are moved to `.reader` with
`position:fixed !important; left/top 0 + margin var(--blkL)/var(--blkT)` (block viewport
origin, refreshed each flip). Paint is pixel-identical (verified mid-flip screenshots), but
fixed boxes never grow document scrollHeight. Restored to `.stf__block` (original order,
dead temp clones dropped via isConnected) on `read` / `flip` landing. renderBook() restores
first so a mid-flip sample switch leaves no orphans. `.book` itself is now overflow:visible.

- Verified: inner/cover/back flips all single-state scroll (900/1440 etc.), 11-viewport check
  identical to section 5.1, mobile portrait unaffected, panel/controls clickable, no errors.
- Also fixed: sample switch now resets #pageinfo to cover (was stale until next flip).
- Note: section 7 item 3 (`overflow:hidden` do-not-remove) is superseded by this mechanism -
  scroll stays flat by construction (probe-verified), keep it that way on future edits.
- Untested: drag-flip paths share the same changeState hook but were not exercised with a
  real pointer drag; button/keyboard/corner-click paths verified.

---

## 13. Appended (2026-10-30): even pages / occlusion / prop sizes / cover guard / glide rhythm

Story now 9 content pages + cover + colophon = 10 faces (even). Spreads [0],[1,2]..[7,8],[9]:
colophon lands single-left as back cover (parent notice), centered by existing reader--back pose.
Added page: injection.json promise (discharge promise: water/handwash/mask, grounded in raw notice,
fact-free). No other books touched (both already even).

Occlusion fix (drip full page, long caption buried the prop): new opt-in `"stand": "high"` on the
skeleton page -> assemble.mjs passthrough -> app.js pageHTML adds `page--stand-high` -> book.css
`.page--stand-high .page__props { top:19%; height:38%; centered }`: prop stands upper-middle,
feet kiss caption top. Measured: prop 22-56%, caption top 56%. Only drip uses it.

Prop size match: `.page__props img:nth-child(2)` height 68%->92%, max-width 38%->46%
(full variant too, mirror kept). Both stands width-bind to equal height. Verified on invite
spread (doctor+nurse equal) and wake spread.

Cover guard (manual flip = button feel): `#book .cover-guard` (absolute inset 0, z50, only
displayed under .reader--cover) swallows mousedown (button 0) / tap (touch <10px, <400ms,
scroll passes through via touch-action:pan-y + passive listeners) and runs goNext() sequencing.
Guard hides with the pose class; interior drags stay direct PageFlip. Verified: mousedown on
cover -> still cover at 500ms, 2/10 by 2000ms, guard display none after; interior drag 2/10->4/10.

Glide rhythm retune (click-MOVE-stop-FLIP): .book transition ease -> cubic-bezier(.2,.7,.3,1)
(fast attack, firm stop) + POSE_GLIDE_MS 850->1000 (200ms full stop). Measured: tx -195->0
over 50-800ms, still 800-1000, flip lands ~1760. Sofa placement for drip prop measured against
scene_drip_rain geometry (seat ~55.6% page height): prop 22-56% centered over armchair.

Regression: build 3 books pass (9 content pages each), 11 viewports match 5.1 baseline,
5 desktop flip probes single-state, no console/pageerror/failed, mobile portrait flat.

---

## 14. Appended: cover group photo

Cover was an empty curtain stage (cover branch ignored page.props). Now renders
`page__cover-cast`: 3-piece cast standing center-stage above the title plate
(book.css: absolute, bottom 198px, h148px, equal heights, drop shadow). Cast per book
(villain center): doudou [doctor__wave, villain_pebble__happy, nurse__wave],
guoguo [doctor__wave, villain_volcano__wow, nurse__wave] (no __happy pose exists for
volcano - vol4 sheet only has angry/smug/wow/sad), miaomiao [doctor__wave,
villain_corona__happy, nurse__wave]. assemble.mjs already passes cover props through;
only pageHTML cover branch + 3 skeletons changed. Verified all 3 covers render 3/3.

Cover grounding fix: title plate is now a solid felt card (was floating white text),
cast sits in-flow directly atop it with -10px tuck (feet behind card = standing).
Title/sub recolored dark for card legibility. All 3 covers verified standing, no float.

Cover revert per user: title back to floating white text (z3, over legs), cast absolute
bottom 129px = feet on floor line 77%. Text-over-legs accepted.

Cover feet grounding: measured solid-pixel bottom gaps (pebble 24px vs doctor/nurse 4-5px,
corona 12px, render px) - fluffy feet end in feathering. Added `cover--<skeleton.key>` class on
cover page + per-book C-slot nudge (appendectomy +19px, injection +7px, volcano +1px skipped).
Faint hem slides behind title plate (z3 over cast z2), solid feet land on common baseline.

Colophon -> parent notice: title changed to parent notice, personalized lead
(child + procedure), same fact-evidence table, usage guidance (read together night
before, badge page on the way). Dropped the skeleton-brand footer to fit. All 3 backs
verified no-overflow.

Colophon tone fix per user: not usage tips but professional companion instructions.
Title parent notice -> companion instructions; closing = follow table for prep, report
discomfort/questions to staff promptly. No new numbers, no diagnoses. Verified fit on 4-fact book.

Colophon trimmed per user (red-X on the intro paragraph): dropped the personalized lead,
kept title + fact-evidence table + companion closing only.

Colophon cards removed per user: fact rows are now plain text with hairline separators
(no white rounded boxes). Closing sentence kept.

Fonts unified inside the book: .page now sets font-family var(--font-round), so body
text/evidence/colophon/badge all match headings; flip bar label too. Panel console untouched.

---

## 15. Appended (2026-10-30 晚 · Kestrel): 徽章页裸放素材 + 仓库卫生

**徽章页**（`web/js/app.js` badge 分支 + `web/css/book.css`）
- 删掉手绘圆盘 `.badge-coin`（圆形渐变 + 虚线描边 + 内嵌标题文字），素材裸放。
- 新增 `.badge-art`：`width: min(292px, 80%)`，仅保留一层 drop-shadow。
- 称号与名字拆成两级：`.badge-name`（称号，19px，`#9a7433`）、`.badge-engrave`（患儿名，25px，`#6f4d1c`），正文 `.badge-text` 12.5px。
- 三本（豆豆/苗苗/果果）徽章页均已截图确认：不溢出、三行文字在页内收住。

**素材目录**
- 34 个占位 SVG 从 `assets/{scenes,characters,badges}/` 迁到 `assets/_placeholder/`，与真图彻底分离。
- `tooling/placeholders.mjs` 的生成路径与 manifest 兜底路径同步改到 `_placeholder`；构建输出 `真实素材 34，占位 0`，即当前无任何 id 会回落到占位图。

**新增 URL 参数**：`?case=N`（0 起）直接打开第 N 本，配合 `?page=N` 用于演示和回归截图。

**仓库**
- `.gitignore` 增补 `rawpic/`、`.cutout-profile*/`（`assets/_src/`、`.venv/`、`.shots/`、`dist/` 原本已忽略）。
- 首次完整提交：`3fbab03`（104 文件），随后 `530bde3`（?case 参数）。此前仓库只有 starter 一个 commit，其余全是 untracked。

**回归**（本次改动后）
- `npm run build`：3 本全过事实保真校验。
- 1440×900 iframe 内实测：无横向溢出（scrollW 1425 < clientW 1440）、三本各 10 面、21–24 张图 0 坏图、无 console/pageerror。
- 未改动：翻页防抽动机制、封面/封底位姿、立牌构图、stage.webp 背景。

---

## 16. 微调（Kestrel）：翻页条下移 6px

- `.reader__bar` 加 `margin-top: 6px`（书与条之间从"贴着"变成"留一口气"，用户要求只动一点点）。
- 同步把短屏限宽公式里的常量 `326px → 332px`（`.book { max-width: min(100%, calc((100vh - 332px) * 1.536)) }`），
  否则短屏会因为这 6px 把翻页条挤出首屏。1366×768 实测条底边 757 < 768，仍在首屏内。

---

## 17. 追加（Kestrel）：输入改成受控词表，砍掉自由文本

**定位变化**：从"贴一张纸"改成"选四下"。系统不认字，也不让人写字 —— 没有自由文本，就没有"读错"这一层风险。

- 新增 `web/engine/catalog.json`：4 科室 / 9 术式 / 5 麻醉 / 3 装置。**只描述病种，不含任何默认数值**（默认值＝揣测，已删除）。
- 新增 `web/engine/compose.mjs`：选择 → 病例；没选＝缺失；缺口反推 `questions`（只问事实，不问感受/风险，最多 3 条）。
- `assemble.mjs`：无骨架术式 → **清单书**（只出事实 + 注意事项，不编故事）；缺事实的页 → **conditional 条件句**（"如果……"），整页跳过只在没有条件句时发生。
- 前端：去掉 textarea，改三级级联 + 麻醉 / 禁食 / 禁水 / 住院 / 装置；数字一律"未确认"，只有演示病例（`catalog.presets`）预填。
- 面板：版本状态条（已确认 / 草稿 / 清单）+ 缺口提示；短屏（≤880px 高）压缩密度并允许面板内滚动。
- 封底：草稿版追加「带去问医生的几件事」；无事实时显示占位说明。
- `mcp/server.mjs` 重写：`list_catalog` + `build_preop_book`，**只收枚举与整数，无 text 参数**；未知术式直接拒。旧的 `parse_preop_notice` 与 `list_skeletons` 已删除。

**三态判定**：`missing.length === 0` → confirmed；否则 draft；术式无骨架 → checklist。B（家长自述）只能产出 draft，confirmed 必须来自受控选择。

**验证**：5 份演示病例（`?case=0..4`）全部渲染、0 坏图、无 console error、无横向溢出；1366×768 面板完整可见。

---

## 18. 追加（Kestrel）：接入家庭/主角角色，manifest 改为扫目录

- `tooling/placeholders.mjs`：manifest 不再写死清单，改为扫描 `assets/{scenes,characters,badges}/`，id 即文件名（同 id 多扩展名按 png > webp > jpg > svg 取一）。当前 59 项全部为真实素材。
- 新角色接入骨架：`mom` / `dad` / `kid_boy` / `kid_girl` / `friend` / `villain_dino`。
- **主角按性别展开**：骨架里写 `kid:stand` / `kid:sleep` / `kid:cheer`，装配层按 `child.gender` 展开成 `kid_boy__*` 或 `kid_girl__*`。前端加了「性别」选择（姓名/性别/年龄三列）。
- 三本骨架 props 重排：封面 = 家长 + 孩子 + 反派；遇见 = 反派生气；邀请 = 医生 + 孩子；禁食 = 孩子；麻醉 = 孩子睡着 + 护士（场景换成 `scene_ward_bed_close`）；留置针 = 护士 + 孩子；对峙 = 医生 + 反派；醒来 = 孩子欢呼 + 妈妈抱抱。
- **特写场景撤掉全身立牌**：`scene_butterfly_hand`、`scene_ward_bed_close` 是微距构图，全身人偶站上去比例失真，这两页 props 置空（页面靠场景本身叙事）。
- 清单书封面加 `kid:stand` + `villain_dino__peek`（"还不知道是什么怪兽"的视觉隐喻）。
- 封面三人组：height 148 → 176，bottom 129 → 152（脚踩在标题牌上沿，不再被牌面吞掉）。

未用上的素材：`dad__*`、`friend__*`、`villain_dino__back/shy/sleep`。要用 dad 需要再加一个"家长性别"选择 + `parent:*` 展开规则。

---

## 19. 修正（Kestrel）：人物浮空 / 床上没人 / 护士消失

三个症状，三个不同根因：

**1. 人物浮空** —— 24 张角色图是分别生成的，每张的透明留白不同。按 `height` 摆放时"图底边"不等于"脚底"，于是有人站地上、有人浮半空。
- 新增 `tooling/normalize.mjs`：逐张 ①去绿边（绿通道高于 R/B 的像素压回中性，绿差大的同时削 alpha）②裁到不透明包围盒（阈值 12/255，留 2% 呼吸位）。处理后图底边即脚底，`height` 才等于视觉高度。
- 原图备份在 `assets/_characters_backup/`（已 gitignore）。

**2. 床上没人** —— 上一轮我把 `cloud` 页 props 清空、场景换成空床特写，结果是空床。
- 新增 `stand: "bed"` 版式：睡姿立牌按"床面"定位（居中、上留 12%、右移 12%、宽 56%），不按脚底贴边。
- `appendectomy` / `tonsillectomy` 的 `cloud` 页、`injection` 的 `drip` 页改为 `kid:sleep` + `stand: "bed"`。

**3. 护士消失** —— 同样是我上一轮把 `needle` 页 props 清空导致的，不是素材缺失。
- `needle` 页恢复 `nurse__wave + kid:stand`。

封面基线与橱窗一致：三人组 `bottom: 129px`（舞台地面线 77%），height 176。

---

## 20. 体型比例（Kestrel）：角色身高表 + 构建期校验

**问题**：所有立牌都按 `height: 92%` 等高渲染，医生和孩子一样高。根因有三层：

1. 没有角色身高表 —— 谁该比谁高，代码里没有这回事。
2. webp 角色（doctor / nurse / villain_*）没裁透明留白，图高 ≠ 角色高，即使有表也会偏。
3. 立牌尺寸以「图片区高度」为基准（props 在 `.page__img` 内），同一角色在不同页会变高。

**改法**：

- 新增 `web/engine/proportions.json`：`roles` 角色系数（患儿 1.00 基准）+ `poses` 姿势系数（跪/坐/趴各自折减，否则跪姿会被拉到与站姿等高）。表随 manifest 下发，前端与 MCP 共用。
- `assemble.mjs` 的 `asset()` 输出 `scale = 角色系数 × 姿势系数`，前端渲染成 `style="--s:1.5"`。
- `book.css`：`height: calc(var(--ph) * .4 * var(--s) * var(--k))`
  - `--ph` 由 JS 写入（翻页器 scale 后的实际页高），`ResizeObserver` 跟随窗口变化；
  - `--k` 是「同框系数」：单人 1、双人 .72、三人 .54（人越多整体越小，但相互比例不变）。
- 新增 `tooling/trim-webp.mjs`：Chrome headless + canvas 裁 webp 透明留白（22 张，840×1040 → 内容包围盒），让「图高 = 角色高」。
- 新增 `stand: "micro"` 版式：手背留置针这类微距场景，立牌缩到 .5 压在下角，读作「画面边角的讲述者」，不与近景比大小。
- `make-cases.mjs` 增加 `MISSING_PROPORTION` 校验：骨架引用的角色若不在比例表里，构建直接失败（否则会静默回落到 1.0，医生又变回和孩子一样高）。

**当前比例表**（患儿 = 1.00）：爸爸 1.50 / 医生 1.50 / 妈妈 1.44 / 护士 1.42 / 火山怪 1.20 / 小恐龙 1.32 / 同龄朋友 0.96 / 小尾巴怪 0.90 / 冠冠怪 0.72。

**验证**：五本实测计算高度严格成比 —— 双人页医生 219.9px / 患儿 146.6px = 1.500，护士 208.2 / 146.6 = 1.420；三人页 164.9 / 109.9 / 156.1 = 1.5 / 1.0 / 1.42。五本 10/10/10/10/2 面、0 坏图、0 立牌越出页顶。

---

## 21. 修（Kestrel）：翻页时人物大小抽动

**现象**：点翻页，画面上的人物会瞬间放大一下再回去。

**根因**：`--ph`（立牌尺寸基准，= 页高 px）写在 `#book` 上。翻页时 `setFlipDetached()` 会把 `.stf__block` 里的页面元素临时搬进 `.reader` —— 元素一离开 `#book` 就继承不到 `--ph`，`calc(var(--ph, 560px) * …)` 回落到默认 560px。509 → 560 是 +10%，于是所有立牌在翻页瞬间放大一成，翻完搬回去又缩回。

**改法**：

- `--ph` 改写到 `document.documentElement`（`:root`），元素搬到哪儿都还是同一个基准。
- 尺寸同步从 `ResizeObserver(.page)` 改为事件驱动：换书时算一次（含 `requestAnimationFrame` 与 120ms 各补一次，等 PageFlip 定尺寸），窗口 resize 防抖 260ms 再算。翻页过程中永不重算。
- `clientHeight` 取整（`Math.round`），避免 509.015625 这类亚像素值引起重排。

**验证**：连翻 5 页 + 回翻 3 页 + 换书，采样 85 次立牌计算高度 —— 全部落在同一基准（183.24px / 219.888px …），不再出现 560 基准的 201.6px / 241.92px。残留 0.006px 的亚像素差，肉眼不可见。

---

## 22. 删（Kestrel）：词表移除「包茎 / 包皮」

比赛场景，可控优先。`catalog.json` 删掉 `gs/circumcision` 整组（病种 + 包皮环切术），全库零残留（`grep 包皮|包茎|circumcision` = 0）。

现词表：**4 科室 / 6 病种 / 8 术式**

| 科室 | 病种 → 术式 |
|---|---|
| 耳鼻咽喉科 | 扁桃体 / 腺样体 → 扁桃体切除、腺样体切除 |
| 小儿外科 | 阑尾 → 腹腔镜 / 开腹；腹股沟疝 → 腹腔镜修补（无骨架） |
| 儿内科 | 静脉输液、发热待查（无骨架） |
| 骨科 | 骨折 → 闭合复位石膏固定（无骨架） |

`腹股沟疝` 保留：它是唯一演示「清单书」（无专属骨架 → 只出事实 + 注意事项）的术式，删了会少一种形态；医学表述中性，不涉及隐私部位描述。

---

## 23. 修（Kestrel）：三级选择器的语义错位

**问题**：儿内科那一组写成「科室 儿内科 / 病种 静脉输液 / 术式 静脉输液治疗」—— 输液是**治疗手段**，不是病种；第二级应当放疾病名。

**全表按「科室 → 疾病 → 操作」重排**：

| 科室 | 病种 | 术式 / 处置 |
|---|---|---|
| 耳鼻咽喉科 | 扁桃体肥大 / 腺样体肥大 | 扁桃体切除术、腺样体切除术 |
| 小儿外科 | 阑尾炎 | 腹腔镜 / 开腹阑尾切除术 |
| 小儿外科 | 腹股沟疝 | 腹腔镜腹股沟疝修补术（无故事） |
| 儿内科 | 呼吸道感染 | 静脉输液 |
| 儿内科 | 发热 | 对症观察（无故事） |
| 骨科 | 骨折 | 闭合复位石膏固定（无故事） |

- 第一级原本写的「扁桃体 / 腺样体」「阑尾」是**部位**，一并改成疾病名（…肥大 / 阑尾炎）。
- 第三级标签从「术式」改成「术式 / 处置」—— 内科用"术式"不合适。
- `injection` 骨架的 `label`（封面类目）同步改为「呼吸道感染」。

**顺带**：状态条文案分三态 —— 清单「这类术式还没有专属故事」、草稿「其中 N 页是"如果……"」、已确认「事实齐全，无"如果……"页」。之前已确认的书也会显示"其中 0 页是如果"，读着像没排完。

---

## 24. 加（Kestrel）：通用模块页 + 面板默认无缓存

### A. 通用模块页（填了哪项，就出哪一页）

新增 `web/engine/modules.json`：只依赖「某一项事实」、与术式无关的页面。

| 模块 | 触发 | 页面 |
|---|---|---|
| `needle` | `facts.device.ids` 含 `iv` | 手上停一只小蝴蝶（micro 版式，场景 `scene_butterfly_hand`） |
| `fasting` | `facts.fasting` 存在 | 肚子空一会儿（场景 `scene_fasting_moon`） |

- `compose` 给 `facts.device` 补 `ids`（前端只存 label，模块要按 id 判断）。
- `assembleBook(caseObj, manifest, skeletons, modules)` 增加第 4 参数；`buildModules(existingIds)` 负责按 id 去重 —— 骨架里已有的 `needle`/`fasting` 页不会被重复插入（故事书写得更细，保留原版）。
- **清单书不再只有一页**：`checklist-cover` → 命中的模块页 → 偶数补齐 → 封底。例：疝气 + 留置针 + 禁食 = 4 面。

### B. 面板默认无缓存

- 三级选择器全部以「未选择」为初值（原来默认选中第一个科室第一术式，等于替人做了确认）。
- 启动不再加载演示病例：`?case=N` 才进演示，否则显示空白卡（`.book--idle`），状态条「未开始」。
- 未选术式点「缝一本绘本」→ 不生成，直接提示「请先选择科室、病种和术式」。
- 「换个病例」在空白状态下第一次点击从第 1 份演示开始（原来会跳过它）。

**验证**：空白 → 选科室（病种/术式仍为空）→ 选病种 → 选术式 + 数值 → 生成，得到 `cover | 手上停一只小蝴蝶 | 肚子空一会儿 | 封底` 4 面。五本演示 10/10/10/10/4 面、0 坏图；MCP 同输入返回同一份 4 面书。

---

## 25. 改（Kestrel）：演示病例只循环完整的三本 + 新增「新建病例」

之前 `presets` 五份混在一起，点「换个病例」会走到草稿版和清单书 —— 演示时容易踩到"这本没写完"的状态。

- `catalog.presets` 增加 `demo` 字段：`complete`（豆豆 / 果果 / 苗苗）、`partial`（只说了阑尾炎）、`no-story`（疝气）。
- 「换个病例」→ `applyDemo(step)`，**只在 `complete` 之间循环**，三本一圈。
- 新增「新建病例」→ `resetForm()` + `renderIdle()`，回到"什么都没确认"，并把演示游标归零（下次「换个病例」从豆豆开始）。
- 按钮排布：`缝一本绘本` 独占一行，`新建病例` / `换个病例` 并排在下（`.panel__row--sub`，更小的字号与内距）。
- `?case=N` 仍按完整 presets 数组索引，草稿 / 清单形态靠它单独查看（回归截图用）。

---

## 26. 修（Kestrel）：「装置」收敛为「留置针」

**问题**：词表里有三个装置（留置针 / 导尿管 / 引流管），但只有留置针有素材和文案。选了导尿管，页面就变成"护士会在手上放一只小蝴蝶 —— 那是**导尿管**"，图还是留置针那只手。

**改法**：

- `catalog.devices` 只留一项 `{id:'iv', label:'留置针'}` —— 没有素材就不要给选项。
- 面板标签「装置」→「留置针」，三选项：**未确认 / 会留一只 / 不留**。
  "不留"也是确认，与"未确认"分开：前者算事实齐全，后者进缺口并生成提问。
- 事实卡标签「手上装置」→「留置针」（骨架 ×3 + modules）。
- `compose` 支持 `devices:['none']` → `facts.device = { short:'不留', value_text:'不留留置针', ids:[] }`。
- `assemble` 的 `requires` 支持 `{fact, has_id}`：
  - 没有该字段 → 未确认，走"如果……"条件句
  - 有字段但不是 iv → **已确认不适用，整页跳过**（不会出现"你没留置针却讲留置针"）
- MCP `devices` 枚举增加 `none`，并写明语义。

**三态实测**（豆豆，阑尾切除）：

| 选择 | 面数 | 小蝴蝶那页 |
|---|---|---|
| 会留一只 | 10 | 「第三件事：手上停一只小蝴蝶」，正文"留置针就是那只小蝴蝶" |
| 不留 | 10 | 整页消失（补留白页保持偶数） |
| 未确认 | 10 | 「如果手上要留一只小蝴蝶」，无事实卡 |

---

## 27. 改（Kestrel）：清单书封面换成真封面

原来清单书第一页是"白纸说明页"（`layout: checklist`）—— 一张内页质感的卡片，写着"还没有故事"+术式名。放在封面位置，翻开来不像一本书。

- 清单书首页改为 `layout: 'cover'`，复用故事书封面结构：舞台场景图（`scene_cover`）+ 立牌 + 标题牌。
- `pageHTML` 的 cover 分支支持页面级覆盖：`page.cover = { kicker, title, subtitle, ribbon }`（故事书不传，仍用骨架的 `book.cover`）。
- 清单书封面文案：kicker = 术式全名 · 书名《XX的术前说明》· 副标"还没有专属故事 —— 先列出要确认的事实和要问的问题"· 丝带"术前 · 清单"。
- 两人组封面单独排布（`.cover--generic`）：立牌分站两侧、`bottom: 138px`，中间让出标题牌顶部的小字；kicker 字号收到 9px、底色加深（术式全名比骨架类目长）。
- 封面镜像规则改回 `nth-child(3)`：小恐龙是"捂脸偷看"的侧身素材，翻过来会变成背影，所以两人组不镜像。

**验证**：`?case=4` 首屏即为完整封面（舞台 + 孩子 + 小恐龙 + 书名牌）；故事书封面（`?case=0`）无回归，三人组仍保持"妈妈朝右、孩子朝右、反派镜像朝左"的对照。

---

## 28. 改（Kestrel）：怪兽不得大于患儿（设计语言变成硬约束）

**问题**：小恐龙 1.32、火山怪 1.20，比患儿（1.00）还高。同一页里怪兽比孩子大，故事读起来就是"威胁"，不是"陪伴"。

**比例表调整**（患儿 = 1.00）：

| 反派 | 原 | 现 |
|---|---|---|
| 火山怪 | 1.20 | 0.90 |
| 紫色小恐龙 | 1.32 | 0.82 |
| 小尾巴怪 | 0.90 | 0.78 |
| 冠冠怪 | 0.72 | 0.60 |

**变成硬约束**：`make-cases.mjs` 增加 `VILLAIN_TOO_BIG` 校验 —— 任何 `villain_*` 角色系数 > 1.00 直接构建失败。以后加新反派，写大了会被拦下来，不会悄悄上线。

**封面连带修的三处**：

- 立牌尺寸 `.30 → .36`（页高的比例），之前封面上人物偏小、舞台空。
- **类目药丸从书名上方移到书名下方**：上方正好是角色脚踩的位置，一直被脚压掉半截。现在是「书名 → 类目 → 副标」。
- `.cover--generic`（清单书）两人组单独排布：立牌分站两侧，中间让出文字。
- 封面镜像规则保持 `nth-child(3)`：两人组不镜像 —— 小恐龙是"捂脸偷看"的侧身素材，翻过来会变成背影。

---

## 29. 修（Kestrel）：圆底角色"浮空"、封面角色"溢出"

**浮空**：小尾巴怪 / 冠冠怪 / 小恐龙都是圆底、几乎没有腿的造型，按图片底边对齐时，底部弧线离地面线还差一截，看起来像飘着。

- `proportions.json` 新增 `offsets`：按角色给「基线下压」，单位是页高比例（`villain_pebble 0.022`、`villain_corona 0.02`、`villain_dino 0.016`）。
- `assemble` 的 `asset()` 带出 `dy` → `imgTag` 写成 `style="--dy:0.022"` → CSS `margin-bottom: calc(var(--ph) * var(--dy) * -1)`。
- 有腿的角色（医生 / 护士 / 家长 / 患儿）不配 offset，保持脚底精确对齐。

**溢出**：火山怪是三人里最宽的（762×983，宽高比 0.78），`.36` 的基准高度下，三个立牌总宽超过封面可用宽度，右边缘被切。

- `.page__cover-cast` 左右内距 20px → 12px。
- 立牌 `margin: 0 -6px`（绒毛边缘本来就透明，略微相互压过去不影响观感）。
- 兜底 `max-width: 34%`：真遇到更宽的素材也不会出框。

**验证**：豆豆本封面小尾巴怪底部与孩子脚底齐平、书名完整；果果本火山怪完整在框内；苗苗本清单封面两人同基线。《遇见怪兽》《医院门口》两页内页角色未被图片区裁切。

---

## 30. 修（Kestrel）：「麻醉方式」不只是文本，它决定这一页讲什么

**问题**：`cloud` 页（第二件事：坐一朵云）只把麻醉方式当作字符串塞进句子：

> 「局部麻醉，就是坐上这朵云。豆豆从一数到三，数到二的时候可能就睡着了。」

局麻不会睡着。孩子是清醒的，只是在动的地方没有痛觉。这句话直接讲错了。

**改法**：页面支持 `variants` —— 按某条事实的**取值**切换内容，而不是只替换文字。

```json
"variants": {
  "fact": "anesthesia",
  "cases": {
    "regional": { "title": "让一小块地方先睡着", "text": "…是醒着的…", "props": ["kid:hug"] },
    "local":    { …同上传… },
    "none":     { "skip": true }
  }
}
```

- `compose` 给 `facts.anesthesia` 补 `ids`（变体按 id 匹配，不靠 label 文本）。
- `assemble` 在 `src` 合并阶段套用变体；`skip: true` 则整页跳过（并进位面偶数补齐）。

**当前四档**：

| 麻醉 | 页面 | 立牌 |
|---|---|---|
| 全身麻醉 / 静脉镇静 | 「一朵会睡觉的云」 | `kid:sleep` 躺床 |
| 椎管内麻醉 / 局部麻醉 | 「让一小块地方先睡着」，正文明确"人是清醒的" | `kid:hug` 坐着抱云朵 |
| 不需要麻醉 | 整页不出现 | — |

**顺带**：`requiredFields` 里「静脉输液」原来要求填麻醉方式 —— 输液不需要麻醉，已经去掉。

**验证**：五档麻醉在真实页面里逐一生成，标题与正文均正确，面数恒为 10。

---

## 31. 修（Kestrel）：讲云的那一页，图换回云床

**问题**：麻醉页标题写「一朵会睡觉的云」，配图却是病房床头特写（`scene_ward_bed_close`）。文字讲云、画面是床，图文不一致。

- `appendectomy` / `tonsillectomy` 的 `cloud` 页 `asset` 改回 `scene_cloud_anesthesia`（云朵床漂浮在星空里，床上是空的，正好放睡姿立牌）。
- 全麻版：睡姿立牌按 `stand: "bed"` 落在云床上，头枕枕头、身体在毯子上，位置基本对齐。
- 局麻 / 椎管内版新增 `stand: "seated"` 版式：坐姿立牌（`kid:hug` 抱云朵）按画面中部定位（宽 27%、上留 27%），坐进云床中央，而不是站在画面底部。

**验证**：全麻 → 孩子躺在云床上；局麻 → 孩子坐在云床上抱着小云朵，正文"你是醒着的"与画面一致。

---

## 32. 修（Kestrel）：封底文字溢出

**现象**：家长陪护说明页最后一行"…请及时告知医护人员。"被切在页面底边外。

**原因有两层**：

1. 密集排版（`is-dense`）压得不够 —— 4 条事实 + 5 条注意事项 + 页脚，比设计时多出约 15px。
2. 版面压力的判定漏算了「带去问医生的几件事」—— 草稿书有 0 条事实，`facts.length + 注意事项条目` 只有 5，判不出 dense，于是用正常间距排，问题行一进来就溢了。

**改法**：

- `is-dense` 全面收紧：标题 19px、事实行 padding 9/7、出处 8.5px、注意事项行高 1.45、页脚 9.5px。
- 压力计算改为按**行数**：`max(事实数,1) + 提问数 + 注意事项条目`（没有事实时算上"数值尚未确认"那行占位）。
- 新增 `is-xdense`（>10 行）再压一档，防止将来注意事项更多的术式把页脚挤出去。

**验证**：豆豆（4+5）、果果（4+4）、草稿（0 事实 + 3 提问 + 5 注意）、清单（4+4）四本封底，页脚均在框内，底部留 25–35px 余量。

---

## 33. 体检（Kestrel）：稳定性与移动端

**压力测试（全过，0 error）**
- 空态点「缝一本绘本」→ 提示"请先选择科室、病种、术式"，不崩
- 连点 12 次 next（间隔 90ms）→ 停在 4/10，无报错、无重复面
- 回翻 6 次 → 回到封面
- 换书 → 重置到封面，10 面

**移动端 390×844**：页 343×447，`--ph` 正确写入 447，三个立牌最右 318 < 容器 319，**没有溢出**（此前误判）。

**顺手修**
- `syncPageHeight` 补 `[120, 400, 900]` 三次重试 —— PageFlip 窄屏定尺寸更晚，值未变时不触发重排。
- 空态文案「从左边选一个病种开始」→「先选一个病种」（手机上控制台在书下方，不是左边）。
- meta description 还停在"一张术前须知"，改为"医护选一个病种"。

---

## 34. 加（Kestrel）：打印 / 导出 PDF

**为什么不是"截图导出"**：家长要的是能带走、能印出来的东西，位图会糊。走浏览器打印管线，文字仍是矢量。

**做法**：

- `renderBook` 时同步烘一份 `#print-root`：用同一套 `pageHTML` / `colophonHTML` 重新生成**顺序排列**的静态页面副本（屏幕上那本是 PageFlip 的绝对定位 + transform，直接打印会重影）。
- 面板新增「打印 / PDF」按钮 → `buildPrintSheets()` 重烘 → `window.print()`；浏览器打印对话框里选"另存为 PDF"即可。
- 打印副本里的图强制 `loading="eager"` —— 懒加载的图不进视口不会解码，打印出来是空白页。
- 打印时 `#print-root` 的 `--ph` 覆盖为 560px（屏幕上是 509，立牌会偏小）。
- 页面尺寸 `@page { size: 430px 560px }`：一页一张、图像 1:1 不重采样。实测 10 页 PDF **10.7MB**（先试过 A4 + 1.66 倍放大，同样 10 页要 **34.9MB**）。
- 打印窗口的默认文件名取书名（临时改 `document.title`，打印结束再恢复）。

**验证**：`--print-to-pdf` 输出 10 页（9 正文 + 封底）；把 `#print-root` 临时显示出来逐页检查，封面 / 内页排版与屏幕一致。

---

## 35. 修（Kestrel）：导出的 PDF 是白底封面

**现象**：点「打印 / PDF」存出来的封面只有文字和角色，没有舞台背景（白底）。

**根因**：`#print-root` 为了不占位用了 `display: none`。**`display:none` 容器里的 `<img>` 不解码** —— 图片元素存在、`src` 正确、`naturalWidth` 是 0。翻到打印媒体时容器才变可见，而那一刻浏览器还来不及解码，于是场景图整片空白（角色和文字是内联的 png/svg 与文本，所以还在）。

**改法**：

- `#print-root` 改为**屏幕外常驻**（`position: fixed; left: -20000px; opacity: 0`），一直在渲染树里，图片随页面加载就解码。
- `printBook()` 改 async：打印前 `await` 所有图的 `img.decode()`，按钮期间显示"正在准备…"。
- 打印媒体下 `#print-root` 复位为 `static / opacity 1 / --ph: 560px`。

**验证**：`#print-root` 里 23 张图 `naturalWidth` 全部 > 0（含 `scene_cover.jpg:1024`）；把副本临时显示出来，封面完整呈现幕布、聚光、地板与三个角色。
