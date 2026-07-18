"""FAB5 FEUD — a Family-Feud-style survey game for the fab5.games hub.

Two sides (SIDE_A / SIDE_B). One player per side = head-to-head; more = teams.
Each round:
  faceoff  -> both sides' reps race to answer; higher-ranked answer wins control
  choice   -> the winning side's captain PLAYs or PASSes control
  play     -> the controlling side answers in rotation; 3 strikes ends it
  steal    -> the other side gets ONE guess to steal the whole pot
  reveal   -> board fully revealed, pot (x round multiplier) awarded
Highest score after N rounds wins.

Teams are chosen in the lobby (tap A or B; auto-balanced otherwise), handled by
game_action even before the game starts, and surfaced in every state via the
`ff` block so the lobby can render the picker.
"""

from __future__ import annotations

import time

from core.session import GameSession
from games.fab5feud import surveys

SIDES = ("A", "B")
FACEOFF_SECONDS = 18
CHOICE_SECONDS = 14
TURN_SECONDS = 22
STEAL_SECONDS = 22
REVEAL_SECONDS = 7


class Fab5FeudSession(GameSession):
    MIN_PLAYERS = 2
    MAX_HUMANS = 10
    # mode: "teams" (two sides, split; 2v1 for odd) or "singles" (everyone for
    # themselves, the two face-off contestants rotate each round — best for odd)
    DEFAULT_SETTINGS = {"rounds": 3, "mode": "teams"}

    def __init__(self, rng=None, bank=None):
        super().__init__(rng)
        self.g = None
        self.teams: dict[str, str] = {}     # token -> "A"/"B" (lobby picks)
        self._bank = bank                   # injectable for tests

    # ---------------- settings ----------------

    def validate_settings(self, patch):
        ok = {}
        r = patch.get("rounds")
        if isinstance(r, int) and not isinstance(r, bool) and r in (3, 5, 7):
            ok["rounds"] = r
        if patch.get("mode") in ("teams", "singles"):
            ok["mode"] = patch["mode"]
        return ok

    # ---------------- teams ----------------

    def _humans_tokens(self):
        return [p.token for p in
                sorted(self.humans(), key=lambda q: q.joined_at)]

    def _ensure_teams(self, tokens):
        """Assign any unpicked token to the smaller side (stable, balanced)."""
        for t in tokens:
            if self.teams.get(t) not in SIDES:
                a = sum(1 for x in tokens if self.teams.get(x) == "A")
                b = sum(1 for x in tokens if self.teams.get(x) == "B")
                self.teams[t] = "A" if a <= b else "B"

    def _rosters(self, tokens):
        self._ensure_teams(tokens)
        r = {"A": [], "B": []}
        for t in tokens:                    # join order preserved
            r[self.teams[t]].append(t)
        return r

    def _side_name(self, roster, side):
        toks = roster[side]
        if len(toks) == 1:
            p = self.players.get(toks[0])
            return p.name if p else ("TEAM " + side)
        return "TEAM " + side

    # ---------------- lifecycle ----------------

    def game_start(self):
        toks = [t for t in self.participants]      # locked-in, join order
        bank = self._bank if self._bank is not None else surveys.load()
        mode = self.settings.get("mode", "teams")
        self.g = {
            "bank": bank, "mode": mode,
            "order": list(toks),                    # singles: face-off rotation
            "roster": None,                          # teams: fixed A/B rosters
            "scores": ({"A": 0, "B": 0} if mode == "teams"
                       else {t: 0 for t in toks}),
            "round_no": 0,
            "rounds_total": self.settings["rounds"],
            "used": set(),
            "round": None,
            "result": None,
        }
        if mode == "teams":
            roster = self._rosters(toks)
            if not roster["A"] or not roster["B"]:   # everyone piled onto one side
                for i, t in enumerate(toks):
                    self.teams[t] = SIDES[i % 2]
                roster = self._rosters(toks)
            self.g["roster"] = roster
            fx = [self.fx("toast", icon="📋", msg="%s  vs  %s"
                          % (self._side_name(roster, "A"), self._side_name(roster, "B")))]
        else:
            fx = [self.fx("toast", icon="🎯",
                          msg="%d players — free-for-all!" % len(toks))]
        fx.extend(self._start_round())
        return fx

    def _mult(self):
        # the final round is a double round
        return 2 if self.g["round_no"] >= self.g["rounds_total"] else 1

    def _pick_survey(self):
        bank = self.g["bank"]
        for _ in range(60):
            i = self.rng.randrange(len(bank))
            if i not in self.g["used"]:
                self.g["used"].add(i)
                return bank[i]
        return bank[self.rng.randrange(len(bank))]

    def _round_sides(self):
        """The two sides that face off THIS round. Teams: the fixed rosters.
        Singles: the next rotating pair of individual contestants."""
        g = self.g
        if g["mode"] == "teams":
            return {s: list(g["roster"][s]) for s in SIDES}
        order = g["order"]
        n = len(order)
        i = (g["round_no"] - 1) % n
        return {"A": [order[i]], "B": [order[(i + 1) % n]]}

    def _start_round(self):
        g = self.g
        g["round_no"] += 1
        s = self._pick_survey()
        sides = self._round_sides()
        names = {side: self._side_name(sides, side) for side in SIDES}
        idx = g["round_no"] - 1
        reps = {side: sides[side][idx % len(sides[side])] for side in SIDES}
        g["round"] = {
            "q": s["q"],
            "answers": [{"text": a["text"], "pts": a["pts"], "aliases": a["aliases"],
                         "revealed": False} for a in s["answers"]],
            "sides": sides,
            "names": names,
            "pot": 0,
            "strikes": 0,
            "control": None,
            "stage": "faceoff",
            "reps": reps,
            "faceoff": {"A": None, "B": None},   # {"guess","idx"} once answered
            "faceoff_order": [],
            "turn_order": [],
            "turn_idx": 0,
            "steal": None,
            "outcome": None,
        }
        self.phase = "faceoff"
        self._bump(time.time() + FACEOFF_SECONDS)
        return [self.fx("round_start", n=g["round_no"], total=g["rounds_total"],
                        mult=self._mult())]

    # ---------------- actions ----------------

    def game_action(self, token, msg):
        self.seq += 1
        t = msg.get("t")
        if t == "team":
            return self._set_team(token, msg.get("side"))
        if self.g is None:
            return [self.fx("invalid", to=token, msg="No game yet")]
        r = self.g["round"]
        if t == "guess":
            return self._guess(token, msg.get("word", ""), r)
        if t == "choice":
            return self._choice(token, bool(msg.get("play", True)), r)
        return [self.fx("invalid", to=token, msg="Unknown action")]

    def _set_team(self, token, side):
        if self.phase not in ("lobby", "countdown"):
            return [self.fx("invalid", to=token, msg="Teams are locked")]
        if side not in SIDES or token not in self.players or self.players[token].is_bot:
            return []
        self.teams[token] = side
        p = self.players[token]
        return [self.fx("toast", msg="%s joined Side %s" % (p.name, side), icon="🫱")]

    def _side_of(self, token):
        r = self.g["round"] if self.g else None
        if not r:
            return None
        for s in SIDES:
            if token in r["sides"][s]:
                return s
        return None

    def _other(self, side):
        return "B" if side == "A" else "A"

    def _clean_guess(self, word):
        return str(word or "").strip()

    def _guess(self, token, word, r):
        side = self._side_of(token)
        if side is None:
            return [self.fx("invalid", to=token, msg="You're watching this one")]
        word = self._clean_guess(word)
        if not word:
            return [self.fx("invalid", to=token, msg="Type an answer")]
        stage = r["stage"]
        if stage == "faceoff":
            return self._faceoff_guess(token, side, word, r)
        if stage == "play":
            return self._play_guess(token, side, word, r)
        if stage == "steal":
            return self._steal_guess(token, side, word, r)
        return [self.fx("invalid", to=token, msg="Not your turn")]

    # ---- faceoff ----

    def _faceoff_guess(self, token, side, word, r):
        if token != r["reps"][side]:
            return [self.fx("invalid", to=token, msg="Only the face-off player answers")]
        if r["faceoff"][side] is not None:
            return [self.fx("invalid", to=token, msg="You already answered")]
        idx = surveys.match_answer(word, r["answers"])
        r["faceoff"][side] = {"guess": word, "idx": idx}
        r["faceoff_order"].append(side)
        p = self.players[token]
        fx = [self.fx("buzz", pid=p.pid, side=side,
                      hit=idx is not None,
                      rank=(idx + 1) if idx is not None else None)]
        if r["faceoff"]["A"] is not None and r["faceoff"]["B"] is not None:
            fx.extend(self._resolve_faceoff(r))
        return fx

    def _resolve_faceoff(self, r):
        fa, fb = r["faceoff"]["A"], r["faceoff"]["B"]
        # each side's matched index (None = strike); lower index = better answer
        ia = fa["idx"] if fa else None
        ib = fb["idx"] if fb else None
        # reveal any matched face-off answers into the pot
        fx = []
        for side, f in (("A", fa), ("B", fb)):
            if f and f["idx"] is not None and not r["answers"][f["idx"]]["revealed"]:
                fx.extend(self._reveal(r, f["idx"]))
        # decide control
        if ia is None and ib is None:
            winner = r["faceoff_order"][0] if r["faceoff_order"] else "A"
        elif ib is None:
            winner = "A"
        elif ia is None:
            winner = "B"
        else:
            winner = "A" if ia <= ib else "B"
        r["control"] = winner
        r["stage"] = "choice"
        self.phase = "choice"
        self._bump(time.time() + CHOICE_SECONDS)
        fx.append(self.fx("faceoff_won", side=winner, name=r["names"][winner]))
        return fx

    # ---- choice ----

    def _choice(self, token, play, r):
        if r["stage"] != "choice" or self._side_of(token) != r["control"]:
            return [self.fx("invalid", to=token, msg="Not your call")]
        if token != r["sides"][r["control"]][0]:
            return [self.fx("invalid", to=token, msg="Only the captain decides")]
        return self._begin_play(r, play)

    def _begin_play(self, r, play):
        if not play:
            r["control"] = self._other(r["control"])
        ctrl = r["control"]
        r["turn_order"] = list(r["sides"][ctrl])
        r["turn_idx"] = 0
        self._seat_answerer(r)
        r["stage"] = "play"
        self.phase = "play"
        self._bump(time.time() + TURN_SECONDS)
        return [self.fx("play_begins", side=ctrl, name=r["names"][ctrl],
                        passed=not play)]

    def _current_answerer(self, r):
        """READ-ONLY: the first connected player from turn_idx. Never mutates —
        it runs on the game_state serialization path once per viewer."""
        order = r["turn_order"]
        n = len(order)
        if not n:
            return None
        for k in range(n):
            tok = order[(r["turn_idx"] + k) % n]
            p = self.players.get(tok)
            if p and p.connected:
                return tok
        return order[r["turn_idx"] % n]

    def _seat_answerer(self, r):
        """Write turn_idx to the first connected seat from where it points."""
        order = r["turn_order"]
        n = len(order)
        for k in range(n):
            idx = (r["turn_idx"] + k) % n
            p = self.players.get(order[idx])
            if p and p.connected:
                r["turn_idx"] = idx
                return

    def _advance_turn(self, r):
        r["turn_idx"] = (r["turn_idx"] + 1) % len(r["turn_order"])
        self._seat_answerer(r)
        self._bump(time.time() + TURN_SECONDS)

    # ---- play ----

    def _play_guess(self, token, side, word, r):
        if side != r["control"]:
            return [self.fx("invalid", to=token, msg="The other side is playing")]
        if token != self._current_answerer(r):
            return [self.fx("invalid", to=token, msg="Wait for your turn")]
        idx = surveys.match_answer(word, r["answers"])
        p = self.players[token]
        if idx is not None and not r["answers"][idx]["revealed"]:
            fx = [self.fx("answer", pid=p.pid, hit=True)]
            fx.extend(self._reveal(r, idx))
            if all(a["revealed"] for a in r["answers"]):
                fx.extend(self._end_round(r, winner=r["control"], reason="swept"))
            else:
                self._advance_turn(r)
            return fx
        # strike: already-revealed or not on the board
        r["strikes"] += 1
        fx = [self.fx("strike", pid=p.pid, n=r["strikes"])]
        if r["strikes"] >= 3:
            fx.extend(self._open_steal(r))
        else:
            self._advance_turn(r)
        return fx

    def _reveal(self, r, idx):
        a = r["answers"][idx]
        a["revealed"] = True
        r["pot"] += a["pts"]
        return [self.fx("reveal", idx=idx, text=a["text"], pts=a["pts"], pot=r["pot"])]

    # ---- steal ----

    def _open_steal(self, r):
        r["stage"] = "steal"
        r["steal"] = {"side": self._other(r["control"])}
        self.phase = "steal"
        self._bump(time.time() + STEAL_SECONDS)
        return [self.fx("steal_open", side=r["steal"]["side"],
                        name=r["names"][r["steal"]["side"]], pot=r["pot"])]

    def _steal_guess(self, token, side, word, r):
        if side != r["steal"]["side"]:
            return [self.fx("invalid", to=token, msg="The other side is stealing")]
        idx = surveys.match_answer(word, r["answers"])
        p = self.players[token]
        if idx is not None and not r["answers"][idx]["revealed"]:
            fx = [self.fx("answer", pid=p.pid, hit=True)]
            fx.extend(self._reveal(r, idx))
            fx.extend(self._end_round(r, winner=side, reason="stole"))
            return fx
        fx = [self.fx("answer", pid=p.pid, hit=False)]
        fx.extend(self._end_round(r, winner=r["control"], reason="held"))
        return fx

    # ---- round / match end ----

    def _award(self, r, side, amount):
        if self.g["mode"] == "singles":
            self.g["scores"][r["sides"][side][0]] += amount
        else:
            self.g["scores"][side] += amount

    def _end_round(self, r, winner, reason):
        mult = self._mult()
        award = r["pot"] * mult
        self._award(r, winner, award)
        r["outcome"] = {"winner": winner, "name": r["names"][winner],
                        "reason": reason, "award": award, "mult": mult}
        for a in r["answers"]:                 # reveal the rest for the board
            a["revealed"] = True
        r["stage"] = "reveal"
        self.phase = "reveal"
        self._bump(time.time() + REVEAL_SECONDS)
        return [self.fx("round_end", winner=winner, award=award)]

    def _pid(self, token):
        p = self.players.get(token)
        return p.pid if p else None

    def _standings(self):
        """Singles: every player ranked (tie-aware ranks). None for teams."""
        if self.g["mode"] != "singles":
            return None
        rows = sorted(self.g["order"],
                      key=lambda t: -self.g["scores"].get(t, 0))
        out, prev, rank = [], None, 0
        for i, t in enumerate(rows):
            sc = self.g["scores"].get(t, 0)
            rank = rank if sc == prev else i + 1
            prev = sc
            p = self.players.get(t)
            out.append({"pid": self._pid(t), "name": p.name if p else "?",
                        "avatar": p.avatar if p else "🙂",
                        "pfp": p.pfp if p else None, "score": sc, "rank": rank})
        return out

    def _podium(self):
        g = self.g
        if g["mode"] == "singles":
            st = self._standings()
            top = st[0]["score"] if st else 0
            leaders = [r for r in st if r["score"] == top]
            self.g["result"] = {
                "mode": "singles",
                "tie": len(leaders) > 1 or top == 0 and len(st) > 1,
                "winner_name": leaders[0]["name"] if len(leaders) == 1 else None,
                "standings": st,
            }
            return self.end_game()
        sc = g["scores"]
        winner = "A" if sc["A"] > sc["B"] else ("B" if sc["B"] > sc["A"] else None)
        self.g["result"] = {
            "mode": "teams",
            "winner": winner,
            "winner_name": (self._side_name(g["roster"], winner) if winner else None),
            "tie": winner is None,
            "sides": [{"side": s, "name": self._side_name(g["roster"], s), "score": sc[s],
                       "members": [self._pid(t) for t in g["roster"][s] if t in self.players]}
                      for s in SIDES],
        }
        return self.end_game()

    def game_player_left(self, token):
        # if the SEATED answerer drops mid-turn, hand the turn to the next
        # connected teammate with a FRESH clock (not the departed's leftover)
        g = self.g
        if g and self.phase == "play":
            r = g["round"]
            order = r["turn_order"]
            if order and order[r["turn_idx"] % len(order)] == token:
                r["turn_idx"] = (r["turn_idx"] + 1) % len(order)
                self._seat_answerer(r)
                if self._current_answerer(r) is not None:
                    self._bump(time.time() + TURN_SECONDS)
        return []

    def to_lobby(self):
        # clear the finished match so the lobby team picker recomputes from the
        # CURRENT players (otherwise it shows the previous game's stale roster)
        self.g = None
        return super().to_lobby()

    def game_tick(self):
        if self.g is None:
            return []
        r = self.g["round"]
        stage = r["stage"] if r else None
        if stage == "faceoff":
            for side in SIDES:
                if r["faceoff"][side] is None:
                    r["faceoff"][side] = {"guess": "", "idx": None}
            return self._resolve_faceoff(r)
        if stage == "choice":
            return self._begin_play(r, True)      # dawdled -> play
        if stage == "play":
            r["strikes"] += 1
            fx = [self.fx("strike", pid=None, n=r["strikes"], timeout=True)]
            if r["strikes"] >= 3:
                fx.extend(self._open_steal(r))
            else:
                self._advance_turn(r)
            return fx
        if stage == "steal":
            return self._end_round(r, winner=r["control"], reason="held")
        if stage == "reveal":
            if self.g["round_no"] >= self.g["rounds_total"]:
                return self._podium()
            return self._start_round()
        return []

    # ---------------- serialization ----------------

    def state_for(self, viewer_token=None):
        st = super().state_for(viewer_token)
        # mode + team-picker data — available in the LOBBY too (base omits game there)
        mode = self.g["mode"] if self.g else self.settings.get("mode", "teams")
        toks = self._humans_tokens()
        ff = {"mode": mode, "n": len(toks)}
        if mode == "teams":
            roster = (self.g["roster"] if (self.g and self.g.get("roster"))
                      else self._rosters(toks))
            ff["teams"] = {self.players[t].pid: self.teams.get(t)
                           for t in toks if t in self.players}
            ff["names"] = {s: self._side_name(roster, s) for s in SIDES}
            ff["counts"] = {s: len(roster[s]) for s in SIDES}
            ff["my_side"] = self.teams.get(viewer_token) if viewer_token else None
        st["ff"] = ff
        return st

    def game_state(self, viewer_token):
        g = self.g
        if g is None:
            return None
        r = g["round"]
        pid = lambda t: self.players[t].pid if t in self.players else None
        revealed_all = r["stage"] == "reveal" or self.phase == "game_end"
        my_side = self._side_of(viewer_token) if viewer_token else None
        answers = []
        for i, a in enumerate(r["answers"]):
            show = a["revealed"]
            answers.append({"rank": i + 1,
                            "text": a["text"] if show else None,
                            "pts": a["pts"] if show else None,
                            "revealed": show})
        cur = None
        if r["stage"] == "play":
            cur = self._current_answerer(r)
        st = {
            "kind": "fab5feud",
            "stage": r["stage"],
            "q": r["q"],
            "answers": answers,
            "pot": r["pot"],
            "strikes": r["strikes"],
            "round_no": g["round_no"],
            "rounds_total": g["rounds_total"],
            "mult": self._mult(),
            "mode": g["mode"],
            "control": r["control"],
            # the two sides' scores shown on the strip: side scores in teams,
            # the two contestants' personal scores in singles
            "scores": ({s: g["scores"][s] for s in SIDES} if g["mode"] == "teams"
                       else {s: g["scores"].get(r["sides"][s][0], 0) for s in SIDES}),
            "names": dict(r["names"]),
            "roster": {s: [pid(t) for t in r["sides"][s]] for s in SIDES},
            "reps": {s: pid(r["reps"][s]) for s in SIDES},
            "faceoff_done": {s: r["faceoff"][s] is not None for s in SIDES},
            "captain": pid(r["sides"][r["control"]][0]) if r["control"] else None,
            "turn": pid(cur) if cur else None,
            "steal_side": r["steal"]["side"] if r["steal"] else None,
            "standings": self._standings(),
            "outcome": r["outcome"],
            "result": g["result"],
            # per-viewer helpers
            "my_side": my_side,
            "my_turn": bool(cur and cur == viewer_token),
            "im_rep": bool(my_side and r["reps"].get(my_side) == viewer_token),
            "im_captain": bool(r["control"] and my_side == r["control"]
                               and r["sides"][r["control"]][0] == viewer_token),
            "can_steal": bool(r["steal"] and my_side == r["steal"]["side"]),
        }
        return st
