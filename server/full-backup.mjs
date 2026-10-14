import {
  mkdtemp,
  mkdir,
  chmod,
  lstat,
  realpath,
  readdir,
  rm,
  open,
  rename,
  writeFile,
  readFile,
} from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve, dirname, basename, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import * as tar from 'tar';
import { BackupStore } from './backup-store.mjs';

const CHUNK_BYTES = 128 * 1024; // Base64 + encryption envelope remains well below request/row limits.
const TIMEOUT = 20 * 60 * 1000;
const checkout = fileURLToPath(new URL('../', import.meta.url));
const inside = (parent, child) => {
  const rel = relative(parent, child);
  return !rel || (!rel.startsWith('..') && !isAbsolute(rel));
};

export class FullBackup {
  constructor(db, claw, stateDir, { maxBytes = 1024 ** 3, extraPaths = [] } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new Error('Full backup maximum bytes must be a positive integer.');
    if (
      !Array.isArray(extraPaths) ||
      extraPaths.length > 20 ||
      extraPaths.some((p) => typeof p !== 'string' || !isAbsolute(p))
    )
      throw new Error(
        'OPENCLAW_BACKUP_EXTRA_PATHS must be a JSON array of at most 20 absolute paths.',
      );
    this.store = new BackupStore(db);
    this.claw = claw;
    this.stateDir = resolve(stateDir);
    this.maxBytes = maxBytes;
    this.extraPaths = extraPaths;
    this.running = null;
    this.phase = 'Idle';
    this.warning = null;
  }
  async init() {
    await this.store.init();
    return this;
  }
  async status() {
    const saved = await this.store.latest();
    return {
      revision: saved.revision,
      updatedAt: saved.updatedAt,
      bytes: saved.value?.bytes ?? null,
      capturedAt: saved.value?.capturedAt ?? null,
      busy: !!this.running,
      phase: this.phase,
      warning: this.warning,
      retainedSnapshots: 1,
      deletionPolicy:
        'Mirror: previous snapshots and chunks are deleted atomically on each successful sync. Local deletions remain pending until sync succeeds.',
      coverage:
        'Verified OpenClaw full archive (including workspaces), companion files, and configured extra paths.',
      hasArchiveWarnings: saved.value?.hasArchiveWarnings || false,
    };
  }
  backup() {
    // Coalesce clicks and timer ticks rather than queuing duplicate multi-gigabyte uploads.
    if (this.running) return this.running;
    this.running = (async () => {
      do {
        this.resyncRequested = false;
        await this.capture();
      } while (this.resyncRequested);
      return {
        saved: true,
        notice: 'Full mirror synced to Turso. Previous snapshots and chunks were deleted.',
      };
    })()
      .catch((error) => {
        this.warning =
          'Full backup failed. The last completed recovery point is unchanged unless publication completed; refresh status. Check private CLI diagnostics, storage limits, and Turso connectivity.';
        throw error;
      })
      .finally(() => {
        this.running = null;
        this.phase = 'Idle';
      });
    return this.running;
  }
  async capture() {
    const capturedAt = new Date().toISOString();
    const previous = await this.store.latest(); // Also verifies the key before any upload.
    const vault = await this.store.db.get('vault');
    try {
      vault.value = JSON.parse(await readFile(join(this.stateDir, 'secrets.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      vault.value = {};
    }
    const id = randomUUID();
    const scratch = await mkdtemp(join(tmpdir(), 'openclaw-turso-'));
    await chmod(scratch, 0o700);
    try {
      this.phase = 'Creating and verifying OpenClaw archive';
      const nativeDir = join(scratch, 'native');
      await mkdir(nativeDir, { mode: 0o700 });
      const report = await this.claw.command(
        ['backup', 'create', '--output', nativeDir, '--verify', '--json'],
        { timeout: TIMEOUT },
      );
      const names = await readdir(nativeDir);
      if (names.length !== 1 || !names[0].endsWith('.tar.gz'))
        throw new Error('OpenClaw did not produce exactly one full backup archive.');
      const native = join(nativeDir, names[0]);
      if (!(await lstat(native)).isFile()) throw new Error('Invalid backup archive.');
      const artifacts = [{ path: native, name: 'openclaw.tar.gz', kind: 'openclaw' }];
      this.phase = 'Capturing companion and extra files';
      await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
      const roots = [this.stateDir, ...this.extraPaths];
      for (const [index, root] of roots.entries()) {
        const source = await realpath(root); // Explicit extra root symlinks resolve; nested links do not.
        if (inside(source, scratch))
          throw new Error('Backup source contains its temporary output.');
        const file = join(scratch, `supplement-${index}.tar.gz`);
        const companion = index === 0;
        await tar.c(
          {
            file,
            gzip: true,
            portable: true,
            strict: true,
            cwd: companion ? source : dirname(source),
            filter: (name) =>
              !companion ||
              !['backups', 'companion.pid', 'companion.log'].includes(
                name.replace(/^\.\//, '').split('/')[0],
              ),
          },
          [companion ? '.' : basename(source)],
        );
        artifacts.push({
          path: file,
          name: companion ? 'companion.tar.gz' : `extra-${index}.tar.gz`,
          kind: companion ? 'companion' : 'extra',
          source,
        });
      }
      await this.store.begin(id);
      this.phase = 'Uploading encrypted chunks';
      const manifest = {
        version: 1,
        capturedAt,
        id,
        bytes: 0,
        artifacts: [],
        // This can contain private paths; it is encrypted, never returned to the browser.
        openclawReport: report,
        hasArchiveWarnings: !!report?.warnings?.length,
      };
      let ordinal = 0;
      for (const artifact of artifacts) {
        const hash = createHash('sha256');
        const entry = {
          name: artifact.name,
          kind: artifact.kind,
          source: artifact.source,
          start: ordinal,
          chunks: 0,
          bytes: 0,
        };
        for await (const chunk of createReadStream(artifact.path, { highWaterMark: CHUNK_BYTES })) {
          manifest.bytes += chunk.length;
          if (manifest.bytes > this.maxBytes)
            throw new Error(
              'Full backup exceeds OPENCLAW_BACKUP_MAX_BYTES. Nothing was truncated or published.',
            );
          hash.update(chunk);
          await this.store.write(id, ordinal++, chunk);
          entry.chunks++;
          entry.bytes += chunk.length;
        }
        entry.sha256 = hash.digest('hex');
        manifest.artifacts.push(entry);
      }
      this.phase = 'Publishing recovery point';
      await this.store.publish(id, manifest, previous.revision, vault);
      this.warning = null;
      return {
        saved: true,
        revision: previous.revision + 1,
        notice:
          'Verified full OpenClaw archive and companion files saved to Turso as encrypted chunks. Previous snapshots were deleted. Check archive warnings and test recovery before deleting the Codespace.',
      };
    } catch (error) {
      await this.store.discard(id).catch(() => {});
      // Filesystem/tar errors may contain private filenames. Only the local CLI sees specifics.
      throw error;
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
  // Recovery is a terminal-only operation. Never write into a running agent's state.
  async recover(destination, { extract = false } = {}) {
    const saved = await this.store.latest();
    if (!saved.value) throw new Error('No completed full backup exists.');
    const manifest = saved.value;
    if (manifest.version !== 1 || manifest.id !== saved.id || !Array.isArray(manifest.artifacts))
      throw new Error('Unsupported backup manifest.');
    const target = resolve(destination);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    // Resolve existing parent links before checking destinations. Recovery material must
    // never be accidentally published in this checkout or mixed into live source trees.
    const canonicalTarget = join(await realpath(dirname(target)), basename(target));
    const forbidden = [
      checkout,
      this.stateDir,
      process.env.OPENCLAW_STATE_DIR || join(homedir(), '.openclaw'),
      ...manifest.artifacts.map((artifact) => artifact.source).filter(Boolean),
    ];
    for (const root of forbidden) {
      const canonical = await realpath(root).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return resolve(root);
      });
      if (inside(canonical, canonicalTarget))
        throw new Error(
          'Recovery output must be outside the Git checkout and live backup source roots.',
        );
    }
    // Reserve a new private directory; an existing destination (including symlinks) is refused.
    await mkdir(target, { mode: 0o700 });
    const pending = join(target, '.incomplete');
    await mkdir(pending, { mode: 0o700 });
    try {
      let total = 0;
      let nextChunk = 0;
      const seen = new Set();
      for (const artifact of manifest.artifacts) {
        if (
          !/^(openclaw|companion|extra-[1-9][0-9]*)\.tar\.gz$/.test(artifact.name) ||
          seen.has(artifact.name) ||
          !Number.isSafeInteger(artifact.start) ||
          artifact.start !== nextChunk ||
          !Number.isSafeInteger(artifact.chunks) ||
          artifact.chunks < 1 ||
          artifact.chunks > Math.ceil(this.maxBytes / CHUNK_BYTES) ||
          !Number.isSafeInteger(artifact.bytes) ||
          artifact.bytes < 1 ||
          artifact.bytes > this.maxBytes
        )
          throw new Error('Invalid backup artifact.');
        seen.add(artifact.name);
        nextChunk += artifact.chunks;
        const file = await open(join(pending, artifact.name), 'wx', 0o600);
        const hash = createHash('sha256');
        let bytes = 0;
        try {
          for (let i = 0; i < artifact.chunks; i++) {
            const chunk = await this.store.read(saved.id, artifact.start + i);
            bytes += chunk.length;
            total += chunk.length;
            if (
              !chunk.length ||
              chunk.length > CHUNK_BYTES ||
              bytes > artifact.bytes ||
              total > this.maxBytes
            )
              throw new Error('Backup size verification failed.');
            hash.update(chunk);
            await file.writeFile(chunk);
          }
          await file.sync();
        } finally {
          await file.close();
        }
        if (bytes !== artifact.bytes || hash.digest('hex') !== artifact.sha256)
          throw new Error('Backup checksum verification failed.');
      }
      if (!seen.has('openclaw.tar.gz') || !seen.has('companion.tar.gz') || total !== manifest.bytes)
        throw new Error('Incomplete full backup manifest.');
      await this.claw.command(['backup', 'verify', join(pending, 'openclaw.tar.gz'), '--json'], {
        timeout: TIMEOUT,
      });
      if (extract) {
        await this.claw.command(
          [
            'backup',
            'restore',
            join(pending, 'openclaw.tar.gz'),
            '--target',
            join(pending, 'openclaw-restored'),
            '--json',
          ],
          { timeout: TIMEOUT },
        );
        // Leave supplemental tarballs intact for owner review. No arbitrary archive links are activated.
      }
      await writeFile(join(pending, 'manifest.json'), JSON.stringify(manifest, null, 2), {
        mode: 0o600,
      });
      await rename(pending, join(target, 'recovery'));
      return { revision: saved.revision, directory: join(target, 'recovery') };
    } catch (error) {
      await rm(target, { recursive: true, force: true });
      throw error;
    }
  }
}

export function fullBackupOptions(env = process.env) {
  let extraPaths;
  try {
    extraPaths = JSON.parse(env.OPENCLAW_BACKUP_EXTRA_PATHS || '[]');
  } catch {
    throw new Error('OPENCLAW_BACKUP_EXTRA_PATHS must be a JSON array.');
  }
  return { maxBytes: Number(env.OPENCLAW_BACKUP_MAX_BYTES || 1024 ** 3), extraPaths };
}
