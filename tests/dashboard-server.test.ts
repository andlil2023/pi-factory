import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { createDashboardServer } from '../src/dashboard-server.ts';

test('read-only HTTP projections and reconnectable bounded streams', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dashboard-http-'));
  const dir = join(root, '.factory', 'runs'); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'r.json'), JSON.stringify({ version: 1, runId: 'r', repository: root, createdAt: 'a', updatedAt: 'b', status: 'running', plan: { secret: 'hidden' }, tasks: {} }));
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
    assert.equal((await fetch(`${base}/api/runs/r`)).status, 200);
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
