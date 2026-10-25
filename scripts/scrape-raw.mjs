#!/usr/bin/env node
/**
 * Fetch the full submission stream for every problem in the five 高潜 homework
 * sets, restricted to the class roster and to the current term.
 *
 * The manager API is slow (1-20s per page) and deep pages are expensive, so this
 * job checkpoints after every few problems and can resume. A time budget keeps
 * the GitHub Actions job inside its 20-minute window; partial data is marked and
 * the diagnosis reports coverage.
 *
 * Output: data/raw/submissions.json (gitignored; contains student data).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ManagerClient, readJson, writeJson } from '../lib/manager.mjs';

const DATA_DIR = path.resolve('data');
const RAW_DIR = path.join(DATA_DIR, 'raw');
const SNAPSHOT = path.join(DATA_DIR, 'snapshot.json');
const BLUEPRINT = path.resolve('blueprint/blueprint.json');
const OUT = path.join(RAW_DIR, 'submissions.json');
const PARTIAL = path.join(RAW_DIR, 'submissions.partial.json');

// First class session (2026-09-12 09:00 +08) minus a safety margin.
const CUTOFF = Date.parse('2026-09-10T00:00:00+08:00');
const BUDGET_MS = Number(process.env.RAW_BUDGET_MS || 12 * 60 * 1000);
const CHECKPOINT_EVERY = 3;

const STATUS = { 0: 'PD', 1: 'AC', 2: 'WA', 3: 'TLE', 4: 'MLE', 5: 'OLE', 6: 'RE', 7: 'CE', 8: 'SE', 9: 'CANCELED', 10: 'ETC' };

const client = new ManagerClient({ concurrency: Number(process.env.MARS_CONCURRENCY || 6) });
const snapshot = await readJson(SNAPSHOT);
const blueprint = await readJson(BLUEPRINT);
if (!blueprint) throw new Error('缺少 blueprint/blueprint.json，请先运行 npm run blueprint');

const roster = new Map();
for (const s of blueprint.cohort || []) roster.set(Number(s.uid), { uid: Number(s.uid), name: s.name, role: 'cohort' });
for (const s of blueprint.excluded || []) roster.set(Number(s.uid), { uid: Number(s.uid), name: s.name, role: s.reason });
for (const s of snapshot?.students || []) if (!roster.has(Number(s.uid))) roster.set(Number(s.uid), { uid: Number(s.uid), name: s.name, role: 'other' });
const rosterUids = new Set(roster.keys());

console.log(`[raw] roster ${rosterUids.size} uids, cutoff ${new Date(CUTOFF).toISOString()}`);
await client.login();

const homeworks = (await client.listHomeworks()).filter((h) => /高潜\s*0*\d/.test(h.title));
const hwByTitle = new Map(homeworks.map((h) => [h.title, h]));
const problemMap = new Map();
for (const session of blueprint.sessions) {
  const hw = hwByTitle.get(session.homework);
  if (!hw) { console.warn(`[raw] 未找到作业 ${session.homework}`); continue; }
  const info = await client.getHomeworkInfo(hw._id);
  for (const p of info?.problems || []) {
    if (!problemMap.has(p.pid)) problemMap.set(p.pid, { problemId: p._id, docId: p.docId, title: p.title, homework: session.homework, lessonId: session.id });
  }
}
for (const hw of snapshot?.homeworks || []) {
  for (const p of hw.problems || []) {
    if (!problemMap.has(p.pid)) problemMap.set(p.pid, { problemId: null, docId: p.docId, title: p.title, homework: hw.title, lessonId: null });
  }
}

// Cheap (recent, small) problems first so a partial run is already useful.
const weight = (pid) => (pid.startsWith('lv') ? 0 : pid.startsWith('fz') ? 1 : pid.startsWith('MNS') || pid.startsWith('GESP') ? 2 : pid.startsWith('a') ? 3 : 4);
const entries = [...problemMap.entries()].sort((a, b) => weight(a[0]) - weight(b[0]) || a[0].localeCompare(b[0]));

const previous = await readJson(PARTIAL);
const done = new Map();
if (previous && previous.cutoff === new Date(CUTOFF).toISOString()) {
  for (const p of previous.problems || []) if (!p.pending && !p.error) done.set(p.pid, p);
  console.log(`[raw] resume from checkpoint: ${done.size}/${entries.length} problems`);
}

const startedAt = Date.now();
let sinceCheckpoint = 0;
let writing = false;
async function checkpoint(complete = false) {
  if (writing) return null;
  writing = true;
  try {
    const problems = entries.map(([pid, meta]) => done.get(pid) || { pid, ...meta, records: [], pending: true });
    const payload = {
      schema: 'gaoqian-raw-submissions-1',
      generatedAt: new Date().toISOString(),
      cutoff: new Date(CUTOFF).toISOString(),
      complete,
      source: { api: 'https://ms.marsoj.cn/api/problem/getRefRecordList', note: 'per-problem full submission list, filtered to class roster' },
      uids: [...roster.values()],
      problems,
      stats: {
        problems: problems.length,
        done: problems.filter((p) => !p.pending).length,
        pending: problems.filter((p) => p.pending).length,
        problemsWithRecords: problems.filter((p) => p.records?.length).length,
        records: problems.reduce((sum, p) => sum + (p.records?.length || 0), 0),
        studentsWithRecords: new Set(problems.flatMap((p) => p.records || []).map((r) => r.uid)).size,
      },
    };
    await writeJson(complete ? OUT : PARTIAL, payload);
    return payload;
  } finally {
    writing = false;
  }
}

await client.mapLimit(entries, async ([pid, meta]) => {
  if (done.has(pid)) {  return; }
  if (Date.now() - startedAt > BUDGET_MS) {  return; }
  if (!meta.problemId) {
    done.set(pid, { pid, ...meta, records: [] });
    return;
  }
  const t0 = Date.now();
  try {
    const records = await client.getProblemRecordsSince(meta.problemId, CUTOFF);
    const kept = records
      .filter((r) => rosterUids.has(Number(r.uid)))
      .map((r) => ({
        rid: r._id,
        uid: Number(r.uid),
        uname: r.uname,
        status: Number(r.status),
        statusCode: STATUS[Number(r.status)] || String(r.status),
        score: Number(r.score) || 0,
        judgeAt: r.judgeAt,
      }))
      .sort((a, b) => String(a.judgeAt).localeCompare(String(b.judgeAt)));
    done.set(pid, { pid, ...meta, totalSinceCutoff: records.length, records: kept, fetchedAt: new Date().toISOString() });
  } catch (error) {
    done.set(pid, { pid, ...meta, records: [], error: error.message, fetchedAt: new Date().toISOString() });
    console.warn(`[raw] ${pid} 失败：${error.message}`);
  }
 
  sinceCheckpoint++;
  const seconds = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`[raw] ${done.size}/${entries.length} ${pid} ${seconds}s (${done.get(pid).records?.length || 0} kept)`);
  if (sinceCheckpoint >= CHECKPOINT_EVERY) { sinceCheckpoint = 0; await checkpoint(false); }
});

const complete = done.size === entries.length;
const payload = await checkpoint(complete);
console.log(`[raw] ${complete ? 'complete' : 'partial'}: ${payload.stats.done}/${payload.stats.problems} problems, ${payload.stats.records} records, ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);
if (!complete) console.log('[raw] 未完成的问题已标记 pending；再次运行会从检查点继续。');
