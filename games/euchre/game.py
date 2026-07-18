"""Euchre — 24-card partnership trump with a calling phase.

Session shape mirrors Spades (the hub's reference implementation):
  * game_start() seats humans, fills chairs with bots, deals
  * game_action() validates client verbs ("bid", "discard", "play")
  * game_tick() = turn timeouts (autopilot) + phase advances
  * next_bot_action()/run_bot() let core.net pace bot turns
  * game_state() serializes a PERSONALIZED view (only your own hand)

Seats 0..3 clockwise, team = seat % 2 (0&2 vs 1&3). Dealer rotates per hand.

Phases: bidding1 (order up the upcard) -> bidding2 (name a suit) or
discard (dealer buries after a pickup) -> playing -> hand_end -> ...
First team to the target (5/10) wins. Going alone benches the maker's
partner; if that benched partner IS the dealer, the pickup/discard is moot
and the hand goes straight to play (the dealer's hand is dead anyway).
Solo play works: MIN_PLAYERS 1, three bots fill the table.
"""

from __future__ import annotations

import time

from core.session import GameSession
from games.euchre import rules
from games.euchre.bots import make_bot

HAND_END_SECONDS = 10          # scoring recap between hands
BOT_NAMES = ["VEGA", "ONYX", "JINX", "NOVA"]
SUIT_NAME = {"S": "spades", "H": "hearts", "D": "diamonds", "C": "clubs"}


class EuchreSession(GameSession):
    MIN_PLAYERS = 1     # solo vs 3 bots is a real mode
    MAX_HUMANS = 8      # only 4 get seats; the rest can watch from the lobby
    DEFAULT_SETTINGS = {
        "target": 10,              # first team at target wins (5 or 10)
        "seating": "partners",     # 2 humans: "partners" (0&2) or "mixed"
        "difficulty": "standard",  # bot tier: "standard" | "rookie"
        "turn_seconds": 30,        # per bid/play; timeout = autopilot acts
        "stick_dealer": True,      # dealer must call if round 2 all pass
    }

    def __init__(self, rng=None):
        super().__init__(rng)
        self.g = None              # whole game state; None outside a game

    # ---------------- settings ----------------

    def validate_settings(self, patch):
        ok = {}
        t = patch.get("target")
        if isinstance(t, int) and not isinstance(t, bool) and t in (5, 10):
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
        sd = patch.get("stick_dealer")
        if isinstance(sd, bool):
            ok["stick_dealer"] = sd
        return ok

    # ---------------- game start / seating ----------------

    def game_start(self):
        humans = self.participants[:4]
        benched = self.participants[4:]
        self.participants = list(humans)
        fx = [self.fx("toast", to=t, icon="🪑",
                      msg="Table seats 4 — you're watching this one")
              for t in benched]
        seats = [None] * 4
        if len(humans) == 4:
            seats = list(humans)
        elif len(humans) == 3:
            seats[0], seats[1], seats[2] = humans
        elif len(humans) == 2 and self.settings["seating"] == "partners":
            seats[0], seats[2] = humans          # humans partner up
        elif len(humans) == 2:
            seats[0], seats[1] = humans          # humans face off
        else:
            seats[0] = humans[0]                 # solo vs three bots
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
            "scores": {0: 0, 1: 0},
            "hand_result": None,
            "result": None,
        }
        fx.append(self.fx("toast", msg="Teams: %s + %s vs %s + %s" % tuple(
            self.players[seats[i]].name for i in (0, 2, 1, 3))))
        fx.extend(self._start_hand())
        return fx

    def _start_hand(self):
        g = self.g
        g["hand_no"] += 1
        g["dealer"] = (g["dealer"] + 1) % 4
        hands, upcard, kitty = rules.deal(self.rng, g["dealer"])
        g["hands"] = hands
        g["upcard"] = upcard
        g["kitty"] = kitty                 # face-down forever; never serialized
        g["turned_down"] = None
        g["trump"] = None
        g["maker"] = None
        g["alone"] = False
        g["sitting_out"] = None
        g["passes"] = 0
        g["trick"] = []
        g["last_trick"] = None
        g["played"] = []
        g["tricks_won"] = {s: 0 for s in range(4)}
        g["hand_result"] = None
        g["turn"] = (g["dealer"] + 1) % 4
        self.phase = "bidding1"
        self._arm_turn()
        return [self.fx("hand_start", hand=g["hand_no"],
                        dealer=self.players[g["seats"][g["dealer"]]].pid,
                        upcard=upcard)]

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

    def _next_active(self, seat):
        g = self.g
        nxt = (seat + 1) % 4
        while nxt == g["sitting_out"]:
            nxt = (nxt + 1) % 4
        return nxt

    def _active_count(self):
        return 3 if self.g["alone"] else 4

    def _pname(self, seat):
        return self.players[self.g["seats"][seat]].name

    def _bid_view(self, seat):
        g = self.g
        return {
            "hand": list(g["hands"][seat]),
            "seat": seat,
            "partner": (seat + 2) % 4,
            "dealer": g["dealer"],
            "upcard": g["upcard"],
            "turned_down": g["turned_down"],
            "forced": self._dealer_stuck(seat),
        }

    def _bot_view(self, seat):
        g = self.g
        return {
            "hand": list(g["hands"][seat]),
            "seat": seat,
            "partner": (seat + 2) % 4,
            "dealer": g["dealer"],
            "trump": g["trump"],
            "maker": g["maker"],
            "alone": g["alone"],
            "trick": [(s, c) for s, c in g["trick"]],
            "played": list(g["played"]),
            "tricks_won": dict(g["tricks_won"]),
        }

    def _dealer_stuck(self, seat):
        """Stick the dealer: in round 2, the dealer (always last to speak)
        may not pass when the toggle is on."""
        return (self.phase == "bidding2"
                and self.settings["stick_dealer"]
                and seat == self.g["dealer"])

    # ---------------- actions ----------------

    def game_action(self, token, msg):
        self.seq += 1
        t = msg.get("t")
        seat = self._seat_of(token)
        if seat is None:
            return [self.fx("invalid", to=token, msg="You're watching this one")]
        if t == "bid":
            return self._do_bid(seat, msg.get("call"), msg.get("suit"),
                                bool(msg.get("alone")), token)
        if t == "discard":
            return self._do_discard(seat, msg.get("card"), token)
        if t == "play":
            return self._do_play(seat, msg.get("card"), token)
        return [self.fx("invalid", to=token, msg="Unknown action")]

    def _do_bid(self, seat, call, suit=None, alone=False, token=None):
        g = self.g
        if self.phase not in ("bidding1", "bidding2") or g["turn"] != seat:
            return [self.fx("invalid", to=token, msg="Not your call")]
        p = self.players[g["seats"][seat]]

        if call == "pass":
            if self._dealer_stuck(seat):
                return [self.fx("invalid", to=token,
                                msg="Stick the dealer — you must name a suit")]
            g["passes"] += 1
            fx = [self.fx("bid_pass", seat=seat, pid=p.pid)]
            if g["passes"] < 4:
                g["turn"] = (seat + 1) % 4
                self._arm_turn()
                return fx
            if self.phase == "bidding1":
                # everyone passed round 1: turn it down, same order again
                self.phase = "bidding2"
                g["turned_down"] = g["upcard"][1]
                g["passes"] = 0
                g["turn"] = (g["dealer"] + 1) % 4
                fx.append(self.fx("turned_down", suit=g["turned_down"],
                                  card=g["upcard"]))
                self._arm_turn()
                return fx
            # round 2 all passed (stick-the-dealer off): throw the hand in
            fx.append(self.fx("redeal"))
            fx.append(self.fx("toast", icon="🃏",
                              msg="Nobody wants it — throw it in, next deal"))
            fx.extend(self._start_hand())
            return fx

        if call == "order":
            if self.phase != "bidding1":
                return [self.fx("invalid", to=token, msg="Naming happens now"
                                " — pick a suit or pass")]
            return self._set_trump(seat, g["upcard"][1], alone,
                                   ordered=True, token=token)

        if call == "call":
            if self.phase != "bidding2":
                return [self.fx("invalid", to=token,
                                msg="Order it up or pass first")]
            if not isinstance(suit, str) or len(suit) != 1 or suit not in rules.SUITS:
                return [self.fx("invalid", to=token, msg="Pick a real suit")]
            if suit == g["turned_down"]:
                return [self.fx("invalid", to=token,
                                msg="That suit was turned down")]
            return self._set_trump(seat, suit, alone,
                                   ordered=False, token=token)

        return [self.fx("invalid", to=token, msg="Order, call, or pass")]

    def _set_trump(self, seat, suit, alone, ordered, token=None):
        g = self.g
        p = self.players[g["seats"][seat]]
        g["trump"] = suit
        g["maker"] = seat
        g["alone"] = bool(alone)
        g["sitting_out"] = (seat + 2) % 4 if alone else None
        kind = "ordered" if ordered else "called"
        fx = [self.fx(kind, seat=seat, pid=p.pid, suit=suit,
                      alone=g["alone"])]
        if g["alone"]:
            fx.append(self.fx("toast", icon="🚀",
                              msg="%s goes ALONE — %s sits out"
                              % (p.name, self._pname(g["sitting_out"]))))
        if ordered and g["dealer"] != g["sitting_out"]:
            # dealer takes the upcard and buries one
            g["hands"][g["dealer"]].append(g["upcard"])
            self.phase = "discard"
            g["turn"] = g["dealer"]
            self._arm_turn()
            return fx
        # round-2 call, or the pickup is moot (benched dealer): play begins
        fx.extend(self._enter_play())
        return fx

    def _do_discard(self, seat, card, token=None):
        g = self.g
        if self.phase != "discard" or seat != g["dealer"]:
            return [self.fx("invalid", to=token, msg="No card to bury")]
        hand = g["hands"][seat]
        if not isinstance(card, str) or card not in hand:
            return [self.fx("invalid", to=token, msg="Not in your hand")]
        hand.remove(card)          # face-down: the card is never serialized
        fx = [self.fx("picked", pid=self.players[g["seats"][seat]].pid)]
        fx.extend(self._enter_play())
        return fx

    def _enter_play(self):
        g = self.g
        leader = ((g["maker"] + 1) % 4 if g["alone"]
                  else (g["dealer"] + 1) % 4)
        if leader == g["sitting_out"]:      # only reachable when not alone-led
            leader = self._next_active(leader)
        g["turn"] = leader
        self.phase = "playing"
        self._arm_turn()
        return [self.fx("play_begins", turn=leader, trump=g["trump"])]

    def _do_play(self, seat, card, token=None):
        g = self.g
        if self.phase != "playing" or g["turn"] != seat:
            return [self.fx("invalid", to=token, msg="Not your turn")]
        hand = g["hands"][seat]
        if not isinstance(card, str) or card not in hand:
            return [self.fx("invalid", to=token, msg="Not in your hand")]
        legal = rules.legal_plays(hand, g["trick"], g["trump"])
        if card not in legal:
            led = rules.effective_suit(g["trick"][0][1], g["trump"])
            why = "Follow %s%s" % (
                SUIT_NAME[led],
                " — the left bower is trump" if led == g["trump"] else "")
            return [self.fx("invalid", to=token, msg=why)]
        hand.remove(card)
        g["trick"].append((seat, card))
        g["played"].append(card)
        p = self.players[g["seats"][seat]]
        fx = [self.fx("played", seat=seat, pid=p.pid, card=card)]
        if len(g["trick"]) == self._active_count():
            winner = rules.trick_winner(g["trick"], g["trump"])
            g["tricks_won"][winner] += 1
            g["last_trick"] = {"cards": [(s, c) for s, c in g["trick"]],
                               "winner": winner}
            g["trick"] = []
            g["turn"] = winner
            wp = self.players[g["seats"][winner]]
            fx.append(self.fx("trick_won", seat=winner, pid=wp.pid))
            if sum(g["tricks_won"].values()) == 5:
                fx.extend(self._end_hand())
                return fx
        else:
            g["turn"] = self._next_active(seat)
        self._arm_turn()
        return fx

    # ---------------- hand scoring / game end ----------------

    def _end_hand(self):
        g = self.g
        team_tricks = {t: g["tricks_won"][t] + g["tricks_won"][t + 2]
                       for t in (0, 1)}
        res = rules.score_hand(g["maker"] % 2, team_tricks, g["alone"])
        g["scores"][res["team"]] += res["points"]
        g["hand_result"] = {
            "maker_seat": g["maker"],
            "maker_team": g["maker"] % 2,
            "alone": g["alone"],
            "trump": g["trump"],
            "tricks": {str(t): team_tricks[t] for t in (0, 1)},
            "scoring_team": res["team"],
            "points": res["points"],
            "euchred": res["euchred"],
            "march": res["march"],
        }
        self.phase = "hand_end"
        self._bump(time.time() + HAND_END_SECONDS)
        return [self.fx("hand_end")]

    def _maybe_finish(self):
        g = self.g
        a, b = g["scores"][0], g["scores"][1]
        target = self.settings["target"]
        if a >= target or b >= target:
            winner = 0 if a > b else 1     # only one team scores per hand
            g["result"] = {"winner_team": winner,
                           "scores": {str(t): g["scores"][t] for t in (0, 1)},
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
        if self.phase not in ("bidding1", "bidding2", "discard", "playing") \
                or g is None:
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
        if self.phase == "bidding1":
            act = bot.bid1(self._bid_view(seat))
            if act[0] == "order":
                return self._do_bid(seat, "order", alone=bool(act[1]))
            return self._do_bid(seat, "pass")
        if self.phase == "bidding2":
            act = bot.bid2(self._bid_view(seat))
            if act[0] == "call":
                suit, alone = act[1], bool(act[2])
                if suit not in rules.SUITS or suit == g["turned_down"]:
                    # bots must never wedge the game
                    suit = next(s for s in rules.SUITS
                                if s != g["turned_down"])
                    alone = False
                return self._do_bid(seat, "call", suit=suit, alone=alone)
            if self._dealer_stuck(seat):    # stuck dealer must call something
                return self._do_bid(seat, "call",
                                    suit=next(s for s in rules.SUITS
                                              if s != g["turned_down"]))
            return self._do_bid(seat, "pass")
        if self.phase == "discard":
            card = bot.discard(list(g["hands"][seat]), g["trump"])
            if card not in g["hands"][seat]:
                card = g["hands"][seat][0]
            return self._do_discard(seat, card)
        if self.phase == "playing":
            card = bot.play(self._bot_view(seat))
            legal = rules.legal_plays(g["hands"][seat], g["trick"], g["trump"])
            if card not in legal:      # bots must never wedge the game
                card = min(legal, key=rules.rank_of)
            return self._do_play(seat, card)
        return []

    def next_bot_action(self):
        if self.phase not in ("bidding1", "bidding2", "discard", "playing") \
                or self.g is None:
            return None
        seat = self.g["turn"]
        if self._seat_is_auto(seat):
            delay = 0.9 + self.rng.random() * 0.9
            if self.phase in ("bidding1", "bidding2"):
                delay += 0.4
            return (delay, self.g["seats"][seat])
        return None

    def run_bot(self, bot_token):
        if self.phase not in ("bidding1", "bidding2", "discard", "playing") \
                or self.g is None:
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
            p = self.players.get(g["seats"][s])
            seats.append({
                "seat": s,
                "pid": p.pid if p else None,
                "team": s % 2,
                "tricks": g["tricks_won"].get(s, 0) if "tricks_won" in g else 0,
                "cards_left": len(g["hands"][s]) if "hands" in g else 0,
                "auto": self._seat_is_auto(s),
                "sitting_out": s == g.get("sitting_out"),
            })
        my_seat = self._seat_of(viewer_token) if viewer_token else None
        return {
            "kind": "euchre",
            "stage": self.phase,
            "seats": seats,
            "my_seat": my_seat,
            "hand": (rules.sort_hand(g["hands"][my_seat], g.get("trump"))
                     if my_seat is not None else None),
            "turn": g.get("turn"),
            "dealer": g["dealer"],
            "hand_no": g["hand_no"],
            "upcard": g["upcard"] if self.phase == "bidding1" else None,
            "turned_down": g.get("turned_down"),
            "trump": g.get("trump"),
            "maker_seat": g.get("maker"),
            "maker_team": (g["maker"] % 2) if g.get("maker") is not None else None,
            "alone": g.get("alone", False),
            "sitting_out": g.get("sitting_out"),
            "stick_dealer": self.settings["stick_dealer"],
            "trick": [{"seat": s, "card": c} for s, c in g.get("trick", [])],
            "last_trick": ({"cards": [{"seat": s, "card": c}
                                      for s, c in g["last_trick"]["cards"]],
                            "winner": g["last_trick"]["winner"]}
                           if g.get("last_trick") else None),
            "turn_seconds": self.settings["turn_seconds"],
            "scores": {str(t): g["scores"][t] for t in (0, 1)},
            "target": self.settings["target"],
            "hand_result": g["hand_result"],
            "result": g["result"],
        }
