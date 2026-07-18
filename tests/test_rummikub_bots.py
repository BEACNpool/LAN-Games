"""Tests for games.rummikub.bots — legality fuzz, meld discipline, scenarios."""

import copy
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from games.rummikub import rules
from games.rummikub.bots import BaselineBot, RummikubBot, make_bot

TURN_CAP = 400

# ---------------------------------------------------------------------------
# helpers


def make_view(hand, board=(), melded=False, pool_count=40):
    return {"hand": list(hand), "board": [list(g) for g in board],
            "melded": melded, "pool_count": pool_count}


def bot():
    return make_bot("baseline", random.Random(0))


def spy_on(b):
    """Assert the PRE-safety-net proposal is legal on every choose() call."""
    orig = b._propose

    def checked(view):
        nb = orig(view)
        if nb is not None:
            res = rules.check_turn(view["board"], nb, view["hand"],
                                   view["melded"])
            assert res["ok"], (
                f"pre-net illegal board from {type(b).__name__}: "
                f"{res['reason']} (hand={view['hand']})")
        return nb

    b._propose = checked
    return b


def play_game(n_players, seed):
    """One bots-only game: deal via build_pool + shuffle, alternate turns,
    apply plays through rules.check_turn (the engine's own verify), draw
    when told. Ends at an empty hand, or pool empty + everyone passing.
    Returns {"winner": seat|None, "turns": int, "plays": int}."""
    rng = random.Random(seed)
    pool = rules.build_pool(n_players)
    rng.shuffle(pool)
    hands = [[pool.pop() for _ in range(rules.HAND_SIZE)]
             for _ in range(n_players)]
    bots = [spy_on(make_bot("baseline", random.Random(seed * 31 + p)))
            for p in range(n_players)]
    board = []
    melded = [False] * n_players
    passes = 0
    plays = 0
    for turn in range(TURN_CAP):
        p = turn % n_players
        view = make_view(hands[p], board, melded[p], len(pool))
        move = bots[p].choose(view)
        if "board" in move:
            res = rules.check_turn(board, move["board"], hands[p], melded[p])
            assert res["ok"], res["reason"]
            for t in res["played"]:
                hands[p].remove(t)
            board = [list(g) for g in move["board"]]
            melded[p] = True
            passes = 0
            plays += 1
            if not hands[p]:
                return {"winner": p, "turns": turn + 1, "plays": plays}
        else:
            assert move == {"draw": True}
            if pool:
                hands[p].append(pool.pop())
                passes = 0
            else:
                passes += 1
                if passes >= n_players:  # pool empty and everyone stuck
                    return {"winner": None, "turns": turn + 1, "plays": plays}
    raise AssertionError(f"game exceeded the {TURN_CAP}-turn cap")


# ---------------------------------------------------------------------------
# legality fuzz


def test_fuzz_300_two_player_games():
    wins = 0
    plays = 0
    for seed in range(300):
        out = play_game(2, seed)
        assert out["turns"] <= TURN_CAP
        plays += out["plays"]
        if out["winner"] is not None:
            wins += 1
    assert plays > 0  # the bots actually commit plays
    assert wins > 0   # ... and some games end with an emptied hand


def test_fuzz_five_player_pool_variant():
    assert len(rules.build_pool(5)) == 212  # double set, 4 jokers
    wins = 0
    plays = 0
    for seed in range(60):
        out = play_game(5, seed + 1000)
        assert out["turns"] <= TURN_CAP
        plays += out["plays"]
        if out["winner"] is not None:
            wins += 1
    assert plays > 0
    assert wins > 0


# ---------------------------------------------------------------------------
# meld discipline


def test_opens_with_obvious_30():
    hand = ["r11.0", "r12.0", "r13.0", "b02.0", "k05.0"]
    mv = bot().choose(make_view(hand))
    assert "board" in mv
    assert ["r11.0", "r12.0", "r13.0"] in mv["board"]
    res = rules.check_turn([], mv["board"], hand, melded=False)
    assert res["ok"] and res["meld_total"] >= rules.MELD_MIN


def test_nine_point_set_is_held_before_meld():
    hand = ["b02.0", "b03.0", "b04.0", "r07.0", "k01.0", "y13.0"]
    assert bot().choose(make_view(hand)) == {"draw": True}


def test_same_nine_point_set_played_after_meld():
    hand = ["b02.0", "b03.0", "b04.0", "r07.0", "k01.0", "y13.0"]
    board = [["r09.0", "r10.0", "r11.0"]]
    mv = bot().choose(make_view(hand, board, melded=True))
    assert "board" in mv
    assert ["b02.0", "b03.0", "b04.0"] in mv["board"]
    assert mv["board"][0] == board[0]  # existing group untouched


# ---------------------------------------------------------------------------
# single-tile extensions (melded)


def test_run_extension_append():
    board = [["r05.0", "r06.0", "r07.0"]]
    hand = ["r08.0", "b01.0", "k13.0"]
    mv = bot().choose(make_view(hand, board, melded=True))
    # plays the extension instead of drawing; order preserved + appended
    assert mv == {"board": [["r05.0", "r06.0", "r07.0", "r08.0"]]}


def test_run_extension_prepend_keeps_order():
    board = [["r05.0", "r06.0", "r07.0"]]
    hand = ["r04.0", "y02.0"]
    mv = bot().choose(make_view(hand, board, melded=True))
    assert mv == {"board": [["r04.0", "r05.0", "r06.0", "r07.0"]]}


def test_group_extension_fourth_color():
    board = [["r09.0", "b09.0", "k09.0"]]
    hand = ["y09.0", "b01.0"]
    mv = bot().choose(make_view(hand, board, melded=True))
    assert mv == {"board": [["r09.0", "b09.0", "k09.0", "y09.0"]]}


def test_multiple_extensions_in_one_commit():
    board = [["r05.0", "r06.0", "r07.0"], ["b09.0", "k09.0", "y09.0"]]
    hand = ["r04.0", "r08.0", "r09.0", "k02.0"]
    mv = bot().choose(make_view(hand, board, melded=True))
    # r04+r08 onto both ends of the run, r09 as the group's fourth color
    assert mv["board"][0] == ["r04.0", "r05.0", "r06.0", "r07.0", "r08.0"]
    assert mv["board"][1] == ["b09.0", "k09.0", "y09.0", "r09.0"]
    res = rules.check_turn(board, mv["board"], hand, melded=True)
    assert res["ok"] and sorted(res["played"]) == ["r04.0", "r08.0", "r09.0"]


# ---------------------------------------------------------------------------
# joker discipline


def test_joker_not_burned_on_a_complete_run():
    board = [["k11.0", "k12.0", "k13.0"]]
    hand = ["r05.0", "r06.0", "r07.0", "J.0"]
    mv = bot().choose(make_view(hand, board, melded=True))
    assert ["r05.0", "r06.0", "r07.0"] in mv["board"]
    assert "J.0" not in rules.board_tiles(mv["board"])  # joker stays home


def test_joker_completes_a_set_that_would_not_exist():
    board = [["k11.0", "k12.0", "k13.0"]]
    hand = ["b09.0", "b10.0", "J.0", "r02.0"]
    mv = bot().choose(make_view(hand, board, melded=True))
    assert ["b09.0", "b10.0", "J.0"] in mv["board"]


def test_opening_counts_joker_at_represented_value():
    # pair at the top of a run: joker must sit in front (J=11 -> 36 points)
    hand = ["r12.0", "r13.0", "J.0", "b03.0"]
    mv = bot().choose(make_view(hand))
    assert "board" in mv
    assert ["J.0", "r12.0", "r13.0"] in mv["board"]
    res = rules.check_turn([], mv["board"], hand, melded=False)
    assert res["ok"] and res["meld_total"] == 36


def test_joker_set_below_30_is_still_held():
    hand = ["r02.0", "r03.0", "J.0", "k08.0"]  # best set is 2+3+4 = 9 points
    assert bot().choose(make_view(hand)) == {"draw": True}


# ---------------------------------------------------------------------------
# no rearrangement in v1 + the SmartBot hook


def test_no_rearrangement_in_v1():
    # r08.0 fits only by splitting the board run; baseline never does that.
    board = [["r05.0", "r06.0", "r07.0", "r08.1", "r09.0", "r10.0"]]
    hand = ["r08.0"]
    assert bot().choose(make_view(hand, board, melded=True)) == {"draw": True}


def test_rearrangement_hook_default_is_empty():
    assert bot()._rearrangement_candidates(make_view(["r05.0"])) == []


def test_rearrangement_hook_is_consulted_by_a_subclass():
    class SmartBot(BaselineBot):
        def _rearrangement_candidates(self, view):
            return [[["r05.0", "r06.0", "r07.0", "r08.0"],
                     ["r08.1", "r09.0", "r10.0"]]]

    board = [["r05.0", "r06.0", "r07.0", "r08.1", "r09.0", "r10.0"]]
    hand = ["r08.0"]
    mv = SmartBot(random.Random(0)).choose(make_view(hand, board, melded=True))
    assert mv == {"board": [["r05.0", "r06.0", "r07.0", "r08.0"],
                            ["r08.1", "r09.0", "r10.0"]]}


# ---------------------------------------------------------------------------
# safety net, factory, hygiene


def test_safety_net_degrades_to_draw():
    b = bot()
    b._propose = lambda view: [["r01.0", "r99.9"]]  # simulate a bot bug
    view = make_view(["r05.0"], [["k11.0", "k12.0", "k13.0"]], melded=True)
    assert b.choose(view) == {"draw": True}


def test_make_bot_factory():
    b = make_bot("baseline", random.Random(0))
    assert isinstance(b, BaselineBot) and isinstance(b, RummikubBot)
    with pytest.raises(ValueError):
        make_bot("grandmaster", random.Random(0))


def test_view_is_not_mutated():
    view = make_view(["r05.0", "r06.0", "r07.0", "r08.0"],
                     [["b09.0", "b10.0", "b11.0"]], melded=True)
    snap = copy.deepcopy(view)
    mv = bot().choose(view)
    assert "board" in mv  # it did play (the 4-run from hand)
    assert view == snap


# ---------------------------------------------------------------------------
# determinism


def test_determinism_same_seed_same_view():
    hand = ["r11.0", "r12.0", "r13.0", "b09.0", "k09.0", "y09.0",
            "b02.0", "J.0"]
    board = [["k05.0", "k06.0", "k07.0"]]
    for melded in (False, True):
        a = make_bot("baseline", random.Random(9)).choose(
            make_view(hand, board, melded))
        b = make_bot("baseline", random.Random(9)).choose(
            make_view(hand, board, melded))
        assert a == b
    # repeated calls on one instance agree too
    b1 = bot()
    v = make_view(hand, board, melded=True)
    assert b1.choose(copy.deepcopy(v)) == b1.choose(copy.deepcopy(v))


def test_determinism_full_games():
    def trace(seed):
        return [play_game(2, seed) for _ in range(3)]

    assert trace(4242) == trace(4242)
