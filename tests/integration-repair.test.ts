import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { configurationFingerprint, fingerprintForRun } from '../src/run-recovery.ts';

test('integration repair budget does not change either fingerprint form', () => {
  const base = { execution: { maxAttempts: 3 }, verification: [{ timeoutMs: 123 }] };
  for (const includeTimeouts of [false, true]) {
    const recorded = configurationFingerprint(base, includeTimeouts);
    for (const budget of [0, 2, 5]) {
      const changed = { ...base, execution: { ...base.execution, maxIntegrationRepairs: budget } };
      assert.equal(configurationFingerprint(changed, includeTimeouts), recorded);
      assert.equal(fingerprintForRun(changed, recorded), recorded);
    }
  }
  assert.notEqual(configurationFingerprint({ other: { maxIntegrationRepairs: 1 } }), configurationFingerprint({ other: { maxIntegrationRepairs: 2 } }));
});

test('config validates integration repair budget and configuration files specify the default', async () => {
  for (const file of ['factory.config.json', 'factory.config.example.json']) {
    const config = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(config.execution.maxIntegrationRepairs, 2);
  }
  const dir = await mkdtemp(join(tmpdir(), 'factory-budget-'));
  try {
    const model = { provider: 'test', model: 'test' };
    const config = { agents: { planner: model, implementer: model, reviewer: model }, pi: { executable: 'unused' }, execution: {} as Record<string, unknown> };
    const file = join(dir, 'config.json');
    const objective = join(dir, 'missing-objective');
    for (const value of [undefined, 0, 2, 5, -1, 6, 1.5, '2', null, true]) {
      if (value === undefined) delete config.execution.maxIntegrationRepairs;
      else config.execution.maxIntegrationRepairs = value;
      await writeFile(file, JSON.stringify(config));
      let error = '';
      try {
        execFileSync(process.execPath, ['--experimental-strip-types', resolve('src/factory-cli.ts'), 'plan', '--repo', dir, '--objective', objective, '--output', join(dir, 'out'), '--config', file], { encoding: 'utf8', stdio: 'pipe' });
        assert.fail('expected plan to fail');
      } catch (caught) {
        error = String((caught as { stderr?: string }).stderr ?? caught);
      }
      if (value === undefined || value === 0 || value === 2 || value === 5) assert.match(error, /missing-objective/);
      else assert.match(error, /execution\.maxIntegrationRepairs/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
