import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Calculate a candidate tree in an isolated Git directory with no executable integrations.
 * Active filters cannot be reproduced safely, so their presence makes identity unavailable.
 */
export async function dashboardImplementationIdentity(repository: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'factory-dashboard-'));
  const env = { ...process.env };
  // Do not inherit Git's repository, configuration injection, or external program overrides.
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('GIT_')) delete env[key];
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  env.GIT_TERMINAL_PROMPT = '0';
  const git = async (args: string[], extra: NodeJS.ProcessEnv = {}) => (await exec('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', ...args], { cwd: repository, env: { ...env, ...extra }, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })).stdout;
  try {
    // Inspect the effective configuration, including normal global/system configuration, but
    // never execute its configured integrations. The isolated repository below has no filters.
    const inspectEnv = { ...process.env };
    for (const key of Object.keys(inspectEnv)) if (key.toUpperCase().startsWith('GIT_')) delete inspectEnv[key];
    const config = (await exec('git', ['-c', 'core.fsmonitor=false', 'config', '--null', '--list', '--includes'], { cwd: repository, env: inspectEnv, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })).stdout;
    const entries = config.split('\0').filter(Boolean).map(entry => { const i = entry.indexOf('\n'); return [entry.slice(0, i), entry.slice(i + 1)] as const; });
    const checkFilters = async () => {
      const inspectGit = async (args: string[]) => (await exec('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: repository, env: inspectEnv, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })).stdout;
      const paths = (await inspectGit(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
      // Passing paths as arguments intentionally fails closed if the platform's argument limit is exceeded.
      if (paths.length) {
        const attrs = (await inspectGit(['check-attr', '-z', 'filter', '--', ...paths])).split('\0');
        for (let i = 2; i < attrs.length; i += 3) if (attrs[i] !== 'unspecified' && attrs[i] !== 'unset') throw new Error('Active filters cannot be evaluated safely');
      }
    };
    await checkFilters();
    const head = (await git(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
    const format = (await git(['rev-parse', '--show-object-format'])).trim();
    if (!['sha1', 'sha256'].includes(format) || !/^[a-f0-9]+$/.test(head)) throw new Error('Unsupported repository');
    const objectsPath = (await git(['rev-parse', '--git-path', 'objects'])).trim();
    const objects = isAbsolute(objectsPath) ? objectsPath : resolve(repository, objectsPath);
    const isolated = join(dir, 'git');
    await git(['init', '--bare', `--object-format=${format}`, isolated]);
    await mkdir(join(isolated, 'objects', 'info'), { recursive: true });
    await writeFile(join(isolated, 'objects', 'info', 'alternates'), objects + '\n');
    // Preserve Git's relevant content and ignore settings without importing executable config.
    const allowed = new Set(['core.autocrlf', 'core.eol', 'core.safecrlf', 'core.filemode', 'core.symlinks', 'core.ignorecase', 'core.excludesfile', 'core.attributesfile']);
    for (const [key, value] of entries) if (allowed.has(key.toLowerCase())) {
      await git(['config', '--file', join(isolated, 'config'), '--replace-all', key, value]);
    }
    for (const name of ['exclude', 'attributes']) {
      const source = (await git(['rev-parse', '--git-path', `info/${name}`])).trim();
      try { await copyFile(isAbsolute(source) ? source : resolve(repository, source), join(isolated, 'info', name)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const isolatedEnv = { GIT_DIR: isolated, GIT_WORK_TREE: resolve(repository), GIT_INDEX_FILE: join(dir, 'index') };
    await git(['read-tree', head], isolatedEnv);
    await git(['add', '-A', '--', '.'], isolatedEnv);
    await checkFilters();
    return (await git(['write-tree'], isolatedEnv)).trim();
  } finally { await rm(dir, { recursive: true, force: true }); }
}
