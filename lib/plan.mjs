/**
 * Session/roster planning shared by the scraper and the diagnosis engine.
 *
 * The course grows over time: new lesson folders appear, new homework sets are
 * published, and new students join. This module keeps the pipeline dynamic:
 *  - blueprint lessons are used when available;
 *  - any homework in the snapshot that has no blueprint lesson becomes a
 *    data-only session (so new homework is visible immediately);
 *  - the roster is derived from the current scoreboard, with teacher accounts
 *    excluded by config, not hardcoded.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

const CN_OFFSET = 8 * 3600 * 1000;

export async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

export async function loadRoles(root = process.cwd()) {
  const config = await readJson(path.join(root, 'config', 'roles.json'), {});
  const teachers = new Set((config.teachers || []).map(Number));
  return { teachers, config };
}

export async function loadSessionConfig(root = process.cwd()) {
  return await readJson(path.join(root, 'config', 'sessions.json'), {});
}

const cnDate = (value) => new Date(new Date(value).getTime() + CN_OFFSET).toISOString().slice(0, 10);
const cnWeekday = (value) => new Date(new Date(value).getTime() + CN_OFFSET).getUTCDay();

/** Earliest Saturday with at least `minCount` submissions for a homework; else beginAt date. */
export function inferSessionDate(homeworkTitle, snapshot, minCount = 3) {
  const hw = (snapshot?.homeworks || []).find((h) => h.title === homeworkTitle);
  if (!hw) return null;
  const buckets = new Map();
  for (const record of snapshot?.records || []) {
    if (record.homework !== homeworkTitle || !record.submitAt) continue;
    const day = cnDate(record.submitAt);
    buckets.set(day, (buckets.get(day) || 0) + 1);
  }
  const saturdays = [...buckets.entries()]
    .filter(([day, count]) => cnWeekday(`${day}T12:00:00+08:00`) === 6 && count >= minCount)
    .sort((a, b) => a[0].localeCompare(b[0]));
  if (saturdays.length) return saturdays[0][0];
  const begin = hw.beginAt ? new Date(String(hw.beginAt).replace(' ', 'T') + '+08:00') : null;
  return begin && !Number.isNaN(begin.getTime()) ? cnDate(begin) : null;
}

function sessionFromHomework(homework, snapshot, blueprintProblems) {
  const match = String(homework.title || '').match(/高潜\s*0*(\d+)/);
  const order = match ? Number(match[1]) : 0;
  const problems = (homework.problems || []).map((p, index) => {
    const known = blueprintProblems?.[p.pid] || {};
    return {
      pid: p.pid,
      title: known.title || p.title || p.pid,
      role: known.role || 'formal',
      order: known.order || index + 1,
      tier: known.tier ?? null,
      tierLabel: known.tierLabel || '',
      minutes: known.minutes ?? null,
      knowledge: known.knowledge || [],
      source: known.source || 'scoreboard-only',
    };
  });
  return {
    id: order ? `L${String(order).padStart(2, '0')}` : `H${homework.id.slice(-4)}`,
    lesson: order || null,
    title: homework.title,
    date: inferSessionDate(homework.title, snapshot),
    homework: homework.title,
    window: { start: '09:00', end: '16:30', lunch: '12:00-13:30' },
    totalMinutes: null,
    modules: [],
    acceptance: {
      detection: { count: null, minutes: null, minFirstPass: null, quote: '' },
      quiz: { count: 15, pass: 80, quote: '' },
      inClassTarget: null,
      postClassTarget: null,
      quote: '由成绩表自动生成的数据课次：未配置教案，只统计提交行为。',
      dataOnly: true,
    },
    problems,
    counts: { formal: problems.filter((p) => p.role === 'formal').length, backup: problems.filter((p) => p.role === 'backup').length, quiz: null },
    dataOnly: true,
  };
}

function mergeHomeworkProblems(session, homework, blueprintProblems) {
  const planned = new Map((session.problems || []).map((p) => [p.pid, p]));
  const plannedFormal = [...planned.values()].filter((p) => p.role === 'formal').length;
  const plannedBackup = [...planned.values()].filter((p) => p.role === 'backup').length;
  const actual = (homework.problems || []).map((p, index) => {
    const known = planned.get(p.pid) || blueprintProblems?.[p.pid] || null;
    return {
      pid: p.pid,
      title: p.title || known?.title || p.pid,
      // Every problem actually listed in the MarsOJ homework counts toward
      // completion; the course plan role is kept as metadata only.
      role: 'formal',
      planRole: known?.role || 'extra',
      order: index + 1,
      tier: known?.tier ?? null,
      tierLabel: known?.tierLabel || '',
      minutes: known?.minutes ?? null,
      knowledge: known?.knowledge || [],
      source: known ? 'blueprint' : 'scoreboard',
    };
  });
  if (!actual.length) return session;
  return {
    ...session,
    problems: actual,
    plannedFormal,
    plannedBackup,
    counts: { ...(session.counts || {}), formal: actual.length, backup: 0 },
  };
}

/**
 * Merge blueprint lessons with snapshot homework. The MarsOJ homework problem
 * list is authoritative: every question actually assigned is counted, while the
 * course blueprint supplies knowledge/tier/minutes when it knows the problem.
 * Snapshot-only homework becomes a data-only session.
 */
export function buildSessionPlan(blueprint, snapshot) {
  const problems = { ...(blueprint?.problems || {}) };
  const sessions = [];
  const seenHomework = new Set();
  const seenLesson = new Set();
  const hwByTitle = new Map((snapshot?.homeworks || []).map((h) => [h.title, h]));

  for (const s of blueprint?.sessions || []) {
    const date = s.date || inferSessionDate(s.homework, snapshot);
    const homework = hwByTitle.get(s.homework);
    let session = { ...s, date, homework: s.homework || null };
    if (homework) session = mergeHomeworkProblems(session, homework, problems);
    sessions.push(session);
    if (session.homework) seenHomework.add(session.homework);
    if (session.lesson) seenLesson.add(Number(session.lesson));
    for (const p of session.problems || []) if (!problems[p.pid]) problems[p.pid] = p;
  }

  for (const homework of snapshot?.homeworks || []) {
    if (!(homework.problems || []).length) continue;
    const title = homework.title;
    if (seenHomework.has(title)) continue;
    const match = String(title).match(/高潜\s*0*(\d+)/);
    const order = match ? Number(match[1]) : null;
    if (order && seenLesson.has(order)) continue;
    const session = mergeHomeworkProblems(sessionFromHomework(homework, snapshot, problems), homework, problems);
    if (order) seenLesson.add(order);
    sessions.push(session);
    for (const p of session.problems) if (!problems[p.pid]) problems[p.pid] = p;
  }

  sessions.sort((a, b) => (a.lesson || 999) - (b.lesson || 999) || String(a.date || '').localeCompare(String(b.date || '')));
  return { sessions, problems };
}

/** Roster from the scoreboard: teachers excluded; everyone else is a student. */
export function deriveRoster(snapshot, roles) {
  const teacherSet = roles?.teachers || new Set();
  const students = (snapshot?.students || []).map((s) => ({ uid: Number(s.uid), name: s.name }));
  const cohort = students.filter((s) => !teacherSet.has(s.uid));
  const excluded = students.filter((s) => teacherSet.has(s.uid)).map((s) => ({ ...s, reason: 'teacher' }));

  const submitted = new Set();
  for (const hw of snapshot?.homeworks || []) {
    for (const student of hw.students || []) {
      for (const cell of student.cells || []) if (cell.rid) submitted.add(Number(student.uid));
    }
  }
  const inactive = cohort.filter((s) => !submitted.has(s.uid)).map((s) => ({ ...s, reason: 'no-submission' }));
  return { cohort, excluded, inactive };
}
