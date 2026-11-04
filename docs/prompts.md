# 素材生成提示词

统一风格基线：`dense short mohair fur`（毛绒玩偶感）+ 毡布场景 + 柔和影棚光 + 浅奶油/薄荷配色。
负面词：`realistic virus, scary, teeth, long fur, human face, sharp objects, gore`。

## 角色（透明底，840×1040）

**病毒怪（火山怪）**
```
A cute fluffy plush toy of a little virus monster character, standing full body,
chubby round body covered in dense short creamy-beige mohair fur,
a crown of soft rounded fuzzy spikes on top of its head (like coral antennae),
a few small pom-pom like protrusions on its back,
minimalist kawaii face: two tiny black dot eyes, gentle smile, soft blush cheeks,
short stubby arms and feet, plain light background, product photography, 3D render
```

**医生（玩偶化人形）**
```
A cute fluffy plush toy of a little doctor character, standing full body,
humanoid plush doll with chubby round proportions,
covered in dense short creamy-white mohair fur,
wearing a tiny white doctor coat with soft felt texture,
a small stethoscope around its neck,
minimalist kawaii face: two tiny black dot eyes, gentle smile, soft blush cheeks,
short stubby arms and feet, plain light background, product photography, 3D render
```

**小尾巴怪（阑尾炎）** —— 石头精，别做成病毒，做成一粒圆滚滚的小石头
```
A cute fluffy plush toy of a little pebble monster character, standing full body,
round grey-beige stone-like body covered in dense short mohair fur, slightly lumpy silhouette,
one small stubby tail at its back, two tiny pebble ears on top,
minimalist kawaii face: two tiny black dot eyes, small sulky mouth, soft blush cheeks,
short stubby arms and feet, plain light background, product photography, 3D render
```

**云朵护士** —— 薄荷绿手术帽 + 抱一朵云
```
A cute fluffy plush toy of a little nurse character, standing full body,
humanoid plush doll with chubby round proportions, dense short creamy-white mohair fur,
wearing a soft mint scrub cap and a pale mint nurse apron,
holding a small fluffy cloud-shaped pillow in both arms,
minimalist kawaii face: two tiny black dot eyes, gentle smile, soft blush cheeks,
short stubby arms and feet, plain light background, product photography, 3D render
```

## 场景（1280×920，毛毡 diorama）

**医院门前 · 对峙（比例失调）**
```
A cozy felt board diorama of a dramatic scene in front of a small children's hospital,
a tiny blue hospital building with a red cross on its roof far in the background on a green grassy hill,
in the foreground two giant oversized fluffy plush toy characters face each other,
a huge plush doctor toy in a white felt coat on the left,
a huge chubby plush virus monster with soft rounded fuzzy spikes on the right,
both characters much much larger than the hospital behind them, exaggerated scale,
they strike playful sparring poses like sumo wrestlers about to start a friendly match,
no violence, wool felt and cotton fabric texture, gentle stitches,
warm soft lighting, pastel colors, low camera angle,
handmade fabric craft style, children's picture book illustration
```

**通用场景模板**
```
A cozy felt board diorama of {场景}, made of soft wool felt and cotton fabric,
visible fabric texture and gentle stitches, warm soft lighting, shallow depth of field,
handmade fabric craft style, pastel colors, children's picture book illustration, no characters
```

`{场景}` 取：儿童医院病房（床边谈话）、夜里窗边的空盘子与月亮、一朵云做的床、
小手上的蝴蝶形留置针特写、醒来时的病房与窗光。

## 网页舞美背景（1792×1024，无角色）

```
A cozy wool-felt diorama stage set for a children's picture book theater, wide horizontal composition,
large empty quiet center, soft wool felt and cotton fabric in pale cream, warm ivory and muted dusty rose,
gentle sage-mint accents, dusty-rose felt curtains only at the far left and far right edges, gathered and tied back,
a shallow scalloped cream felt valance across the very top with hand stitches and a thin antique-gold cord,
warm cream felt back wall with soft stage light halo, pale sandy-beige felt floor with stitch lines and a spotlight pool,
shallow depth of field, warm soft studio lighting, handmade fabric craft, high-end miniature diorama photography,
pastel colors, children's picture book illustration, no characters, no people, no text, no letters, no logo, no watermark
```

产出 `assets/ui/stage.webp`（q88）。裁剪与文案对比度由 CSS 处理，背景本身保持低对比、中央留白。

## 拼装注意

- 场景出图**不要带角色**，角色立牌单独出，前端叠在场景上（`page__props`），这样 90 件素材能拼出大量画面组合。
- 角色统一 3/4 侧身站姿、朝向一致（面向右），叠图时不会撞脸。
- 同一角色多情绪版本命名加后缀（`villain_volcano__sleep.png`），装配层按 `props` 数组取基础版，暂不解析后缀。
