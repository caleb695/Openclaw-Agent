import {
  mkdir,
  writeFile,
  readFile,
  chmod,
  realpath,
  symlink,
  rename,
  lstat,
} from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
const flags = new Set(process.argv.slice(2));
if (!process.env.CODESPACE_NAME)
  throw new Error('Run setup inside your Agent Codespace. Local development: npm run dev.');
const dir = process.env.DASHBOARD_STATE_DIR || '/workspaces/.openclaw-dashboard';
await mkdir(dir, { recursive: true, mode: 0o700 });
await chmod(dir, 0o700);
let settings = {};
try {
  settings = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
execFileSync('openclaw', ['--version'], { stdio: 'inherit' });
if (flags.has('--persist-openclaw')) {
  // Explicit opt-in only; never copy a live SQLite database or silently replace state.
  try {
    execFileSync('openclaw', ['gateway', 'call', 'health', '--json', '--timeout', '3000'], {
      stdio: 'ignore',
    });
    throw new Error('Stop your Gateway before migrating its state.');
  } catch (e) {
    if (!e.status) throw e;
  }
  if (process.env.OPENCLAW_STATE_DIR || process.env.OPENCLAW_CONFIG_PATH)
    throw new Error('Custom OpenClaw paths detected. Persist them manually; see README.');
  const source = join(homedir(), '.openclaw'),
    target = '/workspaces/.openclaw-agent-state';
  try {
    const stat = await lstat(source);
    if (stat.isSymbolicLink()) {
      console.log('Existing OpenClaw state symlink preserved.');
    } else {
      try {
        await lstat(target);
        throw new Error('Persistent target already exists. Refusing to overwrite it.');
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      // Rename may cross filesystems. cp+rm is deliberately not automatic for live agent data.
      try {
        await rename(source, target);
      } catch (e) {
        if (e.code === 'EXDEV')
          throw new Error(
            'Cross-filesystem move required. With Gateway stopped, follow the explicit migration commands in README, then rerun setup.',
          );
        throw e;
      }
      await symlink(target, source);
      await chmod(target, 0o700);
    }
  } catch (e) {
    if (e.code === 'ENOENT')
      console.log('No default OpenClaw state found; complete onboarding first.');
    else throw e;
  }
}
if (flags.has('--manage-gateway')) settings.manageGateway = true;
if (flags.has('--external-gateway')) settings.manageGateway = false;
await writeFile(join(dir, 'settings.json'), JSON.stringify(settings, null, 2), { mode: 0o600 });
console.log(
  `\nPrivate companion URL:\nhttps://${process.env.CODESPACE_NAME}-3000.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev'}\n`,
);
console.log(
  settings.manageGateway
    ? 'Companion supervision enabled. Stop your existing Gateway using its current owner before starting the companion.'
    : 'Existing Gateway ownership preserved. The companion will not start or stop it.',
);
console.log(
  'Run: npm run build && npm start\nKeep port 3000 PRIVATE. Never forward port 18789 publicly.\nOpen GitHub Pages and paste the private companion URL once. No tokens required.',
);
