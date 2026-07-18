"""Spades rules primitives — pure functions, no state, no IO.

Shared by game.py (validation/scoring) and bots.py (decision-making), and the
model for future card games. Cards are 2-char strings: rank + suit, e.g. "AS"
(ace of spades), "TD" (ten of diamonds), "2C". Seats are 0..3; team = seat % 2
(seats 0&2 vs 1&3). Spades are always trump.
"""

from __future__ import annotations

RANKS = "23456789TJQKA"          # index = strength, ascending
SUITS = "SHDC"                   # spades, hearts, diamonds, clubs

DECK = [r + s for s in SUITS for r in RANKS]           # 52 cards
BAG_LIMIT = 10                   # accumulated bags -> penalty
BAG_PENALTY = 100


def rank_of(card: str) -> int:
    return RANKS.index(card[0])


def suit_of(card: str) -> str:
    return card[1]


def sort_hand(hand):
    """Stable display/thinking order: spades high->low, then H, D, C."""
    return sorted(hand, key=lambda c: (SUITS.index(suit_of(c)), -rank_of(c)))


def legal_plays(hand, trick, spades_broken):
    """The legal cards for the player whose turn it is.

    trick: list of (seat, card) already on the table, in play order.
    Rules: must follow the led suit if able. Leading: spades cannot be led
    until broken, unless the hand is all spades.
    """
    hand = list(hand)
    if not trick:
        if spades_broken:
            return hand
        non_spades = [c for c in hand if suit_of(c) != "S"]
        return non_spades if non_spades else hand
    led = suit_of(trick[0][1])
    follow = [c for c in hand if suit_of(c) == led]
    return follow if follow else hand


def trick_winner(trick):
    """trick: full list of 4 (seat, card). Highest spade wins, else highest
    card of the led suit."""
    led = suit_of(trick[0][1])
    spades = [(s, c) for s, c in trick if suit_of(c) == "S"]
    pool = spades if spades else [(s, c) for s, c in trick if suit_of(c) == led]
    return max(pool, key=lambda sc: rank_of(sc[1]))[0]


def score_hand(bids, tricks, bags_before, nil_bonus=100, nil_penalty=100):
    """Score one completed hand for both teams.

    bids:   {seat: int 1..13 or "nil"}     tricks: {seat: int}, sum == 13
    bags_before: {team: int}
    Returns {team: {"delta": int, "bags": int_after, "made": bool,
                    "bid": int, "tricks": int,
                    "nil": [(seat, success, delta), ...]}}

    Standard casual scoring: a team's tricks (both partners') cover the sum
    of its numeric bids — 10/bid trick if met, -10/bid trick if not.
    Overtricks are bags at +1 each; hitting BAG_LIMIT accumulated bags costs
    BAG_PENALTY (and resets that ten). Nil is per-player on top: success
    (zero tricks personally) +nil_bonus, failure -nil_penalty.
    """
    out = {}
    for team in (0, 1):
        seats = [s for s in bids if s % 2 == team]
        team_bid = sum(b for s in seats if isinstance(b := bids[s], int))
        team_tricks = sum(tricks.get(s, 0) for s in seats)
        delta = 0
        nils = []
        for s in seats:
            if bids[s] == "nil":
                ok = tricks.get(s, 0) == 0
                d = nil_bonus if ok else -nil_penalty
                nils.append((s, ok, d))
                delta += d
        made = team_tricks >= team_bid
        bags = bags_before.get(team, 0)
        new_bags = 0
        if team_bid > 0:
            if made:
                delta += 10 * team_bid
                new_bags = team_tricks - team_bid
            else:
                delta -= 10 * team_bid
        else:
            # all-nil team: every trick taken is a bag
            new_bags = team_tricks
        delta += new_bags
        bags += new_bags
        while bags >= BAG_LIMIT:
            delta -= BAG_PENALTY
            bags -= BAG_LIMIT
        out[team] = {"delta": delta, "bags": bags, "made": made,
                     "bid": team_bid, "tricks": team_tricks, "nil": nils}
    return out
