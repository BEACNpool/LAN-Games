"""CATEGORY BLITZ — name things in a category before the sand runs out.

Scattergories energy, phone-native: everyone types answers at once; answers
that MATCH another player's cancel to zero, unique answers score 10. The
reveal grid is the laugh moment AND the honor-system audit — the family in
the room polices nonsense (there is no dictionary judge, just a long-press
"call BS" that fires a toast for fun).

Round loop:  intro (2.5s, big type)  ->  blitz (sand timer, type fast)
             ->  reveal (cancels strike out, uniques count up; tap-to-skip
             when everyone's tapped)  ->  next round / podium.

2–10 players, no bots. Answers are hidden from other players while the
clock runs — only a per-player COUNT ticks up. Disconnected players keep
whatever they had typed (it still scores/cancels); reconnecting mid-round
restores their list from the server.
"""

from __future__ import annotations

import time

from core.session import GameSession
from games.blitz.categories import (
    DECKS, DEFAULT_DECK_SLUGS, deck_meta_cached, draw, norm,
)

INTRO_SECONDS = 2.5
REVEAL_BASE_SECONDS = 6.0        # + a little per answer, capped below
REVEAL_MAX_SECONDS = 14.0
UNIQUE_PTS = 10
MAX_ANSWER_LEN = 40
MAX_ANSWERS_PER_ROUND = 50
MAX_TEXTS_PER_MSG = 6            # client batches; server caps the batch

ROUNDS_CHOICES = (5, 8, 12)
SECONDS_CHOICES = (30, 45, 60)


def _clean_display(text: str) -> str:
    """The answer as it will appear on the reveal grid."""
    text = " ".join(str(text).split())
    return text[:MAX_ANSWER_LEN].strip()


class BlitzSession(GameSession):
    MIN_PLAYERS = 2
    MAX_HUMANS = 10
    DEFAULT_SETTINGS = {
        "rounds": 5,
        "seconds": 45,
        "decks": DEFAULT_DECK_SLUGS,
        "spice": "family",           # family = spice-1 weighted | wild = all
    }

    def __init__(self, rng=None):
        super().__init__(rng)
        self.settings["decks"] = list(self.settings["decks"])
        self.g = None

    # ---------------- settings ----------------

    def validate_settings(self, patch):
        ok = {}
        r = patch.get("rounds")
        if isinstance(r, int) and not isinstance(r, bool) and r in ROUNDS_CHOICES:
            ok["rounds"] = r
        s = patch.get("seconds")
        if isinstance(s, int) and not isinstance(s, bool) and s in SECONDS_CHOICES:
            ok["seconds"] = s
        d = patch.get("decks")
        if isinstance(d, list):
            picked = []
            for slug in d:
                if slug in DECKS and slug not in picked:
                    picked.append(slug)
            if picked:                       # never allow an empty deck set
                ok["decks"] = picked
        sp = patch.get("spice")
        if sp in ("family", "wild"):
            ok["spice"] = sp
        return ok

    # ---------------- lifecycle ----------------

    def game_start(self):
        n_rounds = self.settings["rounds"]
        queue = draw(self.settings["decks"], n_rounds,
                     seed=self.rng.randrange(1 << 30),
                     wild=self.settings["spice"] == "wild")
        self.g = {
            "queue": queue,
            "round_no": 0,
            "cat": None,
            "scores": {t: 0 for t in self.participants},
            "answers": {t: [] for t in self.participants},
            "reveal": None,
            "taps": set(),
            "history": [],          # per round: {"cat", "gains": {token: pts}}
            "result": None,
        }
        return self._next_round()

    def _next_round(self):
        g = self.g
        if g["round_no"] >= len(g["queue"]):
            return self._finish()
        g["cat"] = g["queue"][g["round_no"]]
        g["round_no"] += 1
        g["answers"] = {t: [] for t in self.participants}
        g["reveal"] = None
        g["taps"] = set()
        self.phase = "intro"
        self._bump(time.time() + INTRO_SECONDS)
        return [self.fx("round_intro", round=g["round_no"],
                        cat=g["cat"]["cat"],
                        deck=DECKS[g["cat"]["deck"]]["title"])]

    def game_tick(self):
        g = self.g
        if g is None:
            return []
        if self.phase == "intro":
            self.phase = "blitz"
            self._bump(time.time() + self.settings["seconds"])
            return [self.fx("blitz_start")]
        if self.phase == "blitz":
            return self._score_round()
        if self.phase == "reveal":
            return self._next_round()
        return []

    # ---------------- scoring ----------------

    def _score_round(self):
        """The whole point: normalize, cancel matches, score uniques."""
        g = self.g
        owners = {}                             # key -> [tokens], entry order
        for t in self.participants:
            for a in g["answers"][t]:
                owners.setdefault(a["key"], []).append(t)

        groups = {}                             # cancelled key -> group index
        for key, toks in owners.items():
            if len(toks) >= 2:
                groups[key] = len(groups)

        rows, gains, total_answers = [], {}, 0
        for t in self.participants:
            p = self.players.get(t)
            row_answers, gain = [], 0
            for a in g["answers"][t]:
                cancelled = a["key"] in groups
                pts = 0 if cancelled else UNIQUE_PTS
                gain += pts
                withs = [self.players[o].pid for o in owners[a["key"]]
                         if o != t and o in self.players]
                row_answers.append({
                    "text": a["raw"], "pts": pts,
                    "group": groups.get(a["key"]),
                    "with": withs,
                })
                total_answers += 1
            gains[t] = gain
            g["scores"][t] += gain
            rows.append({"pid": p.pid if p else None,
                         "answers": row_answers,
                         "gain": gain, "score": g["scores"][t]})

        g["history"].append({"cat": g["cat"]["cat"],
                             "gains": dict(gains)})
        g["reveal"] = {
            "cat": g["cat"]["cat"],
            "deck": DECKS[g["cat"]["deck"]]["title"],
            "rows": rows,
            "groups": len(groups),
            "last_round": g["round_no"] >= len(g["queue"]),
        }
        self.phase = "reveal"
        secs = min(REVEAL_MAX_SECONDS,
                   REVEAL_BASE_SECONDS + 0.35 * total_answers)
        self._bump(time.time() + secs)
        return [self.fx("reveal", round=g["round_no"], groups=len(groups))]

    def _finish(self):
        g = self.g
        standings = sorted(g["scores"], key=lambda t: -g["scores"][t])
        prev_score, prev_rank, rows = None, 0, []
        for i, t in enumerate(standings):
            sc = g["scores"][t]
            rank = prev_rank if sc == prev_score else i + 1
            prev_score, prev_rank = sc, rank
            p = self.players.get(t)
            rows.append({"pid": p.pid if p else None, "rank": rank, "score": sc})

        best = None                               # best single round callout
        for rno, h in enumerate(g["history"], 1):
            for t, pts in h["gains"].items():
                if pts > 0 and (best is None or pts > best["pts"]):
                    p = self.players.get(t)
                    best = {"pid": p.pid if p else None, "pts": pts,
                            "round": rno, "cat": h["cat"]}

        g["result"] = {"rows": rows,
                       "winner": rows[0]["pid"] if rows else None,
                       "best": best}
        g["cat"] = None
        g["reveal"] = None
        fx = [self.fx("game_over")]
        fx.extend(self.end_game())
        return fx

    # ---------------- actions ----------------

    def game_action(self, token, msg):
        self.seq += 1
        g = self.g
        if g is None:
            return [self.fx("invalid", to=token, msg="Nothing to do right now")]
        t = msg.get("t")
        if t == "answer":
            return self._do_answers(token, msg)
        if t == "retract":
            return self._do_retract(token, msg.get("text"))
        if t == "tap":
            return self._do_tap(token)
        if t == "bs":
            return self._do_bs(token, msg)
        return [self.fx("invalid", to=token, msg="Unknown action")]

    def _do_answers(self, token, msg):
        g = self.g
        if self.phase == "intro":
            return []                       # early Enter — harmless, ignore
        if self.phase != "blitz":
            return [self.fx("invalid", to=token, msg="The sand ran out!")]
        if token not in g["answers"]:
            return [self.fx("invalid", to=token, msg="You're watching this one")]
        texts = msg.get("texts")
        if not isinstance(texts, list):
            texts = [msg.get("text")]
        p = self.players[token]
        mine = g["answers"][token]
        keys = {a["key"] for a in mine}
        fx = []
        for raw in texts[:MAX_TEXTS_PER_MSG]:
            if not isinstance(raw, str):
                continue
            raw = _clean_display(raw)
            key = norm(raw)
            if not key:
                continue
            if key in keys:
                fx.append(self.fx("dupe", to=token, text=raw))
                continue
            if len(mine) >= MAX_ANSWERS_PER_ROUND:
                fx.append(self.fx("invalid", to=token,
                                  msg="That's plenty — save some for the others"))
                break
            keys.add(key)
            mine.append({"raw": raw, "key": key})
            fx.append(self.fx("answered", to=token, text=raw, n=len(mine)))
            fx.append(self.fx("typed", pid=p.pid, n=len(mine)))
        return fx

    def _do_retract(self, token, text):
        g = self.g
        if self.phase != "blitz" or token not in g["answers"]:
            return [self.fx("invalid", to=token, msg="Too late to take it back")]
        key = norm(text) if isinstance(text, str) else ""
        mine = g["answers"][token]
        for i, a in enumerate(mine):
            if a["key"] == key:
                del mine[i]
                p = self.players[token]
                return [self.fx("retracted", to=token, text=a["raw"]),
                        self.fx("typed", pid=p.pid, n=len(mine))]
        return []

    def _tappers(self):
        """Who must tap for the reveal to end: connected participants."""
        return [t for t in self.participants
                if t in self.players and self.players[t].connected]

    def _do_tap(self, token):
        g = self.g
        if self.phase != "reveal" or token not in self.participants:
            return []
        if token in g["taps"]:
            return []
        g["taps"].add(token)
        p = self.players[token]
        need = self._tappers()
        done = [t for t in need if t in g["taps"]]
        fx = [self.fx("tapped", pid=p.pid, n=len(done), need=len(need))]
        if len(done) >= len(need):
            fx.extend(self._next_round())
        return fx

    def _do_bs(self, token, msg):
        """Long-press call-BS: pure theater — a broadcast, no score effect."""
        g = self.g
        if self.phase != "reveal" or token not in self.participants:
            return []
        p = self.players[token]
        target = self.by_pid(msg.get("target"))
        text = msg.get("text")
        text = _clean_display(text) if isinstance(text, str) else ""
        return [self.fx("bs", by=p.pid,
                        target=target.pid if target else None,
                        text=text[:MAX_ANSWER_LEN])]

    # ---------------- connection events ----------------

    def game_player_left(self, token):
        fx = []
        p = self.players.get(token)
        if p:
            fx.append(self.fx("toast", icon="📵",
                              msg="%s dropped — their answers stay in play" % p.name))
        if self.phase == "reveal" and self.g:
            need = self._tappers()
            if need and all(t in self.g["taps"] for t in need):
                fx.extend(self._next_round())
        return fx

    def game_player_back(self, token):
        p = self.players.get(token)
        if not p:
            return []
        # their typed list comes back automatically via state_for
        return [self.fx("toast", icon="🔌", msg="%s is back" % p.name)]

    # ---------------- serialization ----------------

    def state_for(self, viewer_token=None):
        st = super().state_for(viewer_token)
        st["decks"] = deck_meta_cached()
        return st

    def game_state(self, viewer_token):
        g = self.g
        if g is None:
            return None
        st = {
            "kind": "blitz",
            "stage": self.phase,
            "round_no": min(g["round_no"], len(g["queue"])) or 1,
            "rounds": len(g["queue"]),
            "seconds": self.settings["seconds"],
            "cat": g["cat"]["cat"] if g["cat"] else None,
            "deck": DECKS[g["cat"]["deck"]]["title"] if g["cat"] else None,
            "spice": g["cat"]["spice"] if g["cat"] else None,
            "order": [self.players[t].pid for t in self.participants
                      if t in self.players],
            "scores": {self.players[t].pid: s for t, s in g["scores"].items()
                       if t in self.players},
            "counts": {self.players[t].pid: len(a)
                       for t, a in g["answers"].items() if t in self.players},
            "mine": None,          # ONLY your own answers, and only pre-reveal
            "reveal": None,
            "taps": None,
            "result": g["result"],
        }
        if self.phase in ("intro", "blitz") and viewer_token in g["answers"]:
            st["mine"] = [a["raw"] for a in g["answers"][viewer_token]]
        if self.phase == "reveal" and g["reveal"]:
            st["reveal"] = g["reveal"]
            need = self._tappers()
            st["taps"] = {
                "tapped": [self.players[t].pid for t in g["taps"]
                           if t in self.players],
                "done": len([t for t in need if t in g["taps"]]),
                "need": len(need),
            }
        return st
