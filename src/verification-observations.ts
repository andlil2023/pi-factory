import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export interface VerificationCommand { executable: string; args?: string[]; timeoutMs?: number; name?: string }
export interface VerificationIdentity { plan: string; specification: string | null; implementation: string }
export interface NamedObservation { name: string; passed: boolean; identity: VerificationIdentity | null }

export function validateVerificationCommands(commands: VerificationCommand[]): void {
  if (!Array.isArray(commands)) throw new Error('Invalid verification commands');
  const names = new Set<string>();
  for (const command of commands) {
    if (!command || typeof command.executable !== 'string' || !command.executable.trim() ||
      (command.args !== undefined && (!Array.isArray(command.args) || command.args.some(arg => typeof arg !== 'string'))) ||
      (command.timeoutMs !== undefined && (!Number.isSafeInteger(command.timeoutMs) || command.timeoutMs <= 0)) ||
      (command.name !== undefined && (typeof command.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(command.name) || names.has(command.name)))) throw new Error('Invalid or duplicate named verification command');
    if (command.name !== undefined) names.add(command.name);
  }
}

/** Hash the complete reviewed plan, including explicit mappings. */
export function planIdentity(plan: unknown): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

/** Build the exact candidate Git tree in a temporary index without touching the user's index. */
export async function implementationIdentity(repository: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'factory-verify-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') };
  const git = async (args: string[]) => (await exec('git', args, { cwd: repository, env, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
  try {
    await git(['read-tree', 'HEAD']);
    await git(['add', '-A', '--', '.']);
    return await git(['write-tree']);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
