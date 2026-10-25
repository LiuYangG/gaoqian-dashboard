#!/usr/bin/env node
/**
 * Full per-lesson submission capture.
 *
 * For every lesson (blueprint + any new homework that only exists in the
 * scoreboard), fetch every attempt of every problem for the current roster and
 * store it in data/raw/lessons/{lessonId}.json. Files are overwritten, records
 * are de-duplicated by record id, and the old aggregate files are migrated and
 * removed so stale/duplicated data does not survive.
 *
 * Daily runs are incremental: each problem is refreshed from its last
 * checkpoint, so a normal night only walks the newest pages.
 *
 * Output:
 *   data/raw/lessons/L01.json ... L0N.json
 *   data/raw/index.json
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ManagerClient, readJson, writeJson } from '../lib/manager.mjs';
import { buildSessionPlan, deriveRoster, loadRoles } from '../lib/plan.mjs';

const DATA_DIR = path.resolve('data');
const RAW_DIR = path.join(DATA_DIR, 'raw');
const LESSON_DIR = path.join(RAW_DIR, 'lessons');
const INDEX_FILE = path.join(RAW_DIR, 'index.json');
const SNAPSHOT = path.join(DATA_DIR, 'snapshot.json');
const BLUEPRINT = path.resolve('blueprint/blueprint.json');
const CUTOFF = Date.parse('2026-09-10T00:00:00+08:00');
const BUDGET_MS = Number(process.env.RAW_BUDGET_MS || 20 * 60 * 1000);
const STATUS = { 0: 'PD', 1: 'AC', 2: 'WA', 3: 'TLE', 4: 'MLE', 5: 'OLE', 6: 'RE', 7: 'CE', 8: 'SE', 9: 'CANCELED', 10: 'ETC' };

const snapshot = await readJson(SNAPSHOT);
const blueprint = await readJson(BLUEPRINT);
if (!blueprint) throw new Error('缺少 blueprint/blueprint.json，请先运行 npm run blueprint');
const roles = await loadRoles();
const plan = buildSessionPlan(blueprint, snapshot);
const roster = deriveRoster(snapshot, roles);
const rosterUids = new Set(roster.cohort.map((s) => s.uid));
console.log(`[raw] ${plan.sessions.length} lessons, ${rosterUids.size} students, budget ${Math.round(BUDGET_MS / 60000)}min`);

const client = new ManagerClient({ concurrency: Number(process.env.MARS_CONCURRENCY || 6) });
await client.login();

// Map homework title -> problem metadata (the API needs the problem document id).
const homeworks = (await client.listHomeworks()).filter((h) => /高潜/.test(h.title));
const hwByTitle = new Map(homeworks.map((h) => [h.title, h]));
const problemMeta = new Map();
for (const session of plan.sessions) {
  if (!session.homework) continue;
  const hw = hwByTitle.get(session.homework);
  if (!hw) { console.warn(`[raw] 未找到作业 ${session.homework}`); continue; }
  const info = await client.getHomeworkInfo(hw._id);
  for (const p of info?.problems || []) {
    if (!problemMeta.has(p.pid)) problemMeta.set(p.pid, { problemId: p._id, docId: p.docId, title: p.title, homework: session.homework });
  }
}
for (const hw of snapshot?.homeworks || []) {
  for (const p of hw.problems || []) {
    if (!problemMeta.has(p.pid)) problemMeta.set(p.pid, { problemId: null, docId: p.docId, title: p.title, homework: hw.title });
  }
}

/** Split the legacy aggregate into per-lesson files, once; delete the old files. */
async function migrateLegacy() {
  const legacy = await readJson(path.join(RAW_DIR, 'submissions.json')) || await readJson(path.join(RAW_DIR, 'submissions.partial.json'));
  if (!legacy?.problems?.length) return false;
  await fs.mkdir(LESSON_DIR, { recursive: true });
  const byPid = new Map(legacy.problems.map((p) => [p.pid, p]));
  for (const session of plan.sessions) {
    const homeworkPids = (snapshot?.homeworks || []).find((h) => h.title === session.homework)?.problems?.map((p) => p.pid) || [];
    const pids = new Set([...session.problems.map((p) => p.pid), ...homeworkPids]);
    const problems = [];
    for (const pid of pids) {
      const row = byPid.get(pid);
      if (!row) continue;
      problems.push({
        pid,
        title: row.title,
        role: row.role || 'formal',
        problemId: row.problemId,
        records: Array.isArray(row.records) ? row.records : [],
        pending: Boolean(row.pending),
        checkedAt: row.fetchedAt || legacy.generatedAt,
      });
    }
    if (problems.length) {
      await writeJson(path.join(LESSON_DIR, `${session.id}.json`), {
        schema: 'gaoqian-lesson-submissions-1',
        lessonId: session.id,
        date: session.date,
        homework: session.homework,
        generatedAt: legacy.generatedAt,
        problems,
        complete: problems.every((p) => !p.pending),
      });
    }
  }
  await fs.rm(path.join(RAW_DIR, 'submissions.json'), { force: true });
  await fs.rm(path.join(RAW_DIR, 'submissions.partial.json'), { force: true });
  console.log('[raw] migrated legacy aggregate into per-lesson files');
  return true;
}

await fs.mkdir(LESSON_DIR, { recursive: true });
if (!(await fs.readdir(LESSON_DIR)).some((f) => f.endsWith('.json'))) await migrateLegacy();

const deadline = Date.now() + BUDGET_MS;
const index = [];
for (const session of plan.sessions) {
  const file = path.join(LESSON_DIR, `${session.id}.json`);
  const existing = await readJson(file);
  const existingByPid = new Map((existing?.problems || []).map((p) => [p.pid, p]));
  const homework = (snapshot?.homeworks || []).find((h) => h.title === session.homework);
  const pids = [...new Set([...session.problems.map((p) => p.pid), ...(homework?.problems || []).map((p) => p.pid)])];
  let refreshed = 0;
  const problems = await client.mapLimit(pids, async (pid) => {
    const old = existingByPid.get(pid) || { records: [], pending: true };
    const meta = problemMeta.get(pid) || { problemId: null, title: pid, homework: session.homework };
    if (!meta.problemId) return { ...old, pid, title: meta.title, pending: true };
    if (Date.now() > deadline) return { ...old, pid, title: meta.title, pending: true };

    try {
      const known = Array.isArray(old.records) ? old.records : [];
      const maxJudge = known.reduce((max, r) => Math.max(max, Date.parse(r.judgeAt) || 0), 0);
      const since = old.pending || !known.length
        ? CUTOFF
        : Math.max(CUTOFF, (old.checkedAt ? Date.parse(old.checkedAt) : maxJudge) - 10 * 60 * 1000);
      const records = await client.getProblemRecordsSince(meta.problemId, since);
      const byRid = new Map(known.map((r) => [r.rid, r]));
      for (const r of records) {
        if (!rosterUids.has(Number(r.uid))) continue;
        byRid.set(r._id, {
          rid: r._id,
          uid: Number(r.uid),
          uname: r.uname,
          status: Number(r.status),
          statusCode: STATUS[Number(r.status)] || String(r.status),
          score: Number(r.score) || 0,
          judgeAt: r.judgeAt,
        });
      }
      const merged = [...byRid.values()].sort((a, b) => String(a.judgeAt).localeCompare(String(b.judgeAt)));
      refreshed++;
      return {
        pid,
        title: meta.title,
        role: session.problems.find((p) => p.pid === pid)?.role || 'formal',
        problemId: meta.problemId,
        records: merged,
        pending: false,
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      console.warn(`[raw] ${session.id} ${pid} 失败：${error.message}`);
      return { ...old, pid, title: meta.title, problemId: meta.problemId, pending: true, error: error.message };
    }
  });

  // De-duplicate record ids inside the lesson, then overwrite the file.
  const seen = new Set();
  for (const p of problems) p.records = (p.records || []).filter((r) => (seen.has(r.rid) ? false : (seen.add(r.rid), true)));
  const complete = problems.every((p) => !p.pending);
  const payload = {
    schema: 'gaoqian-lesson-submissions-1',
    lessonId: session.id,
    date: session.date,
    homework: session.homework,
    generatedAt: new Date().toISOString(),
    complete,
    problems,
    stats: {
      problems: problems.length,
      pending: problems.filter((p) => p.pending).length,
      records: problems.reduce((sum, p) => sum + p.records.length, 0),
      students: new Set(problems.flatMap((p) => p.records.map((r) => r.uid))).size,
    },
  };
  await writeJson(file, payload);
  index.push({ lessonId: session.id, date: session.date, homework: session.homework, complete, ...payload.stats });
  console.log(`[raw] ${session.id} ${complete ? 'complete' : 'partial'} ${payload.stats.records} records, ${payload.stats.pending} pending, ${refreshed} refreshed`);
  if (Date.now() > deadline) { console.warn('[raw] budget reached; remaining lessons kept as checkpoint'); break; }
}

await writeJson(INDEX_FILE, {
  schema: 'gaoqian-raw-index-1',
  generatedAt: new Date().toISOString(),
  cutoff: new Date(CUTOFF).toISOString(),
  lessons: index,
});
console.log(`[raw] index written: ${index.map((x) => `${x.lessonId}:${x.pending || 0}p`).join(' ')}`);
