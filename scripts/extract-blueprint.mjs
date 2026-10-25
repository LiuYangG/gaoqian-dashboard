#!/usr/bin/env node
/**
 * Extract the teaching blueprint (lesson -> problems -> knowledge -> tier -> minutes
 * -> acceptance criteria) from the course workspace into blueprint/blueprint.json.
 *
 * The course workspace lives outside this repo, so the generated file is committed
 * and stays the single source of truth for the analytics pipeline.
 *
 * Usage:
 *   node scripts/extract-blueprint.mjs [--course "C:/Users/.../高潜授课"]
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_COURSE = 'C:/Users/DELL/Desktop/高潜授课';
const OUT_DIR = path.resolve('blueprint');

const LESSONS = [
  { id: 'L01', lesson: 1, date: '2026-09-12', dir: 'R1-P01-L01-程序设计、竞赛与在线评测入门', homework: '山东高潜01' },
  { id: 'L02', lesson: 2, date: '2026-09-19', dir: 'R1-P01-L02-变量、类型、输入与运算', homework: '山东高潜02' },
  { id: 'L03', lesson: 3, date: '2026-09-26', dir: 'R1-P01-L03-比较、逻辑与分支结构', homework: '山东高潜03' },
  { id: 'L04', lesson: 4, date: '2026-10-17', dir: 'R1-P01-L04-while、for与循环状态', homework: '山东高潜04' },
  { id: 'L05', lesson: 5, date: '2026-10-24', dir: 'R1-P01-L05-循环嵌套、枚举与数字拆位', homework: '山东高潜05' },
];

const COHORT = [
  { uid: 11095, name: '辛嘉泽' },
  { uid: 11097, name: '王柯铭' },
  { uid: 11098, name: '宋梓赫' },
  { uid: 11103, name: '李盈克' },
];
const EXCLUDED = [
  { uid: 11104, name: '王丹丹', reason: 'teacher' },
  { uid: 11099, name: '刘宸玺', reason: 'new-student' },
];

const courseArg = process.argv.indexOf('--course');
const COURSE = courseArg > 0 ? process.argv[courseArg + 1] : DEFAULT_COURSE;
const PHASE = path.join(COURSE, '第一阶段');

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const read = (file) => fs.readFile(file, 'utf8');
const strip = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

function parseMarkdownTable(headerLine, rowLines) {
  const header = headerLine.split('|').slice(1, -1).map((c) => strip(c));
  return rowLines.map((line) => {
    const cells = line.split('|').slice(1, -1).map((c) => strip(c));
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    return row;
  });
}

/** Find the markdown table following a heading that contains `headingMatch`, until the next heading. */
function findTable(md, headingMatch, stopAt = /^#{2,4}\s/m) {
  const lines = md.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^#{2,4}\s/.test(lines[i]) && headingMatch.test(lines[i])) { start = i; break; }
  }
  if (start < 0) return null;
  let headerLine = '';
  let headerIdx = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (stopAt.test(lines[i])) break;
    if (/^\|/.test(lines[i]) && /题目ID|题目 ID|题号/.test(lines[i])) { headerLine = lines[i]; headerIdx = i; break; }
  }
  if (!headerLine) return null;
  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^#{2,4}\s/.test(line)) break;
    if (!/^\|/.test(line)) { if (rows.length) break; else continue; }
    if (/^\|\s*:?-{2,}/.test(line)) continue;
    rows.push(line);
  }
  return parseMarkdownTable(headerLine, rows);
}

function pickMinutes(row) {
  const values = Object.entries(row).filter(([k]) => /建议|停留|分钟|时长/.test(k)).map(([, v]) => v);
  for (const v of values) {
    const m = String(v).match(/(\d+)/);
    if (m) return Number(m[1]);
  }
  return null;
}

function pickTier(row) {
  const values = Object.values(row).join(' ');
  const m = values.match(/\b([DG])([123])\b/);
  if (!m) return { tier: null, label: '' };
  return { tier: Number(m[2]), label: `${m[1]}${m[2]}` };
}

function pickKnowledge(row, dual) {
  if (dual?.primary?.knowledge?.length) return dual.primary.knowledge.slice();
  const key = Object.keys(row).find((k) => /核心|落点|知识|用途/.test(k));
  const raw = key ? row[key] : '';
  return splitKnowledge(raw);
}

function splitKnowledge(raw) {
  return String(raw || '')
    .split(/[、；;，,＋+]|以及|和(?=[^ ])/)
    .map((s) => strip(s).replace(/[。.]$/, ''))
    .filter((s) => s.length >= 2);
}

// The five lesson plans phrase the same acceptance criterion in different ways.
// These are read from the plans themselves; `quote` is a verbatim line kept for audit.
const ACCEPTANCE = {
  L01: {
    detection: { count: 3, minutes: 40, minFirstPass: 3, quote: '提交、最低 3 题验收、调试记录、备用题' },
    quiz: { count: 15, pass: 80, quote: '15 题，100 分，80 分达标' },
    inClassTarget: null,
    postClassTarget: null,
    quote: '达标：D1 全部、D2 至少 4 题、小测不少于 80 分。',
  },
  L02: {
    detection: { count: 4, minutes: 40, minFirstPass: 3, quote: '40分钟4题，至少3题第一次有效提交通过，并能解释一次整除边界' },
    quiz: { count: 15, pass: 80, quote: '20分钟，前10题各6分、后5题各8分，总100分，80分及格' },
    inClassTarget: 16,
    postClassTarget: 20,
    quote: '课内争取完成16／20道正式题；课后补齐20题',
  },
  L03: {
    detection: { count: 4, minutes: 45, minFirstPass: 4, quote: '大纲最低检测：独立完成4题，教师用边界数据检查分支覆盖' },
    quiz: { count: 15, pass: 80, quote: '小测独立评分，80分及格' },
    inClassTarget: 16,
    postClassTarget: 20,
    quote: '课内争取16/20，课后补齐20道正式题',
  },
  L04: {
    detection: { count: 4, minutes: 45, minFirstPass: 3, quote: '45分钟4题，至少3题一次通过并手推一段循环' },
    quiz: { count: 15, pass: 80, quote: '20分钟15道单选，前10题各6分、后5题各8分，共100分，80分及格' },
    inClassTarget: 16,
    postClassTarget: 20,
    quote: '高潜班争取课内4小时训练阶段完成16道正式题，课后补齐20道正式题',
  },
  L05: {
    detection: { count: 3, minutes: null, minFirstPass: 3, quote: '最低检测从已冻结正式题中选三道尚未讲过完整解法的代表题，建议正式01、03、04' },
    quiz: { count: 15, pass: 80, quote: '小测独立评分，80分及格' },
    inClassTarget: 16,
    postClassTarget: 20,
    quote: '高潜班训练目标：课内尽量完成16道正式题，课后争取20道正式题全部参考AC',
  },
};

function parseAcceptance(lessonId) {
  return ACCEPTANCE[lessonId] || {
    detection: { count: 4, minutes: 45, minFirstPass: 3, quote: '' },
    quiz: { count: 15, pass: 80, quote: '' },
    inClassTarget: 16,
    postClassTarget: 20,
    quote: '',
  };
}

function parseModules(md) {
  const lines = md.split(/\r?\n/);
  const modules = [];
  let inModule = false;
  let cursor = 0;
  for (const line of lines) {
    if (/^#{2,4}\s/.test(line) && /(420\s*分钟|模块计划|模块安排|分钟流程|分钟安排|课堂流程)/.test(line)) { inModule = true; continue; }
    if (inModule && /^#{2,4}\s/.test(line)) break;
    if (!inModule) continue;
    const cells = line.split('|').slice(1, -1).map(strip);
    if (cells.length < 3) continue;
    const span = cells[0]?.match(/^(\d+)\s*[–-]\s*(\d+)$/);
    if (span) {
      modules.push({ from: Number(span[1]), to: Number(span[2]), minutes: Number(cells[1]) || Number(span[2]) - Number(span[1]), label: cells[2] });
      cursor = Number(span[2]);
      continue;
    }
    // Sequence-style tables (L03/L05): |模块|分钟|...| or |总块|模块|分钟|...|
    const numIdx = [1, 2, 3].find((i) => /^\d+$/.test(cells[i] || ''));
    if (numIdx) {
      if (/模块|总块|合计|^#/.test(cells[0]) || /合计/.test(cells[numIdx - 1] || '')) continue;
      const minutes = Number(cells[numIdx]);
      const label = cells.slice(0, numIdx).filter((x) => x && x !== '—').join('·');
      modules.push({ from: cursor, to: cursor + minutes, minutes, label });
      cursor += minutes;
    }
  }
  return modules;
}

/** L01 lists its six backup problems only in the teacher-only solution section. */
function parsePlanBackups(md) {
  const rows = [];
  for (const line of md.split(/\r?\n/)) {
    if (!/（备用）|\(备用\)|备用题/.test(line)) continue;
    const m = line.match(/^###\s+\d+\.\s*([A-Za-z0-9_]+)\s*[｜|]\s*([^（(]+)/);
    if (m) rows.push({ pid: strip(m[1]), title: strip(m[2]) });
  }
  return rows;
}

async function loadDualReview(dir) {
  const files = ['教师版/验证材料/双评记录.json', '发布/教师包/验证材料/双评记录.json'];
  for (const rel of files) {
    const f = path.join(dir, rel);
    if (!(await exists(f))) continue;
    const o = JSON.parse(await read(f));
    const map = new Map();
    for (const r of o.records || []) map.set(r.id, r);
    return { file: f, map, raw: o };
  }
  return { file: null, map: new Map(), raw: null };
}

async function loadBuildReport(dir) {
  const f = path.join(dir, 'BUILD-REPORT.json');
  if (!(await exists(f))) return null;
  return JSON.parse(await read(f));
}

async function main() {
  const sourceFiles = [];
  const sessions = [];
  const problemIndex = new Map();

  for (const lesson of LESSONS) {
    const dir = path.join(PHASE, lesson.dir);
    const planFile = path.join(dir, '教师版/01-教师教案.md');
    if (!(await exists(planFile))) throw new Error(`缺少教案：${planFile}`);
    const plan = await read(planFile);
    sourceFiles.push({ kind: 'lesson-plan', lesson: lesson.id, file: planFile, sha256: sha256(plan) });

    const dual = await loadDualReview(dir);
    if (dual.file) sourceFiles.push({ kind: 'dual-review', lesson: lesson.id, file: dual.file, sha256: sha256(JSON.stringify(dual.raw)) });
    const build = await loadBuildReport(dir);
    if (build) sourceFiles.push({ kind: 'build-report', lesson: lesson.id, file: path.join(dir, 'BUILD-REPORT.json'), sha256: sha256(JSON.stringify(build)) });

    const formalRows = findTable(plan, /正式题前表|固定正式题前表/) || [];
    const backupRows = findTable(plan, /备用题前表|固定备用题前表/) || [];

    const parseRows = (rows, role) => rows.map((row, index) => {
      const pid = row['题目ID'] || row['题目 ID'] || row['题号'] || '';
      if (!pid) return null;
      const dualRec = dual.map.get(pid);
      const { tier, label } = pickTier(row);
      const absolute = dualRec?.primary?.absolute_difficulty;
      return {
        pid,
        title: row['原题名'] || row['题目'] || dualRec?.title || '',
        role,
        order: Number(row['序号']) || index + 1,
        tier: tier ?? (absolute ? Number(String(absolute).replace(/\D/g, '')) : null),
        tierLabel: label || absolute || '',
        minutes: pickMinutes(row),
        knowledge: pickKnowledge(row, dualRec),
        quality: dualRec?.primary?.quality || '',
        implementation: dualRec?.primary?.implementation ?? null,
        thinking: dualRec?.primary?.thinking ?? null,
        source: dualRec ? '教案+双评' : '教案',
      };
    }).filter(Boolean);

    const formal = parseRows(formalRows, 'formal');
    let backup = parseRows(backupRows, 'backup');
    if (!backup.length) {
      backup = parsePlanBackups(plan).map((p, index) => ({
        pid: p.pid,
        title: p.title,
        role: 'backup',
        order: 21 + index,
        tier: null,
        tierLabel: '',
        minutes: null,
        knowledge: splitKnowledge(p.title),
        source: '教案-备用题解答',
      }));
    }
    const acceptance = parseAcceptance(lesson.id);
    const modules = parseModules(plan);

    const session = {
      id: lesson.id,
      lesson: lesson.lesson,
      title: lesson.dir.replace(/^R1-P01-L\d+-/, ''),
      date: lesson.date,
      homework: lesson.homework,
      window: { start: '09:00', end: '16:30', lunch: '12:00-13:30' },
      totalMinutes: build?.minutes || 420,
      modules,
      acceptance,
      problems: [...formal, ...backup],
      counts: { formal: formal.length, backup: backup.length, quiz: build?.quiz ?? acceptance.quiz.count },
    };
    sessions.push(session);

    for (const p of [...formal, ...backup]) {
      if (!problemIndex.has(p.pid)) problemIndex.set(p.pid, { ...p, lessonId: lesson.id, lesson: lesson.lesson, roles: [p.role] });
      else problemIndex.get(p.pid).roles.push(p.role);
    }
  }

  // Cross-lesson preview/extra classification per homework set.
  const lessonByPid = new Map();
  for (const s of sessions) for (const p of s.problems) lessonByPid.set(p.pid, s.lesson);

  for (const s of sessions) {
    const own = new Set(s.problems.map((p) => p.pid));
    const later = new Set(sessions.filter((x) => x.lesson > s.lesson).flatMap((x) => x.problems.map((p) => p.pid)));
    s.extra = [];
    // extras are filled by the snapshot merger (scripts/analyze or scrape); blueprint only marks known ids.
    s.previewCandidates = [...later].filter((pid) => !own.has(pid));
  }

  // Session acceptance fallbacks for lessons whose plan carries the criterion in prose.
  const blueprint = {
    schema: 'gaoqian-blueprint-1',
    generatedAt: new Date().toISOString(),
    course: {
      name: '历城二中路线一 · 第一阶段 P01',
      sourceRoot: COURSE,
      note: '由课程资料自动抽取；仅包含 L01-L05（当前高潜班已发生的课次）。',
    },
    cohort: COHORT,
    excluded: EXCLUDED,
    sessions,
    problems: Object.fromEntries([...problemIndex.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
  };

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUT_DIR, 'blueprint.json'), JSON.stringify(blueprint, null, 2), 'utf8');
  await fs.writeFile(path.join(OUT_DIR, 'sources.json'), JSON.stringify({
    generatedAt: blueprint.generatedAt,
    courseRoot: COURSE,
    files: sourceFiles,
  }, null, 2), 'utf8');

  console.log(`blueprint: ${sessions.length} sessions, ${problemIndex.size} problems`);
  for (const s of sessions) {
    console.log(`  ${s.id} ${s.date} ${s.homework} formal=${s.counts.formal} backup=${s.counts.backup} modules=${s.modules.length} detection=${s.acceptance.detection.count}/${s.acceptance.detection.minutes}min>=${s.acceptance.detection.minFirstPass} quiz>=${s.acceptance.quiz.pass}`);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
