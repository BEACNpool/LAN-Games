"""WEREWOLF — the app is the moderator for an in-person social-deduction night.

Everyone is physically in the same room; the phones hold the secrets. The
server deals hidden roles, stages the night (wolves -> seer -> doctor) with an
identical "the village sleeps" screen for everyone not acting, reveals the
dawn, then referees the day discussion and the vote.

ALL secrecy lives server-side in game_state(): an alive villager's payload
never carries another player's role, the seer's visions travel only in the
seer's payloads, and the vote tally stays server-side until the vote closes.
Dead players become ghosts and get the omniscient feed — that's the fun of
being dead. 5-10 humans, no bots (a bot can't lie to your face).
"""

from __future__ import annotations

import time

from core.session import GameSession

ROLE_SECONDS = 25          # face-down card, hold to peek; early out on all-ack
NIGHT_INTRO_SECONDS = 5    # "NIGHT FALLS" beat
WOLF_SECONDS = 25
SEER_SECONDS = 20
DOCTOR_SECONDS = 20
ACT_BEAT = 2.0             # blur between an actor's tap and the phase flip
SEER_BEAT = 3.0            # the seer needs a moment to read the vision
DAWN_SECONDS = 8
VOTE_SECONDS = 45
VERDICT_SECONDS = 8
FORFEIT_SECONDS = 60       # no connected wolf for this long -> village wins

ROLES = ("wolf", "seer", "doctor", "villager")


def role_plan(n):
    """player count -> (wolves, seers, doctors); the rest are villagers."""
    return (1 if n <= 6 else 2), 1, 1


class WerewolfSession(GameSession):
    MIN_PLAYERS = 5
    MAX_HUMANS = 10
    DEFAULT_SETTINGS = {"day_seconds": 180}    # 120 | 180 | 300

    def __init__(self, rng=None):
        super().__init__(rng)
        self.g = None

    def validate_settings(self, patch):
        ok = {}
        if patch.get("day_seconds") in (120, 180, 300):
            ok["day_seconds"] = patch["day_seconds"]
        return ok

    # ---------------- lifecycle ----------------

    def game_start(self):
        order = list(self.participants)
        deal = list(order)
        self.rng.shuffle(deal)
        n_wolves, _, _ = role_plan(len(deal))
        roles = {}
        for i, t in enumerate(deal):
            if i < n_wolves:
                roles[t] = "wolf"
            elif i == n_wolves:
                roles[t] = "seer"
            elif i == n_wolves + 1:
                roles[t] = "doctor"
            else:
                roles[t] = "villager"
        self.g = {
            "order": order,
            "roles": roles,               # token -> role; NEVER serialized raw
            "alive": set(order),
            "night_no": 0,
            "acks": set(),                # role-card confirmations
            "wolf_picks": {},             # wolf token -> victim token (live)
            "wolf_locks": set(),
            "seer_pick": None,
            "visions": [],                # [{night, target(token), wolf}]
            "doctor_pick": None,
            "night_kill": None,           # token the wolves settled on
            "dawn": None,                 # last dawn result (public)
            "day_ready": set(),
            "votes": {},                  # voter token -> target token (locked)
            "verdict": None,              # last vote result (public once closed)
            "log": [],                    # full history; public at game end
            "result": None,
            "wolf_gone_at": None,         # forfeit clock: no connected wolf
            "phase_ends": 0.0,            # authoritative end of current phase
            "armed": "phase",             # what the live deadline is armed for
        }
        self._enter("role", ROLE_SECONDS)
        return [self.fx("roles_dealt")]

    # ---- timers: (deadline, gen) armed for either the phase end or the
    # forfeit watch, whichever lands first. phase_ends stays authoritative. ----

    def _enter(self, phase, seconds):
        self.phase = phase
        self.g["phase_ends"] = time.time() + seconds
        self._arm()

    def _shorten(self, seconds):
        self.g["phase_ends"] = min(self.g["phase_ends"], time.time() + seconds)
        self._arm()

    def _arm(self):
        g = self.g
        target, kind = g["phase_ends"], "phase"
        if g["wolf_gone_at"] is not None:
            wt = g["wolf_gone_at"] + FORFEIT_SECONDS + 0.3
            if wt < target:
                target, kind = wt, "watch"
        g["armed"] = kind
        self._bump(target)

    def game_tick(self):
        g = self.g
        if g is None or self.phase == "game_end":
            return []
        fx = self._forfeit_check()
        if fx is not None:
            return fx
        if g["armed"] == "watch":       # forfeit watch fired but didn't trip
            self._arm()
            return []
        ph = self.phase
        if ph == "role":
            return self._night_falls()
        if ph == "night_intro":
            return self._enter_wolves()
        if ph == "night_wolf":
            return self._resolve_wolves()
        if ph == "night_seer":
            return self._enter_doctor()
        if ph == "night_doctor":
            return self._dawn()
        if ph == "dawn":
            return self._after_dawn()
        if ph == "day":
            return self._open_vote()
        if ph == "vote":
            return self._close_vote()
        if ph == "verdict":
            return self._after_verdict()
        return []

    def _forfeit_check(self):
        g = self.g
        if g["wolf_gone_at"] is None:
            return None
        wolves = self._alive_wolves()
        if any(t in self.players and self.players[t].connected for t in wolves):
            g["wolf_gone_at"] = None     # somebody came back meanwhile
            return None
        if time.time() - g["wolf_gone_at"] < FORFEIT_SECONDS - 0.5:
            return None
        fx = [self.fx("toast", icon="🐺",
                      msg="The wolves fled the village — VILLAGE WINS by forfeit")]
        fx.extend(self._finish("village", "forfeit"))
        return fx

    # ---------------- night ----------------

    def _night_falls(self):
        g = self.g
        g["night_no"] += 1
        g["acks"] = set()
        g["wolf_picks"], g["wolf_locks"] = {}, set()
        g["seer_pick"] = None
        g["doctor_pick"] = None
        g["night_kill"] = None
        g["dawn"] = None
        g["verdict"] = None
        g["day_ready"] = set()
        g["votes"] = {}
        self._enter("night_intro", NIGHT_INTRO_SECONDS)
        return [self.fx("night", night=g["night_no"])]

    def _enter_wolves(self):
        self._enter("night_wolf", WOLF_SECONDS)
        return [self.fx("wolves_wake")]

    def _resolve_wolves(self):
        g = self.g
        wolves = self._alive_wolves()
        # only CONNECTED wolves are at the table making the live decision — a
        # disconnected wolf's earlier tap must never override the connected
        # pack's confirmed kill (matches _maybe_advance's connected-only view)
        conn_wolves = [t for t in wolves
                       if t in self.players and self.players[t].connected]
        picks = [g["wolf_picks"][t] for t in conn_wolves if t in g["wolf_picks"]]
        picks = [t for t in picks if t in g["alive"]]
        fx = []
        if picks:
            g["night_kill"] = picks[0] if len(set(picks)) == 1 \
                else self.rng.choice(picks)
        else:
            targets = self._wolf_targets()
            if targets and conn_wolves:
                # they dawdled: the pack's hunger decides for them
                g["night_kill"] = self.rng.choice(targets)
                for t in conn_wolves:
                    fx.append(self.fx("dawdled", to=t))
            else:
                g["night_kill"] = None   # every wolf is gone; the role idles
        return fx + self._enter_seer()

    def _enter_seer(self):
        if self._role_holder("seer") is None:      # dead seer: skip the beat
            return self._enter_doctor()
        self._enter("night_seer", SEER_SECONDS)
        return []

    def _enter_doctor(self):
        if self._role_holder("doctor") is None:
            return self._dawn()
        self._enter("night_doctor", DOCTOR_SECONDS)
        return []

    def _dawn(self):
        g = self.g
        kill = g["night_kill"]
        saved = kill is not None and kill == g["doctor_pick"]
        died = None
        if kill is not None and not saved and kill in g["alive"]:
            g["alive"].discard(kill)
            died = kill
        g["dawn"] = {
            "night": g["night_no"],
            "died": self._pid(died),
            "name": self.players[died].name if died in self.players else None,
            "role": g["roles"].get(died) if died else None,
            "saved": saved,
        }
        g["log"].append({
            "type": "night", "n": g["night_no"],
            "target": self._pid(kill), "saved": saved,
            "died": self._pid(died),
            "died_role": g["roles"].get(died) if died else None,
            "seer": self._pid(g["seer_pick"]),
            "doctor": self._pid(g["doctor_pick"]),
        })
        self._enter("dawn", DAWN_SECONDS)
        return [self.fx("dawn", died=g["dawn"]["died"], role=g["dawn"]["role"],
                        saved=saved)]

    def _after_dawn(self):
        w = self._winner()
        if w:
            return self._finish(w, "parity" if w == "wolves" else "hunted")
        return self._enter_day()

    # ---------------- day ----------------

    def _enter_day(self):
        g = self.g
        g["day_ready"] = set()
        self._enter("day", self.settings["day_seconds"])
        return [self.fx("day", night=g["night_no"])]

    def _open_vote(self):
        g = self.g
        g["votes"] = {}
        self._enter("vote", VOTE_SECONDS)
        return [self.fx("vote_open")]

    def _close_vote(self):
        g = self.g
        alive_before = set(g["alive"])
        votes = {v: t for v, t in g["votes"].items()
                 if v in alive_before and t in alive_before}
        tally = {}
        for t in votes.values():
            tally[t] = tally.get(t, 0) + 1
        top = max(tally.values()) if tally else 0
        leaders = [t for t, n in tally.items() if n == top]
        eliminated = leaders[0] if top > 0 and len(leaders) == 1 else None
        role = None
        if eliminated is not None:
            g["alive"].discard(eliminated)
            role = g["roles"][eliminated]
        g["verdict"] = {
            "eliminated": self._pid(eliminated),
            "name": (self.players[eliminated].name
                     if eliminated in self.players else None),
            "role": role,
            "tie": eliminated is None and top > 0,
            "tally": {self._pid(t): n for t, n in tally.items()},
            "votes": {self._pid(v): self._pid(t) for v, t in votes.items()},
            "abstained": [self._pid(t) for t in g["order"]
                          if t in alive_before and t not in votes],
        }
        g["log"].append({
            "type": "day", "n": g["night_no"],
            "eliminated": self._pid(eliminated), "role": role,
            "tally": dict(g["verdict"]["tally"]),
            "abstained": len(g["verdict"]["abstained"]),
        })
        self._enter("verdict", VERDICT_SECONDS)
        return [self.fx("verdict", eliminated=g["verdict"]["eliminated"],
                        role=role, tie=g["verdict"]["tie"])]

    def _after_verdict(self):
        w = self._winner()
        if w:
            return self._finish(w, "parity" if w == "wolves" else "hunted")
        # voting out the last connected wolf leaves an alive-but-absent wolf;
        # start the forfeit clock so the village isn't stuck lynching an AFK
        self._check_wolf_forfeit()
        return self._night_falls()

    # ---------------- endings ----------------

    def _winner(self):
        g = self.g
        wolves = sum(1 for t in g["alive"] if g["roles"][t] == "wolf")
        if wolves == 0:
            return "village"
        if wolves >= len(g["alive"]) - wolves:
            return "wolves"
        return None

    def _finish(self, winner, reason):
        g = self.g
        rows = []
        for t in g["order"]:
            p = self.players.get(t)
            rows.append({"pid": p.pid if p else None,
                         "name": p.name if p else "?",
                         "role": g["roles"][t],
                         "alive": t in g["alive"]})
        wolf_side = winner == "wolves"
        g["result"] = {
            "winner": winner, "reason": reason, "nights": g["night_no"],
            "roles": rows,
            "winners": [r["pid"] for r in rows
                        if (r["role"] == "wolf") == wolf_side],
            "losers": [r["pid"] for r in rows
                       if (r["role"] == "wolf") != wolf_side],
            "log": list(g["log"]),
        }
        fx = [self.fx("game_over", winner=winner)]
        fx.extend(self.end_game())
        return fx

    # ---------------- actions ----------------

    def game_action(self, token, msg):
        self.seq += 1
        g = self.g
        if g is None or self.phase == "game_end":
            return [self.fx("invalid", to=token, msg="Nothing to do right now")]
        if token not in self.participants:
            return [self.fx("invalid", to=token, msg="You're watching this one")]
        t = msg.get("t")
        if t == "role_ack" and self.phase == "role":
            return self._do_role_ack(token)
        if t == "wolf_pick" and self.phase == "night_wolf":
            return self._do_wolf_pick(token, msg.get("pid"))
        if t == "wolf_lock" and self.phase == "night_wolf":
            return self._do_wolf_lock(token)
        if t == "seer_pick" and self.phase == "night_seer":
            return self._do_seer_pick(token, msg.get("pid"))
        if t == "doctor_pick" and self.phase == "night_doctor":
            return self._do_doctor_pick(token, msg.get("pid"))
        if t == "day_ready" and self.phase == "day":
            return self._do_day_ready(token)
        if t == "vote" and self.phase == "vote":
            return self._do_vote(token, msg.get("pid"))
        return [self.fx("invalid", to=token, msg="Not now")]

    def _need_alive(self, token, role=None):
        g = self.g
        if token not in g["alive"]:
            return [self.fx("invalid", to=token, msg="The dead don't act — enjoy the show")]
        if role is not None and g["roles"].get(token) != role:
            return [self.fx("invalid", to=token, msg="That's not your part to play")]
        return None

    def _do_role_ack(self, token):
        bad = self._need_alive(token)
        if bad:
            return bad
        self.g["acks"].add(token)
        return self._maybe_advance()

    def _do_wolf_pick(self, token, pid):
        bad = self._need_alive(token, "wolf")
        if bad:
            return bad
        g = self.g
        target = self.by_pid(pid)
        if (target is None or target.token not in g["alive"]
                or g["roles"].get(target.token) == "wolf"):
            return [self.fx("invalid", to=token, msg="Pick a living villager")]
        g["wolf_picks"][token] = target.token
        g["wolf_locks"].discard(token)     # changing your mind unlocks you
        return []

    def _do_wolf_lock(self, token):
        bad = self._need_alive(token, "wolf")
        if bad:
            return bad
        g = self.g
        if token not in g["wolf_picks"]:
            return [self.fx("invalid", to=token, msg="Mark a victim first")]
        g["wolf_locks"].add(token)
        return self._maybe_advance()

    def _do_seer_pick(self, token, pid):
        bad = self._need_alive(token, "seer")
        if bad:
            return bad
        g = self.g
        if g["seer_pick"] is not None:
            return [self.fx("invalid", to=token, msg="One vision per night")]
        target = self.by_pid(pid)
        if target is None or target.token not in g["alive"]:
            return [self.fx("invalid", to=token, msg="Pick a living player")]
        if target.token == token:
            return [self.fx("invalid", to=token, msg="You already know your own soul")]
        g["seer_pick"] = target.token
        is_wolf = g["roles"][target.token] == "wolf"
        g["visions"].append({"night": g["night_no"], "target": target.token,
                             "wolf": is_wolf})
        self._shorten(SEER_BEAT)
        return [self.fx("vision", to=token, pid=target.pid, wolf=is_wolf)]

    def _do_doctor_pick(self, token, pid):
        bad = self._need_alive(token, "doctor")
        if bad:
            return bad
        g = self.g
        if g["doctor_pick"] is not None:
            return [self.fx("invalid", to=token, msg="Your rounds are done for tonight")]
        target = self.by_pid(pid)     # self allowed; repeats allowed
        if target is None or target.token not in g["alive"]:
            return [self.fx("invalid", to=token, msg="Pick a living player")]
        g["doctor_pick"] = target.token
        self._shorten(ACT_BEAT)
        return [self.fx("protected", to=token, pid=target.pid)]

    def _do_day_ready(self, token):
        bad = self._need_alive(token)
        if bad:
            return bad
        g = self.g
        if token in g["day_ready"]:
            return []
        g["day_ready"].add(token)
        fx = [self.fx("ready_vote", pid=self.players[token].pid)]
        return fx + self._maybe_advance()

    def _do_vote(self, token, pid):
        bad = self._need_alive(token)
        if bad:
            return bad
        g = self.g
        if token in g["votes"]:
            return [self.fx("invalid", to=token, msg="Your vote is locked")]
        target = self.by_pid(pid)
        if target is None or target.token not in g["alive"]:
            return [self.fx("invalid", to=token, msg="Vote for a living player")]
        g["votes"][token] = target.token
        fx = [self.fx("voted", pid=self.players[token].pid)]
        return fx + self._maybe_advance()

    def _maybe_advance(self):
        """Early phase-outs when every relevant connected player has acted."""
        g = self.g
        ph = self.phase
        alive_conn = [t for t in g["alive"]
                      if t in self.players and self.players[t].connected]
        if ph == "role":
            if alive_conn and all(t in g["acks"] for t in alive_conn):
                return self._night_falls()
        elif ph == "day":
            if alive_conn and all(t in g["day_ready"] for t in alive_conn):
                return self._open_vote()
        elif ph == "vote":
            if alive_conn and all(t in g["votes"] for t in alive_conn):
                return self._close_vote()
        elif ph == "night_wolf":
            wolves_conn = [t for t in self._alive_wolves()
                           if t in self.players and self.players[t].connected]
            if wolves_conn and all(t in g["wolf_locks"] for t in wolves_conn):
                picks = {g["wolf_picks"].get(t) for t in wolves_conn}
                if len(picks) == 1 and None not in picks:
                    self._shorten(ACT_BEAT)   # the pack agreed — dawn nears
        return []

    # ---------------- connection events ----------------

    def game_player_left(self, token):
        g = self.g
        if g is None or self.phase == "game_end":
            return []
        fx = []
        p = self.players.get(token)
        if p and token in g["alive"]:
            fx.append(self.fx("toast", icon="📵",
                              msg="%s's phone went dark" % p.name))
        self._check_wolf_forfeit()
        fx.extend(self._maybe_advance())
        return fx

    def game_player_back(self, token):
        g = self.g
        if g is None or self.phase == "game_end":
            return []
        fx = []
        p = self.players.get(token)
        if p and token in self.participants:
            fx.append(self.fx("toast", icon="🔦", msg="%s is back" % p.name))
        if (g["wolf_gone_at"] is not None
                and g["roles"].get(token) == "wolf" and token in g["alive"]):
            g["wolf_gone_at"] = None
            self._arm()                  # restore the true phase deadline
        return fx

    # ---------------- helpers ----------------

    def _pid(self, token):
        p = self.players.get(token) if token else None
        return p.pid if p else None

    def _check_wolf_forfeit(self):
        """Arm the 60s forfeit clock when wolves are alive but none are
        connected (idempotent — never resets an already-running clock).
        Called on disconnect and after any alive-wolf change (vote-out)."""
        g = self.g
        if self.phase == "game_end" or g["wolf_gone_at"] is not None:
            return
        wolves = self._alive_wolves()
        if wolves and not any(t in self.players and self.players[t].connected
                              for t in wolves):
            g["wolf_gone_at"] = time.time()
            self._arm()

    def _alive_wolves(self):
        g = self.g
        return [t for t in g["order"]
                if t in g["alive"] and g["roles"][t] == "wolf"]

    def _wolf_targets(self):
        g = self.g
        return [t for t in g["order"]
                if t in g["alive"] and g["roles"][t] != "wolf"]

    def _role_holder(self, role):
        g = self.g
        for t in g["order"]:
            if t in g["alive"] and g["roles"][t] == role:
                return t
        return None

    # ---------------- serialization (ALL secrecy lives here) ----------------

    def game_state(self, viewer_token):
        g = self.g
        if g is None:
            return None
        ph = self.phase
        alive_pids = [self.players[t].pid for t in g["order"]
                      if t in g["alive"] and t in self.players]
        n_wolves, _, _ = role_plan(len(g["order"]))
        st = {
            "kind": "werewolf",
            "stage": ph,
            "night_no": g["night_no"],
            "ends": int(g["phase_ends"] * 1000),
            "alive": alive_pids,
            "wolves_total": n_wolves,
            "wolves_alive": sum(1 for t in g["alive"]
                                if g["roles"][t] == "wolf"),
            "acked": [self._pid(t) for t in g["order"] if t in g["acks"]]
                     if ph == "role" else None,
            "ready_pids": [self._pid(t) for t in g["order"]
                           if t in g["day_ready"]] if ph == "day" else None,
            "voted_pids": [self._pid(t) for t in g["order"]
                           if t in g["votes"]] if ph == "vote" else None,
            "dawn": dict(g["dawn"]) if g["dawn"] else None,
            "verdict": dict(g["verdict"]) if g["verdict"] else None,
            "me": None,
            "act": None,
            "omni": None,
            "result": g["result"] if ph == "game_end" else None,
        }
        t = viewer_token
        if t not in self.participants or t not in g["roles"]:
            return st        # spectators & mid-game joiners see PUBLIC only
        role = g["roles"][t]
        alive = t in g["alive"]
        me = {"pid": self._pid(t), "role": role, "alive": alive,
              "ghost": not alive}
        if role == "wolf":
            me["partners"] = [self._pid(w) for w in g["order"]
                              if g["roles"][w] == "wolf" and w != t]
        if role == "seer":
            me["visions"] = [{"night": v["night"],
                              "pid": self._pid(v["target"]),
                              "wolf": v["wolf"]} for v in g["visions"]]
        st["me"] = me
        if alive:
            st["act"] = self._act_block(t, role)
        else:
            st["omni"] = self._omni_block()
        return st

    def _act_block(self, t, role):
        g = self.g
        ph = self.phase
        if ph == "role":
            return {"type": "role", "acked": t in g["acks"]}
        if ph == "night_wolf" and role == "wolf":
            return {
                "type": "wolf",
                "targets": [self._pid(x) for x in self._wolf_targets()],
                "picks": {self._pid(w): self._pid(x)
                          for w, x in g["wolf_picks"].items()},
                "locks": [self._pid(w) for w in g["order"]
                          if w in g["wolf_locks"]],
            }
        if ph == "night_seer" and role == "seer":
            return {"type": "seer",
                    "targets": [p for p in
                                (self._pid(x) for x in g["order"]
                                 if x in g["alive"]) if p != self._pid(t)],
                    "pick": self._pid(g["seer_pick"]),
                    "done": g["seer_pick"] is not None}
        if ph == "night_doctor" and role == "doctor":
            return {"type": "doctor",
                    "targets": [self._pid(x) for x in g["order"]
                                if x in g["alive"]],
                    "pick": self._pid(g["doctor_pick"])}
        if ph == "day":
            return {"type": "day", "ready": t in g["day_ready"]}
        if ph == "vote":
            return {"type": "vote",
                    "targets": [self._pid(x) for x in g["order"]
                                if x in g["alive"]],
                    "vote": self._pid(g["votes"].get(t))}
        return None

    def _omni_block(self):
        """Ghost eyes: dead participants see everything, live."""
        g = self.g
        return {
            "roles": {self._pid(t): r for t, r in g["roles"].items()},
            "wolf_picks": {self._pid(w): self._pid(x)
                           for w, x in g["wolf_picks"].items()},
            "seer_pick": self._pid(g["seer_pick"]),
            "doctor_pick": self._pid(g["doctor_pick"]),
            "night_kill": self._pid(g["night_kill"]),
            "visions": [{"night": v["night"], "pid": self._pid(v["target"]),
                         "wolf": v["wolf"]} for v in g["visions"]],
            "votes": {self._pid(v): self._pid(x)
                      for v, x in g["votes"].items()},
            "log": list(g["log"]),
        }
