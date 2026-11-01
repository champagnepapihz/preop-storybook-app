/**
 * 占位素材生成器
 * 真实素材（AIGC 生成的毛绒/毡布图）到位后，直接同名覆盖 assets/ 下的文件即可，
 * manifest 里的 id 不变，装配层和前端都不用改。
 *
 * 用法：node tooling/placeholders.mjs
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 读取真实素材尺寸（png/jpeg/webp），失败时返回 null */
function imageSize(file) {
  const b = readFileSync(file);
  const ext = extname(file).toLowerCase();
  try {
    if (ext === '.png') {
      return [b.readUInt32BE(16), b.readUInt32BE(20)];
    }
    if (ext === '.jpg' || ext === '.jpeg') {
      for (let i = 2; i < b.length - 9; ) {
        if (b[i] !== 0xff) { i++; continue; }
        const marker = b[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
        }
        i += 2 + b.readUInt16BE(i + 2);
      }
      return null;
    }
    if (ext === '.webp') {
      for (let i = 12; i < b.length - 8; ) {
        const fourcc = b.toString('ascii', i, i + 4);
        const size = b.readUInt32LE(i + 4);
        if (fourcc === 'VP8X') {
          return [1 + b.readUIntLE(i + 12, 3), 1 + b.readUIntLE(i + 15, 3)];
        }
        if (fourcc === 'VP8 ' && b[i + 11] === 0x9d && b[i + 12] === 0x01 && b[i + 13] === 0x2a) {
          return [b.readUInt16LE(i + 14) & 0x3fff, b.readUInt16LE(i + 16) & 0x3fff];
        }
        if (fourcc === 'VP8L') {
          const v = b.readUInt32LE(i + 9);
          return [1 + (v & 0x3fff), 1 + ((v >> 14) & 0x3fff)];
        }
        i += 8 + size + (size % 2);
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

const SCENES = [
  ['scene_cover', '封面 · 舞台', '#f6e7cc', '#e2b98a', 'filmic'],
  ['scene_throat_cave', '喉咙山洞 · 火山怪的家', '#f4d9cf', '#d98f7c', 'villain'],
  ['scene_belly_pocket', '肚子右下角 · 小口袋', '#f4d9cf', '#d98f7c', 'villain'],
  ['scene_ward_talk', '病房 · 医生蹲下来', '#e8f0e6', '#9ecfbd', 'ward'],
  ['scene_fasting_moon', '夜里 · 空肚子与月亮', '#e5e8f2', '#9aa7cd', 'night'],
  ['scene_cloud_anesthesia', '云朵 · 数到三', '#e8eef6', '#a9c3de', 'night'],
  ['scene_butterfly_hand', '手背 · 小蝴蝶留置针', '#f3ece2', '#d3b79b', 'detail'],
  ['scene_hospital_front', '医院门前 · 大战', '#e3f1e2', '#8fc79c', 'hero'],
  ['scene_wake_up', '醒来 · 纱布与窗光', '#fdf1e0', '#e8c79a', 'ward'],
  ['scene_fever_night', '发烧的夜 · 小床与温水', '#e7e3f2', '#9a8fc4', 'night'],
  ['scene_drip_rain', '输液角 · 凉凉小雨', '#e8f0e6', '#9ecfbd', 'ward'],
];

const CHARACTERS = [
  ['villain_volcano', '火山怪', '#f2c9a0', '#c96f4a'],
  ['villain_pebble', '小尾巴怪', '#e0d0bc', '#a98a6d'],
  ['doctor', '白大褂医生', '#fbf6ee', '#8fb7a8'],
  ['doctor__wave', '白大褂医生 · 伸手', '#fbf6ee', '#8fb7a8'],
  ['doctor__cheer', '白大褂医生 · 打气', '#fbf6ee', '#8fb7a8'],
  ['nurse__hug', '云朵护士 · 抱抱', '#eef3f8', '#a9c3de'],
  ['nurse__wave', '云朵护士 · 挥手', '#eef3f8', '#a9c3de'],
  ['nurse__present', '云朵护士 · 献上', '#eef3f8', '#a9c3de'],
  ['nurse__cuddle', '云朵护士 · 轻抱', '#eef3f8', '#a9c3de'],
  ['villain_pebble__angry', '小尾巴怪 · 生气', '#e0d0bc', '#a98a6d'],
  ['villain_pebble__wow', '小尾巴怪 · 惊讶', '#e0d0bc', '#a98a6d'],
  ['villain_pebble__sad', '小尾巴怪 · 难过', '#e0d0bc', '#a98a6d'],
  ['villain_pebble__happy', '小尾巴怪 · 开心', '#e0d0bc', '#a98a6d'],
  ['villain_volcano__angry', '火山怪 · 生气', '#f2c9a0', '#c96f4a'],
  ['villain_volcano__smug', '火山怪 · 得意', '#f2c9a0', '#c96f4a'],
  ['villain_volcano__wow', '火山怪 · 惊讶', '#f2c9a0', '#c96f4a'],
  ['villain_volcano__sad', '火山怪 · 难过', '#f2c9a0', '#c96f4a'],
  ['villain_corona__happy', '冠冠怪 · 开心', '#d9c6ec', '#7d5ba6'],
  ['villain_corona__smug', '冠冠怪 · 得意', '#d9c6ec', '#7d5ba6'],
  ['villain_corona__wow', '冠冠怪 · 惊讶', '#d9c6ec', '#7d5ba6'],
  ['villain_corona__sad', '冠冠怪 · 难过', '#d9c6ec', '#7d5ba6'],
  ['nurse_cloud', '云朵护士', '#eef3f8', '#a9c3de'],
];

const BADGES = [['badge_star', '小勇士徽章', '#f6d98f', '#c99b3f']];

function feltSvg({ w, h, bg, accent, label, kind }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <radialGradient id="g" cx="50%" cy="38%" r="72%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity=".85"/>
      <stop offset="100%" stop-color="${bg}"/>
    </radialGradient>
    <filter id="grain">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="4" stitchTiles="stitch"/>
      <feColorMatrix type="saturate" values="0"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.35"/></feComponentTransfer>
    </filter>
    <filter id="soft"><feGaussianBlur stdDeviation="6"/></filter>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#g)"/>
  <ellipse cx="${w * 0.5}" cy="${h * 0.72}" rx="${w * 0.34}" ry="${h * 0.2}" fill="${accent}" opacity=".28" filter="url(#soft)"/>
  <circle cx="${w * 0.5}" cy="${h * 0.44}" r="${Math.min(w, h) * 0.18}" fill="${accent}" opacity=".55"/>
  <circle cx="${w * 0.44}" cy="${h * 0.41}" r="${Math.min(w, h) * 0.018}" fill="#4a3a2f" opacity=".7"/>
  <circle cx="${w * 0.56}" cy="${h * 0.41}" r="${Math.min(w, h) * 0.018}" fill="#4a3a2f" opacity=".7"/>
  <path d="M ${w * 0.47} ${h * 0.47} q ${w * 0.03} ${h * 0.02} ${w * 0.06} 0" stroke="#4a3a2f" stroke-width="2.5" fill="none" stroke-linecap="round" opacity=".7"/>
  <rect width="${w}" height="${h}" filter="url(#grain)" opacity=".5" style="mix-blend-mode:multiply"/>
  <rect x="10" y="10" width="${w - 20}" height="${h - 20}" rx="18" fill="none" stroke="#ffffff" stroke-opacity=".7" stroke-width="3" stroke-dasharray="9 7"/>
  <text x="${w / 2}" y="${h - 26}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="${Math.round(w / 26)}" fill="#5b463a" opacity=".72">${label}</text>
</svg>`;
}

/** 角色立牌：透明底、毛边、可压在场景上 */
function characterSvg({ id, bg, accent }) {
  const w = 420, h = 520;
  const spike = /volcano/.test(id)
    ? `<g fill="${accent}" opacity=".9">
         <circle cx="132" cy="150" r="26"/><circle cx="168" cy="118" r="30"/>
         <circle cx="210" cy="104" r="32"/><circle cx="254" cy="120" r="28"/>
         <circle cx="288" cy="152" r="24"/>
       </g>`
    : /pebble/.test(id)
    ? `<g fill="${accent}" opacity=".85">
         <circle cx="150" cy="140" r="18"/><circle cx="210" cy="120" r="15"/><circle cx="262" cy="146" r="16"/>
       </g>`
    : /doctor/.test(id)
    ? `<path d="M148 330 h124 v210 h-124 z" fill="#ffffff" opacity=".92"/>
       <path d="M210 330 v210" stroke="#cdd9d2" stroke-width="3"/>
       <path d="M232 372 q46 8 44 54 q-2 46 -44 52" stroke="#7f9b90" stroke-width="9" fill="none" stroke-linecap="round"/>
       <circle cx="248" cy="470" r="16" fill="#9dbbaf"/>`
    : `<ellipse cx="210" cy="128" rx="86" ry="42" fill="#ffffff" opacity=".9"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <radialGradient id="body" cx="42%" cy="30%" r="78%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="62%" stop-color="${bg}"/>
      <stop offset="100%" stop-color="${accent}"/>
    </radialGradient>
    <filter id="fur" x="-12%" y="-12%" width="124%" height="124%">
      <feTurbulence type="fractalNoise" baseFrequency="0.045" numOctaves="3" seed="3" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="10" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
    <filter id="grain">
      <feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="3" stitchTiles="stitch"/>
      <feColorMatrix type="saturate" values="0"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.5"/></feComponentTransfer>
    </filter>
    <clipPath id="clip"><ellipse cx="210" cy="382" rx="128" ry="128"/></clipPath>
  </defs>
  <ellipse cx="210" cy="500" rx="110" ry="18" fill="#3a2214" opacity=".18"/>
  <g filter="url(#fur)">
    <ellipse cx="210" cy="382" rx="124" ry="126" fill="url(#body)"/>
    <rect x="150" y="452" width="52" height="54" rx="26" fill="${bg}"/>
    <rect x="222" y="452" width="52" height="54" rx="26" fill="${bg}"/>
    <ellipse cx="118" cy="392" rx="34" ry="52" fill="${bg}" transform="rotate(-12 118 392)"/>
    <ellipse cx="302" cy="392" rx="34" ry="52" fill="${bg}" transform="rotate(12 302 392)"/>
    ${spike}
    <ellipse cx="210" cy="352" rx="74" ry="66" fill="#fffaf2" opacity=".92"/>
  </g>
  <g clip-path="url(#clip)">
    <rect width="${w}" height="${h}" filter="url(#grain)" opacity=".28" style="mix-blend-mode:multiply"/>
  </g>
  <circle cx="184" cy="342" r="8" fill="#3b2b20"/>
  <circle cx="238" cy="342" r="8" fill="#3b2b20"/>
  <circle cx="180" cy="339" r="2.6" fill="#fff" opacity=".9"/>
  <circle cx="234" cy="339" r="2.6" fill="#fff" opacity=".9"/>
  <path d="M196 366 q14 12 28 0" stroke="#3b2b20" stroke-width="4.5" fill="none" stroke-linecap="round"/>
  <ellipse cx="160" cy="360" rx="13" ry="8" fill="#e89b8a" opacity=".55"/>
  <ellipse cx="262" cy="360" rx="13" ry="8" fill="#e89b8a" opacity=".55"/>
</svg>`;
}

/** 徽章：透明底、齿边奖章 */
function badgeSvg({ bg, accent }) {
  const w = 400, h = 400;
  const teeth = Array.from({ length: 24 }, (_, i) => {
    const a = (i / 24) * Math.PI * 2;
    const r1 = 168, r2 = 188;
    return `${(200 + Math.cos(a) * r1).toFixed(1)},${(200 + Math.sin(a) * r1).toFixed(1)} ${(200 + Math.cos(a) * r2).toFixed(1)},${(200 + Math.sin(a) * r2).toFixed(1)}`;
  }).join(' ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <radialGradient id="m" cx="38%" cy="28%" r="80%">
      <stop offset="0%" stop-color="#fff6dd"/>
      <stop offset="58%" stop-color="${bg}"/>
      <stop offset="100%" stop-color="${accent}"/>
    </radialGradient>
    <filter id="grain">
      <feTurbulence type="fractalNoise" baseFrequency="1" numOctaves="3" stitchTiles="stitch"/>
      <feColorMatrix type="saturate" values="0"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.4"/></feComponentTransfer>
    </filter>
  </defs>
  <path d="M128 296 h144 v96 l-72 -36 l-72 36 z" fill="${accent}" opacity=".8"/>
  <polygon points="${teeth}" fill="${accent}" opacity=".5"/>
  <circle cx="200" cy="200" r="168" fill="url(#m)"/>
  <circle cx="200" cy="200" r="168" fill="none" stroke="#ffffff" stroke-opacity=".55" stroke-width="4"/>
  <circle cx="200" cy="200" r="146" fill="none" stroke="#8a5f22" stroke-opacity=".45" stroke-width="3" stroke-dasharray="10 8"/>
  <rect width="${w}" height="${h}" filter="url(#grain)" opacity=".26" style="mix-blend-mode:multiply"/>
  <path d="M200 108 l24 52 l57 7 l-42 40 l11 56 l-50 -28 l-50 28 l11 -56 l-42 -40 l57 -7 z" fill="#fffdf5" opacity=".92" stroke="#a8752c" stroke-opacity=".35" stroke-width="3"/>
</svg>`;
}

const files = [];
for (const [id, label, bg, accent] of SCENES) {
  files.push([`assets/_placeholder/${id}.svg`, feltSvg({ w: 640, h: 460, bg, accent, label, kind: 'scene' })]);
}
for (const [id, label, bg, accent] of CHARACTERS) {
  files.push([`assets/_placeholder/${id}.svg`, characterSvg({ id, bg, accent })]);
}
for (const [id, label, bg, accent] of BADGES) {
  files.push([`assets/_placeholder/${id}.svg`, badgeSvg({ bg, accent })]);
}

for (const [rel, svg] of files) {
  const p = join(ROOT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, svg, 'utf8');
}

// manifest：扫目录生成 —— 以后往 assets/{scenes,characters,badges}/ 丢文件即自动登记
const LABELS = {
  // 场景
  scene_cover: '封面舞台', scene_throat_cave: '喉咙山洞', scene_belly_pocket: '肚子小口袋',
  scene_ward_talk: '病房谈话', scene_fasting_moon: '夜里空肚子', scene_cloud_anesthesia: '云朵麻醉',
  scene_butterfly_hand: '手背小蝴蝶', scene_hospital_front: '医院门前', scene_wake_up: '醒来',
  scene_fever_night: '发热之夜', scene_drip_rain: '输液雨夜', scene_ward_bed_close: '病房床头特写',
  scene_ear_room: '耳朵小鼓·被泡潮了', scene_ear_window: '耳朵小窗·开好了',
  scene_eye_room: '眼睛房间·一个看左一个看右',
  scene_airway_slide: '气道滑梯·被堵住了', scene_nebulizer: '雾化·下了一场雾',
  // 旧角色
  villain_volcano: '火山怪', villain_pebble: '小尾巴怪', villain_corona: '冠冠怪',
  villain_dino: '紫色小恐龙', doctor: '白大褂医生', nurse: '护士', nurse_cloud: '云朵护士',
  villain_water: '小水洼怪咕嘟', villain_fuzz: '毛球怪呼噜', villain_eyes: '眼睛怪左左右右',
  villain_cast: '石膏小怪折折', villain_guji: '肚子怪咕叽', villain_fever: '发热怪烫烫',
  badge_star: '小勇士徽章',
  // 新角色
  kid_boy: '小患者·男孩', kid_girl: '小患者·女孩',
  mom: '妈妈', dad: '爸爸', friend: '病房朋友',
};
const POSE_LABEL = {
  stand: '站', sit: '坐', hug: '抱抱', wave: '挥手', cheer: '欢呼', sleep: '睡着',
  thumb: '点赞', bed: '病床', bear: '抱熊', back: '背影', shy: '害羞', peek: '偷看',
};
function labelOf(id) {
  const [base, pose] = id.split('__');
  const b = LABELS[base] || base;
  return pose ? `${b}·${POSE_LABEL[pose] || pose}` : b;
}

const PRIORITY = ['.png', '.webp', '.jpg', '.jpeg', '.svg'];
const manifest = {
  version: '0.3.0',
  note: 'id 即文件名（不含扩展名）。丢文件进 assets/{scenes,characters,badges}/ 即自动登记，无需改代码。',
  assets: {},
};

// 单个 id 的候选文件（同 id 多种扩展名时按 PRIORITY 取其一）
const found = new Map();
for (const [dir, kind] of [['scenes', 'scene'], ['characters', 'character'], ['badges', 'badge']]) {
  const abs = join(ROOT, 'assets', dir);
  if (!existsSync(abs)) continue;
  for (const f of readdirSync(abs)) {
    const ext = extname(f).toLowerCase();
    if (!PRIORITY.includes(ext)) continue;
    const id = basename(f, extname(f));
    const rank = PRIORITY.indexOf(ext);
    const cur = found.get(id);
    if (!cur || rank < cur.rank) found.set(id, { rel: `assets/${dir}/${f}`, kind, rank, real: ext !== '.svg' });
  }
}

for (const [id, meta] of found) {
  manifest.assets[id] = {
    src: meta.rel,
    alt: labelOf(id),
    kind: meta.kind,
    placeholder: !meta.real,
  };
}

// 占位兜底：词表里有、但目录里没有文件的 id，指向 _placeholder 里的 SVG
for (const [id, , ,] of [...SCENES, ...CHARACTERS, ...BADGES]) {
  if (manifest.assets[id]) continue;
  const rel = `assets/_placeholder/${id}.svg`;
  if (!existsSync(join(ROOT, rel))) continue;
  manifest.assets[id] = { src: rel, alt: labelOf(id), kind: 'placeholder', placeholder: true };
}

// 体型比例表随 manifest 一起发布（前端与 MCP 共用同一份真相）
try {
  manifest.proportions = JSON.parse(readFileSync(join(ROOT, 'web/engine/proportions.json'), 'utf8'));
} catch {
  console.warn('⚠ 未找到 web/engine/proportions.json，角色按等高渲染');
}

writeFileSync(join(ROOT, 'assets/manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

const ids = Object.keys(manifest.assets);
const real = ids.filter((k) => !manifest.assets[k].placeholder).length;
console.log(`素材清单：${ids.length} 项（真实素材 ${real}，占位 ${ids.length - real}）`);
