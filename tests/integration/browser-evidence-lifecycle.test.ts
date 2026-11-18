import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Cdp, withOwnedResources } from '../browser-evidence/collect-dashboard.ts';

function resources(events: string[]) {
  return {
    server: {
      listening: true,
      closeAllConnections: () => { events.push('connections'); },
      close: (callback: (error?: Error) => void) => { events.push('server'); callback(); return undefined as never; },
    },
    removeProfile: async () => { events.push('profile'); },
  };
}

test('WebSocket failure and disconnect reject and clean owned resources', { timeout: 1000 }, async () => {
  class FakeSocket extends EventTarget {
    readyState: number = WebSocket.OPEN;
    send() {}
    close() { this.readyState = WebSocket.CLOSED; this.dispatchEvent(new Event('close')); }
  }
  for (const failure of ['error', 'close'] as const) {
    const events: string[] = [];
    const socket = new FakeSocket();
    const cdp = new Cdp('ws://fake', () => socket as unknown as WebSocket);
    await assert.rejects(withOwnedResources({ ...resources(events), cdp }, async () => {
      if (failure === 'error') {
        const open = cdp.open(); socket.dispatchEvent(new Event('error')); await open;
      }
    }, async () => {
      const pending = cdp.call('Runtime.enable'); socket.dispatchEvent(new Event('close')); await pending;
    }, 20, 100), failure === 'error' ? /WebSocket connection failed/ : /connection closed/);
    assert.deepEqual(events, ['connections', 'server', 'profile']);
  }
});

test('normal cleanup closes page, browser, server and profile', { timeout: 1000 }, async () => {
  const events: string[] = [];
  const owned = {
    ...resources(events),
    child: { exitCode: null as number | null, signalCode: null, kill: () => { events.push('kill'); owned.child.exitCode = 0; return true; }, once: (() => {}) as never },
    exited: Promise.resolve(),
    cdp: { close: async () => { events.push('page'); } },
    browserCdp: { shutdownBrowser: () => { events.push('shutdown'); owned.child.exitCode = 0; }, close: async () => { events.push('browser socket'); } },
  };
  await withOwnedResources(owned, async () => { events.push('startup'); }, async () => { events.push('collect'); }, 20, 100);
  assert.deepEqual(events, ['startup', 'collect', 'page', 'shutdown', 'browser socket', 'connections', 'server', 'profile']);
});

test('startup timeout runs the collector cleanup boundary', { timeout: 1000 }, async () => {
  const events: string[] = [];
  await assert.rejects(withOwnedResources(resources(events),
    () => new Promise<void>(() => {}),
    async () => { events.push('collect'); }, 20, 20), /Collection timed out/);
  assert.deepEqual(events, ['connections', 'server', 'profile']);
});

test('collection failure closes connections and confirms browser termination', { timeout: 1000 }, async () => {
  const events: string[] = [];
  const owned = {
    ...resources(events),
    child: { exitCode: null as number | null, signalCode: null, kill: () => { events.push('kill'); owned.child.exitCode = 0; return true; }, once: (() => {}) as never },
    exited: Promise.resolve(),
    cdp: { close: async () => { events.push('page'); } },
  };
  await assert.rejects(withOwnedResources(owned, async () => {}, async () => { throw new Error('collection failed'); }, 20), /collection failed/);
  assert.deepEqual(events, ['page', 'kill', 'connections', 'server', 'profile']);
});

test('unconfirmed browser termination rejects success but still cleans remaining resources', { timeout: 1000 }, async () => {
  const events: string[] = [];
  const owned = {
    ...resources(events),
    child: { exitCode: null, signalCode: null, kill: () => { events.push('kill'); return true; }, once: (() => {}) as never },
    exited: Promise.resolve(),
    browserCdp: { shutdownBrowser: () => { events.push('shutdown'); }, close: async () => { events.push('browser socket'); } },
  };
  await assert.rejects(withOwnedResources(owned, async () => {}, async () => {}, 20), /termination not confirmed/);
  assert.deepEqual(events, ['shutdown', 'kill', 'kill', 'browser socket', 'connections', 'server', 'profile']);
});

test('stalled termination is bounded and remaining cleanup runs', { timeout: 1000 }, async () => {
  const events: string[] = [];
  const owned = { ...resources(events), child: { exitCode: null, signalCode: null, kill: () => { events.push('kill'); return true; }, once: (() => {}) as never }, exited: new Promise(() => {}) };
  await assert.rejects(withOwnedResources(owned, async () => {}, async () => { throw new Error('collection failed'); }, 20), /termination timed out/);
  assert.deepEqual(events, ['kill', 'kill', 'connections', 'server', 'profile']);
});

test('failed termination cannot keep the collector command alive', { timeout: 3000 }, () => {
  const script = `
    import { withOwnedResources, failCommand } from './tests/browser-evidence/collect-dashboard.ts';
    setInterval(() => {}, 1000);
    const child = { exitCode: null, signalCode: null, kill: () => true };
    const server = { listening: false };
    withOwnedResources({ child, server, exited: new Promise(() => {}), removeProfile: async () => {} }, async () => {}, async () => {}, 20, 100).catch(failCommand);
  `;
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { timeout: 2000, encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
});

test('collector deadline interrupts stalled collection and prevents late continuation', { timeout: 1000 }, async () => {
  const events: string[] = [];
  let resume!: () => void;
  const stalled = new Promise<void>(resolve => { resume = resolve; });
  await assert.rejects(withOwnedResources(resources(events), async () => {}, async signal => {
    await stalled;
    signal.throwIfAborted();
    events.push('late resource');
  }, 20, 20), /Collection timed out/);
  resume();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(events, ['connections', 'server', 'profile']);
});
