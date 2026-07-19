"""WORD RUSH tests — dictionary, rack quality, submit validation, scoring,
cumulative rounds, per-viewer word masking, bots, and a full game."""

import random

import pytest

from games.wordrush import words as W
from games.wordrush.game import WordRushSession, MIN_WORD


# ---- dictionary ----------------------------------------------------------

def test_dictionary_loads_and_validates():
    assert W.is_word("quartz") and W.is_word("house")
    assert not W.is_word("zzxqq") and not W.is_word("qwrtz")
    # only 3-8 letter words are in the playable set
    assert not W.is_word("a") and not W.is_word("go")
    assert len(W._WORDS) > 50000


def test_can_make_and_words_in_rack():
    assert W.can_make("cat", "actz") and not W.can_make("cats", "act")
    assert W.can_make("aa", "a") is False        # needs two a's
    ws = W.words_in_rack("quartzs")
    assert "quartz" in ws and "star" in ws and "arts" in ws
    assert all(W.can_make(w, "quartzs") for w in ws)   # every hit is formable
    assert all(3 <= len(w) <= 7 for w in ws)


def test_make_rack_is_playable():
    rng = random.Random(3)
    for _ in range(30):
        rack, found = W.make_rack(rng, 7, min_words=25)
        assert len(rack) == 7
        assert sum(1 for c in rack if c in W.VOWELS) >= 1
        # a good rack (not a degenerate fallback) should hit the threshold
        assert len(found) >= 20


def test_score_word():
    assert W.score_word("cat", 7) == 1
    assert W.score_word("house", 7) == 4
    assert W.score_word("quartz", 7) == 7          # 6-letter
    assert W.score_word("cabined", 7) == 11 + W.PANGRAM_BONUS   # 7 = full rack


# ---- engine helpers ------------------------------------------------------

def _seat(s, settings=None, humans=("aaaaaaaa", "bbbbbbbb")):
    for i, t in enumerate(humans):
        s.join(t, "P%d" % i, "🦊")
        s.set_ready(t, True)
    if settings:
        s.set_settings(humans[0], settings)
    s.start(humans[0])
    s.tick(s.gen)
    return s


def _a_word(s, length=None):
    pool = s.g["rack_words"]
    if length:
        pool = [w for w in pool if len(w) == length] or list(pool)
    return sorted(pool, key=lambda w: -len(w))[0]


# ---- submission ----------------------------------------------------------

def test_valid_submission_scores():
    s = _seat(WordRushSession(random.Random(5)), {"rounds": 1, "bots": 0})
    w = _a_word(s)
    fx = s._submit("aaaaaaaa", w)
    assert any(f.get("kind") == "found" and f["w"] == w for f in fx)
    assert s.g["found"]["aaaaaaaa"][w] == W.score_word(w, s.g["size"])
    assert s.g["round_score"]["aaaaaaaa"] > 0


def test_rejects():
    s = _seat(WordRushSession(random.Random(6)), {"rounds": 1, "bots": 0})
    rack = "".join(s.g["rack"])
    # not a word (but formable letters) — craft a non-word from rack letters
    def reason(w):
        fx = s._submit("aaaaaaaa", w)
        return next((f.get("why") for f in fx if f.get("kind") == "reject"), "OK")
    assert reason("ab") == "%d+ letters" % MIN_WORD        # too short
    assert reason("zzzz") in ("not in the rack",)          # z's not (all) in rack likely
    assert reason("12a") == "letters only"
    # duplicate
    w = _a_word(s)
    s._submit("aaaaaaaa", w)
    assert reason(w) == "already found"
    # a word longer than the rack
    assert reason("a" * (s.g["size"] + 1)) in ("too long",)


def test_cannot_submit_word_not_in_dictionary():
    s = _seat(WordRushSession(random.Random(9)), {"rounds": 1, "bots": 0})
    # find a letter-string formable from the rack that is NOT a word
    rack = s.g["rack"]
    bogus = None
    import itertools
    for combo in itertools.permutations(rack, 3):
        cand = "".join(combo)
        if not W.is_word(cand):
            bogus = cand
            break
    assert bogus is not None
    fx = s._submit("aaaaaaaa", bogus)
    assert any(f.get("why") == "not a word" for f in fx)
    assert bogus not in s.g["found"]["aaaaaaaa"]


# ---- masking -------------------------------------------------------------

def test_my_words_are_private():
    s = _seat(WordRushSession(random.Random(11)), {"rounds": 1, "bots": 0})
    w = _a_word(s)
    s._submit("aaaaaaaa", w)
    st_a = s.state_for("aaaaaaaa")["game"]
    st_b = s.state_for("bbbbbbbb")["game"]
    st_tv = s.state_for(None)["game"]
    assert any(e["w"] == w for e in st_a["my_words"])      # A sees own word
    assert st_b["my_words"] == []                          # B does NOT see A's words
    assert w not in repr(st_b["leaderboard"])              # nor in the leaderboard
    # but B's leaderboard reflects A's score + count
    a_pid = s.players["aaaaaaaa"].pid
    a_row = next(e for e in st_b["leaderboard"] if e["pid"] == a_pid)
    assert a_row["words"] == 1 and a_row["total"] > 0
    assert st_tv["my_words"] == []                         # spectator: no personal list


def test_state_never_crashes_any_phase():
    s = _seat(WordRushSession(random.Random(12)), {"rounds": 2, "clock": 60, "bots": 2})
    for _ in range(20000):
        for v in (None, "aaaaaaaa", "bbbbbbbb", "ghost"):
            assert s.state_for(v) is not None
        if s.phase == "game_end":
            break
        due = s.next_bot_action()
        if due:
            s.run_bot(due[1]); continue
        s.tick(s.gen)
    assert s.phase == "game_end"


# ---- rounds / scoring ----------------------------------------------------

def test_cumulative_across_rounds():
    s = _seat(WordRushSession(random.Random(13)), {"rounds": 2, "bots": 0})
    w1 = _a_word(s); s._submit("aaaaaaaa", w1)
    r1 = s.g["scores"]["aaaaaaaa"]
    assert r1 > 0
    s.tick(s.gen)            # -> reveal
    assert s.phase == "reveal"
    assert s.g["reveal"]["possible"] >= 20
    s.tick(s.gen)            # -> round 2 (playing)
    assert s.phase == "playing" and s.g["round"] == 2
    assert s.g["round_score"]["aaaaaaaa"] == 0            # per-round reset
    assert s.g["scores"]["aaaaaaaa"] == r1               # cumulative kept
    w2 = _a_word(s); s._submit("aaaaaaaa", w2)
    assert s.g["scores"]["aaaaaaaa"] > r1


def test_reveal_shows_missed_words():
    s = _seat(WordRushSession(random.Random(14)), {"rounds": 1, "bots": 0})
    s._submit("aaaaaaaa", _a_word(s))
    s.tick(s.gen)
    rev = s.g["reveal"]
    assert rev["possible"] == len(s.g["rack_words"])
    assert all(m in s.g["rack_words"] for m in rev["top_missed"])


# ---- bots + full game ----------------------------------------------------

def test_full_bot_game_only_legal_words():
    s = _seat(WordRushSession(random.Random(15)), {"rounds": 2, "clock": 60, "bots": 3})
    assert sum(1 for t in s.participants if s.players[t].is_bot) == 3
    for _ in range(30000):
        if s.phase == "game_end":
            break
        due = s.next_bot_action()
        if due:
            s.run_bot(due[1]); continue
        s.tick(s.gen)
    assert s.phase == "game_end"
    # every word any bot "found" is a real, rack-legal word
    for t in s.participants:
        for w in s.g["found"][t]:
            assert W.is_word(w) and W.can_make(w, s.g["rack_count"])
    res = s.g["result"]
    assert res == sorted(res, key=lambda e: (-e["score"], -e["words"]))


def test_solo_gets_auto_bots():
    s = WordRushSession(random.Random(16))
    s.join("aaaaaaaa", "Solo", "🦊"); s.set_ready("aaaaaaaa", True)
    s.set_settings("aaaaaaaa", {"rounds": 1})
    s.start("aaaaaaaa"); s.tick(s.gen)
    assert len(s.participants) == 3


def test_settings_validation():
    s = WordRushSession(random.Random(17))
    assert s.validate_settings({"rounds": 5, "clock": 120, "size": 8, "bots": 3}) == {
        "rounds": 5, "clock": 120, "size": 8, "bots": 3}
    assert s.validate_settings({"rounds": 4, "clock": 30, "size": 9, "bots": 9}) == {}
