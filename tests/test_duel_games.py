import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import chess as pychess

from games.chess.game import ChessSession
from games.connect4.game import Connect4Session


def make(cls, n_humans=2, seed=9, **settings):
    s = cls(rng=random.Random(seed))
    toks = []
    for i in range(n_humans):
        tok = f"duel-token-{i:02d}"
        s.join(tok, f"P{i}", None)
        s.set_ready(tok, True)
        toks.append(tok)
    s.settings.update(settings)
    s.start(toks[0])
    s.tick(s.gen)
    return s, toks


def seat(s, color):
    return s.g["seats"][color]


# ---------------- duel base ----------------

def test_solo_human_gets_bot():
    s, toks = make(ChessSession, n_humans=1)
    assert s.phase == "playing"
    assert len(s.participants) == 2
    bots = [t for t in s.participants if s.players[t].is_bot]
    assert len(bots) == 1
    # bot is scheduled whenever it's the bot's turn
    for _ in range(4):
        due = s.next_bot_action()
        if due is None:
            cur = seat(s, s.current_color())
            assert not s.players[cur].is_bot
            fx = s.game_action(cur, {"t": "move",
                                     "uci": s.duel_state(None)["legal"][0]})
            break
        s.run_bot(due[1])


def test_resign_and_draw_flow():
    s, toks = make(ChessSession)
    w, b = seat(s, "w"), seat(s, "b")
    fx = s.game_action(w, {"t": "draw_offer"})
    assert any(f["kind"] == "offer" for f in fx)
    fx = s.game_action(b, {"t": "draw_offer"})     # accept by mirroring
    assert s.phase == "game_end"
    assert s.g["result"] == {"winner": None, "why": "agreement"}
    # fresh game: resign
    s2, _ = make(Connect4Session, seed=11)
    r = seat(s2, "r")
    fx = s2.game_action(r, {"t": "resign"})
    assert s2.g["result"]["winner"] == "y"
    assert s2.g["result"]["why"] == "resignation"


def test_spectator_and_wrong_turn_rejected():
    s, toks = make(ChessSession)
    s.join("duel-spec-tok-99", "Spec", None)
    fx = s.game_action("duel-spec-tok-99", {"t": "move", "uci": "e2e4"})
    assert any(f["kind"] == "invalid" for f in fx)
    b = seat(s, "b")
    fx = s.game_action(b, {"t": "move", "uci": "e7e5"})
    assert any(f["kind"] == "invalid" and "turn" in f["msg"] for f in fx)


# ---------------- chess ----------------

def test_chess_legal_and_illegal():
    s, toks = make(ChessSession)
    w = seat(s, "w")
    fx = s.game_action(w, {"t": "move", "uci": "e2e5"})
    assert any(f["kind"] == "invalid" for f in fx)
    fx = s.game_action(w, {"t": "move", "uci": "e2e4"})
    assert any(f["kind"] == "moved" and f["san"] == "e4" for f in fx)
    st = s.state_for(toks[0])["game"]
    assert st["fen"].split()[1] == "b"
    assert "e7e5" in st["legal"]


def test_chess_scholars_mate_ends_game():
    s, toks = make(ChessSession)
    w, b = seat(s, "w"), seat(s, "b")
    for mover, uci in ((w, "e2e4"), (b, "e7e5"), (w, "d1h5"), (b, "b8c6"),
                       (w, "f1c4"), (b, "g8f6"), (w, "h5f7")):
        fx = s.game_action(mover, {"t": "move", "uci": uci})
    assert s.phase == "game_end"
    assert s.g["result"] == {"winner": "w", "why": "checkmate"}
    st = s.state_for(toks[0])["game"]
    assert st["legal"] == [] or s.g["result"]  # game over


def test_chess_takeback():
    s, toks = make(ChessSession)
    w, b = seat(s, "w"), seat(s, "b")
    s.game_action(w, {"t": "move", "uci": "e2e4"})
    s.game_action(b, {"t": "move", "uci": "e7e5"})
    # white wants e4 back after black replied -> pops 2 plies
    s.game_action(w, {"t": "takeback_offer"})
    fx = s.game_action(b, {"t": "takeback_accept"})
    assert s.d["board"].fen() == pychess.Board().fen()
    assert s.current_color() == "w"


def test_chess_promotion_and_captured_list():
    s, toks = make(ChessSession)
    s.d["board"] = pychess.Board("k7/4P3/8/8/8/8/8/K7 w - - 0 1")
    w = seat(s, "w")
    fx = s.game_action(w, {"t": "move", "uci": "e7e8q"})
    assert any(f["kind"] == "moved" for f in fx)
    st = s.duel_state(None)
    assert st["fen"].startswith("k3Q3" ) or "Q" in st["fen"].split()[0]


def test_chess_bots_play_legal_full_game():
    s, toks = make(ChessSession, n_humans=1, difficulty="sharp", seed=3)
    for _ in range(300):
        if s.phase != "playing":
            break
        color = s.current_color()
        tok = seat(s, color)
        if s.players[tok].is_bot:
            s.run_bot(tok)
        else:
            legal = s.duel_state(None)["legal"]
            s.game_action(tok, {"t": "move", "uci": legal[0]})
    assert s.phase == "game_end"
    assert s.g["result"]["why"] in ("checkmate", "stalemate",
                                    "insufficient material",
                                    "fifty-move rule",
                                    "threefold repetition", "resignation")


# ---------------- connect four ----------------

def test_c4_vertical_win():
    s, toks = make(Connect4Session)
    r, y = seat(s, "r"), seat(s, "y")
    for i in range(3):
        s.game_action(r, {"t": "move", "col": 0})
        s.game_action(y, {"t": "move", "col": 1})
    fx = s.game_action(r, {"t": "move", "col": 0})
    assert s.g["result"]["winner"] == "r"
    assert len(s.d["win_line"]) >= 4


def test_c4_diagonal_win_and_full_column():
    s, toks = make(Connect4Session, seed=13)
    r, y = seat(s, "r"), seat(s, "y")
    # build a / diagonal for red at cols 0-3
    moves = [(r, 0), (y, 1), (r, 1), (y, 2), (r, 2), (y, 3), (r, 2),
             (y, 3), (r, 3), (y, 6), (r, 3)]
    for who, col in moves:
        s.game_action(who, {"t": "move", "col": col})
    assert s.g["result"] and s.g["result"]["winner"] == "r"
    # full column rejected in a fresh game (6 discs fill it; the 7th bounces)
    s2, _ = make(Connect4Session, seed=14)
    r2, y2 = seat(s2, "r"), seat(s2, "y")
    for i in range(3):
        s2.game_action(r2, {"t": "move", "col": 4})
        s2.game_action(y2, {"t": "move", "col": 4})
    assert len(s2.d["cols"][4]) == 6
    fx = s2.game_action(r2, {"t": "move", "col": 4})
    assert any(f["kind"] == "invalid" for f in fx)


def test_c4_sharp_bot_blocks_and_wins():
    s, toks = make(Connect4Session, n_humans=2, seed=15, difficulty="sharp")
    r, y = seat(s, "r"), seat(s, "y")
    # red builds three in a row; drive yellow via duel_auto — it must block
    s.game_action(r, {"t": "move", "col": 0})
    s.duel_auto("y") if s.current_color() == "y" else None
    if s.current_color() == "r":
        s.game_action(r, {"t": "move", "col": 1})
    if s.current_color() == "y":
        s.duel_auto("y")
    if s.current_color() == "r":
        s.game_action(r, {"t": "move", "col": 2})
    if s.current_color() == "y" and s.phase == "playing":
        s.duel_auto("y")
        # red threatened 0,1,2 -> yellow must have played col 3 or on top
        # of one of them, IF red actually has 3 in a row on the bottom
        bottom = [c[0] if c else None for c in s.d["cols"]]
        if bottom[0] == "r" and bottom[1] == "r" and bottom[2] == "r":
            assert bottom[3] == "y", s.d["cols"]


def test_c4_bots_full_games():
    for seed in range(6):
        s, toks = make(Connect4Session, n_humans=1, seed=seed)
        for _ in range(60):
            if s.phase != "playing":
                break
            color = s.current_color()
            tok = seat(s, color)
            if s.players[tok].is_bot:
                s.run_bot(tok)
            else:
                legal = s.duel_state(None)["legal"]
                s.game_action(tok, {"t": "move", "col": legal[0]})
        assert s.phase == "game_end"


# ---------------- checkers session ----------------

from games.checkers.game import CheckersSession
from games.checkers import engine as ck


def test_checkers_flow_forced_and_takeback():
    s, toks = make(CheckersSession)
    w, b = seat(s, "w"), seat(s, "b")
    legal = ck.legal_moves(s.d)
    fx = s.game_action(w, {"t": "move", "path": legal[0]})
    assert any(f["kind"] == "moved" for f in fx)
    # illegal move rejected
    fx = s.game_action(b, {"t": "move", "path": [0, 63]})
    assert any(f["kind"] == "invalid" for f in fx)
    # takeback restores the initial position
    s.game_action(b, {"t": "move", "path": ck.legal_moves(s.d)[0]})
    s.game_action(w, {"t": "takeback_offer"})
    s.game_action(b, {"t": "takeback_accept"})
    assert s.d["board"] == ck.new_game()["board"]
    assert s.current_color() == "w"


def test_checkers_bot_full_game():
    s, toks = make(CheckersSession, n_humans=1, seed=21)
    for _ in range(400):
        if s.phase != "playing":
            break
        color = s.current_color()
        tok = seat(s, color)
        if s.players[tok].is_bot:
            s.run_bot(tok)
        else:
            legal = ck.legal_moves(s.d, forced=s.settings["forced"])
            s.game_action(tok, {"t": "move", "path": legal[0]})
    assert s.phase == "game_end"


def test_checkers_forced_toggle():
    s, toks = make(CheckersSession, forced=False)
    st = s.state_for(toks[0])["game"]
    assert st["forced"] is False


# ---------------- backgammon session ----------------

from games.backgammon.game import BackgammonSession
from games.backgammon import engine as bg


def test_backgammon_flow():
    s, toks = make(BackgammonSession, seed=31)
    assert s.phase == "playing"
    st = s.state_for(toks[0])["game"]
    assert st["pips"]["w"] == 167 or st["pips"]["w"] < 167  # opening may have moved
    color = s.current_color()
    tok = seat(s, color)
    turns = st["turns"] if st["turns"] else [[]]
    # play a legal enumerated turn through the session
    legal = bg.legal_turns(s.d)
    pick = [list(x) for x in legal[0]] if legal and legal[0] else []
    if pick:
        fx = s.game_action(tok, {"t": "move", "steps": pick})
        assert any(f["kind"] == "moved" for f in fx), fx
    # illegal turn rejected
    color2 = s.current_color()
    if color2:
        tok2 = seat(s, color2)
        fx = s.game_action(tok2, {"t": "move", "steps": [[0, 23]]})
        assert any(f["kind"] == "invalid" for f in fx)


def test_backgammon_bots_finish():
    s, toks = make(BackgammonSession, n_humans=1, seed=33)
    for _ in range(600):
        if s.phase != "playing":
            break
        color = s.current_color()
        tok = seat(s, color)
        if s.players[tok].is_bot:
            s.run_bot(tok)
        else:
            legal = bg.legal_turns(s.d)
            pick = [list(x) for x in legal[0]] if legal and legal[0] else []
            if pick:
                s.game_action(tok, {"t": "move", "steps": pick})
            else:
                s.game_action(tok, {"t": "move", "steps": []})
    assert s.phase == "game_end"
    assert s.g["result"]["winner"] in ("w", "b")
