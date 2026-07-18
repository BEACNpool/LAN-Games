import json
import math
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from games.smelterskelter import game as smelter
from games.smelterskelter.game import (
    CARGO_FUSE_TICKS,
    HOOK_BUFFER_TICKS,
    MAX_SPEED,
    MIN_ROPE,
    OVERLOAD_TICKS,
    RESPAWN_TICKS,
    SmelterSkelterSession,
    TICK,
    WORLD_H,
    WORLD_W,
    anchor_position,
    generate_anchors,
    hazard_for_shift,
    segment_hits_rect,
)

# Deliberately distinctive so a substring search for them in any serialized
# payload is a real privacy assertion, not a coincidence.
TOKENS = ["secret-alpha-7f", "secret-bravo-2c", "secret-charlie-9d",
          "secret-delta-4e", "secret-echo-1a", "secret-foxtrot-8b",
          "secret-golf-3c", "secret-hotel-6d"]


def make(seed=7, count=3, **settings):
    session = SmelterSkelterSession(rng=random.Random(seed))
    tokens = TOKENS[:count]
    for index, token in enumerate(tokens):
        session.join(token, "Crew %d" % index, None)
        session.set_ready(token, True)
    session.settings.update(settings)
    session.start(tokens[0])
    session.tick(session.gen)           # countdown fires -> game_start
    return session, tokens


def run_ticks(session, n):
    fx = []
    for _ in range(n):
        if session.phase == "game_end":
            break
        fx.extend(session.tick(session.gen))
    return fx


def isolate(session, token):
    """Give one unit the arena to itself: park everyone else in a corner and
    stash the crate far away, so a physics assertion isn't perturbed."""
    g = session.g
    for other in g["order"]:
        if other == token:
            continue
        unit = g["units"][other]
        unit["x"], unit["y"] = 40.0, 40.0
        unit["vx"] = unit["vy"] = 0.0
        unit["hook"] = None
    if g["cargo"]:
        g["cargo"].update(x=WORLD_W - 40.0, y=40.0, vx=0.0, vy=0.0,
                          carrier=None, hang=None)


def dunk(session, token):
    """Drop a unit into the melt. The chain has to go first — a player still
    hooked to a high anchor physically cannot reach the floor."""
    unit = session.g["units"][token]
    unit.update(y=session.g["hazard_y"] + 3, vx=0.0, vy=0.0, hook=None)


def finite_world(session):
    g = session.g
    for unit in g["units"].values():
        for key in ("x", "y", "vx", "vy", "rope_len", "tension"):
            assert math.isfinite(unit[key]), (key, unit[key])
        assert -1.0 <= unit["x"] <= WORLD_W + 1.0
        assert -1.0 <= unit["y"] <= WORLD_H + 1.0
        assert math.hypot(unit["vx"], unit["vy"]) <= MAX_SPEED + 1.0
        assert unit["rope_len"] >= MIN_ROPE - 1e-6
    cargo = g["cargo"]
    if cargo:
        for key in ("x", "y", "vx", "vy"):
            assert math.isfinite(cargo[key]), (key, cargo[key])


# --------------------------------------------------------------- settings

def test_settings_accept_only_the_two_offered_values_and_reject_bools():
    session = SmelterSkelterSession(random.Random(1))
    assert session.DEFAULT_SETTINGS == {"shifts": 3, "shift_seconds": 45}
    assert session.validate_settings({"shifts": 2, "shift_seconds": 60}) == {
        "shifts": 2, "shift_seconds": 60}
    assert session.validate_settings({"shifts": 3, "shift_seconds": 45}) == {
        "shifts": 3, "shift_seconds": 45}
    # bools are ints in Python — they must not sneak through
    assert session.validate_settings({"shifts": True, "shift_seconds": True}) == {}
    assert session.validate_settings({"shifts": 4, "shift_seconds": 30}) == {}
    assert session.validate_settings({"shifts": "3", "shift_seconds": 45.0}) == {}
    assert session.validate_settings({}) == {}


def test_settings_drive_shift_count_and_length():
    session, _ = make(count=2, shifts=2, shift_seconds=60)
    assert session.g["shifts_total"] == 2
    assert session.g["shift_ticks"] == round(60 / TICK)
    # a directly-poked bad value is re-clamped on read, never trusted
    other = SmelterSkelterSession(random.Random(2))
    other.settings["shifts"] = 99
    assert other._setting("shifts", smelter.SHIFT_CHOICES) == 3


def test_match_length_lands_near_the_two_and_a_half_minute_target():
    session, _ = make(count=2)
    play = session.g["shifts_total"] * session.g["shift_ticks"] * TICK
    total = play + (session.g["shifts_total"] - 1) * smelter.SHIFT_BREAK_SECONDS
    assert 135 <= total <= 155          # ~2m30s


# --------------------------------------------------------- roles and start

def test_player_bounds_and_start_seats_everyone_attached_and_safe():
    assert SmelterSkelterSession.MIN_PLAYERS == 2
    assert SmelterSkelterSession.MAX_HUMANS == 8
    session, tokens = make(count=8)
    assert session.phase == "play"
    assert session.g["shift"] == 1
    assert list(session.g["units"]) == tokens
    assert session.g["order"] == tokens
    for token in tokens:
        unit = session.g["units"][token]
        assert unit["alive"] and unit["hook"] is not None
        assert unit["hook"]["kind"] == "anchor"
        assert unit["y"] < session.g["hazard_y"]      # nobody starts in the melt
        assert unit["rope_len"] >= MIN_ROPE
        assert session.g["stats"][token]["score"] == 0
    assert session.g["cargo"] is not None
    assert session.g["cargo"]["carrier"] is None


def test_ninth_human_is_turned_away():
    session, _ = make(count=8)
    player, fx = session.join("secret-india-0z", "Late", None)
    assert player is None
    assert any(e["kind"] == "invalid" for e in fx)


def test_anchors_are_varied_viable_and_escalate_with_cranes():
    rng = random.Random(12)
    first = generate_anchors(rng, 12, 1, hazard_for_shift(1))
    assert len(first) == 12
    assert [a["id"] for a in first] == list(range(12))
    assert all(a["kind"] != "crane" for a in first)     # shift 1 is static
    assert all(0 < a["x"] < WORLD_W and 0 < a["y"] < WORLD_H for a in first)
    assert len({round(a["y"]) for a in first}) > 6      # staggered, not a line
    xs = sorted(a["x"] for a in first)
    assert xs[0] < WORLD_W * 0.25 and xs[-1] > WORLD_W * 0.75   # spans the rig

    later = generate_anchors(random.Random(12), 12, 3, hazard_for_shift(3))
    assert any(a["kind"] == "crane" for a in later)
    assert generate_anchors(random.Random(5), 10, 2, 500.0) == \
        generate_anchors(random.Random(5), 10, 2, 500.0)    # seeded


def test_crane_anchors_sweep_deterministically_and_stay_in_bounds():
    crane = {"id": 0, "x": 600.0, "y": 200.0, "kind": "crane",
             "amp": 150.0, "speed": 0.8, "phase": 0.3}
    seen = {anchor_position(crane, t)[0] for t in range(0, 200, 7)}
    assert len(seen) > 10                              # it genuinely moves
    for t in range(0, 4000):
        x, y = anchor_position(crane, t * 0.5)
        assert math.isfinite(x) and y == 200.0
        assert 60.0 <= x <= WORLD_W - 60.0
    assert anchor_position(crane, 41) == anchor_position(crane, 41)
    beam = {"id": 1, "x": 300.0, "y": 100.0, "kind": "beam",
            "amp": 0.0, "speed": 0.0, "phase": 0.0}
    assert anchor_position(beam, 99) == (300.0, 100.0)  # fixed rig never drifts


def test_hazard_rises_every_shift():
    assert hazard_for_shift(1) > hazard_for_shift(2) > hazard_for_shift(3)
    assert hazard_for_shift(1) < WORLD_H


# ------------------------------------------------------- action semantics

def test_aim_sanitizes_wraps_and_refuses_non_numbers():
    session, tokens = make()
    unit = session.g["units"][tokens[0]]
    assert session.game_action(tokens[0], {"t": "aim", "d": 90}) == []
    assert unit["aim"] == 90.0
    session.game_action(tokens[0], {"t": "aim", "d": -30})
    assert unit["aim"] == 330.0                        # wrapped, never negative
    session.game_action(tokens[0], {"t": "aim", "d": 725.5})
    assert unit["aim"] == 5.5
    session.game_action(tokens[0], {"t": "aim", "d": 359})
    assert 0 <= unit["aim"] <= 359.99
    for bad in (True, False, "90", None, [90], {"d": 1},
                float("nan"), float("inf"), float("-inf")):
        fx = session.game_action(tokens[0], {"t": "aim", "d": bad})
        assert any(e["kind"] == "invalid" for e in fx), bad
    assert unit["aim"] == 359.0                        # unchanged by any of them


def test_hook_and_reel_take_real_bools_only():
    session, tokens = make()
    unit = session.g["units"][tokens[0]]
    for bad in (1, 0, "true", "", None, [], {}, 1.0):
        assert any(e["kind"] == "invalid"
                   for e in session.game_action(tokens[0], {"t": "hook", "on": bad})), bad
        assert any(e["kind"] == "invalid"
                   for e in session.game_action(tokens[0], {"t": "reel", "on": bad})), bad
    assert unit["reel_held"] is False
    assert session.game_action(tokens[0], {"t": "reel", "on": True}) == []
    assert unit["reel_held"] is True
    assert session.game_action(tokens[0], {"t": "reel", "on": False}) == []
    assert unit["reel_held"] is False


def test_unknown_and_malformed_actions_never_raise():
    session, tokens = make()
    junk = [
        None, 42, "hook", [], ("t", "aim"), {"t": "explode"}, {"t": None},
        {"t": "aim"}, {"t": "hook"}, {"t": "reel"}, {"t": ["aim"], "d": 1},
        {"t": "aim", "d": {"x": 1}}, {"t": "hook", "on": {"a": 1}},
        {"t": "reel", "on": [1, 2]}, {}, {"d": 90}, {"on": True},
        {"t": "aim", "d": 1e400}, {"t": "aim", "d": -1e400},
    ]
    for msg in junk:
        fx = session.game_action(tokens[0], msg)
        assert isinstance(fx, list)
        for event in fx:
            assert isinstance(event, dict) and "kind" in event
    finite_world(session)


def test_spectators_and_dead_phases_are_harmless_no_ops():
    session, tokens = make()
    assert session.game_action("nobody-token", {"t": "hook", "on": True}) == []
    assert session.game_action("nobody-token", {"t": "aim", "d": 10}) == []
    session.phase = "game_end"
    assert session.game_action(tokens[0], {"t": "hook", "on": True}) == []
    bare = SmelterSkelterSession(random.Random(3))
    assert bare.game_action("x", {"t": "aim", "d": 1}) == []


# -------------------------------------------------- attach / release / reel

def aim_at(session, token, x, y):
    unit = session.g["units"][token]
    degrees = math.degrees(math.atan2(y - unit["y"], x - unit["x"])) % 360
    session.game_action(token, {"t": "aim", "d": degrees})


def test_hook_release_and_reattach_to_an_aimed_anchor():
    session, tokens = make()
    token = tokens[0]
    unit = session.g["units"][token]
    fx = session.game_action(token, {"t": "hook", "on": False})
    assert any(e["kind"] == "release" for e in fx)
    assert unit["hook"] is None and unit["tension"] == 0.0

    target = max(
        (a for a in session.g["anchors"]
         if 90 < math.hypot(a["x"] - unit["x"], a["y"] - unit["y"]) < smelter.MAX_HOOK_RANGE),
        key=lambda a: math.hypot(a["x"] - unit["x"], a["y"] - unit["y"]))
    aim_at(session, token, target["x"], target["y"])
    fx = session.game_action(token, {"t": "hook", "on": True})
    hook = next(e for e in fx if e["kind"] == "hook")
    assert hook["what"] == "anchor" and hook["pid"] == session.players[token].pid
    assert unit["hook"] == {"kind": "anchor", "id": target["id"]}
    assert unit["rope_len"] > MIN_ROPE
    # holding an existing hook does not silently re-target
    before = dict(unit["hook"])
    assert session.game_action(token, {"t": "hook", "on": True}) == []
    assert unit["hook"] == before


def test_aim_cone_gates_which_targets_are_reachable():
    session, tokens = make(count=2)
    token = tokens[0]
    unit = session.g["units"][token]
    isolate(session, token)
    session.game_action(token, {"t": "hook", "on": False})
    unit.update(x=600.0, y=400.0, vx=0.0, vy=0.0)
    session.g["anchors"] = [
        {"id": 0, "x": 600.0, "y": 200.0, "kind": "beam",
         "amp": 0.0, "speed": 0.0, "phase": 0.0},
    ]
    # straight up (270 deg in screen coords) is dead on
    session.game_action(token, {"t": "aim", "d": 270})
    assert session._best_target(token, unit) == {"kind": "anchor", "id": 0}
    # inside the cone still catches
    session.game_action(token, {"t": "aim", "d": 270 + smelter.HOOK_CONE_DEG - 5})
    assert session._best_target(token, unit) is not None
    # outside it does not
    session.game_action(token, {"t": "aim", "d": 270 + smelter.HOOK_CONE_DEG + 8})
    assert session._best_target(token, unit) is None
    # nor does anything past the reach
    session.g["anchors"][0]["y"] = 400.0 - smelter.MAX_HOOK_RANGE - 60
    session.game_action(token, {"t": "aim", "d": 270})
    assert session._best_target(token, unit) is None


def test_aim_assist_prefers_the_better_aligned_and_closer_anchor():
    session, tokens = make(count=2)
    token = tokens[0]
    unit = session.g["units"][token]
    isolate(session, token)
    session.game_action(token, {"t": "hook", "on": False})
    unit.update(x=600.0, y=400.0, vx=0.0, vy=0.0)
    session.g["anchors"] = [
        {"id": 0, "x": 600.0, "y": 120.0, "kind": "beam",     # aligned, far
         "amp": 0.0, "speed": 0.0, "phase": 0.0},
        {"id": 1, "x": 600.0, "y": 280.0, "kind": "beam",     # aligned, near
         "amp": 0.0, "speed": 0.0, "phase": 0.0},
    ]
    session.game_action(token, {"t": "aim", "d": 270})
    assert session._best_target(token, unit)["id"] == 1
    assert session._best_target(token, unit) == session._best_target(token, unit)


def test_a_live_unit_is_a_legal_anchor_and_is_dropped_when_it_falls():
    session, tokens = make(count=2)
    rider, host = tokens
    session.game_action(rider, {"t": "hook", "on": False})
    session.g["anchors"] = []                       # only bodies left to grab
    session.g["units"][rider].update(x=600.0, y=555.0, vx=0.0, vy=0.0)
    session.g["units"][host].update(x=600.0, y=405.0, vx=0.0, vy=0.0, hook=None)
    aim_at(session, rider, 600.0, 405.0)
    fx = session.game_action(rider, {"t": "hook", "on": True})
    assert any(e["kind"] == "hook" and e["what"] == "unit" for e in fx)
    assert session.g["units"][rider]["hook"] == {"kind": "unit", "token": host}
    assert next(e for e in fx if e["kind"] == "hook")["on"] == \
        session.players[host].pid                   # public pid, not the token

    # Drop the host into the melt from close range, so the chain hangs slack —
    # a taut chain would haul the host back out, which is its own correct
    # behaviour and would mask the thing under test here.
    session.g["units"][host]["y"] = session.g["hazard_y"] + 5
    run_ticks(session, 1)
    assert not session.g["units"][host]["alive"]
    assert session.g["units"][rider]["hook"] is None    # host melted, chain gone
    finite_world(session)


def test_hook_press_is_buffered_briefly_until_a_target_swings_into_range():
    session, tokens = make(count=2)
    token = tokens[0]
    unit = session.g["units"][token]
    isolate(session, token)
    session.game_action(token, {"t": "hook", "on": False})
    unit.update(x=600.0, y=400.0, vx=0.0, vy=0.0)
    session.g["anchors"] = [
        {"id": 0, "x": 600.0, "y": 400.0 - smelter.MAX_HOOK_RANGE - 100,
         "kind": "beam", "amp": 0.0, "speed": 0.0, "phase": 0.0},
    ]
    session.game_action(token, {"t": "aim", "d": 270})
    fx = session.game_action(token, {"t": "hook", "on": True})
    assert not any(e["kind"] == "hook" for e in fx)     # nothing to grab yet
    assert unit["hook_buffer"] == session.g["tick"] + HOOK_BUFFER_TICKS
    session.g["anchors"][0]["y"] = 250.0                # target arrives
    fx = run_ticks(session, 1)
    assert any(e["kind"] == "hook" for e in fx)
    assert unit["hook"] == {"kind": "anchor", "id": 0}


def test_a_stale_buffered_press_expires_instead_of_catching_forever():
    session, tokens = make(count=2)
    token = tokens[0]
    unit = session.g["units"][token]
    isolate(session, token)
    session.game_action(token, {"t": "hook", "on": False})
    unit.update(x=600.0, y=300.0, vx=0.0, vy=0.0)
    session.g["anchors"] = []
    session.game_action(token, {"t": "aim", "d": 270})
    session.game_action(token, {"t": "hook", "on": True})
    assert unit["hook_buffer"]
    run_ticks(session, HOOK_BUFFER_TICKS + 2)
    assert unit["hook_buffer"] == 0
    assert unit["hook"] is None


def test_releasing_clears_the_buffer_so_it_cannot_fire_later():
    session, tokens = make(count=2)
    token = tokens[0]
    unit = session.g["units"][token]
    isolate(session, token)
    session.game_action(token, {"t": "hook", "on": False})
    unit.update(x=600.0, y=300.0, vx=0.0, vy=0.0)
    session.g["anchors"] = []
    session.game_action(token, {"t": "aim", "d": 270})
    session.game_action(token, {"t": "hook", "on": True})
    session.game_action(token, {"t": "hook", "on": False})
    assert unit["hook_buffer"] == 0 and unit["hook_held"] is False
    session.g["anchors"] = [{"id": 0, "x": 600.0, "y": 200.0, "kind": "beam",
                             "amp": 0.0, "speed": 0.0, "phase": 0.0}]
    run_ticks(session, 1)
    assert unit["hook"] is None


def test_reeling_shortens_the_chain_and_injects_real_swing_energy():
    session, tokens = make(count=2)
    token = tokens[0]
    isolate(session, token)
    unit = session.g["units"][token]
    unit["vx"] = unit["vy"] = 0.0
    start_len = unit["rope_len"]
    session.game_action(token, {"t": "reel", "on": True})
    peak = 0.0
    for _ in range(90):
        session.tick(session.gen)
        peak = max(peak, math.hypot(unit["vx"], unit["vy"]))
        finite_world(session)
    assert unit["rope_len"] < start_len              # chain came in
    assert unit["rope_len"] >= MIN_ROPE              # but never to nothing
    assert peak > 120.0                              # a dead hang became a swing

    # letting go pays the chain back out toward where it was attached
    reeled = unit["rope_len"]
    session.game_action(token, {"t": "reel", "on": False})
    run_ticks(session, 20)
    assert unit["rope_len"] > reeled
    assert unit["rope_len"] <= unit["rope_base"] + 1e-6


def test_shortening_a_taut_chain_conserves_angular_momentum():
    """The core locomotion claim: same chain, reeling wins on speed."""
    def swing(reel):
        session, tokens = make(seed=21, count=2)
        token = tokens[0]
        isolate(session, token)
        unit = session.g["units"][token]
        unit["vx"], unit["vy"] = 90.0, 0.0           # identical starting push
        session.game_action(token, {"t": "reel", "on": reel})
        peak = 0.0
        for _ in range(45):
            session.tick(session.gen)
            peak = max(peak, math.hypot(unit["vx"], unit["vy"]))
        return peak
    assert swing(True) > swing(False) * 1.2


# ------------------------------------------------------- rope constraint

def test_the_chain_never_stretches_past_its_length():
    session, tokens = make(seed=13, count=2)
    token = tokens[0]
    isolate(session, token)
    unit = session.g["units"][token]
    unit["vx"], unit["vy"] = 700.0, -260.0           # try to rip it off the rig
    session.game_action(token, {"t": "reel", "on": True})
    for step in range(150):
        session.tick(session.gen)
        finite_world(session)
        if not unit["alive"] or unit["hook"] is None:
            break
        point = session._hook_point(unit, session.g["tick"])
        if point is None:
            break
        span = math.hypot(unit["x"] - point[0], unit["y"] - point[1])
        assert span <= unit["rope_len"] + 2.0, (step, span, unit["rope_len"])


def test_a_slack_chain_lets_you_fall_freely():
    session, tokens = make(count=2)
    token = tokens[0]
    isolate(session, token)
    unit = session.g["units"][token]
    point = session._hook_point(unit, session.g["tick"])
    unit.update(x=point[0], y=point[1] + 4.0, vx=0.0, vy=0.0)   # right under it
    session.tick(session.gen)
    assert unit["vy"] > 0                            # gravity, not a rigid rod
    assert unit["tension"] == 0.0


# --------------------------------------------------------- collisions

def test_hard_collisions_stay_finite_separate_bodies_and_report_a_slam():
    session, tokens = make(count=2)
    a, b = tokens
    for token in tokens:
        session.game_action(token, {"t": "hook", "on": False})
    session.g["units"][a].update(x=560.0, y=300.0, vx=900.0, vy=0.0)
    session.g["units"][b].update(x=600.0, y=300.0, vx=-900.0, vy=0.0)
    if session.g["cargo"]:
        session.g["cargo"].update(x=60.0, y=60.0, carrier=None, hang=None)
    fx = run_ticks(session, 2)
    finite_world(session)
    assert any(e["kind"] == "slam" for e in fx)
    slam = next(e for e in fx if e["kind"] == "slam")
    assert 0.0 <= slam["power"] <= 1.0
    assert {slam["pid"], slam["pid2"]} == {session.players[a].pid,
                                           session.players[b].pid}
    assert session.g["stats"][a]["best_slam"] > 0
    ua, ub = session.g["units"][a], session.g["units"][b]
    assert math.hypot(ua["x"] - ub["x"], ua["y"] - ub["y"]) > 1.0   # pushed apart


def test_perfectly_overlapping_bodies_do_not_divide_by_zero():
    session, tokens = make(count=2)
    a, b = tokens
    for token in tokens:
        session.game_action(token, {"t": "hook", "on": False})
    session.g["units"][a].update(x=500.0, y=300.0, vx=0.0, vy=0.0)
    session.g["units"][b].update(x=500.0, y=300.0, vx=0.0, vy=0.0)
    run_ticks(session, 3)
    finite_world(session)


def test_carrying_cargo_makes_you_measurably_heavier_in_a_hit():
    def shove(carrying):
        session, tokens = make(seed=31, count=2)
        a, b = tokens
        for token in tokens:
            session.game_action(token, {"t": "hook", "on": False})
        session.g["units"][a].update(x=560.0, y=300.0, vx=800.0, vy=0.0)
        session.g["units"][b].update(x=594.0, y=300.0, vx=0.0, vy=0.0)
        cargo = session.g["cargo"]
        cargo.update(x=594.0, y=300.0, vx=0.0, vy=0.0, hang=None,
                     carrier=b if carrying else None,
                     fuse_tick=session.g["tick"] + 9999)
        if not carrying:
            cargo.update(x=60.0, y=60.0)
        session.tick(session.gen)
        return session.g["units"][b]["vx"]
    assert shove(True) < shove(False)                # loaded crew shift less


# --------------------------------------------------------------- cargo

def test_cargo_is_picked_up_on_contact_and_then_trails_on_its_chain():
    session, tokens = make(count=2)
    token = tokens[0]
    unit = session.g["units"][token]
    cargo = session.g["cargo"]
    cargo.update(x=unit["x"] + 4.0, y=unit["y"], vx=0.0, vy=0.0,
                 hang=None, fuse_tick=session.g["tick"] + 9999)
    fx = run_ticks(session, 1)
    pickup = next(e for e in fx if e["kind"] == "pickup")
    assert pickup["pid"] == session.players[token].pid
    assert cargo["carrier"] == token
    assert cargo["hang"] is None                      # dangling chain was cut
    assert session._carrying(token)
    run_ticks(session, 25)
    finite_world(session)
    span = math.hypot(cargo["x"] - unit["x"], cargo["y"] - unit["y"])
    assert span <= smelter.CARGO_CHAIN + 2.0          # short chain holds


def test_a_hanging_crate_waits_on_the_rig_instead_of_melting():
    session, _ = make(seed=17, count=2)
    cargo = session.g["cargo"]
    assert cargo["hang"] is not None
    cargo["fuse_tick"] = session.g["tick"] + 9999
    for _ in range(120):
        session.tick(session.gen)
        if cargo is not session.g["cargo"]:
            break
    assert session.g["cargo"]["y"] < session.g["hazard_y"]


def test_delivery_scores_three_and_respawns_crate_and_chute():
    session, tokens = make(count=2)
    token = tokens[0]
    g = session.g
    chute = g["chute"]
    unit = g["units"][token]
    unit.update(x=chute["x"] + chute["w"] / 2, y=chute["y"] - 140,
                vx=0.0, vy=0.0, hook=None)
    cargo = g["cargo"]
    cargo.update(x=unit["x"], y=chute["y"] - 100, vx=0.0, vy=0.0,
                 carrier=token, hang=None, fuse_tick=g["tick"] + 9999)
    before = dict(chute)
    fx = run_ticks(session, 12)
    delivery = next(e for e in fx if e["kind"] == "delivery")
    assert delivery["pid"] == session.players[token].pid
    assert delivery["points"] == 3 and delivery["over"] is False
    assert g["stats"][token]["score"] == 3
    assert g["stats"][token]["deliveries"] == 1
    assert g["cargo"] is not None and g["cargo"]["carrier"] is None
    assert dict(g["chute"]) != before                 # the chute moved
    assert g["cargo"]["hang"] is not None             # fresh crate is hung


def test_a_thrown_crate_still_credits_the_player_who_let_go():
    session, tokens = make(count=2)
    token = tokens[0]
    g = session.g
    chute = g["chute"]
    cargo = g["cargo"]
    cargo.update(x=chute["x"] + chute["w"] / 2, y=chute["y"] - 40,
                 vx=0.0, vy=120.0, carrier=None, hang=None,
                 last_carrier=token, last_carrier_tick=g["tick"],
                 fuse_tick=g["tick"] + 9999)
    fx = run_ticks(session, 6)
    assert any(e["kind"] == "delivery" and e["pid"] == session.players[token].pid
               for e in fx)
    assert g["stats"][token]["deliveries"] == 1


def test_stale_throw_credit_expires_and_scores_for_nobody():
    session, tokens = make(count=2)
    token = tokens[0]
    g = session.g
    chute = g["chute"]
    g["cargo"].update(x=chute["x"] + chute["w"] / 2, y=chute["y"] - 40,
                      vx=0.0, vy=120.0, carrier=None, hang=None,
                      last_carrier=token,
                      last_carrier_tick=g["tick"] - smelter.THROW_CREDIT_TICKS - 5,
                      fuse_tick=g["tick"] + 9999)
    fx = run_ticks(session, 6)
    assert not any(e["kind"] == "delivery" for e in fx)
    assert g["stats"][token]["deliveries"] == 0


def test_a_hard_enough_slam_steals_the_crate_from_its_carrier():
    session, tokens = make(count=2)
    victim, thief = tokens
    g = session.g
    for token in tokens:
        session.game_action(token, {"t": "hook", "on": False})
    g["units"][victim].update(x=600.0, y=300.0, vx=0.0, vy=0.0)
    g["units"][thief].update(x=560.0, y=300.0, vx=1000.0, vy=0.0)
    g["cargo"].update(x=600.0, y=300.0, vx=0.0, vy=0.0, carrier=victim,
                      hang=None, fuse_tick=g["tick"] + 9999)
    fx = run_ticks(session, 2)
    steal = next(e for e in fx if e["kind"] == "steal")
    assert steal["pid"] == session.players[thief].pid
    assert steal["pid2"] == session.players[victim].pid
    assert g["cargo"]["carrier"] == thief
    assert g["stats"][thief]["steals"] == 1
    assert g["stats"][victim]["steals"] == 0
    finite_world(session)


def test_a_gentle_bump_does_not_steal_the_crate():
    session, tokens = make(count=2)
    victim, other = tokens
    g = session.g
    for token in tokens:
        session.game_action(token, {"t": "hook", "on": False})
    g["units"][victim].update(x=600.0, y=300.0, vx=0.0, vy=0.0)
    g["units"][other].update(x=566.0, y=300.0, vx=30.0, vy=0.0)
    g["cargo"].update(x=600.0, y=300.0, vx=0.0, vy=0.0, carrier=victim,
                      hang=None, fuse_tick=g["tick"] + 9999)
    fx = run_ticks(session, 2)
    assert not any(e["kind"] == "steal" for e in fx)
    assert g["cargo"]["carrier"] == victim


def test_an_expired_fuse_explodes_shoves_the_crew_and_respawns_the_crate():
    session, tokens = make(count=2)
    token = tokens[0]
    g = session.g
    unit = g["units"][token]
    unit.update(x=600.0, y=300.0, vx=0.0, vy=0.0, hook=None)
    old = g["cargo"]
    old.update(x=620.0, y=300.0, vx=0.0, vy=0.0, carrier=None, hang=None,
               fuse_tick=g["tick"] + 1, grab_cd=g["tick"] + 999)
    fx = run_ticks(session, 1)
    boom = next(e for e in fx if e["kind"] == "cargo_boom")
    assert boom["what"] == "fuse"
    assert g["cargo"] is not old                      # a fresh crate exists
    assert g["cargo"]["hang"] is not None
    assert g["cargo"]["fuse_tick"] > g["tick"]
    assert unit["vx"] < 0                             # shoved away from the blast
    finite_world(session)


def test_a_crate_that_reaches_the_melt_explodes_and_comes_back_safe():
    session, tokens = make(count=2)
    g = session.g
    old = g["cargo"]
    old.update(x=600.0, y=g["hazard_y"] + 5, vx=0.0, vy=0.0, carrier=None,
               hang=None, fuse_tick=g["tick"] + 9999)
    fx = run_ticks(session, 1)
    assert any(e["kind"] == "cargo_boom" and e["what"] == "melt" for e in fx)
    assert g["cargo"] is not old
    assert g["cargo"]["y"] < g["hazard_y"]
    finite_world(session)


def test_a_carrier_who_falls_drops_the_crate():
    session, tokens = make(count=2)
    token = tokens[0]
    g = session.g
    unit = g["units"][token]
    dunk(session, token)
    g["cargo"].update(carrier=token, hang=None, x=unit["x"], y=unit["y"],
                      vx=0.0, vy=0.0, fuse_tick=g["tick"] + 9999)
    run_ticks(session, 1)
    assert not unit["alive"]
    assert g["cargo"] is None or g["cargo"]["carrier"] is None


def test_segment_sweep_catches_a_crate_that_would_tunnel_through():
    # straight through the middle in one step
    assert segment_hits_rect(100, 300, 500, 300, 280, 270, 60, 60)
    # clean miss above
    assert not segment_hits_rect(100, 100, 500, 100, 280, 270, 60, 60)
    # starting inside counts
    assert segment_hits_rect(300, 300, 305, 305, 280, 270, 60, 60)
    # a zero-length probe inside the mouth counts
    assert segment_hits_rect(300, 300, 300, 300, 280, 270, 60, 60)
    # parallel and outside does not
    assert not segment_hits_rect(0, 500, 900, 500, 280, 270, 60, 60)


# ------------------------------------------------- falling and respawning

def test_falling_costs_time_then_returns_you_with_a_super_hook():
    session, tokens = make(count=2)
    token = tokens[0]
    g = session.g
    unit = g["units"][token]
    dunk(session, token)
    fx = run_ticks(session, 1)
    fall = next(e for e in fx if e["kind"] == "fall")
    assert fall["pid"] == session.players[token].pid
    assert fall["pid2"] is None and fall["points"] == 0
    assert not unit["alive"] and unit["hook"] is None
    assert g["stats"][token]["falls"] == 1
    assert unit["respawn_tick"] == g["tick"] + RESPAWN_TICKS
    assert 1.5 <= RESPAWN_TICKS * TICK <= 2.5         # "about two seconds"

    run_ticks(session, RESPAWN_TICKS - 2)
    assert not unit["alive"]
    run_ticks(session, 3)
    assert unit["alive"] and unit["super"] is True
    assert unit["hook"] is not None                   # back on a safe anchor
    assert unit["y"] < g["hazard_y"]


def test_the_super_hook_reaches_further_and_is_spent_once():
    session, tokens = make(count=2)
    token = tokens[0]
    unit = session.g["units"][token]
    isolate(session, token)
    session.game_action(token, {"t": "hook", "on": False})
    unit.update(x=600.0, y=560.0, vx=0.0, vy=0.0)
    far = 560.0 - (smelter.MAX_HOOK_RANGE + 90)
    session.g["anchors"] = [{"id": 0, "x": 600.0, "y": far, "kind": "beam",
                             "amp": 0.0, "speed": 0.0, "phase": 0.0}]
    session.game_action(token, {"t": "aim", "d": 270})
    assert session._best_target(token, unit) is None  # out of normal reach
    unit["super"] = True
    assert session._best_target(token, unit) is not None
    fx = session.game_action(token, {"t": "hook", "on": True})
    assert next(e for e in fx if e["kind"] == "hook")["sup"] is True
    assert unit["super"] is False                     # spent on use
    assert unit["rope_len"] < 560.0 - far             # and it yanked us in


def test_shoving_someone_into_the_melt_pays_a_wipe_point():
    session, tokens = make(count=2)
    killer, victim = tokens
    g = session.g
    unit = g["units"][victim]
    unit["last_hit"] = killer
    unit["last_hit_tick"] = g["tick"]
    dunk(session, victim)
    fx = run_ticks(session, 1)
    fall = next(e for e in fx if e["kind"] == "fall")
    assert fall["pid2"] == session.players[killer].pid
    assert fall["points"] == 1
    assert g["stats"][killer]["wipes"] == 1
    assert g["stats"][killer]["score"] == 1
    assert g["stats"][victim]["score"] == 0           # no elimination, no loss


def test_a_stale_shove_earns_nothing_and_you_cannot_wipe_yourself():
    session, tokens = make(count=2)
    killer, victim = tokens
    g = session.g
    unit = g["units"][victim]
    unit["last_hit"] = killer
    unit["last_hit_tick"] = g["tick"] - smelter.WIPE_CREDIT_TICKS - 5
    dunk(session, victim)
    run_ticks(session, 1)
    assert g["stats"][killer]["wipes"] == 0

    other = g["units"][killer]
    other["last_hit"] = killer                        # credit to self: refused
    other["last_hit_tick"] = g["tick"]
    dunk(session, killer)
    run_ticks(session, 1)
    assert g["stats"][killer]["wipes"] == 0


def test_nobody_is_ever_eliminated():
    session, tokens = make(seed=44, count=4)
    g = session.g
    for token in tokens:                              # dunk the whole crew
        dunk(session, token)
    run_ticks(session, 1)
    assert all(not g["units"][t]["alive"] for t in tokens)
    assert session.phase == "play"                    # the shift carries on
    run_ticks(session, RESPAWN_TICKS + 3)
    assert all(g["units"][t]["alive"] for t in tokens)


# ------------------------------------------------------------- overload

def test_the_last_stretch_of_a_shift_goes_into_overload_and_pays_double():
    session, tokens = make(count=2)
    g = session.g
    g["shift_end_tick"] = g["tick"] + OVERLOAD_TICKS
    fx = run_ticks(session, 1)
    assert g["overload"] is True
    assert any(e["kind"] == "overload" and e["mult"] == 2 for e in fx)
    assert session.state_for(None)["game"]["overload"] is True

    token = tokens[0]
    chute = g["chute"]
    unit = g["units"][token]
    unit.update(x=chute["x"] + chute["w"] / 2, y=chute["y"] - 140,
                vx=0.0, vy=0.0, hook=None)
    g["cargo"].update(x=unit["x"], y=chute["y"] - 100, vx=0.0, vy=0.0,
                      carrier=token, hang=None, fuse_tick=g["tick"] + 9999)
    fx = run_ticks(session, 10)
    delivery = next(e for e in fx if e["kind"] == "delivery")
    assert delivery["points"] == 6 and delivery["over"] is True
    assert g["stats"][token]["score"] == 6
    assert g["stats"][token]["deliveries"] == 1       # still one crate


def test_overload_announces_once_and_lifts_when_the_shift_turns_over():
    session, _ = make(count=2, shifts=3)
    g = session.g
    g["shift_end_tick"] = g["tick"] + OVERLOAD_TICKS
    fx = run_ticks(session, OVERLOAD_TICKS)
    assert sum(1 for e in fx if e["kind"] == "overload") == 1
    assert session.phase == "shift_end"
    assert session.g["overload"] is False
    assert session.state_for(None)["game"]["overload"] is False


def test_early_in_a_shift_there_is_no_overload():
    session, _ = make(count=2)
    assert session.g["overload"] is False
    run_ticks(session, 5)
    assert session.g["overload"] is False


# -------------------------------------------------- shifts and match end

def test_a_shift_turns_over_with_a_break_and_a_regenerated_rig():
    session, tokens = make(seed=19, count=3, shifts=3)
    g = session.g
    old_anchors = [dict(a) for a in g["anchors"]]
    old_hazard = g["hazard_y"]
    g["shift_end_tick"] = g["tick"] + 1
    fx = run_ticks(session, 1)
    end = next(e for e in fx if e["kind"] == "shift_end")
    assert end["shift"] == 1 and end["total"] == 3
    assert [row["pid"] for row in end["board"]]       # public board, pids only
    assert session.phase == "shift_end"

    fx = session.tick(session.gen)                    # the break elapses
    start = next(e for e in fx if e["kind"] == "shift_start")
    assert start["shift"] == 2
    assert session.phase == "play"
    assert session.g["anchors"] != old_anchors        # fresh rig
    assert session.g["hazard_y"] < old_hazard         # melt has risen
    for token in tokens:
        unit = session.g["units"][token]
        assert unit["alive"] and unit["hook"] is not None
        assert unit["y"] < session.g["hazard_y"]
    finite_world(session)


def test_scores_persist_across_shifts():
    session, tokens = make(count=2, shifts=3)
    session.g["stats"][tokens[0]]["score"] = 11
    session.g["stats"][tokens[0]]["deliveries"] = 3
    session.g["shift_end_tick"] = session.g["tick"] + 1
    run_ticks(session, 1)
    session.tick(session.gen)
    assert session.g["shift"] == 2
    assert session.g["stats"][tokens[0]]["score"] == 11
    assert session.g["stats"][tokens[0]]["deliveries"] == 3


def test_the_final_shift_ends_the_match_with_a_ranked_result():
    session, tokens = make(seed=23, count=4, shifts=2)
    stats = session.g["stats"]
    stats[tokens[0]].update(score=9, deliveries=3, steals=1, wipes=0,
                            falls=2, best_slam=0.5)
    stats[tokens[1]].update(score=9, deliveries=2, steals=0, wipes=3,
                            falls=1, best_slam=0.9)
    stats[tokens[2]].update(score=4, deliveries=1, steals=2, wipes=1, falls=0)
    session.g["shift"] = 2
    session.g["shift_end_tick"] = session.g["tick"] + 1
    run_ticks(session, 1)
    assert session.phase == "game_end"
    result = session.g["result"]
    assert result["winner"] == session.players[tokens[0]].pid
    assert result["crew_deliveries"] == 6
    standings = result["standings"]
    assert len(standings) == 4
    assert [row["score"] for row in standings] == sorted(
        (row["score"] for row in standings), reverse=True)
    assert set(standings[0]) == {"pid", "score", "deliveries", "steals",
                                 "wipes", "falls", "best_slam"}
    # equal scores break on deliveries, so tokens[0] outranks tokens[1]
    assert standings[0]["pid"] == session.players[tokens[0]].pid
    assert standings[1]["pid"] == session.players[tokens[1]].pid


def test_result_tie_breaks_are_deterministic_and_never_seat_order_luck():
    session, tokens = make(seed=29, count=4, shifts=2)
    for token in tokens:                              # a dead-flat four-way tie
        session.g["stats"][token].update(score=5, deliveries=1, steals=1,
                                         wipes=1, falls=1, best_slam=0.4)
    session.g["shift"] = 2
    session.g["shift_end_tick"] = session.g["tick"] + 1
    run_ticks(session, 1)
    first = [row["pid"] for row in session.g["result"]["standings"]]
    assert first == [session.players[t].pid for t in tokens]
    assert session._ranked() == session._ranked()     # stable on repeat


def test_a_two_shift_match_really_only_plays_two_shifts():
    session, _ = make(seed=33, count=2, shifts=2)
    seen = set()
    guard = 0
    while session.phase != "game_end" and guard < 4000:
        seen.add(session.phase)
        session.tick(session.gen)
        guard += 1
    assert session.phase == "game_end"
    assert seen <= {"play", "shift_end"}
    assert session.g["shift"] == 2
    assert session.g["result"] is not None


# ------------------------------------------------------------ disconnect

def test_a_disconnect_goes_slack_and_ignores_input_until_the_pad_is_back():
    session, tokens = make(count=3)
    token = tokens[0]
    unit = session.g["units"][token]
    session.game_action(token, {"t": "reel", "on": True})
    assert unit["hook"] is not None and unit["reel_held"] is True

    fx = session.leave(token)
    assert any(e["kind"] == "release" for e in fx)
    assert unit["hook"] is None
    assert unit["hook_held"] is False and unit["reel_held"] is False
    assert unit["hook_buffer"] == 0

    # a stray message from a dropped socket changes nothing
    aim_before = unit["aim"]
    assert session.game_action(token, {"t": "aim", "d": 12}) == []
    assert session.game_action(token, {"t": "hook", "on": True}) == []
    assert session.game_action(token, {"t": "reel", "on": True}) == []
    assert unit["aim"] == aim_before
    assert unit["hook"] is None and unit["reel_held"] is False

    # the body stays in the world and keeps simulating
    assert token in session.g["units"]
    run_ticks(session, 12)
    finite_world(session)

    session.join(token, "Crew 0", None)
    assert session.players[token].connected is True
    assert session.game_action(token, {"t": "aim", "d": 12}) == []
    assert unit["aim"] == 12.0                        # steering is live again


def test_a_disconnected_unit_shows_its_flag_and_still_scores():
    session, tokens = make(count=2)
    token = tokens[0]
    session.leave(token)
    tv = session.state_for(None)["game"]
    row = next(u for u in tv["units"] if u[0] == session.players[token].pid)
    assert row[5] & 16                                # disconnected bit
    session.g["stats"][token]["score"] = 4
    assert session.state_for(None)["game"]["scores"][0]["score"] == 4


def test_disconnecting_while_dead_is_safe():
    session, tokens = make(count=2)
    token = tokens[0]
    dunk(session, token)
    run_ticks(session, 1)
    assert not session.g["units"][token]["alive"]
    session.leave(token)
    run_ticks(session, RESPAWN_TICKS + 3)
    assert session.g["units"][token]["alive"]
    finite_world(session)


# --------------------------------------------------------- serialization

def test_tv_payload_matches_the_contract_exactly():
    session, tokens = make(count=3)
    run_ticks(session, 4)
    state = session.state_for(None)["game"]
    assert state["kind"] == "smelterskelter" and state["mode"] == "tv"
    assert state["stage"] == "play"
    assert state["arena"] == [WORLD_W, WORLD_H]
    assert state["tick"] == session.g["tick"] and state["tick_ms"] == 67
    assert state["shift"] == 1 and state["shifts_total"] == 3
    assert isinstance(state["shift_left"], (int, float)) and state["shift_left"] > 0
    assert state["overload"] is False
    assert isinstance(state["hazard_y"], (int, float))
    for anchor in state["anchors"]:
        aid, ax, ay, kind = anchor
        assert isinstance(aid, int) and kind in smelter.ANCHOR_KINDS
        assert math.isfinite(ax) and math.isfinite(ay)
    assert len(state["units"]) == 3
    for row in state["units"]:
        pid, x, y, vx, vy, flags, hx, hy, tension, score = row
        assert pid.startswith("p")
        assert all(math.isfinite(v) for v in (x, y, vx, vy))
        assert isinstance(flags, int) and 0 <= flags <= 31
        assert (hx is None) == (hy is None)
        assert 0.0 <= tension <= 1.0 and isinstance(score, int)
    x, y, vx, vy, carrier, fuse = state["cargo"]
    assert carrier is None or carrier.startswith("p")
    assert fuse >= 0
    cx, cy, cw, ch = state["chute"]
    assert cw > 0 and ch > 0
    assert [set(s) for s in state["scores"]] == \
        [{"pid", "score", "deliveries", "steals", "wipes"}] * 3
    assert state["result"] is None


def test_flag_bits_mean_what_the_contract_says():
    session, tokens = make(count=2)
    token = tokens[0]
    g = session.g
    unit = g["units"][token]
    pid = session.players[token].pid

    def flags():
        tv = session.state_for(None)["game"]
        return next(u[5] for u in tv["units"] if u[0] == pid)

    assert flags() & 1 and flags() & 2                # alive + hooked
    assert not flags() & 4 and not flags() & 8 and not flags() & 16
    session.game_action(token, {"t": "hook", "on": False})
    assert not flags() & 2
    g["cargo"].update(carrier=token, hang=None, fuse_tick=g["tick"] + 999)
    assert flags() & 4
    unit["super"] = True
    assert flags() & 8
    session.leave(token)
    assert flags() & 16
    unit["alive"] = False
    assert not flags() & 1


def test_the_tv_never_learns_where_a_hook_is_when_there_is_none():
    session, tokens = make(count=2)
    session.game_action(tokens[0], {"t": "hook", "on": False})
    tv = session.state_for(None)["game"]
    row = next(u for u in tv["units"] if u[0] == session.players[tokens[0]].pid)
    assert row[6] is None and row[7] is None


def test_participant_pad_payload_matches_the_contract():
    session, tokens = make(count=3)
    run_ticks(session, 3)
    token = tokens[1]
    pad = session.state_for(token)["game"]
    assert pad["kind"] == "smelterskelter" and pad["mode"] == "pad"
    assert pad["stage"] == "play"
    assert pad["tick"] == session.g["tick"]
    assert pad["shift"] == 1 and pad["shifts_total"] == 3
    assert pad["shift_left"] > 0 and pad["overload"] is False
    assert pad["alive"] is True and pad["hooked"] is True
    assert 0.0 <= pad["tension"] <= 1.0
    assert pad["carrying"] is False and pad["super"] is False
    assert pad["score"] == 0
    assert 1 <= pad["rank"] <= 3
    assert pad["respawn"] == 0
    assert 0 <= pad["aim"] <= 359.99


def test_pad_reports_respawn_countdown_and_rank_movement():
    session, tokens = make(count=3)
    g = session.g
    dunk(session, tokens[0])
    run_ticks(session, 1)
    pad = session.state_for(tokens[0])["game"]
    assert pad["alive"] is False
    assert 0 < pad["respawn"] <= RESPAWN_TICKS * TICK + 0.1
    assert pad["hooked"] is False

    g["stats"][tokens[2]]["score"] = 50
    assert session.state_for(tokens[2])["game"]["rank"] == 1


def test_nonparticipant_pad_gets_only_the_watch_summary():
    session, tokens = make(count=2)
    session.join("watcher-token-xyz", "Watcher", None)
    watch = session.state_for("watcher-token-xyz")["game"]
    assert watch == {
        "kind": "smelterskelter", "mode": "watch", "stage": "play",
        "shift": 1, "shifts_total": 3,
        "shift_left": watch["shift_left"], "overload": False, "result": None,
    }
    assert "units" not in watch and "cargo" not in watch and "anchors" not in watch


def test_no_payload_or_effect_ever_leaks_a_token():
    session, tokens = make(count=8)
    fx = []
    for step in range(40):                            # generate real events
        for index, token in enumerate(tokens):
            session.game_action(token, {"t": "aim", "d": (step * 31 + index * 17) % 360})
            session.game_action(token, {"t": "hook", "on": (step + index) % 5 < 3})
            session.game_action(token, {"t": "reel", "on": (step + index) % 3 < 2})
        fx.extend(session.tick(session.gen))
    viewers = [None, tokens[0], tokens[3], "watcher-token-xyz"]
    blobs = [json.dumps(session.state_for(v), default=str) for v in viewers]
    blobs.append(json.dumps(fx, default=str))
    for blob in blobs:
        for token in tokens + ["watcher-token-xyz"]:
            assert token not in blob
        assert "secret-" not in blob


def test_effects_carry_public_pids_only():
    session, tokens = make(count=4)
    g = session.g
    a, b = tokens[0], tokens[1]
    for token in tokens:
        session.game_action(token, {"t": "hook", "on": False})
    g["units"][a].update(x=560.0, y=300.0, vx=1000.0, vy=0.0)
    g["units"][b].update(x=600.0, y=300.0, vx=-1000.0, vy=0.0)
    g["cargo"].update(x=600.0, y=300.0, carrier=b, hang=None,
                      fuse_tick=g["tick"] + 9999)
    fx = run_ticks(session, 3)
    pids = {p.pid for p in session.players.values()} | {None}
    assert fx
    for event in fx:
        for key in ("pid", "pid2", "on"):
            if key in event:
                assert event[key] in pids, event


def test_tv_payload_for_eight_players_stays_inside_the_budget():
    session, tokens = make(count=8)
    run_ticks(session, 30)
    payload = json.dumps(session.state_for(None)["game"], separators=(",", ":"))
    assert len(payload) < 3000, len(payload)

    # and the fattest moment of all: the final board
    session.g["shift"] = session.g["shifts_total"]
    session.g["shift_end_tick"] = session.g["tick"] + 1
    for index, token in enumerate(tokens):
        session.g["stats"][token].update(score=100 + index, deliveries=33,
                                         steals=22, wipes=44, falls=55,
                                         best_slam=0.99)
    run_ticks(session, 1)
    assert session.phase == "game_end"
    end = json.dumps(session.state_for(None)["game"], separators=(",", ":"))
    assert len(end) < 3000, len(end)


def test_game_state_is_safe_and_pure_in_every_live_phase():
    session, tokens = make(count=3, shifts=2)
    watcher = "watcher-token-xyz"
    session.join(watcher, "Watcher", None)
    seen = set()
    guard = 0
    while guard < 4000:
        guard += 1
        seen.add(session.phase)
        # the envelope's `now` is wall-clock by design; the game payload is not
        before = json.dumps(session.state_for(None)["game"], default=str)
        for viewer, mode in ((None, "tv"), (tokens[0], "pad"), (watcher, "watch")):
            state = session.state_for(viewer)
            game = state["game"]
            assert isinstance(game, dict)
            assert game["kind"] == "smelterskelter" and game["mode"] == mode
            assert game["stage"] == session.phase
        # reading state must not have moved the world
        assert json.dumps(session.state_for(None)["game"], default=str) == before
        if session.phase == "game_end":
            break
        session.tick(session.gen)
    assert seen == {"play", "shift_end", "game_end"}


def test_state_is_none_before_start_and_after_the_room_resets():
    session = SmelterSkelterSession(random.Random(6))
    assert session.game_state(None) is None
    session, tokens = make(count=2)
    assert session.game_state(None) is not None
    session.to_lobby()
    assert session.phase == "lobby" and session.g is None
    assert session.game_state(None) is None
    assert session.state_for(None)["game"] is None


# ------------------------------------------------------------ determinism

def scripted(seed, count=6, steps=260):
    """Same seed + same input script must give a byte-identical world."""
    session, tokens = make(seed=seed, count=count)
    for step in range(steps):
        if session.phase == "game_end":
            break
        for index, token in enumerate(tokens):
            session.game_action(token, {"t": "aim", "d": (step * 13 + index * 47) % 360})
            session.game_action(token, {"t": "hook", "on": (step + index) % 7 < 4})
            session.game_action(token, {"t": "reel", "on": (step + index) % 4 < 2})
        session.tick(session.gen)
    return session


def test_the_same_seed_and_script_replay_identically():
    first = scripted(101)
    second = scripted(101)
    assert json.dumps(first.state_for(None)["game"], default=str) == \
        json.dumps(second.state_for(None)["game"], default=str)
    assert first.g["stats"] == second.g["stats"]
    assert first.g["tick"] == second.g["tick"]


def test_different_seeds_diverge():
    assert json.dumps(scripted(101).state_for(None)["game"]["anchors"]) != \
        json.dumps(scripted(202).state_for(None)["game"]["anchors"])


def test_no_wall_clock_leaks_into_the_simulation():
    """shift_left is derived from the tick counter, so it only moves when the
    world does — not while the process sits idle."""
    session, _ = make(count=2)
    before = session.state_for(None)["game"]["shift_left"]
    assert session.state_for(None)["game"]["shift_left"] == before
    session.tick(session.gen)
    after = session.state_for(None)["game"]["shift_left"]
    assert after < before
    assert abs((before - after) - TICK) < 0.02      # serialized to 2 decimals


# ------------------------------------------------------------------ fuzz

def test_hundreds_of_fuzzed_ticks_never_raise_or_go_non_finite():
    rng = random.Random(4242)
    session, tokens = make(seed=99, count=8)
    junk = [None, 42, "hook", [], {}, {"t": "aim"}, {"t": "aim", "d": "x"},
            {"t": "aim", "d": float("nan")}, {"t": "aim", "d": float("inf")},
            {"t": "aim", "d": True}, {"t": "hook", "on": 1},
            {"t": "hook", "on": "yes"}, {"t": "reel", "on": None},
            {"t": "reel", "on": []}, {"t": "wat", "on": True},
            {"t": "aim", "d": -1e308}, {"t": "aim", "d": 1e308}]
    ticks = 0
    for step in range(700):
        if session.phase == "game_end":
            break
        for token in tokens:
            for _ in range(rng.randrange(0, 3)):
                session.game_action(token, rng.choice(junk))
            if rng.random() < 0.7:
                session.game_action(token, {"t": "aim", "d": rng.uniform(-720, 720)})
            if rng.random() < 0.4:
                session.game_action(token, {"t": "hook", "on": rng.random() < 0.5})
            if rng.random() < 0.4:
                session.game_action(token, {"t": "reel", "on": rng.random() < 0.5})
            if rng.random() < 0.02:
                session.leave(token)
            if rng.random() < 0.03:
                session.join(token, "Crew", None)
        session.tick(session.gen)
        ticks += 1
        finite_world(session)
        json.dumps(session.state_for(None), default=str)
        json.dumps(session.state_for(tokens[0]), default=str)
    assert ticks > 300


def test_a_fuzzed_match_still_reaches_a_coherent_result():
    rng = random.Random(77)
    session, tokens = make(seed=88, count=5, shifts=2, shift_seconds=45)
    guard = 0
    while session.phase != "game_end" and guard < 5000:
        guard += 1
        for token in tokens:
            if rng.random() < 0.5:
                session.game_action(token, {"t": "aim", "d": rng.uniform(0, 360)})
            if rng.random() < 0.3:
                session.game_action(token, {"t": "hook", "on": rng.random() < 0.6})
            if rng.random() < 0.3:
                session.game_action(token, {"t": "reel", "on": rng.random() < 0.5})
        session.tick(session.gen)
    assert session.phase == "game_end"
    result = session.g["result"]
    assert result["winner"] in {p.pid for p in session.players.values()}
    assert len(result["standings"]) == 5
    assert result["crew_deliveries"] == sum(r["deliveries"] for r in result["standings"])
    for row in result["standings"]:
        assert row["score"] >= 0 and row["falls"] >= 0
        assert 0.0 <= row["best_slam"] <= 1.0


def test_the_loop_always_rearms_or_ends():
    """A tick that neither re-arms nor ends the game freezes a real-time room."""
    session, _ = make(seed=55, count=3, shifts=2)
    guard = 0
    while session.phase != "game_end" and guard < 5000:
        guard += 1
        gen_before = session.gen
        session.tick(gen_before)
        assert session.gen != gen_before, "tick did not re-arm the deadline"
        assert session.deadline is not None
    assert session.phase == "game_end"
    assert session.deadline is not None                # game_end auto-returns
