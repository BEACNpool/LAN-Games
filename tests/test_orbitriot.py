import math
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from games.orbitriot import game as orbit
from games.orbitriot.game import (
    ABILITY_LOADOUT,
    BUMPERS,
    OrbitRiotSession,
    generate_stars,
    simulate_heat,
    spawn_points,
)


TOKENS = ["orbit-token-a", "orbit-token-b", "orbit-token-c"]


def make(seed=7, count=3, **settings):
    session = OrbitRiotSession(rng=random.Random(seed))
    tokens = TOKENS[:count]
    for index, token in enumerate(tokens):
        session.join(token, "Pilot %d" % index, None)
        session.set_ready(token, True)
    session.settings.update(settings)
    session.start(tokens[0])
    session.tick(session.gen)
    return session, tokens


def lock_all(session, ability="none", angle=123, power=.72):
    fx = []
    for token in session.g["order"]:
        fx.extend(session.game_action(token, {
            "t": "lock", "angle": angle, "power": power,
            "ability": ability if session.g["abilities"][token].get(ability, 0) else "none",
        }))
    return fx


def test_spawn_ring_is_balanced_rotates_and_never_overlaps():
    tokens = ["p%d" % i for i in range(8)]
    first = spawn_points(tokens, heat=1, phase=.2)
    second = spawn_points(tokens, heat=2, phase=.2)
    assert first != second
    radii = [math.hypot(p["x"] - orbit.CX, p["y"] - orbit.CY)
             for p in first.values()]
    assert all(abs(radius - 286) < .1 for radius in radii)
    points = list(first.values())
    assert min(math.hypot(a["x"] - b["x"], a["y"] - b["y"])
               for i, a in enumerate(points) for b in points[i + 1:]) > orbit.PUCK_R * 2


def test_star_generation_is_seeded_clear_of_geometry_and_spawns():
    spawns = spawn_points(["a", "b", "c", "d"], phase=.4)
    first = generate_stars(random.Random(9), 8, spawns)
    second = generate_stars(random.Random(9), 8, spawns)
    assert first == second
    assert len(first) == 8
    for star in first:
        assert math.hypot(star["x"] - orbit.CX, star["y"] - orbit.CY) > orbit.HOLE_R + 40
        assert all(math.hypot(star["x"] - b["x"], star["y"] - b["y"])
                   > b["r"] + orbit.STAR_R + 20 for b in BUMPERS)


def test_physics_replay_is_deterministic_bounded_and_has_all_frames():
    order = ["a", "b", "c", "d"]
    spawns = spawn_points(order, phase=.7)
    stars = generate_stars(random.Random(3), 7, spawns)
    shots = {t: {"angle": 30 + i * 79, "power": .72,
                 "ability": ("none", "boost", "anchor", "shield")[i]}
             for i, t in enumerate(order)}
    first = simulate_heat(order, spawns, shots, stars)
    second = simulate_heat(order, spawns, shots, stars)
    assert first == second
    assert len(first["frames"]) == int(orbit.SIM_SECONDS * 20) + 1
    assert set(first["deltas"]) == set(order)
    for frame in first["frames"]:
        assert len(frame["p"]) == 4
        for x, y, alive in frame["p"]:
            assert math.isfinite(x) and math.isfinite(y)
            if alive:
                assert orbit.WALL <= x <= orbit.WORLD_W - orbit.WALL
                assert orbit.WALL <= y <= orbit.WORLD_H - orbit.WALL


def test_star_pickup_scores_and_removes_collectible_from_replay():
    order = ["a", "b"]
    spawns = {"a": {"x": 180, "y": 120}, "b": {"x": 1020, "y": 555}}
    shots = {
        "a": {"angle": 0, "power": .55, "ability": "none"},
        "b": {"angle": 180, "power": .25, "ability": "none"},
    }
    stars = [{"id": 0, "x": 250, "y": 120}]
    result = simulate_heat(order, spawns, shots, stars)
    assert result["deltas"]["a"] >= 1
    event = next(e for e in result["events"] if e["what"] == "star")
    assert event["token"] == "a" and event["points"] == 1
    assert result["frames"][-1]["s"] & 1 == 0


def test_collision_can_credit_black_hole_knockout():
    order = ["hammer", "target"]
    spawns = {
        "hammer": {"x": orbit.CX - 160, "y": orbit.CY},
        "target": {"x": orbit.CX - 100, "y": orbit.CY},
    }
    shots = {
        "hammer": {"angle": 0, "power": 1, "ability": "anchor"},
        "target": {"angle": 0, "power": .25, "ability": "none"},
    }
    result = simulate_heat(order, spawns, shots, [])
    credited = [e for e in result["events"]
                if e["what"] == "knockout" and e.get("by") == "hammer"]
    assert credited
    assert result["deltas"]["hammer"] >= 3


def test_shield_fires_once_and_prevents_first_void_contact():
    result = simulate_heat(
        ["shielded"], {"shielded": {"x": orbit.CX - 68, "y": orbit.CY}},
        {"shielded": {"angle": 0, "power": .25, "ability": "shield"}}, [])
    assert any(e["what"] == "shield" for e in result["events"])
    shield_index = next(i for i, e in enumerate(result["events"]) if e["what"] == "shield")
    knockout_indexes = [i for i, e in enumerate(result["events"]) if e["what"] == "knockout"]
    assert not knockout_indexes or min(knockout_indexes) > shield_index


def test_game_starts_with_private_aiming_and_equal_powerups():
    session, tokens = make()
    assert session.phase == "aiming"
    assert session.g["heat"] == 1
    assert len(session.g["stars"]) >= 6
    assert all(session.g["abilities"][t] == ABILITY_LOADOUT for t in tokens)
    spectator = session.state_for(None)["game"]
    assert spectator["my_aim"] is None
    assert spectator["my_abilities"] is None


def test_lock_is_private_consumes_ability_and_all_locked_launches():
    session, _ = make()
    first = session.g["order"][0]
    fx = session.game_action(first, {
        "t": "lock", "angle": -90, "power": 9, "ability": "boost",
    })
    assert session.g["aims"][first] == {
        "angle": 270, "power": 1, "ability": "boost",
    }
    assert session.g["abilities"][first]["boost"] == ABILITY_LOADOUT["boost"] - 1
    assert any(e["kind"] == "locked" for e in fx)
    assert session.state_for(first)["game"]["my_aim"]["angle"] == 270
    for token in session.g["order"][1:]:
        session.game_action(token, {"t": "lock", "angle": 10,
                                    "power": .25, "ability": "none"})
    assert session.phase == "replay"
    assert session.g["replay"]["frames"]


def test_malformed_repeat_and_spent_ability_actions_are_safe():
    session, _ = make()
    token = session.g["order"][0]
    bad = [
        {"t": "lock", "angle": "north", "power": .5},
        {"t": "lock", "angle": float("nan"), "power": .5},
        {"t": "lock", "angle": 10, "power": []},
        {"t": "lock", "angle": 10, "power": .5, "ability": []},
        {"t": "explode", "angle": 10, "power": .5},
    ]
    for message in bad:
        fx = session.game_action(token, message)
        assert any(e["kind"] == "invalid" for e in fx)
    session.g["abilities"][token]["shield"] = 0
    fx = session.game_action(token, {"t": "lock", "angle": 10,
                                     "power": .5, "ability": "shield"})
    assert any("spent" in e.get("msg", "") for e in fx)
    session.game_action(token, {"t": "lock", "angle": 10,
                                "power": .5, "ability": "none"})
    assert session.game_action(token, {"t": "lock", "angle": 20,
                                       "power": .8, "ability": "none"}) == []


def test_timeout_and_disconnect_autolock_without_freezing():
    session, _ = make()
    first = session.g["order"][0]
    fx = session.game_player_left(first)
    assert first in session.g["locked"]
    assert any("autopilot" in e.get("msg", "") for e in fx)
    fx = session.tick(session.gen)
    assert session.phase == "replay"
    assert all(t in session.g["locked"] for t in session.g["order"])
    assert any(e["kind"] == "launch" for e in fx)


def test_public_replay_maps_every_internal_token_to_pid():
    session, tokens = make()
    lock_all(session)
    state = session.state_for(None)
    replay = state["game"]["replay"]
    assert len(replay["order"]) == 3
    assert all(pid.startswith("p") for pid in replay["order"])
    serialized = repr(state)
    assert all(token not in serialized for token in tokens)
    assert state["game"]["my_aim"] is None
    assert state["game"]["my_abilities"] is None


def test_full_seeded_game_reaches_ranked_result_and_resets():
    session, _ = make(heats=3)
    seen = set()
    for heat in range(3):
        assert session.phase == "aiming"
        seen.add(session.phase)
        lock_all(session, angle=heat * 71 + 15, power=.69)
        assert session.phase == "replay"
        seen.add(session.phase)
        session.tick(session.gen)
    assert session.phase == "game_end"
    result = session.g["result"]
    assert len(result) == 3
    assert [r["score"] for r in result] == sorted(
        (r["score"] for r in result), reverse=True)
    assert min(r["rank"] for r in result) == 1
    assert seen == {"aiming", "replay"}
    session.to_lobby()
    assert session.phase == "lobby" and session.g is None


def test_settings_validation_rejects_bool_and_unknown_values():
    session = OrbitRiotSession(random.Random(1))
    assert session.validate_settings({"heats": 7, "aim_seconds": 15}) == {
        "heats": 7, "aim_seconds": 15}
    assert session.validate_settings({"heats": True, "aim_seconds": 12}) == {}
