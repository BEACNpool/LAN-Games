"""Tests for TEXAS HOLD'EM (No-Limit Texas Hold'em).

Three layers:
  * pure rules  -- hand evaluation vectors, side-pot layering, odd chips;
  * engine settlement -- construct an exact showdown state and assert payouts;
  * engine betting -- drive real actions and assert order / min-raise /
    action-reopening / the big-blind option / state masking / autopilot;
  * a small seeded bot-only fuzz that must finish with chips conserved.
"""

import random

import pytest

from games.poker import rules as R
from games.poker.game import PokerSession, BETTING


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def c(s):
    """'as 2d' -> ['AS','2D'] (accepts hub 'AS' too)."""
    return [x[0].upper() + x[1].upper() for x in s.split()]


def started(n_humans, table_size, seed=1, speed="standard", diff="shark"):
    s = PokerSession(rng=random.Random(seed))
    s.settings.update(table_size=table_size, speed=speed, difficulty=diff, turn_seconds=25)
    toks = []
    for i in range(n_humans):
        t = "h%d" % i
        s.join(t, "P%d" % i, "🦊")
        s.set_ready(t, True)
        toks.append(t)
    s.start(toks[0])
    s.tick(s.gen)                      # fire countdown -> game_start
    return s, toks


def mk(stacks, button=0, phase="flop", board=None, bb=20, sb=10):
    """Build a PokerSession sitting in a betting/showdown state for scenarios."""
    s = PokerSession(rng=random.Random(7))
    n = len(stacks)
    seats = []
    for i in range(n):
        t = "t%d" % i
        s.join(t, "P%d" % i, "🦊")
        seats.append(t)
    s.g = {
        "n": n, "seats": seats, "bots": {}, "tiers": {}, "autopilot": None,
        "seed": 1, "button": button, "hand_no": 1,
        "base_sb": sb, "base_bb": bb, "rise_every": 10, "rise_mult": 2,
        "sb": sb, "bb": bb, "start_stack": max(stacks),
        "stack": list(stacks), "busted": [], "result": None, "hand_result": None,
        "board": list(board or []),
        "hole": {i: ["2C", "3D"] for i in range(n)},
        "in_hand": {i: True for i in range(n)},
        "all_in": {i: (stacks[i] == 0) for i in range(n)},
        "committed": {i: 0 for i in range(n)},
        "contrib": {i: 0 for i in range(n)},
        "acted": {i: False for i in range(n)},
        "last_action": {i: None for i in range(n)},
        "current_bet": 0, "last_raise": bb, "aggressor": None,
        "preflop_aggressor": None, "to_act": None,
        "actions_this_street": 0,
        # a live deck so a scenario can close a street and deal the next one
        "deck": [x for x in R.DECK if x not in set((board or []))],
    }
    s.g["deck"] = list(reversed(s.g["deck"]))   # deterministic order
    s.phase = phase
    return s, seats


def act(s, move, amount=0):
    """Act for whoever is currently on the clock."""
    seat = s.g["to_act"]
    return s._do_action(seat, move, amount)


def is_invalid(fx):
    return len(fx) == 1 and fx[0].get("kind") == "invalid"


# --------------------------------------------------------------------------- #
# 1. pure hand evaluation
# --------------------------------------------------------------------------- #
HAND_VECTORS = [
    ("as 2d 3c 4h 5s kd qh", "2c 3d 4s 5h 6c kh qs", "B"),   # wheel < 6-high
    ("as 2d 3c 4h 5s kd kh", "kc ks qd 9h 4c 2s 7d", "A"),   # straight > pair
    ("ah as kd kc 5h 3d 2s", "kh ks qd qc jh 3c 2d", "A"),   # aces-up > kings-up
    ("ah as qd qc 5h 3d 2s", "ad ac jd jc kh 8d 7s", "A"),   # AAQQ > AAJJ
    ("ah as kd kc qh 3d 2s", "ad ac ks kh jd 4c 5s", "A"),   # kicker Q>J
    ("9h 9s 9d 4c 4h 2s 7d", "ah kh qh 9h 2h 3s 4d", "A"),   # boat > flush
    ("kh ks kd 2c 2h 5s 7d", "qh qs qd ac ah 5c 6d", "A"),   # KKK boat > QQQ boat
    ("9h 9s 9d ah ac 5s 7d", "9c 9d 9s kh kd 2c 3h", "A"),   # same trips, AA>KK
    ("ah kh 9h 5h 3h 2s 2d", "ah kh 9h 5h 2h 4s 4d", "A"),   # flush 5th card
    ("5h 6h 7h 8h 9h ks kd", "kc kd kh ks ac 2d 3s", "A"),   # SF > quads
    ("2c 3d 5h 5s 9d 9c kh", "2h 3s 5d 5c 9h 9s kh", "tie"),  # play board
    ("th jh qh kh ah 2s 3d", "9h 9s 9d 9c ah ks qd", "A"),   # royal > quads
    ("7h 7s 7d 7c ah 3d 2s", "7h 7s 7d 7c kh 3d 2s", "A"),   # quad kicker
    ("4c 5d 6h 7s 8c ah ad", "2c 3d 4h 5s 6c kh kd", "A"),   # best 5 of 7
]


@pytest.mark.parametrize("ha,hb,want", HAND_VECTORS)
def test_hand_vectors(ha, hb, want):
    sa, sb = R.best_hand(c(ha)), R.best_hand(c(hb))
    got = "A" if sa > sb else ("B" if sb > sa else "tie")
    assert got == want, "%s vs %s -> %s want %s" % (sa, sb, got, want)


def test_wheel_not_broadway_wrap():
    assert R.best_hand(c("kh ah 2d 3c 4s 9h ts"))[0] == 0   # K-A-2-3-4 is not a straight


def test_mixed_straight_flush_is_only_flush():
    assert R.best_hand(c("ah kh qh jh 9h 8s ts"))[0] == 5   # not a straight flush


# --------------------------------------------------------------------------- #
# 2. side pots (pure)
# --------------------------------------------------------------------------- #
def test_sidepot_short_allin():
    pots = R.build_pots({0: 100, 1: 300, 2: 300}, {})
    assert [(p["amount"], p["eligible"]) for p in pots] == \
        [(300, {0, 1, 2}), (400, {1, 2})]


def test_sidepot_two_allins():
    pots = R.build_pots({0: 50, 1: 200, 2: 500, 3: 500}, {})
    assert [(p["amount"], p["eligible"]) for p in pots] == \
        [(200, {0, 1, 2, 3}), (450, {1, 2, 3}), (600, {2, 3})]
    assert sum(p["amount"] for p in pots) == 1250


def test_dead_money_folded():
    pots = R.build_pots({0: 30, 1: 30, 2: 30}, {0: True})
    assert pots == [{"amount": 90, "eligible": {1, 2}}]


def test_uncalled_refund():
    assert R.uncalled_refund({0: 120, 1: 40, 2: 40}) == (0, 80)
    assert R.uncalled_refund({0: 100, 1: 100, 2: 40}) == (None, 0)


# --------------------------------------------------------------------------- #
# 3. engine settlement (showdown through the real engine)
# --------------------------------------------------------------------------- #
def test_settle_short_allin_sidepot():
    # A (seat0) is all-in 100 with the nuts; B/C contest a 400 side pot.
    s, seats = mk([0, 400, 400], button=2, board=c("ah kd 7c 2s 9h"))
    g = s.g
    g["contrib"] = {0: 100, 1: 300, 2: 300}
    g["all_in"][0] = True
    g["hole"] = {0: c("as ac"), 1: c("kh ks"), 2: c("qh qs")}   # A trips aces
    s._showdown()
    # behind (0/400/400) + contribs (100/300/300) = 1500 total chips.
    # main 300 -> seat0 (trip aces); side 400 -> seat1 (KK beats QQ).
    assert g["stack"][0] == 0 + 300
    assert g["stack"][1] == 400 + 400
    assert g["stack"][2] == 400 + 0
    assert sum(g["stack"]) == 1500


def test_settle_split_odd_chip():
    # P1 (seat0, SB, first left of button seat2) and P3 chop a 225 pot; odd chip to P1.
    s, seats = mk([75, 75, 75], button=2, board=c("ah kd qc js 2h"))
    g = s.g
    g["contrib"] = {0: 75, 1: 75, 2: 75}
    for i in range(3):
        g["stack"][i] = 0
    g["hole"] = {0: c("th 9h"), 1: c("2c 3c"), 2: c("td 9d")}   # 0 and 2 both make Broadway... no
    # give 0 and 2 the identical winning hand (a straight on board T? board has no T-run)
    g["hole"] = {0: c("th 3s"), 1: c("2c 4c"), 2: c("td 3d")}   # both: A-K-Q-J + T = Broadway
    s._showdown()
    assert g["stack"][0] == 113   # odd chip to seat left of button (seat0)
    assert g["stack"][2] == 112
    assert g["stack"][1] == 0
    assert sum(g["stack"]) == 225


def test_settle_fold_win_no_reveal():
    s, seats = mk([200, 200], button=1, board=c("ah kd 7c"))
    g = s.g
    g["contrib"] = {0: 50, 1: 120}
    g["in_hand"][0] = False               # seat0 folded
    s._showdown()
    # behind 200/200 + contribs 50/120 = 570 total. Uncalled 70 back to seat1,
    # then seat1 wins the 100 matched pot (2x50).
    assert g["stack"][1] == 200 + 70 + 100
    assert g["stack"][0] == 200
    assert g["hand_result"]["fold_win"] is True
    assert g["hand_result"]["reveal"] == []
    assert sum(g["stack"]) == 570


# --------------------------------------------------------------------------- #
# 4. betting order
# --------------------------------------------------------------------------- #
def test_heads_up_order():
    s, toks = started(2, 2, seed=3)
    g = s.g
    assert g["n"] == 2
    btn = g["button"]
    # heads-up: button posts SB and acts FIRST preflop
    assert g["to_act"] == btn
    # both call/check to see a flop
    act(s, "call")                        # SB completes
    assert s.phase == "preflop"
    act(s, "check")                       # BB checks option
    assert s.phase == "flop"
    # postflop the NON-button (big blind) acts first
    assert g["to_act"] == (btn + 1) % 2


def test_three_handed_preflop_utg_first():
    s, toks = started(3, 3, seed=5)
    g = s.g
    btn = g["button"]
    sb = (btn + 1) % 3
    bb = (btn + 2) % 3
    utg = btn                             # 3-handed UTG wraps to the button
    assert g["to_act"] == utg
    # everyone folds to BB -> BB wins, no showdown
    act(s, "fold")                        # UTG(=button) folds
    act(s, "fold")                        # SB folds
    assert s.phase == "hand_end"
    assert g["hand_result"]["fold_win"] is True
    assert g["hand_result"]["winner_pids"] == [s._pid(bb)]


def test_big_blind_option():
    s, toks = started(3, 3, seed=9)
    g = s.g
    btn = g["button"]
    bb = (btn + 2) % 3
    act(s, "call")                        # UTG limps
    act(s, "call")                        # SB completes
    # action must return to the BB for their option even though the bet is matched
    assert g["to_act"] == bb
    assert s.phase == "preflop"
    act(s, "check")                       # BB checks -> flop
    assert s.phase == "flop"


# --------------------------------------------------------------------------- #
# 5. min-raise + action reopening
# --------------------------------------------------------------------------- #
def test_min_raise_enforced():
    s, seats = mk([1000, 1000, 1000], button=0, phase="flop")
    g = s.g
    g["to_act"] = 1
    fx = s._do_action(1, "bet", 20)       # open 20
    assert not is_invalid(fx) and g["current_bet"] == 20
    # a raise to 30 is only +10 (< min-raise increment 20) and not all-in -> illegal
    fx = s._do_action(2, "raise", 30)
    assert is_invalid(fx)
    fx = s._do_action(2, "raise", 40)     # to 40 is a legal min-raise (+20)
    assert not is_invalid(fx) and g["current_bet"] == 40


def test_short_allin_does_not_reopen():
    # Flop: P0 bets 20 (and thereby closes their action at 20), P1 goes all-in
    # for 30 -- a short raise (+10 < the 20 min-raise increment). It does NOT
    # reopen betting for P0 (already acted & matched), but P2/P3 (not yet acted)
    # may still raise.
    s, seats = mk([1000, 30, 1000, 1000], button=3, phase="flop")
    g = s.g
    g["to_act"] = 0
    s._do_action(0, "bet", 20)
    assert g["current_bet"] == 20 and g["last_raise"] == 20 and g["acted"][0] is True
    assert g["to_act"] == 1
    s._do_action(1, "allin", 0)           # all-in to 30, a short raise (+10)
    assert g["current_bet"] == 30 and g["last_raise"] == 20   # increment unchanged
    assert g["all_in"][1] is True
    assert g["acted"][0] is True          # P0 was NOT reopened by the short all-in
    # a not-yet-acted player (P2) CAN raise; min-raise-to = 30 + 20 = 50
    assert g["to_act"] == 2
    me2 = s.game_state(seats[2])["me"]
    assert me2["can_raise"] is True and me2["min_raise_to"] == 50
    assert is_invalid(s._do_action(2, "raise", 45))           # below 50 -> rejected
    assert not is_invalid(s._do_action(2, "call"))            # P2 just calls 30
    assert not is_invalid(s._do_action(3, "call"))            # P3 just calls 30
    # back to P0: acted & matched before the short all-in -> only call or fold
    assert g["to_act"] == 0
    assert s.game_state(seats[0])["me"]["can_raise"] is False
    assert is_invalid(s._do_action(0, "raise", 200))          # reopening denied
    assert not is_invalid(s._do_action(0, "call"))            # calling is fine


# --------------------------------------------------------------------------- #
# 6. state masking
# --------------------------------------------------------------------------- #
def test_hole_cards_masked():
    s, toks = started(2, 4, seed=11)      # 2 humans + 2 bots
    g = s.g
    me = "h0"
    my_seat = g["seats"].index(me)
    st = s.game_state(me)
    # I see my own two cards
    my = [x for x in st["seats"] if x["seat"] == my_seat][0]
    assert my["cards"] is not None and len(my["cards"]) == 2
    # every other seat is masked
    for x in st["seats"]:
        if x["seat"] != my_seat:
            assert x["cards"] is None, "leaked seat %d" % x["seat"]
    # a spectator (viewer None) sees NO hole cards at all
    spec = s.game_state(None)
    assert all(x["cards"] is None for x in spec["seats"])


def test_showdown_reveals_only_contesting():
    s, seats = mk([0, 400, 400], button=2, board=c("ah kd 7c 2s 9h"))
    g = s.g
    g["contrib"] = {0: 100, 1: 300, 2: 300}
    g["hole"] = {0: c("as ac"), 1: c("kh ks"), 2: c("qh qs")}
    s._showdown()
    st = s.game_state(None)               # spectator view during hand_end
    revealed = {x["seat"] for x in st["seats"] if x["cards"] is not None}
    assert revealed == {0, 1, 2}          # all-in showdown reveals every contesting hand


# --------------------------------------------------------------------------- #
# 7. disconnect autopilot + reconnect
# --------------------------------------------------------------------------- #
def test_disconnect_seat_is_auto():
    s, toks = started(2, 2, seed=13)
    g = s.g
    # disconnect the player on the clock -> the seat becomes auto-playable
    seat = g["to_act"]
    tok = g["seats"][seat]
    if tok.startswith("bot:"):
        pytest.skip("clock is a bot")
    s.players[tok].connected = False
    assert s._seat_is_auto(seat) is True
    nb = s.next_bot_action()
    assert nb is not None and nb[1] == tok
    before = s.seq
    s.run_bot(tok)                        # autopilot acts for the dropped human
    assert s.seq > before


# --------------------------------------------------------------------------- #
# 8. determinism + bot-only fuzz (chips conserved, match terminates)
# --------------------------------------------------------------------------- #
def _play_bot_match(seed, n_humans, table_size, speed="turbo"):
    s = PokerSession(rng=random.Random(seed))
    s.settings.update(table_size=table_size, speed=speed, difficulty="mixed")
    toks = []
    for i in range(n_humans):
        t = "h%d" % i
        s.join(t, "P%d" % i, "🦊")
        s.set_ready(t, True)
        toks.append(t)
    s.start(toks[0])
    s.tick(s.gen)
    g = s.g
    total = g["n"] * g["start_stack"]
    for t in toks:
        s.players[t].connected = False    # drive every seat via autopilot
    guard = 0
    while s.phase not in ("lobby", "game_end") and guard < 200000:
        guard += 1
        assert sum(g["stack"]) + sum(g["contrib"].values()) == total
        if s.phase in BETTING and g["to_act"] is not None:
            seat = g["to_act"]
            assert g["in_hand"][seat] and not g["all_in"][seat]
            if not s.run_bot(g["seats"][seat]):
                s.tick(s.gen)
        else:
            s.tick(s.gen)
    assert s.phase == "game_end"
    assert sum(g["stack"]) == total
    assert g["result"]["winner_pid"]
    return g["result"]["winner_seat"], g["hand_no"]


@pytest.mark.parametrize("seed", range(6))
def test_bot_fuzz(seed):
    cfgs = [(2, 2), (1, 6), (3, 6), (1, 9), (4, 4), (2, 4)]
    _play_bot_match(seed, *cfgs[seed % len(cfgs)])


def test_determinism():
    a = _play_bot_match(1234, 1, 6)
    b = _play_bot_match(1234, 1, 6)
    assert a == b                         # same seed -> identical match
