"""Pure, IO-free Texas Hold'em rules: cards, hand evaluation, side pots.

Nothing here touches sockets, timers, or session state. Everything is a pure
function so it can be unit-tested exhaustively and reused by both the engine
(``game.py``) and the bots (``bots.py``).

Card format follows the GAMEHUB house convention (hearts/spades/euchre): a card
is the 2-char string ``RANK + SUIT`` with ``RANK`` in ``"23456789TJQKA"`` and
``SUIT`` in ``"SHDC"`` -- e.g. ``"AS"`` (ace of spades), ``"TH"`` (ten of
hearts), ``"2C"``.  Ranks evaluate 2..14 (ace high); the only place the ace is
low is the wheel A-2-3-4-5, handled explicitly.

The evaluator is the "best of C(n,5)" approach (deuces/treys style): score every
5-card subset and take the max comparable tuple.  For 7 cards that is 21 subsets
-- trivially fast for a casual server and *structurally* correct: the class of
"best 5 across 7" selection bugs (esp. the mixed-suit straight-plus-flush false
straight-flush) cannot occur because every scored subset is exactly 5 cards.
"""

from collections import Counter
from itertools import combinations

RANKS = "23456789TJQKA"          # index 0..12; value = index + 2 (ace high)
SUITS = "SHDC"                   # spades, hearts, diamonds, clubs
DECK = [r + s for s in SUITS for r in RANKS]   # 52 cards

# Category index (0 weakest .. 8 strongest) -> display name.
HAND_CATEGORIES = [
    "High Card", "Pair", "Two Pair", "Three of a Kind", "Straight",
    "Flush", "Full House", "Four of a Kind", "Straight Flush",
]


def rank_val(card):
    """'A' -> 14, 'T' -> 10, '2' -> 2."""
    return RANKS.index(card[0]) + 2


def suit_of(card):
    return card[1]


def sort_hole(cards):
    """Stable display order: high rank first, suit as a tiebreak."""
    return sorted(cards, key=lambda c: (-rank_val(c), SUITS.index(suit_of(c))))


def _straight_high(rank_set):
    """Top card of the best 5-in-a-row in this rank set, else None.

    Adds an ace-low (1) alias so the wheel A-2-3-4-5 resolves to top card 5.
    """
    rs = set(rank_set)
    if 14 in rs:
        rs.add(1)
    for top in range(14, 4, -1):              # Broadway (14) down to the wheel (5)
        if all((top - i) in rs for i in range(5)):
            return top
    return None


def eval5(cards):
    """Score exactly 5 cards into a comparable tuple (higher = stronger).

    Tuple layout (see HAND_CATEGORIES): first element is the category 0..8,
    followed by tie-break ranks in comparison order, so Python's native tuple
    ordering does all winner/tie logic and ``==`` means an exact chop.
    """
    ranks = sorted((rank_val(c) for c in cards), reverse=True)
    suits = [suit_of(c) for c in cards]
    counts = Counter(ranks)
    # group ranks by (multiplicity desc, rank desc) so quads/trips/pairs lead
    ordered = sorted(counts.items(), key=lambda kv: (kv[1], kv[0]), reverse=True)
    pattern = sorted(counts.values(), reverse=True)
    is_flush = len(set(suits)) == 1
    st = _straight_high(ranks)

    if pattern == [1, 1, 1, 1, 1]:
        if is_flush and st:
            return (8, st)                    # straight flush (incl. royal = (8,14))
        if is_flush:
            return (5, *ranks)                # flush: all five high->low
        if st:
            return (4, st)                    # straight: top card only
        return (0, *ranks)                    # high card
    if pattern == [4, 1]:
        return (7, ordered[0][0], ordered[1][0])          # quads + kicker
    if pattern == [3, 2]:
        return (6, ordered[0][0], ordered[1][0])          # full house: trips, pair
    if pattern == [3, 1, 1]:
        trips = ordered[0][0]
        return (3, trips, *sorted((r for r in ranks if r != trips), reverse=True))
    if pattern == [2, 2, 1]:
        return (2, ordered[0][0], ordered[1][0], ordered[2][0])   # hi pair, lo pair, kicker
    # pattern == [2, 1, 1, 1]  -> one pair + 3 kickers
    pair = ordered[0][0]
    return (1, pair, *sorted((r for r in ranks if r != pair), reverse=True))


def best_hand(cards):
    """Best 5-card score tuple from 5, 6, or 7 cards (list of card strings)."""
    if len(cards) < 5:
        raise ValueError("need at least 5 cards, got %d" % len(cards))
    if len(cards) == 5:
        return eval5(cards)
    return max(eval5(list(c)) for c in combinations(cards, 5))


def hand_name(score):
    """Human label for a score tuple, e.g. 'Full House', 'Royal Flush'."""
    cat = score[0]
    if cat == 8 and score[1] == 14:
        return "Royal Flush"
    return HAND_CATEGORIES[cat]


def _val_name(v, plural=False):
    names = {14: "Ace", 13: "King", 12: "Queen", 11: "Jack", 10: "Ten",
             9: "Nine", 8: "Eight", 7: "Seven", 6: "Six", 5: "Five",
             4: "Four", 3: "Three", 2: "Two"}
    n = names.get(v, str(v))
    return (n + "s") if plural else n


def hand_desc(score):
    """A fuller description, e.g. 'Full House, Kings full of Twos'."""
    cat = score[0]
    if cat == 8:
        return "Royal Flush" if score[1] == 14 else "Straight Flush, %s-high" % _val_name(score[1])
    if cat == 7:
        return "Four of a Kind, %s" % _val_name(score[1], True)
    if cat == 6:
        return "Full House, %s full of %s" % (_val_name(score[1], True), _val_name(score[2], True))
    if cat == 5:
        return "Flush, %s-high" % _val_name(score[1])
    if cat == 4:
        return "Straight, %s-high" % _val_name(score[1])
    if cat == 3:
        return "Three of a Kind, %s" % _val_name(score[1], True)
    if cat == 2:
        return "Two Pair, %s and %s" % (_val_name(score[1], True), _val_name(score[2], True))
    if cat == 1:
        return "Pair of %s" % _val_name(score[1], True)
    return "%s-high" % _val_name(score[1])


# ---------------------------------------------------------------------------
# Side pots  (see the side-pot research spec; pure integer chip math)
# ---------------------------------------------------------------------------

def uncalled_refund(contribs):
    """Chips no opponent could match are returned to the sole top contributor.

    ``contribs`` maps seat -> total chips contributed this hand.  Returns
    ``(refund_seat_or_None, refund_amount)``.  refund > 0 iff exactly one seat
    holds the strict maximum contribution; the amount is (max - 2nd max), where
    the 2nd max is taken over the *positive* contributors only (a seat that put
    in nothing can never be the "matched" level).  Does NOT mutate ``contribs``.
    """
    vals = sorted((c for c in contribs.values() if c > 0), reverse=True)
    if len(vals) < 2 or vals[0] == vals[1]:
        return (None, 0)
    top, second = vals[0], vals[1]
    for seat, c in contribs.items():          # the unique seat holding `top`
        if c == top:
            return (seat, top - second)
    return (None, 0)


def build_pots(contribs, folded):
    """Layer total contributions into a main pot + side pots.

    ``contribs``: dict seat -> total chips contributed this hand (AFTER the
    uncalled-bet refund has been removed).  ``folded``: dict seat -> bool.

    Returns an ordered ``list[{"amount": int, "eligible": set[seat]}]`` with the
    main pot first, side pots (innermost/lowest level first) after.  Every pot
    has ``amount > 0`` and a non-empty ``eligible`` set, and the eligible sets
    nest: ``pots[0].eligible >= pots[1].eligible >= ...``.
    """
    contributors = [s for s, c in contribs.items() if c > 0]
    live = [s for s in contributors if not folded.get(s, False)]

    if len(live) <= 1:
        # No showdown needed: the lone live seat (or, degenerate, nobody) wins all.
        total = sum(contribs[s] for s in contributors)
        elig = set(live) if live else set(contributors)
        return [{"amount": total, "eligible": elig}] if total > 0 else []

    pots = []
    prev = 0
    for level in sorted({contribs[s] for s in contributors}):
        width = level - prev
        if width > 0:
            layer = [s for s in contributors if contribs[s] >= level]
            amount = width * len(layer)
            eligible = {s for s in layer if not folded.get(s, False)}
            if eligible:
                pots.append({"amount": amount, "eligible": eligible})
            elif pots:
                # Defensive: a layer funded only by folded players folds down
                # into the most recent real pot (well-formed betting never hits
                # this, but never lose a chip).
                pots[-1]["amount"] += amount
        prev = level

    # Merge adjacent pots with identical eligible sets (an interior level that
    # added no new contender).
    merged = []
    for p in pots:
        if merged and merged[-1]["eligible"] == p["eligible"]:
            merged[-1]["amount"] += p["amount"]
        else:
            merged.append(p)
    return merged
