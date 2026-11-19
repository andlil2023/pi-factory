import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

class Element {
  static active: Element | null = null;
  children: Element[] = [];
  get firstElementChild() { return this.children[0] || null; }
  static focusOptions: unknown;
  focus(options?: unknown) { Element.active = this; Element.focusOptions = options; }
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  textContent = '';
  className = '';
  open = false;
  readonly tag: string;
  constructor(tag: string) { this.tag = tag; }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren() { this.children = []; }
  contains(element: Element): boolean { return this === element || this.children.some(child => child.contains(element)); }
  listeners: Record<string, () => void> = {};
  addEventListener(name: string, listener: () => void) { this.listeners[name] = listener; }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap(child => [
      ...((selector === 'details[open]' ? child.tag === 'details' && child.open : child.tag === selector) ? [child] : []),
      ...child.querySelectorAll(selector)
    ]);
  }
}
function text(element: Element): string {
  return [element.textContent, ...element.children.map(text)].join(' ');
}

test('current report is read-only, text-only, and handles unavailable screenshots', async () => {
  const elements = Object.fromEntries(['runs', 'list-status', 'refresh', 'details', 'detail-heading', 'detail-status', 'timeline', 'connection'].map(id => [id, new Element(id)]));
  const context = {
    document: { getElementById: (id: string) => elements[id], createElement: (tag: string) => new Element(tag), activeElement: null },
    fetch: async () => ({ ok: true, json: async () => [] }), setInterval() {}, showDetails: (_entry: unknown) => {}
  };
  runInNewContext(await readFile(new URL('../src/dashboard/dashboard.js', import.meta.url), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  context.showDetails({ runId: 'run', available: true, run: { status: 'running', tasks: [], evidenceReport: {
    summary: '<script>change</script>', verification: 'failed', gaps: ['<b>gap</b>'], criteria: [
      { taskId: 'ui', criterion: 0, expected: '<img> expected', observed: 'observed', status: 'demonstrated', evidence: ['check passed'] },
      { taskId: 'other', criterion: 1, expected: 'expected', observed: 'missing', status: 'not demonstrated', evidence: ['gap'] },
      { taskId: 'third', criterion: 0, expected: 'expected', observed: 'failed', status: 'failed', evidence: ['failure'] }
    ] }, screenshots: [{ taskId: 'ui', criterion: 0, caption: '<caption>', url: '/api/runs/run/screenshots/ui/0/0' },
      { taskId: 'other', criterion: 1, caption: 'bad', url: 'https://example.com/image' }] } });
  const report = elements.details.children[1];
  assert.match(text(report), /<script>change<\/script>/);
  assert.match(text(report), /Verification outcome: failed.*<b>gap<\/b>/);
  assert.match(text(report), /Expected: <img> expected.*Observed: observed.*check passed/);
  assert.match(text(report), /not demonstrated/);
  assert.match(text(report), /failed/);
  assert.equal(report.querySelectorAll('script').length, 0);
  const images = report.querySelectorAll('img');
  assert.equal(images.length, 1);
  assert.equal((images[0] as Element & { src: string }).src, '/api/runs/run/screenshots/ui/0/0');
  assert.match(text(report), /<caption>/);
  assert.match(text(report), /Screenshot unavailable/);
  images[0].listeners.error();
  assert.equal(report.querySelectorAll('img').length, 0);
  const supporting = elements.details.querySelectorAll('details')[0];
  assert.equal(supporting.open, false);
  assert.equal(supporting.children[0].textContent, 'Supporting run details');
});

test('activity narratives are hidden while viewing a report and restored for older runs', async () => {
  const elements = Object.fromEntries(['runs', 'list-status', 'refresh', 'details', 'detail-heading', 'detail-status', 'timeline', 'connection', 'activity-panel'].map(id => [id, new Element(id)]));
  let snapshot: (event: { data: string }) => void = () => {};
  class Events {
    close() {}
    addEventListener(_type: string, listener: typeof snapshot) { snapshot = listener; }
  }
  const legacy = { runId: 'run', available: true, run: { status: 'running', tasks: [] } };
  const report = { ...legacy, run: { ...legacy.run, evidenceReport: { summary: 'Change.', verification: 'passed', gaps: [], criteria: [] } } };
  const context = {
    document: { getElementById: (id: string) => elements[id], createElement: (tag: string) => new Element(tag), activeElement: null },
    fetch: async (url: string) => ({ ok: true, json: async () => url === '/api/runs' ? [] : report }),
    EventSource: Events, setInterval() {}, showDetails: (_entry: unknown) => {}, selectRun: (_id: string) => {}
  };
  runInNewContext(await readFile(new URL('../src/dashboard/dashboard.js', import.meta.url), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  context.selectRun('run');
  assert.equal((elements['activity-panel'] as Element & { hidden: boolean }).hidden, true);
  snapshot({ data: JSON.stringify([{ timestamp: '2025-01-01', type: 'RUN_STARTED', message: 'Private process narrative' }]) });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(text(elements.timeline), /Private process narrative/);
  assert.equal((elements['activity-panel'] as Element & { hidden: boolean }).hidden, true);
  context.showDetails(legacy);
  assert.equal((elements['activity-panel'] as Element & { hidden: boolean }).hidden, false);
  context.showDetails(report);
  assert.equal((elements['activity-panel'] as Element & { hidden: boolean }).hidden, true);
  snapshot({ data: JSON.stringify([{ timestamp: '2025-01-02', type: 'RUN_UPDATED', message: 'Another narrative' }]) });
  assert.equal((elements['activity-panel'] as Element & { hidden: boolean }).hidden, true);
  assert.match(text(elements.timeline), /Another narrative/);
});

test('descriptive names, IDs and intended work render as text with narrow-layout styles', async () => {
  const elements = Object.fromEntries(['runs', 'list-status', 'refresh', 'details', 'detail-heading', 'detail-status', 'timeline', 'connection'].map(id => [id, new Element(id)]));
  const longTitle = '<img src=x>' + 'x'.repeat(200);
  const entry = { runId: '<run-id>', available: true, run: {
    label: '<b>Run name</b>', objectiveSummary: '<script>work</script>\nnext line',
    status: 'running', createdAt: '2025-01-01', updatedAt: '2025-01-02',
    tasks: [{ id: '<task-id>', title: longTitle, status: 'running' }, { id: 'fallback', status: 'pending' }]
  } };
  const context = {
    document: { getElementById: (id: string) => elements[id], createElement: (tag: string) => new Element(tag), activeElement: null },
    fetch: async () => ({ ok: true, json: async () => [entry, { runId: 'unavailable', available: false }] }),
    setInterval() {}, showDetails: (_entry: unknown) => {}
  };
  runInNewContext(await readFile(new URL('../src/dashboard/dashboard.js', import.meta.url), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  const button = elements.runs.children[0].children[0];
  assert.equal(button.children[0].textContent, entry.run.label);
  assert.equal(button.children[1].textContent, entry.runId);
  assert.equal(elements.runs.children[1].children[0].children[0].textContent, 'unavailable');
  context.showDetails(entry);
  assert.equal(elements['detail-heading'].textContent, entry.run.label);
  assert.match(text(elements.details), /<run-id>/);
  assert.match(text(elements.details), /Intended work/);
  assert.match(text(elements.details), /<script>work<\/script>/);
  const cards = elements.details.querySelectorAll('article');
  assert.equal(cards[0].children[0].children[0].children[0].textContent, longTitle);
  assert.equal(cards[0].children[0].children[0].children[1].textContent, '<task-id>');
  assert.equal(cards[1].children[0].children[0].children[0].textContent, 'fallback');
  assert.equal(elements.details.querySelectorAll('img').length, 0);
  assert.equal(elements.details.querySelectorAll('script').length, 0);
  context.showDetails({ ...entry, run: { ...entry.run, label: '', objectiveSummary: '' } });
  assert.equal(elements['detail-heading'].textContent, entry.runId);
  assert.doesNotMatch(text(elements.details), /Intended work/);
  const css = await readFile(new URL('../src/dashboard/dashboard.css', import.meta.url), 'utf8');
  assert.match(css, /\.task-name\s*\{[^}]*min-width:\s*0/);
  assert.match(css, /\.task-heading h3\s*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css, /\.display-id\s*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css, /@media\s*\(max-width:\s*640px\)/);
});

test('attempt timing updates live and keeps retry durations separate without inventing timestamps', async () => {
  const elements = Object.fromEntries(['runs', 'list-status', 'refresh', 'details', 'detail-heading', 'detail-status', 'timeline', 'connection'].map(id => [id, new Element(id)]));
  let now = Date.parse('2025-01-01T00:02:00Z');
  class Clock extends Date { static now() { return now; } }
  let tick: () => Promise<void> = async () => {};
  const context = {
    document: { getElementById: (id: string) => elements[id], createElement: (tag: string) => new Element(tag), activeElement: null },
    fetch: async () => { throw new Error('offline'); }, Date: Clock,
    setInterval(fn: () => Promise<void>) { tick = fn; }, showDetails: (_entry: unknown) => {}
  };
  runInNewContext(await readFile(new URL('../src/dashboard/dashboard.js', import.meta.url), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  const entry = { runId: 'run', available: true, run: { status: 'running', createdAt: 'a', updatedAt: 'b', tasks: [
    { id: 'retry', status: 'running', attempts: [
      { number: 1, startedAt: '2025-01-01T00:00:00Z', finishedAt: '2025-01-01T00:00:45Z' },
      { number: 2, startedAt: '2025-01-01T00:01:30Z' }
    ] },
    { id: 'invalid', status: 'running', attempts: [{ number: 1, startedAt: 'bad' }] },
    { id: 'missing', status: 'completed', attempts: [{ number: 1, finishedAt: '2025-01-01T00:01:00Z' }] },
    { id: 'bad-end', status: 'completed', attempts: [{ number: 1, startedAt: '2025-01-01T00:01:00Z', finishedAt: 'bad' }] },
    { id: 'backwards', status: 'completed', attempts: [{ number: 1, startedAt: '2025-01-01T00:01:00Z', finishedAt: '2025-01-01T00:00:00Z' }] }
  ] } };
  context.showDetails(entry);
  assert.match(text(elements.details), /Attempt 1 duration: 0h 0m 45s/);
  assert.match(text(elements.details), /Attempt 2 elapsed: 0h 0m 30s/);
  assert.equal((text(elements.details).match(/Attempt 1 timing unavailable/g) || []).length, 8);
  now += 5000;
  await tick();
  assert.match(text(elements.details), /Attempt 2 elapsed: 0h 0m 35s/);
  assert.match(text(elements.details), /Attempt 1 duration: 0h 0m 45s/);
  context.showDetails({ ...entry, run: { ...entry.run, tasks: [{ id: 'retry', status: 'completed', attempts: [
    { number: 2, startedAt: '2025-01-01T00:01:30Z', finishedAt: '2025-01-01T00:02:05Z' }
  ] }] } });
  assert.match(text(elements.details), /Attempt 2 duration: 0h 0m 35s/);
  now += 5000;
  await tick();
  assert.match(text(elements.details), /Attempt 2 duration: 0h 0m 35s/);
  assert.doesNotMatch(text(elements.details), /elapsed/);
});

test('verification progress uses only positive known totals in all contexts', async () => {
  const elements = Object.fromEntries(['runs', 'list-status', 'refresh', 'details', 'detail-heading', 'detail-status', 'timeline', 'connection'].map(id => [id, new Element(id)]));
  let now = Date.parse('2025-01-01T00:02:00Z');
  class Clock extends Date { static now() { return now; } }
  let tick: () => Promise<void> = async () => {};
  const context = {
    document: { getElementById: (id: string) => elements[id], createElement: (tag: string) => new Element(tag), activeElement: null },
    fetch: async () => ({ ok: true, json: async () => [] }), Date: Clock,
    setInterval(fn: () => Promise<void>) { tick = fn; }, showDetails: (_entry: unknown) => {}
  };
  runInNewContext(await readFile(new URL('../src/dashboard/dashboard.js', import.meta.url), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  const makeRun = (total: number | undefined) => ({ status: 'running', createdAt: 'a', updatedAt: 'b',
    finalVerificationProgress: { status: 'running', mode: 'full', completed: 1, total, failed: 0, startedAt: '2025-01-01T00:01:50Z' },
    tasks: [{ id: 'task', status: 'running', attempts: [{ number: 1, phase: 'verifying', startedAt: '2025-01-01T00:01:30Z', verificationProgress: { mode: 'selected', completed: 1, total, failed: 0 } }] }],
    integrations: [{ number: 1, status: 'running', phase: 'verifying', phaseUpdatedAt: '2025-01-01T00:01:00Z', verificationProgress: { mode: 'full', completed: 1, total, failed: 0 } }]
  });
  context.showDetails({ runId: 'run', available: true, run: makeRun(2) });
  let bars = elements.details.querySelectorAll('div').filter(item => item.attributes.role === 'progressbar');
  assert.equal(bars.length, 3);
  assert.doesNotMatch(text(elements.details), /Final verification elapsed/);
  for (const bar of bars) {
    assert.equal(bar.attributes['aria-valuenow'], '1');
    assert.equal(bar.attributes['aria-valuemax'], '2');
    assert.equal(bar.children[0].style.width, '50%');
  }
  for (const total of [0, undefined]) {
    context.showDetails({ runId: 'run', available: true, run: makeRun(total) });
    bars = elements.details.querySelectorAll('div').filter(item => item.attributes.role === 'progressbar');
    assert.equal(bars.length, 0);
    assert.doesNotMatch(text(elements.details), /% of verification|ETA|1\/0|undefined finished/);
    assert.match(text(elements.details), /Final verification: running/);
    assert.match(text(elements.details), /Final verification elapsed: 0h 0m 10s/);
    assert.match(text(elements.details), /Current phase: verifying/);
    assert.match(text(elements.details), /Attempt 1 elapsed: 0h 0m 30s/);
    assert.match(text(elements.details), /Phase: verifying · Phase started 1m ago/);
  }
  now += 5000;
  await tick();
  assert.match(text(elements.details), /Attempt 1 elapsed: 0h 0m 35s/);
  assert.match(text(elements.details), /Final verification elapsed: 0h 0m 15s/);
  const legacy = makeRun(0);
  context.showDetails({ runId: 'run', available: true, run: { ...legacy, finalVerificationProgress: { ...legacy.finalVerificationProgress, startedAt: undefined } } });
  assert.doesNotMatch(text(elements.details), /Final verification elapsed/);
  context.showDetails({ runId: 'run', available: true, run: { ...legacy, finalVerificationProgress: { ...legacy.finalVerificationProgress, startedAt: 'invalid' } } });
  assert.doesNotMatch(text(elements.details), /Final verification elapsed|NaN|ETA/);
  assert.equal(elements.details.querySelectorAll('div').filter(item => item.attributes.role === 'progressbar').length, 0);
});

test('final verification displays refreshed lifecycle and outcomes as text', async () => {
  const elements = Object.fromEntries(['runs', 'list-status', 'refresh', 'details', 'detail-heading', 'detail-status', 'timeline', 'connection'].map(id => [id, new Element(id)]));
  const context = {
    document: { getElementById: (id: string) => elements[id], createElement: (tag: string) => new Element(tag), activeElement: null },
    fetch: async () => ({ ok: true, json: async () => [] }), setInterval() {}, showDetails: (_entry: unknown) => {}
  };
  runInNewContext(await readFile(new URL('../src/dashboard/dashboard.js', import.meta.url), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  const run = { status: 'running', createdAt: 'a', updatedAt: 'b', tasks: [], finalVerificationProgress: {
    mode: 'full', completed: 1, total: 2, failed: 0, status: 'running', currentCheck: 2, checks: [{ ordinal: 1, passed: true }]
  } };
  context.showDetails({ runId: 'run', available: true, run });
  assert.match(text(elements.details), /Final verification: running/);
  assert.match(text(elements.details), /Current check: 2/);
  assert.match(text(elements.details), /Check 1: passed/);
  context.showDetails({ runId: 'run', available: true, run: { ...run, finalVerificationProgress: { ...run.finalVerificationProgress, status: 'failed', currentCheck: undefined, checks: [{ ordinal: 2, passed: false }] }, finalVerification: { passed: false, checkedAt: '<img src=x>' } } });
  assert.match(text(elements.details), /Final result: failed/);
  assert.match(text(elements.details), /Check 2: failed/);
  assert.doesNotMatch(text(elements.details), /Current check/);
  assert.match(text(elements.details), /<img src=x>/);
  assert.equal(elements.details.querySelectorAll('img').length, 0);
  context.showDetails({ runId: 'run', available: true, run: { ...run, finalVerificationProgress: { ...run.finalVerificationProgress, status: 'interrupted', currentCheck: undefined } } });
  assert.match(text(elements.details), /Final verification: interrupted/);
  context.showDetails({ runId: 'run', available: true, run: { ...run, finalVerificationProgress: undefined, finalVerification: { passed: true } } });
  assert.match(text(elements.details), /Final verification: passed/);
});

test('revisions and rerun-passed attempts render safely and only when present', async () => {
  const elements = Object.fromEntries(['runs', 'list-status', 'refresh', 'details', 'detail-heading', 'detail-status', 'timeline', 'connection'].map(id => [id, new Element(id)]));
  const context = {
    document: { getElementById: (id: string) => elements[id], createElement: (tag: string) => new Element(tag), activeElement: null },
    fetch: async () => ({ ok: true, json: async () => [] }), setInterval() {}, showDetails: (_entry: unknown) => {}
  };
  runInNewContext(await readFile(new URL('../src/dashboard/dashboard.js', import.meta.url), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  const entry = { runId: 'run', available: true, run: {
    status: 'running', createdAt: '2025-01-01', updatedAt: '2025-01-02',
    autoReplans: [{ at: '2025-02-03', taskId: '<img src=x>', reason: 'budget_exhausted', superseded: ['old'], added: ['new-1', 'new-2'], hasLeftoverPatch: true }],
    tasks: [{ id: 'task', status: 'completed', attempts: [{ number: 1, startedAt: '2025-01-01', flakyCount: 2 }] }]
  } };
  context.showDetails(entry);
  const details = elements.details;
  const revisions = details.querySelectorAll('details').find(item => item.dataset.key === 'revisions')!;
  assert.match(text(revisions), /Automatic plan revisions \(1\)/);
  for (const value of ['2025-02-03', '<img src=x>', 'Repair budget exhausted', 'old', 'new-1', 'new-2', 'Leftover patch saved']) assert.ok(text(revisions).includes(value));
  assert.equal(details.querySelectorAll('img').length, 0);
  assert.match(text(details), /Passed on rerun: 2/);
  revisions.open = true;
  context.showDetails(entry);
  assert.equal(details.querySelectorAll('details').find(item => item.dataset.key === 'revisions')!.open, true);
  context.showDetails({ ...entry, run: { ...entry.run, autoReplans: [{ ...entry.run.autoReplans[0], reason: 'task_too_large', hasLeftoverPatch: false }], tasks: [{ id: 'task', status: 'completed', attempts: [{ number: 1, startedAt: '2025-01-01', flakyCount: 0 }] }] } });
  assert.match(text(details), /Task too large/);
  assert.doesNotMatch(text(details), /Leftover patch saved|Passed on rerun/);
  context.showDetails({ ...entry, run: { ...entry.run, autoReplans: [] } });
  assert.doesNotMatch(text(details), /Automatic plan revisions/);
});

test('run details prioritize actionable cards, preserve expanded history and safely render events', async () => {
  const elements = Object.fromEntries(['runs', 'list-status', 'refresh', 'details', 'detail-heading', 'detail-status', 'timeline', 'connection'].map(id => [id, new Element(id)]));
  let snapshot: (event: { data: string }) => void = () => {};
  let closed = false;
  class Events {
    close() { closed = true; }
    addEventListener(_type: string, listener: typeof snapshot) { snapshot = listener; }
  }
  const entry = {
    runId: 'sample', available: true,
    run: {
      status: 'blocked', createdAt: '2025-01-01', updatedAt: '2025-01-02', maxAttempts: 3,
      tasks: [
        { id: 'done', status: 'completed', budgetUsed: 1, attempts: [] },
        { id: '<img src=x>', status: 'blocked', budgetUsed: 2, lastError: 'Build failed', attempts: [
          { number: 2, startedAt: '2025-01-01', outcome: 'failed', verification: { passed: false },
            blockers: [{ kind: 'decision', description: 'Choose a database', question: 'SQLite or Postgres?' }],
            reviews: [{ reviewer: 'code', verdict: 'changes_requested', findings: [{ severity: 'high', file: 'src/main.ts', line: 12, description: 'Missing validation', requiredAction: 'Validate input' }] }] }
        ] }
      ],
      integrations: [{ number: 1, status: 'blocked', phase: 'verifying', verificationProgress: {mode:'full',completed:1,total:3,failed:1}, requiredReviewers:['code'], error: 'Merge failed', verification: { passed: false } }],
      supersededTasks: [{ supersededAt: '2025-01-01', task: { id: 'old', status: 'pending', attempts: [] } }]
    }
  };
  const context = {
    document: { getElementById: (id: string) => elements[id], createElement: (tag: string) => new Element(tag), get activeElement() { return Element.active; } },
    fetch: async (url: string) => ({ ok: true, json: async () => url === '/api/runs' ? [] : entry }),
    EventSource: Events, setInterval() {},
    showDetails: (_entry: unknown) => {}, selectRun: (_id: string) => {}
  };
  runInNewContext(await readFile(new URL('../src/dashboard/dashboard.js', import.meta.url), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  context.showDetails({...entry, run:{...entry.run, tasks:[{id:'recovered',status:'blocked',attempts:[{number:1,startedAt:'2025-01-01',finishedAt:'2025-01-02',outcome:'interrupted',phase:'verifying'}]}]}});
  assert.doesNotMatch(text(elements.details), /Current phase:/);
  context.showDetails(entry);
  const details = elements.details;
  assert.match(text(details), /1\/2 Tasks accepted/);
  assert.match(text(details), /Build failed/);
  assert.match(text(details), /SQLite or Postgres/);
  assert.match(text(details), /src\/main.ts:12/);
  assert.match(text(details), /Validate input/);
  assert.match(text(details), /Final verification: not checked/);
  assert.match(text(details), /Merge failed/);
  assert.match(text(details), /Phase: verifying/);
  assert.match(text(details), /Verification commands: 1\/3 finished · full suite · 1 failed/);
  assert.match(text(details), /code: pending/);
  context.showDetails({...entry, run:{...entry.run, integrations:[{number:1,status:'blocked',phase:'stopped',failedPhase:'<img src=x>',uiEvidence:{passed:false},reviews:[]},{number:2,status:'ready',phase:'awaiting_publication',verification:{passed:true},reviews:[{reviewer:'code',verdict:'approved',findings:[]}]}]}});
  assert.match(text(details), /Failed phase: <img src=x>/);
  assert.match(text(details), /Waiting for operator publication approval/);
  assert.match(text(details), /UI evidence: failed/);
  assert.equal(details.querySelectorAll('img').length, 0);
  context.showDetails({...entry, run:{...entry.run, integrations:[{number:1,status:'ready',phase:'stopped',failedPhase:'publication_checking',error:'Publication checks failed; inspect the candidate and destination before retrying',reviews:[]}]}});
  assert.match(text(details), /Failed phase: publication checking/);
  assert.match(text(details), /Publication checks failed/);
  assert.doesNotMatch(text(details), /Waiting for operator publication approval/);
  context.showDetails(entry);
  assert.match(text(details), /Accepted on run branch/);
  context.showDetails({...entry, run:{...entry.run, status:'completed', deliveryStatus:'awaiting_integration'}});
  assert.match(text(details), /Work verified · awaiting integration/);
  context.showDetails({...entry, run:{...entry.run, deliveryStatus:'pr_opened'}});
  assert.match(text(details), /PR opened · awaiting merge/);
  context.showDetails(entry);
  assert.equal(details.querySelectorAll('article')[0].children[0].children[0].children[0].textContent, '<img src=x>');
  assert.equal(details.querySelectorAll('img').length, 0, 'untrusted values remain text');
  const history = details.querySelectorAll('details')[0];
  assert.equal(history.open, false);
  history.open = true;
  context.showDetails(entry);
  assert.equal(details.querySelectorAll('details')[0].open, true, 'polling preserves expanded history');
  const summary = details.querySelectorAll('details')[0].firstElementChild!;
  summary.focus();
  context.showDetails(entry);
  assert.notEqual(Element.active, summary);
  assert.equal(Element.active, details.querySelectorAll('details')[0].firstElementChild, 'focus follows the matching disclosure');
  assert.deepEqual({ ...(Element.focusOptions as object) }, { preventScroll: true }, 'restoring focus must not scroll the page');
  assert.equal(details.querySelectorAll('details')[0].open, true);
  context.showDetails({ ...entry, run: { ...entry.run, tasks: [] } });
  assert.equal(Element.active, elements.refresh, 'removed disclosure falls back to refresh');
  context.showDetails(entry);
  details.querySelectorAll('details')[0].firstElementChild!.focus();
  context.showDetails({ runId: 'sample', available: false });
  assert.equal(Element.active, elements.refresh, 'unavailable run falls back to refresh');
  context.selectRun('sample');
  await new Promise(resolve => setImmediate(resolve));
  const events = [
    { type: 'TASK_STARTED', timestamp: '2025-01-01', taskId: 'one' },
    { type: 'TASK_BLOCKED', timestamp: '2025-01-02', message: '<script>unsafe</script>' }
  ];
  snapshot({ data: JSON.stringify(events) });
  assert.match(text(elements.timeline.children[0]), /task blocked/);
  assert.match(text(elements.timeline.children[0]), /<script>unsafe<\/script>/);
  assert.equal(elements.timeline.querySelectorAll('script').length, 0);
  snapshot({ data: JSON.stringify(events) });
  assert.equal(elements.timeline.children.length, 2, 'reconnect snapshots do not duplicate events');
  context.selectRun('other');
  assert.equal(closed, true);
  context.showDetails({ runId: 'gone', available: false });
  assert.match(text(details), /missing or unreadable/);
  assert.doesNotMatch(text(details), /Build failed/);
});
