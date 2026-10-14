// Immutable encrypted chunks; a snapshot becomes visible only after atomic publication.
export class BackupStore {
  constructor(db) {
    this.db = db;
  }
  async init() {
    await this.db.query(`CREATE TABLE IF NOT EXISTS dashboard_backups (
      namespace TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER, manifest TEXT,
      created_at TEXT NOT NULL, PRIMARY KEY(namespace, id), UNIQUE(namespace, revision))`);
    await this.db.query(`CREATE TABLE IF NOT EXISTS dashboard_backup_chunks (
      namespace TEXT NOT NULL, snapshot TEXT NOT NULL, ordinal INTEGER NOT NULL,
      value TEXT NOT NULL, PRIMARY KEY(namespace, snapshot, ordinal))`);
    return this;
  }
  async latest() {
    const result = await this.db.query(
      'SELECT id, revision, manifest, created_at FROM dashboard_backups WHERE namespace = ? AND revision IS NOT NULL ORDER BY revision DESC LIMIT 1',
      [this.db.namespace],
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          revision: Number(row.revision),
          updatedAt: row.created_at,
          value: this.db.decrypt(`backup:${row.id}:manifest`, row.manifest),
        }
      : { value: null, revision: 0, updatedAt: null };
  }
  async begin(id) {
    await this.db.query(
      'INSERT INTO dashboard_backups(namespace, id, created_at) VALUES (?, ?, ?)',
      [this.db.namespace, id, new Date().toISOString()],
    );
  }
  async write(id, ordinal, bytes) {
    const result = await this.db.query(
      `INSERT INTO dashboard_backup_chunks(namespace, snapshot, ordinal, value)
       SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM dashboard_backups
         WHERE namespace = ? AND id = ? AND revision IS NULL)`,
      [
        this.db.namespace,
        id,
        ordinal,
        this.db.encrypt(`backup:${id}:${ordinal}`, bytes.toString('base64')),
        this.db.namespace,
        id,
      ],
    );
    if (result.rowsAffected !== 1) throw new Error('Backup upload superseded by another sync.');
  }
  async read(id, ordinal) {
    const result = await this.db.query(
      'SELECT value FROM dashboard_backup_chunks WHERE namespace = ? AND snapshot = ? AND ordinal = ?',
      [this.db.namespace, id, ordinal],
    );
    if (!result.rows[0]) throw new Error('Backup chunk missing. No recovery files were published.');
    return Buffer.from(this.db.decrypt(`backup:${id}:${ordinal}`, result.rows[0].value), 'base64');
  }
  async publish(id, manifest, expectedRevision, vault) {
    const encrypted = this.db.encrypt(`backup:${id}:manifest`, manifest);
    let tx;
    try {
      tx = await this.db.client.transaction('write');
      const run = (sql, args = []) => tx.execute({ sql, args });
      const latest = await run(
        'SELECT MAX(revision) AS revision FROM dashboard_backups WHERE namespace = ?',
        [this.db.namespace],
      );
      if (Number(latest.rows[0].revision || 0) !== expectedRevision) throw new Error('Conflict');
      const result = await run(
        'UPDATE dashboard_backups SET revision = ?, manifest = ?, created_at = ? WHERE namespace = ? AND id = ? AND revision IS NULL',
        [expectedRevision + 1, encrypted, new Date().toISOString(), this.db.namespace, id],
      );
      if (result.rowsAffected !== 1) throw new Error('Missing upload');
      // Mirror policy: publication and deletion of ALL older data are one transaction.
      // Also retire competing/incomplete uploads so deleted data cannot linger in staging rows.
      await run('DELETE FROM dashboard_backup_chunks WHERE namespace = ? AND snapshot != ?', [
        this.db.namespace,
        id,
      ]);
      await run('DELETE FROM dashboard_backups WHERE namespace = ? AND id != ?', [
        this.db.namespace,
        id,
      ]);
      // Retire the old config-only integration; it must not resurrect deleted agent references.
      await run(
        "DELETE FROM dashboard_documents WHERE namespace = ? AND name IN ('openclaw-config', 'companion-settings')",
        [this.db.namespace],
      );
      if (vault) {
        const current = await run(
          "SELECT revision FROM dashboard_documents WHERE namespace = ? AND name = 'vault'",
          [this.db.namespace],
        );
        if (Number(current.rows[0]?.revision || 0) !== vault.revision)
          throw new Error('Vault changed');
        await run(
          `INSERT INTO dashboard_documents(namespace, name, value, revision, updated_at)
          VALUES (?, 'vault', ?, ?, ?) ON CONFLICT(namespace, name) DO UPDATE SET
          value = excluded.value, revision = excluded.revision, updated_at = excluded.updated_at`,
          [
            this.db.namespace,
            this.db.encrypt('vault', vault.value),
            vault.revision + 1,
            new Date().toISOString(),
          ],
        );
      }
      await tx.commit();
    } catch {
      if (tx) await tx.rollback().catch(() => {});
      throw new Error(
        'Full backup publication failed or conflicted. Check Database status before retrying; no partial snapshot is used for recovery.',
      );
    } finally {
      tx?.close();
    }
  }
  async discard(id) {
    // A lost commit response must never cause deletion of a successfully published snapshot.
    await this.db.query(
      `DELETE FROM dashboard_backup_chunks WHERE namespace = ? AND snapshot = ?
      AND EXISTS (SELECT 1 FROM dashboard_backups WHERE namespace = ? AND id = ? AND revision IS NULL)`,
      [this.db.namespace, id, this.db.namespace, id],
    );
    await this.db.query(
      'DELETE FROM dashboard_backups WHERE namespace = ? AND id = ? AND revision IS NULL',
      [this.db.namespace, id],
    );
  }
}
