import { readFile, mkdir, writeFile, rename, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import JSON5 from 'json5';

export async function privateWrite(path, data) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}`;
  await writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(temp, path);
}
export class Persistence {
  constructor(db, claw, configPath, vaultPath) {
    this.db = db;
    this.claw = claw;
    this.configPath = configPath;
    this.vaultPath = vaultPath;
    this.lastWarning = null;
    this.queue = Promise.resolve();
  }
  // Run before the managed Gateway starts. Never replace existing local config.
  async restoreMissing() {
    if (!this.db) return;
    let exists = true;
    try {
      await access(this.configPath);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      exists = false;
    }
    if (!exists) {
      const saved = await this.db.get('openclaw-config');
      if (saved.value) await privateWrite(this.configPath, this.rebind(saved.value));
    }
    const companion = await this.db.get('companion-settings');
    for (const file of ['settings.json', 'updates.json']) {
      if (!companion.value?.[file]) continue;
      const path = join(dirname(this.vaultPath), file);
      try {
        await access(path);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        await privateWrite(path, companion.value[file]);
      }
    }
  }
  rebind(config) {
    const value = structuredClone(config);
    if (value.secrets?.providers?.dashboard?.source === 'file')
      value.secrets.providers.dashboard.path = this.vaultPath;
    return value;
  }
  async status() {
    if (!this.db)
      return {
        configured: false,
        mode: 'Local only',
        notice: 'Add Turso secrets to Codespaces and Actions to enable encrypted persistence.',
      };
    const saved = await this.db.get('openclaw-config');
    return {
      configured: true,
      mode: 'Turso · AES-256-GCM',
      revision: saved.revision,
      updatedAt: saved.updatedAt,
      warning: this.lastWarning,
      notice:
        'Config and dashboard vault only. Chat, memory, installed plugins, and channel login files still require OpenClaw backups.',
    };
  }
  backup() {
    const work = this.queue.then(async () => {
      if (!this.db)
        return { saved: false, notice: 'Local configuration saved. Turso is not configured.' };
      const companion = {};
      for (const file of ['settings.json', 'updates.json']) {
        try {
          companion[file] = JSON.parse(await readFile(join(dirname(this.vaultPath), file), 'utf8'));
        } catch (e) {
          if (e.code !== 'ENOENT') throw e;
        }
      }
      if (Object.keys(companion).length) {
        const old = await this.db.get('companion-settings');
        await this.db.put('companion-settings', companion, old.revision);
      }
      const saved = await this.db.get('openclaw-config');
      // config.get intentionally redacts credentials. Back up the private source instead,
      // retaining SecretRefs and ${ENV} placeholders, never a resolved browser projection.
      let source;
      try {
        source = await readFile(this.configPath, 'utf8');
      } catch {
        throw new Error(
          'Private OpenClaw configuration cannot be read. Check OPENCLAW_CONFIG_PATH.',
        );
      }
      let config;
      try {
        config = JSON5.parse(source);
      } catch {
        throw new Error('Private OpenClaw configuration is not valid JSON5.');
      }
      const hasInclude = (value) =>
        value &&
        typeof value === 'object' &&
        (Object.hasOwn(value, '$include') || Object.values(value).some(hasInclude));
      if (hasInclude(config))
        throw new Error(
          'Cloud snapshots require a single configuration file. Back up $include files with OpenClaw backup instead.',
        );
      if (
        !config ||
        typeof config !== 'object' ||
        Array.isArray(config) ||
        /__OPENCLAW_REDACTED__|\[REDACTED\]/.test(source)
      )
        throw new Error('Invalid or redacted config; cloud snapshot was not changed.');
      const validation = await this.claw.command(['config', 'validate', '--json']);
      if (validation.valid === false)
        throw new Error('OpenClaw rejected this configuration. Cloud snapshot was not changed.');
      if (source !== (await readFile(this.configPath, 'utf8')))
        throw new Error('Configuration changed during validation. Back up again.');
      const result = await this.db.put('openclaw-config', config, saved.revision);
      this.lastWarning = null;
      return { saved: true, ...result, notice: 'Encrypted configuration snapshot saved to Turso.' };
    });
    this.queue = work.catch(() => {});
    return work;
  }
  async afterChange() {
    if (!this.db) return '';
    try {
      return ' ' + (await this.backup()).notice;
    } catch {
      this.lastWarning =
        'The local change was accepted, but cloud backup failed. Check Database and use Back up now after the Gateway is ready.';
      return ' ' + this.lastWarning;
    }
  }
  async restore(hash) {
    if (!this.db) throw new Error('Turso is not configured.');
    const saved = await this.db.get('openclaw-config');
    if (!saved.value) throw new Error('No saved configuration exists.');
    if (typeof hash !== 'string' || !hash)
      throw new Error('Refresh configuration before restoring.');
    // config.apply performs authoritative OpenClaw validation and optimistic concurrency.
    await this.claw.rpc('config.apply', {
      raw: JSON.stringify(this.rebind(saved.value)),
      baseHash: hash,
    });
    return {
      saved: true,
      notice:
        'Saved configuration submitted to the Gateway for validation and restart. Refresh to verify.',
    };
  }
}
