/**
 * 故事装配引擎：case + 骨架 → 一页一页的书
 *
 * 确定性：同一个 case 永远装配出同一本书，零随机、零 LLM 调用。
 * 降级策略：requires 里的字段缺失时整页跳过（宁缺页，不编事实）。
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

/** 按术式选骨架 */
export function pickSkeleton(caseObj, skeletons) {
  const key = caseObj.procedure?.key;
  const sk = skeletons[key];
  if (!sk) {
    const err = new Error(
      `暂不支持该术式「${caseObj.procedure?.label || key}」。当前骨架库：` +
        Object.values(skeletons).map((s) => s.label).join('、')
    );
    err.code = 'UNSUPPORTED_PROCEDURE';
    throw err;
  }
  return sk;
}

/**
 * @param {object} caseObj    parseNotice 的输出
 * @param {object} manifest   assets/manifest.json
 * @param {object} skeletons  { key: skeleton }
 */
export function assembleBook(caseObj, manifest, skeletons) {
  const sk = pickSkeleton(caseObj, skeletons);
  const asset = (id) => {
    const a = manifest?.assets?.[id];
    if (!a) return { id, src: null, alt: id };
    return { id, src: a.src, alt: a.alt || id, kind: a.kind, tags: a.tags };
  };

  const baseCtx = { child: caseObj.child, fact: caseObj.facts };
  const villain = { ...sk.villain, line: resolve(sk.villain.line, baseCtx, 'villain.line') };
  const hero = { ...sk.hero, line: resolve(sk.hero.line, baseCtx, 'hero.line') };
  const ctx = { ...baseCtx, villain, hero };
  const skipped = [];

  const pages = sk.pages
    .filter((p) => {
      const lack = (p.requires || []).filter((k) => !caseObj.facts[k]);
      if (lack.length) { skipped.push({ id: p.id, reason: `缺少事实: ${lack.join(',')}` }); return false; }
      return true;
    })
    .map((p) => {
      const fact = p.fact
        ? (() => {
            const f = caseObj.facts[p.fact.key];
            return {
              key: p.fact.key,
              label: p.fact.label,
              value: p.fact.display === 'value_text' ? f.value_text : f.short,
              evidence: f.evidence,
            };
          })()
        : null;

      return {
        id: p.id,
        layout: p.layout,
        stand: p.stand || null,
        title: resolve(p.title, ctx, `${p.id}.title`),
        text: resolve(p.text, ctx, `${p.id}.text`),
        image: asset(p.asset),
        props: (p.props || []).map(asset),
        fact,
        badge: p.badge
          ? { name: resolve(p.badge.name, ctx, `${p.id}.badge`), engrave: resolve(p.badge.engrave, ctx, `${p.id}.badge`) }
          : null,
      };
    });

  return {
    book_id: caseObj.case_id,
    skeleton: { key: sk.key, label: sk.label },
    cover: {
      title: resolve(sk.title, ctx, 'title'),
      subtitle: resolve(sk.subtitle, ctx, 'subtitle'),
    },
    cast: { villain, hero },
    case: caseObj,
    pages,
    skipped,
    stats: {
      page_count: pages.length,
      fact_pages: pages.filter((p) => p.fact).length,
      built_at: new Date().toISOString(),
    },
    manifest_version: manifest?.version || 'unknown',
  };
}
