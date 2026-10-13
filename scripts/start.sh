#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
state="${DASHBOARD_STATE_DIR:-/workspaces/.openclaw-dashboard}"
mkdir -p "$state"
chmod 700 "$state"
# /workspaces survives rebuilds. Restore the explicit default-state migration only.
if [ -d /workspaces/.openclaw-agent-state ] && [ ! -e "$HOME/.openclaw" ]; then
  ln -s /workspaces/.openclaw-agent-state "$HOME/.openclaw"
fi
if [ -f "$state/companion.pid" ]; then
  pid=$(cat "$state/companion.pid")
  if [ -r "/proc/$pid/cmdline" ] && grep -aq 'server/index.mjs' "/proc/$pid/cmdline"; then
    echo "Companion already running (PID $pid)."; exit 0
  fi
fi
npm ci
npm run build
nohup node server/index.mjs >> "$state/companion.log" 2>&1 </dev/null &
echo "$!" > "$state/companion.pid"
echo 'Companion starting at http://localhost:3000. Keep this port PRIVATE.'
# Codespaces resets visibility to private on restart; reinforce that when CLI access permits.
if [ -n "${CODESPACE_NAME:-}" ]; then
  gh codespace ports visibility 3000:private -c "$CODESPACE_NAME" || echo 'Verify port 3000 is Private in the Ports panel.'
fi
