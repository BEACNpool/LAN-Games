"""SMELTER SKELTER — 2-8 humans swing on chains over a molten smelter.

The hub's second REAL-TIME game (snake was the first) and its first with
continuous physics. A single self-chaining deadline drives the world at 15 Hz;
each world tick runs four 60 Hz physics substeps, so the simulation is stable
without the net layer learning anything new about frame rates.

WHAT PLAYERS DO: everyone hangs from an overhead chain. Aim a direction, press
HOOK to fire at whatever the aim-assist cone likes best (a girder, a crane, or
another player), hold REEL to shorten the chain and pump the swing. One cargo
crate exists at a time — touch it and it trails behind you on a short chain and
makes you heavy. Drop it down the chute for 3 points (6 during overload). Slam
the carrier hard enough and the crate tears loose into your hands. Slam anyone
into the molten floor for a wipe point. Falling costs you ~2 seconds and hands
you one over-powered super hook on the way back in. Nobody is ever eliminated.

DETERMINISM: every random choice comes from `self.rng` and every time-dependent
quantity (crane sweep, fuses, shift clock, respawns) is a function of the
integer tick — never the wall clock. Two sessions seeded alike and fed the same
script produce byte-identical states. `time.time()` appears only where the base
class needs it: arming the next deadline.

World coordinates use screen convention: x grows right, y grows down, and the
smelter is the region below `hazard_y`.
"""

from __future__ import annotations

import math
import time

from core.session import GameSession

WORLD_W, WORLD_H = 1200, 675
TICK = 1 / 15                   # world step; the client interpolates between
TICK_MS = 67
SUBSTEPS = 4                    # 60 Hz physics inside every 15 Hz world tick
DT = TICK / SUBSTEPS

GRAVITY = 1500.0
DRAG = 0.9988
MAX_SPEED = 1400.0
UNIT_R = 17.0
CARGO_R = 15.0

MIN_ROPE = 52.0                 # short enough to whip, long enough not to park
START_ROPE = 130.0
MAX_HOOK_RANGE = 430.0
SUPER_RANGE_MULT = 1.65
SUPER_YANK = 0.72               # a super hook lands already reeled this far in
HOOK_CONE_DEG = 65.0            # aim-assist HALF angle — phone thumbs are coarse
HOOK_BUFFER = 0.15              # a press this early still catches
HOOK_BUFFER_TICKS = max(1, round(HOOK_BUFFER / TICK))
REEL_RATE = 80.0                # px/s of chain hauled in — a pump, not a winch
SLACK_RATE = 95.0               # px/s the chain pays back out when not reeling
REEL_ASSIST = 120.0             # px/s^2 tangential kick; breaks a dead hang
SPIN_CAP = 1.06                 # per-substep ceiling on the spin-up ratio
HOST_MASS_MULT = 2.4            # a hooked player is harder to drag than a girder
TENSION_REF = GRAVITY * 3.5

CARGO_MASS = 0.85               # cargo makes the carrier genuinely heavy
CARGO_CHAIN = 46.0
CARGO_FUSE = 20.0
CARGO_FUSE_TICKS = round(CARGO_FUSE / TICK)
CARGO_GRAB_CD_TICKS = 8         # ~0.5 s of "nobody" after the crate tears loose
THROW_CREDIT_TICKS = 22         # ~1.5 s to still own a crate you lobbed
BOOM_RADIUS = 210.0
BOOM_IMPULSE = 620.0

CHUTE_W, CHUTE_H = 150, 76      # a swinging crate needs a generous mouth
DELIVER_POINTS = 3
WIPE_POINTS = 1

RESTITUTION = 1.9               # equal-circle impulse coefficient
SLAM_MIN = 200.0                # impulse worth announcing
TEAR_IMPULSE = 330.0            # impulse that rips cargo out of a grip
SLAM_REF = 900.0                # normalizes best_slam into 0..1
SLAM_CD_TICKS = 3               # per-pair fx dedup
WIPE_CREDIT_TICKS = 37          # ~2.5 s to still own a shove

RESPAWN_TICKS = 30              # ~2.0 s in the wings, then back with a super
OVERLOAD_SECONDS = 15.0
OVERLOAD_TICKS = round(OVERLOAD_SECONDS / TICK)
SHIFT_BREAK_SECONDS = 4.0
HAZARD_TOP = 610.0              # shift 1 waterline; each shift raises the melt
HAZARD_STEP = 42.0

SHIFT_CHOICES = (2, 3)
SHIFT_SECONDS_CHOICES = (45, 60)
ANCHOR_KINDS = ("beam", "pylon", "crane")


def _finite(value):
    """True for a real, finite number. Bools are numbers in Python — reject."""
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(float(value)))


def _clamp(value, low, high):
    return low if value < low else (high if value > high else value)


def segment_hits_rect(x0, y0, x1, y1, rx, ry, rw, rh):
    """Liang-Barsky: does the swept segment touch the axis-aligned rect?

    A crate can cross 20+ px in a single 60 Hz substep, so a point-in-rect
    delivery test lets fast throws tunnel clean through the chute. Sweeping the
    whole step means a good throw always scores.
    """
    dx, dy = x1 - x0, y1 - y0
    t0, t1 = 0.0, 1.0
    for p, q in ((-dx, x0 - rx), (dx, rx + rw - x0),
                 (-dy, y0 - ry), (dy, ry + rh - y0)):
        if p == 0:
            if q < 0:
                return False                # parallel and outside this slab
            continue
        r = q / p
        if p < 0:
            if r > t1:
                return False
            t0 = max(t0, r)
        else:
            if r < t0:
                return False
            t1 = min(t1, r)
    return t0 <= t1


def hazard_for_shift(shift):
    """The molten line climbs one step per shift — the arena shrinks."""
    return HAZARD_TOP - HAZARD_STEP * max(0, int(shift) - 1)


def anchor_position(anchor, ftick):
    """Where an anchor is at (possibly fractional) tick `ftick`.

    Pure and tick-driven so physics, serialization and tests all agree, and so
    a replayed script lands on identical coordinates.
    """
    if anchor["kind"] != "crane":
        return anchor["x"], anchor["y"]
    t = ftick * TICK
    x = anchor["x"] + anchor["amp"] * math.sin(t * anchor["speed"] + anchor["phase"])
    return _clamp(x, 60.0, WORLD_W - 60.0), anchor["y"]


def generate_anchors(rng, count, shift, hazard_y):
    """Lay out the overhead rig for one shift.

    Anchors are spread across lanes so no corner of the arena is dead, heights
    are staggered for visual variety, and cranes (which sweep horizontally)
    only appear from shift 2 on — that is the escalation the crew feels.
    """
    count = max(4, min(14, int(count)))
    ceiling = 74.0
    floor = max(ceiling + 90.0, hazard_y - 190.0)
    lane = (WORLD_W - 180.0) / count
    anchors = []
    for i in range(count):
        x = 90.0 + lane * (i + 0.5) + rng.uniform(-lane * 0.28, lane * 0.28)
        y = rng.uniform(ceiling, floor)
        kind = "beam" if i % 2 == 0 else "pylon"
        amp = 0.0
        speed = 0.0
        phase = 0.0
        # Cranes sweep, so they need room; keep them off the arena edges.
        if shift >= 2 and i % 3 == 1 and 200.0 < x < WORLD_W - 200.0:
            kind = "crane"
            amp = rng.uniform(70.0, 150.0)
            speed = rng.uniform(0.45, 0.85)
            phase = rng.uniform(0.0, math.tau)
        anchors.append({
            "id": i,
            "x": round(_clamp(x, 70.0, WORLD_W - 70.0), 2),
            "y": round(_clamp(y, ceiling, floor), 2),
            "kind": kind,
            "amp": round(amp, 2),
            "speed": round(speed, 3),
            "phase": round(phase, 4),
        })
    return anchors


class SmelterSkelterSession(GameSession):
    MIN_PLAYERS = 2
    MAX_HUMANS = 8
    DEFAULT_SETTINGS = {"shifts": 3, "shift_seconds": 45}

    def __init__(self, rng=None):
        super().__init__(rng)
        self.g = None

    # ---------------- settings ----------------

    def validate_settings(self, patch):
        out = {}
        shifts = patch.get("shifts")
        if isinstance(shifts, int) and not isinstance(shifts, bool) \
                and shifts in SHIFT_CHOICES:
            out["shifts"] = shifts
        seconds = patch.get("shift_seconds")
        if isinstance(seconds, int) and not isinstance(seconds, bool) \
                and seconds in SHIFT_SECONDS_CHOICES:
            out["shift_seconds"] = seconds
        return out

    def _setting(self, key, choices):
        """Settings can also be poked directly in tests — re-clamp on read."""
        value = self.settings.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and value in choices:
            return value
        return self.DEFAULT_SETTINGS[key]

    # ---------------- start ----------------

    def game_start(self):
        order = list(self.participants)
        self.g = {
            "tick": 0,
            "shift": 0,
            "shifts_total": self._setting("shifts", SHIFT_CHOICES),
            "shift_ticks": round(self._setting("shift_seconds",
                                               SHIFT_SECONDS_CHOICES) / TICK),
            "shift_end_tick": 0,
            "overload": False,
            "hazard_y": hazard_for_shift(1),
            "order": order,
            "anchors": [],
            "units": {},
            "cargo": None,
            "chute": {"x": 0.0, "y": 0.0, "w": CHUTE_W, "h": CHUTE_H},
            "stats": {token: {"score": 0, "deliveries": 0, "steals": 0,
                              "wipes": 0, "falls": 0, "best_slam": 0.0}
                      for token in order},
            "pair_cd": {},
            "result": None,
        }
        for token in order:
            self.g["units"][token] = {
                "x": WORLD_W / 2, "y": WORLD_H / 2,
                "vx": 0.0, "vy": 0.0,
                "alive": True, "respawn_tick": 0,
                "hook": None, "rope_len": START_ROPE, "rope_base": START_ROPE,
                "tension": 0.0,
                "aim": 270.0,
                "hook_held": False, "reel_held": False, "hook_buffer": 0,
                "super": False,
                "last_hit": None, "last_hit_tick": -999,
            }
        return self._start_shift()

    def _start_shift(self):
        """Fresh rig, fresh crate, everybody re-seated and already attached."""
        g = self.g
        g["shift"] += 1
        g["hazard_y"] = hazard_for_shift(g["shift"])
        g["overload"] = False
        g["pair_cd"] = {}
        g["shift_end_tick"] = g["tick"] + g["shift_ticks"]
        g["anchors"] = generate_anchors(
            self.rng, max(6, len(g["order"]) + 4), g["shift"], g["hazard_y"])
        for token in g["order"]:
            self._seat(g["units"][token], super_hook=False)
        g["cargo"] = None
        self._respawn_cargo()
        self.phase = "play"
        self._bump(time.time() + TICK)
        return [self.fx("shift_start", shift=g["shift"],
                        total=g["shifts_total"],
                        hazard_y=round(g["hazard_y"], 1))]

    # ---------------- placement ----------------

    def _anchor_pool(self):
        """Never hand back an empty rig. generate_anchors always makes at
        least four, but a raise inside a tick would freeze the room, so the
        one place that could divide by an empty list gets a fallback."""
        g = self.g
        if g["anchors"]:
            return g["anchors"]
        return [{"id": 0, "x": WORLD_W / 2, "y": 120.0, "kind": "beam",
                 "amp": 0.0, "speed": 0.0, "phase": 0.0}]

    def _safe_anchors(self):
        """Anchors with real air beneath them — never respawn into the melt."""
        g = self.g
        pool = self._anchor_pool()
        safe = [a for a in pool
                if a["y"] < g["hazard_y"] - (START_ROPE + 110.0)]
        return safe or pool

    def _seat(self, unit, super_hook):
        """Hang a unit from a safe anchor, already attached and at rest."""
        g = self.g
        anchor = self.rng.choice(self._safe_anchors())
        ax, ay = anchor_position(anchor, g["tick"])
        rope = min(START_ROPE, max(MIN_ROPE, g["hazard_y"] - ay - 120.0))
        swing = self.rng.uniform(-0.5, 0.5)
        unit["x"] = _clamp(ax + math.sin(swing) * rope, UNIT_R, WORLD_W - UNIT_R)
        unit["y"] = _clamp(ay + math.cos(swing) * rope, UNIT_R, g["hazard_y"] - 30.0)
        unit["vx"] = self.rng.uniform(-40.0, 40.0)
        unit["vy"] = 0.0
        unit["alive"] = True
        unit["respawn_tick"] = 0
        unit["hook"] = {"kind": "anchor", "id": anchor["id"]}
        unit["rope_len"] = unit["rope_base"] = rope
        unit["tension"] = 0.0
        unit["hook_buffer"] = 0
        unit["last_hit"] = None
        unit["last_hit_tick"] = -999
        if super_hook:
            unit["super"] = True

    def _relocate_chute(self):
        g = self.g
        margin = 130.0
        g["chute"] = {
            "x": round(self.rng.uniform(margin, WORLD_W - margin - CHUTE_W), 1),
            "y": round(self.rng.uniform(150.0, max(160.0, g["hazard_y"] - 210.0)), 1),
            "w": CHUTE_W, "h": CHUTE_H,
        }

    def _respawn_cargo(self):
        """Hang a fresh crate off the rig, and move the chute to match.

        A fresh crate dangles from its own anchor rather than free-falling:
        that makes it a stable thing to swing at instead of something that
        melts a second after it appears. The chain is cut the moment anybody
        touches it — from then on the crate is loose and gravity is its
        problem, which is what makes carrying it tense.
        """
        g = self.g
        self._relocate_chute()
        chute = g["chute"]
        pool = self._anchor_pool()
        candidates = [a for a in pool if a["y"] < g["hazard_y"] - 230.0] or pool
        pick = None
        for _ in range(40):
            anchor = self.rng.choice(candidates)
            hang = self.rng.uniform(95.0, 175.0)
            ax, ay = anchor_position(anchor, g["tick"])
            x, y = ax, ay + hang
            if y >= g["hazard_y"] - 60.0:
                continue
            if chute["x"] - 80 <= x <= chute["x"] + chute["w"] + 80 and \
                    chute["y"] - 80 <= y <= chute["y"] + chute["h"] + 80:
                continue
            if any(math.hypot(x - u["x"], y - u["y"]) < 120.0
                   for u in g["units"].values() if u["alive"]):
                continue
            pick = (anchor["id"], hang, x, y)
            break
        if pick is None:
            anchor = candidates[0]
            ax, ay = anchor_position(anchor, g["tick"])
            hang = min(140.0, max(40.0, g["hazard_y"] - ay - 90.0))
            pick = (anchor["id"], hang, ax, ay + hang)
        g["cargo"] = {
            "x": pick[2], "y": pick[3], "vx": 0.0, "vy": 0.0,
            "carrier": None, "last_carrier": None, "last_carrier_tick": -999,
            "fuse_tick": g["tick"] + CARGO_FUSE_TICKS,
            "grab_cd": 0,
            "hang": pick[0], "hang_len": pick[1],
        }

    # ---------------- helpers ----------------

    def _pid(self, token):
        player = self.players.get(token)
        return player.pid if player else None

    def _carrying(self, token):
        cargo = self.g["cargo"]
        return cargo is not None and cargo["carrier"] == token

    def _mass(self, token):
        return 1.0 + (CARGO_MASS if self._carrying(token) else 0.0)

    def _drop_cargo(self, keep_credit=True):
        """Detach the crate from whoever holds it, leaving throw credit."""
        cargo = self.g["cargo"]
        if cargo is None or cargo["carrier"] is None:
            return None
        holder = cargo["carrier"]
        cargo["carrier"] = None
        if keep_credit:
            cargo["last_carrier"] = holder
            cargo["last_carrier_tick"] = self.g["tick"]
        return holder

    # ---------------- hooking ----------------

    def _hook_point(self, unit, ftick):
        """Current world position of whatever this unit is hooked to."""
        g = self.g
        hook = unit["hook"]
        if hook is None:
            return None
        if hook["kind"] == "anchor":
            anchor = next((a for a in g["anchors"] if a["id"] == hook["id"]), None)
            if anchor is None:
                return None
            return anchor_position(anchor, ftick)
        host = g["units"].get(hook["token"])
        if host is None or not host["alive"]:
            return None
        return host["x"], host["y"]

    def _best_target(self, token, unit):
        """Aim assist: score every candidate inside the cone, take the best.

        Candidates are walked in a fixed order (anchors by id, then units by
        seat order) and ties keep the first seen, so the choice is stable for a
        given world — no set iteration, no wall clock.
        """
        g = self.g
        reach = MAX_HOOK_RANGE * (SUPER_RANGE_MULT if unit["super"] else 1.0)
        aim = math.radians(unit["aim"])
        ax, ay = math.cos(aim), math.sin(aim)
        best = None
        best_score = -1e9

        def consider(tx, ty, target, penalty):
            nonlocal best, best_score
            dx, dy = tx - unit["x"], ty - unit["y"]
            dist = math.hypot(dx, dy)
            if dist < 14.0 or dist > reach:
                return
            cos_off = _clamp((dx * ax + dy * ay) / dist, -1.0, 1.0)
            offset = math.degrees(math.acos(cos_off))
            if offset > HOOK_CONE_DEG:
                return
            score = (1.0 - offset / HOOK_CONE_DEG) + 0.55 * (1.0 - dist / reach)
            score -= penalty
            if score > best_score:
                best_score, best = score, target

        for anchor in g["anchors"]:
            px, py = anchor_position(anchor, g["tick"])
            consider(px, py, {"kind": "anchor", "id": anchor["id"]}, 0.0)
        for other in g["order"]:
            if other == token:
                continue
            host = g["units"][other]
            if not host["alive"]:
                continue
            # Slight penalty: a live body is a less dependable anchor than a
            # girder, so it only wins when it is clearly the better line.
            consider(host["x"], host["y"], {"kind": "unit", "token": other}, 0.10)
        return best

    def _attach(self, token, unit, fx):
        target = self._best_target(token, unit)
        if target is None:
            return False
        point = None
        if target["kind"] == "anchor":
            anchor = next(a for a in self.g["anchors"] if a["id"] == target["id"])
            point = anchor_position(anchor, self.g["tick"])
        else:
            host = self.g["units"][target["token"]]
            point = (host["x"], host["y"])
        dist = math.hypot(point[0] - unit["x"], point[1] - unit["y"])
        rope = max(MIN_ROPE, dist)
        used_super = unit["super"]
        if used_super:
            rope = max(MIN_ROPE, rope * SUPER_YANK)
            unit["super"] = False
        unit["hook"] = target
        unit["rope_len"] = unit["rope_base"] = rope
        unit["hook_buffer"] = 0
        fx.append(self.fx(
            "hook", pid=self._pid(token), x=round(point[0], 1),
            y=round(point[1], 1), what=target["kind"], sup=bool(used_super),
            on=self._pid(target["token"]) if target["kind"] == "unit" else None))
        return True

    def _release(self, token, unit, fx):
        if unit["hook"] is None:
            return
        unit["hook"] = None
        unit["tension"] = 0.0
        fx.append(self.fx("release", pid=self._pid(token),
                          x=round(unit["x"], 1), y=round(unit["y"], 1)))

    # ---------------- actions ----------------

    def game_action(self, token, msg):
        self.seq += 1
        if not isinstance(msg, dict):
            return [self.fx("invalid", to=token, msg="Malformed action")]
        g = self.g
        if g is None or token not in g["units"] or self.phase not in ("play", "shift_end"):
            return []                       # spectators and dead phases: no-op
        player = self.players.get(token)
        if player is not None and not player.connected:
            return []                       # a dropped pad cannot steer
        unit = g["units"][token]
        kind = msg.get("t")
        fx = []

        if kind == "aim":
            degrees = msg.get("d")
            if not _finite(degrees):
                return [self.fx("invalid", to=token, msg="Aim needs a number")]
            unit["aim"] = round(float(degrees) % 360.0, 2)
            return []

        if kind == "hook":
            on = msg.get("on")
            if not isinstance(on, bool):
                return [self.fx("invalid", to=token, msg="Hook needs on/off")]
            unit["hook_held"] = on
            if not on:
                if self.phase == "play":
                    self._release(token, unit, fx)
                unit["hook_buffer"] = 0
                return fx
            if self.phase != "play" or not unit["alive"]:
                return []                   # hold recorded; nothing to grab yet
            if unit["hook"] is not None:
                return []
            if not self._attach(token, unit, fx):
                # Nothing in the cone right now — remember the press briefly so
                # a swing that arrives 100 ms later still catches.
                unit["hook_buffer"] = g["tick"] + HOOK_BUFFER_TICKS
            return fx

        if kind == "reel":
            on = msg.get("on")
            if not isinstance(on, bool):
                return [self.fx("invalid", to=token, msg="Reel needs on/off")]
            unit["reel_held"] = on
            return []

        return [self.fx("invalid", to=token, msg="Unknown action")]

    # ---------------- the world tick ----------------

    def game_tick(self):
        if self.g is None:
            return []
        if self.phase == "play":
            return self._tick_play()
        if self.phase == "shift_end":
            return self._start_shift()
        return []

    def _tick_play(self):
        g = self.g
        base = self.deadline or time.time()
        g["tick"] += 1
        tick = g["tick"]
        fx = []

        # -- overload: the last stretch of every shift pays double
        left = g["shift_end_tick"] - tick
        # `left == 0` is the closing tick — deliveries in it still pay double.
        overload = 0 <= left <= OVERLOAD_TICKS
        if overload and not g["overload"]:
            fx.append(self.fx("overload", seconds=round(left * TICK, 1),
                              mult=2))
        g["overload"] = overload

        # -- respawn timers and buffered hook presses
        for token in g["order"]:
            unit = g["units"][token]
            if not unit["alive"]:
                if tick >= unit["respawn_tick"]:
                    self._seat(unit, super_hook=True)
                continue
            if unit["hook"] is None and unit["hook_held"] and unit["hook_buffer"]:
                if tick <= unit["hook_buffer"]:
                    self._attach(token, unit, fx)
                else:
                    unit["hook_buffer"] = 0

        for sub in range(SUBSTEPS):
            self._substep(tick - 1 + (sub + 1) / SUBSTEPS, fx)

        # -- crate fuse
        cargo = g["cargo"]
        if cargo is not None and tick >= cargo["fuse_tick"]:
            self._explode_cargo("fuse", fx)

        if tick >= g["shift_end_tick"]:
            return fx + self._end_shift()
        # -- chain the loop: this is what makes the game real-time
        self._bump(max(time.time() + 0.02, base + TICK))
        return fx

    # ---------------- physics ----------------

    def _substep(self, ftick, fx):
        g = self.g
        order = g["order"]

        for token in order:
            unit = g["units"][token]
            if unit["alive"]:
                self._step_unit(token, unit, ftick)
        self._step_cargo(ftick)
        self._collide_units(fx)
        self._cargo_contacts(fx)
        self._hazard(fx)

    def _step_unit(self, token, unit, ftick):
        """Gravity, then a position-based chain constraint. The chain only
        pulls (never pushes), so slack rope is free-fall and a taut rope is a
        pendulum — which is the whole game."""
        g = self.g
        unit["vy"] += GRAVITY * DT
        unit["vx"] *= DRAG
        unit["vy"] *= DRAG
        unit["x"] += unit["vx"] * DT
        unit["y"] += unit["vy"] * DT

        point = self._hook_point(unit, ftick)
        if point is None:
            if unit["hook"] is not None:      # host fell or rig regenerated
                unit["hook"] = None
            unit["tension"] = 0.0
            self._bound_unit(unit)
            return

        # Reeling shortens the chain; letting go pays it back out.
        old_len = unit["rope_len"]
        if unit["reel_held"]:
            unit["rope_len"] = max(MIN_ROPE, unit["rope_len"] - REEL_RATE * DT)
        else:
            unit["rope_len"] = min(unit["rope_base"],
                                   unit["rope_len"] + SLACK_RATE * DT)

        hx, hy = point
        dx, dy = unit["x"] - hx, unit["y"] - hy
        dist = math.hypot(dx, dy)
        if dist < 1e-6:
            dx, dy, dist = 0.0, 1.0, 1.0
        nx, ny = dx / dist, dy / dist

        if dist > unit["rope_len"]:
            excess = dist - unit["rope_len"]
            hook = unit["hook"]
            host = g["units"].get(hook["token"]) if hook["kind"] == "unit" else None
            if host is None or not host["alive"]:
                # Immovable anchor: the swinger absorbs the whole correction.
                unit["x"] -= nx * excess
                unit["y"] -= ny * excess
            else:
                # Hooked to a live body: split by inverse mass, but weigh the
                # host down so being someone's anchor is annoying, not fatal.
                inv_self = 1.0 / self._mass(token)
                inv_host = 1.0 / (self._mass(hook["token"]) * HOST_MASS_MULT)
                total = inv_self + inv_host
                unit["x"] -= nx * excess * (inv_self / total)
                unit["y"] -= ny * excess * (inv_self / total)
                host["x"] += nx * excess * (inv_host / total)
                host["y"] += ny * excess * (inv_host / total)
                radial_host = host["vx"] * nx + host["vy"] * ny
                if radial_host < 0:
                    host["vx"] -= nx * radial_host * (inv_host / total)
                    host["vy"] -= ny * radial_host * (inv_host / total)
                self._bound_unit(host)
            radial = unit["vx"] * nx + unit["vy"] * ny
            if radial > 0:                    # kill only outward motion
                unit["vx"] -= nx * radial
                unit["vy"] -= ny * radial

            # Hauling in a TAUT chain conserves angular momentum: v_t * L is
            # constant, so a shorter chain means a faster swing. This is the
            # whole locomotion system — reel on the downswing to charge, let
            # go at the top to fly. Capped per substep to stay stable.
            if unit["rope_len"] < old_len:
                ratio = min(old_len / unit["rope_len"], SPIN_CAP)
                v_rad = unit["vx"] * nx + unit["vy"] * ny
                tan_x = (unit["vx"] - nx * v_rad) * ratio
                tan_y = (unit["vy"] - ny * v_rad) * ratio
                unit["vx"] = nx * v_rad + tan_x
                unit["vy"] = ny * v_rad + tan_y

            # Angular momentum can't start a pendulum that is perfectly still,
            # so reeling also kicks along the current tangent to break the
            # symmetry — the "pump your legs" bootstrap.
            if unit["reel_held"]:
                tx, ty = -ny, nx
                along = unit["vx"] * tx + unit["vy"] * ty
                sign = 1.0 if along >= 0 else -1.0
                unit["vx"] += tx * REEL_ASSIST * DT * sign
                unit["vy"] += ty * REEL_ASSIST * DT * sign

            v_rad = unit["vx"] * nx + unit["vy"] * ny
            tan_x = unit["vx"] - nx * v_rad
            tan_y = unit["vy"] - ny * v_rad
            speed_t2 = tan_x * tan_x + tan_y * tan_y
            load = speed_t2 / max(MIN_ROPE, unit["rope_len"]) + GRAVITY * max(0.0, ny)
            unit["tension"] = round(_clamp(load / TENSION_REF, 0.0, 1.0), 3)
        else:
            unit["tension"] = 0.0
        self._bound_unit(unit)

    def _step_cargo(self, ftick):
        """The crate dangles from the rig, trails its carrier, or falls."""
        g = self.g
        cargo = g["cargo"]
        if cargo is None:
            return
        cargo["px"], cargo["py"] = cargo["x"], cargo["y"]
        cargo["vy"] += GRAVITY * DT
        cargo["vx"] *= DRAG
        cargo["vy"] *= DRAG
        cargo["x"] += cargo["vx"] * DT
        cargo["y"] += cargo["vy"] * DT

        if cargo["carrier"] is None and cargo["hang"] is not None:
            anchor = next((a for a in g["anchors"] if a["id"] == cargo["hang"]), None)
            if anchor is None:
                cargo["hang"] = None
            else:
                hx, hy = anchor_position(anchor, ftick)
                dx, dy = cargo["x"] - hx, cargo["y"] - hy
                dist = math.hypot(dx, dy)
                if dist < 1e-6:
                    dx, dy, dist = 0.0, 1.0, 1.0
                if dist > cargo["hang_len"]:
                    nx, ny = dx / dist, dy / dist
                    cargo["x"] -= nx * (dist - cargo["hang_len"])
                    cargo["y"] -= ny * (dist - cargo["hang_len"])
                    radial = cargo["vx"] * nx + cargo["vy"] * ny
                    if radial > 0:
                        cargo["vx"] -= nx * radial
                        cargo["vy"] -= ny * radial
                self._bound_cargo(cargo)
                return

        carrier = g["units"].get(cargo["carrier"]) if cargo["carrier"] else None
        if carrier is not None and carrier["alive"]:
            dx, dy = cargo["x"] - carrier["x"], cargo["y"] - carrier["y"]
            dist = math.hypot(dx, dy)
            if dist > CARGO_CHAIN:
                if dist < 1e-6:
                    dx, dy, dist = 0.0, 1.0, 1.0
                nx, ny = dx / dist, dy / dist
                excess = dist - CARGO_CHAIN
                # The crate does most of the moving; the carrier feels a tug.
                cargo["x"] -= nx * excess * 0.78
                cargo["y"] -= ny * excess * 0.78
                carrier["x"] += nx * excess * 0.22
                carrier["y"] += ny * excess * 0.22
                radial = cargo["vx"] * nx + cargo["vy"] * ny
                if radial > 0:
                    cargo["vx"] -= nx * radial * 0.78
                    cargo["vy"] -= ny * radial * 0.78
                    carrier["vx"] += nx * radial * 0.10
                    carrier["vy"] += ny * radial * 0.10
                self._bound_unit(carrier)
        elif cargo["carrier"] is not None:
            self._drop_cargo()
        self._bound_cargo(cargo)

    def _collide_units(self, fx):
        """Equal-circle impulses. Carrying cargo really does make you heavy."""
        g = self.g
        order = g["order"]
        tick = g["tick"]
        reach = UNIT_R * 2
        for i, a_token in enumerate(order):
            a = g["units"][a_token]
            if not a["alive"]:
                continue
            for b_token in order[i + 1:]:
                b = g["units"][b_token]
                if not b["alive"]:
                    continue
                dx, dy = b["x"] - a["x"], b["y"] - a["y"]
                dist = math.hypot(dx, dy)
                if dist >= reach:
                    continue
                if dist < 1e-6:
                    dx, dy, dist = 1.0, 0.0, 1.0
                nx, ny = dx / dist, dy / dist
                inv_a, inv_b = 1.0 / self._mass(a_token), 1.0 / self._mass(b_token)
                correction = (reach - dist + 0.1) / (inv_a + inv_b)
                a["x"] -= nx * correction * inv_a
                a["y"] -= ny * correction * inv_a
                b["x"] += nx * correction * inv_b
                b["y"] += ny * correction * inv_b
                rel = (b["vx"] - a["vx"]) * nx + (b["vy"] - a["vy"]) * ny
                if rel >= 0:
                    self._bound_unit(a)
                    self._bound_unit(b)
                    continue
                impulse = -(RESTITUTION * rel) / (inv_a + inv_b)
                a["vx"] -= impulse * nx * inv_a
                a["vy"] -= impulse * ny * inv_a
                b["vx"] += impulse * nx * inv_b
                b["vy"] += impulse * ny * inv_b
                self._bound_unit(a)
                self._bound_unit(b)

                if impulse > SLAM_MIN:
                    a["last_hit"], a["last_hit_tick"] = b_token, tick
                    b["last_hit"], b["last_hit_tick"] = a_token, tick
                    power = round(min(1.0, impulse / SLAM_REF), 3)
                    for token in (a_token, b_token):
                        stat = g["stats"][token]
                        if power > stat["best_slam"]:
                            stat["best_slam"] = power
                    pair = (a_token, b_token)
                    if tick - g["pair_cd"].get(pair, -99) > SLAM_CD_TICKS:
                        g["pair_cd"][pair] = tick
                        fx.append(self.fx(
                            "slam", pid=self._pid(a_token), pid2=self._pid(b_token),
                            x=round((a["x"] + b["x"]) / 2, 1),
                            y=round((a["y"] + b["y"]) / 2, 1), power=power))
                    if impulse > TEAR_IMPULSE:
                        self._tear_cargo(a_token, b_token, fx)

    def _tear_cargo(self, a_token, b_token, fx):
        """A hard enough hit rips the crate out of the carrier's grip."""
        g = self.g
        cargo = g["cargo"]
        if cargo is None or cargo["carrier"] not in (a_token, b_token):
            return
        victim = cargo["carrier"]
        thief = b_token if victim == a_token else a_token
        self._drop_cargo()
        unit = g["units"][thief]
        if unit["alive"]:
            cargo["carrier"] = thief
            cargo["last_carrier"] = thief
            cargo["last_carrier_tick"] = g["tick"]
            g["stats"][thief]["steals"] += 1
            fx.append(self.fx("steal", pid=self._pid(thief),
                              pid2=self._pid(victim),
                              x=round(cargo["x"], 1), y=round(cargo["y"], 1)))
        else:
            cargo["grab_cd"] = g["tick"] + CARGO_GRAB_CD_TICKS

    def _cargo_contacts(self, fx):
        """Automatic pickup on touch, and delivery when the crate hits a chute."""
        g = self.g
        cargo = g["cargo"]
        if cargo is None:
            return
        tick = g["tick"]
        if cargo["carrier"] is None and tick >= cargo["grab_cd"]:
            for token in g["order"]:
                unit = g["units"][token]
                if not unit["alive"]:
                    continue
                if math.hypot(cargo["x"] - unit["x"], cargo["y"] - unit["y"]) \
                        <= UNIT_R + CARGO_R:
                    cargo["carrier"] = token
                    cargo["last_carrier"] = token
                    cargo["last_carrier_tick"] = tick
                    cargo["hang"] = None        # chain cut — it's loose now
                    fx.append(self.fx("pickup", pid=self._pid(token),
                                      x=round(cargo["x"], 1),
                                      y=round(cargo["y"], 1)))
                    break

        # The crate's body counts, not just its centre point — the mouth is
        # padded by the crate radius so a graze down the edge still drops in.
        chute = g["chute"]
        if segment_hits_rect(cargo.get("px", cargo["x"]), cargo.get("py", cargo["y"]),
                             cargo["x"], cargo["y"],
                             chute["x"] - CARGO_R, chute["y"] - CARGO_R,
                             chute["w"] + CARGO_R * 2, chute["h"] + CARGO_R * 2):
            owner = cargo["carrier"]
            if owner is None and cargo["last_carrier"] is not None and \
                    tick - cargo["last_carrier_tick"] <= THROW_CREDIT_TICKS:
                owner = cargo["last_carrier"]   # a clean lob still counts
            if owner is not None and owner in g["stats"]:
                points = DELIVER_POINTS * (2 if g["overload"] else 1)
                stat = g["stats"][owner]
                stat["score"] += points
                stat["deliveries"] += 1
                fx.append(self.fx("delivery", pid=self._pid(owner),
                                  x=round(cargo["x"], 1), y=round(cargo["y"], 1),
                                  points=points, over=bool(g["overload"])))
                self._respawn_cargo()

    def _explode_cargo(self, cause, fx):
        """Blow the crate: everyone nearby gets shoved, then it respawns."""
        g = self.g
        cargo = g["cargo"]
        if cargo is None:
            return
        bx, by = cargo["x"], cargo["y"]
        self._drop_cargo(keep_credit=False)
        for token in g["order"]:
            unit = g["units"][token]
            if not unit["alive"]:
                continue
            dx, dy = unit["x"] - bx, unit["y"] - by
            dist = math.hypot(dx, dy)
            if dist >= BOOM_RADIUS:
                continue
            if dist < 1e-6:
                dx, dy, dist = 0.0, -1.0, 1.0
            falloff = 1.0 - dist / BOOM_RADIUS
            unit["vx"] += (dx / dist) * BOOM_IMPULSE * falloff
            unit["vy"] += (dy / dist) * BOOM_IMPULSE * falloff
            self._bound_unit(unit)
        fx.append(self.fx("cargo_boom", x=round(bx, 1), y=round(by, 1),
                          what=cause, r=round(BOOM_RADIUS, 1)))
        self._respawn_cargo()

    def _hazard(self, fx):
        """The melt takes anything that touches it — units and crates alike."""
        g = self.g
        tick = g["tick"]
        for token in g["order"]:
            unit = g["units"][token]
            if not unit["alive"] or unit["y"] < g["hazard_y"]:
                continue
            unit["alive"] = False
            unit["hook"] = None
            unit["tension"] = 0.0
            unit["vx"] = unit["vy"] = 0.0
            unit["hook_buffer"] = 0
            unit["respawn_tick"] = tick + RESPAWN_TICKS
            g["stats"][token]["falls"] += 1
            if g["cargo"] is not None and g["cargo"]["carrier"] == token:
                self._drop_cargo()
            killer = unit["last_hit"]
            credited = (killer is not None and killer != token
                        and killer in g["stats"]
                        and tick - unit["last_hit_tick"] <= WIPE_CREDIT_TICKS)
            if credited:
                g["stats"][killer]["score"] += WIPE_POINTS
                g["stats"][killer]["wipes"] += 1
            fx.append(self.fx("fall", pid=self._pid(token),
                              pid2=self._pid(killer) if credited else None,
                              x=round(unit["x"], 1), y=round(g["hazard_y"], 1),
                              points=WIPE_POINTS if credited else 0))
            unit["last_hit"] = None

        cargo = g["cargo"]
        if cargo is not None and cargo["y"] >= g["hazard_y"]:
            self._explode_cargo("melt", fx)

    # ---------------- bounds ----------------

    def _bound_unit(self, unit):
        """Walls bounce; the floor is the melt. Also the finiteness backstop —
        every physics path funnels through here, so no NaN can ever escape."""
        if not _finite(unit["x"]) or not _finite(unit["y"]):
            unit["x"], unit["y"] = WORLD_W / 2, 120.0
            unit["vx"] = unit["vy"] = 0.0
            unit["hook"] = None
        if not _finite(unit["vx"]) or not _finite(unit["vy"]):
            unit["vx"] = unit["vy"] = 0.0
        if unit["x"] < UNIT_R:
            unit["x"] = UNIT_R
            unit["vx"] = abs(unit["vx"]) * 0.62
        elif unit["x"] > WORLD_W - UNIT_R:
            unit["x"] = WORLD_W - UNIT_R
            unit["vx"] = -abs(unit["vx"]) * 0.62
        if unit["y"] < UNIT_R:
            unit["y"] = UNIT_R
            unit["vy"] = abs(unit["vy"]) * 0.62
        elif unit["y"] > WORLD_H:
            unit["y"] = float(WORLD_H)
        speed = math.hypot(unit["vx"], unit["vy"])
        if speed > MAX_SPEED:
            scale = MAX_SPEED / speed
            unit["vx"] *= scale
            unit["vy"] *= scale

    def _bound_cargo(self, cargo):
        if not _finite(cargo["x"]) or not _finite(cargo["y"]):
            cargo["x"], cargo["y"] = WORLD_W / 2, 120.0
            cargo["vx"] = cargo["vy"] = 0.0
        if not _finite(cargo["vx"]) or not _finite(cargo["vy"]):
            cargo["vx"] = cargo["vy"] = 0.0
        if cargo["x"] < CARGO_R:
            cargo["x"] = CARGO_R
            cargo["vx"] = abs(cargo["vx"]) * 0.55
        elif cargo["x"] > WORLD_W - CARGO_R:
            cargo["x"] = WORLD_W - CARGO_R
            cargo["vx"] = -abs(cargo["vx"]) * 0.55
        if cargo["y"] < CARGO_R:
            cargo["y"] = CARGO_R
            cargo["vy"] = abs(cargo["vy"]) * 0.55
        elif cargo["y"] > WORLD_H:
            cargo["y"] = float(WORLD_H)
        speed = math.hypot(cargo["vx"], cargo["vy"])
        if speed > MAX_SPEED:
            scale = MAX_SPEED / speed
            cargo["vx"] *= scale
            cargo["vy"] *= scale

    # ---------------- shift / match end ----------------

    def _end_shift(self):
        g = self.g
        if g["shift"] >= g["shifts_total"]:
            return self._finish()
        g["overload"] = False
        self.phase = "shift_end"
        self._bump(time.time() + SHIFT_BREAK_SECONDS)
        return [self.fx("shift_end", shift=g["shift"], total=g["shifts_total"],
                        board=self._board())]

    def _board(self):
        return [{"pid": self._pid(token),
                 "score": self.g["stats"][token]["score"]}
                for token in self._ranked()]

    def _ranked(self):
        """Deterministic ordering: score, then work done, then seat order."""
        g = self.g
        index = {token: i for i, token in enumerate(g["order"])}
        return sorted(g["order"], key=lambda t: (
            -g["stats"][t]["score"], -g["stats"][t]["deliveries"],
            -g["stats"][t]["wipes"], -g["stats"][t]["steals"],
            g["stats"][t]["falls"], index[t]))

    def _finish(self):
        g = self.g
        g["overload"] = False
        standings = [{
            "pid": self._pid(token),
            "score": g["stats"][token]["score"],
            "deliveries": g["stats"][token]["deliveries"],
            "steals": g["stats"][token]["steals"],
            "wipes": g["stats"][token]["wipes"],
            "falls": g["stats"][token]["falls"],
            "best_slam": round(g["stats"][token]["best_slam"], 2),
        } for token in self._ranked()]
        g["result"] = {
            "winner": standings[0]["pid"] if standings else None,
            "crew_deliveries": sum(row["deliveries"] for row in standings),
            "standings": standings,
        }
        return self.end_game()

    # ---------------- connection events ----------------

    def game_player_left(self, token):
        """A dropped pad stops steering: chain released, holds neutralized.
        The body keeps swinging (and keeps scoring) — nobody is eliminated."""
        g = self.g
        if g is None or token not in g["units"]:
            return []
        unit = g["units"][token]
        fx = []
        if unit["alive"]:
            self._release(token, unit, fx)
        else:
            unit["hook"] = None
        unit["hook_held"] = False
        unit["reel_held"] = False
        unit["hook_buffer"] = 0
        player = self.players.get(token)
        fx.append(self.fx("toast", icon="🔌",
                          msg="%s dropped — their chain went slack"
                              % (player.name if player else "?")))
        return fx

    def game_player_back(self, token):
        g = self.g
        if g is None or token not in g["units"]:
            return []
        player = self.players.get(token)
        return [self.fx("toast", icon="🦾",
                        msg="%s is back on the rig"
                            % (player.name if player else "?"))]

    # ---------------- serialization ----------------

    def _shift_left(self):
        g = self.g
        return round(max(0, g["shift_end_tick"] - g["tick"]) * TICK, 2)

    def game_state(self, viewer_token):
        """Pure: reads state, never mutates it, never draws from the rng.
        Safe in play, shift_end and the shared game_end."""
        g = self.g
        if g is None:
            return None
        shift_left = self._shift_left()

        if viewer_token is None:
            units = []
            for token in g["order"]:
                unit = g["units"][token]
                player = self.players.get(token)
                point = self._hook_point(unit, g["tick"]) if unit["hook"] else None
                flags = 0
                if unit["alive"]:
                    flags |= 1
                if unit["hook"] is not None:
                    flags |= 2
                if self._carrying(token):
                    flags |= 4
                if unit["super"]:
                    flags |= 8
                if player is not None and not player.connected:
                    flags |= 16
                units.append([
                    self._pid(token), round(unit["x"], 1), round(unit["y"], 1),
                    round(unit["vx"], 1), round(unit["vy"], 1), flags,
                    round(point[0], 1) if point else None,
                    round(point[1], 1) if point else None,
                    round(unit["tension"], 2), g["stats"][token]["score"],
                ])
            cargo = g["cargo"]
            chute = g["chute"]
            return {
                "kind": "smelterskelter", "mode": "tv", "stage": self.phase,
                "tick": g["tick"], "tick_ms": TICK_MS,
                "arena": [WORLD_W, WORLD_H],
                "shift": g["shift"], "shifts_total": g["shifts_total"],
                "shift_left": shift_left, "overload": bool(g["overload"]),
                "hazard_y": round(g["hazard_y"], 1),
                "anchors": [[a["id"]] + [round(v, 1) for v in
                                         anchor_position(a, g["tick"])] + [a["kind"]]
                            for a in g["anchors"]],
                "units": units,
                "cargo": [round(cargo["x"], 1), round(cargo["y"], 1),
                          round(cargo["vx"], 1), round(cargo["vy"], 1),
                          self._pid(cargo["carrier"]) if cargo["carrier"] else None,
                          round(max(0, cargo["fuse_tick"] - g["tick"]) * TICK, 1)]
                         if cargo else None,
                # added field: which anchor an un-grabbed crate dangles from,
                # so the TV can draw its chain. null once the crate is loose.
                "cargo_anchor": cargo["hang"] if cargo else None,
                "chute": [chute["x"], chute["y"], chute["w"], chute["h"]],
                "scores": [{"pid": self._pid(t),
                            "score": g["stats"][t]["score"],
                            "deliveries": g["stats"][t]["deliveries"],
                            "steals": g["stats"][t]["steals"],
                            "wipes": g["stats"][t]["wipes"]}
                           for t in self._ranked()],
                "result": g["result"],
            }

        if viewer_token in g["units"]:
            unit = g["units"][viewer_token]
            ranked = self._ranked()
            return {
                "kind": "smelterskelter", "mode": "pad", "stage": self.phase,
                "tick": g["tick"], "shift": g["shift"],
                "shifts_total": g["shifts_total"], "shift_left": shift_left,
                "overload": bool(g["overload"]),
                "alive": bool(unit["alive"]),
                "hooked": unit["hook"] is not None,
                "tension": round(_clamp(unit["tension"], 0.0, 1.0), 2),
                "carrying": self._carrying(viewer_token),
                "super": bool(unit["super"]),
                "score": g["stats"][viewer_token]["score"],
                "rank": ranked.index(viewer_token) + 1,
                "respawn": (round(max(0, unit["respawn_tick"] - g["tick"]) * TICK, 1)
                            if not unit["alive"] else 0),
                "aim": round(unit["aim"], 1),
                "result": g["result"],
            }

        return {
            "kind": "smelterskelter", "mode": "watch", "stage": self.phase,
            "shift": g["shift"], "shifts_total": g["shifts_total"],
            "shift_left": shift_left, "overload": bool(g["overload"]),
            "result": g["result"],
        }

    def to_lobby(self):
        fx = super().to_lobby()
        self.g = None
        return fx
