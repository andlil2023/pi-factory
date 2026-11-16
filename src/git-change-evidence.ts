import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export type ChangeSource = 'committed' | 'staged' | 'unstaged' | 'untracked';
export interface ChangedPath {
  path: string;
  status: string;
  source: ChangeSource;
  /** Present for a rename or copy, whose path is the destination. */
  previousPath?: string;
}
export interface GitChangeEvidence {
  suitable: boolean;
  changes: ChangedPath[];
  reasons: string[];
}

/** Collect each layer separately, so a later edit cannot hide an earlier deletion or rename.
 * The baseline must be an ancestor of HEAD, not a moving branch or revision expression. */
export async function collectGitChangeEvidence(repository: string, baseline: string): Promise<GitChangeEvidence> {
  const changes: ChangedPath[] = [];
  const reasons: string[] = [];
  const git = async (args: string[]): Promise<Buffer> => (await exec('git', args, {
    cwd: repository, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  })).stdout;
  const text = (buffer: Buffer): string => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
  const line = async (args: string[]): Promise<string> => text(await git(args)).trim();
  const split = (buffer: Buffer): string[] => {
    if (!buffer.length) return [];
    if (buffer[buffer.length - 1] !== 0) throw new Error('Unterminated Git output');
    return text(buffer.subarray(0, -1)).split('\0');
  };
  try {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseline)) throw new Error('Baseline must be a full commit ID');
    if (await line(['rev-parse', '--show-prefix']) !== '') throw new Error('Repository must be a worktree root');
    const actualBaseline = await line(['rev-parse', '--verify', `${baseline}^{commit}`]);
    if (actualBaseline !== baseline) throw new Error('Invalid baseline commit');
    const head = await line(['rev-parse', '--verify', 'HEAD^{commit}']);
    await git(['merge-base', '--is-ancestor', baseline, head]);
    const statusArgs = ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'];
    const before = await git(statusArgs);
    // Git may silently omit working-tree edits for these index flags. Refuse to
    // select rather than treating an incomplete diff as authoritative.
    for (const entry of split(await git(['ls-files', '-v', '-z']))) {
      if (!entry.startsWith('H ')) throw new Error('Unsupported index entry or hidden working-tree changes');
    }
    const collectDiff = async (source: ChangeSource, args: string[]): Promise<void> => {
      const entries = split(await git(['diff', '--no-ext-diff', '--no-textconv', '--no-relative', '--ignore-submodules=none', '--find-renames', '--raw', '-z', '--abbrev=40', ...args, '--']));
      for (let i = 0; i < entries.length;) {
        const header = entries[i++];
        const match = /^:([0-7]{6}) ([0-7]{6}) [a-f0-9]+ [a-f0-9]+ ([A-Z])([0-9]*)$/.exec(header);
        if (!match || i >= entries.length) throw new Error('Malformed or unsupported Git diff output');
        const [, oldMode, newMode, status] = match;
        const first = entries[i++];
        if (!first) throw new Error('Empty Git path');
        let path = first;
        let previousPath: string | undefined;
        if (status === 'R' || status === 'C') {
          if (i >= entries.length || !entries[i]) throw new Error('Incomplete rename or copy');
          previousPath = first;
          path = entries[i++];
        }
        changes.push({ path, status, source, ...(previousPath === undefined ? {} : { previousPath }) });
        if (!['A', 'M'].includes(status) || oldMode === '160000' || newMode === '160000') {
          reasons.push(`Unsupported ${source} change (${status}): ${path}`);
        }
      }
    };
    await collectDiff('committed', [baseline, head]);
    await collectDiff('staged', ['--cached', head]);
    await collectDiff('unstaged', []);
    for (const path of split(await git(['ls-files', '--others', '--exclude-standard', '-z']))) {
      if (!path) throw new Error('Empty Git path');
      changes.push({ path, status: '?', source: 'untracked' });
    }
    if (!before.equals(await git(statusArgs)) || head !== await line(['rev-parse', '--verify', 'HEAD^{commit}'])) {
      throw new Error('Repository changed while collecting evidence');
    }
    if (!changes.length) reasons.push('No changed paths');
  } catch (error) {
    reasons.push(`Unable to collect reliable Git evidence: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { suitable: reasons.length === 0, changes, reasons };
}
