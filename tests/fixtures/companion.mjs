import { createApp } from '../../server/index.mjs';
import { Service } from '../../server/service.mjs';
import { Vault } from '../../server/vault.mjs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
const config = {
  agents: { defaults: { model: { primary: 'test/example' } } },
  channels: {},
  models: { providers: {} },
  update: { auto: { enabled: false } },
};
let hash = 1;
const messages = [];
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
const service = new Service(claw, new Vault(await mkdtemp(tmpdir() + '/dashboard-browser-')));
createApp({
  service,
  origin: 'https://test-agent-3000.app.github.dev',
  pagesOrigin: 'http://127.0.0.1:4173',
}).listen(4180, '0.0.0.0');
