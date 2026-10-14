import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { databaseFromEnv } from '../server/database.mjs';
import { OpenClaw } from '../server/openclaw.mjs';
import { FullBackup, fullBackupOptions } from '../server/full-backup.mjs';

const [action, ...args] = process.argv.slice(2);
let db;
try {
  if (!['sync', 'status', 'recover'].includes(action))
    throw new Error(
      'Use npm run backup:sync, backup:status, or backup:recover -- --output /private/new-directory [--extract].',
    );
  let output;
  let extract = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' && args[i + 1]) output = resolve(args[++i]);
    else if (args[i] === '--extract') extract = true;
    else throw new Error('Unknown backup option. Recovery accepts --output and --extract only.');
  }
  if (action === 'recover' && !output)
    throw new Error(
      'Recovery needs --output pointing to a new private directory outside the Git checkout and live OpenClaw state.',
    );
  if (action !== 'recover' && (output || extract))
    throw new Error('Recovery options cannot be used with sync/status.');
  db = await databaseFromEnv();
  if (!db)
    throw new Error(
      'Turso is not configured. Set the three server-side Turso/encryption secrets first.',
    );
  const state =
    process.env.DASHBOARD_STATE_DIR ||
    (process.env.CODESPACES
      ? '/workspaces/.openclaw-dashboard'
      : join(homedir(), '.openclaw-dashboard'));
  const backup = await new FullBackup(db, new OpenClaw(), state, fullBackupOptions()).init();
  const result =
    action === 'sync'
      ? await backup.backup()
      : action === 'status'
        ? await backup.status()
        : await backup.recover(output, { extract });
  console.log(JSON.stringify(result, null, 2));
  if (action === 'recover')
    console.log(
      'Recovery staged privately. Stop the companion, Gateway, and other writers before activating state. Review recovery/manifest.json and docs/INTEGRATIONS.md; supplemental archives are not automatically extracted.',
    );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  db?.close();
}
