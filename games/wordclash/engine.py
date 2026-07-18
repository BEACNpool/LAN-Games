"""WORDCLASH game engine — pure logic, no IO.

The server owns sockets and timers; everything in here is synchronous state
mutation. Mutating methods return a list of "fx" dicts (transient events —
sounds, toasts, animations) that the server routes to clients alongside a
fresh personalized state push. Timer expiry is delivered by the server
calling Room.tick(gen); `gen` invalidates stale timers after any reschedule.
"""

from __future__ import annotations

import random
import re
import time

WORD_LEN = 5
DUEL_GUESSES = 6
DUEL_SECONDS = 180
COUNTDOWN_SECONDS = 3
ROUND_END_SECONDS = 10
PODIUM_SECONDS = 20
SABOTAGE_CHARGES = 2
TIME_CUT_SECONDS = 7
MIN_TURN_SECONDS = 5
MAX_ROUNDS = 10
MAX_PLAYERS = 10

MODES = ("duel", "relay", "sabotage")

# Scoring
DUEL_SOLVE = 100
DUEL_GUESS_BONUS = 20      # per unused guess row
DUEL_SPEED_MAX = 50        # scaled by fraction of round time remaining
DUEL_FIRST_BONUS = 25
DUEL_GREEN = 12            # non-solver consolation, per distinct green (pos,char)
DUEL_YELLOW = 5            # per distinct yellow letter not known green
DUEL_CONSOLATION_CAP = 75  # always clearly below a solve
RELAY_SOLVE = 100
RELAY_ROW_BONUS = 10       # per unused shared row
RELAY_NEW_GREEN = 15
RELAY_NEW_YELLOW = 5
RELAY_TIMEOUT_PENALTY = 10

AVATARS = ["🦊", "🐸", "🦖", "🐙", "🦉", "🐯", "🐼", "🦄",
           "👾", "🤖", "🐲", "😈", "🦈", "🐝", "🦩", "🐢"]
COLORS = ["#22d3ee", "#a78bfa", "#f472b6", "#fbbf24",
          "#34d399", "#fb7185", "#60a5fa", "#c084fc"]

_NAME_ALLOWED = re.compile(r"[^A-Za-z0-9 \-'.!?]")


def clean_name(raw) -> str:
    if not isinstance(raw, str):
        return "PLAYER"
    name = _NAME_ALLOWED.sub("", raw).strip()
    name = re.sub(r"\s+", " ", name)[:14]
    return name or "PLAYER"


def evaluate_guess(secret: str, guess: str) -> list:
    """Standard Wordle marks with correct duplicate handling.
    Returns list of 'g' (green), 'y' (yellow), 'b' (gray)."""
    marks = ["b"] * WORD_LEN
    remaining = {}
    for i in range(WORD_LEN):
        if guess[i] == secret[i]:
            marks[i] = "g"
        else:
            remaining[secret[i]] = remaining.get(secret[i], 0) + 1
    for i in range(WORD_LEN):
        if marks[i] == "g":
            continue
        c = guess[i]
        if remaining.get(c, 0) > 0:
            marks[i] = "y"
            remaining[c] -= 1
    return marks


class Player:
    __slots__ = ("token", "pid", "name", "avatar", "color",
                 "ready", "connected", "joined_at", "pfp")

    def __init__(self, token, pid, name, avatar, color):
        self.token = token
        self.pid = pid
        self.name = name
        self.avatar = avatar
        self.color = color
        self.ready = False
        self.connected = True
        self.joined_at = time.time()
        self.pfp = None      # custom picture URL (avatars.py), or None

    def public(self, score=0, in_match=False):
        return {"pid": self.pid, "name": self.name, "avatar": self.avatar,
                "color": self.color, "ready": self.ready,
                "connected": self.connected, "score": score,
                "in_match": in_match, "pfp": self.pfp}


class Room:
    def __init__(self, answers, allowed, rng=None):
        self.answers = list(answers)
        self.allowed = set(allowed)
        self.rng = rng or random.Random()
        self.players = {}            # token -> Player
        self.phase = "lobby"         # lobby|countdown|playing|round_end|podium
        self.settings = {"mode": "duel", "rounds": 3, "turn_seconds": 15}
        self.match = None
        self.deadline = None         # epoch seconds; server schedules tick
        self.gen = 0                 # bump whenever deadline is (re)set
        self._pid_counter = 0

    # ---------- helpers ----------

    def _bump(self, deadline):
        self.deadline = deadline
        self.gen += 1

    def _by_pid(self, pid):
        for p in self.players.values():
            if p.pid == pid:
                return p
        return None

    def _connected_ready(self):
        return [p for p in self.players.values() if p.connected and p.ready]

    def _fx(self, kind, to=None, **kw):
        d = {"kind": kind, "to": to}
        d.update(kw)
        return d

    # ---------- lobby ----------

    def join(self, token, name=None, avatar=None):
        fx = []
        p = self.players.get(token)
        if p is None:
            if len(self.players) >= MAX_PLAYERS:
                return None, [self._fx("invalid", to=token, msg="Room is full")]
            self._pid_counter += 1
            pid = "p%d" % self._pid_counter
            color = COLORS[(self._pid_counter - 1) % len(COLORS)]
            av = avatar if avatar in AVATARS else AVATARS[(self._pid_counter - 1) % len(AVATARS)]
            p = Player(token, pid, clean_name(name), av, color)
            self.players[token] = p
            fx.append(self._fx("toast", msg="%s joined" % p.name, icon=p.avatar))
        else:
            p.connected = True
            if name is not None:
                p.name = clean_name(name)
            if avatar in AVATARS:
                p.avatar = avatar
            # rejoining un-pauses a stalled relay round
            fx.extend(self._maybe_resume())
        return p, fx

    def set_profile(self, token, name=None, avatar=None):
        p = self.players.get(token)
        if not p:
            return []
        if name is not None:
            p.name = clean_name(name)
        if avatar in AVATARS:
            p.avatar = avatar
        return []

    def set_ready(self, token, ready):
        p = self.players.get(token)
        if not p or self.phase not in ("lobby", "countdown"):
            return []
        p.ready = bool(ready)
        fx = []
        if self.phase == "countdown" and len(self._connected_ready()) < 2:
            # everyone bailed during countdown
            self._bump(None)
            self.phase = "lobby"
            self._prune()
            fx.append(self._fx("toast", msg="Launch aborted — not enough players"))
        return fx

    def _prune(self):
        """Drop disconnected players who aren't part of a match."""
        m = self.match
        gone = [t for t, p in self.players.items()
                if not p.connected and not (m and t in m["participants"])]
        for t in gone:
            del self.players[t]

    def set_settings(self, token, mode=None, rounds=None, turn_seconds=None):
        if self.phase != "lobby" or token not in self.players:
            return []
        if mode in MODES:
            self.settings["mode"] = mode
        if isinstance(rounds, int) and 1 <= rounds <= MAX_ROUNDS:
            self.settings["rounds"] = rounds
        if isinstance(turn_seconds, int) and MIN_TURN_SECONDS <= turn_seconds <= 60:
            self.settings["turn_seconds"] = turn_seconds
        return []

    def start(self, token):
        p = self.players.get(token)
        if not p or self.phase != "lobby" or not p.ready:
            return []
        if len(self._connected_ready()) < 2:
            return [self._fx("invalid", to=token, msg="Need at least 2 players ready")]
        self.phase = "countdown"
        self._bump(time.time() + COUNTDOWN_SECONDS)
        return [self._fx("countdown", seconds=COUNTDOWN_SECONDS, by=p.pid)]

    def leave(self, token):
        """Socket dropped."""
        p = self.players.get(token)
        if not p:
            return []
        p.connected = False
        fx = []
        in_match = self.match and token in self.match["participants"]
        if self.phase == "lobby" and not in_match:
            del self.players[token]
        else:
            p.ready = False
            if self.phase == "countdown" and len(self._connected_ready()) < 2:
                self._bump(None)
                self.phase = "lobby"
                self._prune()
                fx.append(self._fx("toast", msg="Launch aborted — not enough players"))
            fx.extend(self._maybe_pause())
            if self.match and not self._match_alive():
                fx.extend(self.to_lobby())
                fx.append(self._fx("toast", msg="Match abandoned — everyone left"))
        return fx

    def _match_alive(self):
        """At least one participant still connected."""
        return any(self.players[t].connected
                   for t in self.match["participants"] if t in self.players)

    # ---------- match lifecycle ----------

    def tick(self, gen):
        """Deadline fired. Ignore if superseded."""
        if gen != self.gen or self.deadline is None:
            return []
        if self.phase == "countdown":
            return self._start_match()
        if self.phase == "playing":
            r = self.match["round"]
            if r["kind"] == "duel":
                return self._end_round("time")
            return self._relay_turn_timeout()
        if self.phase == "round_end":
            if self.match["round_num"] >= self.match["rounds_total"]:
                return self._podium()
            return self._start_round()
        if self.phase == "podium":
            return self.to_lobby()
        return []

    def _start_match(self):
        ready = self._connected_ready()
        if len(ready) < 2:
            self.phase = "lobby"
            self._bump(None)
            return [self._fx("toast", msg="Launch aborted — not enough players")]
        self.match = {
            "id": "m%08x" % self.rng.randrange(1 << 32),
            "mode": self.settings["mode"],
            "rounds_total": self.settings["rounds"],
            "participants": [p.token for p in sorted(ready, key=lambda q: q.joined_at)],
            "scores": {p.token: 0 for p in ready},
            "round_num": 0,
            "round": None,
            "reveal": None,
            "used": set(),
        }
        return self._start_round()

    def _pick_secret(self):
        for _ in range(50):
            w = self.rng.choice(self.answers)
            if w not in self.match["used"]:
                self.match["used"].add(w)
                return w
        return self.rng.choice(self.answers)

    def _start_round(self):
        m = self.match
        if not self._match_alive():
            fx = self.to_lobby()
            fx.append(self._fx("toast", msg="Match abandoned — everyone left"))
            return fx
        m["round_num"] += 1
        m["reveal"] = None
        secret = self._pick_secret()
        n = len(m["participants"])
        if m["mode"] == "duel":
            m["round"] = {
                "kind": "duel", "secret": secret,
                "start": time.time(), "seconds": DUEL_SECONDS,
                "boards": {t: {"rows": [], "solved": False, "done": False,
                               "finish": None, "pts": 0}
                           for t in m["participants"]},
                "first_solver": None,
            }
            self.phase = "playing"
            self._bump(time.time() + DUEL_SECONDS)
        else:
            order = list(m["participants"])
            self.rng.shuffle(order)
            r = {
                "kind": m["mode"], "secret": secret,
                "rows": [], "rows_max": max(6, 6 + 2 * (n - 2)),
                "order": order, "turn_idx": 0,
                "greens": set(), "yellows": set(), "grays": set(),
                "charges": {t: SABOTAGE_CHARGES for t in order},
                "pending": None, "paused": False,
                "pts": {t: 0 for t in order},
                "turn_deadline": None, "turn_seconds": self.settings["turn_seconds"],
            }
            m["round"] = r
            self.phase = "playing"
            # first turn goes to first connected in order
            if not self._relay_seat(first=True):
                return [self._fx("toast", msg="Round paused — waiting for players")]
        return [self._fx("round_start", num=m["round_num"],
                         total=m["rounds_total"], mode=m["mode"])]

    # ---------- duel ----------

    def guess(self, token, word):
        if self.phase != "playing" or not self.match:
            return [self._fx("invalid", to=token, msg="No round in progress")]
        r = self.match["round"]
        word = str(word).lower().strip()
        if len(word) != WORD_LEN or not word.isalpha():
            return [self._fx("invalid", to=token, msg="Five letters, please")]
        if word not in self.allowed:
            return [self._fx("invalid", to=token, msg="Not in the dictionary")]
        if r["kind"] == "duel":
            return self._duel_guess(token, word)
        return self._relay_guess(token, word)

    def _duel_guess(self, token, word):
        r = self.match["round"]
        b = r["boards"].get(token)
        if b is None:
            return [self._fx("invalid", to=token, msg="You're spectating this match")]
        if b["done"]:
            return [self._fx("invalid", to=token, msg="Your board is finished")]
        marks = evaluate_guess(r["secret"], word)
        b["rows"].append({"w": word, "m": marks})
        p = self.players[token]
        fx = [self._fx("landed", pid=p.pid, marks=marks, row=len(b["rows"]) - 1)]
        if word == r["secret"]:
            b["solved"] = True
            b["done"] = True
            b["finish"] = time.time()
            first = r["first_solver"] is None
            if first:
                r["first_solver"] = token
            left = DUEL_GUESSES - len(b["rows"])
            time_left = max(0.0, (r["start"] + r["seconds"]) - time.time())
            pts = (DUEL_SOLVE + DUEL_GUESS_BONUS * left
                   + int(DUEL_SPEED_MAX * time_left / r["seconds"])
                   + (DUEL_FIRST_BONUS if first else 0))
            b["pts"] = pts
            fx.append(self._fx("solved", pid=p.pid, first=first))
        elif len(b["rows"]) >= DUEL_GUESSES:
            b["done"] = True
            fx.append(self._fx("busted", pid=p.pid))
        if all(bb["done"] for bb in r["boards"].values()):
            fx.extend(self._end_round("all_done"))
        return fx

    # ---------- relay / sabotage ----------

    def _relay_current(self):
        r = self.match["round"]
        return r["order"][r["turn_idx"]]

    def _relay_seat(self, first=False):
        """Advance turn_idx to the next connected player and arm the turn
        timer. Returns False (and pauses) if nobody is connected."""
        r = self.match["round"]
        n = len(r["order"])
        start = r["turn_idx"] if first else (r["turn_idx"] + 1) % n
        for k in range(n):
            idx = (start + k) % n
            tok = r["order"][idx]
            if self.players[tok].connected:
                r["turn_idx"] = idx
                secs = r["turn_seconds"]
                if r["pending"] and r["pending"]["kind"] == "time":
                    # a time cut must always SHORTEN the turn, even when
                    # turn_seconds is set below the 7s default cut
                    secs = min(TIME_CUT_SECONDS, r["turn_seconds"] - 2)
                r["eff_seconds"] = secs
                r["paused"] = False
                self._bump(time.time() + secs)
                return True
            # a pending effect aimed at a player we skip (disconnected) fizzles
            if (r["pending"]
                    and r["pending"].get("target") == self.players[tok].pid):
                r["pending"] = None
        r["paused"] = True
        self._bump(None)
        return False

    def _maybe_pause(self):
        if (self.phase == "playing" and self.match
                and self.match["round"]["kind"] != "duel"):
            r = self.match["round"]
            cur = self._relay_current()
            if not self.players[cur].connected:
                # current player dropped mid-turn: skip them without penalty
                r["pending"] = None
                if not self._relay_seat():
                    return [self._fx("toast", msg="Round paused — waiting for players")]
                nxt = self.players[self._relay_current()]
                return [self._fx("toast", msg="%s's turn" % nxt.name, icon=nxt.avatar)]
        return []

    def _maybe_resume(self):
        if (self.phase == "playing" and self.match
                and self.match["round"]["kind"] != "duel"
                and self.match["round"].get("paused")):
            if self._relay_seat(first=True):
                p = self.players[self._relay_current()]
                return [self._fx("toast", msg="Round resumed — %s's turn" % p.name,
                                 icon=p.avatar)]
        return []

    def _relay_guess(self, token, word):
        r = self.match["round"]
        if token not in r["order"]:
            return [self._fx("invalid", to=token, msg="You're spectating this match")]
        if r["paused"]:
            return [self._fx("invalid", to=token, msg="Round is paused")]
        if token != self._relay_current():
            return [self._fx("invalid", to=token, msg="Not your turn")]
        pend = r["pending"]
        if pend:
            if pend["kind"] == "ban" and pend["letter"] in word:
                return [self._fx("invalid", to=token,
                                 msg="Letter %s is banned this turn" % pend["letter"].upper())]
            if pend["kind"] == "start" and word[0] != pend["letter"]:
                return [self._fx("invalid", to=token,
                                 msg="Your word must start with %s" % pend["letter"].upper())]
        r["pending"] = None
        p = self.players[token]
        marks = evaluate_guess(r["secret"], word)
        # two-pass scoring: bank all new greens first so a yellow duplicate of
        # a letter that ALSO landed green this guess never double-pays,
        # regardless of position order within the word
        gained = 0
        for i, mk in enumerate(marks):
            if mk == "g" and (i, word[i]) not in r["greens"]:
                r["greens"].add((i, word[i]))
                gained += RELAY_NEW_GREEN
        green_chars = {ch for _, ch in r["greens"]}
        for i, mk in enumerate(marks):
            c = word[i]
            if mk == "y":
                if c not in r["yellows"] and c not in green_chars:
                    r["yellows"].add(c)
                    gained += RELAY_NEW_YELLOW
            elif mk == "b":
                r["grays"].add(c)
        r["rows"].append({"w": word, "m": marks, "by": p.pid, "skipped": False})
        fx = [self._fx("landed", pid=p.pid, marks=marks, word=word,
                       row=len(r["rows"]) - 1, gained=gained)]
        if word == r["secret"]:
            rows_left = r["rows_max"] - len(r["rows"])
            gained += RELAY_SOLVE + RELAY_ROW_BONUS * rows_left
            r["pts"][token] = r["pts"].get(token, 0) + gained
            fx.append(self._fx("solved", pid=p.pid, first=True))
            fx.extend(self._end_round("solved"))
            return fx
        r["pts"][token] = r["pts"].get(token, 0) + gained
        if len(r["rows"]) >= r["rows_max"]:
            fx.extend(self._end_round("exhausted"))
            return fx
        self._relay_seat()
        nxt = self.players[self._relay_current()]
        fx.append(self._fx("turn", pid=nxt.pid))
        return fx

    def _relay_turn_timeout(self):
        r = self.match["round"]
        tok = self._relay_current()
        p = self.players[tok]
        r["pending"] = None
        r["rows"].append({"w": None, "m": None, "by": p.pid, "skipped": True})
        r["pts"][tok] = r["pts"].get(tok, 0) - RELAY_TIMEOUT_PENALTY
        fx = [self._fx("timeout", pid=p.pid, penalty=RELAY_TIMEOUT_PENALTY)]
        if len(r["rows"]) >= r["rows_max"]:
            fx.extend(self._end_round("exhausted"))
            return fx
        if self._relay_seat():
            nxt = self.players[self._relay_current()]
            fx.append(self._fx("turn", pid=nxt.pid))
        else:
            fx.append(self._fx("toast", msg="Round paused — waiting for players"))
        return fx

    def sabotage(self, token, kind, letter=None):
        if self.phase != "playing" or not self.match:
            return [self._fx("invalid", to=token, msg="No round in progress")]
        r = self.match["round"]
        if r["kind"] != "sabotage":
            return [self._fx("invalid", to=token, msg="No sabotage in this mode")]
        if r["paused"] or token not in r["order"]:
            return [self._fx("invalid", to=token, msg="Not your turn")]
        if token != self._relay_current():
            return [self._fx("invalid", to=token, msg="Not your turn")]
        if r["charges"].get(token, 0) <= 0:
            return [self._fx("invalid", to=token, msg="No sabotage charges left")]
        if kind not in ("time", "ban", "start"):
            return [self._fx("invalid", to=token, msg="Unknown sabotage")]
        if kind in ("ban", "start"):
            if not (isinstance(letter, str) and len(letter) == 1):
                return [self._fx("invalid", to=token, msg="Pick a letter")]
            letter = letter.lower()
            # ASCII only — str.isalpha() accepts Unicode letters, which would
            # make a forced-start constraint unsatisfiable (no dictionary word
            # starts with "ë") and grief the target into a guaranteed timeout
            if letter not in "abcdefghijklmnopqrstuvwxyz":
                return [self._fx("invalid", to=token, msg="Pick a letter")]
            if kind == "ban":
                known = {ch for _, ch in r["greens"]} | r["yellows"]
                if letter in known:
                    return [self._fx("invalid", to=token,
                                     msg="Can't ban a revealed letter")]
        caster = self.players[token]
        # resolve the target (next CONNECTED player) before arming the effect;
        # seating then lands exactly on the target, so the pending can never be
        # fizzled mid-cast by a disconnected seat in between
        n = len(r["order"])
        target_tok = None
        for k in range(1, n):
            tok = r["order"][(r["turn_idx"] + k) % n]
            if self.players[tok].connected:
                target_tok = tok
                break
        if target_tok is None or target_tok == token:
            return [self._fx("invalid", to=token, msg="No one to sabotage")]
        target = self.players[target_tok]
        r["charges"][token] -= 1
        r["pending"] = {"kind": kind, "letter": letter, "by": caster.pid,
                        "target": target.pid}
        self._relay_seat()
        return [self._fx("sabotage", by=caster.pid, target=target.pid,
                         what=kind, letter=letter),
                self._fx("turn", pid=target.pid)]

    # ---------- round & match end ----------

    def _end_round(self, reason):
        m = self.match
        r = m["round"]
        round_scores = {}
        if r["kind"] == "duel":
            for tok, b in r["boards"].items():
                if b["solved"]:
                    pts = b["pts"]
                    why = "solved it"
                else:
                    # distinct discoveries across the whole board, so a
                    # losing-but-close board is genuinely rewarded
                    greens, yells = set(), set()
                    for row in b["rows"]:
                        for i, mk in enumerate(row["m"]):
                            if mk == "g":
                                greens.add((i, row["w"][i]))
                            elif mk == "y":
                                yells.add(row["w"][i])
                    yells -= {ch for _, ch in greens}
                    pts = min(DUEL_CONSOLATION_CAP,
                              DUEL_GREEN * len(greens) + DUEL_YELLOW * len(yells))
                    why = "intel" if b["rows"] else "no guesses"
                    b["pts"] = pts
                round_scores[tok] = {"pts": pts, "why": why,
                                     "solved": b["solved"]}
                m["scores"][tok] += pts
        else:
            solver = None
            if reason == "solved":
                solver = self._relay_current()
            for tok in r["order"]:
                pts = r["pts"].get(tok, 0)
                round_scores[tok] = {"pts": pts,
                                     "why": "solved it" if tok == solver else "intel",
                                     "solved": tok == solver}
                m["scores"][tok] += pts
        m["reveal"] = {
            "secret": r["secret"],
            "reason": reason,
            "round_scores": {self.players[t].pid: v for t, v in round_scores.items()},
        }
        m["round"] = r  # kept for full-board reveal rendering
        self.phase = "round_end"
        self._bump(time.time() + ROUND_END_SECONDS)
        return [self._fx("round_end", secret=r["secret"], reason=reason)]

    def _podium(self):
        m = self.match
        self.phase = "podium"
        self._bump(time.time() + PODIUM_SECONDS)
        return [self._fx("match_end")]

    def to_lobby(self):
        self.phase = "lobby"
        self.match = None
        self._bump(None)
        gone = [t for t, p in self.players.items() if not p.connected]
        for t in gone:
            del self.players[t]
        for p in self.players.values():
            p.ready = False
        return [self._fx("lobby")]

    # ---------- state serialization ----------

    def state_for(self, viewer_token=None):
        now = time.time()
        viewer = self.players.get(viewer_token)
        st = {
            "type": "state",
            "now": int(now * 1000),
            "phase": self.phase,
            "deadline": int(self.deadline * 1000) if self.deadline else None,
            "settings": dict(self.settings),
            "players": [],
            "you": None,
            "match": None,
        }
        m = self.match
        for p in sorted(self.players.values(), key=lambda q: q.joined_at):
            score = m["scores"].get(p.token, 0) if m else 0
            in_match = bool(m and p.token in m["participants"])
            st["players"].append(p.public(score, in_match))
        if viewer:
            score = m["scores"].get(viewer.token, 0) if m else 0
            in_match = bool(m and viewer.token in m["participants"])
            st["you"] = viewer.public(score, in_match)
        if not m:
            return st
        pid_of = {t: self.players[t].pid for t in m["participants"] if t in self.players}
        ms = {
            "id": m["id"],
            "mode": m["mode"],
            "round_num": m["round_num"],
            "rounds_total": m["rounds_total"],
            "scores": {pid_of[t]: v for t, v in m["scores"].items() if t in pid_of},
            "round": None,
            "reveal": None,
            "podium": None,
        }
        r = m["round"]
        playing = self.phase == "playing"
        revealed = self.phase in ("round_end", "podium")
        if r and (playing or revealed):
            if r["kind"] == "duel":
                boards = {}
                for tok, b in r["boards"].items():
                    if tok not in pid_of:
                        continue
                    mine = viewer is not None and tok == viewer.token
                    rows = []
                    for row in b["rows"]:
                        if mine or revealed:
                            rows.append({"w": row["w"], "m": row["m"]})
                        else:
                            rows.append({"m": row["m"]})
                    boards[pid_of[tok]] = {
                        "rows": rows, "done": b["done"], "solved": b["solved"],
                        "n": len(b["rows"]), "max": DUEL_GUESSES,
                    }
                ms["round"] = {"kind": "duel", "boards": boards,
                               "seconds": r["seconds"],
                               "started": int(r["start"] * 1000)}
            else:
                pend = None
                if r["pending"]:
                    pend = dict(r["pending"])
                ms["round"] = {
                    "kind": r["kind"],
                    "rows": [{"w": row["w"], "m": row["m"], "by": row["by"],
                              "skipped": row["skipped"]} for row in r["rows"]],
                    "rows_max": r["rows_max"],
                    "order": [pid_of[t] for t in r["order"] if t in pid_of],
                    "turn": pid_of.get(self._relay_current()) if not r["paused"] else None,
                    "turn_seconds": r.get("eff_seconds", r["turn_seconds"]),
                    "paused": r["paused"],
                    "pending": pend,
                    "charges": {pid_of[t]: c for t, c in r["charges"].items()
                                if t in pid_of} if r["kind"] == "sabotage" else None,
                }
        if self.phase == "round_end" and m["reveal"]:
            ms["reveal"] = dict(m["reveal"])
        if self.phase == "podium":
            standing = sorted(
                (t for t in m["participants"] if t in pid_of),
                key=lambda t: -m["scores"].get(t, 0))
            # tie-aware ranks (1,1,3 pattern) — never crown by join order
            podium, prev_score, prev_rank = [], None, 0
            for i, t in enumerate(standing):
                score = m["scores"].get(t, 0)
                rank = prev_rank if score == prev_score else i + 1
                prev_score, prev_rank = score, rank
                podium.append({
                    "pid": pid_of[t],
                    "name": self.players[t].name,
                    "avatar": self.players[t].avatar,
                    "pfp": self.players[t].pfp,
                    "color": self.players[t].color,
                    "score": score,
                    "rank": rank,
                })
            ms["podium"] = podium
        st["match"] = ms
        return st
