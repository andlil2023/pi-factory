import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ContractValidator } from '../../src/contract-validator.ts';
import { collectUiEvidence, assertUiEvidenceCurrent } from '../../src/ui-evidence.ts';
import { dashboardImageLinks } from '../browser-evidence/collect-dashboard.ts';

test('dashboard link capability requires the exact opt-in', () => {
  for (const value of [undefined, '', '0', 'true']) assert.deepEqual(dashboardImageLinks(value), {});
  assert.ok('imageLinks' in dashboardImageLinks('1'));
});

test('real browser collector validates and leaves its owned resources closed', { timeout: 200000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dashboard-evidence-test-'));
  try {
    const repository = resolve('.');
    const record = await collectUiEvidence({ directory, syntheticDeveloperReviewAuthorized: true, command: { executable: process.execPath, args: ['--experimental-strip-types', 'tests/browser-evidence/collect-dashboard.ts'], timeoutMs: 180000 } }, { repository, taskId: 'T001', attempt: 1 }, new ContractValidator(resolve('contracts')));
    assert.equal(record.passed, true, record.issues.join('\n'));
    await assertUiEvidenceCurrent(record, repository);
    assert.equal(record.artifacts.length, 6);
    assert.equal(record.syntheticDeveloperReviewAuthorized, true);
    assert.deepEqual(record.manifest?.imageLinks, [{ checkName: 'Keyboard selection, disclosure, refresh and focus restoration; persisted task, check and phase', screenshotPath: 'dashboard-1440.png', caption: 'Synthetic dashboard after keyboard interaction' }]);
    assert.equal(record.artifacts.filter(a => a.imageType === 'image/png').length, 3);
    assert.match(record.artifacts[0].sha256, /^[a-f0-9]{64}$/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('real dashboard collector emits a legacy-schema manifest without host opt-in', { timeout: 200000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dashboard-legacy-test-'));
  try {
    const output = join(directory, 'output');
    const contracts = join(directory, 'contracts');
    await mkdir(output); await mkdir(contracts);
    await copyFile(resolve('tests/fixtures/ui-evidence-legacy.schema.json'), join(contracts, 'ui-evidence.schema.json'));
    const env: NodeJS.ProcessEnv = { ...process.env, FACTORY_UI_EVIDENCE_DIRECTORY: output, FACTORY_TASK_ID: 'T001', FACTORY_ATTEMPT: '1', FACTORY_SOURCE_FINGERPRINT: 'a'.repeat(64) };
    delete env.FACTORY_UI_EVIDENCE_IMAGE_LINKS;
    await promisify(execFileCallback)(process.execPath, ['--experimental-strip-types', 'tests/browser-evidence/collect-dashboard.ts'], { cwd: resolve('.'), env, timeout: 180000 });
    const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
    assert.equal(Object.hasOwn(manifest, 'imageLinks'), false);
    const validator = new ContractValidator(contracts);
    const legacy = await validator.validate('ui-evidence', manifest);
    assert.equal(legacy.valid, true, JSON.stringify(legacy.issues));
    const unsupported = await validator.validate('ui-evidence', { ...manifest, ...dashboardImageLinks('1') });
    assert.equal(unsupported.valid, false);
    assert.match(JSON.stringify(unsupported.issues), /imageLinks/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
