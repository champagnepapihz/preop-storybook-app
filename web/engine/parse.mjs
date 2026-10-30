/**
 * 术前须知 → 结构化病例
 *
 * 设计原则（医学事实保真）：
 *   1. 所有数字只从原文抽取，不做推断、不做换算；
 *   2. 每一处事实都保留 evidence（原文片段），供 validate 溯源；
 *   3. 抽不到的字段标记 missing，装配层据此降级或跳过整页，绝不编造。
 */

const PROCEDURE_RULES = [
  { key: 'tonsillectomy', label: '扁桃体切除术', match: /扁桃体|腺样体|tonsil/i },
  { key: 'appendectomy', label: '腹腔镜阑尾切除术', match: /阑尾|append/i },
  { key: 'injection', label: '静脉输液', match: /静脉输液|输液|打针|预防接种|疫苗/i },
];

const ANESTHESIA_RULES = [
  { key: 'general', label: '全身麻醉', match: /全身麻醉|全麻|general\s*anesthesia/i },
  { key: 'regional', label: '椎管内麻醉', match: /椎管内麻醉|腰麻|硬膜外/ },
  { key: 'local', label: '局部麻醉', match: /局部麻醉|局麻/ },
  { key: 'sedation', label: '静脉镇静', match: /镇静|静脉麻醉/ },
];

const DEVICE_RULES = [
  { key: 'iv', label: '留置针', match: /留置针|静脉留置|套管针/ },
  { key: 'catheter', label: '导尿管', match: /导尿管/ },
  { key: 'drain', label: '引流管', match: /引流管/ },
];

function grab(text, re) {
  const m = text.match(re);
  if (!m) return null;
  return { value: m[1], evidence: m[0].trim() };
}

function num(text, re) {
  const m = text.match(re);
  if (!m) return null;
  return { value: Number(m[1]), evidence: m[0].trim() };
}

/** 从原文抽取结构化病例 */
export function parseNotice(text, { childName = '', ageHint = null } = {}) {
  const raw = String(text || '').replace(/\r\n/g, '\n');
  const facts = {};
  const missing = [];

  // —— 术式 ——
  let procedure = null;
  for (const rule of PROCEDURE_RULES) {
    if (rule.match.test(raw)) { procedure = { key: rule.key, label: rule.label }; break; }
  }
  if (!procedure) {
    const m = raw.match(/(?:手术名称|术式|拟行手术|手术方式)[：:\s]*([^\n。；;，,]+)/);
    procedure = m
      ? { key: 'generic', label: m[1].trim(), evidence: m[0].trim() }
      : { key: 'generic', label: '待确认术式' };
    missing.push('procedure');
  }

  // —— 禁食 / 禁水 ——
  const fastSolid =
    num(raw, /禁食(?:时间)?[^\n。；;]{0,12}?(\d+(?:\.\d+)?)\s*(?:小时|h)/i) ||
    num(raw, /术前\s*(\d+(?:\.\d+)?)\s*小时[^\n。；;]{0,6}?禁食/) ||
    num(raw, /(\d+(?:\.\d+)?)\s*小时\s*禁食/);
  const fastLiquid =
    num(raw, /禁(?:水|饮)(?:时间)?[^\n。；;]{0,12}?(\d+(?:\.\d+)?)\s*(?:小时|h)/i) ||
    num(raw, /清(?:水|饮)[^\n。；;]{0,10}?(\d+(?:\.\d+)?)\s*小时/);

  if (fastSolid) {
    const hours = fastSolid.value;
    facts.fasting = {
      key: 'fasting',
      label: '术前禁食',
      short: `${hours}小时`,
      short_liquid: fastLiquid ? `${fastLiquid.value}小时` : '足够时间',
      value_text: fastLiquid
        ? `禁食${hours}小时、禁水${fastLiquid.value}小时`
        : `禁食${hours}小时`,
      evidence: [fastSolid.evidence, fastLiquid?.evidence].filter(Boolean),
    };
  } else {
    missing.push('fasting');
  }

  // —— 麻醉 ——
  const anes = ANESTHESIA_RULES.find((r) => r.match.test(raw));
  if (anes) {
    facts.anesthesia = {
      key: 'anesthesia',
      label: '麻醉方式',
      short: anes.label,
      value_text: anes.label,
      evidence: (raw.match(anes.match) || [anes.label])[0],
    };
  } else {
    missing.push('anesthesia');
  }

  // —— 手上装置 ——
  const device = DEVICE_RULES.find((r) => r.match.test(raw));
  if (device) {
    facts.device = {
      key: 'device',
      label: '手上装置',
      short: device.label,
      value_text: device.label,
      evidence: (raw.match(device.match) || [device.label])[0],
    };
  } else {
    missing.push('device');
  }

  // —— 住院时长 ——
  const stay = num(raw, /住院(?:时间|天数)?[^\n。；;]{0,10}?(\d+)\s*(?:天|日)/);
  if (stay) {
    facts.stay = {
      key: 'stay',
      label: '住院时长',
      short: `住院${stay.value}天`,
      value_text: `住院${stay.value}天`,
      evidence: stay.evidence,
    };
  } else {
    missing.push('stay');
  }

  // —— 患儿姓名 ——
  const nameMatch = raw.match(/姓名[：:\s]*([^\s，,。；;\n]{1,8})/);
  const ageInNotice = Number(raw.match(/年龄[：:\s]*(\d{1,2})/)?.[1]);
  const child = {
    name: (childName || nameMatch?.[1] || '小勇士').trim(),
    age: ageHint ?? (Number.isFinite(ageInNotice) && ageInNotice > 0 ? ageInNotice : null),
    name_source: childName ? 'input' : nameMatch ? 'notice' : 'fallback',
  };

  return {
    case_id: `CASE-${Date.now().toString(36).toUpperCase()}`,
    procedure,
    child,
    facts,
    missing,
    raw,
  };
}

/**
 * LLM 抽取钩子：配置 OPENAI_BASE_URL / OPENAI_API_KEY 后可用，
 * 走 OpenAI 兼容的 chat/completions，要求返回与 parseNotice 同构的 facts。
 * 未配置时返回 null，调用方回落规则抽取。
 */
export async function parseWithLLM(text, opts = {}) {
  const base = process.env.OPENAI_BASE_URL;
  const key = process.env.OPENAI_API_KEY;
  if (!base || !key) return null;

  const schemaHint = `只输出 JSON：{"procedure":{"key":"tonsillectomy|appendectomy|injection|generic","label":"..."},
"facts":{"fasting":{"short":"8小时","short_liquid":"2小时","value_text":"禁食8小时、禁水2小时","evidence":"原文片段"},
"anesthesia":{"short":"全身麻醉","value_text":"全身麻醉","evidence":"原文片段"},
"device":{"short":"留置针","value_text":"留置针","evidence":"原文片段"},
"stay":{"short":"住院3天","value_text":"住院3天","evidence":"原文片段"}},
"child":{"name":"...","age":6},"missing":[]}
规则：数字必须来自原文，宁可留空放进 missing，也不要推断。`;

  const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: opts.model || process.env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: '你是术前须知结构化抽取器，只做抽取不做改写。' + schemaHint },
        { role: 'user', content: text },
      ],
    }),
  });
  if (!res.ok) throw new Error(`LLM 抽取失败: ${res.status}`);
  const data = await res.json();
  const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
  return {
    case_id: `CASE-${Date.now().toString(36).toUpperCase()}`,
    procedure: parsed.procedure || { key: 'generic', label: '待确认术式' },
    child: { name: opts.childName || parsed.child?.name || '小勇士', age: parsed.child?.age ?? null, name_source: 'llm' },
    facts: parsed.facts || {},
    missing: parsed.missing || [],
    raw: text,
  };
}
