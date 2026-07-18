"""BUZZ BOARD engine tests: board construction, hidden information, buzzer
lockout, HOT CLUE / LAST CALL wagers, power surge, disconnects, and a full game.
"""

import random

from games.buzzboard.game import BuzzBoardSession, LENGTHS
from games.trivia import questions


TOKENS = ("aaaaaaaa", "bbbbbbbb", "cccccccc")


def _start(seed=1, settings=None, tokens=TOKENS):
    s = BuzzBoardSession(random.Random(seed))
    for i, token in enumerate(tokens):
        s.join(token, "P%d" % (i + 1), "🦊")
        s.set_ready(token, True)
    if settings:
        s.set_settings(tokens[0], settings)
    s.start(tokens[0])
    s.tick(s.gen)
    assert s.phase == "board"
    return s


def _cell(s, hot=None):
    cells = [c for cat in s.g["board"] for c in cat["cells"] if not c["used"]]
    if hot is None:
        return cells[0]
    return next(c for c in cells if c["hot"] is hot)


def _pick(s, cell=None):
    cell = cell or _cell(s, False)
    fx = s._select(s.g["selector"], cell["id"])
    return cell, fx


def test_board_uses_large_curated_bank_and_correct_shapes():
    assert len(questions.BANK) >= 600
    for length, spec in LENGTHS.items():
        s = _start(10, {"length": length})
        assert len(s.g["board"]) == spec["cats"]
        assert all(len(cat["cells"]) == spec["rows"] for cat in s.g["board"])
        cells = [c for cat in s.g["board"] for c in cat["cells"]]
        assert len(cells) == spec["cats"] * spec["rows"]
        assert len({c["key"] for c in cells}) == len(cells)
        assert len([c for c in cells if c["hot"]]) == spec["hots"]
        assert all(len(c["choices"]) == 4 and 0 <= c["correct"] < 4 for c in cells)
        assert all(cat["slug"] != "kids" for cat in s.g["board"])


def test_settings_validation_is_strict():
    s = BuzzBoardSession(random.Random(1))
    assert s.validate_settings({"length": "show", "penalty": "classic"}) == {
        "length": "show", "penalty": "classic"}
    assert s.validate_settings({"length": "giant", "penalty": "cruel"}) == {}


def test_only_selector_can_pick_and_hot_locations_never_leak():
    s = _start(2)
    selector = s.g["selector"]
    other = next(t for t in s.participants if t != selector)
    target = _cell(s, False)
    assert any(f["kind"] == "invalid" for f in s._select(other, target["id"]))
    assert not target["used"]

    tv = s.state_for(None)["game"]
    assert "hot" not in repr(tv["board"]).lower()
    assert "choices" not in repr(tv)
    assert "correct" not in repr(tv)
    s._select(selector, target["id"])
    assert s.phase == "clue" and target["used"]
    pre = repr(s.state_for(None)["game"])
    assert target["answer"] not in pre


def test_buzzer_is_first_valid_server_action_and_choices_are_private():
    s = _start(3, {"penalty": "half"})
    cell, _ = _pick(s)
    s.tick(s.gen)  # clue -> buzz
    assert s.phase == "buzz"
    first, second = s.participants[:2]
    s._buzz(first)
    assert s.phase == "answer" and s.g["buzzer"] == first
    assert any(f["kind"] == "too_late" for f in s._buzz(second))
    assert s.state_for(first)["game"]["me"]["choices"] == cell["choices"]
    assert s.state_for(second)["game"]["me"]["choices"] is None
    assert cell["answer"] not in repr(s.state_for(None)["game"])

    wrong = next(i for i in range(4) if i != cell["correct"])
    s._answer(first, wrong)
    assert s.phase == "buzz"
    assert s.g["scores"][first] == -(cell["value"] // 2)
    assert first in s.g["locked"]
    s._buzz(second)
    s._answer(second, cell["correct"])
    assert s.phase == "reveal"
    assert s.g["scores"][second] == cell["value"]
    assert s.g["selector"] == second
    assert s.state_for(None)["game"]["current"]["answer"] == cell["answer"]


def test_wrong_penalty_modes():
    for mode, expected_factor in (("none", 0), ("half", .5), ("classic", 1)):
        s = _start(20, {"penalty": mode})
        cell, _ = _pick(s)
        s.tick(s.gen)
        token = s.participants[0]
        s._buzz(token)
        wrong = next(i for i in range(4) if i != cell["correct"])
        s._answer(token, wrong)
        assert s.g["scores"][token] == -int(cell["value"] * expected_factor)


def test_hot_clue_hides_clue_then_validates_and_scores_wager():
    s = _start(4)
    hot = _cell(s, True)
    selector = s.g["selector"]
    s._select(selector, hot["id"])
    assert s.phase == "hot_wager"
    tv = s.state_for(None)["game"]
    assert tv["current"]["hot"] is True and tv["current"]["clue"] is None
    assert next(r for r in tv["roster"] if r["selector"])["pid"] == s.players[selector].pid
    assert s.state_for(selector)["game"]["me"]["hot_max"] >= hot["value"]
    assert any(f["kind"] == "invalid" for f in s._wager_hot(selector, True))
    assert any(f["kind"] == "invalid" for f in s._wager_hot(selector, 10**9))
    s._wager_hot(selector, hot["value"])
    assert s.phase == "hot_answer"
    assert s.state_for(None)["game"]["current"]["clue"] == hot["clue"]
    assert s.state_for(selector)["game"]["me"]["choices"] == hot["choices"]
    other = next(t for t in s.participants if t != selector)
    assert s.state_for(other)["game"]["me"]["choices"] is None
    s._answer_hot(selector, hot["correct"])
    assert s.phase == "reveal"
    assert s.g["scores"][selector] == hot["value"]


def test_hot_clue_timeout_resolves_instead_of_freezing():
    s = _start(5)
    hot = _cell(s, True)
    selector = s.g["selector"]
    s._select(selector, hot["id"])
    s.tick(s.gen)  # wager timeout -> answer
    assert s.phase == "hot_answer"
    s.tick(s.gen)  # answer timeout -> reveal
    assert s.phase == "reveal" and s.deadline is not None


def test_power_surge_doubles_only_unplayed_cells():
    s = _start(6)
    cells = [c for cat in s.g["board"] for c in cat["cells"]]
    for c in cells[:s.g["total"] // 2]:
        c["used"] = True
    s.g["used"] = s.g["total"] // 2
    before = {c["id"]: c["value"] for c in cells}
    fx = s._enter_board()
    assert s.g["surged"] is True
    assert any(f["kind"] == "power_surge" for f in fx)
    for c in cells:
        assert c["value"] == (before[c["id"]] if c["used"] else before[c["id"]] * 2)


def test_last_call_wagers_and_answers_remain_secret_until_reveal():
    s = _start(7, tokens=TOKENS[:2])
    for c in [c for cat in s.g["board"] for c in cat["cells"]]:
        c["used"] = True
    s.g["used"] = s.g["total"]
    s.g["scores"][TOKENS[0]] = 1200
    s.g["scores"][TOKENS[1]] = -200
    s._start_final()
    assert s.phase == "final_wager"
    assert s.state_for(TOKENS[1])["game"]["me"]["final_max"] == 1000
    s._wager_final(TOKENS[0], 1200)
    pre_tv = repr(s.state_for(None)["game"])
    assert "1200" not in repr(s.state_for(None)["game"]["final"])
    s._wager_final(TOKENS[1], 1000)
    assert s.phase == "final_answer"
    card = s.g["final"]["card"]
    tv_final = s.state_for(None)["game"]["final"]
    assert tv_final["answer"] is None and "choices" not in tv_final
    assert s.state_for(TOKENS[0])["game"]["me"]["choices"] == card["choices"]
    wrong = next(i for i in range(4) if i != card["correct"])
    s._pick_final(TOKENS[0], card["correct"])
    assert s.g["final"]["rows"] is None
    s._pick_final(TOKENS[1], wrong)
    assert s.phase == "final_reveal"
    assert s.g["scores"][TOKENS[0]] == 2400
    assert s.g["scores"][TOKENS[1]] == -1200
    public = s.state_for(None)["game"]["final"]
    assert public["answer"] == card["answer"] and len(public["rows"]) == 2
    assert "1200" in pre_tv  # score was public, but wager structure was not


def test_disconnect_passes_control_and_dropped_buzzer_gets_no_penalty():
    s = _start(8)
    selector = s.g["selector"]
    s.players[selector].connected = False
    s.game_player_left(selector)
    assert s.g["selector"] != selector
    cell, _ = _pick(s)
    s.tick(s.gen)
    buzzer = s.g["selector"]
    s._buzz(buzzer)
    score = s.g["scores"][buzzer]
    s.players[buzzer].connected = False
    s.game_player_left(buzzer)
    assert s.g["scores"][buzzer] == score
    assert s.phase in ("buzz", "reveal")


def test_rejoin_reports_surviving_score():
    s = _start(18)
    token = s.participants[0]
    s.g["scores"][token] = 700
    fx = s.game_player_back(token)
    assert fx == [{"kind": "toast", "to": token,
                   "msg": "Welcome back — score 700"}]


def test_state_for_tv_never_crashes_through_every_stage():
    s = _start(9, tokens=TOKENS[:2])
    assert s.state_for(None)["game"]
    cell, _ = _pick(s)
    assert s.state_for(None)["game"]
    s.tick(s.gen)
    assert s.state_for(None)["game"]
    token = s.participants[0]
    s._buzz(token)
    assert s.state_for(None)["game"]
    s._answer(token, cell["correct"])
    assert s.state_for(None)["game"]
    s.tick(s.gen)
    assert s.state_for(None)["game"]
    s._start_final()
    assert s.state_for(None)["game"]
    for t in s.participants:
        s._wager_final(t, 0)
    assert s.state_for(None)["game"]
    card = s.g["final"]["card"]
    for t in s.participants:
        s._pick_final(t, card["correct"])
    assert s.state_for(None)["game"]
    s.tick(s.gen)
    assert s.phase == "game_end" and s.state_for(None)["game"]["result"]


def test_full_quick_game_reaches_ranked_game_end():
    s = _start(11, tokens=TOKENS[:2])
    guard = 0
    while s.phase != "game_end" and guard < 1000:
        guard += 1
        if s.phase == "board":
            cell = _cell(s)
            s._select(s.g["selector"], cell["id"])
        elif s.phase == "clue":
            s.tick(s.gen)
        elif s.phase == "buzz":
            token = next(t for t in s.participants if t not in s.g["locked"])
            s._buzz(token)
        elif s.phase == "answer":
            s._answer(s.g["buzzer"], s.g["current"]["correct"])
        elif s.phase == "hot_wager":
            s._wager_hot(s.g["selector"], 0)
        elif s.phase == "hot_answer":
            s._answer_hot(s.g["selector"], s.g["current"]["correct"])
        elif s.phase == "reveal":
            s.tick(s.gen)
        elif s.phase == "final_wager":
            for t in s.participants:
                if t not in s.g["final"]["wagers"]:
                    s._wager_final(t, 0)
        elif s.phase == "final_answer":
            for t in s.participants:
                if t not in s.g["final"]["picks"]:
                    s._pick_final(t, s.g["final"]["card"]["correct"])
        else:
            s.tick(s.gen)
    assert guard < 1000 and s.phase == "game_end"
    result = s.g["result"]
    assert result and result == sorted(result, key=lambda r: -r["score"])
