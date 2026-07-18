"""BINGO — a BIG SCREEN game (shared TV caller + every phone is a card).

The TV (a spectator socket) shows the current call, the called-numbers board,
and everyone's progress + a join QR. Each phone holds a 5x5 card and daubs the
numbers as they're called; first to the pattern shouts BINGO.

Two modes: classic NUMBER bingo (B-I-N-G-O, 1-75) and PICTURE bingo (emojis)
for pre-readers. Patterns: any LINE, four CORNERS, or full BLACKOUT. In AUTO
mode the server daubs for everyone and declares the winner (fully hands-off,
good for little kids); otherwise players tap to daub and tap BINGO to win.
"""

from __future__ import annotations

import time

from core.session import GameSession

# ---- board / call constants ------------------------------------------------
COLS = "BINGO"                       # column letters (numbers mode)
CENTER = 12                          # free space (row 2, col 2)

# 40 distinct, colourful, pre-reader-friendly emojis for PICTURE bingo
EMOJI_POOL = [
    "🐶", "🐱", "🐰", "🦊", "🐻", "🐼", "🐨", "🦁", "🐮", "🐷",
    "🐸", "🐵", "🐔", "🐧", "🦄", "🐝", "🦋", "🐢", "🐙", "🐳",
    "🍎", "🍌", "🍓", "🍕", "🍔", "🍦", "🍩", "🍭", "⭐", "🌈",
    "☀️", "🌙", "⚽", "🏀", "🚗", "🚀", "🎈", "🎁", "🎸", "🌸",
]

# winning cell-index sets for the LINE pattern (rows, cols, both diagonals)
_ROWS = [tuple(range(r * 5, r * 5 + 5)) for r in range(5)]
_COLS = [tuple(range(c, 25, 5)) for c in range(5)]
_DIAGS = [(0, 6, 12, 18, 24), (4, 8, 12, 16, 20)]
LINE_SETS = [frozenset(s) for s in (_ROWS + _COLS + _DIAGS)]
CORNER_SET = frozenset((0, 4, 20, 24))
ALL_SET = frozenset(range(25))

PACE_CHOICES = (3, 4, 6)
ROUND_CHOICES = (1, 3, 5)
ROUNDWIN_SECONDS = 6
GAME_END_HANDOFF = 4                 # brief beat before the shared results screen


def call_label(mode, value):
    """Human-readable call, e.g. 'B 7' for numbers or the emoji itself."""
    if mode == "pics":
        return value
    return "%s %d" % (COLS[(int(value) - 1) // 15], int(value))


class BingoSession(GameSession):
    MIN_PLAYERS = 1                  # solo vs auto-bots is fine
    MAX_HUMANS = 12                  # big family / party
    DEFAULT_SETTINGS = {
        "mode": "numbers",          # numbers | pics
        "pattern": "line",          # line | corners | blackout
        "pace": 4,                  # seconds between calls
        "auto": False,              # server daubs + declares (kids mode)
        "rounds": 3,
        "bots": 0,                  # extra computer players (0-3)
    }

    def __init__(self, rng=None):
        super().__init__(rng)
        self.g = None

    # ---- lobby settings --------------------------------------------------
    def validate_settings(self, patch):
        out = {}
        if patch.get("mode") in ("numbers", "pics"):
            out["mode"] = patch["mode"]
        if patch.get("pattern") in ("line", "corners", "blackout"):
            out["pattern"] = patch["pattern"]
        pace = patch.get("pace")
        if isinstance(pace, int) and not isinstance(pace, bool) and pace in PACE_CHOICES:
            out["pace"] = pace
        if isinstance(patch.get("auto"), bool):
            out["auto"] = patch["auto"]
        rounds = patch.get("rounds")
        if isinstance(rounds, int) and not isinstance(rounds, bool) and rounds in ROUND_CHOICES:
            out["rounds"] = rounds
        bots = patch.get("bots")
        if isinstance(bots, int) and not isinstance(bots, bool) and 0 <= bots <= 3:
            out["bots"] = bots
        return out

    # ---- game lifecycle --------------------------------------------------
    def game_start(self):
        s = self.settings
        # lively solo play: if a lone human starts with no bots picked, add two
        n_bots = int(s["bots"])
        if n_bots == 0 and len(self.participants) == 1:
            n_bots = 2
        for i in range(n_bots):
            self.participants.append(self.add_bot("Bot %d" % (i + 1)).token)

        self.g = {
            "round": 0,
            "wins": {t: 0 for t in self.participants},   # round wins per player
            "cards": {},          # token -> [25 values, CENTER == "FREE"]
            "daubed": {},         # token -> set(cell idx)
            "declared": {},       # token -> True once they've validly called
            "deck": [],           # remaining call values
            "called": [],         # values called so far, in order
            "last_winners": [],
            "result": None,
        }
        return self._start_round()

    def _new_card(self):
        mode = self.settings["mode"]
        card = [None] * 25
        if mode == "pics":
            picks = self.rng.sample(EMOJI_POOL, 24)
            k = 0
            for cell in range(25):
                if cell == CENTER:
                    card[cell] = "FREE"
                else:
                    card[cell] = picks[k]
                    k += 1
        else:  # numbers: 5 distinct per column from that column's 15-number band
            for c in range(5):
                nums = self.rng.sample(range(c * 15 + 1, c * 15 + 16), 5)
                for r in range(5):
                    cell = r * 5 + c
                    card[cell] = "FREE" if cell == CENTER else nums[r]
        return card

    def _new_deck(self):
        pool = list(EMOJI_POOL) if self.settings["mode"] == "pics" else list(range(1, 76))
        self.rng.shuffle(pool)
        return pool

    def _start_round(self):
        g = self.g
        g["round"] += 1
        g["cards"] = {t: self._new_card() for t in self.participants}
        g["daubed"] = {t: {CENTER} for t in self.participants}   # free space pre-daubed
        g["declared"] = {}
        g["deck"] = self._new_deck()
        g["called"] = []
        g["last_winners"] = []
        self.phase = "calling"
        fx = [self.fx("round", n=g["round"], total=self.settings["rounds"])]
        fx.extend(self._call_next())      # first call immediately
        return fx

    def _call_next(self):
        """Pop the next value, auto-daub bots (and everyone in auto mode), then
        either declare auto-winners, end on an exhausted deck, or re-arm."""
        g = self.g
        if not g["deck"]:
            return self._round_over([])   # no winner — deck exhausted
        v = g["deck"].pop()
        g["called"].append(v)
        auto = self.settings["auto"]
        for t in self.participants:
            p = self.players.get(t)
            if p is None:
                continue
            if auto or p.is_bot:          # bots always auto-daub; humans only in auto mode
                self._auto_daub(t, v)
        fx = [self.fx("call", value=v, label=call_label(self.settings["mode"], v),
                      mode=self.settings["mode"])]
        if auto:
            winners = [t for t in self.participants if self._has_bingo(g["daubed"].get(t, set()))]
            if winners:
                return fx + self._round_over(winners)
        self._bump(time.time() + int(self.settings["pace"]))
        return fx

    def _auto_daub(self, token, value):
        card = self.g["cards"].get(token)
        if not card:
            return
        for cell, cv in enumerate(card):
            if cv == value:
                self.g["daubed"][token].add(cell)

    def _has_bingo(self, daubed):
        pattern = self.settings["pattern"]
        if pattern == "blackout":
            return len(daubed) >= 25
        if pattern == "corners":
            return CORNER_SET <= daubed
        return any(line <= daubed for line in LINE_SETS)

    def _round_over(self, winners):
        g = self.g
        for t in winners:
            if t in g["wins"]:
                g["wins"][t] += 1
        g["last_winners"] = list(winners)
        self.phase = "roundwin"
        self._bump(time.time() + ROUNDWIN_SECONDS)
        return [self.fx("roundwin",
                        winners=[self.players[t].pid for t in winners if t in self.players],
                        drawn=not winners)]

    def _finish(self):
        g = self.g
        ranked = sorted(
            ({"pid": self.players[t].pid, "wins": g["wins"][t]}
             for t in self.participants if t in self.players),
            key=lambda e: -e["wins"])
        g["result"] = ranked
        return self.end_game()

    # ---- player actions --------------------------------------------------
    def game_action(self, token, msg):
        if self.g is None or token not in self.participants:
            return [self.fx("invalid", to=token, msg="Not in this game")]
        t = msg.get("t")
        if t == "daub":
            return self._daub(token, msg.get("cell"))
        if t == "bingo":
            return self._claim(token)
        return [self.fx("invalid", to=token, msg="Unknown action")]

    def _daub(self, token, cell):
        if self.phase != "calling":
            return []
        if not isinstance(cell, int) or isinstance(cell, bool) or not (0 <= cell < 25):
            return [self.fx("invalid", to=token, msg="Bad square")]
        card = self.g["cards"].get(token)
        if card is None or cell == CENTER:
            return []
        if card[cell] not in self.g["called"]:
            return [self.fx("invalid", to=token, msg="Not called yet")]
        self.seq += 1
        self.g["daubed"][token].add(cell)
        return []

    def _claim(self, token):
        if self.phase != "calling":
            return []
        self.seq += 1
        if not self._has_bingo(self.g["daubed"].get(token, set())):
            return [self.fx("invalid", to=token, msg="Not a bingo yet!")]
        self.g["declared"][token] = True
        # everyone else who ALSO has a valid pattern on this same call shares it
        winners = [t for t in self.participants
                   if self._has_bingo(self.g["daubed"].get(t, set()))
                   and (t == token or self.g["declared"].get(t))]
        return self._round_over(winners or [token])

    # ---- timers ----------------------------------------------------------
    def game_tick(self):
        if self.phase == "calling":
            return self._call_next()
        if self.phase == "roundwin":
            if self.g["round"] >= int(self.settings["rounds"]):
                return self._finish()
            return self._start_round()
        return []

    # ---- bots (declare a beat after completing, in manual mode) ----------
    def next_bot_action(self):
        if self.g is None or self.phase != "calling" or self.settings["auto"]:
            return None
        for t in self.participants:
            p = self.players.get(t)
            if (p and p.is_bot and not self.g["declared"].get(t)
                    and self._has_bingo(self.g["daubed"].get(t, set()))):
                return (self.rng.uniform(1.5, 4.0), t)
        return None

    def run_bot(self, bot_token):
        if self.phase != "calling" or self.g is None:
            return []
        if not self._has_bingo(self.g["daubed"].get(bot_token, set())):
            return []
        return self._claim(bot_token)

    # ---- state (masked per viewer) --------------------------------------
    def game_state(self, viewer_token):
        g = self.g
        if g is None:
            return None
        mode = self.settings["mode"]
        called_set = set(g["called"])
        card = g["cards"].get(viewer_token)
        my_card = None
        if card is not None:
            my_card = [{"v": (None if cv == "FREE" else cv),
                        "label": ("★" if cv == "FREE" else call_label(mode, cv)),
                        "free": cv == "FREE",
                        "called": cv != "FREE" and cv in called_set}
                       for cv in card]
        my_daubed = sorted(g["daubed"].get(viewer_token, ())) if card is not None else []
        roster = []
        for t in self.participants:
            p = self.players.get(t)
            if p is None:
                continue
            roster.append({"pid": p.pid,
                           "marks": len(g["daubed"].get(t, ())),
                           "wins": g["wins"].get(t, 0),
                           "won": t in g["last_winners"]})
        return {
            "kind": "bingo",
            "stage": self.phase,
            "mode": mode,
            "pattern": self.settings["pattern"],
            "auto": self.settings["auto"],
            "round": g["round"],
            "rounds": int(self.settings["rounds"]),
            "call": (g["called"][-1] if g["called"] else None),
            "call_label": (call_label(mode, g["called"][-1]) if g["called"] else None),
            "called": [{"v": v, "label": call_label(mode, v)} for v in g["called"]],
            "calls_left": len(g["deck"]),
            "my_card": my_card,
            "my_daubed": my_daubed,
            "you_bingo": card is not None and self._has_bingo(g["daubed"].get(viewer_token, set())),
            "roster": roster,
            "last_winners": [self.players[t].pid for t in g["last_winners"] if t in self.players],
            "result": g["result"],
        }
