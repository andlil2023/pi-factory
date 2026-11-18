import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ContractValidator } from '../../src/contract-validator.ts';
import { collectUiEvidence, assertUiEvidenceCurrent } from '../../src/ui-evidence.ts';

test('real browser collector validates and leaves its owned resources closed', { timeout: 200000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dashboard-evidence-test-'));
  try {
    const repository = resolve('.');
    const record = await collectUiEvidence({ directory, command: { executable: process.execPath, args: ['--experimental-strip-types', 'tests/browser-evidence/collect-dashboard.ts'], timeoutMs: 180000 } }, { repository, taskId: 'T001', attempt: 1 }, new ContractValidator(resolve('contracts')));
    assert.equal(record.passed, true, record.issues.join('\n'));
    await assertUiEvidenceCurrent(record, repository);
    assert.equal(record.artifacts.length, 6);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
