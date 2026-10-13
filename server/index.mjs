import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { OpenClaw } from './openclaw.mjs';
import { Vault } from './vault.mjs';
import { Service } from './service.mjs';
import { Supervisor } from './supervisor.mjs';
export function createApp({
  service,
  origin,
  pagesOrigin = 'https://caleb695.github.io',
  root = resolve('dist'),
}) {
  const csrf = randomBytes(32).toString('hex');
  let inFlight = 0;
  const server = http.createServer(async (req, res) => {
    const send = (status, data, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': type });
      res.end(type === 'application/json' ? JSON.stringify(data) : data);
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && pathname === '/api/bootstrap') {
        if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')
          return send(403, { error: 'Same-origin requests only.' });
        return send(200, { csrf, pagesOrigin });
      }
      if (pathname.startsWith('/api/')) {
        const token = Buffer.from(req.headers['x-dashboard-csrf'] || '');
        if (
          req.method !== 'POST' ||
          req.headers.origin !== origin ||
          token.length !== csrf.length ||
          !timingSafeEqual(token, Buffer.from(csrf)) ||
          req.headers['content-type'] !== 'application/json'
        )
          return send(403, { error: 'Request origin or CSRF check failed.' });
        if (inFlight >= 6) return send(429, { error: 'Too many operations. Wait and retry.' });
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 262144) return send(413, { error: 'Request too large.' });
        }
        const input = JSON.parse(body);
        inFlight++;
        try {
          if (pathname !== '/api/action' && pathname !== '/api/private')
            return send(404, { error: 'Not found.' });
          const result = await service.dispatch(
            input.action,
            input.params,
            pathname === '/api/private',
          );
          return send(200, { result });
        } finally {
          inFlight--;
        }
      }
      if (req.method !== 'GET') return send(405, { error: 'Method not allowed.' });
      const fixed = {
        '/bridge': ['server/bridge.html', 'text/html'],
        '/bridge.js': ['server/bridge.js', 'text/javascript'],
        '/bridge.css': ['server/bridge.css', 'text/css'],
      };
      if (fixed[pathname]) {
        const [path, type] = fixed[pathname];
        return send(200, await readFile(resolve(path)), type);
      }
      const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(root + '/')) return send(404, { error: 'Not found.' });
      const mime = file.endsWith('.js')
        ? 'text/javascript'
        : file.endsWith('.css')
          ? 'text/css'
          : file.endsWith('.svg')
            ? 'image/svg+xml'
            : 'text/html';
      return send(200, await readFile(file), mime);
    } catch (e) {
      return send(e.code === 'ENOENT' ? 404 : 400, {
        error: e.code ? 'Resource unavailable.' : e.message,
      });
    }
  });
  return server;
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const port = Number(process.env.PORT || 3000);
  const origin =
    process.env.DASHBOARD_ORIGIN ||
    (process.env.CODESPACE_NAME
      ? `https://${process.env.CODESPACE_NAME}-${port}.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev'}`
      : `http://localhost:${port}`);
  const state =
    process.env.DASHBOARD_STATE_DIR ||
    (process.env.CODESPACES
      ? '/workspaces/.openclaw-dashboard'
      : join(homedir(), '.openclaw-dashboard'));
  let settings = {};
  try {
    settings = JSON.parse(await readFile(join(state, 'settings.json'), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const claw = new OpenClaw();
  const supervisor =
    process.env.MANAGE_GATEWAY === '1' || settings.manageGateway
      ? new Supervisor(claw, state)
      : null;
  if (supervisor) await supervisor.init();
  const service = new Service(claw, new Vault(state), supervisor);
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.on(signal, async () => {
      if (supervisor?.busy) {
        console.error('Update in progress; wait for maintenance to finish before stopping.');
        return;
      }
      if (supervisor) await supervisor.close();
      process.exit(0);
    });
  createApp({
    service,
    origin,
    pagesOrigin: process.env.PAGES_ORIGIN || 'https://caleb695.github.io',
  }).listen(port, '0.0.0.0', () =>
    console.log(
      `OpenClaw companion: ${origin} — keep port ${port} PRIVATE. Gateway credentials stay local.`,
    ),
  );
}
