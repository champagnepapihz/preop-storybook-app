/**
 * 医学事实保真校验
 *
 * 这是整个项目最重要的一道闸：故事可以虚构，事实必须逐字可溯源。
 * 检查三件事：
 *   1. 页面正文里出现的每个数字，都必须能在本页事实或原文里找到；
 *   2. 每条事实的 evidence 必须是原文的真子串（防 LLM 编造）；
 *   3. 骨架要求的必填页是否齐全（缺页要在演示前暴露，不能到现场才发现）。
 */

const NUM = /\d+(?:\.\d+)?/g;

function numbersIn(s) {
  return String(s || '').match(NUM) || [];
}

export function validateBook(book) {
  const issues = [];
  const raw = book.case?.raw || '';
  const allFactText = JSON.stringify(book.case?.facts || {}) + raw;
  const allowed = new Set(numbersIn(allFactText));

  // 1 & 2 —— 逐页检查
  for (const page of book.pages) {
    const prose = `${page.title || ''} ${page.text || ''}`;
    for (const n of new Set(numbersIn(prose))) {
      if (!allowed.has(n)) {
        issues.push({
          level: 'error',
          page: page.id,
          code: 'ORPHAN_NUMBER',
          message: `正文出现未经原文支撑的数字「${n}」，属于编造风险`,
        });
      }
    }

    if (page.fact) {
      const evs = Array.isArray(page.fact.evidence) ? page.fact.evidence : [page.fact.evidence];
      if (!evs.length || evs.some((e) => !e)) {
        issues.push({
          level: 'error',
          page: page.id,
          code: 'FACT_NO_EVIDENCE',
          message: `事实「${page.fact.label}」缺少原文出处`,
        });
      } else {
        for (const ev of evs) {
          if (raw && !raw.includes(ev)) {
            issues.push({
              level: 'error',
              page: page.id,
              code: 'EVIDENCE_NOT_IN_SOURCE',
              message: `事实出处「${ev}」不在原文中，可能被改写或编造`,
            });
          }
        }
      }
      const factNums = numbersIn(page.fact.value);
      for (const n of factNums) {
        if (raw && !raw.includes(n)) {
          issues.push({
            level: 'error',
            page: page.id,
            code: 'FACT_NOT_IN_SOURCE',
            message: `事实值「${page.fact.value}」中的数字「${n}」未在原文出现`,
          });
        }
      }
    }
  }

  // 2.5 —— 注意事项必须逐字来自原文（不许改写、不许润色）
  for (const group of book.cautions || []) {
    for (const item of group.items) {
      if (raw && !raw.includes(item)) {
        issues.push({
          level: 'error',
          page: 'colophon',
          code: 'CAUTION_NOT_VERBATIM',
          message: `注意事项「${item}」不在原文中，属于改写风险`,
        });
      }
    }
  }

  // 3 —— 缺页提示（降级而非报错，但要可见）
  for (const s of book.skipped || []) {
    issues.push({
      level: 'warn',
      page: s.id,
      code: 'PAGE_SKIPPED',
      message: `页面「${s.id}」已跳过：${s.reason}（建议在画面上补一句通用提示，不要凭空补数字）`,
    });
  }

  const ok = issues.every((i) => i.level !== 'error');
  return { ok, issues, checked_pages: book.pages.length };
}

export function formatReport(result) {
  const lines = [];
  lines.push(`事实保真校验：${result.ok ? '通过' : '未通过'}（检查 ${result.checked_pages} 页）`);
  if (!result.issues.length) { lines.push('  ✓ 无问题'); return lines.join('\n'); }
  for (const i of result.issues) {
    const mark = i.level === 'error' ? '✗' : '!';
    lines.push(`  ${mark} [${i.page}] ${i.code}: ${i.message}`);
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------
 * 录入端审计（advisory，只提示不拦截）
 *
 * 前提：本系统不做 OCR，原文由人录入。所以"错"只可能来自两处：
 * 录入打错、映射选错。这里把最常见的两类在录入当下就喊出来，
 * 让问题停在"人还能改"的时刻，而不是流到家长手里。
 * ------------------------------------------------------------------ */

export function auditCase(caseObj) {
  const notes = [];
  const f = caseObj.facts || {};
  const push = (level, text) => notes.push({ level, text });

  const solid = f.fasting ? Number((f.fasting.short || '').replace(/[^\d.]/g, '')) : NaN;
  if (f.fasting) {
    if (!Number.isFinite(solid) || solid <= 0) {
      push('warn', '禁食时长未能解析出具体小时数，请核对录入原文。');
    } else if (solid > 12) {
      push('warn', `禁食 ${solid} 小时，超出常见范围，请复核是不是录入错误。`);
    }
    if (!f.fasting.short_liquid || f.fasting.short_liquid === '足够时间') {
      push('info', '未录到禁水时长，绘本里只会写禁食。');
    }
  }

  const age = caseObj.child?.age;
  if (Number.isFinite(age) && (age < 1 || age > 14)) {
    push('warn', `患儿年龄 ${age} 岁，超出儿科常见区间，请核对。`);
  }

  if (caseObj.child?.name === '小勇士') {
    push('info', '未取到患儿姓名，书名里会使用"小勇士"占位。');
  }

  const procKey = caseObj.procedure?.key;
  if (!procKey || procKey === 'generic') {
    push('warn', '未识别出术式，暂时出不了这本书。请核对术式名称，或补一条骨架再生成。');
  }

  return notes;
}
