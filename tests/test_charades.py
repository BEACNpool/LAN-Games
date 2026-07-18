import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from games.charades import decks
from games.charades.game import CharadesSession, norm, close_enough


# ---------------- content quality ----------------

def test_deck_shapes():
    for slug, d in decks.DECKS.items():
        assert d["title"] and d["icon"] and d["blurb"]
        assert d["difficulty"] in ("easy", "medium", "hard")
        assert len(d["items"]) >= 50, (slug, len(d["items"]))
        for item in d["items"]:
            assert isinstance(item, str) and item.strip()
            display = item.split("|")[0]
            assert 2 <= len(display) <= 48, display
            for part in item.split("|"):
                assert norm(part), item      # every alias must normalize


def test_no_duplicates_within_deck():
    for slug, d in decks.DECKS.items():
        seen = set()
        for item in d["items"]:
            key = norm(item.split("|")[0])
            assert key not in seen, (slug, item)
            seen.add(key)


def test_mix_covers_everything():
    total = {norm(i.split("|")[0])
             for s, d in decks.DECKS.items() if s != "mix"
             for i in d["items"]}
    mix = {norm(i.split("|")[0]) for i in decks.DECKS["mix"]["items"]}
    assert mix == total
    assert len(mix) >= 900   # the promised big library


def test_deck_list_meta():
    dl = decks.deck_list()
    assert any(e["slug"] == "mix" for e in dl)
    assert all(e["count"] > 0 for e in dl)


# ---------------- matching ----------------

def test_norm():
    assert norm("The Lion-King!") == "lionking"
    assert norm("  Déjà   Vu ") == "dejavu"
    assert norm("A Bird in the Hand") == "birdinthehand"
    assert norm("101 Dalmatians") == "101dalmatians"


def test_close_enough():
    assert close_enough(norm("elefant"), norm("elephant"))
    assert close_enough(norm("spiderman"), norm("spidermen"))
    assert not close_enough(norm("dog"), norm("elephant"))
    assert not close_enough(norm("elephant"), norm("elephant"))  # exact isn't "close"


# ---------------- session flow ----------------

def make_session(n=3, seed=5, **settings):
    s = CharadesSession(rng=random.Random(seed))
    toks = []
    for i in range(n):
        tok = f"ch-token-{i:02d}xx"
        s.join(tok, f"P{i}", None)
        s.set_ready(tok, True)
        toks.append(tok)
    s.settings.update(settings)
    s.start(toks[0])
    s.tick(s.gen)
    return s, toks


def actor_of(s):
    return s.g["turn"]["actor"]


def begin_acting(s):
    assert s.phase == "intro"
    s.tick(s.gen)
    assert s.phase == "acting"


def test_flow_and_masking():
    s, toks = make_session(3, rounds=1)
    assert s.phase == "intro"
    act = actor_of(s)
    # only the actor's state carries the subject — before AND during acting
    for tok in toks:
        st = s.state_for(tok)["game"]
        if tok == act:
            assert st["you_act"] and st["subject"]
        else:
            assert not st["you_act"] and st["subject"] is None
    secret = s.g["turn"]["subject"]["display"]
    blob = json.dumps(s.state_for([t for t in toks if t != act][0]))
    assert secret not in blob
    spec = json.dumps(s.state_for(None))
    assert secret not in spec


def test_classic_correct_guess_scores_and_reveals():
    s, toks = make_session(3, rounds=1)
    begin_acting(s)
    act = actor_of(s)
    guesser = [t for t in toks if t != act][0]
    answer = s.g["turn"]["subject"]["display"]
    fx = s.game_action(guesser, {"t": "guess", "text": answer.upper() + "!!"})
    assert any(f["kind"] == "solved" for f in fx), fx
    assert s.phase == "reveal"
    assert s.g["scores"][guesser] >= 100
    assert s.g["scores"][act] == 50
    assert s.g["reveal"]["winner"] == s.players[guesser].pid


def test_wrong_guess_broadcasts_and_near_miss_is_private():
    s, toks = make_session(3, rounds=1)
    begin_acting(s)
    act = actor_of(s)
    guesser = [t for t in toks if t != act][0]
    fx = s.game_action(guesser, {"t": "guess", "text": "zzz nope"})
    assert any(f["kind"] == "guess" and f["to"] is None for f in fx)
    assert not any(f["kind"] == "close" for f in fx)
    # near miss: mangle one letter of the answer
    answer = norm(s.g["turn"]["subject"]["display"])
    typo = answer[:-1] + ("x" if answer[-1] != "x" else "y")
    fx = s.game_action(guesser, {"t": "guess", "text": typo})
    closes = [f for f in fx if f["kind"] == "close"]
    assert closes and closes[0]["to"] == guesser


def test_actor_cannot_guess_but_can_skip():
    s, toks = make_session(3, rounds=1)
    begin_acting(s)
    act = actor_of(s)
    answer = s.g["turn"]["subject"]["display"]
    fx = s.game_action(act, {"t": "guess", "text": answer})
    assert any(f["kind"] == "invalid" for f in fx)
    before = s.g["turn"]["subject"]["display"]
    fx = s.game_action(act, {"t": "skip"})
    assert any(f["kind"] == "skipped" for f in fx)
    assert s.g["turn"]["subject"]["display"] != before
    assert s.g["turn"]["skips_left"] == 1
    s.game_action(act, {"t": "skip"})
    fx = s.game_action(act, {"t": "skip"})
    assert any(f["kind"] == "invalid" for f in fx)   # out of skips
    # guessers can't skip
    guesser = [t for t in toks if t != act][0]
    fx = s.game_action(guesser, {"t": "skip"})
    assert any(f["kind"] == "invalid" for f in fx)


def test_timeout_reveals_with_no_winner():
    s, toks = make_session(2, rounds=1)
    begin_acting(s)
    s.tick(s.gen)
    assert s.phase == "reveal"
    assert s.g["reveal"]["winner"] is None


def test_rotation_and_game_end():
    s, toks = make_session(3, rounds=2)
    actors = []
    for _ in range(6):
        assert s.phase == "intro"
        actors.append(actor_of(s))
        begin_acting(s)
        s.tick(s.gen)          # timeout -> reveal
        assert s.phase == "reveal"
        s.tick(s.gen)          # -> next turn or finish
    assert s.phase == "game_end"
    # everyone acted exactly twice
    from collections import Counter
    assert set(Counter(actors).values()) == {2}
    assert s.g["result"]["rows"]


def test_blitz_chains_subjects():
    s, toks = make_session(2, rounds=1, mode="blitz")
    begin_acting(s)
    act = actor_of(s)
    guesser = [t for t in toks if t != act][0]
    for i in range(3):
        answer = s.g["turn"]["subject"]["display"]
        fx = s.game_action(guesser, {"t": "guess", "text": answer})
        assert any(f["kind"] == "solved" and f["chain"] == i + 1 for f in fx), fx
        assert s.phase == "acting"       # blitz keeps going
    assert s.g["scores"][guesser] == 3 * 60
    assert s.g["scores"][act] == 3 * 25
    s.tick(s.gen)                        # timer out -> reveal with the chain
    assert s.phase == "reveal"
    assert len(s.g["reveal"]["solved"]) == 3


def test_actor_disconnect_skips_turn():
    s, toks = make_session(3, rounds=1)
    begin_acting(s)
    act = actor_of(s)
    fx = s.leave(act)
    assert s.phase == "reveal"
    assert s.g["reveal"]["winner"] is None
    s.tick(s.gen)
    assert s.phase == "intro"            # next actor takes the stage


def test_subjects_never_repeat_until_deck_exhausted():
    s, toks = make_session(2, rounds=4, deck="hard")
    seen = []
    for _ in range(8):
        begin_acting(s)
        seen.append(s.g["turn"]["subject"]["display"])
        s.tick(s.gen)
        if s.phase == "reveal":
            s.tick(s.gen)
    assert len(seen) == len(set(seen))


def test_spectator_cannot_guess():
    s, toks = make_session(2, rounds=1)
    s.join("spec-token-xyz12", "Spec", None)
    begin_acting(s)
    fx = s.game_action("spec-token-xyz12", {"t": "guess", "text": "whatever"})
    assert any(f["kind"] == "invalid" for f in fx)
