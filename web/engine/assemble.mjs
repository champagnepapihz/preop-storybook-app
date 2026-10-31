/**
 * 故事装配引擎：case + 骨架 → 一页一页的书
 *
 * 确定性：同一个 case 永远装配出同一本书，零随机、零 LLM 调用。
 * 降级策略（按顺序）：
 *   0. 页面要求某个字段的"具体取值"（has_id），而该字段还没确认 → 整页跳过。
 *      取值未知不等于"可能是它"，而且这类页的配图就是那个事实本身（手背上的留置针），
 *      配上图就等于把没确认的事画成了既成画面 —— 宁缺页，不编事实。
 *   1. 页面缺事实 → 整页不出（宁缺页，不编事实；不写「如果」，不生成条件页）
 *   2. 术式没有骨架 → 出清单书：不出故事，只出事实 + 注意事项（不编故事）
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
      //
      // 三种情况，语义完全不同，不能混着处理：
      //   1) 已确认但不等于该取值 → 这一页根本不适用，不出页（也不进页码）
      //   2) 未确认 + 普通要求     → 骨架给了"如果……"就用条件句版本（draft）
      //   3) 未确认 + 取值要求     → 整页不出。取值未知不等于"可能是它"；
      //      而且这类页的插画画的就是那个事实本身（手背上的留置针），
      //      一旦配上，"如果"两个字压不住画面 —— 宁缺页，不编事实。
      const conflict = [];
      const lack = [];
      const unknownValue = [];
      for (const r of p.requires || []) {
        const isValueReq = typeof r !== 'string' && Boolean(r.has_id);
        const f = caseObj.facts[typeof r === 'string' ? r : r.fact];
        if (!f) (isValueReq ? unknownValue : lack).push(r);
        else if (isValueReq && !(f.ids || []).includes(r.has_id)) conflict.push(r);
      }

      if (conflict.length) {
        skipped.push({ id: p.id, reason: `已确认不适用: ${conflict.map((c) => c.fact).join(',')}` });
        return null;
      }

      if (unknownValue.length) {
        skipped.push({
          id: p.id,
          reason: `取值未确认: ${unknownValue.map((c) => c.fact).join(',')}（不写成“如果”，整页不出）`,
        });
        return null;
      }

      // 未确认 = 这一页不存在。不再生成「如果……」条件页。
      if (lack.length) {
        skipped.push({
          id: p.id,
          reason: `缺少事实: ${lack.map((r) => (typeof r === 'string' ? r : r.fact)).join(',')}（不出条件页）`,
        });
        return null;
      }

      // 同一页在不同取值下内容不同：全麻是"睡着的云"，局麻是"醒着的，只让一小块睡着"，
      // 这类差异必须按事实值切换，不能只做字符串替换 —— 否则"局麻也会睡着"就是错的。
      let variant = null;
      if (p.variants) {
        const fv = caseObj.facts[p.variants.fact];
        const id = fv?.ids?.[0];
        variant = (p.variants.cases || {})[id] || null;
        if (variant?.skip) {
          skipped.push({ id: p.id, reason: `该取值下不适用（${p.variants.fact}=${id}）` });
          return null;
        }
      }

      const src = { ...p, ...(variant || {}) };
      const fact = p.fact
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
        draft: false,
        condition: null,
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
