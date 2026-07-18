"""Euchre rules primitives — pure functions, no state, no IO.

Cards are 2-char strings rank+suit like the Spades engine: "9H", "TD", "JS",
"AC". 24-card deck (9..A in four suits). Seats 0..3, team = seat % 2.

THE BOWERS (the part every bad implementation gets wrong):
  * right bower = the Jack OF the trump suit — highest trump
  * left bower  = the Jack of the SAME-COLOR suit — second-highest trump,
    and it IS a trump-suit card for every purpose: following suit, the
    "must follow" check, and trick evaluation. A player holding only the
    left bower of a led natural suit does NOT hold that suit.
Everything here routes through effective_suit() so that fact is structural,
not a special case sprinkled around.

Trump ranking: right bower, left bower, A, K, Q, T, 9 (the trump suit's own
Jack is always the right bower, so no plain J exists inside trump).
Off-suits rank A K Q J T 9 — except the same-color suit, which has no Jack
(it defected to trump).
"""

from __future__ import annotations

RANKS = "9TJQKA"                 # index = strength ascending (off-suit)
SUITS = "SHDC"                   # spades, hearts, diamonds, clubs

DECK = [r + s for s in SUITS for r in RANKS]        # 24 cards

SAME_COLOR = {"S": "C", "C": "S", "H": "D", "D": "H"}

# strength of a non-bower card inside the trump suit (no J: it's the right)
_TRUMP_BASE = {"9": 0, "T": 1, "Q": 2, "K": 3, "A": 4}
LEFT_RANK = 5
RIGHT_RANK = 6


def rank_of(card: str) -> int:
    return RANKS.index(card[0])


def suit_of(card: str) -> str:
    """The card's printed suit. Almost never what you want mid-hand —
    use effective_suit(card, trump)."""
    return card[1]


def is_right(card: str, trump: str) -> bool:
    return card == "J" + trump


def is_left(card: str, trump: str) -> bool:
    return card == "J" + SAME_COLOR[trump]


def effective_suit(card: str, trump: str | None) -> str:
    """The suit the card BELONGS to once trump is named: the left bower
    counts as trump, everything else is its printed suit."""
    if trump and is_left(card, trump):
        return trump
    return card[1]


def trump_rank(card: str, trump: str) -> int:
    """Strength within trump (only meaningful if effective_suit == trump)."""
    if is_right(card, trump):
        return RIGHT_RANK
    if is_left(card, trump):
        return LEFT_RANK
    return _TRUMP_BASE[card[0]]


def power(card: str, led_suit: str, trump: str) -> int:
    """Comparable strength of a card in a trick where `led_suit` is the
    EFFECTIVE suit led. Trumps tower over the led suit; off-suit trash
    can't win."""
    if effective_suit(card, trump) == trump:
        return 100 + trump_rank(card, trump)
    if effective_suit(card, trump) == led_suit:
        return rank_of(card)
    return -1


def suit_cards(suit: str, trump: str | None) -> list[str]:
    """Every card whose EFFECTIVE suit is `suit` (trump gains the left
    bower; the same-color suit loses its Jack)."""
    return [c for c in DECK if effective_suit(c, trump) == suit]


def legal_plays(hand, trick, trump):
    """Legal cards for the player to act. trick: [(seat, card), ...] in play
    order. Must follow the led EFFECTIVE suit if able — a hand whose only
    card of the led natural suit is the left bower is void in that suit."""
    hand = list(hand)
    if not trick:
        return hand
    led = effective_suit(trick[0][1], trump)
    follow = [c for c in hand if effective_suit(c, trump) == led]
    return follow if follow else hand


def trick_winner(trick, trump):
    """trick: the completed trick as [(seat, card), ...] (3 entries during a
    lone hand, else 4). Highest trump wins, else highest of the led suit."""
    led = effective_suit(trick[0][1], trump)
    return max(trick, key=lambda sc: power(sc[1], led, trump))[0]


def sort_hand(hand, trump=None):
    """Display order: trump first (right bower down to 9), then the other
    suits A-high. Before trump exists: plain suit groups."""
    def key(c):
        eff = effective_suit(c, trump)
        if trump and eff == trump:
            return (0, -trump_rank(c, trump))
        return (1 + SUITS.index(eff), -rank_of(c))
    return sorted(hand, key=key)


def deal(rng, dealer):
    """Shuffle and deal 5 cards each in packets (3-2 then 2-3, starting left
    of the dealer), turn one card up, bury the rest.
    Returns (hands {seat: [5 cards]}, upcard, kitty [3 cards])."""
    deck = list(DECK)
    rng.shuffle(deck)
    hands = {s: [] for s in range(4)}
    order = [(dealer + 1 + i) % 4 for i in range(4)]
    i = 0
    for packet_row in ((3, 2, 3, 2), (2, 3, 2, 3)):
        for seat, size in zip(order, packet_row):
            hands[seat].extend(deck[i:i + size])
            i += size
    return hands, deck[i], deck[i + 1:]


def score_hand(maker_team, team_tricks, alone):
    """Score one completed hand.

    maker_team: 0|1     team_tricks: {0: int, 1: int} summing to 5
    alone: the maker played alone
    Returns {"team", "points", "euchred", "march"} — the team that scores
    and how much. Exactly one team scores per hand:
      makers 3-4 tricks -> 1 (alone or not)   makers 5 -> 2, alone 5 -> 4
      makers < 3        -> EUCHRED: defenders 2
    """
    mt = team_tricks[maker_team]
    if mt >= 3:
        march = mt == 5
        points = (4 if alone else 2) if march else 1
        return {"team": maker_team, "points": points,
                "euchred": False, "march": march}
    return {"team": 1 - maker_team, "points": 2,
            "euchred": True, "march": False}
