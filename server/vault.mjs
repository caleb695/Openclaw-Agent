import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
export class Vault {
  constructor(dir, db = null, { localAuthoritative = false } = {}) {
    this.localAuthoritative = localAuthoritative;
    this.db = db;
    this.dir = dir;
    this.path = join(dir, 'secrets.json');
    this.queue = Promise.resolve();
  }
  async init({ restore = true } = {}) {
    if (!this.db || !restore) return;
    const stored = await this.db.get('vault');
    if (stored.value) await this.writeLocal(stored.value);
    else {
      const local = await this.read();
      if (Object.keys(local).length) await this.db.put('vault', local, 0);
    }
  }
  async writeLocal(data) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    const temp = `${this.path}.${randomUUID()}`;
    await writeFile(temp, JSON.stringify(data), { mode: 0o600 });
    await rename(temp, this.path);
  }
  async read() {
    try {
      return JSON.parse(await readFile(this.path, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return {};
      throw e;
    }
  }
  async names() {
    return Object.keys(await this.read());
  }
  async put(name, value) {
    if (
      !/^[A-Z][A-Z0-9_]{0,127}$/.test(name) ||
      typeof value !== 'string' ||
      !value ||
      value.length > 32000
    )
      throw new Error('Use an uppercase credential name and a non-empty value (maximum 32 KB).');
    const work = this.queue.then(async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await chmod(this.dir, 0o700);
      const stored = this.db ? await this.db.get('vault') : null;
      const data = this.localAuthoritative
        ? await this.read()
        : stored?.value || (await this.read());
      data[name] = value;
      if (this.db) await this.db.put('vault', data, stored.revision);
      await this.writeLocal(data);
      return { source: 'file', provider: 'dashboard', id: `/${name}` };
    });
    this.queue = work.catch(() => {});
    return work;
  }
}
