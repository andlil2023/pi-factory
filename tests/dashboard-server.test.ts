import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, appendFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { createDashboardServer } from '../src/dashboard-server.ts';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { collectUiEvidence } from '../src/ui-evidence.ts';
import { ContractValidator } from '../src/contract-validator.ts';
import { implementationIdentity, planIdentity } from '../src/verification-observations.ts';
import { dashboardImplementationIdentity } from '../src/dashboard-identity.ts';

test('collected linked images require current reports, authorization and unchanged bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dashboard-images-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worktree = join(root, 'worktree'); await mkdir(worktree);
  execFileSync('git', ['init'], { cwd: worktree });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'init'], { cwd: worktree });
  await writeFile(join(worktree, 'untracked.dat'), 'untracked');
  assert.equal(await dashboardImplementationIdentity(worktree), await implementationIdentity(worktree));
  const config = { directory: join(root, 'evidence'), command: { executable: process.execPath, args: [resolve('tests/fixtures/fake-ui-collector.mjs'), 'linked'] } };
  const context = { repository: worktree, taskId: 'T001', attempt: 1 };
  const validator = new ContractValidator(resolve('contracts'));
  const authorized = await collectUiEvidence({ ...config, syntheticDeveloperReviewAuthorized: true }, context, validator);
  const unauthorized = await collectUiEvidence(config, context, validator);
  assert.equal(authorized.passed, true, authorized.issues.join()); assert.equal(unauthorized.passed, true, unauthorized.issues.join());
  const plan = { tasks: [{ id: 'T001', criterionChecks: [{ criterion: 0, checks: ['Keyboard navigation'] }] }] };
  const state = { version: 1, runId: 'r', repository: root, createdAt: 'a', updatedAt: 'b', status: 'completed', plan,
    git: { worktree }, tasks: { T001: { id: 'T001', status: 'completed', attempts: [{ number: 1, startedAt: 'a', uiEvidence: authorized }] } },
    evidenceReport: { runId: 'r', identity: { plan: planIdentity(plan), specification: null as string | null, implementation: await implementationIdentity(worktree) }, summary: 'Changed.', verification: 'passed', gaps: [], criteria: [{ taskId: 'T001', criterion: 0, expected: 'Works', status: 'demonstrated', observed: 'Passed', evidence: ['Check passed'] }] } };
  const dir = join(root, '.factory', 'runs'); await mkdir(dir, { recursive: true });
  const save = () => writeFile(join(dir, 'r.json'), JSON.stringify(state)); await save();
  const server = createDashboardServer(root); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const detail = async () => (await (await fetch(`${base}/api/runs/r`)).json()) as any;
  const url = `${base}/api/runs/r/screenshots/T001/0/0`;
  assert.equal((await detail()).run.screenshots.length, 1);
  assert.equal((await fetch(url)).status, 200);
  assert.equal((await fetch(`${base}/api/runs/r/screenshots/T001/0/1`)).status, 404);
  assert.equal((await fetch(`${base}/api/runs/other/screenshots/T001/0/0`)).status, 404);
  await writeFile(join(worktree, 'untracked.dat'), 'changed implementation');
  state.evidenceReport.identity.implementation = await implementationIdentity(worktree); await save();
  assert.ok((await detail()).run.evidenceReport, 'new report is current');
  assert.equal((await detail()).run.screenshots.length, 0, 'old capture is not advertised');
  assert.equal((await fetch(url)).status, 404, 'old capture is not served');
  await writeFile(join(worktree, 'untracked.dat'), 'untracked');
  state.evidenceReport.identity.implementation = await implementationIdentity(worktree); await save();
  state.tasks.T001.attempts[0].uiEvidence = unauthorized; await save(); assert.equal((await fetch(url)).status, 404);
  state.tasks.T001.attempts[0].uiEvidence = authorized; await save();
  const captureIdentity = authorized.implementationIdentity;
  delete authorized.implementationIdentity; await save();
  assert.equal((await detail()).run.screenshots.length, 0, 'legacy capture without provenance is unavailable');
  assert.equal((await fetch(url)).status, 404);
  authorized.implementationIdentity = captureIdentity; await save();
  const image = authorized.artifacts.find(a => a.kind === 'screenshot')!;
  await writeFile(image.path, 'modified'); assert.equal((await fetch(url)).status, 404);
  image.sha256 = createHash('sha256').update('modified').digest('hex'); await save();
  assert.equal((await fetch(url)).status, 404, 'matching digest does not make invalid image bytes safe');
  state.evidenceReport.identity.plan = 'stale'; await save(); assert.equal((await detail()).run.evidenceReport, null);
  state.evidenceReport.identity.plan = planIdentity(plan); state.evidenceReport.identity.specification = 'stale'; await save(); assert.equal((await detail()).run.evidenceReport, null);
  state.evidenceReport.identity.specification = null; state.evidenceReport.identity.implementation = 'stale'; await save(); assert.equal((await detail()).run.evidenceReport, null);
  state.git.worktree = join(root, 'missing'); await save(); assert.equal((await detail()).run.evidenceReport, null);
});

test('dashboard reads never execute configured clean filters and fail closed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dashboard-filter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worktree = join(root, 'work'); await mkdir(worktree);
  execFileSync('git', ['init'], { cwd: worktree });
  await writeFile(join(worktree, '.gitattributes'), '*.txt filter=marker\n');
  await writeFile(join(worktree, 'file.txt'), 'content');
  execFileSync('git', ['add', '.'], { cwd: worktree });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init'], { cwd: worktree });
  const plan = { tasks: [] };
  const state = { version: 1, runId: 'r', repository: root, createdAt: 'a', updatedAt: 'b', status: 'completed', plan, git: { worktree }, tasks: {},
    evidenceReport: { runId: 'r', identity: { plan: planIdentity(plan), specification: null, implementation: await implementationIdentity(worktree) }, summary: 'Changed.', verification: 'passed', gaps: [], criteria: [] } };
  const dir = join(root, '.factory', 'runs'); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'r.json'), JSON.stringify(state));
  const marker = join(root, 'marker');
  const script = join(root, 'filter.cjs');
  await writeFile(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); process.stdin.pipe(process.stdout);`);
  execFileSync('git', ['config', 'filter.marker.clean', `"${process.execPath}" "${script}"`], { cwd: worktree });
  const server = createDashboardServer(root); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const detail = await (await fetch(`${base}/api/runs/r`)).json() as any;
  assert.equal(detail.run.evidenceReport, null);
  await fetch(`${base}/api/runs`);
  assert.equal((await fetch(`${base}/api/runs/r/screenshots/T001/0/0`)).status, 404);
  await assert.rejects(access(marker));
});

test('read-only HTTP projections and reconnectable bounded streams', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dashboard-http-'));
  const dir = join(root, '.factory', 'runs'); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'r.json'), JSON.stringify({ version: 1, runId: 'r', repository: root, createdAt: 'a', updatedAt: 'b', status: 'running', plan: { objective: 'Build a thing\nMore detail', tasks: [{ id: 'T001', title: 'First task', secret: 'hidden' }], secret: 'hidden' }, tasks: { T001: { id: 'T001', status: 'pending', attempts: [] } } }));
  const event = (timestamp: string) => JSON.stringify({ runId: 'r', timestamp, type: 'RUN_STARTED', details: 'hidden' }) + '\n';
  await writeFile(join(dir, 'r.events.jsonl'), event('1'));
  const server = createDashboardServer(root);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const streams: import('node:http').IncomingMessage[] = [];
  const open = (last?: string) => new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
    const req = request(`${base}/api/runs/r/live`, { headers: last ? { 'Last-Event-ID': last } : {} }, resolve); req.on('error', reject); req.end();
  });
  try {
    const runs = await fetch(`${base}/api/runs`); assert.equal(runs.status, 200);
    assert.match(runs.headers.get('content-security-policy')!, /default-src 'none'/);
    assert.equal(runs.headers.get('access-control-allow-origin'), null);
    const body = await runs.text(); assert.match(body, /running/); assert.doesNotMatch(body, /hidden/);
    assert.match(body, /Build a thing/); assert.match(body, /First task/);
    const detail = await fetch(`${base}/api/runs/r`); assert.equal(detail.status, 200);
    const detailText = await detail.text();
    assert.match(detailText, /More detail/); assert.match(detailText, /First task/);
    assert.doesNotMatch(detailText, /hidden|"plan"/);
    assert.doesNotMatch(await (await fetch(`${base}/api/runs/r/events`)).text(), /hidden/);
    assert.equal((await fetch(base)).status, 200);
    const badHost = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const req = request(`${base}/api/runs`, { headers: { Host: 'evil.test' } }, resolve); req.on('error', reject); req.end();
    });
    assert.equal(badHost.statusCode, 403); badHost.resume();
    assert.equal((await fetch(`${base}/api/runs`, { headers: { Origin: 'http://evil.test' } })).status, 403);
    assert.equal((await fetch(`${base}/api/runs`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/control`)).status, 404);
    for (const target of ['http://[', '//[']) {
      const socket = createConnection({ host: '127.0.0.1', port: address.port });
      socket.setEncoding('utf8');
      let response = '';
      socket.on('data', chunk => { response += chunk; });
      socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nConnection: close\r\n\r\n`);
      await once(socket, 'end');
      assert.match(response, /^HTTP\/1\.1 400 /);
      assert.equal((await fetch(`${base}/api/runs`)).status, 200);
    }
    const first = await open(); streams.push(first);
    const [chunk] = await once(first, 'data') as [Buffer];
    const text = chunk.toString(); const id = /id: ([a-f0-9]+)/.exec(text)?.[1]; assert.ok(id); assert.match(text, /snapshot/);
    first.destroy(); await once(first, 'close');
    const resumed = await open(id); streams.push(resumed);
    let received = ''; resumed.on('data', chunk => { received += chunk.toString(); });
    await new Promise(resolve => setTimeout(resolve, 1100)); assert.equal(received, '');
    await appendFile(join(dir, 'r.events.jsonl'), event('2'));
    await once(resumed, 'data'); assert.match(received, /"timestamp":"2"/);
    for (let i = 0; i < 19; i++) streams.push(await open());
    const rejected = await open(); assert.equal(rejected.statusCode, 503); rejected.resume();
    resumed.destroy(); await once(resumed, 'close');
    // Allow the server to observe the TCP close before opening a replacement.
    await new Promise(resolve => setTimeout(resolve, 100));
    const replacement = await open(); streams.push(replacement); assert.equal(replacement.statusCode, 200);
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } finally {
    for (const stream of streams) stream.destroy();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
