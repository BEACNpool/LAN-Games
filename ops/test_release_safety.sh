#!/usr/bin/env bash
# Proves that the release rsync policy updates code while preserving state.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=ops/release_lib.sh
source "$script_dir/release_lib.sh"

fixture="$(mktemp -d -t lan-games-release-test.XXXXXXXX)"
cleanup() {
  [[ "$fixture" == /tmp/lan-games-release-test.* ]] && rm -rf -- "$fixture"
}
trap cleanup EXIT

if (lan_games_validate_path "/" >/dev/null 2>&1); then
  lan_games_die "broad path validation failed"
fi
if (lan_games_validate_path "/srv/gamehub/../other" >/dev/null 2>&1); then
  lan_games_die "path traversal validation failed"
fi
lan_games_validate_path "/srv/lan-games"

source_tree="$fixture/source"
target_tree="$fixture/target"
mkdir -p \
  "$source_tree/web" "$source_tree/data/avatars" \
  "$source_tree/core/__pycache__" \
  "$target_tree/web" "$target_tree/data/avatars" \
  "$target_tree/data/chatmedia" "$target_tree/.git" \
  "$target_tree/.venv/bin" "$target_tree/core/__pycache__" \
  "$target_tree/.pytest_cache" "$target_tree/.ruff_cache"

printf 'new code\n' > "$source_tree/web/app.js"
printf 'source must not win\n' > "$source_tree/data/avatars/player.png"
printf 'source must not win\n' > "$source_tree/.git"
printf 'source must not win\n' > "$source_tree/.venv"
printf 'source must not win\n' > "$source_tree/core/__pycache__/module.pyc"

printf 'old code\n' > "$target_tree/web/app.js"
printf 'remove me\n' > "$target_tree/web/obsolete.js"
printf 'avatar\n' > "$target_tree/data/avatars/player.png"
printf 'chat media\n' > "$target_tree/data/chatmedia/photo.jpg"
printf '{"brand":{"name":"PRIVATE"}}\n' > "$target_tree/data/venue.json"
printf 'git metadata\n' > "$target_tree/.git/HEAD"
printf 'virtualenv\n' > "$target_tree/.venv/bin/python"
printf 'bytecode cache\n' > "$target_tree/core/__pycache__/module.pyc"
printf 'pytest cache\n' > "$target_tree/.pytest_cache/state"
printf 'ruff cache\n' > "$target_tree/.ruff_cache/state"
printf 'runtime log\n' > "$target_tree/gamehub.log"

before="$(find \
  "$target_tree/data" "$target_tree/.git" "$target_tree/.venv" \
  "$target_tree/core/__pycache__" "$target_tree/.pytest_cache" \
  "$target_tree/.ruff_cache" "$target_tree/gamehub.log" -type f -print0 \
  | sort -z | xargs -0 sha256sum | sha256sum)"

lan_games_rsync_args
rsync "${LAN_GAMES_RSYNC_ARGS[@]}" "$source_tree/" "$target_tree/" >/dev/null

after="$(find \
  "$target_tree/data" "$target_tree/.git" "$target_tree/.venv" \
  "$target_tree/core/__pycache__" "$target_tree/.pytest_cache" \
  "$target_tree/.ruff_cache" "$target_tree/gamehub.log" -type f -print0 \
  | sort -z | xargs -0 sha256sum | sha256sum)"

[[ "$before" == "$after" ]] || lan_games_die "protected fixture state changed"
grep -qx 'new code' "$target_tree/web/app.js"
[[ ! -e "$target_tree/web/obsolete.js" ]] \
  || lan_games_die "obsolete code was not deleted"

echo "release safety fixture passed"
