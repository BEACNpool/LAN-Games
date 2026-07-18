"""Tests for the American checkers engine — this referee must be airtight."""

import copy
import random
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from games.checkers.engine import (
    new_game, legal_moves, apply_move, choose, sq, is_dark, DRAW_CLOCK,
)


def make(pieces, turn="w", clock=0):
    """Build a state from {(row, col): piece}. Dark squares only."""
    board = [None] * 64
    for (r, c), p in pieces.items():
        assert is_dark(r, c), "test bug: piece on a light square"
        board[sq(r, c)] = p
    return {"board": board, "turn": turn, "clock": clock, "result": None}


def moveset(state, forced=True):
    return {tuple(m) for m in legal_moves(state, forced)}


# ---------------- new_game ----------------

def test_new_game_shape():
    st = new_game()
    assert st["turn"] == "w"
    assert st["clock"] == 0
    assert st["result"] is None
    assert len(st["board"]) == 64
    ws = [i for i, p in enumerate(st["board"]) if p == "w"]
    bs = [i for i, p in enumerate(st["board"]) if p == "b"]
    assert len(ws) == 12 and len(bs) == 12
    assert not any(p in ("W", "B") for p in st["board"])  # no kings at start
    for i in ws + bs:
        r, c = divmod(i, 8)
        assert is_dark(r, c)
    assert all(divmod(i, 8)[0] >= 5 for i in ws)   # white bottom rows 5-7
    assert all(divmod(i, 8)[0] <= 2 for i in bs)   # black top rows 0-2
    # rows 3-4 empty
    assert all(st["board"][sq(r, c)] is None for r in (3, 4) for c in range(8))


def test_new_game_opening_moves():
    # the classic 7 opening moves, all simple, all onto dark squares
    moves = legal_moves(new_game())
    assert len(moves) == 7
    for m in moves:
        assert len(m) == 2
        r, c = divmod(m[1], 8)
        assert is_dark(r, c) and r == 4


# ---------------- simple moves ----------------

def test_white_man_moves_up_only():
    st = make({(5, 2): "w", (0, 1): "b"})
    assert moveset(st) == {(sq(5, 2), sq(4, 1)), (sq(5, 2), sq(4, 3))}


def test_black_man_moves_down_only():
    st = make({(2, 3): "b", (7, 0): "w"}, turn="b")
    assert moveset(st) == {(sq(2, 3), sq(3, 2)), (sq(2, 3), sq(3, 4))}


def test_king_moves_all_four_ways():
    st = make({(4, 3): "W", (0, 1): "b"})
    assert moveset(st) == {(sq(4, 3), sq(3, 2)), (sq(4, 3), sq(3, 4)),
                           (sq(4, 3), sq(5, 2)), (sq(4, 3), sq(5, 4))}


def test_edge_of_board():
    st = make({(5, 0): "w", (0, 1): "b"})
    assert moveset(st) == {(sq(5, 0), sq(4, 1))}


def test_cannot_move_onto_occupied_square():
    # own piece blocks; enemy piece with a blocked landing blocks too
    st = make({(5, 2): "w", (4, 3): "w", (0, 1): "b"})
    assert (sq(5, 2), sq(4, 3)) not in moveset(st)
    st = make({(5, 2): "w", (4, 1): "b", (3, 0): "b"})
    assert moveset(st) == {(sq(5, 2), sq(4, 3))}


def test_destinations_always_dark():
    st = make({(4, 3): "W", (0, 1): "B"})
    for m in legal_moves(st):
        assert is_dark(*divmod(m[1], 8))


# ---------------- captures ----------------

def test_jump_removes_the_jumped_piece():
    st = make({(5, 2): "w", (4, 3): "b", (0, 1): "b"})
    assert [sq(5, 2), sq(3, 4)] in legal_moves(st)
    nxt = apply_move(st, [sq(5, 2), sq(3, 4)])
    assert nxt["board"][sq(4, 3)] is None
    assert nxt["board"][sq(3, 4)] == "w"
    assert nxt["board"][sq(5, 2)] is None
    assert nxt["turn"] == "b"


def test_cannot_jump_own_piece():
    st = make({(5, 2): "w", (4, 3): "w", (0, 1): "b"})
    assert moveset(st) == {(sq(5, 2), sq(4, 1)),
                           (sq(4, 3), sq(3, 2)), (sq(4, 3), sq(3, 4))}


def test_landing_square_must_be_empty():
    st = make({(5, 2): "w", (4, 3): "b", (3, 4): "b"})
    assert moveset(st) == {(sq(5, 2), sq(4, 1))}  # jump blocked -> simple only


def test_man_cannot_jump_backward():
    # black man sits BEHIND the white man; American men capture forward only
    st = make({(3, 2): "w", (4, 3): "b", (0, 1): "b"})
    assert moveset(st) == {(sq(3, 2), sq(2, 1)), (sq(3, 2), sq(2, 3))}


def test_king_jumps_backward():
    st = make({(3, 2): "W", (4, 3): "b"})
    assert [sq(3, 2), sq(5, 4)] in legal_moves(st)
    nxt = apply_move(st, [sq(3, 2), sq(5, 4)])
    assert nxt["board"][sq(4, 3)] is None and nxt["board"][sq(5, 4)] == "W"


def test_forced_true_hides_simple_moves():
    st = make({(5, 2): "w", (4, 3): "b", (6, 5): "w", (0, 1): "b"})
    forced = moveset(st, forced=True)
    assert forced == {(sq(5, 2), sq(3, 4))}  # only the capture


def test_forced_false_shows_both():
    st = make({(5, 2): "w", (4, 3): "b", (6, 5): "w", (0, 1): "b"})
    ms = moveset(st, forced=False)
    assert (sq(5, 2), sq(3, 4)) in ms          # the capture
    assert (sq(6, 5), sq(5, 6)) in ms          # a simple move
    assert len(ms) > 1


# ---------------- multi-jump ----------------

def test_double_jump_cannot_stop_early():
    st = make({(6, 1): "w", (5, 2): "b", (3, 4): "b", (0, 1): "b"})
    ms = legal_moves(st)
    assert ms == [[sq(6, 1), sq(4, 3), sq(2, 5)]]
    assert [sq(6, 1), sq(4, 3)] not in ms  # the partial hop is never offered
    nxt = apply_move(st, [sq(6, 1), sq(4, 3), sq(2, 5)])
    assert nxt["board"][sq(5, 2)] is None and nxt["board"][sq(3, 4)] is None
    assert nxt["board"][sq(2, 5)] == "w"


def test_double_jump_maximal_even_when_not_forced():
    st = make({(6, 1): "w", (5, 2): "b", (3, 4): "b", (0, 1): "b"})
    for m in legal_moves(st, forced=False):
        if abs(divmod(m[1], 8)[0] - divmod(m[0], 8)[0]) == 2:
            assert m == [sq(6, 1), sq(4, 3), sq(2, 5)]  # still complete


def test_triple_jump():
    st = make({(7, 0): "w", (6, 1): "b", (4, 3): "b", (2, 5): "b"})
    ms = legal_moves(st)
    assert ms == [[sq(7, 0), sq(5, 2), sq(3, 4), sq(1, 6)]]
    nxt = apply_move(st, ms[0])
    for r, c in ((6, 1), (4, 3), (2, 5)):
        assert nxt["board"][sq(r, c)] is None
    assert nxt["board"][sq(1, 6)] == "w"   # row 1: no crowning
    assert nxt["result"] == "w"            # black has nothing left


def test_branching_multi_jump_offers_both_branches():
    st = make({(6, 3): "w", (5, 2): "b", (3, 2): "b", (5, 4): "b", (3, 4): "b"})
    ms = moveset(st)
    assert ms == {(sq(6, 3), sq(4, 1), sq(2, 3)),
                  (sq(6, 3), sq(4, 5), sq(2, 3))}
    # taking branch A removes only branch A's victims
    nxt = apply_move(st, [sq(6, 3), sq(4, 1), sq(2, 3)])
    assert nxt["board"][sq(5, 2)] is None and nxt["board"][sq(3, 2)] is None
    assert nxt["board"][sq(5, 4)] == "b" and nxt["board"][sq(3, 4)] == "b"


# ---------------- crowning ----------------

def test_crowning_on_simple_move():
    st = make({(1, 2): "w", (5, 0): "b"})
    nxt = apply_move(st, [sq(1, 2), sq(0, 1)])
    assert nxt["board"][sq(0, 1)] == "W"


def test_crowning_on_jump():
    st = make({(2, 1): "w", (1, 2): "b", (5, 4): "b"})
    nxt = apply_move(st, [sq(2, 1), sq(0, 3)])
    assert nxt["board"][sq(0, 3)] == "W"
    assert nxt["board"][sq(1, 2)] is None


def test_black_crowns_on_row_seven():
    st = make({(6, 1): "b", (0, 7): "W"}, turn="b")
    nxt = apply_move(st, [sq(6, 1), sq(7, 0)])
    assert nxt["board"][sq(7, 0)] == "B"


def test_crowning_ends_the_jump_sequence():
    # RULE pin: landing on the last row crowns AND ends the move, even
    # though the fresh king could jump (1,4) onward to (2,5).
    st = make({(2, 1): "w", (1, 2): "b", (1, 4): "b"})
    ms = legal_moves(st)
    assert ms == [[sq(2, 1), sq(0, 3)]]
    assert [sq(2, 1), sq(0, 3), sq(2, 5)] not in ms
    nxt = apply_move(st, [sq(2, 1), sq(0, 3)])
    assert nxt["board"][sq(0, 3)] == "W"
    assert nxt["board"][sq(1, 4)] == "b"   # survived — no jump after crowning
    assert nxt["turn"] == "b"


# ---------------- endings ----------------

def test_no_pieces_loses():
    st = make({(5, 2): "w", (4, 3): "b"})
    nxt = apply_move(st, [sq(5, 2), sq(3, 4)])
    assert nxt["result"] == "w"
    assert legal_moves(nxt) == []


def test_black_can_win_too():
    st = make({(2, 1): "b", (3, 2): "w"}, turn="b")
    nxt = apply_move(st, [sq(2, 1), sq(4, 3)])
    assert nxt["result"] == "b"
    assert legal_moves(nxt) == []


def test_blocked_side_loses():
    # black's lone man at (5,0) is walled in: (6,1) occupied, jump landing
    # (7,2) occupied. White plays elsewhere; black is stuck and loses.
    st = make({(5, 0): "b", (6, 1): "w", (7, 2): "w", (5, 4): "w"})
    nxt = apply_move(st, [sq(5, 4), sq(4, 5)])
    assert nxt["result"] == "w"
    assert legal_moves(nxt) == []


def test_clock_draw_at_80():
    st = make({(4, 3): "W", (0, 1): "B"}, clock=DRAW_CLOCK - 1)
    nxt = apply_move(st, [sq(4, 3), sq(3, 2)])
    assert nxt["clock"] == DRAW_CLOCK
    assert nxt["result"] == "draw"
    assert legal_moves(nxt) == []


def test_clock_increments_on_king_quiet_move():
    st = make({(4, 3): "W", (0, 1): "B"}, clock=5)
    nxt = apply_move(st, [sq(4, 3), sq(3, 2)])
    assert nxt["clock"] == 6 and nxt["result"] is None


def test_clock_resets_on_man_move():
    st = make({(4, 3): "W", (5, 6): "w", (0, 1): "B"}, clock=50)
    nxt = apply_move(st, [sq(5, 6), sq(4, 7)])
    assert nxt["clock"] == 0


def test_clock_resets_on_king_capture():
    st = make({(4, 3): "W", (3, 2): "b", (0, 7): "B"}, clock=50)
    nxt = apply_move(st, [sq(4, 3), sq(2, 1)])
    assert nxt["clock"] == 0 and nxt["result"] is None


# ---------------- apply_move rejections ----------------

def test_rejects_illegal_move():
    with pytest.raises(ValueError):
        apply_move(new_game(), [sq(0, 0), sq(1, 1)])
    with pytest.raises(ValueError):
        apply_move(new_game(), [sq(4, 1), sq(5, 2)])  # empty source


def test_rejects_wrong_turns_piece():
    with pytest.raises(ValueError):
        apply_move(new_game(), [sq(2, 1), sq(3, 0)])  # black piece, white's turn


def test_rejects_partial_capture_sequence():
    st = make({(6, 1): "w", (5, 2): "b", (3, 4): "b", (0, 1): "b"})
    with pytest.raises(ValueError):
        apply_move(st, [sq(6, 1), sq(4, 3)])  # must finish the double


def test_rejects_simple_move_when_capture_forced():
    st = make({(5, 2): "w", (4, 3): "b", (6, 5): "w", (0, 1): "b"})
    with pytest.raises(ValueError):
        apply_move(st, [sq(6, 5), sq(5, 6)])
    # ...but the house rule allows it
    nxt = apply_move(st, [sq(6, 5), sq(5, 6)], forced=False)
    assert nxt["board"][sq(5, 6)] == "w"


def test_rejects_moves_in_finished_game():
    st = make({(5, 2): "w", (4, 3): "b"})
    done = apply_move(st, [sq(5, 2), sq(3, 4)])
    with pytest.raises(ValueError):
        apply_move(done, [sq(3, 4), sq(2, 5)])
    with pytest.raises(ValueError):
        choose(done, "rookie", random.Random(0))


# ---------------- immutability ----------------

def test_apply_move_does_not_mutate_input():
    st = new_game()
    snapshot = copy.deepcopy(st)
    apply_move(st, legal_moves(st)[0])
    assert st == snapshot
    # and through a capture with crowning
    st2 = make({(2, 1): "w", (1, 2): "b", (5, 4): "b"}, clock=3)
    snap2 = copy.deepcopy(st2)
    apply_move(st2, [sq(2, 1), sq(0, 3)])
    assert st2 == snap2


# ---------------- bots ----------------

def _play(seed_a, seed_b, tier_w, tier_b, cap):
    rng_w, rng_b = random.Random(seed_a), random.Random(seed_b)
    st = new_game()
    transcript = []
    for _ in range(cap):
        if st["result"] is not None:
            break
        tier = tier_w if st["turn"] == "w" else tier_b
        rng = rng_w if st["turn"] == "w" else rng_b
        mv = choose(st, tier, rng)
        assert mv in legal_moves(st)
        transcript.append(mv)
        st = apply_move(st, mv)
    return st, transcript


def test_rookie_fuzz_300_games():
    for i in range(300):
        st, _ = _play(i, 10_000 + i, "rookie", "rookie", cap=300)
        # the draw clock guarantees termination inside the cap
        assert st["result"] in ("w", "b", "draw")


def test_choose_rejects_unknown_tier():
    with pytest.raises(ValueError):
        choose(new_game(), "grandmaster", random.Random(0))


def test_sharp_prefers_biggest_capture():
    # single jump at (7,4) vs double jump at (7,0): sharp must pick the double
    st = make({(7, 0): "w", (6, 1): "b", (4, 3): "b",
               (7, 4): "w", (6, 5): "b"})
    assert moveset(st) == {(sq(7, 0), sq(5, 2), sq(3, 4)),
                           (sq(7, 4), sq(5, 6))}
    for seed in range(10):
        mv = choose(st, "sharp", random.Random(seed))
        assert mv == [sq(7, 0), sq(5, 2), sq(3, 4)]


def test_sharp_avoids_hanging_a_piece():
    # white man at (4,5): stepping to (3,4) lets black jump it; (3,6) is safe
    st = make({(4, 5): "w", (2, 3): "b", (7, 0): "w"})
    for seed in range(10):
        mv = choose(st, "sharp", random.Random(seed))
        assert mv != [sq(4, 5), sq(3, 4)]


def test_sharp_beats_rookie():
    wins = 0
    for i in range(100):
        sharp_color = "w" if i % 2 == 0 else "b"
        tier_w = "sharp" if sharp_color == "w" else "rookie"
        tier_b = "sharp" if sharp_color == "b" else "rookie"
        st, _ = _play(30_000 + i, 40_000 + i, tier_w, tier_b, cap=400)
        if st["result"] == sharp_color:
            wins += 1
    assert wins >= 60, "sharp won only %d of 100 vs rookie" % wins


def test_bots_deterministic_under_seed():
    a_state, a_moves = _play(7, 11, "sharp", "rookie", cap=400)
    b_state, b_moves = _play(7, 11, "sharp", "rookie", cap=400)
    assert a_moves == b_moves
    assert a_state == b_state
