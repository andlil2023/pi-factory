import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
async function command(cwd: string, executable: string, args: string[]): Promise<string> {
  const { stdout } = await exec(executable, args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}
async function git(cwd: string, args: string[]): Promise<string> { return command(cwd, 'git', args); }

export interface GitHubDestination { remote: string; pushUrl: string; repository: string; base: string; baseSha: string; head: string; headSha: string }

function githubRepository(url: string): string {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url);
  if (!match || match[1] === '.' || match[1] === '..' || match[2] === '.' || match[2] === '..') throw new Error('Upstream must use a credential-free github.com repository URL');
  return `${match[1]}/${match[2]}`;
}

export async function githubDestination(cwd: string, base: string, baseSha: string, head: string, headSha: string): Promise<GitHubDestination> {
  const remote = await git(cwd, ['config', '--get', `branch.${base}.remote`]);
  const merge = await git(cwd, ['config', '--get', `branch.${base}.merge`]);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote) || merge !== `refs/heads/${base}`) throw new Error('Target must track the same-named branch of a configured GitHub remote');
  const fetchUrls = (await git(cwd, ['remote', 'get-url', '--all', remote])).split('\n');
  const pushUrls = (await git(cwd, ['remote', 'get-url', '--push', '--all', remote])).split('\n');
  if (fetchUrls.length !== 1 || pushUrls.length !== 1) throw new Error('GitHub remote must have exactly one fetch and push URL');
  const repository = githubRepository(fetchUrls[0]);
  if (githubRepository(pushUrls[0]).toLowerCase() !== repository.toLowerCase()) throw new Error('GitHub fetch and push destinations differ');
  return { remote, pushUrl: pushUrls[0], repository, base, baseSha, head, headSha };
}

export async function remoteHead(cwd: string, remote: string, branch: string): Promise<string | undefined> {
  const output = await git(cwd, ['ls-remote', '--refs', remote, `refs/heads/${branch}`]);
  if (!output) return undefined;
  const match = /^([a-f0-9]{40,64})\s+refs\/heads\/(.+)$/.exec(output);
  if (!match || match[2] !== branch) throw new Error('Unexpected remote ref response');
  return match[1];
}

export async function pushCandidate(cwd: string, destination: GitHubDestination): Promise<void> {
  // Git can rewrite even an explicitly supplied URL, including with pushInsteadOf.
  // Fail closed rather than trying to predict chained, scoped, or case-sensitive rules.
  try {
    const rules = await git(cwd, ['config', '--get-regexp', '^url\\..*\\.(insteadof|pushinsteadof)$']);
    if (rules) throw new Error('Git URL rewrite rules are not supported for GitHub publication');
  } catch (error) {
    if ((error as { code?: unknown }).code !== 1) throw error;
  }
  // The empty expected value requires that the remote branch not exist.
  await git(cwd, ['push', '--no-follow-tags', '--recurse-submodules=no', `--force-with-lease=refs/heads/${destination.head}:`, destination.pushUrl, `${destination.headSha}:refs/heads/${destination.head}`]);
}

export async function createPullRequest(cwd: string, destination: GitHubDestination): Promise<string> {
  const url = await command(cwd, 'gh', ['pr', 'create', '--repo', `github.com/${destination.repository}`, '--head', destination.head, '--base', destination.base,
    '--title', `Factory integration ${destination.head}`, '--body', `Factory-reviewed integration candidate: ${destination.headSha}\nReviewed base: ${destination.baseSha}\n\nAuto-merge is not enabled by the factory.`]);
  const expected = `https://github.com/${destination.repository}/pull/`;
  if (!url.toLowerCase().startsWith(expected.toLowerCase()) || !/^[1-9][0-9]*$/.test(url.slice(expected.length))) throw new Error('GitHub returned an unexpected pull request URL');
  return url;
}

/** Read external PR data as untrusted JSON; callers must validate it before use. */
export async function readPullRequest(cwd: string, repository: string, url: string): Promise<unknown> {
  return JSON.parse(await command(cwd, 'gh', ['pr', 'view', url, '--repo', `github.com/${repository}`, '--json', 'state,mergedAt,mergeCommit,baseRefName,headRefName,headRefOid,url']));
}

export async function verifyPullRequest(cwd: string, destination: GitHubDestination, url: string): Promise<void> {
  const result = JSON.parse(await command(cwd, 'gh', ['pr', 'view', url, '--repo', `github.com/${destination.repository}`, '--json', 'state,baseRefName,baseRefOid,headRefName,headRefOid']));
  if (result.state !== 'OPEN' || result.baseRefName !== destination.base || result.baseRefOid !== destination.baseSha || result.headRefName !== destination.head || result.headRefOid !== destination.headSha) throw new Error('GitHub pull request no longer matches the reviewed refs');
}
