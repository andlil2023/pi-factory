import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { promisify } from 'node:util';
import { ContractValidator } from './contract-validator.ts';
import { implementationIdentity } from './verification-observations.ts';

const exec = promisify(execFile);
export interface UiEvidenceCommand { executable: string; args?: string[]; timeoutMs?: number }
export interface UiEvidenceConfig { command: UiEvidenceCommand; directory: string; syntheticDeveloperReviewAuthorized?: boolean }
export interface UiEvidenceManifest {
  version: 1;
  taskId: string;
  attempt: number;
  capturedAt: string;
  sourceFingerprint: string;
  application: { framework: string; buildId: string };
  checks: Array<{ kind: 'interaction' | 'accessibility'; name: string; status: 'passed' | 'failed'; details?: string }>;
  artifacts: Array<{ kind: 'screenshot' | 'accessibility-tree' | 'log'; path: string }>;
  imageLinks?: Array<{ checkName: string; screenshotPath: string; caption: string }>;
  limitations: string[];
}
export interface UiEvidenceRecord {
  passed: boolean;
  directory: string;
  manifest?: UiEvidenceManifest;
  artifacts: Array<{ kind: string; path: string; sha256: string; imageType?: 'image/png' | 'image/jpeg' }>;
  /** Trusted configuration snapshot, never supplied by the collector. Missing on legacy records means false. */
  syntheticDeveloperReviewAuthorized?: boolean;
  /** Factory-measured Git tree before and after collection, not collector output. */
  implementationIdentity?: string;
  issues: string[];
}

export function validateUiEvidenceCommand(command: UiEvidenceCommand): void {
  if (!command || typeof command.executable !== 'string' || !command.executable.trim()) throw new Error('uiEvidence.command.executable is required');
  if (command.args !== undefined && (!Array.isArray(command.args) || command.args.some(arg => typeof arg !== 'string'))) throw new Error('uiEvidence.command.args must be strings');
  if (command.timeoutMs !== undefined && (!Number.isSafeInteger(command.timeoutMs) || command.timeoutMs <= 0)) throw new Error('Invalid uiEvidence.command.timeoutMs');
}

// Windows measurements showed some collector timestamps later than the parent's end;
// the cause is unproven and the observations do not establish a universal bound.
// The approved inclusive 50 ms allowance on both sides can admit stale timestamps.
export function isUiEvidenceTimestampWithinCollection(capturedAt: string, started: number, ended: number): boolean {
  const captured = Date.parse(capturedAt);
  return Number.isFinite(captured) && captured >= started - 50 && captured <= ended + 50;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

/** Hash current Git-visible source, including unstaged/untracked bytes and symlink targets. */
export async function sourceFingerprint(repository: string): Promise<string> {
  const { stdout: head } = await exec('git', ['rev-parse', 'HEAD'], { cwd: repository });
  const { stdout: files } = await exec('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repository, maxBuffer: 8 * 1024 * 1024 });
  const hash = createHash('sha256').update(head.trim());
  for (const path of [...new Set(files.split('\0').filter(Boolean))].sort()) {
    hash.update(`\0${path}\0`);
    const full = resolve(repository, path);
    if (!inside(resolve(repository), full)) throw new Error('Invalid source path');
    try {
      const stat = await lstat(full);
      hash.update(`${stat.mode}:${stat.size}\0`);
      if (stat.isSymbolicLink()) hash.update(await readlink(full));
      else if (stat.isFile()) {
        for await (const chunk of createReadStream(full)) hash.update(chunk);
      } else throw new Error(`Unsupported source entry: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      hash.update('deleted');
    }
  }
  return hash.digest('hex');
}

/** Runs only a trusted configured collector. A fresh external directory prevents stale reuse. */
export async function collectUiEvidence(config: UiEvidenceConfig, context: { repository: string; taskId: string; attempt: number }, validator: ContractValidator): Promise<UiEvidenceRecord> {
  const result: UiEvidenceRecord = { passed: false, directory: '', artifacts: [], issues: [], syntheticDeveloperReviewAuthorized: config.syntheticDeveloperReviewAuthorized === true };
  try {
    validateUiEvidenceCommand(config.command);
    if (config.syntheticDeveloperReviewAuthorized !== undefined && typeof config.syntheticDeveloperReviewAuthorized !== 'boolean') throw new Error('Invalid synthetic developer-review authorization');
    const repository = await realpath(context.repository);
    await mkdir(config.directory, { recursive: true });
    const root = await realpath(config.directory);
    if (root === repository || inside(repository, root)) throw new Error('UI evidence directory must be outside the target worktree');
    result.directory = await mkdtemp(join(root, `${context.taskId}-${context.attempt}-`));
    const fingerprint = await sourceFingerprint(repository);
    const implementation = await implementationIdentity(repository);
    const started = Date.now();
    try {
      await exec(config.command.executable, config.command.args ?? [], {
        cwd: repository, shell: false, windowsHide: true, timeout: config.command.timeoutMs ?? 120_000, maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, FACTORY_UI_EVIDENCE_DIRECTORY: result.directory,
          FACTORY_TASK_ID: context.taskId, FACTORY_ATTEMPT: String(context.attempt),
          FACTORY_SOURCE_FINGERPRINT: fingerprint,
          FACTORY_UI_EVIDENCE_IMAGE_LINKS: '1' }
      });
    } catch {
      // Do not copy command arguments or stdout/stderr into persisted state.
      throw new Error('UI evidence collector command failed or timed out');
    }
    const ended = Date.now();
    if (await sourceFingerprint(repository) !== fingerprint || await implementationIdentity(repository) !== implementation) throw new Error('Source changed during UI evidence collection');
    const manifestPath = await realpath(join(result.directory, 'manifest.json'));
    if (!inside(result.directory, manifestPath)) throw new Error('Manifest escapes evidence directory');
    if ((await lstat(manifestPath)).size > 1_000_000) throw new Error('UI evidence manifest is too large');
    const validation = await validator.validate<UiEvidenceManifest>('ui-evidence', await readFile(manifestPath, 'utf8'));
    if (!validation.valid) throw new Error(`Invalid UI evidence manifest: ${JSON.stringify(validation.issues)}`);
    const manifest = validation.value;
    result.manifest = manifest;
    if (manifest.taskId !== context.taskId || manifest.attempt !== context.attempt) throw new Error('UI evidence task/attempt mismatch');
    if (manifest.sourceFingerprint !== fingerprint) throw new Error('UI evidence source fingerprint mismatch');
    if (!isUiEvidenceTimestampWithinCollection(manifest.capturedAt, started, ended)) throw new Error('UI evidence capture timestamp is stale or invalid');
    if (manifest.checks.some(check => check.status !== 'passed')) throw new Error('UI evidence contains failed checks');
    for (const kind of ['interaction', 'accessibility']) {
      if (!manifest.checks.some(check => check.kind === kind)) throw new Error(`Missing ${kind} check`);
    }
    for (const kind of ['screenshot', 'accessibility-tree']) {
      if (!manifest.artifacts.some(artifact => artifact.kind === kind)) throw new Error(`Missing ${kind} artifact`);
    }
    for (const link of manifest.imageLinks ?? []) {
      if (manifest.checks.filter(check => check.name === link.checkName).length !== 1) throw new Error('Image link must reference exactly one named check');
      if (manifest.artifacts.filter(artifact => artifact.kind === 'screenshot' && artifact.path === link.screenshotPath).length !== 1) throw new Error('Image link must reference exactly one screenshot artifact');
      if (!link.caption.trim() || /[\u0000-\u001f\u007f]/.test(link.caption)) throw new Error('Image caption must be plain text');
    }
    const seen = new Set<string>();
    for (const artifact of manifest.artifacts) {
      if (isAbsolute(artifact.path) || win32.isAbsolute(artifact.path) || !inside(result.directory, resolve(result.directory, artifact.path))) throw new Error('Artifact path escapes evidence directory');
      const path = await realpath(resolve(result.directory, artifact.path));
      if (!inside(result.directory, path)) throw new Error('Artifact symlink escapes evidence directory');
      if (seen.has(path)) throw new Error('Duplicate UI evidence artifact');
      seen.add(path);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.size === 0 || stat.size > 20 * 1024 * 1024) throw new Error('Invalid or oversized UI evidence artifact');
      const bytes = await readFile(path);
      let imageType: 'image/png' | 'image/jpeg' | undefined;
      if (artifact.kind === 'screenshot') {
        const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
        if (!png && !jpeg) throw new Error('Screenshot must be a PNG or JPEG image');
        imageType = png ? 'image/png' : 'image/jpeg';
      }
      result.artifacts.push({ kind: artifact.kind, path, sha256: createHash('sha256').update(bytes).digest('hex'), ...(imageType ? { imageType } : {}) });
    }
    result.implementationIdentity = implementation;
    result.passed = true;
  } catch (error) {
    // Avoid persisting collector stdout/stderr, which may contain sensitive app data.
    result.issues.push(error instanceof Error ? error.message.split('\n')[0] : 'UI evidence collection failed');
  }
  return result;
}

/** Reject evidence or artifacts modified after collection, before reviewer invocation. */
export async function assertUiEvidenceCurrent(record: UiEvidenceRecord, repository: string): Promise<void> {
  if (!record.passed || !record.manifest) throw new Error('UI evidence did not pass validation');
  if (await sourceFingerprint(repository) !== record.manifest.sourceFingerprint) throw new Error('UI evidence is stale for the current source');
  for (const artifact of record.artifacts) {
    const path = await realpath(artifact.path);
    if (!inside(record.directory, path)) throw new Error('UI evidence artifact moved outside evidence directory');
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size === 0 || stat.size > 20 * 1024 * 1024) throw new Error('Invalid or oversized UI evidence artifact');
    const bytes = await readFile(path);
    if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('UI evidence artifact changed after collection');
  }
}
