import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from games.fortfling import game as ff
from games.fortfling.game import (
    FortFlingSession, WEAPONS, apply_impacts, fort_layout, gen_terrain,
    simulate_path, simulate_weapon,
)


def make(seed=7, **settings):
    session = FortFlingSession(rng=random.Random(seed))
    tokens = ["fort-token-left", "fort-token-right"]
    for index, token in enumerate(tokens):
        session.join(token, f"P{index}", None)
        session.set_ready(token, True)
    session.settings.update(settings)
    session.start(tokens[0])
    session.tick(session.gen)
    return session, tokens


def find_shot(terrain, forts, side, weapon, kind, target_side):
    for angle in range(10, 83, 5):
        for power_i in range(20, 101, 5):
            path = simulate_path(terrain, forts, side, angle, power_i / 100,
                                 0, weapon)
            if path["hit"] == {"kind": kind, "side": target_side}:
                return angle, power_i / 100, path
    raise AssertionError(f"no {weapon} shot found for {kind}:{target_side}")


def test_terrain_is_bounded_repeatable_and_fort_platforms_are_playable():
    first = gen_terrain(random.Random(4))
    second = gen_terrain(random.Random(4))
    assert first == second
    assert len(first) == ff.W
    assert all(40 <= height <= 140 for height in first)
    assert max(first) - min(first) > 25
    layout = fort_layout(first)
    assert layout["left"]["x"] < layout["left"]["sling_x"] < ff.W / 2
    assert layout["right"]["x"] > layout["right"]["sling_x"] > ff.W / 2


def test_ballistics_are_deterministic_and_work_from_both_sides():
    terrain = gen_terrain(random.Random(7))
    forts = fort_layout(terrain)
    angle, power, left = find_shot(terrain, forts, "left", "boulder", "cover", "right")
    assert left == simulate_path(terrain, forts, "left", angle, power, 0, "boulder")
    assert len(left["points"]) > 10
    _, _, right = find_shot(terrain, forts, "right", "boulder", "cover", "left")
    assert right["impact"] is not None


def test_every_weapon_has_its_distinct_trajectory_shape():
    terrain = gen_terrain(random.Random(3))
    forts = fort_layout(terrain)
    assert len(simulate_weapon(terrain, forts, "left", 40, .4, 0, "cluster")) == 3
    assert len(simulate_weapon(terrain, forts, "left", 40, .4, 0, "boulder")) == 1
    rocket = simulate_path(terrain, forts, "left", 25, .4, 0, "rocket")
    boulder = simulate_path(terrain, forts, "left", 25, .4, 0, "boulder")
    # Lower gravity/speed boost gives the rocket a longer flight at the same pull.
    assert rocket["points"][-1][0] > boulder["points"][-1][0]
    bounce = simulate_path(terrain, forts, "left", 25, .25, 0, "ricochet")
    assert bounce["impact"] is not None
    assert len(bounce["points"]) > 20


def test_direct_and_splash_damage_cover_and_fort():
    terrain = gen_terrain(random.Random(8))
    forts = fort_layout(terrain)
    target = forts["right"]
    cover_path = {
        "impact": [target["cover_x"], target["cover_y"] + 60],
        "hit": {"kind": "cover", "side": "right"}, "points": [],
    }
    events = apply_impacts(forts, "left", "boulder", [cover_path])
    assert forts["right"]["cover"] < ff.COVER_HP
    assert any(event["part"] == "cover" for event in events)

    fort_path = {
        "impact": [target["x"], target["y"] + 34],
        "hit": {"kind": "fort", "side": "right"}, "points": [],
    }
    hp = forts["right"]["hp"]
    events = apply_impacts(forts, "left", "bomb", [fort_path])
    assert forts["right"]["hp"] < hp
    assert forts["left"]["dealt"] > 0
    assert any(event["part"] == "fort" for event in events)


def test_start_is_exactly_two_forts_with_equal_inventory():
    session, tokens = make()
    assert session.phase == "battle"
    assert set(session.g["sides"].values()) == {"left", "right"}
    assert len(session.g["order"]) == 2
    for token in tokens:
        assert session.g["inventory"][token] == {
            key: spec["ammo"] for key, spec in WEAPONS.items()
        }
    third, fx = session.join("fort-token-third", "P3", None)
    assert third is None
    assert any(item["kind"] == "invalid" for item in fx)


def test_fire_clamps_values_spends_inventory_and_enters_resolve():
    session, _ = make()
    token = session.g["turn"]
    before = session.g["inventory"][token]["boulder"]
    fx = session.game_action(token, {
        "t": "fire", "weapon": "boulder", "angle": 999, "power": 4,
    })
    flung = next(item for item in fx if item["kind"] == "flung")
    assert flung["angle"] == 82
    assert flung["power"] == 1
    assert session.g["inventory"][token]["boulder"] == before - 1
    assert session.phase in ("resolve", "game_end")
    assert flung["paths"]


def test_out_of_turn_bad_input_and_empty_slot_are_rejected():
    session, _ = make()
    current = session.g["turn"]
    other = session._other(current)
    assert any(item["kind"] == "invalid" for item in session.game_action(
        other, {"t": "fire", "weapon": "bomb", "angle": 45, "power": .4}))
    assert any(item["kind"] == "invalid" for item in session.game_action(
        current, {"t": "fire", "weapon": "banana", "angle": 45, "power": .4}))
    assert any(item["kind"] == "invalid" for item in session.game_action(
        current, {"t": "fire", "weapon": "bomb", "angle": "high", "power": None}))
    session.g["inventory"][current]["bomb"] = 0
    assert any("empty" in item.get("msg", "") for item in session.game_action(
        current, {"t": "fire", "weapon": "bomb", "angle": 45, "power": .4}))


def test_resolve_rotates_turn_and_changes_wind():
    session, _ = make(seed=10)
    current = session.g["turn"]
    session.game_action(current, {
        "t": "fire", "weapon": "boulder", "angle": 35, "power": .4,
    })
    assert session.phase == "resolve"
    fx = session.tick(session.gen)
    assert session.phase == "battle"
    assert session.g["turn"] == session._other(current)
    assert any(item["kind"] == "turn" for item in fx)


def test_destroyed_enemy_fort_ends_with_winner_and_standings():
    session, _ = make(seed=2)
    current = session.g["turn"]
    side = session.g["sides"][current]
    enemy = session._other(current)
    enemy_side = session.g["sides"][enemy]
    session.g["forts"][enemy_side]["cover"] = 0
    session.g["forts"][enemy_side]["hp"] = 5
    angle, power, _ = find_shot(session.g["terrain"], session.g["forts"],
                                side, "boulder", "fort", enemy_side)
    fx = session.game_action(current, {
        "t": "fire", "weapon": "boulder", "angle": angle, "power": power,
    })
    assert session.phase == "game_end"
    assert session.g["result"]["winner"] == session.players[current].pid
    assert len(session.g["result"]["standings"]) == 2
    assert any(item["kind"] == "game_end" for item in fx)


def test_timeout_autofires_and_disconnect_shortens_current_turn():
    session, _ = make()
    current = session.g["turn"]
    fx = session.tick(session.gen)
    assert any(item["kind"] == "flung" for item in fx)
    if session.phase == "resolve":
        session.tick(session.gen)
    current = session.g["turn"]
    old_deadline = session.deadline
    fx = session.game_player_left(current)
    assert session.deadline < old_deadline
    assert any("auto-fling" in item["msg"] for item in fx)


def test_state_is_public_token_free_and_personalized():
    session, tokens = make()
    current = session.g["turn"]
    other = session._other(current)
    current_state = session.state_for(current)["game"]
    other_state = session.state_for(other)["game"]
    spectator = session.state_for(None)["game"]
    assert current_state["your_turn"]
    assert not other_state["your_turn"]
    assert spectator["your_side"] is None
    assert len(current_state["forts"]) == 2
    assert set(current_state["weapons"]) == set(WEAPONS)
    serialized = repr(session.state_for(tokens[0]))
    assert all(token not in serialized for token in tokens)


def test_ammo_limit_finishes_a_miss_fest():
    session, _ = make(seed=12)
    for _ in range(ff.MAX_SHOTS * 2 + 5):
        if session.phase == "game_end":
            break
        if session.phase == "resolve":
            session.tick(session.gen)
            continue
        token = session.g["turn"]
        weapon = next(key for key, count in session.g["inventory"][token].items() if count)
        session.game_action(token, {
            "t": "fire", "weapon": weapon, "angle": 82, "power": 1,
        })
    assert session.phase == "game_end"
    assert session.g["result"]["why"] in ("out of ammo", "fort smashed")


def test_settings_and_lobby_reset_clear_finished_state():
    session, _ = make()
    assert session.validate_settings({"turn_seconds": 30}) == {"turn_seconds": 30}
    assert session.validate_settings({"turn_seconds": 31}) == {}
    session.to_lobby()
    assert session.phase == "lobby"
    assert session.g is None
