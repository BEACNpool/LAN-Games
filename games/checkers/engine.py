"""American (straight) checkers rules engine — pure functions, no IO.

State is a plain JSON-serializable dict:

    {"board": [64 entries],   # index = row*8 + col, ROW 0 AT THE TOP
     "turn":  "w" | "b",
     "clock": int,            # half-moves since last capture OR man move
     "result": None | "w" | "b" | "draw"}

Board entries: None (empty), "w"/"b" (men), "W"/"B" (kings). Pieces live
only on dark squares, where (row + col) % 2 == 1.

Orientation & rules enforced here (American / straight checkers):

- BLACK starts on rows 0-2 (top), WHITE on rows 5-7 (bottom).
- WHITE MOVES FIRST. (Many rulebooks give black/red the first move; we use
  white-first deliberately, for consistency with our chess UI.)
- White men move UP the board (decreasing row); black men move DOWN
  (increasing row). Men move AND capture forward only (American rule —
  unlike international draughts, a man never jumps backward).
- Kings move and jump one square diagonally in all four directions.
  NO flying kings.
- Captures are jumps over an adjacent enemy piece onto the empty square
  beyond. With forced=True (the standard rule) any available capture MUST
  be taken, and a capture sequence must be continued to completion: only
  complete (maximal) sequences are ever offered — the player chooses among
  full sequences, never stops early. forced=False is a house-rule toggle
  that also allows simple moves, but an offered capture sequence is still
  maximal.
- CROWNING ENDS THE MOVE: a man that reaches the far row is crowned and,
  if it got there by a jump, may NOT continue jumping that turn (American
  rule). Kings are made, not born mid-leap.
- A player with no pieces, or no legal moves on their turn, LOSES.
- Draw: 80 half-moves (40 full moves) with no capture and no man move.

A move is a list of square indices: [src, dst] for a simple move, or
[src, j1, j2, ...] for a jump sequence listing EVERY landing square.
"""

from __future__ import annotations

SIZE = 8
DRAW_CLOCK = 80          # half-moves without capture/man-move -> draw
MEN_PER_SIDE = 12

# RULE: men move/capture forward only — white toward row 0, black toward
# row 7. Kings get all four diagonals.
_MAN_DIRS = {"w": ((-1, -1), (-1, 1)), "b": ((1, -1), (1, 1))}
_KING_DIRS = ((-1, -1), (-1, 1), (1, -1), (1, 1))
_CROWN_ROW = {"w": 0, "b": 7}


# ---------------- square helpers ----------------

def sq(row, col):
    """Square index for (row, col); row 0 is the TOP of the board."""
    return row * SIZE + col


def rc(square):
    """(row, col) for a square index."""
    return divmod(square, SIZE)


def is_dark(row, col):
    """Playable squares: the dark ones, (row+col) odd."""
    return (row + col) % 2 == 1


def _on_board(row, col):
    return 0 <= row < SIZE and 0 <= col < SIZE


def _color(piece):
    return piece.lower()


def _is_king(piece):
    return piece.isupper()


def _opponent(color):
    return "b" if color == "w" else "w"


# ---------------- game construction ----------------

def new_game():
    """Fresh game: 12 black men on rows 0-2, 12 white men on rows 5-7,
    dark squares only. White to move (documented deviation — see module
    docstring)."""
    board = [None] * (SIZE * SIZE)
    for row in range(SIZE):
        for col in range(SIZE):
            if not is_dark(row, col):
                continue
            if row <= 2:
                board[sq(row, col)] = "b"
            elif row >= 5:
                board[sq(row, col)] = "w"
    return {"board": board, "turn": "w", "clock": 0, "result": None}


# ---------------- move generation ----------------

def _jump_sequences(board, start, piece):
    """All COMPLETE capture sequences for the piece on `start`.

    RULE: a capture sequence must be played to completion — the same piece
    keeps jumping as long as another jump is available, so only paths that
    cannot be extended are emitted (every branch of a branching multi-jump
    is offered as its own complete sequence).

    RULE: the same enemy piece is never jumped twice; captured pieces stay
    on the board until the move ends, so their squares also block landing.
    The jumper's own start square is vacated for the whole sequence (a
    king may lawfully land back on it mid-loop).

    RULE: a man that lands on the crowning row is crowned and the move
    ENDS immediately — the fresh king may not continue jumping this turn.
    """
    color = _color(piece)
    king = _is_king(piece)
    crown = _CROWN_ROW[color]
    dirs = _KING_DIRS if king else _MAN_DIRS[color]
    out = []

    def dfs(row, col, captured, path):
        extended = False
        for drow, dcol in dirs:
            mrow, mcol = row + drow, col + dcol
            lrow, lcol = row + 2 * drow, col + 2 * dcol
            if not _on_board(lrow, lcol):
                continue
            mid, land = sq(mrow, mcol), sq(lrow, lcol)
            victim = board[mid]
            # must jump an enemy piece not already jumped this sequence
            if victim is None or _color(victim) == color or mid in captured:
                continue
            # landing square must be empty (start square counts as empty)
            if board[land] is not None and land != start:
                continue
            extended = True
            if not king and lrow == crown:
                # RULE: crowning ends the move — do not recurse
                out.append(path + [land])
            else:
                dfs(lrow, lcol, captured | {mid}, path + [land])
        if not extended and len(path) > 1:
            out.append(path)

    dfs(*rc(start), frozenset(), [start])
    return out


def _simple_moves(board, start, piece):
    """One-square diagonal steps onto an empty square."""
    row, col = rc(start)
    dirs = _KING_DIRS if _is_king(piece) else _MAN_DIRS[_color(piece)]
    out = []
    for drow, dcol in dirs:
        nrow, ncol = row + drow, col + dcol
        if _on_board(nrow, ncol) and board[sq(nrow, ncol)] is None:
            out.append([start, sq(nrow, ncol)])
    return out


def legal_moves(state, forced=True):
    """All legal moves for the side to move; [] if the game is over.

    forced=True (standard rule): if any capture exists, ONLY captures are
    legal. forced=False (house rule): simple moves stay legal alongside
    captures, but capture sequences are still complete/maximal.
    Deterministic order: by source square, then direction order.
    """
    if state["result"] is not None:
        return []
    board = state["board"]
    turn = state["turn"]
    jumps, simples = [], []
    for square in range(SIZE * SIZE):
        piece = board[square]
        if piece is None or _color(piece) != turn:
            continue
        jumps.extend(_jump_sequences(board, square, piece))
        simples.extend(_simple_moves(board, square, piece))
    if jumps and forced:
        # RULE: captures are compulsory
        return jumps
    return jumps + simples


def _is_jump_move(move):
    """A jump's first hop spans two rows; a simple move spans one."""
    return abs(rc(move[1])[0] - rc(move[0])[0]) == 2


# ---------------- applying a move ----------------

def apply_move(state, move, forced=True):
    """Apply a legal move, returning a NEW state (input never mutated).

    Raises ValueError for anything not in legal_moves(state, forced) —
    including partial capture sequences, the wrong side's piece, or any
    move in a finished game. Handles captured-piece removal, crowning,
    the draw clock, the turn flip, and result detection.
    """
    move = list(move)
    if move not in legal_moves(state, forced):
        raise ValueError("illegal move: %r" % (move,))

    board = list(state["board"])
    turn = state["turn"]
    src = move[0]
    piece = board[src]
    was_man = piece.islower()

    board[src] = None
    captured = False
    row, col = rc(src)
    for land in move[1:]:
        lrow, lcol = rc(land)
        if abs(lrow - row) == 2:
            # RULE: the jumped piece is removed
            board[sq((row + lrow) // 2, (col + lcol) // 2)] = None
            captured = True
        row, col = lrow, lcol

    # RULE: crowning on reaching the far row
    if was_man and row == _CROWN_ROW[turn]:
        piece = piece.upper()
    board[move[-1]] = piece

    # RULE: draw clock resets on any capture or man move; a king's quiet
    # move increments it
    clock = 0 if (captured or was_man) else state["clock"] + 1

    nxt = {"board": board, "turn": _opponent(turn),
           "clock": clock, "result": None}

    # RULE: opponent with no pieces or no legal moves loses (a decisive
    # position outranks the draw counter); 80 quiet half-moves is a draw
    opp_alive = any(p is not None and _color(p) == nxt["turn"] for p in board)
    if not opp_alive or not legal_moves(nxt):
        nxt["result"] = turn
    elif clock >= DRAW_CLOCK:
        nxt["result"] = "draw"
    return nxt


# ---------------- bots ----------------

def _biggest_threat(state):
    """Pieces the side to move could capture with its best sequence."""
    best = 0
    for move in legal_moves(state):
        if _is_jump_move(move):
            best = max(best, len(move) - 1)
    return best


def choose(state, tier, rng, forced=True):
    """Pick a legal move for the side to move.

    tier "rookie": uniform random over legal moves.
    tier "sharp":  take the capture eating the most pieces; otherwise
                   1-ply safety (minimize what the opponent can capture
                   in reply), then prefer crowning and advancing men.
    All randomness flows through rng (a random.Random) — deterministic
    under a fixed seed.
    """
    moves = legal_moves(state, forced)
    if not moves:
        raise ValueError("no legal moves: game is over or side is stuck")

    if tier == "rookie":
        return moves[rng.randrange(len(moves))]

    if tier != "sharp":
        raise ValueError("unknown tier: %r" % (tier,))

    jumps = [m for m in moves if _is_jump_move(m)]
    if jumps:
        # prefer the capture taking the most pieces
        best = max(len(m) for m in jumps)
        pool = [m for m in jumps if len(m) == best]
    else:
        # 1-ply safety: keep only the moves that concede the fewest
        # captured pieces on the opponent's reply
        danger = [( _biggest_threat(apply_move(state, m, forced=forced)), m)
                  for m in moves]
        safest = min(d for d, _ in danger)
        pool = [m for d, m in danger if d == safest]

        # among equally safe moves, prefer crowning and advancing men
        def gain(m):
            p = state["board"][m[0]]
            if _is_king(p):
                return 0
            r0, r1 = rc(m[0])[0], rc(m[-1])[0]
            advance = (r0 - r1) if state["turn"] == "w" else (r1 - r0)
            crowning = 3 if r1 == _CROWN_ROW[state["turn"]] else 0
            return advance + crowning

        top = max(gain(m) for m in pool)
        pool = [m for m in pool if gain(m) == top]

    return pool[rng.randrange(len(pool))]
