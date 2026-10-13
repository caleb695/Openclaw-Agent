const boot = await fetch('/api/bootstrap').then((r) => r.json());
const site = document.querySelector('#site');
site.textContent = `Only ${boot.pagesOrigin} can request access. Approve only your own dashboard; other sites on that origin share this permission.`;
let approved = false,
  peer = null,
  channel = null;
document.querySelector('#approve').onclick = () => {
  approved = true;
  document.querySelector('#approve').disabled = true;
  document.querySelector('#connection').textContent =
    'Approved. Return to the dashboard. If it still waits, reconnect there.';
};
window.addEventListener('message', async (e) => {
  if (
    !approved ||
    e.origin !== boot.pagesOrigin ||
    e.source !== window.opener ||
    !e.data ||
    e.data.kind !== 'openclaw'
  )
    return;
  const m = e.data;
  if (m.type === 'hello' && typeof m.channel === 'string') {
    peer = e.source;
    channel = m.channel;
    peer.postMessage({ kind: 'openclaw', type: 'ready', channel }, boot.pagesOrigin);
    return;
  }
  if (
    e.source !== peer ||
    m.channel !== channel ||
    m.type !== 'request' ||
    typeof m.id !== 'string'
  )
    return;
  try {
    // Credential submission can only originate in this private document, never via the relay.
    if (m.action === 'credentials.save')
      throw new Error('Enter credentials in the private companion.');
    const r = await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dashboard-CSRF': boot.csrf },
      body: JSON.stringify({ action: m.action, params: m.params }),
    });
    const result = await r.json();
    peer.postMessage(
      { kind: 'openclaw', type: 'response', channel, id: m.id, ...result },
      boot.pagesOrigin,
    );
  } catch (e) {
    peer?.postMessage(
      { kind: 'openclaw', type: 'response', channel, id: m.id, error: e.message },
      boot.pagesOrigin,
    );
  }
});
document.querySelector('#vault').onsubmit = async (e) => {
  e.preventDefault();
  const form = e.target,
    data = new FormData(form),
    button = form.querySelector('button');
  button.disabled = true;
  const params = { name: data.get('name'), value: data.get('value') };
  form.elements.value.value = '';
  try {
    const r = await fetch('/api/private', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dashboard-CSRF': boot.csrf },
      body: JSON.stringify({ action: 'credentials.save', params }),
    });
    const result = await r.json();
    document.querySelector('#result').textContent =
      result.error ||
      `Saved. Reference:\n${JSON.stringify(result.result.ref, null, 2)}${result.result.warning ? '\n' + result.result.warning : ''}`;
  } catch {
    document.querySelector('#result').textContent =
      'Connection lost. Check the companion and retry.';
  } finally {
    params.value = '';
    button.disabled = false;
  }
};
