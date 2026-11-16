import { createServer, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DashboardReader } from './dashboard-reader.ts';

const csp = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
const idPattern = /^[a-zA-Z0-9_-]+$/;

/** Read-only dashboard. Run: node --experimental-strip-types src/dashboard-server.ts REPOSITORY [PORT] (default 3000).
 * GET /api/runs, /api/runs/:id, /api/runs/:id/events and /api/runs/:id/live.
 * Live messages are complete event snapshots, not deltas: consumers replace their timeline.
 * The snapshot hash is the SSE id; Last-Event-ID suppresses an unchanged snapshot on reconnect.
 */
export function createDashboardServer(repository: string) {
  const reader = new DashboardReader(repository);
  const clients = new Set<ServerResponse>();
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const host = req.headers.host;
    if (!host || !hosts.includes(host) || (req.headers.origin !== undefined && req.headers.origin !== `http://${host}`)) {
      res.writeHead(403).end(); return;
    }
    if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }).end(); return; }
    let pathname: string;
    try { pathname = new URL(req.url ?? '/', `http://${host}`).pathname; }
    catch { res.writeHead(400).end(); return; }
    const json = (value: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(value)); };
    try {
      if (pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Factory dashboard</title></head><body><main><h1>Factory dashboard</h1></main></body></html>'); return;
      }
      if (pathname === '/api/runs') { json(await reader.listRuns()); return; }
      const match = /^\/api\/runs\/([^/]+)(?:\/(events|live))?$/.exec(pathname);
      if (!match || !idPattern.test(match[1])) { res.writeHead(404).end(); return; }
      const [, id, action] = match;
      if (!action) { json(await reader.readRun(id)); return; }
      if (action === 'events') { json(await reader.readEvents(id)); return; }
      if (clients.size >= 20) { res.writeHead(503).end(); return; }
      clients.add(res);
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
      res.flushHeaders();
      let last = typeof req.headers['last-event-id'] === 'string' ? req.headers['last-event-id'] : '';
      let busy = false;
      const poll = async () => {
        if (busy || res.destroyed) return;
        busy = true;
        try {
          const data = JSON.stringify(await reader.readEvents(id));
          const hash = createHash('sha256').update(data).digest('hex');
          if (!res.destroyed && hash !== last) { last = hash; res.write(`id: ${hash}\nevent: snapshot\ndata: ${data}\n\n`); }
        } catch { if (!res.destroyed) res.destroy(); } finally { busy = false; }
      };
      const timer = setInterval(() => { void poll(); }, 1000);
      res.on('close', () => { clearInterval(timer); clients.delete(res); });
      void poll();
    } catch { if (!res.headersSent) res.writeHead(500).end(); else res.destroy(); }
  });
  // Closing the server must not wait indefinitely for open event streams.
  const close = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void) => {
    for (const client of clients) client.end();
    return close(callback);
  }) as typeof server.close;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , repository, portArg = '3000', ...extra] = process.argv;
  const port = Number(portArg);
  if (!repository || extra.length || !/^\d+$/.test(portArg) || !Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('Usage: node --experimental-strip-types src/dashboard-server.ts REPOSITORY [PORT]');
    process.exitCode = 1;
  } else {
    createDashboardServer(repository).listen(port, '127.0.0.1', () => console.log(`Dashboard: http://127.0.0.1:${port}/`));
  }
}
