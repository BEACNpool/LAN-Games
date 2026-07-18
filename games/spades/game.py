"""Spades — the hub's reference game implementation.

Session shape (copy this for new games):
  * subclass GameSession, declare MIN_PLAYERS / MAX_HUMANS / DEFAULT_SETTINGS
  * game_start() seats players (adding bots for empty chairs), deals, and
    enters the first game phase
  * game_action() validates and applies client verbs ("bid", "play")
  * game_tick() handles turn timeouts (auto-play) and phase advances
  * next_bot_action()/run_bot() let core.net drive bot turns — a seat whose
    human disconnected is played by the autopilot the same way
  * game_state() serializes a PERSONALIZED view (only your own hand!)

Seats 0..3 clockwise, team = seat % 2 (0&2 vs 1&3). Dealer rotates per hand;
bidding and first lead start left of the dealer.
"""

from __future__ import annotations

import time

from core.session import GameSession
from games.spades import rules
from games.spades.bots import make_bot

HAND_END_SECONDS = 14          # scoring recap between hands
BOT_NAMES = ["VEGA", "ONYX", "JINX", "NOVA"]


class SpadesSession(GameSession):
    MIN_PLAYERS = 2
    MAX_HUMANS = 8      # only 4 get seats; the rest can watch from the lobby
    DEFAULT_SETTINGS = {
        "target": 500,             # first team at/above wins (ties play on)
        "seating": "partners",     # 2 humans: "partners" (1&3) or "mixed"
        "difficulty": "standard",  # bot tier: "standard" | "rookie"
        "turn_seconds": 30,        # per bid/play; timeout = autopilot acts
        "nil_bonus": 100,
        "nil_penalty": 100,
    }

    def __init__(self, rng=None):
        super().__init__(rng)
        self.g = None              # whole game state; None outside a game

    # ---------------- settings ----------------

    def validate_settings(self, patch):
        ok = {}
        t = patch.get("target")
        if isinstance(t, int) and not isinstance(t, bool) and t in (200, 300, 400, 500):
            ok["target"] = t
        s = patch.get("seating")
        if s in ("partners", "mixed"):
            ok["seating"] = s
        d = patch.get("difficulty")
        if d in ("standard", "rookie"):
            ok["difficulty"] = d
        ts = patch.get("turn_seconds")
        if isinstance(ts, int) and not isinstance(ts, bool) and 10 <= ts <= 60:
            ok["turn_seconds"] = ts
        return ok

    # ---------------- game start / seating ----------------

    def game_start(self):
        humans = self.participants[:4]
        benched = self.participants[4:]
        self.participants = list(humans)
        fx_bench = [self.fx("toast", to=t, icon="🪑",
                            msg="Table seats 4 — you're watching this one")
                    for t in benched]
        seats = [None] * 4
        if len(humans) == 4:
            seats = list(humans)
        elif len(humans) == 3:
            seats[0], seats[1], seats[2] = humans
        elif self.settings["seating"] == "partners":
            seats[0], seats[2] = humans          # humans partner up
        else:
            seats[0], seats[1] = humans          # humans face off
        bots = {}
        for i in range(4):
            if seats[i] is None:
                bot = self.add_bot("BOT %s" % BOT_NAMES[i])
                seats[i] = bot.token
                self.participants.append(bot.token)
                bots[bot.token] = make_bot(self.settings["difficulty"], self.rng)
        self.g = {
            "seats": seats,
            "bots": bots,
            "autopilot": make_bot("standard", self.rng),   # plays timeouts/AFK
            "hand_no": 0,
            "dealer": self.rng.randrange(4),
            "scores": {0: {"score": 0, "bags": 0}, 1: {"score": 0, "bags": 0}},
            "hand_result": None,
            "result": None,
        }
        fx = fx_bench
        fx.append(self.fx("toast", msg="Teams: %s + %s vs %s + %s" % tuple(
            self.players[seats[i]].name for i in (0, 2, 1, 3))))
        fx.extend(self._start_hand())
        return fx

    def _start_hand(self):
        g = self.g
        g["hand_no"] += 1
        g["dealer"] = (g["dealer"] + 1) % 4
        deck = list(rules.DECK)
        self.rng.shuffle(deck)
        g["hands"] = {s: deck[13 * s:13 * (s + 1)] for s in range(4)}
        g["bids"] = {s: None for s in range(4)}
        g["tricks_won"] = {s: 0 for s in range(4)}
        g["trick"] = []
        g["last_trick"] = None
        g["played"] = []
        g["spades_broken"] = False
        g["hand_result"] = None
        g["turn"] = (g["dealer"] + 1) % 4
        self.phase = "bidding"
        self._arm_turn()
        return [self.fx("hand_start", hand=g["hand_no"],
                        dealer=self.players[g["seats"][g["dealer"]]].pid)]

    # ---------------- helpers ----------------

    def _seat_of(self, token):
        try:
            return self.g["seats"].index(token)
        except (ValueError, AttributeError, TypeError):
            return None

    def _arm_turn(self):
        self._bump(time.time() + self.settings["turn_seconds"])

    def _seat_is_auto(self, seat):
        """Bots and disconnected humans are on autopilot."""
        p = self.players.get(self.g["seats"][seat])
        return p is None or p.is_bot or not p.connected

    def _bot_view(self, seat):
        g = self.g
        return {
            "hand": list(g["hands"][seat]),
            "seat": seat,
            "partner": (seat + 2) % 4,
            "trick": [(s, c) for s, c in g["trick"]],
            "spades_broken": g["spades_broken"],
            "bids": dict(g["bids"]),
            "tricks_won": dict(g["tricks_won"]),
            "played": list(g["played"]),
        }

    # ---------------- actions ----------------

    def game_action(self, token, msg):
        self.seq += 1
        t = msg.get("t")
        seat = self._seat_of(token)
        if seat is None:
            return [self.fx("invalid", to=token, msg="You're watching this one")]
        if t == "bid":
            return self._do_bid(seat, msg.get("value"), token)
        if t == "play":
            return self._do_play(seat, msg.get("card"), token)
        return [self.fx("invalid", to=token, msg="Unknown action")]

    def _do_bid(self, seat, value, token=None):
        g = self.g
        if self.phase != "bidding" or g["turn"] != seat:
            return [self.fx("invalid", to=token, msg="Not your bid")]
        if value != "nil" and not (isinstance(value, int)
                                   and not isinstance(value, bool)
                                   and 1 <= value <= 13):
            return [self.fx("invalid", to=token, msg="Bid 1-13 or nil")]
        g["bids"][seat] = value
        p = self.players[g["seats"][seat]]
        fx = [self.fx("bid_made", seat=seat, pid=p.pid, value=value)]
        nxt = (seat + 1) % 4
        if all(b is not None for b in g["bids"].values()):
            self.phase = "playing"
            g["turn"] = (g["dealer"] + 1) % 4
            fx.append(self.fx("play_begins", turn=g["turn"]))
        else:
            g["turn"] = nxt
        self._arm_turn()
        return fx

    def _do_play(self, seat, card, token=None):
        g = self.g
        if self.phase != "playing" or g["turn"] != seat:
            return [self.fx("invalid", to=token, msg="Not your turn")]
        hand = g["hands"][seat]
        if not isinstance(card, str) or card not in hand:
            return [self.fx("invalid", to=token, msg="Not in your hand")]
        legal = rules.legal_plays(hand, g["trick"], g["spades_broken"])
        if card not in legal:
            led = g["trick"][0][1][1] if g["trick"] else None
            why = ("Follow suit" if led and any(c[1] == led for c in hand)
                   else "Spades aren't broken yet")
            return [self.fx("invalid", to=token, msg=why)]
        hand.remove(card)
        g["trick"].append((seat, card))
        g["played"].append(card)
        if card[1] == "S":
            g["spades_broken"] = True
        p = self.players[g["seats"][seat]]
        fx = [self.fx("played", seat=seat, pid=p.pid, card=card)]
        if len(g["trick"]) == 4:
            winner = rules.trick_winner(g["trick"])
            g["tricks_won"][winner] += 1
            g["last_trick"] = {"cards": [(s, c) for s, c in g["trick"]],
                               "winner": winner}
            g["trick"] = []
            g["turn"] = winner
            wp = self.players[g["seats"][winner]]
            fx.append(self.fx("trick_won", seat=winner, pid=wp.pid))
            if all(len(h) == 0 for h in g["hands"].values()):
                fx.extend(self._end_hand())
                return fx
        else:
            g["turn"] = (seat + 1) % 4
        self._arm_turn()
        return fx

    # ---------------- hand scoring / game end ----------------

    def _end_hand(self):
        g = self.g
        res = rules.score_hand(
            g["bids"], g["tricks_won"],
            {t: g["scores"][t]["bags"] for t in (0, 1)},
            nil_bonus=self.settings["nil_bonus"],
            nil_penalty=self.settings["nil_penalty"])
        for team in (0, 1):
            g["scores"][team]["score"] += res[team]["delta"]
            g["scores"][team]["bags"] = res[team]["bags"]
        g["hand_result"] = {
            "teams": {str(t): res[t] | {
                "nil": [{"seat": s, "ok": ok, "delta": d}
                        for s, ok, d in res[t]["nil"]],
            } for t in (0, 1)},
            "bids": dict(g["bids"]),
            "tricks": dict(g["tricks_won"]),
        }
        self.phase = "hand_end"
        self._bump(time.time() + HAND_END_SECONDS)
        return [self.fx("hand_end")]

    def _maybe_finish(self):
        g = self.g
        a, b = g["scores"][0]["score"], g["scores"][1]["score"]
        target = self.settings["target"]
        if (a >= target or b >= target) and a != b:
            winner = 0 if a > b else 1
            g["result"] = {"winner_team": winner,
                           "scores": {str(t): g["scores"][t]["score"] for t in (0, 1)},
                           "hands": g["hand_no"]}
            fx = [self.fx("game_over", winner_team=winner)]
            fx.extend(self.end_game())
            return fx
        return None

    # ---------------- timers & bots ----------------

    def game_tick(self):
        g = self.g
        if self.phase == "hand_end":
            return self._maybe_finish() or self._start_hand()
        if self.phase not in ("bidding", "playing") or g is None:
            return []
        # turn timeout: autopilot acts for the stalled seat (human or bot)
        seat = g["turn"]
        p = self.players.get(g["seats"][seat])
        fx = []
        if p is not None and not p.is_bot and p.connected:
            fx.append(self.fx("toast",
                              msg="%s ran out of time — autopilot" % p.name,
                              icon="⏱"))
        fx.extend(self._auto_act(seat))
        return fx

    def _auto_act(self, seat):
        g = self.g
        bot = g["bots"].get(g["seats"][seat], g["autopilot"])
        if self.phase == "bidding":
            return self._do_bid(seat, bot.bid(list(g["hands"][seat])))
        if self.phase == "playing":
            card = bot.play(self._bot_view(seat))
            legal = rules.legal_plays(g["hands"][seat], g["trick"],
                                      g["spades_broken"])
            if card not in legal:      # bots must never wedge the game
                card = min(legal, key=rules.rank_of)
            return self._do_play(seat, card)
        return []

    def next_bot_action(self):
        if self.phase not in ("bidding", "playing") or self.g is None:
            return None
        seat = self.g["turn"]
        if self._seat_is_auto(seat):
            delay = 0.9 + self.rng.random() * 0.9
            if self.phase == "bidding":
                delay += 0.4
            return (delay, self.g["seats"][seat])
        return None

    def run_bot(self, bot_token):
        if self.phase not in ("bidding", "playing") or self.g is None:
            return []
        seat = self.g["turn"]
        if self.g["seats"][seat] != bot_token or not self._seat_is_auto(seat):
            return []
        self.seq += 1
        return self._auto_act(seat)

    # ---------------- connection events ----------------

    def game_player_left(self, token):
        seat = self._seat_of(token)
        if seat is None:
            return []
        p = self.players[token]
        return [self.fx("toast", msg="%s dropped — autopilot takes seat %d"
                        % (p.name, seat + 1), icon="🛰")]

    def game_player_back(self, token):
        seat = self._seat_of(token)
        if seat is None:
            return []
        p = self.players[token]
        return [self.fx("toast", msg="%s is back at the table" % p.name,
                        icon=p.avatar)]

    # ---------------- serialization ----------------

    def game_state(self, viewer_token):
        g = self.g
        if g is None:
            return None
        seats = []
        for s in range(4):
            tok = g["seats"][s]
            p = self.players.get(tok)
            seats.append({
                "seat": s,
                "pid": p.pid if p else None,
                "team": s % 2,
                "bid": g["bids"].get(s) if "bids" in g else None,
                "tricks": g["tricks_won"].get(s, 0) if "tricks_won" in g else 0,
                "cards_left": len(g["hands"][s]) if "hands" in g else 0,
                "auto": self._seat_is_auto(s),
            })
        my_seat = self._seat_of(viewer_token) if viewer_token else None
        st = {
            "kind": "spades",
            "stage": self.phase,
            "seats": seats,
            "my_seat": my_seat,
            "hand": rules.sort_hand(g["hands"][my_seat]) if my_seat is not None else None,
            "turn": g.get("turn"),
            "trick": [{"seat": s, "card": c} for s, c in g.get("trick", [])],
            "last_trick": ({"cards": [{"seat": s, "card": c}
                                      for s, c in g["last_trick"]["cards"]],
                            "winner": g["last_trick"]["winner"]}
                           if g.get("last_trick") else None),
            "spades_broken": g.get("spades_broken", False),
            "hand_no": g["hand_no"],
            "dealer": g["dealer"],
            "turn_seconds": self.settings["turn_seconds"],
            "scores": {str(t): dict(g["scores"][t]) for t in (0, 1)},
            "target": self.settings["target"],
            "hand_result": g["hand_result"],
            "result": g["result"],
        }
        return st
