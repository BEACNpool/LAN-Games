"""Backgammon session — DuelSession wrapper over games/backgammon/engine.py.

The session owns the dice: it rolls the opening (two different dice decide
who starts and become that player's roll) and re-rolls after every turn.
Players submit their COMPLETE turn as steps [[src,dst],...]; the engine
enforces both-dice/higher-die/bear-off rules. Dances (no legal play) are
applied automatically so the game never waits on an impossible move.
No doubling cube in v1; no takebacks (dice are sacred), no draw offers.
"""

from __future__ import annotations

from core.duel import DuelSession
from games.backgammon import engine

MAX_AUTO_DANCES = 20     # safety valve for pathological dance chains


class BackgammonSession(DuelSession):
    SEAT_COLORS = ("w", "b")
    SUPPORTS_TAKEBACK = False
    SUPPORTS_DRAW = False
    DEFAULT_SETTINGS = {"difficulty": "sharp", "turn_seconds": 0}

    # ---------------- helpers ----------------

    def _roll(self):
        return [self.rng.randint(1, 6), self.rng.randint(1, 6)]

    def _is_pass_turn(self, turns):
        return len(turns) == 0 or turns == [[]] or turns == [()]

    def _start_next_turn(self, fx):
        """Roll for the player to move; auto-apply forced dances."""
        for _ in range(MAX_AUTO_DANCES):
            dice = self._roll()
            self.d = engine.start_turn(self.d, dice)
            fx.append(self.fx("rolled", dice=list(dice), turn=self.d["turn"]))
            turns = engine.legal_turns(self.d)
            if not self._is_pass_turn(turns):
                return fx
            color = self.d["turn"]
            p = self.players.get(self.token_of(color))
            fx.append(self.fx("toast", icon="🎲",
                              msg="%s can't move — dance!" % (p.name if p else color)))
            self.d = engine.apply_turn(self.d, [])
            if self.d["result"] is not None:
                break
        return fx

    # ---------------- duel hooks ----------------

    def duel_start(self):
        d1, d2 = self._roll()
        while d1 == d2:
            d1, d2 = self._roll()
        first = "w" if d1 > d2 else "b"
        self.d = engine.new_game(first=first)
        fx = [self.fx("toast", icon="🎲",
                      msg="Opening roll %d-%d — %s starts"
                          % (d1, d2, "White" if first == "w" else "Black"))]
        self.d = engine.start_turn(self.d, [d1, d2])
        turns = engine.legal_turns(self.d)
        if self._is_pass_turn(turns):
            self.d = engine.apply_turn(self.d, [])
            self._start_next_turn(fx)
        return fx

    def current_color(self):
        if self.g["result"] is not None or self.d["result"] is not None:
            return None
        return self.d["turn"]

    def _finish_if_over(self, fx):
        res = self.d["result"]
        if res is not None:
            kind = res["kind"]
            why = {"single": "borne off all 15",
                   "gammon": "GAMMON — opponent never got one off",
                   "backgammon": "BACKGAMMON — total shutout"}[kind]
            fx.extend(self.finish(res["winner"], why))
        return fx

    def duel_move(self, token, color, msg):
        steps_raw = msg.get("steps")
        if not isinstance(steps_raw, list) or len(steps_raw) > 4:
            return [self.fx("invalid", to=token, msg="Bad turn")]
        steps = []
        for st in steps_raw:
            if not (isinstance(st, (list, tuple)) and len(st) == 2):
                return [self.fx("invalid", to=token, msg="Bad turn")]
            src, dst = st
            if not ((src == "bar" or (isinstance(src, int) and 0 <= src < 24))
                    and (dst == "off" or (isinstance(dst, int) and 0 <= dst < 24))):
                return [self.fx("invalid", to=token, msg="Bad turn")]
            steps.append((src, dst))
        try:
            self.d = engine.apply_turn(self.d, steps)
        except ValueError as e:
            return [self.fx("invalid", to=token, msg=str(e) or "Illegal turn")]
        fx = [self.fx("moved", steps=[list(s) for s in steps], by=color)]
        self._finish_if_over(fx)
        if self.phase == "playing":
            self._start_next_turn(fx)
            self._finish_if_over(fx)
        return fx

    def duel_auto(self, color):
        turns = engine.legal_turns(self.d)
        if self._is_pass_turn(turns):
            self.d = engine.apply_turn(self.d, [])
            fx = [self.fx("toast", icon="🎲", msg="No move possible — pass")]
        else:
            turn = engine.choose(self.d, self.settings["difficulty"], self.rng)
            self.d = engine.apply_turn(self.d, list(turn))
            fx = [self.fx("moved", steps=[list(s) for s in turn], by=color)]
        self._finish_if_over(fx)
        if self.phase == "playing":
            self._start_next_turn(fx)
            self._finish_if_over(fx)
        return fx

    def duel_state(self, viewer_token):
        turns = []
        if self.d["result"] is None and self.d.get("remaining"):
            turns = [[list(s) for s in t] for t in engine.legal_turns(self.d)
                     if t]
            turns = turns[:400]
        return {
            "kind": "backgammon",
            "points": list(self.d["points"]),
            "bar": dict(self.d["bar"]),
            "off": dict(self.d["off"]),
            "dice": list(self.d["dice"]) if self.d.get("dice") else None,
            "remaining": list(self.d.get("remaining") or []),
            "turns": turns,
            "pips": {"w": engine.pip_count(self.d, "w"),
                     "b": engine.pip_count(self.d, "b")},
        }
