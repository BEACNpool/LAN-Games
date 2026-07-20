"""Per-venue personalization — the ONE place your own branding/network lives.

THE RULE: nothing personal ever goes in a tracked file. Anything specific to
YOUR house — the name you call your game night, your guest Wi-Fi, the title you
give a game — belongs in `data/venue.json`, which is gitignored. This module
merges that file over the generic defaults below.

A fresh public clone has no venue.json, gets DEFAULTS, and works fine: it reads
as "LAN GAMES" and simply hides the Wi-Fi button. Your box reads venue.json and
shows your branding. Neither ever leaks into the other.

See venue.example.json for every knob, and ops/install_hooks.sh for the
pre-push hook that mechanically blocks personal strings from being committed.
"""

from __future__ import annotations

import json
from pathlib import Path

VENUE_FILE = Path(__file__).resolve().parent.parent / "data" / "venue.json"

# Generic, shippable defaults. These are what the public repo looks like.
DEFAULTS = {
    "brand": {
        # Short wordmark used in page titles: "BINGO · LAN GAMES"
        "name": "LAN GAMES",
        # Big-screen splash kicker: "LAN GAMES PRESENTS"
        "presents": "LAN GAMES PRESENTS",
        # Per-slug title overrides, e.g. {"famfeud": "SMITH FEUD"}
        "titles": {},
    },
    # No default Wi-Fi: absent means the hub hides the join-QR button.
    "wifi": None,
}


def _merge(base: dict, over: dict) -> dict:
    """Recursive dict merge; `over` wins. Non-dict values replace outright."""
    out = dict(base)
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def load() -> dict:
    """Return DEFAULTS deep-merged with data/venue.json (if it exists).

    Never raises: a missing or malformed venue.json falls back to DEFAULTS, so
    a bad edit degrades to the generic look instead of taking the hub down.
    """
    try:
        user = json.loads(VENUE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return json.loads(json.dumps(DEFAULTS))  # deep copy
    if not isinstance(user, dict):
        return json.loads(json.dumps(DEFAULTS))
    return _merge(DEFAULTS, user)


def brand() -> dict:
    """Just the brand block — safe to hand to any client."""
    return load().get("brand") or DEFAULTS["brand"]


def title_for(slug: str, default: str) -> str:
    """Display title for a game, letting venue.json override per slug.

    Keeps personalized names (e.g. "SMITH FEUD") out of games/registry.py, which
    is tracked and public.
    """
    return (brand().get("titles") or {}).get(slug, default)
