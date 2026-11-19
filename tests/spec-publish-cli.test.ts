import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

const cli = (...args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', resolve('src/factory-cli.ts'), ...args], { encoding: 'utf8' });
const valid = '# Example specification\n\n## What\nSomething\n## Why\nReason\n## Acceptance criteria\n- Works\n## Out of scope\nOther\n## Threat model\nNone\n## Open questions\nNone\n## Impact analysis\nNone\n';
const agents = { planner: { provider: 'test', model: 'test' }, implementer: { provider: 'test', model: 'test' }, reviewer: { provider: 'test', model: 'test' } };

test('publish requires approval, rejects structural errors, and saves exact text with a reference', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec-publish-'));
  try {
    const draft = join(dir, 'draft.md');
    const config = join(dir, 'config.json');
    await writeFile(config, JSON.stringify({ agents, specifications: { local: { directory: 'published' } } }));
    await writeFile(draft, valid);
    const args = ['spec', 'publish', '--repo', dir, '--config', config, '--spec', draft];
    assert.equal(cli(...args).status, 1);
    assert.equal(cli(...args, '--approve=false').status, 1);
    await assert.rejects(readdir(join(dir, 'published')), { code: 'ENOENT' });
    await writeFile(draft, valid.replace('## What\nSomething\n', ''));
    const invalid = cli(...args, '--approve');
    assert.equal(invalid.status, 1);
    assert.match(invalid.stdout, /What: Section is missing/);
    await assert.rejects(readdir(join(dir, 'published')), { code: 'ENOENT' });
    await writeFile(draft, valid);
    const result = cli(...args, '--approve');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /published[\\/]example-specification\.md/);
    assert.equal(result.stderr, '');
    assert.equal(await readFile(join(dir, 'published', 'example-specification.md'), 'utf8'), valid);
    assert.equal(cli(...args, '--approve').status, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('readiness exceptions warn independently, but empty or duplicate questions remain invalid', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec-publish-warn-'));
  try {
    const draft = join(dir, 'draft.md');
    const config = join(dir, 'config.json');
    await writeFile(config, JSON.stringify({ agents }));
    const args = ['spec', 'publish', '--repo', dir, '--config', config, '--spec', draft, '--approve'];
    await writeFile(draft, valid.replace('## Open questions\nNone', '## Open questions\nStill deciding'));
    const questions = cli(...args);
    assert.equal(questions.status, 0, questions.stderr);
    assert.match(questions.stderr, /Warning: Open questions/);
    assert.doesNotMatch(questions.stderr, /Impact analysis/);
    await writeFile(draft, valid.replace('# Example specification', '# Other').replace('## Impact analysis\nNone\n', ''));
    const impact = cli(...args);
    assert.equal(impact.status, 0, impact.stderr);
    assert.match(impact.stderr, /Warning: Impact analysis/);
    assert.doesNotMatch(impact.stderr, /Open questions/);
    for (const replacement of ['## Open questions\n', '## Open questions\nNone\n## Open questions\nPending\n']) {
      await writeFile(draft, valid.replace('## Open questions\nNone\n', replacement));
      const result = cli(...args);
      assert.equal(result.status, 1);
      assert.match(result.stdout, /Open questions:/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('approved GitHub publication creates an issue and prints its number and URL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec-publish-gh-'));
  try {
    const draft = join(dir, 'draft.md');
    const config = join(dir, 'config.json');
    const calls = join(dir, 'calls.json');
    // The shell-free runner executes Node as gh; the first argument is this local script.
    await writeFile(join(dir, 'issue'), `const fs = require('node:fs');\nlet input = '';\nprocess.stdin.setEncoding('utf8');\nprocess.stdin.on('data', chunk => input += chunk);\nprocess.stdin.on('end', () => { fs.writeFileSync(${JSON.stringify(calls)}, JSON.stringify({ args: process.argv.slice(2), input })); console.log('https://github.com/owner/repo/issues/42'); });\n`);
    if (process.platform === 'win32') await copyFile(process.execPath, join(dir, 'gh.exe'));
    else {
      await writeFile(join(dir, 'gh'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
      await chmod(join(dir, 'gh'), 0o755);
    }
    await writeFile(draft, valid);
    await writeFile(config, JSON.stringify({ agents, specifications: { store: 'github', github: { repository: 'owner/repo', project: { owner: 'owner', number: 1 } } } }));
    const args = ['spec', 'publish', '--repo', dir, '--config', config, '--spec', draft];
    const run = (...extra: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', resolve('src/factory-cli.ts'), ...args, ...extra], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ''}` } });
    assert.equal(run().status, 1);
    await assert.rejects(readFile(calls), { code: 'ENOENT' });
    const result = run('--approve');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Specification published: 42 https:\/\/github\.com\/owner\/repo\/issues\/42/);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(await readFile(calls, 'utf8')), {
      args: ['create', '--repo', 'owner/repo', '--title', 'Example specification', '--label', 'factory-spec', '--body-file', '-'],
      input: valid.replace('# Example specification\n\n', '').trim(),
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('GitHub publication requires a configured repository or valid origin', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec-publish-github-'));
  try {
    const draft = join(dir, 'draft.md');
    const config = join(dir, 'config.json');
    await writeFile(draft, valid);
    await writeFile(config, JSON.stringify({ agents, specifications: { store: 'github', github: { project: { owner: 'owner', number: 1 } } } }));
    const result = cli('spec', 'publish', '--repo', dir, '--config', config, '--spec', draft, '--approve');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /specifications\.github\.repository/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
