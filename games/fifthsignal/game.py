"""THE FIFTH SIGNAL — asymmetric co-op for exactly one family crew.

Three to five humans operate five semantic stations.  With fewer than five,
some humans carry two stations, but ownership is balanced and every answer is
always relayed by a *different* human.  Phones hold all private console data;
the TV receives only story, readiness and resolution status.

The engine is synchronous and IO-free like every other hub game.  Phone motion
is intentionally client-only: a tilt UI quantizes its gyroscope into the same
``{"x": int, "y": int}`` balance value accepted from an accessible touch pad.
"""

from __future__ import annotations

import copy
import time

from core.session import GameSession
from games.fifthsignal.scenario import (
    CONTROL_KINDS,
    ROLE_BY_ID,
    ROLE_IDS,
    assign_roles,
    build_relays,
    generate_crisis,
    role_public,
)


LENGTHS = {"short": 3, "full": 5}
DIFFICULTIES = {
    "easy": {
        "crisis_seconds": 70,
        "integrity_short": 3,
        "integrity_full": 4,
        "threshold": 4,
    },
    "standard": {
        "crisis_seconds": 55,
        "integrity_short": 2,
        "integrity_full": 3,
        "threshold": 5,
    },
    "expert": {
        "crisis_seconds": 42,
        "integrity_short": 2,
        "integrity_full": 3,
        "threshold": 5,
    },
}

BRIEFING_SECONDS = 6
RESOLUTION_SECONDS = 7
FINAL_SECONDS = 18
SYNC_HOLD_SECONDS = 2.2
RECENT_SIGNATURES = 20
RECENT_FRAMES = 12


def _strict_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


class FifthSignalSession(GameSession):
    MIN_PLAYERS = 3
    MAX_HUMANS = 5
    DEFAULT_SETTINGS = {"length": "full", "difficulty": "standard"}

    def __init__(self, rng=None):
        super().__init__(rng)
        self.g = None
        # This survives to_lobby(), so a rematch rejects the room's recent
        # crises rather than replaying the same opening five minutes later.
        self.recent_signatures = []
        self.recent_frames = []

    # ---------------- lobby / settings ---------------------------------

    def validate_settings(self, patch):
        out = {}
        if not isinstance(patch, dict):
            return out
        length = patch.get("length")
        difficulty = patch.get("difficulty")
        if isinstance(length, str) and length in LENGTHS:
            out["length"] = length
        if isinstance(difficulty, str) and difficulty in DIFFICULTIES:
            out["difficulty"] = difficulty
        return out

    def _setting(self, key, allowed, fallback):
        value = self.settings.get(key)
        return value if isinstance(value, str) and value in allowed else fallback

    # ---------------- lifecycle ----------------------------------------

    def game_start(self):
        order = list(self.participants)
        length = self._setting("length", LENGTHS, "full")
        difficulty = self._setting(
            "difficulty", DIFFICULTIES, "standard")
        owners, relay_targets = assign_roles(order, self.rng)
        roles_by_token = {
            token: [role_id for role_id in ROLE_IDS
                    if owners[role_id] == token]
            for token in order
        }
        integrity_key = "integrity_%s" % length
        integrity = DIFFICULTIES[difficulty][integrity_key]
        self.g = {
            "order": order,
            "length": length,
            "difficulty": difficulty,
            "round": 0,
            "rounds": LENGTHS[length],
            "owners": owners,                 # role -> token, never serialized
            "roles_by_token": roles_by_token,
            "relay_targets": relay_targets,
            "scenario": None,
            "relays": {},
            "run_signatures": [],
            "run_frames": [],
            "inputs": {},
            "autopilot_roles": set(),
            "resolution": None,
            "integrity": integrity,
            "integrity_max": integrity,
            "crises_cleared": 0,
            "stats": {
                token: {
                    "adjustments": 0,
                    "systems_stabilized": 0,
                    "signals_carried": 0,
                    "steady_crises": 0,
                    "autopilot_saves": 0,
                }
                for token in order
            },
            "final": None,
            "result": None,
        }
        return self._next_briefing()

    def _enter(self, phase, seconds):
        self.phase = phase
        self._bump(time.time() + seconds)

    def _next_briefing(self):
        g = self.g
        g["round"] += 1
        blocked = self.recent_signatures + g["run_signatures"]
        previous_kinds = (
            {role_id: task["kind"]
             for role_id, task in g["scenario"]["tasks"].items()}
            if g["scenario"] is not None else {}
        )
        scenario = generate_crisis(
            self.rng, difficulty=g["difficulty"], recent=blocked,
            blocked_frames=self.recent_frames + g["run_frames"],
            previous_kinds=previous_kinds)
        g["scenario"] = scenario
        g["relays"] = build_relays(
            scenario, g["relay_targets"], g["owners"], self.players, self.rng)
        g["run_signatures"].append(scenario["signature"])
        g["run_frames"].append(scenario["frame"]["id"])
        self.recent_signatures.append(scenario["signature"])
        self.recent_signatures = self.recent_signatures[-RECENT_SIGNATURES:]
        self.recent_frames.append(scenario["frame"]["id"])
        self.recent_frames = self.recent_frames[-RECENT_FRAMES:]
        g["inputs"] = {}
        g["autopilot_roles"] = set()
        g["resolution"] = None
        self._enter("briefing", BRIEFING_SECONDS)
        return [self.fx(
            "briefing", round=g["round"], rounds=g["rounds"],
            crisis=scenario["frame"]["title"])]

    def _enter_crisis(self):
        g = self.g
        # Fused crews perform the same five systems sequentially, so give
        # three/four-player rooms enough breathing room without simplifying
        # their actual puzzle.
        crew_scale = {3: 1.20, 4: 1.10, 5: 1.0}[len(g["order"])]
        self._enter(
            "crisis",
            DIFFICULTIES[g["difficulty"]]["crisis_seconds"] * crew_scale)
        fx = [self.fx("crisis", round=g["round"])]
        for token in g["order"]:
            player = self.players.get(token)
            if player is not None and not player.connected:
                fx.extend(self._engage_autopilot(token))
        if len(g["inputs"]) == len(ROLE_IDS):
            fx.extend(self._resolve_crisis())
        return fx

    def game_tick(self):
        if self.g is None:
            return []
        if self.phase == "briefing":
            return self._enter_crisis()
        if self.phase == "crisis":
            return self._resolve_crisis(timed_out=True)
        if self.phase == "resolution":
            if self.g["integrity"] <= 0:
                return self._finish_destroyed()
            if self.g["round"] < self.g["rounds"]:
                return self._next_briefing()
            return self._enter_final()
        if self.phase == "final_sync":
            final = self.g["final"]
            synchronized = (
                final["hold_started"] is not None
                and len(final["held"]) == len(self.g["order"])
            )
            return self._finish(synchronized)
        return []

    # ---------------- crisis controls ----------------------------------

    def _valid_control(self, task, value):
        kind = task["kind"]
        spec = task["spec"]
        if kind == "choice":
            return isinstance(value, str) and value in spec["options"]
        if kind == "sequence":
            return (
                isinstance(value, list)
                and len(value) == spec["length"]
                and all(isinstance(item, str) and item in spec["keys"]
                        for item in value)
            )
        if kind == "dial":
            return (
                _strict_int(value)
                and spec["min"] <= value <= spec["max"]
                and (value - spec["min"]) % spec["step"] == 0
            )
        if kind == "switches":
            return (
                isinstance(value, list)
                and len(value) == len(spec["labels"])
                and all(type(item) is bool for item in value)
            )
        if kind == "balance":
            return (
                isinstance(value, dict)
                and set(value) == {"x", "y"}
                and all(_strict_int(value[axis]) for axis in ("x", "y"))
                and all(spec["min"] <= value[axis] <= spec["max"]
                        and (value[axis] - spec["min"]) % spec["step"] == 0
                        for axis in ("x", "y"))
            )
        return False

    def game_action(self, token, msg):
        if not isinstance(msg, dict):
            return [self.fx("invalid", to=token, msg="Malformed command")]
        action = msg.get("t")
        if action == "control":
            return self._control(token, msg)
        if action == "sync":
            return self._sync(token, msg)
        return [self.fx("invalid", to=token, msg="Unknown command")]

    def _control(self, token, msg):
        if set(msg) != {"t", "role", "value"}:
            return [self.fx("invalid", to=token, msg="Malformed console input")]
        if self.phase != "crisis":
            return [self.fx("invalid", to=token, msg="Consoles are not live")]
        if token not in self.g["order"] or token not in self.players:
            return [self.fx("invalid", to=token, msg="You are not on this crew")]
        role_id = msg["role"]
        if not isinstance(role_id, str) or role_id not in ROLE_BY_ID:
            return [self.fx("invalid", to=token, msg="Unknown console")]
        if self.g["owners"][role_id] != token:
            return [self.fx("invalid", to=token, msg="That is not your console")]
        if role_id in self.g["autopilot_roles"]:
            return [self.fx(
                "invalid", to=token, msg="Autopilot already secured that console")]
        task = self.g["scenario"]["tasks"][role_id]
        value = msg["value"]
        if not self._valid_control(task, value):
            return [self.fx("invalid", to=token, msg="Invalid console value")]

        self.seq += 1
        self.g["inputs"][role_id] = copy.deepcopy(value)
        self.g["stats"][token]["adjustments"] += 1
        fx = [
            self.fx("control_set", to=token, role=role_id),
            self.fx("console_ready", pid=self.players[token].pid, role=role_id),
        ]
        if len(self.g["inputs"]) == len(ROLE_IDS):
            fx.extend(self._resolve_crisis())
        return fx

    def _engage_autopilot(self, token):
        """Secure a disconnected player's stations without exposing answers."""
        if self.phase != "crisis" or token not in self.g["roles_by_token"]:
            return []
        roles = []
        for role_id in self.g["roles_by_token"][token]:
            if role_id in self.g["autopilot_roles"]:
                continue
            task = self.g["scenario"]["tasks"][role_id]
            self.g["inputs"][role_id] = copy.deepcopy(task["target"])
            self.g["autopilot_roles"].add(role_id)
            self.g["stats"][token]["autopilot_saves"] += 1
            roles.append(role_id)
        if not roles:
            return []
        return [self.fx(
            "autopilot", pid=self.players[token].pid, roles=roles)]

    def _resolve_crisis(self, timed_out=False):
        if self.phase != "crisis":
            return []
        g = self.g
        systems = []
        correct_by_owner = {token: [] for token in g["order"]}
        for role_id in ROLE_IDS:
            task = g["scenario"]["tasks"][role_id]
            stable = (
                role_id in g["inputs"]
                and g["inputs"][role_id] == task["target"]
            )
            owner = g["owners"][role_id]
            correct_by_owner[owner].append(stable)
            if stable:
                g["stats"][owner]["systems_stabilized"] += 1
            systems.append({
                "role": role_id,
                "title": ROLE_BY_ID[role_id]["title"],
                "icon": ROLE_BY_ID[role_id]["icon"],
                "stable": stable,
            })
        stabilized = sum(1 for item in systems if item["stable"])
        threshold = DIFFICULTIES[g["difficulty"]]["threshold"]
        cleared = stabilized >= threshold
        if cleared:
            g["crises_cleared"] += 1
        else:
            g["integrity"] = max(0, g["integrity"] - 1)
        for token, marks in correct_by_owner.items():
            g["stats"][token]["signals_carried"] += len(
                g["roles_by_token"][token])
            if marks and all(marks):
                g["stats"][token]["steady_crises"] += 1
        g["resolution"] = {
            "cleared": cleared,
            "stabilized": stabilized,
            "total": len(ROLE_IDS),
            "systems": systems,
            "timed_out": bool(timed_out),
        }
        self._enter("resolution", RESOLUTION_SECONDS)
        return [self.fx(
            "resolved", cleared=cleared, stabilized=stabilized,
            integrity=g["integrity"])]

    # ---------------- final synchronized hold --------------------------

    def _enter_final(self):
        g = self.g
        now = time.time()
        held = {
            token for token in g["order"]
            if token in self.players and not self.players[token].connected
        }
        g["final"] = {
            "held": held,                  # tokens, mapped to pids in state
            "auto": set(held),
            "hold_started": None,
            "ends_at": now + FINAL_SECONDS,
            "synchronized": False,
        }
        self.phase = "final_sync"
        self._arm_final()
        return [self.fx("final_sync", seconds=FINAL_SECONDS)]

    def _arm_final(self):
        final = self.g["final"]
        if len(final["held"]) == len(self.g["order"]):
            if final["hold_started"] is None:
                final["hold_started"] = time.time()
            target = min(
                final["ends_at"], final["hold_started"] + SYNC_HOLD_SECONDS)
        else:
            final["hold_started"] = None
            target = final["ends_at"]
        self._bump(target)

    def _sync(self, token, msg):
        if set(msg) != {"t", "down"} or type(msg.get("down")) is not bool:
            return [self.fx("invalid", to=token, msg="Malformed sync input")]
        if self.phase != "final_sync":
            return [self.fx("invalid", to=token, msg="Sync is not open")]
        if token not in self.g["order"] or token not in self.players:
            return [self.fx("invalid", to=token, msg="You are not on this crew")]
        final = self.g["final"]
        down = msg["down"]
        currently = token in final["held"]
        if currently == down:
            return []
        self.seq += 1
        if down:
            final["held"].add(token)
        else:
            final["held"].discard(token)
            final["auto"].discard(token)
        self._arm_final()
        return [self.fx("sync", pid=self.players[token].pid, down=down)]

    # ---------------- disconnect / reconnect ---------------------------

    def game_player_left(self, token):
        if self.g is None or token not in self.g["order"]:
            return []
        if self.phase == "crisis":
            fx = self._engage_autopilot(token)
            if len(self.g["inputs"]) == len(ROLE_IDS):
                fx.extend(self._resolve_crisis())
            return fx
        if self.phase == "final_sync":
            final = self.g["final"]
            final["held"].add(token)
            final["auto"].add(token)
            self._arm_final()
            return [self.fx(
                "sync_autopilot", pid=self.players[token].pid)]
        return []

    def game_player_back(self, token):
        if self.g is None or token not in self.g["order"]:
            return []
        player = self.players[token]
        if self.phase == "final_sync" and token in self.g["final"]["auto"]:
            self.g["final"]["held"].discard(token)
            self.g["final"]["auto"].discard(token)
            self._arm_final()
        roles = ", ".join(
            ROLE_BY_ID[role_id]["title"]
            for role_id in self.g["roles_by_token"][token])
        return [self.fx(
            "toast", to=token,
            msg="Welcome back, %s — %s online" % (player.name, roles))]

    # ---------------- finish / public state ----------------------------

    def _commendation(self, token):
        roles = self.g["roles_by_token"][token]
        if len(roles) > 1:
            titles = " + ".join(ROLE_BY_ID[role_id]["title"] for role_id in roles)
            return "%s DUAL ACE" % titles
        return {
            "helm": "VECTOR VIRTUOSO",
            "core": "POWER KEEPER",
            "relay": "SIGNAL SLEUTH",
            "life": "CREW GUARDIAN",
            "ops": "MISSION WEAVER",
        }[roles[0]]

    def _finish(self, synchronized):
        if self.phase != "final_sync":
            return []
        return self._complete_mission(bool(synchronized), destroyed=False)

    def _finish_destroyed(self):
        if self.phase != "resolution" or self.g["integrity"] > 0:
            return []
        return self._complete_mission(False, destroyed=True)

    def _complete_mission(self, synchronized, destroyed):
        """Build one safe cooperative result for finale and integrity endings."""
        g = self.g
        if g["final"] is not None:
            g["final"]["synchronized"] = bool(synchronized)
        won = bool(synchronized and not destroyed and g["integrity"] > 0)
        crew = []
        for token in g["order"]:
            player = self.players[token]
            stats = g["stats"][token]
            crew.append({
                "pid": player.pid,
                "name": player.name,
                "avatar": player.avatar,
                "color": player.color,
                "pfp": player.pfp,
                "roles": [
                    role_public(role_id)
                    for role_id in g["roles_by_token"][token]
                ],
                "systems_stabilized": stats["systems_stabilized"],
                "signals_carried": stats["signals_carried"],
                "adjustments": stats["adjustments"],
                "steady_crises": stats["steady_crises"],
                "commendation": self._commendation(token),
            })
        score = (
            sum(row["systems_stabilized"] for row in crew) * 100
            + g["crises_cleared"] * 250
            + g["integrity"] * 200
            + (500 if synchronized else 0)
        )
        if won:
            title = "THE FIFTH SIGNAL IS LIVE"
            message = "Every station answered. The crew brought the signal home."
        elif destroyed:
            title = "STATION LOST — CREW TOGETHER"
            message = (
                "The station could not survive the cascade. Every crew record "
                "was recovered, and the next mission will tell a new story."
            )
        elif synchronized:
            title = "SIGNAL SENT"
            message = (
                "The crew synchronized perfectly, but the station had taken "
                "too much damage. Next transmission, we bring everyone home."
            )
        else:
            title = "SIGNAL INTERRUPTED"
            message = (
                "The station missed the final lock. Your crew map is intact "
                "and the next transmission will be different."
            )
        g["result"] = {
            "won": won,
            "title": title,
            "message": message,
            "score": score,
            "difficulty": g["difficulty"],
            "length": g["length"],
            "crises_cleared": g["crises_cleared"],
            "integrity": g["integrity"],
            "sync_complete": bool(synchronized),
            "destroyed": bool(destroyed),
            "crew": crew,
        }
        return self.end_game()

    def _crisis_public(self):
        if self.g["scenario"] is None:
            return None
        scenario = self.g["scenario"]
        frame = scenario["frame"]
        return {
            "id": scenario["signature"][:12],
            "title": frame["title"],
            "alert": frame["alert"],
            "system": frame["system"],
            "icon": frame["icon"],
        }

    def _roster(self):
        g = self.g
        rows = []
        for token in g["order"]:
            player = self.players[token]
            owned = g["roles_by_token"][token]
            rows.append({
                "pid": player.pid,
                "name": player.name,
                "avatar": player.avatar,
                "color": player.color,
                "pfp": player.pfp,
                "connected": player.connected,
                "roles": [role_public(role_id) for role_id in owned],
                "ready": (
                    self.phase in ("resolution", "final_sync", "game_end")
                    or all(role_id in g["inputs"] for role_id in owned)
                ),
            })
        return rows

    def _private_console(self, viewer_token, role_id):
        g = self.g
        task = g["scenario"]["tasks"][role_id]
        return {
            "role": role_id,
            "title": ROLE_BY_ID[role_id]["title"],
            "icon": ROLE_BY_ID[role_id]["icon"],
            "kind": task["kind"],
            "prompt": task["prompt"],
            "spec": copy.deepcopy(task["spec"]),
            "value": copy.deepcopy(g["inputs"].get(role_id)),
            "submitted": role_id in g["inputs"],
            "autopilot": role_id in g["autopilot_roles"],
            # This is the one sanctioned solution crossing: it belongs to a
            # different human's role and only exists in this viewer's payload.
            "relay": copy.deepcopy(g["relays"][role_id]),
        }

    def _backup_relay_assignments(self):
        """Derive live clue failover without persisting or exposing tokens.

        If a clue holder drops while its target console is still waiting, the
        clue moves to the least-loaded connected crewmate who is not the target
        owner. With only that owner left, self-delivery is the safe fallback:
        preserving a playable mission beats secrecy after two device losses.
        """
        g = self.g
        assignments = {token: [] for token in g["order"]}
        if self.phase != "crisis":
            return assignments
        connected = [
            token for token in g["order"]
            if token in self.players and self.players[token].connected
        ]
        load = {token: 0 for token in connected}
        order_index = {token: index for index, token in enumerate(g["order"])}
        for holder_role in ROLE_IDS:
            holder_owner = g["owners"][holder_role]
            holder = self.players.get(holder_owner)
            relay = g["relays"][holder_role]
            target_role = relay["target_role"]
            target_owner = g["owners"][target_role]
            target = self.players.get(target_owner)
            if holder is not None and holder.connected:
                continue
            if target_role in g["inputs"]:
                continue
            if target is None or not target.connected:
                continue
            candidates = [token for token in connected if token != target_owner]
            if not candidates:
                candidates = [target_owner]
            chosen = min(
                candidates,
                key=lambda token: (
                    load[token],
                    len(g["roles_by_token"][token]),
                    order_index[token],
                ),
            )
            backup = copy.deepcopy(relay)
            backup.update({
                "source_role": holder_role,
                "source_title": ROLE_BY_ID[holder_role]["title"],
                "source_icon": ROLE_BY_ID[holder_role]["icon"],
                "backup": True,
            })
            assignments[chosen].append(backup)
            load[chosen] += 1
        return assignments

    def game_state(self, viewer_token):
        """Build a fresh viewer-specific payload without mutating game state."""
        g = self.g
        if g is None:
            return None
        ready = len(g["inputs"]) if self.phase in ("crisis", "resolution") else 0
        me = None
        if viewer_token in g["order"] and viewer_token in self.players:
            role_ids = g["roles_by_token"][viewer_token]
            consoles = []
            if self.phase in ("crisis", "resolution"):
                consoles = [
                    self._private_console(viewer_token, role_id)
                    for role_id in role_ids
                ]
            me = {
                "pid": self.players[viewer_token].pid,
                "roles": [role_public(role_id) for role_id in role_ids],
                "consoles": consoles,
                "backup_relays": copy.deepcopy(
                    self._backup_relay_assignments().get(viewer_token, [])),
            }

        resolution = None
        if g["resolution"] is not None:
            resolution = copy.deepcopy(g["resolution"])

        final_public = None
        if g["final"] is not None:
            held = [
                self.players[token].pid for token in g["order"]
                if token in g["final"]["held"] and token in self.players
            ]
            final_public = {
                "held": held,
                "needed": len(g["order"]),
                "holding": g["final"]["hold_started"] is not None,
                "hold_ms": int(SYNC_HOLD_SECONDS * 1000),
                "synchronized": bool(g["final"]["synchronized"]),
            }

        return {
            "kind": "fifthsignal",
            "stage": self.phase,
            "round": g["round"],
            "rounds": g["rounds"],
            "difficulty": g["difficulty"],
            "integrity": g["integrity"],
            "integrity_max": g["integrity_max"],
            "crisis": self._crisis_public()
            if self.phase not in ("final_sync", "game_end") else None,
            "progress": {
                "ready": ready,
                "total": len(ROLE_IDS),
                "systems": [
                    {
                        "role": role_id,
                        "ready": role_id in g["inputs"],
                        "autopilot": role_id in g["autopilot_roles"],
                    }
                    for role_id in ROLE_IDS
                ],
            },
            "roster": self._roster(),
            "me": me,
            "resolution": resolution,
            "final": final_public,
            "result": copy.deepcopy(g["result"]),
        }

    def to_lobby(self):
        fx = super().to_lobby()
        self.g = None
        return fx


__all__ = [
    "FifthSignalSession",
    "LENGTHS",
    "DIFFICULTIES",
    "BRIEFING_SECONDS",
    "RESOLUTION_SECONDS",
    "FINAL_SECONDS",
    "SYNC_HOLD_SECONDS",
    "CONTROL_KINDS",
]
