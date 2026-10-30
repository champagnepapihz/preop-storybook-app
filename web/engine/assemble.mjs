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
export function assembleBook(caseObj, manifest, skeletons) {
  // 体型比例：角色系数 × 姿势系数，基准 = 患儿站立身高 1.00
  // 图已裁到不透明包围盒，所以「图片高度」＝「角色视觉高度」，等比缩放即可对齐基线
  const PROP = manifest?.proportions || {};
  const scaleOf = (id) => {
    const [role, pose] = String(id).split('__');
    const r = PROP.roles?.[role]?.scale ?? 1;
    const pz = PROP.poses?.[pose || 'stand'] ?? 1;
    return Number((r * pz).toFixed(3));
  };

  const asset = (id) => {
    const a = manifest?.assets?.[id];
    if (!a) return { id, src: null, alt: id, scale: 1 };
    return { id, src: a.src, alt: a.alt || id, kind: a.kind, tags: a.tags, scale: scaleOf(id) };
  };

  // 主角立牌由性别决定：kid:stand → kid_boy__stand / kid_girl__stand
  const kidBase = caseObj.child?.gender === 'f' ? 'kid_girl' : 'kid_boy';
  const resolveProp = (id) => (typeof id === 'string' && id.startsWith('kid:')
    ? `${kidBase}__${id.slice(4)}`
    : id);

  const sk = pickSkeleton(caseObj, skeletons);
  const version = caseObj.version || (caseObj.missing?.length ? 'draft' : 'confirmed');

  // —— 没有骨架：清单书。不出故事，一个字也不编。 ——
  if (!sk) {
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
      pages: [
        {
          id: 'checklist-cover',
          layout: 'checklist',
          title: `${caseObj.procedure?.label || '待确认术式'}`,
          text: '这本还没有故事。故事要等医生把术式、麻醉和时间都确认了才能写 —— 在那之前，先把要问的事情列清楚。',
          image: null,
          props: ['kid:stand', 'villain_dino__peek'].map(resolveProp).map(asset),
          fact: null,
          badge: null,
        },
      ],
      skipped: [],
      stats: { page_count: 1, fact_pages: 0, built_at: new Date().toISOString() },
      manifest_version: manifest?.version || 'unknown',
    };
  }

  const baseCtx = { child: caseObj.child, fact: caseObj.facts };
  const villain = { ...sk.villain, line: resolve(sk.villain.line, baseCtx, 'villain.line') };
  const hero = { ...sk.hero, line: resolve(sk.hero.line, baseCtx, 'hero.line') };
  const ctx = { ...baseCtx, villain, hero };
  const skipped = [];

  const pages = sk.pages
    .map((p) => {
      const lack = (p.requires || []).filter((k) => !caseObj.facts[k]);
      const draft = lack.length > 0;

      // 缺事实时优先用条件句版本，其次跳过
      if (draft && !p.conditional) {
        skipped.push({ id: p.id, reason: `缺少事实: ${lack.join(',')}` });
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
