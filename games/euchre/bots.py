"""Euchre bots — rule-based AI in the Spades bot mold.

Two tiers via make_bot(difficulty, rng):
  * "rookie"   — RookieBot: naive trump-count bidding, random legal play.
  * "standard" — StandardBot (the SHARP tier): weighted hand estimation for
                 both bidding rounds (bowers heavy, off-aces, voids, and who
                 the upcard helps), goes alone on monsters, sane dealer
                 discard, and partner-aware play with shallow card tracking.

All suit logic routes through rules.effective_suit, so the left bower is a
trump everywhere — following, "is partner's card boss", trick math. All
randomness flows through the injected random.Random. play() always returns a
card from rules.legal_plays(); the base-class safety net guards the engine.

Engine-facing API (duck-typed, the session normalizes args):
  bid1(view)  -> ("order", alone) | ("pass",)          round 1
  bid2(view)  -> ("call", suit, alone) | ("pass",)     round 2 (forced -> call)
  discard(hand, trump) -> card                         dealer's bury
  play(view)  -> card
"""

import random

from games.euchre import rules


def _key(card):
    return (rules.rank_of(card), rules.SUITS.index(card[1]))


def _lowest(cards):
    return min(cards, key=_key)


def _highest(cards):
    return max(cards, key=_key)


def _strength(card, trump):
    """Trump-aware absolute strength — a bower Jack must NEVER be treated
    as a middling J when picking a 'low' card."""
    if trump and rules.effective_suit(card, trump) == trump:
        return 100 + rules.trump_rank(card, trump)
    return rules.rank_of(card)


def _low(cards, trump):
    return min(cards, key=lambda c: (_strength(c, trump), _key(c)))


def _high(cards, trump):
    return max(cards, key=lambda c: (_strength(c, trump), _key(c)))


def _trumps(cards, trump):
    return [c for c in cards if rules.effective_suit(c, trump) == trump]


def _offs(cards, trump):
    return [c for c in cards if rules.effective_suit(c, trump) != trump]


def _beats(card, seat, trick, trump):
    """Would playing `card` now take the (partial) trick?"""
    return rules.trick_winner(list(trick) + [(seat, card)], trump) == seat


def _is_boss(card, trump, seen):
    """No unseen card of this effective suit can beat `card`. `seen` =
    everything we can account for (our hand + all played cards). Shallow by
    design: the buried kitty counts as 'unseen', so this is conservative
    about off-suit bosses — which is the right bias."""
    eff = rules.effective_suit(card, trump)
    if eff == trump:
        mine = rules.trump_rank(card, trump)
        return all(c in seen or rules.trump_rank(c, trump) <= mine
                   for c in rules.suit_cards(trump, trump))
    mine = rules.rank_of(card)
    return all(c in seen or rules.rank_of(c) <= mine
               for c in rules.suit_cards(eff, trump))


def estimate(hand, trump):
    """Expected tricks for `hand` if `trump` is named. Bowers weigh heaviest;
    off-aces are strong in a 24-card deck; voids add trumping chances."""
    est = 0.0
    trumps = _trumps(hand, trump)
    for c in trumps:
        tr = rules.trump_rank(c, trump)
        est += {6: 1.0, 5: 0.9, 4: 0.8, 3: 0.6, 2: 0.45}.get(tr, 0.3)
    for c in _offs(hand, trump):
        if c[0] == "A":
            est += 0.65
        elif c[0] == "K":
            est += 0.25
    if len(trumps) >= 2:
        suits_held = {rules.effective_suit(c, trump) for c in hand}
        est += 0.25 * sum(1 for s in rules.SUITS
                          if s != trump and s not in suits_held)
    return est


def make_bot(difficulty="standard", rng=None):
    """Factory the game engine calls. difficulty: "standard" | "rookie"."""
    if rng is None:
        rng = random.Random()
    if difficulty == "rookie":
        return RookieBot(rng)
    if difficulty == "standard":
        return StandardBot(rng)
    raise ValueError(f"unknown bot difficulty: {difficulty!r}")


def _normalize_view(view):
    """Defensive copy; JSON round-trips stringify int keys."""
    return {
        "hand": list(view["hand"]),
        "seat": int(view["seat"]),
        "partner": int(view["partner"]),
        "dealer": int(view["dealer"]),
        "trump": view.get("trump"),
        "upcard": view.get("upcard"),
        "turned_down": view.get("turned_down"),
        "forced": bool(view.get("forced")),
        "maker": None if view.get("maker") is None else int(view["maker"]),
        "alone": bool(view.get("alone")),
        "trick": [(int(s), c) for s, c in view.get("trick", [])],
        "played": list(view.get("played", [])),
        "tricks_won": {int(k): int(n)
                       for k, n in view.get("tricks_won", {}).items()},
    }


class Bot:
    """Base bot: normalization + legality safety net. Subclasses decide."""

    def __init__(self, rng):
        self.rng = rng

    def bid1(self, view):
        raise NotImplementedError

    def bid2(self, view):
        raise NotImplementedError

    def discard(self, hand, trump):
        """Bury the shortest off-suit's low card; never break up trump or
        toss a lone off-ace while a junk suit exists."""
        offs = _offs(hand, trump)
        if not offs:
            return _low(hand, trump)     # all trump: bury the smallest
        by_suit = {}
        for c in offs:
            by_suit.setdefault(c[1], []).append(c)

        def suit_score(cards):
            # prefer emptying a short suit; strongly avoid burning an ace
            has_ace = any(c[0] == "A" for c in cards)
            return (has_ace, len(cards), rules.rank_of(_lowest(cards)))
        best = min(by_suit.values(), key=suit_score)
        return _lowest(best)

    def play(self, view):
        view = _normalize_view(view)
        legal = rules.legal_plays(view["hand"], view["trick"], view["trump"])
        choice = self._choose(view, legal)
        if choice not in legal:
            # Safety net — must never trigger (the fuzz tests prove it).
            return _lowest(legal)
        return choice

    def _choose(self, view, legal):
        raise NotImplementedError


class RookieBot(Bot):
    """Easy tier: trump-count bidding, random legal card, never alone."""

    def bid1(self, view):
        v = _normalize_view(view)
        trump = v["upcard"][1]
        hand = v["hand"]
        if v["seat"] == v["dealer"]:
            hand = hand + [v["upcard"]]
        if len(_trumps(hand, trump)) >= 3:
            return ("order", False)
        return ("pass",)

    def bid2(self, view):
        v = _normalize_view(view)
        options = [s for s in rules.SUITS if s != v["turned_down"]]
        best = max(options, key=lambda s: len(_trumps(v["hand"], s)))
        if v["forced"] or len(_trumps(v["hand"], best)) >= 3:
            return ("call", best, False)
        return ("pass",)

    def _choose(self, view, legal):
        return self.rng.choice(legal)


class StandardBot(Bot):
    """SHARP tier: weighted estimation + partner-aware, tracked play."""

    ORDER_AT = 2.4       # est needed to order/call (≈ 3 of 5 with partner)
    ALONE_AT = 3.7       # est needed to drop the partner

    # -- bidding -----------------------------------------------------------

    def bid1(self, view):
        v = _normalize_view(view)
        up = v["upcard"]
        trump = up[1]
        seat, dealer, partner = v["seat"], v["dealer"], v["partner"]
        if seat == dealer:
            # the upcard is mine if I order: judge the post-pickup hand
            hand = v["hand"] + [up]
            hand.remove(self.discard(hand, trump))
            est = estimate(hand, trump)
        else:
            est = estimate(v["hand"], trump)
            if dealer == partner:
                est += 0.35          # ordering hands my partner a trump
            else:
                est -= 0.35          # ordering ARMS the enemy dealer
        if est >= self.ORDER_AT:
            return ("order", est >= self.ALONE_AT)
        return ("pass",)

    def bid2(self, view):
        v = _normalize_view(view)
        options = [s for s in rules.SUITS if s != v["turned_down"]]
        best = max(options, key=lambda s: estimate(v["hand"], s))
        est = estimate(v["hand"], best)
        if v["forced"] or est >= self.ORDER_AT - 0.2:   # naming it is worth a shade
            return ("call", best, est >= self.ALONE_AT)
        return ("pass",)

    # -- play --------------------------------------------------------------

    def _choose(self, view, legal):
        trump = view["trump"]
        seat, partner = view["seat"], view["partner"]
        trick = view["trick"]
        seen = set(view["played"]) | set(view["hand"]) \
            | {c for _, c in trick}
        i_am_maker_side = view["maker"] is not None \
            and view["maker"] % 2 == seat % 2

        if not trick:
            return self._lead(view, legal, seen, i_am_maker_side)

        led = rules.effective_suit(trick[0][1], trump)
        following = any(rules.effective_suit(c, trump) == led
                        for c in view["hand"])
        if following:
            return self._follow(view, legal, seen)
        return self._void(view, legal, seen)

    def _lead(self, view, legal, seen, maker_side):
        trump = view["trump"]
        trumps = _trumps(legal, trump)
        offs = _offs(legal, trump)
        # Makers with the boss trump and length: pull the enemy's teeth.
        if maker_side and len(trumps) >= 2:
            top = max(trumps, key=lambda c: rules.trump_rank(c, trump))
            if _is_boss(top, trump, seen):
                return top
        # Lone maker keeps hammering from the top.
        if maker_side and view["alone"] and view["maker"] == view["seat"] \
                and trumps:
            return max(trumps, key=lambda c: rules.trump_rank(c, trump))
        aces = [c for c in offs if c[0] == "A"]
        if aces:
            return _highest(aces)
        boss_offs = [c for c in offs if _is_boss(c, trump, seen)]
        if boss_offs:
            return _highest(boss_offs)
        if offs:
            return _lowest(offs)
        # nothing but trump left: lead the true smallest, keep the brass
        return _low(trumps, trump)

    def _follow(self, view, legal, seen):
        trump = view["trump"]
        seat, partner = view["seat"], view["partner"]
        trick = view["trick"]
        winner = rules.trick_winner(trick, trump)
        in_trick = {s for s, _ in trick}
        opps_to_come = [s for s in range(4)
                        if s not in in_trick and s != seat
                        and s % 2 != seat % 2]
        if winner == partner:
            wc = dict(trick)[partner]
            # Don't stomp partner's winner: duck when it's boss or last hand.
            if not opps_to_come or _is_boss(wc, trump, seen):
                return _low(legal, trump)
        winners = [c for c in legal if _beats(c, seat, trick, trump)]
        if winners:
            if opps_to_come:
                safe = [c for c in winners if _is_boss(c, trump, seen)]
                if safe:
                    return _low(safe, trump)
            return _low(winners, trump)
        return _low(legal, trump)

    def _void(self, view, legal, seen):
        trump = view["trump"]
        seat, partner = view["seat"], view["partner"]
        trick = view["trick"]
        partner_winning = any(s == partner for s, _ in trick) \
            and rules.trick_winner(trick, trump) == partner
        if partner_winning:
            # the house rule learned in Spades: NEVER trump partner's winner
            offs = _offs(legal, trump)
            return _lowest(offs) if offs else _low(legal, trump)
        winning_trumps = [c for c in _trumps(legal, trump)
                          if _beats(c, seat, trick, trump)]
        if winning_trumps:
            return min(winning_trumps,
                       key=lambda c: rules.trump_rank(c, trump))
        offs = _offs(legal, trump)
        if offs:
            return _lowest(offs)     # can't win: don't waste a trump
        return _low(legal, trump)
