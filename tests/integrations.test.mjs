import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { Database, databaseFromEnv } from '../server/database.mjs';
import { Persistence, privateWrite } from '../server/persistence.mjs';
import {
  Codespaces,
  validateSchedule,
  isWorkingTime,
  defaultSchedule,
} from '../server/codespaces.mjs';
import { Messenger, validSignature } from '../server/messenger.mjs';
import { Vault } from '../server/vault.mjs';
import { Service } from '../server/service.mjs';
import { gatewayEnvironment } from '../server/environment.mjs';
const key = 'ab'.repeat(32);
async function database(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-db-'));
  const client = createClient({ url: `file:${join(dir, 'data.db')}` });
  const db = await new Database(client, key, 'test').init();
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { db, client, dir };
}
test('real libSQL schema, encrypted rows, namespace separation, optimistic concurrency and wrong keys', async (t) => {
  const { db, client } = await database(t);
  const secret = { token: 'synthetic-only-not-a-real-token', schedule: { enabled: false } };
  await db.put('vault', secret, 0);
  const first = (await client.execute('SELECT value FROM dashboard_documents')).rows[0].value;
  assert.ok(!first.includes(secret.token));
  assert.deepEqual((await db.get('vault')).value, secret);
  await db.put('vault', secret, 1);
  const second = (await client.execute('SELECT value FROM dashboard_documents')).rows[0].value;
  assert.notEqual(first, second, 'unique nonce per encryption');
  await assert.rejects(() => db.put('vault', {}, 1), /changed elsewhere/);
  await assert.rejects(() => db.put('vault', {}, 0), /changed elsewhere/);
  assert.equal((await new Database(client, key, 'other').get('vault')).value, null);
  await assert.rejects(
    () => new Database(client, 'cd'.repeat(32), 'test').get('vault'),
    /decryption failed/,
  );
  assert.throws(() => db.decrypt('other-document', second), /decryption failed/);
  const results = await Promise.allSettled([
    db.put('vault', { a: 1 }, 2),
    db.put('vault', { b: 1 }, 2),
  ]);
  assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
});
test('database environment is fail-closed and driver errors are redacted', async () => {
  assert.equal(await databaseFromEnv({}), null);
  await assert.rejects(() => databaseFromEnv({ TURSO_AUTH_TOKEN: 'secret' }), /Set TURSO/);
  await assert.rejects(
    () =>
      databaseFromEnv({
        TURSO_DATABASE_URL: 'http://insecure',
        TURSO_AUTH_TOKEN: 'secret',
        DASHBOARD_ENCRYPTION_KEY: key,
      }),
    /secure/,
  );
  const db = new Database(
    {
      execute: async () => {
        throw new Error('secret: https://url');
      },
    },
    key,
  );
  await assert.rejects(
    () => db.get('x'),
    (e) => /unavailable/.test(e.message) && !e.message.includes('https://url'),
  );
  assert.throws(() => new Database({}, 'bad'), /64 hexadecimal/);
});
test('vault restores from Turso after local deletion, rotates atomically, and never returns values', async (t) => {
  const { db, dir } = await database(t);
  const original = new Vault(join(dir, 'first'), db);
  await original.init();
  await Promise.all([original.put('FIRST_KEY', 'one'), original.put('SECOND_KEY', 'two')]);
  const fresh = new Vault(join(dir, 'second'), db);
  await fresh.init();
  assert.deepEqual(await fresh.names(), ['FIRST_KEY', 'SECOND_KEY']);
  assert.equal((await stat(fresh.path)).mode & 0o777, 0o600);
  assert.deepEqual(await fresh.put('FIRST_KEY', 'rotated'), {
    source: 'file',
    provider: 'dashboard',
    id: '/FIRST_KEY',
  });
  assert.equal((await db.get('vault')).value.FIRST_KEY, 'rotated');
});
test('config survives restart; automatic restore never overwrites existing local config and rebinds vault', async (t) => {
  const { db, dir } = await database(t);
  const config = {
    models: { mode: 'merge' },
    secrets: {
      providers: { dashboard: { source: 'file', path: '/old/secrets.json', mode: 'json' } },
    },
  };
  const path = join(dir, 'fresh', 'openclaw.json'),
    vaultPath = join(dir, 'fresh-vault', 'secrets.json');
  let applied;
  const claw = {
    command: async () => ({}),
    rpc: async (method, p) => {
      if (method === 'config.get') return { valid: true, config };
      applied = [method, p];
    },
  };
  const persistence = new Persistence(db, claw, path, vaultPath);
  await privateWrite(join(dir, 'fresh-vault', 'updates.json'), { enabled: true });
  await privateWrite(path, config);
  await persistence.backup();
  await rm(path);
  await rm(join(dir, 'fresh-vault', 'updates.json'));
  await persistence.restoreMissing();
  assert.equal(JSON.parse(await readFile(path)).secrets.providers.dashboard.path, vaultPath);
  assert.equal(JSON.parse(await readFile(join(dir, 'fresh-vault', 'updates.json'))).enabled, true);
  await privateWrite(path, { local: true });
  await persistence.restoreMissing();
  assert.deepEqual(JSON.parse(await readFile(path)), { local: true });
  await persistence.restore('base');
  assert.equal(applied[0], 'config.apply');
  assert.equal(applied[1].baseHash, 'base');
  assert.equal(JSON.parse(applied[1].raw).secrets.providers.dashboard.path, vaultPath);
  assert.equal((await persistence.status()).configured, true);
  await privateWrite(path, { token: '__OPENCLAW_REDACTED__' });
  await assert.rejects(() => persistence.backup(), /redacted config/);
  assert.equal((await db.get('openclaw-config')).revision, 1);
  assert.match(await persistence.afterChange(), /cloud backup failed/);
});
test('schedule validation, exact boundaries, overnight weekday rollover and DST', () => {
  const s = validateSchedule({
    enabled: true,
    timeZone: 'UTC',
    windows: [{ days: [1], start: '22:00', end: '02:00' }],
  });
  assert.equal(isWorkingTime(s, new Date('2026-10-12T21:59:00Z')), false);
  assert.equal(isWorkingTime(s, new Date('2026-10-12T22:00:00Z')), true);
  assert.equal(isWorkingTime(s, new Date('2026-10-13T01:59:00Z')), true);
  assert.equal(isWorkingTime(s, new Date('2026-10-13T02:00:00Z')), false);
  const dst = validateSchedule({
    enabled: true,
    timeZone: 'America/New_York',
    windows: [{ days: [0], start: '01:00', end: '03:00' }],
  });
  assert.equal(isWorkingTime(dst, new Date('2026-11-01T05:30:00Z')), true);
  assert.equal(isWorkingTime(dst, new Date('2026-11-01T06:30:00Z')), true);
  assert.equal(isWorkingTime(dst, new Date('2026-11-01T08:00:00Z')), false);
  for (const bad of [
    { ...s, timeZone: 'bad/zone' },
    { ...s, windows: [] },
    { ...s, windows: [{ days: [7], start: '09:00', end: '10:00' }] },
    { ...s, windows: [{ days: [0], start: '24:00', end: '24:00' }] },
  ])
    assert.throws(() => validateSchedule(bad));
});
test('scheduler starts/stops only the configured target, skips disabled and transitional states', async (t) => {
  const { db } = await database(t);
  let state = 'Shutdown';
  const calls = [];
  const controller = new Codespaces(db, {
    token: 'synthetic',
    name: 'my-agent',
    fetcher: async (url, opts) => {
      calls.push([url, opts.method]);
      return {
        ok: true,
        status: opts.method === 'POST' ? 202 : 200,
        json: async () => ({ name: 'my-agent', state }),
      };
    },
  });
  await controller.saveSchedule({ revision: 0, schedule: { ...defaultSchedule, enabled: true } });
  assert.equal((await controller.tick(new Date('2026-10-12T10:00:00Z'))).action, 'start');
  assert.ok(calls.at(-1)[0].endsWith('/my-agent/start'));
  state = 'Available';
  assert.equal((await controller.tick(new Date('2026-10-12T18:00:00Z'))).action, 'stop');
  state = 'Starting';
  assert.equal((await controller.tick(new Date('2026-10-12T18:00:00Z'))).action, 'none');
  controller.name = 'wrong-target';
  await assert.rejects(() => controller.tick(), /does not match/);
  controller.name = 'my-agent';
  await controller.saveSchedule({ revision: 1, schedule: defaultSchedule });
  calls.length = 0;
  assert.equal((await controller.tick()).reason, 'Schedule disabled');
  assert.equal(calls.length, 0);
  await assert.rejects(
    () => controller.saveSchedule({ revision: 1, schedule: defaultSchedule }),
    /changed elsewhere/,
  );
});
test('resize uses live machine IDs, only allows 2/4 cores, and reports next-start semantics', async () => {
  const calls = [];
  const controller = new Codespaces(null, {
    token: 'not-public',
    name: 'agent',
    fetcher: async (url, opts) => {
      calls.push([url, opts]);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          machines: [
            { name: 'actual-2', cpus: 2 },
            { name: 'actual-4', cpus: 4 },
            { name: 'large', cpus: 8 },
          ],
        }),
      };
    },
  });
  assert.match((await controller.resize('actual-4')).notice, /next time/);
  assert.deepEqual(JSON.parse(calls.at(-1)[1].body), { machine: 'actual-4' });
  await assert.rejects(() => controller.resize('large'), /available 2-core/);
  await assert.rejects(() => controller.resize('invented'), /available 2-core/);
  const denied = new Codespaces(null, {
    token: 'x',
    name: 'agent',
    fetcher: async () => ({ ok: false, status: 403 }),
  });
  await assert.rejects(() => denied.resize('actual-2'), /403/);
});
const messengerEnv = {
  MESSENGER_APP_SECRET: 'synthetic-app-secret',
  MESSENGER_VERIFY_TOKEN: 'synthetic-verify',
  MESSENGER_PAGE_ACCESS_TOKEN: 'synthetic-page-token',
  MESSENGER_PAGE_ID: '123',
  MESSENGER_GRAPH_VERSION: 'v25.0',
  MESSENGER_ALLOWED_PSIDS: '456',
};
const event = (id = 'msg-1', sender = '456') => ({
  object: 'page',
  entry: [
    {
      id: '123',
      messaging: [
        {
          sender: { id: sender },
          recipient: { id: '123' },
          timestamp: Date.now(),
          message: { mid: id, text: 'hello' },
        },
      ],
    },
  ],
});
test('Messenger durably deduplicates, allowlists, isolates sessions and replies with server-side auth', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'messenger-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const commands = [],
    sends = [];
  const claw = {
    command: async (args) => {
      commands.push(args);
      return { result: { payloads: [{ text: 'a'.repeat(1900) }] } };
    },
  };
  const m = await new Messenger(claw, dir, messengerEnv, async (url, opts) => {
    sends.push([url, opts]);
    return { ok: true };
  }).init();
  m.running = true;
  await m.accept(event());
  await m.accept(event());
  await m.accept(event('msg-2', '999'));
  assert.equal(m.events.length, 1);
  assert.equal(JSON.parse(await readFile(m.path)).length, 1);
  m.running = false;
  await m.drain();
  assert.equal(commands.length, 1);
  assert.equal(commands[0][2], 'agent:main:messenger:direct:456');
  assert.equal(sends.length, 2);
  assert.ok(!sends[0][0].includes('synthetic-page-token'));
  assert.equal(sends[0][1].headers.Authorization, 'Bearer synthetic-page-token');
  assert.equal(m.status().delivered, 1);
  assert.equal(m.events[0].text, undefined);
  await m.accept(event());
  assert.equal(commands.length, 1);
  await privateWrite(m.path, [{ id: 'uncertain', state: 'running', text: 'private' }]);
  const restarted = await new Messenger(claw, dir, messengerEnv).init();
  assert.equal(restarted.status().failed, 1);
  assert.equal(restarted.events[0].text, undefined);
});
test('Messenger HTTP isolates the public surface, validates raw HMAC and verification token', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'messenger-http-'));
  const m = await new Messenger(
    { command: async () => ({ payloads: [] }) },
    dir,
    messengerEnv,
  ).init();
  m.running = true;
  const server = m.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/api/bootstrap')).status, 404);
  assert.equal(
    (await fetch(base + '/webhook?hub.mode=subscribe&hub.verify_token=wrong')).status,
    403,
  );
  assert.equal(
    await (
      await fetch(
        base + '/webhook?hub.mode=subscribe&hub.verify_token=synthetic-verify&hub.challenge=abc',
      )
    ).text(),
    'abc',
  );
  const body = JSON.stringify(event());
  const sig =
    'sha256=' + createHmac('sha256', messengerEnv.MESSENGER_APP_SECRET).update(body).digest('hex');
  assert.equal(validSignature(Buffer.from(body), sig, messengerEnv.MESSENGER_APP_SECRET), true);
  assert.equal(
    validSignature(Buffer.from(body + 'x'), sig, messengerEnv.MESSENGER_APP_SECRET),
    false,
  );
  const post = (signature, text = body) =>
    fetch(base + '/webhook', {
      method: 'POST',
      headers: { 'x-hub-signature-256': signature },
      body: text,
    });
  assert.equal((await post('sha256=bad')).status, 403);
  assert.equal((await post(sig)).status, 200);
  assert.equal((await post(sig, 'x'.repeat(270000))).status, 413);
});
test('infrastructure secrets are not inherited by Gateway children', () => {
  assert.deepEqual(
    gatewayEnvironment({
      PATH: '/bin',
      OPENAI_API_KEY: 'provider',
      TURSO_AUTH_TOKEN: 'db',
      TURSO_DATABASE_URL: 'url',
      DASHBOARD_ENCRYPTION_KEY: key,
      CODESPACES_TOKEN: 'github',
      MESSENGER_APP_SECRET: 'meta',
    }),
    { PATH: '/bin', OPENAI_API_KEY: 'provider' },
  );
});
test('database and machine management work when Gateway is unavailable, invalid actions fail cleanly', async () => {
  const service = new Service(
    {
      rpc: async () => {
        throw new Error('Gateway offline');
      },
    },
    {},
    null,
    {
      persistence: { status: async () => ({ configured: true }) },
      codespaces: { status: async () => ({ state: 'Available' }) },
    },
  );
  assert.equal((await service.dispatch('database.status')).configured, true);
  assert.equal((await service.dispatch('codespaces.status')).state, 'Available');
  await assert.rejects(() => service.dispatch(null), /Invalid action/);
});

test('private JSON5 backups reject includes, schema errors, and files changed during validation', async (t) => {
  const { db, dir } = await database(t);
  const path = join(dir, 'openclaw.json');
  const claw = { command: async () => ({ valid: true }) };
  const persistence = new Persistence(db, claw, path, join(dir, 'secrets.json'));
  await writeFile(
    path,
    '{ // comment\n models: { mode: "merge", }, gateway: { auth: { token: "synthetic-inline" } } }',
  );
  await persistence.backup();
  assert.equal((await db.get('openclaw-config')).value.gateway.auth.token, 'synthetic-inline');
  await privateWrite(path, { $include: 'extra.json5' });
  await assert.rejects(() => persistence.backup(), /single configuration/);
  await privateWrite(path, { gateway: {} });
  claw.command = async () => ({ valid: false });
  await assert.rejects(() => persistence.backup(), /rejected/);
  claw.command = async () => {
    await privateWrite(path, { changed: true });
    return { valid: true };
  };
  await assert.rejects(() => persistence.backup(), /changed during validation/);
  assert.equal((await db.get('openclaw-config')).revision, 1);
});

test('scheduler abandons a stale schedule if it changes during GitHub inspection', async (t) => {
  const { db } = await database(t);
  await db.put(
    'codespace-schedule',
    { target: 'agent', schedule: { ...defaultSchedule, enabled: true } },
    0,
  );
  const methods = [];
  const controller = new Codespaces(db, {
    name: 'agent',
    token: 'synthetic',
    fetcher: async (_url, opts) => {
      methods.push(opts.method);
      await db.put('codespace-schedule', { target: 'agent', schedule: defaultSchedule }, 1);
      return { ok: true, status: 200, json: async () => ({ state: 'Shutdown' }) };
    },
  });
  assert.equal(
    (await controller.tick(new Date('2026-10-12T10:00:00Z'))).reason,
    'Schedule changed; wait for next run',
  );
  assert.deepEqual(methods, ['GET']);
});
