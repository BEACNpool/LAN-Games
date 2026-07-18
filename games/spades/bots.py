"""Spades bots — rule-based AI opponents for the game hub.

Two tiers, both created through make_bot(difficulty, rng):

  * "rookie"   — RookieBot: uniformly random legal card and a naive bid.
                 The easy tier; exists to lose convincingly.
  * "standard" — StandardBot: heuristic bidding (high cards + spade length,
                 with a nil detector) and rule-based play: sensible leads,
                 cheap winners, partner awareness, nil ducking/covering, and
                 shallow card tracking (a card is "boss" once every higher
                 card of its suit has been seen).

All randomness flows through the injected random.Random — same seed + same
inputs => same outputs. No IO, no clocks. play() always returns a card from
rules.legal_plays(); a final safety net (which the fuzz tests prove never
fires) guards the engine against a heuristic bug producing an illegal card.

This module is the pattern for future game bots: the Bot base class owns
view normalization + the legality net; subclasses own only the decisions.
"""

import random

from games.spades import rules


def _key(card):
    """Deterministic total order: rank first, suit as tiebreak."""
    return (rules.rank_of(card), rules.SUITS.index(rules.suit_of(card)))


def _lowest(cards):
    return min(cards, key=_key)


def _highest(cards):
    return max(cards, key=_key)


def _beats(card, seat, trick):
    """Would playing `card` now take the lead of the (partial) trick?"""
    return rules.trick_winner(list(trick) + [(seat, card)]) == seat


def _is_boss(card, played, hand):
    """True if no unseen card of this suit can beat `card`.

    Unseen = not in `played` (completed tricks + the current table) and not
    in our own hand. Shallow by design: an opponent trumping from a void is
    not "obvious" and is ignored.
    """
    suit = rules.suit_of(card)
    seen = set(played) | set(hand)
    return all(r + suit in seen for r in rules.RANKS[rules.rank_of(card) + 1:])


def _normalize_view(view):
    """Defensive copy of the engine view; JSON round-trips stringify keys."""
    bids = {}
    for k, b in view["bids"].items():
        bids[int(k)] = b if b == "nil" else int(b)
    return {
        "hand": list(view["hand"]),
        "seat": int(view["seat"]),
        "partner": int(view["partner"]),
        "trick": [(int(s), c) for s, c in view["trick"]],
        "spades_broken": bool(view["spades_broken"]),
        "bids": bids,
        "tricks_won": {int(k): int(n) for k, n in view["tricks_won"].items()},
        "played": list(view["played"]),
    }


def make_bot(difficulty="standard", rng=None):
    """Factory the game engine calls. difficulty: "standard" | "rookie"."""
    if rng is None:
        rng = random.Random()
    if difficulty == "rookie":
        return RookieBot(rng)
    if difficulty == "standard":
        return StandardBot(rng)
    raise ValueError(f"unknown bot difficulty: {difficulty!r}")


class Bot:
    """Base bot: normalization + legality safety net. Subclasses decide."""

    def __init__(self, rng):
        self.rng = rng

    def bid(self, hand):
        raise NotImplementedError

    def play(self, view):
        view = _normalize_view(view)
        legal = rules.legal_plays(view["hand"], view["trick"],
                                  view["spades_broken"])
        choice = self._choose(view, legal)
        if choice not in legal:
            # Safety net — must never trigger (the fuzz tests prove it).
            return _lowest(legal)
        return choice

    def _choose(self, view, legal):
        raise NotImplementedError


class RookieBot(Bot):
    """Easy tier: random legal card; bid = high spades + off-suit aces."""

    def bid(self, hand):
        q = rules.RANKS.index("Q")
        n = sum(1 for c in hand if rules.suit_of(c) == "S"
                and rules.rank_of(c) >= q)
        n += sum(1 for c in hand if rules.suit_of(c) != "S" and c[0] == "A")
        return max(1, min(4, n))

    def _choose(self, view, legal):
        return self.rng.choice(legal)


class StandardBot(Bot):
    """Default tier: heuristic bid + rule-based play with card tracking."""

    # -- bidding -----------------------------------------------------------

    def bid(self, hand):
        est = self._estimate(hand)
        spades = [c for c in hand if rules.suit_of(c) == "S"]
        aces = sum(1 for c in hand if c[0] == "A")
        kings = sum(1 for c in hand if c[0] == "K")
        # Nil wants a hand that can duck everything: no ace, at most one
        # king, few/low spades (spades can't be sloughed on a spade lead).
        q = rules.RANKS.index("Q")
        duckable_spades = (len(spades) <= 2
                           and all(rules.rank_of(c) < q for c in spades))
        if aces == 0 and kings <= 1 and duckable_spades and est <= 1.0:
            return "nil"
        return max(1, min(13, int(est + 0.5)))

    def _estimate(self, hand):
        """Near-certain tricks. High spades are almost sure; extra spade
        length is guaranteed trump value; off-suit honors are discounted
        by how easily they get trumped or over-carded."""
        est = 0.0
        spades = [c for c in hand if rules.suit_of(c) == "S"]
        est += sum(1.0 for c in spades if c[0] in "AKQ")
        est += max(0, len(spades) - 3)
        for suit in "HDC":
            suit_cards = [c for c in hand if rules.suit_of(c) == suit]
            ranks = {c[0] for c in suit_cards}
            if "A" in ranks:
                est += 1.0
            if "K" in ranks:
                est += 0.5
            if "Q" in ranks and len(suit_cards) >= 3:  # protected queen
                est += 0.25
        return est

    # -- play --------------------------------------------------------------

    def _choose(self, view, legal):
        seat, partner = view["seat"], view["partner"]
        trick, bids = view["trick"], view["bids"]

        if bids.get(seat) == "nil":
            return self._nil_choice(seat, trick, legal)

        if bids.get(partner) == "nil":
            if not any(s == partner for s, _ in trick):
                return self._cover_choice(seat, trick, legal)
            if trick and rules.trick_winner(trick) == partner:
                # Partner's nil is about to bust — overtake them cheaply.
                winners = [c for c in legal if _beats(c, seat, trick)]
                return _lowest(winners) if winners else _lowest(legal)

        team_bid = 0
        for s in (seat, partner):
            b = bids.get(s, 0)
            if isinstance(b, int):
                team_bid += b
        tricks_won = view["tricks_won"]
        team_needs = (tricks_won.get(seat, 0) + tricks_won.get(partner, 0)
                      < team_bid)

        if not trick:
            return self._lead_choice(view, legal, team_needs)
        led = rules.suit_of(trick[0][1])
        if any(rules.suit_of(c) == led for c in view["hand"]):
            return self._follow_choice(view, legal)
        return self._void_choice(seat, trick, legal, team_needs)

    def _lead_choice(self, view, legal, team_needs):
        hand, played = view["hand"], view["played"]
        off = [c for c in legal if rules.suit_of(c) != "S"]
        aces = [c for c in off if c[0] == "A"]
        if aces:
            return _highest(aces)
        # Lead spades only from strength: broken, team behind its bid, and
        # we hold the boss trump — then leading it draws out the others.
        spades = [c for c in legal if rules.suit_of(c) == "S"]
        if view["spades_broken"] and team_needs and spades:
            top = _highest(spades)
            if _is_boss(top, played, hand):
                return top
        kings = [c for c in off if c[0] == "K"]
        if kings:
            boss = [c for c in kings if _is_boss(c, played, hand)]
            return _highest(boss) if boss else _highest(kings)
        if off:
            return _lowest(off)
        return _lowest(legal)  # nothing but spades left

    def _follow_choice(self, view, legal):
        seat, partner = view["seat"], view["partner"]
        trick, hand, played = view["trick"], view["hand"], view["played"]
        winner = rules.trick_winner(trick)
        in_trick = {s for s, _ in trick}
        opps_left = [s for s in range(4)
                     if s != seat and s not in in_trick and s % 2 != seat % 2]
        if winner == partner:
            winning_card = dict(trick)[winner]
            # Duck if no opponent to come can obviously beat partner's card
            # (it's boss, or nobody is left to play).
            if not opps_left or _is_boss(winning_card, played, hand):
                return _lowest(legal)
        winners = [c for c in legal if _beats(c, seat, trick)]
        if winners:
            if opps_left:
                # Prefer the cheapest winner the followers can't top.
                safe = [c for c in winners if _is_boss(c, played, hand)]
                if safe:
                    return _lowest(safe)
            return _lowest(winners)
        return _lowest(legal)

    def _void_choice(self, seat, trick, legal, team_needs):
        # never trump a trick your own partner is already winning
        partner_winning = trick and rules.trick_winner(trick) == (seat + 2) % 4
        if team_needs and not partner_winning:
            winning = [c for c in legal if rules.suit_of(c) == "S"
                       and _beats(c, seat, trick)]
            if winning:
                return _lowest(winning)  # cheapest trump that takes it
        # Comfortable (or can't win): never waste spades on a discard.
        off = [c for c in legal if rules.suit_of(c) != "S"]
        if off:
            return _lowest(off)
        return _lowest(legal)

    def _nil_choice(self, seat, trick, legal):
        """Own nil: duck at all costs."""
        if not trick:
            return _lowest(legal)
        losers = [c for c in legal if not _beats(c, seat, trick)]
        if losers:
            return _highest(losers)  # shed the biggest card that still loses
        return _lowest(legal)  # forced to win — minimize the damage

    def _cover_choice(self, seat, trick, legal):
        """Partner bid nil and hasn't played: sit high over them."""
        if not trick:
            off = [c for c in legal if rules.suit_of(c) != "S"]
            return _highest(off) if off else _highest(legal)
        winners = [c for c in legal if _beats(c, seat, trick)]
        if winners:
            return _highest(winners)  # eat the trick before partner plays
        return _lowest(legal)  # can't cover this one — keep the high cards
