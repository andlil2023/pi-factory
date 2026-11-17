import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDashboardServer } from '../../src/dashboard-server.ts';

const deadline = Date.now() + 120_000;
const remaining = () => { const ms = deadline - Date.now(); if (ms <= 0) throw new Error('Collection deadline exceeded'); return Math.min(ms, 5000); };
const sleep = (ms: number) => bounded(new Promise<void>(r => setTimeout(r, ms)), remaining(), 'Collection');
export async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); })]); }
  finally { clearTimeout(timer); }
}

async function browserPath(): Promise<string> {
  const override = process.env.FACTORY_BROWSER_EXECUTABLE;
  if (override) { try { await access(override); return override; } catch { throw new Error('FACTORY_BROWSER_EXECUTABLE is not accessible; supply an installed Chromium or Edge executable'); } }
  const candidates = process.platform === 'win32' ? [
    join(process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
    join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
    join(process.env.LOCALAPPDATA || homedir(), 'Google/Chrome/Application/chrome.exe')
  ] : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/microsoft-edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
  for (const root of [join(homedir(), '.cache', 'ms-playwright'), join(process.env.LOCALAPPDATA || homedir(), 'ms-playwright')]) {
    try { for (const name of (await readdir(root)).filter(n => /^chromium-\d+$/.test(n)).sort().reverse().slice(0, 10)) candidates.push(join(root, name, process.platform === 'win32' ? 'chrome-win/chrome.exe' : 'chrome-linux/chrome')); } catch { /* optional cache */ }
  }
  for (const path of candidates) try { await access(path); return path; } catch { /* next */ }
  throw new Error('No installed Chromium or Edge found; set FACTORY_BROWSER_EXECUTABLE to its executable');
}

class Cdp {
  private socket: WebSocket;
  private next = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.addEventListener('message', event => {
      const data = JSON.parse(String(event.data));
      const pending = this.pending.get(data.id);
      if (pending) { this.pending.delete(data.id); data.error ? pending.reject(new Error('Browser protocol request failed')) : pending.resolve(data.result); }
    });
    this.socket.addEventListener('close', () => { for (const p of this.pending.values()) p.reject(new Error('Browser connection closed')); this.pending.clear(); });
  }
  async open() { await bounded(new Promise<void>((resolve, reject) => { this.socket.addEventListener('open', () => resolve(), { once: true }); this.socket.addEventListener('error', () => reject(new Error('Browser WebSocket connection failed')), { once: true }); }), 5000, 'Browser WebSocket'); }
  async call(method: string, params: object = {}): Promise<any> {
    const id = ++this.next;
    try { return await bounded(new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })); }), remaining(), 'Browser protocol request'); }
    finally { this.pending.delete(id); }
  }
  shutdownBrowser() { this.socket.send(JSON.stringify({ id: ++this.next, method: 'Browser.close' })); }
  async close() { if (this.socket.readyState === WebSocket.CLOSED) return; const closed = new Promise<void>(resolve => this.socket.addEventListener('close', () => resolve(), { once: true })); this.socket.close(); await bounded(closed, 3000, 'Browser connection close'); }
}

export async function terminate(child: Pick<ChildProcess, 'exitCode' | 'signalCode' | 'kill' | 'once'>, exited: Promise<unknown>, graceMs = 5000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  try { await bounded(exited, graceMs, 'Browser graceful termination'); } catch { /* escalate */ }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await bounded(exited, graceMs, 'Browser termination');
  }
  if (child.exitCode === null && child.signalCode === null) throw new Error('Browser termination not confirmed');
}

type OwnedResources = {
  server: Pick<ReturnType<typeof createDashboardServer>, 'listening' | 'closeAllConnections' | 'close'>;
  child?: Pick<ChildProcess, 'exitCode' | 'signalCode' | 'kill' | 'once'>;
  exited?: Promise<unknown>;
  cdp?: Pick<Cdp, 'close'>;
  browserCdp?: Pick<Cdp, 'close' | 'shutdownBrowser'>;
  removeProfile: () => Promise<void>;
};

// Both the collector and lifecycle tests use this ownership boundary.
export async function withOwnedResources(resources: OwnedResources, startup: (signal: AbortSignal) => Promise<void>, collect: (signal: AbortSignal) => Promise<void>, timeoutMs = 5000, collectionMs = 120_000): Promise<void> {
  const controller = new AbortController();
  try {
    await bounded((async () => {
      await startup(controller.signal);
      controller.signal.throwIfAborted();
      await collect(controller.signal);
      controller.signal.throwIfAborted();
    })(), collectionMs, 'Collection');
  } finally {
    controller.abort();
    let cleanupError: unknown;
    try { if (resources.cdp) await bounded(resources.cdp.close(), timeoutMs, 'Browser connection close'); } catch (e) { cleanupError = e; }
    try {
      const { child, exited, browserCdp } = resources;
      if (child && exited) {
        if (browserCdp && child.exitCode === null && child.signalCode === null) {
          try { browserCdp.shutdownBrowser(); await bounded(exited, timeoutMs, 'Browser graceful shutdown'); } catch { /* terminate below */ }
        }
        await terminate(child, exited, timeoutMs);
      }
    } catch (e) { cleanupError = e; }
    try { if (resources.browserCdp) await bounded(resources.browserCdp.close(), timeoutMs, 'Browser connection close'); } catch (e) { cleanupError = e; }
    try { if (resources.server.listening) { resources.server.closeAllConnections(); await bounded(new Promise<void>((resolve, reject) => resources.server.close(error => error ? reject(error) : resolve())), timeoutMs, 'Dashboard close'); } } catch (e) { cleanupError = e; }
    try { await bounded(resources.removeProfile(), timeoutMs, 'Profile removal'); } catch (e) { cleanupError = e; }
    if (cleanupError) throw cleanupError;
  }
}

async function run(): Promise<void> {
  const output = process.env.FACTORY_UI_EVIDENCE_DIRECTORY;
  const taskId = process.env.FACTORY_TASK_ID, attempt = Number(process.env.FACTORY_ATTEMPT), fingerprint = process.env.FACTORY_SOURCE_FINGERPRINT;
  if (!output || !taskId || !/^T\d{3,}$/.test(taskId) || !Number.isSafeInteger(attempt) || attempt < 1 || !fingerprint || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('Collector requires factory evidence context environment variables');
  let executable: string, temp: string, server: ReturnType<typeof createDashboardServer>;
  const resources: OwnedResources = { server: { listening: false, closeAllConnections: () => {}, close: (() => {}) as never }, removeProfile: async () => { if (temp) await rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } };
  let child: ChildProcess, cdp: Cdp, browserCdp: Cdp;
  await withOwnedResources(resources, async signal => {
    executable = await browserPath(); signal.throwIfAborted();
    // A late mkdtemp result must not leave an orphaned profile directory.
    const created = mkdtemp(join(tmpdir(), 'factory-browser-'));
    void created.then(path => { if (signal.aborted) void rm(path, { recursive: true, force: true }).catch(() => {}); }, () => {});
    temp = await created; signal.throwIfAborted();
    server = createDashboardServer(temp); resources.server = server;
    const runs = join(temp, '.factory', 'runs'); await mkdir(runs, { recursive: true }); signal.throwIfAborted();
    await copyFile(resolve('tests/browser-evidence/fixture.json'), join(runs, 'synthetic.json')); signal.throwIfAborted();
    server.listen(0, '127.0.0.1');
    server.once('listening', () => { if (signal.aborted && server.listening) { server.closeAllConnections(); server.close(); } });
    await bounded(once(server, 'listening'), 5000, 'Dashboard startup'); signal.throwIfAborted();
  }, async signal => {
    signal.throwIfAborted();
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Dashboard startup failed');
    child = spawn(executable, ['--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${join(temp, 'profile')}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore', windowsHide: true });
    resources.child = child;
    resources.exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
    const active = join(temp, 'profile', 'DevToolsActivePort');
    let port = '', browserPath = '';
    for (let i = 0; i < 100; i++) { try { [port, browserPath] = (await readFile(active, 'utf8')).split('\n'); if (port && browserPath) break; } catch { /* still starting */ } if (child.exitCode !== null || child.signalCode !== null) throw new Error('Browser exited during startup'); await sleep(100); }
    if (!/^\d+$/.test(port) || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(browserPath)) throw new Error('Browser startup timed out; check the installed browser and sandbox prerequisites');
    signal.throwIfAborted();
    browserCdp = new Cdp(`ws://127.0.0.1:${port}${browserPath}`); resources.browserCdp = browserCdp; await browserCdp.open(); signal.throwIfAborted();
    const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(`http://127.0.0.1:${address.port}/`)}`, { method: 'PUT', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Browser target startup failed');
    const target = await bounded(response.json(), remaining(), 'Browser target response') as { webSocketDebuggerUrl: string };
    const ws = new URL(target.webSocketDebuggerUrl); if (ws.protocol !== 'ws:' || ws.hostname !== '127.0.0.1' || ws.port !== port) throw new Error('Browser returned a non-loopback endpoint');
    signal.throwIfAborted();
    cdp = new Cdp(ws.href); resources.cdp = cdp; await cdp.open(); signal.throwIfAborted();
    await cdp.call('Page.enable'); await cdp.call('Runtime.enable');
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      const value = await cdp.call('Runtime.evaluate', { expression: "document.querySelector('[data-run-id=synthetic]') !== null", returnByValue: true });
      if (value.result?.value) { ready = true; break; } await sleep(100);
    }
    if (!ready) throw new Error('Synthetic dashboard run did not load');
    await cdp.call('Runtime.evaluate', { expression: "document.querySelector('[data-run-id=synthetic]').click()" });
    let selected = false;
    for (let i = 0; i < 100; i++) {
      const value = await cdp.call('Runtime.evaluate', { expression: "document.getElementById('detail-heading').textContent === 'Synthetic dashboard evidence' && document.getElementById('details').textContent.includes('Example task')", returnByValue: true });
      if (value.result?.value) { selected = true; break; } await sleep(100);
    }
    if (!selected) throw new Error('Synthetic run selection did not complete');
    const tree = await cdp.call('Accessibility.getFullAXTree');
    if (!Array.isArray(tree.nodes) || !tree.nodes.some((n: any) => n.role?.value === 'button' && n.name?.value)) throw new Error('Accessibility tree has no named button');
    const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png' });
    signal.throwIfAborted();
    await writeFile(join(output, 'desktop.png'), Buffer.from(screenshot.data, 'base64'), { signal }); signal.throwIfAborted();
    await writeFile(join(output, 'accessibility.json'), JSON.stringify(tree, null, 2), { signal }); signal.throwIfAborted();
  });
  await bounded(writeFile(join(output, 'manifest.json'), JSON.stringify({ version: 1, taskId, attempt, capturedAt: new Date().toISOString(), sourceFingerprint: fingerprint, application: { framework: 'dashboard HTML/JavaScript', buildId: fingerprint }, checks: [{ kind: 'interaction', name: 'Select synthetic run', status: 'passed' }, { kind: 'accessibility', name: 'Browser tree contains a named button', status: 'passed' }], artifacts: [{ kind: 'screenshot', path: 'desktop.png' }, { kind: 'accessibility-tree', path: 'accessibility.json' }], limitations: ['One desktop viewport and one selection; the accessibility tree check is not an accessibility audit or certification.'] }, null, 2), { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) }), Math.max(1, deadline - Date.now()), 'Manifest write');
}

export function failCommand(): never {
  console.error('Dashboard collector failed. Check the installed browser, FACTORY_BROWSER_EXECUTABLE, sandbox prerequisites, and disposable profile permissions.');
  // A failed child may still hold a referenced handle after escalation. Do not
  // let it consume the external timeout; failed cleanup is never success.
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) run().catch(failCommand);
