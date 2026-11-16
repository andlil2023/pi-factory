import { spawn } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface WorktreeInfo {
  repository: string;
  path: string;
  branch: string;
  baseCommit: string;
}

export interface CreateWorktreeOptions {
  repository: string;
  runId: string;
  worktreesDirectory?: string;
}

function assertRunId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) {
    throw new Error('Invalid runId: use 1-80 letters, digits, underscores or hyphens');
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  return await new Promise<string>((ok, fail) => {
    const child = spawn('git', args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (part: string) => { stdout += part; });
    child.stderr.setEncoding('utf8').on('data', (part: string) => { stderr += part; });
    child.on('error', fail);
    child.on('close', code => code === 0 ? ok(stdout.trim()) : fail(new Error(`git ${args[0]} failed (${code}): ${stderr.trim()}`)));
  });
}

export async function createWorktree(options: CreateWorktreeOptions): Promise<WorktreeInfo> {
  assertRunId(options.runId);
  const repository = await realpath(resolve(options.repository));
  const root = await git(repository, ['rev-parse', '--show-toplevel']);
  if (resolve(root) !== resolve(repository)) throw new Error('repository must be the Git working-tree root');
  const baseCommit = await git(repository, ['rev-parse', 'HEAD']);
  if ((await git(repository, ['status', '--porcelain'])).length) {
    throw new Error('Repository must have a clean working tree before starting a factory run');
  }
  const worktreesDirectory = resolve(options.worktreesDirectory ?? join(dirname(repository), '.factory-worktrees'));
  const path = join(worktreesDirectory, options.runId);
  const branch = `factory/${options.runId}`;
  await mkdir(worktreesDirectory, { recursive: true });
  // Git refuses if the destination or branch already exists. Never overwrite an existing run.
  await git(repository, ['worktree', 'add', '-b', branch, path, baseCommit]);
  return { repository, path, branch, baseCommit };
}

export async function removeWorktree(info: WorktreeInfo, options: { deleteBranch?: boolean } = {}): Promise<void> {
  const repo = await realpath(resolve(info.repository));
  const actualRoot = await git(repo, ['rev-parse', '--show-toplevel']);
  if (resolve(actualRoot) !== repo) throw new Error('Invalid repository root');
  // Git may expand Windows 8.3 paths or resolve directory aliases. Compare
  // filesystem-canonical paths, not just lexically normalized strings.
  const target = await realpath(resolve(info.path));
  // NUL-delimited porcelain avoids Git's quoting of unusual path characters.
  const worktrees = await git(repo, ['worktree', 'list', '--porcelain', '-z']);
  let registered = false;
  for (const field of worktrees.split('\0')) {
    if (!field.startsWith('worktree ')) continue;
    try {
      if (await realpath(field.slice(9)) === target) {
        registered = true;
        break;
      }
    } catch (error) {
      // A stale registration must not prevent checking other worktrees.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (!registered) throw new Error('Worktree is not registered; refusing to remove');
  // No --force: preserve uncommitted work for inspection.
  await git(repo, ['worktree', 'remove', target]);
  if (options.deleteBranch) await git(repo, ['branch', '-d', info.branch]);
}

export async function getWorktreeDiff(info: WorktreeInfo): Promise<string> {
  // Includes tracked changes and committed changes since run start; untracked files require separate inspection.
  return git(info.path, ['diff', info.baseCommit]);
}
