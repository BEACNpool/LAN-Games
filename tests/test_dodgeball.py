"""Tests for DODGEBALL (real-time 2.5D arena).

Layers: pure physics (swept CCD, easing), engine mechanics driven through the
real sim (hit-with-height, dash i-frames, catch, bounce-goes-dead, pickup,
elimination/teams, sudden death), malformed-input safety, and a seeded bot fuzz
that must terminate with a single winner.
"""

import random

import pytest

from games.dodgeball import physics as P
from games.dodgeball.game import DodgeballSession


def mk(n, mode="ffa", lives=3, balls=4, seed=1):
    s = DodgeballSession(rng=random.Random(seed))
    s.settings.update(players=n, mode=mode, lives=lives, balls=balls, difficulty="hard")
    toks = []
    for i in range(n):
        t = "h%d" % i
        s.join(t, "P%d" % i, "🦊")
        s.set_ready(t, True)
        toks.append(t)
    s.start("h0")
    s.tick(s.gen)               # fire countdown -> game_start
    return s, toks


def place(u, x, y, invuln=False):
    u["x"], u["y"] = x, y
    u["vx"] = u["vy"] = u["kb_vx"] = u["kb_vy"] = 0.0
    u["iframe_until"] = 999.0 if invuln else -1.0
    u["hitstun_until"] = -1.0


def step_balls(s, n):
    for _ in range(n):
        s.g["clock"] += P.DT
        s._step_balls(P.DT, [])


# --------------------------------------------------------------------------- #
# 1. pure physics
# --------------------------------------------------------------------------- #
def test_ccd_hits_through_circle():
    # segment crossing a circle at origin radius 10 -> a toi in (0,1)
    t = P.seg_circle_toi(-100, 0, 100, 0, 0, 0, 10)
    assert t is not None and 0 < t < 1


def test_ccd_misses():
    assert P.seg_circle_toi(-100, 50, 100, 50, 0, 0, 10) is None   # passes 50px above


def test_ccd_starts_inside():
    assert P.seg_circle_toi(0, 0, 100, 0, 0, 0, 10) == 0.0


def test_approach_monotone():
    v = 0.0
    for _ in range(20):
        v = P.approach(v, 300.0, P.ACCEL_TAU, P.DT)
    assert 250 < v < 300      # ~0.33s in, near but not past target


def test_n_balls_scales():
    assert P.n_balls_for(2) == 3 and P.n_balls_for(8) == 6


# --------------------------------------------------------------------------- #
# 2. hit detection (with height + swept collision)
# --------------------------------------------------------------------------- #
def test_direct_throw_hits_and_costs_a_life():
    s, _ = mk(2)
    g = s.g
    place(g["units"][0], 200, 350)
    place(g["units"][1], 600, 350)
    g["units"][0]["holding"] = g["balls"][0]["id"]
    g["balls"][0]["held_by"] = 0
    before = g["units"][1]["lives"]
    s._throw(0, 0.0, 1.0, [])          # hard throw toward +x (into seat 1)
    hit = False
    for _ in range(40):
        step_balls(s, 1)
        if g["units"][1]["lives"] < before:
            hit = True
            break
    assert hit, "a flat throw straight at a grounded opponent must connect"


def test_high_ball_flies_over_head():
    s, _ = mk(2)
    g = s.g
    place(g["units"][1], 600, 350)
    # a ball at head-clearing height moving at the player must NOT hit
    b = g["balls"][0]
    b.update(x=560, y=350, z=200.0, vx=800.0, vy=0.0, vz=0.0, bounces=0,
             thrower=0, held_by=None, live=True, self_immune_until=-1)
    before = g["units"][1]["lives"]
    step_balls(s, 6)
    assert g["units"][1]["lives"] == before, "a ball over the head must miss"


def test_dash_iframes_pass_through():
    s, _ = mk(2)
    g = s.g
    place(g["units"][1], 600, 350)
    g["units"][1]["dash_until"] = 999.0
    g["units"][1]["iframe_until"] = 999.0   # dashing = invulnerable
    b = g["balls"][0]
    b.update(x=560, y=350, z=50.0, vx=800.0, vy=0.0, vz=0.0, bounces=0,
             thrower=0, held_by=None, live=True, self_immune_until=-1)
    before = g["units"][1]["lives"]
    step_balls(s, 6)
    assert g["units"][1]["lives"] == before, "a dashing (i-framed) player is safe"


def test_bounced_ball_is_not_lethal():
    s, _ = mk(2)
    g = s.g
    place(g["units"][1], 600, 350)
    b = g["balls"][0]
    b.update(x=560, y=350, z=50.0, vx=800.0, vy=0.0, vz=0.0, bounces=1,   # already bounced
             thrower=0, held_by=None, live=False, self_immune_until=-1)
    before = g["units"][1]["lives"]
    step_balls(s, 6)
    assert g["units"][1]["lives"] == before, "a bounced ball can't KO (real dodgeball rule)"


# --------------------------------------------------------------------------- #
# 3. catch — thrower out, catcher gains the ball
# --------------------------------------------------------------------------- #
def test_catch_costs_thrower_and_gives_ball():
    s, _ = mk(2)
    g = s.g
    place(g["units"][0], 200, 350)   # thrower
    place(g["units"][1], 600, 350)   # catcher
    g["units"][1]["catch_until"] = 999.0     # catch window open
    thrower_before = g["units"][0]["lives"]
    b = g["balls"][0]
    b.update(x=560, y=350, z=50.0, vx=800.0, vy=0.0, vz=0.0, bounces=0,
             thrower=0, held_by=None, live=True, self_immune_until=-1)
    caught = False
    for _ in range(6):
        step_balls(s, 1)
        if g["units"][1]["holding"] == b["id"]:
            caught = True
            break
    assert caught, "an open catch window on a live ball must catch it"
    assert g["units"][0]["lives"] == thrower_before - 1, "catching sends the thrower back a life"
    assert b["held_by"] == 1


# --------------------------------------------------------------------------- #
# 4. pickup / ammo
# --------------------------------------------------------------------------- #
def test_pickup_dead_ball():
    s, _ = mk(2)
    g = s.g
    place(g["units"][0], 300, 300)
    g["units"][0]["holding"] = None
    b = g["balls"][0]
    b.update(x=310, y=305, z=0.0, vx=0, vy=0, vz=0, bounces=1, live=False, held_by=None)
    s._pickups([])
    assert g["units"][0]["holding"] == b["id"] and b["held_by"] == 0


# --------------------------------------------------------------------------- #
# 5. lives / elimination / win
# --------------------------------------------------------------------------- #
def test_elimination_and_win():
    s, _ = mk(2, lives=1)
    g = s.g
    place(g["units"][0], 200, 350)
    place(g["units"][1], 600, 350)
    ev = []
    s._lose_life(1, ev, "hit")               # seat 1 had 1 life -> out
    assert not g["units"][1]["alive"]
    done = s._check_win([])
    assert done is not None
    assert g["result"]["winner_pids"] == [s._pid(0)]
    assert s.phase == "game_end"


def test_teams_win_when_one_side_cleared():
    s, _ = mk(4, mode="teams", lives=1)
    g = s.g
    assert g["mode"] == "teams"
    # eliminate both of team 1 (odd seats)
    for seat in [k for k in range(4) if g["team_of"][k] == 1]:
        s._lose_life(seat, [], "hit")
    done = s._check_win([])
    assert done is not None
    assert g["result"]["winner_team"] == 0


# --------------------------------------------------------------------------- #
# 6. sudden death + input safety
# --------------------------------------------------------------------------- #
def test_sudden_death_shrinks_zone():
    assert P.shrink_margins(0)[0] == 0.0
    mx, my = P.shrink_margins(P.SUDDEN_DEATH_START + P.SHRINK_TIME + 5)
    assert mx == pytest.approx(P.MAX_MARGIN_X) and my == pytest.approx(P.MAX_MARGIN_Y)


def test_malformed_input_never_crashes():
    s, toks = mk(2)
    for msg in [None, [], {"t": "move", "x": "nan", "y": None}, {"t": "throw"},
                {"t": "move", "x": float("inf"), "y": 0}, {"t": "zzz"}, 5, "hi",
                {"t": "throw", "a": [], "p": {}}, {"t": "dash"}, {"t": "catch"}]:
        s.game_action(toks[0], msg)          # must not raise
    # a valid move still applies and is magnitude-clamped
    s.game_action(toks[0], {"t": "move", "x": 3.0, "y": 4.0})
    mv = s.g["units"][0]["move"]
    assert abs((mv[0] ** 2 + mv[1] ** 2) ** 0.5 - 1.0) < 1e-6


# --------------------------------------------------------------------------- #
# 7. bot fuzz + determinism
# --------------------------------------------------------------------------- #
def _bot_match(seed, players, mode, lives=3, balls=4, cap=6000):
    s = DodgeballSession(rng=random.Random(seed))
    s.settings.update(players=players, mode=mode, lives=lives, balls=balls, difficulty="mixed")
    s.join("h0", "You", "🦊")
    s.set_ready("h0", True)
    s.start("h0")
    s.tick(s.gen)
    g = s.g
    s.players["h0"].connected = False        # all seats auto
    ticks = 0
    while s.phase == "play" and ticks < cap:
        s.game_tick()
        ticks += 1
        for u in g["units"].values():
            assert -1 <= u["x"] <= P.ARENA_W + 1 and -1 <= u["y"] <= P.ARENA_H + 1
    assert s.phase == "game_end", "match must terminate"
    alive_teams = {u["team"] for u in g["units"].values() if u["alive"]}
    assert len(alive_teams) <= 1
    return ticks, g["result"]["winner_seats"]


@pytest.mark.parametrize("seed", range(4))
def test_bot_fuzz(seed):
    cfgs = [(2, "ffa"), (4, "ffa"), (6, "teams"), (8, "ffa")]
    _bot_match(seed, *cfgs[seed % len(cfgs)])


def test_determinism():
    assert _bot_match(4321, 4, "ffa") == _bot_match(4321, 4, "ffa")


# --------------------------------------------------------------------------- #
# 8. review-fix regressions
# --------------------------------------------------------------------------- #
from games.dodgeball.game import _finite


def test_finite_no_overflow():
    assert _finite(10 ** 4000) is False      # huge int must NOT raise OverflowError
    assert _finite(5) is True and _finite(1.5) is True
    assert _finite(float("nan")) is False and _finite(True) is False and _finite("x") is False


def test_catch_while_holding_no_ghost():
    s, _ = mk(2)
    g = s.g
    place(g["units"][1], 600, 350)
    g["units"][1]["catch_until"] = 999.0
    g["units"][1]["holding"] = g["balls"][1]["id"]   # hands already full
    g["balls"][1]["held_by"] = 1
    b = g["balls"][0]
    b.update(x=560, y=350, z=50.0, vx=800.0, vy=0.0, vz=0.0, bounces=0, thrower=0, held_by=None, live=True, self_immune_until=-1)
    before = g["units"][1]["lives"]
    step_balls(s, 6)
    assert g["units"][1]["lives"] == before - 1          # can't catch full-handed -> HIT
    assert g["units"][1]["holding"] == g["balls"][1]["id"]   # original ball not orphaned
    assert g["balls"][1]["held_by"] == 1


def test_teams_no_friendly_fire():
    s, _ = mk(4, mode="teams")
    g = s.g
    assert g["team_of"][0] == g["team_of"][2]            # seat 2 is a teammate of 0
    place(g["units"][2], 600, 350)
    b = g["balls"][0]
    b.update(x=560, y=350, z=50.0, vx=800.0, vy=0.0, vz=0.0, bounces=0, thrower=0, held_by=None, live=True, self_immune_until=-1)
    before = g["units"][2]["lives"]
    step_balls(s, 6)
    assert g["units"][2]["lives"] == before             # a teammate's ball passes through


def test_double_ko_awards_winner():
    s, _ = mk(2, lives=1)
    g = s.g
    s._lose_life(0, [], "hit")
    s._lose_life(1, [], "hit")                          # both out same "tick"
    done = s._check_win([])
    assert done is not None
    assert g["result"]["winner_seats"] == [1]           # last one out wins the tiebreak (no draw)
