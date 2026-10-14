import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { privateWrite } from './persistence.mjs';

export function validSignature(body, signature, secret) {
  if (typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  return timingSafeEqual(
    Buffer.from(signature.slice(7), 'hex'),
    createHmac('sha256', secret).update(body).digest(),
  );
}
const same = (a, b) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export class Messenger {
  constructor(claw, dir, env = process.env, fetcher = fetch) {
    this.claw = claw;
    this.env = env;
    this.fetcher = fetcher;
    this.path = join(dir, 'messenger-inbox.json');
    this.events = [];
    this.queue = Promise.resolve();
    this.running = false;
    this.allowed = new Set(
      (env.MESSENGER_ALLOWED_PSIDS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }
  async init() {
    if (
      ![
        'MESSENGER_APP_SECRET',
        'MESSENGER_VERIFY_TOKEN',
        'MESSENGER_PAGE_ACCESS_TOKEN',
        'MESSENGER_PAGE_ID',
        'MESSENGER_GRAPH_VERSION',
      ].every((k) => this.env[k])
    )
      throw new Error(
        'Messenger requires app secret, verify token, page access token, page ID, and Graph API version.',
      );
    if (
      !/^v\d+\.\d+$/.test(this.env.MESSENGER_GRAPH_VERSION) ||
      !/^\d+$/.test(this.env.MESSENGER_PAGE_ID) ||
      !this.allowed.size ||
      [...this.allowed].some((id) => !/^\d+$/.test(id))
    )
      throw new Error(
        'Messenger requires a Graph version (vNN.N), numeric Page ID, and an explicit numeric PSID allowlist.',
      );
    if (!/^[a-zA-Z0-9_-]+$/.test(this.env.MESSENGER_AGENT_ID || 'main'))
      throw new Error('Invalid Messenger agent ID.');
    try {
      this.events = JSON.parse(await readFile(this.path, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw new Error('Messenger inbox cannot be read.');
    }
    // Never replay a possibly executed agent turn or delivered message after a crash.
    for (const e of this.events)
      if (e.state === 'running') {
        e.state = 'failed';
        delete e.text;
      }
    await privateWrite(this.path, this.events);
    this.drain();
    return this;
  }
  status() {
    return {
      configured: true,
      mode: 'Custom text-only Page bridge',
      allowlistedPeople: this.allowed.size,
      queued: this.events.filter((e) => e.state === 'queued').length,
      failed: this.events.filter((e) => e.state === 'failed').length,
      delivered: this.events.filter((e) => e.state === 'delivered').length,
      notice:
        'Requires Meta Page setup and a public HTTPS webhook on separate port 3001. Unavailable while the Codespace sleeps. Not an official OpenClaw channel.',
    };
  }
  mutate(fn) {
    const work = this.queue.then(async () => {
      const before = structuredClone(this.events);
      try {
        const result = fn();
        await privateWrite(this.path, this.events);
        return result;
      } catch (e) {
        this.events = before;
        throw e;
      }
    });
    this.queue = work.catch(() => {});
    return work;
  }
  async accept(body) {
    if (body?.object !== 'page' || !Array.isArray(body.entry)) throw new Error('Invalid event.');
    await this.mutate(() => {
      const added = [];
      for (const entry of body.entry) {
        if (String(entry.id) !== this.env.MESSENGER_PAGE_ID || !Array.isArray(entry.messaging))
          continue;
        for (const e of entry.messaging) {
          const id = e?.message?.mid,
            sender = e?.sender?.id,
            text = e?.message?.text;
          if (
            !Number.isFinite(e?.timestamp) ||
            Math.abs(Date.now() - e.timestamp) > 24 * 60 * 60 * 1000
          )
            continue;
          if (
            e?.message?.is_echo ||
            !this.allowed.has(sender) ||
            String(e?.recipient?.id) !== this.env.MESSENGER_PAGE_ID ||
            typeof id !== 'string' ||
            id.length > 256 ||
            typeof text !== 'string' ||
            !text.trim() ||
            text.length > 8000
          )
            continue;
          if (this.events.some((x) => x.id === id) || added.some((x) => x.id === id)) continue;
          added.push({ id, sender, text, state: 'queued', at: new Date().toISOString() });
        }
      }
      if (
        this.events.filter((e) => ['queued', 'running'].includes(e.state)).length + added.length >
        50
      )
        throw new Error('Inbox full.');
      this.events.push(...added);
      // Retain the latest 1000 delivery IDs without keeping old message contents.
      this.events = [
        ...this.events.filter((e) => !['queued', 'running'].includes(e.state)).slice(-1000),
        ...this.events.filter((e) => ['queued', 'running'].includes(e.state)),
      ];
    });
    this.drain();
  }
  async send(sender, text) {
    const r = await this.fetcher(
      `https://graph.facebook.com/${this.env.MESSENGER_GRAPH_VERSION}/${this.env.MESSENGER_PAGE_ID}/messages`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(20000),
        headers: {
          Authorization: `Bearer ${this.env.MESSENGER_PAGE_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          recipient: { id: sender },
          messaging_type: 'RESPONSE',
          message: { text },
        }),
      },
    );
    if (!r.ok) throw new Error('Messenger delivery failed.');
  }
  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      let event;
      while ((event = this.events.find((e) => e.state === 'queued'))) {
        await this.mutate(() => {
          event.state = 'running';
        });
        try {
          if (Date.now() - Date.parse(event.at) > 23 * 60 * 60 * 1000)
            throw new Error('Reply window expired.');
          const result = await this.claw.command(
            [
              'agent',
              '--session-key',
              `agent:${this.env.MESSENGER_AGENT_ID || 'main'}:messenger:direct:${event.sender}`,
              '--message',
              event.text,
              '--json',
              '--timeout',
              '120',
            ],
            { timeout: 150000 },
          );
          const payload = result.result || result;
          const text = (payload.payloads || [])
            .filter((p) => typeof p.text === 'string')
            .map((p) => p.text)
            .join('\n')
            .trim();
          if (!text || result.status === 'error' || payload.meta?.error)
            throw new Error('No successful text reply.');
          const limited = [...text].slice(0, 18000);
          for (let i = 0; i < limited.length; i += 1800)
            await this.send(event.sender, limited.slice(i, i + 1800).join(''));
          await this.mutate(() => {
            event.state = 'delivered';
            delete event.text;
          });
        } catch {
          await this.mutate(() => {
            event.state = 'failed';
            delete event.text;
          });
        }
      }
    } catch {
      /* Inbox I/O failed: do not replay an uncertain turn. Status retains pending state. */
    } finally {
      this.running = false;
    }
  }
  createServer() {
    return http.createServer(async (req, res) => {
      const reply = (code, text) => {
        res.writeHead(code, {
          'Content-Type': 'text/plain',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(text);
      };
      try {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname !== '/webhook') return reply(404, 'Not found');
        if (req.method === 'GET') {
          if (
            url.searchParams.get('hub.mode') !== 'subscribe' ||
            !same(url.searchParams.get('hub.verify_token'), this.env.MESSENGER_VERIFY_TOKEN)
          )
            return reply(403, 'Forbidden');
          return reply(200, (url.searchParams.get('hub.challenge') || '').slice(0, 1000));
        }
        if (req.method !== 'POST') return reply(405, 'Method not allowed');
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 262144) return reply(413, 'Too large');
          chunks.push(chunk);
        }
        const raw = Buffer.concat(chunks);
        if (!validSignature(raw, req.headers['x-hub-signature-256'], this.env.MESSENGER_APP_SECRET))
          return reply(403, 'Forbidden');
        await this.accept(JSON.parse(raw));
        return reply(200, 'EVENT_RECEIVED');
      } catch {
        return reply(503, 'Webhook not accepted');
      }
    });
  }
}
