"""Engine tests for THE FIFTH SIGNAL's asymmetric cooperative protocol."""

from __future__ import annotations

import copy
import random

import pytest

from games.fifthsignal import game as signal_game
from games.fifthsignal.game import DIFFICULTIES, FifthSignalSession
from games.fifthsignal.scenario import (
    CONTROL_KINDS,
    CRISIS_BANK,
    ROLE_IDS,
    assign_roles,
    generate_crisis,
)


TOKENS = (
    "secret-alpha-token",
    "secret-bravo-token",
    "secret-charlie-token",
    "secret-delta-token",
    "secret-echo-token",
    "secret-foxtrot-token",
)


def _start(seed=1, count=5, length="short", difficulty="standard"):
    session = FifthSignalSession(random.Random(seed))
    for index, token in enumerate(TOKENS[:count]):
        player, _ = session.join(token, "Crew %d" % (index + 1), "🦊")
        player.pfp = "/avatars/p%d.webp" % (index + 1)
        session.set_ready(token, True)
    session.set_settings(
        TOKENS[0], {"length": length, "difficulty": difficulty})
    session.start(TOKENS[0])
    session.tick(session.gen)
    assert session.phase == "briefing"
    return session


def _open_crisis(session):
    assert session.phase == "briefing"
    session.tick(session.gen)
    assert session.phase == "crisis"


def _relay_answers(session):
    """Collect the five answers using only legal private player payloads."""
    answers = {}
    for token in session.participants:
        private = session.game_state(token)["me"]
        for console in private["consoles"]:
            relay = console["relay"]
            assert relay["target_role"] not in answers
            answers[relay["target_role"]] = copy.deepcopy(relay["value"])
    assert set(answers) == set(ROLE_IDS)
    return answers


def _solve_crisis(session):
    answers = _relay_answers(session)
    for role_id in ROLE_IDS:
        owner = session.g["owners"][role_id]
        session.game_action(owner, {
            "t": "control", "role": role_id,
            "value": copy.deepcopy(answers[role_id]),
        })
    assert session.phase == "resolution"


def _wrong_value(task):
    spec = task["spec"]
    target = task["target"]
    if task["kind"] == "choice":
        return next(value for value in spec["options"] if value != target)
    if task["kind"] == "sequence":
        value = list(target)
        value[0] = next(key for key in spec["keys"] if key != value[0])
        return value
    if task["kind"] == "dial":
        return (target + spec["step"]
                if target + spec["step"] <= spec["max"] else spec["min"])
    if task["kind"] == "switches":
        value = list(target)
        value[0] = not value[0]
        return value
    if task["kind"] == "balance":
        value = dict(target)
        value["x"] = (value["x"] + spec["step"]
                      if value["x"] + spec["step"] <= spec["max"]
                      else spec["min"])
        return value
    raise AssertionError("unknown task")


def _fail_crisis(session):
    scenario = session.g["scenario"]
    for role_id in ROLE_IDS:
        session.game_action(session.g["owners"][role_id], {
            "t": "control",
            "role": role_id,
            "value": _wrong_value(scenario["tasks"][role_id]),
        })
    assert session.phase == "resolution"


def _advance_to_final(session, solve=True):
    while session.phase != "final_sync":
        if session.phase == "briefing":
            _open_crisis(session)
        elif session.phase == "crisis":
            (_solve_crisis if solve else _fail_crisis)(session)
        elif session.phase == "resolution":
            session.tick(session.gen)
        else:
            raise AssertionError("unexpected phase %s" % session.phase)


def _synchronize(session):
    for token in session.participants:
        session.game_action(token, {"t": "sync", "down": True})
    assert session.phase == "final_sync"
    assert session.g["final"]["hold_started"] is not None
    session.tick(session.gen)
    assert session.phase == "game_end"


def _visible_answers(session):
    """Answers currently recoverable from connected phones, including failover."""
    visible = {}
    for token in session.participants:
        player = session.players[token]
        if not player.connected:
            continue
        me = session.game_state(token)["me"]
        relays = [console["relay"] for console in me["consoles"]]
        relays.extend(me["backup_relays"])
        for relay in relays:
            visible.setdefault(relay["target_role"], []).append(relay["value"])
    return visible


def test_player_limits_settings_and_large_modular_bank():
    assert FifthSignalSession.MIN_PLAYERS == 3
    assert FifthSignalSession.MAX_HUMANS == 5
    assert FifthSignalSession.DEFAULT_SETTINGS["length"] == "full"
    assert len(CRISIS_BANK) >= 20

    session = FifthSignalSession(random.Random(1))
    assert session.validate_settings({
        "length": "full", "difficulty": "expert", "junk": "ignored",
    }) == {"length": "full", "difficulty": "expert"}
    assert session.validate_settings({
        "length": True, "difficulty": "nightmare",
    }) == {}

    for token in TOKENS[:2]:
        session.join(token, token, None)
        session.set_ready(token, True)
    assert any(
        fx["kind"] == "invalid" for fx in session.start(TOKENS[0]))

    for token in TOKENS[2:5]:
        session.join(token, token, None)
    player, fx = session.join(TOKENS[5], "Sixth", None)
    assert player is None
    assert any("full" in item.get("msg", "").lower() for item in fx)


@pytest.mark.parametrize(
    "count,expected_loads",
    ((3, [1, 2, 2]), (4, [1, 1, 1, 2]), (5, [1, 1, 1, 1, 1])),
)
def test_three_four_five_player_role_fusion_is_balanced_and_cross_human(
        count, expected_loads):
    for seed in range(12):
        rng = random.Random(seed)
        owners, relays = assign_roles(TOKENS[:count], rng)
        loads = [
            sum(owner == token for owner in owners.values())
            for token in TOKENS[:count]
        ]
        assert sorted(loads) == expected_loads
        assert set(owners) == set(ROLE_IDS)
        assert set(relays) == set(ROLE_IDS)
        assert set(relays.values()) == set(ROLE_IDS)
        assert all(owners[holder] != owners[target]
                   for holder, target in relays.items())


def test_every_crisis_has_all_five_distinct_controls_and_cross_role_relays():
    session = _start(7, 3)
    _open_crisis(session)
    tasks = session.g["scenario"]["tasks"]
    assert set(tasks) == set(ROLE_IDS)
    assert {task["kind"] for task in tasks.values()} == set(CONTROL_KINDS)

    relays = []
    for token in session.participants:
        for console in session.game_state(token)["me"]["consoles"]:
            relays.append((console["role"], console["relay"]))
    assert len(relays) == 5
    assert {relay["target_role"] for _, relay in relays} == set(ROLE_IDS)
    for holder_role, relay in relays:
        assert session.g["owners"][holder_role] != session.g["owners"][
            relay["target_role"]]
        assert {"target_role", "target_title", "target_icon", "target_pid",
                "target_name", "text", "value"} <= set(relay)


@pytest.mark.parametrize("count", (3, 4, 5))
@pytest.mark.parametrize("drop_count", (1, 2))
def test_backup_relays_keep_every_unresolved_connected_role_solvable(
        count, drop_count):
    for seed in range(8):
        session = _start(700 + count * 20 + drop_count * 3 + seed, count)
        _open_crisis(session)
        dropped = list(session.participants[:drop_count])
        for token in dropped:
            session.leave(token)

        visible = _visible_answers(session)
        unresolved = [
            role_id for role_id in ROLE_IDS
            if role_id not in session.g["inputs"]
            and session.players[session.g["owners"][role_id]].connected
        ]
        assert unresolved
        for role_id in unresolved:
            assert role_id in visible
            assert session.g["scenario"]["tasks"][role_id]["target"] in visible[
                role_id]

        tv = session.game_state(None)
        spectator = session.game_state("spectator-secret")
        assert tv["me"] is None and spectator["me"] is None
        assert "backup_relays" not in repr(tv)
        assert "backup_relays" not in repr(spectator)

        # Assignment is derived, not sticky: each returning holder immediately
        # takes its original relay back. Once all return no backup remains.
        for token in reversed(dropped):
            session.join(token, "Returned", None)
        assert all(
            not session.game_state(token)["me"]["backup_relays"]
            for token in session.participants)


@pytest.mark.parametrize("count", (3, 4, 5))
def test_relay_puzzle_is_solvable_from_private_payloads_across_seed_fuzz(count):
    for seed in range(18):
        session = _start(1000 + seed, count)
        _open_crisis(session)
        _solve_crisis(session)
        assert session.g["resolution"]["stabilized"] == 5
        assert session.g["resolution"]["cleared"] is True


def test_generation_is_deterministic_and_rejects_recent_signatures():
    first_rng = random.Random(91)
    second_rng = random.Random(91)
    first, second = [], []
    for _ in range(25):
        a = generate_crisis(first_rng, "expert", recent=first[-20:])
        b = generate_crisis(second_rng, "expert", recent=second[-20:])
        first.append(a["signature"])
        second.append(b["signature"])
        assert a == b
    assert first == second
    assert len(first) == len(set(first))

    session = _start(123, 5)
    signatures = []
    for _ in range(3):
        signatures.append(session.g["scenario"]["signature"])
        _open_crisis(session)
        _solve_crisis(session)
        session.tick(session.gen)
    assert session.phase == "final_sync"
    assert len(signatures) == len(set(signatures))


def test_story_frame_cooldown_survives_rematches_and_stays_bounded():
    session = _start(127, 5, length="full")

    def finish_and_collect():
        frames = []
        while session.phase != "final_sync":
            if session.phase == "briefing":
                frames.append(session.g["scenario"]["frame"]["id"])
                _open_crisis(session)
            elif session.phase == "crisis":
                _solve_crisis(session)
            elif session.phase == "resolution":
                session.tick(session.gen)
        _synchronize(session)
        return frames

    missions = []
    for mission in range(3):
        missions.append(finish_and_collect())
        assert len(missions[-1]) == len(set(missions[-1])) == 5
        if mission < 2:
            session.to_lobby()
            for token in TOKENS[:5]:
                session.set_ready(token, True)
            session.start(TOKENS[0])
            session.tick(session.gen)
            assert session.phase == "briefing"

    assert set(missions[0]).isdisjoint(missions[1])
    assert set(missions[1]).isdisjoint(missions[2])
    assert len(session.recent_frames) == 12
    assert len(set(session.recent_frames)) == 12


def test_full_mission_never_repeats_frame_or_role_control_consecutively():
    session = _start(124, 5, length="full")
    frames = set()
    previous_kinds = {}
    for _ in range(5):
        scenario = session.g["scenario"]
        frame_id = scenario["frame"]["id"]
        assert frame_id not in frames
        frames.add(frame_id)
        kinds = {
            role_id: scenario["tasks"][role_id]["kind"]
            for role_id in ROLE_IDS
        }
        assert all(kinds[role_id] != previous_kinds.get(role_id)
                   for role_id in ROLE_IDS)
        previous_kinds = kinds
        _open_crisis(session)
        _solve_crisis(session)
        session.tick(session.gen)
    assert session.phase == "final_sync"
    assert len(frames) == 5


@pytest.mark.parametrize(
    "count,expected_seconds", ((3, 66.0), (4, 60.5), (5, 55.0)))
def test_fused_crews_receive_explicit_crisis_time_scaling(
        monkeypatch, count, expected_seconds):
    monkeypatch.setattr(signal_game.time, "time", lambda: 1000.0)
    session = _start(125, count, difficulty="standard")
    _open_crisis(session)
    assert session.deadline == pytest.approx(1000.0 + expected_seconds)


def test_tv_and_other_players_never_receive_targets_solutions_or_tokens():
    session = _start(44, 5)
    _open_crisis(session)

    tv = session.game_state(None)
    assert tv["me"] is None
    assert "'target':" not in repr(tv).lower()
    assert "'solution':" not in repr(tv).lower()
    assert all(token not in repr(tv) for token in TOKENS)

    # Every target role occurs in exactly one player's private relay.  The
    # target's owner is explicitly not that relay holder.
    for target_role in ROLE_IDS:
        viewers = []
        for token in session.participants:
            state = session.game_state(token)
            assert all(secret not in repr(state) for secret in TOKENS)
            if any(console["relay"]["target_role"] == target_role
                   for console in state["me"]["consoles"]):
                viewers.append(token)
        assert len(viewers) == 1
        assert viewers[0] != session.g["owners"][target_role]

    # A spectator gets no role bundle at all.
    assert session.game_state("spectator-secret")["me"] is None
    assert "spectator-secret" not in repr(
        session.game_state("spectator-secret"))


def test_control_validation_is_strict_and_wrong_values_resolve_without_leaks():
    session = _start(8, 5)
    owner = session.participants[0]
    assert any(fx["kind"] == "invalid" for fx in session.game_action(
        owner, {"t": "control", "role": "helm", "value": 1}))
    _open_crisis(session)

    role_id = session.g["roles_by_token"][owner][0]
    task = session.g["scenario"]["tasks"][role_id]
    before = copy.deepcopy(session.g["inputs"])
    malformed = (
        None,
        {},
        {"t": "control", "role": role_id},
        {"t": "control", "role": role_id, "value": task["target"], "extra": 1},
        {"t": "control", "role": "bogus", "value": 1},
        {"t": "sync", "down": 1},
    )
    for message in malformed:
        assert any(fx["kind"] == "invalid"
                   for fx in session.game_action(owner, message))
        assert session.g["inputs"] == before

    other_role = next(role for role in ROLE_IDS
                      if session.g["owners"][role] != owner)
    assert any(fx["kind"] == "invalid" for fx in session.game_action(owner, {
        "t": "control", "role": other_role,
        "value": copy.deepcopy(
            session.g["scenario"]["tasks"][other_role]["target"]),
    }))

    _fail_crisis(session)
    resolution = session.game_state(None)["resolution"]
    assert resolution["stabilized"] == 0
    assert all(item["stable"] is False for item in resolution["systems"])
    assert "target" not in repr(resolution).lower()
    assert all(token not in repr(resolution) for token in TOKENS)


@pytest.mark.parametrize("kind", CONTROL_KINDS)
def test_each_control_kind_rejects_malformed_values(kind):
    session = None
    role_id = None
    task = None
    # Every crisis has the kind exactly once, so one seed is enough; locating
    # it by kind keeps the test independent of role permutation.
    session = _start(300, 5)
    _open_crisis(session)
    role_id, task = next(
        (role, item) for role, item in session.g["scenario"]["tasks"].items()
        if item["kind"] == kind)
    owner = session.g["owners"][role_id]
    bad = {
        "choice": 0,
        "sequence": "A,B,C",
        "dial": True,
        "switches": [1] * len(task["spec"].get("labels", [])),
        "balance": {"x": 0, "y": 0, "z": 0},
    }[kind]
    fx = session.game_action(
        owner, {"t": "control", "role": role_id, "value": bad})
    assert any(item["kind"] == "invalid" for item in fx)
    assert role_id not in session.g["inputs"]


def test_timeout_advances_and_disconnect_reconnect_autopilot_cannot_freeze():
    session = _start(14, 3)
    _open_crisis(session)
    disconnected = session.participants[0]
    owned = set(session.g["roles_by_token"][disconnected])
    fx = session.leave(disconnected)
    assert owned <= session.g["autopilot_roles"]
    assert owned <= set(session.g["inputs"])
    assert any(item["kind"] == "autopilot" for item in fx)

    session.join(disconnected, "Returned", None)
    private = session.game_state(disconnected)["me"]
    assert all(console["autopilot"] for console in private["consoles"])
    role_id = next(iter(owned))
    assert any(item["kind"] == "invalid" for item in session.game_action(
        disconnected, {
            "t": "control", "role": role_id,
            "value": session.g["scenario"]["tasks"][role_id]["target"],
        }))

    # Unanswered connected consoles time out as unsuccessful; resolution still
    # has its own deadline and the next briefing starts normally.
    session.tick(session.gen)
    assert session.phase == "resolution"
    assert session.g["resolution"]["timed_out"] is True
    session.tick(session.gen)
    assert session.phase == "briefing" and session.g["round"] == 2


def test_public_progress_reports_each_system_without_private_values():
    session = _start(51, 5)
    _open_crisis(session)
    tv = session.game_state(None)
    systems = tv["progress"]["systems"]
    assert [item["role"] for item in systems] == list(ROLE_IDS)
    assert all(item == {
        "role": item["role"], "ready": False, "autopilot": False,
    } for item in systems)

    manual_role = ROLE_IDS[0]
    task = session.g["scenario"]["tasks"][manual_role]
    session.game_action(session.g["owners"][manual_role], {
        "t": "control", "role": manual_role,
        "value": _wrong_value(task),
    })
    auto_role = ROLE_IDS[1]
    session.leave(session.g["owners"][auto_role])
    systems = {
        item["role"]: item
        for item in session.game_state(None)["progress"]["systems"]
    }
    assert systems[manual_role] == {
        "role": manual_role, "ready": True, "autopilot": False}
    assert systems[auto_role] == {
        "role": auto_role, "ready": True, "autopilot": True}
    public = repr(session.game_state(None))
    assert "'value':" not in public and "'target':" not in public


def test_short_and_full_lengths_follow_all_required_phases():
    for length, rounds in (("short", 3), ("full", 5)):
        session = _start(61, 4, length=length)
        seen = []
        for number in range(1, rounds + 1):
            assert session.phase == "briefing"
            seen.append(session.phase)
            assert session.g["round"] == number
            _open_crisis(session)
            seen.append(session.phase)
            _solve_crisis(session)
            seen.append(session.phase)
            session.tick(session.gen)
        assert session.phase == "final_sync"
        seen.append(session.phase)
        _synchronize(session)
        seen.append(session.phase)
        assert seen == (
            ["briefing", "crisis", "resolution"] * rounds
            + ["final_sync", "game_end"])


def test_final_requires_one_continuous_synchronized_hold_and_stale_tick_is_safe():
    session = _start(71, 3)
    _advance_to_final(session)
    for token in session.participants:
        session.game_action(token, {"t": "sync", "down": True})
    armed_gen = session.gen
    released = session.participants[0]
    session.game_action(released, {"t": "sync", "down": False})
    assert session.g["final"]["hold_started"] is None
    assert session.tick(armed_gen) == []
    assert session.phase == "final_sync"
    session.game_action(released, {"t": "sync", "down": True})
    session.tick(session.gen)
    assert session.phase == "game_end"
    assert session.g["result"]["sync_complete"] is True


def test_win_and_loss_results_are_cooperative_personalized_and_profile_aware():
    win = _start(81, 5, difficulty="standard")
    _advance_to_final(win, solve=True)
    _synchronize(win)
    result = win.game_state(None)["result"]
    assert result["won"] is True
    assert result["sync_complete"] is True
    assert result["crises_cleared"] == 3
    assert len(result["crew"]) == 5
    assert all(row["pfp"].startswith("/avatars/") for row in result["crew"])
    assert all(row["roles"] and row["commendation"] for row in result["crew"])
    assert len({row["commendation"] for row in result["crew"]}) == 5
    assert "rank" not in repr(result).lower()
    assert "failures" not in repr(result).lower()
    assert all(token not in repr(result) for token in TOKENS)

    assert DIFFICULTIES["expert"]["integrity_short"] == 2
    assert DIFFICULTIES["expert"]["integrity_full"] == 3
    loss = _start(82, 3, length="short", difficulty="expert")
    for expected_round in (1, 2):
        _open_crisis(loss)
        _fail_crisis(loss)
        assert loss.phase == "resolution"
        loss.tick(loss.gen)
        if expected_round == 1:
            assert loss.phase == "briefing"
    assert loss.phase == "game_end"
    assert loss.g["round"] == 2
    assert loss.g["final"] is None
    result = loss.game_state(None)["result"]
    assert result["won"] is False
    assert result["sync_complete"] is False
    assert result["destroyed"] is True
    assert result["integrity"] == 0
    assert len(result["crew"]) == 3
    assert any("DUAL ACE" in row["commendation"] for row in result["crew"])


def test_final_timeout_and_disconnect_use_safe_cooperative_fallbacks():
    session = _start(91, 3)
    _advance_to_final(session)
    dropped = session.participants[0]
    session.leave(dropped)
    assert dropped in session.g["final"]["held"]
    for token in session.participants[1:]:
        session.game_action(token, {"t": "sync", "down": True})
    session.tick(session.gen)
    assert session.phase == "game_end"
    assert session.g["result"]["sync_complete"] is True

    timed_out = _start(92, 3)
    _advance_to_final(timed_out)
    timed_out.tick(timed_out.gen)
    assert timed_out.phase == "game_end"
    assert timed_out.g["result"]["won"] is False
    assert timed_out.g["result"]["sync_complete"] is False


def test_game_state_is_pure_and_safe_for_tv_player_and_spectator_in_every_phase():
    session = _start(111, 3)

    def check():
        before = copy.deepcopy(session.g)
        viewers = [None] + list(session.participants)
        for viewer in viewers:
            first = session.game_state(viewer)
            second = session.game_state(viewer)
            assert first == second
            assert first["stage"] == session.phase
            assert all(token not in repr(first) for token in TOKENS)
        assert session.g == before

    check()                              # briefing
    _open_crisis(session)
    check()                              # crisis
    _solve_crisis(session)
    check()                              # resolution
    while session.g["round"] < session.g["rounds"]:
        session.tick(session.gen)
        check()                          # briefing
        _open_crisis(session)
        check()                          # crisis
        _solve_crisis(session)
        check()                          # resolution
    session.tick(session.gen)
    check()                              # final_sync
    _synchronize(session)
    check()                              # game_end
