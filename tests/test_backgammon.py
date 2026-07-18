"""Backgammon engine tests — every starred rule in the spec gets a test.

Conventions under test (see games/backgammon/engine.py docstring):
  * dance -> legal_turns == [[]] and apply_turn(state, []) passes the roll;
  * apply_turn accepts any stepwise-legal play order that uses the maximum
    number of dice, and rejects everything else with ValueError.
"""

import random
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from games.backgammon import engine
from games.backgammon.engine import (
    apply_turn,
    choose,
    legal_turns,
    new_game,
    pip_count,
    start_turn,
)


# ---------------------------------------------------------------- helpers

def make(points=None, bar=None, off=None, turn="w"):
    """Bare position builder; counts follow the +white/-black encoding."""
    st = {
        "points": [0] * 24,
        "bar": {"w": 0, "b": 0},
        "off": {"w": 0, "b": 0},
        "turn": turn,
        "dice": None,
        "remaining": [],
        "result": None,
    }
    for p, n in (points or {}).items():
        st["points"][p] = n
    if bar:
        st["bar"].update(bar)
    if off:
        st["off"].update(off)
    return st


def steps_of(turns):
    """Flatten a turn list to the set of all steps that appear anywhere."""
    return {s for t in turns for s in t}


def check_invariants(state):
    w = sum(n for n in state["points"] if n > 0)
    b = sum(-n for n in state["points"] if n < 0)
    assert w + state["bar"]["w"] + state["off"]["w"] == 15
    assert b + state["bar"]["b"] + state["off"]["b"] == 15
    # One signed int per point: a point holding both colors is unrepresentable,
    # so "no mixed points" reduces to the encoding being ints in sane range.
    for n in state["points"]:
        assert isinstance(n, int) and -15 <= n <= 15
    for side in ("w", "b"):
        assert state["bar"][side] >= 0
        assert 0 <= state["off"][side] <= 15


def play_game(seed, w_tier="rookie", b_tier="rookie", cap=500, check=False):
    """One full game with session-owned dice; returns (state, plies, history)."""
    rng = random.Random(seed)
    state = new_game("w" if rng.random() < 0.5 else "b")
    plies = 0
    history = []
    while state["result"] is None and plies < cap:
        dice = [rng.randint(1, 6), rng.randint(1, 6)]
        state = start_turn(state, dice)
        turn = choose(state, w_tier if state["turn"] == "w" else b_tier, rng)
        if check:
            assert turn in legal_turns(state)
            check_invariants(state)
        state = apply_turn(state, turn)
        if check:
            check_invariants(state)
        history.append((dice, turn))
        plies += 1
    return state, plies, history


# ---------------------------------------------------------------- setup

def test_new_game_setup():
    st = new_game()
    assert st["points"][23] == 2 and st["points"][12] == 5
    assert st["points"][7] == 3 and st["points"][5] == 5
    assert st["points"][0] == -2 and st["points"][11] == -5
    assert st["points"][16] == -3 and st["points"][18] == -5
    assert sum(n for n in st["points"] if n > 0) == 15
    assert sum(-n for n in st["points"] if n < 0) == 15
    assert st["turn"] == "w" and st["dice"] is None and st["result"] is None
    assert new_game("b")["turn"] == "b"
    with pytest.raises(ValueError):
        new_game("x")


def test_starting_pip_counts_are_167():
    st = new_game()
    assert pip_count(st, "w") == 167
    assert pip_count(st, "b") == 167


def test_pip_count_bar_is_25():
    st = make({5: 1}, bar={"w": 2})
    assert pip_count(st, "w") == 2 * 25 + 6
    st = make({20: -1}, bar={"b": 1})
    assert pip_count(st, "b") == 25 + 4


def test_start_turn_dice_and_remaining():
    st = start_turn(new_game(), [4, 2])
    assert st["dice"] == [4, 2] and st["remaining"] == [4, 2]
    st = start_turn(new_game(), [3, 3])
    assert st["remaining"] == [3, 3, 3, 3]
    with pytest.raises(ValueError):
        start_turn(new_game(), [7, 1])
    with pytest.raises(ValueError):
        start_turn(st, [1, 2])  # turn already in progress


# ---------------------------------------------------------------- bar entry

def test_bar_checkers_must_enter_first():
    st = start_turn(make({12: 5}, bar={"w": 1}), [3, 5])
    turns = legal_turns(st)
    assert turns and all(t[0][0] == "bar" for t in turns)
    assert all(len(t) == 2 for t in turns)  # entry never blocks the other die


def test_blocked_entry_is_a_dance():
    st = start_turn(make({12: 1, 22: -2, 20: -2}, bar={"w": 1}), [2, 4])
    assert legal_turns(st) == [[]]
    nxt = apply_turn(st, [])
    assert nxt["turn"] == "b" and nxt["dice"] is None and nxt["remaining"] == []
    assert nxt["bar"]["w"] == 1  # still stuck
    with pytest.raises(ValueError):
        apply_turn(st, [("bar", 22)])


def test_partial_entry_when_only_one_die_enters():
    # Two on the bar, 19 blocked: enter one with the 3, the 5 dies unplayed.
    st = start_turn(make({19: -2}, bar={"w": 2}), [3, 5])
    assert legal_turns(st) == [[("bar", 21)]]


def test_enter_then_play_other_die():
    st = start_turn(make({5: 1, 19: -2}, bar={"w": 1}), [3, 5])
    turns = legal_turns(st)
    assert sorted(turns) == sorted(
        [[("bar", 21), (21, 16)], [("bar", 21), (5, 0)]]
    )


def test_entry_hits_a_blot():
    st = start_turn(make({21: -1, 18: -2}, bar={"w": 1}), [3, 3])
    assert legal_turns(st) == [[("bar", 21)]]  # 21->18 blocked afterwards
    nxt = apply_turn(st, [("bar", 21)])
    assert nxt["points"][21] == 1
    assert nxt["bar"] == {"w": 0, "b": 1}


def test_black_entry_mirrored():
    # Black enters on die-1; die 3 -> point 2 (blocked here), die 5 -> point 4.
    st = start_turn(make({2: 2}, bar={"b": 1}, turn="b"), [3, 5])
    turns = legal_turns(st)
    assert turns and all(t[0] == ("bar", 4) for t in turns)


# ------------------------------------------------- both-dice / higher-die

def test_must_play_both_dice_order_forced():
    # 23->18 (the 5) is blocked, so only 6-then-5 plays both dice; playing
    # the 5 first (impossible) or the 6 alone (under-use) is illegal.
    st = start_turn(make({23: 1, 18: -2}), [5, 6])
    assert legal_turns(st) == [[(23, 17), (17, 12)]]
    with pytest.raises(ValueError):
        apply_turn(st, [(23, 17)])  # under-uses the dice


def test_higher_die_forced_when_either_but_not_both():
    # The classic: one checker, both single-die moves land fine but every
    # continuation is blocked on 12 — so the higher die (6) is forced.
    st = start_turn(make({23: 1, 12: -2}), [6, 5])
    assert legal_turns(st) == [[(23, 17)]]
    with pytest.raises(ValueError):
        apply_turn(st, [(23, 18)])  # the lower die alone


# ---------------------------------------------------- hitting / blocking

def test_landing_on_blot_hits_to_bar():
    st = start_turn(make({10: 1, 20: 1, 7: -1}), [3, 6])
    nxt = apply_turn(st, [(10, 7), (20, 14)])
    assert nxt["points"][7] == 1 and nxt["points"][10] == 0
    assert nxt["points"][14] == 1 and nxt["points"][20] == 0
    assert nxt["bar"]["b"] == 1
    assert nxt["turn"] == "b" and nxt["dice"] is None


def test_blocked_point_is_not_landable():
    # Only move would be 10->7, but black holds it with two: dance.
    st = start_turn(make({10: 1, 7: -2, 4: -2}), [3, 3])
    assert legal_turns(st) == [[]]
    with pytest.raises(ValueError):
        apply_turn(st, [(10, 7)])


# ---------------------------------------------------------------- bear-off

def test_bear_off_exact_die():
    st = start_turn(
        make({3: 1, 1: 1, 12: -14}, off={"w": 13, "b": 1}), [4, 2]
    )
    turns = legal_turns(st)
    assert (3, "off") in steps_of(turns) and (1, "off") in steps_of(turns)
    nxt = apply_turn(st, [(3, "off"), (1, "off")])
    assert nxt["off"]["w"] == 15
    assert nxt["result"] == {"winner": "w", "kind": "single"}


def test_bear_off_higher_die_from_highest_point():
    # Die 6 with nothing above point 2: overshoot bears off the highest.
    st = start_turn(make({2: 1, 0: 1}), [6, 1])
    assert [(2, "off"), (0, "off")] in legal_turns(st)


def test_no_overshoot_while_higher_point_occupied():
    # Die 4, point 3 empty, point 5 occupied: no bear-off from 2 until the
    # 5-point checker has moved — every turn must start (5, 1).  After that
    # the overshoot becomes legal dynamically.
    st = start_turn(make({5: 1, 2: 1}), [4, 4])
    turns = legal_turns(st)
    assert turns and all(t[0] == (5, 1) for t in turns)
    assert [(5, 1), (2, "off"), (1, "off")] in turns
    with pytest.raises(ValueError):
        apply_turn(st, [(2, "off"), (5, 1), (1, "off")])


def test_no_bear_off_with_checker_outside_home():
    # The back checker on 20 can't reach home this turn: no bear-off at all.
    st = start_turn(make({20: 1, 5: 2}), [6, 5])
    assert not any(dst == "off" for _, dst in steps_of(legal_turns(st)))


def test_bear_off_eligibility_gained_mid_turn():
    # 6-5 with checkers on 6 and 5: playing 6->1 brings everything home, and
    # then the 6 bears off the 5-point exactly — legal within one turn.
    st = start_turn(make({6: 1, 5: 1}), [6, 5])
    turns = legal_turns(st)
    assert [(6, 1), (5, "off")] in turns
    # but while the checker still sits on 6, nothing may bear off first
    assert all(t[0][1] != "off" for t in turns)


def test_no_bear_off_with_checker_on_bar():
    st = start_turn(make({5: 2, 4: 2}, bar={"w": 1}), [2, 1])
    turns = legal_turns(st)
    assert turns and all(t[0][0] == "bar" for t in turns)
    assert not any(dst == "off" for _, dst in steps_of(turns))


def test_black_bear_off_mirrored():
    st = start_turn(
        make({20: -1, 22: -1, 11: 14}, off={"w": 1, "b": 13}, turn="b"), [4, 2]
    )
    nxt = apply_turn(st, [(20, "off"), (22, "off")])
    assert nxt["off"]["b"] == 15
    assert nxt["result"] == {"winner": "b", "kind": "single"}


# ---------------------------------------------------------------- doubles

def test_doubles_play_up_to_four_moves():
    st = start_turn(new_game(), [2, 2])
    turns = legal_turns(st)
    assert len(turns) > 1
    assert all(len(t) == 4 for t in turns)
    # dedup: no repeated turn entries
    canon = [tuple(t) for t in turns]
    assert len(canon) == len(set(canon))


def test_doubles_truncated_when_blocked():
    # Only two of the four sixes are playable: 23 -> 17 -> 11, then blocked.
    st = start_turn(make({23: 1, 5: -2}), [6, 6])
    assert legal_turns(st) == [[(23, 17), (17, 11)]]


# ------------------------------------------------------------- result kinds

def _white_finishing(black_points, black_bar=0, black_off=0):
    points = {0: 1}
    points.update(black_points)
    return start_turn(
        make(points, bar={"b": black_bar}, off={"w": 14, "b": black_off}),
        [1, 2],
    )


def test_result_single():
    nxt = apply_turn(_white_finishing({12: -14}, black_off=1), [(0, "off")])
    assert nxt["result"] == {"winner": "w", "kind": "single"}


def test_result_gammon():
    nxt = apply_turn(_white_finishing({12: -15}), [(0, "off")])
    assert nxt["result"] == {"winner": "w", "kind": "gammon"}


def test_result_backgammon_via_bar():
    nxt = apply_turn(_white_finishing({12: -14}, black_bar=1), [(0, "off")])
    assert nxt["result"] == {"winner": "w", "kind": "backgammon"}


def test_result_backgammon_via_winner_home():
    nxt = apply_turn(_white_finishing({12: -14, 3: -1}), [(0, "off")])
    assert nxt["result"] == {"winner": "w", "kind": "backgammon"}


# ------------------------------------------------------- apply_turn policing

def test_reject_illegal_step():
    st = start_turn(new_game(), [6, 2])
    with pytest.raises(ValueError):
        apply_turn(st, [(23, 16), (12, 10)])  # 23->16 is a 7, not a die
    with pytest.raises(ValueError):
        apply_turn(st, [(5, 0), (12, 10)])  # 5->0 needs a 5


def test_reject_underuse_of_dice():
    st = start_turn(new_game(), [6, 2])
    with pytest.raises(ValueError):
        apply_turn(st, [(23, 17)])
    with pytest.raises(ValueError):
        apply_turn(st, [])


def test_reject_moving_opponent_checkers():
    st = start_turn(new_game(), [6, 2])
    with pytest.raises(ValueError):
        apply_turn(st, [(18, 12), (12, 10)])  # 18 holds black checkers


def test_reject_without_a_roll():
    st = new_game()
    with pytest.raises(ValueError):
        apply_turn(st, [])
    with pytest.raises(ValueError):
        legal_turns(st)


def test_reorderings_accepted_but_only_playable_orders():
    st = start_turn(new_game(), [6, 2])
    a = apply_turn(st, [(23, 17), (12, 10)])
    b = apply_turn(st, [(12, 10), (23, 17)])
    assert a == b  # any stepwise-legal order of the same turn
    with pytest.raises(ValueError):
        # same multiset, but the checker isn't on 17 yet: not a play order
        apply_turn(st, [(17, 15), (23, 17)])
    assert apply_turn(st, [(23, 17), (17, 15)])["points"][15] == 1


def test_apply_is_pure():
    st = start_turn(new_game(), [6, 2])
    before = {k: (list(v) if isinstance(v, list) else v) for k, v in st.items()}
    apply_turn(st, [(23, 17), (12, 10)])
    assert st["points"] == before["points"] and st["remaining"] == [6, 2]


# ---------------------------------------------------------------- bots

def test_choose_rookie_returns_a_legal_turn():
    st = start_turn(new_game(), [3, 1])
    assert choose(st, "rookie", random.Random(0)) in legal_turns(st)
    with pytest.raises(ValueError):
        choose(st, "grandmaster", random.Random(0))


def test_choose_sharp_deterministic_and_legal():
    st = start_turn(new_game(), [3, 1])
    a = choose(st, "sharp", random.Random(1))
    b = choose(st, "sharp", random.Random(999))
    assert a == b and a in legal_turns(st)


def test_sharp_prefers_the_hit():
    st = start_turn(make({10: 1, 20: 1, 7: -1, 2: -2, 1: -2}), [3, 6])
    assert (10, 7) in choose(st, "sharp", random.Random(0))


# ---------------------------------------------------------------- fuzz

def test_fuzz_rookie_vs_rookie_full_games():
    max_plies = 0
    for seed in range(200):
        state, plies, _ = play_game(seed, check=True)
        assert state["result"] is not None, "seed %d did not finish" % seed
        assert state["result"]["winner"] in ("w", "b")
        assert state["result"]["kind"] in ("single", "gammon", "backgammon")
        assert state["off"][state["result"]["winner"]] == 15
        max_plies = max(max_plies, plies)
    # cap is 500; games must finish well under it (observed max ~263)
    assert max_plies < 400


def test_fuzz_deterministic_under_master_seed():
    a_state, a_plies, a_hist = play_game(777)
    b_state, b_plies, b_hist = play_game(777)
    assert a_hist == b_hist and a_plies == b_plies and a_state == b_state


def test_sharp_beats_rookie():
    wins = 0
    for seed in range(100):
        sharp_color = "w" if seed % 2 == 0 else "b"
        state, _, _ = play_game(
            seed,
            w_tier="sharp" if sharp_color == "w" else "rookie",
            b_tier="sharp" if sharp_color == "b" else "rookie",
        )
        assert state["result"] is not None
        if state["result"]["winner"] == sharp_color:
            wins += 1
    assert wins >= 60, "sharp won only %d/100" % wins
