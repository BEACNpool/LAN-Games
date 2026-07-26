"""Pure geometry + constants for BRICKADE (Pong-royale x Breakout x power-ups).

Server-authoritative real-time sim (same cadence as dodgeball: 60 Hz physics /
30 Hz snapshots). Top-down, NO gravity, elastic bounce. 2 players => a rectangle
(Pong); 3-8 => a regular N-gon where each player defends one EDGE as their goal
with a paddle sliding along it. The heart is Lethal-League last-touch ownership:
a ball can only score in OTHER players' goals, and every paddle hit speeds it up.

Geometry uses the orientation-independent inward normal ``n = hat(C - M)`` (M =
edge midpoint, C = arena center) so winding order never matters.
"""

import math

# --- sim frame -------------------------------------------------------------
DT = 1.0 / 60.0
SUBSTEPS = 2
TICK = DT * SUBSTEPS          # 1/30 s broadcast

# --- arena -----------------------------------------------------------------
CX, CY = 500.0, 500.0
ARENA_R = 440.0               # N-gon circumradius (3..8 players)
BALL_R = 11.0
PADDLE_COVER = 0.34           # paddle covers this fraction of its goal edge
PADDLE_COVER_BIG = 0.52       # BIG PADDLE power-up
PADDLE_THICK = 16.0           # visual/collision thickness off the edge line
PADDLE_SPEED = 1050.0         # max slew of the paddle center (px/s)

# rectangle (2 players): goals on bottom (seat 0) + top (seat 1), sides solid
RECT_W, RECT_H = 540.0, 760.0

# --- ball speed ladder (the Lethal League clock) ---------------------------
BALL_START = 470.0
BALL_MIN = 470.0
BALL_MAX = 1500.0
HIT_SPEEDUP = 1.055           # per paddle hit
BRICK_SPEEDUP = 1.01          # tiny bump per brick smashed
MIN_RAMP_AFTER = 20.0         # after 20s, the floor rises (anti-stall)
MIN_RAMP_RATE = 7.0           # +px/s each second
NEUTRAL_DECAY_AFTER = 3.0     # untouched ball sheds speed toward BALL_MIN
IDLE_RESPAWN = 4.5            # neutral+slow too long -> warp to center, fire at leader
PADDLE_ENGLISH = 0.85         # contact-offset -> exit-angle steering
PADDLE_SPIN = 0.30            # paddle velocity -> tangential spin added to the ball

# --- ownership -------------------------------------------------------------
SELF_IMMUNE = True            # your own ball never scores on your own goal
SERVE_GRACE = 1.4             # a fresh NEUTRAL serve can't score for this long
MIN_INWARD = 0.25             # min inward fraction of a paddle-save exit (~14.5°)
                              # so a grazing save can't skim into a neighbour's net

# --- bricks ----------------------------------------------------------------
BRICK_W, BRICK_H = 52.0, 26.0
SPECIAL_PCT = 0.14            # fraction of bricks that are special (arm a power-up)
MAX_BRICK_STEP = 8.0          # substep so a fast ball can't tunnel a brick

# --- power-ups (v1 six) ----------------------------------------------------
PU_KINDS = ["big", "multi", "phase", "slow", "over", "shield"]
PHASE_TIME = 6.0
SLOW_TIME = 6.0
SLOW_MULT = 0.55
OVER_TIME = 6.0
OVER_MULT = 1.7
BIG_TIME = 9.0
SHIELD_TIME = 8.0
SHIELD_HITS = 3
MULTI_SPREAD = 0.34          # radians, extra balls fan out


def max_balls(n):
    # headroom so MULTIBALL (adds 2) turns a lone ball into three, capped for sanity
    return min(5, max(3, n))


# --- termination (mirrors dodgeball) --------------------------------------
GOAL_HP = 3
SUDDEN_DEATH_START = 55.0
SHRINK_TIME = 40.0
SHRINK_TO = 0.60             # ring contracts to 60% of R
STORM_START = 120.0
STORM_INTERVAL = 2.0


def clamp(v, lo, hi):
    return lo if v < lo else (hi if v > hi else v)


def approach(v, target, tau, dt):
    return v + (target - v) * (1.0 - math.exp(-dt / tau))


# ---------------------------------------------------------------------------
# geometry
# ---------------------------------------------------------------------------
def _edge(a, b, kind, owner):
    ax, ay = a
    bx, by = b
    ux, uy = bx - ax, by - ay
    s = math.hypot(ux, uy) or 1.0
    ux, uy = ux / s, uy / s
    mx, my = (ax + bx) / 2.0, (ay + by) / 2.0
    nx, ny = CX - mx, CY - my                 # inward normal (toward center)
    nl = math.hypot(nx, ny) or 1.0
    nx, ny = nx / nl, ny / nl
    return {
        "a": [ax, ay], "b": [bx, by], "u": [ux, uy], "n": [nx, ny],
        "m": [mx, my], "s": s, "kind": kind, "owner": owner,
        "angle": math.atan2(my - CY, mx - CX),   # for per-client rotate-to-bottom
    }


def build_edges(n, shrink=1.0):
    """Edge list for ``n`` players. shrink<1 pulls goal edges toward center
    (sudden death). Returns (edges, R_used)."""
    edges = []
    if n == 2:
        w, h = RECT_W, RECT_H
        # shrink squeezes the two goal edges (top/bottom) toward center
        half_h = (h / 2.0) * shrink
        x0, x1 = CX - w / 2.0, CX + w / 2.0
        yb, yt = CY + half_h, CY - half_h
        edges.append(_edge((x1, yb), (x0, yb), "goal", 0))   # bottom = seat 0
        edges.append(_edge((x0, yt), (x1, yt), "goal", 1))   # top = seat 1
        edges.append(_edge((x0, yb), (x0, yt), "wall", None))  # left wall
        edges.append(_edge((x1, yt), (x1, yb), "wall", None))  # right wall
        return edges, half_h
    R = ARENA_R * shrink
    verts = []
    for k in range(n):
        th = math.pi / 2.0 + 2.0 * math.pi * k / n     # seat 0 edge centered at bottom
        verts.append((CX + R * math.cos(th), CY + R * math.sin(th)))
    for k in range(n):
        a = verts[k]
        b = verts[(k + 1) % n]
        edges.append(_edge(a, b, "goal", k))
    return edges, R


def paddle_span(edge, t, cover):
    """(q_lo, q_hi, q_center) along the edge for a paddle centered at t in [0,1]."""
    s = edge["s"]
    length = cover * s
    half = length / 2.0
    center = half + t * (s - length)
    return center - half, center + half, center


def along(edge, q):
    ax, ay = edge["a"]
    ux, uy = edge["u"]
    return ax + ux * q, ay + uy * q


def reflect(vx, vy, nx, ny):
    d = 2.0 * (vx * nx + vy * ny)
    return vx - d * nx, vy - d * ny
