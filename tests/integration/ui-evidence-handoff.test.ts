import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createAgentAdapters } from '../../src/agent-adapters.ts';
import { Orchestrator, type PlannedTask } from '../../src/orchestrator.ts';
import { StateStore } from '../../src/state-store.ts';

const task: PlannedTask = { id: 'T001', title: 'UI', objective: 'Change UI', scope: 'UI', acceptanceCriteria: ['Works'], dependencies: [], verification: ['test'] };
const model = { provider: 'test', model: 'test' };

for (const mode of ['passed', 'missing-manifest', 'stale', 'failed-check', 'tamper-before', 'source-before', 'tamper-after'] as const) {
  test(`real evidence handoff: ${mode}`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'factory-ui-handoff-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const repository = join(dir, 'repo');
    await mkdir(repository);
    execFileSync('git', ['init', '-q'], { cwd: repository });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'initial'], { cwd: repository });
    const store = new StateStore(join(dir, 'state'));
    const state = await store.create(repository, {}, [task.id], 'handoff');
    const adapters = createAgentAdapters({ repository, factoryRoot: resolve('.'), baselineCommit: 'HEAD',
      piExecutable: process.execPath, piExecutableArgs: [resolve('tests/fixtures/fake-reviewer.mjs')],
      implementer: model, reviewer: model, reviewers: { ui: model }, verification: [],
      uiEvidence: { directory: join(dir, 'evidence'), command: { executable: process.execPath,
        args: [resolve('tests/fixtures/fake-ui-collector.mjs'), ['missing-manifest', 'stale', 'failed-check'].includes(mode) ? mode : 'passed'] } } });
    let uiCalled = false;
    let checkpointed = false;
    const result = await new Orchestrator(store, {
      ...adapters,
      implement: async () => ({ outcome: 'implemented', report: {} }),
      verify: async () => ({ passed: true, details: {} }),
      selectReviewers: async () => ({ requiredReviewers: ['code', 'ui'], changedFiles: [], reasons: [] }),
      review: async (context, implementation, verification, onReview) => adapters.review(context, implementation, verification, async review => {
        if (review.reviewer === 'ui') {
          uiCalled = true;
          const report = review.report as { summary: string };
          const prompt = (JSON.parse(report.summary) as { prompt: string }).prompt;
          const evidence = context.uiEvidence!;
          assert.equal(evidence.passed, true);
          assert.equal(evidence.manifest?.taskId, task.id);
          assert.equal(evidence.manifest?.attempt, context.attempt);
          for (const artifact of evidence.artifacts) {
            assert.ok(isAbsolute(artifact.path));
            assert.ok(prompt.includes(JSON.stringify(artifact.path).slice(1, -1)));
          }
        }
        if (review.reviewer === 'code' && mode === 'tamper-before' || review.reviewer === 'ui' && mode === 'tamper-after') {
          await writeFile(context.uiEvidence!.artifacts[0].path, 'tampered');
        }
        if (review.reviewer === 'code' && mode === 'source-before') await writeFile(join(repository, 'source.txt'), 'changed');
        await onReview?.(review);
      }),
      checkpoint: async () => { checkpointed = true; return { commit: 'accepted' }; }
    }, { requiredReviewers: ['code', 'ui'] }).execute(state, [task]);
    assert.equal(result.status, mode === 'passed' ? 'completed' : 'blocked');
    assert.equal(checkpointed, mode === 'passed');
    assert.equal(uiCalled, mode === 'passed' || mode === 'tamper-after');
    if (mode !== 'passed') {
      const expected = mode === 'missing-manifest' ? /ENOENT/ : mode === 'stale' ? /timestamp/ : mode === 'failed-check' ? /failed checks/ : mode === 'source-before' ? /stale/ : /artifact changed/;
      assert.match(result.tasks.T001.lastError!, expected);
    }
  });
}
