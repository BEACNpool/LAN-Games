"""core.net — sockets, timers, and bot scheduling for a GameSession.

One GameBinding per registered game. It owns:
  * the WebSocket endpoint for that game (mounted at /games/<slug>/ws)
  * an asyncio.Lock — every session mutation happens under it
  * personalized state pushes after every mutation (state_for per token)
  * exactly one pending deadline task, kept in sync with (deadline, gen)
  * bot scheduling: after every push, if session.next_bot_action() says a bot
    is due, a task runs it after the given delay (dropped if session.seq moved)

Games never touch sockets; this file never touches game rules.
"""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
import time
from collections import deque

from fastapi import WebSocket, WebSocketDisconnect

from core import avatars

log = logging.getLogger("gamehub.net")

RATE_N, RATE_WINDOW = 20, 2.0   # generous: stepper-mashing kids must not
                                # get their next real action dropped
MAX_SOCKETS_PER_TOKEN = 4

# Lobby verbs handled here for every game; anything else goes to game_action.
LOBBY_VERBS = ("ready", "start", "settings", "profile", "leave_table")


class GameBinding:
    def __init__(self, slug, session):
        self.slug = slug
        self.session = session
        self.lock = asyncio.Lock()
        self.player_sockets: dict[str, set[WebSocket]] = {}
        self.watch_sockets: set[WebSocket] = set()
        self._timer_task: asyncio.Task | None = None
        self._bot_task: asyncio.Task | None = None

    # ---- push ----

    async def _send(self, ws, obj):
        try:
            await ws.send_text(json.dumps(obj))
        except Exception:
            pass  # dead socket; its receive loop will reap it

    async def push_all(self, fxs):
        for fx in fxs or []:
            fx = dict(fx)
            to = fx.pop("to", None)
            msg = {"type": "fx", **fx}
            if to is None:
                for socks in list(self.player_sockets.values()):
                    for ws in list(socks):
                        await self._send(ws, msg)
                for ws in list(self.watch_sockets):
                    await self._send(ws, msg)
            else:
                for ws in list(self.player_sockets.get(to, ())):
                    await self._send(ws, msg)
        for token, socks in list(self.player_sockets.items()):
            st = self.session.state_for(token)
            for ws in list(socks):
                await self._send(ws, st)
        if self.watch_sockets:
            st = self.session.state_for(None)
            for ws in list(self.watch_sockets):
                await self._send(ws, st)
        self._sync_timer()
        self._sync_bot()

    # ---- deadline timer ----

    def _sync_timer(self):
        cur = None
        try:
            cur = asyncio.current_task()
        except RuntimeError:
            pass
        if self._timer_task is not None and self._timer_task is not cur \
                and not self._timer_task.done():
            self._timer_task.cancel()
        self._timer_task = None
        if self.session.deadline is not None:
            self._timer_task = asyncio.create_task(
                self._fire(self.session.gen, self.session.deadline))

    async def _fire(self, gen, deadline):
        try:
            await asyncio.sleep(max(0.0, deadline - time.time()))
        except asyncio.CancelledError:
            return
        async with self.lock:
            if self._timer_task is asyncio.current_task():
                self._timer_task = None
            if self.session.gen != gen:
                return
            try:
                fxs = self.session.tick(gen)
                await self.push_all(fxs)
            except Exception:
                log.exception("[%s] tick error", self.slug)
                if self.session.gen == gen:
                    # tick died before advancing the generation — re-arming
                    # the same expired deadline would hot-loop the exception.
                    # gen++ kills the failing generation; retry in 2s.
                    self.session._bump(time.time() + 2.0)
                self._sync_timer()
                self._sync_bot()

    # ---- bots ----

    def _sync_bot(self):
        cur = None
        try:
            cur = asyncio.current_task()
        except RuntimeError:
            pass
        if self._bot_task is not None and self._bot_task is not cur \
                and not self._bot_task.done():
            self._bot_task.cancel()
        self._bot_task = None
        due = self.session.next_bot_action()
        if due is not None:
            delay, bot_token = due
            self._bot_task = asyncio.create_task(
                self._run_bot(self.session.seq, delay, bot_token))

    async def _run_bot(self, seq, delay, bot_token):
        try:
            await asyncio.sleep(delay)
        except asyncio.CancelledError:
            return
        async with self.lock:
            if self._bot_task is asyncio.current_task():
                self._bot_task = None
            if self.session.seq != seq:
                return  # something happened meanwhile; next push reschedules
            try:
                fxs = self.session.run_bot(bot_token)
                await self.push_all(fxs)
            except Exception:
                log.exception("[%s] bot error", self.slug)
                self._sync_timer()
                self._sync_bot()

    # ---- websocket endpoint ----

    async def endpoint(self, ws: WebSocket):
        await ws.accept()
        token = None
        watching = False
        try:
            raw = await asyncio.wait_for(ws.receive_text(), timeout=15)
            hello = json.loads(raw)
            assert isinstance(hello, dict) and hello.get("t") == "hello"
        except Exception:
            await ws.close()
            return

        if hello.get("watch"):
            watching = True
            self.watch_sockets.add(ws)
            async with self.lock:
                await self._send(ws, {"type": "welcome", "watch": True})
                await self._send(ws, self.session.state_for(None))
        else:
            token = hello.get("token")
            if not (isinstance(token, str) and 8 <= len(token) <= 64
                    and not token.startswith("bot:")
                    and token.replace("-", "").replace("_", "").isalnum()):
                token = secrets.token_urlsafe(16)
            async with self.lock:
                if len(self.player_sockets.get(token, ())) >= MAX_SOCKETS_PER_TOKEN:
                    await ws.close()
                    return
                player, fxs = self.session.join(
                    token, hello.get("name"), hello.get("avatar"))
                if player is None:
                    for f in fxs:
                        await self._send(ws, {"type": "fx",
                                              **{k: v for k, v in f.items() if k != "to"}})
                    await ws.close()
                    return
                player.pfp = avatars.url_for(token)
                self.player_sockets.setdefault(token, set()).add(ws)
                await self._send(ws, {"type": "welcome", "token": token,
                                      "pid": player.pid})
                await self.push_all(fxs)

        stamps: deque[float] = deque()
        try:
            while True:
                raw = await ws.receive_text()
                if len(raw) > 4096:
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
                    await self._send(ws, {"type": "pong",
                                          "now": int(time.time() * 1000)})
                    continue
                if watching or token is None:
                    continue
                async with self.lock:
                    try:
                        fxs = self.dispatch(token, msg)
                        await self.push_all(fxs)
                    except Exception:
                        log.exception("[%s] dispatch error", self.slug)
                        self._sync_timer()
                        self._sync_bot()
        except WebSocketDisconnect:
            pass
        except Exception:
            log.exception("[%s] ws loop error", self.slug)
        finally:
            if watching:
                self.watch_sockets.discard(ws)
            elif token is not None:
                async with self.lock:
                    socks = self.player_sockets.get(token)
                    if socks is not None:
                        socks.discard(ws)
                        if not socks:
                            del self.player_sockets[token]
                            fxs = self.session.leave(token)
                            await self.push_all(fxs)

    def dispatch(self, token, msg):
        s = self.session
        t = msg.get("t")
        if t == "ready":
            return s.set_ready(token, bool(msg.get("ready", True)))
        if t == "start":
            return s.start(token)
        if t == "settings":
            return s.set_settings(token, msg.get("patch"))
        if t == "profile":
            fx = s.set_profile(token, msg.get("name"), msg.get("avatar"))
            p = s.players.get(token)
            if p is not None:
                p.pfp = avatars.url_for(token)   # re-check after uploads
            return fx
        if t == "again":
            return s.to_lobby() if s.phase == "game_end" else []
        return s.game_action(token, msg)
