import random
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from games.trivia import questions
from games.trivia.game import (TriviaSession, QUESTION_SECONDS, ANSWER_SECONDS,
                               RACE_SECONDS, BUZZ_BASE, SPEED_MAX,
                               WRONG_PENALTY, RACE_MAX, RACE_MIN)


# ---------------- bank integrity ----------------

def test_bank_size_and_shape():
    assert len(questions.BANK) >= 600
    for e in questions.BANK:
        assert set(e) == {"cat", "diff", "q", "choices", "a"}, e
        assert e["cat"] in questions.CAT_SLUGS, e
        assert e["diff"] in (1, 2, 3), e
        assert isinstance(e["q"], str) and len(e["q"].strip()) >= 8, e
        assert isinstance(e["choices"], list) and len(e["choices"]) == 4, e
        assert all(isinstance(c, str) and c.strip() for c in e["choices"]), e
        assert len({c.strip().lower() for c in e["choices"]}) == 4, e
        assert isinstance(e["a"], int) and 0 <= e["a"] <= 3, e


def test_bank_all_categories_present_and_stocked():
    counts = Counter(e["cat"] for e in questions.BANK)
    assert set(counts) == set(questions.CAT_SLUGS)
    for slug, n in counts.items():
        assert n >= 50, (slug, n)


def test_bank_no_duplicate_questions():
    keys = Counter(questions.key(e) for e in questions.BANK)
    dupes = [k for k, v in keys.items() if v > 1]
    assert not dupes, dupes


def test_family_pool_deep_enough():
    for c in questions.categories():
        assert c["family_count"] >= 20, c   # 20-question family match per cat


def test_categories_meta():
    cats = questions.categories()
    assert len(cats) == 10
    assert sum(c["count"] for c in cats) == len(questions.BANK)
    for c in cats:
        assert c["title"] and c["icon"]


# ---------------- draw ----------------

def test_draw_no_repeats_and_seeded():
    a = questions.draw(20, random.Random(7), cat="mixed", family=False)
    b = questions.draw(20, random.Random(7), cat="mixed", family=False)
    assert [e["q"] for e in a] == [e["q"] for e in b]      # seeded
    keys = [questions.key(e) for e in a]
    assert len(keys) == len(set(keys)) == 20               # no repeats


def test_draw_respects_category_and_family():
    got = questions.draw(15, random.Random(3), cat="science", family=True)
    assert len(got) == 15
    assert all(e["cat"] == "science" and e["diff"] <= 2 for e in got)
    got = questions.draw(15, random.Random(3), cat="history", family=False)
    assert all(e["cat"] == "history" for e in got)


def test_draw_avoids_excluded_until_exhausted():
    first = questions.draw(20, random.Random(1), cat="kids", family=True)
    seen = {questions.key(e) for e in first}
    second = questions.draw(20, random.Random(2), cat="kids", family=True,
                            exclude=seen)
    assert not seen & {questions.key(e) for e in second}
    # exhaustion: kids has 60 entries; asking for 50 with 20 excluded must
    # still return 50 distinct questions (falls back to the excluded ones)
    third = questions.draw(50, random.Random(3), cat="kids", family=True,
                           exclude=seen)
    ks = [questions.key(e) for e in third]
    assert len(ks) == len(set(ks)) == 50


# ---------------- session plumbing ----------------

def make_session(n=3, seed=5, **settings):
    s = TriviaSession(rng=random.Random(seed))
    toks = []
    for i in range(n):
        tok = f"tv-token-{i:02d}xx"
        s.join(tok, f"P{i}", None)
        s.set_ready(tok, True)
        toks.append(tok)
    s.settings.update({"rounds": 4, **settings})
    s.start(toks[0])
    s.tick(s.gen)          # countdown fires -> game_start -> first question
    return s, toks


def correct_i(s):
    return s.g["q"]["card"]["correct"]


def wrong_i(s):
    return (correct_i(s) + 1) % 4


def kinds(fx):
    return [f["kind"] for f in fx]


def test_settings_validation():
    s = TriviaSession()
    ok = s.validate_settings({"mode": "race", "rounds": 15,
                              "cat": "movies", "diff": "all"})
    assert ok == {"mode": "race", "rounds": 15, "cat": "movies", "diff": "all"}
    assert s.validate_settings({"rounds": 4}) == {"rounds": 4}   # dev short
    assert s.validate_settings({"mode": "chaos", "rounds": 7,
                                "cat": "nope", "diff": "impossible"}) == {}


def test_game_starts_with_question_and_masks_answer():
    s, toks = make_session(3)
    assert s.phase == "question"
    st = s.state_for(toks[0])["game"]
    assert st["q"] and len(st["q"]["choices"]) == 4
    assert "correct" not in st["q"]
    assert st["reveal"] is None
    spec = s.state_for(None)["game"]
    assert "correct" not in spec["q"] and spec["reveal"] is None
    # lobby state carries the category metadata for the picker
    assert len(s.state_for(toks[0])["cats"]) == 10


# ---------------- buzzer flow ----------------

def test_first_buzz_wins_and_locks_room():
    s, toks = make_session(3)
    fx = s.game_action(toks[0], {"t": "buzz"})
    assert "buzz" in kinds(fx)
    assert s.phase == "answer"
    assert s.g["q"]["buzzer"] == toks[0]
    late = s.game_action(toks[1], {"t": "buzz"})
    assert kinds(late) == ["too_late"]
    assert late[0]["to"] == toks[1]
    assert s.g["q"]["buzzer"] == toks[0]     # unchanged


def test_correct_buzz_scores_with_speed_bonus():
    s, toks = make_session(2)
    s.game_action(toks[0], {"t": "buzz"})
    fx = s.game_action(toks[0], {"t": "pick", "i": correct_i(s)})
    assert "correct" in kinds(fx) and "reveal" in kinds(fx)
    pts = s.g["scores"][toks[0]]
    # instant buzz: full base + nearly all of the speed bonus
    assert BUZZ_BASE + SPEED_MAX - 10 <= pts <= BUZZ_BASE + SPEED_MAX
    assert s.phase == "reveal"
    assert s.g["reveal"]["by"] == s.players[toks[0]].pid


def test_wrong_answer_locks_out_and_reopens_for_steal():
    s, toks = make_session(3)
    s.game_action(toks[0], {"t": "buzz"})
    fx = s.game_action(toks[0], {"t": "pick", "i": wrong_i(s)})
    assert "wrong" in kinds(fx) and "reopen" in kinds(fx)
    assert s.phase == "question"                     # re-opened
    assert toks[0] in s.g["q"]["locked"]
    assert s.g["scores"][toks[0]] == -WRONG_PENALTY
    # locked player can't buzz again
    fx = s.game_action(toks[0], {"t": "buzz"})
    assert "invalid" in kinds(fx)
    # the steal: second player buzzes and takes it
    s.game_action(toks[1], {"t": "buzz"})
    assert s.g["q"]["buzzer"] == toks[1]
    fx = s.game_action(toks[1], {"t": "pick", "i": correct_i(s)})
    assert "reveal" in kinds(fx)
    assert s.g["scores"][toks[1]] >= BUZZ_BASE
    assert s.g["reveal"]["by"] == s.players[toks[1]].pid


def test_all_locked_out_reveals_with_no_winner():
    s, toks = make_session(2)
    for tok in toks:
        s.game_action(tok, {"t": "buzz"})
        fx = s.game_action(tok, {"t": "pick", "i": wrong_i(s)})
    assert "reveal" in kinds(fx)                     # second fail ends it
    assert s.phase == "reveal"
    assert s.g["reveal"]["by"] is None
    assert all(s.g["scores"][t] == -WRONG_PENALTY for t in toks)


def test_answer_timeout_counts_as_wrong():
    s, toks = make_session(3)
    s.game_action(toks[0], {"t": "buzz"})
    fx = s.tick(s.gen)                               # 6s window expires
    assert "wrong" in kinds(fx)
    assert fx[kinds(fx).index("wrong")]["timeout"] is True
    assert toks[0] in s.g["q"]["locked"]
    assert s.phase == "question"                     # others may steal


def test_nobody_buzzes_reveals_unscored():
    s, toks = make_session(2)
    fx = s.tick(s.gen)                               # 20s clock expires
    assert "reveal" in kinds(fx)
    assert s.g["reveal"]["by"] is None
    assert all(v == 0 for v in s.g["scores"].values())


def test_pick_without_buzz_is_rejected():
    s, toks = make_session(2)
    fx = s.game_action(toks[0], {"t": "pick", "i": 0})
    assert "invalid" in kinds(fx)
    assert all(v == 0 for v in s.g["scores"].values())


# ---------------- race flow ----------------

def test_race_scoring_and_early_reveal():
    s, toks = make_session(3, mode="race")
    assert s.phase == "question"
    fx = s.game_action(toks[0], {"t": "pick", "i": correct_i(s)})
    assert "picked" in kinds(fx) and "race_pick" in kinds(fx)
    # picks stay hidden (and unscored) until the reveal
    assert s.g["scores"][toks[0]] == 0
    st = s.state_for(toks[1])["game"]
    assert st["your_pick"] is None
    assert s.players[toks[0]].pid in st["answered"]
    s.game_action(toks[1], {"t": "pick", "i": wrong_i(s)})
    fx = s.game_action(toks[2], {"t": "pick", "i": correct_i(s)})
    assert "reveal" in kinds(fx)                     # everyone answered -> early
    assert s.phase == "reveal"
    fast, wrong, slow = (s.g["scores"][t] for t in toks)
    assert RACE_MIN <= fast <= RACE_MAX and RACE_MIN <= slow <= RACE_MAX
    assert fast >= slow                              # earlier answer, more points
    assert wrong == 0                                # no negatives in race
    picks = {d["pid"]: d["pick"] for d in s.g["reveal"]["deltas"]}
    assert picks[s.players[toks[1]].pid] == wrong_i(s)   # reveal shows who picked what


def test_race_no_double_pick_and_no_buzz():
    s, toks = make_session(2, mode="race")
    s.game_action(toks[0], {"t": "pick", "i": 0})
    fx = s.game_action(toks[0], {"t": "pick", "i": 1})
    assert "invalid" in kinds(fx)
    fx = s.game_action(toks[0], {"t": "buzz"})
    assert "invalid" in kinds(fx)


def test_race_timeout_scores_only_the_picks():
    s, toks = make_session(3, mode="race")
    s.game_action(toks[0], {"t": "pick", "i": correct_i(s)})
    fx = s.tick(s.gen)                               # 12s expires
    assert "reveal" in kinds(fx)
    assert s.g["scores"][toks[0]] >= RACE_MIN
    assert s.g["scores"][toks[1]] == 0 and s.g["scores"][toks[2]] == 0


# ---------------- match arc ----------------

def run_question_by_timeout(s):
    assert s.phase == "question"
    s.tick(s.gen)                    # question clock -> reveal
    assert s.phase == "reveal"
    s.tick(s.gen)                    # reveal -> next / standings / end


def test_match_end_and_standings_ranks():
    s, toks = make_session(3)
    # q1: P0 answers correctly; the rest time out
    s.game_action(toks[0], {"t": "buzz"})
    s.game_action(toks[0], {"t": "pick", "i": correct_i(s)})
    s.tick(s.gen)                    # reveal -> q2
    for _ in range(3):
        run_question_by_timeout(s)
    assert s.phase == "game_end"
    res = s.g["result"]
    assert res["winner"] == s.players[toks[0]].pid
    assert res["rows"][0]["rank"] == 1
    assert res["rows"][0]["score"] >= BUZZ_BASE
    # the two zero-score players tie on rank
    assert res["rows"][1]["rank"] == res["rows"][2]["rank"] == 2
    # game_end auto-returns to lobby via the shared machinery
    s.tick(s.gen)
    assert s.phase == "lobby"


def test_standings_interstitial_every_5():
    s, toks = make_session(2, rounds=10)
    for i in range(4):
        run_question_by_timeout(s)
        assert s.phase == "question", i
    assert s.g["qno"] == 5
    s.tick(s.gen)                    # q5 reveal
    fx = s.tick(s.gen)               # reveal -> standings, not next question
    assert "standings" in kinds(fx)
    assert s.phase == "standings"
    st = s.state_for(toks[0])["game"]
    assert st["standings"] and len(st["standings"]) == 2
    s.tick(s.gen)                    # standings -> q6
    assert s.phase == "question" and s.g["qno"] == 6


def test_no_repeats_within_match_and_across_rematch():
    s, toks = make_session(2, rounds=20)
    first = {q["q"] for q in s.g["queue"]}
    assert len(first) == 20
    # burn the match down, rematch, draw again
    while s.phase != "game_end":
        if s.phase == "question":
            s.tick(s.gen)
        else:
            s.tick(s.gen)
    s.to_lobby()
    for tok in toks:
        s.set_ready(tok, True)
    s.start(toks[0])
    s.tick(s.gen)
    second = {q["q"] for q in s.g["queue"]}
    assert not first & second        # rematch avoids the questions just played


# ---------------- disconnects ----------------

def test_disconnect_of_answering_buzzer_fails_and_reopens():
    s, toks = make_session(3)
    s.game_action(toks[0], {"t": "buzz"})
    fx = s.leave(toks[0])
    assert "wrong" in kinds(fx)
    assert s.phase == "question"     # re-opened for the others
    assert s.g["scores"][toks[0]] == -WRONG_PENALTY
    # reconnect mid-question: seamless rejoin, still a participant
    p, fx = s.join(toks[0], "P0", None)
    assert p.connected
    st = s.state_for(toks[0])["game"]
    assert st["you_locked"] is True  # their lockout survived the drop
    assert s.players[toks[0]].pid in st["order"]


def test_disconnected_player_skipped_in_race():
    s, toks = make_session(3, mode="race")
    s.leave(toks[2])
    s.game_action(toks[0], {"t": "pick", "i": correct_i(s)})
    fx = s.game_action(toks[1], {"t": "pick", "i": correct_i(s)})
    assert "reveal" in kinds(fx)     # the dropped player doesn't block the room
    assert s.phase == "reveal"


def test_reconnect_mid_question_keeps_scores():
    s, toks = make_session(2)
    s.game_action(toks[0], {"t": "buzz"})
    s.game_action(toks[0], {"t": "pick", "i": correct_i(s)})
    before = s.g["scores"][toks[0]]
    s.tick(s.gen)                    # reveal -> q2
    s.leave(toks[1])
    p, fx = s.join(toks[1], "P1", None)
    assert any(f["kind"] == "toast" for f in fx)     # welcome back
    assert s.g["scores"][toks[0]] == before
    assert s.in_game()


def test_spectator_cannot_play():
    s, toks = make_session(2)
    s.join("spec-token-xyz12", "Spec", None)
    fx = s.game_action("spec-token-xyz12", {"t": "buzz"})
    assert "invalid" in kinds(fx)
