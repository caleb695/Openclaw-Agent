import {
  readMethods,
  writeMethods,
  sanitize,
  sanitizeSchema,
  rejectInlineSecrets,
  validateTree,
  patchConfig,
} from './openclaw.mjs';
export class Service {
  constructor(
    claw,
    vault,
    supervisor = null,
    { persistence = null, codespaces = null, messenger = null } = {},
  ) {
    this.persistence = persistence;
    this.codespaces = codespaces;
    this.messenger = messenger;
    this.claw = claw;
    this.vault = vault;
    this.supervisor = supervisor;
    this.mutating = false;
    if (supervisor)
      supervisor.maintenanceBlocked = () =>
        this.mutating || !!this.persistence?.fullBackup?.running;
  }
  async config() {
    const c = await this.claw.rpc('config.get');
    // Intentionally discard raw/resolved/source strings, which can bypass redaction.
    return {
      config: sanitize(c.config || {}),
      hash: c.hash,
      valid: c.valid,
      issues: sanitize(c.issues || []),
    };
  }
  async dispatch(action, p = {}, privateRequest = false) {
    const result = await this.execute(action, p, privateRequest);
    if (
      this.persistence &&
      ['patch', 'credentials.save', 'updates.policy', 'plugins.change'].includes(action)
    ) {
      const backup = await this.persistence.afterChange();
      if (backup) {
        result.notice = (result.notice || 'Change accepted.') + backup;
        if (this.persistence.lastWarning)
          result.warning = [result.warning, this.persistence.lastWarning].filter(Boolean).join(' ');
      }
    }
    return result;
  }
  async execute(action, p = {}, privateRequest = false) {
    if (typeof action !== 'string' || !p || typeof p !== 'object' || Array.isArray(p))
      throw new Error('Invalid action parameters.');
    validateTree(p);
    if (action === 'database.status') return this.persistence?.status() || { configured: false };
    if (action === 'database.backup') {
      if (!this.persistence) throw new Error('Database integration is not configured.');
      if (this.supervisor?.busy) throw new Error('Wait for Gateway maintenance before syncing.');
      return this.persistence.startBackup();
    }
    if (action === 'database.restore') {
      if (!this.persistence) throw new Error('Database integration is not configured.');
      if (this.supervisor?.busy) throw new Error('Wait for Gateway maintenance before restoring.');
      return this.persistence.restore(p.hash);
    }
    if (action === 'messenger.status')
      return (
        this.messenger?.status() || {
          configured: false,
          notice: 'Messenger bridge is disabled. See docs/INTEGRATIONS.md.',
        }
      );
    if (action.startsWith('codespaces.')) {
      if (!this.codespaces) throw new Error('Codespaces integration is not configured.');
      if (action === 'codespaces.status') return this.codespaces.status();
      if (action === 'codespaces.schedule') return this.codespaces.saveSchedule(p);
      if (action === 'codespaces.resize') return this.codespaces.resize(p.machine);
    }
    if (
      this.supervisor?.busy &&
      !['updates.status', 'updates.mode', 'gateway.status', 'credentials.list'].includes(action)
    )
      throw new Error(
        'Gateway maintenance in progress. Check update status before making changes.',
      );
    if (action === 'config') return this.config();
    if (action === 'rpc') {
      if (!readMethods.has(p.method) && !writeMethods.has(p.method))
        throw new Error('RPC method is not allowed.');
      rejectInlineSecrets(p.params);
      const result = await this.claw.rpc(p.method, p.params || {});
      return p.method === 'config.schema' ? sanitizeSchema(result) : sanitize(result);
    }
    if (action === 'patch') {
      rejectInlineSecrets(p.patch);
      await patchConfig(this.claw, p.patch, p.hash, p.replacePaths || []);
      return {
        saved: true,
        notice:
          'Validated patch accepted. The Gateway may restart; refresh to verify the applied configuration.',
      };
    }
    if (action === 'plugins.list')
      return sanitize(await this.claw.command(['plugins', 'list', '--json']));
    if (action === 'plugins.change') {
      const { operation, id } = p;
      if (
        !['enable', 'disable', 'install', 'update', 'uninstall'].includes(operation) ||
        typeof id !== 'string' ||
        id.length > 200 ||
        !/^(?:@[a-z0-9_-]+\/)?[a-z0-9_][a-z0-9_.-]*(?:@[a-z0-9_.-]+)?$/i.test(id || '')
      )
        throw new Error('Use a plugin ID or pinned npm package, not a URL, path, or command flag.');
      if (this.mutating) throw new Error('Another maintenance operation is running.');
      this.mutating = true;
      try {
        return await this.claw.command(
          ['plugins', operation, id, ...(operation === 'uninstall' ? ['--force'] : [])],
          { json: false, timeout: 180000 },
        );
      } finally {
        this.mutating = false;
      }
    }
    if (action === 'updates.status' && this.supervisor?.busy)
      return {
        dashboard: this.supervisor.status(),
        notice: 'Maintenance in progress; release inspection resumes after the updater finishes.',
      };
    if (action === 'updates.status')
      return {
        ...sanitize(await this.claw.command(['update', 'status', '--json'])),
        dashboard: this.supervisor?.status() || { mode: 'native' },
      };
    if (action === 'updates.mode') return this.supervisor?.status() || { mode: 'native' };
    if (action === 'updates.policy') {
      if (typeof p.enabled !== 'boolean') throw new Error('An enabled boolean is required.');
      if (this.supervisor) return this.supervisor.policySet(p.enabled);
      // Use the supported native updater, not a competing npm cron job.
      await patchConfig(
        this.claw,
        { update: { channel: 'stable', checkOnStart: true, auto: { enabled: p.enabled } } },
        p.hash,
      );
      return {
        saved: true,
        notice:
          'Policy saved. Automatic installation requires an OpenClaw-managed Gateway service; a foreground Gateway only shows update hints.',
      };
    }
    if (action === 'updates.run') {
      if (this.mutating)
        throw new Error('Plugin maintenance is running. Wait before updating OpenClaw.');
      if (this.supervisor) {
        if (this.supervisor.busy) throw new Error('An update is already running.');
        this.supervisor.check(true).catch(() => {});
        return {
          started: true,
          notice: 'Check Release status to follow the update. Acceptance is not completion.',
        };
      }
      return sanitize(await this.claw.rpc('update.run', {}));
    }
    if (action === 'gateway.status' && this.supervisor) return this.supervisor.status();
    if (action === 'gateway.status')
      return sanitize(await this.claw.command(['gateway', 'status', '--json']));
    if (action === 'credentials.list') return { names: await this.vault.names() };
    if (action === 'credentials.save' && privateRequest) {
      const ref = await this.vault.put(p.name, p.value);
      // Save first: validation must be able to resolve the file. A failed patch leaves a
      // safe, unbound credential which can be retried, not a broken reference.
      const c = await this.claw.rpc('config.get');
      await patchConfig(
        this.claw,
        {
          secrets: {
            providers: { dashboard: { source: 'file', path: this.vault.path, mode: 'json' } },
          },
        },
        c.hash,
      );
      try {
        await this.claw.rpc('secrets.reload', {});
      } catch {
        return {
          saved: true,
          ref,
          warning:
            'Stored, but secret reload failed. Restart the Gateway or run openclaw secrets reload in the private terminal.',
        };
      }
      return { saved: true, ref };
    }
    throw new Error('Action is not allowed on this interface.');
  }
}
