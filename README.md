# 术前绘本 · 布艺剧场版

给小朋友的「手术说明书」：把疾病变成角色，把治疗变成故事。
医护在受控词表里选三四下，输出一本属于这个孩子的布艺绘本，出院再给一枚角色徽章。

> 故事是虚构的，事实是真实的 —— 书里的每个数字都来自逐项确认，每句注意事项都原文照录。

---

## 1. 架构

```
受控词表录入（科室 → 病种 → 术式 + 麻醉 / 禁食 / 住院 / 留置针）
      │        web/engine/catalog.json：只描述"这种病"，不含任何默认数值
      ▼
web/engine/compose.mjs   选择 → 病例：只承载明确输入，没选＝缺失
      │                 缺口反推 questions：缺什么问什么，只问事实
      ▼
web/engine/skeletons/*   故事骨架 DSL（按术式选；缺事实的页整页不出）
      ▼
web/engine/assemble.mjs  确定性装配：无骨架 → 清单书；缺事实 → 该页不存在
      ▼
web/engine/validate.mjs  事实校验：孤儿数字 / 证据溯源 / 未确认字段混入正文
      ▼
web/js/app.js            布艺剧场 + 翻页阅读器（StPageFlip）
```

**三条入口，一份内容源**

| 入口 | 谁用 | 输入 | 产物 |
|---|---|---|---|
| A 受控选择 | 医生 / 护士 | 三级词表 + 数值逐项确认 | **confirmed** 绘本 |
| C 扫码取书 | 家长 | 住院号 / 二维码 | 读 A 已生成的那本 |
| B 家长自述 | 家长（经第三方 agent） | 自然语言 → 归一化到词表 | **draft** 绘本 + 提问清单 |

只有 A 能产出 confirmed 版。B 的产物永远是 draft：缺的字段不进书，只在封底变成"带去问医生的几件事"。

MCP 接口只收枚举与整数，**没有 `text` 参数** —— 调用方可以是大模型，但它没法把"大概禁食 8 小时吧"变成数字，因为 `fasting_hours` 要么是 0–24 的整数，要么不存在。揣测在 schema 层被挡住。

> 旧的自由文本路径（`parse.mjs` + `data/raw/*.txt` → `npm run cases`）保留作回归实验，前端已不再使用。

**一份引擎，两处复用**：浏览器现场装配（贴须知→即时出书），Node 构建期烘焙（`data/books/*.json`）。同一批骨架 JSON、同一套校验。

## 2. 命令

```bash
npm install
npm run placeholders   # 生成占位素材 + assets/manifest.json
npm run cases          # data/raw/*.txt → data/books/*.json（含校验报告）
npm run build          # 产物输出到 dist/（netlify.toml 已指向这里）
npm run dev            # http://localhost:5173 预览 dist/

**带走一本书**：点面板上的「打印 / PDF」→ 浏览器打印对话框里目标选"另存为 PDF"。
页面按 430×560 一页一张输出（9 正文 + 封底 = 10 页），文字是矢量的，图像 1:1 不重采样。
要印成 A4 纸，在打印设置里勾"适合页面"即可。
```

MCP 接口（零依赖 stdio）：

```bash
node mcp/server.mjs
```

注册到 WorkBuddy / Claude Desktop：

```json
{
  "mcpServers": {
    "preop-storybook": { "command": "node", "args": ["<绝对路径>/mcp/server.mjs"] }
  }
}
```

工具：`list_skeletons`、`parse_preop_notice`、`build_preop_book`。

## 3. 素材契约（接下来要补的东西）

素材 id 是对外契约，**同名文件覆盖即生效**，代码零改动。放入 `assets/scenes|characters|badges/`，支持 `.png .jpg .jpeg .webp`（优先于占位 `.svg`）。

| id | 类型 | 画面 | 建议尺寸 |
|---|---|---|---|
| `scene_cover` | 场景 | 封面舞台，主角位留白 | 1280×920 |
| `scene_throat_cave` | 场景 | 喉咙山洞，火山怪的窝 | 1280×920 |
| `scene_belly_pocket` | 场景 | 肚子右下角小口袋 | 1280×920 |
| `scene_ward_talk` | 场景 | 病房，医生蹲下来平视 | 1280×920 |
| `scene_fasting_moon` | 场景 | 夜里，空肚子与月亮 | 1280×920 |
| `scene_cloud_anesthesia` | 场景 | 一朵会睡觉的云 | 1280×920 |
| `scene_butterfly_hand` | 场景 | 手背上的小蝴蝶（留置针） | 1280×920 |
| `scene_hospital_front` | 场景 | 医院门前，医生与病毒对峙（比例失调） | 1280×920 |
| `scene_wake_up` | 场景 | 醒来，纱布与窗光 | 1280×920 |
| `villain_volcano` | 角色 | 火山怪（毛绒、圆钝棘突、腮红） | 840×1040 透明底 |
| `villain_pebble` | 角色 | 小尾巴怪 | 840×1040 透明底 |
| `doctor` | 角色 | 白大褂医生（玩偶化人形） | 840×1040 透明底 |
| `nurse_cloud` | 角色 | 云朵护士 | 840×1040 透明底 |
| `badge_star` | 徽章 | 小勇士徽章 | 800×800 |

风格基线：毛绒短绒（`dense short mohair fur`）+ 毡布场景 + 柔和影棚光，浅奶油/薄荷系配色。生成提示词见 `docs/prompts.md`。

网页舞美背景不在上述契约内：`assets/ui/stage.webp`（毛毡剧场，1792×1024）。原始生成图与角色/场景的透明底母版存放在 `assets/_src/`（已 gitignore，不进发布包）。

## 4. 演示脚本（60 秒）

1. 左栏贴一张术前须知（或点「换个病例」）。
2. 侧栏立刻列出抽取到的事实，每条下面带「原文：……」。
3. 右侧书翻开：封面 → 火山怪出场 → 医生登场 → 禁食页（带绿色事实卡）→ 麻醉页 → 留置针页 → 医院门前对峙 → 醒来 → 徽章。
4. 翻到最后一页：这本书里所有数字的原文出处。
5. 换个病例再点一次 —— 书名、角色、章节、事实卡全变，但骨架和画风一致。

## 5. 取舍（写在明处）

- **不实时生成角色与场景**：素材提前 AIGC 出图、人工筛过，前端只做拼装。生成稳定性和「每个孩子不同」不矛盾——不同的是故事骨架分支与事实，不是画风。
- **不做每例从零生成**：骨架 + 模块化素材，保证 8 页书 1 秒出。
- **轻输入**：输入是家长手里那张纸，不要求上传孩子照片（儿童面部 + 医疗场景的隐私风险不值得）。
- **医学事实零容错**：数字只从原文抽取并逐字注入，校验器拦「孤儿数字」。

## 6. 目录

```
web/            前端（引擎 + 布艺剧场 + 翻页阅读器）
web/engine/     解析 / 骨架 / 装配 / 校验（浏览器与 Node 共用）
assets/         素材与 manifest.json（id 契约）
assets/ui/      网页舞美背景（stage.webp，不进 manifest）
data/raw/       术前须知样本
data/books/     烘焙产物
tooling/        占位素材、批量烘焙、构建、本地预览
mcp/            MCP stdio 服务
```

依赖：`page-flip` (MIT, Nodlik/StPageFlip)，负责真实的翻页手感。布艺质感由 CSS（SVG 噪声颗粒 + 缝线 + 毡面内阴影）构建，背景是一张 AIGC 毛毡舞台图（`assets/ui/stage.webp`），无第三方 UI 框架。
