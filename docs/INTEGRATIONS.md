# Private integrations: owner setup

No database token, GitHub token, or Meta token belongs in chat, source code, Pages settings forms, browser storage, or a `VITE_*` variable. Add values directly in GitHub's encrypted secret settings. These instructions do **not** claim your accounts are already connected.

## 1. Turso

Use a **libSQL-compatible Turso database**, its secure `libsql://…` URL, and a **database access token** with write permission. A Turso account-management API token is not the database token used by this driver.

Add the following to both repository **Settings → Secrets and variables → Codespaces** and **Settings → Secrets and variables → Actions** (or use your personal Codespaces secrets with access granted to this repository):

| Secret                     | Value                                                                           |
| -------------------------- | ------------------------------------------------------------------------------- |
| `TURSO_DATABASE_URL`       | Your database's secure libSQL/HTTPS URL                                         |
| `TURSO_AUTH_TOKEN`         | Database access token, not an account-management token                          |
| `DASHBOARD_ENCRYPTION_KEY` | The same random 32-byte key, encoded as 64 hex characters, in both environments |
| `CODESPACES_TOKEN`         | Only needed for machine changes/scheduling; see below                           |

Generate the encryption key **in your own private terminal**, for example with `openssl rand -hex 32`. Copy it directly to the two secret settings. Do not send it to an assistant or commit it. Keep a separate private recovery copy. Losing/changing this key makes existing encrypted rows unreadable; simply replacing it does not rotate the data. Token rotation does not require changing the encryption key.

The optional `DASHBOARD_NAMESPACE` defaults to `agent`. To change it, set the same value as a Codespaces secret/environment variable and an Actions repository **variable**. It must contain 1–80 letters, digits, hyphens, or underscores. Use one active companion per namespace. A namespace avoids accidental collisions; it is **not** tenant authorization or a security boundary.

Restart the Codespace/companion after adding secrets so its process receives them. The driver creates `dashboard_documents` automatically. No hosted GitHub Marketplace application or frontend database connection is needed.

Then:

1. Connect the dashboard to your private companion.
2. Open **Database** and confirm `configured: true`.
3. Choose **Back up now** and check the saved timestamp. This creates the initial snapshot; do this before deleting/replacing the Codespace.
4. Make a harmless setting change, back up, and check the timestamp again.

### Persistence behavior

- Values are encrypted using AES-256-GCM with a fresh nonce and authenticated namespace/document identity before reaching Turso. The key is stored only in the server/Actions secret environment, not the database.
- Dashboard credential saves write the encrypted cloud vault first, then atomically update the local 0600 file used by OpenClaw SecretRefs. Names and references—not secret values—are returned to Pages.
- Configuration is backed up after dashboard config/credential/plugin/update-policy changes and every five minutes while the companion is running. Backup parses the **private JSON5 source file**, verifies it with `openclaw config validate --json`, and checks that the file did not change during validation. Using `config.get` as a backup source would silently lose redacted values, so it is not used.
- The source retains `${ENV}` placeholders and SecretRefs. Environment credentials and other providers' files must still exist on the replacement host.
- A local setting change and a cloud snapshot are not one distributed transaction. If cloud backup fails after a local change, the UI explicitly warns; use **Back up now** once the problem is fixed. Scheduled backup is retried later. Never delete a Codespace before checking its backup timestamp.
- `$include` layouts are rejected for cloud config snapshots rather than producing an incomplete restore. Use OpenClaw's full backup for those layouts.
- The companion's setup ownership and auto-update policy files are also encrypted and restored **only if missing**.
- At startup, the cloud vault is materialized locally; a missing OpenClaw configuration is restored before a companion-managed Gateway starts. The dashboard file-secret-provider path is rebound to the new local vault path. Other absolute paths are not rewritten.
- Existing local config is never automatically replaced. **Restore saved configuration** explicitly sends the cloud snapshot through hash-guarded `config.apply` for Gateway validation/restart. Inspect the configuration before backing up a different existing Codespace into the same namespace.
- Conflicting cloud edits fail instead of silently overwriting an unseen revision. Partial/missing secrets, authentication failures, and decryption errors fail closed—there is no silent plaintext or local-only fallback once Turso is configured.
- With no Turso secrets at all, existing local-only behavior remains available and the UI labels it accordingly.

**Not a full Agent backup:** Turso does not mirror chat/session history, memory, workspace files, plugin binaries, OAuth state, channel login files, OpenClaw cron-job storage, or the Messenger inbox. Use supported OpenClaw backups for these. A configuration referring to missing plugins, external files, or credentials may not start on a fresh host until those dependencies are restored. Reinstall the compatible OpenClaw version before starting the companion.

## 2. Codespaces work hours and core count

A stopped Codespace cannot run its own scheduler or private dashboard API. The external controller is `.github/workflows/codespace-schedule.yml`, not an OpenClaw cron job. The static Pages site cannot wake the companion by itself.

1. Add `CODESPACES_TOKEN` to **Codespaces secrets** and **Actions secrets**. Use a token belonging to the Codespace owner with access to the target Codespace and the GET, machine-list, PATCH, start and stop endpoints. GitHub documents the classic `codespace` scope for these endpoints; if using a fine-grained token, grant the corresponding endpoint permissions and satisfy your organization's policy. The ordinary workflow `GITHUB_TOKEN` is not a substitute. Give the token an expiry and rotate it privately. Do not paste it into this dashboard or chat.
2. Add repository Actions **variable** `CODESPACE_NAME` containing the actual machine name, not its friendly display name. Inside the Codespace, GitHub supplies this environment variable automatically.
3. Add repository Actions **variable** `CODESPACE_SCHEDULER_ENABLED` with value `true` only when you are ready. Without it the workflow is skipped.
4. Merge/deploy the workflow to the repository's **default branch**. GitHub's schedule event runs there. Verify Actions is enabled.
5. With the Codespace awake, connect the dashboard and open **Codespaces**. Add one or more day/time windows, choose an IANA timezone, enable the schedule, and save.
6. Run **Codespace work schedule → Run workflow** once. Verify its result and the last-check status in the dashboard. This can start/stop the target immediately according to the current time.

Windows use local wall time in the saved timezone. Start is inclusive, end is exclusive. Overnight windows belong to their start day: Monday 22:00–02:00 includes Tuesday until 02:00. Overlapping windows are combined. Equal start/end times are rejected. DST follows the timezone's local clock: repeated hours may match twice; skipped hours never occur.

The workflow checks at UTC minutes 7, 22, 37 and 52. It starts only a `Shutdown` machine inside work hours and stops only an `Available` machine outside them; transitional states are left alone. The saved target must match the Actions variable. Schedule edits are revision-guarded. Disabling the schedule means **manual control**; it does not itself stop a running machine. If the companion is sleeping, start it at [GitHub Codespaces](https://github.com/codespaces) to edit hours, or disable the Actions opt-in variable as an emergency pause.

**Not a spending guarantee:** Actions schedules can be delayed, dropped, or disabled (including inactivity on public repositories). This controller may stop the Codespace while you are actively working or the agent is running. Save work and plan for interruption. Set a GitHub budget/spending limit and Codespaces idle timeout independently; storage can still incur charges while stopped. Inspect Actions failures and keep secrets current. Deleted/expired Codespaces are not recreated automatically.

**2 ↔ 4 cores:** The website fetches the real machine list for this Codespace and displays available 2-/4-core choices. It never invents a machine name. GitHub's PATCH request records the new size for **the next start**. Save work, stop the Codespace on GitHub, then start it to apply. This dashboard deliberately does not kill itself automatically after resizing. Four cores consume core-hours twice as fast as two for equal running time. Organization restrictions, region capacity, and quotas may prevent a selection.

## 3. Facebook Messenger

This is a **custom, text-only Facebook Page bridge**, not an official bundled OpenClaw channel and not automation of a personal Facebook account. It requires a Meta developer app connected to a Facebook Page, access to Messenger's messaging APIs, a Page access token, webhook subscription, and any app review/permissions required by Meta for your audience. Development-mode restrictions still apply. We cannot complete or verify those owner account steps from this repository.

Add these **Codespaces secrets/environment settings only**:

| Setting                       | Purpose                                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `MESSENGER_ENABLED=1`         | Explicit opt-in; disabled by default                                                                                       |
| `MESSENGER_APP_SECRET`        | Validates `X-Hub-Signature-256`                                                                                            |
| `MESSENGER_VERIFY_TOKEN`      | Your random webhook verification string; enter the same one in Meta                                                        |
| `MESSENGER_PAGE_ACCESS_TOKEN` | Page token for Send API replies                                                                                            |
| `MESSENGER_PAGE_ID`           | Numeric Page ID                                                                                                            |
| `MESSENGER_GRAPH_VERSION`     | Supported Graph version enabled for your Meta app, in `vNN.N` format                                                       |
| `MESSENGER_ALLOWED_PSIDS`     | Comma-separated numeric **Page-scoped** sender IDs explicitly permitted to control the bot; not ordinary Facebook user IDs |
| `MESSENGER_AGENT_ID`          | Optional configured OpenClaw agent, default `main`                                                                         |

An empty sender allowlist is rejected; there is no automatic enrollment from incoming messages. Obtain the intended person's Page-scoped ID through your Meta Page/app tooling.

Restart the companion. When enabled, a **separate webhook-only HTTP server** listens on port **3001**. In Codespaces, forward **only 3001** publicly if your organization permits it, or use a dedicated HTTPS ingress to that port. Register its HTTPS URL plus `/webhook` in Meta; subscribe the Page/app to message events. Codespaces may reset port visibility on restart: recheck the webhook after restart. For dependable 24/7 messaging, deploy this bridge and Gateway on an always-on private host behind a webhook-only public ingress rather than a sleeping Codespace.

**Keep port 3000 PRIVATE and keep the Gateway port loopback-only. Never expose the companion or Gateway just to satisfy Meta webhook verification.** The webhook server serves no dashboard, static assets, database routes, CSRF bootstrap, or administrative API.

The bridge:

- Checks the GET verification token and constant-time HMAC-SHA256 over the raw POST bytes.
- Checks the configured Page and explicit PSID allowlist, ignores echoes/non-text events, limits body/message/queue sizes, and rejects stale event timestamps.
- Persists accepted events to a 0600 local inbox before acknowledging, serializes agent turns, and remembers the most recent 1,000 completed event IDs for deduplication.
- Routes each allowed sender into a separate `agent:<id>:messenger:direct:<PSID>` session using the supported `openclaw agent --session-key … --json` command, then sends text via Meta's Send API with server-side authorization. A version supporting `--session-key` is required.
- Splits long responses into bounded text chunks (maximum 18,000 code points). No images, files, postbacks, or group features are implemented.
- Does **not** automatically retry uncertain agent runs or outbound deliveries: an interrupted/failed run is marked failed, avoiding duplicate tool execution. Messages queued more than 23 hours are not processed. Check failure counts in **Messaging channels** and send a new message intentionally when ready.

The bot has the chosen agent's configured tool permissions. Only allow trusted owners, or configure a restricted dedicated agent before allowing other people. Signature verification is not a sandbox. Database/GitHub/Meta management secrets are excluded from Gateway subprocess environments as defense in depth; trusted tools still share the Codespace OS identity and can read owner files.

**Sleeping limitation:** no webhook or bot replies are available while the Codespace sleeps. Meta's retry/delivery policy is not a durable offline inbox guarantee. Turso alone does not make an offline Gateway answer messages. This path is covered by local signed-webhook and mocked-delivery tests, not a verified live Meta integration.
