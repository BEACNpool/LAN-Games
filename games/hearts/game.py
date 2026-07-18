"""Hearts — 4-seat trick-taking, no partners, LOWEST score wins.

Mirrors the Spades session shape (games/spades/game.py, the hub's reference):
  * game_start() seats humans in ready order, bots fill the empty chairs
  * each hand: a passing phase (left/right/across/hold by hand number, 3
    cards each) -> the 2♣ holder opens -> 13 tricks -> the scoreboard
  * game_action() validates "pass" and "play"; game_tick() autopilots
    timeouts (whole passing phase shares one deadline; play is per turn)
  * next_bot_action()/run_bot() drive bot passes and plays — a seat whose
    human disconnected is played by the autopilot the same way
  * game_state() serializes a PERSONALIZED view (only your own hand, your
    own picks, and — on your turn — your legal cards)

Seats 0..3 clockwise. Solo works: MIN_PLAYERS 1, three bots sit in.
"""

from __future__ import annotations

import time

from core.session import GameSession
from games.hearts import rules
from games.hearts.bots import make_bot

HAND_END_SECONDS = 12          # scoreboard recap between hands
BOT_NAMES = ["VEGA", "ONYX", "JINX", "NOVA"]


class HeartsSession(GameSession):
    MIN_PLAYERS = 1     # solo vs three bots is a real game
    MAX_HUMANS = 8      # only 4 get seats; the rest can watch from the lobby
    DEFAULT_SETTINGS = {
        "target": 100,             # match ends at/after this; LOWEST wins
        "difficulty": "standard",  # bot tier: "standard" | "rookie"
        "turn_seconds": 30,        # per play (and the whole passing phase)
    }

    def __init__(self, rng=None):
        super().__init__(rng)
        self.g = None              # whole game state; None outside a game

    # ---------------- settings ----------------

    def validate_settings(self, patch):
        ok = {}
        t = patch.get("target")
        if isinstance(t, int) and not isinstance(t, bool) and t in (50, 100):
            ok["target"] = t
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
        fx = [self.fx("toast", to=t, icon="🪑",
                      msg="Table seats 4 — you're watching this one")
              for t in benched]
        seats = list(humans) + [None] * (4 - len(humans))
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
            "scores": {s: 0 for s in range(4)},
            "hand_result": None,
            "result": None,
        }
        fx.append(self.fx("toast", icon="♥",
                          msg="First to %d ends it — LOWEST score wins"
                          % self.settings["target"]))
        fx.extend(self._start_hand())
        return fx

    def _start_hand(self):
        g = self.g
        g["hand_no"] += 1
        deck = list(rules.DECK)
        self.rng.shuffle(deck)
        g["hands"] = {s: deck[13 * s:13 * (s + 1)] for s in range(4)}
        g["pass_dir"] = rules.pass_direction(g["hand_no"])
        g["passes"] = {s: None for s in range(4)}
        g["received"] = {s: [] for s in range(4)}
        g["taken"] = {s: [] for s in range(4)}
        g["trick"] = []
        g["trick_no"] = 1
        g["last_trick"] = None
        g["played"] = []
        g["hearts_broken"] = False
        g["hand_result"] = None
        g["turn"] = None
        fx = [self.fx("hand_start", hand=g["hand_no"], dir=g["pass_dir"])]
        if g["pass_dir"] == "hold":
            fx.extend(self._begin_play())
        else:
            self.phase = "passing"
            self._arm_turn()
        return fx

    def _begin_play(self):
        g = self.g
        leader = next(s for s in range(4) if rules.TWO_CLUBS in g["hands"][s])
        g["turn"] = leader
        self.phase = "playing"
        self._arm_turn()
        return [self.fx("play_begins", turn=leader,
                        pid=self.players[g["seats"][leader]].pid)]

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

    def _pts_by_seat(self):
        return rules.hand_points(self.g["taken"])

    def _bot_for(self, seat):
        return self.g["bots"].get(self.g["seats"][seat], self.g["autopilot"])

    def _bot_view(self, seat):
        g = self.g
        return {
            "hand": list(g["hands"][seat]),
            "seat": seat,
            "trick": [(s, c) for s, c in g["trick"]],
            "trick_no": g["trick_no"],
            "hearts_broken": g["hearts_broken"],
            "played": list(g["played"]),
            "pts": self._pts_by_seat(),
        }

    # ---------------- actions ----------------

    def game_action(self, token, msg):
        self.seq += 1
        t = msg.get("t")
        seat = self._seat_of(token)
        if seat is None:
            return [self.fx("invalid", to=token, msg="You're watching this one")]
        if t == "pass":
            return self._do_pass(seat, msg.get("cards"), token)
        if t == "play":
            return self._do_play(seat, msg.get("card"), token)
        return [self.fx("invalid", to=token, msg="Unknown action")]

    def _do_pass(self, seat, cards, token=None):
        g = self.g
        if self.phase != "passing":
            return [self.fx("invalid", to=token, msg="Not the passing phase")]
        if g["passes"][seat] is not None:
            return [self.fx("invalid", to=token, msg="You already passed")]
        if (not isinstance(cards, list) or len(cards) != rules.PASS_COUNT
                or not all(isinstance(c, str) for c in cards)
                or len(set(cards)) != rules.PASS_COUNT
                or any(c not in g["hands"][seat] for c in cards)):
            return [self.fx("invalid", to=token,
                            msg="Pick exactly 3 of your cards")]
        g["passes"][seat] = list(cards)
        p = self.players[g["seats"][seat]]
        fx = [self.fx("passed", seat=seat, pid=p.pid)]
        if all(v is not None for v in g["passes"].values()):
            fx.extend(self._resolve_passes())
        return fx

    def _resolve_passes(self):
        g = self.g
        for s in range(4):
            for c in g["passes"][s]:
                g["hands"][s].remove(c)
        for s in range(4):
            tgt = rules.pass_target(s, g["pass_dir"])
            g["hands"][tgt].extend(g["passes"][s])
            g["received"][tgt] = list(g["passes"][s])
        fx = [self.fx("passes_done", dir=g["pass_dir"])]
        fx.extend(self._begin_play())
        return fx

    def _why_illegal(self, seat, card):
        g = self.g
        if not g["trick"]:
            if g["trick_no"] == 1:
                return "The 2♣ opens the hand"
            return "Hearts aren't broken yet"
        led = rules.suit_of(g["trick"][0][1])
        if any(rules.suit_of(c) == led for c in g["hands"][seat]):
            return "Follow suit"
        return "No point cards on the first trick"

    def _do_play(self, seat, card, token=None):
        g = self.g
        if self.phase != "playing" or g["turn"] != seat:
            return [self.fx("invalid", to=token, msg="Not your turn")]
        hand = g["hands"][seat]
        if not isinstance(card, str) or card not in hand:
            return [self.fx("invalid", to=token, msg="Not in your hand")]
        legal = rules.legal_plays(hand, g["trick"], g["hearts_broken"],
                                  g["trick_no"])
        if card not in legal:
            return [self.fx("invalid", to=token,
                            msg=self._why_illegal(seat, card))]
        hand.remove(card)
        g["trick"].append((seat, card))
        g["played"].append(card)
        p = self.players[g["seats"][seat]]
        fx = [self.fx("played", seat=seat, pid=p.pid, card=card)]
        if rules.is_point(card) and not g["hearts_broken"]:
            g["hearts_broken"] = True
            fx.append(self.fx("hearts_broken", pid=p.pid))
        if card == rules.QUEEN:
            fx.append(self.fx("queen_played", seat=seat, pid=p.pid))
        if len(g["trick"]) == 4:
            winner = rules.trick_winner(g["trick"])
            pts = sum(rules.points_of(c) for _, c in g["trick"])
            got_queen = any(c == rules.QUEEN for _, c in g["trick"])
            g["taken"][winner].extend(
                c for _, c in g["trick"] if rules.is_point(c))
            g["last_trick"] = {"cards": [(s, c) for s, c in g["trick"]],
                               "winner": winner, "pts": pts}
            g["trick"] = []
            g["turn"] = winner
            wp = self.players[g["seats"][winner]]
            fx.append(self.fx("trick_won", seat=winner, pid=wp.pid, pts=pts))
            if got_queen:
                fx.append(self.fx("queen_taken", seat=winner, pid=wp.pid))
            if all(len(h) == 0 for h in g["hands"].values()):
                fx.extend(self._end_hand())
                return fx
            g["trick_no"] += 1
        else:
            g["turn"] = (seat + 1) % 4
        self._arm_turn()
        return fx

    # ---------------- hand scoring / game end ----------------

    def _end_hand(self):
        g = self.g
        res = rules.score_hand(g["taken"])
        for s in range(4):
            g["scores"][s] += res["deltas"][s]
        g["hand_result"] = {
            "pts": {str(s): res["pts"][s] for s in range(4)},
            "deltas": {str(s): res["deltas"][s] for s in range(4)},
            "totals": {str(s): g["scores"][s] for s in range(4)},
            "moon": res["moon"],
        }
        fx = []
        if res["moon"] is not None:
            mp = self.players[g["seats"][res["moon"]]]
            fx.append(self.fx("moon", seat=res["moon"], pid=mp.pid))
        self.phase = "hand_end"
        self._bump(time.time() + HAND_END_SECONDS)
        fx.append(self.fx("hand_end"))
        return fx

    def _maybe_finish(self):
        g = self.g
        winner = rules.match_winner(g["scores"], self.settings["target"])
        if winner is None:
            return None
        standings = sorted(range(4), key=lambda s: (g["scores"][s], s))
        g["result"] = {
            "winner_seat": winner,
            "winner_pid": self.players[g["seats"][winner]].pid,
            "standings": [{"seat": s,
                           "pid": self.players[g["seats"][s]].pid,
                           "score": g["scores"][s]} for s in standings],
            "hands": g["hand_no"],
        }
        fx = [self.fx("game_over", pid=g["result"]["winner_pid"])]
        fx.extend(self.end_game())
        return fx

    # ---------------- timers & bots ----------------

    def game_tick(self):
        g = self.g
        if self.phase == "hand_end":
            return self._maybe_finish() or self._start_hand()
        if g is None:
            return []
        if self.phase == "passing":
            fx = []
            for s in range(4):
                if g["passes"][s] is None:
                    p = self.players.get(g["seats"][s])
                    if p is not None and not p.is_bot and p.connected:
                        fx.append(self.fx(
                            "toast", icon="⏱",
                            msg="%s ran out of time — autopilot passes" % p.name))
                    fx.extend(self._auto_pass(s))
            return fx
        if self.phase != "playing":
            return []
        seat = g["turn"]
        p = self.players.get(g["seats"][seat])
        fx = []
        if p is not None and not p.is_bot and p.connected:
            fx.append(self.fx("toast", icon="⏱",
                              msg="%s ran out of time — autopilot" % p.name))
        fx.extend(self._auto_play(seat))
        return fx

    def _auto_pass(self, seat):
        g = self.g
        cards = self._bot_for(seat).pass_cards(list(g["hands"][seat]))
        if (not isinstance(cards, list) or len(set(cards)) != rules.PASS_COUNT
                or any(c not in g["hands"][seat] for c in cards)):
            # bots must never wedge the game
            cards = sorted(g["hands"][seat], key=rules.rank_of)[-3:]
        return self._do_pass(seat, list(cards))

    def _auto_play(self, seat):
        g = self.g
        card = self._bot_for(seat).play(self._bot_view(seat))
        legal = rules.legal_plays(g["hands"][seat], g["trick"],
                                  g["hearts_broken"], g["trick_no"])
        if card not in legal:          # bots must never wedge the game
            card = min(legal, key=rules.rank_of)
        return self._do_play(seat, card)

    def next_bot_action(self):
        if self.g is None:
            return None
        g = self.g
        if self.phase == "passing":
            for s in range(4):
                if g["passes"][s] is None and self._seat_is_auto(s):
                    return (0.6 + self.rng.random() * 0.8, g["seats"][s])
            return None
        if self.phase == "playing":
            seat = g["turn"]
            if self._seat_is_auto(seat):
                return (0.9 + self.rng.random() * 0.9, g["seats"][seat])
        return None

    def run_bot(self, bot_token):
        if self.g is None:
            return []
        g = self.g
        if self.phase == "passing":
            seat = self._seat_of(bot_token)
            if (seat is None or g["passes"][seat] is not None
                    or not self._seat_is_auto(seat)):
                return []
            self.seq += 1
            return self._auto_pass(seat)
        if self.phase == "playing":
            seat = g["turn"]
            if g["seats"][seat] != bot_token or not self._seat_is_auto(seat):
                return []
            self.seq += 1
            return self._auto_play(seat)
        return []

    # ---------------- connection events ----------------

    def game_player_left(self, token):
        seat = self._seat_of(token)
        if seat is None:
            return []
        p = self.players[token]
        return [self.fx("toast", icon="🛰",
                        msg="%s dropped — autopilot takes seat %d"
                        % (p.name, seat + 1))]

    def game_player_back(self, token):
        seat = self._seat_of(token)
        if seat is None:
            return []
        p = self.players[token]
        return [self.fx("toast", msg="%s is back at the table" % p.name,
                        icon=p.avatar)]

    # ---------------- serialization ----------------

    def _moon_threat(self):
        """Seat visibly hoovering EVERY point taken so far, or None."""
        pts = self._pts_by_seat()
        holders = [s for s, p in pts.items() if p > 0]
        if len(holders) == 1 and pts[holders[0]] >= 13:
            return holders[0]
        return None

    def game_state(self, viewer_token):
        g = self.g
        if g is None:
            return None
        pts = self._pts_by_seat()
        seats = []
        for s in range(4):
            p = self.players.get(g["seats"][s])
            seats.append({
                "seat": s,
                "pid": p.pid if p else None,
                "pts": pts[s],
                "score": g["scores"][s],
                "cards_left": len(g["hands"][s]),
                "passed": g["passes"][s] is not None,
                "auto": self._seat_is_auto(s),
            })
        my_seat = self._seat_of(viewer_token) if viewer_token else None
        pass_to = None
        if my_seat is not None and g["pass_dir"] != "hold":
            tp = self.players.get(
                g["seats"][rules.pass_target(my_seat, g["pass_dir"])])
            pass_to = tp.pid if tp else None
        st = {
            "kind": "hearts",
            "stage": self.phase,
            "seats": seats,
            "my_seat": my_seat,
            "hand": (rules.sort_hand(g["hands"][my_seat])
                     if my_seat is not None else None),
            "my_pass": g["passes"][my_seat] if my_seat is not None else None,
            "received": (g["received"][my_seat]
                         if my_seat is not None else None),
            "legal": (rules.legal_plays(g["hands"][my_seat], g["trick"],
                                        g["hearts_broken"], g["trick_no"])
                      if my_seat is not None and self.phase == "playing"
                      and g["turn"] == my_seat else None),
            "pass_dir": g["pass_dir"],
            "pass_to": pass_to,
            "turn": g["turn"],
            "trick": [{"seat": s, "card": c} for s, c in g["trick"]],
            "last_trick": ({"cards": [{"seat": s, "card": c}
                                      for s, c in g["last_trick"]["cards"]],
                            "winner": g["last_trick"]["winner"],
                            "pts": g["last_trick"]["pts"]}
                           if g["last_trick"] else None),
            "hearts_broken": g["hearts_broken"],
            "trick_no": g["trick_no"],
            "hand_no": g["hand_no"],
            "turn_seconds": self.settings["turn_seconds"],
            "scores": {str(s): g["scores"][s] for s in range(4)},
            "target": self.settings["target"],
            "moon_threat": (self._moon_threat()
                            if self.phase == "playing" else None),
            "hand_result": g["hand_result"],
            "result": g["result"],
        }
        return st
