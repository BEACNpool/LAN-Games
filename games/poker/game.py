"""TEXAS HOLD'EM — No-Limit Texas Hold'em for the GAMEHUB platform.

A single-table No-Limit Hold'em cash-style *elimination* game: everyone starts
with an equal stack, blinds rise on a schedule, bots fill empty chairs, and the
last player with chips wins the match.  Built entirely on the GAMEHUB
``GameSession`` contract (synchronous, IO-free; the net layer owns sockets,
timers, and bot scheduling).

The engine is deliberately split from the pure rules: ``rules.py`` holds card /
hand-evaluation / side-pot math (heavily unit-tested); this file is the betting
state machine and the multi-hand match loop.  Correctness targets that cost real
engines bugs and are handled explicitly here: the heads-up blind/act inversion,
the big-blind option, the min-raise increment, the action-reopening rule on
short all-ins, all-in side pots with dead money, split pots + odd chips, and
per-viewer hole-card masking.
"""

import time

from core.session import GameSession
from . import rules, bots

BETTING = ("preflop", "flop", "turn", "river")

RUNOUT_GAP = 1.1         # seconds between board cards during an all-in runout
SHOWDOWN_RECAP = 5.5     # results-of-hand pause when cards are shown
FOLD_RECAP = 2.0         # shorter pause when everyone folded (no showdown)

# Blind/stack presets. Each preset bundles a starting stack, base blinds, and
# how fast the blinds escalate (guarantees the match terminates).
SPEEDS = {
    "turbo":    {"stack": 1000, "sb": 10, "bb": 20, "rise_every": 6,  "rise_mult": 2},
    "standard": {"stack": 1500, "sb": 10, "bb": 20, "rise_every": 10, "rise_mult": 2},
    "deep":     {"stack": 3000, "sb": 10, "bb": 20, "rise_every": 14, "rise_mult": 2},
}


class PokerSession(GameSession):
    MIN_PLAYERS = 1          # solo vs bots is fine
    MAX_HUMANS = 9           # a full ring
    DEFAULT_SETTINGS = {
        "table_size": 6,     # target seats; expands to fit humans, bots fill the rest
        "speed": "standard",
        "difficulty": "mixed",
        "turn_seconds": 25,
    }

    def __init__(self, rng=None):
        super().__init__(rng)
        self.g = None

    # ---- lobby ------------------------------------------------------------
    def validate_settings(self, patch):
        ok = {}
        ts = patch.get("table_size")
        if isinstance(ts, int) and not isinstance(ts, bool) and ts in (2, 4, 6, 9):
            ok["table_size"] = ts
        sp = patch.get("speed")
        if sp in SPEEDS:
            ok["speed"] = sp
        d = patch.get("difficulty")
        if d in ("mixed", "fish", "shark", "maniac"):
            ok["difficulty"] = d
        t = patch.get("turn_seconds")
        if isinstance(t, int) and not isinstance(t, bool) and 10 <= t <= 60:
            ok["turn_seconds"] = t
        return ok

    def _speed(self):
        return SPEEDS.get(self.settings.get("speed"), SPEEDS["standard"])

    # ---- start ------------------------------------------------------------
    def game_start(self):
        st = self._speed()
        target = self.settings["table_size"]
        humans = self.participants[:9]              # ring cap
        benched = self.participants[9:]
        self.participants = list(humans)
        seats = list(humans)

        size = min(9, max(len(seats), target))      # expand to fit humans; fill rest with bots
        diff = self.settings["difficulty"]
        tier_cycle = ["fish", "shark", "maniac"]
        seed = self.rng.getrandbits(48)

        bots_map, tiers_map = {}, {}
        bi = 0
        while len(seats) < size:
            b = self.add_bot("%s" % bots.BOT_NAMES[bi % len(bots.BOT_NAMES)])
            seats.append(b.token)
            self.participants.append(b.token)
            tier = tier_cycle[bi % 3] if diff == "mixed" else diff
            tiers_map[b.token] = tier
            bots_map[b.token] = bots.make_bot(tier, seed)
            bi += 1

        n = len(seats)
        self.g = {
            "n": n, "seats": seats, "bots": bots_map, "tiers": tiers_map,
            "autopilot": bots.make_bot("shark", seed ^ 0x9E3779B9),
            "seed": seed, "button": None, "hand_no": 0,
            "base_sb": st["sb"], "base_bb": st["bb"],
            "rise_every": st["rise_every"], "rise_mult": st["rise_mult"],
            "sb": st["sb"], "bb": st["bb"], "start_stack": st["stack"],
            "stack": [st["stack"]] * n, "busted": [],
            "result": None, "hand_result": None,
            # per-hand fields (filled by _start_hand)
            "board": [], "hole": {}, "in_hand": {}, "all_in": {},
            "committed": {}, "contrib": {}, "acted": {}, "last_action": {},
            "current_bet": 0, "last_raise": 0, "aggressor": None,
            "preflop_aggressor": None, "to_act": None,
            "actions_this_street": 0, "deck": [],
        }
        fx = [self.fx("toast", to=t, icon="🪑", msg="Table's full — you're railing this one")
              for t in benched]
        fx.append(self.fx("toast", icon="🃏",
                          msg="No-Limit Hold'em — %d seats, blinds %d/%d" % (n, st["sb"], st["bb"])))
        fx.extend(self._start_hand())
        return fx

    # ---- deck helpers -----------------------------------------------------
    def _draw(self, k=1):
        return [self.g["deck"].pop() for _ in range(k)]

    def _burn(self):
        if self.g["deck"]:
            self.g["deck"].pop()

    # ---- per-hand setup ---------------------------------------------------
    def _alive(self, seat):
        return self.g["stack"][seat] > 0

    def _next_alive(self, seat):
        n = self.g["n"]
        for k in range(1, n + 1):
            s = (seat + k) % n
            if self.g["stack"][s] > 0:
                return s
        return seat

    def _start_hand(self):
        g = self.g
        g["hand_no"] += 1
        level = (g["hand_no"] - 1) // g["rise_every"]
        g["sb"] = g["base_sb"] * (g["rise_mult"] ** level)
        g["bb"] = g["base_bb"] * (g["rise_mult"] ** level)
        n = g["n"]
        alive = [s for s in range(n) if g["stack"][s] > 0]

        if g["button"] is None:
            g["button"] = self.rng.choice(alive)
        else:
            g["button"] = self._next_alive(g["button"])

        g["board"] = []
        g["hole"] = {}
        g["hand_result"] = None
        g["in_hand"] = {s: (g["stack"][s] > 0) for s in range(n)}
        g["all_in"] = {s: False for s in range(n)}
        g["committed"] = {s: 0 for s in range(n)}
        g["contrib"] = {s: 0 for s in range(n)}
        g["acted"] = {s: False for s in range(n)}
        g["last_action"] = {s: None for s in range(n)}
        g["current_bet"] = 0
        g["last_raise"] = g["bb"]
        g["aggressor"] = None
        g["preflop_aggressor"] = None
        g["actions_this_street"] = 0

        deck = list(rules.DECK)
        self.rng.shuffle(deck)
        g["deck"] = deck
        for s in alive:
            g["hole"][s] = self._draw(2)

        if len(alive) == 2:                          # heads-up: button IS the small blind
            sb_seat = g["button"]
            bb_seat = self._next_alive(g["button"])
            first = g["button"]                      # SB/button acts first preflop
        else:
            sb_seat = self._next_alive(g["button"])
            bb_seat = self._next_alive(sb_seat)
            first = self._next_alive(bb_seat)        # UTG

        self.phase = "preflop"
        fx = [self.fx("hand_start", hand=g["hand_no"], button=g["button"],
                      sb_seat=sb_seat, bb_seat=bb_seat, sb=g["sb"], bb=g["bb"])]
        fx += self._post_blind(sb_seat, g["sb"], "sb")
        fx += self._post_blind(bb_seat, g["bb"], "bb")
        g["current_bet"] = g["bb"]                   # nominal BB is the opening bet
        g["last_raise"] = g["bb"]
        g["aggressor"] = bb_seat

        opener = self._first_can_act_from(first)
        if opener is None:
            # everyone was put all-in by the blinds -> run the board out
            g["to_act"] = None
            fx += self._close_street()
            return fx
        g["to_act"] = opener
        self._arm_turn()
        return fx

    def _first_can_act_from(self, start):
        g = self.g
        n = g["n"]
        for k in range(n):
            s = (start + k) % n
            if g["in_hand"][s] and not g["all_in"][s]:
                return s
        return None

    def _post_blind(self, seat, amount, kind):
        put = min(amount, self.g["stack"][seat])
        self._commit(seat, put)
        self.g["last_action"][seat] = kind
        p = self.players.get(self.g["seats"][seat])
        return [self.fx("post_blind", seat=seat, pid=(p.pid if p else None),
                        blind=kind, amount=put, allin=self.g["all_in"][seat])]

    def _commit(self, seat, amount):
        g = self.g
        amount = min(amount, g["stack"][seat])
        g["stack"][seat] -= amount
        g["committed"][seat] += amount
        g["contrib"][seat] += amount
        if g["stack"][seat] == 0:
            g["all_in"][seat] = True

    def _arm_turn(self):
        self._bump(time.time() + self.settings["turn_seconds"])

    # ---- human/bot action -------------------------------------------------
    def game_action(self, token, msg):
        self.seq += 1
        g = self.g
        if g is None or self.phase not in BETTING:
            return [self.fx("invalid", to=token, msg="No action right now")]
        seat = self._seat_of(token)
        if seat is None:
            return [self.fx("invalid", to=token, msg="You're not in this hand")]
        if not isinstance(msg, dict):
            return [self.fx("invalid", to=token, msg="Bad message")]
        move = msg.get("move")
        if not isinstance(move, str) or move not in ("fold", "check", "call", "bet", "raise", "allin"):
            return [self.fx("invalid", to=token, msg="Unknown action")]
        amount = msg.get("amount", 0)
        if not isinstance(amount, int) or isinstance(amount, bool):
            amount = 0
        if g["to_act"] != seat:
            return [self.fx("invalid", to=token, msg="Not your turn")]
        return self._do_action(seat, move, amount, token)

    def _do_action(self, seat, move, amount=0, token=None):
        """The single validated action path for humans, bots, and autopilot.

        Returns fx.  On illegal input returns a lone ``invalid`` fx (never
        raises), so a malformed client message can't crash or wedge the table.
        """
        g = self.g
        if self.phase not in BETTING:
            return [self.fx("invalid", to=token, msg="No action right now")]
        if g["to_act"] != seat:
            return [self.fx("invalid", to=token, msg="Not your turn")]
        if not g["in_hand"][seat] or g["all_in"][seat]:
            return [self.fx("invalid", to=token, msg="You can't act")]

        to_call = g["current_bet"] - g["committed"][seat]
        stack = g["stack"][seat]
        max_to = g["committed"][seat] + stack

        if move == "allin":                          # normalize a shove
            move = "raise" if max_to > g["current_bet"] else "call"
            amount = max_to

        if move == "fold":
            g["in_hand"][seat] = False
            g["acted"][seat] = True
            label, put = "fold", 0
        elif move == "check":
            if to_call > 0:
                return [self.fx("invalid", to=token, msg="Can't check facing a bet")]
            g["acted"][seat] = True
            label, put = "check", 0
        elif move == "call":
            g["acted"][seat] = True
            if to_call <= 0:
                label, put = "check", 0
            else:
                put = min(to_call, stack)
                self._commit(seat, put)
                label = "allin" if g["all_in"][seat] else "call"
        elif move in ("bet", "raise"):
            target = int(amount)
            if target <= g["current_bet"]:
                return [self.fx("invalid", to=token, msg="Raise must exceed the current bet")]
            if not ((not g["acted"][seat]) and stack > to_call):
                return [self.fx("invalid", to=token, msg="You can only call or fold")]
            if target > max_to:
                return [self.fx("invalid", to=token, msg="You don't have that many chips")]
            is_allin = (target == max_to)
            min_to = g["current_bet"] + g["last_raise"]
            if target < min_to and not is_allin:
                return [self.fx("invalid", to=token, msg="Raise must be to at least %d" % min_to)]
            old_bet = g["current_bet"]
            put = target - g["committed"][seat]
            self._commit(seat, put)
            g["acted"][seat] = True
            increment = g["committed"][seat] - old_bet
            g["current_bet"] = g["committed"][seat]
            if increment >= g["last_raise"]:         # full raise -> reopen betting
                g["last_raise"] = increment
                for s in range(g["n"]):
                    if s != seat and g["in_hand"][s] and not g["all_in"][s]:
                        g["acted"][s] = False
            g["aggressor"] = seat
            if self.phase == "preflop":
                g["preflop_aggressor"] = seat
            label = "allin" if g["all_in"][seat] else ("bet" if old_bet == 0 else "raise")
        else:
            return [self.fx("invalid", to=token, msg="Unknown action")]

        g["last_action"][seat] = label
        g["actions_this_street"] += 1
        p = self.players.get(g["seats"][seat])
        fx = [self.fx("acted", seat=seat, pid=(p.pid if p else None), action=label,
                      amount=put, total=g["committed"][seat],
                      allin=g["all_in"][seat], stack=g["stack"][seat])]
        fx += self._advance_or_close(seat)
        return fx

    def _next_to_act(self, from_seat):
        g = self.g
        n = g["n"]
        for k in range(1, n + 1):
            s = (from_seat + k) % n
            if g["in_hand"][s] and not g["all_in"][s] and \
               (not g["acted"][s] or g["committed"][s] < g["current_bet"]):
                return s
        return None

    def _advance_or_close(self, from_seat):
        if len(self._in_hand_seats()) <= 1:
            # last player standing (everyone else folded) -> hand is over, even
            # if the survivor still nominally "hasn't acted" (e.g. folded to the BB)
            return self._close_street()
        nxt = self._next_to_act(from_seat)
        if nxt is None:
            return self._close_street()
        self.g["to_act"] = nxt
        self._arm_turn()
        return []

    # ---- street transitions ----------------------------------------------
    def _in_hand_seats(self):
        return [s for s in range(self.g["n"]) if self.g["in_hand"][s]]

    def _close_street(self):
        g = self.g
        g["to_act"] = None
        # reset per-street betting state
        g["current_bet"] = 0
        g["last_raise"] = g["bb"]
        g["aggressor"] = None
        g["actions_this_street"] = 0
        for s in range(g["n"]):
            g["committed"][s] = 0
            if g["in_hand"][s] and not g["all_in"][s]:
                g["acted"][s] = False

        live = self._in_hand_seats()
        if len(live) <= 1:
            return self._showdown()                  # everyone folded -> instant win
        can_act = [s for s in live if not g["all_in"][s]]
        if len(can_act) <= 1:                         # no more betting possible
            if len(g["board"]) >= 5:
                return self._showdown()
            self.phase = "runout"
            self._bump(time.time() + RUNOUT_GAP)
            return [self.fx("allin_runout")]
        if self.phase == "river":
            return self._showdown()
        return self._deal_next_street()

    def _first_postflop_actor(self):
        # first in-hand, non-all-in seat clockwise from the button (SB seat, or
        # the big blind heads-up — both are "left of the button", uniform).
        g = self.g
        n = g["n"]
        for k in range(1, n + 1):
            s = (g["button"] + k) % n
            if g["in_hand"][s] and not g["all_in"][s]:
                return s
        return None

    def _deal_next_street(self):
        g = self.g
        b = len(g["board"])
        if b == 0:
            self._burn(); g["board"] += self._draw(3); self.phase = "flop"; street = "flop"
        elif b == 3:
            self._burn(); g["board"] += self._draw(1); self.phase = "turn"; street = "turn"
        else:
            self._burn(); g["board"] += self._draw(1); self.phase = "river"; street = "river"
        g["to_act"] = self._first_postflop_actor()
        self._arm_turn()
        return [self.fx("board", street=street, board=list(g["board"]), cards=list(g["board"]))]

    def _advance_runout(self):
        """Deal one board street per tick during an all-in runout, then showdown."""
        g = self.g
        b = len(g["board"])
        if b >= 5:
            return self._showdown()
        if b == 0:
            self._burn(); g["board"] += self._draw(3); street = "flop"
        elif b == 3:
            self._burn(); g["board"] += self._draw(1); street = "turn"
        else:
            self._burn(); g["board"] += self._draw(1); street = "river"
        self._bump(time.time() + RUNOUT_GAP)
        return [self.fx("board", street=street, board=list(g["board"]),
                        cards=list(g["board"]), runout=True)]

    # ---- showdown / settlement -------------------------------------------
    def _showdown(self):
        g = self.g
        n = g["n"]

        # 1. return any uncalled bet before building pots
        refseat, refamt = rules.uncalled_refund(g["contrib"])
        contrib = dict(g["contrib"])
        refund = None
        if refseat is not None and refamt > 0:
            g["stack"][refseat] += refamt
            contrib[refseat] -= refamt
            refund = {"seat": refseat, "amount": refamt}

        folded = {s: (not g["in_hand"][s]) for s in range(n)}
        pots = rules.build_pots(contrib, folded)

        live = self._in_hand_seats()
        contested = any(len([s for s in p["eligible"] if g["in_hand"][s]]) > 1 for p in pots)

        # Hand strength is evaluated lazily and only when a pot is genuinely
        # contested (>1 eligible) -- at which point the board is always complete
        # (5 cards).  A fold-win never needs it (the lone live seat takes all).
        scores = {}

        def score_of(s):
            if s not in scores:
                scores[s] = rules.best_hand(g["hole"][s] + g["board"])
            return scores[s]

        winnings = {s: 0 for s in range(n)}
        pot_results = []
        for pi, pot in enumerate(pots):
            elig = [s for s in pot["eligible"] if g["in_hand"][s]]
            if not elig:                              # degenerate: all eligible folded
                elig = list(pot["eligible"])
            if len(elig) == 1:
                winners, best = list(elig), None
            else:
                best = max(score_of(s) for s in elig)
                winners = [s for s in elig if score_of(s) == best]
            base = pot["amount"] // len(winners)
            rem = pot["amount"] - base * len(winners)
            # odd chip(s): first winner(s) left of the button, clockwise
            order = sorted(winners, key=lambda s: (s - (g["button"] + 1)) % n)
            for s in winners:
                winnings[s] += base
            for k in range(rem):
                winnings[order[k]] += 1
            pot_results.append({
                "amount": pot["amount"],
                "label": ("Main pot" if pi == 0 else "Side pot %d" % pi),
                "winners": [self._pid(s) for s in winners],
                "winner_seats": winners,
                "best": (rules.hand_name(best) if best else None),
            })

        for s in range(n):
            g["stack"][s] += winnings[s]
        # chips are now back in stacks; clear the middle so total chips are
        # conserved at every step (contrib is rebuilt next hand).
        for s in range(n):
            g["contrib"][s] = 0

        reveal_seats = live if contested else []
        reveal = []
        for s in reveal_seats:
            reveal.append({
                "seat": s, "pid": self._pid(s), "cards": list(g["hole"][s]),
                "hand": rules.hand_desc(score_of(s)),
            })

        winner_seats = [s for s in range(n) if winnings[s] > 0]
        g["hand_result"] = {
            "board": list(g["board"]),
            "pots": pot_results,
            "reveal": reveal,
            "reveal_seats": list(reveal_seats),
            "winnings": {self._pid(s): winnings[s] for s in winner_seats},
            "winner_seats": winner_seats,
            "winner_pids": [self._pid(s) for s in winner_seats],
            "fold_win": not contested,
            "refund": refund,
            "hand_no": g["hand_no"],
        }

        fx = [self.fx("showdown", contested=contested,
                      winners=[self._pid(s) for s in winner_seats],
                      board=list(g["board"]))]
        for s in winner_seats:
            fx.append(self.fx("pot_won", seat=s, pid=self._pid(s), amount=winnings[s]))

        self.phase = "hand_end"
        g["to_act"] = None
        self._bump(time.time() + (SHOWDOWN_RECAP if contested else FOLD_RECAP))
        return fx

    def _maybe_finish(self):
        g = self.g
        n = g["n"]
        for s in range(n):                            # record fresh busts (in seat order)
            if g["stack"][s] == 0 and s not in g["busted"]:
                g["busted"].append(s)
        alive = [s for s in range(n) if g["stack"][s] > 0]
        if len(alive) <= 1:
            winner = alive[0] if alive else (g["busted"][-1] if g["busted"] else 0)
            standings = [winner] + [s for s in reversed(g["busted"]) if s != winner]
            g["result"] = {
                "winner_pid": self._pid(winner),
                "winner_seat": winner,
                "standings": [{"seat": s, "pid": self._pid(s), "stack": g["stack"][s]}
                              for s in standings],
                "hands": g["hand_no"],
            }
            fx = [self.fx("game_over", pid=self._pid(winner))]
            fx.extend(self.end_game())
            return fx
        return None

    # ---- tick -------------------------------------------------------------
    def game_tick(self):
        g = self.g
        if g is None:
            return []
        if self.phase == "hand_end":
            return self._maybe_finish() or self._start_hand()
        if self.phase == "runout":
            return self._advance_runout()
        if self.phase in BETTING:
            seat = g["to_act"]
            if seat is None:
                return []
            p = self.players.get(g["seats"][seat])
            fx = []
            if p is not None and not p.is_bot and p.connected:
                fx.append(self.fx("toast", icon="⏱", msg="%s ran out of time" % p.name))
            fx.extend(self._auto_act(seat, timed_out=True))
            return fx
        return []

    # ---- bots -------------------------------------------------------------
    def _seat_is_auto(self, seat):
        p = self.players.get(self.g["seats"][seat])
        return p is None or p.is_bot or not p.connected

    def next_bot_action(self):
        g = self.g
        if g is None or self.phase not in BETTING:
            return None
        seat = g["to_act"]
        if seat is None:
            return None
        if self._seat_is_auto(seat):
            delay = 0.8 + self.rng.random() * 1.1
            return (delay, g["seats"][seat])
        return None

    def run_bot(self, bot_token):
        g = self.g
        if g is None or self.phase not in BETTING:
            return []
        seat = g["to_act"]
        if seat is None or g["seats"][seat] != bot_token or not self._seat_is_auto(seat):
            return []
        self.seq += 1
        return self._auto_act(seat)

    def _auto_act(self, seat, timed_out=False):
        g = self.g
        p = self.players.get(g["seats"][seat])
        to_call = g["current_bet"] - g["committed"][seat]
        if timed_out and p is not None and not p.is_bot and p.connected:
            # a connected human who idled: standard time-out is check, else fold
            return self._do_action(seat, "check" if to_call <= 0 else "fold", 0)
        brain = g["bots"].get(g["seats"][seat], g["autopilot"])
        try:
            move, amount = brain.decide(self._bot_view(seat))
            res = self._do_action(seat, move, amount)
        except Exception:
            res = [self.fx("invalid", msg="bot error")]
        if len(res) == 1 and res[0].get("kind") == "invalid":   # safety net: never wedge
            return self._do_action(seat, "check" if to_call <= 0 else "fold", 0)
        return res

    def _position(self, seat):
        g = self.g
        n = g["n"]
        idx = (seat - (g["button"] + 1)) % n          # 0=SB, 1=BB, ..., n-1=button
        if n <= 2:
            return "BLIND"
        if idx <= 1:
            return "BLIND"
        if idx >= n - 2:
            return "LATE"
        if idx <= (n // 2):
            return "EARLY"
        return "MIDDLE"

    def _bot_view(self, seat):
        g = self.g
        to_call = max(0, g["current_bet"] - g["committed"][seat])
        stack = g["stack"][seat]
        max_to = g["committed"][seat] + stack
        min_to = min(g["current_bet"] + g["last_raise"], max_to)
        return {
            "street": self.phase,
            "board": list(g["board"]),
            "hole": list(g["hole"][seat]),
            "pot": self._pot_total(),
            "to_call": to_call,
            "my_committed": g["committed"][seat],
            "my_stack": stack,
            "min_raise_to": min_to,
            "max_raise_to": max_to,
            "can_raise": (not g["acted"][seat]) and stack > to_call,
            "big_blind": g["bb"],
            "num_active": sum(1 for s in range(g["n"]) if g["in_hand"][s]),
            "position": self._position(seat),
            "i_opened": g["preflop_aggressor"] == seat,
            "hand_no": g["hand_no"],
            "seat": seat,
            "actions_this_street": g["actions_this_street"],
            "limpers": 0, "callers": 0,
        }

    # ---- disconnect / reconnect (notification only; autopilot via _seat_is_auto)
    def game_player_left(self, token):
        seat = self._seat_of(token)
        if seat is None:
            return []
        p = self.players.get(token)
        return [self.fx("toast", icon="🤖",
                        msg="%s dropped — auto-playing their seat" % (p.name if p else "Player"))]

    def game_player_back(self, token):
        seat = self._seat_of(token)
        if seat is None:
            return []
        p = self.players.get(token)
        return [self.fx("toast", icon=(p.avatar if p else "👋"),
                        msg="%s is back at the table" % (p.name if p else "Player"))]

    # ---- helpers ----------------------------------------------------------
    def _seat_of(self, token):
        if self.g is None or token is None:
            return None
        try:
            return self.g["seats"].index(token)
        except ValueError:
            return None

    def _pid(self, seat):
        p = self.players.get(self.g["seats"][seat])
        return p.pid if p else None

    def _pot_total(self):
        return sum(self.g["contrib"].values())

    # ---- state (per-viewer; masks hole cards) -----------------------------
    def game_state(self, viewer_token):
        g = self.g
        if g is None:
            return None
        n = g["n"]
        my_seat = self._seat_of(viewer_token) if viewer_token else None

        if self.phase == "runout":
            reveal_seats = {s for s in range(n) if g["in_hand"].get(s)}
        elif self.phase == "hand_end" and g["hand_result"]:
            reveal_seats = set(g["hand_result"].get("reveal_seats", []))
        else:
            reveal_seats = set()

        seats = []
        for s in range(n):
            p = self.players.get(g["seats"][s])
            cards = None
            if s in g.get("hole", {}) and (s == my_seat or s in reveal_seats):
                cards = list(g["hole"][s])
            seats.append({
                "seat": s,
                "pid": p.pid if p else None,
                "name": p.name if p else "—",
                "avatar": p.avatar if p else "🪑",
                "pfp": p.pfp if p else None,
                "bot": p.is_bot if p else False,
                "tier": g["tiers"].get(g["seats"][s]),
                "stack": g["stack"][s],
                "committed": g["committed"].get(s, 0),
                "in_hand": g["in_hand"].get(s, False),
                "all_in": g["all_in"].get(s, False),
                "has_cards": g["in_hand"].get(s, False) and s in g.get("hole", {}),
                "cards": cards,
                "last_action": g["last_action"].get(s),
                "auto": self._seat_is_auto(s),
                "is_button": s == g["button"],
                "connected": (p.connected if p else False),
            })

        me = None
        if my_seat is not None and self.phase in BETTING and g["to_act"] == my_seat:
            to_call = max(0, g["current_bet"] - g["committed"][my_seat])
            stack = g["stack"][my_seat]
            max_to = g["committed"][my_seat] + stack
            me = {
                "to_call": min(to_call, stack),
                "can_check": to_call == 0,
                "can_raise": (not g["acted"][my_seat]) and stack > to_call,
                "min_raise_to": min(g["current_bet"] + g["last_raise"], max_to),
                "max_raise_to": max_to,
                "committed": g["committed"][my_seat],
                "stack": stack,
                "current_bet": g["current_bet"],
                "pot": self._pot_total(),
            }

        return {
            "kind": "poker",
            "stage": self.phase,
            "n": n,
            "button": g["button"],
            "sb": g["sb"], "bb": g["bb"], "hand_no": g["hand_no"],
            "board": list(g["board"]),
            "pot": self._pot_total(),
            "current_bet": g["current_bet"],
            "to_act": g["to_act"],
            "my_seat": my_seat,
            "seats": seats,
            "me": me,
            "turn_seconds": self.settings["turn_seconds"],
            "hand_result": g["hand_result"],
            "result": g["result"],
        }
