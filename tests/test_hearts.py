import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from games.hearts import rules
from games.hearts.game import HeartsSession


# ---------------- rules primitives ----------------

def test_deck():
    assert len(rules.DECK) == 52
    assert len(set(rules.DECK)) == 52


def test_card_points():
    assert rules.points_of("QS") == 13
    assert rules.points_of("2H") == 1 and rules.points_of("AH") == 1
    assert rules.points_of("AS") == 0 and rules.points_of("KD") == 0
    assert sum(rules.points_of(c) for c in rules.DECK) == 26


def test_pass_rotation():
    assert [rules.pass_direction(h) for h in range(1, 9)] == \
        ["left", "right", "across", "hold"] * 2
    assert rules.pass_target(0, "left") == 1     # left = next in play order
    assert rules.pass_target(0, "right") == 3
    assert rules.pass_target(0, "across") == 2
    assert rules.pass_target(3, "left") == 0
    assert rules.pass_target(2, "right") == 1


def test_legal_first_trick_lead_is_2c():
    hand = ["2C", "AC", "9H", "QS"]
    assert rules.legal_plays(hand, [], False, 1) == ["2C"]
    # any other leader (defensive; can't happen live) may lead anything
    assert set(rules.legal_plays(["AC", "9D"], [], False, 1)) == {"AC", "9D"}


def test_legal_first_trick_blocks_points():
    # void in clubs on trick 1: hearts and the queen stay in hand
    hand = ["9H", "QS", "KD", "3S"]
    assert set(rules.legal_plays(hand, [(0, "2C")], False, 1)) == {"KD", "3S"}
    # nothing but points: forced to bleed one
    allpts = ["9H", "QS"]
    assert set(rules.legal_plays(allpts, [(0, "2C")], False, 1)) == {"9H", "QS"}


def test_legal_hearts_locked_until_broken():
    hand = ["AH", "2H", "9D"]
    assert set(rules.legal_plays(hand, [], False, 5)) == {"9D"}
    assert set(rules.legal_plays(hand, [], True, 5)) == {"AH", "2H", "9D"}
    # only hearts left: may lead them even unbroken
    assert set(rules.legal_plays(["AH", "2H"], [], False, 5)) == {"AH", "2H"}
    # the queen may be led any time — she's a spade
    assert "QS" in rules.legal_plays(["QS", "2H", "9D"], [], False, 5)


def test_legal_follow_suit():
    hand = ["AS", "2H", "9H", "3C"]
    assert set(rules.legal_plays(hand, [(0, "KH")], True, 5)) == {"2H", "9H"}
    # void in the led suit: anything (past trick 1)
    assert set(rules.legal_plays(["AS", "3C"], [(0, "KD")], False, 5)) == \
        {"AS", "3C"}


def test_trick_winner_no_trump():
    # highest of the led suit wins
    assert rules.trick_winner([(0, "5H"), (1, "KH"), (2, "AH"), (3, "2D")]) == 2
    # off-suit cards never win, however big
    assert rules.trick_winner([(0, "5D"), (1, "AS"), (2, "AH"), (3, "9D")]) == 3
    assert rules.trick_winner([(2, "TC"), (3, "JC"), (0, "QS"), (1, "2C")]) == 3


def test_score_hand_basic_and_queen():
    # seat 0: two hearts + the queen; seat 3: the ten remaining hearts
    taken = {0: ["2H", "9H", "QS"], 1: ["AH"], 2: [],
             3: [r + "H" for r in "345678TJQK"]}
    res = rules.score_hand(taken)
    assert res["pts"] == {0: 15, 1: 1, 2: 0, 3: 10}
    assert res["deltas"] == res["pts"]
    assert res["moon"] is None


def test_score_hand_moon():
    allpts = [r + "H" for r in rules.RANKS] + ["QS"]
    res = rules.score_hand({0: [], 1: [], 2: allpts, 3: []})
    assert res["moon"] == 2
    assert res["deltas"] == {0: 26, 1: 26, 2: 0, 3: 26}


def test_match_winner_lowest_unique():
    assert rules.match_winner({0: 40, 1: 30, 2: 20, 3: 10}, 100) is None
    assert rules.match_winner({0: 102, 1: 55, 2: 31, 3: 70}, 100) == 2
    # tie at the bottom plays on
    assert rules.match_winner({0: 100, 1: 20, 2: 20, 3: 70}, 100) is None
    assert rules.match_winner({0: 50, 1: 49, 2: 50, 3: 50}, 50) == 1


# ---------------- session ----------------

def make_session(n_humans=1, seed=11, **settings):
    s = HeartsSession(rng=random.Random(seed))
    toks = []
    for i in range(n_humans):
        tok = f"human-token-{i:02d}"
        s.join(tok, f"H{i}", None)
        s.set_ready(tok, True)
        toks.append(tok)
    s.settings.update(settings)
    fx = s.start(toks[0])
    assert s.phase == "countdown", fx
    s.tick(s.gen)
    return s, toks


def pass_all(s):
    """Autopilot-pass every seat still holding picks."""
    for seat in range(4):
        if s.g["passes"][seat] is None:
            fx = s._auto_pass(seat)
            assert not any(f["kind"] == "invalid" for f in fx), fx
    assert s.phase == "playing"


def play_full_hand(s):
    """Drive the hand with first-legal plays. Returns plays made."""
    n = 0
    while s.phase == "playing" and n < 60:
        seat = s.g["turn"]
        legal = rules.legal_plays(s.g["hands"][seat], s.g["trick"],
                                  s.g["hearts_broken"], s.g["trick_no"])
        fx = s._do_play(seat, legal[0])
        assert not any(f["kind"] == "invalid" for f in fx), fx
        n += 1
    return n


def test_solo_start_seats_three_bots():
    s, toks = make_session(1)
    assert s.phase == "passing"          # hand 1 passes left
    g = s.g
    assert g["seats"][0] == toks[0]
    assert all(s.players[g["seats"][i]].is_bot for i in (1, 2, 3))
    assert len(s.participants) == 4
    hands = g["hands"]
    allc = [c for h in hands.values() for c in h]
    assert len(allc) == 52 and len(set(allc)) == 52
    assert all(len(h) == 13 for h in hands.values())


def test_hold_hand_skips_passing():
    s, _ = make_session(1)
    s.g["hand_no"] = 3                   # next deal is hand 4 -> hold
    fx = s._start_hand()
    assert s.g["pass_dir"] == "hold"
    assert s.phase == "playing"
    assert rules.TWO_CLUBS in s.g["hands"][s.g["turn"]]
    assert any(f["kind"] == "play_begins" for f in fx)


def test_pass_validation():
    s, toks = make_session(1)
    hand = list(s.g["hands"][0])
    bad = [hand[:2],                       # too few
           hand[:4],                       # too many
           [hand[0], hand[0], hand[1]],    # dupes
           [hand[0], hand[1], "XX"],       # not a card
           "AS 2H 3C",                     # not a list
           None]
    for cards in bad:
        fx = s._do_pass(0, cards)
        assert any(f["kind"] == "invalid" for f in fx), cards
    fx = s._do_pass(0, hand[:3])
    assert not any(f["kind"] == "invalid" for f in fx)
    # can't pass twice
    fx = s._do_pass(0, hand[3:6])
    assert any(f["kind"] == "invalid" for f in fx)


def test_passing_moves_cards_and_2c_leads():
    s, _ = make_session(1)
    picks = list(s.g["hands"][0][:3])
    s._do_pass(0, picks)
    pass_all(s)                          # bots pass; play begins
    g = s.g
    # hand 1 passes left: seat 0's picks land with seat 1
    assert all(c in g["hands"][1] for c in picks)
    assert all(c not in g["hands"][0] for c in picks)
    assert g["received"][1] == picks
    allc = [c for h in g["hands"].values() for c in h]
    assert len(allc) == 52 and len(set(allc)) == 52
    assert all(len(h) == 13 for h in g["hands"].values())
    # the 2♣ holder opens
    assert rules.TWO_CLUBS in g["hands"][g["turn"]]


def test_first_play_must_be_2c():
    s, _ = make_session(1)
    pass_all(s)
    seat = s.g["turn"]
    other = next(c for c in s.g["hands"][seat] if c != rules.TWO_CLUBS)
    fx = s._do_play(seat, other)
    assert any(f["kind"] == "invalid" for f in fx)
    fx = s._do_play(seat, rules.TWO_CLUBS)
    assert not any(f["kind"] == "invalid" for f in fx)
    # out-of-turn play rejected
    fx = s._do_play(seat, s.g["hands"][seat][0])
    assert any(f["kind"] == "invalid" for f in fx)


def test_follow_suit_enforced():
    s, _ = make_session(1)
    pass_all(s)
    seat = s.g["turn"]
    s._do_play(seat, rules.TWO_CLUBS)
    nxt = s.g["turn"]
    hand = s.g["hands"][nxt]
    can_follow = [c for c in hand if c[1] == "C"]
    cant = [c for c in hand if c[1] != "C"]
    if can_follow and cant:
        fx = s._do_play(nxt, cant[0])
        assert any(f["kind"] == "invalid" for f in fx)


def test_hearts_lead_locked_until_broken():
    s, _ = make_session(1)
    pass_all(s)
    g = s.g
    g["trick"] = []
    g["trick_no"] = 3
    g["turn"] = 0
    g["hearts_broken"] = False
    g["hands"][0] = ["5H", "3C"]
    fx = s._do_play(0, "5H")
    assert any(f["kind"] == "invalid" for f in fx)
    g["hearts_broken"] = True
    fx = s._do_play(0, "5H")
    assert not any(f["kind"] == "invalid" for f in fx)


def test_queen_drama_and_broken_by_queen():
    s, _ = make_session(1)
    pass_all(s)
    g = s.g
    g["trick"], g["trick_no"], g["turn"] = [], 13, 0
    g["hearts_broken"] = False
    g["hands"] = {0: ["QS"], 1: ["AS"], 2: ["2D"], 3: ["3D"]}
    fx = s._do_play(0, "QS")             # Q♠ lead is legal unbroken...
    assert not any(f["kind"] == "invalid" for f in fx)
    assert g["hearts_broken"]            # ...and it breaks hearts
    assert any(f["kind"] == "queen_played" for f in fx)
    fx = s._do_play(1, "AS")
    fx = s._do_play(2, "2D")
    fx = s._do_play(3, "3D")
    # AS over the queen: seat 1 eats 13
    assert any(f["kind"] == "queen_taken" and f["seat"] == 1 for f in fx)
    assert any(f["kind"] == "trick_won" and f["pts"] == 13 for f in fx)
    assert s.phase == "hand_end"
    assert s.g["hand_result"]["pts"]["1"] == 13


def test_full_hand_scores_26():
    s, _ = make_session(1)
    pass_all(s)
    plays = play_full_hand(s)
    assert plays == 52
    assert s.phase == "hand_end"
    hr = s.g["hand_result"]
    assert sum(hr["pts"].values()) == 26
    assert sum(s.g["scores"].values()) == 26 or hr["moon"] is not None


def test_moon_applied_in_session():
    s, _ = make_session(1)
    pass_all(s)
    allpts = [r + "H" for r in rules.RANKS] + ["QS"]
    s.g["taken"] = {0: [], 1: [], 2: allpts, 3: []}
    s._end_hand()
    assert s.g["hand_result"]["moon"] == 2
    assert s.g["scores"] == {0: 26, 1: 26, 2: 0, 3: 26}


def test_match_end_lowest_wins():
    s, _ = make_session(1, target=50)
    pass_all(s)
    play_full_hand(s)
    assert s.phase == "hand_end"
    s.g["scores"] = {0: 12, 1: 55, 2: 30, 3: 41}
    s.tick(s.gen)
    assert s.phase == "game_end"
    res = s.g["result"]
    assert res["winner_seat"] == 0
    scores = [r["score"] for r in res["standings"]]
    assert scores == sorted(scores)      # lowest first
    assert res["standings"][0]["seat"] == 0


def test_match_tie_at_bottom_plays_on():
    s, _ = make_session(1, target=50)
    pass_all(s)
    play_full_hand(s)
    s.g["scores"] = {0: 20, 1: 20, 2: 60, 3: 70}
    s.tick(s.gen)
    assert s.phase in ("passing", "playing")   # next hand dealt
    assert s.g["result"] is None
    assert s.g["hand_no"] == 2


def test_timeout_autopasses_and_autoplays():
    s, _ = make_session(1)
    assert s.phase == "passing"
    s.tick(s.gen)                        # deadline: autopilot passes for all
    assert s.phase == "playing"
    before = sum(len(h) for h in s.g["hands"].values())
    s.tick(s.gen)                        # play timeout auto-plays a card
    assert sum(len(h) for h in s.g["hands"].values()) == before - 1


def test_bots_drive_passing_and_turns():
    s, toks = make_session(1)
    for _ in range(8):
        due = s.next_bot_action()
        if due is None:
            break
        delay, bot_tok = due
        assert delay > 0
        s.run_bot(bot_tok)
    # all three bots passed; only the human's picks are missing
    assert [seat for seat in range(4) if s.g["passes"][seat] is None] == [0]
    s._do_pass(0, list(s.g["hands"][0][:3]))
    assert s.phase == "playing"
    # if a bot leads, next_bot_action offers it
    if s._seat_is_auto(s.g["turn"]):
        assert s.next_bot_action() is not None


def test_bots_play_full_hands_legally():
    """Several full bot-only hands per tier, seeded — every action legal."""
    for diff, seed in (("standard", 21), ("rookie", 22)):
        s, _ = make_session(1, seed=seed, difficulty=diff)
        hands_done, guard = 0, 0
        while hands_done < 5 and s.phase != "game_end" and guard < 4000:
            guard += 1
            if s.phase == "passing":
                for seat in range(4):
                    if s.g["passes"][seat] is None:
                        fx = s._auto_pass(seat)
                        assert not any(f["kind"] == "invalid" for f in fx), fx
            elif s.phase == "playing":
                fx = s._auto_play(s.g["turn"])
                assert not any(f["kind"] == "invalid" for f in fx), fx
            elif s.phase == "hand_end":
                assert sum(s.g["hand_result"]["pts"].values()) == 26
                hands_done += 1
                s.tick(s.gen)
            else:
                raise AssertionError(s.phase)
        assert hands_done >= 5 or s.phase == "game_end", (diff, s.phase)


def test_state_masks_hands():
    s, toks = make_session(2, seed=14)
    st0 = s.state_for(toks[0])
    g0 = st0["game"]
    assert g0["my_seat"] == 0
    assert len(g0["hand"]) == 13
    assert all(x["cards_left"] == 13 for x in g0["seats"])
    # nothing has been played: no card of seat 0's hand may reach seat 1
    import json
    blob = json.dumps(s.state_for(toks[1]))
    for c in s.g["hands"][0]:
        assert '"%s"' % c not in blob
    spec = s.state_for(None)
    assert spec["game"]["my_seat"] is None and spec["game"]["hand"] is None
    assert spec["game"]["my_pass"] is None and spec["game"]["legal"] is None


def test_legal_list_only_on_your_turn():
    s, toks = make_session(1)
    pass_all(s)
    st = s.state_for(toks[0])
    g = st["game"]
    if s.g["turn"] == 0:
        assert g["legal"] == [rules.TWO_CLUBS]
    else:
        assert g["legal"] is None


def test_disconnect_seat_goes_autopilot():
    s, toks = make_session(2, seed=15)
    s.leave(toks[1])
    st = s.state_for(toks[0])
    seat1 = [x for x in st["game"]["seats"] if x["seat"] == 1][0]
    assert seat1["auto"]
    # last human gone -> game abandoned
    s.leave(toks[0])
    assert s.phase == "lobby"
    assert not any(p.is_bot for p in s.players.values())


def test_settings_validation():
    s = HeartsSession(rng=random.Random(1))
    assert s.validate_settings({"target": 50}) == {"target": 50}
    assert s.validate_settings({"target": 75}) == {}
    assert s.validate_settings({"target": True}) == {}
    assert s.validate_settings({"difficulty": "rookie"}) == {"difficulty": "rookie"}
    assert s.validate_settings({"difficulty": "impossible"}) == {}
    assert s.validate_settings({"turn_seconds": 10}) == {"turn_seconds": 10}
    assert s.validate_settings({"turn_seconds": 5}) == {}
    assert s.validate_settings({"turn_seconds": 65}) == {}
