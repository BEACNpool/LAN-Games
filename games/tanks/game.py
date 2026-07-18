"""TANKS — turn-based artillery. Side-view destructible terrain, 2-6 tanks
spread across one map (the classic way artillery games go multiplayer),
move-then-shoot turns with manual angle + power, wind, craters, last tank
standing wins.

Everything physical is SERVER-simulated and deterministic: the client only
animates the trajectory the server returns. World: 1200 x 600 units,
heights[x] = terrain surface height (from the bottom) per column.

Turn shape: the current player may spend move fuel (small steps, slope-
limited) and must fire once — firing resolves the shot (carve craters,
damage, falls), shows a short RESOLVE window so every phone can watch the
tracer, then the next living tank is up. Timeout = the bot gunner fires
for you. Self-damage is real. That's the game.
"""

from __future__ import annotations

import math
import time

from core.session import GameSession

W, H = 1200, 600
GRAVITY = 110.0
DT = 0.033
POWER_SCALE = 1.9
WIND_DRAG = 0.28
MOVE_STEP = 4
MAX_SLOPE = 14          # per-step climb limit -> steep walls block movement
FUEL_PER_TURN = 100
BLAST_R = 34            # crater radius
DMG_R = 46              # damage radius
DMG_MAX = 55
HP = 100
FALL_FREE = 40          # units of free fall before damage
RESOLVE_SECONDS = 3.2
BOT_NAMES = ["GUNNER", "HAVOC", "MORTAR", "RICOCHET", "DUSTY"]

TERRAINS = {
    "rolling": 0.9,
    "craggy": 1.7,
    "canyon": 2.6,
}


def gen_terrain(rng, style="craggy"):
    """Midpoint displacement + smoothing: hills, valleys, crevices."""
    rough = TERRAINS.get(style, 1.7)
    n = 1
    while n < W:
        n *= 2
    hts = [0.0] * (n + 1)
    hts[0] = rng.uniform(H * 0.25, H * 0.5)
    hts[n] = rng.uniform(H * 0.25, H * 0.5)
    step = n
    disp = H * 0.28 * rough
    while step > 1:
        half = step // 2
        for i in range(half, n, step):
            hts[i] = (hts[i - half] + hts[i + half]) / 2 \
                + rng.uniform(-disp, disp)
        disp *= 0.55
        step = half
    # smooth + clamp
    out = [0] * W
    for x in range(W):
        v = hts[x]
        if 0 < x < W - 1:
            v = (hts[x - 1] + v * 2 + hts[x + 1]) / 4
        out[x] = int(max(50, min(H - 180, v)))
    return out


def simulate_shot(heights, tanks, shooter_id, angle, power, wind):
    """Integrate the projectile; return dict with trajectory (sampled),
    impact point (or None when it flies off), and hit tank id (direct)."""
    t = tanks[shooter_id]
    a = math.radians(angle)
    x = t["x"] + math.cos(a) * 16.0
    y = t["y"] + 12.0 + math.sin(a) * 16.0
    vx = math.cos(a) * power * POWER_SCALE
    vy = math.sin(a) * power * POWER_SCALE
    points = []
    impact = None
    hit_tank = None
    for i in range(2600):
        vx += wind * WIND_DRAG * DT
        vy -= GRAVITY * DT
        x += vx * DT
        y += vy * DT
        if i % 2 == 0:
            points.append([round(x, 1), round(y, 1)])
        if x < -60 or x > W + 60 or y < -50:
            break
        if y > H * 2:
            continue
        # direct tank hit (living, not the shooter in the first instants)
        for tid, tk in tanks.items():
            if tk["hp"] <= 0:
                continue
            if tid == shooter_id and i < 12:
                continue
            if abs(x - tk["x"]) <= 13 and abs(y - (tk["y"] + 8)) <= 13:
                impact = (x, y)
                hit_tank = tid
                break
        if impact:
            break
        xi = int(x)
        if 0 <= xi < W and y <= heights[xi]:
            impact = (x, max(y, heights[xi] - 2))
            break
    return {"points": points, "impact": impact, "hit_tank": hit_tank}


def carve(heights, cx, cy, r=BLAST_R):
    """Blast a crater: lower terrain within r of the impact point."""
    x0, x1 = max(0, int(cx - r)), min(W - 1, int(cx + r))
    for c in range(x0, x1 + 1):
        dx = c - cx
        chord = math.sqrt(max(0.0, r * r - dx * dx))
        floor_here = cy - chord
        if heights[c] > floor_here:
            heights[c] = int(max(20, floor_here))


class TanksSession(GameSession):
    MIN_PLAYERS = 1            # a lone human gets bot opponents
    MAX_HUMANS = 6
    DEFAULT_SETTINGS = {
        "bot_players": 1,
        "difficulty": "sharp",      # bot gunners: sharp | rookie
        "turn_seconds": 45,
        "terrain": "craggy",
    }

    def __init__(self, rng=None):
        super().__init__(rng)
        self.g = None

    def validate_settings(self, patch):
        ok = {}
        b = patch.get("bot_players")
        if isinstance(b, int) and not isinstance(b, bool) and 0 <= b <= 5:
            ok["bot_players"] = b
        if patch.get("difficulty") in ("rookie", "sharp"):
            ok["difficulty"] = patch["difficulty"]
        ts = patch.get("turn_seconds")
        if isinstance(ts, int) and not isinstance(ts, bool) and ts in (30, 45, 60, 90):
            ok["turn_seconds"] = ts
        if patch.get("terrain") in TERRAINS:
            ok["terrain"] = patch["terrain"]
        return ok

    # ---------------- lifecycle ----------------

    def game_start(self):
        humans = self.participants[:6]
        benched = self.participants[6:]
        self.participants = list(humans)
        fx = [self.fx("toast", to=t, icon="🪑",
                      msg="Six tanks max — you're watching this one")
              for t in benched]
        want_bots = self.settings["bot_players"]
        if len(humans) == 1 and want_bots == 0:
            want_bots = 1              # someone has to get shot at
        n_bots = min(want_bots, 6 - len(humans))
        for i in range(n_bots):
            bot = self.add_bot("BOT %s" % BOT_NAMES[i % len(BOT_NAMES)])
            self.participants.append(bot.token)
        order = list(self.participants)
        self.rng.shuffle(order)
        heights = gen_terrain(self.rng, self.settings["terrain"])
        tanks = {}
        n = len(order)
        for i, tok in enumerate(order):
            x = int(W * (i + 1) / (n + 1) + self.rng.uniform(-40, 40))
            x = max(30, min(W - 30, x))
            tanks[tok] = {"x": x, "y": heights[x], "hp": HP,
                          "angle": 60 if x < W / 2 else 120, "dealt": 0}
        self.g = {
            "order": order,
            "heights": heights,
            "terrain_v": 1,
            "tanks": tanks,
            "turn_idx": 0,
            "fuel": FUEL_PER_TURN,
            "wind": self.rng.randint(-25, 25),
            "shots": 0,
            "result": None,
        }
        self.phase = "battle"
        self._arm_turn()
        fx.append(self.fx("battle_start"))
        return fx

    def _arm_turn(self):
        self._bump(time.time() + self.settings["turn_seconds"])

    def _current(self):
        return self.g["order"][self.g["turn_idx"]]

    def _alive(self):
        return [t for t in self.g["order"] if self.g["tanks"][t]["hp"] > 0]

    def _advance(self):
        g = self.g
        for _ in range(len(g["order"])):
            g["turn_idx"] = (g["turn_idx"] + 1) % len(g["order"])
            if g["tanks"][self._current()]["hp"] > 0:
                break
        g["fuel"] = FUEL_PER_TURN
        g["wind"] = self.rng.randint(-25, 25)
        self.phase = "battle"
        self._arm_turn()
        p = self.players.get(self._current())
        return [self.fx("turn", pid=p.pid if p else None)]

    # ---------------- actions ----------------

    def game_action(self, token, msg):
        self.seq += 1
        g = self.g
        if g is None or self.phase != "battle":
            return [self.fx("invalid", to=token, msg="Hold on")]
        if token not in g["order"]:
            return [self.fx("invalid", to=token, msg="You're watching this one")]
        if token != self._current():
            return [self.fx("invalid", to=token, msg="Not your turn")]
        if g["tanks"][token]["hp"] <= 0:
            return []
        t = msg.get("t")
        if t == "move":
            return self._do_move(token, msg.get("dir"))
        if t == "aim":
            ang = msg.get("angle")
            if isinstance(ang, (int, float)) and 0 <= ang <= 180:
                g["tanks"][token]["angle"] = round(float(ang), 1)
            return []
        if t == "fire":
            return self._do_fire(token, msg.get("angle"), msg.get("power"))
        return [self.fx("invalid", to=token, msg="Unknown action")]

    def _do_move(self, token, direction):
        g = self.g
        if direction not in (-1, 1):
            return []
        if g["fuel"] < MOVE_STEP:
            return [self.fx("invalid", to=token, msg="Out of fuel")]
        tank = g["tanks"][token]
        nx = tank["x"] + direction * MOVE_STEP
        if not (14 <= nx <= W - 14):
            return []
        climb = g["heights"][nx] - g["heights"][tank["x"]]
        if climb > MAX_SLOPE:
            return [self.fx("invalid", to=token, msg="Too steep")]
        # no walking across others
        for tid, other in g["tanks"].items():
            if tid != token and other["hp"] > 0 and abs(other["x"] - nx) < 18:
                return []
        tank["x"] = nx
        tank["y"] = g["heights"][nx]
        g["fuel"] -= MOVE_STEP + max(0, climb // 4)
        return []          # position flows through the state push

    def _do_fire(self, token, angle, power):
        g = self.g
        if not isinstance(angle, (int, float)) or not isinstance(power, (int, float)) \
                or isinstance(angle, bool) or isinstance(power, bool):
            return [self.fx("invalid", to=token, msg="Bad shot")]
        angle = max(0.0, min(180.0, float(angle)))
        power = max(10.0, min(100.0, float(power)))
        g["tanks"][token]["angle"] = round(angle, 1)
        shot = simulate_shot(g["heights"], g["tanks"], token,
                             angle, power, g["wind"])
        g["shots"] += 1
        damages, deaths = [], []
        if shot["impact"]:
            ix, iy = shot["impact"]
            carve(g["heights"], ix, iy)
            g["terrain_v"] += 1
            for tid, tk in g["tanks"].items():
                if tk["hp"] <= 0:
                    continue
                dist = math.hypot(tk["x"] - ix, (tk["y"] + 8) - iy)
                if shot["hit_tank"] == tid:
                    dist = 0.0
                if dist < DMG_R:
                    dmg = int(DMG_MAX * (1 - dist / DMG_R)) + \
                        (10 if shot["hit_tank"] == tid else 0)
                    tk["hp"] = max(0, tk["hp"] - dmg)
                    if tid != token:
                        g["tanks"][token]["dealt"] += dmg
                    p = self.players.get(tid)
                    damages.append({"pid": p.pid if p else None, "dmg": dmg})
            # settle everyone onto the new ground, with fall damage
            for tid, tk in g["tanks"].items():
                if tk["hp"] <= 0:
                    continue
                ground = g["heights"][tk["x"]]
                drop = tk["y"] - ground
                if drop > 0:
                    tk["y"] = ground
                    if drop > FALL_FREE:
                        fall = int((drop - FALL_FREE) * 0.3)
                        tk["hp"] = max(0, tk["hp"] - fall)
                        p = self.players.get(tid)
                        damages.append({"pid": p.pid if p else None,
                                        "dmg": fall, "fall": True})
            for tid, tk in g["tanks"].items():
                if tk["hp"] <= 0 and not tk.get("dead"):
                    tk["dead"] = True
                    p = self.players.get(tid)
                    deaths.append(p.pid if p else None)
        p = self.players[token]
        fx = [self.fx("fired", pid=p.pid,
                      points=shot["points"][:400],
                      impact=[round(shot["impact"][0], 1),
                              round(shot["impact"][1], 1)] if shot["impact"] else None,
                      damages=damages, deaths=deaths,
                      angle=angle, power=power, wind=g["wind"])]
        alive = self._alive()
        if len(alive) <= 1:
            winner = alive[0] if alive else token
            wp = self.players.get(winner)
            self.g["result"] = {
                "winner": wp.pid if wp else None,
                "dealt": g["tanks"][winner]["dealt"] if winner in g["tanks"] else 0,
                "shots": g["shots"],
                "standings": [{
                    "pid": self.players[t].pid,
                    "hp": g["tanks"][t]["hp"],
                    "dealt": g["tanks"][t]["dealt"],
                } for t in g["order"] if t in self.players],
            }
            fx.extend(self.end_game())
            return fx
        # resolve window so everyone watches the tracer, then next turn
        self.phase = "resolve"
        self._bump(time.time() + RESOLVE_SECONDS)
        return fx

    # ---------------- timers & bots ----------------

    def game_tick(self):
        if self.g is None:
            return []
        if self.phase == "resolve":
            return self._advance()
        if self.phase != "battle":
            return []
        token = self._current()
        p = self.players.get(token)
        fx = []
        if p is not None and not p.is_bot and p.connected:
            fx.append(self.fx("toast", icon="⏱",
                              msg="%s took too long — the gunner fires" % p.name))
        fx.extend(self._bot_fire(token))
        return fx

    def _bot_fire(self, token):
        angle, power = self._aim(token)
        return self._do_fire(token, angle, power)

    def _aim(self, token):
        """Grid-search the ballistics for the best shot at the nearest
        living enemy; rookie adds heavy jitter."""
        g = self.g
        me = g["tanks"][token]
        enemies = [(tid, tk) for tid, tk in g["tanks"].items()
                   if tid != token and tk["hp"] > 0]
        if not enemies:
            return 60.0, 50.0
        target = min(enemies, key=lambda e: abs(e[1]["x"] - me["x"]))[1]
        best, best_d = (60.0, 60.0), 1e9
        to_right = target["x"] >= me["x"]
        angles = range(15, 91, 5) if to_right else range(90, 166, 5)
        for a in angles:
            for pw in range(25, 101, 5):
                shot = simulate_shot(g["heights"], g["tanks"], token,
                                     float(a), float(pw), g["wind"])
                if not shot["impact"]:
                    continue
                ix, iy = shot["impact"]
                d = math.hypot(ix - target["x"], iy - target["y"])
                self_d = math.hypot(ix - me["x"], iy - me["y"])
                if self_d < DMG_R + 6:
                    d += 500          # don't shell yourself
                if d < best_d:
                    best_d, best = d, (float(a), float(pw))
        a, pw = best
        if self.settings["difficulty"] == "rookie":
            a += self.rng.uniform(-9, 9)
            pw += self.rng.uniform(-12, 12)
        else:
            a += self.rng.uniform(-1.5, 1.5)
            pw += self.rng.uniform(-2, 2)
        return max(0.0, min(180.0, a)), max(10.0, min(100.0, pw))

    def next_bot_action(self):
        if self.phase != "battle" or self.g is None:
            return None
        token = self._current()
        p = self.players.get(token)
        if p is None or p.is_bot or not p.connected:
            return (1.6 + self.rng.random() * 1.4, token)
        return None

    def run_bot(self, bot_token):
        if self.phase != "battle" or self.g is None:
            return []
        if self._current() != bot_token:
            return []
        p = self.players.get(bot_token)
        if p is not None and not p.is_bot and p.connected:
            return []
        self.seq += 1
        return self._bot_fire(bot_token)

    # ---------------- connection events ----------------

    def game_player_left(self, token):
        if self.g and token in self.g["order"] and self.phase in ("battle", "resolve"):
            p = self.players[token]
            return [self.fx("toast", icon="🛰",
                            msg="%s dropped — the gunner mans their tank" % p.name)]
        return []

    # ---------------- serialization ----------------

    def game_state(self, viewer_token):
        g = self.g
        if g is None:
            return None
        cur = self._current()
        tanks = []
        for tok in g["order"]:
            p = self.players.get(tok)
            tk = g["tanks"][tok]
            tanks.append({
                "pid": p.pid if p else None,
                "x": tk["x"], "y": tk["y"], "hp": tk["hp"],
                "angle": tk["angle"], "dealt": tk["dealt"],
                "auto": p is None or p.is_bot or not p.connected,
            })
        return {
            "kind": "tanks",
            "stage": self.phase,
            "heights": g["heights"],
            "terrain_v": g["terrain_v"],
            "tanks": tanks,
            "turn": self.players[cur].pid if self.players.get(cur) else None,
            "your_turn": viewer_token == cur and self.phase == "battle",
            "fuel": g["fuel"] if viewer_token == cur else None,
            "wind": g["wind"],
            "turn_seconds": self.settings["turn_seconds"],
            "world": [W, H],
            "result": g["result"],
        }
