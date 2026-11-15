import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface CheckpointRequest {
  worktree: string;
  branch: string;
  taskId: string;
  title: string;
  expectedHead?: string;
}
export interface CheckpointResult {
  commit: string;
  previousHead: string;
  changedFiles: string[];
}

async function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolveResult, reject) => {
    const child = spawn('git', args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (data: string) => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', (data: string) => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolveResult(stdout.trim()) : reject(new Error(`git ${args[0]} failed (${code}): ${stderr.trim()}`)));
  });
}

/** Commit the verified working tree on the designated factory branch. No merges or branch deletion. */
export async function createGitCheckpoint(request: CheckpointRequest): Promise<CheckpointResult> {
  if (!/^T\d{3,}$/.test(request.taskId)) throw new Error('Invalid task ID');
  if (!request.title.trim() || /[\r\n]/.test(request.title)) throw new Error('Invalid task title');
  if (!/^factory\/[A-Za-z0-9_-]+$/.test(request.branch)) throw new Error('Expected a factory branch');
  const cwd = await realpath(resolve(request.worktree));
  const root = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (resolve(root).toLowerCase() !== cwd.toLowerCase()) throw new Error('Worktree must be a Git root');
  const branch = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch !== request.branch) throw new Error(`Wrong branch: ${branch}`);
  const previousHead = await git(cwd, ['rev-parse', 'HEAD']);
  if (request.expectedHead && request.expectedHead !== previousHead) throw new Error('HEAD changed since verification');
  const status = await git(cwd, ['status', '--porcelain', '--untracked-files=all']);
  if (!status) throw new Error('No changes to checkpoint');
  // The caller must have validated scope and tests before invoking this function.
  // Stage new, modified, and deleted files, including untracked files.
  await git(cwd, ['add', '--all']);
  const staged = await git(cwd, ['diff', '--cached', '--name-only']);
  if (!staged) throw new Error('No staged changes');
  const changedFiles = staged.split(/\r?\n/);
  if (changedFiles.some(path => path === '.factory' || path.startsWith('.factory/') || path === '.git' || path.startsWith('.git/'))) {
    await git(cwd, ['reset', '--quiet']);
    throw new Error('Refusing to commit factory state or Git metadata');
  }
  try {
    await git(cwd, ['-c', 'user.name=PI Factory', '-c', 'user.email=pi-factory@localhost', 'commit', '-m', `${request.taskId}: ${request.title}`]);
  } catch (error) {
    // Preserve the working tree; unstage only the files we staged.
    await git(cwd, ['reset', '--quiet']).catch(() => {});
    throw error;
  }
  return { commit: await git(cwd, ['rev-parse', 'HEAD']), previousHead, changedFiles };
}
