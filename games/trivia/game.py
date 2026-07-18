"""TRIVIA BUZZER — pub-quiz for the living room, phones as buzzers.

Two modes:
    buzzer  the question opens for everyone; first buzz (server-ordered — the
            binding's lock means first-processed wins) freezes the room and
            gives the buzzer 6s to answer. Wrong/timeout: -50, locked out,
            the question re-opens for the others on the remaining 20s clock.
    race    everyone answers independently within 12s; faster correct answers
            score more (100 down to 50), wrong = 0.

Between questions: a 3s reveal beat; every 5 questions a full standings
interstitial. No bots — trivia is about what's in YOUR head.
"""

from __future__ import annotations

import time

from core.session import GameSession
from games.trivia import questions

QUESTION_SECONDS = 20    # buzzer mode: total clock per question
ANSWER_SECONDS = 6       # buzzer mode: time to pick after buzzing
RACE_SECONDS = 12        # race mode: everyone answers within this
REVEAL_SECONDS = 3
STANDINGS_SECONDS = 6

BUZZ_BASE = 100          # correct answer after a buzz
SPEED_MAX = 50           # extra, scaled by how fast the buzz came
WRONG_PENALTY = 50       # wrong answer or answer timeout after buzzing
RACE_MAX = 100           # instant correct answer in race mode
RACE_MIN = 50            # last-moment correct answer in race mode

ROUND_CHOICES = (10, 15, 20)
DEV_ROUNDS = 4           # hidden short match for tests; not in the UI


class TriviaSession(GameSession):
    MIN_PLAYERS = 2
    MAX_HUMANS = 10
    DEFAULT_SETTINGS = {
        "mode": "buzzer",        # buzzer | race
        "rounds": 10,            # questions per match
        "cat": "mixed",          # mixed | category slug
        "diff": "family",        # family (diff 1-2, kid-weighted) | all
    }

    def __init__(self, rng=None):
        super().__init__(rng)
        self.g = None
        self.seen_keys = set()   # asked in recent matches; avoid instant repeats

    def validate_settings(self, patch):
        ok = {}
        if patch.get("mode") in ("buzzer", "race"):
            ok["mode"] = patch["mode"]
        r = patch.get("rounds")
        if r in ROUND_CHOICES or r == DEV_ROUNDS:
            ok["rounds"] = r
        if patch.get("cat") == "mixed" or patch.get("cat") in questions.CAT_SLUGS:
            ok["cat"] = patch["cat"]
        if patch.get("diff") in ("family", "all"):
            ok["diff"] = patch["diff"]
        return ok

    # ---------------- lifecycle ----------------

    def game_start(self):
        n = self.settings["rounds"]
        drawn = questions.draw(n, self.rng, cat=self.settings["cat"],
                               family=self.settings["diff"] == "family",
                               exclude=self.seen_keys)
        if len(self.seen_keys) > len(questions.BANK) // 2:
            self.seen_keys = set()          # let old material cycle back
        self.seen_keys.update(questions.key(e) for e in drawn)
        cat_meta = {c["slug"]: c for c in questions.categories()}
        queue = []
        for e in drawn:
            order = list(range(4))
            self.rng.shuffle(order)
            meta = cat_meta[e["cat"]]
            queue.append({
                "q": e["q"], "diff": e["diff"],
                "cat": meta["title"], "icon": meta["icon"],
                "choices": [e["choices"][i] for i in order],
                "correct": order.index(e["a"]),
            })
        self.g = {
            "mode": self.settings["mode"],
            "queue": queue,
            "total": len(queue),
            "qno": 0,
            "scores": {t: 0 for t in self.participants},
            "q": None,           # runtime state of the live question
            "reveal": None,
            "result": None,
        }
        return self._next_question()

    def _next_question(self):
        g = self.g
        if g["qno"] >= g["total"]:
            return self._finish()
        g["qno"] += 1
        now = time.time()
        card = g["queue"][g["qno"] - 1]
        g["reveal"] = None
        g["q"] = {
            "card": card,
            "start": now,
            "q_deadline": now + QUESTION_SECONDS,   # buzzer master clock
            "buzzer": None,       # token currently answering (buzzer mode)
            "buzz_at": None,
            "locked": set(),      # tokens locked out of this question
            "picks": {},          # race: token -> {i, pts}
            "deltas": [],         # [{pid, pts}] accumulated this question
        }
        self.phase = "question"
        self._bump(now + (RACE_SECONDS if g["mode"] == "race" else QUESTION_SECONDS))
        return [self.fx("question", qno=g["qno"], total=g["total"])]

    def game_tick(self):
        g = self.g
        if g is None:
            return []
        if self.phase == "question":
            # clock ran out: race -> score the picks; buzzer -> nobody buzzed
            return self._reveal(None, 0)
        if self.phase == "answer":
            # the buzzer froze — same as a wrong answer
            return self._buzz_fail(g["q"]["buzzer"], timeout=True)
        if self.phase == "reveal":
            if g["qno"] < g["total"] and g["qno"] % 5 == 0:
                self.phase = "standings"
                self._bump(time.time() + STANDINGS_SECONDS)
                return [self.fx("standings")]
            return self._next_question()
        if self.phase == "standings":
            return self._next_question()
        return []

    # ---------------- actions ----------------

    def game_action(self, token, msg):
        self.seq += 1
        g = self.g
        if g is None or self.phase not in ("question", "answer"):
            return [self.fx("invalid", to=token, msg="Nothing to do right now")]
        if token not in g["scores"]:
            return [self.fx("invalid", to=token, msg="You're watching this one")]
        t = msg.get("t")
        if t == "buzz":
            return self._do_buzz(token)
        if t == "pick":
            return self._do_pick(token, msg.get("i"))
        return [self.fx("invalid", to=token, msg="Unknown action")]

    def _do_buzz(self, token):
        g = self.g
        q = g["q"]
        if g["mode"] != "buzzer":
            return [self.fx("invalid", to=token, msg="No buzzers in race mode — just answer!")]
        if self.phase != "question":
            # someone already holds the floor — private, not an error toast
            return [self.fx("too_late", to=token)]
        if token in q["locked"]:
            return [self.fx("invalid", to=token, msg="You're locked out of this one")]
        now = time.time()
        q["buzzer"] = token
        q["buzz_at"] = now
        self.phase = "answer"
        self._bump(now + ANSWER_SECONDS)
        p = self.players[token]
        return [self.fx("buzz", pid=p.pid,
                        ms=int((now - q["start"]) * 1000))]

    def _do_pick(self, token, i):
        g = self.g
        q = g["q"]
        if not isinstance(i, int) or isinstance(i, bool) or not 0 <= i <= 3:
            return [self.fx("invalid", to=token, msg="Pick a real answer")]
        if g["mode"] == "buzzer":
            if self.phase != "answer" or token != q["buzzer"]:
                return [self.fx("invalid", to=token, msg="Buzz first!")]
            if i == q["card"]["correct"]:
                rem = max(0.0, q["q_deadline"] - q["buzz_at"])
                pts = BUZZ_BASE + min(SPEED_MAX,
                                      int(SPEED_MAX * rem / QUESTION_SECONDS))
                g["scores"][token] += pts
                q["deltas"].append({"pid": self.players[token].pid, "pts": pts})
                fx = [self.fx("correct", pid=self.players[token].pid, pts=pts)]
                fx.extend(self._reveal(token, pts))
                return fx
            return self._buzz_fail(token)
        # race mode
        if self.phase != "question":
            return [self.fx("invalid", to=token, msg="Time's up")]
        if token in q["picks"]:
            return [self.fx("invalid", to=token, msg="Answer locked in")]
        now = time.time()
        rem = max(0.0, (q["start"] + RACE_SECONDS) - now)
        ok = i == q["card"]["correct"]
        pts = RACE_MIN + int((RACE_MAX - RACE_MIN) * rem / RACE_SECONDS) if ok else 0
        q["picks"][token] = {"i": i, "pts": pts}
        fx = [self.fx("picked", to=token, i=i),
              self.fx("race_pick", pid=self.players[token].pid,
                      n=len(q["picks"]))]
        if self._race_all_in():
            fx.extend(self._reveal(None, 0))
        return fx

    def _race_all_in(self):
        g = self.g
        q = g["q"]
        for t in g["scores"]:
            p = self.players.get(t)
            if p is not None and p.connected and t not in q["picks"]:
                return False
        return True

    def _buzz_fail(self, token, timeout=False):
        """Wrong answer or answer-window timeout in buzzer mode."""
        g = self.g
        q = g["q"]
        q["locked"].add(token)
        g["scores"][token] -= WRONG_PENALTY
        p = self.players.get(token)
        pid = p.pid if p else None
        q["deltas"].append({"pid": pid, "pts": -WRONG_PENALTY})
        q["buzzer"] = None
        q["buzz_at"] = None
        fx = [self.fx("wrong", pid=pid, timeout=timeout, pts=-WRONG_PENALTY)]
        now = time.time()
        eligible = [t for t in g["scores"]
                    if t not in q["locked"]
                    and t in self.players and self.players[t].connected]
        remaining = q["q_deadline"] - now
        if eligible and remaining > 0.5:
            self.phase = "question"
            self._bump(q["q_deadline"])
            fx.append(self.fx("reopen", left=len(eligible)))
        else:
            fx.extend(self._reveal(None, 0))
        return fx

    # ---------------- reveal / finish ----------------

    def _reveal(self, winner_token, pts):
        g = self.g
        q = g["q"]
        if g["mode"] == "race":
            # apply the stashed pick scores now (hidden until reveal)
            for t, pk in q["picks"].items():
                if pk["pts"]:
                    g["scores"][t] += pk["pts"]
                p = self.players.get(t)
                q["deltas"].append({"pid": p.pid if p else None,
                                    "pts": pk["pts"], "pick": pk["i"]})
        winner = self.players.get(winner_token) if winner_token else None
        g["reveal"] = {
            "correct": q["card"]["correct"],
            "by": winner.pid if winner else None,
            "pts": pts,
            "deltas": list(q["deltas"]),
            "last": g["qno"] >= g["total"],
        }
        self.phase = "reveal"
        self._bump(time.time() + REVEAL_SECONDS)
        return [self.fx("reveal", correct=q["card"]["correct"],
                        by=g["reveal"]["by"])]

    def _standings_rows(self):
        g = self.g
        order = sorted(g["scores"], key=lambda t: -g["scores"][t])
        prev_score, prev_rank, rows = None, 0, []
        for i, t in enumerate(order):
            sc = g["scores"][t]
            rank = prev_rank if sc == prev_score else i + 1
            prev_score, prev_rank = sc, rank
            p = self.players.get(t)
            rows.append({"pid": p.pid if p else None, "rank": rank, "score": sc})
        return rows

    def _finish(self):
        g = self.g
        rows = self._standings_rows()
        g["result"] = {"rows": rows,
                       "winner": rows[0]["pid"] if rows else None}
        g["q"] = None
        g["reveal"] = None
        fx = [self.fx("game_over")]
        fx.extend(self.end_game())
        return fx

    # ---------------- connection events ----------------

    def game_player_left(self, token):
        g = self.g
        fx = []
        if g is None or g["q"] is None or token not in g["scores"]:
            return fx
        q = g["q"]
        if g["mode"] == "buzzer" and self.phase == "answer" and token == q["buzzer"]:
            p = self.players.get(token)
            fx.append(self.fx("toast", icon="📵",
                              msg="%s dropped mid-answer" % (p.name if p else "Player")))
            fx.extend(self._buzz_fail(token, timeout=True))
        elif g["mode"] == "race" and self.phase == "question" and self._race_all_in():
            fx.extend(self._reveal(None, 0))
        return fx

    def game_player_back(self, token):
        p = self.players.get(token)
        if p:
            return [self.fx("toast", icon="🔌", msg="%s is back" % p.name)]
        return []

    # ---------------- serialization ----------------

    def state_for(self, viewer_token=None):
        st = super().state_for(viewer_token)
        st["cats"] = questions.categories()     # lobby picker, no extra fetch
        return st

    def game_state(self, viewer_token):
        g = self.g
        if g is None:
            return None
        st = {
            "kind": "trivia",
            "stage": self.phase,
            "mode": g["mode"],
            "qno": g["qno"],
            "total": g["total"],
            "question_seconds": QUESTION_SECONDS,
            "answer_seconds": ANSWER_SECONDS,
            "race_seconds": RACE_SECONDS,
            "scores": {self.players[t].pid: s for t, s in g["scores"].items()
                       if t in self.players},
            "order": [self.players[t].pid for t in g["scores"]
                      if t in self.players],
            "q": None,
            "buzzer": None,
            "locked": [],
            "answered": [],
            "you_locked": False,
            "you_buzzed": False,
            "your_pick": None,
            "q_deadline": None,
            "reveal": None,
            "standings": None,
            "result": g["result"],
        }
        q = g["q"]
        if q is not None:
            card = q["card"]
            st["q"] = {"text": card["q"], "choices": card["choices"],
                       "cat": card["cat"], "icon": card["icon"],
                       "diff": card["diff"]}
            st["q_deadline"] = int(q["q_deadline"] * 1000)
            st["locked"] = [self.players[t].pid for t in q["locked"]
                            if t in self.players]
            st["you_locked"] = viewer_token in q["locked"]
            if q["buzzer"] and q["buzzer"] in self.players:
                st["buzzer"] = self.players[q["buzzer"]].pid
            st["you_buzzed"] = q["buzzer"] is not None and viewer_token == q["buzzer"]
            st["answered"] = [self.players[t].pid for t in q["picks"]
                              if t in self.players]
            if viewer_token in q["picks"]:
                st["your_pick"] = q["picks"][viewer_token]["i"]
        if self.phase == "reveal" and g["reveal"]:
            st["reveal"] = g["reveal"]
        if self.phase == "standings":
            st["standings"] = self._standings_rows()
        return st
