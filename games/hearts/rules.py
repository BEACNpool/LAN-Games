"""Hearts rules primitives — pure functions, no state, no IO.

Shared by game.py (validation/scoring) and bots.py (decision-making). Cards
are 2-char strings: rank + suit, e.g. "QS" (queen of spades), "TH" (ten of
hearts), "2C". Seats are 0..3, play order clockwise (seat+1). There is no
trump and there are no partners: every heart is 1 point, the Q♠ is 13, and
the LOWEST total wins the match.
"""

from __future__ import annotations

RANKS = "23456789TJQKA"          # index = strength, ascending
SUITS = "SHDC"                   # spades, hearts, diamonds, clubs

DECK = [r + s for s in SUITS for r in RANKS]           # 52 cards

QUEEN = "QS"
TWO_CLUBS = "2C"
MOON_POINTS = 26                 # all hearts + the queen
PASS_COUNT = 3

# Passing rotates by hand number: left, right, across, hold, repeating.
PASS_ORDER = ("left", "right", "across", "hold")
PASS_OFFSET = {"left": 1, "right": 3, "across": 2, "hold": 0}


def rank_of(card: str) -> int:
    return RANKS.index(card[0])


def suit_of(card: str) -> str:
    return card[1]


def points_of(card: str) -> int:
    if suit_of(card) == "H":
        return 1
    if card == QUEEN:
        return 13
    return 0


def is_point(card: str) -> bool:
    return points_of(card) > 0


def sort_hand(hand):
    """Stable display/thinking order: spades high->low, then H, D, C."""
    return sorted(hand, key=lambda c: (SUITS.index(suit_of(c)), -rank_of(c)))


def pass_direction(hand_no: int) -> str:
    """Hand 1 passes left, 2 right, 3 across, 4 holds; then it repeats."""
    return PASS_ORDER[(hand_no - 1) % 4]


def pass_target(seat: int, direction: str) -> int:
    """The seat this seat's picks go to. Left = next seat in play order."""
    return (seat + PASS_OFFSET[direction]) % 4


def legal_plays(hand, trick, hearts_broken, trick_no):
    """The legal cards for the player whose turn it is.

    trick: list of (seat, card) already on the table, in play order.
    Rules: the 2♣ opens the hand; no point card may hit trick 1 unless the
    hand allows nothing else; must follow the led suit if able; hearts may
    not be LED until broken unless the leader has only hearts. The Q♠ may
    be led any time.
    """
    hand = list(hand)
    if not trick:
        if trick_no == 1:
            # the 2♣ holder leads it — nothing else opens a hand
            return [TWO_CLUBS] if TWO_CLUBS in hand else hand
        if hearts_broken:
            return hand
        non_hearts = [c for c in hand if suit_of(c) != "H"]
        return non_hearts if non_hearts else hand
    led = suit_of(trick[0][1])
    follow = [c for c in hand if suit_of(c) == led]
    if follow:
        return follow
    if trick_no == 1:
        clean = [c for c in hand if not is_point(c)]
        if clean:
            return clean
    return hand


def trick_winner(trick):
    """trick: full list of 4 (seat, card). No trump — the highest card of
    the led suit takes it (and every point in it)."""
    led = suit_of(trick[0][1])
    pool = [(s, c) for s, c in trick if suit_of(c) == led]
    return max(pool, key=lambda sc: rank_of(sc[1]))[0]


def hand_points(taken):
    """taken: {seat: [point cards]} -> {seat: raw points this hand}."""
    return {s: sum(points_of(c) for c in taken.get(s, ())) for s in range(4)}


def score_hand(taken):
    """Score one completed hand.

    taken: {seat: [point cards captured]}. Returns
    {"pts": raw points/seat, "deltas": score change/seat, "moon": seat|None}.
    Shooting the moon (all 26 points to one seat) scores that seat 0 and
    everyone else +26.
    """
    pts = hand_points(taken)
    moon = next((s for s, p in pts.items() if p == MOON_POINTS), None)
    if moon is not None:
        deltas = {s: (0 if s == moon else MOON_POINTS) for s in range(4)}
    else:
        deltas = dict(pts)
    return {"pts": pts, "deltas": deltas, "moon": moon}


def match_winner(totals, target):
    """None while the match continues. It ends when someone reaches the
    target at the end of a hand AND the lowest total is unique — the LOWEST
    total wins; a tie at the bottom plays on."""
    if max(totals.values()) < target:
        return None
    lo = min(totals.values())
    lows = [s for s, v in totals.items() if v == lo]
    return lows[0] if len(lows) == 1 else None
