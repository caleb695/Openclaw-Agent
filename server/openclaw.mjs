import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export class OpenClaw {
  constructor(bin = process.env.OPENCLAW_BIN || 'openclaw') {
    this.bin = bin;
  }
  async command(args, { json = true, timeout = 60000 } = {}) {
    try {
      const pending = exec(this.bin, args, {
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, NO_COLOR: '1' },
        windowsHide: true,
      });
      pending.child?.stdin?.end();
      const { stdout } = await pending;
      if (!json) return { completed: true }; // never forward CLI logs: plugins may print secrets
      try {
        return JSON.parse(stdout);
      } catch {
        // Some releases print startup notices before their JSON document.
        const lines = stdout.split('\n');
        for (let i = 0; i < lines.length; i++) {
          try {
            return JSON.parse(lines.slice(i).join('\n'));
          } catch {
            /* continue */
          }
        }
        throw new Error('Expected JSON');
      }
    } catch (e) {
      // No stderr, argv, or arbitrary plugin errors cross the security boundary.
      throw new Error(
        e.code === 'ENOENT'
          ? 'OpenClaw CLI not found. Install it in Agent, then restart the companion.'
          : e.killed
            ? 'OpenClaw timed out. The operation may still have applied; refresh before retrying.'
            : 'OpenClaw rejected this operation. Check Gateway health, installed-version support, config schema, and private terminal diagnostics. No automatic retry was made.',
      );
    }
  }
  rpc(method, params = {}) {
    return this.command([
      'gateway',
      'call',
      method,
      '--params',
      JSON.stringify(params),
      '--json',
      '--timeout',
      '45000',
    ]);
  }
}
export const readMethods = new Set([
  'health',
  'status',
  'models.list',
  'sessions.list',
  'chat.history',
  'skills.status',
  'channels.status',
  'cron.list',
  'node.list',
  'config.schema',
]);
export const writeMethods = new Set([
  'chat.send',
  'chat.abort',
  'skills.update',
  'skills.install',
  'cron.run',
  'cron.remove',
  'cron.add',
  'cron.update',
  'sessions.patch',
]);
export const secretKey =
  /api.?key|token$|secret|password|credential|authorization|cookie|private.?key/i;
export const isRef = (v) =>
  v &&
  typeof v === 'object' &&
  ['env', 'file', 'exec', 'store'].includes(v.source) &&
  typeof v.id === 'string' &&
  typeof v.provider === 'string';
export function sanitize(value, key = '') {
  if (isRef(value)) return value;
  if (secretKey.test(key) && value != null && value !== '') return '[REDACTED]';
  if (Array.isArray(value)) return value.map((v) => sanitize(v));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v, k)]));
  return value;
}
// Schemas describe credential fields; their names are not credential values.
// Strip authored defaults/examples rather than destroying secret-field schemas.
export function sanitizeSchema(value) {
  if (Array.isArray(value)) return value.map(sanitizeSchema);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !['default', 'example', 'examples'].includes(key))
        .map(([key, item]) => [key, sanitizeSchema(item)]),
    );
  return value;
}
export function validateTree(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, v] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key))
      throw new Error('Unsafe configuration key.');
    validateTree(v);
  }
}
export function rejectInlineSecrets(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, v] of Object.entries(value)) {
    if (secretKey.test(key) && v != null && v !== '' && typeof v !== 'boolean' && !isRef(v))
      throw new Error(
        'Use Credentials in the private companion for secrets; only SecretRefs are accepted here.',
      );
    if (key === 'env' || key === 'headers') {
      if (v && Object.values(v).some((x) => typeof x === 'string' && !/^\$\{[A-Z0-9_]+\}$/.test(x)))
        throw new Error('Use server-side secret references for environment values and headers.');
    }
    rejectInlineSecrets(v);
  }
}
export async function patchConfig(claw, patch, baseHash, replacePaths = []) {
  validateTree(patch);
  if (!baseHash || typeof baseHash !== 'string')
    throw new Error('Refresh the configuration before saving (missing base hash).');
  return claw.rpc('config.patch', {
    raw: JSON.stringify(patch),
    baseHash,
    ...(replacePaths.length ? { replacePaths } : {}),
  });
}
