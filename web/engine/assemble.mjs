/**
 * 故事装配引擎：case + 骨架 → 一页一页的书
 *
 * 确定性：同一个 case 永远装配出同一本书，零随机、零 LLM 调用。
 * 降级策略（按顺序）：
 *   1. 页面缺事实，但骨架给了 conditional → 用"如果……"的条件句版本（draft）
 *   2. 页面缺事实且没条件句 → 整页跳过（宁缺页，不编事实）
 *   3. 术式没有骨架 → 出清单书：不出故事，只出事实 + 注意事项（不编故事）
 *
 * 骨架由调用方注入（浏览器 fetch JSON / Node 读文件），引擎本身不绑运行时。
 */

const TOKEN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

function get(ctx, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), ctx);
}

function resolve(str, ctx, where = '') {
  if (typeof str !== 'string') return str;
  return str.replace(TOKEN, (_, path) => {
    const v = get(ctx, path);
    if (v == null || v === '') throw new Error(`模板变量缺失: {{${path}}} @${where}`);
    return String(v);
  });
}

/** 按术式选骨架；没有骨架返回 null（走清单书，而不是报错） */
export function pickSkeleton(caseObj, skeletons) {
  const key = caseObj.procedure?.key;
  if (!key || key === 'generic') return null;
  return skeletons[key] || null;
}

/**
 * @param {object} caseObj    parseNotice / composeCase 的输出
 * @param {object} manifest   assets/manifest.json
 * @param {object} skeletons  { key: skeleton }
 */
export function assembleBook(caseObj, manifest, skeletons, modules) {
  // 体型比例：角色系数 × 姿势系数，基准 = 患儿站立身高 1.00
  // 图已裁到不透明包围盒，所以「图片高度」＝「角色视觉高度」，等比缩放即可对齐基线
  const PROP = manifest?.proportions || {};
  const scaleOf = (id) => {
    const [role, pose] = String(id).split('__');
    const r = PROP.roles?.[role]?.scale ?? 1;
    const pz = PROP.poses?.[pose || 'stand'] ?? 1;
    return Number((r * pz).toFixed(3));
  };

  // 基线下压：圆底角色按图底对齐会显得飘，往下压一点让身体咬住地面线
  const OFFSET = PROP.offsets || {};
  const dyOf = (id) => Number(OFFSET[String(id).split('__')[0]] || 0);

  const asset = (id) => {
    const a = manifest?.assets?.[id];
    if (!a) return { id, src: null, alt: id, scale: 1, dy: 0 };
    return { id, src: a.src, alt: a.alt || id, kind: a.kind, tags: a.tags, scale: scaleOf(id), dy: dyOf(id) };
  };

  // 主角立牌由性别决定：kid:stand → kid_boy__stand / kid_girl__stand
  const kidBase = caseObj.child?.gender === 'f' ? 'kid_girl' : 'kid_boy';
  const resolveProp = (id) => (typeof id === 'string' && id.startsWith('kid:')
    ? `${kidBase}__${id.slice(4)}`
    : id);

  const sk = pickSkeleton(caseObj, skeletons);
  const version = caseObj.version || (caseObj.missing?.length ? 'draft' : 'confirmed');

  const baseCtx = { child: caseObj.child, fact: caseObj.facts };

  /**
   * 通用模块页：只看「某一项事实有没有」，与术式无关。
   * 选了留置针 → 「手上停一只小蝴蝶」；填了禁食 → 「肚子空一会儿」。
   * 骨架里已有的同 id 页不会重复插（故事书自己写得更细）。
   */
  const buildModules = (existingIds) => {
    const out = [];
    for (const m of modules?.modules || []) {
      if (existingIds.has(m.id)) continue;
      const w = m.when || {};
      const f = caseObj.facts[w.fact];
      if (!f) continue;
      if (w.has_id && !(f.ids || []).includes(w.has_id)) continue;
      out.push({
        id: m.id,
        layout: m.layout || 'image_left',
        stand: m.stand || null,
        draft: false,
        condition: null,
        title: resolve(m.title, baseCtx, `${m.id}.title`),
        text: resolve(m.text, baseCtx, `${m.id}.text`),
        image: asset(m.asset),
        props: (m.props || []).map(resolveProp).map(asset),
        fact: m.fact
          ? {
              key: m.fact.key,
              label: m.fact.label,
              value: m.fact.display === 'value_text' ? f.value_text : f.short,
              evidence: f.evidence ?? null,
              source: f.source || 'catalog',
            }
          : null,
        badge: null,
      });
    }
    return out;
  };

  // —— 没有骨架：清单书。不出故事，一个字也不编。 ——
  if (!sk) {
    const clPages = [
      {
        id: 'checklist-cover',
        layout: 'cover',
        title: `《${caseObj.child?.name || '小勇士'}的术前说明》`,
        text: '',
        image: asset('scene_cover'),
        props: ['kid:stand', 'villain_dino__peek'].map(resolveProp).map(asset),
        cover: {
          kicker: caseObj.procedure?.label || '待确认术式',
          title: `《${caseObj.child?.name || '小勇士'}的术前说明》`,
          subtitle: '还没有专属故事 —— 先列出要确认的事实和要问的问题。',
          ribbon: '术前 · 清单',
        },
        fact: null,
        badge: null,
      },
      ...buildModules(new Set(['checklist-cover'])),
    ];
    if ((clPages.length + 1) % 2 !== 0) {
      clPages.push({
        id: 'notes',
        layout: 'notes',
        title: `写给${caseObj.child?.name || '孩子'}的一句话`,
        text: '这一页空着。等这本书读完，你可以在这里写一句话，或者贴一张照片。',
        image: null,
        props: [],
        fact: null,
        badge: null,
      });
    }
    return {
      book_id: caseObj.case_id,
      mode: 'checklist',
      version: 'checklist',
      skeleton: { key: 'generic', label: caseObj.procedure?.label || '待确认术式' },
      cover: {
        title: `《${caseObj.child?.name || '小勇士'}的术前说明》`,
        subtitle: '这类手术还没有专属故事。下面这几页，全是需要确认的事实。',
      },
      cast: { villain: null, hero: null },
      case: caseObj,
      cautions: caseObj.cautions || [],
      missing: caseObj.missing || [],
      questions: caseObj.questions || [],
      pages: clPages,
      skipped: [],
      stats: {
        page_count: clPages.length,
        fact_pages: clPages.filter((p) => p.fact).length,
        draft_pages: 0,
        built_at: new Date().toISOString(),
      },
      manifest_version: manifest?.version || 'unknown',
    };
  }

  const villain = { ...sk.villain, line: resolve(sk.villain.line, baseCtx, 'villain.line') };
  const hero = { ...sk.hero, line: resolve(sk.hero.line, baseCtx, 'hero.line') };
  const ctx = { ...baseCtx, villain, hero };
  const skipped = [];

  const pages = sk.pages
    .map((p) => {
      // requires 支持两种写法：
      //   "device"                      —— 只要有这个字段
      //   { fact: 'device', has_id:'iv'} —— 字段存在且取值是 iv
      // 后者还区分两种情况：没有这个字段 = 未确认（可走"如果……"），
      //                    有字段但不是 iv = 已确认不留（这一页根本不该出现）。
      const conflict = [];
      const lack = (p.requires || []).filter((r) => {
        if (typeof r === 'string') return !caseObj.facts[r];
        const f = caseObj.facts[r.fact];
        if (!f) return true;                       // 未确认
        if (r.has_id && !(f.ids || []).includes(r.has_id)) { conflict.push(r); return false; }
        return false;
      });

      if (conflict.length) {
        skipped.push({ id: p.id, reason: `已确认不适用: ${conflict.map((c) => c.fact).join(',')}` });
        return null;
      }

      const draft = lack.length > 0;

      // 缺事实时优先用条件句版本，其次跳过
      if (draft && !p.conditional) {
        skipped.push({ id: p.id, reason: `缺少事实: ${lack.map((r) => (typeof r === 'string' ? r : r.fact)).join(',')}` });
        return null;
      }

      const src = draft ? { ...p, ...p.conditional } : p;
      const fact = !draft && p.fact
        ? (() => {
            const f = caseObj.facts[p.fact.key];
            return {
              key: p.fact.key,
              label: p.fact.label,
              value: p.fact.display === 'value_text' ? f.value_text : f.short,
              evidence: f.evidence ?? null,
              source: f.source || 'notice',
            };
          })()
        : null;

      return {
        id: p.id,
        layout: src.layout || p.layout,
        stand: src.stand || p.stand || null,
        draft,
        condition: draft ? lack : null,
        title: resolve(src.title, ctx, `${p.id}.title`),
        text: resolve(src.text, ctx, `${p.id}.text`),
        image: asset(src.asset || p.asset),
        props: (src.props || p.props || []).map(resolveProp).map(asset),
        fact,
        badge: src.badge
          ? { name: resolve(src.badge.name, ctx, `${p.id}.badge`), engrave: resolve(src.badge.engrave, ctx, `${p.id}.badge`) }
          : null,
      };
    })
    .filter(Boolean);

  // 骨架没写到、但事实已经确认的通用页，补在故事之后（不重复）
  pages.push(...buildModules(new Set(pages.map((p) => p.id))));

  // —— 面数奇偶：封底必须单独占一面（左侧单页）。
  // PageFlip 的跨页是 [1,2][3,4]…，总面数为奇数时封底会被拼进跨页。
  // 所以这里补一张"写一句话"的留白页，把总数凑成偶数。
  if ((pages.length + 1) % 2 !== 0) {
    pages.push({
      id: 'notes',
      layout: 'notes',
      title: `写给${caseObj.child?.name || '孩子'}的一句话`,
      text: '这一页空着。等这本书读完，你可以在这里写一句话，或者贴一张照片。',
      image: null,
      props: [],
      fact: null,
      badge: null,
    });
  }

  return {
    book_id: caseObj.case_id,
    mode: 'story',
    version,
    skeleton: { key: sk.key, label: sk.label },
    cover: {
      title: resolve(sk.title, ctx, 'title'),
      subtitle: resolve(sk.subtitle, ctx, 'subtitle'),
    },
    cast: { villain, hero },
    case: caseObj,
    cautions: caseObj.cautions || [],
    missing: caseObj.missing || [],
    questions: caseObj.questions || [],
    pages,
    skipped,
    stats: {
      page_count: pages.length,
      fact_pages: pages.filter((p) => p.fact).length,
      draft_pages: pages.filter((p) => p.draft).length,
      built_at: new Date().toISOString(),
    },
    manifest_version: manifest?.version || 'unknown',
  };
}
