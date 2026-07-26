"""DODGEBALL — a real-time top-down 2.5D arena for the GAMEHUB platform.

The platform's first free-movement physics game.  It follows the established
realtime pattern (cf. ``smelterskelter``/``orbitriot``): a single deadline-driven
``game_tick`` self-reschedules with ``_bump(time.time()+TICK)`` to run a fixed
timestep authoritative sim; clients send coalesced *inputs* (never positions),
render interpolated snapshots, and predict their own avatar locally.

Server owns everything — movement, ball flight, and every hit — because "did the
ball tag you" is the entire game and can't live on a client.  Ball flight is a
real projectile with height (``z``); a swept (continuous) collision test stops a
fast ball tunnelling through a player.  Physics constants live in ``physics.py``.
"""

import math
import time

from core.session import GameSession
from . import physics as P
from . import bots as botai

BR = P.BALL_RADIUS
PR = P.PLAYER_RADIUS


def _finite(v):
    if isinstance(v, bool):
        return False
    if isinstance(v, int):
        return -1e12 <= v <= 1e12          # reject huge ints without float-overflowing isfinite
    return isinstance(v, float) and math.isfinite(v)


SPEEDS = {"quick": 2, "standard": 4, "brawl": 6}   # (unused placeholder)


class DodgeballSession(GameSession):
    MIN_PLAYERS = 1            # solo vs bots
    MAX_HUMANS = 8
    DEFAULT_SETTINGS = {
        "players": 4,          # target seats; bots fill the rest (2/4/6/8)
        "mode": "ffa",         # ffa | teams
        "balls": 4,            # balls on court (2..8)
        "lives": 3,            # 1 | 3 | 5
        "difficulty": "mixed",
    }

    def __init__(self, rng=None):
        super().__init__(rng)
        self.g = None

    # ---- lobby ------------------------------------------------------------
    def validate_settings(self, patch):
        ok = {}
        pl = patch.get("players")
        if isinstance(pl, int) and not isinstance(pl, bool) and pl in (2, 4, 6, 8):
            ok["players"] = pl
        m = patch.get("mode")
        if m in ("ffa", "teams"):
            ok["mode"] = m
        b = patch.get("balls")
        if isinstance(b, int) and not isinstance(b, bool) and 2 <= b <= 8:
            ok["balls"] = b
        lv = patch.get("lives")
        if isinstance(lv, int) and not isinstance(lv, bool) and lv in (1, 3, 5):
            ok["lives"] = lv
        d = patch.get("difficulty")
        if d in ("mixed", "easy", "hard"):
            ok["difficulty"] = d
        return ok

    # ---- start ------------------------------------------------------------
    def game_start(self):
        target = self.settings["players"]
        humans = self.participants[:8]
        benched = self.participants[8:]
        self.participants = list(humans)
        seats = list(humans)
        size = min(8, max(len(seats), target))
        if self.settings["mode"] == "teams" and size % 2 == 1:
            size += 1                      # even teams
        size = min(8, size)

        diff = self.settings["difficulty"]
        tier_cycle = ["easy", "shark", "hard"] if diff == "mixed" else [diff]
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
        mode = self.settings["mode"] if n >= 2 else "ffa"
        team_of = {}
        for s in range(n):
            team_of[s] = (s % 2) if mode == "teams" else s

        self.g = {
            "n": n, "seats": seats, "mode": mode, "team_of": team_of,
            "bots": bots_map, "tiers": tiers_map,
            "autopilot": botai.make_bot("shark", seed ^ 0x9E3779B9),
            "seed": seed, "tick": 0, "clock": 0.0,
            "units": {}, "balls": [], "next_ball": 0,
            "start_lives": self.settings["lives"], "result": None,
            "mx": 0.0, "my": 0.0, "sd": False, "next_storm": P.STORM_START,
            "ko_order": [],
        }
        self._spawn_units()
        self._spawn_balls()
        self.phase = "play"
        self._bump(time.time() + P.TICK)
        fx = [self.fx("toast", to=t, icon="🪑", msg="Court's full — you're on the bench")
              for t in benched]
        fx.append(self.fx("match_start", n=n, mode=mode, balls=len(self.g["balls"])))
        return fx

    def _spawn_units(self):
        g = self.g
        n, mode = g["n"], g["mode"]
        for s in range(n):
            if mode == "teams":
                team = g["team_of"][s]
                col = 160.0 if team == 0 else P.ARENA_W - 160.0
                mates = [k for k in range(n) if g["team_of"][k] == team]
                idx = mates.index(s)
                y = P.ARENA_H * (idx + 1) / (len(mates) + 1)
                x = col
                face = 0.0 if team == 0 else math.pi
            else:
                ang = 2 * math.pi * s / n - math.pi / 2
                x = P.ARENA_W / 2 + math.cos(ang) * (P.ARENA_H * 0.34)
                y = P.ARENA_H / 2 + math.sin(ang) * (P.ARENA_H * 0.34)
                face = math.atan2(P.ARENA_H / 2 - y, P.ARENA_W / 2 - x)
            g["units"][s] = {
                "seat": s, "x": x, "y": y, "vx": 0.0, "vy": 0.0,
                "move": (0.0, 0.0), "facing": face,
                "lives": g["start_lives"], "alive": True, "holding": None,
                "dash_until": -1.0, "dash_cd_until": -1.0, "dvx": 0.0, "dvy": 0.0,
                "iframe_until": P.IFRAMES_SPAWN, "hitstun_until": -1.0,
                "catch_until": -1.0, "catch_cd_until": -1.0,
                "kb_vx": 0.0, "kb_vy": 0.0,
                "want_throw": None, "want_dash": False, "want_catch": False,
                "team": g["team_of"][s], "bot_state": {},
            }

    def _spawn_balls(self):
        g = self.g
        nb = self.settings["balls"]
        cx = P.ARENA_W / 2
        for i in range(nb):
            y = P.ARENA_H * (i + 1) / (nb + 1)
            g["balls"].append(self._new_ball(cx, y))

    def _new_ball(self, x, y):
        g = self.g
        b = {"id": g["next_ball"], "x": x, "y": y, "z": 0.0,
             "vx": 0.0, "vy": 0.0, "vz": 0.0, "bounces": 1,
             "thrower": None, "held_by": None, "self_immune_until": -1.0,
             "live": False, "rest_since": g["clock"]}
        g["next_ball"] += 1
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
        if t == "move":
            mx, my = msg.get("x"), msg.get("y")
            if _finite(mx) and _finite(my):
                m = math.hypot(mx, my)
                if m > 1.0:
                    mx, my = mx / m, my / m
                u["move"] = (float(mx), float(my))
            return []
        if t == "throw":
            a, p = msg.get("a"), msg.get("p")
            if _finite(a) and _finite(p):
                u["want_throw"] = (float(a), P.clamp(float(p), 0.0, 1.0))
            return []
        if t == "dash":
            u["want_dash"] = True
            return []
        if t == "catch":
            u["want_catch"] = True
            return []
        return []

    # ---- the sim tick -----------------------------------------------------
    def game_tick(self):
        g = self.g
        if g is None:
            return []
        if self.phase != "play":
            return []
        ev = []
        # 1. bots/autopilot decide their intents (same fields humans set)
        for s in range(g["n"]):
            u = g["units"][s]
            if u["alive"] and self._seat_is_auto(s):
                self._bot_think(s)
        # 2. apply one-shot intents (throw / dash / catch)
        for s in range(g["n"]):
            self._apply_intents(s, ev)
        # 3. sudden death — the arena closes in to force a finish
        g["mx"], g["my"] = P.shrink_margins(g["clock"])
        if g["mx"] > 0 and not g["sd"]:
            g["sd"] = True
            ev.append(("sudden_death",))
        # 4. fixed-timestep substeps
        for _ in range(P.SUBSTEPS):
            g["clock"] += P.DT
            self._step_players(P.DT)
            self._step_balls(P.DT, ev)
        # 5. pickups + idle-ball respawn
        self._pickups(ev)
        self._idle_balls()
        self._storm(ev)
        g["tick"] += 1
        # 6. win?
        done = self._check_win(ev)
        if done is not None:
            return done
        self._bump(time.time() + P.TICK)
        return self._to_fx(ev)

    def _apply_intents(self, seat, ev):
        g = self.g
        u = g["units"][seat]
        now = g["clock"]
        if not u["alive"]:
            u["want_throw"] = None
            u["want_dash"] = u["want_catch"] = False
            return
        if u["want_dash"] and now >= u["dash_cd_until"]:
            dx, dy = u["move"]
            if dx == 0 and dy == 0:
                dx, dy = math.cos(u["facing"]), math.sin(u["facing"])
            m = math.hypot(dx, dy) or 1.0
            u["dvx"], u["dvy"] = dx / m * P.DASH_SPEED, dy / m * P.DASH_SPEED
            u["dash_until"] = now + P.DASH_DURATION
            u["iframe_until"] = max(u["iframe_until"], now + P.DASH_IFRAMES)
            u["dash_cd_until"] = now + P.DASH_COOLDOWN + P.DASH_DURATION
            ev.append(("dash", seat, u["x"], u["y"]))
        u["want_dash"] = False
        if u["want_catch"] and now >= u["catch_cd_until"]:
            u["catch_until"] = now + P.CATCH_WINDOW
            u["catch_cd_until"] = now + P.CATCH_COOLDOWN + P.CATCH_WINDOW
            ev.append(("catch_arm", seat))
        u["want_catch"] = False
        if u["want_throw"] is not None and u["holding"] is not None:
            angle, power = u["want_throw"]
            self._throw(seat, angle, power, ev)
        u["want_throw"] = None

    def _throw(self, seat, angle, power, ev):
        g = self.g
        u = g["units"][seat]
        ball = self._ball(u["holding"])
        if ball is None:
            u["holding"] = None
            return
        power = P.clamp(power, 0.2, 1.0)
        speed = P.THROW_SPEED_MIN + (P.THROW_SPEED_MAX - P.THROW_SPEED_MIN) * power
        ca, sa = math.cos(angle), math.sin(angle)
        ball["x"] = u["x"] + ca * (PR + BR + 2)
        ball["y"] = u["y"] + sa * (PR + BR + 2)
        ball["z"] = P.RELEASE_HEIGHT
        ball["vx"], ball["vy"], ball["vz"] = ca * speed, sa * speed, P.VZ_DIRECT
        ball["bounces"] = 0
        ball["thrower"] = seat
        ball["held_by"] = None
        ball["self_immune_until"] = g["clock"] + P.SELF_IMMUNE
        ball["live"] = True
        u["holding"] = None
        u["facing"] = angle
        ev.append(("throw", seat, round(angle, 3), round(power, 2), ball["id"]))

    def _step_players(self, dt):
        g = self.g
        now = g["clock"]
        for s in range(g["n"]):
            u = g["units"][s]
            if not u["alive"]:
                continue
            dashing = now < u["dash_until"]
            if dashing:
                u["vx"], u["vy"] = u["dvx"], u["dvy"]
            else:
                stunned = now < u["hitstun_until"]
                mx, my = (0.0, 0.0) if stunned else u["move"]
                tvx, tvy = mx * P.RUN_SPEED, my * P.RUN_SPEED
                moving = (mx or my)
                tau = P.ACCEL_TAU if moving else P.STOP_TAU
                u["vx"] = P.approach(u["vx"], tvx, tau, dt)
                u["vy"] = P.approach(u["vy"], tvy, tau, dt)
                if moving:
                    u["facing"] = math.atan2(my, mx)
            # knockback decays independently and slides the body
            u["kb_vx"] = P.approach(u["kb_vx"], 0.0, P.KB_TAU, dt)
            u["kb_vy"] = P.approach(u["kb_vy"], 0.0, P.KB_TAU, dt)
            u["x"] += (u["vx"] + u["kb_vx"]) * dt
            u["y"] += (u["vy"] + u["kb_vy"]) * dt
            # walls (respect the shrinking sudden-death zone): clamp + kill normal
            mx, my = g["mx"], g["my"]
            if u["x"] < mx + PR:
                u["x"] = mx + PR
                u["vx"] = max(u["vx"], 0.0); u["kb_vx"] = max(u["kb_vx"], 0.0)
            elif u["x"] > P.ARENA_W - mx - PR:
                u["x"] = P.ARENA_W - mx - PR
                u["vx"] = min(u["vx"], 0.0); u["kb_vx"] = min(u["kb_vx"], 0.0)
            if u["y"] < my + PR:
                u["y"] = my + PR
                u["vy"] = max(u["vy"], 0.0); u["kb_vy"] = max(u["kb_vy"], 0.0)
            elif u["y"] > P.ARENA_H - my - PR:
                u["y"] = P.ARENA_H - my - PR
                u["vy"] = min(u["vy"], 0.0); u["kb_vy"] = min(u["kb_vy"], 0.0)
        self._resolve_bodies()

    def _resolve_bodies(self):
        g = self.g
        alive = [s for s in range(g["n"]) if g["units"][s]["alive"]]
        for i in range(len(alive)):
            for j in range(i + 1, len(alive)):
                a, b = g["units"][alive[i]], g["units"][alive[j]]
                dx, dy = b["x"] - a["x"], b["y"] - a["y"]
                d = math.hypot(dx, dy)
                overlap = (2 * PR) - d
                if overlap > P.SLOP and d > 1e-6:
                    nx, ny = dx / d, dy / d
                    push = (overlap - P.SLOP) * P.PUSH_PCT * 0.5
                    a["x"] -= nx * push; a["y"] -= ny * push
                    b["x"] += nx * push; b["y"] += ny * push

    def _step_balls(self, dt, ev):
        g = self.g
        now = g["clock"]
        for ball in g["balls"]:
            if ball["held_by"] is not None:
                u = g["units"].get(ball["held_by"])
                if u is None or not u["alive"]:
                    ball["held_by"] = None
                    continue
                ca, sa = math.cos(u["facing"]), math.sin(u["facing"])
                ball["x"] = u["x"] + ca * (PR + BR)
                ball["y"] = u["y"] + sa * (PR + BR)
                ball["z"] = P.RELEASE_HEIGHT
                ball["vx"] = ball["vy"] = ball["vz"] = 0.0
                continue
            x0, y0 = ball["x"], ball["y"]
            ball["vz"] -= P.GRAVITY * dt
            nx = ball["x"] + ball["vx"] * dt
            ny = ball["y"] + ball["vy"] * dt
            nz = ball["z"] + ball["vz"] * dt
            speed = math.hypot(ball["vx"], ball["vy"])
            # continuous hit test BEFORE committing the move (only a live ball)
            if ball["bounces"] == 0 and speed > P.LETHAL_MIN_SPEED and nz > 0:
                hit_seat, toi = self._sweep_hit(ball, x0, y0, nx, ny, now)
                if hit_seat is not None:
                    self._resolve_hit(ball, hit_seat, ev)
                    continue                     # ball consumed / became dead at contact
            # ground bounce
            if nz <= 0.0 and ball["vz"] < 0.0:
                nz = -nz * 0.35                  # small rebound above ground
                ball["vz"] = -ball["vz"] * P.RESTITUTION_Z
                ball["vx"] *= P.RESTITUTION_H
                ball["vy"] *= P.RESTITUTION_H
                ball["bounces"] += 1
                ev.append(("bounce", ball["id"], round(nx, 1), round(ny, 1),
                           round(speed, 1)))
            # wall bounce (x/y), respecting the shrinking zone
            mx, my = g["mx"], g["my"]
            if nx < mx + BR:
                nx = mx + BR; ball["vx"] = -ball["vx"] * P.RESTITUTION_WALL
                ev.append(("wall", ball["id"], round(nx, 1), round(ny, 1)))
            elif nx > P.ARENA_W - mx - BR:
                nx = P.ARENA_W - mx - BR; ball["vx"] = -ball["vx"] * P.RESTITUTION_WALL
                ev.append(("wall", ball["id"], round(nx, 1), round(ny, 1)))
            if ny < my + BR:
                ny = my + BR; ball["vy"] = -ball["vy"] * P.RESTITUTION_WALL
                ev.append(("wall", ball["id"], round(nx, 1), round(ny, 1)))
            elif ny > P.ARENA_H - my - BR:
                ny = P.ARENA_H - my - BR; ball["vy"] = -ball["vy"] * P.RESTITUTION_WALL
                ev.append(("wall", ball["id"], round(nx, 1), round(ny, 1)))
            ball["x"], ball["y"], ball["z"] = nx, ny, nz
            speed = math.hypot(ball["vx"], ball["vy"])
            ball["live"] = (ball["bounces"] == 0 and speed > P.LETHAL_MIN_SPEED and ball["z"] > 0)
            if speed >= P.DEAD_SPEED or ball["z"] > BR:
                ball["rest_since"] = now

    def _sweep_hit(self, ball, x0, y0, nx, ny, now):
        """Earliest eligible player the ball's swept segment enters this step."""
        g = self.g
        thrower = ball["thrower"]
        best_seat, best_toi = None, 2.0
        for s in range(g["n"]):
            u = g["units"][s]
            if not u["alive"]:
                continue
            if s == thrower and now < ball["self_immune_until"]:
                continue
            if thrower is not None and g["mode"] == "teams" and \
                    g["team_of"][s] == g["team_of"][thrower]:
                continue                         # no friendly fire in teams mode
            if now < u["iframe_until"]:
                continue                         # invulnerable -> ball passes through
            # height band: ball must be within the player's column
            if not (ball["z"] - BR < P.BODY_HEIGHT and ball["z"] + BR > 0):
                continue
            toi = P.seg_circle_toi(x0, y0, nx, ny, u["x"], u["y"], PR + BR)
            if toi is not None and toi < best_toi:
                best_seat, best_toi = s, toi
        return best_seat, best_toi

    def _resolve_hit(self, ball, seat, ev):
        g = self.g
        now = g["clock"]
        u = g["units"][seat]
        thrower = ball["thrower"]
        speed = math.hypot(ball["vx"], ball["vy"])
        # CATCH beats HIT if the window is open, the ball is reachable, and your
        # hands are empty (HOLD_CAP=1 — can't catch a 2nd ball, that ghosts one)
        if u["holding"] is None and now <= u["catch_until"] and ball["z"] < P.BODY_HEIGHT + P.CATCH_REACH_Z:
            u["holding"] = ball["id"]
            ball["held_by"] = seat
            ball["thrower"] = None
            ball["live"] = False
            ball["vx"] = ball["vy"] = ball["vz"] = 0.0
            perfect = now <= (u["catch_until"] - P.CATCH_WINDOW + P.PERFECT_CATCH_WINDOW)
            ev.append(("catch", seat, thrower if thrower is not None else -1,
                       1 if perfect else 0))
            if thrower is not None and thrower != seat:
                self._lose_life(thrower, ev, "caught")
            return
        # otherwise HIT
        dir_x, dir_y = (ball["vx"] / speed, ball["vy"] / speed) if speed > 1e-6 else (0.0, 0.0)
        mag = P.clamp(P.KB_BASE + P.KB_SCALE * speed, P.KB_MIN, P.KB_MAX)
        u["kb_vx"] += dir_x * mag
        u["kb_vy"] += dir_y * mag
        u["hitstun_until"] = now + P.HIT_STUN
        u["iframe_until"] = now + P.IFRAMES_HIT
        # ball dies where it struck
        ball["bounces"] = 1
        ball["live"] = False
        ball["vx"] *= 0.15; ball["vy"] *= 0.15; ball["vz"] = 40.0
        ball["thrower"] = None
        ball["rest_since"] = now
        ev.append(("hit", seat, thrower if thrower is not None else -1,
                   round(u["x"], 1), round(u["y"], 1)))
        self._lose_life(seat, ev, "hit")

    def _lose_life(self, seat, ev, cause):
        g = self.g
        u = g["units"][seat]
        if not u["alive"]:
            return
        u["lives"] -= 1
        u["iframe_until"] = max(u["iframe_until"], g["clock"] + P.IFRAMES_SPAWN)
        if u["lives"] <= 0:
            u["alive"] = False
            u["move"] = (0.0, 0.0)
            g["ko_order"].append(seat)
            if u["holding"] is not None:
                b = self._ball(u["holding"])
                if b is not None:
                    b["held_by"] = None
                    b["rest_since"] = g["clock"]
                u["holding"] = None
            ev.append(("eliminate", seat, cause))
        else:
            ev.append(("life", seat, u["lives"], cause))

    def _pickups(self, ev):
        g = self.g
        for s in range(g["n"]):
            u = g["units"][s]
            if not u["alive"] or u["holding"] is not None:
                continue
            for ball in g["balls"]:
                if ball["held_by"] is not None or ball["live"]:
                    continue
                if ball["z"] > P.BODY_HEIGHT:
                    continue
                if math.hypot(ball["x"] - u["x"], ball["y"] - u["y"]) < P.PICKUP_RANGE:
                    u["holding"] = ball["id"]
                    ball["held_by"] = s
                    ball["thrower"] = None
                    ball["vx"] = ball["vy"] = ball["vz"] = 0.0
                    ball["bounces"] = 1
                    ev.append(("pickup", s, ball["id"]))
                    break

    def _idle_balls(self):
        g = self.g
        now = g["clock"]
        for ball in g["balls"]:
            if ball["held_by"] is not None:
                continue
            if now - ball["rest_since"] > P.BALL_IDLE_RESPAWN:
                ball["x"] = P.ARENA_W / 2 + self.rng.uniform(-40, 40)
                ball["y"] = P.ARENA_H / 2 + self.rng.uniform(-120, 120)
                ball["z"] = 0.0
                ball["vx"] = ball["vy"] = ball["vz"] = 0.0
                ball["bounces"] = 1
                ball["rest_since"] = now

    def _storm(self, ev):
        """Hard backstop for a stalled match: after STORM_START, crush the
        weakest alive player once per interval so it always ends with a single
        winner (never a draw)."""
        g = self.g
        if g["clock"] < g["next_storm"]:
            return
        g["next_storm"] += P.STORM_INTERVAL
        alive = [s for s in range(g["n"]) if g["units"][s]["alive"]]
        if len(alive) <= 1:
            return
        weakest = min(alive, key=lambda s: (g["units"][s]["lives"], -s))
        u = g["units"][weakest]
        u["lives"] = 0
        u["alive"] = False
        u["move"] = (0.0, 0.0)
        g["ko_order"].append(weakest)
        if u["holding"] is not None:
            b = self._ball(u["holding"])
            if b is not None:
                b["held_by"] = None
                b["rest_since"] = g["clock"]
            u["holding"] = None
        ev.append(("storm_out", weakest))

    # ---- win / results ----------------------------------------------------
    def _alive_teams(self):
        g = self.g
        teams = {}
        for s in range(g["n"]):
            if g["units"][s]["alive"]:
                teams.setdefault(g["team_of"][s], []).append(s)
        return teams

    def _check_win(self, ev):
        g = self.g
        teams = self._alive_teams()
        if len(teams) > 1:
            return None
        # a winner (or nobody) — build the result
        if teams:
            win_team = next(iter(teams))
            win_seats = teams[win_team]
        elif g["ko_order"]:
            # simultaneous double-KO: award the tiebreak to whoever went out LAST
            last = g["ko_order"][-1]
            win_team = g["team_of"][last]
            win_seats = ([s for s in range(g["n"]) if g["team_of"][s] == win_team]
                         if g["mode"] == "teams" else [last])
        else:
            win_team, win_seats = None, []
        standings = sorted(range(g["n"]), key=lambda s: (
            -int(g["units"][s]["alive"]), -g["units"][s]["lives"], s))
        g["result"] = {
            "mode": g["mode"],
            "winner_team": win_team,
            "winner_seats": win_seats,
            "winner_pids": [self._pid(s) for s in win_seats],
            "standings": [{"seat": s, "pid": self._pid(s),
                           "lives": max(0, g["units"][s]["lives"]),
                           "alive": g["units"][s]["alive"]} for s in standings],
        }
        wins_pid = self._pid(win_seats[0]) if win_seats else None
        fx = self._to_fx(ev)
        fx.append(self.fx("game_over", pid=wins_pid, team=win_team))
        fx.extend(self.end_game())
        return fx

    # ---- bots (ticked, not scheduled) -------------------------------------
    def next_bot_action(self):
        return None               # realtime bots are driven inside game_tick

    def run_bot(self, bot_token):
        return []

    def _bot_think(self, seat):
        g = self.g
        brain = g["bots"].get(g["seats"][seat], g["autopilot"])
        try:
            brain.think(self._bot_view(seat), g["units"][seat])
        except Exception:
            g["units"][seat]["move"] = (0.0, 0.0)

    def _bot_view(self, seat):
        g = self.g
        u = g["units"][seat]
        return {
            "seat": seat, "x": u["x"], "y": u["y"], "team": u["team"],
            "holding": u["holding"] is not None,
            "dash_ready": g["clock"] >= u["dash_cd_until"],
            "arena": (P.ARENA_W, P.ARENA_H), "clock": g["clock"], "tick": g["tick"],
            "seed": g["seed"],
            "enemies": [{"seat": e, "x": g["units"][e]["x"], "y": g["units"][e]["y"],
                         "vx": g["units"][e]["vx"], "vy": g["units"][e]["vy"]}
                        for e in range(g["n"])
                        if g["units"][e]["alive"] and g["team_of"][e] != u["team"]],
            "balls": [{"id": b["id"], "x": b["x"], "y": b["y"], "z": b["z"],
                       "vx": b["vx"], "vy": b["vy"], "live": b["live"],
                       "free": b["held_by"] is None and not b["live"],
                       "thrower": b["thrower"]}
                      for b in g["balls"]],
        }

    # ---- disconnect (autopilot handles the seat) --------------------------
    def game_player_left(self, token):
        seat = self._seat_of(token)
        if seat is None:
            return []
        p = self.players.get(token)
        return [self.fx("toast", icon="🤖",
                        msg="%s dropped — bot takes the court" % (p.name if p else "Player"))]

    def game_player_back(self, token):
        seat = self._seat_of(token)
        if seat is None:
            return []
        p = self.players.get(token)
        if seat is not None and self.g and seat in self.g["units"]:
            self.g["units"][seat]["move"] = (0.0, 0.0)
        return [self.fx("toast", icon=(p.avatar if p else "👋"),
                        msg="%s is back" % (p.name if p else "Player"))]

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

    def _ball(self, bid):
        for b in self.g["balls"]:
            if b["id"] == bid:
                return b
        return None

    def _to_fx(self, ev):
        out = []
        for e in ev:
            out.append(self.fx("ev", kind_=e[0], a=e))
        return out

    # ---- state (whole court; dodgeball has no hidden info) ----------------
    def game_state(self, viewer_token):
        g = self.g
        if g is None:
            return None
        my_seat = self._seat_of(viewer_token) if viewer_token else None
        now = g["clock"]
        units = []
        for s in range(g["n"]):
            u = g["units"][s]
            p = self.players.get(g["seats"][s])
            units.append({
                "seat": s, "pid": p.pid if p else None,
                "name": p.name if p else "—", "avatar": p.avatar if p else "🤖",
                "pfp": p.pfp if p else None, "bot": p.is_bot if p else False,
                "tier": g["tiers"].get(g["seats"][s]),
                "team": u["team"], "x": round(u["x"], 1), "y": round(u["y"], 1),
                "vx": round(u["vx"] + u["kb_vx"], 1), "vy": round(u["vy"] + u["kb_vy"], 1),
                "facing": round(u["facing"], 3),
                "lives": max(0, u["lives"]), "alive": u["alive"],
                "holding": u["holding"] is not None,
                "invuln": now < u["iframe_until"],
                "dashing": now < u["dash_until"],
                "catching": now < u["catch_until"],
                "auto": self._seat_is_auto(s),
            })
        balls = []
        for b in g["balls"]:
            balls.append({
                "id": b["id"], "x": round(b["x"], 1), "y": round(b["y"], 1),
                "z": round(b["z"], 1), "vx": round(b["vx"], 1), "vy": round(b["vy"], 1),
                "live": b["live"], "held": b["held_by"] is not None,
                "held_by": b["held_by"],
            })
        return {
            "kind": "dodgeball", "stage": self.phase, "tick": g["tick"],
            "n": g["n"], "mode": g["mode"],
            "arena": {"w": P.ARENA_W, "h": P.ARENA_H},
            "mx": round(g["mx"], 1), "my": round(g["my"], 1), "sd": g["sd"],
            "my_seat": my_seat, "units": units, "balls": balls,
            "lives": g["start_lives"], "result": g["result"],
            "consts": {"pr": PR, "br": BR, "body": P.BODY_HEIGHT,
                       "tmin": P.THROW_SPEED_MIN, "tmax": P.THROW_SPEED_MAX,
                       "vz": P.VZ_DIRECT, "grav": P.GRAVITY},
        }
