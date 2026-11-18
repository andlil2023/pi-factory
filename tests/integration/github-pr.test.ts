import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { githubDestination, pushCandidate, readPullRequest, remoteHead, type GitHubDestination } from '../../src/github-pr.ts';

function git(cwd: string, ...args: string[]): string { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }

test('readPullRequest requests the recorded PR fields without a shell or raw output', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-gh-read-'));
  const previousPath = process.env.PATH;
  t.after(async () => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; await rm(dir, { recursive: true, force: true }); });
  // On Windows use Node itself as gh.exe; it executes the first argument, the local 'pr' script.
  await writeFile(join(dir, 'pr'), 'const fs = require("node:fs");\nfs.appendFileSync("calls", JSON.stringify(["pr", ...process.argv.slice(2)]) + "\\n");\nprocess.stdout.write(JSON.stringify({state:"MERGED", mergedAt:null, marker:"raw-secret"}));\n');
  if (process.platform === 'win32') {
    await copyFile(process.execPath, join(dir, 'gh.exe'));
  } else {
    const gh = join(dir, 'gh');
    await writeFile(gh, '#!/bin/sh\nexec node "$@"\n');
    await chmod(gh, 0o755);
  }
  process.env.PATH = `${dir}${delimiter}${previousPath ?? ''}`;
  const url = 'https://github.com/owner/repo/pull/1;echo shell-injection';
  assert.deepEqual(await readPullRequest(dir, 'owner/repo', url), { state: 'MERGED', mergedAt: null, marker: 'raw-secret' });
  const calls = (await readFile(join(dir, 'calls'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls, [['pr', 'view', url, '--repo', 'github.com/owner/repo', '--json', 'state,mergedAt,mergeCommit,baseRefName,headRefName,headRefOid,url']]);
});

test('destination requires a same-branch GitHub upstream and matching push destination', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-github-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  git(dir, 'init');
  git(dir, 'remote', 'add', 'origin', 'https://github.com/owner/repo.git');
  git(dir, 'config', 'branch.main.remote', 'origin');
  git(dir, 'config', 'branch.main.merge', 'refs/heads/main');
  const sha = 'a'.repeat(40);
  const result = await githubDestination(dir, 'main', sha, 'factory/test', sha);
  assert.equal(result.repository, 'owner/repo');
  git(dir, 'remote', 'set-url', '--push', 'origin', 'https://github.com/other/repo.git');
  await assert.rejects(githubDestination(dir, 'main', sha, 'factory/test', sha), /destinations differ/);
  git(dir, 'remote', 'set-url', '--push', 'origin', 'https://token@github.com/owner/repo.git');
  await assert.rejects(githubDestination(dir, 'main', sha, 'factory/test', sha), /credential-free/);
  git(dir, 'config', 'branch.main.merge', 'refs/heads/other');
  await assert.rejects(githubDestination(dir, 'main', sha, 'factory/test', sha), /same-named/);
});

test('candidate push creates only the pinned branch even with followTags configured', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-github-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo'), remote = join(dir, 'remote.git');
  await mkdir(repo); await mkdir(remote);
  git(repo, 'init'); git(remote, 'init', '--bare');
  git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'push.followTags', 'true');
  await writeFile(join(repo, 'a'), 'a'); git(repo, 'add', 'a'); git(repo, 'commit', '-m', 'test');
  git(repo, 'tag', '-a', 'private-tag', '-m', 'must not be pushed');
  const sha = git(repo, 'rev-parse', 'HEAD');
  const destination: GitHubDestination = { remote: 'origin', pushUrl: remote, repository: 'example/repo', base: 'main', baseSha: sha, head: 'factory/test', headSha: sha };
  git(repo, 'config', 'url.https://github.com/owner/.insteadOf', 'alias:');
  git(repo, 'config', `url.${join(dir, 'other')}.pushInsteadOf`, 'https://github.com/owner/');
  await assert.rejects(pushCandidate(repo, destination), /rewrite rules/);
  assert.equal(await remoteHead(repo, remote, destination.head), undefined);
  git(repo, 'config', '--unset', 'url.https://github.com/owner/.insteadOf');
  git(repo, 'config', '--unset', `url.${join(dir, 'other')}.pushInsteadOf`);
  await pushCandidate(repo, destination);
  assert.equal(await remoteHead(repo, remote, destination.head), sha);
  assert.equal(git(remote, 'for-each-ref', '--format=%(refname)', 'refs/tags'), '');
  await writeFile(join(repo, 'a'), 'b'); git(repo, 'add', 'a'); git(repo, 'commit', '-m', 'another');
  await assert.rejects(pushCandidate(repo, { ...destination, headSha: git(repo, 'rev-parse', 'HEAD') }));
  assert.equal(await remoteHead(repo, remote, destination.head), sha);
});
