import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync, type spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpecificationStore } from '../src/spec-store.ts';
import { GitHubSpecificationStore, ghRunner, type GhRunner } from '../src/spec-store-github.ts';

const project = { owner: 'org', number: 7 };

test('gh runner uses shell-free argument array and writes stdin', async () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
  let stdin = '';
  child.stdin.on('data', chunk => { stdin += chunk.toString(); });
  const fakeSpawn = ((executable: string, args: string[], options: Record<string, unknown>) => {
    assert.equal(executable, 'gh');
    assert.deepEqual(args, ['issue', 'create', '--title', 'a; echo unsafe']);
    assert.equal(options.shell, false);
    assert.equal(options.cwd, 'repo');
    queueMicrotask(() => { child.stdout.write('result\n'); child.emit('close', 0); });
    return child;
  }) as unknown as typeof spawn;
  assert.equal(await ghRunner('repo', fakeSpawn)(['issue', 'create', '--title', 'a; echo unsafe'], 'body'), 'result');
  assert.equal(stdin, 'body');
});

test('builder applies configured settings and defaults; save passes body via stdin once', async () => {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const gh: GhRunner = async (args, input) => { calls.push({ args, input }); return 'https://github.com/owner/repo/issues/12'; };
  const store = await createSpecificationStore({ store: 'github', github: { repository: 'owner/repo', project } }, '.', gh) as GitHubSpecificationStore;
  assert.equal(store.kind, 'github');
  assert.equal(store.options.label, 'factory-spec');
  assert.deepEqual(store.options.project, { ...project, iterationField: 'Iteration' });
  assert.deepEqual(await store.save('Calc', '# Calc\n\n## What\nX\n'), { id: '12', url: 'https://github.com/owner/repo/issues/12' });
  assert.deepEqual(calls, [{ args: ['issue', 'create', '--repo', 'owner/repo', '--title', 'Calc', '--label', 'factory-spec', '--body-file', '-'], input: '## What\nX' }]);
  const custom = await createSpecificationStore({ store: 'github', github: { repository: 'owner/repo', label: 'custom', project: { ...project, iterationField: 'Sprint' } } }, '.', gh) as GitHubSpecificationStore;
  assert.equal(custom.options.label, 'custom');
  assert.equal(custom.options.project.iterationField, 'Sprint');
  await custom.save('Real', '```\n# example\n```\n# Real\n\nBody\n');
  assert.equal(calls[1].input, '```\n# example\n```\n\nBody');
  assert.equal((await custom.startable('12')).ok, false);
});

test('only matching issue URLs are accepted; errors are concise and missing labels include guidance', async () => {
  let output = '';
  const store = new GitHubSpecificationStore({ repository: 'owner/repo', label: 'factory-spec', project: { ...project, iterationField: 'Iteration' }, gh: async () => output });
  for (output of ['https://github.com/other/repo/issues/12', 'https://github.com/owner/repo/pull/12', 'https://github.com/owner/repo/issues/12/x', 'https://github.com/owner/repo/issues/0']) {
    await assert.rejects(store.save('x', '# x'), /unexpected issue URL/);
  }
  const failing = new GitHubSpecificationStore({ ...store.options, gh: async () => { throw new Error("command failed\ncould not add label: 'factory-spec' not found\n"); } });
  await assert.rejects(failing.save('x', '# x'), (error: Error) => {
    assert.equal(error.message, `could not add label: 'factory-spec' not found Create the label "factory-spec" in owner/repo first.`);
    return true;
  });
});

test('fetch reconstructs a specification without requesting comments or an editor', async () => {
  const calls: string[][] = [];
  const store = new GitHubSpecificationStore({ repository: 'owner/repo', label: 'spec', project: { ...project, iterationField: 'Iteration' }, gh: async args => {
    calls.push(args);
    return JSON.stringify({ title: 'Example', body: '## Details\r\nBody\r\n', url: 'https://github.com/owner/repo/issues/42', updatedAt: '2025-01-02T03:04:05Z', comments: [{ body: 'ignored' }], lastEditor: 'ignored' });
  } });
  assert.deepEqual(await store.fetch('42'), { id: '42', title: 'Example', text: '# Example\n\n## Details\nBody\n', url: 'https://github.com/owner/repo/issues/42', updatedAt: '2025-01-02T03:04:05Z' });
  assert.deepEqual(calls, [['issue', 'view', '42', '--repo', 'owner/repo', '--json', 'title,body,url,updatedAt']]);
});

test('fetch rejects invalid ids before invoking gh', async () => {
  let calls = 0;
  const store = new GitHubSpecificationStore({ repository: 'owner/repo', label: 'spec', project: { ...project, iterationField: 'Iteration' }, gh: async () => { calls++; return ''; } });
  for (const id of ['', '0', '000', '-1', '+1', '1.2', ' 1', '1e2', '１２', '42\n', '42\r', '42\r\n']) await assert.rejects(store.fetch(id), /invalid.*id/i);
  assert.equal(calls, 0);
});

test('fetch rejects malformed issue responses', async () => {
  let response = '';
  const store = new GitHubSpecificationStore({ repository: 'owner/repo', label: 'spec', project: { ...project, iterationField: 'Iteration' }, gh: async () => response });
  const valid: Record<string, unknown> = { title: 'Title', body: '', url: 'https://github.com/owner/repo/issues/1', updatedAt: '2025-01-01T00:00:00Z' };
  for (response of ['not json', 'null', '[]', '42', ...Object.keys(valid).flatMap(key => {
    const missing = { ...valid }; delete missing[key];
    return [JSON.stringify(missing), JSON.stringify({ ...valid, [key]: null }), JSON.stringify({ ...valid, [key]: 123 })];
  })]) await assert.rejects(store.fetch('1'), /unexpected response/i);
});

test('repository derives from origin using GitHub PR URL rules and errors name configuration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec-origin-'));
  try {
    execFileSync('git', ['init', '-q', dir]);
    const config = { store: 'github' as const, github: { project } };
    await assert.rejects(createSpecificationStore(config, dir, async () => ''), /specifications\.github\.repository/);
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://github.com/owner/repo.git']);
    const store = await createSpecificationStore(config, dir, async () => '') as GitHubSpecificationStore;
    assert.equal(store.options.repository, 'owner/repo');
    execFileSync('git', ['-C', dir, 'remote', 'set-url', 'origin', 'https://example.com/owner/repo']);
    await assert.rejects(createSpecificationStore(config, dir, async () => ''), /specifications\.github\.repository/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
