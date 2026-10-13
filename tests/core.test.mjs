import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sanitize,
  sanitizeSchema,
  rejectInlineSecrets,
  validateTree,
  patchConfig,
  OpenClaw,
} from '../server/openclaw.mjs';
import { Vault } from '../server/vault.mjs';
import { Service } from '../server/service.mjs';
import { createApp } from '../server/index.mjs';
import { Supervisor } from '../server/supervisor.mjs';
test('redacts nested credentials but preserves usable references', () => {
  const ref = { source: 'file', provider: 'dashboard', id: '/KEY' };
  assert.equal(sanitize({ apiKey: { ...ref, token: 'hidden' } }).apiKey, '[REDACTED]');
  assert.deepEqual(
    sanitize({ nested: { apiKey: 'secret', password: 'hidden', token: 'hidden' }, apiKey: ref }),
    { nested: { apiKey: '[REDACTED]', password: '[REDACTED]', token: '[REDACTED]' }, apiKey: ref },
  );
});
test('rejects inline credentials and prototype pollution', () => {
  assert.doesNotThrow(() => rejectInlineSecrets({ maxTokens: 8192, tokenLimit: 4096 }));
  assert.equal(sanitize({ maxTokens: 8192 }).maxTokens, 8192);
  assert.deepEqual(
    sanitizeSchema({ properties: { apiKey: { type: 'string', default: 'hidden' } } }),
    { properties: { apiKey: { type: 'string' } } },
  );
  assert.throws(() =>
    rejectInlineSecrets({ models: { providers: { custom: { apiKey: 'secret' } } } }),
  );
  assert.throws(() => rejectInlineSecrets({ headers: { 'X-Custom-Key': 'secret' } }));
  assert.throws(() => validateTree(JSON.parse('{"x":{"__proto__":{"bad":true}}}')));
  assert.doesNotThrow(() =>
    rejectInlineSecrets({ apiKey: { source: 'file', provider: 'dashboard', id: '/KEY' } }),
  );
});
test('config patches retain the base hash and replacement paths', async () => {
  let call;
  const claw = {
    rpc: async (...args) => {
      call = args;
      return {};
    },
  };
  await patchConfig(claw, { update: { auto: { enabled: false } } }, 'abc', ['plugins.allow']);
  assert.equal(call[0], 'config.patch');
  assert.equal(call[1].baseHash, 'abc');
  assert.deepEqual(call[1].replacePaths, ['plugins.allow']);
  await assert.rejects(() => patchConfig(claw, {}, null));
});
test('vault writes atomically, privately, serializes concurrent rotations, returns only refs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vault-'));
  const vault = new Vault(dir);
  try {
    const ref = await vault.put('CUSTOM_KEY', 'private-value');
    assert.equal(ref.id, '/CUSTOM_KEY');
    await Promise.all([vault.put('SECOND', 'two'), vault.put('THIRD', 'three')]);
    assert.deepEqual((await vault.names()).sort(), ['CUSTOM_KEY', 'SECOND', 'THIRD']);
    assert.equal((await stat(vault.path)).mode & 0o777, 0o600);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    await vault.put('CUSTOM_KEY', 'rotated');
    assert.equal(JSON.parse(await readFile(vault.path)).CUSTOM_KEY, 'rotated');
    await assert.rejects(() => vault.put('../bad', 'x'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('service strips raw config, restricts RPC, disallows credential submission via relay', async () => {
  const calls = [];
  const claw = {
    rpc: async (method, params) => {
      calls.push([method, params]);
      return {
        hash: 'one',
        raw: 'SECRET',
        config: { apiKey: 'SECRET', channels: { telegram: { enabled: true } } },
      };
    },
    command: async () => ({}),
  };
  const service = new Service(claw, {
    names: async () => ['ONE'],
    put: async () => {
      throw new Error('must not be reached');
    },
  });
  const c = await service.dispatch('config');
  assert.ok(!('raw' in c));
  assert.equal(c.config.apiKey, '[REDACTED]');
  await assert.rejects(() => service.dispatch('rpc', { method: 'exec', params: {} }));
  await assert.rejects(() => service.dispatch('credentials.save', { name: 'X', value: 'secret' }));
  await assert.rejects(() =>
    service.dispatch('plugins.change', { operation: 'install', id: '--help' }),
  );
  await assert.rejects(() =>
    service.dispatch('plugins.change', { operation: 'install', id: 'x;touch /tmp/pwn' }),
  );
  await service.dispatch('rpc', {
    method: 'chat.send',
    params: { message: 'hello', sessionKey: 'agent:main:main', idempotencyKey: 'fixed' },
  });
  assert.equal(calls.at(-1)[1].idempotencyKey, 'fixed');
});
test('HTTP companion enforces exact Origin, CSRF, body type and no CORS', async () => {
  const calls = [];
  const server = createApp({
    service: {
      dispatch: async (...args) => {
        calls.push(args);
        return { ok: true };
      },
    },
    origin: 'https://agent-3000.app.github.dev',
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const boot = await fetch(base + '/api/bootstrap');
    const { csrf } = await boot.json();
    assert.ok(csrf);
    assert.equal(boot.headers.get('access-control-allow-origin'), null);
    assert.equal(
      (await fetch(base + '/api/bootstrap', { headers: { 'Sec-Fetch-Site': 'cross-site' } }))
        .status,
      403,
    );
    const headers = {
      'Content-Type': 'application/json',
      'X-Dashboard-CSRF': csrf,
      Origin: 'https://agent-3000.app.github.dev',
    };
    const call = (h = headers, path = '/api/action', body = { action: 'config' }) =>
      fetch(base + path, { method: 'POST', headers: h, body: JSON.stringify(body) });
    assert.equal((await call({ ...headers, Origin: 'https://evil.example' })).status, 403);
    assert.equal((await call({ ...headers, 'X-Dashboard-CSRF': 'wrong' })).status, 403);
    assert.equal((await call({ ...headers, 'Content-Type': 'text/plain' })).status, 403);
    assert.equal((await call()).status, 200);
    assert.equal(calls.at(-1)[2], false);
    assert.equal((await call(headers, '/api/private')).status, 200);
    assert.equal(calls.at(-1)[2], true);
    assert.equal((await call(headers, '/api/action', { x: 'a'.repeat(270000) })).status, 413);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
test('CLI failures never leak argv, credentials, or stderr', async () => {
  const claw = new OpenClaw('/not/an/openclaw');
  await assert.rejects(() => claw.rpc('health'), /CLI not found/);
  const fail = new OpenClaw('/bin/false');
  await assert.rejects(
    () => fail.rpc('health', { token: 'do-not-leak' }),
    (e) => !e.message.includes('do-not-leak'),
  );
});
test('supervisor refuses updates for unknown ownership; never stops an unrelated Gateway', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'supervisor-'));
  let stopped = false;
  const s = new Supervisor(
    {
      command: async () => ({
        availability: { hasRegistryUpdate: true },
        update: { installKind: 'package', packageManager: 'unknown' },
        channel: { value: 'stable' },
      }),
    },
    dir,
  );
  s.stop = async () => {
    stopped = true;
  };
  s.policy.enabled = true;
  await s.check();
  assert.equal(stopped, false);
  assert.equal(s.last.state, 'failed');
  s.busy = true;
  await assert.rejects(() => s.policySet(false), /in progress/);
  await rm(dir, { recursive: true, force: true });
});
test('supervisor disabled policy does not check; update lock rejects concurrent updates', async () => {
  let checked = false;
  const s = new Supervisor(
    {
      command: async () => {
        checked = true;
      },
    },
    '/unused',
  );
  await s.check();
  assert.equal(checked, false);
  s.busy = true;
  await assert.rejects(() => s.check(true), /already/);
});
test('supervised update orders drain → verified backup → pinned supported update → restart → health', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'supervisor-'));
  const events = [];
  const claw = {
    command: async (args) => {
      events.push(args.join(' '));
      if (args[0] === 'update' && args[1] === 'status')
        return {
          availability: { hasRegistryUpdate: true, latestVersion: '2026.10.4' },
          update: { installKind: 'package', packageManager: 'npm' },
          channel: { value: 'stable' },
        };
      return { status: 'ok' };
    },
    rpc: async (method) => {
      events.push(method);
      return { ok: true, runtimeVersion: '2026.10.4' };
    },
  };
  const s = new Supervisor(claw, dir);
  s.child = {};
  s.stop = async () => events.push('stop');
  s.start = async () => events.push('start');
  await s.check(true);
  assert.equal(s.last.state, 'completed');
  assert.equal(s.busy, false);
  assert.deepEqual(
    events.map((x) => (x.startsWith('backup') ? 'backup' : x)),
    [
      'update status --json',
      'stop',
      'backup',
      'update --yes --tag 2026.10.4 --no-restart --json',
      'start',
      'health',
      'status',
    ],
  );
  assert.ok(events[2].includes('--verify'));
  claw.rpc = async () => ({ ok: true, runtimeVersion: '2026.10.3' });
  await s.check(true);
  assert.equal(s.last.state, 'failed');
  assert.match(s.last.message, /does not report the requested release/);
  await rm(dir, { recursive: true, force: true });
});
test('backup failure prevents package replacement and restarts the owned Gateway', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'supervisor-'));
  const events = [];
  const s = new Supervisor(
    {
      command: async (args) => {
        events.push(args[0]);
        if (args[0] === 'backup') throw new Error('Backup failed');
        return {
          availability: { hasRegistryUpdate: true, latestVersion: '2026.10.4' },
          update: { installKind: 'package', packageManager: 'npm' },
          channel: { value: 'stable' },
        };
      },
    },
    dir,
  );
  s.child = {};
  s.stop = async () => {};
  s.start = async () => events.push('restart');
  await s.check(true);
  assert.equal(s.last.state, 'failed');
  assert.deepEqual(events, ['update', 'backup', 'restart']);
  await rm(dir, { recursive: true, force: true });
});
test('stale hash failures are not silently retried or overwritten', async () => {
  let calls = 0;
  const service = new Service(
    {
      rpc: async () => {
        calls++;
        throw new Error('hash mismatch');
      },
    },
    {},
  );
  await assert.rejects(
    () => service.dispatch('patch', { patch: { channels: {} }, hash: 'stale' }),
    /hash mismatch/,
  );
  assert.equal(calls, 1);
});
