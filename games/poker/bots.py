"""Deterministic heuristic Texas Hold'em bots.

Every decision is a pure function of the visible game state plus a seed derived
from immutable hand state, so tests replay identically and a table of clones
does not move in lockstep (the seed folds in the bot's seat).  No wall clock, no
``Math.random``/bare ``random`` -- all entropy flows from the seed, matching the
GAMEHUB house rule.

Strategy: Chen formula preflop, seeded Monte-Carlo equity + pot odds postflop,
pot-fraction bet sizing, seeded bluff/c-bet schedule, three difficulty tiers.  A
final ``legalize`` guard clamps every proposed action to what the engine allows
(min-raise / all-in / check-vs-fold), so the strategy layer can never emit an
illegal action.

``decide(view)`` returns ``(move, amount)`` where ``move`` is one of
``"fold" | "check" | "call" | "raise"`` and ``amount`` is the raise-TO total for
this street (ignored for fold/check/call -- the engine computes the call size).
"""

import random

from . import rules

# --- preflop: Chen formula ---------------------------------------------------
_HI = {14: 10.0, 13: 8.0, 12: 7.0, 11: 6.0}   # A, K, Q, J


def chen(c1, c2):
    """Bill Chen's starting-hand score for two hole-card strings."""
    r1, r2 = rules.rank_val(c1), rules.rank_val(c2)
    s1, s2 = rules.suit_of(c1), rules.suit_of(c2)
    hi, lo = max(r1, r2), min(r1, r2)
    pts = _HI.get(hi, hi / 2.0)
    if r1 == r2:                                   # pair
        pts = max(pts * 2, 5.0)
    else:
        if s1 == s2:
            pts += 2.0                             # suited
        gap = hi - lo - 1
        pts -= {0: 0, 1: 1, 2: 2, 3: 4}.get(gap, 5)
        if gap <= 1 and hi < 12:
            pts += 1.0                             # straight bonus, both below Q
    import math
    return math.ceil(pts)


# --- postflop: draws + seeded Monte-Carlo equity -----------------------------

def outs(hole, board):
    """Approximate outs to improve (flush + straight draws) for bet sizing."""
    if len(board) >= 5:
        return 0
    cards = hole + board
    suits = [rules.suit_of(c) for c in cards]
    ranks = {rules.rank_val(c) for c in cards}
    o = 0
    if max(suits.count(s) for s in rules.SUITS) == 4:
        o += 9                                     # flush draw
    rs = set(ranks)
    if 14 in rs:
        rs.add(1)                                  # wheel ace
    windows = sum(1 for lo in range(1, 11)
                  if len({lo, lo + 1, lo + 2, lo + 3, lo + 4} & rs) == 4)
    if windows >= 2:
        o += 8                                     # open-ended
    elif windows == 1:
        o += 4                                     # gutshot
    return o


def equity(hole, board, num_active, rng, n_sims=140):
    """Monte-Carlo win probability against ``num_active-1`` random opponents.

    Uses the passed seeded ``rng`` so the estimate is a deterministic function
    of the spot.  Returns a float in [0, 1] (wins + 0.5*ties) / n_sims.
    """
    opp_n = max(0, num_active - 1)
    dead = set(hole) | set(board)
    deck = [c for c in rules.DECK if c not in dead]
    need = 5 - len(board)
    if opp_n == 0:
        return 1.0
    win = tie = 0
    for _ in range(n_sims):
        d = deck[:]
        rng.shuffle(d)
        i = 0
        opps = []
        for _k in range(opp_n):
            opps.append([d[i], d[i + 1]])
            i += 2
        full = board + d[i:i + need]
        me = rules.best_hand(hole + full)
        best_opp = max(rules.best_hand(o + full) for o in opps)
        if me > best_opp:
            win += 1
        elif me == best_opp:
            tie += 1
    return (win + 0.5 * tie) / n_sims


def pot_odds_required(view):
    tc = view["to_call"]
    return 0.0 if tc <= 0 else tc / (view["pot"] + tc)


# --- difficulty tiers --------------------------------------------------------
# Only this parameter block changes between tiers; the decision code is shared.
TIERS = {
    "fish": {   # loose-passive calling station
        "open_off": 2, "open_thr": 9, "threebet_thr": 14, "call_raise_thr": 8,
        "call_margin": -0.05, "value_bet_E": 0.70, "raise_E": 0.80,
        "cbet_freq": 0.35, "bluff_freq": 0.03, "bluff_raise_freq": 0.02,
        "semibluff_freq": 0.20, "value_frac": 0.50,
    },
    "shark": {  # tight-aggressive, the balanced default
        "open_off": 0, "open_thr": 9, "threebet_thr": 12, "call_raise_thr": 10,
        "call_margin": 0.02, "value_bet_E": 0.60, "raise_E": 0.66,
        "cbet_freq": 0.70, "bluff_freq": 0.10, "bluff_raise_freq": 0.05,
        "semibluff_freq": 0.50, "value_frac": 0.66,
    },
    "maniac": {  # loose-aggressive
        "open_off": 2, "open_thr": 9, "threebet_thr": 10, "call_raise_thr": 9,
        "call_margin": -0.02, "value_bet_E": 0.55, "raise_E": 0.60,
        "cbet_freq": 0.85, "bluff_freq": 0.22, "bluff_raise_freq": 0.14,
        "semibluff_freq": 0.70, "value_frac": 0.75,
    },
}
_POS_OFFSET = {"EARLY": 0, "MIDDLE": 1, "LATE": 3, "BLIND": 2}
_STREET_IDX = {"preflop": 0, "flop": 1, "turn": 2, "river": 3}


def _seed(session_seed, view):
    x = session_seed & 0xFFFFFFFFFFFF
    for v in (view["hand_no"], _STREET_IDX.get(view["street"], 0),
              view["seat"], view["actions_this_street"]):
        x = (x * 1000003 + (int(v) & 0xFFFFFFFF)) & 0xFFFFFFFFFFFFFFFF
    return x


def _legalize(action, view):
    """Clamp a proposed (move, amount) to a legal action for this spot."""
    move, amt = action
    tc = view["to_call"]
    if move == "fold":
        return ("check", 0) if tc == 0 else ("fold", 0)
    if move == "check":
        return ("check", 0) if tc == 0 else ("call", 0)
    if move == "call":
        return ("check", 0) if tc == 0 else ("call", 0)
    if move in ("bet", "raise"):
        if not view["can_raise"]:
            return ("check", 0) if tc == 0 else ("call", 0)
        cap = view["max_raise_to"]
        mn = view["min_raise_to"]
        amt = min(int(amt), cap)
        if amt >= cap:
            return ("raise", cap)                  # all-in
        if amt < mn:
            amt = mn                               # round up to a legal min-raise
            if amt >= cap:
                return ("raise", cap)
        return ("raise", amt)
    return ("check", 0) if tc == 0 else ("fold", 0)


def _size_raise(view, frac, rng):
    """Turn a pot fraction into a legal raise-to total (with seeded jitter)."""
    frac *= 0.9 + 0.2 * rng.random()
    pot_after_call = view["pot"] + view["to_call"]
    target = view["my_committed"] + view["to_call"] + round(frac * pot_after_call)
    return ("raise", int(target))


def _size_open(view, rng):
    """Preflop open / 3-bet sizing as a raise-to total."""
    bb = view["big_blind"]
    if view["to_call"] <= bb:                      # opening
        base = 2.5 * bb + view.get("limpers", 0) * bb
    else:                                          # 3-bet: ~3x the last bet
        base = 3.0 * view["to_call"] + view.get("callers", 0) * bb
    base *= 0.92 + 0.16 * rng.random()
    return ("raise", int(round(base)))


class PokerBot:
    def __init__(self, tier="shark", session_seed=0):
        self.tier = tier if tier in TIERS else "shark"
        self.session_seed = session_seed

    def decide(self, view):
        P = TIERS[self.tier]
        rng = random.Random(_seed(self.session_seed, view))

        if view["street"] == "preflop":
            return self._preflop(view, P, rng)
        return self._postflop(view, P, rng)

    # -- preflop -------------------------------------------------------------
    def _preflop(self, view, P, rng):
        score = chen(view["hole"][0], view["hole"][1])
        bb = view["big_blind"]
        if view["to_call"] <= bb:                          # unopened / limped
            eff = score + _POS_OFFSET[view["position"]] + P["open_off"]
            if eff >= P["open_thr"]:
                a = _size_open(view, rng)
            elif view["to_call"] == 0:
                a = ("check", 0)
            elif score >= 5 and view["position"] in ("LATE", "BLIND"):
                a = ("call", 0)                            # cheap limp behind
            else:
                a = ("fold", 0)
        else:                                              # facing a raise
            if score >= P["threebet_thr"]:
                a = _size_open(view, rng)                  # 3-bet
            elif score >= P["call_raise_thr"] and view["to_call"] <= 0.12 * view["my_stack"]:
                a = ("call", 0)
            else:
                a = ("fold", 0)
        return _legalize(a, view)

    # -- postflop ------------------------------------------------------------
    def _postflop(self, view, P, rng):
        E = equity(view["hole"], view["board"], view["num_active"], rng)
        o = outs(view["hole"], view["board"])
        d_eq = min(o * 4, 32) / 100.0 if view["street"] == "flop" else o * 2 / 100.0
        strong_draw = o >= 8
        req = pot_odds_required(view)

        if view["to_call"] == 0:                           # checked to us
            if E >= P["value_bet_E"]:
                a = _size_raise(view, P["value_frac"], rng)
            elif view["i_opened"] and view["street"] == "flop" and rng.random() < P["cbet_freq"]:
                a = _size_raise(view, 0.40, rng)
            elif strong_draw and rng.random() < P["semibluff_freq"]:
                a = _size_raise(view, 0.45, rng)
            elif rng.random() < P["bluff_freq"]:
                a = _size_raise(view, 0.40, rng)
            else:
                a = ("check", 0)
        else:                                              # facing a bet
            if E >= P["raise_E"]:
                a = _size_raise(view, P["value_frac"], rng)
            elif strong_draw and (E + d_eq) >= req and rng.random() < P["semibluff_freq"]:
                a = _size_raise(view, 0.50, rng)
            elif E >= req + P["call_margin"]:
                a = ("call", 0)
            elif strong_draw and E >= req:
                a = ("call", 0)
            elif rng.random() < P["bluff_raise_freq"]:
                a = _size_raise(view, 0.50, rng)
            else:
                a = ("fold", 0)
        return _legalize(a, view)


# Pretty names for bots, cycled by seat.
BOT_NAMES = ["Ace", "Maverick", "Chip", "Slick", "Doyle", "Lady Luck",
             "Nitro", "Bluffy", "Cool Hand", "Shark"]


def make_bot(tier, session_seed):
    return PokerBot(tier, session_seed)
