import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createClient } from '@libsql/client';
import * as tar from 'tar';
import { Database } from '../server/database.mjs';
import { BackupStore } from '../server/backup-store.mjs';
import { FullBackup, fullBackupOptions } from '../server/full-backup.mjs';
import { Persistence } from '../server/persistence.mjs';
import { Vault } from '../server/vault.mjs';
import { Service } from '../server/service.mjs';

const key = 'ab'.repeat(32);
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'turso-full-test-'));
  const db = await new Database(
    createClient({ url: `file:${join(dir, 'test.db')}` }),
    key,
    'test',
  ).init();
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const source = join(dir, 'openclaw');
  const state = join(dir, 'companion');
  await mkdir(join(source, 'agents', 'temporary'), { recursive: true });
  await mkdir(join(source, 'workspace'), { recursive: true });
  await mkdir(join(state, 'backups'), { recursive: true });
  await writeFile(join(source, 'openclaw.json'), '{"agents":{"list":[{"id":"temporary"}]}}');
  await writeFile(join(source, 'agents', 'temporary', 'memory.md'), 'private deleted agent memory');
  await writeFile(
    join(source, 'agents', 'temporary', 'conversation.jsonl'),
    'private deleted conversation',
  );
  await writeFile(join(source, 'workspace', 'binary.bin'), randomBytes(400000));
  await writeFile(join(state, 'secrets.json'), '{"TOKEN":"private vault secret"}');
  await writeFile(join(state, 'messenger-inbox.json'), '{"message":"private inbox"}');
  await writeFile(join(state, 'backups', 'old-secret.txt'), 'must not be mirrored');
  await writeFile(join(state, 'companion.log'), 'historical output must not be mirrored');
  const calls = [];
  const claw = {
    command: async (args) => {
      calls.push(args);
      if (args[0] !== 'backup') throw new Error('Unexpected command');
      if (args[1] === 'create') {
        assert.ok(args.includes('--verify'));
        assert.ok(!args.includes('--no-include-workspace'));
        assert.ok(!args.includes('--only-config'));
        await tar.c(
          {
            cwd: source,
            file: join(args[args.indexOf('--output') + 1], 'fixture.tar.gz'),
            gzip: true,
          },
          ['.'],
        );
        return { warnings: ['private path warning'], version: 'fixture' };
      }
      if (args[1] === 'verify') {
        await tar.t({ file: args[2], strict: true });
        return { ok: true };
      }
      if (args[1] === 'restore') {
        const target = args[args.indexOf('--target') + 1];
        await mkdir(target, { mode: 0o700 });
        await tar.x({ file: args[2], cwd: target, strict: true });
        return { ok: true };
      }
      throw new Error('Unexpected command');
    },
  };
  const backup = await new FullBackup(db, claw, state).init();
  return { db, dir, source, state, claw, calls, backup };
}

test('full mirror streams encrypted chunks, recovers binary/state/companion files privately, never exposes paths in status', async (t) => {
  const { db, dir, source, backup, calls } = await fixture(t);
  const extra = join(dir, 'external-auth.json');
  await writeFile(extra, '{"refreshToken":"external-private"}');
  backup.extraPaths = [extra];
  await backup.backup();
  const saved = await backup.store.latest();
  assert.ok(saved.value.artifacts[0].chunks > 1);
  const rows = (await db.query('SELECT value FROM dashboard_backup_chunks')).rows;
  for (const row of rows) assert.ok(!row.value.includes('private'));
  const status = await backup.status();
  assert.equal(status.hasArchiveWarnings, true);
  assert.equal(status.retainedSnapshots, 1);
  assert.ok(!JSON.stringify(status).includes(dir));
  const destination = join(dir, 'recovered');
  const result = await backup.recover(destination, { extract: true });
  assert.equal((await stat(destination)).mode & 0o777, 0o700);
  assert.equal((await stat(join(result.directory, 'openclaw.tar.gz'))).mode & 0o777, 0o600);
  assert.deepEqual(
    await readFile(join(result.directory, 'openclaw-restored', 'workspace', 'binary.bin')),
    await readFile(join(source, 'workspace', 'binary.bin')),
  );
  assert.match(
    await readFile(
      join(result.directory, 'openclaw-restored', 'agents', 'temporary', 'conversation.jsonl'),
      'utf8',
    ),
    /private deleted conversation/,
  );
  const entries = [];
  await tar.t({
    file: join(result.directory, 'companion.tar.gz'),
    onReadEntry: (e) => entries.push(e.path),
  });
  assert.ok(entries.includes('./secrets.json'));
  assert.ok(entries.includes('./messenger-inbox.json'));
  assert.ok(!entries.some((x) => x.includes('old-secret') || x.includes('companion.log')));
  await access(join(result.directory, 'extra-1.tar.gz'));
  assert.ok(calls.some((c) => c[1] === 'verify'));
  await assert.rejects(() => backup.recover(destination), { code: 'EEXIST' });
});

test('deleting an agent removes all old snapshots/chunks and legacy config; unrelated current files survive recovery', async (t) => {
  const { db, dir, source, state, backup } = await fixture(t);
  await db.put('openclaw-config', { agents: { list: [{ id: 'temporary' }] } }, 0);
  await db.put('companion-settings', { old: true }, 0);
  await backup.backup();
  const original = await backup.store.latest();
  await rm(join(source, 'agents', 'temporary'), { recursive: true });
  await writeFile(join(source, 'openclaw.json'), '{"agents":{"list":[]}}');
  await writeFile(join(state, 'secrets.json'), '{}');
  await backup.backup();
  const latest = await backup.store.latest();
  assert.equal(latest.revision, 2);
  assert.notEqual(latest.id, original.id);
  assert.equal((await db.query('SELECT * FROM dashboard_backups')).rows.length, 1);
  assert.equal(
    (await db.query('SELECT * FROM dashboard_backup_chunks WHERE snapshot = ?', [original.id])).rows
      .length,
    0,
  );
  assert.equal((await db.get('openclaw-config')).value, null);
  assert.equal((await db.get('companion-settings')).value, null);
  assert.deepEqual((await db.get('vault')).value, {});
  const { directory } = await backup.recover(join(dir, 'after-delete'), { extract: true });
  await assert.rejects(() => access(join(directory, 'openclaw-restored', 'agents', 'temporary')), {
    code: 'ENOENT',
  });
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, 'openclaw-restored', 'openclaw.json'))),
    { agents: { list: [] } },
  );
  await access(join(directory, 'openclaw-restored', 'workspace', 'binary.bin'));
});

test('failed uploads and size limits preserve last completed mirror and report deletion as pending; retry replaces it', async (t) => {
  const { db, backup, source } = await fixture(t);
  await backup.backup();
  const old = await backup.store.latest();
  await rm(join(source, 'agents', 'temporary'), { recursive: true });
  const write = backup.store.write.bind(backup.store);
  backup.store.write = async (id, ordinal, chunk) => {
    if (ordinal === 1) throw new Error('simulated network interruption');
    return write(id, ordinal, chunk);
  };
  await assert.rejects(() => backup.backup(), /interruption/);
  assert.equal((await backup.store.latest()).id, old.id);
  assert.match((await backup.status()).warning, /failed/);
  assert.equal((await db.query('SELECT * FROM dashboard_backups')).rows.length, 1);
  backup.store.write = write;
  backup.maxBytes = 1;
  await assert.rejects(() => backup.backup(), /exceeds/);
  assert.equal((await backup.store.latest()).id, old.id);
  backup.maxBytes = 1024 ** 3;
  await backup.backup();
  assert.equal((await backup.status()).warning, null);
  assert.notEqual((await backup.store.latest()).id, old.id);
});

test('atomic publication prunes incomplete uploads, rejects stale publishers, and isolates namespaces', async (t) => {
  const { db, backup } = await fixture(t);
  const other = await new BackupStore(new Database(db.client, key, 'other')).init();
  await other.begin('unrelated');
  await other.write('unrelated', 0, Buffer.from('other namespace'));
  await backup.store.begin('abandoned');
  await backup.store.write('abandoned', 0, Buffer.from('old deleted data'));
  await backup.backup();
  await assert.rejects(
    () => backup.store.write('abandoned', 1, Buffer.from('late write')),
    /superseded/,
  );
  await assert.rejects(() => backup.store.read('abandoned', 0), /missing/);
  assert.equal((await other.read('unrelated', 0)).toString(), 'other namespace');
  await backup.store.begin('stale');
  await assert.rejects(() => backup.store.publish('stale', {}, 0), /conflicted/);
  assert.equal((await backup.store.latest()).revision, 1);
  await backup.store.discard('stale');
  // A lost commit response must not delete an already-published snapshot.
  const completed = await backup.store.latest();
  await backup.store.discard(completed.id);
  assert.ok((await backup.store.read(completed.id, 0)).length);
});

test('tampering, missing chunks and wrong keys fail closed, removing partial recovery output', async (t) => {
  const { db, backup, dir } = await fixture(t);
  await backup.backup();
  const saved = await backup.store.latest();
  const wrongKey = await new FullBackup(
    new Database(db.client, 'cd'.repeat(32), 'test'),
    backup.claw,
    backup.stateDir,
  ).init();
  await assert.rejects(() => wrongKey.recover(join(dir, 'wrong-key')), /decryption failed/);
  await db.query(
    'UPDATE dashboard_backup_chunks SET value = ? WHERE namespace = ? AND snapshot = ? AND ordinal = 0',
    [
      db.encrypt(`backup:${saved.id}:0`, Buffer.from('tampered').toString('base64')),
      db.namespace,
      saved.id,
    ],
  );
  await assert.rejects(() => backup.recover(join(dir, 'tampered')), /checksum/);
  await assert.rejects(() => access(join(dir, 'tampered')), { code: 'ENOENT' });
  await db.query('DELETE FROM dashboard_backup_chunks WHERE ordinal = 0');
  await assert.rejects(() => backup.recover(join(dir, 'missing')), /missing/);
  await assert.rejects(() => access(join(dir, 'missing')), { code: 'ENOENT' });
});

test('vault concurrency aborts publication rather than losing a credential edit', async (t) => {
  const { db, backup } = await fixture(t);
  await backup.backup();
  const old = await backup.store.latest();
  const publish = backup.store.publish.bind(backup.store);
  backup.store.publish = async (...args) => {
    const vault = await db.get('vault');
    await db.put('vault', { NEW: 'concurrent credential' }, vault.revision);
    return publish(...args);
  };
  await assert.rejects(() => backup.backup(), /publication failed/);
  assert.equal((await backup.store.latest()).id, old.id);
  assert.equal((await db.get('vault')).value.NEW, 'concurrent credential');
});

test('full mirror disables config-only recovery and startup resurrection; background jobs coalesce and rerun after edits', async (t) => {
  const { db, backup, source, state, claw } = await fixture(t);
  const persistence = new Persistence(
    db,
    claw,
    join(source, 'openclaw.json'),
    join(state, 'secrets.json'),
    backup,
  );
  const supervisor = { busy: true };
  const service = new Service(claw, {}, supervisor, { persistence });
  await assert.rejects(() => service.dispatch('database.backup'), /maintenance/);
  supervisor.busy = false;
  const realCapture = backup.capture.bind(backup);
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  let captures = 0;
  backup.capture = async () => {
    captures++;
    await wait;
    return realCapture();
  };
  assert.equal((await service.dispatch('database.backup')).running, true);
  assert.equal(supervisor.maintenanceBlocked(), true);
  const first = backup.running;
  assert.equal(backup.backup(), first);
  await persistence.afterChange();
  release();
  await first;
  assert.equal(captures, 2, 'an edit during capture must get a subsequent snapshot');
  assert.equal(supervisor.maintenanceBlocked(), false);
  await assert.rejects(() => persistence.restore('hash'), /private terminal/);
  await rm(join(source, 'openclaw.json'));
  await assert.rejects(() => persistence.restoreMissing(), /recovery|recover/);
  await rm(join(state, 'secrets.json'));
  const vault = new Vault(state, db, { localAuthoritative: true });
  await vault.init({ restore: false });
  await vault.put('NEW', 'new-key');
  assert.deepEqual((await db.get('vault')).value, { NEW: 'new-key' });
});

test('backup options reject unsafe extra path configuration and never allow historical retention', () => {
  assert.deepEqual(fullBackupOptions({}), { maxBytes: 1024 ** 3, extraPaths: [] });
  assert.throws(() => fullBackupOptions({ OPENCLAW_BACKUP_EXTRA_PATHS: 'bad' }), /JSON array/);
  assert.throws(
    () => new FullBackup({}, {}, '/state', { extraPaths: ['relative'] }),
    /absolute paths/,
  );
  assert.throws(() => new FullBackup({}, {}, '/state', { maxBytes: NaN }), /positive integer/);
});

test('unreadable extra roots fail closed and recovery refuses live/checkout/symlinked destinations', async (t) => {
  const { backup, dir, state } = await fixture(t);
  await backup.backup();
  const previous = await backup.store.latest();
  backup.extraPaths = [join(dir, 'missing-extra')];
  await assert.rejects(() => backup.backup(), { code: 'ENOENT' });
  assert.equal((await backup.store.latest()).id, previous.id);
  await assert.rejects(() => backup.recover(join(state, 'recovery')), /outside/);
  await assert.rejects(
    () => backup.recover(new URL('../private-test-recovery', import.meta.url).pathname),
    /outside/,
  );
  const { symlink } = await import('node:fs/promises');
  await symlink(state, join(dir, 'linked-state'));
  await assert.rejects(() => backup.recover(join(dir, 'linked-state', 'recovery')), /outside/);
});
