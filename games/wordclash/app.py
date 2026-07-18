"""WORDCLASH as a gamehub sub-application, mounted at /games/wordclash.

This is the original WORDCLASH server (its Room engine + WebSocket/timer
plumbing) brought into the gamehub process so it shares the same venv, the
same origin (LAN Games), and — crucially — the same identity + photo store
as every other game. Profiles set on the hub carry in automatically:
  * identity (wc-* localStorage) is shared because this is the same origin
  * photos are shared because this uses gamehub's core.avatars store; pfp
    URLs (/avatars/…) and uploads (/api/avatar) resolve to gamehub's ROOT
    shared endpoints, not a private copy.

Mounted by server.py: app.mount("/games/wordclash", wc_app). All routes here
are relative to that prefix (WS at /games/wordclash/ws, TV at /games/wordclash/tv).
"""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
import time
from collections import deque
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from core import avatars                       # shared photo store (256px)
from games.wordclash.engine import Room
from games.wordclash.words import load_words

log = logging.getLogger("gamehub.wordclash")

WEB = Path(__file__).parent / "web"

wc_app = FastAPI(title="WORDCLASH")
_answers, _allowed = load_words()
room = Room(_answers, _allowed)
lock = asyncio.Lock()
player_sockets: dict[str, set[WebSocket]] = {}
tv_sockets: set[WebSocket] = set()
timer_task: asyncio.Task | None = None

RATE_N, RATE_WINDOW = 10, 2.0


async def send_json(ws: WebSocket, obj) -> None:
    try:
        await ws.send_text(json.dumps(obj))
    except Exception:
        pass


async def push_all(fxs) -> None:
    for fx in fxs or []:
        fx = dict(fx)
        to = fx.pop("to", None)
        msg = {"type": "fx", **fx}
        if to is None:
            for socks in list(player_sockets.values()):
                for ws in list(socks):
                    await send_json(ws, msg)
            for ws in list(tv_sockets):
                await send_json(ws, msg)
        else:
            for ws in list(player_sockets.get(to, ())):
                await send_json(ws, msg)
    for token, socks in list(player_sockets.items()):
        st = room.state_for(token)
        for ws in list(socks):
            await send_json(ws, st)
    if tv_sockets:
        st = room.state_for(None)
        for ws in list(tv_sockets):
            await send_json(ws, st)
    _reschedule()


def _reschedule() -> None:
    global timer_task
    cur = None
    try:
        cur = asyncio.current_task()
    except RuntimeError:
        pass
    if timer_task is not None and timer_task is not cur and not timer_task.done():
        timer_task.cancel()
    timer_task = None
    if room.deadline is not None:
        timer_task = asyncio.create_task(_fire(room.gen, room.deadline))


async def _fire(gen: int, deadline: float) -> None:
    global timer_task
    try:
        await asyncio.sleep(max(0.0, deadline - time.time()))
    except asyncio.CancelledError:
        return
    async with lock:
        if timer_task is asyncio.current_task():
            timer_task = None
        if room.gen != gen:
            return
        fxs = room.tick(gen)
        await push_all(fxs)


def dispatch(token: str, msg: dict):
    t = msg.get("t")
    if t == "ready":
        return room.set_ready(token, bool(msg.get("ready", True)))
    if t == "settings":
        rounds = msg.get("rounds")
        secs = msg.get("turn_seconds")
        return room.set_settings(
            token, msg.get("mode"),
            rounds if isinstance(rounds, int) and not isinstance(rounds, bool) else None,
            secs if isinstance(secs, int) and not isinstance(secs, bool) else None)
    if t == "start":
        return room.start(token)
    if t == "guess":
        return room.guess(token, msg.get("word", ""))
    if t == "sabotage":
        return room.sabotage(token, msg.get("kind"), msg.get("letter"))
    if t == "profile":
        fx = room.set_profile(token, msg.get("name"), msg.get("avatar"))
        p = room.players.get(token)
        if p is not None:
            p.pfp = avatars.url_for(token)       # shared store
        return fx
    if t == "again":
        if room.phase == "podium":
            return room.to_lobby()
        return []
    return []


@wc_app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    token: str | None = None
    is_tv = False
    try:
        raw = await asyncio.wait_for(ws.receive_text(), timeout=15)
        hello = json.loads(raw)
        assert isinstance(hello, dict) and hello.get("t") == "hello"
    except Exception:
        await ws.close()
        return

    if hello.get("tv"):
        is_tv = True
        tv_sockets.add(ws)
        async with lock:
            await send_json(ws, {"type": "welcome", "tv": True})
            await send_json(ws, room.state_for(None))
    else:
        token = hello.get("token")
        if not (isinstance(token, str) and 8 <= len(token) <= 64
                and token.replace("-", "").replace("_", "").isalnum()):
            token = secrets.token_urlsafe(16)
        async with lock:
            if len(player_sockets.get(token, ())) >= 4:
                await ws.close()
                return
            player, fxs = room.join(token, hello.get("name"), hello.get("avatar"))
            if player is None:
                for f in fxs:
                    await send_json(ws, {"type": "fx", **{k: v for k, v in f.items() if k != "to"}})
                await ws.close()
                return
            player.pfp = avatars.url_for(token)
            player_sockets.setdefault(token, set()).add(ws)
            await send_json(ws, {"type": "welcome", "token": token, "pid": player.pid})
            await push_all(fxs)

    stamps: deque[float] = deque()
    try:
        while True:
            raw = await ws.receive_text()
            if len(raw) > 2048:
                continue
            now = time.time()
            stamps.append(now)
            while stamps and now - stamps[0] > RATE_WINDOW:
                stamps.popleft()
            if len(stamps) > RATE_N:
                continue
            try:
                msg = json.loads(raw)
                assert isinstance(msg, dict)
            except Exception:
                continue
            if msg.get("t") == "ping":
                await send_json(ws, {"type": "pong", "now": int(time.time() * 1000)})
                continue
            if is_tv or token is None:
                continue
            async with lock:
                try:
                    fxs = dispatch(token, msg)
                    await push_all(fxs)
                except Exception:
                    log.exception("[wordclash] dispatch error")
                    _reschedule()
    except WebSocketDisconnect:
        pass
    except Exception:
        log.exception("[wordclash] ws loop error")
    finally:
        if is_tv:
            tv_sockets.discard(ws)
        elif token is not None:
            async with lock:
                socks = player_sockets.get(token)
                if socks is not None:
                    socks.discard(ws)
                    if not socks:
                        del player_sockets[token]
                        fxs = room.leave(token)
                        await push_all(fxs)


@wc_app.get("/health")
async def health():
    return JSONResponse({"ok": True, "phase": room.phase,
                         "players": len(room.players), "words": len(_answers)})


@wc_app.get("/tv")
async def tv_page():
    return FileResponse(WEB / "tv.html", headers={"Cache-Control": "no-cache"})


@wc_app.middleware("http")
async def cache_headers(request, call_next):
    resp = await call_next(request)
    p = request.url.path
    if "/fonts/" in p:
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    else:
        resp.headers["Cache-Control"] = "no-cache"
    return resp


# static client LAST so /ws, /tv, /health win. Photos/uploads are NOT served
# here — they use gamehub's ROOT /avatars + /api/avatar (the shared store).
wc_app.mount("/", StaticFiles(directory=WEB, html=True), name="wordclash-web")
