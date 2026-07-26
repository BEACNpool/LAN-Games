#!/usr/bin/env bash
# Dry-run-first LAN Games deployment with an off-tree rollback point.
#
# Nothing is changed unless --apply is supplied. Even then, the exact rsync
# plan is shown first, current code/runtime state is backed up, protected paths
# are fingerprinted, and a failed health check rolls code back automatically.
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=ops/release_lib.sh
source "$script_dir/release_lib.sh"

usage() {
  cat <<'USAGE'
Usage:
  ops/deploy.sh --host HOST --dest /absolute/path [options]

Required:
  --host HOST              SSH host/alias that owns the service
  --dest PATH              Absolute production checkout path

Safety and behavior:
  --apply                  Apply after showing the dry-run (default: plan only)
  --yes                    Skip the typed confirmation (automation only)
  --skip-tests             Skip pytest; the privacy gate still runs
  --restart                Restart even for a static-only release
  --no-restart             Never restart (rejected when Python changes)

Configuration:
  --backup-root PATH       Remote backup root (default: DEST parent /
                           .lan-games-backups / DEST basename)
  --service NAME           systemd user unit (default: gamehub)
  --health-url URL         Remote health URL
                           (default: http://127.0.0.1:8096/health)
  -h, --help               Show this help

Examples:
  # Mandatory first pass: read the plan; production is untouched.
  ops/deploy.sh --host game-host --dest /home/me/projects/gamehub

  # Apply the same release after reviewing the plan.
  ops/deploy.sh --host game-host --dest /home/me/projects/gamehub --apply
USAGE
}

host=""
dest=""
backup_root=""
service="gamehub"
health_url="http://127.0.0.1:8096/health"
apply=0
assume_yes=0
skip_tests=0
restart_mode="auto"

while (($#)); do
  case "$1" in
    --host) [[ $# -ge 2 ]] || lan_games_die "--host needs a value"; host="$2"; shift 2 ;;
    --dest) [[ $# -ge 2 ]] || lan_games_die "--dest needs a value"; dest="${2%/}"; shift 2 ;;
    --backup-root) [[ $# -ge 2 ]] || lan_games_die "--backup-root needs a value"; backup_root="${2%/}"; shift 2 ;;
    --service) [[ $# -ge 2 ]] || lan_games_die "--service needs a value"; service="$2"; shift 2 ;;
    --health-url) [[ $# -ge 2 ]] || lan_games_die "--health-url needs a value"; health_url="$2"; shift 2 ;;
    --apply) apply=1; shift ;;
    --yes) assume_yes=1; shift ;;
    --skip-tests) skip_tests=1; shift ;;
    --restart) restart_mode="always"; shift ;;
    --no-restart) restart_mode="never"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) lan_games_die "unknown argument: $1" ;;
  esac
done

[[ -n "$host" ]] || lan_games_die "--host is required"
[[ -n "$dest" ]] || lan_games_die "--dest is required"
lan_games_validate_host "$host"
lan_games_validate_path "$dest"
[[ "$service" =~ ^[A-Za-z0-9_.@-]+$ ]] || lan_games_die "unsafe service name"
[[ "$health_url" =~ ^https?://[A-Za-z0-9._:/?=-]+$ ]] || lan_games_die "unsafe health URL"

dest_parent="${dest%/*}"
dest_name="${dest##*/}"
if [[ -z "$backup_root" ]]; then
  backup_root="$dest_parent/.lan-games-backups/$dest_name"
fi
lan_games_validate_path "$backup_root"
[[ "$backup_root" != "$dest" && "$backup_root" != "$dest/"* ]] \
  || lan_games_die "backup root must be outside the deployment target"

for command in git python3 rsync ssh; do
  command -v "$command" >/dev/null || lan_games_die "missing local command: $command"
done

repo_root="$(git -C "$script_dir" rev-parse --show-toplevel)"
cd "$repo_root"
commit="$(git rev-parse HEAD)"
short_commit="${commit:0:12}"
branch="$(git symbolic-ref --short -q HEAD || echo detached)"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || lan_games_die "unexpected commit id"
[[ "$branch" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$ ]] \
  || lan_games_die "unsafe branch name; release from a conventionally named branch"
release_id="$(date -u +%Y%m%dT%H%M%SZ)-$short_commit"
release_dir="$backup_root/$release_id"

dirty="$(git status --porcelain --untracked-files=all)"
if [[ -n "$dirty" ]]; then
  echo "$dirty" >&2
  lan_games_die "source tree is dirty; commit the exact release before deploying"
fi

# Freeze the committed release into its own worktree before tests or review.
# Every later test, dry-run and applied rsync reads these same immutable bytes,
# so a concurrent edit to the developer worktree cannot change the release.
release_parent="$(mktemp -d -t lan-games-release.XXXXXXXX)"
release_source="$release_parent/source"
plan_file="$release_parent/rsync-plan"
cleanup() {
  local status=$?
  trap - EXIT
  rm -f -- "$plan_file"
  if [[ -d "$release_source" ]]; then
    git -C "$repo_root" worktree remove --force "$release_source" >/dev/null 2>&1 || true
  fi
  rmdir -- "$release_parent" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
git worktree add --quiet --detach "$release_source" "$commit"

python_bin="$repo_root/.venv/bin/python"
[[ -x "$python_bin" ]] || python_bin="$(command -v python3)"

"$python_bin" -c 'import pytest' 2>/dev/null \
  || lan_games_die "pytest is unavailable; install requirements-dev.txt before releasing"
echo "privacy gate"
(cd "$release_source" && "$python_bin" tests/test_no_private_data.py)
if [[ "$skip_tests" -ne 1 ]]; then
  echo "full Python suite"
  (cd "$release_source" && "$python_bin" -m pytest -q)
else
  echo "warning: full test suite skipped" >&2
fi
[[ -z "$(git -C "$release_source" status --porcelain --untracked-files=no)" ]] \
  || lan_games_die "tests modified tracked release files"

echo "remote preflight: $host:$dest"
ssh "$host" "bash -s -- '$dest'" <<'REMOTE'
set -euo pipefail
dest="$1"
[[ -d "$dest" ]] || { echo "missing production directory: $dest" >&2; exit 1; }
[[ -w "$dest" ]] || { echo "production directory is not writable: $dest" >&2; exit 1; }
command -v rsync >/dev/null
command -v tar >/dev/null
command -v sha256sum >/dev/null
REMOTE

lan_games_rsync_args

echo
echo "release: $branch@$short_commit"
echo "target:  $host:$dest"
echo "backup:  $host:$release_dir"
echo
echo "rsync dry-run (protected: all data, git metadata, virtualenvs, caches, logs)"
rsync "${LAN_GAMES_RSYNC_ARGS[@]}" --dry-run "$release_source/" "$host:$dest/" | tee "$plan_file"

python_changed=0
requirements_changed=0
while IFS= read -r line; do
  path="${line##* }"
  case "$path" in
    server.py|core/*.py|games/*.py|games/**/*.py) python_changed=1 ;;
    requirements.txt) requirements_changed=1; python_changed=1 ;;
  esac
done < "$plan_file"

if [[ "$requirements_changed" -eq 1 ]]; then
  lan_games_die "requirements.txt changed; this code-only deploy refuses non-atomic virtualenv changes"
fi
if [[ "$python_changed" -eq 1 && "$restart_mode" == "never" ]]; then
  lan_games_die "Python changes require a restart; remove --no-restart"
fi

if [[ "$apply" -ne 1 ]]; then
  echo
  echo "DRY RUN ONLY — no remote files changed."
  echo "Review every deletion/update above, then rerun with --apply."
  exit 0
fi

if [[ "$assume_yes" -ne 1 ]]; then
  echo
  read -r -p "Type DEPLOY $short_commit to continue: " confirmation
  [[ "$confirmation" == "DEPLOY $short_commit" ]] || lan_games_die "deployment cancelled"
fi

echo "creating rollback point"
ssh "$host" "bash -s -- '$dest' '$release_dir' '$commit' '$branch'" <<'REMOTE'
set -euo pipefail
dest="$1"
release_dir="$2"
commit="$3"
branch="$4"
umask 077
[[ ! -e "$release_dir" ]] \
  || { echo "refusing to overwrite rollback point: $release_dir" >&2; exit 1; }
mkdir -p "$release_dir/code"

protected=(
  --archive --checksum --delete
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
rsync "${protected[@]}" "$dest/" "$release_dir/code/"
tar -C "$release_dir/code" --sort=name --mtime=@0 --owner=0 --group=0 \
  --numeric-owner -cf - . 2>/dev/null \
  | sha256sum | awk '{print $1}' > "$release_dir/code.sha256"

if [[ -e "$dest/data" ]]; then
  tar -C "$dest" -czf "$release_dir/runtime-data.tar.gz" data
fi
if [[ -e "$dest/.git" ]]; then
  tar -C "$dest" -czf "$release_dir/git-metadata.tar.gz" .git
fi

{
  echo "source_commit=$commit"
  echo "source_branch=$branch"
  echo "target=$dest"
  echo "created_utc=$(date -u +%FT%TZ)"
} > "$release_dir/manifest"

fingerprint() {
  local rel="$1"
  if [[ -e "$dest/$rel" ]]; then
    tar -C "$dest" --sort=name --mtime=@0 --owner=0 --group=0 \
      --numeric-owner -cf - "$rel" 2>/dev/null | sha256sum | awk '{print $1}'
  else
    echo absent
  fi
}
{
  # Runtime data is deliberately excluded from this equality check: avatars
  # and chat uploads may change legitimately while a release is in flight.
  # The rsync policy/fixture proves data is excluded and protected; fingerprint
  # only stable protected paths here.
  for rel in .git .venv venv; do
    printf '%s %s\n' "$rel" "$(fingerprint "$rel")"
  done
} > "$release_dir/preserved.before"

find "$release_dir" -maxdepth 1 -type f ! -name SHA256SUMS -print0 \
  | sort -z | xargs -0 -r sha256sum > "$release_dir/SHA256SUMS"
echo "$release_dir"
REMOTE

deploy_started=0
rollback_on_error() {
  local status="${1:-$?}"
  trap - ERR
  if [[ "$deploy_started" -eq 1 ]]; then
    deploy_started=0
    echo "deployment step failed; restoring pre-deploy code automatically" >&2
    if ! "$script_dir/rollback.sh" \
      --host "$host" --dest "$dest" --backup "$release_dir" \
      --service "$service" --health-url "$health_url" --apply --yes; then
      echo "CRITICAL: automatic rollback also failed; use $release_dir manually" >&2
    fi
  fi
  exit "$status"
}
trap rollback_on_error ERR

echo "applying reviewed plan"
deploy_started=1
rsync "${LAN_GAMES_RSYNC_ARGS[@]}" "$release_source/" "$host:$dest/"

echo "verifying stable protected paths were untouched by rsync"
ssh "$host" "bash -s -- '$dest' '$release_dir'" <<'REMOTE'
set -euo pipefail
dest="$1"
release_dir="$2"
fingerprint() {
  local rel="$1"
  if [[ -e "$dest/$rel" ]]; then
    tar -C "$dest" --sort=name --mtime=@0 --owner=0 --group=0 \
      --numeric-owner -cf - "$rel" 2>/dev/null | sha256sum | awk '{print $1}'
  else
    echo absent
  fi
}
{
  for rel in .git .venv venv; do
    printf '%s %s\n' "$rel" "$(fingerprint "$rel")"
  done
} > "$release_dir/preserved.after"
diff -u "$release_dir/preserved.before" "$release_dir/preserved.after"
REMOTE

should_restart=0
case "$restart_mode" in
  always) should_restart=1 ;;
  auto) [[ "$python_changed" -eq 1 ]] && should_restart=1 ;;
esac

health_ok=0
if [[ "$should_restart" -eq 1 ]]; then
  echo "restarting systemd user unit: $service"
  if ssh "$host" "systemctl --user restart '$service' && systemctl --user is-active --quiet '$service'"; then
    health_ok=1
  fi
else
  echo "static-only release: no service restart"
  health_ok=1
fi

if [[ "$health_ok" -eq 1 ]]; then
  echo "health check: $health_url"
  ssh "$host" "for i in \$(seq 1 20); do curl -fsS '$health_url' >/dev/null && exit 0; sleep 0.5; done; exit 1" \
    || health_ok=0
fi

if [[ "$health_ok" -ne 1 ]]; then
  echo "health check failed" >&2
  rollback_on_error 1
fi

deploy_started=0
trap - ERR

echo
echo "DEPLOYED $short_commit"
echo "rollback point: $host:$release_dir"
echo "manual rollback:"
echo "  ops/rollback.sh --host $host --dest $dest --backup $release_dir --apply"
