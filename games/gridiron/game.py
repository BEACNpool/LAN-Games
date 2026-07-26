"""GRIDIRON — server-authoritative, phone-controlled party football.

The shared screen owns the field. Phones submit compact intent messages; this
session owns every position, timing window, catch, tackle, yard and score.
Hidden calls are masked in ``game_state`` until the huddle closes.
"""

from __future__ import annotations

import math
import time

from core.session import GameSession


TEAM_SIZE = 4
START_YARD = 50.0
FIELD_W = 100.0
FIELD_H = 2.0

HUDDLE_SECONDS = 12.0
SETUP_SECONDS = 3.0
WHISTLE_SECONDS = 4.0
TICK = 0.05
TICK_MS = 50
LIVE_TICKS = 120

RUN_SPEED = 3.2
SCRAMBLE_SPEED = 2.7
AFTER_CATCH_SPEED = 3.5
LATERAL_SPEED = 0.9
DEFENDER_LATERAL_SPEED = 1.15
DIVE_YARDS = 2.0
ARM_TACKLE_YARDS = 2.5

OFFENSE_ROLES = ("QB", "RB", "WR1", "WR2")
DEFENSE_ROLES = ("CB", "LB", "DL", "S")

OFFENSE_PLAYS = {
    "power": {
        "name": "POWER",
        "description": "RB hits the middle behind a clean crease.",
        "kind": "run",
        "primary": "RB",
        "lane": 0.0,
    },
    "sweep": {
        "name": "JET SWEEP",
        "description": "RB races outside and bends upfield.",
        "kind": "run",
        "primary": "RB",
        "lane": -0.65,
    },
    "slant": {
        "name": "QUICK SLANT",
        "description": "WR1 flashes open across the middle.",
        "kind": "pass",
        "primary": "WR1",
        "lane": -0.15,
    },
    "deep": {
        "name": "GO ROUTE",
        "description": "WR2 stretches the field for a deep shot.",
        "kind": "pass",
        "primary": "WR2",
        "lane": 0.65,
    },
}

DEFENSE_PLAYS = {
    "blitz": {
        "name": "HEAT",
        "description": "DL attacks the pocket before routes develop.",
        "focus": "DL",
    },
    "contain": {
        "name": "CONTAIN",
        "description": "LB closes the run lane and watches the scramble.",
        "focus": "LB",
    },
    "press": {
        "name": "PRESS",
        "description": "CB challenges the short receiver.",
        "focus": "CB",
    },
    "zone": {
        "name": "DEEP ZONE",
        "description": "Safety protects the long throw.",
        "focus": "S",
    },
}

BOT_NAMES = (
    "RIVET", "TURBO", "BOLT", "COMET", "ROCKET", "BLITZ", "ACE", "MACK",
)


def _finite(value):
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return -1_000_000 <= value <= 1_000_000
    return isinstance(value, float) and math.isfinite(value)


def _clamp(value, low, high):
    return max(low, min(high, value))


class GridironSession(GameSession):
    MIN_PLAYERS = 1
    MAX_HUMANS = 8
    DEFAULT_SETTINGS = {"possessions": 6, "assist": True}

    def __init__(self, rng=None):
        super().__init__(rng)
        self.g = None

    # ---------------- lobby / start ---------------------------------

    def validate_settings(self, patch):
        out = {}
        if not isinstance(patch, dict):
            return out
        possessions = patch.get("possessions")
        if (isinstance(possessions, int) and not isinstance(possessions, bool)
                and possessions in (4, 6, 8)):
            out["possessions"] = possessions
        assist = patch.get("assist")
        if type(assist) is bool:
            out["assist"] = assist
        return out

    def _setting_possessions(self):
        value = self.settings.get("possessions")
        if isinstance(value, int) and not isinstance(value, bool) \
                and value in (4, 6, 8):
            return value
        return 6

    def _setting_assist(self):
        value = self.settings.get("assist")
        return value if type(value) is bool else True

    def game_start(self):
        humans = [
            token for token in self.participants
            if token in self.players and not self.players[token].is_bot
        ][:self.MAX_HUMANS]
        teams = [[], []]
        for index, token in enumerate(humans):
            teams[index % 2].append(token)

        bot_index = 0
        for team in (0, 1):
            while len(teams[team]) < TEAM_SIZE:
                bot = self.add_bot(BOT_NAMES[bot_index % len(BOT_NAMES)])
                bot_index += 1
                teams[team].append(bot.token)

        order = teams[0] + teams[1]
        self.participants = list(order)
        self.g = {
            "teams": teams,
            "team_of": {
                token: team for team in (0, 1) for token in teams[team]
            },
            "team_names": ("CYAN", "VIOLET"),
            "scores": [0, 0],
            "order": order,
            "max_possessions": self._setting_possessions(),
            "assist": self._setting_assist(),
            "possession_no": 0,
            "possession_team": 0,
            "team_possessions": [0, 0],
            "roles": {},
            "down": 1,
            "to_go": FIELD_W - START_YARD,
            "yard": START_YARD,
            "drive_play": 0,
            "play_calls": {},
            "play_callers": {},
            "play_no": 0,
            "tick": 0,
            "clock": 0.0,
            "units": {},
            "routes": [],
            "ball": None,
            "mode": None,
            "carrier": None,
            "nearest_defender": None,
            "receivers": {},
            "target_receiver": None,
            "tackle_window": None,
            "catch_window": None,
            "tackle_attempted": False,
            "whiff": False,
            "boost_until": -1,
            "bot": {},
            "last_play": None,
            "possession_done": False,
            "result": None,
            "stats": {
                token: {
                    "yards": 0.0, "catches": 0, "tackles": 0,
                    "touchdowns": 0, "dives": 0, "whiffs": 0,
                }
                for token in order
            },
        }
        return self._start_possession()

    # ---------------- phase machine ----------------------------------

    def _start_possession(self):
        g = self.g
        g["possession_no"] += 1
        g["possession_team"] = (g["possession_no"] - 1) % 2
        g["team_possessions"][g["possession_team"]] += 1
        g["down"] = 1
        # Arcade rule: four plays from midfield to reach the goal. There are
        # no chain resets; "to go" is the remaining distance to the end zone.
        g["to_go"] = FIELD_W - START_YARD
        g["yard"] = START_YARD
        g["drive_play"] = 0
        g["possession_done"] = False
        self._assign_roles()
        fx = self._enter_huddle()
        fx.insert(0, self.fx(
            "possession", number=g["possession_no"],
            team=g["possession_team"]))
        return fx

    def _assign_roles(self):
        g = self.g
        offset = (g["possession_no"] - 1) % TEAM_SIZE
        offense = g["possession_team"]
        roles = {}
        for team in (0, 1):
            role_bank = OFFENSE_ROLES if team == offense else DEFENSE_ROLES
            for index, token in enumerate(g["teams"][team]):
                roles[token] = role_bank[(index + offset) % TEAM_SIZE]
        g["roles"] = roles

    def _enter_huddle(self):
        g = self.g
        g["play_no"] += 1
        g["drive_play"] += 1
        g["play_calls"] = {}
        g["play_callers"] = {}
        g["tick"] = 0
        g["clock"] = 0.0
        g["units"] = {}
        g["routes"] = []
        g["ball"] = {
            "x": round(g["yard"], 2), "y": 0.0, "carrier": None,
            "airborne": False, "target": None, "progress": 0.0,
        }
        g["mode"] = None
        g["carrier"] = None
        g["nearest_defender"] = None
        g["receivers"] = {}
        g["target_receiver"] = None
        g["tackle_window"] = None
        g["catch_window"] = None
        g["tackle_attempted"] = False
        g["whiff"] = False
        g["boost_until"] = -1
        g["possession_done"] = False
        self.phase = "huddle"
        self._fill_bot_calls()
        self._bump(time.time() + HUDDLE_SECONDS)
        return [self.fx(
            "huddle", possession=g["possession_no"], down=g["down"])]

    def _fill_bot_calls(self, force=False):
        g = self.g
        for team in (0, 1):
            if team in g["play_calls"]:
                continue
            connected_human = any(
                token in self.players
                and not self.players[token].is_bot
                and self.players[token].connected
                for token in g["teams"][team]
            )
            if connected_human and not force:
                continue
            cards = OFFENSE_PLAYS if team == g["possession_team"] \
                else DEFENSE_PLAYS
            play = self.rng.choice(tuple(cards))
            g["play_calls"][team] = play
            g["play_callers"][team] = None

    def _enter_setup(self):
        g = self.g
        self._build_down()
        self.phase = "setup"
        self._bump(time.time() + SETUP_SECONDS)
        return [self.fx(
            "play_reveal",
            offense=g["play_calls"][g["possession_team"]],
            defense=g["play_calls"][1 - g["possession_team"]])]

    def _begin_live(self):
        self.phase = "live"
        self.g["tick"] = 0
        self.g["clock"] = 0.0
        self._bump(time.time() + TICK)
        return [self.fx("snap")]

    def game_tick(self):
        if self.g is None:
            return []
        if self.phase == "huddle":
            self._fill_bot_calls(force=True)
            return self._enter_setup()
        if self.phase == "setup":
            return self._begin_live()
        if self.phase == "live":
            return self._tick_live()
        if self.phase == "whistle":
            if self.g["possession_done"]:
                if self.g["possession_no"] >= self.g["max_possessions"]:
                    return self._finish_game()
                return self._start_possession()
            return self._enter_huddle()
        self._bump(time.time() + 0.5)
        return []

    # ---------------- formation / simulation --------------------------

    def _token_for_role(self, team, role):
        for token in self.g["teams"][team]:
            if self.g["roles"].get(token) == role:
                return token
        return None

    def _build_down(self):
        g = self.g
        offense = g["possession_team"]
        defense = 1 - offense
        offense_play = OFFENSE_PLAYS[g["play_calls"][offense]]
        defense_play = DEFENSE_PLAYS[g["play_calls"][defense]]
        yard = g["yard"]
        formation = {
            "QB": (yard - 1.0, 0.0),
            "RB": (yard - 2.0, -0.25),
            "WR1": (yard, -0.78),
            "WR2": (yard, 0.78),
            "CB": (yard + 4.5, -0.72),
            "LB": (yard + 3.2, 0.0),
            "DL": (yard + 1.3, 0.12),
            "S": (yard + 8.0, 0.55),
        }
        g["units"] = {}
        for token in g["order"]:
            role = g["roles"][token]
            x, y = formation[role]
            g["units"][token] = {
                "x": float(x), "y": float(y), "vx": 0.0, "vy": 0.0,
                "steer": 0.0,
            }

        wr1 = self._token_for_role(offense, "WR1")
        wr2 = self._token_for_role(offense, "WR2")
        if g["play_calls"][offense] == "deep":
            receiver_specs = {
                wr1: {"start": 26, "end": 52, "catch_x": yard + 10.0,
                      "catch_y": -0.15},
                wr2: {"start": 44, "end": 82, "catch_x": yard + 18.0,
                      "catch_y": 0.58},
            }
        elif g["play_calls"][offense] == "slant":
            receiver_specs = {
                wr1: {"start": 18, "end": 52, "catch_x": yard + 9.0,
                      "catch_y": -0.05},
                wr2: {"start": 34, "end": 66, "catch_x": yard + 14.0,
                      "catch_y": 0.52},
            }
        else:
            receiver_specs = {
                wr1: {"start": 28, "end": 58, "catch_x": yard + 10.0,
                      "catch_y": -0.1},
                wr2: {"start": 40, "end": 74, "catch_x": yard + 15.0,
                      "catch_y": 0.5},
            }
        g["receivers"] = receiver_specs
        g["routes"] = [
            {
                "token": token,
                "points": [
                    {"x": round(g["units"][token]["x"], 2),
                     "y": round(g["units"][token]["y"], 2)},
                    {"x": round(spec["catch_x"], 2),
                     "y": round(spec["catch_y"], 2)},
                ],
            }
            for token, spec in receiver_specs.items()
        ]

        if offense_play["kind"] == "run":
            carrier = self._token_for_role(offense, "RB")
            nearest_role = defense_play["focus"]
            if nearest_role in ("CB", "S") and g["play_calls"][defense] != "zone":
                nearest_role = "LB"
            nearest = self._token_for_role(defense, nearest_role)
            g["mode"] = "run"
            g["carrier"] = carrier
            g["ball"] = {
                "x": yard, "y": g["units"][carrier]["y"],
                "carrier": carrier, "airborne": False,
                "target": None, "progress": 0.0,
            }
            g["tackle_window"] = self._new_tackle_window(nearest, 30, 48)
        else:
            qb = self._token_for_role(offense, "QB")
            nearest = self._token_for_role(
                defense, "DL" if g["play_calls"][defense] == "blitz" else "LB")
            g["mode"] = "pocket"
            g["carrier"] = qb
            g["ball"] = {
                "x": yard, "y": 0.0, "carrier": qb,
                "airborne": False, "target": None, "progress": 0.0,
            }
            g["tackle_window"] = self._new_tackle_window(nearest, 56, 72)

        g["nearest_defender"] = nearest
        g["target_receiver"] = None
        g["catch_window"] = None
        g["tackle_attempted"] = False
        g["whiff"] = False
        g["bot"] = {
            "throw_offset": self.rng.choice((-2, -1, 0, 1, 2)),
            "catch_offset": self.rng.choice((-2, -1, 0, 1, 2)),
            "tackle_offset": self.rng.choice((-3, -1, 0, 1, 3, 7)),
        }

    def _new_tackle_window(self, token, start, end):
        if self.g["assist"]:
            start -= 4
            end += 4
        return {"token": token, "start": int(start), "end": int(end)}

    def _tick_live(self):
        g = self.g
        base = self.deadline or time.time()
        g["tick"] += 1
        g["clock"] = round(g["tick"] * TICK, 3)
        fx = []
        fx.extend(self._auto_actions())
        if self.phase != "live":
            return fx
        self._step_world()

        if g["mode"] == "air" and g["catch_window"] \
                and g["tick"] > g["catch_window"]["end"]:
            fx.extend(self._finish_play("incomplete", gain_override=0.0))
            return fx

        if g["tick"] >= LIVE_TICKS:
            if g["mode"] in ("pocket", "air"):
                outcome = "sack" if g["mode"] == "pocket" else "incomplete"
                gain = -3.0 if outcome == "sack" else 0.0
                fx.extend(self._finish_play(outcome, gain_override=gain))
            else:
                fx.extend(self._finish_play("whistle"))
            return fx

        self._bump(max(time.time() + 0.01, base + TICK))
        return fx

    def _auto_actions(self):
        g = self.g
        fx = []
        carrier = g["carrier"]
        defender = g["nearest_defender"]
        if carrier and self._is_auto(carrier):
            target_y = OFFENSE_PLAYS[
                g["play_calls"][g["possession_team"]]]["lane"]
            current = g["units"][carrier]["y"]
            g["units"][carrier]["steer"] = _clamp(
                (target_y - current) * 2.0, -1.0, 1.0)
        if defender and self._is_auto(defender):
            carrier_y = g["units"][carrier]["y"] if carrier else 0.0
            current = g["units"][defender]["y"]
            g["units"][defender]["steer"] = _clamp(
                (carrier_y - current) * 2.4, -1.0, 1.0)

        if g["mode"] == "pocket":
            qb = g["carrier"]
            if qb and self._is_auto(qb):
                primary_role = OFFENSE_PLAYS[
                    g["play_calls"][g["possession_team"]]]["primary"]
                target = self._token_for_role(g["possession_team"], primary_role)
                spec = g["receivers"].get(target)
                if spec:
                    throw_tick = (spec["start"] + spec["end"]) // 2 \
                        + g["bot"]["throw_offset"]
                    if g["tick"] >= throw_tick:
                        fx.extend(self._throw(qb, target, require_open=False))

        if g["mode"] == "air" and g["target_receiver"]:
            target = g["target_receiver"]
            if self._is_auto(target) and g["catch_window"]:
                center = (g["catch_window"]["start"]
                          + g["catch_window"]["end"]) // 2
                if g["tick"] >= center + g["bot"]["catch_offset"]:
                    fx.extend(self._catch(target))

        if self.phase == "live" and g["nearest_defender"] \
                and not g["tackle_attempted"] and g["tackle_window"]:
            defender = g["nearest_defender"]
            if self._is_auto(defender):
                center = (g["tackle_window"]["start"]
                          + g["tackle_window"]["end"]) // 2
                if g["tick"] >= center + g["bot"]["tackle_offset"]:
                    fx.extend(self._tackle(defender))
        return fx

    def _step_world(self):
        g = self.g
        tick = g["tick"]
        start = g["yard"]
        for token, spec in g["receivers"].items():
            unit = g["units"][token]
            progress = _clamp(tick / max(1, spec["end"]), 0.0, 1.0)
            unit["x"] = start + (spec["catch_x"] - start) * progress
            initial_y = -0.78 if g["roles"][token] == "WR1" else 0.78
            unit["y"] = initial_y + (spec["catch_y"] - initial_y) * progress

        carrier = g["carrier"]
        if g["mode"] in ("run", "scramble", "caught") and carrier:
            unit = g["units"][carrier]
            speed = {
                "run": RUN_SPEED,
                "scramble": SCRAMBLE_SPEED,
                "caught": AFTER_CATCH_SPEED,
            }[g["mode"]]
            if tick < g["boost_until"]:
                speed *= 1.2
            unit["vx"] = speed
            unit["vy"] = unit["steer"] * LATERAL_SPEED
            unit["x"] = _clamp(unit["x"] + speed * TICK, 0.0, FIELD_W)
            unit["y"] = _clamp(
                unit["y"] + unit["steer"] * LATERAL_SPEED * TICK, -1.0, 1.0)
            g["ball"]["x"] = unit["x"]
            g["ball"]["y"] = unit["y"]
            g["ball"]["carrier"] = carrier

        defender = g["nearest_defender"]
        if defender and carrier:
            du = g["units"][defender]
            cu = g["units"][carrier]
            du["vy"] = du["steer"] * DEFENDER_LATERAL_SPEED
            du["y"] = _clamp(
                du["y"] + du["steer"] * DEFENDER_LATERAL_SPEED * TICK,
                -1.0, 1.0)
            dx = _clamp((cu["x"] - du["x"]) * 0.08, -0.28, 0.28)
            du["vx"] = dx / TICK
            du["x"] = _clamp(du["x"] + dx, 0.0, FIELD_W)

        if g["mode"] == "pocket" and carrier:
            g["ball"]["x"] = g["yard"]
            g["ball"]["y"] = g["units"][carrier]["y"]
        elif g["mode"] == "air" and g["target_receiver"]:
            ball = g["ball"]
            start_tick = ball["thrown_at"]
            end_tick = ball["arrival"]
            progress = _clamp(
                (tick - start_tick) / max(1, end_tick - start_tick), 0.0, 1.0)
            target = g["units"][g["target_receiver"]]
            ball["x"] = ball["from_x"] + (target["x"] - ball["from_x"]) * progress
            ball["y"] = ball["from_y"] + (target["y"] - ball["from_y"]) * progress
            ball["progress"] = round(progress, 3)

    # ---------------- actions ----------------------------------------

    def game_action(self, token, msg):
        if not isinstance(msg, dict):
            return [self.fx("invalid", to=token, msg="Malformed action")]
        if self.g is None or token not in self.g["team_of"]:
            return [self.fx("invalid", to=token, msg="You are not in this game")]
        player = self.players.get(token)
        if player is None or not player.connected:
            return [self.fx("invalid", to=token, msg="Controller is offline")]
        action = msg.get("t")
        if action == "call_play":
            return self._call_play(token, msg)
        if action == "swap_role":
            return self._swap_role(token, msg)
        if action == "steer":
            return self._steer(token, msg)
        if action == "dive":
            return self._dive(token, msg)
        if action == "tackle":
            return self._tackle_action(token, msg)
        if action == "catch":
            return self._catch_action(token, msg)
        if action == "throw":
            return self._throw_action(token, msg)
        if action == "scramble":
            return self._scramble(token, msg)
        return [self.fx("invalid", to=token, msg="Unknown action")]

    def _call_play(self, token, msg):
        if set(msg) != {"t", "play"} or not isinstance(msg.get("play"), str):
            return [self.fx("invalid", to=token, msg="Malformed play call")]
        if self.phase != "huddle":
            return [self.fx("invalid", to=token, msg="The huddle is closed")]
        team = self.g["team_of"][token]
        cards = OFFENSE_PLAYS if team == self.g["possession_team"] \
            else DEFENSE_PLAYS
        play = msg["play"]
        if play not in cards:
            return [self.fx("invalid", to=token, msg="Unknown play")]
        self.seq += 1
        self.g["play_calls"][team] = play
        self.g["play_callers"][team] = token
        self._fill_bot_calls()
        fx = [self.fx("play_locked", team=team)]
        if len(self.g["play_calls"]) == 2:
            fx.extend(self._enter_setup())
        return fx

    def _swap_role(self, token, msg):
        if set(msg) != {"t", "pid"} or not isinstance(msg.get("pid"), str):
            return [self.fx("invalid", to=token, msg="Malformed swap")]
        if self.phase != "huddle":
            return [self.fx("invalid", to=token, msg="Swap in the huddle")]
        target_player = self.by_pid(msg["pid"])
        if target_player is None:
            return [self.fx("invalid", to=token, msg="Unknown teammate")]
        target = target_player.token
        team = self.g["team_of"][token]
        if target == token or self.g["team_of"].get(target) != team:
            return [self.fx("invalid", to=token, msg="Pick a teammate")]
        self.seq += 1
        self.g["roles"][token], self.g["roles"][target] = (
            self.g["roles"][target], self.g["roles"][token])
        return [self.fx(
            "roles_swapped", team=team,
            a=self.players[token].pid, b=self.players[target].pid)]

    def _steer(self, token, msg):
        if set(msg) != {"t", "x"} or not _finite(msg.get("x")):
            return [self.fx("invalid", to=token, msg="Steer needs a number")]
        if self.phase != "live" or token not in (
                self.g["carrier"], self.g["nearest_defender"]):
            return [self.fx("invalid", to=token, msg="You are not steering")]
        if token == self.g["carrier"] and self.g["mode"] == "pocket":
            return [self.fx("invalid", to=token, msg="Scramble first")]
        self.seq += 1
        self.g["units"][token]["steer"] = _clamp(float(msg["x"]), -1.0, 1.0)
        return []

    def _dive(self, token, msg):
        if set(msg) != {"t"}:
            return [self.fx("invalid", to=token, msg="Malformed dive")]
        if self.phase != "live" or token != self.g["carrier"] \
                or self.g["mode"] not in ("run", "scramble", "caught"):
            return [self.fx("invalid", to=token, msg="You do not have the ball")]
        self.seq += 1
        self.g["stats"][token]["dives"] += 1
        return [self.fx("dive", pid=self.players[token].pid)] + \
            self._finish_play("dive", extra=DIVE_YARDS)

    def _tackle_action(self, token, msg):
        if set(msg) != {"t"}:
            return [self.fx("invalid", to=token, msg="Malformed tackle")]
        return self._tackle(token)

    def _tackle(self, token):
        g = self.g
        if self.phase != "live" or token != g["nearest_defender"] \
                or g["tackle_window"] is None:
            return [self.fx("invalid", to=token, msg="No tackle available")]
        if g["tackle_attempted"]:
            return [self.fx("invalid", to=token, msg="Tackle already spent")]
        self.seq += 1
        g["tackle_attempted"] = True
        window = g["tackle_window"]
        # A tackle is a one-shot timing decision. Clear the public cue at the
        # same authoritative mutation so reload/reconnect cannot advertise a
        # second HIT NOW after an early whiff.
        g["tackle_window"] = None
        tick = g["tick"]
        if tick < window["start"]:
            g["whiff"] = True
            g["boost_until"] = tick + 20
            g["stats"][token]["whiffs"] += 1
            return [self.fx("tackle", result="early", pid=self.players[token].pid)]

        carrier = g["carrier"]
        aligned = True
        if carrier:
            tolerance = 0.72 if g["assist"] else 0.55
            aligned = abs(
                g["units"][carrier]["y"] - g["units"][token]["y"]) <= tolerance
        if tick <= window["end"] and aligned:
            g["stats"][token]["tackles"] += 1
            outcome = "sack" if g["mode"] == "pocket" else "tackle"
            gain = -3.0 if outcome == "sack" else None
            return [self.fx(
                "tackle", result="clean", pid=self.players[token].pid)] + \
                self._finish_play(
                    outcome, gain_override=gain, tackler=token)
        if tick <= window["end"]:
            g["whiff"] = True
            g["boost_until"] = tick + 16
            g["stats"][token]["whiffs"] += 1
            return [self.fx("tackle", result="miss", pid=self.players[token].pid)]
        g["stats"][token]["tackles"] += 1
        return [self.fx(
            "tackle", result="late", pid=self.players[token].pid)] + \
            self._finish_play(
                "arm_tackle", extra=ARM_TACKLE_YARDS, tackler=token)

    def _throw_action(self, token, msg):
        if set(msg) != {"t", "target"} or not isinstance(msg.get("target"), str):
            return [self.fx("invalid", to=token, msg="Malformed throw")]
        target_player = self.by_pid(msg["target"])
        target = target_player.token if target_player else None
        # Direction is deliberately forgiving: lit buttons advertise the best
        # window, but a QB may still commit to a covered receiver. The catch
        # remains server-timed, so accepting the discrete target cannot move
        # or manufacture the ball client-side.
        return self._throw(token, target, require_open=False)

    def _throw(self, token, target, require_open):
        g = self.g
        if self.phase != "live" or g["mode"] != "pocket" \
                or token != g["carrier"] or g["roles"].get(token) != "QB":
            return [self.fx("invalid", to=token, msg="You cannot throw now")]
        if target not in g["receivers"]:
            return [self.fx("invalid", to=token, msg="Unknown receiver")]
        spec = g["receivers"][target]
        if require_open and not (spec["start"] <= g["tick"] <= spec["end"]):
            return [self.fx("invalid", to=token, msg="Receiver is covered")]
        self.seq += 1
        arrival = g["tick"] + 12
        width = 6 if g["assist"] else 4
        g["mode"] = "air"
        g["target_receiver"] = target
        g["catch_window"] = {
            "token": target,
            "start": arrival - width,
            "end": arrival + width,
        }
        nearest_role = "CB" if g["roles"][target] == "WR1" else "S"
        defender = self._token_for_role(1 - g["possession_team"], nearest_role)
        g["nearest_defender"] = defender
        g["tackle_window"] = self._new_tackle_window(
            defender, arrival + 7, arrival + 21)
        g["tackle_attempted"] = False
        qb_unit = g["units"][token]
        g["ball"] = {
            "x": qb_unit["x"], "y": qb_unit["y"], "carrier": None,
            "airborne": True, "target": target, "progress": 0.0,
            "from_x": qb_unit["x"], "from_y": qb_unit["y"],
            "thrown_at": g["tick"], "arrival": arrival,
        }
        return [self.fx(
            "throw", passer=self.players[token].pid,
            target=self.players[target].pid)]

    def _catch_action(self, token, msg):
        if set(msg) != {"t"}:
            return [self.fx("invalid", to=token, msg="Malformed catch")]
        return self._catch(token)

    def _catch(self, token):
        g = self.g
        if self.phase != "live" or g["mode"] != "air" \
                or token != g["target_receiver"] or g["catch_window"] is None:
            return [self.fx("invalid", to=token, msg="No catch available")]
        self.seq += 1
        window = g["catch_window"]
        if g["tick"] < window["start"]:
            return [self.fx(
                "catch", result="early", pid=self.players[token].pid)] + \
                self._finish_play(
                    "incomplete_early", gain_override=0.0, receiver=token)
        if g["tick"] > window["end"]:
            return [self.fx(
                "catch", result="late", pid=self.players[token].pid)] + \
                self._finish_play(
                    "incomplete_late", gain_override=0.0, receiver=token)
        g["mode"] = "caught"
        g["carrier"] = token
        g["stats"][token]["catches"] += 1
        unit = g["units"][token]
        g["ball"] = {
            "x": unit["x"], "y": unit["y"], "carrier": token,
            "airborne": False, "target": None, "progress": 1.0,
        }
        return [self.fx("catch", result="caught", pid=self.players[token].pid)]

    def _scramble(self, token, msg):
        if set(msg) != {"t"}:
            return [self.fx("invalid", to=token, msg="Malformed scramble")]
        g = self.g
        if self.phase != "live" or g["mode"] != "pocket" \
                or token != g["carrier"] or g["roles"].get(token) != "QB":
            return [self.fx("invalid", to=token, msg="You cannot scramble now")]
        self.seq += 1
        g["mode"] = "scramble"
        g["ball"]["carrier"] = token
        g["tackle_window"] = self._new_tackle_window(
            g["nearest_defender"], g["tick"] + 10, g["tick"] + 26)
        g["tackle_attempted"] = False
        return [self.fx("scramble", pid=self.players[token].pid)]

    # ---------------- resolution / connections -----------------------

    def _finish_play(self, outcome, extra=0.0, gain_override=None,
                     tackler=None, receiver=None):
        if self.phase != "live":
            return []
        g = self.g
        start_yard = g["yard"]
        old_down = g["down"]
        if gain_override is None:
            ball_x = g["ball"]["x"] if g["ball"] else start_yard
            gain = ball_x - start_yard + extra
        else:
            gain = gain_override
        gain = round(float(gain), 1)
        end_yard = round(_clamp(start_yard + gain, 0.0, FIELD_W), 1)
        gain = round(end_yard - start_yard, 1)
        touchdown = end_yard >= FIELD_W
        first_down = False
        turnover = bool(not touchdown and old_down >= 4)

        carrier = g["carrier"]
        if carrier and outcome not in (
                "incomplete", "incomplete_early", "incomplete_late", "sack"):
            g["stats"][carrier]["yards"] = round(
                g["stats"][carrier]["yards"] + gain, 1)
        if touchdown:
            g["scores"][g["possession_team"]] += 6
            if carrier:
                g["stats"][carrier]["touchdowns"] += 1

        g["yard"] = end_yard
        if touchdown or turnover:
            g["possession_done"] = True
        else:
            g["down"] = old_down + 1
            g["to_go"] = round(max(0.1, FIELD_W - end_yard), 1)

        text = self._play_text(
            outcome, gain, touchdown, first_down, turnover,
            tackler=tackler, receiver=receiver)
        g["last_play"] = {
            "possession": g["possession_no"],
            "down": old_down,
            "offense_team": g["possession_team"],
            "offense_play": g["play_calls"][g["possession_team"]],
            "defense_play": g["play_calls"][1 - g["possession_team"]],
            "outcome": outcome,
            "text": text,
            "yards": gain,
            "start_yard": round(start_yard, 1),
            "end_yard": end_yard,
            "first_down": first_down,
            "touchdown": touchdown,
            "turnover": turnover,
            "tackler_pid": self.players[tackler].pid if tackler else None,
            "receiver_pid": self.players[
                receiver or g["target_receiver"]].pid
            if (receiver or g["target_receiver"]) else None,
        }
        self.phase = "whistle"
        self._bump(time.time() + WHISTLE_SECONDS)
        return [self.fx(
            "whistle", outcome=outcome, yards=gain, text=text,
            touchdown=touchdown, turnover=turnover)]

    def _play_text(self, outcome, gain, touchdown, first_down, turnover,
                   tackler=None, receiver=None):
        if touchdown:
            return "TOUCHDOWN — %s!" % self.g["team_names"][
                self.g["possession_team"]]
        if outcome.startswith("incomplete"):
            return "Incomplete pass."
        if outcome == "sack":
            return "Sacked for %s yards." % abs(gain)
        if outcome == "dive":
            return "The dive steals %.1f yards." % gain
        if turnover:
            return "Stopped on fourth down — turnover."
        if first_down:
            return "%.1f yards — FIRST DOWN." % gain
        if outcome == "arm_tackle":
            return "Arm tackle, but the runner drags for %.1f." % gain
        return "%.1f yards on the play." % gain

    def _finish_game(self):
        g = self.g
        if g["scores"][0] == g["scores"][1]:
            winner = None
            tie = True
            winner_tokens = list(g["order"])
            headline = "REGULATION DRAW"
        else:
            winner = 0 if g["scores"][0] > g["scores"][1] else 1
            tie = False
            winner_tokens = list(g["teams"][winner])
            headline = "%s WINS" % g["team_names"][winner]
        teams = [
            {"id": team, "name": g["team_names"][team],
             "score": g["scores"][team]}
            for team in (0, 1)
        ]
        g["result"] = {
            "winner_team": winner,
            "tie": tie,
            "teams": teams,
            "winner_pids": [self.players[token].pid for token in winner_tokens],
            "reason": "regulation",
            "possessions": g["max_possessions"],
            "headline": headline,
        }
        return self.end_game()

    def game_player_left(self, token):
        if self.g is None or token not in self.g["team_of"]:
            return []
        if token in self.g["units"]:
            self.g["units"][token]["steer"] = 0.0
        fx = [self.fx(
            "autopilot", pid=self.players[token].pid,
            msg="%s dropped — autopilot is in" % self.players[token].name)]
        if self.phase == "huddle":
            self._fill_bot_calls()
            if len(self.g["play_calls"]) == 2:
                fx.extend(self._enter_setup())
        return fx

    def game_player_back(self, token):
        if self.g is None or token not in self.g["team_of"]:
            return []
        if token in self.g["units"]:
            self.g["units"][token]["steer"] = 0.0
        return [self.fx(
            "toast", to=token, icon=self.players[token].avatar,
            msg="%s is back in the huddle" % self.players[token].name)]

    def _is_auto(self, token):
        player = self.players.get(token)
        return player is None or player.is_bot or not player.connected

    # ---------------- pure masked state -------------------------------

    def _pid(self, token):
        player = self.players.get(token)
        return player.pid if player else None

    def _public_ball(self):
        ball = self.g["ball"]
        if ball is None:
            return None
        return {
            "x": round(ball["x"], 2),
            "y": round(ball["y"], 3),
            "carrier_pid": self._pid(ball.get("carrier")),
            "airborne": bool(ball.get("airborne")),
            "target_pid": self._pid(ball.get("target")),
            "progress": round(float(ball.get("progress", 0.0)), 3),
        }

    def _public_roster(self):
        g = self.g
        rows = []
        for token in g["order"]:
            player = self.players[token]
            unit = g["units"].get(token)
            team = g["team_of"][token]
            rows.append({
                "pid": player.pid,
                "name": player.name,
                "avatar": player.avatar,
                "pfp": player.pfp,
                "color": player.color,
                "team": team,
                "side": "offense" if team == g["possession_team"] else "defense",
                "role": g["roles"].get(token),
                "x": round(unit["x"], 2) if unit else None,
                "y": round(unit["y"], 3) if unit else None,
                "vx": round(unit["vx"], 2) if unit else 0.0,
                "vy": round(unit["vy"], 2) if unit else 0.0,
                "connected": bool(player.connected),
                "bot": bool(player.is_bot),
                "auto": self._is_auto(token),
                "is_carrier": token == g["carrier"]
                and g["mode"] in ("run", "scramble", "caught"),
                "is_nearest_defender": token == g["nearest_defender"],
                "stats": dict(g["stats"][token]),
            })
        return rows

    def _public_routes(self):
        if self.phase == "huddle":
            return []
        return [
            {
                "pid": self._pid(route["token"]),
                "role": self.g["roles"].get(route["token"]),
                "points": [
                    {"x": point["x"], "y": point["y"]}
                    for point in route["points"]
                ],
            }
            for route in self.g["routes"]
        ]

    def _window_state(self, raw):
        if raw is None:
            return None
        return {
            "pid": self._pid(raw["token"]),
            "start": raw["start"],
            "end": raw["end"],
            "open": raw["start"] <= self.g["tick"] <= raw["end"],
        }

    def _play_cards(self, side):
        cards = OFFENSE_PLAYS if side == "offense" else DEFENSE_PLAYS
        return [
            {"id": play_id, "name": spec["name"],
             "description": spec["description"]}
            for play_id, spec in cards.items()
        ]

    def _assignment(self, token):
        role = self.g["roles"].get(token)
        return {
            "QB": "Pick an open receiver or tap SCRAMBLE.",
            "RB": "When you get the ball, tilt to steer and tap DIVE.",
            "WR1": "Run the route. Raise the phone when CATCH flashes.",
            "WR2": "Run the route. Raise the phone when CATCH flashes.",
            "CB": "Track the receiver; tackle when the TV window flashes.",
            "LB": "Read the carrier; tilt pursuit and time the tackle.",
            "DL": "Collapse the pocket and time the sack.",
            "S": "Protect deep, then close on the carrier.",
        }.get(role, "Watch the shared field.")

    def _private_me(self, viewer_token):
        g = self.g
        if viewer_token not in g["team_of"] or viewer_token not in self.players:
            return None
        player = self.players[viewer_token]
        team = g["team_of"][viewer_token]
        side = "offense" if team == g["possession_team"] else "defense"
        role = g["roles"].get(viewer_token)
        is_carrier = (
            viewer_token == g["carrier"]
            and g["mode"] in ("run", "scramble", "caught")
        )
        is_defender = viewer_token == g["nearest_defender"]
        controls = []
        control = "watch"
        if self.phase == "huddle":
            control = "call_play"
            controls = ["call_play", "swap_role"]
        elif self.phase == "live":
            if is_carrier:
                control = "carrier"
                controls = ["steer", "dive"]
            elif is_defender and not g["tackle_attempted"]:
                control = "defender"
                controls = ["steer", "tackle"]
            elif role == "QB" and g["mode"] == "pocket":
                control = "quarterback"
                controls = ["throw", "scramble"]
            elif viewer_token == g["target_receiver"] and g["mode"] == "air":
                control = "receiver"
                controls = ["catch"]

        selected = g["play_calls"].get(team) if self.phase == "huddle" else None
        cards = self._play_cards(side) if self.phase == "huddle" else []
        swap_targets = []
        if self.phase == "huddle":
            for token in g["teams"][team]:
                if token == viewer_token:
                    continue
                swap_targets.append({
                    "pid": self._pid(token),
                    "name": self.players[token].name,
                    "role": g["roles"][token],
                })
        receivers = []
        if role == "QB":
            for token, spec in g["receivers"].items():
                receivers.append({
                    "pid": self._pid(token),
                    "name": self.players[token].name,
                    "role": g["roles"][token],
                    "open": (
                        self.phase == "live" and g["mode"] == "pocket"
                        and spec["start"] <= g["tick"] <= spec["end"]
                    ),
                })
        return {
            "pid": player.pid,
            "team": team,
            "side": side,
            "role": role,
            "assignment": self._assignment(viewer_token),
            "control": control,
            "controls": controls,
            "is_carrier": is_carrier,
            "is_nearest_defender": is_defender,
            "play_cards": cards,
            "play_choices": cards,
            "selected_play": selected,
            "swap_targets": swap_targets,
            "can_swap": self.phase == "huddle",
            "receivers": receivers,
            "available_receivers": [
                row for row in receivers if row["open"]
            ],
            "autopilot": self._is_auto(viewer_token),
        }

    def game_state(self, viewer_token):
        """Return a fresh payload; never mutate state or draw random values."""
        g = self.g
        if g is None:
            return None
        teams = [
            {"id": team, "name": g["team_names"][team],
             "score": g["scores"][team]}
            for team in (0, 1)
        ]
        roster = self._public_roster()
        ball = self._public_ball()
        play_status = []
        for team in (0, 1):
            row = {
                "team": team,
                "locked": team in g["play_calls"],
                "revealed": self.phase != "huddle",
            }
            if self.phase != "huddle" and team in g["play_calls"]:
                row["play"] = g["play_calls"][team]
            play_status.append(row)
        routes = self._public_routes()
        field = {
            "w": FIELD_W,
            "h": FIELD_H,
            "line_of_scrimmage": round(g["yard"], 1),
            "first_down": FIELD_W,
            "goal_line": FIELD_W,
            "players": roster,
            "units": roster,
            "ball": ball,
            "routes": routes,
        }
        state = {
            "kind": "gridiron",
            "stage": self.phase,
            "teams": teams,
            "possession": g["possession_no"],
            "possession_no": g["possession_no"],
            "max_possessions": g["max_possessions"],
            "possession_team": g["possession_team"],
            "offense": g["possession_team"],
            "down": g["down"],
            "to_go": round(g["to_go"], 1),
            "yard": round(g["yard"], 1),
            "direction": 1,
            "tick": g["tick"],
            "clock": g["clock"],
            "stage_left": round(
                max(0, LIVE_TICKS - g["tick"]) * TICK, 3
            ) if self.phase == "live" else None,
            "tick_ms": TICK_MS,
            "live_ticks": LIVE_TICKS,
            "field": field,
            "ball": ball,
            "roster": roster,
            "play_status": play_status,
            "windows": {
                "tackle": self._window_state(g["tackle_window"]),
                "catch": self._window_state(g["catch_window"]),
            },
            "last_play": dict(g["last_play"]) if g["last_play"] else None,
            "result": {
                **g["result"],
                "teams": [dict(row) for row in g["result"]["teams"]],
                "winner_pids": list(g["result"]["winner_pids"]),
            } if g["result"] else None,
        }
        # A watch socket is deliberately public-shaped: private controller
        # keys are absent, not present with null placeholders. A joined
        # spectator still receives ``me: None`` so phone clients can render
        # their explicit observer state.
        if viewer_token is not None:
            state["me"] = self._private_me(viewer_token)
        return state

    def to_lobby(self):
        fx = super().to_lobby()
        self.g = None
        return fx


__all__ = [
    "GridironSession",
    "OFFENSE_PLAYS",
    "DEFENSE_PLAYS",
    "HUDDLE_SECONDS",
    "SETUP_SECONDS",
    "WHISTLE_SECONDS",
    "TICK",
    "TICK_MS",
    "LIVE_TICKS",
]
