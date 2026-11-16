import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createDashboardServer } from '../src/dashboard-server.ts';

test('refresh restores run focus or falls back when the run disappears', async () => {
  let active: Element | null = null;
  class Element {
    children: Element[] = [];
    dataset: Record<string, string> = {};
    textContent = '';
    type = '';
    constructor(_tag: string) {}
    append(...children: Element[]) { this.children.push(...children); }
    replaceChildren() { if (this.contains(active)) active = null; this.children = []; }
    contains(element: Element | null): boolean { return this === element || this.children.some(child => child.contains(element)); }
    focus() { active = this; }
    addEventListener() {}
  }
  const elements = Object.fromEntries(['runs', 'list-status', 'refresh', 'details', 'detail-status', 'timeline', 'connection'].map(id => [id, new Element(id)]));
  let runs = [{ runId: 'one', available: false }, { runId: 'two', available: false }];
  let interval: () => Promise<void> = async () => {};
  const document = { getElementById: (id: string) => elements[id], createElement: (tag: string) => new Element(tag), get activeElement() { return active; } };
  const source = await readFile(new URL('../src/dashboard/dashboard.js', import.meta.url), 'utf8');
  runInNewContext(source, { document, fetch: async () => ({ ok: true, json: async () => runs }), setInterval: (fn: () => Promise<void>) => { interval = fn; } });
  // Let the initial async fetch finish.
  await new Promise(resolve => setImmediate(resolve));
  elements.runs.children[1].children[0].focus();
  await interval();
  assert.equal(active, elements.runs.children[1].children[0]);
  runs = [runs[0]];
  await interval();
  assert.equal(active, elements.refresh);
  elements.runs.children[0].children[0].focus();
  elements.refresh.focus();
  await interval();
  assert.equal(active, elements.refresh, 'refresh must not steal focus from another control');
});

test('serves dashboard assets and fixture projections without a browser', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dashboard-ui-'));
  const dir = join(root, '.factory', 'runs');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'sample.json'), JSON.stringify({ version: 1, runId: 'sample', repository: root, createdAt: '2025-01-01', updatedAt: '2025-01-02', status: 'running', plan: {}, tasks: {} }));
  await writeFile(join(dir, 'broken.json'), '{');
  await writeFile(join(dir, 'sample.events.jsonl'), JSON.stringify({ runId: 'sample', timestamp: '2025-01-02', type: 'RUN_STARTED', message: '<img src=x>' }) + '\n');
  const server = createDashboardServer(root);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const html = await (await fetch(base)).text();
    assert.match(html, /<main>/); assert.match(html, /<button/); assert.match(html, /dashboard\.js/);
    const jsResponse = await fetch(`${base}/dashboard.js`);
    assert.match(jsResponse.headers.get('content-type')!, /javascript/);
    const js = await jsResponse.text();
    assert.match(js, /textContent/); assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML/);
    assert.match(js, /timeline\.replaceChildren\(\)/); assert.match(js, /last persisted state/);
    assert.equal((await fetch(`${base}/dashboard.css`)).status, 200);
    const runs = await (await fetch(`${base}/api/runs`)).json() as Array<{ runId: string; available: boolean }>;
    assert.deepEqual(runs.map(({ runId, available }) => [runId, available]), [['broken', false], ['sample', true]]);
    const events = await (await fetch(`${base}/api/runs/sample/events`)).json() as Array<{ message: string }>;
    assert.equal(events[0].message, '<img src=x>');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
