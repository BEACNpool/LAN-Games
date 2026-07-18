"""GameSession — the shared base every game in the hub builds on.

This is the reference shape for the whole library (Spades is the reference
implementation; future games copy it). It owns everything that is the same
for every game:

  * player identity: token (secret, per-device) -> Player with a public pid,
    name, avatar, color; reconnect-safe; bots are Players with is_bot=True
  * the lobby: ready flags, GO gating (min_players), 3-2-1 countdown
  * the phase envelope: "lobby" / "countdown" -> game phases -> "game_end"
  * timers: a single (deadline, gen) pair; the server fires tick(gen) at the
    deadline and stale generations are ignored
  * fx: transient events (toasts, sounds, animations) returned by every
    mutating method and routed by core.net to sockets

A concrete game subclasses GameSession and implements the game_* hooks.
All game logic is synchronous and IO-free — core.net owns sockets and sleep.

fx conventions (dicts): {"kind": ..., "to": token-or-None, ...}. to=None
broadcasts. Kinds shared by all games: toast, invalid, countdown, lobby,
game_start, game_end. Games add their own kinds freely.
"""

from __future__ import annotations

import random
import re
import time

COUNTDOWN_SECONDS = 3
GAME_END_SECONDS = 20          # results screen, then auto back to lobby

AVATARS = ["🦊", "🐸", "🦖", "🐙", "🦉", "🐯", "🐼", "🦄",
           "👾", "🤖", "🐲", "😈", "🦈", "🐝", "🦩", "🐢"]
COLORS = ["#22d3ee", "#a78bfa", "#f472b6", "#fbbf24",
          "#34d399", "#fb7185", "#60a5fa", "#c084fc"]
BOT_AVATARS = ["🎯", "🧮", "🛰", "⚙️"]

_NAME_ALLOWED = re.compile(r"[^A-Za-z0-9 \-'.!?]")


def clean_name(raw) -> str:
    if not isinstance(raw, str):
        return "PLAYER"
    name = _NAME_ALLOWED.sub("", raw).strip()
    name = re.sub(r"\s+", " ", name)[:14]
    return name or "PLAYER"


class Player:
    __slots__ = ("token", "pid", "name", "avatar", "color",
                 "ready", "connected", "joined_at", "is_bot", "pfp")

    def __init__(self, token, pid, name, avatar, color, is_bot=False):
        self.token = token          # secret; never serialized to other clients
        self.pid = pid              # public id, safe to broadcast
        self.name = name
        self.avatar = avatar
        self.color = color
        self.ready = is_bot         # bots are always ready
        self.connected = True       # bots never disconnect
        self.joined_at = time.time()
        self.is_bot = is_bot
        self.pfp = None             # custom picture URL (core.avatars), or None

    def public(self):
        return {"pid": self.pid, "name": self.name, "avatar": self.avatar,
                "color": self.color, "ready": self.ready,
                "connected": self.connected, "bot": self.is_bot,
                "pfp": self.pfp}


class GameSession:
    # ---- subclass knobs -------------------------------------------------
    MIN_PLAYERS = 2                # humans needed before GO appears
    MAX_HUMANS = 8                 # joinable humans (bots don't count)
    DEFAULT_SETTINGS: dict = {}    # shallow-copied per session

    def __init__(self, rng=None):
        self.rng = rng or random.Random()
        self.players: dict[str, Player] = {}   # token -> Player (humans+bots)
        self.phase = "lobby"
        self.settings = dict(self.DEFAULT_SETTINGS)
        self.participants: list[str] = []      # tokens locked in at game start
        self.deadline: float | None = None
        self.gen = 0
        self.seq = 0            # bumps on every mutation; used by core.net to
        self._pid_counter = 0   # detect stale queued bot actions

    # ---- game hooks (override these) ------------------------------------

    def validate_settings(self, patch: dict) -> dict:
        """Return the sanitized subset of `patch` to apply. Lobby only."""
        return {}

    def game_start(self) -> list:
        """participants are locked in; deal/seat and enter your first phase.
        Return fx. Must set self.phase to something game-specific."""
        raise NotImplementedError

    def game_action(self, token: str, msg: dict) -> list:
        """A client message that isn't a lobby verb. Return fx."""
        return [self.fx("invalid", to=token, msg="Unknown action")]

    def game_tick(self) -> list:
        """The deadline fired during one of YOUR phases. Return fx."""
        return []

    def game_state(self, viewer_token) -> dict | None:
        """Personalized game payload (mask hidden info per viewer!).
        viewer_token is None for spectators/TV."""
        return None

    def game_player_left(self, token: str) -> list:
        """A participant's last socket dropped mid-game. Return fx."""
        return []

    def game_player_back(self, token: str) -> list:
        """A participant reconnected mid-game. Return fx."""
        return []

    def next_bot_action(self):
        """If a bot should act now, return (delay_seconds, bot_token);
        core.net schedules run_bot(bot_token) after the delay (staleness-
        checked via self.seq). Return None when no bot is due."""
        return None

    def run_bot(self, bot_token: str) -> list:
        """Execute the due bot's move. Return fx."""
        return []

    # ---- shared machinery ------------------------------------------------

    def fx(self, kind, to=None, **kw):
        d = {"kind": kind, "to": to}
        d.update(kw)
        return d

    def _bump(self, deadline):
        self.deadline = deadline
        self.gen += 1

    def by_pid(self, pid):
        for p in self.players.values():
            if p.pid == pid:
                return p
        return None

    def humans(self):
        return [p for p in self.players.values() if not p.is_bot]

    def _connected_ready(self):
        return [p for p in self.humans() if p.connected and p.ready]

    def in_game(self):
        return self.phase not in ("lobby", "countdown")

    def add_bot(self, name, difficulty="standard"):
        """Create a bot Player (subclasses call this from game_start)."""
        self._pid_counter += 1
        pid = "p%d" % self._pid_counter
        token = "bot:%s" % pid
        n_bots = sum(1 for p in self.players.values() if p.is_bot)
        bot = Player(token, pid, clean_name(name),
                     BOT_AVATARS[n_bots % len(BOT_AVATARS)],
                     COLORS[(self._pid_counter - 1) % len(COLORS)],
                     is_bot=True)
        self.players[token] = bot
        return bot

    def remove_bots(self):
        for t in [t for t, p in self.players.items() if p.is_bot]:
            del self.players[t]

    # ---- lobby verbs (same for every game) -------------------------------

    def join(self, token, name=None, avatar=None):
        p = self.players.get(token)
        if p is None and len(self.humans()) >= self.MAX_HUMANS:
            # reject BEFORE bumping seq: nothing changed, and a seq bump with
            # no following push would orphan a pending bot action
            return None, [self.fx("invalid", to=token, msg="Room is full")]
        self.seq += 1
        fx = []
        if p is None:
            self._pid_counter += 1
            pid = "p%d" % self._pid_counter
            color = COLORS[(self._pid_counter - 1) % len(COLORS)]
            av = avatar if avatar in AVATARS else AVATARS[(self._pid_counter - 1) % len(AVATARS)]
            p = Player(token, pid, clean_name(name), av, color)
            p.ready = False
            self.players[token] = p
            fx.append(self.fx("toast", msg="%s joined" % p.name, icon=p.avatar))
        else:
            p.connected = True
            if name is not None:
                p.name = clean_name(name)
            if avatar in AVATARS:
                p.avatar = avatar
            if self.in_game() and token in self.participants:
                fx.extend(self.game_player_back(token))
        return p, fx

    def leave(self, token):
        self.seq += 1
        p = self.players.get(token)
        if not p or p.is_bot:
            return []
        p.connected = False
        fx = []
        if token not in self.participants:
            # non-participants (lobby leavers AND mid-game spectators) are
            # pruned immediately — ghosts must not count toward MAX_HUMANS
            del self.players[token]
            if self.phase == "countdown" and len(self._connected_ready()) < self.MIN_PLAYERS:
                self._bump(None)
                self.phase = "lobby"
                fx.append(self.fx("toast", msg="Launch aborted — not enough players"))
            return fx
        p.ready = False
        if self.in_game() and token in self.participants:
            fx.extend(self.game_player_left(token))
            humans_alive = any(
                self.players[t].connected
                for t in self.participants
                if t in self.players and not self.players[t].is_bot)
            if not humans_alive:
                fx.extend(self.to_lobby())
                fx.append(self.fx("toast", msg="Game abandoned — everyone left"))
        return fx

    def set_profile(self, token, name=None, avatar=None):
        self.seq += 1
        p = self.players.get(token)
        if p and not p.is_bot:
            if name is not None:
                p.name = clean_name(name)
            if avatar in AVATARS:
                p.avatar = avatar
        return []

    def set_ready(self, token, ready):
        self.seq += 1
        p = self.players.get(token)
        if not p or p.is_bot or self.phase not in ("lobby", "countdown"):
            return []
        p.ready = bool(ready)
        if self.phase == "countdown" and len(self._connected_ready()) < self.MIN_PLAYERS:
            self._bump(None)
            self.phase = "lobby"
            return [self.fx("toast", msg="Launch aborted — not enough players")]
        return []

    def set_settings(self, token, patch):
        self.seq += 1
        if self.phase != "lobby" or token not in self.players:
            return []
        if isinstance(patch, dict):
            self.settings.update(self.validate_settings(patch))
        return []

    def start(self, token):
        self.seq += 1
        p = self.players.get(token)
        if not p or self.phase != "lobby" or not p.ready:
            return []
        if len(self._connected_ready()) < self.MIN_PLAYERS:
            return [self.fx("invalid", to=token,
                            msg="Need at least %d players ready" % self.MIN_PLAYERS)]
        self.phase = "countdown"
        self._bump(time.time() + COUNTDOWN_SECONDS)
        return [self.fx("countdown", seconds=COUNTDOWN_SECONDS, by=p.pid)]

    def tick(self, gen):
        self.seq += 1
        if gen != self.gen or self.deadline is None:
            return []
        if self.phase == "countdown":
            ready = self._connected_ready()
            if len(ready) < self.MIN_PLAYERS:
                self.phase = "lobby"
                self._bump(None)
                return [self.fx("toast", msg="Launch aborted — not enough players")]
            self.participants = [p.token for p in
                                 sorted(ready, key=lambda q: q.joined_at)]
            fx = [self.fx("game_start")]
            # connected humans who never readied get told, not ghosted
            for p in self.humans():
                if p.connected and p.token not in self.participants:
                    fx.append(self.fx("toast", to=p.token, icon="🪑",
                                      msg="Game started without you — you weren't ready. Watch this one, ready up for the next."))
            fx.extend(self.game_start())
            return fx
        if self.phase == "game_end":
            return self.to_lobby()
        return self.game_tick()

    def end_game(self):
        """Games call this when they're done (after building their final
        results into their own state). Enters the shared game_end phase."""
        self.phase = "game_end"
        self._bump(time.time() + GAME_END_SECONDS)
        return [self.fx("game_end")]

    def to_lobby(self):
        self.seq += 1
        self.phase = "lobby"
        self.participants = []
        self.remove_bots()
        for t in [t for t, p in self.players.items() if not p.connected]:
            del self.players[t]
        for p in self.players.values():
            p.ready = False
        self._bump(None)
        return [self.fx("lobby")]

    # ---- state envelope ---------------------------------------------------

    def state_for(self, viewer_token=None):
        now = time.time()
        viewer = self.players.get(viewer_token)
        st = {
            "type": "state",
            "now": int(now * 1000),
            "phase": self.phase,
            "deadline": int(self.deadline * 1000) if self.deadline else None,
            "settings": dict(self.settings),
            "min_players": self.MIN_PLAYERS,
            "players": [p.public() for p in
                        sorted(self.players.values(), key=lambda q: q.joined_at)],
            "you": viewer.public() if viewer else None,
            "game": None,
        }
        if self.in_game():
            st["game"] = self.game_state(viewer_token)
        return st
