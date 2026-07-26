"""Pure, deterministic physics constants + helpers for DODGEBALL.

Top-down 2.5D: ground is ``(x, y)`` (pixels, +y down), height is a separate
``z`` axis that only the ball uses (gravity acts on ``vz`` only).  Fixed
timestep, integer-tick-driven, all randomness seeded — same seed + same inputs
reproduce the same match (like every other realtime game in the hub).

Units: distance px, time s, velocity px/s, accel/gravity px/s^2.  Constants are
tuned to the ~1100x700 arena the other realtime games use; every value is a
starting point exposed here so the feel can be tuned in one place.  Juice
(shake, hitstop, particles, haptics) lives entirely on the client — never here.
"""

import math

# --- sim frame -------------------------------------------------------------
DT = 1.0 / 60.0          # physics step
SUBSTEPS = 2             # per world tick -> 30 Hz snapshots, 60 Hz physics
TICK = DT * SUBSTEPS     # 1/30 s: the broadcast tick

# --- arena / bodies --------------------------------------------------------
ARENA_W, ARENA_H = 1100.0, 700.0
PLAYER_RADIUS = 24.0
BODY_HEIGHT = 90.0       # a player is a column z in [0, BODY_HEIGHT]
BALL_RADIUS = 11.0

# --- movement --------------------------------------------------------------
RUN_SPEED = 300.0        # ~3.7 s to cross the long axis
ACCEL_TAU = 0.10         # time-to-max ~0.30 s
STOP_TAU = 0.07          # time-to-stop ~0.21 s (snappier stop = "has mass")
PLAYER_RESTITUTION = 0.15
PUSH_PCT = 0.7           # soft body positional correction
SLOP = 0.5               # ignore overlaps below this

# --- dash / dodge ----------------------------------------------------------
DASH_SPEED = 720.0
DASH_DURATION = 0.22     # covers ~158 px
DASH_IFRAMES = 0.16      # first ~73% of the dash is invulnerable; tail punishable
DASH_COOLDOWN = 0.90

# --- throw -----------------------------------------------------------------
THROW_SPEED_MIN = 460.0  # tap throw
THROW_SPEED_MAX = 850.0  # full charge
RELEASE_HEIGHT = 45.0    # z0, hand height
VZ_DIRECT = 300.0        # flat lethal throw; peak z ~77 (< body height)
VZ_LOB = 640.0           # arc over heads; peak z ~191
LOB_POWER = 0.55         # power below this reads as a lob (higher arc)
SELF_IMMUNE = 0.25       # thrower can't be hit by their own ball this long

# --- ball physics ----------------------------------------------------------
GRAVITY = 1400.0         # z-axis only
RESTITUTION_Z = 0.60     # vertical bounce; e^2=0.36 -> settles in ~3 bounces
RESTITUTION_H = 0.80     # horizontal roll-out per ground bounce
RESTITUTION_WALL = 0.85  # x/y wall reflect
LETHAL_MIN_SPEED = 260.0 # airborne ball slower than this can't KO
DEAD_SPEED = 120.0       # below this it's at rest, a neutral pickup
BALL_IDLE_RESPAWN = 8.0  # an untouched dead ball warps to a neutral spawn

# --- hit / knockback -------------------------------------------------------
KB_BASE = 160.0
KB_SCALE = 0.35
KB_MIN, KB_MAX = 160.0, 520.0
KB_TAU = 0.09
HIT_STUN = 0.20
IFRAMES_HIT = 0.80
IFRAMES_SPAWN = 1.50
LIVES = 3

# --- catch -----------------------------------------------------------------
CATCH_WINDOW = 0.24
CATCH_COOLDOWN = 0.60
CATCH_REACH_Z = 18.0
PERFECT_CATCH_WINDOW = 0.08

# --- ammo ------------------------------------------------------------------
HOLD_CAP = 1
PICKUP_RANGE = PLAYER_RADIUS + BALL_RADIUS + 8.0

# --- sudden death (guarantees a punchy, finite match) ----------------------
SUDDEN_DEATH_START = 55.0     # walls start closing after this
SHRINK_TIME = 45.0           # seconds to squeeze down to the core
CORE_W = 240.0               # final playable core (centered)
MAX_MARGIN_X = (ARENA_W - CORE_W) / 2.0
MAX_MARGIN_Y = (ARENA_H - CORE_W) / 2.0
STORM_START = 120.0          # hard backstop: eliminate the weakest each interval
STORM_INTERVAL = 1.5


def shrink_margins(clock):
    """Edge margins of the shrinking safe zone at ``clock`` (0 before SD)."""
    if clock < SUDDEN_DEATH_START:
        return (0.0, 0.0)
    f = clamp((clock - SUDDEN_DEATH_START) / SHRINK_TIME, 0.0, 1.0)
    return (MAX_MARGIN_X * f, MAX_MARGIN_Y * f)


def clamp(v, lo, hi):
    return lo if v < lo else (hi if v > hi else v)


def approach(v, target, tau, dt):
    """Frame-rate-independent exponential ease of a scalar toward ``target``."""
    a = 1.0 - math.exp(-dt / tau)
    return v + (target - v) * a


def n_balls_for(players):
    """Fewer balls than players -> a scramble. 2p:3, 4p:3, 6p:5, 8p:6."""
    return max(3, math.ceil(players * 0.75))


def seg_circle_toi(x0, y0, x1, y1, cx, cy, r):
    """Swept (continuous) collision: time-of-impact in [0,1] of the segment
    (x0,y0)->(x1,y1) entering a circle of radius ``r`` at ``(cx,cy)``, or None.

    This is what stops a fast ball tunnelling through a thin player in one step.
    Returns the *earliest* contact fraction along the segment (0 if it starts
    already overlapping), else None.
    """
    dx, dy = x1 - x0, y1 - y0
    fx, fy = x0 - cx, y0 - cy
    if fx * fx + fy * fy <= r * r:
        return 0.0                       # already overlapping at segment start
    a = dx * dx + dy * dy
    if a < 1e-12:
        return None                      # no movement and not overlapping
    b = 2.0 * (fx * dx + fy * dy)
    c = fx * fx + fy * fy - r * r
    disc = b * b - 4.0 * a * c
    if disc < 0.0:
        return None                      # never touches
    sq = math.sqrt(disc)
    t = (-b - sq) / (2.0 * a)            # first root = entry
    if 0.0 <= t <= 1.0:
        return t
    return None
