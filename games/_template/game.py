"""_template — HIGH CARD, the smallest possible complete hub game.

Copy this directory to games/<yourgame>/ and grow it. It demonstrates every
hook a game needs:

  phases        game_start() -> "drawing" -> "reveal" -> ... -> end_game()
  actions       game_action() validating token/turn/phase
  timers        game_tick() on deadline expiry (auto-draw for the slow)
  masking       game_state() hides other players' cards until reveal
  results       session.end_game() shows results, auto-returns to lobby

Rules: 3 rounds. Everyone draws a card each round; highest card wins the
round (+1 point). Most points after 3 rounds wins.
"""

from __future__ import annotations

import time

from core.session import GameSession

RANKS = "23456789TJQKA"
SUITS = "SHDC"
ROUNDS = 3
DRAW_SECONDS = 15
REVEAL_SECONDS = 5


class HighCardSession(GameSession):
    MIN_PLAYERS = 2
    MAX_HUMANS = 8
    DEFAULT_SETTINGS = {}

    def __init__(self, rng=None):
        super().__init__(rng)
        self.g = None

    def game_start(self):
        self.g = {"round": 0, "points": {t: 0 for t in self.participants},
                  "cards": {}, "result": None}
        return self._next_round()

    def _next_round(self):
        self.g["round"] += 1
        self.g["cards"] = {}
        self.phase = "drawing"
        self._bump(time.time() + DRAW_SECONDS)
        return [self.fx("round", n=self.g["round"], total=ROUNDS)]

    def _draw(self, token):
        card = self.rng.choice(RANKS) + self.rng.choice(SUITS)
        self.g["cards"][token] = card
        return card

    def game_action(self, token, msg):
        if msg.get("t") != "draw" or self.phase != "drawing":
            return [self.fx("invalid", to=token, msg="Nothing to do")]
        if token not in self.participants or token in self.g["cards"]:
            return [self.fx("invalid", to=token, msg="Already drew")]
        self._draw(token)
        fx = [self.fx("drew", pid=self.players[token].pid)]
        if len(self.g["cards"]) == len(self.participants):
            fx.extend(self._reveal())
        return fx

    def game_tick(self):
        if self.phase == "drawing":
            # timeout: draw for the stragglers
            for t in self.participants:
                if t not in self.g["cards"]:
                    self._draw(t)
            return self._reveal()
        if self.phase == "reveal":
            if self.g["round"] >= ROUNDS:
                self.g["result"] = sorted(
                    ({"pid": self.players[t].pid, "points": p}
                     for t, p in self.g["points"].items() if t in self.players),
                    key=lambda e: -e["points"])
                return self.end_game()
            return self._next_round()
        return []

    def _reveal(self):
        cards = self.g["cards"]
        # ties share the point — never award by draw order (a lesson from
        # wordclash's tie-aware podium; copy this instinct into new games)
        top = max(RANKS.index(c[0]) for c in cards.values())
        winners = [t for t, c in cards.items() if RANKS.index(c[0]) == top]
        for t in winners:
            self.g["points"][t] += 1
        self.phase = "reveal"
        self._bump(time.time() + REVEAL_SECONDS)
        return [self.fx("reveal",
                        winner=self.players[winners[0]].pid,
                        winners=[self.players[t].pid for t in winners])]

    def game_state(self, viewer_token):
        g = self.g
        if g is None:
            return None
        revealed = self.phase in ("reveal", "game_end")
        return {
            "kind": "highcard",
            "stage": self.phase,
            "round": g["round"],
            "rounds": ROUNDS,
            # mask: you see your own card always, others only after reveal
            "cards": {self.players[t].pid: (c if revealed or t == viewer_token else "??")
                      for t, c in g["cards"].items() if t in self.players},
            "points": {self.players[t].pid: p
                       for t, p in g["points"].items() if t in self.players},
            "you_drew": viewer_token in g["cards"],
            "result": g["result"],
        }
