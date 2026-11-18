import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAttemptFeedback, extractFailures, boundOutput } from '../src/attempt-feedback.ts';
import type { AttemptRecord } from '../src/state-store.ts';

const finding = (description: string, severity = 'blocking') => ({ severity, file: 'src/a.ts', line: 3, description, evidence: 'seen', requiredAction: 'fix it' });
const review = (reviewer: string, verdict: 'approved' | 'changes_requested' | 'blocked', findings: unknown[] = []) =>
  ({ reviewer, verdict, report: { taskId: 'T001', reviewer, verdict, summary: `${reviewer} summary`, findings, limitations: [] } });
const attempt = (number: number, extra: Partial<AttemptRecord>): AttemptRecord =>
  ({ number, startedAt: 'x', finishedAt: 'y', phase: 'finished', outcome: 'implemented', ...extra });

test('no previous attempts produce no feedback', () => {
  assert.equal(buildAttemptFeedback([]), undefined);
});

test('open items come from the latest attempt only; earlier blocking findings must stay fixed', () => {
  const feedback = buildAttemptFeedback([
    attempt(1, { verification: { passed: true, details: { checks: [{ command: 'test', passed: true, stdout: 'NOISE_A', stderr: '' }] } },
      reviews: [review('code', 'changes_requested', [finding('OLD_FINDING'), finding('OLD_ADVISORY', 'advisory')]), review('ui', 'approved')] }),
    attempt(2, { verification: { passed: true, details: { checks: [{ command: 'test', passed: true, stdout: 'NOISE_B', stderr: '' }] } },
      reviews: [review('code', 'approved'), review('ui', 'changes_requested', [finding('NEW_FINDING'), finding('NEW_ADVISORY', 'advisory')])] })
  ])!;
  assert.equal(feedback.open.attempt, 2);
  assert.deepEqual(feedback.open.findings.map(f => [f.reviewer, f.description]), [['ui', 'NEW_FINDING']]);
  assert.deepEqual(feedback.mustStayFixed.map(f => [f.reviewer, f.attempt, f.description]), [['code', 1, 'OLD_FINDING']]);
  assert.equal(feedback.open.findings[0].requiredAction, 'fix it');
  assert.equal(feedback.history.length, 2);
  assert.match(feedback.history[0].result, /code: changes_requested/);
  const text = JSON.stringify(feedback);
  assert.doesNotMatch(text, /NOISE_|ADVISORY/);
});

test('failed verification reports failing commands, extracted failures and log file, not passing output', () => {
  const stdout = `ok 1 - fine\nnot ok 2 - breaks on empty input\n  ---\n  error: 'boom'\n${'x'.repeat(50)}\n`;
  const feedback = buildAttemptFeedback([attempt(1, { verification: { passed: false, details: { checks: [
    { command: 'tsc', passed: true, stdout: 'PASSING_OUTPUT', stderr: '' },
    { command: 'node --test', passed: false, stdout, stderr: '', failures: ['not ok 2 - breaks on empty input'], logFile: '/logs/T001-1-1.log' }
  ] } } })])!;
  assert.equal(feedback.open.reason, 'Deterministic verification failed');
  assert.equal(feedback.open.failedChecks.length, 1);
  assert.deepEqual(feedback.open.failedChecks[0].failures, ['not ok 2 - breaks on empty input']);
  assert.equal(feedback.open.failedChecks[0].logFile, '/logs/T001-1-1.log');
  assert.match(feedback.open.failedChecks[0].excerpt, /boom/);
  assert.doesNotMatch(JSON.stringify(feedback), /PASSING_OUTPUT/);
});

test('legacy checks without extracted failures are extracted on demand', () => {
  const feedback = buildAttemptFeedback([attempt(1, { verification: { passed: false, details: { checks: [
    { command: 'tsc', passed: false, stdout: 'src/a.ts(1,2): error TS2322: bad type', stderr: '' }] } } })])!;
  assert.deepEqual(feedback.open.failedChecks[0].failures, ['src/a.ts(1,2): error TS2322: bad type']);
});

test('infrastructure errors after a rejected attempt keep the rejected findings open', () => {
  const feedback = buildAttemptFeedback([
    attempt(1, { reviews: [review('code', 'changes_requested', [finding('STILL_OPEN')])], verification: { passed: true, details: {} } }),
    attempt(2, { outcome: 'error', infraRetry: { role: 'reviewer', error: 'reviewer: timeout' } })
  ])!;
  assert.equal(feedback.open.attempt, 1);
  assert.deepEqual(feedback.open.findings.map(f => f.description), ['STILL_OPEN']);
  assert.ok(feedback.notes.some(note => /Attempt 2: reviewer process failed/.test(note) && /Inspect the worktree/.test(note)));
});

test('findings stay open until a later review has judged them', () => {
  // Attempt 2 never reached review, so nobody confirmed that attempt 1's finding was fixed.
  const feedback = buildAttemptFeedback([
    attempt(1, { verification: { passed: true, details: {} }, reviews: [review('code', 'changes_requested', [finding('UNCONFIRMED_FIX')])] }),
    attempt(2, { verification: { passed: false, details: { checks: [{ command: 'test', passed: false, stdout: 'not ok 1 - broke', stderr: '' }] } } })
  ])!;
  assert.equal(feedback.open.attempt, 2);
  assert.equal(feedback.open.reason, 'Deterministic verification failed');
  assert.deepEqual(feedback.open.failedChecks[0].failures, ['not ok 1 - broke']);
  assert.deepEqual(feedback.open.findings.map(f => [f.attempt, f.description]), [[1, 'UNCONFIRMED_FIX']]);
  assert.deepEqual(feedback.mustStayFixed, []);
});

test('blocked, failed and UI evidence results are open items', () => {
  const blocked = buildAttemptFeedback([attempt(1, { outcome: 'blocked', implementationReport: { summary: 'stuck', blockers: [{ kind: 'decision_needed', description: 'Need policy', question: 'Which?' }] } })])!;
  assert.deepEqual(blocked.open.blockers, [{ kind: 'decision_needed', description: 'Need policy', question: 'Which?' }]);
  assert.equal(blocked.open.implementerSummary, 'stuck');
  const ui = buildAttemptFeedback([attempt(1, { verification: { passed: true, details: {} },
    uiEvidence: { passed: false, directory: 'd', artifacts: [], issues: ['UI evidence contains failed checks'],
      manifest: { checks: [{ kind: 'interaction', name: 'opens dialog', status: 'failed', details: 'no dialog' }, { kind: 'accessibility', name: 'names', status: 'passed' }] } as never } })])!;
  assert.deepEqual(ui.open.uiEvidenceIssues, ['UI evidence contains failed checks', 'Failed interaction check "opens dialog": no dialog']);
});

test('extractFailures finds test, compiler and build failures, deduplicated and bounded', () => {
  const output = ['ok 1 - a', 'not ok 2 - b', '✖ renders title (12ms)', 'src/x.ts(4,1): error TS1005: expected', 'Foo.cs(10,5): error CS0103: missing', 'not ok 2 - b',
    ...Array.from({ length: 100 }, (_, i) => `not ok ${i + 10} - many`)].join('\n');
  const failures = extractFailures(output);
  assert.deepEqual(failures.slice(0, 4), ['not ok 2 - b', '✖ renders title (12ms)', 'src/x.ts(4,1): error TS1005: expected', 'Foo.cs(10,5): error CS0103: missing']);
  assert.equal(failures.length, 40);
});

test('boundOutput keeps head and tail of long output', () => {
  assert.equal(boundOutput('short', 100), 'short');
  const bounded = boundOutput(`HEAD${'x'.repeat(5000)}TAIL`, 1000);
  assert.ok(bounded.startsWith('HEAD') && bounded.endsWith('TAIL') && bounded.length < 1100);
  assert.match(bounded, /\[\d+ characters omitted\]/);
});
