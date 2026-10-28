/**
 * Learning diagnosis engine.
 *
 * Inputs
 *  - blueprint/blueprint.json : lesson -> problems -> knowledge -> tier -> minutes -> acceptance
 *  - data/snapshot.json       : scoreboard (one selected record per cell) + code + submit time
 *  - data/raw/submissions.json: full per-problem submission stream (judge time, status, attempts)
 *
 * The output is a static, auditable diagnosis document: every claim carries the
 * evidence (problem id, record id, time) and an explicit confidence label.
 *
 * Design rules (deliberate, see METHOD below):
 *  - n is tiny (4 students, 5 sessions). No latent-trait model, no ranking score.
 *  - Report counts and rates with denominators; mark "证据不足" instead of guessing.
 *  - "Mastery" is criterion-referenced to the course's own acceptance rubric
 *    (first-pass independent AC, 16/20 training target), not an invented score.
 *  - Class-window timing is descriptive; it is not proof of copying.
 */
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildSessionPlan, deriveRoster } from './plan.mjs';

const CN_TZ_OFFSET = 8 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const STATUS_LABEL = { 1: 'AC', 2: 'WA', 3: 'TLE', 4: 'MLE', 5: 'OLE', 6: 'RE', 7: 'CE', 8: 'SE', 9: 'CANCELED', 10: 'ETC', 0: 'PD' };

const cn = (value) => new Date(new Date(value).getTime() + CN_TZ_OFFSET);
const dayKey = (value) => cn(value).toISOString().slice(0, 10);
const hhmm = (value) => cn(value).toISOString().slice(11, 16);
const minutesBetween = (a, b) => (new Date(b).getTime() - new Date(a).getTime()) / 60000;
const minutesOfDay = (value) => { const h = hhmm(value); return Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5)); };
const round = (value, digits = 2) => (value == null || Number.isNaN(value) ? null : Number(value.toFixed(digits)));

function mean(values) {
  const list = values.filter((v) => Number.isFinite(v));
  return list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
}
function median(values) {
  const list = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}
function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { p: round(p, 3), low: round(Math.max(0, centre - margin), 3), high: round(Math.min(1, centre + margin), 3), n };
}
function ranks(values) {
  const sorted = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array(values.length);
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].v === sorted[i].v) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[sorted[k].i] = rank;
    i = j + 1;
  }
  return out;
}
function spearman(x, y) {
  const pairs = x.map((v, i) => [v, y[i]]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  if (pairs.length < 4) return null;
  const rx = ranks(pairs.map((p) => p[0]));
  const ry = ranks(pairs.map((p) => p[1]));
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0; let dx = 0; let dy = 0;
  for (let i = 0; i < rx.length; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
  return dx && dy ? round(num / Math.sqrt(dx * dy), 3) : null;
}
function permutationP(x, y, observed, iterations = 2000) {
  if (!Number.isFinite(observed)) return null;
  let hits = 0;
  const shuffled = y.slice();
  for (let it = 0; it < iterations; it++) {
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const rho = spearman(x, shuffled);
    if (rho != null && Math.abs(rho) >= Math.abs(observed)) hits++;
  }
  return round((hits + 1) / (iterations + 1), 4);
}

function statusCode(record) {
  if (!record) return 'NONE';
  if (record.statusCode) return record.statusCode;
  if (typeof record.status === 'string') return record.status;
  return STATUS_LABEL[Number(record.status)] || String(record.status ?? 'NONE');
}

function normalizeCode(code) {
  const clean = String(code || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\s+/g, ' ');
  return clean.match(/[A-Za-z_][A-Za-z0-9_]*|\d+|[^\sA-Za-z0-9_]/g) || [];
}

/**
 * Collapse problem-level knowledge phrases into a small, readable taxonomy.
 * Raw tags stay available on each problem; the knowledge panel groups them so
 * a tag that appears on one problem does not masquerade as a "knowledge point".
 */
function knowledgeGroup(tag) {
  const text = String(tag || '');
  if (/函数|作用域|引用参数|参数传递/.test(text)) return '函数与作用域';
  if (/结构体|vector|sort|排序|比较器|多关键字/.test(text)) return '结构体与排序';
  if (/数组|下标|越界|计数桶|标记|去重|桶/.test(text)) return '数组与计数';
  if (/循环|for|while|枚举|递推|数位|拆位|累加|累乘|最值|哨兵|EOF|状态/.test(text)) return '循环与状态';
  if (/分支|条件|if|else|逻辑|互斥|嵌套|判断|比较/.test(text)) return '分支与条件';
  if (/字符|ASCII|string|字符串|编码|整行/.test(text)) return '字符与字符串';
  if (/输出|换行|空格|图形|格式|文本|小数|precision/.test(text)) return '输出与格式';
  if (/输入|变量|类型|赋值|读入|范围/.test(text)) return '变量与输入';
  if (/算术|表达式|运算|取余|整除|商|括号|溢出/.test(text)) return '算术与运算';
  if (/复杂度|STL|map|set|堆|优先队列|容器/.test(text)) return '复杂度与容器';
  return '其他';
}
function shingles(tokens, size = 5) {
  const set = new Set();
  for (let i = 0; i + size <= tokens.length; i++) set.add(tokens.slice(i, i + size).join(' '));
  return set;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function classifyPhase(firstAt, session) {
  if (!firstAt) return 'none';
  const day = dayKey(firstAt);
  if (day < session.date) return 'preview';
  if (day > session.date) return 'catch-up';
  const minutes = Number(hhmm(firstAt).slice(0, 2)) * 60 + Number(hhmm(firstAt).slice(3, 5));
  if (minutes < 9 * 60) return 'before-class';
  if (minutes <= 16 * 60 + 30) return 'in-class';
  return 'after-class';
}

function buildIndex({ snapshot, raw, blueprint, sessions, problems }) {
  const problemMeta = new Map();
  const lessonOrder = new Map(sessions.map((s) => [s.id, s.lesson]));
  for (const session of sessions) {
    for (const p of session.problems) {
      problemMeta.set(p.pid, {
        pid: p.pid,
        title: p.title,
        lessonId: session.id,
        lesson: session.lesson,
        role: p.role,
        tier: p.tier,
        tierLabel: p.tierLabel,
        minutes: p.minutes,
        knowledge: p.knowledge || [],
      });
    }
  }
  const snapshotRecords = new Map(); // rid -> record
  const snapshotCell = new Map(); // `${uid}|${pid}` -> record
  for (const hw of snapshot?.homeworks || []) {
    for (const student of hw.students || []) {
      for (const cell of student.cells || []) {
        if (!cell.rid) continue;
        const record = (snapshot.records || []).find((r) => r.rid === cell.rid);
        if (record) {
          snapshotRecords.set(record.rid, record);
          snapshotCell.set(`${student.uid}|${cell.pid}`, record);
        }
      }
    }
  }
  const rawByPid = new Map();
  const rawPending = new Set();
  for (const p of raw?.problems || []) {
    rawByPid.set(p.pid, p);
    if (p.pending) rawPending.add(p.pid);
  }
  const hwTitles = new Map((snapshot?.homeworks || []).map((h) => [h.title, h]));
  return { problemMeta, lessonOrder, snapshotRecords, snapshotCell, rawByPid, rawPending, hwTitles };
}

function attemptsFor(index, uid, pid) {
  const raw = index.rawByPid.get(pid);
  const list = (raw?.records || []).filter((r) => Number(r.uid) === Number(uid));
  const out = list.map((r) => ({
    rid: r.rid,
    statusCode: r.statusCode || STATUS_LABEL[Number(r.status)] || 'NONE',
    score: r.score,
    judgeAt: r.judgeAt,
    source: 'raw',
    code: index.snapshotRecords.get(r.rid)?.code || '',
    submitAt: index.snapshotRecords.get(r.rid)?.submitAt || '',
  }));
  if (!out.length) {
    const cell = index.snapshotCell.get(`${uid}|${pid}`);
    if (cell) {
      out.push({
        rid: cell.rid,
        statusCode: cell.status?.code || 'NONE',
        score: cell.score,
        judgeAt: cell.judgeAt || cell.submitAt,
        source: 'snapshot-best',
        code: cell.code || '',
        submitAt: cell.submitAt || '',
      });
    }
  }
  out.sort((a, b) => String(a.judgeAt).localeCompare(String(b.judgeAt)));
  return out;
}

function analyzeProblem(index, uid, pid, session, meta) {
  const attempts = attemptsFor(index, uid, pid);
  const first = attempts[0] || null;
  const firstAC = attempts.find((a) => a.statusCode === 'AC') || null;
  const firstPass = first ? (first.source === 'raw' ? first.statusCode === 'AC' : null) : null;
  const phase = classifyPhase(first?.judgeAt, session);
  const solveMinutes = firstAC && first && first.source === 'raw' ? round(minutesBetween(first.judgeAt, firstAC.judgeAt), 1) : null;
  const ratio = solveMinutes != null && meta.minutes ? round(solveMinutes / meta.minutes, 2) : null;
  return {
    pid,
    title: meta.title,
    role: meta.role,
    tier: meta.tier,
    tierLabel: meta.tierLabel,
    minutes: meta.minutes,
    knowledge: meta.knowledge,
    attempted: attempts.length > 0,
    attempts: attempts.length,
    dataPending: index.rawPending.has(pid),
    firstStatus: first?.statusCode || null,
    firstAt: first?.judgeAt || null,
    firstPhase: phase,
    firstPass,
    eventualAC: Boolean(firstAC),
    acAt: firstAC?.judgeAt || null,
    solveMinutes,
    retryRatio: ratio,
    retriesBeforeAC: firstAC ? attempts.indexOf(firstAC) : null,
    evidence: attempts.slice(0, 6).map((a) => ({ rid: a.rid, status: a.statusCode, at: a.judgeAt, source: a.source })),
  };
}

function buildSessionEvaluation(name, session, m) {
  const parts = [];
  if (m.attempted === 0) {
    return `${name}在 ${session.id}（${session.date}）没有提交记录，暂无可评估的完成情况。以上依据 OJ 提交与评测时间。`;
  }
  const target = session.acceptance?.inClassTarget ?? null;
  const targetText = target && m.formalTotal >= target ? `，${m.ac >= target ? '达到' : '未达到'}课内 ${target} 题目标` : '';
  parts.push(`${name}在 ${session.id}（${session.date}）的正式题中最终 AC ${m.ac} 道${targetText}。`);
  if (m.firstPassKnown >= 3) {
    const rate = Math.round((m.firstPass / m.firstPassKnown) * 100);
    const tone = rate >= 80 ? '独立完成度较好' : rate >= 60 ? '大部分题能独立完成' : '多题需要二次以上提交';
    parts.push(`首次提交即通过 ${m.firstPass}/${m.firstPassKnown}（${rate}%），${tone}。`);
  }
  if (m.catchupAttempted > 0 || m.previewAttempted > 0) {
    parts.push(`其中当堂首次提交 ${m.inClassAttempted} 题、课后补做 ${m.catchupAttempted} 题${m.previewAttempted ? `、课前/超前 ${m.previewAttempted} 题` : ''}。`);
  }
  if (m.pace.medianRatio != null) {
    const over = m.pace.overrun ? `，有 ${m.pace.overrun} 题明显超出建议时长` : '';
    parts.push(`相邻首次提交间隔中位 ${m.pace.medianGapMinutes ?? '—'} 分钟，约为教案建议时长的 ${m.pace.medianRatio} 倍${over}。`);
  }
  if (m.persistence.giveUps > 0) {
    parts.push(`${m.persistence.giveUps} 题提交后没有通过，需要教师确认具体卡点。`);
  } else if (m.persistence.avgAttempts != null && m.persistence.avgAttempts > 1.5) {
    parts.push(`平均每题提交 ${m.persistence.avgAttempts} 次才通过，实现或边界处理仍需打磨。`);
  }
  const weak = m.kp
    .filter((k) => k.firstPassKnown >= 2 && k.firstPassRate != null && k.firstPassRate <= 0.5)
    .sort((a, b) => a.firstPassRate - b.firstPassRate)
    .slice(0, 2);
  if (weak.length) {
    parts.push(`知识点 ${weak.map((k) => `「${k.tag}」${k.firstPass}/${k.firstPassKnown}`).join('、')} 首次通过偏低，是本节课的回补重点。`);
  }
  if (m.engagement.lastAt) {
    parts.push(`当天有效提交 ${m.engagement.records} 次，最后一次在 ${hhmm(m.engagement.lastAt)}。`);
  }
  parts.push('以上依据 OJ 提交与评测时间。');
  return parts.join('');
}

function summarizeStudentSession(index, uid, session, blueprint) {
  const rows = [];
  const available = session.problems.filter((p) => !index.rawPending.has(p.pid));
  for (const p of available) {
    const meta = index.problemMeta.get(p.pid) || p;
    rows.push(analyzeProblem(index, uid, p.pid, session, meta));
  }
  const formal = rows.filter((r) => r.role === 'formal');
  const backup = rows.filter((r) => r.role === 'backup');
  const attempted = formal.filter((r) => r.attempted);
  const firstPassKnown = formal.filter((r) => r.firstPass !== null);
  const firstPass = firstPassKnown.filter((r) => r.firstPass);
  const ac = formal.filter((r) => r.eventualAC);
  const noAC = attempted.filter((r) => !r.eventualAC);
  const inClass = attempted.filter((r) => r.firstPhase === 'in-class');
  const inClassAC = inClass.filter((r) => r.eventualAC);
  const preview = attempted.filter((r) => r.firstPhase === 'preview');
  const catchup = attempted.filter((r) => r.firstPhase === 'catch-up');

  // Pace: the OJ never sees the time a student spends before the first submit,
  // so "first submit -> AC" only measures retries. Real pace is the interval
  // between consecutive first attempts, compared with the lesson plan's minutes.
  const ordered = formal.filter((r) => r.firstAt).sort((a, b) => String(a.firstAt).localeCompare(String(b.firstAt)));
  let previous = null;
  for (const row of ordered) {
    if (previous) {
      const gap = minutesBetween(previous.firstAt, row.firstAt);
      const crossesLunch = minutesOfDay(previous.firstAt) < 720 && minutesOfDay(row.firstAt) > 810;
      if (gap >= 0 && gap <= 30 && !crossesLunch) {
        row.paceGapMinutes = round(gap, 1);
        row.paceRatio = row.minutes ? round(gap / row.minutes, 2) : null;
      }
    }
    previous = row;
  }
  const ratios = formal.filter((r) => r.paceRatio != null).map((r) => r.paceRatio);
  const attemptsToAC = formal.filter((r) => r.eventualAC && r.retriesBeforeAC != null).map((r) => r.retriesBeforeAC + 1);

  // The homework set may contain problems from the next lesson (accelerated class) or older sets.
  const hw = index.hwTitles.get(session.homework);
  const hwPids = (hw?.problems || []).map((p) => p.pid);
  const own = new Set(session.problems.map((p) => p.pid));
  const later = new Set(index.sessions.filter((s) => s.lesson > session.lesson).flatMap((s) => s.problems.map((p) => p.pid)));
  const extras = hwPids.filter((pid) => !own.has(pid)).map((pid) => {
    const meta = index.problemMeta.get(pid) || { pid, title: pid, knowledge: [], tier: null, minutes: null };
    const row = analyzeProblem(index, uid, pid, session, { ...meta, role: later.has(pid) ? 'preview' : 'extra' });
    return row;
  });
  const extraPreview = extras.filter((r) => r.role === 'preview' && r.attempted);
  const extraOther = extras.filter((r) => r.role === 'extra' && r.attempted);

  // Engagement: every attempt inside the class window on the session day.
  const dayAttempts = rows.concat(extras).flatMap((r) => r.evidence.filter((e) => {
    if (e.source !== 'raw' || dayKey(e.at) !== session.date) return false;
    const minutes = Number(hhmm(e.at).slice(0, 2)) * 60 + Number(hhmm(e.at).slice(3, 5));
    return minutes >= 540 && minutes <= 990;
  }));
  const days = dayAttempts.map((e) => e.at).sort();
  const bins = new Set(days.map((at) => Math.floor((Number(hhmm(at).slice(0, 2)) * 60 + Number(hhmm(at).slice(3, 5)) - 540) / 30)));
  let longestGap = null;
  for (let i = 1; i < days.length; i++) {
    const gap = minutesBetween(days[i - 1], days[i]);
    if (longestGap == null || gap > longestGap) longestGap = gap;
  }
  const inClassRecords = days;

  // Knowledge points (formal only). Group raw phrases first so one-off tags do
  // not look like a knowledge point; each problem counts once per group.
  const kpMap = new Map();
  for (const row of attempted) {
    for (const tag of row.knowledge || []) {
      const group = knowledgeGroup(tag);
      if (group === '其他') continue;
      if (!kpMap.has(group)) kpMap.set(group, { tag: group, rawTags: new Set(), rows: new Map() });
      const bucket = kpMap.get(group);
      bucket.rawTags.add(tag);
      bucket.rows.set(row.pid, row);
    }
  }
  const kp = [...kpMap.values()].map((b) => {
    const rows = [...b.rows.values()];
    const known = rows.filter((r) => r.firstPass !== null);
    return {
      tag: b.tag,
      rawTags: [...b.rawTags],
      problems: rows.map((r) => r.pid),
      attempted: rows.length,
      ac: rows.filter((r) => r.eventualAC).length,
      firstPass: known.filter((r) => r.firstPass).length,
      firstPassKnown: known.length,
      firstPassRate: known.length ? round(known.filter((r) => r.firstPass).length / known.length, 3) : null,
    };
  }).sort((a, b) => b.attempted - a.attempted);

  const result = {
    sessionId: session.id,
    lesson: session.lesson,
    date: session.date,
    title: session.title,
    homework: session.homework,
    formalTotal: formal.length,
    backupTotal: backup.length,
    attempted: attempted.length,
    firstPass: firstPass.length,
    firstPassKnown: firstPassKnown.length,
    firstPassRate: firstPassKnown.length ? round(firstPass.length / firstPassKnown.length, 3) : null,
    firstPassWilson: wilson(firstPass.length, firstPassKnown.length),
    ac: ac.length,
    noAC: noAC.length,
    untried: formal.length - attempted.length,
    completionRate: round(ac.length / Math.max(1, formal.length), 3),
    eventualRate: attempted.length ? round(ac.length / attempted.length, 3) : null,
    inClassAttempted: inClass.length,
    inClassAC: inClassAC.length,
    previewAttempted: preview.length,
    catchupAttempted: catchup.length,
    backupAttempted: backup.filter((r) => r.attempted).length,
    backupAC: backup.filter((r) => r.eventualAC).length,
    extraPreviewAttempted: extraPreview.length,
    extraPreviewAC: extraPreview.filter((r) => r.eventualAC).length,
    extraOtherAttempted: extraOther.length,
    pace: {
      medianRatio: round(median(ratios), 2),
      medianGapMinutes: round(median(ordered.map((r) => r.paceGapMinutes).filter((v) => v != null)), 1),
      overrun: formal.filter((r) => r.paceRatio != null && r.paceRatio > 2).length,
      fast: formal.filter((r) => r.paceRatio != null && r.paceRatio < 0.5).length,
      timed: ratios.length,
    },
    persistence: {
      avgAttempts: attempted.length ? round(attempted.reduce((s, r) => s + r.attempts, 0) / attempted.length, 2) : null,
      medianAttemptsToAC: median(attemptsToAC),
      giveUps: noAC.length,
    },
    engagement: {
      firstAt: days[0] || null,
      lastAt: days[days.length - 1] || null,
      records: days.length,
      activeBins: bins.size,
      longestGapMinutes: round(longestGap, 1),
      morningRecords: inClassRecords.filter((at) => Number(hhmm(at).slice(0, 2)) < 12).length,
      afternoonRecords: inClassRecords.filter((at) => Number(hhmm(at).slice(0, 2)) >= 13).length,
      lunchRecords: days.filter((at) => { const m = Number(hhmm(at).slice(0, 2)) * 60 + Number(hhmm(at).slice(3, 5)); return m >= 720 && m < 810; }).length,
    },
    kp,
    problems: rows,
    extras,
  };
  const studentName = index.cohort.find((s) => Number(s.uid) === Number(uid))?.name || String(uid);
  result.evaluation = buildSessionEvaluation(studentName, session, result);
  return result;
}

function classSession(index, session, blueprint, cohort) {
  const formal = session.problems.filter((p) => p.role === 'formal' && !index.rawPending.has(p.pid));
  const perStudent = cohort.map((student) => {
    const rows = formal.map((p) => analyzeProblem(index, student.uid, p.pid, session, index.problemMeta.get(p.pid) || p));
    const ordered = rows.filter((r) => r.firstAt).sort((a, b) => String(a.firstAt).localeCompare(String(b.firstAt)));
    const pace = new Map();
    let previous = null;
    for (const row of ordered) {
      if (previous) {
        const gap = minutesBetween(previous.firstAt, row.firstAt);
        const crossesLunch = minutesOfDay(previous.firstAt) < 720 && minutesOfDay(row.firstAt) > 810;
        if (gap >= 0 && gap <= 30 && !crossesLunch && row.minutes) pace.set(row.pid, round(gap / row.minutes, 2));
      }
      previous = row;
    }
    return { uid: student.uid, rows, pace };
  });
  const problems = formal.map((p, indexInFormal) => {
    const meta = index.problemMeta.get(p.pid) || p;
    const rows = perStudent.map((student) => student.rows[indexInFormal]);
    const attempted = rows.filter((r) => r.attempted);
    const known = rows.filter((r) => r.firstPass !== null);
    const passes = known.filter((r) => r.firstPass);
    const ratios = perStudent.map((student) => student.pace.get(p.pid)).filter((v) => v != null);
    return {
      pid: p.pid,
      title: meta.title,
      tier: meta.tier,
      tierLabel: meta.tierLabel,
      minutes: meta.minutes,
      knowledge: meta.knowledge,
      attempted: attempted.length,
      firstPassKnown: known.length,
      firstPass: passes.length,
      firstPassRate: known.length ? round(passes.length / known.length, 3) : null,
      ac: rows.filter((r) => r.eventualAC).length,
      noAC: attempted.filter((r) => !r.eventualAC).length,
      medianSolveMinutes: median(rows.filter((r) => r.solveMinutes != null).map((r) => r.solveMinutes)),
      medianRatio: round(median(ratios), 2),
      students: rows.map((r) => ({ uid: r.uid, attempted: r.attempted, firstPass: r.firstPass, eventualAC: r.eventualAC, solveMinutes: r.solveMinutes })),
    };
  });
  const timeline = [];
  for (let start = 9 * 60; start < 16 * 60 + 30; start += 15) {
    const end = start + 15;
    let count = 0;
    for (const s of cohort) {
      for (const p of session.problems) {
        const raw = index.rawByPid.get(p.pid);
        for (const r of raw?.records || []) {
          if (Number(r.uid) !== Number(s.uid)) continue;
          if (dayKey(r.judgeAt) !== session.date) continue;
          const m = Number(hhmm(r.judgeAt).slice(0, 2)) * 60 + Number(hhmm(r.judgeAt).slice(3, 5));
          if (m >= start && m < end) count++;
        }
      }
    }
    timeline.push({ from: start, to: end, label: `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`, count });
  }
  const reteach = problems
    .filter((p) => p.attempted >= 2 && ((p.firstPassRate != null && p.firstPassRate <= 0.5) || (p.medianRatio != null && p.medianRatio > 2)))
    .sort((a, b) => (a.firstPassRate ?? 1) - (b.firstPassRate ?? 1))
    .slice(0, 8)
    .map((p) => ({ pid: p.pid, title: p.title, tier: p.tierLabel, firstPassRate: p.firstPassRate, medianRatio: p.medianRatio, attempted: p.attempted, noAC: p.noAC }));
  return { sessionId: session.id, date: session.date, title: session.title, problems, timeline, reteach };
}

function buildFindings(student, sessions) {
  const findings = [];
  const push = (kind, level, text, { evidence = [], n = 0, confidence } = {}) => {
    findings.push({ kind, level, text, evidence, n, confidence: confidence || (n >= 4 ? 'high' : n >= 2 ? 'medium' : 'low') });
  };
  for (const s of sessions) {
    if (s.attempted === 0) {
      push('no-evidence', 'warn', `${s.title}：没有任何 OJ 提交记录，无法判断该课掌握情况（缺勤、平台问题或未开始做题需教师确认）。`, { n: 0, confidence: 'low' });
      continue;
    }
    if (s.untried >= 2 || s.noAC >= 1) {
      const target = s.acceptanceInClassTarget ?? null;
      const targetOk = target != null && s.formalTotal >= target;
      const targetText = targetOk ? `（课内目标 ${target}）` : '';
      const level = targetOk && s.ac <= target - 6 ? 'warn' : s.untried >= 5 ? 'warn' : 'info';
      push('completion-gap', level, `${s.title}：正式题 ${s.ac}/${s.formalTotal} 题 AC${targetText}，未做 ${s.untried} 题，提交未通过 ${s.noAC} 题。`, { n: s.formalTotal, confidence: 'high' });
    }
    if (s.firstPassKnown >= 5 && s.firstPassRate != null && s.firstPassRate < 0.6) {
      push('first-pass', 'warn', `${s.title}：一次通过率 ${Math.round(s.firstPassRate * 100)}%（${s.firstPass}/${s.firstPassKnown}），说明多题需要二次以上提交；需区分读题、边界与实现问题。`, { n: s.firstPassKnown, confidence: 'high' });
    }
    if (s.pace.overrun >= 2) {
      push('pace-overrun', 'warn', `${s.title}：${s.pace.overrun} 题的相邻首次提交间隔超过教案建议时长的 2 倍（中位倍率 ${s.pace.medianRatio ?? '—'}），存在明显卡题或长时间停顿。`, { n: s.pace.overrun, confidence: 'medium' });
    }
    if (s.pace.fast >= 4 && s.firstPassRate != null && s.firstPassRate < 0.7) {
      push('pace-fast', 'info', `${s.title}：${s.pace.fast} 题的相邻首次提交间隔不足建议时长一半，但一次通过率不高，可能存在读题或试错偏快。`, { n: s.pace.fast, confidence: 'low' });
    }
    if (s.persistence.giveUps >= 2) {
      push('give-up', 'warn', `${s.title}：${s.persistence.giveUps} 题有提交但没有 AC，需确认是放弃、时间不足还是卡在特定测试点。`, { n: s.persistence.giveUps, confidence: 'medium' });
    }
    if (s.extraPreviewAttempted >= 3) {
      push('preview', 'info', `${s.title}：提前做了下节课内容 ${s.extraPreviewAttempted} 题（AC ${s.extraPreviewAC}），属于超前学习，不计入本课掌握。`, { n: s.extraPreviewAttempted, confidence: 'medium' });
    }
    if (s.catchupAttempted >= 3) {
      push('catch-up', 'info', `${s.title}：课后补做 ${s.catchupAttempted} 题，说明当堂完成度不足或课后在追进度。`, { n: s.catchupAttempted, confidence: 'medium' });
    }
    const weakKp = s.kp.filter((k) => k.firstPassKnown >= 2 && k.firstPassRate === 0).slice(0, 3);
    for (const k of weakKp) {
      push('kp-weak', 'strong', `${s.title}：知识点「${k.tag}」涉及 ${k.firstPassKnown} 题，首次通过 0 题（最终 AC ${k.ac}/${k.attempted}）。`, { evidence: k.problems.map((pid) => ({ pid })), n: k.firstPassKnown });
    }
    if (s.engagement.lastAt && s.engagement.records >= 3) {
      const last = hhmm(s.engagement.lastAt);
      if (last < '15:00') push('engagement-early', 'info', `${s.title}：当天最后一次提交在 ${last}，距下课尚早；需确认是提前完成还是中途离开。`, { n: s.engagement.records, confidence: 'medium' });
      if (s.engagement.longestGapMinutes > 90) push('engagement-gap', 'info', `${s.title}：课内最长无提交间隔 ${Math.round(s.engagement.longestGapMinutes)} 分钟。`, { n: s.engagement.records, confidence: 'low' });
      if (s.engagement.lunchRecords >= 3) push('engagement-lunch', 'info', `${s.title}：午休时段（12:00–13:30）仍有 ${s.engagement.lunchRecords} 次提交。`, { n: s.engagement.lunchRecords, confidence: 'low' });
    }
  }
  return findings;
}

function buildMethod() {
  return {
    construct: {
      completion: '正式题最终 AC 数 / 20；另记课内、课后、未做、提交未通过。',
      mastery: '课程验收口径：首次有效提交即 AC 的比例（一次通过率），按题目和知识点汇总；不合成排名分。',
      learningState: '节奏（实际用时/教案建议时长）、坚持（重试与放弃）、投入（当堂活跃时段与中断）、超前/补做。',
      independence: '同题提交时间邻近 + AC 代码相似度，仅作提示，不作抄袭结论。',
    },
    formulas: {
      firstPassRate: '首次提交状态为 AC 的正式题数 / 有 OJ 记录的正式题数',
      completionRate: '最终 AC 的正式题数 / 20',
      paceRatio: '同一学员相邻两次「首次提交」的间隔分钟数 / 教案建议分钟（平台看不到首次提交前的思考与编码时间）',
      wilson: '95% Wilson 区间，小样本下比正态近似稳健',
    },
    dataSources: [
      'MarsOJ 管理端 /api/manager/v1/homeworks + /homework/{tid}/scoreboard：作业、题目与成绩表',
      'MarsOJ 提交记录页 /record?tid={tid}：每节课的每次提交（状态/学员/时间）',
      'MarsOJ 记录详情页 /record/{rid}：选中记录的代码、提交与评测时间',
      '课程资料：教案（建议时长/验收标准）、双评记录（知识点/梯度）',
    ],
    limitations: [
      '班级规模小、课次有限；所有比例都应读作描述性证据，不能推断总体。',
      '平台只提供 judgeAt（评测时间），没有 submitAt；时间差通常在数秒内，对分钟级节奏分析影响可忽略。',
      '「当堂/课后」按北京时间 09:00–16:30 划分；上午讲授、下午练习的实际切换点未逐课记录。',
      '代码相似度只比较 AC 代码，短程序天然高度相似；只作提示，不作抄袭结论。',
      '新增课次和新增学员不需要改代码：蓝图由课程资料重抽，名单由成绩表自动更新。',
    ],
    changelog: [
      'v1：以课程验收标准替代自造掌握分；以全量提交流替代 scoreboard 选中记录；加入双评难度一致性、留出课预测与敏感性分析。',
    ],
  };
}

export function analyze({ snapshot, raw, blueprint }) {
  let roles = { teachers: new Set() };
  try {
    const config = JSON.parse(readFileSync('config/roles.json', 'utf8'));
    roles = { teachers: new Set((config.teachers || []).map(Number)) };
  } catch { /* config optional */ }

  const plan = buildSessionPlan(blueprint, snapshot);
  const sessions = plan.sessions;
  const roster = deriveRoster(snapshot, roles);
  const cohort = roster.cohort;
  const index = buildIndex({ snapshot, raw, blueprint, sessions, problems: plan.problems });
  index.cohort = cohort;
  index.sessions = sessions;
  const students = cohort.map((student) => {
    const perSession = sessions.map((session) => {
      const result = summarizeStudentSession(index, student.uid, session, blueprint);
      result.acceptanceInClassTarget = session.acceptance?.inClassTarget ?? null;
      return result;
    });
    for (const s of perSession) s.acceptanceInClassTarget = sessions.find((x) => x.id === s.sessionId)?.acceptance?.inClassTarget ?? null;
    const totals = {
      formalTotal: perSession.reduce((sum, s) => sum + s.formalTotal, 0),
      attempted: perSession.reduce((sum, s) => sum + s.attempted, 0),
      firstPass: perSession.reduce((sum, s) => sum + s.firstPass, 0),
      firstPassKnown: perSession.reduce((sum, s) => sum + s.firstPassKnown, 0),
      ac: perSession.reduce((sum, s) => sum + s.ac, 0),
      untried: perSession.reduce((sum, s) => sum + s.untried, 0),
      inClassAC: perSession.reduce((sum, s) => sum + s.inClassAC, 0),
      catchupAttempted: perSession.reduce((sum, s) => sum + s.catchupAttempted, 0),
      previewAttempted: perSession.reduce((sum, s) => sum + s.previewAttempted, 0),
      extraPreviewAttempted: perSession.reduce((sum, s) => sum + s.extraPreviewAttempted, 0),
    };
    return {
      uid: student.uid,
      name: student.name,
      summary: {
        ...totals,
        completionRate: round(totals.ac / Math.max(1, totals.formalTotal), 3),
        firstPassRate: totals.firstPassKnown ? round(totals.firstPass / totals.firstPassKnown, 3) : null,
        firstPassWilson: wilson(totals.firstPass, totals.firstPassKnown),
        avgAttempts: totals.attempted ? round(perSession.reduce((sum, s) => sum + (s.persistence.avgAttempts || 0) * s.attempted, 0) / totals.attempted, 2) : null,
        giveUps: perSession.reduce((sum, s) => sum + s.persistence.giveUps, 0),
        paceMedianRatio: round(median(perSession.flatMap((s) => s.problems.filter((p) => p.paceRatio != null).map((p) => p.paceRatio))), 2),
        inClassRate: totals.attempted ? round(totals.inClassAC / totals.attempted, 3) : null,
      },
      sessions: perSession,
      findings: buildFindings(student, perSession),
    };
  });

  // Class-level: per-session difficulty and reteach lists.
  const classSessions = sessions.map((session) => classSession(index, session, blueprint, cohort));

  // Validation on formal problems across sessions.
  const difficultyRows = [];
  for (const cs of classSessions) {
    for (const p of cs.problems) {
      if (p.attempted >= 2 && p.firstPassRate != null) difficultyRows.push({ tier: p.tier, firstPassRate: p.firstPassRate, medianRatio: p.medianRatio, pid: p.pid, sessionId: cs.sessionId });
    }
  }
  const diffX = difficultyRows.map((r) => r.tier);
  const diffY = difficultyRows.map((r) => r.firstPassRate);
  const difficultyRho = spearman(diffX, diffY);
  const difficultyP = permutationP(diffX, diffY, difficultyRho);
  const ratioRows = difficultyRows.filter((r) => r.medianRatio != null);
  const ratioRho = spearman(ratioRows.map((r) => r.tier), ratioRows.map((r) => r.medianRatio));
  const ratioP = permutationP(ratioRows.map((r) => r.tier), ratioRows.map((r) => r.medianRatio), ratioRho);

  // Split-half reliability: odd vs even formal problem order per student.
  const splitRows = [];
  for (const student of students) {
    let aPass = 0; let aN = 0; let bPass = 0; let bN = 0;
    for (const s of student.sessions) {
      for (const p of s.problems.filter((x) => x.role === 'formal' && x.firstPass !== null)) {
        const even = (p.pid.length + (p.tier || 0)) % 2 === 0;
        if (even) { bN++; if (p.firstPass) bPass++; } else { aN++; if (p.firstPass) aPass++; }
      }
    }
    if (aN >= 3 && bN >= 3) splitRows.push({ uid: student.uid, name: student.name, aRate: round(aPass / aN, 3), bRate: round(bPass / bN, 3), aN, bN });
  }
  const splitRho = splitRows.length >= 3 ? spearman(splitRows.map((r) => r.aRate), splitRows.map((r) => r.bRate)) : null;
  const splitHalf = splitRho == null ? null : { rho: splitRho, spearmanBrown: round((2 * splitRho) / (1 + splitRho), 3), n: splitRows.length, rows: splitRows };

  // Leave-one-session-out prediction of the next session's first-pass rate.
  const holdoutRows = [];
  for (const student of students) {
    const ordered = student.sessions.filter((s) => s.firstPassRate != null && s.firstPassKnown >= 3);
    for (let i = 1; i < ordered.length; i++) {
      const prior = ordered.slice(0, i);
      const predicted = mean(prior.map((s) => s.firstPassRate));
      holdoutRows.push({ uid: student.uid, name: student.name, sessionId: ordered[i].sessionId, predicted: round(predicted, 3), actual: ordered[i].firstPassRate });
    }
  }
  const modelMae = mean(holdoutRows.map((r) => Math.abs(r.predicted - r.actual)));
  const baselineRows = [];
  for (const session of sessions) {
    const rates = students.map((s) => s.sessions.find((x) => x.sessionId === session.id)?.firstPassRate).filter((v) => v != null);
    for (const student of students) {
      const own = student.sessions.find((x) => x.sessionId === session.id);
      if (own?.firstPassRate == null) continue;
      const peers = rates.filter((r) => r !== own.firstPassRate);
      if (peers.length) baselineRows.push({ actual: own.firstPassRate, predicted: mean(peers) });
    }
  }
  const baselineMae = mean(baselineRows.map((r) => Math.abs(r.predicted - r.actual)));
  const holdout = {
    n: holdoutRows.length,
    modelMae: round(modelMae, 3),
    classMeanMae: round(baselineMae, 3),
    verdict: modelMae != null && baselineMae != null ? (modelMae < baselineMae ? '优于班级均值基线' : '未优于班级均值基线') : '样本不足',
    rows: holdoutRows,
    note: holdoutRows.length < 8 ? '样本过少，仅作稳定性的粗略检查，不作为模型有效性证据。' : '',
    baselineNote: '模型只用该学员自己的历史均值；相对班级均值基线的优势主要来自学员间稳定差异，不代表诊断模型本身有预测力。',
  };

  // Sensitivity: in-class-only first attempt vs all first attempts.
  const sensitivity = students.map((student) => {
    let allPass = 0; let allN = 0; let inPass = 0; let inN = 0;
    for (const s of student.sessions) {
      for (const p of s.problems.filter((x) => x.role === 'formal' && x.firstPass !== null)) {
        allN++; if (p.firstPass) allPass++;
        if (p.firstPhase === 'in-class') { inN++; if (p.firstPass) inPass++; }
      }
    }
    return {
      uid: student.uid,
      name: student.name,
      allRate: allN ? round(allPass / allN, 3) : null,
      inClassRate: inN ? round(inPass / inN, 3) : null,
      delta: allN && inN ? round(inPass / inN - allPass / allN, 3) : null,
      n: allN,
    };
  });

  // Code similarity on AC code (snapshot carries code for the selected record).
  const codeRows = [];
  const codeByPid = new Map();
  for (const record of snapshot?.records || []) {
    if (record.status?.code !== 'AC' || !record.code) continue;
    const pid = record.problem?.pid;
    if (!pid) continue;
    if (!codeByPid.has(pid)) codeByPid.set(pid, []);
    codeByPid.get(pid).push({ uid: record.user?.uid, name: record.user?.name, code: record.code });
  }
  for (const [pid, list] of codeByPid) {
    if (list.length < 2) continue;
    const shinglesList = list.map((x) => ({ ...x, sh: shingles(normalizeCode(x.code)) }));
    for (let i = 0; i < shinglesList.length; i++) {
      for (let j = i + 1; j < shinglesList.length; j++) {
        const a = shinglesList[i];
        const b = shinglesList[j];
        if (a.sh.size < 10 || b.sh.size < 10) continue;
        const sim = jaccard(a.sh, b.sh);
        if (sim >= 0.85) codeRows.push({ pid, a: a.name, b: b.name, similarity: round(sim, 3), tokens: Math.min(a.sh.size, b.sh.size) });
      }
    }
  }
  const codeSimilarity = {
    pairs: codeRows.sort((a, b) => b.similarity - a.similarity).slice(0, 20),
    threshold: 0.85,
    note: '短程序或模板化题目容易高相似；只作「独立完成」提示，不作抄袭结论。',
  };

  // Data coverage.
  const totalCells = cohort.length * sessions.reduce((sum, s) => sum + s.problems.filter((p) => p.role === 'formal').length, 0);
  const coveredCells = students.reduce((sum, st) => sum + st.sessions.reduce((acc, s) => acc + s.problems.filter((p) => p.role === 'formal' && p.attempted).length, 0), 0);
  const firstPassCells = students.reduce((sum, st) => sum + st.sessions.reduce((acc, s) => acc + s.firstPassKnown, 0), 0);
  const knownKnowledge = sessions.reduce((sum, s) => sum + s.problems.filter((p) => (p.knowledge || []).length).length, 0);
  const allProblems = sessions.reduce((sum, s) => sum + s.problems.length, 0);
  const dataQuality = {
    rawAvailable: Boolean(raw?.problems?.length),
    rawGeneratedAt: raw?.generatedAt || null,
    rawCutoff: raw?.cutoff || null,
    rawComplete: raw?.complete ?? null,
    rawPending: raw?.stats?.pending ?? null,
    rawDone: raw?.stats?.done ?? null,
    rawProblems: raw?.stats?.problems ?? null,
    coverage: { cells: totalCells, covered: coveredCells, rate: totalCells ? round(coveredCells / totalCells, 3) : null },
    firstPassCoverage: { cells: totalCells, known: firstPassCells, rate: totalCells ? round(firstPassCells / totalCells, 3) : null },
    knowledgeCoverage: { problems: allProblems, withKnowledge: knownKnowledge, rate: allProblems ? round(knownKnowledge / allProblems, 3) : null },
    quizScores: 'missing',
    handTrace: 'missing',
    teacherPrompts: 'missing',
  };

  return {
    schema: 'gaoqian-diagnosis-1',
    generatedAt: new Date().toISOString(),
    inputs: {
      snapshotGeneratedAt: snapshot?.generatedAt || null,
      rawGeneratedAt: raw?.generatedAt || null,
      blueprintGeneratedAt: blueprint.generatedAt,
    },
    cohort,
    excluded: roster.excluded,
    inactive: roster.inactive,
    sessions: sessions.map((s) => ({
      id: s.id,
      lesson: s.lesson,
      title: s.title,
      date: s.date,
      homework: s.homework,
      window: s.window,
      totalMinutes: s.totalMinutes,
      acceptance: s.acceptance,
      modules: s.modules,
      counts: s.counts,
      dataOnly: Boolean(s.dataOnly),
    })),
    students,
    class: {
      sessions: classSessions,
      overall: {
        difficultyValidation: {
          n: difficultyRows.length,
          spearman: difficultyRho,
          permutationP: difficultyP,
          ratioSpearman: ratioRho,
          ratioPermutationP: ratioP,
          note: '期望方向：梯度越难（1→3），一次通过率越低、用时倍率越高。',
        },
        splitHalf,
        holdout,
        sensitivity,
        codeSimilarity,
        dataQuality,
      },
    },
    method: buildMethod(),
    stats: {
      students: cohort.length,
      activeStudents: cohort.length - roster.inactive.length,
      sessions: sessions.length,
      formalProblems: sessions.reduce((sum, s) => sum + s.problems.filter((p) => p.role === 'formal').length, 0),
      rawRecords: raw?.stats?.records ?? 0,
    },
  };
}

export function diagnosisHash(diagnosis) {
  return crypto.createHash('sha256').update(JSON.stringify(diagnosis)).digest('hex').slice(0, 16);
}

// Exposed for unit tests; not part of the dashboard contract.
export const internals = { wilson, spearman, median, knowledgeGroup, classifyPhase, statusCode };
