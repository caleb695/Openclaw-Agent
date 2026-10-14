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

Restart the Codespace/companion after adding secrets so its process receives them. The driver creates `dashboard_documents`, `dashboard_backups`, and `dashboard_backup_chunks` automatically. No hosted GitHub Marketplace application or frontend database connection is needed.

### Enable and verify the full-state mirror

1. Deploy this revision in the Codespace, run `npm ci && npm run build`, and restart the companion. Existing server-side Turso secrets are reused. No database credentials enter the frontend.
2. Use the supported OpenClaw release (this repository targets **2026.10.3**) with `backup create --verify --json`, `backup verify`, and `backup restore`. Unsupported commands fail the sync; there is no silent config-only fallback.
3. Open **Database → Sync full backup now**. It starts a background job, not an immediate completed backup. Refresh until `busy: false`, the completion `updatedAt` advances, and `warning` is empty. `capturedAt` marks when capture began; later changes may need another sync.
4. Test recovery in a new private directory using the commands below **before deleting/rebuilding your Codespace**. Inspect native archive warnings privately.

### What is stored

- The companion invokes **`openclaw backup create --output <private-temp-dir> --verify --json`**, with workspaces enabled. The native archive covers OpenClaw state, conversations/session transcripts, memory databases, configured agent roots and workspaces, files, configuration and its `$include` dependencies, auth profiles, channel credentials, cron state, and durable plugin state covered by OpenClaw's backup inventory.
- OpenClaw owns SQLite capture and verification; the companion does **not** copy live core SQLite/WAL files as ordinary files. The native implementation provides per-database snapshots, not one transaction across all databases and files. Pause writers for the strongest cross-file consistency. Unmanaged/plugin SQLite files can be opaque copies; inspect warnings and use their owner's backup procedure.
- A supplemental archive covers the companion state directory: credential vault, settings, update policy, Messenger inbox, and other files. Its `backups/`, `companion.pid`, and `companion.log` are excluded to avoid recursive/historical archives and stale runtime state. Other included files/logs can still contain retained data. This supplemental file capture is not a database snapshot API.
- For durable external files not included by OpenClaw, set server-only `OPENCLAW_BACKUP_EXTRA_PATHS` to a JSON array, e.g. `["/workspaces/private-bot-data", "/home/codespace/private-provider/auth.json"]`. Roots must be absolute and readable. Explicit root symlinks resolve; nested symlinks are archived as links, **not followed**. List external targets separately. Missing configured roots fail sync rather than silently lose coverage. If you intentionally delete an entire extra root, also remove its entry from this list and sync again to delete its cloud copy. Don't select home, `/`, temporary folders, database files, trash, or backup/recovery directories.
- Archives are streamed into **128 KiB chunks**, encrypted with AES-256-GCM, and stored directly in Turso. Nonces are fresh; authenticated identity binds each chunk to its namespace, snapshot, and position. The encrypted manifest stores sizes, SHA-256 checksums, source paths, and the native private report. Browser status contains no filenames, archive contents, or credentials.
- The default combined **compressed upload limit is 1 GiB**, configurable with `OPENCLAW_BACKUP_MAX_BYTES`. Exceeding it fails—nothing is silently omitted/truncated. Archive creation needs local temporary disk _before_ this limit is checked. Native creation/verification have a 20-minute timeout per CLI invocation. Large captures and Turso quotas can still fail. Base64/encryption storage overhead is roughly 1.8× archive size, plus indexes; allow room for the old and new copy during upload. Five-minute full snapshots can incur substantial database writes and transfer costs.
- No Turso secrets means local-only mode. Partial credentials, decryption errors, validation failures, and upload errors fail closed.

### Deletion policy: a current mirror, not historical retention

**Only one completed recovery point is retained per namespace.** Each successful sync publishes the new snapshot and deletes **all previous snapshot rows and chunks**, plus superseded incomplete uploads, in the same database transaction. The first successful full sync also removes legacy `openclaw-config` and `companion-settings` documents; the separate encrypted vault document is replaced from the current local vault with concurrency checks. Scheduler documents remain independent.

For example: delete an agent **and its files** in OpenClaw, then sync. The new archive contains the remaining agents only; the old archive containing that agent's memory/conversations is deleted from the active Turso tables. Removing only an agent's configuration does not delete its files. Any leftover files, trash, archived transcripts, logs, shared references, or duplicates still in included source trees can still be backed up. The mirror reflects actual source data, not a per-agent semantic erasure tool.

Sync starts on companion startup, every five minutes while awake (skipping maintenance/in-flight jobs), after dashboard configuration/credential/plugin/update-policy changes, and on **Sync full backup now**. Changes made directly through OpenClaw or a terminal, including deletions, are picked up by the next successful sync. Run `npm run backup:sync` to wait for completion in a private terminal; use one sync writer per namespace. Edits during a dashboard-triggered capture request a follow-up capture.

**Deletion is not instantaneous.** It remains pending while offline, during capture, or after any failed sync. The last completed mirror remains recoverable until a replacement commits. Check `capturedAt`, `updatedAt`, and `warning`; a click/accepted job is not a deletion acknowledgment. Abrupt termination can leave private temporary archives on the Codespace and encrypted incomplete upload rows in Turso; the next successful sync removes superseded upload rows. Remove abandoned temporary files privately only after confirming no backup process is using them.

This is SQL-level deletion from the application's active tables, **not a guarantee of forensic erasure** from Turso's own recovery copies, replicas, transaction history, or storage pages. Check your provider's retention policy separately. Local updater backups and any recovery exports are separate copies and are not removed by mirror sync. Because deletions propagate, accidental deletion has no historical undo after a successful sync. Do not use this namespace for multiple independent bots/hosts.

### Recover after losing a Codespace

Full-state recovery is deliberately **terminal-only and staged**, never an automatic overwrite of a running bot. Once a full mirror exists, the companion does not restore individual missing config/vault/settings files at startup (that could resurrect deletions or start an empty bot and overwrite the mirror). Missing config blocks startup with recovery instructions. Older config-only deployments retain their legacy bootstrap behavior until the first full sync.

1. Stop automatic companion startup/sync on the replacement host. Install the compatible OpenClaw version and the companion's dependencies. Restore the same Turso URL/token, `DASHBOARD_NAMESPACE`, and **encryption key** into its private environment. Do not start a newly initialized empty agent against the old namespace: syncing it would intentionally replace the mirror.
2. Stop other sync writers during recovery; a concurrent successful sync can delete the snapshot being downloaded, in which case recovery fails safely and must be retried.
3. In the private terminal, choose a **new** private directory outside Git and all live state/workspace trees:

   ```bash
   npm run backup:status
   npm run backup:recover -- --output /workspaces/private-openclaw-recovery --extract
   ```

   This reads the latest completed manifest, decrypts and streams every chunk, checks each archive's size and SHA-256, runs `openclaw backup verify`, and (with `--extract`) invokes `openclaw backup restore --target <staging>`. Existing output paths are refused; failure removes partial output. A wrong key never overwrites cloud or local state. Output is **plaintext sensitive material**, protected by a 0700 directory and 0600 archive/manifest files—keep it out of Git and public file servers.

4. Inspect `recovery/manifest.json` (including `openclawReport` warnings). The `openclaw-restored/` tree contains the native archive layout and its own manifest. Use that native manifest to locate each state, config, credentials, workspace, and agent asset. Inspect `companion.tar.gz` and any `extra-N.tar.gz` archives with `tar -tzf` first; extract each into its **own new private staging directory** for review, not into `/` or a running state tree. Supplemental archives are intentionally not auto-extracted or activated. Their source mappings are in the encrypted/exported manifest.
5. With the companion, Gateway, plugins, and other writers stopped, activate the restored files using OpenClaw's [recovery workflow](https://github.com/openclaw/openclaw/blob/v2026.10.3/docs/install/backups.md). Restore companion files into `DASHBOARD_STATE_DIR`, repair absolute paths and the dashboard file-secret-provider path if locations changed, and review symlink targets. No automatic path rewriting is done for a full mirror.
6. Reinstall OpenClaw/runtime binaries and plugin dependencies. The native backup intentionally excludes rebuildable `node_modules`, runtime caches, some temporary/sanitized delivery state, and private update captures. It is a **full supported OpenClaw state archive, not a disk image of the Codespace**. Environment-only secrets are not captured; supply them again, along with any external service data not represented by the included files. Channels may need relinking after rollback.
7. Run `openclaw doctor`, verify agents/conversations/memory/workspaces/channels, and only then restart the companion and its mirror. Delete your plaintext recovery staging files when you no longer need them.

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
