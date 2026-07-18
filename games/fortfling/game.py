"""FORT FLING — an original two-player, turn-based slingshot battle.

Each player owns a fort, a destructible shield wall, 100 health, and the
same finite weapon belt. A turn is one server-authoritative pull-and-release
shot. The client sends only weapon, angle, and power; this module calculates
every trajectory, bounce, collision, and point of damage.

World coordinates use y=0 at the bottom. The client flips y while drawing.
"""

from __future__ import annotations

import math
import time

from core.session import GameSession

W, H = 1000, 560
DT = 0.025
GRAVITY = 260.0
TURN_SECONDS = 40
RESOLVE_SECONDS = 2.2
FORT_HP = 100
COVER_HP = 60
MAX_SHOTS = 26

WEAPONS = {
    "boulder": {
        "name": "BOULDER", "icon": "🪨", "ammo": 6,
        "damage": 24, "radius": 48, "speed": 1.0, "gravity": 1.0,
        "desc": "Reliable direct damage",
    },
    "bomb": {
        "name": "BOOM BOMB", "icon": "💣", "ammo": 2,
        "damage": 38, "radius": 105, "speed": 0.94, "gravity": 1.05,
        "desc": "Wide splash behind cover",
    },
    "cluster": {
        "name": "TRIPLE POP", "icon": "🎆", "ammo": 2,
        "damage": 15, "radius": 46, "speed": 1.0, "gravity": 1.0,
        "spread": (-7.0, 0.0, 7.0),
        "desc": "Three-way spread shot",
    },
    "rocket": {
        "name": "RUSH ROCKET", "icon": "🚀", "ammo": 1,
        "damage": 46, "radius": 66, "speed": 1.16, "gravity": 0.58,
        "desc": "Fast, flat, and heavy",
    },
    "ricochet": {
        "name": "BOUNCE BALL", "icon": "🔴", "ammo": 2,
        "damage": 29, "radius": 58, "speed": 1.03, "gravity": 0.92,
        "bounces": 1,
        "desc": "Skips once off the ground",
    },
}


def gen_terrain(rng):
    """Generate low rolling terrain, flattened beneath both forts/slings."""
    phase = rng.uniform(0, math.tau)
    heights = []
    for x in range(W):
        y = 72 + 12 * math.sin(x / 83 + phase) + 7 * math.sin(x / 31 - phase)
        # A small central mound makes low-power skips tactically interesting.
        y += 34 * math.exp(-((x - 500) / 135) ** 2)
        heights.append(int(max(48, min(132, y))))
    for center, radius in ((92, 72), (205, 46), (795, 46), (908, 72)):
        level = heights[center]
        for x in range(max(0, center - radius), min(W, center + radius + 1)):
            blend = min(1.0, abs(x - center) / max(1, radius - 8))
            heights[x] = int(level * (1 - blend) + heights[x] * blend)
    return heights


def fort_layout(terrain):
    """Return stable left/right structure geometry for a terrain."""
    return {
        "left": {
            "side": "left", "x": 92, "y": terrain[92],
            "sling_x": 220, "sling_y": terrain[220] + 74,
            "cover_x": 160, "cover_y": terrain[160],
            "hp": FORT_HP, "cover": COVER_HP, "dealt": 0,
        },
        "right": {
            "side": "right", "x": 908, "y": terrain[908],
            "sling_x": 780, "sling_y": terrain[780] + 74,
            "cover_x": 840, "cover_y": terrain[840],
            "hp": FORT_HP, "cover": COVER_HP, "dealt": 0,
        },
    }


def _point_rect_distance(x, y, cx, bottom, width=42, height=112):
    nx = max(cx - width / 2, min(x, cx + width / 2))
    ny = max(bottom, min(y, bottom + height))
    return math.hypot(x - nx, y - ny)


def simulate_path(terrain, forts, shooter_side, angle, power, wind,
                  weapon_key="boulder", angle_offset=0.0):
    """Simulate one projectile and return sampled points plus its impact.

    Collision checks include living fort avatars, standing cover, and ground.
    Ricochet gets one terrain bounce. Structure collisions always stop it.
    """
    spec = WEAPONS[weapon_key]
    shooter = forts[shooter_side]
    direction = 1 if shooter_side == "left" else -1
    a = math.radians(max(10.0, min(82.0, angle + angle_offset)))
    speed = (270.0 + 330.0 * power) * spec.get("speed", 1.0)
    x, y = float(shooter["sling_x"]), float(shooter["sling_y"])
    vx = math.cos(a) * speed * direction
    vy = math.sin(a) * speed
    gravity = GRAVITY * spec.get("gravity", 1.0)
    bounces = spec.get("bounces", 0)
    points = [[round(x, 1), round(y, 1)]]
    impact = None
    hit = None

    for step in range(1800):
        vx += wind * 0.78 * DT
        vy -= gravity * DT
        x += vx * DT
        y += vy * DT
        if step % 2 == 0:
            points.append([round(x, 1), round(y, 1)])
        if x < -70 or x > W + 70 or y < -80 or y > H + 220:
            break

        # Structure hits. Ignore the firing side for the first few frames so
        # a projectile cannot collide with its own launch avatar.
        for side, fort in forts.items():
            if side == shooter_side and step < 12:
                continue
            if fort["cover"] > 0 and _point_rect_distance(
                    x, y, fort["cover_x"], fort["cover_y"]) <= 7:
                impact, hit = [x, y], {"kind": "cover", "side": side}
                break
            if fort["hp"] > 0 and math.hypot(
                    x - fort["x"], y - (fort["y"] + 34)) <= 31:
                impact, hit = [x, y], {"kind": "fort", "side": side}
                break
        if impact is not None:
            break

        xi = int(x)
        if 0 <= xi < W and y <= terrain[xi] + 2:
            if bounces and abs(vy) > 65:
                y = terrain[xi] + 5
                vy = abs(vy) * 0.62
                vx *= 0.78
                bounces -= 1
                points.append([round(x, 1), round(y, 1)])
                continue
            impact, hit = [x, terrain[xi] + 1], {"kind": "ground", "side": None}
            break

    return {
        "points": points[:360],
        "impact": [round(impact[0], 1), round(impact[1], 1)] if impact else None,
        "hit": hit,
    }


def simulate_weapon(terrain, forts, shooter_side, angle, power, wind, weapon_key):
    spec = WEAPONS[weapon_key]
    spread = spec.get("spread", (0.0,))
    return [simulate_path(terrain, forts, shooter_side, angle, power, wind,
                          weapon_key, offset) for offset in spread]


def apply_impacts(forts, shooter_side, weapon_key, paths):
    """Apply splash/direct damage and return public damage events."""
    spec = WEAPONS[weapon_key]
    events = []
    totals = {"left": {"fort": 0, "cover": 0},
              "right": {"fort": 0, "cover": 0}}
    for path in paths:
        if path["impact"] is None:
            continue
        ix, iy = path["impact"]
        direct = path["hit"] or {}
        for side, fort in forts.items():
            target_dist = math.hypot(ix - fort["x"], iy - (fort["y"] + 34))
            if direct.get("kind") == "fort" and direct.get("side") == side:
                target_dist = 0.0
            if fort["hp"] > 0 and target_dist < spec["radius"]:
                damage = max(1, round(spec["damage"] * (1 - target_dist / spec["radius"])))
                if direct.get("kind") == "fort" and direct.get("side") == side:
                    damage += 5
                totals[side]["fort"] += damage

            cover_dist = _point_rect_distance(
                ix, iy, fort["cover_x"], fort["cover_y"])
            if direct.get("kind") == "cover" and direct.get("side") == side:
                cover_dist = 0.0
            if fort["cover"] > 0 and cover_dist < spec["radius"]:
                damage = max(1, round(spec["damage"] * 1.12
                                      * (1 - cover_dist / spec["radius"])))
                if direct.get("kind") == "cover" and direct.get("side") == side:
                    damage += 4
                totals[side]["cover"] += damage

    for side, amounts in totals.items():
        fort = forts[side]
        if amounts["cover"]:
            dealt = min(fort["cover"], amounts["cover"])
            fort["cover"] = max(0, fort["cover"] - amounts["cover"])
            events.append({"side": side, "part": "cover", "damage": dealt})
            if side != shooter_side:
                forts[shooter_side]["dealt"] += dealt
        if amounts["fort"]:
            dealt = min(fort["hp"], amounts["fort"])
            fort["hp"] = max(0, fort["hp"] - amounts["fort"])
            events.append({"side": side, "part": "fort", "damage": dealt})
            if side != shooter_side:
                forts[shooter_side]["dealt"] += dealt
    return events


class FortFlingSession(GameSession):
    MIN_PLAYERS = 2
    MAX_HUMANS = 2
    DEFAULT_SETTINGS = {"turn_seconds": TURN_SECONDS}

    def __init__(self, rng=None):
        super().__init__(rng)
        self.g = None

    def validate_settings(self, patch):
        seconds = patch.get("turn_seconds")
        if isinstance(seconds, int) and not isinstance(seconds, bool) \
                and seconds in (30, 40, 60):
            return {"turn_seconds": seconds}
        return {}

    def game_start(self):
        order = list(self.participants[:2])
        terrain = gen_terrain(self.rng)
        forts = fort_layout(terrain)
        sides = {order[0]: "left", order[1]: "right"}
        turn = self.rng.choice(order)
        self.g = {
            "order": order,
            "sides": sides,
            "forts": forts,
            "terrain": terrain,
            "turn": turn,
            "wind": self.rng.randint(-18, 18),
            "inventory": {token: {key: spec["ammo"] for key, spec in WEAPONS.items()}
                          for token in order},
            "shots": 0,
            "last_weapon": None,
            "result": None,
        }
        self.phase = "battle"
        self._arm_turn()
        return [self.fx("battle_start", pid=self.players[turn].pid)]

    def _arm_turn(self):
        self._bump(time.time() + self.settings["turn_seconds"])

    def _side_token(self, side):
        return next((token for token, value in self.g["sides"].items() if value == side), None)

    def _other(self, token):
        return self.g["order"][1] if self.g["order"][0] == token else self.g["order"][0]

    def _remaining(self, token):
        return sum(self.g["inventory"][token].values())

    def game_action(self, token, msg):
        self.seq += 1
        if self.g is None or self.phase != "battle":
            return [self.fx("invalid", to=token, msg="Wait for the next sling")]
        if token != self.g["turn"]:
            return [self.fx("invalid", to=token, msg="Your rival is aiming")]
        if msg.get("t") != "fire":
            return [self.fx("invalid", to=token, msg="Pull back and release to fire")]
        return self._fire(token, msg.get("weapon"), msg.get("angle"), msg.get("power"))

    def _fire(self, token, weapon, angle, power):
        if weapon not in WEAPONS:
            return [self.fx("invalid", to=token, msg="Pick a real weapon")]
        if self.g["inventory"][token].get(weapon, 0) <= 0:
            return [self.fx("invalid", to=token, msg="That slot is empty")]
        if not isinstance(angle, (int, float)) or isinstance(angle, bool) \
                or not isinstance(power, (int, float)) or isinstance(power, bool):
            return [self.fx("invalid", to=token, msg="Bad sling pull")]
        angle = round(max(10.0, min(82.0, float(angle))), 1)
        power = round(max(0.2, min(1.0, float(power))), 3)
        g = self.g
        side = g["sides"][token]
        paths = simulate_weapon(g["terrain"], g["forts"], side,
                                angle, power, g["wind"], weapon)
        g["inventory"][token][weapon] -= 1
        g["shots"] += 1
        g["last_weapon"] = weapon
        damages = apply_impacts(g["forts"], side, weapon, paths)
        opponent = self._other(token)
        opponent_side = g["sides"][opponent]
        fx = [self.fx(
            "flung", pid=self.players[token].pid, side=side, weapon=weapon,
            icon=WEAPONS[weapon]["icon"], angle=angle, power=power,
            wind=g["wind"], paths=paths, damages=damages,
        )]

        if g["forts"][opponent_side]["hp"] <= 0:
            fx.extend(self._finish(token, "fort smashed"))
            return fx
        if g["shots"] >= MAX_SHOTS or all(self._remaining(t) == 0 for t in g["order"]):
            fx.extend(self._finish_by_score("out of ammo"))
            return fx

        self.phase = "resolve"
        self._bump(time.time() + RESOLVE_SECONDS)
        return fx

    def _finish(self, winner_token, why):
        g = self.g
        winner = self.players[winner_token] if winner_token else None
        g["result"] = {
            "winner": winner.pid if winner else None,
            "why": why,
            "shots": g["shots"],
            "standings": [self._standing(token) for token in g["order"]],
        }
        return self.end_game()

    def _finish_by_score(self, why):
        def score(token):
            fort = self.g["forts"][self.g["sides"][token]]
            return fort["hp"], fort["cover"], fort["dealt"]
        a, b = self.g["order"]
        sa, sb = score(a), score(b)
        winner = a if sa > sb else b if sb > sa else None
        return self._finish(winner, why)

    def _standing(self, token):
        side = self.g["sides"][token]
        fort = self.g["forts"][side]
        return {
            "pid": self.players[token].pid, "side": side,
            "hp": fort["hp"], "cover": fort["cover"], "dealt": fort["dealt"],
            "ammo": self._remaining(token),
        }

    def _advance(self):
        g = self.g
        g["turn"] = self._other(g["turn"])
        g["wind"] = self.rng.randint(-18, 18)
        self.phase = "battle"
        self._arm_turn()
        return [self.fx("turn", pid=self.players[g["turn"]].pid)]

    def _timeout_shot(self, token):
        inventory = self.g["inventory"][token]
        weapon = next((key for key in WEAPONS if inventory[key] > 0), None)
        if weapon is None:
            return self._finish_by_score("out of ammo")
        # On flat ground this reaches the opposing fort. Wind correction is
        # intentionally modest: a timeout shot should play, not play perfectly.
        angle = 45.0
        power = max(0.2, min(1.0, 0.40 - self.g["wind"] * 0.0025
                             * (1 if self.g["sides"][token] == "left" else -1)))
        return self._fire(token, weapon, angle, power)

    def game_tick(self):
        if self.g is None:
            return []
        if self.phase == "resolve":
            return self._advance()
        if self.phase == "battle":
            token = self.g["turn"]
            player = self.players.get(token)
            fx = [self.fx("toast", icon="⏱", msg="%s ran out of aim time" % player.name)]
            fx.extend(self._timeout_shot(token))
            return fx
        return []

    def game_player_left(self, token):
        if self.g and self.phase == "battle" and self.g["turn"] == token:
            self._bump(time.time() + 3.0)
            return [self.fx("toast", icon="📡", msg="Connection lost — auto-fling in 3s")]
        return []

    def game_state(self, viewer_token):
        g = self.g
        if g is None:
            return None
        turn_player = self.players.get(g["turn"])
        forts = []
        for side in ("left", "right"):
            token = self._side_token(side)
            fort = g["forts"][side]
            forts.append({
                "side": side, "pid": self.players[token].pid,
                "x": fort["x"], "y": fort["y"],
                "sling_x": fort["sling_x"], "sling_y": fort["sling_y"],
                "cover_x": fort["cover_x"], "cover_y": fort["cover_y"],
                "hp": fort["hp"], "cover": fort["cover"], "dealt": fort["dealt"],
                "inventory": dict(g["inventory"][token]),
            })
        your_side = g["sides"].get(viewer_token)
        return {
            "kind": "fortfling", "stage": self.phase,
            "world": [W, H], "terrain": list(g["terrain"]),
            "forts": forts, "turn": turn_player.pid if turn_player else None,
            "your_side": your_side,
            "your_turn": viewer_token == g["turn"] and self.phase == "battle",
            "wind": g["wind"], "shots": g["shots"],
            "weapons": {key: {field: value for field, value in spec.items()
                                if field in ("name", "icon", "desc")}
                        for key, spec in WEAPONS.items()},
            "result": g["result"],
        }

    def to_lobby(self):
        fx = super().to_lobby()
        self.g = None
        return fx
