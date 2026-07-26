"""Tests for BRICKADE (Pong-royale x Breakout x power-ups)."""
import math
import random

import pytest

from games.brickade import physics as P
from games.brickade.game import BrickadeSession, _finite

BR = P.BALL_R


def started(n, lives=3, seed=1):
    s = BrickadeSession(rng=random.Random(seed))
    s.settings.update(players=n, lives=lives, difficulty="hard", layout="ring")
    for i in range(n):
        t = "h%d" % i
        s.join(t, "P%d" % i, "🦊")
        s.set_ready(t, True)
    s.start("h0")
    s.tick(s.gen)
    return s


def edge_of(g, seat):
    for e in g["edges"]:
        if e["owner"] == seat:
            return e
    return None


def put_ball(s, seat, q_frac, owner=None, speed=None):
    g = s.g
    e = edge_of(g, seat)
    q = q_frac * e["s"]
    px, py = P.along(e, q)
    nx, ny = e["n"]
    b = {"id": 999, "x": px + nx * (BR - 1), "y": py + ny * (BR - 1),
         "vx": -nx, "vy": -ny, "speed": speed or P.BALL_START, "owner": owner,
         "last_touch_tick": 0, "phase_until": -1.0, "slow_until": -1.0,
         "over_until": -1.0, "neutral_since": 0.0}
    g["balls"] = [b]
    return b, e


def cover_q(s, seat, q_frac):
    """Put seat's paddle so its center sits at q_frac of the edge."""
    g = s.g
    u = g["units"][seat]
    e = edge_of(g, seat)
    length = u["cover"] * e["s"]
    q = q_frac * e["s"]
    u["t"] = u["t_prev"] = u["t_target"] = P.clamp((q - length / 2.0) / max(1.0, e["s"] - length), 0.0, 1.0)


# --------------------------------------------------------------------------- #
# geometry
# --------------------------------------------------------------------------- #
def test_edges_2p_is_rectangle():
    s = started(2)
    kinds = sorted(e["kind"] for e in s.g["edges"])
    assert kinds == ["goal", "goal", "wall", "wall"]


@pytest.mark.parametrize("n", [3, 4, 6, 8])
def test_ngon_has_n_goal_edges(n):
    s = started(n)
    goals = [e for e in s.g["edges"] if e["kind"] == "goal"]
    assert len(goals) == n
    assert {e["owner"] for e in goals} == set(range(n))


# --------------------------------------------------------------------------- #
# save vs score + ownership
# --------------------------------------------------------------------------- #
def test_paddle_save_reflects_and_takes_ownership():
    s = started(2)
    g = s.g
    cover_q(s, 0, 0.5)
    b, e = put_ball(s, 0, 0.5, owner=None, speed=600)
    before = g["units"][0]["hp"]
    res = s._resolve_edges(b, [])
    assert res is None                         # not a score
    assert g["units"][0]["hp"] == before       # saved, no life lost
    assert b["owner"] == 0                      # last touch is now seat 0
    vn = b["vx"] * e["n"][0] + b["vy"] * e["n"][1]
    assert vn > 0                               # bounced back inward
    assert b["speed"] > 600                     # speed ladder ticked up


def test_undefended_goal_scores():
    s = started(2)
    g = s.g
    cover_q(s, 0, 0.05)                         # paddle parked far away
    b, e = put_ball(s, 0, 0.9, owner=1, speed=600)   # ball owned by seat 1
    before = g["units"][0]["hp"]
    res = s._resolve_edges(b, [])
    assert res == "score"
    assert g["units"][0]["hp"] == before - 1   # goal owner loses a life


def test_self_immune_own_ball_never_scores():
    s = started(2)
    g = s.g
    cover_q(s, 0, 0.05)
    b, e = put_ball(s, 0, 0.9, owner=0, speed=600)   # seat 0's OWN ball at seat 0's goal
    before = g["units"][0]["hp"]
    res = s._resolve_edges(b, [])
    assert res is None                          # bounces, does not score
    assert g["units"][0]["hp"] == before


def test_shield_blocks_a_shot():
    s = started(2)
    g = s.g
    g["units"][0]["shield_until"] = 999.0
    g["units"][0]["shield_hits"] = 2
    cover_q(s, 0, 0.05)
    b, e = put_ball(s, 0, 0.9, owner=1, speed=600)
    before = g["units"][0]["hp"]
    res = s._resolve_edges(b, [])
    assert res is None and g["units"][0]["hp"] == before
    assert g["units"][0]["shield_hits"] == 1    # absorbed one


# --------------------------------------------------------------------------- #
# bricks + power-ups
# --------------------------------------------------------------------------- #
def test_brick_breaks_and_special_arms_powerup():
    s = started(2)
    g = s.g
    g["bricks"] = [{"id": 0, "cx": 400.0, "cy": 500.0, "hw": 24.0, "hh": 11.0,
                    "special": True, "alive": True}]
    b = {"id": 1, "x": 400.0, "y": 500.0, "vx": 1.0, "vy": 0.0, "speed": 500,
         "owner": 0, "last_touch_tick": 0, "phase_until": -1.0,
         "slow_until": -1.0, "over_until": -1.0, "neutral_since": 0.0}
    g["balls"] = [b]
    s._resolve_bricks(b, [])
    assert g["bricks"][0]["alive"] is False
    assert g["units"][0]["inv"] in P.PU_KINDS   # last-toucher armed a power-up


def test_powerup_multi_spawns_balls():
    s = started(4)
    g = s.g
    g["balls"] = [{"id": 0, "x": 500.0, "y": 500.0, "vx": 1.0, "vy": 0.0, "speed": 600,
                   "owner": 0, "last_touch_tick": 0, "phase_until": -1.0,
                   "slow_until": -1.0, "over_until": -1.0, "neutral_since": 0.0}]
    s._activate(0, "multi", [])
    assert len(g["balls"]) >= 2
    assert all(b["owner"] == 0 for b in g["balls"])


def test_powerup_over_and_slow_and_big():
    s = started(2)
    g = s.g
    g["balls"] = [{"id": 0, "x": 500.0, "y": 500.0, "vx": 1.0, "vy": 0.0, "speed": 600,
                   "owner": 0, "last_touch_tick": 0, "phase_until": -1.0,
                   "slow_until": -1.0, "over_until": -1.0, "neutral_since": 0.0}]
    s._activate(0, "over", [])
    assert g["balls"][0]["over_until"] > g["clock"]
    s._activate(0, "slow", [])
    assert g["balls"][0]["slow_until"] > g["clock"] and g["balls"][0]["over_until"] < 0
    s._activate(0, "big", [])
    assert g["units"][0]["big_until"] > g["clock"]


def test_phase_ball_clears_bricks_without_bouncing():
    s = started(2)
    g = s.g
    g["bricks"] = [{"id": i, "cx": 400.0 + i * 30, "cy": 500.0, "hw": 24.0, "hh": 11.0,
                    "special": False, "alive": True} for i in range(3)]
    b = {"id": 1, "x": 380.0, "y": 500.0, "vx": 1.0, "vy": 0.0, "speed": 500, "owner": 0,
         "last_touch_tick": 0, "phase_until": 999.0, "slow_until": -1.0,
         "over_until": -1.0, "neutral_since": 0.0}
    g["balls"] = [b]
    s._resolve_bricks(b, [])
    assert b["vx"] > 0                          # did not reflect
    assert sum(1 for br in g["bricks"] if not br["alive"]) >= 1


# --------------------------------------------------------------------------- #
# elimination / win / input / fuzz
# --------------------------------------------------------------------------- #
def test_elimination_and_win():
    s = started(2, lives=1)
    g = s.g
    s._score(1, {"x": 0, "y": 0, "owner": 0}, [])   # seat 1 conceded (1 life) -> out
    assert not g["units"][1]["alive"]
    done = s._check_win([])
    assert done is not None and g["result"]["winner_pid"] == s._pid(0)
    assert s.phase == "game_end"


def test_simultaneous_ko_is_draw():
    s = started(2, lives=1)
    g = s.g
    s._score(0, {"x": 0, "y": 0, "owner": 1}, [])   # seat 0 out
    s._score(1, {"x": 0, "y": 0, "owner": 0}, [])   # seat 1 out, same tick
    done = s._check_win([])
    assert done is not None
    assert g["result"]["draw"] is True
    assert g["result"]["winner_seat"] is None and g["result"]["winner_pid"] is None
    assert s.phase == "game_end"


def test_multi_from_center_when_no_owned_ball():
    s = started(4)
    g = s.g
    # one ball owned by a DIFFERENT seat; activator (seat 0) owns nothing
    g["balls"] = [{"id": 0, "x": 200.0, "y": 200.0, "vx": 1.0, "vy": 0.0, "speed": 700,
                   "owner": 1, "last_touch_tick": 0, "phase_until": -1.0,
                   "slow_until": -1.0, "over_until": -1.0, "neutral_since": 0.0}]
    s._activate(0, "multi", [])
    mine0 = [b for b in g["balls"] if b["owner"] == 0]
    assert len(mine0) >= 2
    assert all(b["x"] == P.CX and b["y"] == P.CY for b in mine0)   # from center, not forged
    assert any(b["owner"] == 1 and b["x"] == 200.0 for b in g["balls"])   # foreign ball untouched


def test_neutral_serve_grace():
    s = started(2)
    g = s.g
    cover_q(s, 0, 0.05)
    g["clock"] = 0.3                                 # within SERVE_GRACE
    b, e = put_ball(s, 0, 0.9, owner=None, speed=600); b["neutral_since"] = 0.0
    before = g["units"][0]["hp"]
    assert s._resolve_edges(b, []) is None          # fresh serve bounces, no score
    assert g["units"][0]["hp"] == before
    g["clock"] = P.SERVE_GRACE + 0.5                 # after grace, it does score
    b2, e2 = put_ball(s, 0, 0.9, owner=None, speed=600); b2["neutral_since"] = 0.0
    assert s._resolve_edges(b2, []) == "score"
    assert g["units"][0]["hp"] == before - 1


def test_finite_no_overflow():
    assert _finite(10 ** 4000) is False
    assert _finite(0.5) is True and _finite(True) is False


def test_malformed_input_never_crashes():
    s = started(2)
    for msg in [None, [], 7, "x", {"t": "paddle", "p": "nan"}, {"t": "paddle", "p": float("inf")},
                {"t": "paddle"}, {"t": "act"}, {"t": "zzz"}, {"t": "paddle", "p": []}]:
        s.game_action("h0", msg)
    s.game_action("h0", {"t": "paddle", "p": 2.5})
    assert 0.0 <= s.g["units"][0]["t_target"] <= 1.0


def _bot_match(seed, n, lives=3, cap=9000):
    s = BrickadeSession(rng=random.Random(seed))
    s.settings.update(players=n, lives=lives, difficulty="mixed")
    s.join("h0", "You", "🦊")
    s.set_ready("h0", True)
    s.start("h0")
    s.tick(s.gen)
    g = s.g
    s.players["h0"].connected = False
    ticks = 0
    while s.phase == "play" and ticks < cap:
        s.game_tick()
        ticks += 1
        for b in g["balls"]:
            assert math.hypot(b["x"] - P.CX, b["y"] - P.CY) < P.ARENA_R + 90
    assert s.phase == "game_end"
    return g["result"]["winner_seat"]


@pytest.mark.parametrize("seed", range(3))
def test_bot_fuzz(seed):
    _bot_match(seed, [2, 4, 6][seed % 3])


def test_determinism():
    assert _bot_match(4242, 4) == _bot_match(4242, 4)
