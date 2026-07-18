"""Backgammon rules engine — pure functions on a plain-dict state, no IO.

House style follows games/rummikub/rules.py: the state is a JSON-serializable
dict, every public function returns a new state, and all randomness is owned
by the caller (dice are injected, `choose` takes an rng).

GEOMETRY
    points: list of 24 ints, index 0..23.  points[p] > 0 means that many WHITE
    checkers sit on p; points[p] < 0 means -points[p] BLACK checkers.  A point
    can never hold both colors (the encoding forbids it).

    WHITE moves from high to low (23 -> 0); white home = points 0-5; white
    bears off past 0.  BLACK moves from low to high (0 -> 23); black home =
    points 18-23; black bears off past 23.

    Bar entry: white with die d enters on point 24-d (die 1 -> point 23);
    black with die d enters on point d-1 (die 1 -> point 0).

    Pip count (distance to bear off): a white checker on p contributes p+1,
    a black checker on p contributes 24-p, a checker on the bar contributes
    25 for either color.

    Standard start: white 2 on 23, 5 on 12, 3 on 7, 5 on 5; black mirrored
    (2 on 0, 5 on 11, 3 on 16, 5 on 18).  167 pips per side.

STATE
    {"points": [24 ints], "bar": {"w": n, "b": n}, "off": {"w": n, "b": n},
     "turn": "w"|"b",
     "dice": None | [d, d]     -- the roll as rolled,
     "remaining": [ints]       -- dice values still unplayed (doubles -> 4),
     "result": None | {"winner": "w"|"b",
                       "kind": "single"|"gammon"|"backgammon"}}

TURNS
    A turn is a list of steps in play order; a step is (src, dst) with
    src in 0..23 or "bar" and dst in 0..23 or "off".

CONVENTIONS (documented per spec)
    * Dance: when no move is legal, legal_turns() returns [[]] — exactly one
      legal "turn", the empty step list.  apply_turn(state, []) is then the
      only way to pass; it consumes the roll and flips the turn.  When any
      move exists, [] is rejected.
    * legal_turns dedup: turns with the same multiset of steps AND the same
      resulting position are collapsed to ONE entry (a single valid play
      order), so doubles don't return factorially many permutations of the
      same play.
    * apply_turn validation (the "multiset + same resulting state" flavor):
      the submitted steps are accepted if they are ANY stepwise-legal play
      order that uses the maximum number of dice — not just the one ordering
      legal_turns returned.  Under-use of dice, playing the lower die alone
      when the higher was playable, moving opponent checkers, and any
      individually illegal step are all rejected with ValueError.
"""

from __future__ import annotations

WHITE = "w"
BLACK = "b"

# White's standard start; black is mirrored on point 23-p.
_START = {23: 2, 12: 5, 7: 3, 5: 5}

# Cross-call cache: immutable move-relevant state -> legal turn list.  A pure
# position maps to a pure answer, so entries can never go stale; the cache is
# capped so it can never grow without bound.
_TURNS_CACHE = {}
_TURNS_CACHE_MAX = 20000


def other(color):
    return BLACK if color == WHITE else WHITE


def new_game(first="w"):
    """Fresh game at the standard start.  Dice are None: the session rolls."""
    if first not in (WHITE, BLACK):
        raise ValueError("first must be 'w' or 'b'")
    points = [0] * 24
    for p, n in _START.items():
        points[p] = n
        points[23 - p] = -n
    return {
        "points": points,
        "bar": {"w": 0, "b": 0},
        "off": {"w": 0, "b": 0},
        "turn": first,
        "dice": None,
        "remaining": [],
        "result": None,
    }


def start_turn(state, dice):
    """Inject a roll.  Doubles put four copies in `remaining`."""
    if state["result"] is not None:
        raise ValueError("game is over")
    if state["remaining"]:
        raise ValueError("a turn is already in progress")
    try:
        d1, d2 = dice
    except (TypeError, ValueError):
        raise ValueError("dice must be a pair [d1, d2]")
    for d in (d1, d2):
        if not isinstance(d, int) or not 1 <= d <= 6:
            raise ValueError("die values must be ints 1..6")
    new = _copy(state)
    new["dice"] = [d1, d2]
    new["remaining"] = [d1] * 4 if d1 == d2 else [d1, d2]
    return new


def pip_count(state, color):
    """Total distance to bear off: white on p counts p+1, black 24-p, bar 25."""
    points = state["points"]
    pips = 25 * state["bar"][color]
    if color == WHITE:
        for p in range(24):
            if points[p] > 0:
                pips += points[p] * (p + 1)
    else:
        for p in range(24):
            if points[p] < 0:
                pips += -points[p] * (24 - p)
    return pips


def legal_turns(state):
    """All distinct complete (maximal) turns for the player to move.

    Returns a list of turns; each turn is a list of (src, dst) step tuples in
    a valid play order — one representative order per distinct (step multiset,
    resulting position).  A dance returns [[]].
    """
    if state["result"] is not None:
        raise ValueError("game is over")
    if not state["remaining"]:
        raise ValueError("no dice to play — call start_turn first")
    return [list(t) for t in _enumerate(state)]


def apply_turn(state, steps):
    """Validate and play a complete turn; returns the new state.

    Accepts any stepwise-legal play order that uses the maximum number of
    dice (see module docstring).  [] is accepted only on a dance.
    """
    if state["result"] is not None:
        raise ValueError("game is over")
    if state["dice"] is None or not state["remaining"]:
        raise ValueError("no dice to play — call start_turn first")
    try:
        norm = tuple((s[0], s[1]) for s in steps)
    except (TypeError, IndexError, KeyError):
        raise ValueError("malformed steps: %r" % (steps,))
    turns = _enumerate(state)
    maxlen = len(turns[0])
    if len(norm) != maxlen:
        raise ValueError(
            "illegal turn %r: %d step(s) played but %d die/dice must be "
            "played" % (steps, len(norm), maxlen)
        )
    if norm not in turns:
        # Not one of the representative orderings.  For multi-step turns any
        # other stepwise-legal order of the dice is fine; for single-step
        # turns membership is exact (this is what enforces the higher-die
        # rule).  maxlen == 0 never reaches here (norm == () is in turns).
        if maxlen < 2 or not _feasible(state, norm):
            raise ValueError(
                "illegal turn %r (blocked point, bad die, bar/bear-off rule, "
                "or the higher-die rule)" % (steps,)
            )
    color = state["turn"]
    points = list(state["points"])
    bar = dict(state["bar"])
    off = dict(state["off"])
    for src, dst in norm:
        _do(points, bar, color, src, dst)
        if dst == "off":
            off[color] += 1
    result = None
    if off[color] == 15:
        loser = other(color)
        if off[loser] > 0:
            kind = "single"
        else:
            if color == WHITE:
                in_winner_home = any(points[p] < 0 for p in range(0, 6))
            else:
                in_winner_home = any(points[p] > 0 for p in range(18, 24))
            kind = "backgammon" if bar[loser] > 0 or in_winner_home else "gammon"
        result = {"winner": color, "kind": kind}
    return {
        "points": points,
        "bar": bar,
        "off": off,
        "turn": other(color),
        "dice": None,
        "remaining": [],
        "result": result,
    }


def choose(state, tier, rng):
    """Pick a turn for a bot.  rookie: uniform random.  sharp: heuristic,
    deterministic for a given state (rng only used by rookie)."""
    turns = legal_turns(state)
    if tier == "rookie":
        return turns[rng.randrange(len(turns))]
    if tier != "sharp":
        raise ValueError("unknown tier %r" % (tier,))
    me = state["turn"]
    best = None
    best_score = None
    # Canonical candidate order + strict '>' makes the pick deterministic.
    for turn in sorted(turns, key=lambda t: tuple(map(_step_key, t))):
        points, bar, off = _replay(state, turn)
        score = _score(points, bar, off, me)
        if best is None or score > best_score:
            best, best_score = turn, score
    return best


# ---------------------------------------------------------------- internals

def _copy(state):
    return {
        "points": list(state["points"]),
        "bar": dict(state["bar"]),
        "off": dict(state["off"]),
        "turn": state["turn"],
        "dice": None if state["dice"] is None else list(state["dice"]),
        "remaining": list(state["remaining"]),
        "result": None if state["result"] is None else dict(state["result"]),
    }


def _state_key(state):
    """Immutable key of everything move generation depends on.  `off` is
    deliberately excluded: legality never reads it (bear-off eligibility is
    "no own checkers outside home and none on the bar"), and cached turn
    lists contain steps only, so sharing across off counts is sound."""
    return (
        tuple(state["points"]),
        state["bar"]["w"],
        state["bar"]["b"],
        state["turn"],
        tuple(sorted(state["remaining"])),
    )


def _step_key(step):
    """Sortable form of a step (src 'bar' -> 25, dst 'off' -> -1)."""
    src, dst = step
    return (25 if src == "bar" else src, -1 if dst == "off" else dst)


def _do(points, bar, color, src, dst):
    """Execute one step in place.  Returns True if it hit a blot."""
    sign = 1 if color == WHITE else -1
    if src == "bar":
        bar[color] -= 1
    else:
        points[src] -= sign
    hit = False
    if dst != "off":
        if points[dst] == -sign:  # lone opposing checker: hit to the bar
            points[dst] = 0
            bar[other(color)] += 1
            hit = True
        points[dst] += sign
    return hit


def _undo(points, bar, color, src, dst, hit):
    sign = 1 if color == WHITE else -1
    if dst != "off":
        points[dst] -= sign
        if hit:
            points[dst] = -sign
            bar[other(color)] -= 1
    if src == "bar":
        bar[color] += 1
    else:
        points[src] += sign


def _single_moves(points, bar, color, d):
    """All legal single-die moves for `color` with die `d` (bar rule included)."""
    moves = []
    if color == WHITE:
        if bar["w"] > 0:
            e = 24 - d
            if points[e] >= -1:
                moves.append(("bar", e))
            return moves
        for src in range(24):
            if points[src] <= 0:
                continue
            dst = src - d
            if dst >= 0 and points[dst] >= -1:
                moves.append((src, dst))
        # Bear-off: every white checker home (bar is empty here by branch).
        if all(points[p] <= 0 for p in range(6, 24)):
            if points[d - 1] > 0:                       # exact die
                moves.append((d - 1, "off"))
            elif not any(points[p] > 0 for p in range(d, 6)):
                # d-1 empty and nothing higher: overshoot from highest occupied.
                for p in range(d - 2, -1, -1):
                    if points[p] > 0:
                        moves.append((p, "off"))
                        break
    else:
        if bar["b"] > 0:
            e = d - 1
            if points[e] <= 1:
                moves.append(("bar", e))
            return moves
        for src in range(24):
            if points[src] >= 0:
                continue
            dst = src + d
            if dst <= 23 and points[dst] <= 1:
                moves.append((src, dst))
        if all(points[p] >= 0 for p in range(0, 18)):
            exact = 24 - d
            if points[exact] < 0:
                moves.append((exact, "off"))
            elif not any(points[p] < 0 for p in range(18, exact)):
                for p in range(exact + 1, 24):
                    if points[p] < 0:
                        moves.append((p, "off"))
                        break
    return moves


def _enumerate(state):
    """All distinct maximal turns, each a tuple of (src, dst) steps in a valid
    play order.  A dance yields [()].

    DFS over single-die moves with two prunes that keep the worst case
    (doubles, many checkers) small:
      * memoization on the immutable (points, bar, remaining-dice) node, so
        transpositions are expanded once;
      * per-node dedup to one representative ordering per (step multiset,
        end position), so permutations of the same play never multiply.
    Only turns using the maximum number of dice survive (per-node max-length
    filtering; a maximal turn's tail is maximal from every node it passes).
    The higher-die rule is applied at the root when exactly one of two
    different dice can be played.  Results are cached across calls.
    """
    ckey = _state_key(state)
    cached = _TURNS_CACHE.get(ckey)
    if cached is not None:
        return cached

    color = state["turn"]
    points = list(state["points"])
    bar = {"w": state["bar"]["w"], "b": state["bar"]["b"]}
    # Descending order matters twice: deterministic output, and the higher
    # die is tried first so a single-step turn playable by either die gets
    # annotated with the higher die (see the higher-die filter below).
    root_remaining = tuple(sorted(state["remaining"], reverse=True))
    memo = {}

    def rec(remaining):
        """-> dict {(sorted step keys, end board): annotated steps tuple},
        holding only the max-dice continuations from this node.  Annotated
        steps are (src, dst, die) in play order; end board is
        (points tuple, bar_w, bar_b) after them."""
        board = tuple(points)
        key = (board, bar["w"], bar["b"], remaining)
        hit = memo.get(key)
        if hit is not None:
            return hit
        found = {}
        tried = set()
        for i, d in enumerate(remaining):
            if d in tried:
                continue
            tried.add(d)
            rest = remaining[:i] + remaining[i + 1:]
            for src, dst in _single_moves(points, bar, color, d):
                sk = _step_key((src, dst))
                was_hit = _do(points, bar, color, src, dst)
                for (csort, end), csteps in rec(rest).items():
                    k = (tuple(sorted(csort + (sk,))), end)
                    if k not in found:
                        found[k] = ((src, dst, d),) + csteps
                _undo(points, bar, color, src, dst, was_hit)
        if found:
            best = max(len(sort) for sort, _ in found)
            if any(len(sort) != best for sort, _ in found):
                found = {k: v for k, v in found.items() if len(k[0]) == best}
        else:
            found = {((), (board, bar["w"], bar["b"])): ()}
        memo[key] = found
        return found

    turns = list(rec(root_remaining).values())

    # Higher-die rule: two different dice, only one playable move total, and
    # both dice individually playable -> the higher die must be the one
    # played.  (Steps playable by EITHER die were annotated with the higher
    # one because the DFS tries dice in descending order, so they survive.)
    if (
        len(root_remaining) == 2
        and root_remaining[0] != root_remaining[1]
        and turns[0]
        and len(turns[0]) == 1
    ):
        dies_used = {t[0][2] for t in turns}
        if len(dies_used) > 1:
            hi = max(dies_used)
            turns = [t for t in turns if t[0][2] == hi]

    stripped = [tuple((a, b) for a, b, _ in t) for t in turns]

    if len(_TURNS_CACHE) >= _TURNS_CACHE_MAX:
        _TURNS_CACHE.clear()
    _TURNS_CACHE[ckey] = stripped
    return stripped


def _feasible(state, steps):
    """Is `steps` playable in the given order with SOME assignment of the
    remaining dice?  (Stepwise legality only — maximality is checked by the
    caller.)  Small backtracking over at most 4 dice of at most 2 values."""
    color = state["turn"]
    points = list(state["points"])
    bar = {"w": state["bar"]["w"], "b": state["bar"]["b"]}

    def go(i, remaining):
        if i == len(steps):
            return True
        step = steps[i]
        tried = set()
        for j, d in enumerate(remaining):
            if d in tried:
                continue
            tried.add(d)
            if step in _single_moves(points, bar, color, d):
                src, dst = step
                was_hit = _do(points, bar, color, src, dst)
                if go(i + 1, remaining[:j] + remaining[j + 1:]):
                    return True
                _undo(points, bar, color, src, dst, was_hit)
        return False

    return go(0, tuple(sorted(state["remaining"], reverse=True)))


def _replay(state, steps):
    """Board after playing `steps` for the side to move: (points, bar, off)."""
    points = list(state["points"])
    bar = dict(state["bar"])
    off = dict(state["off"])
    color = state["turn"]
    for src, dst in steps:
        _do(points, bar, color, src, dst)
        if dst == "off":
            off[color] += 1
    return points, bar, off


def _hittable(points, bar, me, p):
    """Can the opponent hit a `me` blot on p with a direct 1-6 (or bar entry)?"""
    if me == WHITE:
        if bar["b"] > 0 and p <= 5:
            return True
        for q in range(max(0, p - 6), p):
            if points[q] < 0:
                return True
    else:
        if bar["w"] > 0 and p >= 18:
            return True
        for q in range(p + 1, min(23, p + 6) + 1):
            if points[q] > 0:
                return True
    return False


def _score(points, bar, off, me):
    """Static evaluation of a post-turn board from the mover's perspective:
    race (pips), bear-off progress, hits, made points, exposed blots."""
    sign = 1 if me == WHITE else -1
    opp = other(me)
    score = 30.0 * off[me] + 25.0 * bar[opp]
    pips = 25 * bar[me]
    home = range(0, 6) if me == WHITE else range(18, 24)
    for p in range(24):
        n = points[p] * sign
        if n <= 0:
            continue
        pips += n * ((p + 1) if me == WHITE else (24 - p))
        if n >= 2:
            score += 4.0 + (2.0 if p in home else 0.0)
        elif n == 1:
            score -= 12.0 if _hittable(points, bar, me, p) else 3.0
    return score - pips
