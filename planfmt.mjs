/*
 * 行程文案格式化（纯函数，零依赖）
 * ------------------------------------------------------------------
 * 为什么需要它：
 *   百炼 / 千问在「指令较长 + 对话里有历史」时，经常会无视「每行以 · 开头」
 *   这条格式要求，把 4 条要点压成一段逗号连写（实测确实如此）。
 *   提示词约束只能降低概率，不能保证 —— 所以这里做一次确定性的兜底整形：
 *
 *   1. 洗掉模型爱加的 markdown 装饰（# 标题、** 加粗、` 代码、- * 列表符）
 *   2. 有换行结构的 → 逐行规整（补「· 」、裁到 40 字、最多 4~5 行）
 *   3. 整段连写的 → 按句读切碎 → 贪心合并成 ≤40 字 → 太长的硬折行
 *
 * 结果：无论模型怎么输出，前端拿到的永远是「· 」开头的 3~4 行。
 */

const MAX_LINE = 40;   // 单行汉字上限（含标点）
const MAX_LINES = 4;   // 最多几行

/** 去掉模型附加的 markdown 噪音，保留正文 */
function stripDecor(s) {
  return String(s || '')
    .replace(/\r/g, '')
    .replace(/^[ \t]*#{1,6}[^\n]*$/gm, '')  // ## 标题整行丢掉（不能变成一条要点）
    .replace(/\*\*/g, '')                   // **加粗**
    .replace(/^[ \t]*[-*•·][ \t]+/gm, '')   // - / * / • / · 列表符（后面统一补）
    .replace(/`/g, '')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/** 超长碎句硬折行：优先在空格处断开，避免把车次/航班号劈成两半 */
function hardWrap(s, max) {
  const out = [];
  let rest = String(s).trim();
  while (rest.length > max) {
    let cut = max;
    const sp = rest.lastIndexOf(' ', max);
    if (sp > max * 0.6) cut = sp;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** 贪心合并：把碎句拼成 ≤maxLine 的行 */
function regrow(parts, maxLine) {
  const out = [];
  let cur = '';
  for (const raw of parts) {
    const p = String(raw || '').trim().replace(/[，,、]+$/, '');
    if (!p) continue;
    if (!cur) { cur = p; continue; }
    if ((cur + '，' + p).length <= maxLine) cur += '，' + p;
    else { out.push(cur); cur = p; }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * @param {string} txt  模型原始输出
 * @returns {string}    规整后的「· 」多行文本；输入为空时返回空串（调用方回退本地规则）
 */
export function normalizePlanText(txt) {
  const body = stripDecor(txt);
  if (!body) return '';

  // 情况一：模型给了换行结构 —— 按行处理
  if (/\n/.test(body)) {
    const rows = body.split('\n').map(s => s.trim()).filter(Boolean);
    if (rows.length >= 2) {
      const kept = rows.slice(0, MAX_LINES + 1);
      // 已经接近目标长度（百炼应用自身就按短行产出）→ 原样保留。
      // 这里绝不能 slice 硬切，否则「航程约1.4小时」会被切成「航程约1.4」、
      // 「（¥136）」会被切成「（¥1」—— 二次截断比不整形更糟。
      if (kept.every(r => r.length <= MAX_LINE + 12)) {
        return kept.map(r => '· ' + r).join('\n');
      }
      return kept.map(r => hardWrap(r, MAX_LINE).map(x => '· ' + x).join('\n')).join('\n');
    }
  }

  // 情况二：整段连写 —— 按句读切碎，长句再用逗号切，仍超长就硬折行
  const segs = body.split(/[。；;！!？?\n]+/).filter(Boolean);
  const parts = segs.flatMap(seg => {
    if (seg.length <= MAX_LINE) return [seg];
    const byComma = seg.split(/[，,、]+/).filter(Boolean);
    const res = [];
    for (const c of byComma) {
      if (c.length <= MAX_LINE) res.push(c);
      else res.push(...hardWrap(c, MAX_LINE));
    }
    return res;
  });
  const lines = regrow(parts, MAX_LINE).slice(0, MAX_LINES);
  return lines.map(l => '· ' + l).join('\n');
}

export default { normalizePlanText };
