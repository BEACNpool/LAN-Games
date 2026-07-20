"""Lobby chat for the LAN Games hub — a tiny in-memory WebSocket channel.

Everyone on the hub shares one room. Text (with emoji) + optional meme/GIF
(a /chatmedia URL uploaded via /api/chatmedia). History is a rolling buffer so
a phone that opens the hub sees the last few messages. No accounts, no
persistence across restart — it's a lobby, not a record.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from collections import deque

from fastapi import WebSocket, WebSocketDisconnect

from core import avatars, chatmedia
from core.session import clean_name

HISTORY = 60
TEXT_MAX = 400
RATE_N, RATE_WINDOW = 6, 4.0        # messages per rolling window per socket
TYPING_GAP = 1.5                    # min seconds between a socket's typing pings
REACTIONS = ("👍", "❤️", "😂", "🔥", "🎉", "😮")   # the only reactions accepted


def _valid_token(token) -> bool:
    return (isinstance(token, str) and 8 <= len(token) <= 64
            and not token.startswith("bot:")
            and token.replace("-", "").replace("_", "").isalnum())


def _uid(token: str) -> str:
    return "u" + hashlib.sha256(("chat:" + token).encode()).hexdigest()[:10]


class ChatHub:
    def __init__(self):
        self.lock = asyncio.Lock()
        self.sockets: dict[WebSocket, dict] = {}   # ws -> {token, uid}
        self.history: deque = deque(maxlen=HISTORY)
        self.reactions: dict[int, dict] = {}       # msg id -> {emoji: set(uid)}
        self._id = 0

    def _online(self) -> int:
        return len({m["token"] for m in self.sockets.values()})

    def _with_reactions(self, m: dict) -> dict:
        bag = self.reactions.get(m["id"])
        if not bag:
            return m
        return {**m, "reactions": {e: sorted(u) for e, u in bag.items() if u}}

    async def _send(self, ws, obj):
        try:
            await ws.send_text(json.dumps(obj))
        except Exception:
            pass

    async def _broadcast(self, obj):
        for ws in list(self.sockets):
            await self._send(ws, obj)

    async def _presence(self):
        await self._broadcast({"type": "presence", "online": self._online()})

    async def endpoint(self, ws: WebSocket):
        await ws.accept()
        try:
            raw = await asyncio.wait_for(ws.receive_text(), timeout=15)
            hello = json.loads(raw)
            assert isinstance(hello, dict) and hello.get("t") == "hello"
        except Exception:
            await ws.close()
            return

        token = hello.get("token")
        if not _valid_token(token):
            await ws.close()
            return
        uid = _uid(token)
        sender_name = clean_name(hello.get("name")) if hello.get("name") else "PLAYER"
        async with self.lock:
            self.sockets[ws] = {"token": token, "uid": uid}
            await self._send(ws, {"type": "welcome", "you": uid})
            await self._send(ws, {"type": "history",
                                  "messages": [self._with_reactions(m)
                                               for m in self.history]})
            await self._presence()

        stamps: deque = deque()
        last_typing = 0.0
        try:
            while True:
                raw = await ws.receive_text()
                if len(raw) > 4096:
                    continue
                try:
                    msg = json.loads(raw)
                    assert isinstance(msg, dict)
                except Exception:
                    continue
                verb = msg.get("t")
                if verb == "ping":
                    await self._send(ws, {"type": "pong",
                                          "now": int(time.time() * 1000)})
                    continue
                if verb == "typing":
                    now = time.time()
                    if now - last_typing < TYPING_GAP:
                        continue
                    last_typing = now
                    for other in list(self.sockets):
                        if other is not ws:
                            await self._send(other, {"type": "typing", "by": uid,
                                                     "name": sender_name})
                    continue
                if verb == "clear":
                    async with self.lock:
                        self.history.clear()
                        self.reactions.clear()
                        await self._broadcast({"type": "cleared", "name": sender_name})
                    continue
                if verb == "react":
                    mid, emoji = msg.get("id"), msg.get("emoji")
                    if (not isinstance(mid, int) or isinstance(mid, bool)
                            or emoji not in REACTIONS):
                        continue
                    async with self.lock:
                        if not any(m["id"] == mid for m in self.history):
                            continue
                        bag = self.reactions.setdefault(mid, {})
                        users = bag.setdefault(emoji, set())
                        if uid in users:
                            users.discard(uid)
                        else:
                            users.add(uid)
                        if not users:
                            bag.pop(emoji, None)
                        await self._broadcast({
                            "type": "react", "id": mid,
                            "reactions": {e: sorted(u) for e, u in bag.items() if u}})
                    continue
                if verb != "msg":
                    continue
                now = time.time()
                stamps.append(now)
                while stamps and now - stamps[0] > RATE_WINDOW:
                    stamps.popleft()
                if len(stamps) > RATE_N:
                    continue
                async with self.lock:
                    out = self._build(token, uid, hello, msg)
                    if out is None:
                        continue
                    self.history.append(out)
                    if self.reactions:      # drop reactions for rolled-off messages
                        live = {m["id"] for m in self.history}
                        for dead in [k for k in self.reactions if k not in live]:
                            self.reactions.pop(dead, None)
                    await self._broadcast({"type": "msg", **out})
        except WebSocketDisconnect:
            pass
        except Exception:
            pass
        finally:
            async with self.lock:
                self.sockets.pop(ws, None)
                await self._presence()

    def _build(self, token, uid, hello, msg):
        text = msg.get("text", "")
        if not isinstance(text, str):
            text = ""
        text = text.replace("\x00", "").strip()[:TEXT_MAX]
        img = msg.get("img")
        if img is not None and not chatmedia.valid_url(img):
            img = None
        if not text and not img:
            return None
        self._id += 1
        name = clean_name(hello.get("name")) if hello.get("name") else "PLAYER"
        avatar = hello.get("avatar") if isinstance(hello.get("avatar"), str) else "🙂"
        return {
            "id": self._id,
            "by": uid,
            "name": name,
            "avatar": avatar,
            "pfp": avatars.url_for(token),
            "text": text,
            "img": img,
            "iw": msg.get("iw") if img else None,
            "ih": msg.get("ih") if img else None,
            "ts": int(time.time() * 1000),
        }
