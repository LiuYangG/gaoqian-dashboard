import test from 'node:test';
import assert from 'node:assert/strict';
import { internals } from '../lib/analytics.mjs';

test('wilson interval stays inside [0,1] and brackets the point estimate', () => {
  const w = internals.wilson(5, 10);
  assert.equal(w.n, 10);
  assert.ok(w.low >= 0 && w.high <= 1);
  assert.ok(w.low < 0.5 && w.high > 0.5);
  assert.equal(internals.wilson(0, 0), null);
});

test('spearman is +1 for monotonic and -1 for reversed ranks', () => {
  assert.equal(internals.spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(internals.spearman([1, 2, 3, 4], [40, 30, 20, 10]), -1);
  assert.equal(internals.spearman([1, 2], [1, 2]), null, 'needs at least 4 pairs');
});

test('median handles odd and even samples', () => {
  assert.equal(internals.median([3, 1, 2]), 2);
  assert.equal(internals.median([4, 1, 3, 2]), 2.5);
  assert.equal(internals.median([]), null);
});

test('knowledge phrases collapse into a stable taxonomy', () => {
  assert.equal(internals.knowledgeGroup('单层 for'), '循环与状态');
  assert.equal(internals.knowledgeGroup('固定文本输出'), '输出与格式');
  assert.equal(internals.knowledgeGroup('if/else 分支'), '分支与条件');
  assert.equal(internals.knowledgeGroup('数组下标越界'), '数组与计数');
  assert.equal(internals.knowledgeGroup('奇怪的新知识点'), '其他');
});

test('class phase respects the confirmed Saturday session date', () => {
  const session = { date: '2026-09-12' };
  assert.equal(internals.classifyPhase('2026-09-12T03:00:00.000Z', session), 'in-class'); // 11:00 +08
  assert.equal(internals.classifyPhase('2026-09-11T03:00:00.000Z', session), 'preview');
  assert.equal(internals.classifyPhase('2026-09-13T03:00:00.000Z', session), 'catch-up');
  assert.equal(internals.classifyPhase('2026-09-12T10:00:00.000Z', session), 'after-class'); // 18:00 +08
});

test('status codes normalize both raw numbers and snapshot strings', () => {
  assert.equal(internals.statusCode({ statusCode: 'AC' }), 'AC');
  assert.equal(internals.statusCode({ status: 1 }), 'AC');
  assert.equal(internals.statusCode({ status: 7 }), 'CE');
  assert.equal(internals.statusCode(null), 'NONE');
});
