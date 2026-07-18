import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from games.battleship import game as bg
from games.battleship.bots import make_bot
from games.battleship.game import (BattleshipSession, BOARDS, cell_label,
                                   place_ok, random_fleet, ship_cells)


# ---------------- helpers ----------------

def make_session(n_humans=2, seed=7, **settings):
    s = BattleshipSession(rng=random.Random(seed))
    toks = []
    for i in range(n_humans):
        tok = f"ship-token-{i:02d}"
        s.join(tok, f"H{i}", None)
        s.set_ready(tok, True)
        toks.append(tok)
    s.settings.update({"bot_players": 0, **settings})
    s.start(toks[0])
    assert s.phase == "countdown"
    s.tick(s.gen)
    return s, toks


def place_all(s, toks):
    """Randomize + ready every human; returns once battle begins."""
    for tok in toks:
        assert not any(f["kind"] == "invalid"
                       for f in s.game_action(tok, {"t": "randomize"}))
        assert not any(f["kind"] == "invalid"
                       for f in s.game_action(tok, {"t": "place_ready"}))
    assert s.phase == "battle"


def fire(s, tok, target_tok, r, c):
    pid = s.players[target_tok].pid
    fx = s.game_action(tok, {"t": "fire", "target": pid, "r": r, "c": c})
    if s.phase == "resolve":
        s.tick(s.gen)                  # advance past the resolve beat
    return fx


def water_cell(s, tok):
    """A cell on tok's board that holds no ship and hasn't been shot."""
    pd = s.g["players"][tok]
    shipcells = {c for sh in pd["ships"] for c in (sh["cells"] or [])}
    for r in range(s.g["n"]):
        for c in range(s.g["n"]):
            if (r, c) not in shipcells and (r, c) not in pd["shots"]:
                return r, c
    raise AssertionError("no open water left")


def assert_fleet_legal(n, fleet_spec, ships):
    assert [sh["size"] for sh in ships] == [sz for _, sz in fleet_spec]
    seen = set()
    for sh in ships:
        assert sh["cells"] is not None
        assert len(sh["cells"]) == sh["size"]
        rs = {r for r, _ in sh["cells"]}
        cs = {c for _, c in sh["cells"]}
        assert len(rs) == 1 or len(cs) == 1        # straight line
        for (r, c) in sh["cells"]:
            assert 0 <= r < n and 0 <= c < n
            assert (r, c) not in seen              # no overlap
            seen.add((r, c))


# ---------------- primitives ----------------

def test_boards_spec():
    assert BOARDS["classic"]["n"] == 10
    assert [sz for _, sz in BOARDS["classic"]["fleet"]] == [5, 4, 3, 3, 2]
    assert BOARDS["quick"]["n"] == 8
    assert [sz for _, sz in BOARDS["quick"]["fleet"]] == [4, 3, 3, 2]


def test_cell_label():
    assert cell_label(0, 0) == "A1"
    assert cell_label(1, 3) == "B4"
    assert cell_label(9, 9) == "J10"


def test_place_ok_bounds_and_overlap():
    ships = [{"cells": [(0, 0), (0, 1)], "size": 2},
             {"cells": None, "size": 3}]
    # bounds
    assert not place_ok(8, ships, 1, ship_cells(0, 6, 3, "h"))
    assert not place_ok(8, ships, 1, ship_cells(6, 0, 3, "v"))
    assert place_ok(8, ships, 1, ship_cells(5, 5, 3, "h"))
    # overlap with ship 0
    assert not place_ok(8, ships, 1, ship_cells(0, 1, 3, "h"))
    # a ship never collides with its own old position
    assert place_ok(8, ships, 0, ship_cells(0, 0, 2, "v"))


def test_random_fleet_legal_on_both_boards():
    for board in ("classic", "quick"):
        spec = BOARDS[board]
        for seed in range(20):
            ships = random_fleet(random.Random(seed), spec["n"], spec["fleet"])
            assert_fleet_legal(spec["n"], spec["fleet"], ships)


# ---------------- settings & lobby ----------------

def test_settings_validation():
    s = BattleshipSession(rng=random.Random(1))
    ok = s.validate_settings({"board": "quick", "bot_players": 3,
                              "difficulty": "rookie", "turn_seconds": 40})
    assert ok == {"board": "quick", "bot_players": 3,
                  "difficulty": "rookie", "turn_seconds": 40}
    assert s.validate_settings({"board": "huge", "bot_players": 9,
                                "difficulty": "god", "turn_seconds": 5}) == {}
    assert s.validate_settings({"bot_players": True,
                                "turn_seconds": True}) == {}
    assert s.validate_settings({"turn_seconds": 0}) == {"turn_seconds": 0}


def test_solo_human_forces_a_bot():
    s, toks = make_session(1, seed=3)
    assert s.phase == "placement"
    assert len(s.participants) == 2
    assert sum(1 for t in s.participants if s.players[t].is_bot) == 1
    # bots are pre-placed and ready
    bot_tok = next(t for t in s.participants if s.players[t].is_bot)
    assert s.g["players"][bot_tok]["placed_ready"]


def test_bot_fill_respects_total():
    s, toks = make_session(2, seed=4, bot_players=3)
    assert len(s.participants) == 5
    assert sum(1 for t in s.participants if s.players[t].is_bot) == 3


# ---------------- placement ----------------

def test_manual_place_bounds_overlap_rotation():
    s, toks = make_session(2, seed=5, board="quick")
    a = toks[0]
    # legal placement
    fx = s.game_action(a, {"t": "place", "ship": 0, "r": 0, "c": 0, "dir": "h"})
    assert not any(f["kind"] == "invalid" for f in fx)
    assert s.g["players"][a]["ships"][0]["cells"] == [(0, 0), (0, 1), (0, 2), (0, 3)]
    # out of bounds
    fx = s.game_action(a, {"t": "place", "ship": 1, "r": 0, "c": 6, "dir": "h"})
    assert any(f["kind"] == "invalid" for f in fx)
    # overlap with ship 0
    fx = s.game_action(a, {"t": "place", "ship": 1, "r": 0, "c": 1, "dir": "v"})
    assert any(f["kind"] == "invalid" for f in fx)
    # rotation of ship 0 in place: would leave board? no — 4 down from r0 fits
    fx = s.game_action(a, {"t": "place", "ship": 0, "r": 0, "c": 0, "dir": "v"})
    assert not any(f["kind"] == "invalid" for f in fx)
    assert s.g["players"][a]["ships"][0]["cells"] == [(0, 0), (1, 0), (2, 0), (3, 0)]
    # rotation that runs off the board is refused and keeps the old spot
    fx = s.game_action(a, {"t": "place", "ship": 0, "r": 6, "c": 0, "dir": "v"})
    assert any(f["kind"] == "invalid" for f in fx)
    assert s.g["players"][a]["ships"][0]["cells"] == [(0, 0), (1, 0), (2, 0), (3, 0)]
    # junk input
    for bad in ({"ship": "x", "r": 0, "c": 0, "dir": "h"},
                {"ship": 0, "r": 0.5, "c": 0, "dir": "h"},
                {"ship": 0, "r": 0, "c": 0, "dir": "diag"},
                {"ship": 99, "r": 0, "c": 0, "dir": "h"},
                {"ship": True, "r": 0, "c": 0, "dir": "h"}):
        fx = s.game_action(a, {"t": "place", **bad})
        assert any(f["kind"] == "invalid" for f in fx), bad


def test_ready_gate_and_lock():
    s, toks = make_session(2, seed=6)
    a = toks[0]
    # not all placed -> refused
    fx = s.game_action(a, {"t": "place_ready"})
    assert any(f["kind"] == "invalid" for f in fx)
    s.game_action(a, {"t": "randomize"})
    assert_fleet_legal(s.g["n"], s.g["fleet_spec"], s.g["players"][a]["ships"])
    fx = s.game_action(a, {"t": "place_ready"})
    assert not any(f["kind"] == "invalid" for f in fx)
    # no touching ships after ready
    fx = s.game_action(a, {"t": "place", "ship": 0, "r": 0, "c": 0, "dir": "h"})
    assert any(f["kind"] == "invalid" for f in fx)
    fx = s.game_action(a, {"t": "randomize"})
    assert any(f["kind"] == "invalid" for f in fx)
    # second player readies -> battle begins
    s.game_action(toks[1], {"t": "randomize"})
    s.game_action(toks[1], {"t": "place_ready"})
    assert s.phase == "battle"


def test_placement_timeout_autodeploys_stragglers():
    s, toks = make_session(3, seed=8)
    # one player placed two ships manually, nobody readied
    s.game_action(toks[0], {"t": "place", "ship": 0, "r": 0, "c": 0, "dir": "h"})
    fx = s.tick(s.gen)
    assert s.phase == "battle"
    for tok in toks:
        pd = s.g["players"][tok]
        assert pd["placed_ready"]
        assert_fleet_legal(s.g["n"], s.g["fleet_spec"], pd["ships"])
    # the manual pick survived the auto-deploy
    assert s.g["players"][toks[0]]["ships"][0]["cells"][0] == (0, 0)
    assert any(f["kind"] == "battle_start" for f in fx)


# ---------------- battle ----------------

def test_shot_validation():
    s, toks = make_session(3, seed=9, board="quick")
    place_all(s, toks)
    cur = s._current()
    others = [t for t in s.participants if t != cur]
    my_pid = s.players[cur].pid
    other_pid = s.players[others[0]].pid
    # out of turn
    fx = s.game_action(others[0], {"t": "fire", "target": my_pid, "r": 0, "c": 0})
    assert any(f["kind"] == "invalid" for f in fx)
    # can't fire at yourself
    fx = s.game_action(cur, {"t": "fire", "target": my_pid, "r": 0, "c": 0})
    assert any(f["kind"] == "invalid" for f in fx)
    # bad coordinates
    for r, c in ((-1, 0), (0, 99), ("x", 0), (True, 0)):
        fx = s.game_action(cur, {"t": "fire", "target": other_pid, "r": r, "c": c})
        assert any(f["kind"] == "invalid" for f in fx), (r, c)
    # legal shot, then the same cell again is refused
    fx = s.game_action(cur, {"t": "fire", "target": other_pid, "r": 2, "c": 2})
    assert any(f["kind"] == "shot" for f in fx)
    s.tick(s.gen)                                 # resolve -> next turn
    # drive turns until it's cur's turn again, then repeat-fire the same cell
    for _ in range(10):
        if s._current() == cur and s.phase == "battle":
            break
        if s.phase == "resolve":
            s.tick(s.gen)
        else:
            fire(s, s._current(), cur, *water_cell(s, cur))
    fx = s.game_action(cur, {"t": "fire", "target": other_pid, "r": 2, "c": 2})
    assert any(f["kind"] == "invalid" for f in fx)
    # dead target refused
    s.g["players"][others[1]]["alive"] = False
    dead_pid = s.players[others[1]].pid
    fx = s.game_action(cur, {"t": "fire", "target": dead_pid, "r": 5, "c": 5})
    assert any(f["kind"] == "invalid" for f in fx)


def test_hit_miss_sunk_elimination_win():
    s, toks = make_session(2, seed=10, board="quick")
    place_all(s, toks)
    a, b = s._current(), [t for t in s.participants if t != s._current()][0]
    # miss lands in open water
    wr, wc = water_cell(s, b)
    fx = fire(s, a, b, wr, wc)
    shot = next(f for f in fx if f["kind"] == "shot")
    assert shot["result"] == "miss" and shot["label"] == cell_label(wr, wc)
    assert s.g["players"][b]["shots"][(wr, wc)] is False
    # b answers with a miss so the turn comes back
    fire(s, b, a, *water_cell(s, a))
    # a now sinks b's entire fleet, cell by cell
    sunk_seen, elim_seen = 0, False
    target_cells = [c for sh in s.g["players"][b]["ships"] for c in sh["cells"]]
    for (r, c) in target_cells:
        assert s._current() == a and s.phase == "battle"
        fx = s.game_action(a, {"t": "fire",
                               "target": s.players[b].pid, "r": r, "c": c})
        shot = next(f for f in fx if f["kind"] == "shot")
        assert shot["result"] == "hit"
        if shot["sunk"]:
            sunk_seen += 1
            assert shot["sunk"]["name"]
        if shot["eliminated"]:
            elim_seen = True
            assert shot["eliminated"] == s.players[b].pid
        if s.phase == "resolve":
            s.tick(s.gen)
            # b's answering turn: always a fresh water miss
            assert s._current() == b
            fire(s, b, a, *water_cell(s, a))
    assert sunk_seen == len(s.g["fleet_spec"])
    assert elim_seen
    assert s.phase == "game_end"
    res = s.g["result"]
    assert res["winner"] == s.players[a].pid
    assert res["standings"][0]["pid"] == s.players[a].pid
    assert res["standings"][0]["alive"]
    assert not res["standings"][1]["alive"]
    assert res["standings"][1]["cells_left"] == 0


def test_turn_rotation_skips_dead():
    s, toks = make_session(4, seed=12, board="quick")
    place_all(s, toks)
    order = s.g["order"]
    cur = s._current()
    nxt = order[(order.index(cur) + 1) % 4]
    after = order[(order.index(cur) + 2) % 4]
    # kill the very next player in order
    s.g["players"][nxt]["alive"] = False
    s.g["elim"].append(nxt)
    fire(s, cur, after, *water_cell(s, after))
    assert s._current() == after                  # dead seat skipped
    # eliminated players can't act
    fx = s.game_action(nxt, {"t": "fire",
                             "target": s.players[cur].pid, "r": 0, "c": 0})
    assert any(f["kind"] == "invalid" for f in fx)


def test_timeout_marks_afk_and_autopilot_fires():
    s, toks = make_session(2, seed=13, board="quick")
    place_all(s, toks)
    cur = s._current()
    fx = s.tick(s.gen)
    assert any(f["kind"] == "shot" for f in fx)   # autopilot fired
    assert any(f["kind"] == "toast" for f in fx)
    assert cur in s.g["afk"]
    # AFK players are picked up by the bot scheduler on their next turn
    s.tick(s.gen)                                 # resolve -> other player
    fire(s, s._current(), cur, *water_cell(s, cur))
    assert s._current() == cur and s.phase == "battle"
    due = s.next_bot_action()
    assert due is not None and due[1] == cur
    fx = s.run_bot(cur)
    assert any(f["kind"] == "shot" for f in fx)
    # acting again clears the AFK flag
    s.g["afk"].add(cur)
    s.game_action(cur, {"t": "fire", "target": "nope", "r": 0, "c": 0})
    assert cur not in s.g["afk"]


def test_no_timer_setting_leaves_no_deadline():
    s, toks = make_session(2, seed=14, board="quick", turn_seconds=0)
    place_all(s, toks)
    assert s.phase == "battle" and s.deadline is None
    # resolve beat still gets a deadline
    cur = s._current()
    other = [t for t in s.participants if t != cur][0]
    s.game_action(cur, {"t": "fire", "target": s.players[other].pid,
                        "r": 0, "c": 0})
    assert s.phase == "resolve" and s.deadline is not None
    s.tick(s.gen)
    assert s.phase == "battle" and s.deadline is None


# ---------------- public knowledge / masking ----------------

def test_state_hides_unhit_ships_but_exposes_shot_union():
    s, toks = make_session(3, seed=15, board="quick")
    place_all(s, toks)
    a, b, c = s.g["order"]
    # a hits one of b's ship cells; c sees that shot too
    hit_cell = s.g["players"][b]["ships"][0]["cells"][0]
    if s._current() != a:
        while s._current() != a:
            fire(s, s._current(), a, *water_cell(s, a))
            if s.phase == "resolve":
                s.tick(s.gen)
    fire(s, a, b, *hit_cell)
    st_c = s.state_for(c)
    gb = st_c["game"]
    b_board = next(x for x in gb["boards"] if x["pid"] == s.players[b].pid)
    assert [hit_cell[0], hit_cell[1], True] in b_board["shots"]
    # un-hit enemy ship cells never serialize for other viewers: no "ships"
    # key, and the only cell lists in the whole payload are sunk ships +
    # the viewer's own fleet
    assert "ships" not in b_board
    own_c = next(x for x in gb["boards"] if x["pid"] == s.players[c].pid)
    expected_cell_lists = sum(len(x["sunk"]) for x in gb["boards"]) \
        + len(own_c.get("ships", []))
    assert json.dumps(st_c).count('"cells"') == expected_cell_lists
    # own board DOES carry ships
    st_b = s.state_for(b)
    own = next(x for x in st_b["game"]["boards"] if x["pid"] == s.players[b].pid)
    assert own["ships"] and all(x["cells"] for x in own["ships"])
    # spectator (None viewer) sees no ships anywhere
    st_spec = s.state_for(None)
    assert all("ships" not in x for x in st_spec["game"]["boards"])
    # sunk ships become public
    ship0 = s.g["players"][b]["ships"][0]
    for cell in ship0["cells"]:
        s.g["players"][b]["shots"][cell] = True
    ship0["sunk"] = True
    st_c2 = s.state_for(c)
    b_board2 = next(x for x in st_c2["game"]["boards"]
                    if x["pid"] == s.players[b].pid)
    assert b_board2["sunk"][0]["name"] == ship0["name"]
    assert sorted(map(tuple, b_board2["sunk"][0]["cells"])) == \
        sorted(map(tuple, ship0["cells"]))


def test_eliminated_viewer_sees_all_boards_revealed():
    s, toks = make_session(3, seed=16, board="quick")
    place_all(s, toks)
    a = s.g["order"][0]
    s.g["players"][a]["alive"] = False
    st = s.state_for(a)
    assert all("ships" in x for x in st["game"]["boards"])
    # a living viewer still only sees their own
    alive_tok = s.g["order"][1]
    st2 = s.state_for(alive_tok)
    with_ships = [x for x in st2["game"]["boards"] if "ships" in x]
    assert len(with_ships) == 1
    assert with_ships[0]["pid"] == s.players[alive_tok].pid


# ---------------- bots ----------------

def test_sharp_bot_targets_after_hit():
    rng = random.Random(20)
    bot = make_bot("sharp", rng)
    shots = {(4, 4): True}
    view = {"n": 8, "victims": [{"token": "v", "cells_left": 11,
                                 "shots": shots, "sunk_cells": set(),
                                 "remaining_sizes": [4, 3, 3, 2]}]}
    for _ in range(20):
        tok, cell = bot.choose(view)
        assert tok == "v"
        assert cell in ((3, 4), (5, 4), (4, 3), (4, 5))
    # two hits in a row lock the orientation to the line ends
    shots2 = {(4, 4): True, (4, 5): True}
    view2 = {"n": 8, "victims": [{"token": "v", "cells_left": 10,
                                  "shots": shots2, "sunk_cells": set(),
                                  "remaining_sizes": [4, 3, 3, 2]}]}
    for _ in range(20):
        tok, cell = bot.choose(view2)
        assert cell in ((4, 3), (4, 6))


def test_sharp_bot_hunts_on_parity():
    rng = random.Random(21)
    bot = make_bot("sharp", rng)
    view = {"n": 8, "victims": [{"token": "v", "cells_left": 12, "shots": {},
                                 "sunk_cells": set(),
                                 "remaining_sizes": [4, 3, 3, 2]}]}
    for _ in range(30):
        _, (r, c) = bot.choose(view)
        assert 0 <= r < 8 and 0 <= c < 8
    # once only the destroyer (2) remains, hunting is checkerboard
    view2 = {"n": 8, "victims": [{"token": "v", "cells_left": 2, "shots": {},
                                  "sunk_cells": set(),
                                  "remaining_sizes": [2]}]}
    par = {(r + c) % 2 for _ in range(15)
           for (r, c) in [bot.choose(view2)[1]]}
    assert len(par) == 1


def test_bots_prefer_weakest_victim():
    rng = random.Random(22)
    bot = make_bot("sharp", rng)
    view = {"n": 8, "victims": [
        {"token": "strong", "cells_left": 12, "shots": {},
         "sunk_cells": set(), "remaining_sizes": [4, 3, 3, 2]},
        {"token": "weak", "cells_left": 1, "shots": {},
         "sunk_cells": set(), "remaining_sizes": [2]},
    ]}
    picks = [bot.choose(view)[0] for _ in range(60)]
    assert picks.count("weak") > picks.count("strong")


def test_full_seeded_bot_game_is_legal_to_completion():
    s, toks = make_session(1, seed=23, board="quick", bot_players=2)
    assert len(s.participants) == 3
    s.tick(s.gen)                       # placement timeout: deploy the human
    assert s.phase == "battle"
    seen = {t: set() for t in s.participants}
    n = s.g["n"]
    rounds = 0
    while s.phase != "game_end" and rounds < 5000:
        rounds += 1
        if s.phase == "resolve":
            s.tick(s.gen)
            continue
        cur = s._current()
        if s.players[cur].is_bot:
            fx = s.run_bot(cur)
        else:
            fx = s.tick(s.gen)          # human is on timeout autopilot
        assert not any(f["kind"] == "invalid" for f in fx), fx
        for f in fx:
            if f["kind"] != "shot":
                continue
            ttok = next(t for t in s.participants
                        if s.players[t].pid == f["target"])
            key = (f["r"], f["c"])
            assert 0 <= f["r"] < n and 0 <= f["c"] < n
            assert key not in seen[ttok], "repeat shot on the same cell"
            seen[ttok].add(key)
            assert f["target"] != f["shooter"]
    assert s.phase == "game_end"
    res = s.g["result"]
    assert res["winner"] is not None
    assert len(res["standings"]) == 3


def test_standings_survival_order_and_stats():
    s, toks = make_session(1, seed=24, board="quick", bot_players=2)
    s.tick(s.gen)
    while s.phase != "game_end":
        if s.phase == "resolve":
            s.tick(s.gen)
        elif s.players[s._current()].is_bot:
            s.run_bot(s._current())
        else:
            s.tick(s.gen)
    res = s.g["result"]
    rows = res["standings"]
    assert [r["place"] for r in rows] == [1, 2, 3]
    assert rows[0]["alive"] and not rows[1]["alive"] and not rows[2]["alive"]
    # survival order: 2nd place died AFTER 3rd place
    elim_pids = [s.players[t].pid for t in s.g["elim"]]
    assert rows[1]["pid"] == elim_pids[-1]
    assert rows[2]["pid"] == elim_pids[0]
    for r in rows:
        assert 0 <= r["hits"] <= r["shots"]
        assert r["ships_left"] >= 0 and r["cells_left"] >= 0
    assert rows[0]["cells_left"] > 0


def test_all_humans_leave_aborts():
    s, toks = make_session(2, seed=25)
    for t in toks:
        s.leave(t)
    assert s.phase == "lobby"
    assert not any(p.is_bot for p in s.players.values())
