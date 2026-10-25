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
const candidates = [
  await readJson(path.join(DATA_DIR, 'raw', 'submissions.json')),
  await readJson(path.join(DATA_DIR, 'raw', 'submissions.partial.json')),
].filter(Boolean);
// Prefer the checkpoint with the most completed problems, not merely the final filename.
candidates.sort((a, b) => (b.stats?.done || 0) - (a.stats?.done || 0));
const raw = candidates[0] || null;

if (!blueprint) throw new Error('缺少 blueprint/blueprint.json，请先运行 npm run blueprint');
if (!snapshot) throw new Error('缺少 data/snapshot.json，请先抓取看板数据');
if (!raw) console.warn('提示：data/raw/submissions.json 不存在，诊断将退化为「成绩表选中记录」口径（一次通过率不可用）。');

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
