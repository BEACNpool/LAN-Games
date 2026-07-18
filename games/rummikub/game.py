"""Rummikub — turn-based tile game on the GameSession base.

Turn model: all drag-and-drop happens locally on the client; the server sees
exactly one of two moves per turn:
    {"t": "commit", "board": [[tile ids]]}   full proposed board at turn end
    {"t": "draw"}                            take a tile (or pass, pool empty)
rules.check_turn validates the ENTIRE proposed board (conservation, validity,
initial-meld discipline) — the client's live validation is a convenience, the
server is the referee. "Undo my turn" is therefore free: the client just
restores its local snapshot; the server never saw the mess.

Long rounds + phones falling asleep: a disconnected player's seat runs on
autopilot (baseline bot) via next_bot_action, same as turn timeouts — the
game never stalls waiting for a reconnect, and the player takes back over
the moment they're back.
"""

from __future__ import annotations

import re
import time

from core.session import GameSession
from games.rummikub import rules
from games.rummikub.bots import make_bot

ROUND_END_SECONDS = 16
BOT_NAMES = ["TILDA", "OTTO", "MOSS", "PIP"]
MAX_SEATS = 6
TILE_RE = re.compile(r"[rbky](0[1-9]|1[0-3])\.\d|J\.\d")


class RummikubSession(GameSession):
    MIN_PLAYERS = 2
    MAX_HUMANS = 6
    DEFAULT_SETTINGS = {
        "rounds": 1,          # cumulative score across rounds; high total wins
        "turn_seconds": 60,   # rearranging takes time; timeout = autopilot
        "bot_players": 0,     # extra bot opponents, 0-4
        "bot_skill": "smart",  # "smart" (rearrangement search) or "baseline"
    }

    def __init__(self, rng=None):
        super().__init__(rng)
        self.g = None

    def validate_settings(self, patch):
        ok = {}
        r = patch.get("rounds")
        if isinstance(r, int) and not isinstance(r, bool) and 1 <= r <= 5:
            ok["rounds"] = r
        ts = patch.get("turn_seconds")
        if isinstance(ts, int) and not isinstance(ts, bool) and 20 <= ts <= 120:
            ok["turn_seconds"] = ts
        b = patch.get("bot_players")
        if isinstance(b, int) and not isinstance(b, bool) and 0 <= b <= 4:
            ok["bot_players"] = b
        if patch.get("bot_skill") in ("smart", "baseline"):
            ok["bot_skill"] = patch["bot_skill"]
        return ok

    # ---------------- game lifecycle ----------------

    def game_start(self):
        humans = self.participants[:MAX_SEATS]
        benched = self.participants[MAX_SEATS:]
        self.participants = list(humans)
        fx_bench = [self.fx("toast", to=t, icon="🪑",
                            msg="Table seats %d — you're watching this one" % MAX_SEATS)
                    for t in benched]
        n_bots = min(self.settings["bot_players"], MAX_SEATS - len(humans))
        bots = {}
        for i in range(n_bots):
            bot = self.add_bot("BOT %s" % BOT_NAMES[i % len(BOT_NAMES)])
            self.participants.append(bot.token)
            bots[bot.token] = make_bot(self.settings["bot_skill"], self.rng)
        order = list(self.participants)
        self.rng.shuffle(order)
        self.g = {
            "order": order,
            "bots": bots,
            "autopilot": make_bot("baseline", self.rng),
            "double_set": len(order) >= rules.DOUBLE_SET_FROM,
            "round_no": 0,
            "scores": {t: 0 for t in order},
            "summary": None,
            "result": None,
        }
        fx = fx_bench
        fx.append(self.fx("toast", msg="%d players — %s tile set" % (
            len(order), "double (212)" if self.g["double_set"] else "single (106)"),
            icon="🁵"))
        fx.extend(self._start_round())
        return fx

    def _start_round(self):
        g = self.g
        g["round_no"] += 1
        pool = rules.build_pool(len(g["order"]))
        self.rng.shuffle(pool)
        g["hands"] = {}
        for t in g["order"]:
            g["hands"][t] = pool[:rules.HAND_SIZE]
            pool = pool[rules.HAND_SIZE:]
        g["pool"] = pool
        g["board"] = []
        g["melded"] = {t: False for t in g["order"]}
        g["passes"] = 0
        g["turn_idx"] = (g["round_no"] - 1) % len(g["order"])
        g["summary"] = None
        self.phase = "playing"
        self._arm_turn()
        return [self.fx("round_start", n=g["round_no"],
                        total=self.settings["rounds"])]

    def _arm_turn(self):
        self._bump(time.time() + self.settings["turn_seconds"])

    def _current(self):
        return self.g["order"][self.g["turn_idx"]]

    def _advance(self):
        g = self.g
        g["turn_idx"] = (g["turn_idx"] + 1) % len(g["order"])
        self._arm_turn()

    # ---------------- actions ----------------

    def game_action(self, token, msg):
        self.seq += 1
        g = self.g
        if self.phase != "playing" or g is None:
            return [self.fx("invalid", to=token, msg="No round in progress")]
        if token not in g["order"]:
            return [self.fx("invalid", to=token, msg="You're watching this one")]
        if token != self._current():
            return [self.fx("invalid", to=token, msg="Not your turn")]
        t = msg.get("t")
        if t == "commit":
            return self._do_commit(token, msg.get("board"))
        if t == "draw":
            return self._do_draw(token)
        return [self.fx("invalid", to=token, msg="Unknown action")]

    def _sane_board(self, board):
        if not isinstance(board, list) or len(board) > 80:
            return None
        out = []
        total = 0
        for grp in board:
            if not isinstance(grp, list) or len(grp) > 15:
                return None
            for t in grp:
                if not isinstance(t, str) or not TILE_RE.fullmatch(t):
                    return None
            total += len(grp)
            if total > 300:
                return None
            out.append(list(grp))
        return out

    def _do_commit(self, token, board):
        g = self.g
        board = self._sane_board(board)
        if board is None:
            return [self.fx("invalid", to=token, msg="Bad board payload")]
        res = rules.check_turn(g["board"], board, g["hands"][token],
                               g["melded"][token])
        if not res["ok"]:
            return [self.fx("commit_rejected", to=token, msg=res["reason"],
                            bad_groups=res["bad_groups"])]
        for t in res["played"]:
            g["hands"][token].remove(t)
        g["board"] = board
        g["passes"] = 0
        was_meld = not g["melded"][token]
        g["melded"][token] = True
        p = self.players[token]
        fx = [self.fx("played", pid=p.pid, n=len(res["played"]),
                      opened=was_meld,
                      meld_total=res["meld_total"])]
        if not g["hands"][token]:
            fx.extend(self._end_round(winner=token))
            return fx
        self._advance()
        fx.append(self.fx("turn", pid=self.players[self._current()].pid))
        return fx

    def _do_draw(self, token):
        g = self.g
        p = self.players[token]
        fx = []
        if g["pool"]:
            g["hands"][token].append(g["pool"].pop())
            g["passes"] = 0
            fx.append(self.fx("drew", pid=p.pid, pool=len(g["pool"])))
        else:
            g["passes"] += 1
            fx.append(self.fx("passed", pid=p.pid))
            if g["passes"] >= len(g["order"]):
                fx.extend(self._end_round(winner=None))
                return fx
        self._advance()
        fx.append(self.fx("turn", pid=self.players[self._current()].pid))
        return fx

    # ---------------- round end & scoring ----------------

    def _end_round(self, winner):
        g = self.g
        values = {t: rules.hand_value(g["hands"][t]) for t in g["order"]}
        if winner is None:
            # pool empty and everyone passed: lowest leftover hand wins,
            # scored relative to the winner's hand
            winner = min(g["order"], key=lambda t: values[t])
            gains = {t: -(values[t] - values[winner]) for t in g["order"]}
            gains[winner] = sum(values[t] - values[winner] for t in g["order"])
            stalemate = True
        else:
            gains = {t: -values[t] for t in g["order"]}
            gains[winner] = sum(values[t] for t in g["order"] if t != winner)
            stalemate = False
        for t in g["order"]:
            g["scores"][t] += gains[t]
        g["summary"] = {
            "winner": self.players[winner].pid,
            "stalemate": stalemate,
            "rows": [{
                "pid": self.players[t].pid,
                "left": len(g["hands"][t]),
                "value": values[t],
                "gain": gains[t],
                "total": g["scores"][t],
            } for t in sorted(g["order"], key=lambda t: -gains[t])],
        }
        fx = [self.fx("round_end", winner=self.players[winner].pid,
                      stalemate=stalemate)]
        if g["round_no"] >= self.settings["rounds"]:
            standings = sorted(g["order"], key=lambda t: -g["scores"][t])
            g["result"] = {
                "winner": self.players[standings[0]].pid,
                "rows": [{"pid": self.players[t].pid,
                          "total": g["scores"][t]} for t in standings],
            }
            fx.extend(self.end_game())
        else:
            self.phase = "round_end"
            self._bump(time.time() + ROUND_END_SECONDS)
        return fx

    def game_tick(self):
        g = self.g
        if self.phase == "round_end":
            return self._start_round()
        if self.phase != "playing" or g is None:
            return []
        token = self._current()
        p = self.players.get(token)
        fx = []
        if p is not None and not p.is_bot and p.connected:
            fx.append(self.fx("toast", msg="%s ran out of time — autopilot"
                              % p.name, icon="⏱"))
        fx.extend(self._auto_act(token))
        return fx

    # ---------------- bots / autopilot ----------------

    def _auto_act(self, token):
        g = self.g
        bot = g["bots"].get(token, g["autopilot"])
        view = {"hand": list(g["hands"][token]),
                "board": [list(grp) for grp in g["board"]],
                "melded": g["melded"][token],
                "pool_count": len(g["pool"])}
        try:
            move = bot.choose(view)
        except Exception:
            move = {"draw": True}
        if isinstance(move, dict) and "board" in move:
            fx = self._do_commit(token, move["board"])
            if not any(f["kind"] == "commit_rejected" for f in fx):
                return fx
        return self._do_draw(token)

    def next_bot_action(self):
        if self.phase != "playing" or self.g is None:
            return None
        token = self._current()
        p = self.players.get(token)
        if p is None or p.is_bot or not p.connected:
            return (1.3 + self.rng.random() * 1.2, token)
        return None

    def run_bot(self, bot_token):
        if self.phase != "playing" or self.g is None:
            return []
        if self._current() != bot_token:
            return []
        p = self.players.get(bot_token)
        if p is not None and not p.is_bot and p.connected:
            return []   # human woke up; their timer still runs
        self.seq += 1
        return self._auto_act(bot_token)

    # ---------------- connection events ----------------

    def game_player_left(self, token):
        if self.phase == "playing" and self.g and token in self.g["order"]:
            p = self.players[token]
            return [self.fx("toast", msg="%s dropped — autopilot plays their tiles"
                            % p.name, icon="🛰")]
        return []

    def game_player_back(self, token):
        if self.g and token in self.g["order"]:
            p = self.players[token]
            return [self.fx("toast", msg="%s is back" % p.name, icon=p.avatar)]
        return []

    # ---------------- serialization ----------------

    @staticmethod
    def _sort_hand(hand):
        def key(t):
            if rules.is_joker(t):
                return (9, 99, t)
            return (rules.COLORS.index(rules.color_of(t)),
                    rules.number_of(t), t)
        return sorted(hand, key=key)

    def game_state(self, viewer_token):
        g = self.g
        if g is None:
            return None
        mine = viewer_token if viewer_token in (g.get("hands") or {}) else None
        seats = []
        for t in g["order"]:
            p = self.players.get(t)
            seats.append({
                "pid": p.pid if p else None,
                "tiles": len(g["hands"][t]),
                "melded": g["melded"][t],
                "auto": p is None or p.is_bot or not p.connected,
            })
        return {
            "kind": "rummikub",
            "stage": self.phase,
            "board": [list(grp) for grp in g["board"]],
            "hand": self._sort_hand(g["hands"][mine]) if mine else None,
            "melded": g["melded"].get(mine, False) if mine else False,
            "seats": seats,
            "turn": self.players[self._current()].pid
                    if self.phase == "playing" else None,
            "pool": len(g["pool"]),
            "double_set": g["double_set"],
            "round_no": g["round_no"],
            "rounds": self.settings["rounds"],
            "turn_seconds": self.settings["turn_seconds"],
            "bot_skill": self.settings["bot_skill"],
            "summary": g["summary"],
            "result": g["result"],
        }
