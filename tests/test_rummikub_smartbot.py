"""Tests for games.rummikub.bots.SmartBot — the board-rearrangement tier.

Covers: constructed rearrangement scenarios the baseline provably cannot
play (split runs, group steals, joker reclaim chains, multi-step combos),
opening-search superiority, joker discipline, a 200-position legality /
conservation fuzz, determinism, the node-budget telemetry, and full
SmartBot-vs-baseline games (majority wins + termination).
"""

import copy
import random
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from games.rummikub import rules
from games.rummikub.bots import BaselineBot, SmartBot, make_bot

TURN_CAP = 400

# ---------------------------------------------------------------------------
# helpers


def make_view(hand, board=(), melded=False, pool_count=40):
    return {"hand": list(hand), "board": [list(g) for g in board],
            "melded": melded, "pool_count": pool_count}


def smart(seed=0, **kw):
    return SmartBot(random.Random(seed), **kw)


def baseline(seed=0):
    return make_bot("baseline", random.Random(seed))


def assert_legal(view, mv):
    """mv must be a legal commit; returns the sorted played tiles."""
    assert "board" in mv, f"expected a play, got {mv}"
    res = rules.check_turn(view["board"], mv["board"], view["hand"],
                           view["melded"])
    assert res["ok"], res["reason"]
    return sorted(res["played"])


def random_position(seed):
    """A realistic position: play baseline-vs-baseline for a seed-chosen
    number of turns, then hand the current player's view to the test."""
    rng = random.Random(seed)
    n_players = 5 if seed % 7 == 0 else 2 + seed % 3  # sprinkle double sets
    pool = rules.build_pool(n_players)
    rng.shuffle(pool)
    hands = [[pool.pop() for _ in range(rules.HAND_SIZE)]
             for _ in range(n_players)]
    bots = [make_bot("baseline", random.Random(seed * 31 + p))
            for p in range(n_players)]
    board = []
    melded = [False] * n_players
    stop = 4 + seed % 40
    turn = 0
    for turn in range(stop):
        p = turn % n_players
        mv = bots[p].choose(make_view(hands[p], board, melded[p], len(pool)))
        if "board" in mv:
            res = rules.check_turn(board, mv["board"], hands[p], melded[p])
            assert res["ok"], res["reason"]
            for t in res["played"]:
                hands[p].remove(t)
            board = [list(g) for g in mv["board"]]
            melded[p] = True
            if not hands[p]:
                break
        elif pool:
            hands[p].append(pool.pop())
    p = (turn + 1) % n_players
    return make_view(hands[p], board, melded[p], len(pool))


# ---------------------------------------------------------------------------
# constructed rearrangement scenarios (baseline provably draws on each)


def test_splits_six_run_for_duplicate_middle_tile():
    # The exact position the v1 suite proves baseline CANNOT play.
    board = [["r05.0", "r06.0", "r07.0", "r08.1", "r09.0", "r10.0"]]
    hand = ["r08.0"]
    view = make_view(hand, board, melded=True)
    assert baseline().choose(copy.deepcopy(view)) == {"draw": True}
    mv = smart().choose(view)
    assert assert_legal(view, mv) == ["r08.0"]
    assert len(mv["board"]) == 2  # the run really was split in two


def test_splits_long_run_to_free_middle_tile_for_hand_group():
    # 7-run: split into 4-6 / 8-10, freed r07 completes the hand group.
    board = [["r04.0", "r05.0", "r06.0", "r07.0",
              "r08.0", "r09.0", "r10.0"]]
    hand = ["b07.0", "k07.0"]
    view = make_view(hand, board, melded=True)
    assert baseline().choose(copy.deepcopy(view)) == {"draw": True}
    mv = smart().choose(view)
    assert assert_legal(view, mv) == ["b07.0", "k07.0"]
    assert sorted(map(sorted, mv["board"])) == sorted(map(sorted, [
        ["r04.0", "r05.0", "r06.0"],
        ["r07.0", "b07.0", "k07.0"],
        ["r08.0", "r09.0", "r10.0"]]))


def test_steals_fourth_group_copy_to_complete_run():
    board = [["r08.0", "b08.0", "k08.0", "y08.0"]]
    hand = ["r06.0", "r07.0"]
    view = make_view(hand, board, melded=True)
    assert baseline().choose(copy.deepcopy(view)) == {"draw": True}
    mv = smart().choose(view)
    assert assert_legal(view, mv) == ["r06.0", "r07.0"]
    assert ["r06.0", "r07.0", "r08.0"] in mv["board"]


def test_joker_reclaim_chain():
    # Reclaim the tabled joker with the real b06 from hand, then reuse the
    # joker to finish a brand-new meld with two more hand tiles.
    board = [["b05.0", "J.0", "b07.0"]]
    hand = ["b06.0", "r11.0", "r12.0"]
    view = make_view(hand, board, melded=True)
    assert baseline().choose(copy.deepcopy(view)) == {"draw": True}
    mv = smart().choose(view)
    assert assert_legal(view, mv) == ["b06.0", "r11.0", "r12.0"]
    assert ["b05.0", "b06.0", "b07.0"] in mv["board"]
    joker_group = next(g for g in mv["board"] if "J.0" in g)
    assert "r11.0" in joker_group and "r12.0" in joker_group


def test_freed_tile_plus_two_hand_tiles():
    # Multi-step: shrink the 4-run to free r08, combine it with two hand
    # tiles into a new group.
    board = [["r05.0", "r06.0", "r07.0", "r08.0"]]
    hand = ["b08.0", "k08.0"]
    view = make_view(hand, board, melded=True)
    assert baseline().choose(copy.deepcopy(view)) == {"draw": True}
    mv = smart().choose(view)
    assert assert_legal(view, mv) == ["b08.0", "k08.0"]
    assert sorted(map(sorted, mv["board"])) == sorted(map(sorted, [
        ["r05.0", "r06.0", "r07.0"],
        ["r08.0", "b08.0", "k08.0"]]))


# ---------------------------------------------------------------------------
# opening (pre-30) search — pure-hand only, by the rule


def test_opening_finds_combo_the_greedy_baseline_misses():
    # Greedy grabs the 4-long b05-b08 run (26 pts) and starves the group of
    # eights; the search plays b05-b07 + the 8-group for 42 and opens.
    hand = ["b05.0", "b06.0", "b07.0", "b08.0", "r08.0", "k08.0"]
    view = make_view(hand)
    assert baseline().choose(copy.deepcopy(view)) == {"draw": True}
    mv = smart().choose(view)
    res = rules.check_turn([], mv["board"], hand, melded=False)
    assert res["ok"] and res["meld_total"] >= rules.MELD_MIN
    assert sorted(res["played"]) == sorted(hand)  # plays all six tiles


def test_opening_leaves_the_table_untouched():
    board = [["k11.0", "k12.0", "k13.0"]]
    hand = ["b05.0", "b06.0", "b07.0", "b08.0", "r08.0", "k08.0"]
    view = make_view(hand, board, melded=False)
    mv = smart().choose(view)
    assert mv["board"][0] == board[0]  # existing group byte-identical
    res = rules.check_turn(board, mv["board"], hand, melded=False)
    assert res["ok"] and res["meld_total"] >= rules.MELD_MIN


def test_opening_below_30_still_draws():
    hand = ["b02.0", "b03.0", "b04.0", "r07.0", "k01.0", "y13.0"]
    assert smart().choose(make_view(hand)) == {"draw": True}
    # ... and no amount of table temptation changes the rule
    board = [["r09.0", "r10.0", "r11.0"]]
    assert smart().choose(make_view(hand, board)) == {"draw": True}


# ---------------------------------------------------------------------------
# joker taste — held early, spent to unlock, dumped in the endgame


def test_early_game_lone_joker_glue_is_held():
    # Big hand, nothing plays without the joker, and the joker alone can
    # only glue onto the board run — hold it and draw.
    board = [["b09.0", "b10.0", "b11.0"]]
    hand = ["J.0", "r02.0", "k05.0", "y07.0", "r09.1",
            "y04.0", "k11.0", "y01.0"]
    assert smart().choose(make_view(hand, board, melded=True)) == \
        {"draw": True}


def test_early_game_joker_spent_when_it_unlocks_real_tiles():
    board = [["k11.0", "k12.0", "k13.0"]]
    hand = ["b09.0", "b10.0", "J.0", "r02.0", "k05.0",
            "y07.0", "y01.0", "k03.0"]
    view = make_view(hand, board, melded=True)
    mv = smart().choose(view)
    assert assert_legal(view, mv) == ["J.0", "b09.0", "b10.0"]


def test_endgame_dumps_the_joker():
    board = [["b09.0", "b10.0", "b11.0"]]
    hand = ["J.0", "r02.0"]  # small hand: dump value, joker included
    view = make_view(hand, board, melded=True)
    mv = smart().choose(view)
    assert assert_legal(view, mv) == ["J.0"]
    assert "J.0" in rules.board_tiles(mv["board"])


# ---------------------------------------------------------------------------
# safety fuzz: 200 seeded positions, every result legal + conserved


def test_fuzz_200_positions_legal_conserved_budgeted():
    plays = 0
    for seed in range(200):
        view = random_position(seed)
        bot = smart(seed)
        snap = copy.deepcopy(view)
        mv = bot.choose(view)
        assert view == snap, "view mutated"
        assert 0 <= bot.last_nodes <= bot.node_budget
        if mv == {"draw": True}:
            continue
        plays += 1
        new = mv["board"]
        res = rules.check_turn(view["board"], new, view["hand"],
                               view["melded"])
        assert res["ok"], res["reason"]
        # conservation, asserted independently of check_turn:
        old_c = Counter(rules.board_tiles(view["board"]))
        new_c = Counter(rules.board_tiles(new))
        assert not (old_c - new_c), "a board tile vanished"
        assert not ((new_c - old_c) - Counter(view["hand"])), \
            "played a tile not from hand"
        oj = sum(v for t, v in old_c.items() if rules.is_joker(t))
        nj = sum(v for t, v in new_c.items() if rules.is_joker(t))
        hj = sum(1 for t in view["hand"] if rules.is_joker(t))
        assert oj <= nj <= oj + hj, "jokers not conserved"
        assert all(r["ok"] for r in rules.validate_board(new))
    assert plays > 20  # the tier actually plays, it doesn't hide in draws


# ---------------------------------------------------------------------------
# determinism + node budget


def test_determinism_same_position_same_seed():
    for seed in (3, 57, 123):
        view = random_position(seed)
        assert smart(1).choose(copy.deepcopy(view)) == \
            smart(1).choose(copy.deepcopy(view))
        bot = smart(2)  # repeated calls on one instance agree too
        assert bot.choose(copy.deepcopy(view)) == \
            bot.choose(copy.deepcopy(view))


def test_node_counter_exposed_and_budget_default():
    bot = smart()
    assert bot.node_budget == SmartBot.NODE_BUDGET == 20000
    view = make_view(["b07.0", "k07.0"],
                     [["r04.0", "r05.0", "r06.0", "r07.0",
                       "r08.0", "r09.0", "r10.0"]], melded=True)
    mv = bot.choose(view)
    assert "board" in mv
    assert 0 < bot.last_nodes <= bot.node_budget


def test_tiny_budget_still_legal_and_deterministic():
    for budget in (0, 30):
        view = random_position(11)
        a = SmartBot(random.Random(0), node_budget=budget)
        mv = a.choose(copy.deepcopy(view))
        assert a.last_nodes <= budget
        if "board" in mv:  # whatever it found (or baseline gave) is legal
            assert rules.check_turn(view["board"], mv["board"],
                                    view["hand"], view["melded"])["ok"]
        b = SmartBot(random.Random(0), node_budget=budget)
        assert b.choose(copy.deepcopy(view)) == mv


# ---------------------------------------------------------------------------
# factory + hook


def test_factory_smart_tier_and_baseline_default_unchanged():
    assert isinstance(make_bot("smart", random.Random(0)), SmartBot)
    b = make_bot("baseline", random.Random(0))
    assert isinstance(b, BaselineBot) and not isinstance(b, SmartBot)
    assert type(make_bot(rng=random.Random(0))) is BaselineBot


def test_rearrangement_hook_yields_a_validated_board():
    board = [["r05.0", "r06.0", "r07.0", "r08.0"]]
    hand = ["b08.0", "k08.0"]
    bot = smart()
    bot.last_nodes = 0  # the hook draws down the per-choose budget
    cands = bot._rearrangement_candidates(make_view(hand, board, melded=True))
    assert cands
    res = rules.check_turn(board, cands[0], hand, True)
    assert res["ok"] and sorted(res["played"]) == ["b08.0", "k08.0"]


# ---------------------------------------------------------------------------
# full games: SmartBot vs baseline — majority wins, always terminates


def play_match(seed, smart_seat):
    """One 2-player game, applying moves through rules.check_turn (the
    engine's own referee). Returns (winning seat, turns). Stalemate = pool
    empty + both passing; the lower leftover hand wins it (engine rule)."""
    rng = random.Random(seed)
    pool = rules.build_pool(2)
    rng.shuffle(pool)
    hands = [[pool.pop() for _ in range(rules.HAND_SIZE)] for _ in range(2)]
    bots = [None, None]
    bots[smart_seat] = make_bot("smart", random.Random(seed * 7 + 1))
    bots[1 - smart_seat] = make_bot("baseline", random.Random(seed * 7 + 2))
    board = []
    melded = [False, False]
    passes = 0
    for turn in range(TURN_CAP):
        p = turn % 2
        view = make_view(hands[p], board, melded[p], len(pool))
        mv = bots[p].choose(view)
        if "board" in mv:
            res = rules.check_turn(board, mv["board"], hands[p], melded[p])
            assert res["ok"], res["reason"]
            for t in res["played"]:
                hands[p].remove(t)
            board = [list(g) for g in mv["board"]]
            melded[p] = True
            passes = 0
            if not hands[p]:
                return p, turn + 1
        else:
            assert mv == {"draw": True}
            if pool:
                hands[p].append(pool.pop())
                passes = 0
            else:
                passes += 1
                if passes >= 2:
                    vals = [rules.hand_value(h) for h in hands]
                    return (0 if vals[0] <= vals[1] else 1), turn + 1
    raise AssertionError(f"game exceeded the {TURN_CAP}-turn cap")


def test_smartbot_beats_baseline_majority_and_terminates():
    wins = 0
    for seed in range(10):
        seat = seed % 2  # alternate who moves first — no seat advantage
        winner, turns = play_match(seed, smart_seat=seat)
        assert turns <= TURN_CAP
        if winner == seat:
            wins += 1
    assert wins >= 6, f"SmartBot won only {wins}/10 vs baseline"
