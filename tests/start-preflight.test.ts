import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

const agents = { planner: { provider: 'test', model: 'test' }, implementer: { provider: 'test', model: 'test' }, reviewer: { provider: 'test', model: 'test' } };
const body = '## What\nSomething\n## Why\nReason\n## Acceptance criteria\n- Works\n## Out of scope\nOther\n## Threat model\nNone\n## Open questions\nNone\n';
const text = `# Example\n\n${body}`;
const hash = createHash('sha256').update(text).digest('hex');
const cli = (args: string[], env = process.env) => spawnSync(process.execPath, ['--experimental-strip-types', resolve('src/factory-cli.ts'), ...args], { encoding: 'utf8', env });

test('approval and configuration gates precede fetching, and local preflight validates every issue', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'start-local-'));
  try {
    const config = join(dir, 'config.json');
    const spec = join(dir, 'spec.md');
    const args = ['start', '--repo', dir, '--config', config, '--spec', spec];
    const noApproval = cli(args);
    assert.equal(noApproval.status, 1);
    assert.match(noApproval.stderr, /--approve/);
    await writeFile(config, JSON.stringify({ agents }));
    assert.match(cli([...args, '--approve']).stderr, /verification/i);
    await writeFile(config, JSON.stringify({ agents, verification: [{ executable: 'test' }], planning: { maxReviewRounds: 0 } }));
    assert.match(cli([...args, '--approve']).stderr, /planning\.maxReviewRounds/);
    await writeFile(config, JSON.stringify({ agents, verification: [{ executable: 'test' }] }));
    await writeFile(spec, '# Invalid\n');
    const invalid = cli([...args, '--approve']);
    assert.equal(invalid.status, 1);
    for (const section of ['What', 'Why', 'Acceptance criteria', 'Out of scope', 'Threat model', 'Open questions']) assert.match(invalid.stdout, new RegExp(`${section}: Section is missing`));
    await writeFile(spec, text);
    const valid = cli([...args, '--approve']);
    assert.equal(valid.status, 1);
    assert.match(valid.stderr, /preflight passed/i);
    const mismatch = cli([...args, '--approve', '--sha256', 'wrong']);
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /wrong/);
    assert.ok(mismatch.stderr.includes(hash));
    const matched = cli([...args, '--approve', '--sha256', hash]);
    assert.equal(matched.status, 1);
    assert.match(matched.stderr, /preflight passed/i);
    await assert.rejects(readFile(join(dir, '.factory', 'runs')), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('GitHub start checks readiness before exact-text consent and never starts execution', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'start-gh-'));
  try {
    const config = join(dir, 'config.json');
    const fixture = join(dir, 'fixture.json');
    const calls = join(dir, 'calls');
    await writeFile(config, JSON.stringify({ agents, verification: [{ executable: 'test' }], specifications: { store: 'github', github: { repository: 'owner/repo', project: { owner: 'owner', number: 1 } } } }));
    await writeFile(join(dir, 'issue'), `const fs=require('node:fs'); fs.appendFileSync(${JSON.stringify(calls)}, 'fetch\\n'); const f=JSON.parse(fs.readFileSync(${JSON.stringify(fixture)},'utf8')); console.log(JSON.stringify(f.issue));`);
    await writeFile(join(dir, 'api'), `const fs=require('node:fs'); fs.appendFileSync(${JSON.stringify(calls)}, 'startable\\n'); const f=JSON.parse(fs.readFileSync(${JSON.stringify(fixture)},'utf8')); console.log(JSON.stringify({data:{repository:{issue:f.state}}}));`);
    if (process.platform === 'win32') await copyFile(process.execPath, join(dir, 'gh.exe'));
    else { await writeFile(join(dir, 'gh'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`); await chmod(join(dir, 'gh'), 0o755); }
    const env = { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ''}` };
    const args = ['start', '--repo', dir, '--config', config, '--spec', '42'];
    const issue = { title: 'Example', body, url: 'https://github.com/owner/repo/issues/42', updatedAt: '2025-01-02T03:04:05Z' };
    const connection = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false } });
    const state = { state: 'OPEN', labels: connection([{ name: 'factory-spec' }]), projectItems: connection([{ project: { number: 1, owner: { login: 'owner' } }, fieldValueByName: { __typename: 'ProjectV2ItemFieldIterationValue', title: 'Current', startDate: '2020-01-01', duration: 100000 } }]) };
    await writeFile(fixture, JSON.stringify({ issue, state }));
    assert.equal(cli(args, env).status, 1);
    await assert.rejects(readFile(calls), { code: 'ENOENT' });
    await writeFile(fixture, JSON.stringify({ issue: { ...issue, body: '' }, state }));
    const invalid = cli([...args, '--approve'], env);
    assert.match(invalid.stdout, /What: Section is missing/);
    assert.equal(await readFile(calls, 'utf8'), 'fetch\n');
    await writeFile(fixture, JSON.stringify({ issue, state: { state: 'CLOSED' } }));
    assert.match(cli([...args, '--approve'], env).stderr, /Issue is not open/);
    await writeFile(fixture, JSON.stringify({ issue, state }));
    const preview = cli([...args, '--approve'], env);
    assert.equal(preview.status, 0, preview.stderr);
    for (const value of ['Example', issue.url, issue.updatedAt, hash, '--sha256', 'Next command']) assert.ok(preview.stdout.includes(value), value);
    const mismatch = cli([...args, '--approve', '--sha256', 'wrong'], env);
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /wrong/);
    assert.ok(mismatch.stderr.includes(hash));
    const matched = cli([...args, '--approve', '--sha256', hash], env);
    assert.equal(matched.status, 1);
    assert.match(matched.stderr, /preflight passed/i);
    await assert.rejects(readFile(join(dir, '.factory', 'runs')), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
