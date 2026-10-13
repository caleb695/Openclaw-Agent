# Security model

## Boundary

GitHub Pages is public, static, and untrusted as a credential store. Port **3000 must remain Private** in Codespaces. GitHub's authenticated forwarded-port tunnel is the authentication boundary; the companion is not safe to expose as a public server. Loopback CLI/Gateway authentication remains enabled. Do not use `dangerouslyDisableDeviceAuth`, wildcard origins, or public Gateway forwarding.

The private bridge:

1. Loads in a top-level GitHub-authenticated window, not an iframe.
2. Requires explicit operator approval for the configured Pages origin.
3. Accepts messages only from its own `window.opener`, exact allowed origin, and current random channel ID.
4. Makes same-origin POST requests with exact Origin, JSON content type, and an unpredictable boot CSRF token.
5. Returns results only to that opener and origin.

Backend checks use a configured origin, not an arbitrary request Host or forwarded-header fallback. API responses are `no-store`, no CORS headers are emitted, framing is denied, and CSP forbids third-party scripts. Request body size, concurrent requests, output size, and CLI timeouts are bounded. RPC and CLI operations are allowlisted. Plugin IDs/specs reject flags, paths, and shell syntax; subprocesses do not use a shell. This is a **personal administrative UI**, not multi-user RBAC or an isolation boundary against untrusted local code.

## Secrets

- Enter API keys only in the **private companion** credential form. They necessarily exist briefly in that form/request, but never enter Pages' credential forms, bundle, localStorage, or relay messages.
- Owner-only directory (0700), atomic owner-only file (0600): `/workspaces/.openclaw-dashboard/secrets.json` by default in Codespaces.
- Only names and SecretRefs are readable. No reveal endpoint. Rotation is supported; deletion is intentionally manual because existing references could break. A secrets reload is requested after save.
- OpenClaw reads values through its supported file-backed provider. Only references go through CLI params, so these secret values do not appear in command-line arguments. The existing Gateway token is resolved by the local CLI, never requested by the frontend.
- Config inspection discards raw/source strings, uses OpenClaw's own redacted RPC snapshot, and applies additional sensitive-key redaction. Opaque plugin data or an agent deliberately printing a secret cannot be perfectly identified by heuristic filters. Do not ask agents to print secrets or paste keys into chat/config JSON. Use schema-declared secret fields and supported SecretRefs.
- The vault is not encryption at rest and cannot defeat a compromised Codespace, same-user process, malicious plugin, or account takeover. File-backed SecretRefs are not an HSM. Install only trusted plugins/skills.
- Logs/backups can contain sensitive agent data. They live outside Git with restrictive permissions. No diagnostic log streaming or unredacted CLI errors is exposed to Pages.
- Browser persistence stores **only the non-secret companion URL**. Chat and config stay in memory. Reload loses the browser connection and requires reconnecting.

## Origin scope

Default Pages origin is `https://caleb695.github.io`, not a repository path: origins cannot distinguish `/Openclaw-Agent/` from another site under that same hostname. **Every site on this origin is part of the trust boundary.** Do not host untrusted scripts on sibling Pages projects. A dedicated custom domain isolates this dashboard better; set `PAGES_ORIGIN` in the companion to its exact HTTPS origin and redeploy the frontend there.

The private companion URL input accepts only HTTPS Codespaces port-3000 URLs. It never accepts a token in query parameters, user-info credentials, arbitrary hosts, or insecure HTTP. A per-session connection always requires approval in the companion. No permissive `postMessage('*')` is used.

## Persistence and updates

Changing repository visibility does not secure a deployed frontend. All files in `dist` are public. Never put `.env`, OpenClaw state, backup archives, or credentials into this repository, Actions secrets intended for client build-time injection, screenshots, issue reports, or Git history.

In supervised mode only the spawned child is sent SIGTERM. A busy Gateway gets a drain window; it is never force-killed by this updater. A backup failure prevents installation. Updates are pinned to the detected stable version and use the official updater. No automatic rollback is attempted after migrations; restore only through OpenClaw's documented recovery workflow. Disabling updates does not cancel an already-running installation; the UI rejects policy changes during maintenance.

Codespace deletion is not a backup strategy. Download encrypted/private copies to storage you control. Neither Pages nor this companion wakes a stopped Codespace or keeps it running artificially.
