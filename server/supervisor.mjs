import { spawn } from 'node:child_process';
import { gatewayEnvironment } from './environment.mjs';
import { mkdir, open, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
// Opt-in lifecycle ownership for Codespaces without systemd. Never adopts or kills
// an existing process. OpenClaw itself remains responsible for package updates.
export class Supervisor {
  constructor(claw, dir) {
    this.claw = claw;
    this.dir = dir;
    this.child = null;
    this.busy = false;
    this.stopping = false;
    this.policy = { enabled: false };
    this.last = { state: 'idle' };
  }
  async init() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      this.policy = JSON.parse(await readFile(join(this.dir, 'updates.json'), 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    await this.start();
    this.timer = setInterval(() => this.check().catch(() => {}), 60 * 60 * 1000);
    this.timer.unref();
    this.initial = setTimeout(() => this.check().catch(() => {}), 60000);
    this.initial.unref();
  }
  async start() {
    const gateway = await this.claw.command(['config', 'get', 'gateway', '--json']);
    if (gateway.mode === 'remote' || (gateway.bind && gateway.bind !== 'loopback'))
      throw new Error('Supervised mode requires gateway.mode=local and gateway.bind=loopback.');
    const port = gateway.port || 18789;
    const occupied = await new Promise((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port });
      s.once('connect', () => {
        s.destroy();
        resolve(true);
      });
      s.once('error', () => resolve(false));
    });
    if (occupied)
      throw new Error(
        'Gateway port is occupied. Stop the existing Gateway through its owner before enabling supervised mode. No process was stopped.',
      );
    const log = await open(join(this.dir, 'gateway.log'), 'a', 0o600);
    this.child = spawn(this.claw.bin, ['gateway', 'run', '--bind', 'loopback'], {
      stdio: ['ignore', log.fd, log.fd],
      env: gatewayEnvironment(),
    });
    this.child.on('error', () => {
      this.child = null;
      this.last = {
        state: 'failed',
        message: 'Could not launch OpenClaw. Check the private Gateway log.',
      };
    });
    this.child.on('exit', () => {
      this.child = null;
      if (!this.stopping)
        this.last = {
          state: 'stopped',
          message:
            'Gateway exited. Inspect gateway.log in the private state directory, then restart the companion.',
        };
    });
    await log.close();
  }
  async stop() {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    this.stopping = true;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), 90000);
      timer.unref();
    });
    const ok = await Promise.race([exited.then(() => true), timeout]);
    clearTimeout(timer);
    if (!ok) {
      this.stopping = false;
      throw new Error(
        'Gateway did not drain within 90 seconds. Update canceled; no forced kill was attempted.',
      );
    }
  }
  async policySet(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('Enabled must be a boolean.');
    if (this.busy)
      throw new Error('Update in progress; wait for completion before changing policy.');
    this.policy = { enabled };
    const path = join(this.dir, 'updates.json');
    await writeFile(path + '.tmp', JSON.stringify(this.policy), { mode: 0o600 });
    await rename(path + '.tmp', path);
    return {
      saved: true,
      notice: `Companion-managed stable updates ${enabled ? 'enabled' : 'disabled'}. Checks run hourly while Agent is awake; a verified backup precedes each update.`,
    };
  }
  status() {
    return {
      mode: 'companion-supervised',
      enabled: this.policy.enabled,
      running: !!this.child,
      busy: this.busy,
      last: this.last,
    };
  }
  async check(manual = false) {
    if (this.busy) throw new Error('An update is already in progress.');
    if (!manual && !this.policy.enabled) return;
    if (this.maintenanceBlocked?.())
      throw new Error('Plugin maintenance is in progress; update deferred.');
    this.busy = true;
    let stopped = false;
    try {
      this.last = { state: 'checking', at: new Date().toISOString() };
      const status = await this.claw.command(['update', 'status', '--json']);
      if (!status.availability?.hasRegistryUpdate) {
        this.last = { state: 'current', at: new Date().toISOString() };
        return;
      }
      if (
        status.update?.installKind !== 'package' ||
        !['npm', 'pnpm', 'bun'].includes(status.update?.packageManager) ||
        status.channel?.value !== 'stable'
      )
        throw new Error(
          'Automatic updates require a supported package-manager installation on the stable channel. Source, unknown-owner, and container installations must use their actual update owner.',
        );
      const target = status.availability.latestVersion || status.update.registry?.latestVersion;
      if (typeof target !== 'string' || !/^\d+\.\d+\.\d+$/.test(target))
        throw new Error('No exact stable release target was returned. Update refused.');
      if (!this.child) throw new Error('No companion-owned Gateway is running; update refused.');
      this.last = { state: 'draining', at: new Date().toISOString() };
      await this.stop();
      stopped = true;
      this.last = { state: 'backing-up', at: new Date().toISOString() };
      const backups = join(this.dir, 'backups');
      await mkdir(backups, { recursive: true, mode: 0o700 });
      await this.claw.command(['backup', 'create', '--output', backups, '--verify', '--json'], {
        timeout: 600000,
      });
      // Vault sits outside OpenClaw state and therefore needs its own private copy.
      try {
        await writeFile(
          join(backups, `vault-${Date.now()}.json`),
          await readFile(join(this.dir, 'secrets.json')),
          { mode: 0o600 },
        );
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      this.last = { state: 'installing', at: new Date().toISOString() };
      const result = await this.claw.command(
        ['update', '--yes', '--tag', target, '--no-restart', '--json'],
        { timeout: 1800000 },
      );
      if (result.status && !['ok', 'success'].includes(result.status))
        throw new Error(
          'Updater did not report a successful installation. Inspect OpenClaw update status in the private terminal.',
        );
      this.last = { state: 'verifying', at: new Date().toISOString() };
      await this.start();
      this.stopping = false;
      stopped = false;
      let healthy = false;
      for (let n = 0; n < 12; n++) {
        try {
          await this.claw.rpc('health');
          healthy = true;
          break;
        } catch {
          await delay(5000);
        }
      }
      if (!healthy)
        throw new Error(
          'Update finished but Gateway health did not recover. Inspect the private log and backup; automatic rollback of migrated state is unsafe.',
        );
      const running = await this.claw.rpc('status');
      if (running.runtimeVersion !== target)
        throw new Error(
          'Gateway recovered but does not report the requested release. Inspect OpenClaw update status; completion has not been verified.',
        );
      this.last = { state: 'completed', at: new Date().toISOString() };
    } catch (e) {
      this.last = { state: 'failed', at: new Date().toISOString(), message: e.message };
      if (stopped) {
        try {
          await this.start();
        } catch {
          /* last failure retained */
        }
      }
    } finally {
      this.stopping = false;
      this.busy = false;
    }
  }
  async close() {
    clearInterval(this.timer);
    clearTimeout(this.initial);
    await this.stop();
  }
}
