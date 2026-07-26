"""Engine and anti-leak tests for GRIDIRON."""

from __future__ import annotations

import copy
import math
import random

import pytest

from games.gridiron.game import (
    DEFENSE_PLAYS,
    LIVE_TICKS,
    OFFENSE_PLAYS,
    TICK,
    GridironSession,
    _clamp,
)


TOKENS = tuple("secret-gridiron-%d" % index for index in range(1, 10))


def _start(seed=1, humans=2, possessions=6, assist=True):
    session = GridironSession(random.Random(seed))
    for index, token in enumerate(TOKENS[:humans]):
        player, _ = session.join(
            token, "Player %d" % (index + 1), "🦊")
        player.pfp = "/avatars/gridiron-%d.webp" % index
        session.set_ready(token, True)
    if humans:
        session.set_settings(
            TOKENS[0], {"possessions": possessions, "assist": assist})
        session.start(TOKENS[0])
        session.tick(session.gen)
    else:
        session.game_start()
    assert session.phase == "huddle"
    return session


def _human_for_team(session, team):
    return next(
        token for token in session.g["teams"][team]
        if not session.players[token].is_bot)


def _call_both(session, offense_play="power", defense_play="contain"):
    assert session.phase == "huddle"
    offense = session.g["possession_team"]
    defense = 1 - offense
    offense_token = _human_for_team(session, offense)
    defense_token = _human_for_team(session, defense)
    session.game_action(
        offense_token, {"t": "call_play", "play": offense_play})
    assert session.phase == "huddle"
    session.game_action(
        defense_token, {"t": "call_play", "play": defense_play})
    assert session.phase == "setup"
    return offense_token, defense_token


def _open_live(session, offense_play="power", defense_play="contain"):
    _call_both(session, offense_play, defense_play)
    session.tick(session.gen)
    assert session.phase == "live"
    return session


def _pid(session, token):
    return session.players[token].pid


@pytest.mark.parametrize("humans", range(1, 9))
def test_one_to_eight_humans_fill_two_balanced_four_player_teams(humans):
    session = _start(100 + humans, humans=humans)
    assert session.MIN_PLAYERS == 1
    assert session.MAX_HUMANS == 8
    assert len(session.participants) == 8
    assert [len(team) for team in session.g["teams"]] == [4, 4]
    assert sum(
        not session.players[token].is_bot
        for token in session.participants) == humans
    assert set(session.g["roles"].values()) == {
        "QB", "RB", "WR1", "WR2", "CB", "LB", "DL", "S",
    }


def test_settings_are_strict_default_to_six_and_roles_rotate_each_possession():
    session = GridironSession(random.Random(1))
    assert session.DEFAULT_SETTINGS == {"possessions": 6, "assist": True}
    assert session.validate_settings({
        "possessions": 8, "assist": False, "junk": "ignored",
    }) == {"possessions": 8, "assist": False}
    for bad in (None, [], {"possessions": True}, {"possessions": 2},
                {"possessions": 6.0}, {"assist": 1}, {"assist": "yes"}):
        assert session.validate_settings(bad) == {}

    session = _start(2, humans=2)
    token = session.g["teams"][0][0]
    first_role = session.g["roles"][token]
    session._start_possession()
    assert session.g["possession_no"] == 2
    assert session.g["roles"][token] != first_role


def test_huddle_masks_calls_from_opponents_and_tv_before_second_call():
    session = _start(9, humans=3)
    offense = session.g["possession_team"]
    caller = _human_for_team(session, offense)
    teammate = next(
        token for token in session.g["teams"][offense]
        if token != caller and not session.players[token].is_bot)
    opponent = _human_for_team(session, 1 - offense)

    session.game_action(caller, {"t": "call_play", "play": "power"})
    assert session.phase == "huddle"
    assert session.game_state(caller)["me"]["selected_play"] == "power"
    assert session.game_state(teammate)["me"]["selected_play"] == "power"
    assert session.game_state(opponent)["me"]["selected_play"] is None

    for viewer in (None, opponent, "unknown-spectator"):
        state = session.game_state(viewer)
        assert "power" not in repr(state["play_status"])
        assert all("play" not in row for row in state["play_status"])
        assert state["field"]["routes"] == []
    assert "me" not in session.game_state(None)
    assert session.game_state("unknown-spectator")["me"] is None

    session.game_action(opponent, {"t": "call_play", "play": "zone"})
    assert session.phase == "setup"
    tv = session.game_state(None)
    assert {row["play"] for row in tv["play_status"]} == {"power", "zone"}
    assert tv["field"]["routes"]


def test_every_view_is_pure_token_free_and_tv_safe_in_every_phase():
    session = _start(11, humans=3)

    def check():
        before = copy.deepcopy(session.g)
        for viewer in [None, "spectator"] + list(TOKENS[:3]):
            first = session.game_state(viewer)
            second = session.game_state(viewer)
            assert first == second
            assert first["stage"] == session.phase
            assert all(secret not in repr(first) for secret in TOKENS)
        assert session.g == before

    check()  # huddle
    _call_both(session, "slant", "press")
    check()  # setup
    session.tick(session.gen)
    check()  # live
    session.g["ball"]["x"] = session.g["yard"] + 4
    session._finish_play("tackle")
    check()  # whistle
    session.g["possession_no"] = session.g["max_possessions"]
    session.g["possession_done"] = True
    session.tick(session.gen)
    check()  # game_end


def test_huddle_setup_live_whistle_deadlines_and_early_lock_progress():
    session = _start(12, humans=2)
    huddle_gen = session.gen
    _call_both(session, "power", "contain")
    assert session.phase == "setup"
    assert session.gen > huddle_gen and session.deadline is not None
    setup_gen = session.gen
    session.tick(setup_gen)
    assert session.phase == "live"
    live_gen = session.gen
    old_tick = session.g["tick"]
    session.tick(live_gen)
    assert session.phase == "live"
    assert session.g["tick"] == old_tick + 1
    assert session.gen > live_gen and session.deadline is not None
    live_state = session.game_state(TOKENS[0])
    assert live_state["stage_left"] == pytest.approx(
        (LIVE_TICKS - session.g["tick"]) * TICK)
    assert live_state["live_ticks"] == LIVE_TICKS

    carrier = session.g["carrier"]
    session.game_action(carrier, {"t": "dive"})
    assert session.phase == "whistle"
    assert session.deadline is not None
    session.tick(session.gen)
    assert session.phase == "huddle"


def test_one_world_step_moves_defender_once_not_twice():
    session = _open_live(_start(13, humans=2), "power", "contain")
    carrier = session.g["carrier"]
    defender = session.g["nearest_defender"]
    cu = session.g["units"][carrier]
    du = session.g["units"][defender]
    du["steer"] = 0.0
    old_defender_x = du["x"]
    expected_carrier_x = cu["x"] + 3.2 * 0.05
    expected_dx = _clamp(
        (expected_carrier_x - old_defender_x) * 0.08, -0.28, 0.28)
    session._step_world()
    assert du["x"] == pytest.approx(old_defender_x + expected_dx)


def test_carrier_steer_is_clamped_and_dive_ends_server_authoritatively():
    session = _open_live(_start(14, humans=2), "power", "contain")
    carrier = session.g["carrier"]
    start = session.g["yard"]
    session.game_action(carrier, {"t": "steer", "x": 9.0})
    assert session.g["units"][carrier]["steer"] == 1.0
    session._step_world()
    before_dive = session.g["ball"]["x"]
    fx = session.game_action(carrier, {"t": "dive"})
    assert session.phase == "whistle"
    assert any(item["kind"] == "dive" for item in fx)
    assert session.g["last_play"]["end_yard"] == pytest.approx(
        round(before_dive - start + 2.0 + start, 1))
    assert session.g["stats"][carrier]["dives"] == 1


def _run_tackle_at(timing):
    session = _open_live(_start(20 + timing, humans=2), "power", "contain")
    defender = session.g["nearest_defender"]
    carrier = session.g["carrier"]
    window = session.g["tackle_window"]
    session.g["units"][defender]["y"] = session.g["units"][carrier]["y"]
    if timing == 0:
        session.g["tick"] = window["start"] - 1
    elif timing == 1:
        session.g["tick"] = (window["start"] + window["end"]) // 2
    else:
        session.g["tick"] = window["end"] + 1
    fx = session.game_action(defender, {"t": "tackle"})
    return session, fx


def test_tackle_timing_early_whiffs_window_stops_and_late_drags():
    early, fx = _run_tackle_at(0)
    assert early.phase == "live"
    assert early.g["whiff"] is True
    assert any(item.get("result") == "early" for item in fx)
    assert early.game_state(None)["windows"]["tackle"] is None
    assert early.game_state(
        early.g["nearest_defender"])["me"]["control"] == "watch"
    assert any(item["kind"] == "invalid" for item in early.game_action(
        early.g["nearest_defender"], {"t": "tackle"}))

    clean, fx = _run_tackle_at(1)
    assert clean.phase == "whistle"
    assert clean.g["last_play"]["outcome"] == "tackle"
    assert clean.game_state(None)["windows"]["tackle"] is None
    assert any(item.get("result") == "clean" for item in fx)

    late, fx = _run_tackle_at(2)
    assert late.phase == "whistle"
    assert late.g["last_play"]["outcome"] == "arm_tackle"
    assert late.g["last_play"]["yards"] >= 2.0
    assert any(item.get("result") == "late" for item in fx)


def _throw_to(session, receiver_role="WR1"):
    qb = session._token_for_role(session.g["possession_team"], "QB")
    receiver = session._token_for_role(
        session.g["possession_team"], receiver_role)
    spec = session.g["receivers"][receiver]
    session.g["tick"] = (spec["start"] + spec["end"]) // 2
    state = session.game_state(qb)
    assert _pid(session, receiver) in {
        row["pid"] for row in state["me"]["available_receivers"]}
    fx = session.game_action(
        qb, {"t": "throw", "target": _pid(session, receiver)})
    assert any(item["kind"] == "throw" for item in fx)
    assert session.g["mode"] == "air"
    return qb, receiver


def test_qb_throw_receiver_catch_window_and_post_catch_carrier_controls():
    session = _open_live(_start(31, humans=2), "slant", "zone")
    _, receiver = _throw_to(session)
    window = session.g["catch_window"]
    session.g["tick"] = (window["start"] + window["end"]) // 2
    fx = session.game_action(receiver, {"t": "catch"})
    assert any(item.get("result") == "caught" for item in fx)
    assert session.g["mode"] == "caught"
    assert session.g["carrier"] == receiver
    me = session.game_state(receiver)["me"]
    assert me["control"] == "carrier"
    assert me["controls"] == ["steer", "dive"]
    session.game_action(receiver, {"t": "dive"})
    assert session.phase == "whistle"
    assert session.g["last_play"]["receiver_pid"] == _pid(session, receiver)

    early = _open_live(_start(32, humans=2), "slant", "zone")
    _, receiver = _throw_to(early)
    early.g["tick"] = early.g["catch_window"]["start"] - 1
    early.game_action(receiver, {"t": "catch"})
    assert early.phase == "whistle"
    assert early.g["last_play"]["outcome"] == "incomplete_early"

    late = _open_live(_start(33, humans=2), "slant", "zone")
    _, receiver = _throw_to(late)
    late.g["tick"] = late.g["catch_window"]["end"] + 1
    late.game_action(receiver, {"t": "catch"})
    assert late.phase == "whistle"
    assert late.g["last_play"]["outcome"] == "incomplete_late"


def test_qb_may_commit_to_a_covered_receiver_without_deadlocking_controller():
    session = _open_live(_start(35, humans=2), "deep", "zone")
    qb = session._token_for_role(session.g["possession_team"], "QB")
    receiver = session._token_for_role(session.g["possession_team"], "WR2")
    session.g["tick"] = 1
    assert session.g["tick"] < session.g["receivers"][receiver]["start"]
    fx = session.game_action(
        qb, {"t": "throw", "target": _pid(session, receiver)})
    assert any(item["kind"] == "throw" for item in fx)
    assert session.g["mode"] == "air"


def test_qb_touch_scramble_switches_to_tilt_carrier():
    session = _open_live(_start(34, humans=2), "deep", "blitz")
    qb = session._token_for_role(session.g["possession_team"], "QB")
    fx = session.game_action(qb, {"t": "scramble"})
    assert any(item["kind"] == "scramble" for item in fx)
    assert session.g["mode"] == "scramble"
    assert session.game_state(qb)["me"]["control"] == "carrier"
    session.game_action(qb, {"t": "steer", "x": -0.75})
    assert session.g["units"][qb]["steer"] == -0.75


def test_strict_four_play_drive_flip_touchdown_and_regulation_result():
    first = _open_live(_start(40, humans=2), "power", "contain")
    first.g["ball"]["x"] = first.g["yard"] + 10.0
    first._finish_play("tackle")
    assert first.g["last_play"]["first_down"] is False
    assert first.g["down"] == 2
    assert first.g["yard"] == 60.0
    assert first.g["to_go"] == 40.0

    failed = _open_live(_start(41, humans=2), "power", "contain")
    failed.g["down"] = 4
    failed.g["to_go"] = 3.0
    failed.g["ball"]["x"] = failed.g["yard"] + 2.0
    failed._finish_play("tackle")
    assert failed.g["last_play"]["turnover"] is True
    assert failed.g["possession_done"] is True
    failed.tick(failed.gen)
    assert failed.g["possession_no"] == 2
    assert failed.g["possession_team"] == 1
    assert failed.g["yard"] == 50.0 and failed.g["down"] == 1

    touchdown = _open_live(_start(42, humans=2), "power", "contain")
    touchdown.g["ball"]["x"] = 100.0
    touchdown._finish_play("dive")
    assert touchdown.g["last_play"]["touchdown"] is True
    assert touchdown.g["scores"] == [6, 0]

    touchdown.g["possession_no"] = 6
    touchdown.g["max_possessions"] = 6
    touchdown.g["scores"] = [18, 12]
    touchdown.g["possession_done"] = True
    touchdown.tick(touchdown.gen)
    assert touchdown.phase == "game_end"
    result = touchdown.game_state(None)["result"]
    assert result["winner_team"] == 0
    assert result["tie"] is False
    assert result["possessions"] == 6
    assert set(result["winner_pids"]) == {
        _pid(touchdown, token) for token in touchdown.g["teams"][0]}


def test_disconnect_engages_autopilot_and_reconnect_restores_control():
    session = _open_live(_start(50, humans=4), "power", "contain")
    carrier = session.g["carrier"]
    assert not session.players[carrier].is_bot
    old_x = session.g["units"][carrier]["x"]
    fx = session.leave(carrier)
    assert session.players[carrier].connected is False
    assert session._is_auto(carrier) is True
    assert any(item["kind"] == "autopilot" for item in fx)
    session.tick(session.gen)
    assert session.g["units"][carrier]["x"] > old_x
    session.join(carrier, "Returned", "🦊")
    assert session.players[carrier].connected is True
    assert session._is_auto(carrier) is False


def test_bot_only_seeded_match_completes_six_possessions_deterministically():
    def run(seed):
        session = _start(seed, humans=0)
        for ticks in range(5000):
            if session.phase == "game_end":
                break
            session.tick(session.gen)
        assert session.phase == "game_end", (
            session.phase, session.g["possession_no"], ticks)
        assert session.g["possession_no"] == 6
        assert session.g["result"] is not None
        assert session.g["result"]["possessions"] == 6
        return (
            tuple(session.g["scores"]),
            copy.deepcopy(session.g["result"]),
            ticks,
        )

    assert run(77) == run(77)


def test_malformed_messages_never_raise_or_mutate_critical_state():
    session = _start(60, humans=2)
    token = TOKENS[0]
    bad_huddle = (
        None, [], "call",
        {}, {"t": []},
        {"t": "call_play", "play": []},
        {"t": "call_play", "play": {}},
        {"t": "call_play", "play": "fake"},
        {"t": "swap_role", "pid": []},
        {"t": "swap_role", "pid": {}},
        {"t": "swap_role", "pid": "not-a-pid"},
    )
    for message in bad_huddle:
        fx = session.game_action(token, message)
        assert any(item["kind"] == "invalid" for item in fx)
        assert session.phase == "huddle"

    _open_live(session, "slant", "zone")
    before = copy.deepcopy(session.g["play_calls"])
    bad_live = (
        {"t": "steer"}, {"t": "steer", "x": True},
        {"t": "steer", "x": math.nan},
        {"t": "steer", "x": math.inf},
        {"t": "steer", "x": []},
        {"t": "dive", "extra": 1},
        {"t": "tackle", "extra": 1},
        {"t": "catch", "extra": 1},
        {"t": "throw", "target": []},
        {"t": "throw", "target": {}},
        {"t": "scramble", "extra": 1},
        {"t": {"nested": "bad"}},
    )
    for message in bad_live:
        fx = session.game_action(token, message)
        assert isinstance(fx, list)
        assert all(isinstance(item, dict) for item in fx)
    assert session.g["play_calls"] == before
