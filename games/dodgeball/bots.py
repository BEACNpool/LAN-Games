"""Deterministic dodgeball bots.

A bot ``think(view, unit)`` sets the same intent fields a human sets via input
(``move``, ``want_throw``, ``want_dash``, ``want_catch``), so bots and humans run
through the identical sim.  All randomness comes from a seed derived from
immutable tick state, so a seeded match replays identically and bots at the same
seat don't move in lockstep.  It can never produce an illegal action — it only
expresses intent; the engine validates.
"""

import math
import random

from . import physics as P

BOT_NAMES = ["Rocket", "Dodger", "Blitz", "Ace", "Nova", "Rex", "Fury", "Zip"]

TIERS = {
    "easy":  {"aim_err": 0.34, "throw_cd": 0.95, "dodge_p": 0.34,
              "catch_p": 0.0, "lead": 0.30, "danger": 150.0, "react_t": 0.42},
    "shark": {"aim_err": 0.13, "throw_cd": 0.55, "dodge_p": 0.72,
              "catch_p": 0.16, "lead": 0.75, "danger": 200.0, "react_t": 0.28},
    "hard":  {"aim_err": 0.05, "throw_cd": 0.40, "dodge_p": 0.93,
              "catch_p": 0.34, "lead": 1.00, "danger": 240.0, "react_t": 0.20},
}


def _seed(session_seed, tick, seat, salt):
    x = (session_seed ^ (salt * 0x2545F4914F6CDD1D)) & 0xFFFFFFFFFFFFFFFF
    for v in (tick, seat, salt):
        x = (x * 1000003 + (int(v) & 0xFFFFFFFF)) & 0xFFFFFFFFFFFFFFFF
    return x


class DodgeBot:
    def __init__(self, tier="shark", session_seed=0):
        self.tier = tier if tier in TIERS else "shark"
        self.session_seed = session_seed

    def think(self, view, unit):
        T = TIERS[self.tier]
        bs = unit["bot_state"]
        clock = view["clock"]
        mx, my = view["x"], view["y"]
        aw, ah = view["arena"]
        rng = random.Random(_seed(self.session_seed, view["tick"], view["seat"], 7))

        move = (0.0, 0.0)

        # --- 1. dodge / catch an incoming live ball ------------------------
        threat = self._incoming(view, mx, my, T["danger"])
        if threat is not None:
            tball, closest, ttime = threat
            react = ttime <= T["react_t"] or closest < P.PLAYER_RADIUS + 12
            if react and rng.random() < T["dodge_p"]:
                # escape perpendicular to the ball's travel
                vlen = math.hypot(tball["vx"], tball["vy"]) or 1.0
                bvx, bvy = tball["vx"] / vlen, tball["vy"] / vlen
                px, py = -bvy, bvx
                # pick the side that moves me away from the ball line
                rel = (mx - tball["x"], my - tball["y"])
                if px * rel[0] + py * rel[1] < 0:
                    px, py = -px, -py
                move = (px, py)
                if view["dash_ready"] and rng.random() < 0.7:
                    unit["want_dash"] = True
                elif not view["holding"] and rng.random() < T["catch_p"]:
                    unit["want_catch"] = True
                unit["move"] = move
                return

        # --- 2. holding a ball -> aim + throw ------------------------------
        if view["holding"]:
            tgt = self._nearest_enemy(view, mx, my)
            if tgt is not None:
                dist = math.hypot(tgt["x"] - mx, tgt["y"] - my)
                if clock >= bs.get("throw_ready", 0.0):
                    lead = T["lead"] * dist / P.THROW_SPEED_MAX
                    ax = tgt["x"] + tgt["vx"] * lead - mx
                    ay = tgt["y"] + tgt["vy"] * lead - my
                    angle = math.atan2(ay, ax) + rng.uniform(-T["aim_err"], T["aim_err"])
                    power = P.clamp(0.45 + dist / (0.9 * math.hypot(aw, ah)), 0.5, 1.0)
                    unit["want_throw"] = (angle, power)
                    bs["throw_ready"] = clock + T["throw_cd"] + rng.uniform(0, 0.2)
                # sidestep toward the target while lining up
                dx, dy = tgt["x"] - mx, tgt["y"] - my
                dl = math.hypot(dx, dy) or 1.0
                strafe = 0.5 if rng.random() < 0.5 else -0.5
                move = (dx / dl * 0.35 - dy / dl * strafe,
                        dy / dl * 0.35 + dx / dl * strafe)
            else:
                move = self._toward(mx, my, aw / 2, ah / 2)
            unit["move"] = self._clampv(move)
            return

        # --- 3. empty-handed -> grab the nearest free ball -----------------
        ball = self._nearest_free_ball(view, mx, my)
        if ball is not None:
            move = self._toward(mx, my, ball["x"], ball["y"])
        else:
            # nothing to grab: drift near the action, wander a little
            tgt = self._nearest_enemy(view, mx, my)
            if tgt is not None:
                move = self._toward(mx, my, (mx + tgt["x"]) / 2 + rng.uniform(-60, 60),
                                    (my + tgt["y"]) / 2 + rng.uniform(-60, 60))
            else:
                move = self._toward(mx, my, aw / 2, ah / 2)
        unit["move"] = self._clampv(move)

    # -- helpers -------------------------------------------------------------
    def _incoming(self, view, mx, my, danger):
        best = None
        for b in view["balls"]:
            if not b["live"] or b["thrower"] == view["seat"]:
                continue
            vx, vy = b["vx"], b["vy"]
            v2 = vx * vx + vy * vy
            if v2 < 1.0:
                continue
            relx, rely = mx - b["x"], my - b["y"]
            t = (relx * vx + rely * vy) / v2      # time of closest approach
            if t <= 0 or t > 0.7:
                continue
            cx, cy = b["x"] + vx * t, b["y"] + vy * t
            closest = math.hypot(mx - cx, my - cy)
            if closest < danger and (best is None or t < best[2]):
                best = (b, closest, t)
        return best

    def _nearest_enemy(self, view, mx, my):
        best, bd = None, 1e18
        for e in view["enemies"]:
            d = (e["x"] - mx) ** 2 + (e["y"] - my) ** 2
            if d < bd:
                best, bd = e, d
        return best

    def _nearest_free_ball(self, view, mx, my):
        best, bd = None, 1e18
        for b in view["balls"]:
            if not b["free"]:
                continue
            d = (b["x"] - mx) ** 2 + (b["y"] - my) ** 2
            if d < bd:
                best, bd = b, d
        return best

    def _toward(self, x0, y0, x1, y1):
        dx, dy = x1 - x0, y1 - y0
        d = math.hypot(dx, dy)
        if d < 8:
            return (0.0, 0.0)
        return (dx / d, dy / d)

    def _clampv(self, v):
        m = math.hypot(v[0], v[1])
        if m > 1.0:
            return (v[0] / m, v[1] / m)
        return v


def make_bot(tier, session_seed):
    return DodgeBot(tier, session_seed)
