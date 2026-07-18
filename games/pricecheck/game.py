"""PRICE CHECK — a BIG SCREEN game (shared TV, phones are number pads).

The TV shows an item; every phone locks in a guess at its price (or count /
distance / speed). Closest wins the round — or, in NO-OVER mode, closest
without going over (Price-Is-Right rules). Most round wins after N items is the
champion. Guesses stay secret until the reveal.
"""

from __future__ import annotations

import time

from core.session import GameSession
from games.pricecheck import items as itembank

CLOCK_CHOICES = (20, 30, 45)
ROUND_CHOICES = (3, 5, 8)
REVEAL_SECONDS = 8
BULLSEYE_PCT = 0.05          # within 5% of the answer earns a 🎯


class PriceCheckSession(GameSession):
    MIN_PLAYERS = 1
    MAX_HUMANS = 12
    DEFAULT_SETTINGS = {
        "rule": "closest",      # closest | over  (over = closest without going over)
        "rounds": 5,
        "clock": 30,            # seconds to lock a guess
        "bots": 0,
    }

    def __init__(self, rng=None):
        super().__init__(rng)
        self.g = None

    # ---- lobby settings --------------------------------------------------
    def validate_settings(self, patch):
        out = {}
        if patch.get("rule") in ("closest", "over"):
            out["rule"] = patch["rule"]
        rounds = patch.get("rounds")
        if isinstance(rounds, int) and not isinstance(rounds, bool) and rounds in ROUND_CHOICES:
            out["rounds"] = rounds
        clock = patch.get("clock")
        if isinstance(clock, int) and not isinstance(clock, bool) and clock in CLOCK_CHOICES:
            out["clock"] = clock
        bots = patch.get("bots")
        if isinstance(bots, int) and not isinstance(bots, bool) and 0 <= bots <= 3:
            out["bots"] = bots
        return out

    # ---- lifecycle -------------------------------------------------------
    def game_start(self):
        n_bots = int(self.settings["bots"])
        if n_bots == 0 and len(self.participants) == 1:
            n_bots = 2
        for i in range(n_bots):
            self.participants.append(self.add_bot("Bot %d" % (i + 1)).token)

        n = int(self.settings["rounds"])
        self.g = {
            "round": 0,
            "wins": {t: 0 for t in self.participants},
            "items": itembank.pick(self.rng, n),
            "item": None,
            "guesses": {},        # token -> float
            "locked": {},         # token -> True
            "reveal": None,       # ranked breakdown at reveal
            "last_winners": [],
            "result": None,
        }
        # fewer items than rounds requested (tiny bank) — clamp
        self.g["_total"] = len(self.g["items"])
        return self._start_round()

    def _start_round(self):
        g = self.g
        g["round"] += 1
        g["item"] = g["items"][g["round"] - 1]
        g["guesses"] = {}
        g["locked"] = {}
        g["reveal"] = None
        g["last_winners"] = []
        self.phase = "guessing"
        self._bump(time.time() + int(self.settings["clock"]))
        return [self.fx("item", n=g["round"], total=g["_total"])]

    def _norm_guess(self, value):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        v = float(value)
        if v != v or v in (float("inf"), float("-inf")):   # NaN / inf
            return None
        if v < 0 or v > 1e9:
            return None
        return round(v, 2)

    # ---- actions ---------------------------------------------------------
    def game_action(self, token, msg):
        if self.g is None or token not in self.participants:
            return [self.fx("invalid", to=token, msg="Not in this game")]
        t = msg.get("t")
        if t == "guess":
            return self._guess(token, msg.get("value"))
        if t == "lock":
            return self._lock(token)
        return [self.fx("invalid", to=token, msg="Unknown action")]

    def _guess(self, token, value):
        if self.phase != "guessing" or self.g["locked"].get(token):
            return []
        v = self._norm_guess(value)
        if v is None:
            return [self.fx("invalid", to=token, msg="Enter a number")]
        self.seq += 1
        self.g["guesses"][token] = v
        return []

    def _lock(self, token):
        if self.phase != "guessing" or self.g["locked"].get(token):
            return []
        if token not in self.g["guesses"]:
            return [self.fx("invalid", to=token, msg="Enter a guess first")]
        self.seq += 1
        self.g["locked"][token] = True
        fx = [self.fx("locked", pid=self.players[token].pid)]
        if all(self.g["locked"].get(t) for t in self.participants):
            fx.extend(self._reveal())
        return fx

    # ---- reveal / scoring ------------------------------------------------
    def _reveal(self):
        g = self.g
        answer = float(g["item"]["answer"])
        rows = []
        for t in self.participants:
            if t not in g["guesses"]:
                continue
            guess = g["guesses"][t]
            diff = abs(guess - answer)
            over = guess > answer
            bull = answer > 0 and diff <= answer * BULLSEYE_PCT or diff == 0
            rows.append({"token": t, "pid": self.players[t].pid,
                         "guess": guess, "diff": round(diff, 2),
                         "over": over, "bullseye": bool(bull)})

        rule = self.settings["rule"]
        winners = []
        if rows:
            if rule == "over":
                under = [r for r in rows if not r["over"]]
                if under:
                    best = min(r["diff"] for r in under)
                    winners = [r["token"] for r in under if r["diff"] == best]
            else:
                best = min(r["diff"] for r in rows)
                winners = [r["token"] for r in rows if r["diff"] == best]

        for t in winners:
            g["wins"][t] += 1
        win_set = set(winners)
        for r in rows:
            r["won"] = r["token"] in win_set
        # rank for display: winners first, then by closeness
        rows.sort(key=lambda r: (not r["won"], r["diff"]))
        g["reveal"] = [{k: r[k] for k in ("pid", "guess", "diff", "over", "bullseye", "won")}
                       for r in rows]
        g["last_winners"] = winners
        self.phase = "reveal"
        self._bump(time.time() + REVEAL_SECONDS)
        return [self.fx("reveal",
                        winners=[self.players[t].pid for t in winners if t in self.players],
                        answer=answer, drawn=not winners)]

    def _finish(self):
        g = self.g
        g["result"] = sorted(
            ({"pid": self.players[t].pid, "wins": g["wins"][t]}
             for t in self.participants if t in self.players),
            key=lambda e: -e["wins"])
        return self.end_game()

    def game_tick(self):
        if self.phase == "guessing":
            return self._reveal()
        if self.phase == "reveal":
            if self.g["round"] >= self.g["_total"]:
                return self._finish()
            return self._start_round()
        return []

    # ---- bots ------------------------------------------------------------
    def next_bot_action(self):
        if self.g is None or self.phase != "guessing":
            return None
        for t in self.participants:
            p = self.players.get(t)
            if p and p.is_bot and not self.g["locked"].get(t):
                return (self.rng.uniform(1.5, max(2.0, int(self.settings["clock"]) - 4)), t)
        return None

    def run_bot(self, bot_token):
        if self.phase != "guessing" or self.g is None or self.g["locked"].get(bot_token):
            return []
        answer = float(self.g["item"]["answer"])
        guess = max(0.0, answer * self.rng.uniform(0.55, 1.45))
        guess = round(guess, 2) if self.g["item"]["money"] else float(round(guess))
        self.g["guesses"][bot_token] = guess
        return self._lock(bot_token)

    # ---- state (guesses masked until reveal) -----------------------------
    def game_state(self, viewer_token):
        g = self.g
        if g is None:
            return None
        it = g["item"]
        revealed = self.phase in ("reveal", "game_end")
        pub_item = {"prompt": it["prompt"], "emoji": it["emoji"],
                    "money": it["money"], "unit": it["unit"], "category": it["category"]}
        roster = []
        for t in self.participants:
            p = self.players.get(t)
            if p is None:
                continue
            entry = {"pid": p.pid, "locked": bool(g["locked"].get(t)),
                     "guessed": t in g["guesses"], "wins": g["wins"].get(t, 0),
                     "won": t in g["last_winners"]}
            if revealed and t in g["guesses"]:
                entry["guess"] = g["guesses"][t]
            roster.append(entry)
        return {
            "kind": "pricecheck",
            "stage": self.phase,
            "rule": self.settings["rule"],
            "round": g["round"],
            "rounds": g["_total"],
            "item": pub_item,
            "answer": (float(it["answer"]) if revealed else None),
            "fact": (it["fact"] if revealed else None),
            "my_guess": g["guesses"].get(viewer_token),
            "my_locked": bool(g["locked"].get(viewer_token)),
            "reveal": g["reveal"] if revealed else None,
            "roster": roster,
            "last_winners": [self.players[t].pid for t in g["last_winners"] if t in self.players],
            "result": g["result"],
        }
