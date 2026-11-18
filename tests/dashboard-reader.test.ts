import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DashboardReader } from '../src/dashboard-reader.ts';

test('dashboard reader projects state, isolates unavailable runs, and limits events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dashboard-'));
  try {
    const dir = join(root, '.factory', 'runs'); await mkdir(dir, { recursive: true });
    const reader = new DashboardReader(root);
    const task = { id: 'T001', status: 'blocked', lastError: 'blocked', attempts: [
      { number: 1, startedAt: 'a', finishedAt: 'b', outcome: 'implemented', verification: { passed: false, details: { stdout: 'SECRET_OUTPUT' } }, reviews: [{ reviewer: 'code', verdict: 'changes_requested', report: { findings: [{ severity: 'blocking', description: 'fix', evidence: 'evidence', requiredAction: 'repair', prompt: 'SECRET_PROMPT' }] } }], uiEvidence: { artifact: 'SECRET_ARTIFACT' } },
      { number: 2, startedAt: 'a', finishedAt: 'b', outcome: 'blocked', implementationReport: { blockers: [{ kind: 'decision_needed', description: 'choose' }] } },
      { number: 3, startedAt: 'a' }
    ] };
    const state = { version: 1, runId: 'good', repository: root, createdAt: 'a', updatedAt: 'b', status: 'blocked', plan: { prompt: 'SECRET_PROMPT' }, execution: { maxAttempts: 3, configurationFingerprint: 'SECRET_CONFIG' }, tasks: { T001: task }, supersededTasks: [{ supersededAt: 'c', task }], finalVerification: { passed: false, checkedAt: 'c', details: 'SECRET_OUTPUT' } };
    await writeFile(join(dir, 'good.json'), JSON.stringify(state));
    await writeFile(join(dir, 'broken.json'), '{');
    await writeFile(join(dir, 'partial.json'), JSON.stringify({ version: 1, runId: 'partial', tasks: {} }));
    await writeFile(join(dir, 'large.json'), Buffer.alloc(5 * 1024 * 1024 + 1));
    assert.equal((await reader.readRun('missing')).available, false);
    await assert.rejects(reader.readRun('../good'), /Invalid run ID/);
    await assert.rejects(reader.readEvents('../good'), /Invalid run ID/);
    const runs = await reader.listRuns();
    assert.deepEqual(runs.map(r => [r.runId, r.available]), [['broken', false], ['good', true], ['large', false], ['partial', false]]);
    const good = await reader.readRun('good'); assert.ok(good.available);
    assert.equal(good.run.label, 'good');
    assert.equal(good.run.objectiveSummary, undefined);
    assert.deepEqual(good.run.autoReplans, []);
    assert.equal(good.run.tasks[0].attempts[0].flakyCount, 0);
    assert.equal(good.run.tasks[0].title, 'T001');
    assert.equal(good.run.tasks[0].budgetUsed, 1);
    assert.equal(good.run.tasks[0].attempts[0].verification?.passed, false);
    assert.equal(good.run.tasks[0].attempts[0].reviews[0].findings[0].description, 'fix');
    assert.equal(good.run.tasks[0].attempts[1].blockers[0].description, 'choose');
    assert.equal(good.run.supersededTasks[0].task.id, 'T001');
    assert.doesNotMatch(JSON.stringify(good), /SECRET_/);
    const revisions = [
      { at: 'one', taskId: 'T001', reason: 'task_too_large', superseded: ['T001', 4], added: ['T002', null], leftoverPatch: '/secret/leftover.patch' },
      { at: 'two', taskId: 'T002', reason: 'budget_exhausted', superseded: ['T002'], added: ['T003'] },
      { at: 'three', taskId: 'T003', reason: 'invalid', superseded: [], added: [] }
    ];
    const flakyTask = { ...task, attempts: [
      { number: 1, startedAt: 'a', verification: { passed: true, details: { flaky: ['secret command one', 42, 'secret command two'] } } },
      { number: 2, startedAt: 'b', verification: { passed: true, details: { flaky: 'secret command three' } } },
      { number: 3, startedAt: 'c' }
    ] };
    await writeFile(join(dir, 'revisions.json'), JSON.stringify({ ...state, runId: 'revisions', autoReplans: revisions, tasks: { T001: flakyTask } }));
    const revised = await reader.readRun('revisions'); assert.ok(revised.available);
    assert.deepEqual(revised.run.autoReplans, [
      { at: 'one', taskId: 'T001', reason: 'task_too_large', superseded: ['T001'], added: ['T002'], hasLeftoverPatch: true },
      { at: 'two', taskId: 'T002', reason: 'budget_exhausted', superseded: ['T002'], added: ['T003'], hasLeftoverPatch: false }
    ]);
    assert.deepEqual(revised.run.tasks[0].attempts.map(a => a.flakyCount), [2, 0, 0]);
    assert.doesNotMatch(JSON.stringify(revised), /leftover\.patch|secret command/);
    // Even malformed optional fields must not bypass the projection allowlist.
    const malformed = { ...state, runId: 'malformed', execution: { maxAttempts: { prompt: 'SECRET_CONFIG' } }, finalVerification: { passed: true, checkedAt: { artifact: 'SECRET_ARTIFACT' } }, integrations: [{ number: { prompt: 'SECRET_PROMPT' }, status: { artifact: 'SECRET_ARTIFACT' }, error: { stdout: 'SECRET_OUTPUT' }, reviews: [{ reviewer: { prompt: 'SECRET_PROMPT' }, verdict: { artifact: 'SECRET_ARTIFACT' } }] }] };
    await writeFile(join(dir, 'malformed.json'), JSON.stringify(malformed));
    const projectedMalformed = await reader.readRun('malformed');
    assert.ok(projectedMalformed.available);
    assert.doesNotMatch(JSON.stringify(projectedMalformed), /SECRET_/);
    for (const integrations of [[null], 'invalid', [{status:'published'}, null], [{status:'pr-opened'}]]) {
      await writeFile(join(dir, 'optional.json'), JSON.stringify({...state, runId:'optional', status:'completed', integrations}));
      const optional = await reader.readRun('optional'); assert.ok(optional.available);
      assert.equal(optional.run.deliveryStatus, Array.isArray(integrations) && integrations.some(i => i?.status === 'published') ? 'integrated'
        : Array.isArray(integrations) && integrations.some(i => i?.status === 'pr-opened') ? 'pr_opened' : 'awaiting_integration');
    }
    const metadata = { ...state, runId: 'metadata', plan: { objective: `  \n ${'A'.repeat(101)} \n${'B'.repeat(2100)} `, tasks: [{ id: 'other', title: 'Wrong' }, { id: 'T001', title: ` ${'T'.repeat(201)} `, secret: 'SECRET_TITLE' }], secret: 'SECRET_PLAN' } };
    await writeFile(join(dir, 'metadata.json'), JSON.stringify(metadata));
    const projected = await reader.readRun('metadata'); assert.ok(projected.available);
    assert.equal(projected.run.label, 'A'.repeat(99) + '…');
    assert.equal(projected.run.objectiveSummary, metadata.plan.objective.trim().slice(0, 1999) + '…');
    assert.equal(projected.run.tasks[0].title, 'T'.repeat(199) + '…');
    assert.equal(projected.run.supersededTasks[0].task.title, 'T001');
    assert.doesNotMatch(JSON.stringify(projected), /SECRET_/);
    for (const plan of [undefined, null, {}, [], { objective: 42, tasks: 'bad' }, { objective: '  \n ', tasks: [null, { id: 'T001', title: '  ' }, { id: 'other', title: 'wrong' }] }]) {
      await writeFile(join(dir, 'fallback.json'), JSON.stringify({ ...state, runId: 'fallback', plan }));
      const fallback = await reader.readRun('fallback'); assert.ok(fallback.available);
      assert.equal(fallback.run.label, 'fallback');
      assert.equal(fallback.run.objectiveSummary, undefined);
      assert.equal(fallback.run.tasks[0].title, 'T001');
    }
    const lines = Array.from({ length: 2100 }, (_, i) => JSON.stringify({ timestamp: String(i), runId: 'good', type: 'RUN_STARTED', details: { prompt: 'SECRET_PROMPT' } }));
    await writeFile(join(dir, 'good.events.jsonl'), lines.join('\n') + '\n{');
    const events = await reader.readEvents('good');
    assert.equal(events.length, 2000); assert.equal(events[0].timestamp, '100');
    assert.doesNotMatch(JSON.stringify(events), /SECRET_/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
