import { createApp } from '../../server/index.mjs';
import { Service } from '../../server/service.mjs';
import { Vault } from '../../server/vault.mjs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { Database } from '../../server/database.mjs';
import { Persistence, privateWrite } from '../../server/persistence.mjs';
import { Codespaces } from '../../server/codespaces.mjs';
const config = {
  agents: { defaults: { model: { primary: 'test/example' } } },
  channels: {},
  models: { providers: {} },
  update: { auto: { enabled: false } },
};
let hash = 1;
const messages = [];
const jobs = [];
const merge = (to, from) => {
  for (const [k, v] of Object.entries(from)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      to[k] ||= {};
      merge(to[k], v);
    } else to[k] = v;
  }
};
const claw = {
  rpc: async (method, p = {}) => {
    if (method === 'config.get') return { hash: String(hash), config };
    if (method === 'config.patch') {
      if (p.baseHash !== String(hash)) throw new Error('Configuration changed; refresh.');
      merge(config, JSON.parse(p.raw));
      await privateWrite(join(dir, 'openclaw.json'), config);
      hash++;
      return { ok: true };
    }
    if (method === 'chat.send') {
      messages.push(
        { role: 'user', content: p.message },
        { role: 'assistant', content: 'Fixture reply: ' + p.message },
      );
      return { runId: 'fixture-run' };
    }
    if (method === 'chat.history') return { messages };
    if (method === 'sessions.list')
      return {
        sessions: [
          { key: 'agent:main:main', displayName: 'Main conversation', model: 'test/example' },
        ],
      };
    if (method === 'agents.list') return { agents: [{ id: 'main', name: 'Main agent' }] };
    if (method === 'node.list')
      return { nodes: [{ nodeId: 'test-node', displayName: 'Test computer', connected: true }] };
    if (method === 'cron.list') return { jobs };
    if (method === 'cron.add') {
      jobs.push({ id: 'job-' + jobs.length, ...p });
      return { ok: true };
    }
    if (method === 'cron.update') {
      Object.assign(
        jobs.find((j) => j.id === p.id),
        p.patch,
      );
      return { ok: true };
    }
    if (method === 'cron.remove') {
      const index = jobs.findIndex((j) => j.id === p.id);
      if (index >= 0) jobs.splice(index, 1);
      return { ok: true };
    }
    if (method === 'cron.runs') return { entries: [{ status: 'ok' }] };
    if (method === 'models.list') return { models: [] };
    if (method === 'skills.status')
      return {
        skills: [
          {
            name: 'Weather',
            skillKey: 'weather',
            eligible: true,
            description: 'Test fixture skill',
          },
        ],
      };
    if (method === 'config.schema') return { schema: { type: 'object' } };
    return { ok: true };
  },
  command: async () => ({ plugins: [] }),
};
const dir = await mkdtemp(tmpdir() + '/dashboard-browser-');
const db = await new Database(
  createClient({ url: `file:${join(dir, 'database.db')}` }),
  'ab'.repeat(32),
  'browser',
).init();
const vault = new Vault(dir, db);
await privateWrite(join(dir, 'openclaw.json'), config);
const persistence = new Persistence(db, claw, join(dir, 'openclaw.json'), vault.path);
const codespaces = new Codespaces(db, {
  token: 'fixture-only',
  name: 'test-agent',
  fetcher: async (url, options) => ({
    ok: true,
    status: 200,
    json: async () =>
      url.endsWith('/machines')
        ? {
            machines: [
              { name: 'two-core', cpus: 2, display_name: '2-core fixture' },
              { name: 'four-core', cpus: 4, display_name: '4-core fixture' },
            ],
          }
        : { name: 'test-agent', state: 'Available', machine: { name: 'two-core', cpus: 2 } },
  }),
});
const service = new Service(claw, vault, null, { persistence, codespaces });
createApp({
  service,
  origin: 'https://test-agent-3000.app.github.dev',
  pagesOrigin: 'http://127.0.0.1:4173',
}).listen(4180, '0.0.0.0');
