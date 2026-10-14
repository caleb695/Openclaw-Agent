import { createClient } from '@libsql/client';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Values (including config and vault data) are encrypted before leaving this process.
// The encryption key must be kept in GitHub secrets, never in the database itself.
export class Database {
  constructor(client, key, namespace = 'agent') {
    if (!/^[a-f0-9]{64}$/i.test(key || ''))
      throw new Error('DASHBOARD_ENCRYPTION_KEY must be 64 hexadecimal characters.');
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(namespace)) throw new Error('Invalid database namespace.');
    this.client = client;
    this.key = Buffer.from(key, 'hex');
    this.namespace = namespace;
  }
  async init() {
    await this.query(`CREATE TABLE IF NOT EXISTS dashboard_documents (
      namespace TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL,
      revision INTEGER NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (namespace, name))`);
    return this;
  }
  async query(sql, args = []) {
    try {
      return await this.client.execute({ sql, args });
    } catch {
      // libSQL exceptions can include connection URLs. Never forward them to the UI/logs.
      throw new Error(
        'Database unavailable. Check Turso secrets and connectivity; no fallback write was made.',
      );
    }
  }
  encrypt(name, value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`${this.namespace}:${name}:v1`));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
    ]);
    return JSON.stringify({
      v: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: ciphertext.toString('base64'),
    });
  }
  decrypt(name, value) {
    try {
      const e = JSON.parse(value);
      if (e.v !== 1) throw new Error();
      const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(e.iv, 'base64'));
      cipher.setAAD(Buffer.from(`${this.namespace}:${name}:v1`));
      cipher.setAuthTag(Buffer.from(e.tag, 'base64'));
      return JSON.parse(
        Buffer.concat([cipher.update(Buffer.from(e.data, 'base64')), cipher.final()]).toString(
          'utf8',
        ),
      );
    } catch {
      throw new Error(
        'Database decryption failed. Check the namespace and encryption key; stored data was not changed.',
      );
    }
  }
  async get(name) {
    const result = await this.query(
      'SELECT value, revision, updated_at FROM dashboard_documents WHERE namespace = ? AND name = ?',
      [this.namespace, name],
    );
    const row = result.rows[0];
    return row
      ? {
          value: this.decrypt(name, row.value),
          revision: Number(row.revision),
          updatedAt: row.updated_at,
        }
      : { value: null, revision: 0, updatedAt: null };
  }
  async put(name, value, revision) {
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new Error('Refresh database state before saving.');
    const updatedAt = new Date().toISOString();
    const encoded = this.encrypt(name, value);
    const result =
      revision === 0
        ? await this.query(
            'INSERT INTO dashboard_documents (namespace, name, value, revision, updated_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT DO NOTHING',
            [this.namespace, name, encoded, updatedAt],
          )
        : await this.query(
            'UPDATE dashboard_documents SET value = ?, revision = revision + 1, updated_at = ? WHERE namespace = ? AND name = ? AND revision = ?',
            [encoded, updatedAt, this.namespace, name, revision],
          );
    if (result.rowsAffected !== 1)
      throw new Error(
        'Database changed elsewhere. Refresh before saving; your edit was not overwritten.',
      );
    return { revision: revision + 1, updatedAt };
  }
  close() {
    this.client.close();
  }
}
export async function databaseFromEnv(env = process.env) {
  const values = [env.TURSO_DATABASE_URL, env.TURSO_AUTH_TOKEN, env.DASHBOARD_ENCRYPTION_KEY];
  if (values.every((v) => !v)) return null;
  if (values.some((v) => !v))
    throw new Error(
      'Set TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, and DASHBOARD_ENCRYPTION_KEY together.',
    );
  let url;
  try {
    url = new URL(env.TURSO_DATABASE_URL);
  } catch {
    throw new Error('Invalid Turso database URL.');
  }
  if (
    !['libsql:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Use a secure libsql:// or https:// Turso database URL without credentials.');
  let client;
  try {
    client = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
  } catch {
    throw new Error('Invalid Turso client configuration.');
  }
  return new Database(
    client,
    env.DASHBOARD_ENCRYPTION_KEY,
    env.DASHBOARD_NAMESPACE || 'agent',
  ).init();
}
