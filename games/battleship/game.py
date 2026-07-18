"""BATTLESHIP FFA — hidden fleets, everyone fires at everyone.

2-6 combatants (humans + bots fill to the chosen total). Each player
secretly places a fleet, then turns rotate through the LIVING players:
pick a victim, call a cell, FIRE — exactly one shot per turn, which keeps
the free-for-all fair. Every shot result is PUBLIC knowledge: each board
shows the union of everything anyone has fired at that player, so the
whole room shares reconnaissance (and the bots read it too). Ship
positions stay secret server-side until they're hit/sunk. Last fleet
afloat wins.

Phases: placement -> battle -> resolve (a short beat so every phone sees
the splash) -> battle -> ... -> game_end.

Timeout/disconnect = autopilot: the gunner fires for that player. A
player who times out is flagged AFK and their LATER turns run at bot
speed until they act again — a battleship match is 30-50 rounds, and a
20s crawl for every absent turn would strangle the table.
"""

from __future__ import annotations

import time

from core.session import GameSession
from games.battleship.bots import make_bot

PLACE_SECONDS = 60
RESOLVE_SECONDS = 1.8
MAX_SEATS = 6
BOT_NAMES = ["SONAR", "TORPEDO", "KRAKEN", "MAKO", "PERISCOPE"]

BOARDS = {
    "classic": {"n": 10, "fleet": [("CARRIER", 5), ("BATTLESHIP", 4),
                                   ("CRUISER", 3), ("SUBMARINE", 3),
                                   ("DESTROYER", 2)]},
    "quick": {"n": 8, "fleet": [("BATTLESHIP", 4), ("CRUISER", 3),
                                ("SUBMARINE", 3), ("DESTROYER", 2)]},
}


def cell_label(r, c):
    """(1, 3) -> 'B4' — rows are letters, columns are 1-based numbers."""
    return "%s%d" % (chr(ord("A") + r), c + 1)


def ship_cells(r, c, size, d):
    if d == "h":
        return [(r, c + i) for i in range(size)]
    return [(r + i, c) for i in range(size)]


def place_ok(n, ships, sid, cells):
    """Bounds + no overlap with the OTHER placed ships of this fleet."""
    for (r, c) in cells:
        if not (0 <= r < n and 0 <= c < n):
            return False
    taken = set()
    for i, sh in enumerate(ships):
        if i == sid or sh["cells"] is None:
            continue
        taken.update(sh["cells"])
    return not any(cell in taken for cell in cells)


def _new_fleet(fleet_spec):
    return [{"name": nm, "size": sz, "cells": None, "dir": "h", "sunk": False}
            for nm, sz in fleet_spec]


def random_fleet(rng, n, fleet_spec):
    """A full random legal layout. Deterministic under the injected rng."""
    for _attempt in range(200):
        ships = _new_fleet(fleet_spec)
        done = True
        for sid, sh in enumerate(ships):
            for _try in range(200):
                d = "h" if rng.random() < 0.5 else "v"
                cells = ship_cells(rng.randrange(n), rng.randrange(n),
                                   sh["size"], d)
                if place_ok(n, ships, sid, cells):
                    sh["cells"], sh["dir"] = cells, d
                    break
            else:
                done = False
                break
        if done:
            return ships
    raise RuntimeError("random_fleet could not lay out a fleet")


class BattleshipSession(GameSession):
    MIN_PLAYERS = 1                # solo human gets bot opponents
    MAX_HUMANS = 6
    DEFAULT_SETTINGS = {
        "board": "classic",        # "classic" 10x10 [5,4,3,3,2] | "quick" 8x8
        "bot_players": 1,          # fills toward the chosen total
        "difficulty": "sharp",     # "sharp" | "rookie"
        "turn_seconds": 20,        # 20 | 40 | 0 (0 = no timer)
    }

    def __init__(self, rng=None):
        super().__init__(rng)
        self.g = None

    # ---------------- settings ----------------

    def validate_settings(self, patch):
        ok = {}
        if patch.get("board") in BOARDS:
            ok["board"] = patch["board"]
        b = patch.get("bot_players")
        if isinstance(b, int) and not isinstance(b, bool) and 0 <= b <= 5:
            ok["bot_players"] = b
        if patch.get("difficulty") in ("sharp", "rookie"):
            ok["difficulty"] = patch["difficulty"]
        ts = patch.get("turn_seconds")
        if isinstance(ts, int) and not isinstance(ts, bool) and ts in (20, 40, 0):
            ok["turn_seconds"] = ts
        return ok

    # ---------------- lifecycle ----------------

    def game_start(self):
        humans = self.participants[:MAX_SEATS]
        benched = self.participants[MAX_SEATS:]
        self.participants = list(humans)
        fx = [self.fx("toast", to=t, icon="🪑",
                      msg="Six fleets max — you're watching this one")
              for t in benched]
        want = self.settings["bot_players"]
        if len(humans) == 1 and want == 0:
            want = 1                       # someone has to get torpedoed
        bots = {}
        for i in range(min(want, MAX_SEATS - len(humans))):
            bot = self.add_bot("BOT %s" % BOT_NAMES[i % len(BOT_NAMES)])
            self.participants.append(bot.token)
            bots[bot.token] = make_bot(self.settings["difficulty"], self.rng)
        spec = BOARDS[self.settings["board"]]
        order = list(self.participants)
        self.rng.shuffle(order)
        fleets = {}
        for tok in order:
            fleets[tok] = {
                "ships": _new_fleet(spec["fleet"]),
                "placed_ready": False,
                "shots": {},          # (r, c) -> True hit / False miss (union)
                "alive": True,
                "fired": 0, "hits": 0, "sunk_dealt": 0,
            }
        self.g = {
            "n": spec["n"],
            "fleet_spec": list(spec["fleet"]),
            "order": order,
            "bots": bots,
            "autopilot": make_bot("sharp", self.rng),   # timeouts/AFK/dropped
            "players": fleets,
            "turn_idx": 0,
            "afk": set(),
            "feed": [],
            "elim": [],               # tokens in elimination order
            "result": None,
        }
        for tok in bots:              # bots deploy instantly
            fleets[tok]["ships"] = random_fleet(self.rng, spec["n"],
                                                spec["fleet"])
            fleets[tok]["placed_ready"] = True
        self.phase = "placement"
        self._bump(time.time() + PLACE_SECONDS)
        fx.append(self.fx("place_start", seconds=PLACE_SECONDS))
        fx.append(self.fx("toast", icon="⚓",
                          msg="Place your fleet — %ds" % PLACE_SECONDS))
        return fx

    # ---------------- helpers ----------------

    def _current(self):
        return self.g["order"][self.g["turn_idx"]]

    def _alive(self):
        return [t for t in self.g["order"] if self.g["players"][t]["alive"]]

    def _arm_turn(self):
        ts = self.settings["turn_seconds"]
        self._bump(time.time() + ts if ts else None)

    def _cells_left(self, tok):
        pd = self.g["players"][tok]
        total = 0
        for sh in pd["ships"]:
            if sh["cells"] is None:
                total += sh["size"]
            else:
                total += sum(1 for cell in sh["cells"]
                             if cell not in pd["shots"])
        return total

    def _ships_left(self, tok):
        return sum(1 for sh in self.g["players"][tok]["ships"]
                   if not sh["sunk"])

    def _is_auto(self, tok):
        p = self.players.get(tok)
        return p is None or p.is_bot or not p.connected or tok in self.g["afk"]

    def _name(self, tok):
        p = self.players.get(tok)
        return p.name if p else "?"

    def _feed(self, msg, k="info"):
        self.g["feed"].append({"msg": msg, "k": k})
        del self.g["feed"][:-30]

    # ---------------- actions ----------------

    def game_action(self, token, msg):
        self.seq += 1
        g = self.g
        if g is None or token not in g["players"]:
            return [self.fx("invalid", to=token, msg="You're watching this one")]
        g["afk"].discard(token)      # any action proves they're back
        t = msg.get("t")
        if t == "place":
            return self._do_place(token, msg)
        if t == "randomize":
            return self._do_randomize(token)
        if t == "place_ready":
            return self._do_place_ready(token)
        if t == "fire":
            return self._do_fire_msg(token, msg)
        return [self.fx("invalid", to=token, msg="Unknown action")]

    # ----- placement -----

    def _do_place(self, token, msg):
        if self.phase != "placement":
            return [self.fx("invalid", to=token, msg="Placement is over")]
        pd = self.g["players"][token]
        if pd["placed_ready"]:
            return [self.fx("invalid", to=token, msg="Fleet is locked in")]
        sid, r, c, d = (msg.get("ship"), msg.get("r"), msg.get("c"),
                        msg.get("dir"))
        ints = all(isinstance(v, int) and not isinstance(v, bool)
                   for v in (sid, r, c))
        if not ints or d not in ("h", "v") or not 0 <= sid < len(pd["ships"]):
            return [self.fx("invalid", to=token, msg="Bad placement")]
        sh = pd["ships"][sid]
        cells = ship_cells(r, c, sh["size"], d)
        if not place_ok(self.g["n"], pd["ships"], sid, cells):
            return [self.fx("invalid", to=token, msg="Doesn't fit there")]
        sh["cells"], sh["dir"] = cells, d
        return []

    def _do_randomize(self, token):
        if self.phase != "placement":
            return [self.fx("invalid", to=token, msg="Placement is over")]
        pd = self.g["players"][token]
        if pd["placed_ready"]:
            return [self.fx("invalid", to=token, msg="Fleet is locked in")]
        pd["ships"] = random_fleet(self.rng, self.g["n"], self.g["fleet_spec"])
        return []

    def _do_place_ready(self, token):
        if self.phase != "placement":
            return [self.fx("invalid", to=token, msg="Placement is over")]
        pd = self.g["players"][token]
        if pd["placed_ready"]:
            return []
        if any(sh["cells"] is None for sh in pd["ships"]):
            return [self.fx("invalid", to=token,
                            msg="Place your whole fleet first")]
        pd["placed_ready"] = True
        fx = [self.fx("toast", icon="⚓",
                      msg="%s is locked in" % self._name(token))]
        if all(self.g["players"][t]["placed_ready"] for t in self.participants):
            fx.extend(self._begin_battle())
        return fx

    def _fill_random(self, token):
        """Auto-place whatever a straggler left unplaced (keeps their picks)."""
        g = self.g
        pd = g["players"][token]
        for sid, sh in enumerate(pd["ships"]):
            if sh["cells"] is not None:
                continue
            for _try in range(500):
                d = "h" if self.rng.random() < 0.5 else "v"
                cells = ship_cells(self.rng.randrange(g["n"]),
                                   self.rng.randrange(g["n"]), sh["size"], d)
                if place_ok(g["n"], pd["ships"], sid, cells):
                    sh["cells"], sh["dir"] = cells, d
                    break
            else:   # boxed in by their own manual picks — redeploy everything
                pd["ships"] = random_fleet(self.rng, g["n"], g["fleet_spec"])
                return

    def _begin_battle(self):
        g = self.g
        self.phase = "battle"
        self._arm_turn()
        self._feed("⚓ BATTLE STATIONS — fleets are set")
        p = self.players.get(self._current())
        return [self.fx("battle_start"),
                self.fx("turn", pid=p.pid if p else None)]

    # ----- battle -----

    def _do_fire_msg(self, token, msg):
        g = self.g
        if self.phase != "battle":
            return [self.fx("invalid", to=token, msg="Hold your fire")]
        if not g["players"][token]["alive"]:
            return [self.fx("invalid", to=token,
                            msg="Your fleet is sunk — spectating")]
        if token != self._current():
            return [self.fx("invalid", to=token, msg="Not your turn")]
        target = self.by_pid(msg.get("target"))
        ttok = target.token if target else None
        if ttok is None or ttok not in g["players"]:
            return [self.fx("invalid", to=token, msg="Pick a target")]
        if ttok == token:
            return [self.fx("invalid", to=token,
                            msg="Not your own fleet, captain")]
        if not g["players"][ttok]["alive"]:
            return [self.fx("invalid", to=token, msg="That fleet is already gone")]
        r, c = msg.get("r"), msg.get("c")
        if not all(isinstance(v, int) and not isinstance(v, bool)
                   for v in (r, c)) or not (0 <= r < g["n"] and 0 <= c < g["n"]):
            return [self.fx("invalid", to=token, msg="Bad coordinates")]
        if (r, c) in g["players"][ttok]["shots"]:
            return [self.fx("invalid", to=token,
                            msg="%s was already shot" % cell_label(r, c))]
        return self._resolve_fire(token, ttok, r, c)

    def _resolve_fire(self, token, ttok, r, c):
        """The shot is pre-validated. Resolve, feed, fx, advance/finish."""
        g = self.g
        tp = g["players"][ttok]
        me = g["players"][token]
        me["fired"] += 1
        hit_ship = None
        for sh in tp["ships"]:
            if sh["cells"] and (r, c) in sh["cells"]:
                hit_ship = sh
                break
        tp["shots"][(r, c)] = hit_ship is not None
        label = cell_label(r, c)
        sname, tname = self._name(token), self._name(ttok)
        sunk = None
        eliminated = None
        fx = []
        if hit_ship is None:
            self._feed("%s missed %s at %s" % (sname, tname, label), "miss")
        else:
            me["hits"] += 1
            self._feed("%s hit %s at %s 💥" % (sname, tname, label), "hit")
            if all(cell in tp["shots"] for cell in hit_ship["cells"]):
                hit_ship["sunk"] = True
                me["sunk_dealt"] += 1
                sunk = {"name": hit_ship["name"], "size": hit_ship["size"],
                        "cells": [list(cell) for cell in hit_ship["cells"]]}
                self._feed("%s SUNK %s's %s!" % (sname, tname,
                                                 hit_ship["name"]), "sunk")
                if all(sh["sunk"] for sh in tp["ships"]):
                    tp["alive"] = False
                    g["elim"].append(ttok)
                    tpl = self.players.get(ttok)
                    eliminated = tpl.pid if tpl else None
                    self._feed("☠️ %s's fleet is destroyed!" % tname, "elim")
                    fx.append(self.fx("toast", icon="☠️",
                                      msg="%s's fleet is destroyed!" % tname))
        shooter = self.players.get(token)
        tplayer = self.players.get(ttok)
        fx.insert(0, self.fx(
            "shot",
            shooter=shooter.pid if shooter else None,
            target=tplayer.pid if tplayer else None,
            r=r, c=c, label=label,
            result="hit" if hit_ship else "miss",
            sunk=sunk, eliminated=eliminated))
        if len(self._alive()) <= 1:
            fx.extend(self._finish())
            return fx
        self.phase = "resolve"
        self._bump(time.time() + RESOLVE_SECONDS)
        return fx

    def _advance(self):
        g = self.g
        for _ in range(len(g["order"])):
            g["turn_idx"] = (g["turn_idx"] + 1) % len(g["order"])
            if g["players"][self._current()]["alive"]:
                break
        self.phase = "battle"
        self._arm_turn()
        p = self.players.get(self._current())
        return [self.fx("turn", pid=p.pid if p else None)]

    def _finish(self):
        g = self.g
        rows = sorted(g["order"], key=lambda tk: (
            1 if g["players"][tk]["alive"] else 0,
            g["elim"].index(tk) if tk in g["elim"] else 10 ** 6,
            self._cells_left(tk),
            g["players"][tk]["hits"],
        ), reverse=True)
        standings = []
        for i, tk in enumerate(rows):
            pd = g["players"][tk]
            p = self.players.get(tk)
            standings.append({
                "place": i + 1,
                "pid": p.pid if p else None,
                "alive": pd["alive"],
                "cells_left": self._cells_left(tk),
                "ships_left": self._ships_left(tk),
                "shots": pd["fired"],
                "hits": pd["hits"],
                "sunk": pd["sunk_dealt"],
            })
        g["result"] = {"winner": standings[0]["pid"], "standings": standings}
        winner_name = self._name(rows[0])
        self._feed("👑 %s rules the seas" % winner_name, "win")
        fx = [self.fx("game_over", winner=standings[0]["pid"])]
        fx.extend(self.end_game())
        return fx

    # ---------------- timers & bots ----------------

    def game_tick(self):
        g = self.g
        if g is None:
            return []
        if self.phase == "placement":
            fx = []
            for tok in self.participants:
                pd = g["players"][tok]
                if pd["placed_ready"]:
                    continue
                self._fill_random(tok)
                pd["placed_ready"] = True
                p = self.players.get(tok)
                if p and not p.is_bot:
                    fx.append(self.fx("toast", icon="⚓",
                                      msg="%s ran out of time — fleet "
                                          "auto-deployed" % p.name))
            fx.extend(self._begin_battle())
            return fx
        if self.phase == "resolve":
            return self._advance()
        if self.phase != "battle":
            return []
        token = self._current()
        p = self.players.get(token)
        fx = []
        if p is not None and not p.is_bot and p.connected \
                and token not in g["afk"]:
            fx.append(self.fx("toast", icon="⏱",
                              msg="%s took too long — the gunner fires"
                                  % p.name))
        if p is not None and not p.is_bot:
            g["afk"].add(token)      # later turns run at bot speed
        fx.extend(self._auto_fire(token))
        return fx

    def _bot_view(self, token):
        g = self.g
        victims = []
        for t in g["order"]:
            if t == token or not g["players"][t]["alive"]:
                continue
            pd = g["players"][t]
            sunk_cells = set()
            remaining = []
            for sh in pd["ships"]:
                if sh["sunk"]:
                    sunk_cells.update(sh["cells"])
                else:
                    remaining.append(sh["size"])
            victims.append({
                "token": t,
                "cells_left": self._cells_left(t),
                "shots": dict(pd["shots"]),
                "sunk_cells": sunk_cells,
                "remaining_sizes": remaining,
            })
        return {"n": g["n"], "victims": victims}

    def _auto_fire(self, token):
        g = self.g
        view = self._bot_view(token)
        if not view["victims"]:
            return []
        bot = g["bots"].get(token, g["autopilot"])
        choice = bot.choose(view)
        ttok, cell = choice if choice else (None, None)
        legal = (ttok in g["players"] and ttok != token
                 and g["players"][ttok]["alive"] and cell is not None
                 and 0 <= cell[0] < g["n"] and 0 <= cell[1] < g["n"]
                 and cell not in g["players"][ttok]["shots"])
        if not legal:                 # safety net — must never wedge the game
            ttok = view["victims"][0]["token"]
            shots = g["players"][ttok]["shots"]
            cell = next((r, c) for r in range(g["n"]) for c in range(g["n"])
                        if (r, c) not in shots)
        return self._resolve_fire(token, ttok, cell[0], cell[1])

    def next_bot_action(self):
        if self.phase != "battle" or self.g is None:
            return None
        token = self._current()
        if self._is_auto(token):
            return (0.8 + self.rng.random() * 0.8, token)
        return None

    def run_bot(self, bot_token):
        if self.phase != "battle" or self.g is None:
            return []
        if self._current() != bot_token or not self._is_auto(bot_token):
            return []
        self.seq += 1
        return self._auto_fire(bot_token)

    # ---------------- connection events ----------------

    def game_player_left(self, token):
        if self.g and token in self.g["players"]:
            return [self.fx("toast", icon="🛰",
                            msg="%s dropped — autopilot mans the guns"
                                % self._name(token))]
        return []

    def game_player_back(self, token):
        if self.g and token in self.g["players"]:
            self.g["afk"].discard(token)
            p = self.players.get(token)
            return [self.fx("toast", icon=p.avatar if p else "⚓",
                            msg="%s is back at the helm" % self._name(token))]
        return []

    # ---------------- serialization ----------------

    def game_state(self, viewer_token):
        g = self.g
        if g is None:
            return None
        viewer_tok = viewer_token if viewer_token in g["players"] else None
        me = g["players"].get(viewer_tok)
        reveal_all = self.phase == "game_end" or \
            (me is not None and not me["alive"])
        cur = self._current()
        boards = []
        for tok in g["order"]:
            p = self.players.get(tok)
            pd = g["players"][tok]
            entry = {
                "pid": p.pid if p else None,
                "alive": pd["alive"],
                "ships_left": self._ships_left(tok),
                "cells_left": self._cells_left(tok),
                "shots": [[r, c, hit] for (r, c), hit
                          in sorted(pd["shots"].items())],
                "sunk": [{"name": sh["name"], "size": sh["size"],
                          "cells": [list(cell) for cell in sh["cells"]]}
                         for sh in pd["ships"] if sh["sunk"]],
                "auto": self._is_auto(tok),
                "fired": pd["fired"],
                "hits": pd["hits"],
            }
            if tok == viewer_tok or reveal_all:
                entry["ships"] = [
                    {"name": sh["name"], "size": sh["size"], "dir": sh["dir"],
                     "sunk": sh["sunk"],
                     "cells": [list(cell) for cell in sh["cells"]]
                     if sh["cells"] else None}
                    for sh in pd["ships"]]
            boards.append(entry)
        curp = self.players.get(cur)
        return {
            "kind": "battleship",
            "stage": self.phase,
            "n": g["n"],
            "fleet": [{"name": nm, "size": sz} for nm, sz in g["fleet_spec"]],
            "order": [self.players[t].pid for t in g["order"]
                      if t in self.players],
            "boards": boards,
            "turn": curp.pid if curp and self.phase in ("battle", "resolve")
                    else None,
            "your_turn": (viewer_tok == cur and self.phase == "battle"
                          and me is not None and me["alive"]),
            "turn_seconds": self.settings["turn_seconds"],
            "placement": {
                "ready": {self.players[t].pid: g["players"][t]["placed_ready"]
                          for t in g["order"] if t in self.players},
                "placed": {self.players[t].pid:
                           sum(1 for sh in g["players"][t]["ships"]
                               if sh["cells"] is not None)
                           for t in g["order"] if t in self.players},
            } if self.phase == "placement" else None,
            "feed": g["feed"][-8:],
            "result": g["result"],
        }
