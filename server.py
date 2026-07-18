"""GAMEHUB server — the hub page plus every game in games/registry.py.

Per game <slug>:
    /games/<slug>/ws     WebSocket (core.net.GameBinding)
    /games/<slug>/       the game's static client
Shared:
    /                    hub page (web/hub.html)
    /api/games           registry for the hub cards
    /shared/*            shared css/js (design tokens, identity, qr)
    /health
"""

from __future__ import annotations

import logging
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from core import avatars, chatmedia
from core.chat import ChatHub
from core.net import GameBinding
from games.registry import REGISTRY, EXTERNAL, COMING_SOON
from games.wordclash.app import wc_app

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("gamehub")

WEB = Path(__file__).parent / "web"
PORT = 8096

app = FastAPI(title="GAMEHUB")
bindings: dict[str, GameBinding] = {}

for entry in REGISTRY:
    slug = entry["slug"]
    binding = GameBinding(slug, entry["session"]())
    bindings[slug] = binding

    def _make_ws(b: GameBinding):
        async def ws_endpoint(ws: WebSocket):
            await b.endpoint(ws)
        return ws_endpoint

    app.add_api_websocket_route("/games/%s/ws" % slug, _make_ws(binding))


@app.get("/api/games")
async def api_games():
    return JSONResponse({
        "games": [{
            "slug": e["slug"], "title": e["title"], "icon": e["icon"],
            "blurb": e["blurb"], "players": e["players"],
            "category": e.get("category"), "accent": e.get("accent"),
            "art": e.get("art"),
            "tagline": e.get("tagline"), "tv": e.get("tv", False),
            "min_p": e.get("min_p"), "max_p": e.get("max_p"),
            "solo": e.get("solo", False),
            "hidden": e.get("hidden", False),
            "live": {
                "players": len(bindings[e["slug"]].session.humans()),
                "phase": bindings[e["slug"]].session.phase,
            },
        } for e in REGISTRY],
        "external": EXTERNAL,
        "coming_soon": COMING_SOON,
    })


def _valid_token(token):
    return (isinstance(token, str) and 8 <= len(token) <= 64
            and not token.startswith("bot:")
            and token.replace("-", "").replace("_", "").isalnum())


@app.post("/api/avatar")
async def upload_avatar(request: Request):
    token = request.headers.get("x-wc-token", "")
    if not _valid_token(token):
        return JSONResponse({"error": "bad token"}, status_code=400)
    if int(request.headers.get("content-length") or 0) > avatars.MAX_BYTES:
        return JSONResponse({"error": "image too large (8MB max)"},
                            status_code=413)
    body = await request.body()
    try:
        url = avatars.save(token, body)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=415)
    return JSONResponse({"url": url})


@app.delete("/api/avatar")
async def delete_avatar(request: Request):
    token = request.headers.get("x-wc-token", "")
    if not _valid_token(token):
        return JSONResponse({"error": "bad token"}, status_code=400)
    avatars.remove(token)
    return JSONResponse({"ok": True})


chat = ChatHub()


@app.websocket("/chat/ws")
async def chat_ws(ws: WebSocket):
    await chat.endpoint(ws)


@app.post("/api/chatmedia")
async def upload_chatmedia(request: Request):
    token = request.headers.get("x-wc-token", "")
    if not _valid_token(token):
        return JSONResponse({"error": "bad token"}, status_code=400)
    if int(request.headers.get("content-length") or 0) > chatmedia.MAX_BYTES:
        return JSONResponse({"error": "image too large (16MB max)"},
                            status_code=413)
    body = await request.body()
    try:
        return JSONResponse(chatmedia.save(body))
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=415)


@app.get("/api/charades/decks")
async def charades_decks():
    from games.charades.decks import deck_list
    return JSONResponse({"decks": deck_list()})


@app.get("/health")
async def health():
    return JSONResponse({"ok": True, "games": {
        s: {"phase": b.session.phase, "players": len(b.session.players)}
        for s, b in bindings.items()}})


@app.get("/")
async def hub():
    return FileResponse(WEB / "hub.html", headers={"Cache-Control": "no-cache"})


@app.middleware("http")
async def cache_headers(request, call_next):
    resp = await call_next(request)
    p = request.url.path
    if "/fonts/" in p:
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    elif p.startswith("/chatmedia/"):
        # content-addressed filenames -> safe to cache hard
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    elif p.startswith("/avatars/"):
        # URLs carry ?v=<mtime>, so long caching is safe
        resp.headers["Cache-Control"] = "public, max-age=86400"
    else:
        resp.headers["Cache-Control"] = "no-cache"
    return resp


# WORDCLASH runs as a mounted sub-app (its own Room engine + WS), sharing this
# process, venv, origin, and — via core.avatars — the same photo store.
app.mount("/games/wordclash", wc_app)

# static mounts LAST so /api, /health, and the ws routes win
for entry in REGISTRY:
    app.mount("/games/%s" % entry["slug"],
              StaticFiles(directory=entry["web"], html=True),
              name="game-%s" % entry["slug"])
app.mount("/shared", StaticFiles(directory=WEB), name="shared")
avatars.AVATAR_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/avatars", StaticFiles(directory=avatars.AVATAR_DIR), name="avatars")
chatmedia.CHAT_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/chatmedia", StaticFiles(directory=chatmedia.CHAT_DIR), name="chatmedia")


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT)
