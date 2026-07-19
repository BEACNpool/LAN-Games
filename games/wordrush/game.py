"""WORD RUSH — a real-time multiplayer word-finding race.

Everyone gets the SAME rack of ~7 letters and races to spell as many valid words
as they can before the clock runs out. Longer words score more; a word that uses
the whole rack earns a bonus. Most points across the rounds wins. You score every
valid word you find (independent of the other players) — it's a race, not a duel.
Your own found words stay private during play; the live leaderboard shows scores
and word counts, and a reveal at the end shows what everyone missed.
"""

from __future__ import annotations

import time
from collections import Counter

from core.session import GameSession
from games.wordrush import words as W

CLOCK_CHOICES = (60, 90, 120)
ROUND_CHOICES = (2, 3, 5)
SIZE_CHOICES = (6, 7, 8)
MIN_WORD = 3
REVEAL_SECONDS = 11
MIN_RACK_WORDS = 25         # a rack must offer at least this many words


class WordRushSession(GameSession):
    MIN_PLAYERS = 1
    MAX_HUMANS = 12
    DEFAULT_SETTINGS = {
        "rounds": 3,
        "clock": 90,
        "size": 7,          # letters in the rack
        "bots": 0,
    }

    def __init__(self, rng=None):
        super().__init__(rng)
        self.g = None

    # ---- settings --------------------------------------------------------
    def validate_settings(self, patch):
        out = {}
        for key, choices in (("rounds", ROUND_CHOICES), ("clock", CLOCK_CHOICES),
                             ("size", SIZE_CHOICES)):
            v = patch.get(key)
            if isinstance(v, int) and not isinstance(v, bool) and v in choices:
                out[key] = v
        b = patch.get("bots")
        if isinstance(b, int) and not isinstance(b, bool) and 0 <= b <= 3:
            out["bots"] = b
        return out

    # ---- lifecycle -------------------------------------------------------
    def game_start(self):
        n_bots = int(self.settings["bots"])
        if n_bots == 0 and len(self.participants) == 1:
            n_bots = 2
        for i in range(n_bots):
            self.participants.append(self.add_bot("Bot %d" % (i + 1)).token)

        self.g = {
            "round": 0,
            "size": int(self.settings["size"]),
            "scores": {t: 0 for t in self.participants},   # cumulative
            "words_total": {t: 0 for t in self.participants},
            "rack": [], "rack_count": Counter(), "rack_words": set(),
            "found": {}, "round_score": {},
            "ticker": [], "botplan": {}, "botpos": {},
            "reveal": None, "last_winners": [], "result": None,
        }
        return self._start_round()

    def _start_round(self):
        g = self.g
        g["round"] += 1
        rack, rack_words = W.make_rack(self.rng, g["size"], MIN_RACK_WORDS)
        g["rack"] = rack
        g["rack_count"] = Counter(rack)
        g["rack_words"] = rack_words
        g["found"] = {t: {} for t in self.participants}
        g["round_score"] = {t: 0 for t in self.participants}
        g["ticker"] = []
        g["reveal"] = None
        g["last_winners"] = []
        g["botplan"] = {}
        g["botpos"] = {}
        self._plan_bots()
        self.phase = "playing"
        self._bump(time.time() + int(self.settings["clock"]))
        return [self.fx("round", n=g["round"], total=int(self.settings["rounds"]))]

    def _plan_bots(self):
        g = self.g
        pool = list(g["rack_words"])
        for t in self.participants:
            p = self.players.get(t)
            if not (p and p.is_bot) or not pool:
                continue
            frac = self.rng.uniform(0.12, 0.28)          # modest, beatable
            n = max(3, min(len(pool), int(len(pool) * frac)))
            # bias toward shorter (more human-like) words via noisy length sort
            picks = sorted(pool, key=lambda w: len(w) + self.rng.uniform(0, 4))[:n]
            self.rng.shuffle(picks)
            g["botplan"][t] = picks
            g["botpos"][t] = 0

    # ---- submitting a word ----------------------------------------------
    def game_action(self, token, msg):
        if self.g is None or token not in self.participants:
            return [self.fx("invalid", to=token, msg="Not in this game")]
        if msg.get("t") == "word":
            return self._submit(token, msg.get("w"))
        return [self.fx("invalid", to=token, msg="Unknown action")]

    def _submit(self, token, w):
        g = self.g
        if self.phase != "playing":
            return []
        if not isinstance(w, str):
            return [self.fx("invalid", to=token, msg="Type a word")]
        w = w.strip().lower()
        if not w.isascii() or not w.isalpha():
            return [self.fx("reject", to=token, w=w, why="letters only")]
        if len(w) < MIN_WORD:
            return [self.fx("reject", to=token, w=w, why="%d+ letters" % MIN_WORD)]
        if len(w) > g["size"]:
            return [self.fx("reject", to=token, w=w, why="too long")]
        if w in g["found"].get(token, {}):
            return [self.fx("reject", to=token, w=w, why="already found")]
        if not W.can_make(w, g["rack_count"]):
            return [self.fx("reject", to=token, w=w, why="not in the rack")]
        if not W.is_word(w):
            return [self.fx("reject", to=token, w=w, why="not a word")]
        pts = W.score_word(w, g["size"])
        g["found"][token][w] = pts
        g["round_score"][token] += pts
        g["scores"][token] += pts
        g["words_total"][token] += 1
        p = self.players[token]
        g["ticker"].append({"pid": p.pid, "len": len(w), "pts": pts})
        g["ticker"] = g["ticker"][-14:]
        self.seq += 1
        return [self.fx("found", to=token, w=w, pts=pts,
                        pangram=(len(w) >= g["size"]))]

    # ---- timers ----------------------------------------------------------
    def game_tick(self):
        if self.phase == "playing":
            return self._reveal()
        if self.phase == "reveal":
            if self.g["round"] >= int(self.settings["rounds"]):
                return self._finish()
            return self._start_round()
        return []

    def _reveal(self):
        g = self.g
        rows = []
        all_found = set()
        for t in self.participants:
            p = self.players.get(t)
            if not p:
                continue
            fw = g["found"][t]
            all_found |= set(fw)
            best = max(fw, key=lambda x: (fw[x], len(x))) if fw else None
            rows.append({"pid": p.pid, "words": len(fw),
                         "score": g["round_score"][t], "best": best})
        rows.sort(key=lambda r: -r["score"])
        top = rows[0]["score"] if rows else 0
        g["last_winners"] = [r["pid"] for r in rows if r["score"] == top and top > 0]
        missed = sorted(g["rack_words"] - all_found, key=lambda x: -len(x))[:6]
        g["reveal"] = {"rows": rows, "possible": len(g["rack_words"]),
                       "top_missed": missed}
        self.phase = "reveal"
        self._bump(time.time() + REVEAL_SECONDS)
        return [self.fx("reveal", winners=g["last_winners"])]

    def _finish(self):
        g = self.g
        g["result"] = sorted(
            ({"pid": self.players[t].pid, "score": g["scores"][t],
              "words": g["words_total"][t]}
             for t in self.participants if t in self.players),
            key=lambda e: (-e["score"], -e["words"]))
        return self.end_game()

    # ---- bots ------------------------------------------------------------
    def next_bot_action(self):
        if self.g is None or self.phase != "playing":
            return None
        g = self.g
        best, best_rem = None, 0
        for t in self.participants:
            p = self.players.get(t)
            if not (p and p.is_bot):
                continue
            rem = len(g["botplan"].get(t, ())) - g["botpos"].get(t, 0)
            if rem > best_rem:
                best, best_rem = t, rem
        if best is None:
            return None
        return (self.rng.uniform(0.5, 2.4), best)

    def run_bot(self, bot_token):
        if self.phase != "playing" or self.g is None:
            return []
        g = self.g
        plan = g["botplan"].get(bot_token, [])
        pos = g["botpos"].get(bot_token, 0)
        if pos >= len(plan):
            return []
        g["botpos"][bot_token] = pos + 1
        return self._submit(bot_token, plan[pos])

    # ---- state (own word list masked to the viewer) ----------------------
    def game_state(self, viewer_token):
        g = self.g
        if g is None:
            return None
        revealed = self.phase in ("reveal", "game_end")
        mine = g["found"].get(viewer_token, {})
        my_words = [{"w": w, "pts": pts} for w, pts in
                    sorted(mine.items(), key=lambda kv: (-len(kv[0]), kv[0]))]
        board = []
        for t in self.participants:
            p = self.players.get(t)
            if not p:
                continue
            board.append({"pid": p.pid, "total": g["scores"].get(t, 0),
                          "round": g["round_score"].get(t, 0),
                          "words": len(g["found"].get(t, {}))})
        board.sort(key=lambda e: (-e["total"], -e["round"]))
        return {
            "kind": "wordrush",
            "stage": self.phase,
            "round": g["round"],
            "rounds": int(self.settings["rounds"]),
            "size": g["size"],
            "rack": list(g["rack"]),
            "my_words": my_words,
            "my_round": g["round_score"].get(viewer_token, 0),
            "my_total": g["scores"].get(viewer_token, 0),
            "leaderboard": board,
            "ticker": g["ticker"][-10:],
            "reveal": g["reveal"] if revealed else None,
            "result": g["result"],
        }
