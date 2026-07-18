#!/usr/bin/env bash
# Dev restart: kill whatever holds port 8096, start fresh, wait for /health.
set -e
cd "$(dirname "$0")/.."
fuser -k -TERM 8096/tcp 2>/dev/null || true
for i in $(seq 1 25); do
  ss -tln 2>/dev/null | grep -q ':8096 ' || break
  sleep 0.2
done
if ss -tln 2>/dev/null | grep -q ':8096 '; then
  echo "port 8096 still busy" >&2; exit 1
fi
nohup "$PWD/.venv/bin/python" "$PWD/server.py" > "${GAMEHUB_LOG:-$HOME/tmp/gamehub-server.log}" 2>&1 &
for i in $(seq 1 25); do
  curl -sf 127.0.0.1:8096/health >/dev/null 2>&1 && { echo "server up"; exit 0; }
  sleep 0.2
done
echo "server failed to start" >&2; exit 1
