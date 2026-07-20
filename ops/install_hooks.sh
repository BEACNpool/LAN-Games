#!/usr/bin/env bash
# Install the pre-push guard that blocks personal data from reaching the public
# repo. Run once per clone:  ./ops/install_hooks.sh
#
# Git hooks live in .git/hooks, which is NOT tracked — that's why this installer
# is committed instead of the hook itself.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
hook_dir="$(git rev-parse --git-path hooks)"
hook="$hook_dir/pre-push"

mkdir -p "$hook_dir"

if [[ -e "$hook" ]] && ! grep -q "gamehub-privacy-guard" "$hook" 2>/dev/null; then
  cp "$hook" "$hook.bak-$(date +%F-%H%M%S)"
  echo "note: existing pre-push hook backed up alongside it"
fi

cat > "$hook" <<'HOOK'
#!/usr/bin/env bash
# gamehub-privacy-guard — refuse to push personal data to a public repo.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"

py="$root/.venv/bin/python"
[[ -x "$py" ]] || py="$(command -v python3 || command -v python)"

if [[ -z "${py:-}" ]]; then
  echo "pre-push: no python found; skipping privacy guard" >&2
  exit 0
fi

if ! "$py" "$root/tests/test_no_private_data.py"; then
  cat >&2 <<'MSG'

PUSH BLOCKED — personal data found in tracked files.

This repo is public. Personalization belongs in data/venue.json (gitignored).
Fix the lines above, or if a hit is legitimate add it to ALLOW in
tests/test_no_private_data.py with a comment.

To override for one push (you had better be sure):
    git push --no-verify

MSG
  exit 1
fi
HOOK

chmod +x "$hook"
echo "installed: $hook"
echo "verifying against the current tree..."
"${repo_root}/.venv/bin/python" "${repo_root}/tests/test_no_private_data.py" 2>/dev/null \
  || python3 "${repo_root}/tests/test_no_private_data.py"
