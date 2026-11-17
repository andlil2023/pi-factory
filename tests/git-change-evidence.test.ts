import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectGitChangeEvidence } from '../src/git-change-evidence.ts';

async function repository(fn: (repo: string, baseline: string, git: (...args: string[]) => string) => Promise<void>) {
  const repo = await mkdtemp(join(tmpdir(), 'factory-evidence-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    await writeFile(join(repo, 'base'), 'base\n');
    await writeFile(join(repo, 'rename-me'), 'rename content\n');
    git('add', '.'); git('commit', '-qm', 'baseline');
    await fn(repo, git('rev-parse', 'HEAD'), git);
  } finally { await rm(repo, { recursive: true, force: true }); }
}

test('collects committed, staged, unstaged and untracked paths without quoting unusual names', async () => {
  await repository(async (repo, baseline, git) => {
    await writeFile(join(repo, 'committed'), 'one');
    git('add', '.'); git('commit', '-qm', 'change');
    await writeFile(join(repo, 'staged'), 'two'); git('add', 'staged');
    await writeFile(join(repo, 'base'), 'modified');
    const unusual = process.platform === 'win32' ? 'space ü.txt' : 'space\tline\nü.txt';
    await writeFile(join(repo, unusual), 'new');
    const result = await collectGitChangeEvidence(repo, baseline);
    assert.equal(result.suitable, true, result.reasons.join('; '));
    assert.deepEqual(result.changes, [
      { path: 'committed', status: 'A', source: 'committed' },
      { path: 'staged', status: 'A', source: 'staged' },
      { path: 'base', status: 'M', source: 'unstaged' },
      { path: unusual, status: '?', source: 'untracked' },
    ]);
  });
});

test('preserves a leading BOM in the first untracked filename', async () => {
  await repository(async (repo, baseline) => {
    const filename = '\uFEFFsafe.txt';
    await writeFile(join(repo, filename), 'new');
    const result = await collectGitChangeEvidence(repo, baseline);
    assert.equal(result.suitable, true, result.reasons.join('; '));
    assert.deepEqual(result.changes, [{ path: filename, status: '?', source: 'untracked' }]);
  });
});

test('reports renames and deletions unsuitable, including changes hidden by later layers', async () => {
  await repository(async (repo, baseline, git) => {
    await rename(join(repo, 'rename-me'), join(repo, 'renamed'));
    git('add', '-A'); git('commit', '-qm', 'rename');
    await rm(join(repo, 'base'));
    const result = await collectGitChangeEvidence(repo, baseline);
    assert.equal(result.suitable, false);
    assert.ok(result.changes.some(c => c.status === 'R' && c.previousPath === 'rename-me' && c.path === 'renamed'));
    assert.ok(result.changes.some(c => c.status === 'D' && c.path === 'base'));
  });
  await repository(async (repo, baseline, git) => {
    await rm(join(repo, 'base')); git('add', '-A');
    await writeFile(join(repo, 'base'), 'restored');
    const result = await collectGitChangeEvidence(repo, baseline);
    assert.equal(result.suitable, false);
    assert.ok(result.changes.some(c => c.source === 'staged' && c.status === 'D'));
  });
});

test('index flags that hide working-tree changes make evidence unsuitable', async () => {
  await repository(async (repo, baseline, git) => {
    git('update-index', '--assume-unchanged', 'base');
    await writeFile(join(repo, 'base'), 'hidden');
    await writeFile(join(repo, 'visible'), 'visible');
    const result = await collectGitChangeEvidence(repo, baseline);
    assert.equal(result.suitable, false);
    assert.match(result.reasons.join(' '), /index entry/);
  });
});

test('empty, missing, non-ancestor and inaccessible evidence is unsuitable', async () => {
  await repository(async (repo, baseline, git) => {
    assert.equal((await collectGitChangeEvidence(repo, baseline)).suitable, false);
    assert.equal((await collectGitChangeEvidence(repo, 'HEAD')).suitable, false);
    assert.equal((await collectGitChangeEvidence(repo, '0'.repeat(baseline.length))).suitable, false);
    await writeFile(join(repo, 'new'), 'x'); git('add', '.'); git('commit', '-qm', 'next');
    const later = git('rev-parse', 'HEAD');
    git('reset', '--hard', baseline);
    assert.equal((await collectGitChangeEvidence(repo, later)).suitable, false);
    assert.equal((await collectGitChangeEvidence(join(repo, 'missing'), baseline)).suitable, false);
  });
});
