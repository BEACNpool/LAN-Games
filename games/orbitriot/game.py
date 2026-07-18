"""ORBIT RIOT — simultaneous cosmic billiards for a TV and 2–8 phones.

Players privately aim a comet on their phone. When everybody locks in (or the
clock runs out), the server simulates one deterministic physics heat: comets
curve around a gravity well, bounce from walls and pinball bumpers, collide
with each other, collect stars, and can be knocked into the black hole. The TV
receives a compact replay; no client is trusted to decide collisions or score.

World coordinates use screen convention: x grows right, y grows down.
"""

from __future__ import annotations

import math
import time

from core.session import GameSession

WORLD_W, WORLD_H = 1200, 675
CX, CY = WORLD_W / 2, WORLD_H / 2
WALL = 34
PUCK_R = 22
STAR_R = 13
HOLE_R = 58
HOLE_PULL_RANGE = 270
SAFE_INNER, SAFE_OUTER = 116, 208
SIM_SECONDS = 7.2
REPLAY_SECONDS = 8.0
DT = 1 / 120
FRAME_EVERY = 6                 # 20 replay frames / second
MAX_SPEED = 1120

HEAT_CHOICES = (3, 5, 7)
AIM_CHOICES = (15, 20, 30)
ABILITY_LOADOUT = {"boost": 2, "anchor": 1, "shield": 1}

BUMPERS = (
    {"x": 458, "y": 218, "r": 36},
    {"x": 742, "y": 218, "r": 36},
    {"x": 458, "y": 457, "r": 36},
    {"x": 742, "y": 457, "r": 36},
)


def _finite_number(value):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(float(value)))


def spawn_points(tokens, heat=1, phase=0.0):
    """Evenly distribute players around the launch ring.

    The heat rotation prevents the same player owning the same map lane all
    night. Return token-keyed positions; tokens never leave the server.
    """
    count = max(1, len(tokens))
    radius = 286
    rotate = phase + (heat - 1) * 0.47
    return {
        token: {
            "x": round(CX + math.cos(rotate + math.tau * i / count) * radius, 2),
            "y": round(CY + math.sin(rotate + math.tau * i / count) * radius, 2),
        }
        for i, token in enumerate(tokens)
    }


def _dist(a, b):
    return math.hypot(a["x"] - b["x"], a["y"] - b["y"])


def generate_stars(rng, count, spawns):
    """Generate balanced collectible positions away from solid geometry."""
    stars = []
    attempts = 0
    while len(stars) < count and attempts < 800:
        attempts += 1
        angle = rng.uniform(0, math.tau)
        radius = rng.uniform(92, 318)
        candidate = {
            "id": len(stars),
            "x": round(CX + math.cos(angle) * radius, 2),
            "y": round(CY + math.sin(angle) * radius, 2),
        }
        if math.hypot(candidate["x"] - CX, candidate["y"] - CY) < HOLE_R + 40:
            continue
        if any(_dist(candidate, b) < b["r"] + STAR_R + 20 for b in BUMPERS):
            continue
        if any(_dist(candidate, p) < PUCK_R + STAR_R + 28 for p in spawns.values()):
            continue
        if any(_dist(candidate, s) < STAR_R * 2 + 28 for s in stars):
            continue
        stars.append(candidate)
    return stars


def _frame(bodies, active_stars, order, elapsed):
    mask = 0
    for sid in active_stars:
        mask |= 1 << sid
    return {
        "t": round(elapsed * 1000),
        "p": [[round(bodies[t]["x"], 1), round(bodies[t]["y"], 1),
               bool(bodies[t]["alive"])] for t in order],
        "s": mask,
    }


def _event(events, elapsed, kind, **payload):
    events.append({"t": round(elapsed * 1000), "what": kind, **payload})


def simulate_heat(order, spawns, shots, stars):
    """Run one authoritative simultaneous-launch physics simulation.

    Inputs and outputs are plain data, making this function deterministic and
    directly fuzzable. `shots` must already be sanitized by the session.
    """
    bodies = {}
    for token in order:
        shot = shots[token]
        ability = shot.get("ability", "none")
        speed = 390 + 500 * shot["power"]
        if ability == "boost":
            speed *= 1.22
        angle = math.radians(shot["angle"])
        bodies[token] = {
            "x": float(spawns[token]["x"]),
            "y": float(spawns[token]["y"]),
            "vx": math.cos(angle) * speed,
            "vy": math.sin(angle) * speed,
            "mass": 2.35 if ability == "anchor" else 1.0,
            "ability": ability,
            "shield": ability == "shield",
            "alive": True,
            "last_hit": None,
            "last_hit_at": -99.0,
        }

    active_stars = {int(s["id"]) for s in stars}
    star_by_id = {int(s["id"]): s for s in stars}
    deltas = {token: 0 for token in order}
    events = []
    frames = [_frame(bodies, active_stars, order, 0)]
    pair_last_event = {}
    steps = int(SIM_SECONDS / DT)

    for step in range(1, steps + 1):
        elapsed = step * DT

        # Curved gravity gives bank shots character without letting the well
        # dominate the whole arena. A small tangential current creates orbits.
        for token in order:
            body = bodies[token]
            if not body["alive"]:
                continue
            dx, dy = CX - body["x"], CY - body["y"]
            dist = max(1.0, math.hypot(dx, dy))
            if dist < HOLE_PULL_RANGE:
                closeness = 1 - dist / HOLE_PULL_RANGE
                pull = 105 + 980 * closeness * closeness
                swirl = 72 * closeness
                nx, ny = dx / dist, dy / dist
                body["vx"] += (nx * pull - ny * swirl) * DT
                body["vy"] += (ny * pull + nx * swirl) * DT

            body["vx"] *= 0.9972
            body["vy"] *= 0.9972
            speed = math.hypot(body["vx"], body["vy"])
            if speed > MAX_SPEED:
                body["vx"] *= MAX_SPEED / speed
                body["vy"] *= MAX_SPEED / speed
            body["x"] += body["vx"] * DT
            body["y"] += body["vy"] * DT

            # Arena walls absorb a little energy but stay satisfyingly bouncy.
            if body["x"] < WALL + PUCK_R:
                body["x"] = WALL + PUCK_R
                body["vx"] = abs(body["vx"]) * 0.86
            elif body["x"] > WORLD_W - WALL - PUCK_R:
                body["x"] = WORLD_W - WALL - PUCK_R
                body["vx"] = -abs(body["vx"]) * 0.86
            if body["y"] < WALL + PUCK_R:
                body["y"] = WALL + PUCK_R
                body["vy"] = abs(body["vy"]) * 0.86
            elif body["y"] > WORLD_H - WALL - PUCK_R:
                body["y"] = WORLD_H - WALL - PUCK_R
                body["vy"] = -abs(body["vy"]) * 0.86

            # Fixed pinball bumpers add energy and announce strong contacts.
            for bi, bumper in enumerate(BUMPERS):
                dx = body["x"] - bumper["x"]
                dy = body["y"] - bumper["y"]
                dist = math.hypot(dx, dy)
                reach = PUCK_R + bumper["r"]
                if dist >= reach:
                    continue
                if dist < 0.001:
                    dx, dy, dist = 1.0, 0.0, 1.0
                nx, ny = dx / dist, dy / dist
                body["x"] += nx * (reach - dist + 0.1)
                body["y"] += ny * (reach - dist + 0.1)
                toward = body["vx"] * nx + body["vy"] * ny
                if toward < 0:
                    kick = -(1.94 * toward) + 78
                    body["vx"] += nx * kick
                    body["vy"] += ny * kick
                    key = (token, bi)
                    if elapsed - pair_last_event.get(key, -9) > 0.16:
                        pair_last_event[key] = elapsed
                        _event(events, elapsed, "bumper", token=token, x=bumper["x"],
                               y=bumper["y"], power=min(1, abs(toward) / 620))

        # Equal-circle impulses. Anchor is deliberately heavy: it changes the
        # mass equation rather than faking a damage bonus.
        for ai, a_token in enumerate(order):
            a = bodies[a_token]
            if not a["alive"]:
                continue
            for b_token in order[ai + 1:]:
                b = bodies[b_token]
                if not b["alive"]:
                    continue
                dx, dy = b["x"] - a["x"], b["y"] - a["y"]
                dist = math.hypot(dx, dy)
                reach = PUCK_R * 2
                if dist >= reach:
                    continue
                if dist < 0.001:
                    dx, dy, dist = 1.0, 0.0, 1.0
                nx, ny = dx / dist, dy / dist
                inv_a, inv_b = 1 / a["mass"], 1 / b["mass"]
                correction = (reach - dist + 0.1) / (inv_a + inv_b)
                a["x"] -= nx * correction * inv_a
                a["y"] -= ny * correction * inv_a
                b["x"] += nx * correction * inv_b
                b["y"] += ny * correction * inv_b
                rel = (b["vx"] - a["vx"]) * nx + (b["vy"] - a["vy"]) * ny
                if rel >= 0:
                    continue
                impulse = -(1.91 * rel) / (inv_a + inv_b)
                a["vx"] -= impulse * nx * inv_a
                a["vy"] -= impulse * ny * inv_a
                b["vx"] += impulse * nx * inv_b
                b["vy"] += impulse * ny * inv_b
                if impulse > 105:
                    a["last_hit"], a["last_hit_at"] = b_token, elapsed
                    b["last_hit"], b["last_hit_at"] = a_token, elapsed
                pair = tuple(sorted((a_token, b_token)))
                if impulse > 170 and elapsed - pair_last_event.get(pair, -9) > 0.2:
                    pair_last_event[pair] = elapsed
                    _event(events, elapsed, "crash", a=a_token, b=b_token,
                           x=(a["x"] + b["x"]) / 2,
                           y=(a["y"] + b["y"]) / 2,
                           power=min(1, impulse / 850))

        # Collectibles and black-hole outcomes resolve after collisions.
        for token in order:
            body = bodies[token]
            if not body["alive"]:
                continue
            for sid in list(active_stars):
                star = star_by_id[sid]
                if math.hypot(body["x"] - star["x"], body["y"] - star["y"]) \
                        <= PUCK_R + STAR_R:
                    active_stars.remove(sid)
                    deltas[token] += 1
                    _event(events, elapsed, "star", token=token, sid=sid,
                           x=star["x"], y=star["y"], points=1)

            dx, dy = body["x"] - CX, body["y"] - CY
            dist = math.hypot(dx, dy)
            if dist >= HOLE_R:
                continue
            if body["shield"]:
                body["shield"] = False
                if dist < 0.001:
                    dx, dy, dist = 1.0, 0.0, 1.0
                nx, ny = dx / dist, dy / dist
                body["x"], body["y"] = CX + nx * 102, CY + ny * 102
                body["vx"] = nx * 505 - ny * 150
                body["vy"] = ny * 505 + nx * 150
                _event(events, elapsed, "shield", token=token,
                       x=body["x"], y=body["y"])
                continue
            body["alive"] = False
            body["vx"] = body["vy"] = 0.0
            attacker = body["last_hit"]
            credited = (attacker in bodies and attacker != token
                        and elapsed - body["last_hit_at"] <= 2.6)
            if credited:
                deltas[attacker] += 3
            _event(events, elapsed, "knockout", token=token,
                   by=attacker if credited else None, x=CX, y=CY,
                   points=3 if credited else 0)

        if step % FRAME_EVERY == 0:
            frames.append(_frame(bodies, active_stars, order, elapsed))

    # Curling-style finish: resting in the luminous inner orbit is worth two.
    for token in order:
        body = bodies[token]
        if not body["alive"]:
            continue
        radius = math.hypot(body["x"] - CX, body["y"] - CY)
        if SAFE_INNER <= radius <= SAFE_OUTER:
            deltas[token] += 2
            _event(events, SIM_SECONDS, "orbit", token=token,
                   x=body["x"], y=body["y"], points=2)

    # Ensure the last scored frame contains the authoritative final positions.
    if not frames or frames[-1]["t"] < round(SIM_SECONDS * 1000):
        frames.append(_frame(bodies, active_stars, order, SIM_SECONDS))
    final = {
        token: {"x": round(bodies[token]["x"], 1),
                "y": round(bodies[token]["y"], 1),
                "alive": bool(bodies[token]["alive"])}
        for token in order
    }
    return {"frames": frames, "events": events, "deltas": deltas,
            "final": final, "stars_left": sorted(active_stars)}


class OrbitRiotSession(GameSession):
    MIN_PLAYERS = 2
    MAX_HUMANS = 8
    DEFAULT_SETTINGS = {"heats": 5, "aim_seconds": 20}

    def __init__(self, rng=None):
        super().__init__(rng)
        self.g = None

    def validate_settings(self, patch):
        out = {}
        heats = patch.get("heats")
        if isinstance(heats, int) and not isinstance(heats, bool) and heats in HEAT_CHOICES:
            out["heats"] = heats
        aim = patch.get("aim_seconds")
        if isinstance(aim, int) and not isinstance(aim, bool) and aim in AIM_CHOICES:
            out["aim_seconds"] = aim
        return out

    def game_start(self):
        order = list(self.participants)
        self.rng.shuffle(order)
        self.g = {
            "order": order,
            "heat": 0,
            "scores": {token: 0 for token in order},
            "abilities": {token: dict(ABILITY_LOADOUT) for token in order},
            "phase_offset": self.rng.uniform(0, math.tau),
            "spawns": {},
            "stars": [],
            "aims": {},
            "locked": set(),
            "heat_delta": {token: 0 for token in order},
            "replay": None,
            "result": None,
        }
        return self._start_heat()

    def _start_heat(self):
        g = self.g
        g["heat"] += 1
        g["spawns"] = spawn_points(g["order"], g["heat"], g["phase_offset"])
        g["stars"] = generate_stars(
            self.rng, max(6, len(g["order"]) + 2), g["spawns"])
        g["aims"] = {}
        g["locked"] = set()
        g["heat_delta"] = {token: 0 for token in g["order"]}
        g["replay"] = None
        self.phase = "aiming"
        self._bump(time.time() + int(self.settings["aim_seconds"]))
        return [self.fx("heat", n=g["heat"], total=int(self.settings["heats"]))]

    def _validate_shot(self, msg):
        angle, power = msg.get("angle"), msg.get("power")
        ability = msg.get("ability", "none")
        if not _finite_number(angle) or not _finite_number(power):
            return None
        if not isinstance(ability, str) or ability not in (*ABILITY_LOADOUT, "none"):
            return None
        return {
            "angle": round(float(angle) % 360, 2),
            "power": round(max(0.25, min(1.0, float(power))), 3),
            "ability": ability,
        }

    def game_action(self, token, msg):
        if self.g is None or token not in self.g["order"]:
            return [self.fx("invalid", to=token, msg="You're watching this heat")]
        if msg.get("t") != "lock" or self.phase != "aiming":
            return [self.fx("invalid", to=token, msg="Wait for the aiming clock")]
        if token in self.g["locked"]:
            return []
        shot = self._validate_shot(msg)
        if shot is None:
            return [self.fx("invalid", to=token, msg="Set a real direction and power")]
        ability = shot["ability"]
        if ability != "none" and self.g["abilities"][token].get(ability, 0) <= 0:
            return [self.fx("invalid", to=token, msg="That power-up is spent")]

        self.seq += 1
        if ability != "none":
            self.g["abilities"][token][ability] -= 1
        self.g["aims"][token] = shot
        self.g["locked"].add(token)
        fx = [self.fx("locked", pid=self.players[token].pid)]
        if all(t in self.g["locked"] for t in self.g["order"]):
            fx.extend(self._launch())
        return fx

    def _auto_lock(self, token):
        spawn = self.g["spawns"][token]
        target = min(self.g["stars"], key=lambda s: _dist(spawn, s), default={"x": CX, "y": CY})
        angle = math.degrees(math.atan2(target["y"] - spawn["y"],
                                        target["x"] - spawn["x"]))
        # A small seeded deflection stops every timed-out comet tracing the
        # mathematically same lane while remaining purposeful.
        angle += self.rng.uniform(-8, 8)
        self.g["aims"][token] = {
            "angle": round(angle % 360, 2), "power": 0.68, "ability": "none",
        }
        self.g["locked"].add(token)

    def _launch(self):
        g = self.g
        for token in g["order"]:
            if token not in g["locked"]:
                self._auto_lock(token)
        replay = simulate_heat(g["order"], g["spawns"], g["aims"], g["stars"])
        g["heat_delta"] = dict(replay["deltas"])
        for token, points in replay["deltas"].items():
            g["scores"][token] += points
        replay["started_ms"] = round(time.time() * 1000)
        replay["duration_ms"] = round(REPLAY_SECONDS * 1000)
        replay["shots"] = dict(g["aims"])
        g["replay"] = replay
        self.phase = "replay"
        self._bump(time.time() + REPLAY_SECONDS)
        return [self.fx("launch", heat=g["heat"])]

    def _finish(self):
        ranked = sorted(self.g["order"],
                        key=lambda token: (-self.g["scores"][token],
                                           self.players[token].joined_at))
        result = []
        previous = None
        rank = 0
        for index, token in enumerate(ranked):
            score = self.g["scores"][token]
            if score != previous:
                rank = index + 1
                previous = score
            result.append({"pid": self.players[token].pid, "score": score, "rank": rank})
        self.g["result"] = result
        return self.end_game()

    def game_tick(self):
        if self.g is None:
            return []
        if self.phase == "aiming":
            for token in self.g["order"]:
                if token not in self.g["locked"]:
                    self._auto_lock(token)
            return [self.fx("toast", icon="⏱", msg="Trajectory clock expired")] + self._launch()
        if self.phase == "replay":
            if self.g["heat"] >= int(self.settings["heats"]):
                return self._finish()
            return self._start_heat()
        return []

    def game_player_left(self, token):
        if self.g and self.phase == "aiming" and token in self.g["order"] \
                and token not in self.g["locked"]:
            self._auto_lock(token)
            fx = [self.fx("toast", icon="📡",
                          msg="%s disconnected — autopilot locked" % self.players[token].name)]
            if all(t in self.g["locked"] for t in self.g["order"]):
                fx.extend(self._launch())
            return fx
        return []

    def _public_replay(self):
        replay = self.g.get("replay")
        if replay is None:
            return None
        pid = {token: self.players[token].pid for token in self.g["order"]}
        events = []
        for raw in replay["events"]:
            event = {k: v for k, v in raw.items()
                     if k not in ("token", "a", "b", "by")}
            for key in ("token", "a", "b", "by"):
                if key in raw:
                    event[key] = pid.get(raw[key]) if raw[key] is not None else None
            events.append(event)
        return {
            "started_ms": replay["started_ms"],
            "duration_ms": replay["duration_ms"],
            "sim_ms": round(SIM_SECONDS * 1000),
            "order": [pid[t] for t in self.g["order"]],
            "frames": replay["frames"],
            "events": events,
            "shots": [{"pid": pid[t], "ability": replay["shots"][t]["ability"]}
                      for t in self.g["order"]],
        }

    def game_state(self, viewer_token):
        g = self.g
        if g is None:
            return None
        pid = {token: self.players[token].pid for token in g["order"]}
        roster = [{
            "pid": pid[token],
            "score": g["scores"][token],
            "delta": g["heat_delta"][token],
            "locked": token in g["locked"],
        } for token in g["order"]]
        pucks = [{"pid": pid[token], **g["spawns"][token]} for token in g["order"]]
        my_aim = g["aims"].get(viewer_token)
        return {
            "kind": "orbitriot",
            "stage": self.phase,
            "world": [WORLD_W, WORLD_H],
            "heat": g["heat"],
            "heats": int(self.settings["heats"]),
            "hole": {"x": CX, "y": CY, "r": HOLE_R,
                     "safe_inner": SAFE_INNER, "safe_outer": SAFE_OUTER},
            "bumpers": [dict(item) for item in BUMPERS],
            "stars": [dict(item) for item in g["stars"]],
            "pucks": pucks,
            "roster": roster,
            "my_locked": viewer_token in g["locked"],
            "my_aim": dict(my_aim) if my_aim else None,
            "my_abilities": (dict(g["abilities"][viewer_token])
                             if viewer_token in g["abilities"] else None),
            "replay": self._public_replay(),
            "result": g["result"],
        }

    def to_lobby(self):
        fx = super().to_lobby()
        self.g = None
        return fx
