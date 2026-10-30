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
