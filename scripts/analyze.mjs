#!/usr/bin/env node
/**
 * Build data/diagnosis.json from blueprint + snapshot + full submission stream.
 * Run after `npm run raw` (or the scrape workflow) so the latest attempt data is used.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { analyze, diagnosisHash } from '../lib/analytics.mjs';
import { readJson, writeJson } from '../lib/manager.mjs';

const DATA_DIR = path.resolve('data');
const OUT = path.join(DATA_DIR, 'diagnosis.json');
const blueprint = await readJson(path.resolve('blueprint/blueprint.json'));
const snapshot = await readJson(path.join(DATA_DIR, 'snapshot.json'));

async function loadRaw() {
  const lessonDir = path.join(DATA_DIR, 'raw', 'lessons');
  let files = [];
  try { files = (await fs.readdir(lessonDir)).filter((f) => f.endsWith('.json')); } catch { /* no per-lesson data yet */ }
  if (files.length) {
    const byPid = new Map();
    let generatedAt = null;
    let complete = true;
    for (const file of files) {
      const lesson = await readJson(path.join(lessonDir, file));
      if (!lesson) continue;
      if (lesson.generatedAt && (!generatedAt || lesson.generatedAt > generatedAt)) generatedAt = lesson.generatedAt;
      if (!lesson.complete) complete = false;
      for (const p of lesson.problems || []) {
        if (!byPid.has(p.pid)) byPid.set(p.pid, { pid: p.pid, title: p.title, role: p.role, records: [], pending: true });
        const target = byPid.get(p.pid);
        if (!p.pending) target.pending = false;
        const seen = new Set(target.records.map((r) => r.rid));
        for (const r of p.records || []) if (!seen.has(r.rid)) { seen.add(r.rid); target.records.push(r); }
      }
    }
    const problems = [...byPid.values()].map((p) => ({ ...p, records: p.records.sort((a, b) => String(a.judgeAt).localeCompare(String(b.judgeAt))) }));
    return {
      schema: 'gaoqian-lesson-submissions-1',
      generatedAt,
      cutoff: files.length ? new Date(Date.parse('2026-09-10T00:00:00+08:00')).toISOString() : null,
      complete,
      problems,
      stats: {
        problems: problems.length,
        done: problems.filter((p) => !p.pending).length,
        pending: problems.filter((p) => p.pending).length,
        records: problems.reduce((sum, p) => sum + p.records.length, 0),
      },
    };
  }
  const legacy = [
    await readJson(path.join(DATA_DIR, 'raw', 'submissions.json')),
    await readJson(path.join(DATA_DIR, 'raw', 'submissions.partial.json')),
  ].filter(Boolean).sort((a, b) => (b.stats?.done || 0) - (a.stats?.done || 0));
  return legacy[0] || null;
}

const raw = await loadRaw();

if (!blueprint) throw new Error('缺少 blueprint/blueprint.json，请先运行 npm run blueprint');
if (!snapshot) throw new Error('缺少 data/snapshot.json，请先抓取看板数据');
if (!raw) console.warn('提示：尚未抓到全量提交流，诊断只使用成绩表选中记录（一次通过率不可用）。');

const diagnosis = analyze({ snapshot, raw, blueprint });
diagnosis.hash = diagnosisHash(diagnosis);
await writeJson(OUT, diagnosis);

const fmt = (v, d = 1) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`);
console.log(`diagnosis: ${OUT}`);
console.log(`  students ${diagnosis.stats.students}, sessions ${diagnosis.stats.sessions}, raw records ${diagnosis.stats.rawRecords}`);
for (const s of diagnosis.students) {
  console.log(`  ${s.name}: completion ${fmt(s.summary.completionRate)}, first-pass ${fmt(s.summary.firstPassRate)} (${s.summary.firstPass}/${s.summary.firstPassKnown}), give-ups ${s.summary.giveUps}, findings ${s.findings.length}`);
}
const dq = diagnosis.class.overall.dataQuality;
console.log(`  data: coverage ${fmt(dq.coverage.rate)}, knowledge ${fmt(dq.knowledgeCoverage.rate)}, raw=${dq.rawAvailable}`);
console.log(`  validation: rho ${diagnosis.class.overall.difficultyValidation.spearman} (p ${diagnosis.class.overall.difficultyValidation.permutationP}), holdout MAE ${diagnosis.class.overall.holdout.modelMae} vs class-mean ${diagnosis.class.overall.holdout.classMeanMae}`);
