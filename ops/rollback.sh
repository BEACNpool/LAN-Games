#!/usr/bin/env bash
# Restore a code snapshot created by ops/deploy.sh. Runtime data, .git,
# virtualenvs, caches and logs remain protected. Default is a dry run.
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=ops/release_lib.sh
source "$script_dir/release_lib.sh"

usage() {
  cat <<'USAGE'
Usage:
  ops/rollback.sh --host HOST --dest /absolute/path \
    --backup /absolute/path/to/release [--apply]

Options:
  --service NAME       systemd user unit (default: gamehub)
  --health-url URL     default: http://127.0.0.1:8096/health
  --apply              restore after showing the dry-run
  --yes                skip typed confirmation
  -h, --help           show help

Only code is restored. Runtime data is never overwritten automatically.
The backup's runtime-data.tar.gz is disaster-recovery material for a deliberate,
manual restore after inspection.
USAGE
}

host=""
dest=""
backup=""
service="gamehub"
health_url="http://127.0.0.1:8096/health"
apply=0
assume_yes=0

while (($#)); do
  case "$1" in
    --host) [[ $# -ge 2 ]] || lan_games_die "--host needs a value"; host="$2"; shift 2 ;;
    --dest) [[ $# -ge 2 ]] || lan_games_die "--dest needs a value"; dest="${2%/}"; shift 2 ;;
    --backup) [[ $# -ge 2 ]] || lan_games_die "--backup needs a value"; backup="${2%/}"; shift 2 ;;
    --service) [[ $# -ge 2 ]] || lan_games_die "--service needs a value"; service="$2"; shift 2 ;;
    --health-url) [[ $# -ge 2 ]] || lan_games_die "--health-url needs a value"; health_url="$2"; shift 2 ;;
    --apply) apply=1; shift ;;
    --yes) assume_yes=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) lan_games_die "unknown argument: $1" ;;
  esac
done

[[ -n "$host" && -n "$dest" && -n "$backup" ]] \
  || lan_games_die "--host, --dest and --backup are required"
lan_games_validate_host "$host"
lan_games_validate_path "$dest"
lan_games_validate_path "$backup"
[[ "$backup" != "$dest" && "$backup" != "$dest/"* ]] \
  || lan_games_die "backup must be outside the deployment target"
[[ "$service" =~ ^[A-Za-z0-9_.@-]+$ ]] || lan_games_die "unsafe service name"
[[ "$health_url" =~ ^https?://[A-Za-z0-9._:/?=-]+$ ]] || lan_games_die "unsafe health URL"

echo "rollback dry-run (runtime, git metadata, virtualenvs and caches protected)"
ssh "$host" "bash -s -- '$dest' '$backup'" <<'REMOTE'
set -euo pipefail
dest="$1"
backup="$2"
[[ -d "$dest" ]] || { echo "missing target: $dest" >&2; exit 1; }
[[ -d "$backup/code" ]] || { echo "missing code snapshot: $backup/code" >&2; exit 1; }
[[ -f "$backup/manifest" ]] || { echo "missing release manifest: $backup/manifest" >&2; exit 1; }
[[ -f "$backup/code.sha256" ]] || { echo "missing code checksum" >&2; exit 1; }
expected="$(<"$backup/code.sha256")"
actual="$(tar -C "$backup/code" --sort=name --mtime=@0 --owner=0 --group=0 \
  --numeric-owner -cf - . 2>/dev/null | sha256sum | awk '{print $1}')"
[[ "$actual" == "$expected" ]] \
  || { echo "code snapshot checksum mismatch" >&2; exit 1; }
args=(
  --archive --checksum --delete-delay --itemize-changes --human-readable --safe-links
  --no-owner --no-group
  --filter="protect /data" --filter="protect /data/***" --exclude="/data"
  --filter="protect /.git" --filter="protect /.git/***" --exclude="/.git"
  --filter="protect /.venv" --filter="protect /.venv/***" --exclude="/.venv"
  --filter="protect /venv" --filter="protect /venv/***" --exclude="/venv"
  --filter="protect **/node_modules" --filter="protect **/node_modules/***" --exclude="**/node_modules"
  --filter="protect **/__pycache__" --filter="protect **/__pycache__/***" --exclude="**/__pycache__"
  --filter="protect **/.pytest_cache" --filter="protect **/.pytest_cache/***" --exclude="**/.pytest_cache"
  --filter="protect **/.mypy_cache" --filter="protect **/.mypy_cache/***" --exclude="**/.mypy_cache"
  --filter="protect **/.ruff_cache" --filter="protect **/.ruff_cache/***" --exclude="**/.ruff_cache"
  --filter="protect **/.cache" --filter="protect **/.cache/***" --exclude="**/.cache"
  --filter="protect /.coverage" --exclude="/.coverage"
  --filter="protect *.py[co]" --exclude="*.py[co]"
  --filter="protect *.log" --exclude="*.log"
  --filter="protect /nohup.out" --exclude="/nohup.out"
)
rsync "${args[@]}" --dry-run "$backup/code/" "$dest/"
REMOTE

if [[ "$apply" -ne 1 ]]; then
  echo "DRY RUN ONLY — rerun with --apply after reviewing the plan."
  exit 0
fi
if [[ "$assume_yes" -ne 1 ]]; then
  read -r -p "Type ROLLBACK to restore this code snapshot: " confirmation
  [[ "$confirmation" == "ROLLBACK" ]] || lan_games_die "rollback cancelled"
fi

ssh "$host" "bash -s -- '$dest' '$backup'" <<'REMOTE'
set -euo pipefail
dest="$1"
backup="$2"
failed="$backup/failed-release-code-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$failed"
args=(
  --archive --checksum --delete-delay --itemize-changes --human-readable --safe-links
  --no-owner --no-group
  --filter="protect /data" --filter="protect /data/***" --exclude="/data"
  --filter="protect /.git" --filter="protect /.git/***" --exclude="/.git"
  --filter="protect /.venv" --filter="protect /.venv/***" --exclude="/.venv"
  --filter="protect /venv" --filter="protect /venv/***" --exclude="/venv"
  --filter="protect **/node_modules" --filter="protect **/node_modules/***" --exclude="**/node_modules"
  --filter="protect **/__pycache__" --filter="protect **/__pycache__/***" --exclude="**/__pycache__"
  --filter="protect **/.pytest_cache" --filter="protect **/.pytest_cache/***" --exclude="**/.pytest_cache"
  --filter="protect **/.mypy_cache" --filter="protect **/.mypy_cache/***" --exclude="**/.mypy_cache"
  --filter="protect **/.ruff_cache" --filter="protect **/.ruff_cache/***" --exclude="**/.ruff_cache"
  --filter="protect **/.cache" --filter="protect **/.cache/***" --exclude="**/.cache"
  --filter="protect /.coverage" --exclude="/.coverage"
  --filter="protect *.py[co]" --exclude="*.py[co]"
  --filter="protect *.log" --exclude="*.log"
  --filter="protect /nohup.out" --exclude="/nohup.out"
)
rsync "${args[@]}" "$dest/" "$failed/"
rsync "${args[@]}" "$backup/code/" "$dest/"
REMOTE

ssh "$host" "systemctl --user restart '$service' && systemctl --user is-active --quiet '$service'"
ssh "$host" "for i in \$(seq 1 20); do curl -fsS '$health_url' >/dev/null && exit 0; sleep 0.5; done; exit 1"
echo "ROLLBACK COMPLETE — runtime data remained untouched"
