"""Install-shell metadata stays generic in public and adopts venue branding."""

from __future__ import annotations

import asyncio
import json

import server
from core import venue


def manifest_payload() -> dict:
    response = asyncio.run(server.app_manifest())
    assert response.media_type == "application/manifest+json"
    return json.loads(response.body)


def test_manifest_uses_public_default_without_venue_file(tmp_path, monkeypatch):
    monkeypatch.setattr(venue, "VENUE_FILE", tmp_path / "missing.json")
    payload = manifest_payload()
    assert payload["name"] == "LAN GAMES"
    assert payload["short_name"] == "LAN GAMES"
    assert payload["scope"] == "/"
    assert payload["display"] == "standalone"


def test_manifest_uses_private_venue_wordmark(tmp_path, monkeypatch):
    config = tmp_path / "venue.json"
    config.write_text(json.dumps({"brand": {"name": "NORTH STAR ARCADE"}}),
                      encoding="utf-8")
    monkeypatch.setattr(venue, "VENUE_FILE", config)
    payload = manifest_payload()
    assert payload["name"] == "NORTH STAR ARCADE"
    assert payload["short_name"] == "NORTH STAR ARCADE"


def test_app_shell_routes_are_registered():
    paths = {getattr(route, "path", "") for route in server.app.routes}
    assert {"/app.webmanifest", "/sw.js", "/offline"} <= paths


def test_route_aliases_only_accept_safe_existing_targets(tmp_path, monkeypatch):
    config = tmp_path / "venue.json"
    config.write_text(json.dumps({
        "route_aliases": {
            "old-family-feud": "famfeud",
            "poker": "famfeud",          # cannot shadow a real route
            "retired-game": "missing",   # target must exist
            "../escape": "famfeud",      # route text must be a slug
        },
    }), encoding="utf-8")
    monkeypatch.setattr(venue, "VENUE_FILE", config)
    assert venue.route_aliases({"famfeud", "poker"}) == {
        "old-family-feud": "famfeud",
    }
