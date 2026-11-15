import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FactoryEventBus } from '../src/event-bus.ts';

test('adds run ID and timestamp, and notifies subscribers', async () => {
  const bus = new FactoryEventBus({ runId: 'run-1', consoleOutput: false, clock: () => new Date('2026-11-15T20:00:00Z') });
  const seen: string[] = [];
  const unsubscribe = bus.subscribe(event => seen.push(event.type));
  const event = bus.emit({ type: 'TASK_STARTED', taskId: 'T001' });
  assert.equal(event.runId, 'run-1');
  assert.equal(event.timestamp, '2026-11-15T20:00:00.000Z');
  assert.deepEqual(seen, ['TASK_STARTED']);
  unsubscribe();
  bus.emit({ type: 'TASK_COMPLETED', taskId: 'T001' });
  assert.deepEqual(seen, ['TASK_STARTED']);
  await bus.close();
});

test('persists JSONL events in emission order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-events-'));
  try {
    const path = join(dir, 'nested', 'events.jsonl');
    const bus = new FactoryEventBus({ runId: 'run-2', logFile: path, consoleOutput: false });
    bus.emit({ type: 'RUN_STARTED' });
    bus.emit({ type: 'TASK_STARTED', taskId: 'T001', attempt: 1 });
    bus.emit({ type: 'REVIEW_APPROVED', taskId: 'T001', agent: 'code' });
    await bus.close();
    const lines = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(lines.map(x => x.type), ['RUN_STARTED', 'TASK_STARTED', 'REVIEW_APPROVED']);
    assert.ok(lines.every(x => x.runId === 'run-2'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('listener errors do not interrupt event emission', async () => {
  const bus = new FactoryEventBus({ runId: 'run-3', consoleOutput: false });
  bus.subscribe(() => { throw new Error('observer failed'); });
  assert.equal(bus.emit({ type: 'RUN_STARTED' }).type, 'RUN_STARTED');
  await bus.close();
});

test('rejects events after close', async () => {
  const bus = new FactoryEventBus({ runId: 'run-4', consoleOutput: false });
  await bus.close();
  assert.throws(() => bus.emit({ type: 'RUN_STARTED' }), /closed/);
});
