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
    assert.equal(good.run.tasks[0].budgetUsed, 1);
    assert.equal(good.run.tasks[0].attempts[0].verification?.passed, false);
    assert.equal(good.run.tasks[0].attempts[0].reviews[0].findings[0].description, 'fix');
    assert.equal(good.run.tasks[0].attempts[1].blockers[0].description, 'choose');
    assert.equal(good.run.supersededTasks[0].task.id, 'T001');
    assert.doesNotMatch(JSON.stringify(good), /SECRET_/);
    // Even malformed optional fields must not bypass the projection allowlist.
    const malformed = { ...state, runId: 'malformed', execution: { maxAttempts: { prompt: 'SECRET_CONFIG' } }, finalVerification: { passed: true, checkedAt: { artifact: 'SECRET_ARTIFACT' } }, integrations: [{ number: { prompt: 'SECRET_PROMPT' }, status: { artifact: 'SECRET_ARTIFACT' }, error: { stdout: 'SECRET_OUTPUT' }, reviews: [{ reviewer: { prompt: 'SECRET_PROMPT' }, verdict: { artifact: 'SECRET_ARTIFACT' } }] }] };
    await writeFile(join(dir, 'malformed.json'), JSON.stringify(malformed));
    const projectedMalformed = await reader.readRun('malformed');
    assert.ok(projectedMalformed.available);
    assert.doesNotMatch(JSON.stringify(projectedMalformed), /SECRET_/);
    const lines = Array.from({ length: 2100 }, (_, i) => JSON.stringify({ timestamp: String(i), runId: 'good', type: 'RUN_STARTED', details: { prompt: 'SECRET_PROMPT' } }));
    await writeFile(join(dir, 'good.events.jsonl'), lines.join('\n') + '\n{');
    const events = await reader.readEvents('good');
    assert.equal(events.length, 2000); assert.equal(events[0].timestamp, '100');
    assert.doesNotMatch(JSON.stringify(events), /SECRET_/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
