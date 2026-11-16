import test from 'node:test';
import assert from 'node:assert/strict';
import { selectVerification } from '../src/verification-selector.ts';
import type { GitChangeEvidence } from '../src/git-change-evidence.ts';
import type { SelectionConfig } from '../src/selection-config.ts';

const commands = [{ executable: 'first' }, { executable: 'second' }, { executable: 'third' }];
const config: SelectionConfig = {
  rules: [{ path: 'src', commands: [2, 0] }, { path: 'docs', commands: [1, 2] }],
  dependencyPaths: ['src/verify', 'scripts/check', '.eslintrc', '.eslintrc.js', '.eslintrc.json'],
  dependenciesComprehensive: true,
};
const evidence = (...paths: string[]): GitChangeEvidence => ({
  suitable: true, reasons: [], changes: paths.map(path => ({ path, status: 'M', source: 'unstaged' })),
});

test('selects the union in configured order and preserves evidence', () => {
  const changes = evidence('src/app.ts', 'docs/guide.md', 'src/other.ts');
  const result = selectVerification(commands, config, changes);
  assert.equal(result.mode, 'selected');
  assert.deepEqual(result.commands, commands);
  assert.deepEqual(result.evidence, changes);
  assert.equal(result.reasons.length, 3);
  assert.deepEqual(selectVerification(commands, config, evidence('src/app.ts')).commands, [commands[0], commands[2]]);
});

test('declared dependencies override mappings, including directory entrypoints and legacy ESLint paths', () => {
  for (const path of ['src/verify', 'src/verify/index.ts', 'scripts/check', 'scripts/check/index.js', '.eslintrc', '.eslintrc.js', '.eslintrc.json']) {
    const result = selectVerification(commands, config, evidence(path));
    assert.equal(result.mode, 'full', path);
    assert.deepEqual(result.commands, commands);
    assert.match(result.reasons[0], /dependency/);
  }
  assert.equal(selectVerification(commands, config, evidence('src/verify-extra/index.ts')).mode, 'selected');
});

test('unknown paths and incomplete or invalid declarations fall back', () => {
  for (const selection of [undefined, { ...config, dependenciesComprehensive: false }, { rules: config.rules }, { ...config, dependencyPaths: undefined }]) {
    assert.equal(selectVerification(commands, selection, evidence('src/a')).mode, 'full');
  }
  for (const path of ['unknown', 'src-extra/a']) {
    const result = selectVerification(commands, config, evidence('src/a', path));
    assert.equal(result.mode, 'full');
    assert.deepEqual(result.commands, commands);
    assert.match(result.reasons[0], /No verification mapping/);
  }
});

test('unsuitable, empty and inconsistent evidence falls back', () => {
  const cases: GitChangeEvidence[] = [
    { suitable: false, changes: evidence('src/a').changes, reasons: ['Git failed'] },
    evidence(),
    { ...evidence('src/a'), reasons: ['incomplete'] },
    { suitable: true, reasons: [], changes: [{ path: 'src/a', status: 'D', source: 'staged' }] },
    { suitable: true, reasons: [], changes: [{ path: 'src/a', status: 'R', source: 'committed', previousPath: 'src/b' }] },
    evidence('src/../unknown'),
  ];
  for (const changes of cases) {
    const result = selectVerification(commands, config, changes);
    assert.equal(result.mode, 'full');
    assert.deepEqual(result.commands, commands);
    assert.deepEqual(result.evidence, changes);
    assert.ok(result.reasons.length);
  }
});
