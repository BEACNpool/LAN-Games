import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from games.blitz import categories
from games.blitz.categories import (
    CATEGORIES, DECKS, DEFAULT_DECK_SLUGS, deck_meta, draw, norm,
)
from games.blitz.game import BlitzSession


# ---------------- bank integrity ----------------

def test_bank_size_and_shape():
    assert len(CATEGORIES) >= 400, len(CATEGORIES)
    for c in CATEGORIES:
        assert set(c) == {"cat", "deck", "spice"}, c
        assert isinstance(c["cat"], str) and 3 <= len(c["cat"]) <= 60, c
        assert c["deck"] in DECKS, c
        assert c["spice"] in (1, 2), c
        assert norm(c["cat"]), c            # every category must normalize


def test_every_deck_present_and_stocked():
    for slug in DECKS:
        cats = [c for c in CATEGORIES if c["deck"] == slug]
        assert len(cats) >= 35, (slug, len(cats))
    assert {c["deck"] for c in CATEGORIES} == set(DECKS)


def test_no_duplicate_categories_by_normalized_text():
    seen = {}
    for c in CATEGORIES:
        key = norm(c["cat"])
        assert key not in seen, (c["cat"], seen.get(key))
        seen[key] = c["cat"]


def test_kids_zone_is_all_easy():
    assert all(c["spice"] == 1 for c in CATEGORIES if c["deck"] == "kids")


def test_default_decks_exclude_spice2_heavy():
    # TIME MACHINE is deliberately >50% spice-2 -> off by default
    assert "time" not in DEFAULT_DECK_SLUGS
    for slug in ("easy", "kids", "house", "food", "grab"):
        assert slug in DEFAULT_DECK_SLUGS, slug


def test_deck_meta():
    meta = deck_meta()
    assert len(meta) == len(DECKS)
    for m in meta:
        assert m["count"] >= 35
        assert 0 <= m["hard"] <= m["count"]
        assert m["default"] == (m["slug"] in DEFAULT_DECK_SLUGS)


# ---------------- draw ----------------

def test_draw_no_repeats_and_deterministic():
    a = draw(list(DECKS), 12, seed=42)
    b = draw(list(DECKS), 12, seed=42)
    assert a == b
    assert len(a) == 12
    keys = [norm(c["cat"]) for c in a]
    assert len(keys) == len(set(keys))


def test_draw_respects_deck_filter():
    for c in draw(["kids"], 12, seed=7):
        assert c["deck"] == "kids"
    for c in draw(["easy", "food"], 12, seed=7):
        assert c["deck"] in ("easy", "food")


def test_draw_family_weights_easy():
    fam = wild = 0
    for seed in range(60):
        fam += sum(1 for c in draw(list(DECKS), 12, seed) if c["spice"] == 2)
        wild += sum(1 for c in draw(list(DECKS), 12, seed, wild=True)
                    if c["spice"] == 2)
    assert fam < wild, (fam, wild)


# ---------------- the normalizer ----------------

def test_norm_table():
    same = [
        ("The Lions", "lion"),
        ("ice-cream", "ice cream"),
        ("Fries ", "fries"),
        ("fries", "fry"),                    # y->ie canonical form
        ("cookies", "Cookie"),
        ("cities", "city"),
        ("A Penguin!", "penguins"),
        ("Mac & Cheese", "mac and cheese"),
        ("McDonald's", "mcdonalds"),
        ("monkeys", "monkey"),
        ("  Déjà   Vu ", "deja vu"),
        ("boxes", "box"),
        ("dishes", "dish"),
        ("glasses", "glass"),
        ("101 Dalmatians", "101 dalmatian"),
        ("don't know", "dont know"),
    ]
    for a, b in same:
        assert norm(a) == norm(b), (a, norm(a), b, norm(b))


def test_norm_exceptions_not_mangled():
    # words that end in s but must survive intact
    for w in ("glass", "chess", "bus", "gas", "tennis", "octopus",
              "news", "lens", "series", "species"):
        assert norm(w) == w, (w, norm(w))


def test_norm_no_false_merges():
    diff = [("dog", "cat"), ("lion", "lioness"), ("apple", "apples juice"),
            ("star war", "star trek")]
    for a, b in diff:
        assert norm(a) != norm(b), (a, b)


def test_norm_junk():
    assert norm("") == ""
    assert norm("   ") == ""
    assert norm("the") == ""
    assert norm("!!!") == ""


# ---------------- session helpers ----------------

def make_session(n=2, seed=5, **settings):
    s = BlitzSession(rng=random.Random(seed))
    toks = []
    for i in range(n):
        tok = f"bz-token-{i:02d}xx"
        s.join(tok, f"P{i}", None)
        s.set_ready(tok, True)
        toks.append(tok)
    s.settings.update(settings)
    s.start(toks[0])
    s.tick(s.gen)                  # countdown -> game_start -> intro
    return s, toks


def begin_blitz(s):
    assert s.phase == "intro"
    s.tick(s.gen)
    assert s.phase == "blitz"


def answer(s, tok, *texts):
    return s.game_action(tok, {"t": "answer", "texts": list(texts)})


def pid(s, tok):
    return s.players[tok].pid


# ---------------- round flow + cancellation math ----------------

def test_round_flow_and_masking():
    s, (a, b) = make_session(2)
    assert s.phase == "intro"
    st = s.state_for(a)["game"]
    assert st["cat"] and st["rounds"] == 5
    begin_blitz(s)
    answer(s, a, "pizza", "secret unicorn")
    # b must never see a's text mid-round — only the count
    blob = json.dumps(s.state_for(b))
    assert "secret unicorn" not in blob
    assert s.state_for(b)["game"]["counts"][pid(s, a)] == 2
    # spectator state is masked too
    assert "secret unicorn" not in json.dumps(s.state_for(None))
    # a sees their own list
    assert s.state_for(a)["game"]["mine"] == ["pizza", "secret unicorn"]


def test_cancellation_two_players():
    s, (a, b) = make_session(2)
    begin_blitz(s)
    answer(s, a, "pizza", "sushi")
    answer(s, b, "The Pizzas!!", "tacos")     # normalizes onto a's pizza
    s.tick(s.gen)                             # sand out -> score
    assert s.phase == "reveal"
    rv = s.g["reveal"]
    rows = {r["pid"]: r for r in rv["rows"]}
    ra, rb = rows[pid(s, a)], rows[pid(s, b)]
    assert ra["answers"][0]["pts"] == 0 and ra["answers"][0]["group"] == 0
    assert ra["answers"][0]["with"] == [pid(s, b)]
    assert ra["answers"][1]["pts"] == 10 and ra["answers"][1]["group"] is None
    assert rb["answers"][0]["pts"] == 0
    assert ra["gain"] == 10 and rb["gain"] == 10
    assert s.g["scores"][a] == 10 and s.g["scores"][b] == 10


def test_cancellation_three_way_match():
    s, (a, b, c) = make_session(3)
    begin_blitz(s)
    answer(s, a, "pizza", "sushi")
    answer(s, b, "pizza")
    answer(s, c, "pizza", "tacos", "sushi")
    s.tick(s.gen)
    rows = {r["pid"]: r for r in s.g["reveal"]["rows"]}
    # pizza: three-way cancel; sushi: two-way; tacos unique
    assert rows[pid(s, a)]["gain"] == 0
    assert rows[pid(s, b)]["gain"] == 0
    assert rows[pid(s, c)]["gain"] == 10
    pz = rows[pid(s, a)]["answers"][0]
    assert sorted(pz["with"]) == sorted([pid(s, b), pid(s, c)])
    su = rows[pid(s, c)]["answers"][2]
    assert su["pts"] == 0 and su["with"] == [pid(s, a)]


def test_cancellation_four_players_mixed():
    s, toks = make_session(4)
    a, b, c, d = toks
    begin_blitz(s)
    answer(s, a, "lion", "zebra", "elephant")
    answer(s, b, "lions")                     # cancels a's lion
    answer(s, c, "Zebras", "giraffe")         # cancels a's zebra
    answer(s, d, "hippo")
    s.tick(s.gen)
    rows = {r["pid"]: r for r in s.g["reveal"]["rows"]}
    assert rows[pid(s, a)]["gain"] == 10      # only elephant survives
    assert rows[pid(s, b)]["gain"] == 0
    assert rows[pid(s, c)]["gain"] == 10      # giraffe
    assert rows[pid(s, d)]["gain"] == 10
    assert s.g["reveal"]["groups"] == 2


def test_own_duplicates_deduped_on_entry():
    s, (a, b) = make_session(2)
    begin_blitz(s)
    fx = answer(s, a, "pizza", "The Pizza", "pizzas")
    assert len(s.g["answers"][a]) == 1
    assert sum(1 for f in fx if f["kind"] == "dupe") == 2
    # empties are ignored quietly
    answer(s, a, "", "   ", "the")
    assert len(s.g["answers"][a]) == 1


def test_retract_own_answer():
    s, (a, b) = make_session(2)
    begin_blitz(s)
    answer(s, a, "pizza", "sushi")
    fx = s.game_action(a, {"t": "retract", "text": "Pizza!"})
    assert any(f["kind"] == "retracted" for f in fx)
    assert [x["raw"] for x in s.g["answers"][a]] == ["sushi"]
    # can't retract during reveal
    s.tick(s.gen)
    fx = s.game_action(a, {"t": "retract", "text": "sushi"})
    assert any(f["kind"] == "invalid" for f in fx)
    assert s.g["scores"][a] == 10


def test_answers_rejected_outside_blitz():
    s, (a, b) = make_session(2)
    assert s.phase == "intro"
    assert answer(s, a, "early bird") == []       # quietly ignored
    assert s.g["answers"][a] == []
    begin_blitz(s)
    s.tick(s.gen)                                 # -> reveal
    fx = answer(s, a, "too late")
    assert any(f["kind"] == "invalid" for f in fx)


def test_spectator_cannot_answer():
    s, toks = make_session(2)
    s.join("spec-token-xyz12", "Spec", None)
    begin_blitz(s)
    fx = s.game_action("spec-token-xyz12", {"t": "answer", "text": "hi"})
    assert any(f["kind"] == "invalid" for f in fx)


# ---------------- reveal: tap-to-skip ----------------

def test_tap_to_skip_reveal():
    s, (a, b) = make_session(2)
    begin_blitz(s)
    answer(s, a, "one thing")
    s.tick(s.gen)
    assert s.phase == "reveal"
    s.game_action(a, {"t": "tap"})
    assert s.phase == "reveal"                    # one tap isn't enough
    st = s.state_for(b)["game"]
    assert st["taps"]["done"] == 1 and st["taps"]["need"] == 2
    fx = s.game_action(b, {"t": "tap"})
    assert s.phase == "intro"                     # everyone tapped -> next round
    assert s.g["round_no"] == 2
    assert any(f["kind"] == "round_intro" for f in fx)


def test_tap_ignores_double_and_spectators():
    s, (a, b) = make_session(2)
    s.join("spec-token-xyz12", "Spec", None)
    begin_blitz(s)
    s.tick(s.gen)
    s.game_action(a, {"t": "tap"})
    s.game_action(a, {"t": "tap"})                # double tap: no-op
    s.game_action("spec-token-xyz12", {"t": "tap"})
    assert s.phase == "reveal"


def test_disconnected_player_does_not_block_taps():
    s, (a, b, c) = make_session(3)
    begin_blitz(s)
    s.tick(s.gen)
    assert s.phase == "reveal"
    s.game_action(a, {"t": "tap"})
    s.game_action(b, {"t": "tap"})
    assert s.phase == "reveal"
    s.leave(c)                                    # the holdout drops
    assert s.phase == "intro"                     # reveal advances


def test_bs_call_is_theater_only():
    s, (a, b) = make_session(2)
    begin_blitz(s)
    answer(s, a, "made up thing")
    s.tick(s.gen)
    before = dict(s.g["scores"])
    fx = s.game_action(b, {"t": "bs", "target": pid(s, a),
                           "text": "made up thing"})
    assert any(f["kind"] == "bs" and f["by"] == pid(s, b)
               and f["target"] == pid(s, a) for f in fx)
    assert s.g["scores"] == before


# ---------------- full match ----------------

def play_round(s, plans):
    """plans: {token: [answers...]} for one round, then tap through."""
    begin_blitz(s)
    for tok, texts in plans.items():
        if texts:
            answer(s, tok, *texts)
    s.tick(s.gen)                                 # -> reveal
    assert s.phase == "reveal"
    for tok in list(s.g["answers"]):
        if s.phase == "reveal":
            s.game_action(tok, {"t": "tap"})


def test_full_match_totals_and_best_round():
    s, (a, b) = make_session(2)
    plans = [
        {a: ["red", "blue"], b: ["red"]},           # a +10, b 0
        {a: ["one", "two", "three"], b: []},        # a +30  <- best round
        {a: ["x"], b: ["x"]},                       # both 0
        {a: [], b: ["solo"]},                       # b +10
        {a: ["last"], b: ["different"]},            # both +10
    ]
    for i, plan in enumerate(plans):
        assert s.g["round_no"] == i + 1
        play_round(s, plan)
    assert s.phase == "game_end"
    res = s.g["result"]
    assert s.g["scores"][a] == 50 and s.g["scores"][b] == 20
    rows = {r["pid"]: r for r in res["rows"]}
    assert rows[pid(s, a)]["rank"] == 1 and rows[pid(s, a)]["score"] == 50
    assert rows[pid(s, b)]["rank"] == 2 and rows[pid(s, b)]["score"] == 20
    assert res["winner"] == pid(s, a)
    assert res["best"]["pid"] == pid(s, a) and res["best"]["pts"] == 30
    assert res["best"]["round"] == 2
    assert len(s.g["history"]) == 5


def test_rounds_setting_and_no_category_repeats():
    s, (a, b) = make_session(2, rounds=8)
    seen = []
    while s.phase != "game_end":
        seen.append(s.g["cat"]["cat"])
        play_round(s, {a: [], b: []})
    assert len(seen) == 8
    assert len(seen) == len(set(seen))            # no repeats within a match


def test_tie_ranks():
    s, (a, b) = make_session(2)
    for _ in range(5):
        play_round(s, {a: ["same"], b: ["same"]})
    rows = s.g["result"]["rows"]
    assert [r["rank"] for r in rows] == [1, 1]
    assert s.g["result"]["best"] is None          # nobody ever scored


# ---------------- reconnect / disconnect ----------------

def test_reconnect_restores_typed_list():
    s, (a, b) = make_session(2)
    begin_blitz(s)
    answer(s, a, "pizza", "sushi")
    s.leave(a)                                    # phone died mid-round
    assert s.players[a].connected is False
    assert [x["raw"] for x in s.g["answers"][a]] == ["pizza", "sushi"]
    p, fx = s.join(a, "P0", None)                 # came back
    assert p.connected
    st = s.state_for(a)["game"]
    assert st["mine"] == ["pizza", "sushi"]       # list restored
    answer(s, a, "tacos")                         # and they can keep typing
    assert len(s.g["answers"][a]) == 3


def test_disconnected_answers_still_score_and_cancel():
    s, (a, b) = make_session(2)
    begin_blitz(s)
    answer(s, a, "pizza", "unique thing")
    answer(s, b, "pizza")
    s.leave(a)
    s.tick(s.gen)                                 # score with a gone
    rows = {r["pid"]: r for r in s.g["reveal"]["rows"]}
    assert rows[pid(s, a)]["gain"] == 10          # unique still scores
    assert rows[pid(s, b)]["gain"] == 0           # pizza still cancelled
    # and b alone can tap the reveal away
    s.game_action(b, {"t": "tap"})
    assert s.phase == "intro"


# ---------------- settings ----------------

def test_validate_settings():
    s = BlitzSession()
    s.join("bz-token-00xx", "P0", None)
    ok = s.validate_settings({"rounds": 8, "seconds": 60,
                              "decks": ["kids", "kids", "nope", "easy"],
                              "spice": "wild"})
    assert ok == {"rounds": 8, "seconds": 60,
                  "decks": ["kids", "easy"], "spice": "wild"}
    assert s.validate_settings({"rounds": 7}) == {}
    assert s.validate_settings({"rounds": True}) == {}
    assert s.validate_settings({"seconds": 31}) == {}
    assert s.validate_settings({"decks": []}) == {}       # never empty
    assert s.validate_settings({"decks": "kids"}) == {}
    assert s.validate_settings({"spice": "nuclear"}) == {}


def test_state_carries_deck_meta():
    s = BlitzSession()
    s.join("bz-token-00xx", "P0", None)
    st = s.state_for("bz-token-00xx")
    slugs = {d["slug"] for d in st["decks"]}
    assert slugs == set(DECKS)
    assert st["settings"]["decks"] == DEFAULT_DECK_SLUGS
