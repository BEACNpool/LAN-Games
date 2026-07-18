"""Checkers session — thin DuelSession wrapper over games/checkers/engine.py
(American rules: forced captures by default, toggleable as a house rule;
no flying kings; crowning ends the move)."""

from __future__ import annotations

from core.duel import DuelSession
from games.checkers import engine


class CheckersSession(DuelSession):
    SEAT_COLORS = ("w", "b")          # white moves first, sits at the bottom
    DEFAULT_SETTINGS = {"difficulty": "sharp", "turn_seconds": 0,
                        "forced": True}

    def validate_settings(self, patch):
        ok = super().validate_settings(patch)
        if isinstance(patch.get("forced"), bool):
            ok["forced"] = patch["forced"]
        return ok

    # ---------------- duel hooks ----------------

    def duel_start(self):
        self.d = engine.new_game()
        self.hist = []
        return [self.fx("board")]

    def current_color(self):
        if self.g["result"] is not None or self.d["result"] is not None:
            return None
        return self.d["turn"]

    def _apply(self, move, color):
        self.hist.append(self.d)
        self.d = engine.apply_move(self.d, move,
                                   forced=self.settings["forced"])
        captured = len(move) > 2 or abs(move[0] - move[1]) > 9
        fx = [self.fx("moved", path=list(move), by=color, capture=captured)]
        res = self.d["result"]
        if res is not None:
            if res == "draw":
                fx.extend(self.finish(None, "40 moves without progress"))
            else:
                why = "no moves left" if any(
                    v for v in self.d["board"]) else "all pieces captured"
                fx.extend(self.finish(res, why))
        return fx

    def duel_move(self, token, color, msg):
        path = msg.get("path")
        if not (isinstance(path, list) and 2 <= len(path) <= 12
                and all(isinstance(x, int) and not isinstance(x, bool)
                        and 0 <= x < 64 for x in path)):
            return [self.fx("invalid", to=token, msg="Bad move")]
        legal = engine.legal_moves(self.d, forced=self.settings["forced"])
        if path not in legal:
            msg_txt = "Captures are forced" if self.settings["forced"] and \
                any(len(m) > 2 or abs(m[0] - m[1]) > 9 for m in legal) \
                else "Illegal move"
            return [self.fx("invalid", to=token, msg=msg_txt)]
        return self._apply(path, color)

    def duel_auto(self, color):
        move = engine.choose(self.d, self.settings["difficulty"], self.rng,
                             forced=self.settings["forced"])
        return self._apply(move, color)

    def duel_takeback(self, color):
        pops = 1 if self.current_color() != color else 2
        for _ in range(min(pops, len(self.hist))):
            self.d = self.hist.pop()
        return [self.fx("board"), self.fx("toast", icon="↩️", msg="Takeback")]

    def duel_state(self, viewer_token):
        legal = [] if self.d["result"] is not None else \
            engine.legal_moves(self.d, forced=self.settings["forced"])
        return {
            "kind": "checkers",
            "board": list(self.d["board"]),
            "legal": legal,
            "forced": self.settings["forced"],
            "clock": self.d["clock"],
        }
