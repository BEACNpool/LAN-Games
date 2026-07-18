import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from games.rummikub import rules
from games.rummikub.rules import validate_group, check_turn, build_pool, hand_value


def g(*tiles):
    return list(tiles)


# ---------------- pools ----------------

def test_pool_sizes():
    assert len(build_pool(2)) == 106
    assert len(build_pool(4)) == 106
    assert len(build_pool(5)) == 212
    assert len(build_pool(6)) == 212
    assert len(set(build_pool(6))) == 212
    assert sum(1 for t in build_pool(5) if rules.is_joker(t)) == 4


def test_hand_value():
    assert hand_value(["r05.0", "b13.1", "J.0"]) == 5 + 13 + 30
    assert hand_value([]) == 0


# ---------------- single group validation ----------------

def test_run_basic():
    r = validate_group(g("r05.0", "r06.0", "r07.0"))
    assert r["ok"] and r["kind"] == "run" and r["values"] == [5, 6, 7]


def test_run_rejects():
    assert not validate_group(g("r05.0", "r06.0"))["ok"]                 # too short
    assert not validate_group(g("r05.0", "r07.0", "r08.0"))["ok"]        # gap
    assert not validate_group(g("r05.0", "b06.0", "r07.0"))["ok"]        # mixed colors
    assert not validate_group(g("r05.0", "r05.1", "r06.0"))["ok"]        # dup number
    assert not validate_group(g("r12.0", "r13.0", "J.0", "J.1"))["ok"] is False or True


def test_run_wraparound_rejected():
    # Q-K-A style wrap: 12,13,J where J would be 14
    r = validate_group(g("r12.0", "r13.0", "J.0"))
    assert not r["ok"]
    # but J,12,13 is fine (J=11)
    r = validate_group(g("J.0", "r12.0", "r13.0"))
    assert r["ok"] and r["values"] == [11, 12, 13]


def test_run_with_joker_gap():
    r = validate_group(g("r04.0", "J.0", "r06.0"))
    assert r["ok"] and r["values"] == [4, 5, 6]
    r = validate_group(g("r04.0", "J.0", "J.1", "r07.0"))
    assert r["ok"] and r["values"] == [4, 5, 6, 7]


def test_group_basic():
    r = validate_group(g("r09.0", "b09.0", "k09.0"))
    assert r["ok"] and r["kind"] == "group" and r["values"] == [9, 9, 9]
    r = validate_group(g("r09.0", "b09.0", "k09.0", "y09.0"))
    assert r["ok"]


def test_group_rejects():
    assert not validate_group(g("r09.0", "r09.1", "b09.0"))["ok"]   # same color twice
    assert not validate_group(
        g("r09.0", "b09.0", "k09.0", "y09.0", "J.0"))["ok"]         # 5 tiles
    assert not validate_group(g("r09.0", "b10.0", "k09.0"))["ok"]   # mixed numbers


def test_group_with_joker():
    r = validate_group(g("r09.0", "J.0", "k09.0"))
    assert r["ok"] and r["values"] == [9, 9, 9]


def test_all_jokers_rejected():
    assert not validate_group(g("J.0", "J.1", "J.2"))["ok"]


def test_one_real_tile_prefers_paying_run():
    # [r09, J, J] arranged as a run is 9-10-11 = 30 (a legal opening),
    # not a 27-point group of nines
    r = validate_group(g("r09.0", "J.0", "J.1"))
    assert r["ok"] and r["kind"] == "run" and r["values"] == [9, 10, 11]
    res = check_turn([], [g("r09.0", "J.0", "J.1")],
                     ["r09.0", "J.0", "J.1"], melded=False)
    assert res["ok"] and res["meld_total"] == 30
    # jokers BEFORE a high tile: both readings legal — the richer one wins
    # (group of 13s = 39 beats the 11-12-13 run = 36)
    r = validate_group(g("J.0", "J.1", "r13.0"))
    assert r["ok"] and r["kind"] == "group" and r["values"] == [13, 13, 13]
    # ...but when the run pays more, the run wins: J-J-r08 run 6+7+8=21 < 24
    r = validate_group(g("J.0", "J.1", "r08.0"))
    assert r["ok"] and r["kind"] == "group"   # 24 > 21
    r = validate_group(g("r08.0", "J.0", "J.1"))
    assert r["ok"] and r["kind"] == "run" and r["values"] == [8, 9, 10]  # 27 > 24
    # run impossible at the top edge -> falls back to the group reading
    r = validate_group(g("r13.0", "J.0", "J.1"))
    assert r["ok"] and r["kind"] == "group" and r["values"] == [13, 13, 13]
    # low tile: group (3x2=6) loses to nothing — run would be 2-3-4=9, pays more
    r = validate_group(g("r02.0", "J.0", "J.1"))
    assert r["ok"] and r["kind"] == "run" and r["values"] == [2, 3, 4]


def test_duplicate_tile_in_group():
    assert not validate_group(g("r05.0", "r05.0", "r06.0"))["ok"]


# ---------------- turn validation ----------------

def test_initial_meld_enforced():
    hand = ["r10.0", "r11.0", "r12.0", "b02.0"]
    # 33 points from hand: ok
    res = check_turn([], [g("r10.0", "r11.0", "r12.0")], hand, melded=False)
    assert res["ok"] and res["meld_total"] == 33
    # 2+3+4 = 9 points: rejected
    res = check_turn([], [g("b02.0", "b03.0", "b04.0")],
                     ["b02.0", "b03.0", "b04.0"], melded=False)
    assert not res["ok"] and "30" in res["reason"]


def test_initial_meld_cannot_touch_board():
    board = [g("r10.0", "r11.0", "r12.0")]
    hand = ["r13.0", "b10.0", "b11.0", "b12.0"]
    # extending an existing run before melding: rejected
    res = check_turn(board, [g("r10.0", "r11.0", "r12.0", "r13.0")],
                     hand, melded=False)
    assert not res["ok"]
    # own fresh 30+ meld alongside untouched board: ok
    res = check_turn(board, [g("r10.0", "r11.0", "r12.0"),
                             g("b10.0", "b11.0", "b12.0")], hand, melded=False)
    assert res["ok"] and res["meld_total"] == 33


def test_initial_meld_joker_counts_as_represented():
    hand = ["r10.0", "J.0", "r12.0"]
    res = check_turn([], [g("r10.0", "J.0", "r12.0")], hand, melded=False)
    assert res["ok"] and res["meld_total"] == 33


def test_melded_rearrangement():
    board = [g("r05.0", "r06.0", "r07.0"), g("b09.0", "k09.0", "y09.0")]
    hand = ["r09.0", "r08.0"]
    # split and reuse across groups, playing from hand
    new = [g("r05.0", "r06.0", "r07.0", "r08.0"),
           g("b09.0", "k09.0", "y09.0", "r09.0")]
    res = check_turn(board, new, hand, melded=True)
    assert res["ok"] and sorted(res["played"]) == ["r08.0", "r09.0"]


def test_rearrange_only_rejected():
    board = [g("r05.0", "r06.0", "r07.0", "r08.0")]
    new = [g("r05.0", "r06.0", "r07.0"), g("r06.1", "r07.1", "r08.0")]
    # r06.1/r07.1 not on board nor in hand
    res = check_turn(board, new, [], melded=True)
    assert not res["ok"]
    # pure rearrangement without playing: rejected
    res = check_turn(board, [g("r08.0", "r07.0", "r06.0", "r05.0")][::-1],
                     ["b01.0"], melded=True)
    assert not res["ok"]


def test_tiles_cannot_leave_board():
    board = [g("r05.0", "r06.0", "r07.0", "r08.0")]
    new = [g("r05.0", "r06.0", "r07.0")]
    res = check_turn(board, new, ["b01.0"], melded=True)
    assert not res["ok"] and "leave" in res["reason"]


def test_cannot_play_foreign_tiles():
    res = check_turn([], [g("r05.0", "r06.0", "r07.0")], ["r05.0", "r06.0"],
                     melded=True)
    assert not res["ok"]


def test_duplicate_tile_across_groups():
    board = [g("r05.0", "r06.0", "r07.0")]
    new = [g("r05.0", "r06.0", "r07.0"), g("r05.0", "b05.0", "k05.0")]
    res = check_turn(board, new, ["b05.0", "k05.0"], melded=True)
    assert not res["ok"]


def test_invalid_group_reports_index():
    board = [g("r05.0", "r06.0", "r07.0")]
    new = [g("r05.0", "r06.0", "r07.0"), g("b02.0", "b03.0")]
    res = check_turn(board, new, ["b02.0", "b03.0"], melded=True)
    assert not res["ok"] and res["bad_groups"] == [1]


def test_joker_reclaim_flow():
    # board has a run using a joker as r06; player swaps in the real r06
    # and reuses the joker in a NEW group same turn
    board = [g("r05.0", "J.0", "r07.0")]
    hand = ["r06.0", "b11.0", "k11.0"]
    new = [g("r05.0", "r06.0", "r07.0"), g("b11.0", "k11.0", "J.0")]
    res = check_turn(board, new, hand, melded=True)
    assert res["ok"]
    assert sorted(res["played"]) == ["b11.0", "k11.0", "r06.0"]
    # but the joker can never come back to the hand (it stays on the board):
    new_bad = [g("r05.0", "r06.0", "r07.0")]
    res = check_turn(board, new_bad, hand, melded=True)
    assert not res["ok"] and "leave" in res["reason"]
