"""BINGO engine tests — card structure, daub rules, patterns, tie-sharing,
per-viewer masking, and full auto/manual games."""

import random

import pytest

from games.bingo.game import (BingoSession, CENTER, LINE_SETS, CORNER_SET,
                              call_label, EMOJI_POOL)


def _seat(s, settings=None, humans=("aaaaaaaa", "bbbbbbbb")):
    for i, t in enumerate(humans):
        s.join(t, "P%d" % i, "🦊")
        s.set_ready(t, True)
    if settings:
        s.set_settings(humans[0], settings)
    s.start(humans[0])
    s.tick(s.gen)               # countdown -> game_start
    return s


def _run(s, cap=6000):
    """Drive to game_end the way the net layer would (fire due bots, else tick)."""
    for _ in range(cap):
        if s.phase == "game_end":
            return
        due = s.next_bot_action()
        if due is not None:
            s.run_bot(due[1])
            continue
        s.tick(s.gen)
    raise AssertionError("game did not finish")


# ---- card + call ----------------------------------------------------------

def test_number_card_structure():
    s = _seat(BingoSession(random.Random(1)), {"rounds": 1})
    card = s.g["cards"]["aaaaaaaa"]
    assert len(card) == 25
    assert card[CENTER] == "FREE"
    nums = [c for i, c in enumerate(card) if i != CENTER]
    assert len(set(nums)) == 24                       # all distinct
    for c in range(5):                                # each column in its band
        band = set(range(c * 15 + 1, c * 15 + 16))
        col_cells = [r * 5 + c for r in range(5) if r * 5 + c != CENTER]
        assert all(card[cell] in band for cell in col_cells)


def test_pics_card_and_labels():
    s = _seat(BingoSession(random.Random(2)), {"rounds": 1, "mode": "pics"})
    card = s.g["cards"]["aaaaaaaa"]
    assert card[CENTER] == "FREE"
    pics = [c for i, c in enumerate(card) if i != CENTER]
    assert len(set(pics)) == 24
    assert all(p in EMOJI_POOL for p in pics)
    assert call_label("numbers", 7) == "B 7"
    assert call_label("numbers", 66) == "O 66"
    assert call_label("pics", "🐶") == "🐶"


# ---- daub rules -----------------------------------------------------------

def test_cannot_daub_uncalled_or_free():
    s = _seat(BingoSession(random.Random(3)), {"rounds": 1})
    card = s.g["cards"]["aaaaaaaa"]
    # pick a non-center cell whose value has NOT been called yet
    called = set(s.g["called"])
    cell = next(i for i, v in enumerate(card) if i != CENTER and v not in called)
    fx = s._daub("aaaaaaaa", cell)
    assert any(f.get("kind") == "invalid" for f in fx)
    assert cell not in s.g["daubed"]["aaaaaaaa"]
    # center is free and pre-daubed; daubing it is a no-op, never marks a claim
    assert CENTER in s.g["daubed"]["aaaaaaaa"]
    # now "call" that value and it becomes daubable
    s.g["called"].append(card[cell])
    assert s._daub("aaaaaaaa", cell) == []
    assert cell in s.g["daubed"]["aaaaaaaa"]


def test_daub_rejects_bad_cell():
    s = _seat(BingoSession(random.Random(4)), {"rounds": 1})
    for bad in (-1, 25, 99, "3", True, [1], None):
        fx = s._daub("aaaaaaaa", bad)
        assert fx == [] or any(f.get("kind") == "invalid" for f in fx)


# ---- pattern detection ----------------------------------------------------

def test_has_bingo_patterns():
    s = BingoSession(random.Random(5))
    s.settings["pattern"] = "line"
    assert s._has_bingo(set(LINE_SETS[0]))                 # a full row
    assert not s._has_bingo({0, 1, 2, 3})                  # partial
    s.settings["pattern"] = "corners"
    assert s._has_bingo(set(CORNER_SET) | {CENTER})
    assert not s._has_bingo({0, 4, 20})
    s.settings["pattern"] = "blackout"
    assert s._has_bingo(set(range(25)))
    assert not s._has_bingo(set(range(24)))


def test_claim_rejects_false_bingo():
    s = _seat(BingoSession(random.Random(6)), {"rounds": 1, "pattern": "blackout"})
    fx = s._claim("aaaaaaaa")                              # only free space daubed
    assert any(f.get("kind") == "invalid" for f in fx)
    assert s.phase == "calling"


def test_tie_shares_round_win():
    s = _seat(BingoSession(random.Random(7)), {"rounds": 2, "pattern": "line"})
    # force both players onto a complete first row via their real cards
    for t in ("aaaaaaaa", "bbbbbbbb"):
        s.g["daubed"][t] = set(LINE_SETS[0])
    fx = s._round_over(["aaaaaaaa", "bbbbbbbb"])
    assert s.g["wins"]["aaaaaaaa"] == 1
    assert s.g["wins"]["bbbbbbbb"] == 1
    assert s.phase == "roundwin"


# ---- masking --------------------------------------------------------------

def test_state_masks_other_cards():
    s = _seat(BingoSession(random.Random(8)), {"rounds": 1})
    a_nums = {v for i, v in enumerate(s.g["cards"]["aaaaaaaa"]) if i != CENTER}
    st_a = s.state_for("aaaaaaaa")["game"]
    # A's my_card is exactly A's own card — no field carries anyone else's card
    assert {c["v"] for c in st_a["my_card"] if not c["free"]} == a_nums
    for entry in st_a["roster"]:                           # roster is progress only
        assert set(entry) == {"pid", "marks", "wins", "won"}
    # spectator/TV gets no personal card at all, but sees progress
    st_tv = s.state_for(None)["game"]
    assert st_tv["my_card"] is None
    assert st_tv["roster"]


def test_state_never_crashes_any_phase():
    for mode in ("numbers", "pics"):
        for pattern in ("line", "corners", "blackout"):
            s = _seat(BingoSession(random.Random(9)),
                      {"rounds": 1, "auto": True, "pace": 3, "mode": mode, "pattern": pattern})
            for _ in range(4000):
                for v in (None, "aaaaaaaa", "bbbbbbbb", "ghost"):
                    assert s.state_for(v) is not None
                if s.phase == "game_end":
                    break
                s.tick(s.gen)
            assert s.phase == "game_end"


# ---- full games -----------------------------------------------------------

def test_auto_game_finishes_with_winner_each_round():
    s = _seat(BingoSession(random.Random(11)),
              {"rounds": 3, "auto": True, "pace": 3, "pattern": "line"})
    _run(s)
    assert s.phase == "game_end"
    res = s.g["result"]
    assert res and sum(e["wins"] for e in res) >= 3        # >=1 winner/round
    assert res == sorted(res, key=lambda e: -e["wins"])    # ranked


def test_manual_game_human_can_win():
    s = _seat(BingoSession(random.Random(12)), {"rounds": 1, "auto": False, "pattern": "line"})
    # human daubs everything callable each tick, claims the instant it's a line
    for _ in range(6000):
        if s.phase != "calling":
            break
        called = set(s.g["called"])
        for cell, cv in enumerate(s.g["cards"]["aaaaaaaa"]):
            if cv != "FREE" and cv in called:
                s._daub("aaaaaaaa", cell)
        if s._has_bingo(s.g["daubed"]["aaaaaaaa"]):
            s._claim("aaaaaaaa")
            break
        s.tick(s.gen)
    assert s.phase == "roundwin"
    assert "p1" in [s.players["aaaaaaaa"].pid]
    assert s.g["wins"]["aaaaaaaa"] == 1


def test_solo_gets_auto_bots():
    s = BingoSession(random.Random(13))
    s.join("aaaaaaaa", "Solo", "🦊")
    s.set_ready("aaaaaaaa", True)
    s.set_settings("aaaaaaaa", {"rounds": 1, "auto": True})
    s.start("aaaaaaaa")
    s.tick(s.gen)
    assert len(s.participants) == 3                        # solo + 2 auto bots
    assert sum(1 for t in s.participants if s.players[t].is_bot) == 2


def test_settings_validation():
    s = BingoSession(random.Random(14))
    assert s.validate_settings({"mode": "pics", "pattern": "blackout", "pace": 6,
                                "auto": True, "rounds": 5, "bots": 2}) == {
        "mode": "pics", "pattern": "blackout", "pace": 6,
        "auto": True, "rounds": 5, "bots": 2}
    # junk rejected
    assert s.validate_settings({"mode": "x", "pace": 99, "pace2": 1,
                                "rounds": 2, "bots": 9, "auto": "yes"}) == {}
