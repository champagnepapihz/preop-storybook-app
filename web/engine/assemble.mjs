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
/**
 * 按术式选骨架。
 *   有专属骨架 → 用它；
 *   没有 → 回落到 generic-story（「默认小怪兽」），任何术式都能讲一个不编造的故事；
 *   连通用骨架都没有 → null，走清单书（老数据仍然安全）。
 */
export function pickSkeleton(caseObj, skeletons) {
  const key = caseObj.procedure?.key;
  const own = key && key !== 'generic' ? skeletons?.[key] : null;
  if (own) return own;
  // 没有专属骨架时按类别回落：
  //   手术类 → generic-story  「那一天」，有睡一觉、有处置
  //   医疗类 → generic-medical「一天一天」，没有那一天，只有每天做一点
  // 两种叙事不能共用一份文案 —— 给「鼻腔冲洗」「遮盖治疗」讲「那天护士帮你」是错的。
  const fallback = caseObj.procedure?.kind === 'medical' ? 'generic-medical' : 'generic-story';
  return skeletons?.[fallback] || skeletons?.['generic-story'] || null;
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

  /**
   * 反派立牌：骨架写 villain:peek，按这一例的反派解析成 villain_xxx__peek。
   *
   * 为什么需要它：通用骨架要服务所有没有专属剧本的处置，而每个反派会画的姿势
   * 并不一致（紫恐龙有背影、石膏小怪没有）。写死 villain_dino__peek 的结果是
   * 词表换成别的反派之后，书里还站着紫恐龙 —— 名字和画面直接对不上。
   *
   * 兜底不是一条链，是分用途的 —— 同一张姿势在不同页上意思不一样：
   *   封面要「它站着」（peek 退 stand，绝不能退成睡姿）
   *   处置页要「它被请走了」（back 退 sleep，睡姿同样表示安静下来了）
   * 一条链走到底的话，石膏小怪没有 peek 也没有 back，封面会直接变成躺着睡觉。
   */
  const VILLAIN_FALLBACK = {
    peek:  ['peek', 'stand', 'shy', 'cheer', 'sleep'],
    stand: ['stand', 'peek', 'shy', 'cheer', 'sleep'],
    shy:   ['shy', 'stand', 'peek', 'cheer', 'sleep'],
    cheer: ['cheer', 'stand', 'shy', 'peek', 'sleep'],
    back:  ['back', 'sleep', 'shy', 'stand', 'cheer', 'peek'],
    sleep: ['sleep', 'shy', 'stand', 'peek', 'cheer'],
  };
  const villainPose = (pose) => {
    const vid = caseObj.disease?.villain?.id;
    if (!vid) return null;
    for (const p of VILLAIN_FALLBACK[pose] || [pose, 'stand']) {
      const key = `${vid}__${p}`;
      if (manifest?.assets?.[key]) return key;
    }
    return Object.keys(manifest?.assets || {}).find((k) => k.startsWith(`${vid}__`)) || null;
  };

  // 陪同家长：parent:hug → mom__hug / dad__hug。和 kid: 一样是「谁来陪」决定的，
  // 不写成固定素材名，否则换成爸爸要改每一份骨架。
  const parentBase = caseObj.child?.parent === 'dad' ? 'dad' : 'mom';
  const resolveProp = (id) => {
    if (typeof id !== 'string') return id;
    if (id.startsWith('kid:')) return `${kidBase}__${id.slice(4)}`;
    if (id.startsWith('parent:')) return `${parentBase}__${id.slice(7)}`;
    if (id.startsWith('villain:')) return villainPose(id.slice(8)) || id;
    return id;
  };

  const sk = pickSkeleton(caseObj, skeletons);
  const version = caseObj.version || (caseObj.missing?.length ? 'draft' : 'confirmed');

  // procedure 也进上下文：通用骨架要用 {{procedure.label}} 说出这次是什么术式
  const baseCtx = { child: caseObj.child, fact: caseObj.facts, procedure: caseObj.procedure || {} };

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
      // 变体：同一页在不同取值下换文案/画面（如全麻睡着、局麻醒着）
      let src = m;
      if (m.variants) {
        const fv = caseObj.facts[m.variants.fact];
        const vid = fv?.ids?.[0];
        const v = (m.variants.cases || {})[vid] || null;
        if (v?.skip) continue;
        src = { ...m, ...(v || {}) };
      }
      out.push({
        id: m.id,
        layout: src.layout || 'image_left',
        stand: src.stand || null,
        draft: false,
        condition: null,
        title: resolve(src.title, baseCtx, `${m.id}.title`),
        text: resolve(src.text, baseCtx, `${m.id}.text`),
        image: asset(src.asset),
        props: (src.props || []).map(resolveProp).map(asset),
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

  // 没有骨架 = 数据缺了通用骨架。走到这里说明 skeletons 里没有 generic-story，
  // 宁可报错，也不要悄悄出一本"没有故事的书"。
  if (!sk) {
    const err = new Error(`没有可用骨架：${caseObj.procedure?.id || 'unknown'}（缺少 generic-story）`);
    err.code = 'NO_SKELETON';
    throw err;
  }

  // 反派由病种决定（同一疾病不同术式共用一只），病种没写专属就落到 default_villain
  const villainDef = caseObj.disease?.villain;
  if (!villainDef) {
    const err = new Error('词表里没有反派定义，也没有 default_villain');
    err.code = 'NO_VILLAIN';
    throw err;
  }

  /**
   * 病种可以换掉通用骨架某几页的场景：{ meet: "scene_plaster_room" }
   *
   * 三个新反派都有专属场景，但没有专属骨架 —— 通用骨架的遇见页本来借的是
   * scene_ward_bed_close，三本书都用它，翻两页就看出重复。按页 id 覆盖最小，
   * 不用为每只怪兽复制一份骨架（复制出去的骨架以后改文案要改三处）。
   * 只覆盖骨架里真实存在的页 id，写错了不会凭空多出一页。
   */
  const SCENE_OVERRIDE = villainDef.scenes || {};
  const sceneOf = (pageId, fallback) => SCENE_OVERRIDE[pageId] || fallback;

  const villain = { ...villainDef, line: resolve(villainDef.line, baseCtx, 'villain.line') };
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
      //   2) 未确认 + 普通要求     → 这一页不出（不写「如果」，不生成条件页）
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
          reason: `缺少事实: ${lack.map((r) => (typeof r === 'string' ? r : r.fact)).join(',')}（不写「如果」，整页不出）`,
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
        image: asset(sceneOf(p.id, src.asset || p.asset)),
        props: (src.props || p.props || []).map(resolveProp).map(asset),
        fact,
        badge: src.badge
          ? { name: resolve(src.badge.name, ctx, `${p.id}.badge`), engrave: resolve(src.badge.engrave, ctx, `${p.id}.badge`) }
          : null,
      };
    })
    .filter(Boolean);

  // 骨架没写到、但事实已经确认的通用页（禁食 / 留置针），补在故事里、徽章之前。
  // 直接 push 会排到徽章后面，翻到最后突然又冒出「肚子空一会儿」。
  // 插入位置按叙事顺序：准备页（禁食 / 留置针）要排在「治疗」之前、不能落到结尾。
  //   battle / drip 是治疗，wake 是收尾，badge 是最后一页
  const mods = buildModules(new Set(pages.map((p) => p.id)));
  if (mods.length) {
    // 禁食 / 留置针都属于「术前准备」，要排在麻醉、治疗之前；
    // 取页序里最早出现的那个锚点，而不是按数组顺序取第一个匹配
    const ANCHORS = ['cloud', 'nebulizer', 'drip', 'battle', 'treatment', 'wake', 'badge'];
    const idxs = ANCHORS.map((id) => pages.findIndex((p) => p.id === id)).filter((i) => i >= 0);
    const at = idxs.length ? Math.min(...idxs) : -1;
    if (at >= 0) pages.splice(at, 0, ...mods);
    else pages.push(...mods);
  }

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
    // label 是内部标识（构建日志用），kicker 才是印在封面书名下方那行。
    //
    // 优先用「这一次选中的处置名」，而不是骨架自己的 label，原因有两个：
    //   1) 一份骨架服务多条处置（扁桃体/腺样体共用），骨架只能写一个名字，
    //      选了腺样体却印「扁桃体切除术」就是错的；
    //   2) 骨架 label 容易停在旧名（injection 写着「呼吸道感染」、asthma 写着「哮喘急性发作」），
    //      词表改了名，封面还印旧名。
    // 通用骨架写的 {{procedure.label}} 解析出来和这条是同一个值。
    skeleton: {
      key: sk.key,
      label: sk.label,
      kicker: sk.kicker
        ? resolve(sk.kicker, ctx, 'kicker')
        : (caseObj.procedure?.label || sk.label),
    },
    cover: {
      // 书名优先用病种自己的：通用骨架只有一个标题《XX和身体里的小怪兽》，
      // 十几本书同名，而且和站在封面上的那只怪兽没关系。
      // 病种写了 title 就用它，没写才回到骨架的（专属骨架本来就有专属标题）。
      title: resolve(villainDef.title || sk.title, ctx, 'title'),
      subtitle: resolve(villainDef.subtitle || sk.subtitle, ctx, 'subtitle'),
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
    },
    manifest_version: manifest?.version || 'unknown',
  };
}
