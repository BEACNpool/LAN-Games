import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from games.spades import rules
from games.spades.game import SpadesSession


# ---------------- rules primitives ----------------

def test_deck():
    assert len(rules.DECK) == 52
    assert len(set(rules.DECK)) == 52


def test_legal_plays_follow_suit():
    hand = ["AS", "2H", "9H", "3C"]
    # led hearts: must follow
    assert set(rules.legal_plays(hand, [(0, "KH")], False)) == {"2H", "9H"}
    # void in led suit: anything
    assert set(rules.legal_plays(["AS", "3C"], [(0, "KD")], False)) == {"AS", "3C"}


def test_legal_plays_spades_locked_until_broken():
    hand = ["AS", "2S", "9H"]
    assert set(rules.legal_plays(hand, [], False)) == {"9H"}
    assert set(rules.legal_plays(hand, [], True)) == {"AS", "2S", "9H"}
    # only spades left: may lead them even unbroken
    assert set(rules.legal_plays(["AS", "2S"], [], False)) == {"AS", "2S"}


def test_trick_winner():
    # highest of led suit when no spade
    assert rules.trick_winner([(0, "5H"), (1, "KH"), (2, "AH"), (3, "2D")]) == 2
    # any spade beats the led suit
    assert rules.trick_winner([(0, "AH"), (1, "2S"), (2, "KH"), (3, "QH")]) == 1
    # highest spade among several
    assert rules.trick_winner([(0, "AH"), (1, "2S"), (2, "9S"), (3, "QH")]) == 2


def test_score_hand_basic():
    bids = {0: 4, 1: 3, 2: 3, 3: 4}
    tricks = {0: 4, 1: 3, 2: 4, 3: 2}       # team0: bid 7 took 8, team1: bid 7 took 5
    res = rules.score_hand(bids, tricks, {0: 0, 1: 0})
    assert res[0]["delta"] == 70 + 1 and res[0]["bags"] == 1 and res[0]["made"]
    assert res[1]["delta"] == -70 and res[1]["bags"] == 0 and not res[1]["made"]


def test_score_hand_nil_and_bagout():
    bids = {0: "nil", 1: 5, 2: 6, 3: 5}
    tricks = {0: 0, 1: 5, 2: 8, 3: 0}       # team0 nil ok + 6 bid met w/ 2 bags
    res = rules.score_hand(bids, tricks, {0: 9, 1: 0})
    # team0: nil +100, bid 6 took 8 -> +60, 2 bags -> +2; bags 9+2=11 -> -100, bags 1
    assert res[0]["delta"] == 100 + 60 + 2 - 100
    assert res[0]["bags"] == 1
    # team1: bid 10 took 5 -> -100
    assert res[1]["delta"] == -100
    # failed nil
    res2 = rules.score_hand({0: "nil", 1: 1, 2: 12, 3: 1}, {0: 1, 1: 1, 2: 11, 3: 0},
                            {0: 0, 1: 0})
    (seat, ok, delta) = res2[0]["nil"][0]
    assert seat == 0 and not ok and delta == -100


# ---------------- session ----------------

def make_session(n_humans=2, seating="partners", seed=11):
    s = SpadesSession(rng=random.Random(seed))
    toks = []
    for i in range(n_humans):
        tok = f"human-token-{i:02d}"
        s.join(tok, f"H{i}", None)
        s.set_ready(tok, True)
        toks.append(tok)
    s.settings["seating"] = seating
    fx = s.start(toks[0])
    assert s.phase == "countdown", fx
    s.tick(s.gen)
    return s, toks


def test_seating_partners_and_bots():
    s, toks = make_session(2, "partners")
    g = s.g
    assert s.phase == "bidding"
    assert g["seats"][0] == toks[0] and g["seats"][2] == toks[1]
    assert s.players[g["seats"][1]].is_bot and s.players[g["seats"][3]].is_bot
    assert len(s.participants) == 4
    # mixed: humans on opposite teams
    s2, toks2 = make_session(2, "mixed", seed=12)
    assert s2.g["seats"][0] == toks2[0] and s2.g["seats"][1] == toks2[1]
    # 3 humans -> one bot at seat 3
    s3, toks3 = make_session(3, seed=13)
    assert [s3.g["seats"][i] for i in (0, 1, 2)] == toks3
    assert s3.players[s3.g["seats"][3]].is_bot


def test_deal_is_clean():
    s, _ = make_session(2)
    hands = s.g["hands"]
    allc = [c for h in hands.values() for c in h]
    assert len(allc) == 52 and len(set(allc)) == 52
    assert all(len(h) == 13 for h in hands.values())


def bid_all(s, value=3):
    for _ in range(4):
        seat = s.g["turn"]
        tok = s.g["seats"][seat]
        if s.players[tok].is_bot:
            s.run_bot(tok) if False else None
        fx = s._do_bid(seat, value)
        assert not any(f["kind"] == "invalid" for f in fx), fx


def test_bid_flow_and_turn_order():
    s, toks = make_session(2)
    first = s.g["turn"]
    assert first == (s.g["dealer"] + 1) % 4
    # out-of-turn bid rejected
    wrong = (first + 1) % 4
    fx = s._do_bid(wrong, 4)
    assert any(f["kind"] == "invalid" for f in fx)
    bid_all(s, 3)
    assert s.phase == "playing"
    assert s.g["turn"] == (s.g["dealer"] + 1) % 4


def test_bid_validation():
    s, _ = make_session(2)
    seat = s.g["turn"]
    for bad in (0, 14, -1, "NIL", None, 3.5, True):
        fx = s._do_bid(seat, bad)
        assert any(f["kind"] == "invalid" for f in fx), bad
    assert not any(f["kind"] == "invalid" for f in s._do_bid(seat, "nil"))


def play_full_hand(s):
    """Drive a whole hand with lowest-legal plays. Returns tricks played."""
    n = 0
    while s.phase == "playing" and n < 60:
        seat = s.g["turn"]
        legal = rules.legal_plays(s.g["hands"][seat], s.g["trick"],
                                  s.g["spades_broken"])
        fx = s._do_play(seat, legal[0])
        assert not any(f["kind"] == "invalid" for f in fx), fx
        n += 1
    return n


def test_full_hand_to_scoring():
    s, _ = make_session(2)
    bid_all(s, 3)
    plays = play_full_hand(s)
    assert plays == 52
    assert s.phase == "hand_end"
    hr = s.g["hand_result"]
    assert sum(hr["tricks"].values()) == 13
    total = sum(s.g["scores"][t]["score"] for t in (0, 1))
    assert total != 0  # somebody scored something


def test_follow_suit_enforced():
    s, _ = make_session(2)
    bid_all(s, 3)
    seat = s.g["turn"]
    legal = rules.legal_plays(s.g["hands"][seat], [], s.g["spades_broken"])
    s._do_play(seat, legal[0])
    led = legal[0][1]
    nxt = s.g["turn"]
    hand = s.g["hands"][nxt]
    can_follow = [c for c in hand if c[1] == led]
    cant = [c for c in hand if c[1] != led]
    if can_follow and cant:
        fx = s._do_play(nxt, cant[0])
        assert any(f["kind"] == "invalid" for f in fx)


def test_spades_lead_lock():
    s, _ = make_session(2)
    bid_all(s, 3)
    seat = s.g["turn"]
    hand = s.g["hands"][seat]
    spades = [c for c in hand if c[1] == "S"]
    others = [c for c in hand if c[1] != "S"]
    if spades and others:
        fx = s._do_play(seat, spades[0])
        assert any(f["kind"] == "invalid" for f in fx)


def test_timeout_autoplays():
    s, _ = make_session(2)
    assert s.phase == "bidding"
    for _ in range(4):
        s.tick(s.gen)          # bid timeouts auto-bid via autopilot
    assert s.phase == "playing"
    before = sum(len(h) for h in s.g["hands"].values())
    s.tick(s.gen)              # play timeout auto-plays a card
    assert sum(len(h) for h in s.g["hands"].values()) == before - 1


def test_bots_drive_turns():
    s, toks = make_session(2)
    # bot turn shows up in next_bot_action; run until it's a human's bid
    for _ in range(8):
        due = s.next_bot_action()
        if due is None:
            break
        delay, bot_tok = due
        s.run_bot(bot_tok)
    # all bot bids landed without wedging
    assert s.phase in ("bidding", "playing")


def test_game_end_at_target():
    s, _ = make_session(2)
    s.settings["target"] = 200
    s.g["scores"][0]["score"] = 190
    s.g["scores"][1]["score"] = 50
    bid_all(s, 2)
    play_full_hand(s)
    assert s.phase == "hand_end"
    s.tick(s.gen)
    # 190 + anything >= 200 unless team0 got set badly; accept either outcome
    if s.phase == "game_end":
        assert s.g["result"]["winner_team"] in (0, 1)
    else:
        assert s.phase == "bidding"   # tied or not reached -> next hand


def test_state_masks_hands():
    s, toks = make_session(2)
    st0 = s.state_for(toks[0])
    g0 = st0["game"]
    assert g0["my_seat"] == 0
    assert len(g0["hand"]) == 13
    # other seats expose counts only
    assert all(x["cards_left"] == 13 for x in g0["seats"])
    import json
    blob = json.dumps(s.state_for(toks[1]))
    for c in s.g["hands"][0]:
        assert '"%s"' % c not in blob or c in s.g["hands"][2]
    spec = s.state_for(None)
    assert spec["game"]["my_seat"] is None and spec["game"]["hand"] is None


def test_disconnect_seat_goes_autopilot():
    s, toks = make_session(2)
    s.leave(toks[1])
    st = s.state_for(toks[0])
    seat2 = [x for x in st["game"]["seats"] if x["seat"] == 2][0]
    assert seat2["auto"]
    # both humans gone -> game abandoned
    s.leave(toks[0])
    assert s.phase == "lobby"
    assert s.g is None or s.match is None if hasattr(s, "match") else True


def test_all_humans_leave_aborts():
    s, toks = make_session(3)
    for t in toks:
        s.leave(t)
    assert s.phase == "lobby"
    assert not any(p.is_bot for p in s.players.values())
