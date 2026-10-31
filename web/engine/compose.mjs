/**
 * 选择 → 病例（A 路径：受控词表录入）
 *
 * 铁律：只承载"明确输入"。
 *   没选的字段 → 不进 facts，进 missing；
 *   没选的字段 → 不猜、不补、不换算；
 *   版本号由"缺口是否为零"决定，不靠时间、不靠模型。
 */

/** 术式是否属于"需要禁食"的手术类（输液、观察类不需要） */
/**
 * 病例编号：由内容决定，不用时间戳。
 * 同一次输入永远得到同一个编号 —— 构建可复现，git diff 里不会每次多出三行垃圾。
 * 32 位 FNV-1a（纯 JS，浏览器与 Node 通用），这个量级下碰撞可以忽略。
 */
export function caseId(seed) {
  let h = 0x811c9dc5;
  const s = String(seed);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `CASE-${h.toString(36).toUpperCase().padStart(7, '0')}`;
}

function isSurgical(skeletonKey) {
  return skeletonKey !== 'injection';
}

/** 该术式下，哪些字段属于"必须确认" */
export function requiredFields(skeletonKey) {
  return isSurgical(skeletonKey)
    ? ['anesthesia', 'fasting', 'stay', 'device']
    : ['stay'];
}

/**
 * 缺口 → 建议提问（最多 3 条）
 *
 * 只问"需要去确认的事实"，不问感受、不问风险、不暗示后果。
 * 句式统一为中性询问，避免制造不确定预期。
 */
const QUESTION_BANK = {
  procedure: '医生说的手术名称，具体是哪一种？',
  anesthesia: '做的时候，孩子是睡着的，还是醒着的？',
  fasting: '手术前从几点开始不能吃东西、不能喝水？',
  device: '手上会不会留一根小管子？',
  stay: '大概需要住几天？',
};

export function buildQuestions(missing = []) {
  const out = [];
  for (const key of missing) {
    const q = QUESTION_BANK[key];
    if (q && out.length < 3) out.push({ field: key, question: q });
  }
  return out;
}

/**
 * @param {object} input
 * @param {object} input.catalog   受控词表
 * @param {string} input.procedureId
 * @param {string} [input.childName]
 * @param {number|null} [input.age]
 * @param {string|null} [input.anesthesiaId]
 * @param {number|null} [input.fastingHours]
 * @param {number|null} [input.liquidHours]
 * @param {number|null} [input.stayDays]
 * @param {string[]} [input.devices]
 */
export function composeCase(input) {
  const { catalog } = input;
  const procedure = findProcedure(catalog, input.procedureId);
  if (!procedure) {
    const err = new Error(`词表里没有这个术式：${input.procedureId}`);
    err.code = 'UNKNOWN_PROCEDURE';
    throw err;
  }

  const skeletonKey = procedure.skeleton || null;
  const facts = {};

  // —— 麻醉 ——
  const anes = (catalog.anesthesia || []).find((a) => a.id === input.anesthesiaId);
  if (anes) {
    facts.anesthesia = {
      key: 'anesthesia',
      label: '麻醉方式',
      short: anes.label,
      value_text: anes.label,
      ids: [anes.id],   // 页面变体按 id 匹配（全麻/镇静 vs 局麻/椎管内，画面对不上）
      evidence: null,
      source: 'catalog',
    };
  }

  // —— 禁食 / 禁水（手术类才需要）——
  const fasting = Number.isFinite(input.fastingHours) ? input.fastingHours : null;
  const liquid = Number.isFinite(input.liquidHours) ? input.liquidHours : null;
  if (isSurgical(skeletonKey) && fasting != null) {
    facts.fasting = {
      key: 'fasting',
      label: '术前空腹',
      short: `${fasting}小时`,
      short_liquid: liquid != null ? `${liquid}小时` : '足够时间',
      value_text: liquid != null ? `禁食${fasting}小时、禁水${liquid}小时` : `禁食${fasting}小时`,
      evidence: null,
      source: 'catalog',
    };
  }

  // —— 留置针（"有 / 没有"两种都算确认过；只有"未确认"才进 missing）——
  const devIds = input.devices || [];
  const noDevice = devIds.includes('none');
  const chosen = devIds
    .map((id) => (catalog.devices || []).find((d) => d.id === id))
    .filter(Boolean);
  if (noDevice) {
    facts.device = {
      key: 'device',
      label: '手上装置',   // 值本身就是「留置针 / 不留」，标签再写一遍会变成「留置针 留置针」
      short: '不留',
      value_text: '不留留置针',
      ids: [],                       // 空 ids → 小蝴蝶那页不会插入
      evidence: null,
      source: 'catalog',
    };
  } else if (chosen.length) {
    facts.device = {
      key: 'device',
      label: '手上装置',   // 同上：标签「留置针」+ 值「留置针」是重复
      short: chosen[0].label,
      value_text: chosen.map((d) => d.label).join('、'),
      ids: chosen.map((d) => d.id),   // 通用模块页按 id 判断该不该插（iv → 小蝴蝶页）
      evidence: null,
      source: 'catalog',
    };
  }

  // —— 住院天数 ——
  const stay = Number.isFinite(input.stayDays) ? input.stayDays : null;
  if (stay != null) {
    facts.stay = {
      key: 'stay',
      label: '住院时长',
      short: `住院${stay}天`,
      value_text: `${stay}天`, // 便签上已经有「住院时长」这个标签，值里不必再重复
      evidence: null,
      source: 'catalog',
    };
  }

  // —— 缺口 ——
  const required = requiredFields(skeletonKey);
  const missing = required.filter((k) => !facts[k]);

  // —— 注意事项（来自词表，逐条可审）——
  //
  // 词表里的条目可以写成两种形式：
  //   "更换病号服"                                     —— 这条术式人人要做，照录
  //   { text: "留置针穿刺", requires: [{fact:'device',has_id:'iv'}] }
  //                                                    —— 这条取决于某个事实，事实没说就不写
  //
  // 为什么未确认时是"整条不出"而不是写"如果"：这是一份 to-do 清单，
  // 清单上出现「留置针穿刺」就等于告诉家长"你的孩子要扎留置针"，没有任何前缀能救回来。
  // 和故事页同一条规则：宁缺一条，不编事实。
  const itemText = (it) => (typeof it === 'string' ? it : it?.text);
  const itemApplies = (it) => {
    if (typeof it === 'string') return true;
    for (const r of it?.requires || []) {
      const f = facts[typeof r === 'string' ? r : r.fact];
      if (!f) return false;                                       // 未确认 → 不出
      if (typeof r !== 'string' && r.has_id && !(f.ids || []).includes(r.has_id)) return false; // 已确认不适用
    }
    return true;
  };
  const cautions = [];
  for (const [label, items] of Object.entries(procedure.cautions || {})) {
    const kept = (items || []).filter(itemApplies).map(itemText).filter(Boolean);
    if (!kept.length) continue;                                   // 整组都被摘掉就不要再留一个空标题
    cautions.push({ label, items: kept, source: 'catalog' });
  }

  return {
    case_id: caseId(JSON.stringify([procedure.id, input.childName || '', input.age ?? null, facts])),
    source: 'catalog',
    version: missing.length ? 'draft' : 'confirmed',
    procedure: { key: skeletonKey || 'generic', id: procedure.id, label: procedure.label },
    child: {
      name: (input.childName || '').trim() || '小勇士',
      age: Number.isFinite(input.age) ? input.age : null,
      gender: input.gender === 'f' || input.gender === 'm' ? input.gender : null,
      name_source: (input.childName || '').trim() ? 'input' : 'fallback',
    },
    facts,
    cautions,
    missing,
    questions: buildQuestions(missing),
    raw: null,
  };
}

/** 在词表里按 id 找术式，同时带出科室/分组标签（用于书名与面包屑） */
export function findProcedure(catalog, procedureId) {
  for (const dept of catalog.departments || []) {
    for (const group of dept.groups || []) {
      for (const p of group.procedures || []) {
        if (p.id === procedureId) return { ...p, dept, group };
      }
    }
  }
  return null;
}

/** 扁平化：给 UI 和 MCP 的 list_catalog 用 */
export function flattenProcedures(catalog) {
  const out = [];
  for (const dept of catalog.departments || []) {
    for (const group of dept.groups || []) {
      for (const p of group.procedures || []) {
        out.push({
          id: p.id,
          label: p.label,
          dept_id: dept.id,
          dept_label: dept.label,
          group_id: group.id,
          group_label: group.label,
          has_story: Boolean(p.skeleton),
          skeleton: p.skeleton || null,
        });
      }
    }
  }
  return out;
}
