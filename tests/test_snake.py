import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from games.snake import game as sg
from games.snake.game import SnakeSession

UP, DOWN, LEFT, RIGHT = (0, -1), (0, 1), (-1, 0), (1, 0)
NAME = {UP: "up", DOWN: "down", LEFT: "left", RIGHT: "right"}


def make(n_humans=1, seed=7, **settings):
    s = SnakeSession(rng=random.Random(seed))
    toks = []
    for i in range(n_humans):
        tok = f"snake-token-{i:02d}"
        s.join(tok, f"P{i}", None)
        s.set_ready(tok, True)
        toks.append(tok)
    s.settings.update({"bot_players": 0, **settings})
    s.start(toks[0])
    s.tick(s.gen)          # countdown fires -> game_start
    return s, toks


def step(s, n=1):
    fx = []
    for _ in range(n):
        fx.extend(s.tick(s.gen))
    return fx


def place(s, tok, head, d, length=4):
    """Teleport a snake into a controlled position (body trails behind)."""
    sn = s.g["snakes"][tok]
    sn["body"] = [(head[0] - d[0] * i, head[1] - d[1] * i)
                  for i in range(length)]
    sn["dir"] = d
    sn["pending"] = []
    sn["grow"] = 0
    return sn


def no_apples(s):
    """Silence apple/gold spawning for surgical tests."""
    s._spawn_apples = lambda: None
    s.g["items"] = {}


# ---------------- core movement ----------------

def test_tick_advances_every_snake_one_cell():
    s, toks = make(1)                       # solo forces one bot in
    assert len(s.participants) == 2
    assert s.phase == "play"
    pre = {t: (sn["body"][0], sn["dir"]) for t, sn in s.g["snakes"].items()}
    step(s)
    for t, sn in s.g["snakes"].items():
        (hx, hy), _ = pre[t]
        nx, ny = sn["body"][0]
        assert abs(nx - hx) + abs(ny - hy) == 1     # exactly one cell
        assert len(sn["body"]) == sg.START_LEN
    # the human had no pending turns: pure straight drift
    hx, hy = pre[toks[0]][0]
    dx, dy = pre[toks[0]][1]
    assert s.g["snakes"][toks[0]]["body"][0] == (hx + dx, hy + dy)


def test_spawns_are_in_bounds_and_disjoint():
    s, toks = make(8, bot_players=0)
    seen = set()
    for sn in s.g["snakes"].values():
        for (x, y) in sn["body"]:
            assert 0 <= x < sg.GW and 0 <= y < sg.GH
            assert (x, y) not in seen
            seen.add((x, y))


def test_growth_from_apple():
    s, toks = make(1)
    no_apples(s)
    sn = place(s, toks[0], (10, 13), RIGHT)
    place(s, s.participants[1], (10, 20), RIGHT)      # keep the bot away
    s.g["items"][(11, 13)] = {"what": "apple", "until": None,
                              "score": sg.APPLE_SCORE, "grow": sg.APPLE_GROW}
    step(s)
    assert sn["score"] == sg.APPLE_SCORE
    assert sn["grow"] == sg.APPLE_GROW
    assert len(sn["body"]) == sg.START_LEN            # growth is spread out
    step(s, 3)
    assert len(sn["body"]) == sg.START_LEN + sg.APPLE_GROW
    assert sn["grow"] == 0
    step(s)
    assert len(sn["body"]) == sg.START_LEN + sg.APPLE_GROW


def test_reversal_rejected():
    s, toks = make(1)
    no_apples(s)
    sn = place(s, toks[0], (10, 13), RIGHT)
    place(s, s.participants[1], (10, 20), RIGHT)
    s.game_action(toks[0], {"t": "turn", "dir": "left"})   # 180° — no
    assert sn["pending"] == []
    s.game_action(toks[0], {"t": "turn", "dir": "right"})  # no-op — no
    assert sn["pending"] == []
    step(s)
    assert sn["dir"] == RIGHT
    assert sn["body"][0] == (11, 13)


def test_queued_turns_two_deep():
    s, toks = make(1)
    no_apples(s)
    sn = place(s, toks[0], (10, 13), RIGHT)
    place(s, s.participants[1], (10, 20), RIGHT)
    s.game_action(toks[0], {"t": "turn", "dir": "up"})
    s.game_action(toks[0], {"t": "turn", "dir": "left"})
    s.game_action(toks[0], {"t": "turn", "dir": "down"})   # 3rd — dropped
    assert sn["pending"] == [UP, LEFT]
    step(s)
    assert sn["dir"] == UP and sn["body"][0] == (10, 12)
    step(s)
    assert sn["dir"] == LEFT and sn["body"][0] == (9, 12)
    step(s)
    assert sn["dir"] == LEFT and sn["body"][0] == (8, 12)  # queue exhausted


def test_malformed_dir_does_not_raise():
    # a client sending a non-string dir (JSON array/object) is unhashable;
    # game_action must reject it gracefully, never raise out of the lookup
    s, toks = make(1)
    no_apples(s)
    sn = place(s, toks[0], (10, 13), RIGHT)
    place(s, s.participants[1], (10, 20), RIGHT)
    for bad in ([0, 1], {"x": 1}, 3, None, True, ""):
        assert s.game_action(toks[0], {"t": "turn", "dir": bad}) == []
    assert sn["pending"] == []
    s.game_action(toks[0], {"t": "turn", "dir": "up"})   # a real turn still lands
    assert sn["pending"] == [UP]


# ---------------- death ----------------

def test_wall_death_and_pellet_conversion():
    s, toks = make(2, bot_players=0)
    no_apples(s)
    a = place(s, toks[0], (0, 13), LEFT)         # next tick: off the wall
    place(s, toks[1], (10, 20), RIGHT)
    body_before = list(a["body"])
    fx = step(s)
    assert not a["alive"] and a["died"] == "wall"
    assert a["body"] == []
    for cell in body_before:
        it = s.g["items"].get(cell)
        assert it and it["what"] == "pellet" and it["score"] == sg.PELLET_SCORE
        assert it["until"] == s.g["tick"] + sg.PELLET_TTL_TICKS
    assert any(f["kind"] == "death" and f["cause"] == "wall" for f in fx)
    # 2 snakes -> lone survivor ends the round with the bonus
    assert s.phase == "round_end"
    assert s.g["snakes"][toks[1]]["wins"] == 1
    assert s.g["snakes"][toks[1]]["score"] == sg.SURVIVE_BONUS


def test_body_collision_kills_the_runner():
    s, toks = make(3, bot_players=0)             # 3 so the round continues
    no_apples(s)
    a = place(s, toks[0], (19, 10), RIGHT)
    b = place(s, toks[1], (20, 10 - 0), DOWN)    # vertical wall of body
    b["body"] = [(20, 10), (20, 9), (20, 8), (20, 7)]
    place(s, toks[2], (10, 20), RIGHT)
    step(s)
    assert not a["alive"] and a["died"] == "body"
    assert b["alive"]
    assert s.phase == "play"


def test_adjacent_head_swap_kills_both():
    s, toks = make(3, bot_players=0)
    no_apples(s)
    a = place(s, toks[0], (10, 10), RIGHT)
    b = place(s, toks[1], (11, 10), LEFT)
    b["body"] = [(11, 10), (12, 10), (13, 10), (14, 10)]
    place(s, toks[2], (10, 20), RIGHT)
    step(s)
    assert not a["alive"] and a["died"] == "body"
    assert not b["alive"] and b["died"] == "body"


def test_head_on_equal_lengths_both_die():
    s, toks = make(2, bot_players=0)
    no_apples(s)
    a = place(s, toks[0], (10, 10), RIGHT)
    b = place(s, toks[1], (12, 10), LEFT)
    b["body"] = [(12, 10), (13, 10), (14, 10), (15, 10)]
    step(s)
    assert not a["alive"] and a["died"] == "head"
    assert not b["alive"] and b["died"] == "head"
    assert s.phase == "round_end"                # zero survivors
    assert s.g["round_winner"] is None
    assert all(sn["wins"] == 0 for sn in s.g["snakes"].values())


def test_head_on_longer_snake_survives():
    s, toks = make(2, bot_players=0)
    no_apples(s)
    a = place(s, toks[0], (10, 10), RIGHT)
    b = place(s, toks[1], (12, 10), LEFT, length=5)
    b["body"] = [(12, 10), (13, 10), (14, 10), (15, 10), (16, 10)]
    step(s)
    assert not a["alive"] and a["died"] == "head"
    assert b["alive"] and b["body"][0] == (11, 10)


# ---------------- items ----------------

def test_apples_only_on_free_cells():
    s, toks = make(1, seed=13, bot_players=3)
    for _ in range(300):
        if s.phase == "game_end":
            break
        step(s)
        if s.phase != "play":
            continue
        bodies = set()
        for sn in s.g["snakes"].values():
            bodies.update(sn["body"])
        apples = 0
        for (x, y), it in s.g["items"].items():
            assert 0 <= x < sg.GW and 0 <= y < sg.GH
            assert (x, y) not in bodies
            if it["what"] == "apple":
                apples += 1
        assert apples == sg.N_APPLES


def test_pellets_fade():
    s, toks = make(2, bot_players=0)
    no_apples(s)
    place(s, toks[0], (2, 5), RIGHT)             # long safe corridors
    place(s, toks[1], (2, 20), RIGHT)
    s.g["items"][(40, 1)] = {"what": "pellet", "until": s.g["tick"] + 2,
                             "score": 1, "grow": 1}
    step(s)
    assert (40, 1) in s.g["items"]
    step(s)
    assert (40, 1) not in s.g["items"]


def test_golden_apple_spawns_and_expires():
    s, toks = make(2, bot_players=0)
    no_apples(s)
    place(s, toks[0], (2, 5), RIGHT)
    place(s, toks[1], (2, 20), RIGHT)
    s.g["round_tick"] = sg.GOLD_EVERY_TICKS - 1  # one tick before the drop
    # park the snakes on a treadmill so they never die: re-place each tick
    fx = step(s)
    assert any(f["kind"] == "gold_spawn" for f in fx)
    golds = [(c, it) for c, it in s.g["items"].items() if it["what"] == "gold"]
    assert len(golds) == 1
    (gx, gy), it = golds[0]
    assert it["score"] == sg.GOLD_SCORE and it["grow"] == sg.GOLD_GROW
    assert it["until"] == s.g["tick"] + sg.GOLD_TTL_TICKS
    for _ in range(sg.GOLD_TTL_TICKS):
        place(s, toks[0], (2, 5), RIGHT)
        place(s, toks[1], (2, 20), RIGHT)
        step(s)
    assert not any(i["what"] == "gold" for i in s.g["items"].values())


# ---------------- rounds & match ----------------

def test_round_end_and_best_of_three():
    s, toks = make(2, bot_players=0)             # rounds defaults to 3
    no_apples(s)
    place(s, toks[0], (0, 13), LEFT)             # A dives into the wall
    place(s, toks[1], (10, 20), RIGHT)
    step(s)
    b = s.g["snakes"][toks[1]]
    assert s.phase == "round_end"
    assert b["wins"] == 1 and b["score"] == sg.SURVIVE_BONUS
    assert s.g["round_winner"] == s.players[toks[1]].pid
    step(s)                                      # round_end -> round 2
    assert s.phase == "play" and s.g["round"] == 2
    for sn in s.g["snakes"].values():            # fresh spawns, scores kept
        assert sn["alive"] and len(sn["body"]) == sg.START_LEN
    assert s.g["snakes"][toks[1]]["score"] == sg.SURVIVE_BONUS
    no_apples(s)
    place(s, toks[0], (0, 13), LEFT)
    place(s, toks[1], (10, 20), RIGHT)
    step(s)                                      # B clinches 2 of 3
    assert s.phase == "game_end"
    res = s.g["result"]
    assert res["winner"] == s.players[toks[1]].pid
    assert res["standings"][0]["wins"] == 2
    assert len(res["standings"]) == 2
    assert res["rounds"] == 2


def test_best_of_one_ends_immediately():
    s, toks = make(2, bot_players=0, rounds=1)
    no_apples(s)
    place(s, toks[0], (0, 13), LEFT)
    place(s, toks[1], (10, 20), RIGHT)
    step(s)
    assert s.phase == "game_end"
    assert s.g["result"]["winner"] == s.players[toks[1]].pid


# ---------------- disconnects ----------------

def test_disconnect_drifts_then_becomes_bot():
    s, toks = make(2, bot_players=0)
    no_apples(s)
    a = place(s, toks[0], (2, 13), RIGHT)        # 40+ free cells ahead
    place(s, toks[1], (2, 20), RIGHT)
    s.leave(toks[0])
    assert a["dc_tick"] == s.g["tick"]
    head0 = a["body"][0]
    step(s, sg.GRACE_TICKS - 1)
    assert a["alive"] and not a["auto"]          # still drifting straight
    assert a["body"][0] == (head0[0] + sg.GRACE_TICKS - 1, head0[1])
    place(s, toks[1], (2, 20), RIGHT)            # keep B out of trouble
    step(s)
    assert a["alive"] and a["auto"]              # young round -> botified


def test_disconnect_late_round_dies():
    s, toks = make(2, bot_players=0)
    no_apples(s)
    a = place(s, toks[0], (2, 13), RIGHT)
    place(s, toks[1], (2, 20), RIGHT)
    s.leave(toks[0])
    s.g["round_tick"] = sg.YOUNG_TICKS + 100     # round is old
    step(s, sg.GRACE_TICKS - 1)
    assert a["alive"]
    place(s, toks[1], (2, 20), RIGHT)
    step(s)
    assert not a["alive"] and a["died"] == "gone"
    assert any(it["what"] == "pellet" for it in s.g["items"].values())


def test_reconnect_restores_control():
    s, toks = make(2, bot_players=0)
    no_apples(s)
    a = place(s, toks[0], (2, 13), RIGHT)
    place(s, toks[1], (2, 20), RIGHT)
    s.leave(toks[0])
    step(s, sg.GRACE_TICKS)
    assert a["auto"]
    s.join(toks[0], "P0", None)                  # back -> game_player_back
    assert not a["auto"] and a["dc_tick"] is None


# ---------------- bots ----------------

def _static_safe_moves(s, tok):
    """Non-reversal moves into cells that cannot be occupied post-move
    (bodies minus vacating tails). Mirrors what any legal bot must see."""
    sn = s.g["snakes"][tok]
    blocked = set()
    for other in s.g["snakes"].values():
        if not other["alive"] or not other["body"]:
            continue
        cells = other["body"] if other["grow"] > 0 else other["body"][:-1]
        blocked.update(cells)
    hx, hy = sn["body"][0]
    dx, dy = sn["dir"]
    out = []
    for d in ((0, -1), (1, 0), (0, 1), (-1, 0)):
        if d == (-dx, -dy):
            continue
        c = (hx + d[0], hy + d[1])
        if 0 <= c[0] < sg.GW and 0 <= c[1] < sg.GH and c not in blocked:
            out.append(d)
    return out


def test_bots_stay_legal_and_never_suicide_500_ticks():
    s, toks = make(1, seed=11, bot_players=4, rounds=5)
    bot_toks = [t for t in s.participants if s.players[t].is_bot]
    assert len(bot_toks) == 4
    play_ticks = 0
    for _ in range(500):
        if s.phase == "game_end":
            break
        if s.phase != "play":
            step(s)
            continue
        pre = {}
        for t in bot_toks:
            sn = s.g["snakes"][t]
            if sn["alive"]:
                pre[t] = (sn["body"][0], sn["dir"],
                          len(_static_safe_moves(s, t)) > 0)
        step(s)
        play_ticks += 1
        for t, (head, d, had_safe) in pre.items():
            sn = s.g["snakes"][t]
            if sn["alive"] and sn["body"]:
                nx, ny = sn["body"][0]
                mx, my = nx - head[0], ny - head[1]
                assert abs(mx) + abs(my) == 1          # one orthogonal cell
                assert (mx, my) != (-d[0], -d[1])      # never a reversal
            elif sn["died"] in ("wall", "body"):
                # a bot only crashes into certain death when truly boxed in
                assert not had_safe, \
                    f"bot {t} suicided ({sn['died']}) with a safe move open"
    assert play_ticks > 100


def test_rookie_bot_also_legal():
    s, toks = make(1, seed=23, bot_players=2, difficulty="rookie", rounds=5)
    for _ in range(200):
        if s.phase == "game_end":
            break
        pre = {t: (sn["body"][0], sn["dir"])
               for t, sn in s.g["snakes"].items()
               if sn["alive"] and s.players[t].is_bot}
        step(s)
        if s.phase != "play":
            continue
        for t, (head, d) in pre.items():
            sn = s.g["snakes"][t]
            if sn["alive"] and sn["body"]:
                nx, ny = sn["body"][0]
                mx, my = nx - head[0], ny - head[1]
                if abs(mx) + abs(my) == 1:             # same round only
                    assert (mx, my) != (-d[0], -d[1])


def test_bots_deterministic_given_seed():
    runs = []
    for _ in range(2):
        s, toks = make(1, seed=42, bot_players=3)
        s.leave(toks[0])
        step(s, 120)
        snap = [(t, sn["alive"], tuple(sn["body"][:1]), sn["score"])
                for t, sn in sorted(s.g["snakes"].items())]
        runs.append((snap, s.g["tick"], s.phase, s.g["round"]))
    assert runs[0] == runs[1]


# ---------------- settings & state ----------------

def test_validate_settings():
    s = SnakeSession(rng=random.Random(1))
    assert s.validate_settings({"bot_players": 5}) == {"bot_players": 5}
    assert s.validate_settings({"bot_players": 9}) == {}
    assert s.validate_settings({"bot_players": True}) == {}
    assert s.validate_settings({"rounds": 5}) == {"rounds": 5}
    assert s.validate_settings({"rounds": 4}) == {}
    assert s.validate_settings({"difficulty": "rookie"}) == \
        {"difficulty": "rookie"}
    assert s.validate_settings({"difficulty": "genius"}) == {}


def test_state_shape():
    s, toks = make(1)
    st = s.state_for(toks[0])
    g = st["game"]
    assert g["kind"] == "snake"
    assert g["grid"] == [sg.GW, sg.GH]
    assert g["tick_ms"] == sg.TICK_MS
    assert g["round"] == 1 and g["rounds_total"] == 3
    assert len(g["snakes"]) == 2
    for sn in g["snakes"]:
        assert sn["pid"] and len(sn["body"]) == sg.START_LEN
        assert sn["alive"] and sn["len"] == sg.START_LEN
    assert sum(1 for i in g["items"] if i["what"] == "apple") == sg.N_APPLES
    # spectator (no token) gets the same board
    assert s.state_for(None)["game"]["kind"] == "snake"
