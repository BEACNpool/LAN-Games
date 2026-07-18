import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from games.fab5feud.game import Fab5FeudSession, SIDES
from games.fab5feud import surveys

# deterministic bank: answers descending by pts, distinct aliases
BANK = [
    {"q": "Q%d" % k, "answers": [
        {"text": "Apple", "pts": 40, "aliases": ["apple"]},
        {"text": "Banana", "pts": 30, "aliases": ["banana"]},
        {"text": "Cherry", "pts": 20, "aliases": ["cherry"]},
        {"text": "Date", "pts": 10, "aliases": ["date", "dates"]},
    ]} for k in range(8)
]


def make(n=2, seed=1, rounds=3, teams=None):
    s = Fab5FeudSession(rng=random.Random(seed), bank=BANK)
    toks = ["feudtok%03d" % i for i in range(n)]
    for i, t in enumerate(toks):
        s.join(t, "P%d" % i, None)
        s.set_ready(t, True)
    s.settings["rounds"] = rounds
    if teams:
        for t, side in zip(toks, teams):
            s.teams[t] = side
    s.start(toks[0])
    s.tick(s.gen)                     # countdown -> game_start -> faceoff
    return s, toks


def guess(s, tok, word):
    return s.game_action(tok, {"t": "guess", "word": word})


def rep(s, side):
    return s.g["round"]["reps"][side]


# ---------------- matching ----------------

def test_match_normalizes():
    ans = BANK[0]["answers"]
    assert surveys.match_answer("apple", ans) == 0
    assert surveys.match_answer("  The APPLE ", ans) == 0
    assert surveys.match_answer("dates", ans) == 3        # singularized
    assert surveys.match_answer("grape", ans) is None


def test_match_exact_beats_shorter_containment():
    # the review's case: "toilet paper" must hit "Toilet Paper", not "Toilet"
    ans = [
        {"text": "Toilet", "pts": 40, "aliases": ["toilet"]},
        {"text": "Toilet Paper", "pts": 20, "aliases": ["toilet paper", "tp"]},
    ]
    assert surveys.match_answer("toilet paper", ans) == 1
    assert surveys.match_answer("the toilet", ans) == 0
    assert surveys.match_answer("i need some toilet paper", ans) == 1   # longest phrase wins


# ---------------- teams ----------------

def test_head_to_head_names_are_players():
    s, toks = make(2)
    assert s.g["names"]["A"] == "P0" and s.g["names"]["B"] == "P1"
    assert s.g["roster"]["A"] == [toks[0]] and s.g["roster"]["B"] == [toks[1]]


def test_teams_mode_splits_and_labels():
    s, toks = make(4, teams=["A", "A", "B", "B"])
    assert s.g["roster"]["A"] == [toks[0], toks[1]]
    assert s.g["names"]["A"] == "TEAM A" and s.g["names"]["B"] == "TEAM B"


def test_lobby_team_pick_before_start():
    s = Fab5FeudSession(rng=random.Random(1), bank=BANK)
    for i in range(2):
        s.join("feudtok%03d" % i, "P%d" % i, None)
        s.set_ready("feudtok%03d" % i, True)
    s.game_action("feudtok000", {"t": "team", "side": "B"})
    assert s.teams["feudtok000"] == "B"
    st = s.state_for("feudtok000")
    assert st["ff"]["my_side"] == "B"


# ---------------- faceoff ----------------

def test_faceoff_higher_answer_takes_control():
    s, toks = make(2)
    guess(s, rep(s, "A"), "cherry")     # rank 3
    guess(s, rep(s, "B"), "apple")      # rank 1 -> better
    assert s.g["round"]["control"] == "B"
    assert s.g["round"]["stage"] == "choice"
    # both matched face-off answers are revealed into the pot
    assert s.g["round"]["pot"] == 40 + 20


def test_faceoff_hit_beats_strike():
    s, toks = make(2)
    guess(s, rep(s, "A"), "zzzzz")      # strike
    guess(s, rep(s, "B"), "date")       # rank 4, on board
    assert s.g["round"]["control"] == "B"


def test_only_rep_answers_faceoff():
    s, toks = make(4, teams=["A", "A", "B", "B"])
    non_rep = [t for t in s.g["roster"]["A"] if t != rep(s, "A")][0]
    r = guess(s, non_rep, "apple")
    assert r and r[0]["kind"] == "invalid"


# ---------------- play + strikes + steal ----------------

def _win_faceoff_and_play(s, side="A"):
    # `side` wins the face-off with the top answer, then chooses PLAY
    guess(s, rep(s, side), "apple")
    other = "B" if side == "A" else "A"
    guess(s, rep(s, other), "zzzzz")
    cap = s.g["roster"][s.g["round"]["control"]][0]
    s.game_action(cap, {"t": "choice", "play": True})
    assert s.g["round"]["stage"] == "play"


def test_play_reveals_and_sweep_wins_pot():
    s, toks = make(2)
    _win_faceoff_and_play(s, "A")       # apple(40) already revealed, control A
    for w in ["banana", "cherry", "date"]:
        guess(s, s.g["round"]["turn"] if False else toks[0], w)
    r = s.g["round"]
    assert r["stage"] == "reveal" and r["outcome"]["winner"] == "A"
    assert s.g["scores"]["A"] == 100    # full board, round 1 mult 1


def test_three_strikes_opens_steal_then_steal_wins():
    s, toks = make(2)
    _win_faceoff_and_play(s, "A")       # control A, pot has apple(40)
    for _ in range(3):
        guess(s, toks[0], "zzzzz")      # 3 strikes
    assert s.g["round"]["stage"] == "steal"
    assert s.g["round"]["steal"]["side"] == "B"
    guess(s, toks[1], "banana")         # steal a remaining answer
    assert s.g["round"]["outcome"]["reason"] == "stole"
    assert s.g["scores"]["B"] == 40 + 30   # steals the whole pot


def test_failed_steal_holds_for_control():
    s, toks = make(2)
    _win_faceoff_and_play(s, "A")
    for _ in range(3):
        guess(s, toks[0], "zzzzz")
    guess(s, toks[1], "zzzzz")          # steal misses
    assert s.g["round"]["outcome"]["reason"] == "held"
    assert s.g["scores"]["A"] == 40     # control keeps the pot


# ---------------- multipliers + match end ----------------

def test_final_round_is_double():
    s, toks = make(2, rounds=1)         # round 1 is also the final -> x2
    assert s._mult() == 2
    _win_faceoff_and_play(s, "A")
    for w in ["banana", "cherry", "date"]:
        guess(s, toks[0], w)
    assert s.g["scores"]["A"] == 200    # 100 pot x2


def test_match_ends_with_winner():
    s, toks = make(2, rounds=1)
    _win_faceoff_and_play(s, "A")
    for w in ["banana", "cherry", "date"]:
        guess(s, toks[0], w)
    s.tick(s.gen)                        # reveal -> podium/game_end
    assert s.phase == "game_end"
    assert s.g["result"]["winner"] == "A" and not s.g["result"]["tie"]


# ---------------- timers ----------------

def test_faceoff_timeout_resolves():
    s, toks = make(2)
    guess(s, rep(s, "A"), "apple")      # only A answers
    s.tick(s.gen)                        # B times out -> resolve
    assert s.g["round"]["control"] == "A" and s.g["round"]["stage"] == "choice"


def test_play_timeout_is_a_strike():
    s, toks = make(2)
    _win_faceoff_and_play(s, "A")
    before = s.g["round"]["strikes"]
    s.tick(s.gen)                        # answerer runs out of time
    assert s.g["round"]["strikes"] == before + 1


# ---------------- state masking ----------------

def test_unrevealed_answers_are_hidden():
    s, toks = make(2)
    st = s.state_for(toks[1])["game"]
    hidden = [a for a in st["answers"] if not a["revealed"]]
    assert hidden and all(a["text"] is None and a["pts"] is None for a in hidden)


def test_bot_free_min_players():
    assert Fab5FeudSession.MIN_PLAYERS == 2
    s, toks = make(2)
    assert all(not p.is_bot for p in s.players.values())


# ---------------- the shipped survey bank ----------------

def test_game_state_read_is_pure():
    # serializing (called per-viewer every push) must NOT move turn_idx
    s, toks = make(4, teams=["A", "A", "B", "B"])
    _win_faceoff_and_play(s, "A")
    r = s.g["round"]
    before = r["turn_idx"]
    for _ in range(6):
        s.state_for(None)
        s.state_for(toks[0])
    assert r["turn_idx"] == before


def test_to_lobby_clears_stale_roster():
    s, toks = make(2, rounds=1)
    _win_faceoff_and_play(s, "A")
    for w in ["banana", "cherry", "date"]:
        guess(s, toks[0], w)                 # sweep -> reveal
    s.tick(s.gen)                            # reveal -> podium -> game_end
    assert s.phase == "game_end"
    s.tick(s.gen)                            # game_end -> to_lobby
    assert s.phase == "lobby" and s.g is None
    # a third player joins; the picker counts must reflect all 3, not the stale 1v1
    s.join("feudtok900", "New", None)
    s.set_ready("feudtok900", True)
    st = s.state_for("feudtok900")
    assert sum(st["ff"]["counts"].values()) == 3


def test_answerer_disconnect_reseats_with_fresh_clock():
    s, toks = make(4, teams=["A", "A", "B", "B"])
    _win_faceoff_and_play(s, "A")
    r = s.g["round"]
    seated = r["turn_order"][r["turn_idx"]]
    s.leave(seated)                          # the current answerer drops
    nxt = s.g["round"]["turn_order"][s.g["round"]["turn_idx"]]
    assert nxt != seated and s.players[nxt].connected


def test_real_bank_integrity():
    from games.fab5feud._surveys_data import SURVEYS
    assert len(SURVEYS) >= 110
    seen = set()
    for s in SURVEYS:
        q = s["q"].strip().lower()
        assert q and q not in seen
        seen.add(q)
        a = s["answers"]
        assert 5 <= len(a) <= 8
        pts = [x["pts"] for x in a]
        assert pts == sorted(pts, reverse=True)
        assert 80 <= sum(pts) <= 110


def test_real_bank_every_answer_reachable():
    # each answer must be matchable via at least one of its own text/aliases,
    # and none of its terms should whiff entirely — catches ambiguous content
    from games.fab5feud._surveys_data import SURVEYS
    for s in SURVEYS:
        a = s["answers"]
        for i, ans in enumerate(a):
            hits = [surveys.match_answer(al, a) for al in [ans["text"]] + ans["aliases"]]
            assert all(h is not None for h in hits), (s["q"], ans["text"], hits)
            assert i in hits, (s["q"], ans["text"], "unreachable", hits)
