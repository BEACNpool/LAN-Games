"""Mechanical gate: no personal or machine-specific data in tracked files.

This repo is public. Personalization belongs in the gitignored data/venue.json
(see core/venue.py), never in a tracked file. This test greps everything git
actually tracks for the patterns that have leaked before, so a slip fails CI
instead of shipping.

The same check runs as a pre-push hook — install it with ops/install_hooks.sh.

Adding a legitimate hit? Prefer fixing the code. If a pattern genuinely belongs
(e.g. documenting the placeholder itself), add a narrow entry to ALLOW below
with a comment explaining why.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent

# (label, regex) — case-insensitive. Keep each pattern tight enough not to
# false-positive on ordinary game content (see ALLOW for known exceptions).
PATTERNS = [
    ("personal branding",
     r"\bfab[\s._-]?5\b"),
    ("private LAN address",
     r"\b10\.30\.0\.\d{1,3}\b"),
    ("internal hostname",
     r"\b[a-z0-9-]+\.internal\b"),
    ("owner home path",
     r"/home/ubuntudesktop\b"),
    ("private host alias",
     r"\b(midnight-ops|opsbox|midnight\.local)\b"),
    ("personal email",
     r"[\w.+-]+@(gmail|yahoo|outlook|hotmail|icloud)\.com"),
    ("wifi credential",
     r"WIFI:T:[^;]*;S:[^;$]"),          # a literal QR payload, not the builder
    ("hardcoded ssid/password",
     r"^\s*[\"']?(ssid|passphrase|psk)[\"']?\s*[:=]\s*[\"'][^\"'{$<]"),
    ("private workspace doc",
     r"\b(TOOLS|MEMORY|HEARTBEAT|SOUL|IDENTITY)\.md\b"),
]

# Paths (relative, prefix match) excluded wholesale.
SKIP_PREFIXES = (
    "data/",                  # gitignored anyway, but belt-and-braces
    ".venv/", "venv/", "node_modules/", "__pycache__/",
    "games/wordrush/data/words.txt",   # 80k-word dictionary: pure noise
)

SKIP_SUFFIXES = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg",
                 ".woff", ".woff2", ".ttf", ".mp3", ".mp4", ".webm", ".pyc")

# Known-good exceptions: (path, label) pairs that are allowed to match.
ALLOW = {
    # venue.example.json must show the wifi keys to document them; the values are
    # obvious placeholders. Only this one label is exempted for that file —
    # "personal branding" stays enforced there, see the note below.
    ("venue.example.json", "hardcoded ssid/password"),
    # NOTE: venue.example.json is otherwise NOT exempted. The example config
    # must use a fictional venue ("SMITH FAMILY ARCADE"), never the real one —
    # otherwise the personalization ships as the documented sample, which is the
    # exact leak this whole mechanism exists to prevent.
    #
    # This test file necessarily contains the patterns it searches for.
    ("tests/test_no_private_data.py", "personal branding"),
    ("tests/test_no_private_data.py", "private LAN address"),
    ("tests/test_no_private_data.py", "internal hostname"),
    ("tests/test_no_private_data.py", "owner home path"),
    ("tests/test_no_private_data.py", "private host alias"),
    ("tests/test_no_private_data.py", "personal email"),
    ("tests/test_no_private_data.py", "wifi credential"),
    ("tests/test_no_private_data.py", "hardcoded ssid/password"),
    ("tests/test_no_private_data.py", "private workspace doc"),
}


def tracked_files() -> list[str]:
    out = subprocess.run(
        ["git", "-C", str(REPO), "ls-files"],
        capture_output=True, text=True, check=True).stdout
    files = []
    for line in out.splitlines():
        if not line or line.startswith(SKIP_PREFIXES) or line.endswith(SKIP_SUFFIXES):
            continue
        files.append(line)
    return files


def scan() -> list[str]:
    """Return a list of human-readable violations."""
    compiled = [(label, re.compile(rx, re.IGNORECASE | re.MULTILINE))
                for label, rx in PATTERNS]
    problems = []
    for rel in tracked_files():
        path = REPO / rel
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, FileNotFoundError, IsADirectoryError):
            continue
        for label, rx in compiled:
            if (rel, label) in ALLOW:
                continue
            for m in rx.finditer(text):
                line_no = text.count("\n", 0, m.start()) + 1
                snippet = text.splitlines()[line_no - 1].strip()[:110]
                problems.append(f"{rel}:{line_no}  [{label}]  {snippet}")
    return problems


def test_no_private_data_in_tracked_files():
    problems = scan()
    assert not problems, (
        "Personal/machine-specific data found in tracked files.\n"
        "Move it to the gitignored data/venue.json (see core/venue.py), or add a\n"
        "justified exception to ALLOW in this file.\n\n" + "\n".join(problems))


def test_venue_json_is_not_tracked():
    """The one file that must never be committed."""
    out = subprocess.run(
        ["git", "-C", str(REPO), "ls-files", "data/venue.json"],
        capture_output=True, text=True, check=True).stdout.strip()
    assert not out, (
        "data/venue.json is TRACKED — it holds your Wi-Fi password.\n"
        "Run: git rm --cached data/venue.json")


if __name__ == "__main__":   # allow use as a standalone pre-push check
    found = scan()
    if found:
        print("BLOCKED — personal data in tracked files:\n")
        print("\n".join(found))
        raise SystemExit(1)
    print("clean: no personal data in tracked files")
