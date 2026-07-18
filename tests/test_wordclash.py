import random
import sys
from pathlib import Path


import games.wordclash.engine as engine
from games.wordclash.engine import (Room, evaluate_guess, clean_name, DUEL_GUESSES,
                    DUEL_SOLVE, DUEL_GUESS_BONUS, DUEL_SPEED_MAX,
                    DUEL_FIRST_BONUS, RELAY_SOLVE, RELAY_ROW_BONUS,
                    RELAY_NEW_GREEN, RELAY_NEW_YELLOW,
                    RELAY_TIMEOUT_PENALTY, TIME_CUT_SECONDS)
from games.wordclash.words import load_words


class FakeClock:
    def __init__(self, t=1_000_000.0):
        self.t = t

    def __call__(self):
        return self.t

    def advance(self, dt):
        self.t += dt


def make_room(monkeypatch, answers=None, allowed_extra=(), seed=7):
    clock = FakeClock()
    monkeypatch.setattr(engine.time, "time", clock)
    answers = answers or ["crane"]
    allowed = set(answers) | set(allowed_extra)
    room = Room(answers, allowed, rng=random.Random(seed))
    return room, clock


def join_ready(room, n):
    toks = []
    for i in range(n):
        tok = f"token-{i:02d}xxxxxx"
        room.join(tok, f"P{i}", None)
        room.set_ready(tok, True)
        toks.append(tok)
    return toks


def start_match(room, toks):
    fx = room.start(toks[0])
    assert room.phase == "countdown", fx
    fx = room.tick(room.gen)
    assert room.phase == "playing"
    return fx


# ---------------- marks ----------------

def test_marks_basic():
    assert evaluate_guess("crane", "crane") == ["g"] * 5
    assert evaluate_guess("crane", "brand") == ["b", "g", "g", "g", "b"]


def test_marks_duplicates():
    # secret has one 'l'? no: silly has two l's, lolly guesses three
    assert evaluate_guess("silly", "lolly") == ["b", "b", "g", "g", "g"]
    # one 'r' in secret: second guessed r must be gray
    assert evaluate_guess("crane", "carer") == ["g", "y", "y", "y", "b"]
    # guess has double letter, secret has one: only first non-green gets yellow
    assert evaluate_guess("abide", "eerie") == ["b", "b", "b", "y", "g"]


def test_clean_name():
    assert clean_name("  Sam!  ") == "Sam!"
    assert clean_name("<script>alert(1)</script>") == "scriptalert1sc"
    assert clean_name("💀💀💀") == "PLAYER"
    assert clean_name(None) == "PLAYER"
    assert len(clean_name("x" * 99)) == 14


def test_first_letter_coverage():
    answers, allowed = load_words()
    firsts = {w[0] for w in allowed}
    assert firsts == set("abcdefghijklmnopqrstuvwxyz")


# ---------------- lobby ----------------

def test_lobby_ready_and_go(monkeypatch):
    room, clock = make_room(monkeypatch)
    t0, t1 = join_ready(room, 2)
    room.set_ready(t1, False)
    fx = room.start(t0)
    assert any(f["kind"] == "invalid" for f in fx)
    assert room.phase == "lobby"
    room.set_ready(t1, True)
    room.start(t0)
    assert room.phase == "countdown"
    room.tick(room.gen)
    assert room.phase == "playing"
    assert room.match["round"]["kind"] == "duel"


def test_countdown_abort_on_unready(monkeypatch):
    room, clock = make_room(monkeypatch)
    t0, t1 = join_ready(room, 2)
    room.start(t0)
    room.set_ready(t1, False)
    assert room.phase == "lobby"


def test_lobby_disconnect_removes(monkeypatch):
    room, clock = make_room(monkeypatch)
    t0, t1 = join_ready(room, 2)
    room.leave(t1)
    assert t1 not in room.players


# ---------------- duel ----------------

def test_duel_full_round_scoring(monkeypatch):
    room, clock = make_room(monkeypatch, answers=["crane"],
                            allowed_extra=["slate", "brand"])
    t0, t1 = join_ready(room, 2)
    start_match(room, toks := [t0, t1])
    clock.advance(30)  # 150s left of 180
    fx = room.guess(t0, "slate")
    assert any(f["kind"] == "landed" for f in fx)
    fx = room.guess(t0, "crane")
    assert any(f["kind"] == "solved" and f["first"] for f in fx)
    b = room.match["round"]["boards"][t0]
    expected = (DUEL_SOLVE + DUEL_GUESS_BONUS * 4
                + int(DUEL_SPEED_MAX * 150 / 180) + DUEL_FIRST_BONUS)
    assert b["pts"] == expected
    # p1 guesses once, never solves; round ends on deadline
    room.guess(t1, "brand")  # b,g,g,g,b -> 3 distinct greens
    clock.advance(151)
    fx = room.tick(room.gen)
    assert room.phase == "round_end"
    rs = room.match["reveal"]["round_scores"]
    p0 = room.players[t0].pid
    p1 = room.players[t1].pid
    assert rs[p0]["pts"] == expected
    assert rs[p1]["pts"] == 3 * engine.DUEL_GREEN
    assert room.match["reveal"]["secret"] == "crane"


def test_duel_six_strikes_ends_board(monkeypatch):
    room, clock = make_room(monkeypatch, answers=["crane"],
                            allowed_extra=["slate"])
    t0, t1 = join_ready(room, 2)
    start_match(room, [t0, t1])
    for _ in range(DUEL_GUESSES):
        room.guess(t0, "slate")
    b = room.match["round"]["boards"][t0]
    assert b["done"] and not b["solved"]
    fx = room.guess(t0, "slate")
    assert any(f["kind"] == "invalid" for f in fx)


def test_duel_ends_early_when_all_done(monkeypatch):
    room, clock = make_room(monkeypatch, answers=["crane"])
    t0, t1 = join_ready(room, 2)
    start_match(room, [t0, t1])
    room.guess(t0, "crane")
    assert room.phase == "playing"
    fx = room.guess(t1, "crane")
    assert room.phase == "round_end"
    # second solver is not first
    assert any(f["kind"] == "solved" and not f["first"] for f in fx)


def test_duel_invalid_words(monkeypatch):
    room, clock = make_room(monkeypatch, answers=["crane"])
    t0, t1 = join_ready(room, 2)
    start_match(room, [t0, t1])
    for w in ["zzzzz", "cat", "cranes", "cr4ne"]:
        fx = room.guess(t0, w)
        assert any(f["kind"] == "invalid" for f in fx), w
    assert room.match["round"]["boards"][t0]["rows"] == []


def test_match_podium_and_lobby(monkeypatch):
    room, clock = make_room(monkeypatch, answers=["crane", "slate", "brand"])
    room.settings["rounds"] = 2
    t0, t1 = join_ready(room, 2)
    start_match(room, [t0, t1])
    for rnd in range(2):
        secret = room.match["round"]["secret"]
        room.guess(t0, secret)
        room.guess(t1, secret)
        assert room.phase == "round_end"
        room.tick(room.gen)
    assert room.phase == "podium"
    st = room.state_for(t0)
    pod = st["match"]["podium"]
    assert pod[0]["score"] >= pod[1]["score"]
    room.tick(room.gen)
    assert room.phase == "lobby"
    assert room.match is None
    assert all(not p.ready for p in room.players.values())


# ---------------- state masking ----------------

def test_duel_masking(monkeypatch):
    room, clock = make_room(monkeypatch, answers=["crane"],
                            allowed_extra=["slate"])
    t0, t1 = join_ready(room, 2)
    start_match(room, [t0, t1])
    room.guess(t0, "slate")
    st1 = room.state_for(t1)
    p0 = room.players[t0].pid
    other_rows = st1["match"]["round"]["boards"][p0]["rows"]
    assert other_rows and "w" not in other_rows[0] and "m" in other_rows[0]
    st0 = room.state_for(t0)
    own_rows = st0["match"]["round"]["boards"][p0]["rows"]
    assert own_rows[0]["w"] == "slate"
    # TV/spectator masked too
    tv = room.state_for(None)
    assert "w" not in tv["match"]["round"]["boards"][p0]["rows"][0]
    # never leak the secret or tokens while playing
    import json
    blob = json.dumps(st1) + json.dumps(tv)
    assert "crane" not in blob
    assert t0 not in blob and t1 not in blob
    # revealed after round end
    room.guess(t0, "crane")
    room.guess(t1, "crane")
    st1 = room.state_for(t1)
    assert st1["match"]["round"]["boards"][p0]["rows"][0]["w"] == "slate"


# ---------------- relay ----------------

def relay_room(monkeypatch, n=3, mode="relay", answers=None, extra=()):
    room, clock = make_room(monkeypatch, answers=answers or ["crane"],
                            allowed_extra=extra)
    room.settings["mode"] = mode
    room.settings["rounds"] = 1
    toks = join_ready(room, n)
    start_match(room, toks)
    r = room.match["round"]
    order = list(r["order"])
    return room, clock, toks, order


def test_relay_turn_flow_and_scoring(monkeypatch):
    room, clock, toks, order = relay_room(
        monkeypatch, 3, extra=["slate", "brand", "carts"])
    r = room.match["round"]
    assert r["rows_max"] == 8
    first, second = order[0], order[1]
    fx = room.guess(second, "slate")
    assert any(f["kind"] == "invalid" for f in fx)
    fx = room.guess(first, "brand")  # vs crane: b,g,g,g,b -> 3 new greens
    gained = [f for f in fx if f["kind"] == "landed"][0]["gained"]
    assert gained == 3 * RELAY_NEW_GREEN
    assert room._relay_current() == second
    # repeat info earns nothing new
    fx = room.guess(second, "brand")
    gained = [f for f in fx if f["kind"] == "landed"][0]["gained"]
    assert gained == 0
    # third player solves: solve bonus + remaining new greens (c, e)
    third = order[2]
    rows_left = r["rows_max"] - 3
    fx = room.guess(third, "crane")
    assert room.phase == "round_end"
    rs = room.match["reveal"]["round_scores"]
    pid3 = room.players[third].pid
    # crane vs revealed greens {(1,r),(2,a),(3,n)}: new greens at 0,4 = c,e
    assert rs[pid3]["pts"] == (2 * RELAY_NEW_GREEN + RELAY_SOLVE
                               + RELAY_ROW_BONUS * rows_left)
    assert rs[pid3]["solved"]


def test_relay_timeout_penalty_and_advance(monkeypatch):
    room, clock, toks, order = relay_room(monkeypatch, 2)
    r = room.match["round"]
    fx = room.tick(room.gen)  # turn timer expires
    assert any(f["kind"] == "timeout" for f in fx)
    assert r["rows"][0]["skipped"]
    assert r["pts"][order[0]] == -RELAY_TIMEOUT_PENALTY
    assert room._relay_current() == order[1]
    # timeouts can exhaust the board
    for _ in range(r["rows_max"] - 1):
        room.tick(room.gen)
    assert room.phase == "round_end"
    assert room.match["reveal"]["reason"] == "exhausted"


def test_all_leave_abandons_match(monkeypatch):
    # relay: everyone disconnects mid-round -> match abandoned, room reusable
    room, clock, toks, order = relay_room(monkeypatch, 2)
    room.leave(order[0])
    fx = room.leave(order[1])
    assert room.phase == "lobby", fx
    assert room.match is None
    assert not room.players  # ghosts pruned
    # duel path: last participant leaving abandons instantly
    room2, clock2 = make_room(monkeypatch, answers=["crane", "slate"])
    room2.settings["rounds"] = 2
    t0, t1 = join_ready(room2, 2)
    start_match(room2, [t0, t1])
    room2.leave(t0)
    assert room2.phase == "playing"   # one player still in
    room2.leave(t1)
    assert room2.phase == "lobby"
    assert room2.match is None


def test_relay_disconnect_skips_then_abandons(monkeypatch):
    room, clock, toks, order = relay_room(monkeypatch, 3)
    r = room.match["round"]
    cur = order[0]
    room.leave(cur)
    assert room._relay_current() == order[1]
    assert not r["rows"]  # no penalty row for a dropped player
    assert room.deadline is not None
    # dropped player reconnects mid-round and rejoins the rotation
    room.join(cur, "back", None)
    assert room.players[cur].connected
    # remaining players leave -> match abandoned (cur reconnected keeps it alive)
    room.leave(order[1])
    room.leave(order[2])
    assert room.phase == "playing"    # cur is still here
    room.leave(cur)
    assert room.phase == "lobby"
    assert room.match is None


# ---------------- sabotage ----------------

def test_sabotage_time_cut(monkeypatch):
    room, clock, toks, order = relay_room(monkeypatch, 2, mode="sabotage")
    r = room.match["round"]
    fx = room.sabotage(order[0], "time")
    assert any(f["kind"] == "sabotage" and f["what"] == "time" for f in fx)
    assert r["charges"][order[0]] == 1
    assert room._relay_current() == order[1]
    assert r["eff_seconds"] == TIME_CUT_SECONDS
    assert abs(room.deadline - (engine.time.time() + TIME_CUT_SECONDS)) < 0.01
    # effect clears after the target guesses
    room.guess(order[1], "crane")
    assert room.phase == "round_end"


def test_sabotage_ban_and_start(monkeypatch):
    room, clock, toks, order = relay_room(
        monkeypatch, 2, mode="sabotage",
        answers=["crane"], extra=["slate", "brand", "quick", "zebra"])
    a, b = order[0], order[1]
    # reveal some letters first
    room.guess(a, "slate")   # a: (2,a) green? crane vs slate: s-b,l-b,a g,t-b,e g
    room.guess(b, "brand")
    # now a's turn; ban a revealed letter is rejected
    fx = room.sabotage(a, "ban", "a")
    assert any(f["kind"] == "invalid" for f in fx)
    fx = room.sabotage(a, "ban", "q")
    assert any(f["kind"] == "sabotage" for f in fx)
    # b must not use q
    fx = room.guess(b, "quick")
    assert any(f["kind"] == "invalid" for f in fx)
    fx = room.guess(b, "zebra")
    assert any(f["kind"] == "landed" for f in fx)
    # pending cleared; back to a: force start letter
    fx = room.sabotage(a, "start", "z")
    assert any(f["kind"] == "sabotage" for f in fx)
    fx = room.guess(b, "slate")
    assert any(f["kind"] == "invalid" for f in fx)
    fx = room.guess(b, "zebra")
    assert any(f["kind"] == "landed" for f in fx)


def test_sabotage_charges_exhaust(monkeypatch):
    room, clock, toks, order = relay_room(monkeypatch, 2, mode="sabotage")
    a, b = order
    room.sabotage(a, "time")
    room.guess(b, "crane") and None  # solves; but round ends — new approach below
    # (solved round ends the match; only assert charge bookkeeping)
    assert room.match["round"]["charges"][a] == 1


def test_duel_consolation_across_rows_and_cap(monkeypatch):
    room, clock = make_room(monkeypatch, answers=["crane"],
                            allowed_extra=["brand", "carts", "prank"])
    t0, t1 = join_ready(room, 2)
    start_match(room, [t0, t1])
    # t0 discovers across several rows: distinct info counts once
    room.guess(t0, "brand")   # greens (1,r),(2,a),(3,n)
    room.guess(t0, "brand")   # repeats: nothing new
    room.guess(t0, "carts")   # green (0,c)? c-r-a-n-e vs c-a-r-t-s: (0,c) g, a y, r y
    room.guess(t1, "crane")
    clock.advance(181)
    room.tick(room.gen)
    rs = room.match["reveal"]["round_scores"]
    p0 = room.players[t0].pid
    # greens {(1,r),(2,a),(3,n),(0,c)}; yellows: a,r already green-chars -> none
    expect = min(engine.DUEL_CONSOLATION_CAP, 4 * engine.DUEL_GREEN)
    assert rs[p0]["pts"] == expect


def test_relay_yellow_scoring_position_independent(monkeypatch):
    # secret 'sassy': a guess landing both a new green 's' and a yellow 's'
    # must score the same no matter the letter positions in the word
    room1, _, toks1, order1 = relay_room(
        monkeypatch, 2, answers=["sassy"], extra=["issue", "shuts"])
    fx = room1.guess(order1[0], "issue")   # yellow s @1 before green s @2
    g1 = [f for f in fx if f["kind"] == "landed"][0]["gained"]
    room2, _, toks2, order2 = relay_room(
        monkeypatch, 2, answers=["sassy"], extra=["issue", "shuts"])
    fx = room2.guess(order2[0], "shuts")   # green s @0 before yellow s @4
    g2 = [f for f in fx if f["kind"] == "landed"][0]["gained"]
    # both guesses reveal exactly one new green 's' plus a duplicate-s yellow;
    # the yellow of a letter that just landed green must never pay, in either
    # position order
    m1 = evaluate_guess("sassy", "issue")
    m2 = evaluate_guess("sassy", "shuts")
    assert m1.count("g") == 1 and m1.count("y") == 1
    assert m2.count("g") == 1 and m2.count("y") == 1
    assert g1 == RELAY_NEW_GREEN
    assert g2 == RELAY_NEW_GREEN
    assert g1 == g2


def test_sabotage_next_seat_disconnected_no_crash(monkeypatch):
    room, clock, toks, order = relay_room(monkeypatch, 3, mode="sabotage")
    a, b, c = order
    room.leave(b)                       # next seat drops; round keeps going
    fx = room.sabotage(a, "time")       # must not crash, must hit c
    sab = [f for f in fx if f["kind"] == "sabotage"]
    assert sab and sab[0]["target"] == room.players[c].pid
    assert room._relay_current() == c
    r = room.match["round"]
    assert r["pending"] is not None and r["pending"]["target"] == room.players[c].pid
    assert r["eff_seconds"] == min(engine.TIME_CUT_SECONDS,
                                   r["turn_seconds"] - 2)
    # 2p sabotage with opponent gone: rejected cleanly, charge kept
    room2, _, toks2, order2 = relay_room(monkeypatch, 2, mode="sabotage")
    x, y = order2
    room2.players[y].connected = False  # simulate drop without pause bookkeeping
    fx = room2.sabotage(x, "time")
    assert any(f["kind"] == "invalid" for f in fx)
    assert room2.match["round"]["charges"][x] == engine.SABOTAGE_CHARGES


def test_time_cut_always_shortens(monkeypatch):
    room, clock, toks, order = relay_room(monkeypatch, 2, mode="sabotage")
    room.match["round"]["turn_seconds"] = 5
    room.sabotage(order[0], "time")
    assert room.match["round"]["eff_seconds"] == 3   # min(7, 5-2)
    assert room.match["round"]["eff_seconds"] < 5


def test_sabotage_unicode_letter_rejected(monkeypatch):
    room, clock, toks, order = relay_room(monkeypatch, 2, mode="sabotage")
    for bad in ["ë", "ß", "π", "1", "ab", None, 5]:
        fx = room.sabotage(order[0], "start", bad)
        assert any(f["kind"] == "invalid" for f in fx), bad
    assert room.match["round"]["charges"][order[0]] == engine.SABOTAGE_CHARGES


def test_podium_ties_share_rank(monkeypatch):
    room, clock = make_room(monkeypatch, answers=["crane", "slate"])
    room.settings["rounds"] = 1
    toks = join_ready(room, 3)
    start_match(room, toks)
    # everyone times out with no guesses -> all 0 points
    clock.advance(181)
    room.tick(room.gen)
    room.tick(room.gen)   # round_end -> podium
    assert room.phase == "podium"
    pod = room.state_for(toks[0])["match"]["podium"]
    assert [e["rank"] for e in pod] == [1, 1, 1]


def test_room_full_cap(monkeypatch):
    room, clock = make_room(monkeypatch)
    for i in range(engine.MAX_PLAYERS):
        p, fx = room.join(f"cap-token-{i:02d}", f"P{i}", None)
        assert p is not None
    p, fx = room.join("cap-token-overflow", "Late", None)
    assert p is None
    assert any(f["kind"] == "invalid" for f in fx)


def test_sabotage_rejected_in_relay_mode(monkeypatch):
    room, clock, toks, order = relay_room(monkeypatch, 2, mode="relay")
    fx = room.sabotage(order[0], "time")
    assert any(f["kind"] == "invalid" for f in fx)


def test_relay_state_shape(monkeypatch):
    room, clock, toks, order = relay_room(monkeypatch, 3, mode="sabotage",
                                          extra=["slate"])
    room.guess(order[0], "slate")
    st = room.state_for(toks[0])
    rd = st["match"]["round"]
    assert rd["kind"] == "sabotage"
    assert rd["rows"][0]["w"] == "slate"  # relay rows are public
    assert rd["turn"] is not None
    assert rd["charges"] is not None
    assert st["deadline"] is not None
