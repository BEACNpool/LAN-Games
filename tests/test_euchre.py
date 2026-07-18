import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from games.euchre import rules
from games.euchre.game import EuchreSession


# ---------------- rules primitives ----------------

def test_deck():
    assert len(rules.DECK) == 24
    assert len(set(rules.DECK)) == 24
    assert all(c[0] in "9TJQKA" and c[1] in "SHDC" for c in rules.DECK)


def test_deal_shape_and_packets():
    rng = random.Random(5)
    hands, upcard, kitty = rules.deal(rng, dealer=3)
    allc = [c for h in hands.values() for c in h] + [upcard] + kitty
    assert len(allc) == 24 and len(set(allc)) == 24
    assert all(len(h) == 5 for h in hands.values())
    assert len(kitty) == 3
    # packets 3-2 / 2-3 starting left of the dealer: replicate the shuffle
    deck = list(rules.DECK)
    random.Random(5).shuffle(deck)
    assert hands[0] == deck[0:3] + deck[10:12]      # eldest: 3 then 2
    assert hands[1] == deck[3:5] + deck[12:15]      # next: 2 then 3
    assert hands[3] == deck[8:10] + deck[17:20]     # dealer last
    assert upcard == deck[20] and kitty == deck[21:24]


def test_bower_identity():
    for trump, mate in (("S", "C"), ("C", "S"), ("H", "D"), ("D", "H")):
        right, left = "J" + trump, "J" + mate
        assert rules.is_right(right, trump) and not rules.is_left(right, trump)
        assert rules.is_left(left, trump) and not rules.is_right(left, trump)
        # THE rule: the left bower IS a trump-suit card
        assert rules.effective_suit(left, trump) == trump
        assert rules.effective_suit(right, trump) == trump
        # the other two jacks are plain
        for s in "SHDC":
            if s not in (trump, mate):
                assert rules.effective_suit("J" + s, trump) == s
    # no trump named yet: jacks are just jacks
    assert rules.effective_suit("JH", None) == "H"


def test_trump_ranking_order():
    # right, left, A, K, Q, T, 9 — strictly descending
    order = ["JD", "JH", "AD", "KD", "QD", "TD", "9D"]
    ranks = [rules.trump_rank(c, "D") for c in order]
    assert ranks == sorted(ranks, reverse=True)
    assert len(set(ranks)) == len(ranks)


def test_left_bower_must_follow_trump():
    # trump D led with AD; hand holds JH (left bower) + clubs: MUST follow
    legal = rules.legal_plays(["JH", "9C", "KC"], [(0, "AD")], "D")
    assert legal == ["JH"]


def test_left_bower_is_not_its_natural_suit():
    # hearts led, trump D: JH is a DIAMOND now — holder is void in hearts
    legal = rules.legal_plays(["JH", "9C", "KC"], [(0, "AH")], "D")
    assert set(legal) == {"JH", "9C", "KC"}
    # and with a real heart in hand, the JH is NOT a legal follow
    legal = rules.legal_plays(["JH", "TH", "KC"], [(0, "AH")], "D")
    assert legal == ["TH"]


def test_leading_left_bower_leads_trump():
    # left bower led: followers must play trump, and it beats the trump ace? no —
    # A of trump loses to the left bower
    trick = [(0, "JH"), (1, "AD"), (2, "9D"), (3, "AH")]
    assert rules.trick_winner(trick, "D") == 0
    # right bower beats left bower beats trump ace
    trick = [(0, "JH"), (1, "AD"), (2, "JD"), (3, "9D")]
    assert rules.trick_winner(trick, "D") == 2


def test_trick_winner_no_trump():
    # nobody trumped: highest of led suit wins; off-suit ace is trash
    trick = [(0, "TH"), (1, "KH"), (2, "AC"), (3, "9H")]
    assert rules.trick_winner(trick, "S") == 1


def test_trick_winner_trump_beats_led_ace():
    trick = [(0, "AH"), (1, "9S"), (2, "KH"), (3, "QH")]
    assert rules.trick_winner(trick, "S") == 1


def test_three_handed_trick():
    # lone hands play 3-card tricks
    trick = [(1, "AH"), (2, "9H"), (3, "KH")]
    assert rules.trick_winner(trick, "S") == 1


def test_score_hand_all_cases():
    # makers 3 or 4 tricks -> 1 point
    for mt in (3, 4):
        r = rules.score_hand(0, {0: mt, 1: 5 - mt}, alone=False)
        assert (r["team"], r["points"], r["euchred"], r["march"]) == (0, 1, False, False)
    # march -> 2
    r = rules.score_hand(1, {0: 0, 1: 5}, alone=False)
    assert (r["team"], r["points"], r["march"]) == (1, 2, True)
    # alone march -> 4
    r = rules.score_hand(1, {0: 0, 1: 5}, alone=True)
    assert (r["team"], r["points"], r["march"]) == (1, 4, True)
    # alone 3-4 -> still 1
    r = rules.score_hand(0, {0: 4, 1: 1}, alone=True)
    assert (r["team"], r["points"]) == (0, 1)
    # euchred -> defenders 2
    r = rules.score_hand(0, {0: 2, 1: 3}, alone=False)
    assert (r["team"], r["points"], r["euchred"]) == (1, 2, True)
    r = rules.score_hand(1, {0: 5, 1: 0}, alone=True)
    assert (r["team"], r["points"], r["euchred"]) == (0, 2, True)


# ---------------- session ----------------

def make_session(n_humans=1, seating="partners", seed=11, **settings):
    s = EuchreSession(rng=random.Random(seed))
    toks = []
    for i in range(n_humans):
        tok = f"human-token-{i:02d}"
        s.join(tok, f"H{i}", None)
        s.set_ready(tok, True)
        toks.append(tok)
    s.settings["seating"] = seating
    s.settings.update(settings)
    fx = s.start(toks[0])
    assert s.phase == "countdown", fx
    s.tick(s.gen)
    return s, toks


def no_invalid(fx):
    assert not any(f["kind"] == "invalid" for f in fx), fx
    return fx


def test_seating_and_bots():
    s, toks = make_session(1)
    assert s.phase == "bidding1"
    assert s.g["seats"][0] == toks[0]
    assert all(s.players[s.g["seats"][i]].is_bot for i in (1, 2, 3))
    s2, toks2 = make_session(2, "partners", seed=12)
    assert s2.g["seats"][0] == toks2[0] and s2.g["seats"][2] == toks2[1]
    s3, toks3 = make_session(2, "mixed", seed=13)
    assert s3.g["seats"][0] == toks3[0] and s3.g["seats"][1] == toks3[1]
    s4, toks4 = make_session(4, seed=14)
    assert s4.g["seats"] == toks4
    assert not any(p.is_bot for p in s4.players.values())


def test_deal_is_clean_and_turn_starts_left_of_dealer():
    s, _ = make_session(1)
    g = s.g
    allc = [c for h in g["hands"].values() for c in h] + [g["upcard"]] + g["kitty"]
    assert len(allc) == 24 and len(set(allc)) == 24
    assert all(len(h) == 5 for h in g["hands"].values())
    assert g["turn"] == (g["dealer"] + 1) % 4


def test_order_up_pickup_and_discard():
    s, _ = make_session(4)
    g = s.g
    eldest = (g["dealer"] + 1) % 4
    up = g["upcard"]
    no_invalid(s._do_bid(eldest, "order"))
    assert s.phase == "discard"
    assert g["trump"] == up[1]
    assert g["maker"] == eldest and not g["alone"]
    assert g["turn"] == g["dealer"]
    assert len(g["hands"][g["dealer"]]) == 6
    assert up in g["hands"][g["dealer"]]
    # bury any card (trump may legally be buried), face-down
    bury = g["hands"][g["dealer"]][0]
    no_invalid(s._do_discard(g["dealer"], bury))
    assert s.phase == "playing"
    assert len(g["hands"][g["dealer"]]) == 5
    assert bury not in g["hands"][g["dealer"]]
    assert g["turn"] == (g["dealer"] + 1) % 4   # eldest leads
    # the buried card and kitty never appear in any serialized state
    for tok in list(s.players) + [None]:
        blob = json.dumps(s.state_for(tok))
        for c in g["kitty"]:
            assert c not in blob or any(c in h for h in g["hands"].values())


def test_bid_validation_and_turn_order():
    s, _ = make_session(4)
    g = s.g
    eldest = (g["dealer"] + 1) % 4
    wrong = (eldest + 1) % 4
    assert any(f["kind"] == "invalid" for f in s._do_bid(wrong, "pass"))
    # round-2 verbs are rejected in round 1
    assert any(f["kind"] == "invalid" for f in s._do_bid(eldest, "call", suit="H"))
    assert any(f["kind"] == "invalid" for f in s._do_bid(eldest, "bogus"))
    no_invalid(s._do_bid(eldest, "pass"))
    assert g["turn"] == wrong


def test_all_pass_turns_it_down():
    s, _ = make_session(4)
    g = s.g
    up_suit = g["upcard"][1]
    for _ in range(4):
        fx = no_invalid(s._do_bid(g["turn"], "pass"))
    assert any(f["kind"] == "turned_down" for f in fx)
    assert s.phase == "bidding2"
    assert g["turned_down"] == up_suit
    assert g["turn"] == (g["dealer"] + 1) % 4
    # the turned-down suit may not be named
    fx = s._do_bid(g["turn"], "call", suit=up_suit)
    assert any(f["kind"] == "invalid" for f in fx)
    # ordering is over
    fx = s._do_bid(g["turn"], "order")
    assert any(f["kind"] == "invalid" for f in fx)
    # a legal call goes straight to play — no pickup in round 2
    other = next(x for x in "SHDC" if x != up_suit)
    no_invalid(s._do_bid(g["turn"], "call", suit=other))
    assert s.phase == "playing"
    assert g["trump"] == other
    assert all(len(h) == 5 for h in g["hands"].values())


def test_stick_the_dealer():
    s, _ = make_session(4, stick_dealer=True)
    g = s.g
    for _ in range(4):
        no_invalid(s._do_bid(g["turn"], "pass"))
    for _ in range(3):
        no_invalid(s._do_bid(g["turn"], "pass"))
    assert g["turn"] == g["dealer"]
    fx = s._do_bid(g["dealer"], "pass")
    assert any(f["kind"] == "invalid" for f in fx)
    assert s.phase == "bidding2"          # still stuck
    other = next(x for x in "SHDC" if x != g["turned_down"])
    no_invalid(s._do_bid(g["dealer"], "call", suit=other))
    assert s.phase == "playing" and g["maker"] == g["dealer"]


def test_no_stick_throw_in_redeals():
    s, _ = make_session(4, stick_dealer=False)
    g = s.g
    old_dealer, old_hand_no = g["dealer"], g["hand_no"]
    for _ in range(4):
        no_invalid(s._do_bid(g["turn"], "pass"))
    for _ in range(3):
        no_invalid(s._do_bid(g["turn"], "pass"))
    fx = no_invalid(s._do_bid(g["dealer"], "pass"))
    assert any(f["kind"] == "redeal" for f in fx)
    assert s.phase == "bidding1"
    assert g["dealer"] == (old_dealer + 1) % 4
    assert g["hand_no"] == old_hand_no + 1
    assert all(len(h) == 5 for h in g["hands"].values())


def play_full_hand(s):
    """Drive the whole hand with lowest-index legal plays. Returns plays."""
    n = 0
    while s.phase == "playing" and n < 40:
        seat = s.g["turn"]
        legal = rules.legal_plays(s.g["hands"][seat], s.g["trick"], s.g["trump"])
        no_invalid(s._do_play(seat, legal[0]))
        n += 1
    return n


def test_full_hand_to_scoring():
    s, _ = make_session(4)
    g = s.g
    no_invalid(s._do_bid(g["turn"], "order"))
    no_invalid(s._do_discard(g["dealer"], g["hands"][g["dealer"]][0]))
    plays = play_full_hand(s)
    assert plays == 20
    assert s.phase == "hand_end"
    hr = g["hand_result"]
    assert hr["tricks"]["0"] + hr["tricks"]["1"] == 5
    assert hr["points"] in (1, 2, 4)
    assert g["scores"][hr["scoring_team"]] == hr["points"]
    if hr["euchred"]:
        assert hr["scoring_team"] != hr["maker_team"] and hr["points"] == 2
    else:
        assert hr["scoring_team"] == hr["maker_team"]


def test_follow_suit_enforced_with_left_bower():
    s, _ = make_session(4)
    g = s.g
    eldest = (g["dealer"] + 1) % 4
    # rig the hands: trump hearts ordered; eldest leads a heart; next seat
    # holds ONLY the left bower (JD) as its "trump" plus clubs
    nxt = (eldest + 2) % 4  # keep dealer's 6th-card pickup out of the way
    no_invalid(s._do_bid(eldest, "order"))
    trump = g["trump"]
    left = "J" + rules.SAME_COLOR[trump]
    no_invalid(s._do_discard(g["dealer"], g["hands"][g["dealer"]][0]))
    # find the left bower's owner and force a trump lead scenario around it
    owner = next(sq for sq in range(4) if left in g["hands"][sq])
    lead_seat = g["turn"]
    if owner == lead_seat:
        # owner leads the left bower: it leads TRUMP, not its natural suit
        no_invalid(s._do_play(lead_seat, left))
        nxt = g["turn"]
        follow = [c for c in g["hands"][nxt]
                  if rules.effective_suit(c, trump) == trump]
        off = [c for c in g["hands"][nxt]
               if rules.effective_suit(c, trump) != trump]
        if follow and off:
            fx = s._do_play(nxt, off[0])
            assert any(f["kind"] == "invalid" for f in fx)
            no_invalid(s._do_play(nxt, follow[0]))
    else:
        # someone else leads; if trump gets led while owner must follow,
        # the engine forces the left bower to count as trump
        legal = rules.legal_plays(g["hands"][lead_seat], [], trump)
        trump_leads = [c for c in legal
                       if rules.effective_suit(c, trump) == trump]
        if trump_leads:
            no_invalid(s._do_play(lead_seat, trump_leads[0]))
            while g["turn"] != owner and s.phase == "playing" and g["trick"]:
                sq = g["turn"]
                lg = rules.legal_plays(g["hands"][sq], g["trick"], trump)
                no_invalid(s._do_play(sq, lg[0]))
            if g["trick"] and g["turn"] == owner:
                only_left = [c for c in g["hands"][owner]
                             if rules.effective_suit(c, trump) == trump] == [left]
                if only_left:
                    off = [c for c in g["hands"][owner] if c != left]
                    if off:
                        fx = s._do_play(owner, off[0])
                        assert any(f["kind"] == "invalid" for f in fx)
                    no_invalid(s._do_play(owner, left))


def test_going_alone_partner_benched():
    s, _ = make_session(4)
    g = s.g
    eldest = (g["dealer"] + 1) % 4
    no_invalid(s._do_bid(eldest, "order", alone=True))
    assert g["alone"] and g["maker"] == eldest
    assert g["sitting_out"] == (eldest + 2) % 4
    # dealer isn't the benched one here (eldest+2 != dealer), so pickup runs
    assert s.phase == "discard"
    no_invalid(s._do_discard(g["dealer"], g["hands"][g["dealer"]][0]))
    assert s.phase == "playing"
    # lone bidder's LEFT leads
    assert g["turn"] == (eldest + 1) % 4
    plays = play_full_hand(s)
    assert plays == 15                     # 5 tricks x 3 players
    assert s.phase == "hand_end"
    hr = g["hand_result"]
    assert hr["alone"]
    # the benched hand never played a card
    assert len(g["hands"][g["sitting_out"]]) == 5
    assert g["tricks_won"][g["sitting_out"]] == 0


def test_alone_when_dealer_is_partner_skips_discard():
    s, _ = make_session(4)
    g = s.g
    maker = (g["dealer"] + 2) % 4          # dealer's partner
    no_invalid(s._do_bid(g["turn"], "pass"))
    assert g["turn"] == maker
    no_invalid(s._do_bid(maker, "order", alone=True))
    # the benched partner IS the dealer: no pickup, straight to play
    assert g["sitting_out"] == g["dealer"]
    assert s.phase == "playing"
    assert len(g["hands"][g["dealer"]]) == 5
    assert g["turn"] == (maker + 1) % 4


def test_timeout_autoplays_every_phase():
    s, _ = make_session(1, seed=21)
    assert s.phase == "bidding1"
    for _ in range(30):
        if s.phase == "playing":
            break
        s.tick(s.gen)                      # autopilot bids/discards
    assert s.phase == "playing"
    before = sum(len(s.g["hands"][x]) for x in range(4)
                 if x != s.g["sitting_out"])
    s.tick(s.gen)                          # play timeout auto-plays a card
    after = sum(len(s.g["hands"][x]) for x in range(4)
                if x != s.g["sitting_out"])
    assert after == before - 1


def test_match_end_at_target():
    s, _ = make_session(4, target=5)
    g = s.g
    g["scores"][0] = 4
    g["scores"][1] = 4
    no_invalid(s._do_bid(g["turn"], "order"))
    no_invalid(s._do_discard(g["dealer"], g["hands"][g["dealer"]][0]))
    play_full_hand(s)
    assert s.phase == "hand_end"
    s.tick(s.gen)
    assert s.phase == "game_end"
    r = g["result"]
    assert r["winner_team"] in (0, 1)
    assert int(r["scores"][str(r["winner_team"])]) >= 5


def test_state_masks_hands_and_upcard_visibility():
    s, toks = make_session(2, seed=31)
    g = s.g
    st0 = s.state_for(toks[0])["game"]
    assert st0["my_seat"] == 0
    assert len(st0["hand"]) == 5
    assert st0["upcard"] == g["upcard"]    # public in round 1
    blob = json.dumps(s.state_for(toks[1]))
    for c in g["hands"][0]:
        assert '"%s"' % c not in blob
    for c in g["kitty"]:
        assert '"%s"' % c not in blob
    spec = s.state_for(None)["game"]
    assert spec["my_seat"] is None and spec["hand"] is None
    # after the turn-down the upcard face leaves the state
    for _ in range(4):
        s._do_bid(g["turn"], "pass")
    assert s.state_for(toks[0])["game"]["upcard"] is None
    assert s.state_for(toks[0])["game"]["turned_down"] == g["upcard"][1]


def test_disconnect_goes_autopilot_and_abandon():
    s, toks = make_session(2)
    s.leave(toks[1])
    st = s.state_for(toks[0])
    seat2 = [x for x in st["game"]["seats"] if x["seat"] == 2][0]
    assert seat2["auto"]
    s.leave(toks[0])
    assert s.phase == "lobby"
    assert not any(p.is_bot for p in s.players.values())


def drive_bot_game(seed, difficulty="standard", target=5):
    """A full match on autopilot: bots via run_bot, the human seat via the
    turn-timeout path (tick). Every action must be legal."""
    s, toks = make_session(1, seed=seed, target=target,
                           difficulty=difficulty)
    guard = 0
    while s.phase != "game_end" and guard < 3000:
        guard += 1
        if s.phase in ("bidding1", "bidding2", "discard", "playing"):
            due = s.next_bot_action()
            if due is None:                # human seat: timeout -> autopilot
                no_invalid(s.tick(s.gen))
                continue
            delay, tok = due
            assert 0 < delay < 5
            fx = s.run_bot(tok)
            no_invalid(fx)
        elif s.phase == "hand_end":
            hr = s.g["hand_result"]
            assert hr["tricks"]["0"] + hr["tricks"]["1"] == 5
            assert hr["points"] in (1, 2, 4)
            s.tick(s.gen)
        else:
            raise AssertionError(s.phase)
    assert s.phase == "game_end", "game never finished (seed %d)" % seed
    r = s.g["result"]
    assert int(r["scores"][str(r["winner_team"])]) >= target
    return s


def test_seeded_bot_games_stay_legal():
    for seed in (1, 7, 42):
        drive_bot_game(seed, "standard")
    drive_bot_game(99, "rookie")
