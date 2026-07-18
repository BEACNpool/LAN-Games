"""Connect Four — 7x6, drop a disc, four in a row wins. The palate
cleanser between longer games; also the simplest DuelSession example.

Bot: rookie = random column; sharp = win now > block their win > never
serve them a win on top of your move > center-weighted random.
"""

from __future__ import annotations

from core.duel import DuelSession

COLS, ROWS = 7, 6


def winning_line(cols, col, row):
    """If the disc just placed at (col,row) completes 4+, return the line
    as [(c,r)...], else None."""
    color = cols[col][row]
    for dc, dr in ((1, 0), (0, 1), (1, 1), (1, -1)):
        line = [(col, row)]
        for sgn in (1, -1):
            c, r = col + dc * sgn, row + dr * sgn
            while 0 <= c < COLS and 0 <= r < ROWS \
                    and r < len(cols[c]) and cols[c][r] == color:
                line.append((c, r))
                c += dc * sgn
                r += dr * sgn
        if len(line) >= 4:
            return line
    return None


class Connect4Session(DuelSession):
    SEAT_COLORS = ("r", "y")
    SUPPORTS_DRAW = False           # draws only happen on a full board
    DEFAULT_SETTINGS = {"difficulty": "sharp", "turn_seconds": 0}

    def duel_start(self):
        self.d = {"cols": [[] for _ in range(COLS)], "turn": "r",
                  "moves": [], "win_line": None}
        return [self.fx("board")]

    def current_color(self):
        if self.g["result"] is not None:
            return None
        return self.d["turn"]

    def _legal_cols(self):
        return [c for c in range(COLS) if len(self.d["cols"][c]) < ROWS]

    def _drop(self, color, col):
        d = self.d
        d["cols"][col].append(color)
        d["moves"].append(col)
        row = len(d["cols"][col]) - 1
        fx = [self.fx("moved", col=col, row=row, by=color)]
        line = winning_line(d["cols"], col, row)
        if line:
            d["win_line"] = [[c, r] for c, r in line]
            fx.extend(self.finish(color, "four in a row"))
        elif not self._legal_cols():
            fx.extend(self.finish(None, "board full"))
        else:
            d["turn"] = self.other(color)
        return fx

    def duel_move(self, token, color, msg):
        col = msg.get("col")
        if not (isinstance(col, int) and not isinstance(col, bool)
                and col in self._legal_cols()):
            return [self.fx("invalid", to=token, msg="That column is full")]
        return self._drop(color, col)

    def _wins_at(self, color, col):
        d = self.d
        d["cols"][col].append(color)
        row = len(d["cols"][col]) - 1
        won = winning_line(d["cols"], col, row) is not None
        d["cols"][col].pop()
        return won

    def duel_auto(self, color):
        legal = self._legal_cols()
        opp = self.other(color)
        if self.settings["difficulty"] == "sharp":
            wins = [c for c in legal if self._wins_at(color, c)]
            if wins:
                return self._drop(color, wins[self.rng.randrange(len(wins))])
            blocks = [c for c in legal if self._wins_at(opp, c)]
            if blocks:
                return self._drop(color, blocks[self.rng.randrange(len(blocks))])
            # avoid gifting a win directly on top of our disc
            safe = []
            for c in legal:
                self.d["cols"][c].append(color)
                gift = len(self.d["cols"][c]) < ROWS and self._wins_at(opp, c)
                self.d["cols"][c].pop()
                if not gift:
                    safe.append(c)
            pool = safe or legal
            weights = [4 - abs(3 - c) for c in pool]     # center preference
            total = sum(weights)
            pick = self.rng.random() * total
            for c, w in zip(pool, weights):
                pick -= w
                if pick <= 0:
                    return self._drop(color, c)
            return self._drop(color, pool[-1])
        return self._drop(color, legal[self.rng.randrange(len(legal))])

    def duel_takeback(self, color):
        d = self.d
        pops = 1 if self.current_color() != color else 2
        for _ in range(min(pops, len(d["moves"]))):
            col = d["moves"].pop()
            d["cols"][col].pop()
        d["turn"] = color
        d["win_line"] = None
        return [self.fx("board"), self.fx("toast", icon="↩️", msg="Takeback")]

    def duel_state(self, viewer_token):
        return {
            "kind": "connect4",
            "cols": [list(c) for c in self.d["cols"]],
            "legal": self._legal_cols() if self.g["result"] is None else [],
            "last_col": self.d["moves"][-1] if self.d["moves"] else None,
            "win_line": self.d["win_line"],
        }
