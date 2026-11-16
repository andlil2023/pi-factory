import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { validateSelectionConfig } from '../src/selection-config.ts';
import { configurationFingerprint } from '../src/run-recovery.ts';

const verification = [{ executable: 'npm', args: ['test'] }, { executable: 'npm', args: ['run', 'check'] }];
const selection = { rules: [{ path: 'src', commands: [0, 1] }, { path: 'README.md', commands: [1] }] };

test('valid selection uses configured command indexes and participates in the configuration fingerprint', () => {
  validateSelectionConfig(selection, verification);
  const base = { verification };
  assert.notEqual(configurationFingerprint(base), configurationFingerprint({ ...base, verificationSelection: selection }));
  assert.notEqual(configurationFingerprint({ ...base, verificationSelection: selection }), configurationFingerprint({ ...base, verificationSelection: { rules: [{ path: 'src', commands: [0] }] } }));
  assert.equal(configurationFingerprint(base), configurationFingerprint({ verification }));
});

test('rejects malformed rules, ambiguous mappings and invalid command references', () => {
  const invalid: unknown[] = [null, {}, { rules: [] }, { rules: [], extra: true },
    ...['', '/src', 'src/', 'src//x', '.', 'a/../b', 'a/./b', 'C:/src', 'src\\x', 'src/*', ' src', 'x\n'].map(path => ({ rules: [{ path, commands: [0] }] })),
    { rules: [{ path: 'src', commands: [0] }, { path: 'src', commands: [1] }] },
    { rules: [{ path: 'src', commands: [0] }, { path: 'src/a', commands: [1] }] },
    ...[[], [-1], [2], [0.5], ['0'], [0, 0], null].map(commands => ({ rules: [{ path: 'src', commands }] })),
    { rules: [{ path: 'src', commands: [0], extra: true }] }];
  for (const value of invalid) assert.throws(() => validateSelectionConfig(value, verification), /Invalid verificationSelection/, JSON.stringify(value));
  for (const commands of [undefined, [], [{ executable: '' }], [{ executable: 'npm', args: [1] }], [verification[0], verification[0]]]) {
    assert.throws(() => validateSelectionConfig(selection, commands), /Invalid verificationSelection/);
  }
});

test('dependency declarations are optional, validated, and fingerprinted', () => {
  const base = { verification, verificationSelection: selection };
  const declarations = [
    { dependencyPaths: [] },
    { dependencyPaths: ['package.json', 'scripts/verification'], dependenciesComprehensive: false },
    { dependencyPaths: [], dependenciesComprehensive: true },
    { dependencyPaths: ['package.json', 'scripts/verification'], dependenciesComprehensive: true },
  ];
  for (const declaration of declarations) {
    const config = { ...base, verificationSelection: { ...selection, ...declaration } };
    validateSelectionConfig(config.verificationSelection, verification);
    assert.notEqual(configurationFingerprint(base), configurationFingerprint(config));
  }
  assert.notEqual(configurationFingerprint({ ...base, verificationSelection: { ...selection, ...declarations[1] } }),
    configurationFingerprint({ ...base, verificationSelection: { ...selection, ...declarations[3] } }));
  const invalid: unknown[] = [
    ...['', '/src', 'src/', 'src//x', '.', 'a/../b', 'a/./b', 'C:/src', 'src\\x', 'src/*', ' src', 'x\n', 1].map(path => ({ dependencyPaths: [path] })),
    { dependencyPaths: null }, { dependencyPaths: 'src' }, { dependencyPaths: ['src', 'src'] },
    ...[null, 'true', 1, {}, []].map(dependenciesComprehensive => ({ dependenciesComprehensive })),
    { dependenciesComprehensive: true },
  ];
  for (const declaration of invalid) {
    assert.throws(() => validateSelectionConfig({ ...selection, ...declaration as object }, verification), /Invalid verificationSelection/, JSON.stringify(declaration));
  }
});

test('CLI rejects invalid selection before creating a worktree or executing commands', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-selection-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, 'config.json');
  const model = { provider: 'fixture', model: 'fixture' };
  await writeFile(config, JSON.stringify({ agents: { planner: model, implementer: model, reviewer: model }, verification, verificationSelection: { rules: [{ path: '../escape', commands: [0] }] } }));
  const run = () => spawnSync(process.execPath, ['--experimental-strip-types', resolve('src/factory-cli.ts'), 'run', '--repo', dir, '--plan', join(dir, 'missing.json'), '--approve', '--config', config], { encoding: 'utf8' });
  let result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid verificationSelection/);
  for (const declaration of [{ dependencyPaths: ['../escape'] }, { dependenciesComprehensive: 'true' }, { dependenciesComprehensive: true }]) {
    await writeFile(config, JSON.stringify({ agents: { planner: model, implementer: model, reviewer: model }, verification, verificationSelection: { ...selection, ...declaration } }));
    result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid verificationSelection/);
  }
});
