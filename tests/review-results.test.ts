import test from 'node:test';
import assert from 'node:assert/strict';
import { appendReviewResult, reconcileReviewResults } from '../src/review-results.ts';
import type { ReviewResult } from '../src/orchestrator.ts';

const blocking = (): ReviewResult => ({ reviewer: 'security', verdict: 'changes_requested', report: { finding: 'Keep this evidence' } });

test('incremental results are copied and reject duplicates/unselected reviewers', () => {
  const saved: ReviewResult[] = [];
  const result = blocking();
  appendReviewResult(saved, result, ['code', 'security']);
  (result.report as { finding: string }).finding = 'mutated';
  assert.deepEqual(saved, [blocking()]);
  assert.throws(() => appendReviewResult(saved, blocking(), ['code', 'security']), /Invalid incremental/);
  assert.throws(() => appendReviewResult([], blocking(), ['code']), /Invalid incremental/);
});

test('batch completion cannot omit, duplicate or downgrade already persisted findings', () => {
  const saved = [blocking()];
  for (const finished of [[], [{ ...blocking(), verdict: 'approved' as const }], [blocking(), blocking()]]) {
    assert.throws(() => reconcileReviewResults(saved, finished), /changed or omitted/);
    assert.deepEqual(saved, [blocking()]);
  }
});

test('identical progress reports reconcile with the complete batch', () => {
  const complete: ReviewResult[] = [{ reviewer: 'code', verdict: 'approved', report: {} }, blocking()];
  assert.deepEqual(reconcileReviewResults([blocking()], complete), complete);
  assert.deepEqual(reconcileReviewResults([], complete), complete);
});
