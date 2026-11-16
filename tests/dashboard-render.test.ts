import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

class Element {
  children: Element[] = [];
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
  addEventListener() {}
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
      integrations: [{ number: 1, status: 'blocked', error: 'Merge failed', verification: { passed: false } }],
      supersededTasks: [{ supersededAt: '2025-01-01', task: { id: 'old', status: 'pending', attempts: [] } }]
    }
  };
  const context = {
    document: { getElementById: (id: string) => elements[id], createElement: (tag: string) => new Element(tag), activeElement: null },
    fetch: async (url: string) => ({ ok: true, json: async () => url === '/api/runs' ? [] : entry }),
    EventSource: Events, setInterval() {},
    showDetails: (_entry: unknown) => {}, selectRun: (_id: string) => {}
  };
  runInNewContext(await readFile(new URL('../src/dashboard/dashboard.js', import.meta.url), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  context.showDetails(entry);
  const details = elements.details;
  assert.match(text(details), /1\/2 Tasks completed/);
  assert.match(text(details), /Build failed/);
  assert.match(text(details), /SQLite or Postgres/);
  assert.match(text(details), /src\/main.ts:12/);
  assert.match(text(details), /Validate input/);
  assert.match(text(details), /Final verification: not checked/);
  assert.match(text(details), /Merge failed/);
  assert.equal(details.querySelectorAll('article')[0].children[0].children[0].textContent, '<img src=x>');
  assert.equal(details.querySelectorAll('img').length, 0, 'untrusted values remain text');
  const history = details.querySelectorAll('details')[0];
  assert.equal(history.open, false);
  history.open = true;
  context.showDetails(entry);
  assert.equal(details.querySelectorAll('details')[0].open, true, 'polling preserves expanded history');
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
