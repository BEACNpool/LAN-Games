"""Deterministic BRICKADE goalie bots.

``think(view, unit)`` sets the same intent fields a human sets (``t_target``, and
``want_act`` to fire a power-up). It projects every ball onto the bot's own goal
edge, moves the paddle to intercept the most imminent threat, and drifts toward
the nearest ball otherwise. Seeded, so a match replays and bots at different
seats don't move in lockstep.
"""

import math
import random

from . import physics as P

BOT_NAMES = ["Wall-E", "Keeper", "Rico", "Bumper", "Zed", "Volley", "Deuce", "Pixel"]

TIERS = {
    "easy": {"err": 0.16, "lag": 0.22, "react": 0.6, "use_p": 0.010, "idle_t": 0.5},
    "hard": {"err": 0.03, "lag": 0.06, "react": 1.4, "use_p": 0.030, "idle_t": 0.5},
}


def _seed(session_seed, tick, seat):
    x = session_seed & 0xFFFFFFFFFFFF
    for v in (tick, seat, 19):
        x = (x * 1000003 + (int(v) & 0xFFFFFFFF)) & 0xFFFFFFFFFFFFFFFF
    return x


class BrickBot:
    def __init__(self, tier="hard", session_seed=0):
        self.tier = tier if tier in TIERS else "hard"
        self.session_seed = session_seed

    def think(self, view, unit):
        T = TIERS[self.tier]
        rng = random.Random(_seed(self.session_seed, view["tick"], view["seat"]))
        edge = view["edge"]
        ax, ay = edge["a"]
        nx, ny = edge["n"]
        ux, uy = edge["u"]
        s = edge["s"]

        best_q, best_t = None, 1e9
        nearest_q, nearest_d = None, 1e18
        for b in view["balls"]:
            vn = b["vx"] * nx + b["vy"] * ny
            # q of the ball projected straight onto my edge (for idle tracking)
            pq = (b["x"] - ax) * ux + (b["y"] - ay) * uy
            d = (b["x"] - ax) * nx + (b["y"] - ay) * ny
            if d < nearest_d:
                nearest_d, nearest_q = d, pq
            if vn < -1.0:                          # heading toward my edge
                tt = -((b["x"] - ax) * nx + (b["y"] - ay) * ny) / vn
                if tt <= 0:
                    continue
                cx = b["x"] + b["vx"] * tt
                cy = b["y"] + b["vy"] * tt
                q = (cx - ax) * ux + (cy - ay) * uy
                if -0.2 * s <= q <= 1.2 * s and tt < best_t:
                    best_t, best_q = tt, q

        if best_q is not None:
            target_q = P.clamp(best_q, 0.0, s)
            # react only within a lookahead window (weaker bots see threats later)
            if best_t > T["react"]:
                target_q = self._q_from_ball(nearest_q, s)
        elif nearest_q is not None:
            target_q = self._q_from_ball(nearest_q, s)
        else:
            target_q = s * 0.5

        # aim error + a little lag
        target_q += rng.uniform(-T["err"], T["err"]) * s
        cover = unit["cover"]
        length = cover * s
        travel = max(1.0, s - length)
        t = P.clamp((target_q - length / 2.0) / travel, 0.0, 1.0)
        unit["t_target"] = P.approach(unit["t_target"], t, T["lag"], P.TICK)

        # power-up: fire it soon after picking one up
        if view["have_pu"] and rng.random() < T["use_p"]:
            unit["want_act"] = True

    def _q_from_ball(self, q, s):
        if q is None:
            return s * 0.5
        return P.clamp(q, 0.0, s)


def make_bot(tier, session_seed):
    return BrickBot(tier, session_seed)
