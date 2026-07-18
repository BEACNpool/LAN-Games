import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from games.rummikub import rules
from games.rummikub.game import RummikubSession


def make_session(n_humans=2, bots=0, rounds=1, seed=21):
    s = RummikubSession(rng=random.Random(seed))
    toks = []
    for i in range(n_humans):
        tok = f"rk-human-{i:02d}xx"
        s.join(tok, f"H{i}", None)
        s.set_ready(tok, True)
        toks.append(tok)
    s.settings["bot_players"] = bots
    s.settings["rounds"] = rounds
    s.start(toks[0])
    s.tick(s.gen)
    return s, toks


def test_start_and_deal_single_set():
    s, toks = make_session(2)
    g = s.g
    assert s.phase == "playing"
    assert not g["double_set"]
    assert all(len(g["hands"][t]) == 14 for t in g["order"])
    assert len(g["pool"]) == 106 - 28
    # all tiles unique across hands+pool
    allt = list(g["pool"]) + [t for h in g["hands"].values() for t in h]
    assert len(allt) == len(set(allt)) == 106


def test_double_set_at_five_players():
    s, toks = make_session(5)
    assert s.g["double_set"]
    assert len(s.g["pool"]) == 212 - 5 * 14
    s2, _ = make_session(3, bots=2)   # 3 humans + 2 bots = 5 seats
    assert s2.g["double_set"]


def test_bot_players_setting_fills_seats():
    s, toks = make_session(2, bots=2)
    assert len(s.g["order"]) == 4
    assert sum(1 for t in s.g["order"] if s.players[t].is_bot) == 2


def find_meldable(s, token):
    """Give the current player a guaranteed 30+ opener (test helper)."""
    hand = s.g["hands"][token]
    hand[:3] = ["r11.9", "r12.9", "r13.9"]   # synthetic ids kept unique
    return [["r11.9", "r12.9", "r13.9"]]


def test_commit_flow_and_meld_gate():
    s, toks = make_session(2)
    cur = s.g["order"][s.g["turn_idx"]]
    # cheap opener rejected
    hand = s.g["hands"][cur]
    weak = [t for t in hand if not rules.is_joker(t)][:1]
    fx = s.game_action(cur, {"t": "commit", "board": [[weak[0]] * 3]})
    assert any(f["kind"] in ("invalid", "commit_rejected") for f in fx)
    # inject a 36-point run and open with it
    board = find_meldable(s, cur)
    fx = s.game_action(cur, {"t": "commit", "board": board})
    assert any(f["kind"] == "played" and f["opened"] for f in fx), fx
    assert s.g["melded"][cur]
    assert len(s.g["hands"][cur]) == 14 - 3
    # turn advanced
    assert s.g["order"][s.g["turn_idx"]] != cur


def test_out_of_turn_rejected():
    s, toks = make_session(2)
    other = s.g["order"][(s.g["turn_idx"] + 1) % 2]
    fx = s.game_action(other, {"t": "draw"})
    assert any(f["kind"] == "invalid" for f in fx)


def test_draw_advances_and_grows_hand():
    s, toks = make_session(2)
    cur = s.g["order"][s.g["turn_idx"]]
    pool_before = len(s.g["pool"])
    fx = s.game_action(cur, {"t": "draw"})
    assert any(f["kind"] == "drew" for f in fx)
    assert len(s.g["hands"][cur]) == 15
    assert len(s.g["pool"]) == pool_before - 1


def test_win_by_empty_hand_scoring():
    s, toks = make_session(2)
    g = s.g
    cur = g["order"][g["turn_idx"]]
    other = g["order"][(g["turn_idx"] + 1) % 2]
    g["melded"][cur] = True
    g["hands"][cur] = ["r11.9", "r12.9", "r13.9"]
    g["hands"][other] = ["b05.9", "J.9"]        # 5 + 30 penalty
    fx = s.game_action(cur, {"t": "commit", "board": [["r11.9", "r12.9", "r13.9"]]})
    assert any(f["kind"] == "round_end" for f in fx)
    assert g["scores"][cur] == 35
    assert g["scores"][other] == -35
    assert s.phase == "game_end"          # rounds=1
    assert g["result"]["winner"] == s.players[cur].pid


def test_stalemate_everyone_passes():
    s, toks = make_session(2)
    g = s.g
    g["pool"] = []
    a = g["order"][g["turn_idx"]]
    b = g["order"][(g["turn_idx"] + 1) % 2]
    g["hands"][a] = ["r01.9"]              # value 1 -> stalemate winner
    g["hands"][b] = ["k13.9", "k12.9"]     # value 25
    s.game_action(a, {"t": "draw"})        # pass
    fx = s.game_action(b, {"t": "draw"})   # pass -> round ends
    assert any(f["kind"] == "round_end" and f["stalemate"] for f in fx)
    assert g["scores"][a] == 24 and g["scores"][b] == -24


def test_timeout_autopilot_acts():
    s, toks = make_session(2)
    cur = s.g["order"][s.g["turn_idx"]]
    hand_before = len(s.g["hands"][cur])
    fx = s.tick(s.gen)
    # autopilot either committed a play or drew — turn moved on either way
    assert s.g["order"][s.g["turn_idx"]] != cur or s.phase != "playing"
    assert any(f["kind"] in ("played", "drew", "passed") for f in fx)


def test_disconnected_seat_runs_on_autopilot():
    s, toks = make_session(2)
    cur = s.g["order"][s.g["turn_idx"]]
    s.leave(cur)
    due = s.next_bot_action()
    assert due is not None and due[1] == cur
    fx = s.run_bot(cur)
    assert any(f["kind"] in ("played", "drew", "passed") for f in fx)


def test_state_masks_other_hands():
    s, toks = make_session(2)
    st = s.state_for(toks[0])
    gm = st["game"]
    assert gm["hand"] is not None and len(gm["hand"]) == 14
    import json
    blob = json.dumps(s.state_for(toks[1]))
    hidden = [t for t in s.g["hands"][toks[0]] if t not in s.g["hands"][toks[1]]]
    for t in hidden:
        assert '"%s"' % t not in blob
    spec = s.state_for(None)
    assert spec["game"]["hand"] is None
    assert spec["game"]["pool"] == len(s.g["pool"])


def test_multi_round_flow():
    s, toks = make_session(2, rounds=2)
    g = s.g
    cur = g["order"][g["turn_idx"]]
    g["melded"][cur] = True
    g["hands"][cur] = ["r11.9", "r12.9", "r13.9"]
    s.game_action(cur, {"t": "commit", "board": [["r11.9", "r12.9", "r13.9"]]})
    assert s.phase == "round_end"
    s.tick(s.gen)
    assert s.phase == "playing"
    assert g["round_no"] == 2
    assert g["board"] == []
    assert all(len(h) == 14 for h in g["hands"].values())
