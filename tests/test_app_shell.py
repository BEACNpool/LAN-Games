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


def venue_payload() -> dict:
    response = asyncio.run(server.api_venue())
    assert response.media_type == "application/json"
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
            "wordclash": "famfeud",      # cannot shadow a mounted external app
            "retired-game": "missing",   # target must exist
            "../escape": "famfeud",      # route text must be a slug
        },
    }), encoding="utf-8")
    monkeypatch.setattr(venue, "VENUE_FILE", config)
    assert venue.route_aliases(
        {"famfeud", "poker", "wordclash"}, {"famfeud", "poker"}) == {
        "old-family-feud": "famfeud",
    }


def test_client_venue_payload_excludes_server_only_config(tmp_path, monkeypatch):
    config = tmp_path / "venue.json"
    config.write_text(json.dumps({
        "brand": {
            "name": "NORTH STAR ARCADE",
            "presents": "NORTH STAR ARCADE PRESENTS",
            "titles": {"famfeud": "NORTH STAR FEUD"},
        },
        "route_aliases": {"old-family-feud": "famfeud"},
        "wifi": {
            "ssid": "guest-wifi",
            "password": "changeme",
            "security": "WPA",
            "hidden": True,
            "admin_note": "server only",
        },
        "future_server_setting": "private",
    }), encoding="utf-8")
    monkeypatch.setattr(venue, "VENUE_FILE", config)
    payload = venue_payload()
    assert payload == {
        "brand": {
            "name": "NORTH STAR ARCADE",
            "presents": "NORTH STAR ARCADE PRESENTS",
        },
        "wifi": {
            "ssid": "guest-wifi",
            "password": "changeme",
            "security": "WPA",
            "hidden": True,
        },
    }
