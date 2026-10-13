import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
export class Vault {
  constructor(dir) {
    this.dir = dir;
    this.path = join(dir, 'secrets.json');
    this.queue = Promise.resolve();
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
      const data = await this.read();
      data[name] = value;
      const temp = `${this.path}.${randomUUID()}`;
      await writeFile(temp, JSON.stringify(data), { mode: 0o600 });
      await rename(temp, this.path);
      return { source: 'file', provider: 'dashboard', id: `/${name}` };
    });
    this.queue = work.catch(() => {});
    return work;
  }
}
