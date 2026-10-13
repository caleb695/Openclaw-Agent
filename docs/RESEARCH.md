# Architecture decision and research

Research and implementation: 2026-10-13. Runtime contract tested against the npm release **OpenClaw 2026.10.3**, not an assumed REST API. Official docs move faster than older installations; an older Agent may need a supported upgrade before all controls work.

## Repository and platform findings

- This checkout initially contained only `README.md`.
- GitHub API reported `caleb695/Openclaw-Agent` **public**, despite the request describing a private repository. No visibility change was made. Neither public nor private repository status protects a Pages client bundle.
- `gh codespace list --json name,displayName,repository,state` returned `[]` for this session. “Agent” may exist under access unavailable to this integration. We cannot derive its machine slug from its friendly display name.
- The Pages API initially returned 404. Attempting to create a workflow-backed Pages site returned **403 Resource not accessible by integration**. This is a permissions blocker, not a completed deployment.

## Compared connection approaches

| Approach                                                                    | Benefits                                                                                                                                                    | Costs / security implications                                                                                                                                                                                                                                                                                                          | Decision                                                                |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Pages directly → Gateway WebSocket                                          | Official UI architecture; event streaming; few components                                                                                                   | Private Codespaces ports require GitHub auth. Cross-origin fetch/WS cannot reliably perform login redirects or use GitHub's cookie flow; browser WS cannot set arbitrary `X-GitHub-Token` headers. Public Gateway exposure requires independent authentication, device pairing, precise origins, and admin credentials in the browser. | Rejected for this personal, private-port deployment.                    |
| Pages → public companion with custom auth / OAuth                           | Normal HTTPS API/WS, no popup                                                                                                                               | Internet-exposed administrative surface, authentication/session implementation, rate limits, OAuth registration/callbacks or browser-held bearer credentials. Cross-site cookies can be blocked; public port visibility resets on Codespace restart.                                                                                   | More infrastructure and risk than necessary.                            |
| Pages → private GitHub-authenticated companion window → local CLI / Gateway | No public admin port, no GitHub or Gateway token in Pages, GitHub handles sign-in, first-party cookies on the companion, only one personal Codespace needed | Companion tab/window must remain open; explicit approval; login redirects can sever opener and require reopening after login. Polling chat rather than native event streaming.                                                                                                                                                         | **Selected.**                                                           |
| Official Control UI on private port / Tailscale Serve                       | Broad official feature coverage; native event streaming; maintained upstream                                                                                | Primarily hosts the UI on Gateway/tailnet, not GitHub Pages; Tailscale adds an account/device/network dependency.                                                                                                                                                                                                                      | Good alternative if Pages or the companion-window tradeoff is unwanted. |

No iframe is used: sign-in and frame restrictions make it unreliable. No GitHub PAT is requested. No automatic Codespace wake proxy is provided: Pages has no server or private token store.

## Supported control surface

Official [Control UI feature reference](https://docs.openclaw.ai/web/control-ui/feature-reference), [Gateway CLI query](https://docs.openclaw.ai/cli/gateway/query), [protocol RPC reference](https://docs.openclaw.ai/gateway/protocol/rpc-talk-config-and-agents), and [official UI source](https://github.com/openclaw/openclaw/tree/main/ui) were reviewed.

The backend runs `openclaw gateway call <allowlisted-method> --params <json> --json`. It inherits the _server's_ configured profile/authentication; there is no invented `/api/chat` on OpenClaw and no arbitrary shell endpoint. `execFile` is used without a shell. CLI notices preceding a JSON document are tolerated; stdout/stderr from non-JSON commands is not returned to Pages.

| Capability            | Supported interface                                                                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat / history / stop | `chat.send` (idempotency key), `chat.history`, `chat.abort`                                                                                                                        |
| Configuration         | `config.get`, `config.schema`, hash-guarded `config.patch`, explicit `replacePaths` for destructive array edits                                                                    |
| Models                | `models.list`; `models.providers` config with custom `baseUrl`, `api`, model IDs and credential refs                                                                               |
| Skills                | `skills.status`, `skills.update`, `skills.install`; `skills.entries`                                                                                                               |
| Plugins               | `openclaw plugins list --json`; explicit `enable`, `disable`, `install`, `update`, `uninstall` commands                                                                            |
| Channels              | `channels.status`; `channels.<id>` config including plugin-specific keys                                                                                                           |
| Operations            | `sessions.list`, `sessions.patch`, `cron.list/add/update/run/remove`, `node.list`, `status`, `health`                                                                              |
| Credentials           | [File SecretRefs](https://docs.openclaw.ai/gateway/secrets/secretref-contract), `secrets.reload`                                                                                   |
| Updates               | [Official update CLI](https://docs.openclaw.ai/cli/update), [native update policy](https://docs.openclaw.ai/install/updating/automatic-updates), `update.run` for managed services |

### Updates: an important distinction

Current official docs explicitly say native auto-apply requires an **OpenClaw-managed service**. Codespaces generally does not offer a normal systemd user service. Simply adding `update.auto.enabled=true` is not enough for a foreground Gateway.

- Existing externally managed Gateway: preserve ownership, use native policy and `update.run`; expose service status and unsupported handoff results.
- Opt-in companion supervision: spawn a foreground Gateway, never adopt another process, check hourly while awake, require a stable supported npm/pnpm/Bun installation and a newer registry release, drain only the owned child, create a verified full backup plus private vault copy, run `openclaw update --yes --tag <exact-version> --no-restart --json`, restart and check health. Disabled by default. Source/container/unknown-owner installs are not silently upgraded.
- No fabricated version comparison, git reset, arbitrary install script, or blind global npm update. No unsafe automatic downgrade after database migration. Failure is visible; backups remain available outside Git.

## GitHub limitations verified

- [Pages is static hosting](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages). Private-repository Pages eligibility depends on plan. Ordinary Pages sites can be publicly accessible even when source is private.
- [Private forwarded ports](https://docs.github.com/en/codespaces/reference/security-in-github-codespaces) authenticate the Codespace owner using GitHub; the docs describe three-hour private-port auth cookies. Public ports have no GitHub authentication and can revert to private on restart.
- [Port forwarding](https://docs.github.com/en/codespaces/developing-in-a-codespace/forwarding-ports-in-your-codespace) uses `https://CODESPACENAME-PORT.app.github.dev`. REST clients can use `X-GitHub-Token`, but shipping that token to Pages is inappropriate here. Keep local forwarding protocol HTTP; GitHub terminates browser HTTPS.
- [Runtime lifecycle](https://docs.github.com/en/codespaces/about-codespaces/deep-dive) and [timeouts](https://docs.github.com/en/codespaces/setting-your-user-preferences/setting-your-timeout-period-for-github-codespaces): default idle stop is 30 minutes; user timeout choices are bounded by policy, with a documented maximum continuous session lifetime of 12 hours. Compute costs accrue while running. Do not promise 24/7 uptime or defeat idle limits.
- [Rebuild persistence](https://docs.github.com/en/codespaces/developing-in-a-codespace/rebuilding-the-container-in-a-codespace): `/workspaces` survives stops/rebuilds; home/container files may not survive a rebuild. Deleting the Codespace deletes its disk. Persist state outside the Git checkout and keep independent private backups.
- [Custom Actions deployment](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages): upload only built static assets; deploy job uses `pages:write`, `id-token:write`, and the `github-pages` environment.

## Design references

Reviewed official [Control UI](https://docs.openclaw.ai/web/control-ui), [feature reference](https://docs.openclaw.ai/web/control-ui/feature-reference), and [upstream base styles](https://github.com/openclaw/openclaw/blob/main/ui/src/styles/base.css). Inspired by its dark panels, signature red accent, sidebar separation of chat/capabilities/system settings, status badges, and schema-backed configuration. This is an independently implemented personal companion UI, not a complete fork or an official OpenClaw product.

## Residual tradeoffs

- A browser popup is deliberate, not an invisible cross-origin bypass. Browser/enterprise COOP or popup restrictions can prevent it; sign in first then reconnect. This has been tested in Chromium with a real cross-origin popup and simulated tunnel, **not with this user's GitHub login or Agent**.
- CLI-per-call is slower than one persistent Gateway WS. Chat polls every five seconds while visible, displays plain-text messages, and has no attachments, tool-card rendering, or token streaming. This reduces authentication/protocol coupling.
- Messaging OAuth/QR/interactive login and plugin capability-consent prompts remain private-terminal/official-UI tasks. An enabled channel is not proof of successful login.
- API root URLs and adapter selection are configurable; endpoint behavior and SecretRef support depend on the chosen adapter/plugin. We do not promise arbitrary HTTP protocols will become OpenAI-compatible.
