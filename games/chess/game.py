"""Chess — rules and legality entirely via python-chess (never hand-roll
castling/en-passant/repetition). The session is a thin DuelSession wrapper:
moves arrive as UCI ("e2e4", "e7e8q"), the library is the referee, and
draws by 50-move/threefold are claimed automatically (family rules).

Bots: rookie = random legal move; sharp = depth-2 alpha-beta on material
(+tiny mobility), captures first — beatable by a human who's paying
attention, which is exactly the bar for a living-room opponent.
"""

from __future__ import annotations

import chess

from core.duel import DuelSession

PIECE_VALS = {chess.PAWN: 1.0, chess.KNIGHT: 3.0, chess.BISHOP: 3.15,
              chess.ROOK: 5.0, chess.QUEEN: 9.0, chess.KING: 0.0}


def material(board: chess.Board) -> float:
    score = 0.0
    for pt, v in PIECE_VALS.items():
        score += v * (len(board.pieces(pt, chess.WHITE))
                      - len(board.pieces(pt, chess.BLACK)))
    return score


def sharp_move(board: chess.Board, rng) -> chess.Move:
    """Depth-2 (my move, best reply) material search, captures ordered
    first, small jitter so identical positions don't always repeat."""
    me = board.turn
    sign = 1 if me == chess.WHITE else -1
    best, best_score = [], None
    moves = sorted(board.legal_moves,
                   key=lambda m: (not board.is_capture(m), rng.random()))
    for m in moves:
        board.push(m)
        if board.is_checkmate():
            board.pop()
            return m
        # opponent's best (worst for us) reply by static eval
        worst = None
        if board.is_game_over(claim_draw=False):
            worst = sign * material(board)
        else:
            for r in board.legal_moves:
                board.push(r)
                s = sign * material(board)
                if board.is_checkmate():
                    s = -1000
                board.pop()
                if worst is None or s < worst:
                    worst = s
        board.pop()
        score = worst
        if best_score is None or score > best_score + 1e-9:
            best, best_score = [m], score
        elif abs(score - best_score) < 0.05:
            best.append(m)
    return best[rng.randrange(len(best))]


class ChessSession(DuelSession):
    SEAT_COLORS = ("w", "b")
    DEFAULT_SETTINGS = {"difficulty": "sharp", "turn_seconds": 0}

    # ---------------- duel hooks ----------------

    def duel_start(self):
        self.d = {"board": chess.Board()}
        return [self.fx("board")]

    def current_color(self):
        if self.g["result"] is not None:
            return None
        return "w" if self.d["board"].turn == chess.WHITE else "b"

    def _after_move(self, move_san, color):
        board = self.d["board"]
        fx = [self.fx("moved", san=move_san, by=color,
                      check=board.is_check())]
        outcome = board.outcome(claim_draw=True)
        if outcome is not None:
            if outcome.winner is None:
                why = {chess.Termination.STALEMATE: "stalemate",
                       chess.Termination.INSUFFICIENT_MATERIAL: "insufficient material",
                       chess.Termination.FIFTY_MOVES: "fifty-move rule",
                       chess.Termination.THREEFOLD_REPETITION: "threefold repetition",
                       }.get(outcome.termination, "draw")
                fx.extend(self.finish(None, why))
            else:
                w = "w" if outcome.winner == chess.WHITE else "b"
                fx.extend(self.finish(w, "checkmate"))
        return fx

    def duel_move(self, token, color, msg):
        board = self.d["board"]
        uci = msg.get("uci")
        try:
            move = chess.Move.from_uci(str(uci))
        except Exception:
            return [self.fx("invalid", to=token, msg="Bad move")]
        if move not in board.legal_moves:
            return [self.fx("invalid", to=token, msg="Illegal move")]
        san = board.san(move)
        board.push(move)
        return self._after_move(san, color)

    def duel_auto(self, color):
        board = self.d["board"]
        if self.settings["difficulty"] == "rookie":
            moves = list(board.legal_moves)
            move = moves[self.rng.randrange(len(moves))]
        else:
            move = sharp_move(board, self.rng)
        san = board.san(move)
        board.push(move)
        return self._after_move(san, color)

    def duel_takeback(self, color):
        board = self.d["board"]
        # undo until it is `color`'s move again with their last move gone:
        # 1 ply if the opponent hasn't replied, else 2
        pops = 1 if self.current_color() != color else 2
        for _ in range(min(pops, len(board.move_stack))):
            board.pop()
        return [self.fx("board"), self.fx("toast", icon="↩️", msg="Takeback")]

    def duel_state(self, viewer_token):
        board = self.d["board"]
        last = board.peek() if board.move_stack else None
        captured = {"w": [], "b": []}
        # material actually off the board, from a replay-free count
        start = {chess.PAWN: 8, chess.KNIGHT: 2, chess.BISHOP: 2,
                 chess.ROOK: 2, chess.QUEEN: 1}
        for pt, n in start.items():
            for col, cc in ((chess.WHITE, "w"), (chess.BLACK, "b")):
                missing = n - len(board.pieces(pt, col))
                sym = chess.piece_symbol(pt)
                captured[cc] += [sym] * max(0, missing)
        return {
            "kind": "chess",
            "fen": board.fen(),
            "legal": [m.uci() for m in board.legal_moves],
            "last_move": last.uci() if last else None,
            "check_sq": chess.square_name(board.king(board.turn))
                        if board.is_check() else None,
            "captured": captured,
            "move_no": board.fullmove_number,
        }
