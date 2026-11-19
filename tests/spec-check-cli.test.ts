import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const cli = (...args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', resolve('src/factory-cli.ts'), ...args], { encoding: 'utf8' });

test('spec check validates files and reports every issue', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec-check-'));
  try {
    const file = join(dir, 'draft.md');
    await writeFile(file, '# Example\n\n## What\nSomething\n## Why\nReason\n## Acceptance criteria\n- Works\n## Out of scope\nOther\n## Threat model\nNone\n## Open questions\nNone\n');
    const valid = cli('spec', 'check', '--spec', file);
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(valid.stdout.trim(), 'Specification is valid.');
    await writeFile(file, '# Example\n## What\nSomething\n');
    const invalid = cli('spec', 'check', '--spec', file);
    assert.equal(invalid.status, 1);
    for (const section of ['Why', 'Acceptance criteria', 'Out of scope', 'Threat model', 'Open questions']) {
      assert.ok(invalid.stdout.includes(`${section}: Section is missing.`), invalid.stdout);
    }
    assert.equal(cli('spec', 'check').status, 1);
    assert.equal(cli('spec', 'check', '--spec', join(dir, 'missing')).status, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('spec subcommands and help', () => {
  for (const args of [['spec'], ['spec', 'unknown']]) {
    const result = cli(...args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown spec command/);
  }
  const help = cli('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /pi-factory spec check --spec FILE/);
  assert.match(help.stdout, /pi-factory spec publish --repo PATH/);
});
