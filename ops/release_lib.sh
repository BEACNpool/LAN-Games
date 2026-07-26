#!/usr/bin/env bash
# Shared release safety policy. Source this file; do not execute it directly.

lan_games_die() {
  echo "error: $*" >&2
  exit 1
}

lan_games_validate_host() {
  [[ "$1" =~ ^[A-Za-z0-9._@:-]+$ ]] \
    || lan_games_die "unsafe host value: $1"
}

lan_games_validate_path() {
  local path="$1"
  [[ "$path" =~ ^/[A-Za-z0-9._/-]+$ ]] \
    || lan_games_die "paths must be absolute and contain no spaces: $path"
  [[ "$path" != *"//"* && "$path" != *"/./"* && "$path" != *"/../"* \
     && "$path" != */. && "$path" != */.. ]] \
    || lan_games_die "path traversal/redundant segments are not allowed: $path"
  [[ "$path" != "/" && "$path" != "/home" && "$path" != "/srv" ]] \
    || lan_games_die "refusing broad target path: $path"
  [[ ${#path} -ge 12 ]] \
    || lan_games_die "target path is suspiciously short: $path"
}

lan_games_rsync_content_change() {
  # Itemized rsync output beginning with "." is metadata-only (commonly a
  # timestamp from the frozen worktree). Transfers and deletions change code.
  case "$1" in
    \<f*|\>f*|\*deleting) return 0 ;;
    *) return 1 ;;
  esac
}

lan_games_rsync_args() {
  # Protect + exclude is deliberate belt-and-suspenders behavior:
  #   exclude = never copy over it
  #   protect = --delete can never remove it on the receiver
  #
  # Protect all of data/, not only today's known paths, so future runtime state
  # inherits the safe policy automatically.
  LAN_GAMES_RSYNC_ARGS=(
    --archive
    --checksum
    --delete-delay
    --itemize-changes
    --human-readable
    --safe-links
    --no-owner
    --no-group
    --filter="protect /data"
    --filter="protect /data/***"
    --exclude="/data"
    --filter="protect /.git"
    --filter="protect /.git/***"
    --exclude="/.git"
    --filter="protect /.venv"
    --filter="protect /.venv/***"
    --exclude="/.venv"
    --filter="protect /venv"
    --filter="protect /venv/***"
    --exclude="/venv"
    --filter="protect **/node_modules"
    --filter="protect **/node_modules/***"
    --exclude="**/node_modules"
    --filter="protect **/__pycache__"
    --filter="protect **/__pycache__/***"
    --exclude="**/__pycache__"
    --filter="protect **/.pytest_cache"
    --filter="protect **/.pytest_cache/***"
    --exclude="**/.pytest_cache"
    --filter="protect **/.mypy_cache"
    --filter="protect **/.mypy_cache/***"
    --exclude="**/.mypy_cache"
    --filter="protect **/.ruff_cache"
    --filter="protect **/.ruff_cache/***"
    --exclude="**/.ruff_cache"
    --filter="protect **/.cache"
    --filter="protect **/.cache/***"
    --exclude="**/.cache"
    --filter="protect /.coverage"
    --exclude="/.coverage"
    --filter="protect *.py[co]"
    --exclude="*.py[co]"
    --filter="protect *.log"
    --exclude="*.log"
    --filter="protect /nohup.out"
    --exclude="/nohup.out"
  )
}
