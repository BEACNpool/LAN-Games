"""Charades — one actor, everyone else races to type the answer.

Everyone is physically in the room watching the actor; the phones are just
the secret card, the buzzer, and the scoreboard. Two modes:

    classic  one subject per turn — first correct guess ends it, big reveal
    blitz    the actor chains through as many subjects as the timer allows

The actor rotates every turn; a "round" = everyone has acted once. No bots
(a bot can neither act nor watch). Matching is server-side on normalized
text (case/punctuation/accents/leading articles ignored) with per-item
aliases from decks.py, plus a private "so close!" ping for near misses.
"""

from __future__ import annotations

import time

from core.session import GameSession
from games.charades.decks import DECKS, deck_list, norm

INTRO_SECONDS = 4
REVEAL_SECONDS = 6
CLASSIC_SKIPS = 2
BLITZ_SKIPS = 5
MAX_GUESS_LEN = 48

# scoring
CLASSIC_GUESS = 100
CLASSIC_SPEED_MAX = 50
CLASSIC_ACTOR = 50
BLITZ_GUESS = 60
BLITZ_ACTOR = 25


def close_enough(guess: str, answer: str) -> bool:
    """Near-miss check for the 'so close!' ping: edit distance <= 1
    (2 for long answers), on already-normalized strings."""
    if not guess or not answer or guess == answer:
        return False
    limit = 2 if len(answer) >= 8 else 1
    if abs(len(guess) - len(answer)) > limit:
        return False
    prev = list(range(len(answer) + 1))
    for i, gc in enumerate(guess, 1):
        cur = [i]
        best = i
        for j, ac in enumerate(answer, 1):
            cur.append(min(prev[j] + 1, cur[-1] + 1,
                           prev[j - 1] + (gc != ac)))
            best = min(best, cur[-1])
        if best > limit:
            return False
        prev = cur
    return prev[-1] <= limit


class CharadesSession(GameSession):
    MIN_PLAYERS = 2          # playable at 2, sings at 3+
    MAX_HUMANS = 10
    DEFAULT_SETTINGS = {
        "deck": "mix",
        "mode": "classic",       # classic | blitz
        "turn_seconds": 75,      # acting time per turn
        "rounds": 2,             # full actor rotations per game
    }

    def __init__(self, rng=None):
        super().__init__(rng)
        self.g = None

    def validate_settings(self, patch):
        ok = {}
        if patch.get("deck") in DECKS:
            ok["deck"] = patch["deck"]
        if patch.get("mode") in ("classic", "blitz"):
            ok["mode"] = patch["mode"]
        ts = patch.get("turn_seconds")
        if isinstance(ts, int) and not isinstance(ts, bool) and 30 <= ts <= 150:
            ok["turn_seconds"] = ts
        r = patch.get("rounds")
        if isinstance(r, int) and not isinstance(r, bool) and 1 <= r <= 4:
            ok["rounds"] = r
        return ok

    # ---------------- lifecycle ----------------

    def game_start(self):
        order = list(self.participants)
        self.rng.shuffle(order)
        deck = DECKS[self.settings["deck"]]
        items = list(deck["items"])
        self.rng.shuffle(items)
        self.g = {
            "order": order,
            "mode": self.settings["mode"],
            "deck_slug": self.settings["deck"],
            "deck_title": deck["title"],
            "queue": items,          # pre-shuffled; pop() = next subject
            "used": [],
            "round_no": 0,
            "turn_no": 0,            # global turn counter
            "scores": {t: 0 for t in order},
            "turn": None,
            "reveal": None,
            "result": None,
        }
        return self._next_turn()

    def _draw_subject(self):
        g = self.g
        if not g["queue"]:               # deck exhausted: reshuffle the used
            g["queue"] = list(g["used"])
            self.rng.shuffle(g["queue"])
            g["used"] = []
        item = g["queue"].pop()
        g["used"].append(item)
        parts = item.split("|")
        return {"display": parts[0],
                "answers": {norm(p) for p in parts if norm(p)}}

    def _next_turn(self):
        g = self.g
        n = len(g["order"])
        g["round_no"] = g["turn_no"] // n + 1
        if g["round_no"] > self.settings["rounds"]:
            return self._finish()
        actor = g["order"][g["turn_no"] % n]
        g["turn_no"] += 1
        subject = self._draw_subject()
        g["turn"] = {
            "actor": actor,
            "subject": subject,
            "skips_left": BLITZ_SKIPS if g["mode"] == "blitz" else CLASSIC_SKIPS,
            "solved": [],            # blitz: [{word, by(pid), pts}]
            "start": None,
        }
        g["reveal"] = None
        self.phase = "intro"
        self._bump(time.time() + INTRO_SECONDS)
        p = self.players[actor]
        return [self.fx("turn_intro", pid=p.pid,
                        round=g["round_no"], turn=g["turn_no"])]

    def game_tick(self):
        g = self.g
        if g is None:
            return []
        if self.phase == "intro":
            self.phase = "acting"
            g["turn"]["start"] = time.time()
            self._bump(time.time() + self.settings["turn_seconds"])
            return [self.fx("acting")]
        if self.phase == "acting":
            return self._end_turn(None)          # time ran out
        if self.phase == "reveal":
            return self._next_turn()
        return []

    def _end_turn(self, winner_token):
        """Close the acting phase. winner_token is the classic-mode solver
        (None on timeout); blitz results live in turn['solved']."""
        g = self.g
        t = g["turn"]
        actor = self.players[t["actor"]]
        g["reveal"] = {
            "subject": t["subject"]["display"],
            "actor": actor.pid,
            "winner": self.players[winner_token].pid if winner_token else None,
            "solved": list(t["solved"]),
            "last_turn": g["turn_no"] >= len(g["order"]) * self.settings["rounds"],
        }
        self.phase = "reveal"
        self._bump(time.time() + REVEAL_SECONDS)
        return [self.fx("reveal", subject=t["subject"]["display"],
                        winner=g["reveal"]["winner"])]

    def _finish(self):
        g = self.g
        standings = sorted(g["order"], key=lambda t: -g["scores"][t])
        prev_score, prev_rank, rows = None, 0, []
        for i, t in enumerate(standings):
            sc = g["scores"][t]
            rank = prev_rank if sc == prev_score else i + 1
            prev_score, prev_rank = sc, rank
            p = self.players.get(t)
            rows.append({"pid": p.pid if p else None, "rank": rank, "score": sc})
        g["result"] = {"rows": rows, "winner": rows[0]["pid"] if rows else None}
        g["turn"] = None
        fx = [self.fx("game_over")]
        fx.extend(self.end_game())
        return fx

    # ---------------- actions ----------------

    def game_action(self, token, msg):
        self.seq += 1
        g = self.g
        if g is None or self.phase not in ("acting", "intro"):
            return [self.fx("invalid", to=token, msg="Nothing to do right now")]
        if token not in g["order"]:
            return [self.fx("invalid", to=token, msg="You're watching this one")]
        t = msg.get("t")
        if t == "guess":
            return self._do_guess(token, msg.get("text"))
        if t == "skip":
            return self._do_skip(token)
        return [self.fx("invalid", to=token, msg="Unknown action")]

    def _do_guess(self, token, text):
        g = self.g
        turn = g["turn"]
        if self.phase != "acting":
            return []                     # guesses during intro are just early
        if token == turn["actor"]:
            return [self.fx("invalid", to=token, msg="You're the actor — act!")]
        if not isinstance(text, str):
            return []
        text = text.strip()[:MAX_GUESS_LEN]
        guess = norm(text)
        if not guess:
            return []
        p = self.players[token]
        if guess in turn["subject"]["answers"]:
            if g["mode"] == "blitz":
                g["scores"][token] += BLITZ_GUESS
                g["scores"][turn["actor"]] += BLITZ_ACTOR
                turn["solved"].append({"word": turn["subject"]["display"],
                                       "by": p.pid, "pts": BLITZ_GUESS})
                turn["subject"] = self._draw_subject()
                return [self.fx("solved", pid=p.pid,
                                word=turn["solved"][-1]["word"],
                                pts=BLITZ_GUESS, chain=len(turn["solved"]))]
            total = self.settings["turn_seconds"]
            rem = max(0.0, (turn["start"] + total) - time.time())
            pts = CLASSIC_GUESS + int(CLASSIC_SPEED_MAX * rem / total)
            g["scores"][token] += pts
            g["scores"][turn["actor"]] += CLASSIC_ACTOR
            fx = [self.fx("solved", pid=p.pid,
                          word=turn["subject"]["display"], pts=pts)]
            fx.extend(self._end_turn(token))
            return fx
        # wrong: everyone sees it fly by; near misses get a private nudge
        fx = [self.fx("guess", pid=p.pid, text=text)]
        if any(close_enough(guess, a) for a in turn["subject"]["answers"]):
            fx.append(self.fx("close", to=token))
        return fx

    def _do_skip(self, token):
        g = self.g
        turn = g["turn"]
        if self.phase != "acting" or token != turn["actor"]:
            return [self.fx("invalid", to=token, msg="Only the actor can skip")]
        if turn["skips_left"] <= 0:
            return [self.fx("invalid", to=token, msg="No skips left — act it out!")]
        turn["skips_left"] -= 1
        skipped = turn["subject"]["display"]
        turn["subject"] = self._draw_subject()
        return [self.fx("skipped", word=skipped, left=turn["skips_left"])]

    # ---------------- connection events ----------------

    def game_player_left(self, token):
        g = self.g
        fx = []
        if g and g["turn"] and token == g["turn"]["actor"] \
                and self.phase in ("intro", "acting"):
            p = self.players[token]
            fx.append(self.fx("toast", icon="🎭",
                              msg="%s left the stage — skipping their turn" % p.name))
            fx.extend(self._end_turn(None))
        return fx

    # ---------------- serialization ----------------

    def game_state(self, viewer_token):
        g = self.g
        if g is None:
            return None
        turn = g["turn"]
        st = {
            "kind": "charades",
            "stage": self.phase,
            "mode": g["mode"],
            "deck": g["deck_title"],
            "round_no": min(g["round_no"], self.settings["rounds"]),
            "rounds": self.settings["rounds"],
            "turn_no": g["turn_no"],
            "turns_total": len(g["order"]) * self.settings["rounds"],
            "turn_seconds": self.settings["turn_seconds"],
            "scores": {self.players[t].pid: s for t, s in g["scores"].items()
                       if t in self.players},
            "order": [self.players[t].pid for t in g["order"] if t in self.players],
            "actor": None,
            "you_act": False,
            "subject": None,          # ONLY the actor ever sees this live
            "skips_left": None,
            "chain": None,
            "reveal": g["reveal"],
            "result": g["result"],
        }
        if turn:
            actor_p = self.players.get(turn["actor"])
            st["actor"] = actor_p.pid if actor_p else None
            st["you_act"] = viewer_token == turn["actor"]
            st["chain"] = len(turn["solved"]) if g["mode"] == "blitz" else None
            if st["you_act"]:
                st["subject"] = turn["subject"]["display"]
                st["skips_left"] = turn["skips_left"]
        return st
