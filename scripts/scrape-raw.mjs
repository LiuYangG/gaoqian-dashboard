#!/usr/bin/env node
/**
 * Incremental per-lesson submission capture for the post-2026 platform.
 *
 * Each homework/lesson has a `/record?tid={tid}` list (20 rows/page, newest
 * first). We read pages until we pass the lesson's last checkpoint, so a normal
 * nightly run only reads the newest page(s). Files are overwritten and records
 * are de-duplicated by record id.
 *
 * Output: data/raw/lessons/{lessonId}.json + data/raw/index.json
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ManagerClient, readJson, writeJson } from '../lib/manager.mjs';
import { buildSessionPlan, deriveRoster, loadRoles } from '../lib/plan.mjs';
import { lastRecordPage, parseRecordListHtml } from '../scraper.mjs';

const DATA_DIR = path.resolve('data');
const RAW_DIR = path.join(DATA_DIR, 'raw');
const LESSON_DIR = path.join(RAW_DIR, 'lessons');
const INDEX_FILE = path.join(RAW_DIR, 'index.json');
const SNAPSHOT = path.join(DATA_DIR, 'snapshot.json');
const BLUEPRINT = path.resolve('blueprint/blueprint.json');
// First class session (2026-09-12 09:00 +08) minus a safety margin.
const CUTOFF = Date.parse('2026-09-10T00:00:00+08:00');
const OVERLAP_MS = 10 * 60 * 1000;
const BUDGET_MS = Number(process.env.RAW_BUDGET_MS || 10 * 60 * 1000);
const MAX_PAGES = Number(process.env.RAW_MAX_PAGES || 80);

const snapshot = await readJson(SNAPSHOT);
const blueprint = await readJson(BLUEPRINT);
if (!snapshot) throw new Error('缺少 data/snapshot.json，请先运行 run-scrape.mjs');
if (!blueprint) throw new Error('缺少 blueprint/blueprint.json，请先运行 npm run blueprint');
const roles = await loadRoles();
const plan = buildSessionPlan(blueprint, snapshot);
const roster = deriveRoster(snapshot, roles);
const rosterUids = new Set(roster.cohort.map((s) => Number(s.uid)));
const hwById = new Map((snapshot.homeworks || []).map((h) => [h.title, h]));
console.log(`[raw] ${plan.sessions.length} lessons, ${rosterUids.size} students, budget ${Math.round(BUDGET_MS / 60000)}min`);

const client = new ManagerClient({ concurrency: Number(process.env.MARS_CONCURRENCY || 6) });
await client.login();
await fs.mkdir(LESSON_DIR, { recursive: true });
// Legacy aggregate files are obsolete; remove them so duplicates cannot survive.
for (const legacy of ['submissions.json', 'submissions.partial.json']) {
  await fs.rm(path.join(RAW_DIR, legacy), { force: true });
}

const deadline = Date.now() + BUDGET_MS;
const index = [];

for (const session of plan.sessions) {
  const homework = hwById.get(session.homework);
  const tid = homework?.id || null;
  const file = path.join(LESSON_DIR, `${session.id}.json`);
  const existing = await readJson(file);
  const existingProblems = new Map((existing?.problems || []).map((p) => [p.pid, p]));
  const existingRecords = new Map();
  let checkpoint = 0;
  for (const p of existing?.problems || []) {
    for (const r of p.records || []) {
      existingRecords.set(r.rid, { ...r, pid: p.pid, title: p.title });
      const t = Date.parse(r.judgeAt);
      if (Number.isFinite(t)) checkpoint = Math.max(checkpoint, t);
    }
  }
  const since = checkpoint ? Math.max(CUTOFF, checkpoint - OVERLAP_MS) : CUTOFF;

  const collected = [];
  let pagesRead = 0;
  let complete = true;
  if (tid && Date.now() <= deadline) {
    try {
      let first = await client.getRecordListHtml(tid, 1);
      const maxPage = Math.min(lastRecordPage(first), MAX_PAGES);
      for (let page = 1; page <= maxPage; page++) {
        const html = page === 1 ? first : await client.getRecordListHtml(tid, page);
        const rows = parseRecordListHtml(html);
        pagesRead++;
        for (const row of rows) {
          if (!row.judgeAt) continue;
          if (Date.parse(row.judgeAt) < since) continue;
          if (row.uid == null || !rosterUids.has(Number(row.uid))) continue;
          collected.push(row);
        }
        const oldest = rows.reduce((min, r) => Math.min(min, Date.parse(r.judgeAt) || Infinity), Infinity);
        if (oldest < since) break;
        if (Date.now() > deadline) { complete = false; break; }
      }
    } catch (error) {
      complete = false;
      console.warn(`[raw] ${session.id} 记录列表失败：${error.message}`);
    }
  } else {
    complete = false;
  }

  // Merge with the existing lesson file (by record id) and group by problem.
  const byRid = new Map(existingRecords);
  for (const row of collected) byRid.set(row.rid, row);
  const pids = [...new Set([...session.problems.map((p) => p.pid), ...(homework?.problems || []).map((p) => p.pid)])];
  const problems = pids.map((pid) => {
    const rows = [...byRid.values()].filter((r) => r.pid === pid);
    const records = rows
      .map((r) => ({
        rid: r.rid,
        uid: Number(r.uid),
        uname: r.uname,
        status: r.status?.code || r.status,
        statusCode: r.status?.code || r.status,
        score: Number(r.score) || 0,
        judgeAt: r.judgeAt,
      }))
      .sort((a, b) => String(a.judgeAt).localeCompare(String(b.judgeAt)));
    return {
      pid,
      title: session.problems.find((p) => p.pid === pid)?.title || rows[0]?.title || pid,
      role: session.problems.find((p) => p.pid === pid)?.role || 'formal',
      records,
      pending: false,
      checkedAt: new Date().toISOString(),
    };
  });

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
      pending: 0,
      records: problems.reduce((sum, p) => sum + p.records.length, 0),
      pagesRead,
      students: new Set(problems.flatMap((p) => p.records.map((r) => r.uid))).size,
    },
  };
  await writeJson(file, payload);
  index.push({ lessonId: session.id, date: session.date, homework: session.homework, complete, ...payload.stats });
  console.log(`[raw] ${session.id} ${complete ? 'complete' : 'partial'} ${payload.stats.records} records (+${collected.length}), ${pagesRead} pages`);
  if (Date.now() > deadline) { console.warn('[raw] budget reached'); break; }
}

await writeJson(INDEX_FILE, {
  schema: 'gaoqian-raw-index-1',
  generatedAt: new Date().toISOString(),
  cutoff: new Date(CUTOFF).toISOString(),
  lessons: index,
});
console.log(`[raw] index written: ${index.map((x) => `${x.lessonId}:${x.records}r`).join(' ')}`);
