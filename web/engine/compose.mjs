/**
 * 选择 → 病例（A 路径：受控词表录入）
 *
 * 铁律：只承载"明确输入"。
 *   没选的字段 → 不进 facts，进 missing；
 *   没选的字段 → 不猜、不补、不换算；
 *   版本号由"缺口是否为零"决定，不靠时间、不靠模型。
 */

/** 术式是否属于"需要禁食"的手术类（输液、观察类不需要） */
function isSurgical(skeletonKey) {
  return skeletonKey !== 'injection';
}

/** 该术式下，哪些字段属于"必须确认" */
export function requiredFields(skeletonKey) {
  return isSurgical(skeletonKey)
    ? ['anesthesia', 'fasting', 'stay', 'device']
    : ['anesthesia', 'stay'];
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
      label: '术前禁食',
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
      label: '留置针',
      short: '不留',
      value_text: '不留留置针',
      ids: [],                       // 空 ids → 小蝴蝶那页不会插入
      evidence: null,
      source: 'catalog',
    };
  } else if (chosen.length) {
    facts.device = {
      key: 'device',
      label: '留置针',
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
      value_text: `住院${stay}天`,
      evidence: null,
      source: 'catalog',
    };
  }

  // —— 缺口 ——
  const required = requiredFields(skeletonKey);
  const missing = required.filter((k) => !facts[k]);

  // —— 注意事项（来自词表，逐条可审）——
  const cautions = Object.entries(procedure.cautions || {}).map(([label, items]) => ({
    label,
    items: [...items],
    source: 'catalog',
  }));

  return {
    case_id: `CASE-${Date.now().toString(36).toUpperCase()}`,
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
