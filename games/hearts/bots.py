"""Hearts bots — rule-based AI opponents for the game hub.

Two tiers, both created through make_bot(difficulty, rng):

  * "rookie"   — RookieBot: greedy pass (three biggest cards) and a random
                 legal play. The easy tier; exists to eat the queen.
  * "standard" — StandardBot (SHARP in the UI): passes away the killers
                 (Q/A/K♠ unless deeply protected) and high hearts, builds
                 voids in short suits; in play it smokes out the Q♠ with low
                 spades, ducks under dangerous tricks, drops the queen on an
                 A/K♠, sheds liabilities when void, takes cheap early tricks,
                 and plays minimal moon defense (grabs a heart back when one
                 opponent owns every point late in the hand).

Same contract as games/spades/bots.py: all randomness flows through the
injected random.Random — same seed + same inputs => same outputs. No IO, no
clocks. play() always returns a card from rules.legal_plays(); a final
safety net (which the fuzz tests prove never fires) guards the engine.
pass_cards() always returns 3 distinct cards from the hand.
"""

import random

from games.hearts import rules


def _key(card):
    """Deterministic total order: rank first, suit as tiebreak."""
    return (rules.rank_of(card), rules.SUITS.index(rules.suit_of(card)))


def _lowest(cards):
    return min(cards, key=_key)


def _highest(cards):
    return max(cards, key=_key)


def _takes(card, seat, trick):
    """Would playing `card` now take the lead of the (partial) trick?"""
    return rules.trick_winner(list(trick) + [(seat, card)]) == seat


def _normalize_view(view):
    """Defensive copy of the engine view; JSON round-trips stringify keys."""
    return {
        "hand": list(view["hand"]),
        "seat": int(view["seat"]),
        "trick": [(int(s), c) for s, c in view["trick"]],
        "trick_no": int(view["trick_no"]),
        "hearts_broken": bool(view["hearts_broken"]),
        "played": list(view["played"]),
        "pts": {int(k): int(v) for k, v in view["pts"].items()},
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

    def pass_cards(self, hand):
        raise NotImplementedError

    def play(self, view):
        view = _normalize_view(view)
        legal = rules.legal_plays(view["hand"], view["trick"],
                                  view["hearts_broken"], view["trick_no"])
        choice = self._choose(view, legal)
        if choice not in legal:
            # Safety net — must never trigger (the fuzz tests prove it).
            return _lowest(legal)
        return choice

    def _choose(self, view, legal):
        raise NotImplementedError


class RookieBot(Bot):
    """Easy tier: shoves the three biggest cards; plays a random legal card."""

    def pass_cards(self, hand):
        return sorted(hand, key=_key, reverse=True)[:rules.PASS_COUNT]

    def _choose(self, view, legal):
        return self.rng.choice(legal)


class StandardBot(Bot):
    """Default tier: heuristic pass + rule-based play with card tracking."""

    # -- passing -----------------------------------------------------------

    def pass_cards(self, hand):
        hand = list(hand)
        spades = [c for c in hand if rules.suit_of(c) == "S"]
        picks = []
        # 1) the killers — unless deeply protected (4+ spades ride it out)
        if len(spades) <= 3:
            for c in (rules.QUEEN, "AS", "KS"):
                if c in hand and len(picks) < rules.PASS_COUNT:
                    picks.append(c)
        # 2) high hearts
        jack = rules.RANKS.index("J")
        high_hearts = sorted((c for c in hand if rules.suit_of(c) == "H"
                              and rules.rank_of(c) >= jack),
                             key=_key, reverse=True)
        for c in high_hearts:
            if len(picks) < rules.PASS_COUNT:
                picks.append(c)
        # 3) void out a short club/diamond suit (sloughing beats following)
        if len(picks) < rules.PASS_COUNT:
            for suit in sorted("CD", key=lambda s: len(
                    [c for c in hand if rules.suit_of(c) == s])):
                cards = [c for c in hand
                         if rules.suit_of(c) == suit and c not in picks]
                if 0 < len(cards) <= rules.PASS_COUNT - len(picks):
                    picks.extend(sorted(cards, key=_key, reverse=True))
        # 4) fill with the biggest liabilities left — but low spades stay
        #    home (they guard against the queen)
        queen_rank = rules.RANKS.index("Q")
        rest = sorted((c for c in hand if c not in picks),
                      key=_key, reverse=True)
        for c in rest:
            if len(picks) >= rules.PASS_COUNT:
                break
            if rules.suit_of(c) == "S" and rules.rank_of(c) < queen_rank:
                continue
            picks.append(c)
        for c in rest:                       # absolute fallback
            if len(picks) >= rules.PASS_COUNT:
                break
            if c not in picks:
                picks.append(c)
        return picks[:rules.PASS_COUNT]

    # -- play --------------------------------------------------------------

    def _moon_threat(self, view):
        """The seat shooting the moon on us, or None. Late hand, one other
        seat holds EVERY point taken so far, and it's real accumulation."""
        pts = view["pts"]
        holders = [s for s, p in pts.items() if p > 0]
        if (view["trick_no"] >= 8 and len(holders) == 1
                and holders[0] != view["seat"] and pts[holders[0]] >= 10):
            return holders[0]
        return None

    def _choose(self, view, legal):
        trick = view["trick"]
        if not trick:
            return self._lead_choice(view, legal)
        led = rules.suit_of(trick[0][1])
        if any(rules.suit_of(c) == led for c in view["hand"]):
            return self._follow_choice(view, legal)
        return self._void_choice(view, legal)

    def _lead_choice(self, view, legal):
        hand, played = view["hand"], view["played"]
        qs_out = rules.QUEEN not in played and rules.QUEEN not in hand
        # moon defense: lead a high heart to snatch a point back
        if self._moon_threat(view) is not None:
            hearts = [c for c in legal if rules.suit_of(c) == "H"]
            if hearts:
                return _highest(hearts)
        # smoke the queen out with low spades while someone else holds her
        if qs_out:
            queen_rank = rules.RANKS.index("Q")
            low_spades = [c for c in legal if rules.suit_of(c) == "S"
                          and rules.rank_of(c) < queen_rank]
            if low_spades:
                return _lowest(low_spades)
        # never lead A/K♠ while the queen is out
        pool = [c for c in legal if not (qs_out and c in ("AS", "KS"))] or legal
        off = [c for c in pool if rules.suit_of(c) != "H"] or pool
        return _lowest(off)

    def _follow_choice(self, view, legal):
        seat, trick = view["seat"], view["trick"]
        trick_pts = sum(rules.points_of(c) for _, c in trick)
        n_after = 3 - len(trick)
        if view["trick_no"] == 1:
            return _highest(legal)        # no points can land — unload
        winners = [c for c in legal if _takes(c, seat, trick)]
        unders = [c for c in legal if c not in winners]
        # moon defense: eat a pointed trick to spoil the shoot
        if self._moon_threat(view) is not None and trick_pts > 0 and winners:
            pool = [c for c in winners if c != rules.QUEEN] or winners
            return _highest(pool)
        if rules.QUEEN in unders:
            return rules.QUEEN            # drop her on that A/K♠
        # last to act on a clean early trick: take it cheap with a low card
        if n_after == 0 and trick_pts == 0 and view["trick_no"] <= 5:
            cheap = [c for c in winners if c != rules.QUEEN]
            if cheap:
                return _lowest(cheap)
        if unders:
            return _highest(unders)       # duck, shedding the biggest loser
        pool = [c for c in winners if c != rules.QUEEN] or winners
        if n_after == 0 and trick_pts == 0:
            return _highest(pool)         # forced win but free — unload
        return _lowest(pool)              # forced win — keep it cheap

    def _void_choice(self, view, legal):
        # can't follow: unload the liabilities, biggest first
        if rules.QUEEN in legal:
            return rules.QUEEN
        qs_out = (rules.QUEEN not in view["played"]
                  and rules.QUEEN not in view["hand"])
        if qs_out:
            for c in ("AS", "KS"):
                if c in legal:
                    return c
        hearts = [c for c in legal if rules.suit_of(c) == "H"]
        if hearts:
            return _highest(hearts)
        return _highest(legal)
