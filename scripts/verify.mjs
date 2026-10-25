#!/usr/bin/env node
/**
 * Data + diagnosis integrity checks. Fails loudly instead of publishing a
 * dashboard whose numbers no longer add up.
 *
 * Usage: npm run verify
 */
import path from 'node:path';
import { readJson } from '../lib/manager.mjs';

const root = process.cwd();
const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail });

const blueprint = await readJson(path.join(root, 'blueprint/blueprint.json'));
const snapshot = await readJson(path.join(root, 'data/snapshot.json'));
const raw = await readJson(path.join(root, 'data/raw/submissions.json')) || await readJson(path.join(root, 'data/raw/submissions.partial.json'));
const diagnosis = await readJson(path.join(root, 'data/diagnosis.json'));

check('blueprint exists', Boolean(blueprint), 'blueprint/blueprint.json');
if (blueprint) {
  check('blueprint has sessions', blueprint.sessions.length >= 1, `got ${blueprint.sessions.length}`);
  for (const s of blueprint.sessions) {
    const formal = s.problems.filter((p) => p.role === 'formal').length;
    const withTime = s.problems.filter((p) => p.minutes).length;
    check(`${s.id} has formal problems`, formal > 0, `got ${formal}`);
    check(`${s.id} has suggested minutes`, withTime >= 18, `${withTime}/${s.problems.length}`);
  }
  const known = Object.values(blueprint.problems);
  const withKnowledge = known.filter((p) => (p.knowledge || []).length).length;
  check('knowledge coverage >= 95%', withKnowledge / known.length >= 0.95, `${withKnowledge}/${known.length}`);
}

check('snapshot exists', Boolean(snapshot), 'data/snapshot.json');
if (snapshot && blueprint) {
  for (const s of blueprint.sessions) {
    const hw = snapshot.homeworks.find((h) => h.title === s.homework);
    check(`${s.id} homework in snapshot`, Boolean(hw), s.homework);
    if (!hw) continue;
    const pids = new Set(hw.problems.map((p) => p.pid));
    const missing = s.problems.filter((p) => !pids.has(p.pid));
    check(`${s.id} blueprint problems all in homework`, missing.length === 0, missing.map((p) => p.pid).join(','));
  }
}

if (raw) {
  const rids = new Set();
  let duplicates = 0;
  for (const p of raw.problems) {
    for (const r of p.records || []) {
      if (rids.has(r.rid)) duplicates++;
      rids.add(r.rid);
    }
  }
  check('raw has no duplicate record ids', duplicates === 0, `${duplicates} duplicates`);
  const pending = raw.problems.filter((p) => p.pending).length;
  check('raw coverage reported', raw.stats && Number.isFinite(raw.stats.done), JSON.stringify(raw.stats));
  check('raw data is readable', pending === 0 || raw.complete === false, `${pending} pending problems`);
  const badTime = raw.problems.flatMap((p) => p.records || []).filter((r) => !r.judgeAt || Number.isNaN(Date.parse(r.judgeAt))).length;
  check('raw records have valid judgeAt', badTime === 0, `${badTime} bad timestamps`);
}

check('diagnosis exists', Boolean(diagnosis), 'data/diagnosis.json');
if (diagnosis) {
  check('diagnosis has a cohort', diagnosis.cohort.length >= 1, `got ${diagnosis.cohort.length}`);
  check('diagnosis has class sessions', diagnosis.class.sessions.length === diagnosis.sessions.length, `got ${diagnosis.class.sessions.length}`);
  for (const student of diagnosis.students) {
    const s = student.summary;
    check(`${student.name} completion in [0,1]`, s.completionRate == null || (s.completionRate >= 0 && s.completionRate <= 1), String(s.completionRate));
    check(`${student.name} first-pass in [0,1]`, s.firstPassRate == null || (s.firstPassRate >= 0 && s.firstPassRate <= 1), String(s.firstPassRate));
    check(`${student.name} first-pass <= attempted`, s.firstPass <= s.firstPassKnown, `${s.firstPass}/${s.firstPassKnown}`);
    check(`${student.name} AC <= attempted`, s.ac <= s.attempted, `${s.ac}/${s.attempted}`);
    for (const session of student.sessions) {
      const formal = session.problems.filter((p) => p.role === 'formal').length;
      check(`${student.name} ${session.sessionId} formal total`, formal > 0, `got ${formal}`);
    }
  }
  const dv = diagnosis.class.overall.difficultyValidation;
  check('difficulty validation computed', dv.n > 0 && dv.spearman != null, `n=${dv.n} rho=${dv.spearman}`);
  const dq = diagnosis.class.overall.dataQuality;
  check('diagnosis data quality section', Boolean(dq.coverage), JSON.stringify(dq.coverage));
}

const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  — ${c.detail}` : ''}`);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) process.exitCode = 1;
