import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

test('npm package contains runtime and assets but not local configuration or run data', () => {
  const temp = mkdtempSync(join(tmpdir(), 'pi-factory-pack-'));
  try {
    for (const path of ['package.json', 'package-lock.json', 'AGENTS.md', 'README.md', 'bin', 'src', 'agents', 'contracts', 'examples', 'factory.config.example.json', '.pi/skills']) {
      const destination = join(temp, path);
      mkdirSync(resolve(destination, '..'), { recursive: true });
      cpSync(join(root, path), destination, { recursive: true });
    }
    for (const path of ['factory.config.json', '.env', '.npmrc', '.factory/config.json', '.factory/runs/run-1/state.json', '.pi/settings.json', 'src/credentials.json']) {
      const destination = join(temp, path);
      mkdirSync(resolve(destination, '..'), { recursive: true });
      writeFileSync(destination, path === '.npmrc' ? '# secret-canary\n' : 'secret-canary');
    }
    const manifest = JSON.parse(readFileSync(join(temp, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(join(temp, 'package-lock.json'), 'utf8'));
    assert.equal(manifest.engines.node, '>=24.12.0');
    assert.equal(manifest.bin['pi-factory'], 'bin/pi-factory.js');
    assert.ok(manifest.dependencies.ajv);
    assert.ok(manifest.dependencies.tsx);
    assert.equal(lock.packages[''].dependencies.tsx, manifest.dependencies.tsx);
    assert.equal(lock.packages[''].dependencies.ajv, manifest.dependencies.ajv);
    assert.equal(lock.packages[''].engines.node, manifest.engines.node);
    assert.match(readFileSync(join(temp, manifest.bin['pi-factory']), 'utf8'), /^#!\/usr\/bin\/env node\r?\n/);
    const output = execSync('npm pack --json --ignore-scripts', { cwd: temp, encoding: 'utf8' });
    const [pack] = JSON.parse(output) as Array<{ filename: string; files: Array<{ path: string }> }>;
    const paths = new Set(pack.files.map(file => file.path));
    for (const dir of ['src', 'agents', 'contracts', '.pi/skills']) {
      for (const file of filesUnder(join(root, dir))) {
        const path = relative(root, file).replaceAll('\\', '/');
        assert.ok(paths.has(path), `missing ${path}`);
      }
    }
    for (const path of ['bin/pi-factory.js', 'AGENTS.md', 'factory.config.example.json', 'examples/objective.md', 'package.json']) assert.ok(paths.has(path), `missing ${path}`);
    for (const path of ['factory.config.json', '.env', '.npmrc', '.factory/config.json', '.factory/runs/run-1/state.json', '.pi/settings.json', 'src/credentials.json']) assert.ok(!paths.has(path), `unexpected ${path}`);
    const installDir = join(temp, 'consumer');
    mkdirSync(installDir);
    writeFileSync(join(installDir, 'package.json'), '{"private":true}');
    execSync(`npm install --no-audit --no-fund "${join(temp, pack.filename)}"`, { cwd: installDir, encoding: 'utf8' });
    const executable = join(installDir, 'node_modules', '.bin', process.platform === 'win32' ? 'pi-factory.cmd' : 'pi-factory');
    const usage = process.platform === 'win32'
      ? execSync(`"${executable}"`, { cwd: installDir, encoding: 'utf8' })
      : execFileSync(executable, [], { cwd: installDir, encoding: 'utf8' });
    assert.match(usage, /Usage:/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
