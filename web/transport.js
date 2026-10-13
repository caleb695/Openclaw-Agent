export class Transport {
  constructor(onState) {
    this.onState = onState;
    this.pending = new Map();
    this.channel = crypto.randomUUID();
    this.connected = false;
    window.addEventListener('message', (e) => {
      const m = e.data;
      if (
        !this.popup ||
        e.source !== this.popup ||
        e.origin !== this.origin ||
        m?.kind !== 'openclaw' ||
        m.channel !== this.channel
      )
        return;
      if (m.type === 'ready') {
        clearInterval(this.hello);
        clearTimeout(this.deadline);
        this.connected = true;
        this.onState('connected');
      }
      if (m.type === 'response') {
        const p = this.pending.get(m.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(m.id);
        m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
      }
    });
  }
  connect(url) {
    const target = new URL(url);
    if (
      target.protocol !== 'https:' ||
      !/^[a-z0-9-]+-3000\.app\.github\.dev$/.test(target.hostname) ||
      target.username ||
      target.password ||
      target.search ||
      target.hash ||
      !['', '/', '/bridge'].includes(target.pathname)
    )
      throw new Error('Use the private HTTPS forwarded URL for port 3000 (…-3000.app.github.dev).');
    this.disconnect();
    this.origin = target.origin;
    this.channel = crypto.randomUUID();
    this.popup = window.open(
      `${target.origin}/bridge`,
      'openclaw-companion',
      'width=760,height=850',
    );
    if (!this.popup) throw new Error('Allow popups for this site, then connect again.');
    this.onState('waiting');
    this.monitor = setInterval(() => {
      if (this.popup?.closed) this.disconnect();
    }, 1000);
    this.hello = setInterval(() => {
      if (this.popup.closed) {
        this.disconnect();
        return;
      }
      this.popup.postMessage(
        { kind: 'openclaw', type: 'hello', channel: this.channel },
        this.origin,
      );
    }, 1000);
    this.deadline = setTimeout(() => {
      this.disconnect();
      this.onState('timeout');
    }, 120000);
  }
  disconnect() {
    clearInterval(this.hello);
    clearTimeout(this.deadline);
    clearInterval(this.monitor);
    this.popup = null;
    this.connected = false;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Connection closed. Refresh to check any pending operation.'));
    }
    this.pending.clear();
    this.onState('disconnected');
  }
  request(action, params = {}) {
    if (!this.connected || !this.popup || this.popup.closed) {
      this.disconnect();
      return Promise.reject(
        new Error(
          'Connect to Agent first. Start the Codespace, then authorize its private companion window.',
        ),
      );
    }
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error('Request timed out. Check the Codespace and refresh before retrying a write.'),
        );
      }, 190000);
      this.pending.set(id, { resolve, reject, timer });
      this.popup.postMessage(
        { kind: 'openclaw', type: 'request', channel: this.channel, id, action, params },
        this.origin,
      );
    });
  }
  openVault() {
    if (!this.popup || this.popup.closed) throw new Error('Connect to Agent first.');
    this.popup.focus();
  }
}
