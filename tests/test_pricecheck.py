"""PRICE CHECK engine tests — guess validation, closest/over scoring, ties,
guess masking until reveal, bots, and a full game."""

import random

import pytest

from games.pricecheck.game import PriceCheckSession
from games.pricecheck import items as itembank


def _seat(s, settings=None, humans=("aaaaaaaa", "bbbbbbbb")):
    for i, t in enumerate(humans):
        s.join(t, "P%d" % i, "🦊")
        s.set_ready(t, True)
    if settings:
        s.set_settings(humans[0], settings)
    s.start(humans[0])
    s.tick(s.gen)
    return s


# ---- item bank ------------------------------------------------------------

def test_item_bank_schema():
    bank = itembank.load()
    assert len(bank) >= len(itembank.SEED_ITEMS)
    keys = {"prompt", "emoji", "answer", "money", "unit", "fact", "category"}
    for it in bank:
        assert set(it) == keys, it
        assert isinstance(it["answer"], (int, float)) and not isinstance(it["answer"], bool)
        assert isinstance(it["money"], bool)
    picks = itembank.pick(random.Random(1), 5)
    assert len(picks) == 5 and len({p["prompt"] for p in picks}) == 5


# ---- guess validation -----------------------------------------------------

def test_guess_normalization():
    s = _seat(PriceCheckSession(random.Random(2)), {"rounds": 3, "bots": 0})
    assert s._norm_guess(12) == 12.0
    assert s._norm_guess(4.999) == 5.0                     # rounded to cents
    assert s._norm_guess(True) is None                     # bool is not a number
    assert s._norm_guess("5") is None
    assert s._norm_guess(-1) is None
    assert s._norm_guess(float("inf")) is None
    assert s._norm_guess(1e12) is None


def test_guess_and_lock_flow():
    s = _seat(PriceCheckSession(random.Random(3)), {"rounds": 3, "clock": 30, "bots": 0})
    assert s.phase == "guessing"
    # can't lock without a guess
    assert any(f.get("kind") == "invalid" for f in s._lock("aaaaaaaa"))
    s._guess("aaaaaaaa", 10)
    s._guess("aaaaaaaa", 20)                                # updates freely
    assert s.g["guesses"]["aaaaaaaa"] == 20
    s._lock("aaaaaaaa")
    assert s.g["locked"]["aaaaaaaa"]
    # locked -> further guesses ignored
    s._guess("aaaaaaaa", 999)
    assert s.g["guesses"]["aaaaaaaa"] == 20


def test_all_locked_reveals_early():
    s = _seat(PriceCheckSession(random.Random(4)), {"rounds": 2, "clock": 45, "bots": 0})
    s._guess("aaaaaaaa", 10); s._lock("aaaaaaaa")
    assert s.phase == "guessing"
    s._guess("bbbbbbbb", 20); s._lock("bbbbbbbb")
    assert s.phase == "reveal"                              # all locked -> instant reveal


# ---- scoring --------------------------------------------------------------

def _force_item(s, answer, money=False):
    s.g["item"] = {"prompt": "x", "emoji": "❓", "answer": answer, "money": money,
                   "unit": "", "fact": "because", "category": "fun"}


def test_closest_rule_and_tie():
    s = _seat(PriceCheckSession(random.Random(5)), {"rule": "closest", "rounds": 2, "bots": 0})
    _force_item(s, 100)
    s.g["guesses"] = {"aaaaaaaa": 90, "bbbbbbbb": 110}      # both 10 away -> tie
    s.g["locked"] = {"aaaaaaaa": True, "bbbbbbbb": True}
    s._reveal()
    assert s.g["wins"]["aaaaaaaa"] == 1 and s.g["wins"]["bbbbbbbb"] == 1
    assert set(s.g["last_winners"]) == {"aaaaaaaa", "bbbbbbbb"}


def test_over_rule_excludes_overbids():
    s = _seat(PriceCheckSession(random.Random(6)), {"rule": "over", "rounds": 2, "bots": 0})
    _force_item(s, 100)
    s.g["guesses"] = {"aaaaaaaa": 95, "bbbbbbbb": 101}      # B is over -> ineligible
    s.g["locked"] = {"aaaaaaaa": True, "bbbbbbbb": True}
    s._reveal()
    assert s.g["last_winners"] == ["aaaaaaaa"]
    assert s.g["wins"]["bbbbbbbb"] == 0


def test_over_rule_all_over_is_draw():
    s = _seat(PriceCheckSession(random.Random(7)), {"rule": "over", "rounds": 2, "bots": 0})
    _force_item(s, 100)
    s.g["guesses"] = {"aaaaaaaa": 120, "bbbbbbbb": 130}
    s.g["locked"] = {"aaaaaaaa": True, "bbbbbbbb": True}
    fx = s._reveal()
    assert s.g["last_winners"] == []
    assert any(f.get("kind") == "reveal" and f.get("drawn") for f in fx)


def test_bullseye_flag():
    s = _seat(PriceCheckSession(random.Random(8)), {"rounds": 2, "bots": 0})
    _force_item(s, 100)
    s.g["guesses"] = {"aaaaaaaa": 100, "bbbbbbbb": 50}
    s.g["locked"] = {"aaaaaaaa": True, "bbbbbbbb": True}
    s._reveal()
    by_pid = {r["pid"]: r for r in s.g["reveal"]}
    assert by_pid[s.players["aaaaaaaa"].pid]["bullseye"] is True
    assert by_pid[s.players["bbbbbbbb"].pid]["bullseye"] is False


# ---- masking --------------------------------------------------------------

def test_guesses_masked_until_reveal():
    s = _seat(PriceCheckSession(random.Random(9)), {"rounds": 2, "clock": 45, "bots": 0})
    s._guess("aaaaaaaa", 777); s._lock("aaaaaaaa")
    s._guess("bbbbbbbb", 888)
    # B's view during guessing must NOT contain A's 777 anywhere
    st_b = s.state_for("bbbbbbbb")
    assert "777" not in repr(st_b["game"]["roster"])
    assert st_b["game"]["my_guess"] == 888                 # but sees their own
    assert st_b["game"]["answer"] is None                  # answer hidden pre-reveal
    a_locked = next(r for r in st_b["game"]["roster"] if r["pid"] == s.players["aaaaaaaa"].pid)
    assert a_locked["locked"] is True and "guess" not in a_locked
    # after reveal, guesses are public
    s._lock("bbbbbbbb")
    assert s.phase == "reveal"
    st_tv = s.state_for(None)
    assert st_tv["game"]["answer"] is not None
    assert any("guess" in r for r in st_tv["game"]["roster"])


# ---- bots + full game -----------------------------------------------------

def test_bot_guesses_and_full_game():
    s = _seat(PriceCheckSession(random.Random(10)), {"rounds": 3, "clock": 20, "bots": 2})
    assert sum(1 for t in s.participants if s.players[t].is_bot) == 2
    for _ in range(5000):
        if s.phase == "game_end":
            break
        due = s.next_bot_action()
        if due is not None:
            s.run_bot(due[1])
            continue
        if s.phase == "guessing":                          # humans guess too
            ans = float(s.g["item"]["answer"])
            s._guess("aaaaaaaa", ans * 0.9); s._lock("aaaaaaaa")
            s._guess("bbbbbbbb", ans * 1.3); s._lock("bbbbbbbb")
            continue
        s.tick(s.gen)
    assert s.phase == "game_end"
    res = s.g["result"]
    assert res and res == sorted(res, key=lambda e: -e["wins"])


def test_solo_gets_auto_bots():
    s = PriceCheckSession(random.Random(11))
    s.join("aaaaaaaa", "Solo", "🦊"); s.set_ready("aaaaaaaa", True)
    s.set_settings("aaaaaaaa", {"rounds": 3})
    s.start("aaaaaaaa"); s.tick(s.gen)
    assert len(s.participants) == 3


def test_settings_validation():
    s = PriceCheckSession(random.Random(12))
    assert s.validate_settings({"rule": "over", "rounds": 8, "clock": 45, "bots": 3}) == {
        "rule": "over", "rounds": 8, "clock": 45, "bots": 3}
    assert s.validate_settings({"rule": "x", "rounds": 4, "clock": 99, "bots": 9}) == {}
