"""SNAKE ARENA — the hub's first REAL-TIME game. 1-8 snakes (bots fill the
pit), a 44x26 server-authoritative arena that advances every ~130 ms,
apples, a golden apple, corpse pellets, best-of-N rounds.

REAL-TIME WITHOUT THREADS: core.net owns exactly one deadline task per
binding, driven by the session's (deadline, gen) pair. Every play tick
re-arms the deadline ~TICK seconds out before returning, so the binding's
existing timer task IS the game loop: fire -> advance the world one cell
-> push state to every socket -> re-arm. Nothing in core changes.

Clients send only direction changes (a swipe / key press), never
per-frame input, so the 20 msgs / 2 s socket rate limit is never in play.

Bots are computed synchronously inside the tick (games/snake/bots.py) —
the async bot scheduler is for turn-based games and stays unused here.

Simultaneous-move resolution each tick:
  1. everyone's new head = head + heading (one queued turn pops first)
  2. wall exits die
  3. heads landing on the SAME cell: the strictly longest survives,
     everyone else there dies; equal lengths all die
  4. a head landing in any post-move body cell (incl. its own) dies —
     this covers the classic adjacent head-swap, and vacating tails are
     legally enterable because bodies are compared POST-move
  5. dead snakes' cells become 1-point pellets that fade after ~10 s
"""

from __future__ import annotations

import time

from core.session import GameSession
from games.snake import bots

GW, GH = 44, 26                # arena cells
TICK = 0.13                    # seconds per world step
TICK_MS = 130
START_LEN = 4
SPAWN_INSET = 4                # head distance from the wall at spawn
N_APPLES = 3                   # concurrent normal apples
APPLE_SCORE, APPLE_GROW = 10, 3
GOLD_SCORE, GOLD_GROW = 30, 5
GOLD_EVERY_TICKS = 230         # ~30 s of play per round
GOLD_TTL_TICKS = 62            # ~8 s
PELLET_SCORE, PELLET_GROW = 1, 1
PELLET_TTL_TICKS = 77          # ~10 s
SURVIVE_BONUS = 50
MAX_PENDING = 2                # queued direction changes per snake
GRACE_TICKS = 38               # ~5 s of straight drifting after a disconnect
YOUNG_TICKS = 230              # a round is "young" for its first ~30 s
ROUND_END_SECONDS = 4.0
BOT_NAMES = ["VIPER", "COBRA", "MAMBA", "ASP", "BOA", "ADDER", "KRAIT"]

DIR_NAMES = {"up": (0, -1), "down": (0, 1), "left": (-1, 0), "right": (1, 0)}


class SnakeSession(GameSession):
    MIN_PLAYERS = 1            # a lone human gets bot snakes
    MAX_HUMANS = 8
    DEFAULT_SETTINGS = {
        "bot_players": 1,
        "difficulty": "sharp",     # bot brains: sharp | rookie
        "rounds": 3,               # best-of: 1 | 3 | 5
    }

    def __init__(self, rng=None):
        super().__init__(rng)
        self.g = None

    def validate_settings(self, patch):
        ok = {}
        b = patch.get("bot_players")
        if isinstance(b, int) and not isinstance(b, bool) and 0 <= b <= 7:
            ok["bot_players"] = b
        if patch.get("difficulty") in ("rookie", "sharp"):
            ok["difficulty"] = patch["difficulty"]
        r = patch.get("rounds")
        if isinstance(r, int) and not isinstance(r, bool) and r in (1, 3, 5):
            ok["rounds"] = r
        return ok

    # ---------------- lifecycle ----------------

    def game_start(self):
        humans = list(self.participants)
        want_bots = self.settings["bot_players"]
        if len(humans) == 1 and want_bots == 0:
            want_bots = 1              # someone has to be chased
        n_bots = min(want_bots, self.MAX_HUMANS - len(humans))
        for i in range(n_bots):
            bot = self.add_bot("BOT %s" % BOT_NAMES[i % len(BOT_NAMES)])
            self.participants.append(bot.token)
        self.g = {
            "order": list(self.participants),
            "snakes": {},
            "items": {},               # (x,y) -> {"what","until","score","grow"}
            "tick": 0,
            "round": 1,
            "rounds_total": self.settings["rounds"],
            "round_tick": 0,
            "round_started_n": 0,
            "round_winner": None,
            "result": None,
        }
        self._spawn_round()
        self.phase = "play"
        self._bump(time.time() + TICK)
        return [self.fx("round_start", round=1, total=self.g["rounds_total"])]

    # ---------------- spawning ----------------

    def _perimeter_slot(self, d):
        """Walk distance d along the wall ring; return (wall_x, wall_y,
        inward dir). Ring: top L->R, right T->B, bottom R->L, left B->T."""
        d %= 2 * (GW + GH)
        if d < GW:
            return d, 0, (0, 1)
        d -= GW
        if d < GH:
            return GW - 1, d, (-1, 0)
        d -= GH
        if d < GW:
            return GW - 1 - d, GH - 1, (0, -1)
        d -= GW
        return 0, GH - 1 - d, (1, 0)

    def _spawn_round(self):
        g = self.g
        order = g["order"]
        n = len(order)
        P = 2 * (GW + GH)
        slots = [self._perimeter_slot(round((i + 0.5) * P / n))
                 for i in range(n)]
        self.rng.shuffle(slots)
        for tok, (wx, wy, (dx, dy)) in zip(order, slots):
            head = (wx + dx * SPAWN_INSET, wy + dy * SPAWN_INSET)
            prev = g["snakes"].get(tok)
            p = self.players.get(tok)
            g["snakes"][tok] = {
                "body": [(head[0] - dx * i, head[1] - dy * i)
                         for i in range(START_LEN)],
                "dir": (dx, dy),
                "pending": [],
                "grow": 0,
                "alive": True,
                "died": None,
                "dc_tick": None,
                # a human who is gone at round start plays as a bot
                "auto": bool(p is not None and not p.is_bot and not p.connected),
                "score": prev["score"] if prev else 0,
                "wins": prev["wins"] if prev else 0,
                "best_len": prev["best_len"] if prev else START_LEN,
            }
        g["items"] = {}
        g["round_tick"] = 0
        g["round_started_n"] = n
        g["round_winner"] = None
        self._spawn_apples()

    def _free_cells(self):
        used = set(self.g["items"])
        for s in self.g["snakes"].values():
            used.update(s["body"])
        return [(x, y) for y in range(GH) for x in range(GW)
                if (x, y) not in used]

    def _spawn_apples(self):
        items = self.g["items"]
        while sum(1 for it in items.values() if it["what"] == "apple") < N_APPLES:
            free = self._free_cells()
            if not free:
                break
            cell = self.rng.choice(free)
            items[cell] = {"what": "apple", "until": None,
                           "score": APPLE_SCORE, "grow": APPLE_GROW}

    # ---------------- actions ----------------

    def game_action(self, token, msg):
        self.seq += 1
        if msg.get("t") != "turn":
            return [self.fx("invalid", to=token, msg="Unknown action")]
        g = self.g
        if g is None or self.phase != "play":
            return []
        s = g["snakes"].get(token)
        if s is None or not s["alive"]:
            return []
        raw_dir = msg.get("dir")
        d = DIR_NAMES.get(raw_dir) if isinstance(raw_dir, str) else None
        if d is None:
            return []
        # validate against where the snake will actually be heading once
        # the already-queued turns apply
        cur = s["pending"][-1] if s["pending"] else s["dir"]
        if d == cur or d == (-cur[0], -cur[1]):
            return []                  # no-op or 180° reversal — rejected
        if len(s["pending"]) >= MAX_PENDING:
            return []
        s["pending"].append(d)
        return []

    # ---------------- the world tick ----------------

    def game_tick(self):
        if self.g is None:
            return []
        if self.phase == "play":
            return self._tick_play()
        if self.phase == "round_end":
            return self._next_round()
        return []

    def _next_round(self):
        g = self.g
        g["round"] += 1
        self._spawn_round()
        self.phase = "play"
        self._bump(time.time() + TICK)
        return [self.fx("round_start", round=g["round"],
                        total=g["rounds_total"])]

    def _tick_play(self):
        g = self.g
        base = self.deadline or time.time()
        g["tick"] += 1
        g["round_tick"] += 1
        tick = g["tick"]
        snakes = g["snakes"]
        fx = []

        # -- disconnect grace: drift straight 5 s, then botify or die
        for tok in g["order"]:
            s = snakes[tok]
            if not s["alive"] or s["auto"]:
                continue
            p = self.players.get(tok)
            if p is None or p.is_bot:
                continue
            if p.connected:
                s["dc_tick"] = None
                continue
            if s["dc_tick"] is None:
                s["dc_tick"] = tick
            elif tick - s["dc_tick"] >= GRACE_TICKS:
                if g["round_tick"] <= YOUNG_TICKS:
                    s["auto"] = True
                    fx.append(self.fx("toast", icon="🛰",
                                      msg="%s is gone — a bot takes the snake" % p.name))
                else:
                    self._kill(tok, "gone", fx)

        # -- steering: bots + botified snakes think synchronously; humans
        #    pop one queued turn
        view = {tok: {"body": sn["body"], "dir": sn["dir"],
                      "grow": sn["grow"], "alive": sn["alive"]}
                for tok, sn in snakes.items()}
        item_cells = set(g["items"])
        for tok in g["order"]:
            s = snakes[tok]
            if not s["alive"]:
                continue
            p = self.players.get(tok)
            if (p is not None and p.is_bot) or s["auto"]:
                d = bots.choose_dir(GW, GH, view, tok, item_cells,
                                    self.rng, self.settings["difficulty"])
                if d is not None:
                    s["dir"] = d
            elif s["pending"]:
                d = s["pending"].pop(0)
                if d != (-s["dir"][0], -s["dir"][1]):
                    s["dir"] = d

        # -- everyone advances one cell, simultaneously
        movers = [tok for tok in g["order"] if snakes[tok]["alive"]]
        newh, post = {}, {}
        for tok in movers:
            s = snakes[tok]
            hx, hy = s["body"][0]
            dx, dy = s["dir"]
            nh = (hx + dx, hy + dy)
            newh[tok] = nh
            post[tok] = [nh] + (s["body"] if s["grow"] > 0 else s["body"][:-1])

        dead = {}
        for tok in movers:                                   # walls
            x, y = newh[tok]
            if not (0 <= x < GW and 0 <= y < GH):
                dead[tok] = "wall"
        cells = {}                                           # head-to-head
        for tok in movers:
            if tok not in dead:
                cells.setdefault(newh[tok], []).append(tok)
        for cell, toks in cells.items():
            if len(toks) < 2:
                continue
            lens = [len(post[t]) for t in toks]
            top = max(lens)
            winners = [t for t, ln in zip(toks, lens) if ln == top]
            losers = toks if len(winners) > 1 else \
                [t for t in toks if t != winners[0]]
            for t in losers:
                dead[t] = "head"
        body_cells = set()                                   # bodies
        for tok in movers:
            body_cells.update(post[tok][1:])
        for tok in movers:
            if tok not in dead and newh[tok] in body_cells:
                dead[tok] = "body"

        # -- commit survivors, then convert the fallen into pellets
        for tok in movers:
            if tok in dead:
                continue
            s = snakes[tok]
            s["body"] = post[tok]
            if s["grow"] > 0:
                s["grow"] -= 1
            if len(s["body"]) > s["best_len"]:
                s["best_len"] = len(s["body"])
        for tok, cause in dead.items():
            self._kill(tok, cause, fx)

        # -- eating (survivors only; a head cell is unique after step 3)
        for tok in movers:
            if tok in dead:
                continue
            s = snakes[tok]
            it = g["items"].pop(s["body"][0], None)
            if it:
                s["score"] += it["score"]
                s["grow"] += it["grow"]
                p = self.players.get(tok)
                fx.append(self.fx("eat", pid=p.pid if p else None,
                                  x=s["body"][0][0], y=s["body"][0][1],
                                  what=it["what"], points=it["score"]))

        # -- item lifecycles
        for cell in [c for c, it in g["items"].items()
                     if it["until"] is not None and tick >= it["until"]]:
            del g["items"][cell]
        if (g["round_tick"] > 0 and g["round_tick"] % GOLD_EVERY_TICKS == 0
                and not any(it["what"] == "gold" for it in g["items"].values())):
            free = self._free_cells()
            if free:
                cell = self.rng.choice(free)
                g["items"][cell] = {"what": "gold",
                                    "until": tick + GOLD_TTL_TICKS,
                                    "score": GOLD_SCORE, "grow": GOLD_GROW}
                fx.append(self.fx("gold_spawn", x=cell[0], y=cell[1]))
        self._spawn_apples()

        # -- round over?
        alive_now = [tok for tok in g["order"] if snakes[tok]["alive"]]
        floor = 1 if g["round_started_n"] >= 2 else 0
        if len(alive_now) <= floor:
            return fx + self._finish_round(alive_now)

        # -- chain the loop: this is what makes the game real-time
        self._bump(max(time.time() + 0.02, base + TICK))
        return fx

    def _finish_round(self, alive_now):
        g = self.g
        fx = []
        wtok = alive_now[0] if alive_now else None
        wp = self.players.get(wtok) if wtok else None
        if wtok:
            s = g["snakes"][wtok]
            s["score"] += SURVIVE_BONUS
            s["wins"] += 1
        g["round_winner"] = wp.pid if wp else None
        fx.append(self.fx("round_over", winner=g["round_winner"],
                          round=g["round"]))
        clinched = wtok is not None and \
            g["snakes"][wtok]["wins"] * 2 > g["rounds_total"]
        if g["round"] >= g["rounds_total"] or clinched:
            standings = sorted(
                ({"pid": self.players[t].pid,
                  "score": g["snakes"][t]["score"],
                  "wins": g["snakes"][t]["wins"],
                  "best_len": g["snakes"][t]["best_len"]}
                 for t in g["order"] if t in self.players),
                key=lambda r: (-r["wins"], -r["score"]))
            g["result"] = {
                "winner": standings[0]["pid"] if standings else None,
                "rounds": g["round"],
                "standings": standings,
            }
            fx.extend(self.end_game())
        else:
            self.phase = "round_end"
            self._bump(time.time() + ROUND_END_SECONDS)
        return fx

    def _kill(self, tok, cause, fx):
        s = self.g["snakes"][tok]
        if not s["alive"]:
            return
        s["alive"] = False
        s["died"] = cause
        s["pending"] = []
        s["dc_tick"] = None
        cells = []
        for (x, y) in s["body"]:
            if 0 <= x < GW and 0 <= y < GH:
                cells.append([x, y])
                if (x, y) not in self.g["items"]:
                    self.g["items"][(x, y)] = {
                        "what": "pellet",
                        "until": self.g["tick"] + PELLET_TTL_TICKS,
                        "score": PELLET_SCORE, "grow": PELLET_GROW}
        s["body"] = []
        p = self.players.get(tok)
        fx.append(self.fx("death", pid=p.pid if p else None,
                          cells=cells, cause=cause))

    # ---------------- connection events ----------------

    def game_player_left(self, token):
        g = self.g
        if g is None or token not in g["snakes"]:
            return []
        s = g["snakes"][token]
        if not s["alive"] or self.phase not in ("play", "round_end"):
            return []
        s["dc_tick"] = g["tick"]
        s["pending"] = []              # no steering while gone — pure drift
        p = self.players.get(token)
        return [self.fx("toast", icon="🛰",
                        msg="%s dropped — their snake drifts on" %
                        (p.name if p else "?"))]

    def game_player_back(self, token):
        g = self.g
        if g is None or token not in g["snakes"]:
            return []
        s = g["snakes"][token]
        s["dc_tick"] = None
        fx = []
        if s["auto"]:
            s["auto"] = False
            p = self.players.get(token)
            fx.append(self.fx("toast", icon="🎮",
                              msg="%s is back on the stick" %
                              (p.name if p else "?")))
        return fx

    # ---------------- serialization ----------------

    def game_state(self, viewer_token):
        g = self.g
        if g is None:
            return None
        out_snakes = []
        for tok in g["order"]:
            s = g["snakes"].get(tok)
            p = self.players.get(tok)
            if s is None:
                continue
            out_snakes.append({
                "pid": p.pid if p else None,
                "body": s["body"],
                "dir": s["dir"],
                "alive": s["alive"],
                "died": s["died"],
                "len": len(s["body"]),
                "score": s["score"],
                "wins": s["wins"],
                "auto": bool((p is not None and p.is_bot) or s["auto"]
                             or (p is not None and not p.connected)),
            })
        items = [{"x": x, "y": y, "what": it["what"],
                  "ttl": (it["until"] - g["tick"])
                  if it["until"] is not None else None}
                 for (x, y), it in g["items"].items()]
        return {
            "kind": "snake",
            "stage": self.phase,
            "grid": [GW, GH],
            "tick": g["tick"],
            "tick_ms": TICK_MS,
            "round": g["round"],
            "rounds_total": g["rounds_total"],
            "round_winner": g["round_winner"],
            "snakes": out_snakes,
            "items": items,
            "result": g["result"],
        }
