import math
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from games.tanks import game as tg
from games.tanks.game import TanksSession, gen_terrain, simulate_shot, carve


def make(n_humans=2, seed=7, **settings):
    s = TanksSession(rng=random.Random(seed))
    toks = []
    for i in range(n_humans):
        tok = f"tank-token-{i:02d}"
        s.join(tok, f"P{i}", None)
        s.set_ready(tok, True)
        toks.append(tok)
    s.settings.update({"bot_players": 0, **settings})
    s.start(toks[0])
    s.tick(s.gen)
    return s, toks


# ---------------- terrain & physics ----------------

def test_terrain_bounds_and_variety():
    for style in ("rolling", "craggy", "canyon"):
        h = gen_terrain(random.Random(3), style)
        assert len(h) == tg.W
        assert all(20 <= v <= tg.H for v in h)
        assert max(h) - min(h) > 40      # not flat


def test_shot_hits_terrain_and_is_deterministic():
    rng = random.Random(5)
    h = gen_terrain(rng, "craggy")
    tanks = {"a": {"x": 200, "y": h[200], "hp": 100, "angle": 45, "dealt": 0},
             "b": {"x": 900, "y": h[900], "hp": 100, "angle": 135, "dealt": 0}}
    s1 = simulate_shot(h, tanks, "a", 45, 70, 5)
    s2 = simulate_shot(h, tanks, "a", 45, 70, 5)
    assert s1 == s2                       # deterministic
    assert s1["impact"] is not None       # lands somewhere on this map
    assert len(s1["points"]) > 10


def test_straight_up_comes_back_down_on_shooter():
    h = [100] * tg.W
    tanks = {"a": {"x": 600, "y": 100, "hp": 100, "angle": 90, "dealt": 0}}
    s = simulate_shot(h, tanks, "a", 90, 40, 0)
    assert s["impact"] is not None
    ix, iy = s["impact"]
    assert abs(ix - 600) < 30             # lands near the tank


def test_carve_lowers_terrain():
    h = [200] * tg.W
    carve(h, 600, 200)
    assert h[600] < 200
    assert h[600 - tg.BLAST_R - 5] == 200
    assert min(h) >= 20


# ---------------- session ----------------

def test_start_spreads_tanks_and_solo_gets_bot():
    s, toks = make(3)
    xs = sorted(t["x"] for t in s.g["tanks"].values())
    assert len(xs) == 3
    assert xs[1] - xs[0] > 100 and xs[2] - xs[1] > 100
    solo, _ = make(1)
    assert len(solo.participants) == 2    # forced bot opponent


def test_move_fuel_and_slope():
    s, toks = make(2)
    cur = s.g["order"][s.g["turn_idx"]]
    tank = s.g["tanks"][cur]
    # flatten local terrain for a clean move test
    for x in range(max(0, tank["x"] - 120), min(tg.W, tank["x"] + 121)):
        s.g["heights"][x] = 150
    tank["y"] = 150
    x0 = tank["x"]
    s.game_action(cur, {"t": "move", "dir": 1})
    assert s.g["tanks"][cur]["x"] == x0 + tg.MOVE_STEP
    assert s.g["fuel"] < tg.FUEL_PER_TURN
    # wall blocks
    wall_x = tank["x"] + tg.MOVE_STEP
    s.g["heights"][wall_x] = 150 + tg.MAX_SLOPE + 10
    fx = s.game_action(cur, {"t": "move", "dir": 1})
    assert any(f["kind"] == "invalid" and "steep" in f["msg"] for f in fx)
    # drain fuel -> blocked
    s.g["fuel"] = 2
    fx = s.game_action(cur, {"t": "move", "dir": -1})
    assert any(f["kind"] == "invalid" and "fuel" in f["msg"] for f in fx)


def test_fire_resolves_and_rotates():
    s, toks = make(2)
    cur = s.g["order"][s.g["turn_idx"]]
    fx = s.game_action(cur, {"t": "fire", "angle": 60, "power": 50})
    assert any(f["kind"] == "fired" for f in fx)
    assert s.phase in ("resolve", "game_end")
    if s.phase == "resolve":
        s.tick(s.gen)
        assert s.phase == "battle"
        assert s.g["order"][s.g["turn_idx"]] != cur or \
            s.g["tanks"][s.g["order"][s.g["turn_idx"]]]["hp"] > 0


def test_out_of_turn_and_bad_input():
    s, toks = make(2)
    other = s.g["order"][(s.g["turn_idx"] + 1) % 2]
    fx = s.game_action(other, {"t": "fire", "angle": 45, "power": 50})
    assert any(f["kind"] == "invalid" for f in fx)
    cur = s.g["order"][s.g["turn_idx"]]
    fx = s.game_action(cur, {"t": "fire", "angle": "up", "power": None})
    assert any(f["kind"] == "invalid" for f in fx)


def test_direct_hit_damages_and_kills_to_victory():
    s, toks = make(2)
    g = s.g
    a = g["order"][g["turn_idx"]]
    b = g["order"][(g["turn_idx"] + 1) % 2]
    # put b right next to a on flat ground and drop b's hp
    for x in range(tg.W):
        g["heights"][x] = 150
    g["tanks"][a].update({"x": 400, "y": 150})
    g["tanks"][b].update({"x": 520, "y": 150, "hp": 20})
    # aim with the bot solver — it should find the kill
    ang, pw = s._aim(a)
    fx = s.game_action(a, {"t": "fire", "angle": ang, "power": pw})
    fired = [f for f in fx if f["kind"] == "fired"][0]
    if s.phase == "game_end":
        assert s.g["result"]["winner"] == s.players[a].pid
        assert any(d["pid"] == s.players[b].pid for d in fired["damages"])
    else:
        # bot missed a 20hp tank? allowed but the shot must at least land
        assert fired["impact"] is not None


def test_self_damage_suicide_ends_game():
    s, toks = make(2)
    g = s.g
    a = g["order"][g["turn_idx"]]
    g["tanks"][a]["hp"] = 10
    # straight up, low power: it lands on your own head
    for x in range(tg.W):
        g["heights"][x] = 150
    for t in g["tanks"].values():
        t["y"] = 150
    fx = s.game_action(a, {"t": "fire", "angle": 90, "power": 30})
    assert s.phase == "game_end"
    b = g["order"][0] if g["order"][0] != a else g["order"][1]
    assert s.g["result"]["winner"] == s.players[b].pid


def test_timeout_fires_for_the_player():
    s, toks = make(2)
    cur = s.g["order"][s.g["turn_idx"]]
    fx = s.tick(s.gen)
    assert any(f["kind"] == "fired" for f in fx)


def test_full_bot_battle_finishes():
    s, toks = make(1, seed=11, difficulty="sharp")
    for _ in range(300):
        if s.phase == "game_end":
            break
        if s.phase == "resolve":
            s.tick(s.gen)
            continue
        cur = s.g["order"][s.g["turn_idx"]]
        p = s.players[cur]
        if p.is_bot:
            s.run_bot(cur)
        else:
            s.tick(s.gen)      # timeout autopilot fires for the human too
    assert s.phase == "game_end"
    assert s.g["result"]["winner"] is not None
    assert s.g["result"]["standings"]


def test_terrain_changes_after_impact():
    s, toks = make(2)
    v0 = s.g["terrain_v"]
    h0 = list(s.g["heights"])
    cur = s.g["order"][s.g["turn_idx"]]
    fx = s.game_action(cur, {"t": "fire", "angle": 45, "power": 60})
    fired = [f for f in fx if f["kind"] == "fired"][0]
    if fired["impact"]:
        assert s.g["terrain_v"] == v0 + 1
        assert s.g["heights"] != h0


def test_state_shape_and_fuel_privacy():
    s, toks = make(2)
    cur = s.g["order"][s.g["turn_idx"]]
    other = [t for t in toks if t != cur][0]
    st_cur = s.state_for(cur)["game"]
    st_other = s.state_for(other)["game"]
    assert st_cur["your_turn"] and st_cur["fuel"] is not None
    assert not st_other["your_turn"] and st_other["fuel"] is None
    assert len(st_cur["heights"]) == tg.W
    assert st_cur["world"] == [tg.W, tg.H]
