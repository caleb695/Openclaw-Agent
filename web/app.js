import './style.css';
import { Transport } from './transport.js';
import { icons } from './icons.js';
const $ = (s) => document.querySelector(s);
const esc = (x) =>
  String(x ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const json = (x) => JSON.stringify(x, null, 2);
const names = {
  overview: 'Overview',
  sessions: 'Sessions',
  cron: 'Automations',
  nodes: 'Nodes',
  agents: 'Agents',
  codespaces: 'Codespaces',
  database: 'Database',
  chat: 'Agent chat',
  models: 'Models & providers',
  channels: 'Messaging channels',
  skills: 'Skills',
  plugins: 'Plugins',
  credentials: 'Credentials',
  operations: 'Operations',
  settings: 'Configuration',
  updates: 'Updates',
};
const subtitles = {
  overview: 'Connection, configuration, and runtime at a glance.',
  sessions: 'Find a conversation and continue where you left off.',
  cron: 'Scheduled agent tasks. Separate from Codespace wake and sleep hours.',
  nodes: 'Devices connected to your Gateway.',
  agents: 'The agents configured in your Gateway.',
  codespaces: 'Set your working hours. Choose the right machine.',
  database: 'Encrypted cloud persistence, independent of your Codespace.',
  chat: 'A direct line to your OpenClaw agent.',
  models: 'Your endpoints. Your models. No provider lock-in.',
  channels: 'Connect your agent to the places you work.',
  skills: 'Give your agent the right capabilities.',
  plugins: 'Extend your agent with trusted integrations.',
  credentials: 'Secrets belong on your server. Not in your browser storage.',
  operations: 'Inspect sessions, scheduled work, and connected nodes.',
  settings: 'Fine-grained control, validated by your Gateway.',
  updates: 'Keep OpenClaw current, on your terms.',
};
let page = location.hash.slice(1) || 'overview',
  connection = 'disconnected',
  snapshot = null,
  updateMode = { mode: 'native' },
  busy = false,
  polling = false,
  session = 'agent:main:main',
  codespaceState = null,
  databaseState = null;
const transport = new Transport((state) => {
  connection = state;
  updateConnection();
  if (state === 'connected') {
    notice('Private companion connected. Loading Agent…');
    snapshot = null;
    codespaceState = null;
    databaseState = null;
    load();
  }
});
function stored(key) {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}
function store(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* optional preference */
  }
}
const field = (label, name, value = '', type = 'text', placeholder = '') =>
  `<label>${esc(label)}<input name="${esc(name)}" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" ${type === 'url' ? '' : 'autocomplete="off"'}></label>`;
const button = (text, action, cls = 'secondary') =>
  `<button class="${cls}" data-action="${action}">${text}</button>`;
function shell() {
  $('#app').innerHTML =
    `<aside><a class="brand" href="#overview"><span class="logo">${icons.agents}</span><span>OpenClaw<small>CONTROL CONSOLE</small></span></a><div class="workspace"><span class="avatar">A</span><div>Agent<small>Personal workspace</small></div><span class="mini-dot"></span></div><nav aria-label="Main navigation"><p class="nav-label">CHAT</p>${['chat', 'sessions'].map(nav).join('')}<p class="nav-label">CONTROL</p>${['overview', 'channels', 'agents', 'cron', 'nodes'].map(nav).join('')}<p class="nav-label">AGENT</p>${['models', 'skills', 'plugins'].map(nav).join('')}<p class="nav-label">SETTINGS</p>${['settings', 'credentials', 'database', 'codespaces', 'updates', 'operations'].map(nav).join('')}</nav><div class="sidebar-bottom"><div><span class="status-dot"></span><span id="sidebar-state">Not connected</span></div><small>GITHUB CODESPACES · AGENT</small><a href="https://github.com/caleb695/Openclaw-Agent" target="_blank" rel="noopener noreferrer">Repository ↗</a></div></aside><div class="main"><header><div class="breadcrumb">Workspace <span>/</span> <b id="crumb"></b></div><div class="header-actions"><span class="private-badge">◇ Private connection</span><button class="avatar" data-action="connection">A</button></div></header><main><div class="page-heading"><div><div class="eyebrow">OPENCLAW CONTROL PLANE</div><h1 id="title"></h1><p id="subtitle"></p></div><div class="heading-actions"><span id="status" class="badge">Offline</span>${button('↻ Refresh', 'refresh')}${button('Connect Agent ↗', 'connection', 'primary')}</div></div><div id="notice" role="status" aria-live="polite" hidden></div><div id="content"></div><footer><span>OPENCLAW <i>/</i> PERSONAL AGENT CONSOLE</span><span>Secrets stay in Agent <span class="green">◇</span></span></footer></main></div><dialog id="connect-dialog"><div class="dialog-head"><h2>Connect your Agent</h2><button data-action="close-dialog" aria-label="Close">×</button></div><p>The dashboard is hosted on GitHub Pages. Your private Codespace companion handles all OpenClaw operations.</p><form id="connect-form">${field('Private companion URL', 'url', stored('companion-url'), 'url', 'https://your-codespace-3000.app.github.dev')}<ol><li>Start <b>Agent</b> at <a href="https://github.com/codespaces" target="_blank" rel="noopener">GitHub Codespaces ↗</a>.</li><li>Copy the <b>port 3000</b> forwarded URL. Keep its visibility <b>Private</b>.</li><li>Connect, sign in to GitHub, and choose <b>Allow this session</b> in the companion window.</li></ol><p class="hint">Keep the companion window open. If GitHub sign-in breaks the connection, return here and connect again after signing in. No token is needed.</p><button class="primary">Open private companion ↗</button></form></dialog>`;
  render();
}
function nav(id) {
  return `<a href="#${id}" data-page="${id}" title="${names[id]}" aria-label="${names[id]}"><span>${icons[id]}</span><span class="nav-text">${names[id]}</span></a>`;
}
function updateConnection() {
  if (!$('#status')) return;
  const label = {
    disconnected: 'Offline',
    waiting: 'Awaiting approval',
    connected: 'Connected',
    timeout: 'Connection timed out',
  }[connection];
  $('#status').textContent = label;
  $('#status').className = `badge ${connection === 'connected' ? 'online' : ''}`;
  $('#sidebar-state').textContent = label;
  if (connection === 'timeout')
    notice(
      'No response from the companion. Sign in to its private port, allow popups, then reconnect. If your browser severed the opener during login, a second connection usually resolves it.',
      true,
    );
}
function notice(text, error = false) {
  const n = $('#notice');
  n.hidden = false;
  n.className = error ? 'error' : 'success';
  n.textContent = text;
}
function panel(title, description, body, extra = '') {
  return `<section class="panel ${extra}"><div class="panel-heading"><div><h2>${title}</h2><p>${description}</p></div></div>${body}</section>`;
}
function empty(title, body) {
  return `<div class="empty"><span class="empty-icon">${icons[page] || '◈'}</span><h3>${title}</h3><p>${body}</p></div>`;
}
function output(id = 'result') {
  return `<pre class="output" id="${id}" hidden></pre>`;
}
function render() {
  if (!names[page]) page = 'overview';
  $('#title').textContent = names[page];
  $('#subtitle').textContent = subtitles[page];
  $('#crumb').textContent = names[page];
  document.querySelectorAll('nav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.page === page);
    if (a.dataset.page === page) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  $('#notice').hidden = true;
  updateConnection();
  const c = snapshot?.config || {};
  const views = {
    overview: () =>
      `<div class="workspace-summary"><div><span class="badge ${connection === 'connected' ? 'online' : ''}">${connection === 'connected' ? 'Companion connected' : 'Connection required'}</span><h2>Gateway workspace</h2><p>Manage conversations, automations, and your agent’s configuration.</p></div><a href="#chat" class="primary link-button">Open chat</a></div><div class="stats">${stat('Gateway', connection === 'connected' ? 'Companion linked' : 'Not connected', 'Live health appears after connecting', icons.overview)}${stat('Default model', c.agents?.defaults?.model?.primary || 'Not loaded', 'Choose any compatible endpoint', icons.models)}${stat('Channels', snapshot ? String(Object.keys(c.channels || {}).length) : '—', 'Configured messaging integrations', icons.channels)}${stat('Auto-updates', snapshot ? ((updateMode.mode === 'companion-supervised' ? updateMode.enabled : c.update?.auto?.enabled) ? 'Enabled' : 'Disabled') : '—', 'Stable channel · service required', icons.updates)}</div><div class="two-col">${panel('Workspace connections', 'Your agent stays private, even on a public website.', `<div class="connection-diagram"><div>${icons.overview}<b>GitHub Pages</b><small>Dashboard</small></div><span>······</span><div>${icons.credentials}<b>GitHub auth</b><small>Private relay</small></div><span>······</span><div>${icons.agents}<b>Agent</b><small>OpenClaw</small></div></div><div class="panel-note">${connection === 'connected' ? 'Companion authorized for this browser session.' : 'Start Agent and connect its private companion to see live data.'}</div>${button('Configure connection ↗', 'connection')}`)}${panel('Quick actions', 'Make this workspace yours.', `<div class="quick-links"><a href="#models"><span>${icons.models}</span><div>Add an AI provider<small>Custom base URLs and model IDs</small></div>↗</a><a href="#channels"><span>${icons.channels}</span><div>Connect a messaging channel<small>Telegram, Discord, and more</small></div>↗</a><a href="#credentials"><span>${icons.credentials}</span><div>Manage credentials<small>Server-side, write-only storage</small></div>↗</a></div>`)}</div>${panel('Gateway health', 'Live status from your OpenClaw instance.', `<div id="health">${empty('Ready when you are', 'Connect to Agent to load real Gateway health. No sample activity is shown.')}</div>`)}`,
    sessions: () =>
      panel(
        'Conversations',
        'Open a session to load its actual history. No synthetic activity.',
        `<label>Filter sessions<input id="session-filter" placeholder="Search name, key, or model"></label><div id="inventory">${empty('No sessions loaded', 'Connect to load Gateway sessions.')}</div>`,
      ),
    agents: () =>
      panel(
        'Agent roster',
        'Configured agent IDs and identities, as reported by the Gateway.',
        `<div id="inventory">${empty('No agents loaded', 'Connect to inspect your agents.')}</div>`,
      ),
    nodes: () =>
      panel(
        'Connected nodes',
        'Connection state does not grant new permissions. Pairing remains under Gateway control.',
        `<div id="inventory">${empty('No nodes loaded', 'Connect to inspect paired devices.')}</div>`,
      ),
    cron: () =>
      `${panel('Automations', 'Run, pause, resume, or remove saved jobs. Jobs only execute while the Gateway is awake.', `<div id="inventory">${empty('No automations loaded', 'Connect to load scheduled tasks.')}</div>`)}${panel('Create an automation', 'An isolated agent turn with no external delivery. Use Operations for advanced job JSON.', `<form id="cron-form"><div class="form-grid">${field('Automation name', 'name', '', 'text', 'Morning summary')}${field('Cron expression', 'expression', '0 9 * * 1-5')}${field('Timezone', 'timeZone', Intl.DateTimeFormat().resolvedOptions().timeZone)}</div><label>Agent prompt<textarea name="message" rows="4" required placeholder="Summarize today’s priorities"></textarea></label><p class="hint">Five-field cron: minute hour day month weekday. Example: 0 9 * * 1-5 means weekdays at 09:00. Gateway validates the expression.</p><button class="primary">Create automation</button></form>`)}${panel('Run history', 'Select History on a job to inspect results.', output('cron-history'))}`,
    database: () =>
      `${panel('Turso persistence', 'Database credentials never enter the Pages bundle or browser storage.', `<div id="database-status">${empty('Storage status not loaded', 'Connect to check the database integration.')}</div><div class="form-footer">${button('Back up now', 'database-backup', 'primary')}${button('Restore saved configuration', 'database-restore')}</div>`)}${panel('What is saved', 'Configuration and dashboard-managed credentials survive a Codespace deletion when Turso is configured.', `<ul class="feature-list"><li>AES-256-GCM encrypted configuration snapshots</li><li>Encrypted credential vault; only names and SecretRefs reach this UI</li><li>Editable work hours and scheduler status</li><li>Missing config and vault restored on companion startup</li></ul><div class="warning"><b>Not a complete Agent backup</b><p>Chat history, memory, workspace files, installed plugins, and channel login files are not mirrored to Turso. Keep verified OpenClaw backups. Existing local config is never silently replaced.</p></div><p>Add repository secrets for Codespaces and Actions: <code>TURSO_DATABASE_URL</code>, <code>TURSO_AUTH_TOKEN</code>, and <code>DASHBOARD_ENCRYPTION_KEY</code>. Use the same namespace and key in both.</p><a class="text-link" href="https://github.com/caleb695/Openclaw-Agent/blob/main/docs/INTEGRATIONS.md" target="_blank" rel="noopener">Integration setup guide ↗</a>`)}`,
    codespaces: () =>
      `${panel('Machine & runtime', 'Change the machine without putting your GitHub token in the browser.', `<div id="codespace-status">${empty('Machine not loaded', 'Connect to check available 2-core and 4-core machines.')}</div><form id="machine-form"><label for="machine-select">Machine size</label><select name="machine" id="machine-select" required disabled><option value="">Load available machines first</option></select><p class="hint">A change applies on the next start, not immediately. Four cores use core-hours twice as fast as two. GitHub quota and organization policy still apply.</p><button class="primary" id="resize-button" disabled>Save machine size</button></form><a class="text-link" href="https://github.com/codespaces" target="_blank" rel="noopener">Start / stop on GitHub ↗</a>`)}${panel('Work schedule', 'A GitHub Actions controller wakes and stops this Codespace using your saved schedule.', `<form id="schedule-form"><label class="check"><input type="checkbox" name="enabled" id="schedule-enabled"> Enable scheduled work hours</label>${field('Schedule timezone', 'timeZone', 'UTC', 'text', 'America/New_York')}<div id="work-windows"></div>${button('Add time window', 'add-window')}<p class="hint">Windows may cross midnight. Days refer to the start day; end time is exclusive. Disable the schedule to return to manual control.</p><div class="warning"><b>Best-effort timing, not a spending cap</b><p>Actions checks about every 15 minutes and may be delayed or disabled by GitHub. Outside these windows the scheduler stops the Codespace—even if you are using it. A sleeping Codespace cannot serve chat or Messenger. Set GitHub budgets and an idle timeout too.</p></div><button class="primary" id="save-schedule" disabled>Save work schedule</button></form><div id="scheduler-status"></div><p class="hint">Requires the workflow on the default branch, Actions secrets, and repository variable <code>CODESPACE_SCHEDULER_ENABLED=true</code>. When sleeping, start it on GitHub to change this schedule.</p>`)}`,
    chat: () =>
      `<section class="panel chat-panel"><div class="chat-top"><span class="avatar">⌘</span><div><b>OpenClaw Agent</b><small>Gateway conversation · persisted in Agent</small></div><label class="session-label">Session<input id="session" value="${esc(session)}" aria-label="Session key"></label>${button('Load', 'history')}</div><div id="messages" class="messages" aria-live="polite">${empty('What are we working on?', 'Connect your Agent to start a conversation. Your chat history stays in the Codespace.')}</div><form id="chat-form"><label class="sr-only" for="message">Message your agent</label><textarea id="message" placeholder="Ask your agent anything…" rows="3" required></textarea><div class="composer-footer"><span>Plain-text replies · refreshes every 5 seconds</span><div>${button('Stop', 'abort')}<button class="primary" id="send">Send message ↑</button></div></div></form></section>`,
    models: () =>
      `<div class="two-col wide-left">${panel(
        'Provider configuration',
        'OpenAI-compatible, Anthropic-compatible, and custom APIs.',
        `<label>Existing provider<select id="provider-select"><option value="">＋ Add a provider</option>${Object.keys(
          c.models?.providers || {},
        )
          .map((k) => `<option>${esc(k)}</option>`)
          .join(
            '',
          )}</select></label><form id="provider-form"><div class="form-grid">${field('Provider ID', 'id', '', 'text', 'my-provider')}${field('Model ID', 'model', '', 'text', 'your-model-name')}${field('API base URL', 'baseUrl', '', 'url', 'https://api.example.com/v1')}<label>API protocol<select name="api"><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option><option value="google-generative-ai">Google Generative AI</option><option value="ollama">Ollama</option></select></label>${field('Credential name (optional)', 'credential', '', 'text', 'CUSTOM_API_KEY')}${field('Model display name', 'displayName', '', 'text', 'My model')}</div><label class="check"><input type="checkbox" name="primary" checked> Use as the default agent model</label><div class="form-footer"><span>API keys are referenced, never embedded.</span><button class="primary">Save provider</button></div></form>`,
      )}${panel('Provider independent', 'You decide where requests go.', `<div class="info-icon">⬡</div><h3>Bring your own endpoint.</h3><p>Use a hosted provider, an OpenAI-compatible proxy, or a local inference server reachable from Agent.</p><ul class="feature-list"><li>Custom base URLs</li><li>Arbitrary model identifiers</li><li>Server-side credentials</li><li>Advanced headers & compatibility</li></ul><p class="hint">Use the API root (often /v1), not a completions URL. Protocol adapters determine endpoint paths. Configure supported overrides in Configuration. Existing provider model lists are preserved.</p><a href="#credentials" class="text-link">Add a credential first →</a>`)}</div>${panel('Available models', 'The catalog reported by your Gateway.', `<div id="inventory">${empty('No model catalog loaded', 'Connect and refresh to discover your configured models.')}</div>`)}`,
    channels: () =>
      `${panel(
        'Messaging integrations',
        'Configure any channel supported by your installed OpenClaw plugins.',
        `<div class="channel-grid">${[
          ['telegram', '↗', 'Telegram'],
          ['discord', '♧', 'Discord'],
          ['slack', '#', 'Slack'],
          ['whatsapp', '◉', 'WhatsApp'],
        ]
          .map(
            ([id, icon, name]) =>
              `<button class="channel-card" data-channel="${id}"><span class="channel-icon">${icon}</span><b>${name}</b><span class="badge">${c.channels?.[id]?.enabled ? 'Enabled' : c.channels?.[id] ? 'Configured' : 'Not configured'}</span><small>Configure integration ↗</small></button>`,
          )
          .join(
            '',
          )}</div><div class="form-grid">${field('Channel ID', 'channel-id', 'telegram', 'text', 'Any installed channel ID')}</div><label>Channel configuration (JSON with SecretRefs)<textarea class="code" id="channel-json" rows="12">${esc(json(c.channels?.telegram || { enabled: true, botToken: { source: 'file', provider: 'dashboard', id: '/TELEGRAM_BOT_TOKEN' }, dmPolicy: 'pairing' }))}</textarea></label><div class="form-footer"><span>Keep pairing / allowlists enabled. Some channels require plugin installation or a private terminal login.</span>${button('Save channel', 'save-channel', 'primary')}</div>`,
      )}${panel('Facebook Messenger', 'Optional custom bridge for a Facebook Page—not personal-account automation or an official OpenClaw plugin.', `<div id="messenger-status">Connect to check bridge readiness.</div><p>Uses signed Meta webhooks, a Page access token, and an explicit list of allowed people. Credentials are configured only as Codespaces secrets. Port 3001 serves only the webhook; keep the dashboard port 3000 private.</p><p class="hint">Text only. Requires Page/app permissions and a publicly reachable HTTPS webhook. Messages cannot be handled while Agent sleeps. Failed or interrupted turns are not automatically replayed.</p><a class="text-link" href="https://github.com/caleb695/Openclaw-Agent/blob/main/docs/INTEGRATIONS.md#facebook-messenger" target="_blank" rel="noopener">Messenger setup instructions ↗</a>`)}${panel('Channel health', 'Live connection state. Saving configuration does not prove login succeeded.', `<div id="inventory">${empty('Awaiting channel status', 'Connect to load your actual messaging integrations.')}</div>`)}`,
    skills: () =>
      `${panel('Installed skills', 'Enable capabilities and inspect dependency readiness.', `<div id="inventory">${empty('Your agent’s toolkit', 'Connect to load bundled and workspace skills.')}</div>`)}${panel('Skill configuration', 'Use a skill key from the inventory. Config, API keys, and environment mappings are supported.', `<div class="form-grid">${field('Skill key', 'skill-key', '', 'text', 'weather')}${field('Installer ID (from skill inventory)', 'install-id', '', 'text', 'brew / npm / installer ID')}</div><label>Skill entry JSON<textarea id="skill-json" class="code" rows="7">${esc(json({ enabled: true }))}</textarea></label><div class="form-footer"><span>Installing dependencies can execute third-party code. Review the source first.</span><div>${button('Install dependencies', 'install-skill')}${button('Save skill', 'save-skill', 'primary')}</div></div>`)}`,
    plugins: () =>
      `${panel('Plugin library', 'Only install code you trust. Plugin permissions and consent are enforced by OpenClaw.', `<div id="inventory">${empty('Extend your agent', 'Connect to inspect installed plugins and their status.')}</div>`)}${panel('Manage a plugin', 'Use an installed plugin ID, or a pinned npm package to install.', `<form id="plugin-form"><div class="form-grid">${field('Plugin ID or package', 'id', '', 'text', '@scope/plugin@1.2.3')}<label>Operation<select name="operation"><option>enable</option><option>disable</option><option>install</option><option>update</option><option>uninstall</option></select></label></div><p class="hint">Interactive source/capability consent must be completed in Agent’s terminal. This dashboard never bypasses it. Plugin-specific config and credentials are editable in Configuration.</p><button class="primary">Run operation</button></form>${output()}`)}`,
    credentials: () =>
      `<div class="two-col">${panel('Private credential vault', 'No secret values are loaded into this dashboard.', `<div class="vault-visual">◇<span>SERVER-SIDE ONLY</span></div><h3>Your keys stay in Agent.</h3><p>Enter or rotate keys in the private, GitHub-authenticated companion window. This dashboard only sees credential names and references.</p>${button('Open private credential vault ↗', 'vault', 'primary')}<div id="inventory" class="credential-list"></div>`)}${panel('One reference. Any integration.', 'Use supported OpenClaw SecretRef fields.', `<pre class="output">${esc(json({ source: 'file', provider: 'dashboard', id: '/CUSTOM_API_KEY' }))}</pre><p>Reference your key from model providers, skills, messaging channels, or compatible plugin configuration.</p><ul class="feature-list"><li>Owner-only file permissions (0600)</li><li>Atomic, write-only credential storage</li><li>Outside this Git repository</li><li>No API keys in local storage</li></ul><p class="hint">Rotation replaces the named value. The companion requests a secrets reload after saving; check its confirmation for any reload warning. There is intentionally no reveal or delete endpoint: removing a referenced key could break Agent. When Turso is configured, credentials are encrypted in the database and restored into the private vault at startup. Check Database before deleting the Codespace.</p>`)}</div>`,
    operations: () =>
      `${panel(
        'Runtime explorer',
        'Inspect real Gateway resources, without exposing an arbitrary command shell.',
        `<div class="tabs">${[
          ['sessions.list', 'Sessions'],
          ['cron.list', 'Scheduled jobs'],
          ['node.list', 'Nodes'],
          ['status', 'Runtime status'],
        ]
          .map(([method, label]) => `<button data-inspect="${method}">${label}</button>`)
          .join('')}</div>${output('inventory')}`,
      )}${panel('Scheduled job controls', 'Add/edit with the live cron schema; run and delete need an existing job ID.', `<div class="form-grid">${field('Job ID', 'job-id', '', 'text', 'ID from Scheduled jobs')}<label>Action<select id="job-action"><option value="cron.run">Run now</option><option value="cron.remove">Remove</option><option value="cron.add">Add</option><option value="cron.update">Update</option></select></label></div><label>Parameters for Add / Update (JSON)<textarea id="job-json" class="code" rows="6">{}</textarea></label>${button('Run job action', 'job', 'primary')}${output('job-result')}`)}`,
    settings: () =>
      `${panel('Configuration editor', 'Partial JSON patch, not a full replacement. The Gateway validates every save.', `<div class="form-footer"><span>Current snapshot: <code>${esc(snapshot?.hash?.slice(0, 12) || 'Not loaded')}</code></span>${button('Load live schema', 'schema')}</div><label>Redacted configuration snapshot<textarea id="config-snapshot" class="code" rows="12" readonly>${esc(snapshot ? json(c) : 'Connect to load configuration.')}</textarea></label><label>Configuration patch<textarea id="config-patch" class="code" rows="10" spellcheck="false">{}</textarea></label><label>Array replacement paths (comma-separated, for current OpenClaw)<input id="replace-paths" placeholder="plugins.allow, agents.defaults.model.fallbacks"></label><div class="form-footer"><span>Hash-guarded writes prevent lost edits. Secrets must be references. Never copy redaction markers into a patch.</span>${button('Validate & apply patch', 'save-config', 'primary')}</div>${output('schema-output')}`)}`,
    updates: () =>
      `${panel('Automatic OpenClaw updates', 'Supported OpenClaw update tooling. No install scripts from the browser.', `<div class="setting-row"><div><h3>Enable automatic updates</h3><p>Check and install stable releases with the update owner shown below.</p></div><label class="switch"><input id="auto-update" type="checkbox" ${c.update?.auto?.enabled ? 'checked' : ''} aria-label="Enable automatic OpenClaw updates"><span></span></label></div><div class="warning"><b>Managed Gateway service required</b><p>OpenClaw only auto-installs when its managed service can safely hand off and restart. A foreground Gateway in Codespaces will not auto-install. See service status below; do not mistake an enabled policy for a working update service.</p></div><p class="hint">Updates only run while Agent is awake. Back up state first. Source, container, and externally supervised installs have different update ownership. Unsupported handoffs are reported, never replaced with a blind npm install.</p><div class="form-footer"><span>Channel: <b>stable</b> · checks run only while Agent is awake</span>${button('Save update policy', 'save-updates', 'primary')}</div>`)}<div class="two-col">${panel('Release status', 'Check the actual installation and available version.', `${button('Check for updates', 'check-updates')}${button('Install supported update', 'run-update', 'primary')}${output('update-status')}`)}${panel('Service readiness', 'Verify that OpenClaw owns a managed Gateway service.', `${button('Inspect Gateway service', 'gateway-status')}${output('service-status')}<p>Without a managed service, use the private terminal: stop the Gateway through its actual owner, run <code>openclaw update</code>, then start it again. See the setup guide for Codespaces limitations.</p>`)}</div>`,
  };
  $('#content').innerHTML = views[page]();
  const loading = transport.connected && !snapshot && !['database', 'codespaces'].includes(page);
  $('#content').setAttribute('aria-busy', String(loading));
  if (loading) {
    for (const control of document.querySelectorAll(
      '#content input, #content textarea, #content select, #content button',
    )) {
      if (!['check-updates', 'gateway-status'].includes(control.dataset.action))
        control.disabled = true;
    }
  }
}
function stat(title, value, detail, icon) {
  return `<section class="stat"><div>${title}<span>${icon}</span></div><strong title="${esc(value)}">${esc(value)}</strong><small>${detail}</small></section>`;
}
async function request(action, params) {
  return transport.request(action, params);
}
async function rpc(method, params = {}) {
  return request('rpc', { method, params });
}
function showData(selector, data) {
  const e = $(selector);
  if (e) {
    e.hidden = false;
    e.textContent = json(data);
    e.classList.add('output');
  }
}
async function patch(p, replacePaths = []) {
  if (!snapshot) throw new Error('Refresh configuration before editing.');
  if (json(p).includes('[REDACTED]') || json(p).includes('__OPENCLAW_REDACTED__'))
    throw new Error('Remove redaction markers from your patch.');
  const result = await request('patch', { patch: p, hash: snapshot.hash, replacePaths });
  notice(result.notice);
  snapshot = null;
}
let loadVersion = 0;
async function load() {
  const current = page,
    version = ++loadVersion;
  const active = () => current === page && version === loadVersion;
  if (!transport.connected) return;
  const read = async (action, params) => {
    const result = await request(action, params);
    if (!active()) throw new Error('View changed.');
    return result;
  };
  const call = (method, params = {}) => read('rpc', { method, params });
  try {
    if (current === 'codespaces') {
      codespaceState = null;
      codespaceState = await read('codespaces.status');
      renderCodespace(codespaceState);
      return;
    }
    if (current === 'database') {
      databaseState = await read('database.status');
      showData('#database-status', databaseState);
      return;
    }
    const mode = await read('updates.mode');
    if (!snapshot && !mode.busy) snapshot = await read('config');
    updateMode = mode;
    render();
    if (current === 'sessions') sessions(await call('sessions.list'));
    if (current === 'cron') automations(await call('cron.list', { includeDisabled: true }));
    if (current === 'nodes') resources(await call('node.list'), 'nodes');
    if (current === 'agents') resources(await call('agents.list'), 'agents');
    if (current === 'overview') showData('#health', await call('health'));
    if (current === 'chat') await history();
    if (current === 'models') models(await call('models.list'));
    if (current === 'channels') {
      showData('#messenger-status', await read('messenger.status'));
      showData('#inventory', await call('channels.status', { probe: true }));
    }
    if (current === 'skills') skills(await call('skills.status'));
    if (current === 'plugins') plugins(await read('plugins.list'));
    if (current === 'credentials') {
      const data = await read('credentials.list');
      $('#inventory').innerHTML = data.names.length
        ? data.names
            .map(
              (n) =>
                `<div class="credential"><span>◇ ${esc(n)}</span><small>Stored · write-only</small></div>`,
            )
            .join('')
        : '<p>No credentials in the dashboard vault yet.</p>';
    }
    if (current === 'updates') {
      if (mode.mode === 'companion-supervised') {
        $('#auto-update').checked = mode.enabled;
        $('.warning').innerHTML =
          '<b>Companion-managed Gateway</b><p>This companion owns the foreground Gateway. When enabled, it checks hourly, drains its own process, creates a verified backup, invokes openclaw update, restarts, and verifies health. No unrelated process is stopped. Keep enough disk space for backups.</p>';
      }
      showData('#service-status', mode);
    }
    if (current === 'operations') showData('#inventory', await call('sessions.list'));
  } catch (e) {
    if (active()) notice(e.message, true);
  }
}
function workWindow(w) {
  return `<fieldset class="work-window"><legend>Work window</legend><div class="day-picker">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => `<label class="check"><input type="checkbox" name="day" value="${i}" ${w.days.includes(i) ? 'checked' : ''}>${d}</label>`).join('')}</div><div class="form-grid">${field('Start', 'start', w.start, 'time')}${field('End', 'end', w.end, 'time')}</div><button type="button" data-remove-window>Remove window</button></fieldset>`;
}
function renderCodespace(data) {
  showData('#codespace-status', {
    configured: data.configured,
    name: data.name,
    state: data.state,
    machine: data.machine,
    notice: data.notice,
  });
  const select = $('#machine-select');
  select.innerHTML =
    (data.machines || [])
      .map(
        (m) =>
          `<option value="${esc(m.name)}" ${m.name === data.machine?.name ? 'selected' : ''}>${esc(m.cpus)} cores — ${esc(m.displayName || m.name)}</option>`,
      )
      .join('') || '<option value="">No available machine sizes</option>';
  select.disabled = !data.machines?.length;
  $('#resize-button').disabled = !data.machines?.length;
  $('#schedule-enabled').checked = data.schedule.enabled;
  $('#schedule-form [name="timeZone"]').value = data.schedule.timeZone;
  $('#work-windows').innerHTML = data.schedule.windows.map(workWindow).join('');
  $('#save-schedule').disabled = !data.persistent || !data.configured;
  showData('#scheduler-status', {
    target: data.target,
    revision: data.revision,
    lastCheck:
      data.lastCheck || 'No scheduler check recorded. Saving hours does not enable GitHub Actions.',
  });
}
function sessions(data) {
  const rows = data.sessions || [];
  if (!rows.length) return showData('#inventory', data);
  $('#inventory').innerHTML =
    `<div class="table-wrap"><table><thead><tr><th>Session</th><th>Model</th><th>Updated</th><th></th></tr></thead><tbody>${rows.map((s) => `<tr data-session-row><td><b>${esc(s.displayName || s.label || s.key)}</b><br><code>${esc(s.key)}</code></td><td>${esc(s.model || 'Default')}</td><td>${esc(s.updatedAt ? new Date(s.updatedAt).toLocaleString() : '—')}</td><td><button data-session="${esc(s.key)}">Open chat</button></td></tr>`).join('')}</tbody></table></div>`;
}
function automations(data) {
  const rows = data.jobs || [];
  if (!rows.length) return showData('#inventory', data);
  $('#inventory').innerHTML =
    `<div class="table-wrap"><table><thead><tr><th>Automation</th><th>Schedule</th><th>State</th><th>Actions</th></tr></thead><tbody>${rows.map((j) => `<tr><td>${esc(j.name || j.id)}<br><code>${esc(j.id)}</code></td><td>${esc(j.schedule?.expr || (j.schedule?.everyMs ? `Every ${j.schedule.everyMs / 1000}s` : j.schedule?.at || '—'))}<br><small>${esc(j.schedule?.tz || '')}</small></td><td>${j.enabled ? 'Active' : 'Paused'}<br>${esc(j.state?.lastStatus || 'No runs')}</td><td class="row-actions"><button data-cron="${esc(j.id)}" data-op="run">Run now</button><button data-cron="${esc(j.id)}" data-op="toggle" data-enabled="${!j.enabled}">${j.enabled ? 'Pause' : 'Resume'}</button><button data-cron="${esc(j.id)}" data-op="history">History</button><button data-cron="${esc(j.id)}" data-op="remove">Remove</button></td></tr>`).join('')}</tbody></table></div>`;
}
function resources(data, kind) {
  const rows = data[kind] || [];
  if (!rows.length) return showData('#inventory', data);
  $('#inventory').innerHTML =
    `<div class="resource-list">${rows.map((r) => `<article class="resource-row">${icons[kind]}<div><h3>${esc(r.identity?.name || r.name || r.displayName || r.id || r.nodeId)}</h3><code>${esc(r.id || r.nodeId)}</code><p>${esc(kind === 'nodes' ? (r.connected ? 'Connected' : 'Disconnected') : r.identity?.theme || 'Configured agent')}</p></div>${kind === 'agents' ? `<button data-session="agent:${esc(r.id)}:main">Open chat</button>` : ''}</article>`).join('')}</div>`;
}
document.addEventListener('input', (e) => {
  if (e.target.id === 'session-filter')
    for (const row of document.querySelectorAll('[data-session-row]'))
      row.hidden = !row.textContent.toLowerCase().includes(e.target.value.toLowerCase());
});
function models(data) {
  const list = data.models || [];
  if (!list.length) return showData('#inventory', data);
  $('#inventory').innerHTML =
    `<div class="table-wrap"><table><thead><tr><th>Model</th><th>Provider</th><th>Model ID</th><th>Context</th></tr></thead><tbody>${list.map((m) => `<tr><td>${esc(m.name || m.id)}</td><td><span class="badge">${esc(m.provider || '—')}</span></td><td><code>${esc(m.id)}</code></td><td>${esc(m.contextWindow ? Number(m.contextWindow).toLocaleString() : '—')}</td></tr>`).join('')}</tbody></table></div>`;
}
function plugins(data) {
  const list = data.plugins || [];
  if (!list.length) return showData('#inventory', data);
  $('#inventory').innerHTML =
    `<div class="skill-grid">${list.map((p) => `<article class="skill-card"><span class="skill-symbol">▦</span><h3>${esc(p.name || p.id)}</h3><p>${esc(p.description || p.origin || 'Installed plugin')}</p><code>${esc(p.id)}${p.version ? ' · ' + esc(p.version) : ''}</code><div class="skill-bottom"><span class="badge">${esc(p.status || (p.enabled ? 'Enabled' : 'Disabled'))}</span><button data-plugin="${esc(p.id)}" data-operation="${p.enabled ? 'disable' : 'enable'}">${p.enabled ? 'Disable' : 'Enable'}</button></div><details><summary>Plugin details</summary><pre>${esc(json(p))}</pre></details></article>`).join('')}</div>`;
}
function skills(data) {
  const all = data.skills || [];
  if (!all.length) return showData('#inventory', data);
  $('#inventory').innerHTML =
    `<div class="skill-grid">${all.map((s) => `<article class="skill-card"><span class="skill-symbol">${esc(s.emoji || '✧')}</span><h3>${esc(s.name)}</h3><p>${esc(s.description)}</p><code>${esc(s.skillKey || s.name)}</code><div class="skill-bottom"><span class="badge ${s.eligible ? 'online' : ''}">${s.disabled ? 'Disabled' : s.eligible ? 'Ready' : 'Missing requirements'}</span><button data-skill="${esc(s.skillKey || s.name)}" data-enabled="${!!s.disabled}">${s.disabled ? 'Enable' : 'Disable'}</button></div><details><summary>Requirements & installers</summary><pre>${esc(json({ missing: s.missing, install: s.install }))}</pre></details></article>`).join('')}</div>`;
}
async function history() {
  if (polling) return;
  polling = true;
  try {
    const historySession = session;
    const data = await rpc('chat.history', { sessionKey: historySession, limit: 100 });
    if (page !== 'chat' || historySession !== session) return;
    const area = $('#messages');
    const nearEnd = area.scrollHeight - area.scrollTop - area.clientHeight < 100;
    const html =
      (data.messages || [])
        .map(
          (m) =>
            `<article class="message ${m.role === 'user' ? 'user' : ''}"><span class="message-avatar">${m.role === 'user' ? 'A' : '⌘'}</span><div><small>${esc(m.role === 'user' ? 'You' : m.role || 'Agent')}</small><div class="message-body">${esc(
              typeof m.content === 'string'
                ? m.content
                : (m.content || [])
                    .filter((x) => x.type === 'text')
                    .map((x) => x.text)
                    .join('\n') ||
                    '[Tool or non-text content — inspect in the official Control UI]',
            )}</div></div></article>`,
        )
        .join('') ||
      empty(
        'A fresh conversation',
        'Send a message to begin. Replies will appear here as Gateway history updates.',
      );
    if (area.innerHTML !== html) {
      area.innerHTML = html;
      if (nearEnd) area.scrollTop = area.scrollHeight;
    }
  } finally {
    polling = false;
  }
}
async function act(action) {
  switch (action) {
    case 'database-backup':
      notice((await request('database.backup')).notice);
      showData('#database-status', await request('database.status'));
      return;
    case 'database-restore': {
      if (
        !confirm(
          'Replace the current Gateway configuration with the encrypted cloud snapshot? This may restart the Gateway. Existing state and plugins are not restored.',
        )
      )
        return;
      const current = await request('config');
      notice((await request('database.restore', { hash: current.hash })).notice);
      snapshot = null;
      return;
    }
    case 'add-window':
      if (document.querySelectorAll('.work-window').length >= 21)
        throw new Error('Maximum 21 work windows.');
      $('#work-windows').insertAdjacentHTML(
        'beforeend',
        workWindow({ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }),
      );
      return;
    case 'connection':
      $('#connect-dialog').showModal();
      return;
    case 'close-dialog':
      $('#connect-dialog').close();
      return;
    case 'refresh':
      snapshot = null;
      await load();
      if (!transport.connected) notice('Connect to Agent to load live data.');
      return;
    case 'vault':
      transport.openVault();
      return;
    case 'history':
      session = $('#session').value.trim();
      await history();
      return;
    case 'abort':
      await rpc('chat.abort', { sessionKey: session });
      notice('Stop requested. Refresh history to verify.');
      return;
    case 'save-channel': {
      const id = $('[name="channel-id"]').value.trim();
      validId(id);
      await patch({ channels: { [id]: JSON.parse($('#channel-json').value) } });
      return;
    }
    case 'save-skill': {
      const id = $('[name="skill-key"]').value.trim();
      validId(id);
      await patch({ skills: { entries: { [id]: JSON.parse($('#skill-json').value) } } });
      return;
    }
    case 'install-skill':
      if (confirm('Install dependencies on Agent? Review the installer source first.'))
        showData(
          '#inventory',
          await rpc('skills.install', {
            name: $('[name="skill-key"]').value,
            installId: $('[name="install-id"]').value,
            timeoutMs: 120000,
          }),
        );
      return;
    case 'save-config':
      if (confirm('Apply this configuration patch? Some changes restart the Gateway.'))
        await patch(
          JSON.parse($('#config-patch').value),
          $('#replace-paths')
            .value.split(',')
            .map((x) => x.trim())
            .filter(Boolean),
        );
      return;
    case 'schema':
      showData('#schema-output', await rpc('config.schema'));
      return;
    case 'save-updates':
      if (!snapshot) throw new Error('Refresh before changing policy.');
      notice(
        (
          await request('updates.policy', {
            enabled: $('#auto-update').checked,
            hash: snapshot.hash,
          })
        ).notice,
      );
      snapshot = null;
      return;
    case 'check-updates':
      showData('#update-status', await request('updates.status'));
      return;
    case 'gateway-status':
      showData('#service-status', await request('gateway.status'));
      return;
    case 'run-update':
      if (confirm('Request an OpenClaw update? Back up state first. This may restart Agent.'))
        showData('#update-status', await request('updates.run'));
      return;
    case 'job': {
      const method = $('#job-action').value;
      if (!confirm(`Run ${method}?`)) return;
      const params = ['cron.add', 'cron.update'].includes(method)
        ? JSON.parse($('#job-json').value)
        : { id: $('[name="job-id"]').value };
      showData('#job-result', await rpc(method, params));
      return;
    }
  }
}
function validId(id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id))
    throw new Error('Use letters, numbers, hyphens, and underscores for the ID.');
}
async function safe(fn, button) {
  if (button) button.disabled = true;
  try {
    await fn();
  } catch (e) {
    notice(e.message, true);
  } finally {
    if (button) button.disabled = false;
  }
}
document.addEventListener('click', (e) => {
  const el = e.target.closest('button');
  if (!el) return;
  if (el.dataset.action) {
    e.preventDefault();
    safe(() => act(el.dataset.action), el);
  }
  if (el.hasAttribute('data-remove-window')) el.closest('.work-window').remove();
  if (el.dataset.session) {
    session = el.dataset.session;
    location.hash = 'chat';
  }
  if (el.dataset.cron)
    safe(async () => {
      const id = el.dataset.cron;
      const op = el.dataset.op;
      if (op === 'history') {
        showData('#cron-history', await rpc('cron.runs', { id, limit: 20 }));
        return;
      }
      if (!confirm(`${op} this automation?`)) return;
      await rpc(
        op === 'run' ? 'cron.run' : op === 'remove' ? 'cron.remove' : 'cron.update',
        op === 'toggle' ? { id, patch: { enabled: el.dataset.enabled === 'true' } } : { id },
      );
      await load();
      notice('Automation change accepted.');
    }, el);
  if (el.dataset.inspect)
    safe(async () => showData('#inventory', await rpc(el.dataset.inspect)), el);
  if (el.dataset.plugin)
    safe(async () => {
      if (confirm(`${el.dataset.operation} ${el.dataset.plugin}?`)) {
        await request('plugins.change', { operation: el.dataset.operation, id: el.dataset.plugin });
        await load();
      }
    }, el);
  if (el.dataset.skill)
    safe(async () => {
      await rpc('skills.update', {
        skillKey: el.dataset.skill,
        enabled: el.dataset.enabled === 'true',
      });
      await load();
    }, el);
  if (el.dataset.channel) {
    $('[name="channel-id"]').value = el.dataset.channel;
    $('#channel-json').value = json(
      snapshot?.config?.channels?.[el.dataset.channel] || { enabled: true },
    );
  }
});
document.addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target,
    data = Object.fromEntries(new FormData(form));
  safe(async () => {
    if (form.id === 'machine-form') {
      if (
        !confirm('Apply this machine size on the next Codespace start? Billing usage will change.')
      )
        return;
      notice((await request('codespaces.resize', { machine: data.machine })).notice);
    }
    if (form.id === 'schedule-form') {
      if (!codespaceState) throw new Error('Load schedule state first.');
      const windows = [...form.querySelectorAll('.work-window')].map((row) => ({
        days: [...row.querySelectorAll('[name="day"]:checked')].map((x) => Number(x.value)),
        start: row.querySelector('[name="start"]').value,
        end: row.querySelector('[name="end"]').value,
      }));
      const result = await request('codespaces.schedule', {
        revision: codespaceState.revision,
        schedule: { enabled: !!data.enabled, timeZone: data.timeZone, windows },
      });
      await load();
      notice(result.notice);
    }
    if (form.id === 'cron-form') {
      if (!data.name.trim() || !data.message.trim())
        throw new Error('A name and prompt are required.');
      await rpc('cron.add', {
        name: data.name.trim(),
        enabled: true,
        schedule: { kind: 'cron', expr: data.expression.trim(), tz: data.timeZone.trim() },
        sessionTarget: 'isolated',
        payload: { kind: 'agentTurn', message: data.message.trim() },
        delivery: { mode: 'none' },
      });
      await load();
      notice('Automation created. It runs only while the Gateway is awake.');
    }
    if (form.getAttribute('id') === 'connect-form') {
      transport.connect(data.url);
      store('companion-url', data.url);
      $('#connect-dialog').close();
      notice('Sign in and approve the private companion window. Keep it open.');
    }
    if (form.getAttribute('id') === 'chat-form') {
      if (busy) return;
      busy = true;
      try {
        session = $('#session').value.trim();
        const message = $('#message').value.trim();
        if (!message) return;
        const result = await rpc('chat.send', {
          sessionKey: session,
          message,
          idempotencyKey: crypto.randomUUID(),
        });
        if (page !== 'chat' || !$('#message')) return;
        $('#message').value = '';
        notice(
          `Message accepted${result.runId ? ' · ' + result.runId : ''}. Waiting for the agent’s reply.`,
        );
        await history();
      } finally {
        busy = false;
      }
    }
    if (form.getAttribute('id') === 'provider-form') {
      validId(data.id);
      if (!data.model) throw new Error('A model ID is required.');
      const url = new URL(data.baseUrl);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error(
          'Use an HTTP(S) base URL without embedded credentials, query parameters, or fragments.',
        );
      const old = snapshot?.config?.models?.providers?.[data.id];
      const models = [...(old?.models || [])];
      const idx = models.findIndex((m) => m.id === data.model);
      const model = {
        ...(idx >= 0 ? models[idx] : {}),
        id: data.model,
        name: data.displayName || data.model,
      };
      if (idx >= 0) models[idx] = model;
      else models.push(model);
      const provider = { baseUrl: data.baseUrl, api: data.api, models };
      if (data.credential) {
        if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(data.credential))
          throw new Error('Use an uppercase credential name.');
        provider.apiKey = { source: 'file', provider: 'dashboard', id: `/${data.credential}` };
      }
      await patch(
        {
          models: { mode: 'merge', providers: { [data.id]: provider } },
          ...(data.primary
            ? { agents: { defaults: { model: { primary: `${data.id}/${data.model}` } } } }
            : {}),
        },
        old?.models?.length ? [`models.providers.${data.id}.models`] : [],
      );
    }
    if (
      form.getAttribute('id') === 'plugin-form' &&
      confirm(
        `${data.operation} ${data.id}? Plugins execute code on Agent. Interactive trust prompts must be completed in the private terminal.`,
      )
    ) {
      showData('#result', await request('plugins.change', data));
      notice('Command completed. Refresh inventory to verify runtime state.');
    }
  }, form.querySelector('button[type="submit"],button.primary,button'));
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'provider-select') {
    const id = e.target.value,
      p = snapshot?.config?.models?.providers?.[id];
    const form = $('#provider-form');
    form.reset();
    if (!p) return;
    form.elements.id.value = id;
    form.elements.baseUrl.value = p.baseUrl || '';
    form.elements.api.value = p.api || 'openai-completions';
    form.elements.model.value = p.models?.[0]?.id || '';
    form.elements.displayName.value = p.models?.[0]?.name || '';
    form.elements.credential.value = p.apiKey?.provider === 'dashboard' ? p.apiKey.id.slice(1) : '';
  }
});
window.addEventListener('hashchange', () => {
  page = location.hash.slice(1);
  snapshot = null;
  render();
  load();
});
setInterval(() => {
  if (page === 'chat' && transport.connected && !document.hidden) safe(history);
}, 5000);
shell();
