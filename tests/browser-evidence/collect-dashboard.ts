import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDashboardServer } from '../../src/dashboard-server.ts';
import { planIdentity } from '../../src/verification-observations.ts';
import { dashboardImplementationIdentity } from '../../src/dashboard-identity.ts';

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

export class Cdp {
  private socket: WebSocket;
  private next = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  constructor(url: string, createSocket: (url: string) => WebSocket = url => new WebSocket(url)) {
    this.socket = createSocket(url);
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

// A legacy host rejects unknown manifest properties. This capability is independent
// of permission to display synthetic images, which only the host can grant.
export function dashboardImageLinks(capability: string | undefined) {
  return capability === '1' ? { imageLinks: [{ checkName: 'Keyboard selection, disclosure, refresh and focus restoration; persisted task, check and phase', screenshotPath: 'dashboard-1440.png', caption: 'Synthetic populated report after keyboard interaction' }] } : {};
}

async function run(): Promise<void> {
  const output = process.env.FACTORY_UI_EVIDENCE_DIRECTORY;
  const taskId = process.env.FACTORY_TASK_ID, attempt = Number(process.env.FACTORY_ATTEMPT), fingerprint = process.env.FACTORY_SOURCE_FINGERPRINT;
  if (!output || !taskId || !/^T\d{3,}$/.test(taskId) || !Number.isSafeInteger(attempt) || attempt < 1 || !fingerprint || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('Collector requires factory evidence context environment variables');
  let executable: string, temp: string, server: ReturnType<typeof createDashboardServer>;
  const resources: OwnedResources = { server: { listening: false, closeAllConnections: () => {}, close: (() => {}) as never }, removeProfile: async () => { if (temp) await rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } };
  let child: ChildProcess, cdp: Cdp, browserCdp: Cdp;
  let collectedArtifacts: { kind: string; path: string }[] = [];
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
    const evaluate = async (expression: string) => (await cdp.call('Runtime.evaluate', { expression, returnByValue: true })).result?.value;
    const key = async (key: string, code: string, windowsVirtualKeyCode: number) => {
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode });
      await cdp.call('Input.dispatchKeyEvent', { type: 'char', key, code, text: '\r', windowsVirtualKeyCode });
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
    };
    await evaluate("document.querySelector('[data-run-id=synthetic]').focus()");
    await key('Enter', 'Enter', 13);
    let selected = false;
    for (let i = 0; i < 100; i++) {
      const value = await cdp.call('Runtime.evaluate', { expression: "document.getElementById('detail-heading').textContent === 'Synthetic dashboard evidence' && ['Example task', 'Current phase: verification', 'Verification: passed', 'Verification commands: 1/2 finished'].every(s => document.getElementById('details').textContent.includes(s))", returnByValue: true });
      if (value.result?.value) { selected = true; break; } await sleep(100);
    }
    if (!selected) throw new Error('Synthetic run selection did not complete');
    // Keyboard-operate the existing disclosure and refresh control.
    await evaluate("document.querySelector('summary').focus()");
    await key('Enter', 'Enter', 13);
    if (!await evaluate("document.querySelector('details').open")) throw new Error('Keyboard disclosure failed');
    // Attribute the request to the trusted keyboard click, not the automatic poll.
    await evaluate(`(() => {
      const button = document.getElementById('refresh');
      const originalFetch = window.fetch;
      window.__keyboardRefresh = { requests: 0, previousRun: document.querySelector('[data-run-id=synthetic]') };
      let keyboardClick = false;
      button.addEventListener('click', event => {
        if (event.isTrusted && event.detail === 0) {
          keyboardClick = true;
          setTimeout(() => { keyboardClick = false; }, 0);
        }
      }, { capture: true, once: true });
      window.fetch = function(input, init) {
        if (keyboardClick && input === '/api/runs') window.__keyboardRefresh.requests++;
        return originalFetch.call(this, input, init);
      };
      window.__restoreFetch = () => { window.fetch = originalFetch; };
      button.focus();
    })()`);
    await key('Enter', 'Enter', 13);
    let keyboardRefreshed = false;
    for (let i = 0; i < 100; i++) {
      if (await evaluate("window.__keyboardRefresh.requests === 1 && !window.__keyboardRefresh.previousRun.isConnected && document.querySelector('[data-run-id=synthetic]') !== null")) { keyboardRefreshed = true; break; }
      await sleep(100);
    }
    await evaluate('window.__restoreFetch()');
    if (!keyboardRefreshed) throw new Error('Keyboard refresh did not complete');
    // Separately verify restoration of run-list focus after a manual refresh.
    await evaluate("document.querySelector('[data-run-id=synthetic]').focus(); window.__previousRun = document.activeElement; document.getElementById('refresh').click()");
    let restored = false;
    for (let i = 0; i < 100; i++) {
      if (await evaluate("document.activeElement !== window.__previousRun && document.activeElement?.dataset.runId === 'synthetic'")) { restored = true; break; }
      await sleep(100);
    }
    if (!restored) throw new Error('Run focus was not restored after refresh');
    await evaluate("document.querySelector('#details summary').focus(); window.__previousSummary = document.activeElement; document.getElementById('refresh').click()");
    let disclosureRestored = false;
    for (let i = 0; i < 100; i++) {
      if (await evaluate("document.activeElement !== window.__previousSummary && document.activeElement === document.querySelector('#details summary') && document.activeElement.parentElement.open")) { disclosureRestored = true; break; }
      await sleep(100);
    }
    if (!disclosureRestored) throw new Error('Disclosure focus and open state were not restored after refresh');

    // Keep the legacy run above, and create a separate revision-bound report. Its
    // linked image is a real capture of that synthetic run, served by the normal
    // authorization, digest and image-type checks rather than injected into DOM.
    const worktree = join(temp, 'worktree'); await mkdir(worktree);
    execFileSync('git', ['init', '-q'], { cwd: worktree });
    execFileSync('git', ['-c', 'user.name=Evidence', '-c', 'user.email=evidence@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'Synthetic'], { cwd: worktree });
    const imageDir = join(temp, 'synthetic-evidence'); await mkdir(imageDir);
    const imagePath = join(imageDir, 'legacy.png');
    const image = Buffer.from((await cdp.call('Page.captureScreenshot', { format: 'png' })).data, 'base64');
    await writeFile(imagePath, image);
    const fixture = JSON.parse(await readFile(resolve('tests/browser-evidence/fixture.json'), 'utf8'));
    const checkName = 'Synthetic dashboard interaction';
    fixture.runId = 'report';
    fixture.plan.objective = 'Synthetic populated report';
    fixture.plan.tasks[0].acceptanceCriteria = ['Show the synthetic dashboard.', 'Demonstrate an unsupported behavior.'];
    fixture.plan.tasks[0].criterionChecks = [{ criterion: 0, checks: [checkName] }];
    fixture.git = { worktree };
    fixture.tasks.T001.attempts[0].uiEvidence = {
      passed: true, syntheticDeveloperReviewAuthorized: true, directory: imageDir,
      manifest: { taskId: 'T001', attempt: 1, checks: [{ name: checkName, status: 'passed' }],
        artifacts: [{ kind: 'screenshot', path: 'legacy.png' }],
        imageLinks: [{ checkName, screenshotPath: 'legacy.png', caption: 'Synthetic dashboard before report selection' }] },
      artifacts: [{ kind: 'screenshot', path: await realpath(imagePath), imageType: 'image/png', sha256: createHash('sha256').update(image).digest('hex') }]
    };
    fixture.evidenceReport = { runId: 'report', identity: { plan: planIdentity(fixture.plan), specification: null, implementation: await dashboardImplementationIdentity(worktree) },
      summary: 'The dashboard presents a read-only evidence report.', verification: 'passed', gaps: ['A separate criterion has no direct evidence.'],
      criteria: [
        { taskId: 'T001', criterion: 0, expected: 'Show the synthetic dashboard.', observed: 'The dashboard was captured.', status: 'demonstrated', evidence: ['Synthetic dashboard interaction passed.'] },
        { taskId: 'T001', criterion: 1, expected: 'Demonstrate an unsupported behavior.', observed: 'No direct check was recorded.', status: 'not demonstrated', evidence: ['No matching check.'] }
      ] };
    const runs = join(temp, '.factory', 'runs');
    await writeFile(join(runs, 'report.json'), JSON.stringify(fixture));
    await writeFile(join(runs, 'report.events.jsonl'), JSON.stringify({ runId: 'report', timestamp: '2026-01-01T00:00:00Z', type: 'RUN_STARTED', message: 'Synthetic process narrative must remain hidden' }) + '\n');
    await evaluate("document.getElementById('refresh').click()");
    for (let i = 0; i < 100 && !await evaluate("!!document.querySelector('[data-run-id=report]')"); i++) await sleep(100);
    if (!await evaluate("!!document.querySelector('[data-run-id=report]')")) throw new Error('Report run did not load');
    await evaluate("document.querySelector('[data-run-id=report]').focus()"); await key('Enter', 'Enter', 13);
    let reportReady = false;
    for (let i = 0; i < 100; i++) {
      reportReady = Boolean(await evaluate(`(() => {
        const details = document.getElementById('details');
        const cards = details.querySelectorAll('.report-criterion');
        const img = cards[0]?.querySelector('figure img');
        return cards.length === 2 && cards[0].textContent.includes('Expected: Show the synthetic dashboard.') &&
          cards[0].querySelector('.badge')?.textContent === 'demonstrated' &&
          cards[0].querySelector('figcaption')?.textContent === 'Synthetic dashboard before report selection' &&
          cards[1].textContent.includes('Expected: Demonstrate an unsupported behavior.') &&
          cards[1].querySelector('.badge')?.textContent === 'not demonstrated' &&
          !cards[1].querySelector('img') && cards[1].textContent.includes('Screenshot unavailable.') &&
          details.textContent.includes('The dashboard presents a read-only evidence report.') &&
          details.textContent.includes('Verification outcome: passed') && details.textContent.includes('A separate criterion has no direct evidence.') &&
          details.textContent.includes('demonstrated') && details.textContent.includes('not demonstrated') &&
          details.textContent.includes('Screenshot unavailable.') && details.textContent.includes('Synthetic dashboard before report selection') &&
          img && img.complete && img.naturalWidth > 0 && img.getAttribute('src').startsWith('/api/runs/report/screenshots/') &&
          document.getElementById('activity-panel').hidden && document.getElementById('timeline').textContent.includes('Synthetic process narrative must remain hidden');
      })()`));
      if (reportReady) break; await sleep(100);
    }
    if (!reportReady) throw new Error('Populated report, image, gaps, statuses or hidden activity did not load');
    // The same screenshot that was rendered must fail closed if its bytes change.
    const screenshotUrl = `http://127.0.0.1:${address.port}/api/runs/report/screenshots/T001/0/0`;
    if ((await fetch(screenshotUrl)).status !== 200) throw new Error('Associated screenshot was not served');
    await writeFile(imagePath, Buffer.concat([image, Buffer.from('tampered')]));
    if ((await fetch(screenshotUrl)).status !== 404) throw new Error('Modified screenshot was served');
    await writeFile(imagePath, image);
    if (!await evaluate("!document.querySelector('#details details').open")) throw new Error('Supporting details must start collapsed');
    await evaluate("document.querySelector('#details summary').focus()"); await key('Enter', 'Enter', 13);
    if (!await evaluate("document.querySelector('#details details').open")) throw new Error('Report supporting details are not keyboard accessible');
    await key('Enter', 'Enter', 13);
    if (!await evaluate("!document.querySelector('#details details').open")) throw new Error('Report supporting details did not collapse');
    await evaluate('window.scrollTo(0, 0)');
    const artifacts: { kind: string; path: string }[] = [];
    for (const width of [1440, 768, 390]) {
      await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await sleep(100);
      if (!await evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth')) throw new Error(`Horizontal overflow at ${width}px`);
      const tree = await cdp.call('Accessibility.getFullAXTree');
      if (!Array.isArray(tree.nodes) || !['Refresh now', 'Synthetic populated report'].every(name => tree.nodes.some((n: any) => n.role?.value === 'button' && n.name?.value?.includes(name))) || !tree.nodes.some((n: any) => n.name?.value?.includes('Supporting run details')) || !tree.nodes.some((n: any) => n.name?.value?.includes('Synthetic dashboard before report selection'))) throw new Error(`Report accessibility content missing at ${width}px`);
      // Include the entire report at narrow widths, where its criteria fall below
      // the run list and would otherwise be outside the viewport capture.
      const metrics = await cdp.call('Page.getLayoutMetrics');
      const size = metrics.cssContentSize;
      const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 } });
      signal.throwIfAborted();
      await writeFile(join(output, `dashboard-${width}.png`), Buffer.from(screenshot.data, 'base64'), { signal });
      await writeFile(join(output, `accessibility-${width}.json`), JSON.stringify(tree, null, 2), { signal });
      artifacts.push({ kind: 'screenshot', path: `dashboard-${width}.png` }, { kind: 'accessibility-tree', path: `accessibility-${width}.json` });
    }
    collectedArtifacts = artifacts;
  });
  await bounded(writeFile(join(output, 'manifest.json'), JSON.stringify({ version: 1, taskId, attempt, capturedAt: new Date().toISOString(), sourceFingerprint: fingerprint, application: { framework: 'dashboard HTML/JavaScript', buildId: fingerprint }, checks: [{ kind: 'interaction', name: 'Keyboard selection, disclosure, refresh and focus restoration; persisted task, check and phase', status: 'passed' }, { kind: 'accessibility', name: 'Named controls and no document overflow at 1440, 768 and 390 pixels', status: 'passed' }, { kind: 'interaction', name: 'Current report summary, gaps, statuses, served captioned image, unavailable image and hidden activity', status: 'passed' }], artifacts: collectedArtifacts, ...dashboardImageLinks(process.env.FACTORY_UI_EVIDENCE_IMAGE_LINKS), limitations: ['Synthetic persisted run and selected keyboard interactions only; viewport and named-control checks are not a complete accessibility audit or certification.'] }, null, 2), { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) }), Math.max(1, deadline - Date.now()), 'Manifest write');
}

export function failCommand(): never {
  console.error('Dashboard collector failed. Check the installed browser, FACTORY_BROWSER_EXECUTABLE, sandbox prerequisites, and disposable profile permissions.');
  // A failed child may still hold a referenced handle after escalation. Do not
  // let it consume the external timeout; failed cleanup is never success.
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) run().catch(failCommand);
