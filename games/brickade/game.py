"""BRICKADE — Pong-royale x Breakout x physics power-ups for GAMEHUB.

Real-time, server-authoritative (the dodgeball pattern: self-rescheduling
game_tick, fixed-timestep substeps, coalesced input, per-viewer state that hands
each client its own seat+angle so the client can rotate its goal to the bottom).

One glowing ball collapses four genres: it's the Pong ball (defend), the Breakout
ball (smash bricks -> power-ups), the royale weapon (score to eliminate), and it
carries a last-touch OWNER (Lethal League) so it only threatens *other* goals and
speeds up on every paddle hit.
"""

import math
import time

from core.session import GameSession
from . import physics as P
from . import bots as botai

BR = P.BALL_R


def _finite(v):
    if isinstance(v, bool):
        return False
    if isinstance(v, int):
        return -1e12 <= v <= 1e12
    return isinstance(v, float) and math.isfinite(v)


class BrickadeSession(GameSession):
    MIN_PLAYERS = 1
    MAX_HUMANS = 8
    DEFAULT_SETTINGS = {
        "players": 4,           # target seats (2/3/4/6/8); bots fill
        "lives": 3,             # goals-against to eliminate
        "difficulty": "mixed",
        "layout": "random",
    }

    def __init__(self, rng=None):
        super().__init__(rng)
        self.g = None

    # ---- lobby ------------------------------------------------------------
    def validate_settings(self, patch):
        ok = {}
        pl = patch.get("players")
        if isinstance(pl, int) and not isinstance(pl, bool) and pl in (2, 3, 4, 6, 8):
            ok["players"] = pl
        lv = patch.get("lives")
        if isinstance(lv, int) and not isinstance(lv, bool) and lv in (1, 3, 5):
            ok["lives"] = lv
        d = patch.get("difficulty")
        if d in ("mixed", "easy", "hard"):
            ok["difficulty"] = d
        lay = patch.get("layout")
        if lay in ("random", "ring", "block", "cross", "checker"):
            ok["layout"] = lay
        return ok

    # ---- start ------------------------------------------------------------
    def game_start(self):
        target = self.settings["players"]
        humans = self.participants[:8]
        benched = self.participants[8:]
        self.participants = list(humans)
        seats = list(humans)
        size = min(8, max(len(seats), target))
        if size < 2:
            size = 2

        diff = self.settings["difficulty"]
        tier_cycle = ["easy", "hard", "hard"] if diff == "mixed" else [diff]
        seed = self.rng.getrandbits(48)
        bots_map, tiers_map = {}, {}
        bi = 0
        while len(seats) < size:
            b = self.add_bot(botai.BOT_NAMES[bi % len(botai.BOT_NAMES)])
            seats.append(b.token)
            self.participants.append(b.token)
            tier = tier_cycle[bi % len(tier_cycle)] if diff == "mixed" else diff
            tiers_map[b.token] = tier
            bots_map[b.token] = botai.make_bot(tier, seed)
            bi += 1

        n = len(seats)
        self.g = {
            "n": n, "seats": seats, "bots": bots_map, "tiers": tiers_map,
            "autopilot": botai.make_bot("hard", seed ^ 0x9E3779B9),
            "seed": seed, "tick": 0, "clock": 0.0, "shrink": 1.0,
            "units": {}, "balls": [], "next_ball": 0,
            "bricks": [], "bricks_v": 0,
            "start_lives": self.settings["lives"], "result": None,
            "next_storm": P.STORM_START, "ko_order": [],
            "layout": self.settings["layout"],
        }
        self._build_arena()
        for s in range(n):
            self.g["units"][s] = {
                "seat": s, "t": 0.5, "t_target": 0.5, "t_prev": 0.5, "pvel": 0.0,
                "cover": P.PADDLE_COVER, "big_until": -1.0,
                "shield_until": -1.0, "shield_hits": 0,
                "alive": True, "hp": self.g["start_lives"],
                "inv": None, "want_act": False,
            }
        self._build_bricks()
        self._spawn_ball(None)
        self.phase = "play"
        self._bump(time.time() + P.TICK)
        fx = [self.fx("toast", to=t, icon="🧱", msg="Arena's full — you're spectating")
              for t in benched]
        fx.append(self.fx("match_start", n=n))
        return fx

    def _build_arena(self):
        self.g["edges"], self.g["ring"] = P.build_edges(self.g["n"], self.g["shrink"])

    def _build_bricks(self):
        g = self.g
        lay = g["layout"]
        if lay == "random":
            lay = self.rng.choice(["ring", "block", "cross", "checker"])
        g["layout_used"] = lay
        R = P.ARENA_R
        cols = int(1.0 * R / P.BRICK_W)
        rows = int(1.0 * R / P.BRICK_H)
        bricks = []
        bid = 0
        for r in range(-rows, rows + 1):
            for c in range(-cols, cols + 1):
                cx = P.CX + c * P.BRICK_W
                cy = P.CY + r * P.BRICK_H
                d = math.hypot(cx - P.CX, cy - P.CY) / R
                keep = False
                if lay == "ring":
                    keep = 0.20 <= d <= 0.44
                elif lay == "block":
                    keep = d <= 0.34
                elif lay == "cross":
                    keep = (abs(cx - P.CX) < P.BRICK_W * 1.5 or abs(cy - P.CY) < P.BRICK_H * 1.5) and d <= 0.46
                else:  # checker
                    keep = ((c + r) % 2 == 0) and d <= 0.42
                if not keep:
                    continue
                special = self.rng.random() < P.SPECIAL_PCT
                bricks.append({"id": bid, "cx": cx, "cy": cy,
                               "hw": P.BRICK_W / 2.0 - 1.5, "hh": P.BRICK_H / 2.0 - 1.5,
                               "special": special, "alive": True})
                bid += 1
        g["bricks"] = bricks
        g["bricks_v"] += 1

    def _spawn_ball(self, owner, x=None, y=None, ang=None):
        g = self.g
        if x is None:
            x, y = P.CX, P.CY
        if ang is None:
            ang = self.rng.uniform(0, 2 * math.pi)
        b = {"id": g["next_ball"], "x": x, "y": y,
             "vx": math.cos(ang), "vy": math.sin(ang), "speed": P.BALL_START,
             "owner": owner, "last_touch_tick": g["tick"],
             "phase_until": -1.0, "slow_until": -1.0, "over_until": -1.0,
             "neutral_since": g["clock"]}
        g["next_ball"] += 1
        g["balls"].append(b)
        return b

    # ---- input ------------------------------------------------------------
    def game_action(self, token, msg):
        self.seq += 1
        g = self.g
        if g is None or self.phase != "play":
            return []
        seat = self._seat_of(token)
        if seat is None:
            return []
        u = g["units"].get(seat)
        if u is None or not u["alive"]:
            return []
        if not isinstance(msg, dict):
            return [self.fx("invalid", to=token, msg="Bad input")]
        t = msg.get("t")
        if t == "paddle":
            v = msg.get("p")
            if _finite(v):
                u["t_target"] = P.clamp(float(v), 0.0, 1.0)
            return []
        if t == "act":
            u["want_act"] = True
            return []
        return []

    # ---- tick -------------------------------------------------------------
    def game_tick(self):
        g = self.g
        if g is None or self.phase != "play":
            return []
        ev = []
        now = g["clock"]
        # sudden-death ring shrink
        if now >= P.SUDDEN_DEATH_START:
            f = P.clamp((now - P.SUDDEN_DEATH_START) / P.SHRINK_TIME, 0.0, 1.0)
            g["shrink"] = 1.0 - (1.0 - P.SHRINK_TO) * f
        self._build_arena()
        # bots decide, then activate power-ups, move paddles
        for s in range(g["n"]):
            u = g["units"][s]
            if u["alive"] and self._seat_is_auto(s):
                self._bot_think(s)
        for s in range(g["n"]):
            self._apply_paddle_and_act(s, ev)
        # substeps
        for _ in range(P.SUBSTEPS):
            g["clock"] += P.DT
            self._step_balls(P.DT, ev)
        # expire power-up timers, idle-ball respawn
        self._expire(ev)
        self._storm(ev)
        g["tick"] += 1
        done = self._check_win(ev)
        if done is not None:
            return done
        self._bump(time.time() + P.TICK)
        return self._to_fx(ev)

    def _apply_paddle_and_act(self, seat, ev):
        g = self.g
        u = g["units"][seat]
        if not u["alive"]:
            u["want_act"] = False
            return
        # power-up activation
        if u["want_act"] and u["inv"] is not None:
            self._activate(seat, u["inv"], ev)
            u["inv"] = None
        u["want_act"] = False
        # cover reverts when BIG expires
        u["cover"] = P.PADDLE_COVER_BIG if g["clock"] < u["big_until"] else P.PADDLE_COVER
        # slew paddle t toward target, capped by PADDLE_SPEED
        edge = g["edges"][seat]
        s = edge["s"]
        span = max(1.0, s - u["cover"] * s)
        max_dt_t = P.PADDLE_SPEED * P.TICK / span
        u["t_prev"] = u["t"]
        dt_t = P.clamp(u["t_target"] - u["t"], -max_dt_t, max_dt_t)
        u["t"] = P.clamp(u["t"] + dt_t, 0.0, 1.0)
        # paddle velocity along the edge (px/s), for english
        _, _, cq = P.paddle_span(edge, u["t"], u["cover"])
        _, _, cq0 = P.paddle_span(edge, u["t_prev"], u["cover"])
        u["pvel"] = (cq - cq0) / P.TICK

    # ---- ball sim ---------------------------------------------------------
    def _step_balls(self, dt, ev):
        g = self.g
        now = g["clock"]
        min_speed = min(P.BALL_MAX, P.BALL_MIN
                        + (max(0.0, now - P.MIN_RAMP_AFTER) * P.MIN_RAMP_RATE
                           if now > P.MIN_RAMP_AFTER else 0.0))
        for ball in list(g["balls"]):
            # neutral decay
            if ball["owner"] is None and now - ball["neutral_since"] > P.NEUTRAL_DECAY_AFTER:
                ball["speed"] = P.approach(ball["speed"], P.BALL_MIN, 0.6, dt)
            base = P.clamp(ball["speed"], min_speed, P.BALL_MAX)
            mult = (P.SLOW_MULT if now < ball["slow_until"]
                    else (P.OVER_MULT if now < ball["over_until"] else 1.0))
            spd = base * mult
            cur = math.hypot(ball["vx"], ball["vy"]) or 1.0
            ball["vx"] *= spd / cur
            ball["vy"] *= spd / cur
            # substep so a fast ball can't tunnel a brick/paddle
            nsub = max(1, int(math.ceil(spd * dt / P.MAX_BRICK_STEP)))
            h = dt / nsub
            scored = False
            for _ in range(nsub):
                ball["x"] += ball["vx"] * h
                ball["y"] += ball["vy"] * h
                self._resolve_bricks(ball, ev)
                res = self._resolve_edges(ball, ev)
                if res == "score":
                    scored = True
                    break
            if scored:
                g["balls"].remove(ball)
        if not g["balls"]:
            # keep at least one ball live; fire at the healthiest player
            self._spawn_ball(None)

    def _resolve_edges(self, ball, ev):
        g = self.g
        now = g["clock"]
        for edge in g["edges"]:
            nx, ny = edge["n"]
            ax, ay = edge["a"]
            d = (ball["x"] - ax) * nx + (ball["y"] - ay) * ny   # inward distance
            vn = ball["vx"] * nx + ball["vy"] * ny
            if d < BR and vn < 0:                                # touching, moving out
                q = (ball["x"] - ax) * edge["u"][0] + (ball["y"] - ay) * edge["u"][1]
                if q < -BR or q > edge["s"] + BR:
                    continue                                     # not this edge (belongs to neighbor)
                owner = edge["owner"]
                gu = g["units"].get(owner) if owner is not None else None
                # push out of the wall
                ball["x"] += (BR - d) * nx
                ball["y"] += (BR - d) * ny
                if owner is None or gu is None or not gu["alive"]:
                    ball["vx"], ball["vy"] = P.reflect(ball["vx"], ball["vy"], nx, ny)
                    ev.append(("bounce", round(ball["x"], 1), round(ball["y"], 1),
                               round(ball["speed"], 1), ball["owner"] if ball["owner"] is not None else -1))
                    return None
                # a live goal edge: shield? paddle save? or score?
                if now < gu["shield_until"] and gu["shield_hits"] > 0:
                    gu["shield_hits"] -= 1
                    ball["vx"], ball["vy"] = P.reflect(ball["vx"], ball["vy"], nx, ny)
                    ev.append(("shield", owner))
                    return None
                q_lo, q_hi, q_c = P.paddle_span(edge, gu["t"], gu["cover"])
                if q_lo - BR <= q <= q_hi + BR:
                    self._paddle_save(ball, edge, gu, q, q_c, ev)
                    return None
                # SCORE — undefended goal
                if P.SELF_IMMUNE and ball["owner"] == owner:
                    # your own ball can't score on you: bounce it away
                    ball["vx"], ball["vy"] = P.reflect(ball["vx"], ball["vy"], nx, ny)
                    return None
                if ball["owner"] is None and now - ball["neutral_since"] < P.SERVE_GRACE:
                    # a fresh neutral serve can't instantly nuke an unprepared keeper
                    ball["vx"], ball["vy"] = P.reflect(ball["vx"], ball["vy"], nx, ny)
                    return None
                self._score(owner, ball, ev)
                return "score"
        return None

    def _paddle_save(self, ball, edge, gu, q, q_c, ev):
        g = self.g
        nx, ny = edge["n"]
        ux, uy = edge["u"]
        # reflect off the paddle face
        vx, vy = P.reflect(ball["vx"], ball["vy"], nx, ny)
        spd = math.hypot(vx, vy) or 1.0
        # english: contact offset from paddle center -> steer along the edge
        half = max(1.0, gu["cover"] * edge["s"] / 2.0)
        offset = P.clamp((q - q_c) / half, -1.0, 1.0)
        vx += ux * offset * P.PADDLE_ENGLISH * spd
        vy += uy * offset * P.PADDLE_ENGLISH * spd
        # paddle motion -> tangential spin
        vx += ux * gu["pvel"] * P.PADDLE_SPIN
        vy += uy * gu["pvel"] * P.PADDLE_SPIN
        # take the exit DIRECTION, then guarantee a minimum inward angle so a
        # grazing save can't skim along the goal line into a neighbour's net
        L = math.hypot(vx, vy) or 1.0
        dx, dy = vx / L, vy / L
        inward = dx * nx + dy * ny
        if inward < P.MIN_INWARD:
            dx += nx * (P.MIN_INWARD - inward)
            dy += ny * (P.MIN_INWARD - inward)
            L2 = math.hypot(dx, dy) or 1.0
            dx, dy = dx / L2, dy / L2
        # keep magnitude = spd this frame (matches the wall path; the speed
        # ladder bump takes effect when _step_balls re-normalizes next tick)
        ball["speed"] = P.clamp(ball["speed"] * P.HIT_SPEEDUP, P.BALL_MIN, P.BALL_MAX)
        ball["vx"], ball["vy"] = dx * spd, dy * spd
        ball["owner"] = gu["seat"]
        ball["last_touch_tick"] = g["tick"]
        ball["neutral_since"] = g["clock"]
        ev.append(("save", gu["seat"], round(ball["x"], 1), round(ball["y"], 1),
                   round(ball["speed"], 1)))

    def _resolve_bricks(self, ball, ev):
        g = self.g
        phasing = g["clock"] < ball["phase_until"]
        fx_flip = fy_flip = False
        hits = [b for b in g["bricks"] if b["alive"]
                and abs(ball["x"] - b["cx"]) < BR + b["hw"]
                and abs(ball["y"] - b["cy"]) < BR + b["hh"]]
        if not hits:
            return
        hits.sort(key=lambda b: (b["cx"] - ball["x"]) ** 2 + (b["cy"] - ball["y"]) ** 2)
        for b in hits:
            dx, dy = ball["x"] - b["cx"], ball["y"] - b["cy"]
            cdx, cdy = abs(dx) - b["hw"], abs(dy) - b["hh"]
            if cdx > 0 and cdy > 0 and cdx * cdx + cdy * cdy > BR * BR:
                continue                         # ball's circle clears the brick corner
            ox = (BR + b["hw"]) - abs(dx)
            oy = (BR + b["hh"]) - abs(dy)
            if ox <= 0 or oy <= 0:
                continue
            sx = 1.0 if dx >= 0 else -1.0
            sy = 1.0 if dy >= 0 else -1.0
            if not phasing:
                corner = abs(ox - oy) <= 0.6
                do_x = ox < oy or (corner and ball["vx"] * sx < 0)
                do_y = oy < ox or (corner and ball["vy"] * sy < 0)
                if do_x:
                    ball["x"] += sx * ox
                    if not fx_flip and ball["vx"] * sx < 0:
                        ball["vx"] = -ball["vx"]; fx_flip = True
                if do_y:
                    ball["y"] += sy * oy
                    if not fy_flip and ball["vy"] * sy < 0:
                        ball["vy"] = -ball["vy"]; fy_flip = True
            self._break_brick(b, ball, ev)
            if not phasing:
                break            # one solid brick per substep (dedup); phase clears all

    def _break_brick(self, b, ball, ev):
        g = self.g
        b["alive"] = False
        g["bricks_v"] += 1
        ball["speed"] = P.clamp(ball["speed"] * P.BRICK_SPEEDUP, P.BALL_MIN, P.BALL_MAX)
        ev.append(("brick", round(b["cx"], 1), round(b["cy"], 1), 1 if b["special"] else 0))
        if b["special"] and ball["owner"] is not None:
            u = g["units"].get(ball["owner"])
            if u is not None and u["alive"] and u["inv"] is None:
                u["inv"] = self.rng.choice(P.PU_KINDS)
                ev.append(("arm", ball["owner"], u["inv"]))

    # ---- power-ups --------------------------------------------------------
    def _activate(self, seat, kind, ev):
        g = self.g
        now = g["clock"]
        u = g["units"][seat]
        mine = [b for b in g["balls"] if b["owner"] == seat]
        if kind == "big":
            u["big_until"] = now + P.BIG_TIME
        elif kind == "shield":
            u["shield_until"] = now + P.SHIELD_TIME
            u["shield_hits"] = P.SHIELD_HITS
        elif kind == "slow":
            for b in mine:
                b["slow_until"] = now + P.SLOW_TIME; b["over_until"] = -1.0
        elif kind == "over":
            for b in mine:
                b["over_until"] = now + P.OVER_TIME; b["slow_until"] = -1.0
        elif kind == "phase":
            for b in mine:
                b["phase_until"] = now + P.PHASE_TIME
        elif kind == "multi":
            cap = P.max_balls(g["n"])
            # multiply YOUR own threat; if you own none, serve fresh owned balls
            # from center (never hijack a ball you don't own — that would forge
            # ownership on a shot aimed at someone else's goal)
            if mine:
                sx, sy, base, sspeed = mine[0]["x"], mine[0]["y"], \
                    math.atan2(mine[0]["vy"], mine[0]["vx"]), mine[0]["speed"]
            else:
                sx, sy, base, sspeed = P.CX, P.CY, self.rng.uniform(0, 2 * math.pi), P.BALL_START
            for k in (1, -1):
                if len(g["balls"]) >= cap:
                    break
                nb = self._spawn_ball(seat, sx, sy, base + k * P.MULTI_SPREAD)
                nb["speed"] = sspeed
        ev.append(("use", seat, kind))

    def _expire(self, ev):
        g = self.g
        now = g["clock"]
        # drop stale shield charges once the timer lapses (keeps state honest)
        for s in range(g["n"]):
            u = g["units"][s]
            if u["shield_hits"] and now >= u["shield_until"]:
                u["shield_hits"] = 0
        for ball in g["balls"]:
            if ball["owner"] is None and now - ball["neutral_since"] > P.IDLE_RESPAWN:
                tgt = self._healthiest()
                ang = self.rng.uniform(0, 2 * math.pi)
                if tgt is not None:
                    e = g["edges"][tgt]
                    ang = math.atan2(e["m"][1] - P.CY, e["m"][0] - P.CX)
                ball["x"], ball["y"] = P.CX, P.CY
                ball["vx"], ball["vy"] = math.cos(ang), math.sin(ang)
                ball["speed"] = P.BALL_START
                ball["neutral_since"] = now
                ball["phase_until"] = ball["slow_until"] = ball["over_until"] = -1.0
                ev.append(("respawn",))

    def _healthiest(self):
        g = self.g
        alive = [s for s in range(g["n"]) if g["units"][s]["alive"]]
        if not alive:
            return None
        return max(alive, key=lambda s: g["units"][s]["hp"])

    # ---- scoring / win ----------------------------------------------------
    def _score(self, owner, ball, ev):
        g = self.g
        u = g["units"][owner]
        u["hp"] -= 1
        bo = ball["owner"]
        credit = bo if (bo is not None and bo != owner and g["units"][bo]["alive"]) else -1
        ev.append(("goal", owner, credit, round(ball["x"], 1), round(ball["y"], 1)))
        if u["hp"] <= 0:
            u["alive"] = False
            g["ko_order"].append(owner)
            ev.append(("eliminate", owner, len([s for s in range(g["n"]) if g["units"][s]["alive"]]) + 1))

    def _storm(self, ev):
        g = self.g
        if g["clock"] < g["next_storm"]:
            return
        g["next_storm"] += P.STORM_INTERVAL
        alive = [s for s in range(g["n"]) if g["units"][s]["alive"]]
        if len(alive) <= 1:
            return
        weakest = min(alive, key=lambda s: (g["units"][s]["hp"], -s))
        g["units"][weakest]["hp"] = 0
        g["units"][weakest]["alive"] = False
        g["ko_order"].append(weakest)
        ev.append(("storm_out", weakest))

    def _check_win(self, ev):
        g = self.g
        alive = [s for s in range(g["n"]) if g["units"][s]["alive"]]
        if len(alive) > 1:
            return None
        if alive:                                   # one survivor — a clean win
            win = alive[0]
            standings = [win] + [s for s in reversed(g["ko_order"]) if s != win]
            draw = False
        else:                                       # every net fell on the same
            win = None                              # tick — a genuine dead heat,
            standings = list(reversed(g["ko_order"]))   # NOT a win for the last
            draw = True                             # one killed
        for s in range(g["n"]):
            if s not in standings:
                standings.append(s)
        win_pid = self._pid(win) if win is not None else None
        g["result"] = {
            "winner_seat": win, "winner_pid": win_pid, "draw": draw,
            "standings": [{"seat": s, "pid": self._pid(s),
                           "hp": max(0, g["units"][s]["hp"])} for s in standings],
        }
        fx = self._to_fx(ev)
        fx.append(self.fx("game_over", pid=win_pid))
        fx.extend(self.end_game())
        return fx

    # ---- bots -------------------------------------------------------------
    def next_bot_action(self):
        return None

    def run_bot(self, bot_token):
        return []

    def _bot_think(self, seat):
        g = self.g
        brain = g["bots"].get(g["seats"][seat], g["autopilot"])
        try:
            brain.think(self._bot_view(seat), g["units"][seat])
        except Exception:
            pass

    def _bot_view(self, seat):
        g = self.g
        edge = g["edges"][seat]
        return {
            "seat": seat, "edge": edge, "clock": g["clock"], "tick": g["tick"],
            "seed": g["seed"], "have_pu": g["units"][seat]["inv"] is not None,
            "balls": [{"x": b["x"], "y": b["y"], "vx": b["vx"] * b["speed"],
                       "vy": b["vy"] * b["speed"], "owner": b["owner"], "speed": b["speed"]}
                      for b in g["balls"]],
        }

    # ---- disconnect -------------------------------------------------------
    def game_player_left(self, token):
        seat = self._seat_of(token)
        if seat is None:
            return []
        p = self.players.get(token)
        return [self.fx("toast", icon="🤖", msg="%s dropped — bot guards the net" % (p.name if p else "Player"))]

    def game_player_back(self, token):
        seat = self._seat_of(token)
        if seat is None:
            return []
        p = self.players.get(token)
        return [self.fx("toast", icon=(p.avatar if p else "👋"), msg="%s is back" % (p.name if p else "Player"))]

    # ---- helpers ----------------------------------------------------------
    def _seat_is_auto(self, seat):
        p = self.players.get(self.g["seats"][seat])
        return p is None or p.is_bot or not p.connected

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

    def _to_fx(self, ev):
        return [self.fx("ev", kind_=e[0], a=e) for e in ev]

    # ---- state (per-viewer: hands each client its seat + angle) -----------
    def game_state(self, viewer_token):
        g = self.g
        if g is None:
            return None
        my_seat = self._seat_of(viewer_token) if viewer_token else None
        now = g["clock"]
        edges = []
        for e in g["edges"]:
            owner = e["owner"]
            u = g["units"].get(owner) if owner is not None else None
            entry = {"a": [round(e["a"][0], 1), round(e["a"][1], 1)],
                     "b": [round(e["b"][0], 1), round(e["b"][1], 1)],
                     "u": [round(e["u"][0], 5), round(e["u"][1], 5)],
                     "n": [round(e["n"][0], 5), round(e["n"][1], 5)],
                     "s": round(e["s"], 2),
                     "kind": e["kind"], "owner": owner,
                     "angle": round(e["angle"], 4)}
            if u is not None:
                q_lo, q_hi, _ = P.paddle_span(e, u["t"], u["cover"])
                p0 = P.along(e, q_lo)
                p1 = P.along(e, q_hi)
                entry.update({
                    "alive": u["alive"], "hp": max(0, u["hp"]),
                    "p0": [round(p0[0], 1), round(p0[1], 1)],
                    "p1": [round(p1[0], 1), round(p1[1], 1)],
                    "shield": now < u["shield_until"] and u["shield_hits"] > 0,
                    "shield_hits": u["shield_hits"],
                    "pid": self._pid(owner),
                    "name": (self.players.get(g["seats"][owner]).name if self.players.get(g["seats"][owner]) else "—"),
                })
            edges.append(entry)
        balls = []
        for b in g["balls"]:
            balls.append({"id": b["id"], "x": round(b["x"], 1), "y": round(b["y"], 1),
                          "vx": round(b["vx"] * b["speed"], 1), "vy": round(b["vy"] * b["speed"], 1),
                          "owner": b["owner"], "speed": round(b["speed"], 1),
                          "phase": now < b["phase_until"],
                          "over": now < b["over_until"], "slow": now < b["slow_until"]})
        bricks = [{"x": round(b["cx"], 1), "y": round(b["cy"], 1),
                   "w": round(b["hw"] * 2 + 3, 1), "h": round(b["hh"] * 2 + 3, 1),
                   "sp": b["special"]} for b in g["bricks"] if b["alive"]]
        me = g["units"].get(my_seat) if my_seat is not None else None
        return {
            "kind": "brickade", "stage": self.phase, "tick": g["tick"], "n": g["n"],
            "cx": P.CX, "cy": P.CY, "R": P.ARENA_R,
            "my_seat": my_seat,
            "my_angle": (round(g["edges"][my_seat]["angle"], 4) if my_seat is not None else None),
            "edges": edges, "balls": balls, "bricks": bricks, "bricks_v": g["bricks_v"],
            "inv": (me["inv"] if me else None),
            "lives": g["start_lives"], "shrink": round(g["shrink"], 3), "result": g["result"],
        }
