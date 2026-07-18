"""Tests for games.spades.bots — legality fuzz, bid sanity, play scenarios."""

import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from games.spades import rules
from games.spades.bots import RookieBot, StandardBot, make_bot

# ---------------------------------------------------------------------------
# helpers


def make_view(hand, seat=0, trick=(), spades_broken=False, bids=None,
              tricks_won=None, played=()):
    return {
        "hand": list(hand),
        "seat": seat,
        "partner": (seat + 2) % 4,
        "trick": [list(t) for t in trick],
        "spades_broken": spades_broken,
        "bids": bids if bids is not None else {0: 3, 1: 3, 2: 3, 3: 3},
        "tricks_won": tricks_won if tricks_won is not None
                      else {0: 0, 1: 0, 2: 0, 3: 0},
        "played": list(played),
    }


def build_view(hand, seat, trick, broken, bids, tricks_won, played,
               stringify=False):
    v = make_view(hand, seat, trick, broken, dict(bids), dict(tricks_won),
                  played)
    if stringify:  # simulate a JSON round-trip: dict keys become strings
        v["bids"] = {str(k): b for k, b in v["bids"].items()}
        v["tricks_won"] = {str(k): n for k, n in v["tricks_won"].items()}
    return v


def spy_on(bot):
    """Assert the PRE-safety-net choice is legal on every play() call."""
    orig = bot._choose

    def checked(view, legal):
        c = orig(view, legal)
        assert c in legal, (
            f"pre-net illegal choice {c!r} from {type(bot).__name__} "
            f"(hand={view['hand']} trick={view['trick']})")
        return c

    bot._choose = checked
    return bot


def run_hand(rng, bots, stringify=False, force_nil_chance=0.0, collect=None):
    """Play one full 13-trick hand. bots: {seat: Bot}; other seats play
    uniformly random legal cards. Returns the number of bot plays made."""
    deck = rules.DECK[:]
    rng.shuffle(deck)
    hands = {s: deck[13 * s:13 * (s + 1)] for s in range(4)}
    bids = {}
    for s in range(4):
        if s in bots:
            bids[s] = bots[s].bid(list(hands[s]))
            assert bids[s] == "nil" or 1 <= bids[s] <= 13
            # occasionally force nil onto a bot seat to exercise nil play
            if bids[s] != "nil" and rng.random() < force_nil_chance:
                bids[s] = "nil"
        else:
            bids[s] = "nil" if rng.random() < 0.15 else rng.randint(1, 5)
    tricks_won = {s: 0 for s in range(4)}
    played = []
    broken = False
    leader = rng.randrange(4)
    n_bot_plays = 0
    for _ in range(13):
        trick = []
        for i in range(4):
            s = (leader + i) % 4
            legal = rules.legal_plays(hands[s], trick, broken)
            if s in bots:
                view = build_view(hands[s], s, trick, broken, bids,
                                  tricks_won, played, stringify=stringify)
                card = bots[s].play(view)
                assert card in legal
                n_bot_plays += 1
                if collect is not None:
                    collect.append(card)
            else:
                card = rng.choice(legal)
            hands[s].remove(card)
            trick.append((s, card))
            played.append(card)
            if rules.suit_of(card) == "S":
                broken = True
        leader = rules.trick_winner(trick)
        tricks_won[leader] += 1
    assert sum(tricks_won.values()) == 13
    assert all(not h for h in hands.values())
    return n_bot_plays


def std():
    return make_bot("standard", random.Random(0))


# ---------------------------------------------------------------------------
# legality fuzz


def test_full_random_games_bot_always_legal():
    rng = random.Random(2026)
    total = 0
    for i in range(300):
        difficulty = ("standard", "rookie")[i % 2]
        bot = spy_on(make_bot(difficulty, random.Random(i)))
        total += run_hand(rng, {i % 4: bot}, stringify=(i % 3 == 0),
                          force_nil_chance=0.2)
    assert total == 300 * 13


def test_play_fuzz_mid_trick_states():
    # Bots in all four seats: every play() call is a fresh mid-trick state,
    # and the spy asserts the pre-net choice is legal each time.
    rng = random.Random(777)
    states = 0
    for i in range(45):
        bots = {
            s: spy_on(make_bot("standard" if (i + s) % 2 else "rookie",
                               random.Random(i * 4 + s)))
            for s in range(4)
        }
        states += run_hand(rng, bots, stringify=(i % 2 == 0),
                           force_nil_chance=0.15)
    assert states >= 2000


# ---------------------------------------------------------------------------
# bidding


def test_bid_strong_hand():
    hand = ["AS", "KS", "QS", "JS", "AH", "AD", "AC",
            "2H", "3H", "4D", "5D", "2C", "3C"]
    assert std().bid(hand) >= 6


def test_bid_garbage_hand():
    hand = ["2S", "3S", "4H", "5H", "6H", "2D", "3D", "4D", "6D",
            "2C", "3C", "4C", "5C"]
    b = std().bid(hand)
    assert b == "nil" or b <= 3


def test_nil_detector_fires_on_terrible_hand():
    hand = ["2S", "3H", "4H", "5H", "6H", "7H", "2D", "3D", "4D",
            "2C", "3C", "4C", "5C"]
    assert std().bid(hand) == "nil"


def test_nil_detector_does_not_fire_with_an_ace():
    hand = ["2S", "AH", "4H", "5H", "6H", "7H", "2D", "3D", "4D",
            "2C", "3C", "4C", "5C"]
    b = std().bid(hand)
    assert b != "nil"
    assert 1 <= b <= 13


def test_rookie_bid_range():
    rook = make_bot("rookie", random.Random(0))
    strong = ["AS", "KS", "QS", "JS", "AH", "AD", "AC",
              "2H", "3H", "4D", "5D", "2C", "3C"]
    assert rook.bid(strong) == 4  # 3 high spades + 3 aces, clamped to 4
    garbage = ["2S", "3S", "4H", "5H", "6H", "2D", "3D", "4D", "6D",
               "2C", "3C", "4C", "5C"]
    assert rook.bid(garbage) == 1  # nothing counts, clamped up to 1


# ---------------------------------------------------------------------------
# play scenarios (StandardBot, seat 0, partner 2)


def test_lead_prefers_side_ace():
    view = make_view(["AH", "7H", "3D", "4D", "9C", "2C", "5S", "8S"])
    assert std().play(view) == "AH"


def test_duck_low_when_partner_winning():
    # Partner's KH is boss (AH already gone); seat 3 still to play.
    view = make_view(
        ["QH", "8H", "2H", "5D", "9C"],
        trick=[[1, "5H"], [2, "KH"]],
        played=["AH", "3H", "4H", "6H", "5H", "KH"],
        tricks_won={0: 0, 1: 0, 2: 1, 3: 0},
    )
    assert std().play(view) == "2H"


def test_void_and_behind_trumps_with_lowest_winning_spade():
    view = make_view(
        ["3S", "9S", "QS", "2C", "7C"],
        trick=[[1, "KD"], [2, "4D"]],
        bids={0: 3, 1: 2, 2: 2, 3: 2},
        played=["KD", "4D"],
    )
    assert std().play(view) == "3S"


def test_void_and_comfortable_discards_off_suit():
    view = make_view(
        ["3S", "9S", "QS", "2C", "7C"],
        trick=[[1, "KD"], [2, "4D"]],
        bids={0: 1, 1: 3, 2: 1, 3: 3},
        tricks_won={0: 2, 1: 0, 2: 1, 3: 0},  # team 0+2 already has its 2
        played=["KD", "4D"],
    )
    assert std().play(view) == "2C"


def test_own_nil_ducks_with_highest_loser():
    view = make_view(
        ["KH", "7H", "4H", "2S"],
        trick=[[1, "9H"]],
        bids={0: "nil", 1: 3, 2: 3, 3: 3},
        played=["9H"],
    )
    assert std().play(view) == "7H"


def test_king_played_as_winner_once_ace_is_gone():
    view = make_view(
        ["KH", "6H", "2H", "4C"],
        trick=[[3, "QH"]],
        played=["AH", "3H", "5H", "7H", "QH"],
    )
    assert std().play(view) == "KH"


def test_covers_partner_nil_by_playing_high():
    view = make_view(
        ["AH", "9H", "2H", "5C"],
        trick=[[1, "5H"]],
        bids={0: 3, 1: 3, 2: "nil", 3: 3},
        played=["5H"],
    )
    assert std().play(view) == "AH"


# ---------------------------------------------------------------------------
# safety net, factory, normalization


def test_safety_net_falls_back_to_lowest_legal():
    bot = std()
    bot._choose = lambda view, legal: "XX"  # simulate a heuristic bug
    view = make_view(["2H", "3D"], trick=[[1, "9H"]], played=["9H"])
    assert bot.play(view) == "2H"


def test_make_bot_types_and_unknown():
    assert isinstance(make_bot("standard", random.Random(0)), StandardBot)
    assert isinstance(make_bot("rookie", random.Random(0)), RookieBot)
    with pytest.raises(ValueError):
        make_bot("grandmaster", random.Random(0))


def test_string_key_views_are_normalized():
    view = make_view(
        ["2H", "9H", "4C"],
        trick=[[1, "5H"]],
        bids={"0": 3, "1": 3, "2": "nil", "3": 3},
        tricks_won={"0": 0, "1": 0, "2": 0, "3": 0},
        played=["5H"],
    )
    card = std().play(view)
    assert card in rules.legal_plays(["2H", "9H", "4C"], [(1, "5H")], False)
    assert card == "9H"  # partner-nil cover still recognized through str keys


# ---------------------------------------------------------------------------
# determinism


def test_determinism_full_hands():
    def run(difficulty, seed):
        out = []
        rng = random.Random(seed)
        bots = {s: make_bot(difficulty, random.Random(seed + s))
                for s in range(4)}
        for _ in range(3):
            run_hand(rng, bots, force_nil_chance=0.2, collect=out)
        return out

    for difficulty in ("standard", "rookie"):
        assert run(difficulty, 4242) == run(difficulty, 4242)


def test_determinism_single_state():
    hand = ["AH", "7H", "3D", "4D", "9C", "2C", "5S", "8S"]
    view = make_view(hand)
    for difficulty in ("standard", "rookie"):
        a = make_bot(difficulty, random.Random(5)).play(make_view(hand))
        b = make_bot(difficulty, random.Random(5)).play(make_view(hand))
        assert a == b
        assert (make_bot(difficulty, random.Random(5)).bid(hand)
                == make_bot(difficulty, random.Random(5)).bid(hand))
    assert std().play(view) == std().play(view)
