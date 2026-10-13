# OpenClaw Agent Console

A red-and-black GitHub Pages dashboard for **your existing Agent Codespace**. Real OpenClaw controls, a private GitHub-authenticated companion, and no API keys in the public frontend.

**Owner setup is required.** The dashboard has no embedded credentials. Add private integration secrets and review [Turso, schedules, machine sizes, and Messenger setup](docs/INTEGRATIONS.md). Do not upload OpenClaw state or secrets to this repository. The included integrations are not evidence of a successful deployment or account connection.

## What is included

- Chat, server-side history, session key selection, and stop requests.
- Custom model providers: base URL, protocol adapter, model ID/display name, default model, file-backed API-key reference. Not limited to a predefined provider list.
- Skills inventory, readiness/dependency details, enable/disable, dependency installation, and skill configuration.
- Plugin inventory, enable/disable, install/update/uninstall, and plugin config through validated configuration patches.
- Telegram, Discord, Slack, WhatsApp, and any installed channel's JSON configuration; live channel health.
- Private credential entry/rotation, names-only inventory, and OpenClaw SecretRefs for compatible providers/skills/plugins/integrations.
- Schema inspection, redacted config, concurrent-edit protection, sessions, cron controls, nodes, and health.
- Automatic update toggle, release checks, supported update requests, and optional foreground Gateway supervision for Codespaces without systemd.
- Turso persistence: AES-256-GCM encrypted config, dashboard credential vault, and companion policy; automatic restore of missing files and explicit restore of existing config.
- Codespaces work hours: timezone-aware, overnight/multiple windows, external Actions wake/sleep scheduling, and live 2-/4-core machine selection.
- Dedicated Sessions, Automations, Agents, and Nodes views with labeled SVG navigation on desktop and mobile.
- Optional signed-webhook Facebook Page Messenger bridge with explicit sender allowlisting (not an official OpenClaw channel).
- Actions deployment, devcontainer startup, automated security/unit/browser tests.

This is a focused personal control panel, **not every feature of the official Control UI**. Chat is plain text with five-second history polling, not token streaming. File attachments, QR/OAuth login, and interactive plugin trust/permission prompts remain official-UI/private-terminal operations. Do not paste credentials in chat or the JSON editor.

## 1. Enable and deploy GitHub Pages — once

1. In [repository Settings → Pages](https://github.com/caleb695/Openclaw-Agent/settings/pages), choose **Source: GitHub Actions**. An owner must do this because this session's integration lacks the Pages permission.
2. The workflow **Deploy Agent Console** runs on pushes to `main`, or via **Run workflow**. Review and merge changes before deployment. The obsolete second workflow that published the repository root was removed. If the first run failed before Pages was enabled, open [Actions](https://github.com/caleb695/Openclaw-Agent/actions), choose that workflow run, and **Re-run all jobs**.
3. If the `github-pages` environment restricts deployment branches, allow the branch you explicitly chose to deploy under **Settings → Environments → github-pages**, or review/merge the work through your normal process. Do not add secrets to this environment for the frontend.
4. Once the deploy job succeeds, open **https://caleb695.github.io/Openclaw-Agent/**. This is the expected URL, not a claim that deployment has already succeeded. Hash routes and relative asset paths support the project subdirectory.

The build publishes **only `dist/`**, never the companion, OpenClaw config, or credentials. A private repository would not make client-side secrets safe. Private-repository Pages also requires an eligible GitHub plan.

## 2. Install the companion inside the existing Agent Codespace — once

Start **Agent** from [github.com/codespaces](https://github.com/codespaces). Open its terminal in this repository. A Codespace display name is not its forwarded-port hostname; setup prints the real machine URL.

First bring in this branch without discarding local work:

```bash
git status --short
# If this is not empty, save/review your work first. Do not reset it.
git fetch origin arena/bdf0a997-openclaw-agent
git merge --ff-only origin/arena/bdf0a997-openclaw-agent
```

If the fast-forward fails, resolve the branch difference normally; do not force-reset your existing agent's repository.

Check your existing runtime:

```bash
node --version
openclaw --version
```

The companion needs Node 22+, but **OpenClaw 2026.10.3 needs Node 24.16+ on the 24.x line, or 26.1+**. Earlier companion functionality was live-tested with Node 24.16.0 and OpenClaw 2026.10.3. The new integrations have local/mock coverage; see docs/TESTING.md for the current verification boundary. Do not blindly upgrade an older installation with existing state; follow OpenClaw's migration/backup instructions first.

With your existing Gateway still running, run:

```bash
npm run setup && bash scripts/start.sh
```

This preserves Gateway ownership. It installs the dashboard's locked dependencies, builds static assets, starts the companion with private logs, prints the port, and attempts to enforce private visibility. No OpenClaw reinstallation or config reset occurs.

In the Codespace **Ports** tab:

- Port **3000**: **Private**, forwarding protocol **HTTP** (the browser URL is still HTTPS).
- Do **not** publicly forward port 18789 or your custom Gateway port.
- Copy the forwarded URL, shaped like `https://MACHINE-SLUG-3000.app.github.dev`.

Open the Pages dashboard → **Connect Agent** → paste that URL → **Open private companion**. Sign in to GitHub if asked, then select **Allow this session** in the companion. Leave it open. The URL is the only preference stored by Pages; no GitHub/OpenClaw token is needed.

**Login/reconnect:** GitHub redirects can break a window's opener. Finish signing in, close the disconnected companion if necessary, then click Connect again from Pages. Expired GitHub cookies, browser popup blocking, sleeping Codespaces, or enterprise browser policies require a fresh connection. We tested the cross-origin browser flow using a simulated tunnel, not your inaccessible Codespace/login.

### Normal use and startup

- **Start Agent first.** A stopped Codespace has no reachable companion or Gateway; Pages cannot wake it without a separate credentialed service.
- `.devcontainer/devcontainer.json` runs `scripts/start.sh` on Codespace start **after that devcontainer configuration has been applied**. Existing Codespaces do not gain new lifecycle hooks until a rebuild.
- **Do not rebuild before preserving OpenClaw state.** See persistence below. Until then, run `bash scripts/start.sh` after each Codespace start; it does not duplicate an already-running companion.
- The companion preserves your current CLI profile/environment. Set `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, or other supported server-side OpenClaw settings before starting if you use custom locations. Never put them in a `VITE_*` client variable.
- The devcontainer does not silently reinstall or upgrade OpenClaw. After a rebuild, restore/reinstall your recorded OpenClaw version and any external dependencies if they were installed outside `/workspaces`. For a **missing** npm installation of the tested version on a supported Node runtime: `npm install -g openclaw@2026.10.3`. Do not use this as an unreviewed migration command for old state.

To stop/restart the companion, read its PID from `/workspaces/.openclaw-dashboard/companion.pid`, verify it is the `node server/index.mjs` process, and terminate it normally. Then run `bash scripts/start.sh`. In companion-supervised mode this also drains its Gateway. Do not terminate it during an update; inspect Updates first.

## 3. Configure your providers and integrations

### Example: any OpenAI-compatible API

1. Open **Credentials → Open private credential vault**.
2. In the private window, save your key as `CUSTOM_API_KEY`. The value is never returned. Existing names rotate in place. Check the save/reload confirmation.
3. In **Models & providers**, choose a provider ID such as `custom`, enter your actual model ID, select **OpenAI Chat Completions** or **OpenAI Responses**, enter the API root URL (for example `https://your-provider.example/v1`), and enter credential **name** `CUSTOM_API_KEY`.
4. Select default model if desired, save, then refresh and send a chat message. A catalog entry is configuration evidence, not proof that a provider accepts requests.

The persisted provider config references a server-side key:

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "custom": {
        "baseUrl": "https://your-provider.example/v1",
        "api": "openai-completions",
        "apiKey": { "source": "file", "provider": "dashboard", "id": "/CUSTOM_API_KEY" },
        "models": [{ "id": "your-model", "name": "Your model" }]
      }
    }
  }
}
```

A base URL is not a complete arbitrary request URL. Adapters choose endpoint paths; use compatible protocols and the installed schema's supported headers/compatibility settings for special providers. Provider requests originate in **Agent**, so a loopback API URL refers to the Codespace, not your laptop.

### Messaging

For Telegram, store `TELEGRAM_BOT_TOKEN` privately, then configure a supported channel with its SecretRef. Example for a version/plugin supporting these fields:

```json
{
  "enabled": true,
  "botToken": { "source": "file", "provider": "dashboard", "id": "/TELEGRAM_BOT_TOKEN" },
  "dmPolicy": "pairing"
}
```

For Discord, use its `token` SecretRef and a restrictive `groupPolicy`/allowlist as documented by your installed channel. Install required channel plugins first. Channel schemas vary by release; **Configuration → Load live schema** shows the active contract. Preserve pairing/allowlists. Bot provisioning, Discord intents, WhatsApp QR login, and OAuth approvals must be performed in their provider portal/private terminal/official UI. Check **Channel health** afterward.

### Skills, plugins, and advanced settings

- Skills lists the actual key and installer metadata. Enable/disable directly; use the skill entry editor for config and SecretRefs. Dependency installation executes code on Agent—review it first.
- Plugins accepts IDs and npm-safe package specs (prefer exact versions). Arbitrary paths, URLs, flags, and shell commands are deliberately excluded. Noninteractive installs never bypass OpenClaw capability consent. Finish any required confirmation with `openclaw plugins install ...` in the private terminal.
- Configure `plugins.entries.<id>.config`, channel options, agent defaults, fallback models, tool policies, and other supported options through the partial JSON patch editor. Null deletes a key; array replacement may require listing its path explicitly. The Gateway validates and hash-guards writes.
- For third-party secret fields that **do not support SecretRef**, use the plugin's supported private server-side environment/config setup. Do not paste its key into Pages.
- After a config/credential change or external edit, refresh before saving another change. A hash conflict is intentional protection; the app never silently overwrites a newer config.

## 4. Automatic updates that work with the actual runtime owner

Automatic updates are **off by default** in companion-supervised mode. The UI distinguishes two modes.

### A. Existing OpenClaw-managed service

Leave the companion in default/external mode. **Updates → Inspect Gateway service** shows the real service state. The toggle writes `update.channel=stable`, `update.checkOnStart=true`, and `update.auto.enabled`. Update requests use the supported `update.run` RPC.

**An enabled flag is not enough:** native automatic installation requires a working OpenClaw-managed service. A foreground Gateway or external supervisor only receives update hints. `OPENCLAW_NO_AUTO_UPDATE=1` can also override policy. Handoff refusals appear in update results.

### B. Codespace foreground Gateway (no systemd): optional companion supervision

If your Codespace runs OpenClaw directly in a terminal, use this mode for working automatic installation:

1. Back up state and finish active agent work.
2. Stop your existing Gateway **using its actual owner** (Ctrl+C in its original foreground terminal; or `openclaw gateway stop` for an installed service). Disable any old startup hook that would launch a competing Gateway.
3. Stop the existing companion as described above.
4. Run in Agent:

```bash
npm run setup -- --manage-gateway
bash scripts/start.sh
```

5. Reconnect Pages. **Updates** must say **Companion-managed Gateway** and show `running: true`. If the Gateway port is already occupied, startup refuses without touching the other process.
6. Enable automatic updates and save. Checks run once a minute after startup, then hourly **while the Codespace is running**. Manual **Install supported update** runs the same check immediately.

Supervised updates require a **recognized npm/pnpm/Bun package installation on stable**. They detect an exact newer stable release, SIGTERM/drain only the owned child, verify a full OpenClaw backup, copy the vault privately, run the supported updater with `--no-restart`, relaunch, and verify health. Failed backup means no installation. Install/source/ownership/capability failures are not bypassed. Only one update runs at a time. The UI exposes progress and failures under **Check for updates**; an accepted request is not a completed update.

Backups live in `/workspaces/.openclaw-dashboard/backups/`; no automatic pruning is performed. Check disk space and retain/download backups deliberately. Logs and last in-memory update state are not a permanent update ledger; OpenClaw retains its own update history. No automatic database downgrade is attempted after migration. Follow the official [rollback/recovery guide](https://docs.openclaw.ai/install/updating/rollback-and-recovery) if verification fails.

To return ownership to your external service: stop the companion normally, run `npm run setup -- --external-gateway`, start the external Gateway, then run `bash scripts/start.sh`.

## 5. Persistence — do this before rebuilding or deleting Agent

The companion vault, settings, logs, and backups default to **`/workspaces/.openclaw-dashboard`**, outside the Git checkout. Those survive stops and rebuilds. OpenClaw itself defaults to **`~/.openclaw`**, which typically does **not** survive a container rebuild. Keep independent private backups; Codespace deletion removes `/workspaces` too.

For a default-profile installation, stop the Gateway and all writers first, then optionally run `npm run setup -- --persist-openclaw`. It refuses an existing destination/custom configured paths and never copies a running database. A cross-filesystem rename may require this explicit migration instead:

```bash
# Gateway and companion-supervised Gateway must be STOPPED first.
# These guards intentionally refuse an existing target or state symlink.
test -d "$HOME/.openclaw" && test ! -L "$HOME/.openclaw"
test ! -e /workspaces/.openclaw-agent-state
umask 077
cp -a "$HOME/.openclaw" /workspaces/.openclaw-agent-state
# Verify the copy before changing the active location:
diff -qr "$HOME/.openclaw" /workspaces/.openclaw-agent-state
mv "$HOME/.openclaw" "$HOME/.openclaw.pre-dashboard-backup"
ln -s /workspaces/.openclaw-agent-state "$HOME/.openclaw"
```

Run those as a guarded script (`set -e`) or individually and stop on any error. Retain the backup until OpenClaw health, sessions, providers, and channels are verified. `scripts/start.sh` restores this exact symlink after a rebuild if the home location is absent. Custom state directories, external workspaces, profile locations, plugin data, and OAuth files outside that tree need their own persistence and backup plan—do not assume the default-state migration covers them. Record the installation version and needed binaries before a rebuild.

## Configuration reference (server only)

| Variable              | Default / purpose                                                                      |
| --------------------- | -------------------------------------------------------------------------------------- |
| `PORT`                | `3000`; the Pages connection validator intentionally targets this personal-use port    |
| `PAGES_ORIGIN`        | `https://caleb695.github.io`; exact trusted origin, no path or wildcard                |
| `DASHBOARD_ORIGIN`    | Computed HTTPS forwarded Codespace origin; override explicitly for a custom deployment |
| `DASHBOARD_STATE_DIR` | `/workspaces/.openclaw-dashboard` in Codespaces; `~/.openclaw-dashboard` elsewhere     |
| `OPENCLAW_BIN`        | `openclaw`; optional absolute CLI/wrapper executable, not a shell command string       |
| `MANAGE_GATEWAY=1`    | Opt into foreground lifecycle ownership; setup also persists this choice               |

Set environment variables in the server's private startup environment, not in frontend code or tracked files. All Pages projects on `caleb695.github.io` share an origin; only host trusted code there, or use a dedicated custom domain. Read [SECURITY.md](docs/SECURITY.md).

## Limitations and troubleshooting

| Symptom                                     | What to do                                                                                                                                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pages 404 / Actions configure-pages failure | Enable Pages with GitHub Actions in repository Settings, permit the deploy branch/environment, then rerun the workflow.                                                                           |
| Companion unreachable                       | Start Agent, inspect port 3000, keep it private, and inspect private companion logs. A friendly display name is not the machine slug.                                                             |
| Waiting for approval                        | Allow popups, complete GitHub login, press Allow in the companion. Reopen it after login if the browser severed its opener.                                                                       |
| API 403                                     | Confirm the forwarded URL and server's exact `DASHBOARD_ORIGIN`; no CORS wildcard or Origin fallback is supported.                                                                                |
| CLI not found after rebuild                 | Restore the installed OpenClaw version/runtime, state symlink and PATH; restart the companion.                                                                                                    |
| Config mutation rejected                    | Refresh for a fresh hash; inspect the live schema; run `openclaw config validate` in Agent. Raw CLI errors are not forwarded because plugins can print secrets.                                   |
| Saved credential but reload warning         | In Agent run `openclaw secrets reload`; inspect local health/config. Unbound vault entries may remain after a rejected config patch and can be safely retried.                                    |
| Plugin operation needs consent              | Complete the official CLI's interactive capability/source approval in the private terminal.                                                                                                       |
| Update enabled but never installs           | Inspect mode/service status, installation owner, stable channel, environment opt-outs, and whether Agent is awake. Use supervised mode for an otherwise unmanaged foreground Gateway.             |
| Chat accepted but no reply                  | Inspect provider credentials/base URL/model availability, Gateway health, session key and private logs. Acceptance only means the Gateway queued the run. Refresh history; do not blindly resend. |
| Gateway exited under companion supervision  | Inspect private `gateway.log`, fix the cause, restart the companion. Repeated crash loops are not automatically hidden.                                                                           |

Codespaces is not 24/7 hosting. Idle timeouts, maximum session lifetime, compute billing, quotas, port-auth expiry, and deletion retention apply. No artificial keepalive or paid-runtime auto-wake loop is installed.

## Development and verification

```bash
npm ci
npm run check                         # security/unit tests + production build
npx playwright install --with-deps chromium
npx playwright test                  # real cross-origin browser relay with fixtures
npx vite preview --host 0.0.0.0       # static UI preview (no live Agent implied)
```

`npm start` runs the private companion on port 3000. Open `/bridge` for its private vault; the normal UI is meant to be loaded from the configured Pages origin. Browser fixtures are under `tests/fixtures`, never part of `dist`. Test only against synthetic data or an isolated OpenClaw profile. See [TESTING.md](docs/TESTING.md) for executed results and unverified boundaries, and [RESEARCH.md](docs/RESEARCH.md) for source links, alternatives, and API contracts.
