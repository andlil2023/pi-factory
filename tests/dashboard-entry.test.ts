import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('packaged entry point serves dashboard assets and selected repository outside checkout', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dashboard-entry-'));
  try {
    const pkg = join(temp, 'node_modules', 'pi-factory');
    await mkdir(pkg, { recursive: true });
    for (const item of ['bin', 'src', 'contracts', 'package.json']) {
      await cp(join(root, item), join(pkg, item), { recursive: true });
    }
    await symlink(join(root, 'node_modules'), join(pkg, 'node_modules'), 'junction');
    const cwd = join(temp, 'caller'); const target = join(temp, 'target');
    await mkdir(cwd); await mkdir(join(target, '.factory', 'runs'), { recursive: true });
    await writeFile(join(target, '.factory', 'runs', 'selected.json'), JSON.stringify({ version: 1, runId: 'selected', repository: target, createdAt: 'a', updatedAt: 'b', status: 'running', plan: { objective: 'Selected repository', tasks: [] }, tasks: {} }));
    const entry = join(pkg, 'bin', 'pi-factory.js');
    for (const args of [[], ['--repo', target, '--port', '0'], ['--repo', target, '--port', 'abc'], ['--repo', target, '--port'], ['--repo', target, '--host', '0.0.0.0']]) {
      const result = spawnSync(process.execPath, [entry, 'dashboard', ...args], { cwd, encoding: 'utf8' });
      assert.notEqual(result.status, 0, `unexpected success: ${args.join(' ')}`);
    }
    const probe = createServer();
    probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
    const address = probe.address(); assert.ok(address && typeof address !== 'string');
    const port = address.port;
    await new Promise<void>((resolveClose, reject) => probe.close(error => error ? reject(error) : resolveClose()));
    const child = spawn(process.execPath, [entry, 'dashboard', '--repo', target, '--port', String(port)], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let errors = '';
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { errors += chunk; });
    try {
      await new Promise<void>((resolveReady, reject) => {
        const timer = setTimeout(() => reject(new Error(`dashboard startup timed out: ${errors}`)), 10000);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => { output += chunk; if (output.includes('Dashboard:')) { clearTimeout(timer); resolveReady(); } });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`dashboard exited ${code}: ${errors}`)); });
      });
      assert.match(output, new RegExp(`http://127\\.0\\.0\\.1:${port}/`));
      const base = `http://127.0.0.1:${port}`;
      for (const [route, file, contentType] of [['/', 'dashboard.html', 'text/html'], ['/dashboard.js', 'dashboard.js', 'text/javascript'], ['/dashboard.css', 'dashboard.css', 'text/css']]) {
        const response = await fetch(base + route);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type')!, new RegExp(contentType));
        assert.equal(await response.text(), await readFile(join(pkg, 'src', 'dashboard', file), 'utf8'));
      }
      assert.match(await (await fetch(`${base}/api/runs`)).text(), /Selected repository/);
      assert.equal((await fetch(`${base}/api/runs`, { method: 'POST' })).status, 405);
      assert.equal((await fetch(`${base}/api/runs`, { headers: { Origin: 'http://evil.test' } })).status, 403);
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
