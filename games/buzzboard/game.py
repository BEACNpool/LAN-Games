"""BUZZ BOARD — a hostless, Jeopardy-style BIG SCREEN party game.

The TV owns the board and clue reveals. Phones select squares, race for a
server-authoritative buzzer, answer privately, and make secret HOT CLUE / LAST
CALL wagers. Content comes from the hub's curated 610-question family bank.
"""

from __future__ import annotations

import time

from core.session import GameSession
from games.trivia import questions


LENGTHS = {
    "quick": {
        "cats": 4, "rows": 3, "diffs": (1, 2, 3),
        "values": (200, 400, 600), "hots": 1,
    },
    "show": {
        "cats": 5, "rows": 5, "diffs": (1, 1, 2, 2, 3),
        "values": (200, 400, 600, 800, 1000), "hots": 2,
    },
}
PENALTIES = {"none": 0.0, "half": 0.5, "classic": 1.0}

PICK_SECONDS = 18
BUZZ_SECONDS = 9
REBUZZ_SECONDS = 6
ANSWER_SECONDS = 12
REVEAL_SECONDS = 4
HOT_WAGER_SECONDS = 15
HOT_ANSWER_SECONDS = 15
FINAL_WAGER_SECONDS = 20
FINAL_ANSWER_SECONDS = 22
FINAL_REVEAL_SECONDS = 10


class BuzzBoardSession(GameSession):
    MIN_PLAYERS = 2
    MAX_HUMANS = 10
    DEFAULT_SETTINGS = {
        "length": "quick",       # quick (4x3) | show (5x5)
        "penalty": "half",       # none | half | classic
    }

    def __init__(self, rng=None):
        super().__init__(rng)
        self.g = None
        self.seen_keys = set()

    # ---- lobby ---------------------------------------------------------

    def validate_settings(self, patch):
        out = {}
        if patch.get("length") in LENGTHS:
            out["length"] = patch["length"]
        if patch.get("penalty") in PENALTIES:
            out["penalty"] = patch["penalty"]
        return out

    # ---- content / board ----------------------------------------------

    def _card(self, entry, cell_id, value, cat_meta):
        order = list(range(4))
        self.rng.shuffle(order)
        return {
            "id": cell_id,
            "category": cat_meta["title"],
            "icon": cat_meta["icon"],
            "value": value,
            "clue": entry["q"],
            "choices": [entry["choices"][i] for i in order],
            "correct": order.index(entry["a"]),
            "answer": entry["choices"][entry["a"]],
            "used": False,
            "hot": False,
            "key": questions.key(entry),
        }

    def _build_board(self):
        spec = LENGTHS[self.settings["length"]]
        meta = {c[0]: {"slug": c[0], "title": c[1], "icon": c[2]}
                for c in questions.CATEGORIES}
        # Kids Zone is intentionally all diff-1 in the shared bank. Leaving it
        # in would make the highest-value squares easier than the low rows.
        slugs = [slug for slug in meta if slug != "kids"]
        self.rng.shuffle(slugs)
        slugs = slugs[:spec["cats"]]
        board, picked = [], set()
        for ci, slug in enumerate(slugs):
            pool = [e for e in questions.BANK
                    if e["cat"] == slug and questions.key(e) not in self.seen_keys]
            if len(pool) < spec["rows"]:
                pool = [e for e in questions.BANK if e["cat"] == slug]
            cells = []
            for ri, (diff, value) in enumerate(zip(spec["diffs"], spec["values"])):
                candidates = [e for e in pool
                              if e["diff"] == diff and questions.key(e) not in picked]
                if not candidates:
                    candidates = [e for e in pool if questions.key(e) not in picked]
                entry = self.rng.choice(candidates)
                picked.add(questions.key(entry))
                cells.append(self._card(entry, "c%dr%d" % (ci, ri), value, meta[slug]))
            board.append({"slug": slug, "title": meta[slug]["title"],
                          "icon": meta[slug]["icon"], "cells": cells})

        hot_pool = [cell for cat in board for cell in cat["cells"]
                    if cell["value"] > spec["values"][0]]
        for cell in self.rng.sample(hot_pool, min(spec["hots"], len(hot_pool))):
            cell["hot"] = True

        final_pool = [e for e in questions.BANK
                      if e["diff"] == 3 and questions.key(e) not in picked
                      and e["cat"] not in slugs]
        if not final_pool:
            final_pool = [e for e in questions.BANK
                          if e["diff"] == 3 and questions.key(e) not in picked]
        final_entry = self.rng.choice(final_pool)
        final_meta = meta[final_entry["cat"]]
        final = self._card(final_entry, "final", 0, final_meta)
        self.seen_keys.update(picked | {final["key"]})
        if len(self.seen_keys) > len(questions.BANK) // 2:
            self.seen_keys = set(picked | {final["key"]})
        return board, final

    def _find_cell(self, cell_id):
        if not isinstance(cell_id, str):
            return None
        for cat in self.g["board"]:
            for cell in cat["cells"]:
                if cell["id"] == cell_id:
                    return cell
        return None

    def _available(self):
        return [cell for cat in self.g["board"] for cell in cat["cells"]
                if not cell["used"]]

    # ---- lifecycle -----------------------------------------------------

    def game_start(self):
        board, final = self._build_board()
        scores = {t: 0 for t in self.participants}
        selector = self.rng.choice(list(self.participants))
        total = sum(len(cat["cells"]) for cat in board)
        self.g = {
            "board": board,
            "total": total,
            "used": 0,
            "surged": False,
            "selector": selector,
            "scores": scores,
            "current": None,
            "buzzer": None,
            "locked": set(),
            "attempts": [],
            "reveal": None,
            "hot_wager": None,
            "final": {
                "card": final, "wagers": {}, "picks": {},
                "pre": None, "rows": None,
            },
            "result": None,
        }
        return self._enter_board([self.fx("board", first=True)])

    def _connected(self):
        return [t for t in self.participants
                if t in self.players and self.players[t].connected]

    def _lowest_connected(self):
        pool = self._connected()
        if not pool:
            return self.g["selector"]
        low = min(self.g["scores"].get(t, 0) for t in pool)
        tied = [t for t in pool if self.g["scores"].get(t, 0) == low]
        return self.rng.choice(tied)

    def _enter_board(self, fx=None):
        fx = list(fx or [])
        if not self._available():
            return fx + self._start_final()
        if not self.g["surged"] and self.g["used"] >= self.g["total"] // 2:
            self.g["surged"] = True
            for cell in self._available():
                cell["value"] *= 2
            fx.append(self.fx("power_surge"))
        if self.g["selector"] not in self._connected():
            self.g["selector"] = self._lowest_connected()
        self.g["current"] = None
        self.g["buzzer"] = None
        self.g["locked"] = set()
        self.g["attempts"] = []
        self.g["reveal"] = None
        self.g["hot_wager"] = None
        self.phase = "board"
        self._bump(time.time() + PICK_SECONDS)
        return fx

    # ---- selection / clue ---------------------------------------------

    def _select(self, token, cell_id, automatic=False):
        if self.phase != "board" or (not automatic and token != self.g["selector"]):
            return [self.fx("invalid", to=token, msg="Wait for the selector")]
        cell = self._find_cell(cell_id)
        if cell is None or cell["used"]:
            return [self.fx("invalid", to=token, msg="Pick an open square")]
        self.seq += 1
        cell["used"] = True
        self.g["used"] += 1
        self.g["current"] = cell
        self.g["locked"] = set()
        self.g["attempts"] = []
        self.g["reveal"] = None
        self.g["buzzer"] = None
        if cell["hot"]:
            self.phase = "hot_wager"
            self._bump(time.time() + HOT_WAGER_SECONDS)
            return [self.fx("hot_clue", pid=self.players[self.g["selector"]].pid,
                            value=cell["value"])]
        self.phase = "clue"
        read_seconds = min(5.0, max(2.0, 1.0 + len(cell["clue"].split()) * 0.12))
        self._bump(time.time() + read_seconds)
        return [self.fx("clue", cell=cell["id"], value=cell["value"])]

    def _auto_select(self):
        available = self._available()
        if not available:
            return self._start_final()
        low = min(c["value"] for c in available)
        pool = [c for c in available if c["value"] <= low * 2]
        return self._select(self.g["selector"], self.rng.choice(pool)["id"], True)

    def _open_buzz(self, seconds=BUZZ_SECONDS):
        self.phase = "buzz"
        self.g["buzzer"] = None
        self._bump(time.time() + seconds)
        return [self.fx("buzz_open")]

    def _buzz(self, token):
        if self.phase != "buzz":
            return [self.fx("too_late", to=token)]
        if token not in self.g["scores"] or token in self.g["locked"]:
            return [self.fx("invalid", to=token, msg="You're locked out")]
        p = self.players.get(token)
        if p is None or not p.connected:
            return []
        self.seq += 1
        self.g["buzzer"] = token
        self.phase = "answer"
        self._bump(time.time() + ANSWER_SECONDS)
        return [self.fx("buzz", pid=p.pid)]

    def _answer(self, token, choice):
        if self.phase != "answer" or token != self.g["buzzer"]:
            return [self.fx("invalid", to=token, msg="Buzz first")]
        if not isinstance(choice, int) or isinstance(choice, bool) or not 0 <= choice < 4:
            return [self.fx("invalid", to=token, msg="Pick an answer")]
        self.seq += 1
        return self._resolve_answer(token, choice)

    def _resolve_answer(self, token, choice, disconnected=False):
        cell = self.g["current"]
        correct = choice == cell["correct"]
        p = self.players.get(token)
        pid = p.pid if p else None
        if correct:
            delta = cell["value"]
            self.g["scores"][token] += delta
            self.g["selector"] = token
            self.g["attempts"].append({"pid": pid, "choice": choice,
                                       "label": cell["choices"][choice],
                                       "correct": True, "delta": delta})
            return self._show_reveal(token, delta)

        factor = 0.0 if disconnected else PENALTIES[self.settings["penalty"]]
        delta = -int(cell["value"] * factor)
        self.g["scores"][token] += delta
        self.g["locked"].add(token)
        label = cell["choices"][choice] if isinstance(choice, int) and 0 <= choice < 4 else "NO ANSWER"
        self.g["attempts"].append({"pid": pid, "choice": choice,
                                   "label": label, "correct": False,
                                   "delta": delta})
        self.g["buzzer"] = None
        eligible = [t for t in self._connected() if t not in self.g["locked"]]
        fx = [self.fx("wrong", pid=pid, pts=delta, disconnected=disconnected)]
        if eligible:
            fx.extend(self._open_buzz(REBUZZ_SECONDS))
            return fx
        self.g["selector"] = self._lowest_connected()
        return fx + self._show_reveal(None, 0)

    def _show_reveal(self, winner, delta):
        cell = self.g["current"]
        self.g["reveal"] = {
            "answer": cell["answer"],
            "correct": cell["correct"],
            "winner": self.players[winner].pid if winner in self.players else None,
            "delta": delta,
            "attempts": list(self.g["attempts"]),
        }
        self.phase = "reveal"
        self._bump(time.time() + REVEAL_SECONDS)
        return [self.fx("reveal", winner=self.g["reveal"]["winner"],
                        answer=cell["answer"], pts=delta)]

    # ---- HOT CLUE ------------------------------------------------------

    def _max_hot_wager(self, token):
        top = max(c["value"] for cat in self.g["board"] for c in cat["cells"])
        return max(top, max(0, self.g["scores"].get(token, 0)))

    def _wager_hot(self, token, value):
        if self.phase != "hot_wager" or token != self.g["selector"]:
            return [self.fx("invalid", to=token, msg="This isn't your wager")]
        maximum = self._max_hot_wager(token)
        if (not isinstance(value, int) or isinstance(value, bool)
                or value < 0 or value > maximum):
            return [self.fx("invalid", to=token, msg="Choose a valid wager")]
        self.seq += 1
        self.g["hot_wager"] = value
        return self._begin_hot_answer()

    def _begin_hot_answer(self):
        if self.g["hot_wager"] is None:
            self.g["hot_wager"] = 0
        self.phase = "hot_answer"
        self._bump(time.time() + HOT_ANSWER_SECONDS)
        return [self.fx("hot_wagered", pid=self.players[self.g["selector"]].pid,
                        wager=self.g["hot_wager"])]

    def _answer_hot(self, token, choice, disconnected=False, timeout=False):
        if self.phase != "hot_answer" or token != self.g["selector"]:
            return [self.fx("invalid", to=token, msg="This clue belongs to the selector")]
        if not disconnected and not timeout and (
                not isinstance(choice, int) or isinstance(choice, bool)
                or not 0 <= choice < 4):
            return [self.fx("invalid", to=token, msg="Pick an answer")]
        if not disconnected:
            self.seq += 1
        cell = self.g["current"]
        correct = not disconnected and choice == cell["correct"]
        wager = self.g["hot_wager"] or 0
        delta = wager if correct else (-wager if not disconnected else 0)
        self.g["scores"][token] += delta
        pid = self.players[token].pid if token in self.players else None
        label = cell["choices"][choice] if isinstance(choice, int) and 0 <= choice < 4 else "NO ANSWER"
        self.g["attempts"] = [{"pid": pid, "choice": choice, "label": label,
                                "correct": correct, "delta": delta}]
        return self._show_reveal(token if correct else None, delta)

    # ---- LAST CALL -----------------------------------------------------

    def _start_final(self):
        final = self.g["final"]
        final["wagers"] = {}
        final["picks"] = {}
        final["pre"] = dict(self.g["scores"])
        final["rows"] = None
        self.g["current"] = None
        self.phase = "final_wager"
        self._bump(time.time() + FINAL_WAGER_SECONDS)
        return [self.fx("last_call")]

    def _max_final_wager(self, token):
        return max(1000, max(0, self.g["scores"].get(token, 0)))

    def _wager_final(self, token, value):
        final = self.g["final"]
        if self.phase != "final_wager" or token not in self.g["scores"]:
            return [self.fx("invalid", to=token, msg="Wagering is closed")]
        if token in final["wagers"]:
            return []
        maximum = self._max_final_wager(token)
        if (not isinstance(value, int) or isinstance(value, bool)
                or value < 0 or value > maximum):
            return [self.fx("invalid", to=token, msg="Choose a valid wager")]
        self.seq += 1
        final["wagers"][token] = value
        fx = [self.fx("final_locked", pid=self.players[token].pid)]
        if self._all_connected_in(final["wagers"]):
            fx.extend(self._begin_final_answer())
        return fx

    def _all_connected_in(self, mapping):
        return all(t in mapping for t in self._connected())

    def _begin_final_answer(self):
        final = self.g["final"]
        for t in self.participants:
            final["wagers"].setdefault(t, 0)
        self.phase = "final_answer"
        self._bump(time.time() + FINAL_ANSWER_SECONDS)
        return [self.fx("final_clue")]

    def _pick_final(self, token, choice):
        final = self.g["final"]
        if self.phase != "final_answer" or token not in self.g["scores"]:
            return [self.fx("invalid", to=token, msg="LAST CALL isn't open")]
        if token in final["picks"]:
            return []
        if not isinstance(choice, int) or isinstance(choice, bool) or not 0 <= choice < 4:
            return [self.fx("invalid", to=token, msg="Pick an answer")]
        self.seq += 1
        final["picks"][token] = choice
        fx = [self.fx("final_answered", pid=self.players[token].pid)]
        if self._all_connected_in(final["picks"]):
            fx.extend(self._show_final())
        return fx

    def _show_final(self):
        final = self.g["final"]
        card = final["card"]
        rows = []
        for t in self.participants:
            pick = final["picks"].get(t)
            wager = final["wagers"].get(t, 0)
            correct = pick == card["correct"]
            delta = wager if correct else -wager
            self.g["scores"][t] += delta
            p = self.players.get(t)
            rows.append({
                "pid": p.pid if p else "?",
                "before": final["pre"].get(t, 0),
                "wager": wager,
                "choice": card["choices"][pick] if isinstance(pick, int) and 0 <= pick < 4 else "NO ANSWER",
                "correct": correct,
                "delta": delta,
                "score": self.g["scores"][t],
            })
        # Stable sort preserves participant/join order for tied scores.
        rows.sort(key=lambda r: r["before"])
        final["rows"] = rows
        self.phase = "final_reveal"
        self._bump(time.time() + FINAL_REVEAL_SECONDS)
        return [self.fx("final_reveal", answer=card["answer"])]

    def _finish(self):
        result = []
        for t in self.participants:
            p = self.players.get(t)
            if p:
                result.append({"pid": p.pid, "score": self.g["scores"].get(t, 0)})
        result.sort(key=lambda r: -r["score"])
        self.g["result"] = result
        return self.end_game()

    # ---- dispatch / timers --------------------------------------------

    def game_action(self, token, msg):
        if self.g is None or token not in self.g["scores"]:
            return [self.fx("invalid", to=token, msg="You're watching this game")]
        action = msg.get("t")
        if action == "select":
            return self._select(token, msg.get("cell"))
        if action == "buzz":
            return self._buzz(token)
        if action == "answer":
            return self._answer(token, msg.get("choice"))
        if action == "hot_wager":
            return self._wager_hot(token, msg.get("value"))
        if action == "hot_answer":
            return self._answer_hot(token, msg.get("choice"))
        if action == "final_wager":
            return self._wager_final(token, msg.get("value"))
        if action == "final_answer":
            return self._pick_final(token, msg.get("choice"))
        return [self.fx("invalid", to=token, msg="Unknown action")]

    def game_tick(self):
        if self.phase == "board":
            return self._auto_select()
        if self.phase == "clue":
            return self._open_buzz()
        if self.phase == "buzz":
            self.g["selector"] = self._lowest_connected()
            return self._show_reveal(None, 0)
        if self.phase == "answer":
            return self._resolve_answer(self.g["buzzer"], None)
        if self.phase == "hot_wager":
            return self._begin_hot_answer()
        if self.phase == "hot_answer":
            return self._answer_hot(self.g["selector"], None, timeout=True)
        if self.phase == "reveal":
            return self._enter_board()
        if self.phase == "final_wager":
            return self._begin_final_answer()
        if self.phase == "final_answer":
            return self._show_final()
        if self.phase == "final_reveal":
            return self._finish()
        return []

    # ---- disconnects ---------------------------------------------------

    def game_player_left(self, token):
        if self.g is None:
            return []
        if self.phase == "board" and token == self.g["selector"]:
            self.g["selector"] = self._lowest_connected()
            self._bump(time.time() + PICK_SECONDS)
            return [self.fx("toast", msg="Selector passed to the next player")]
        if self.phase == "answer" and token == self.g["buzzer"]:
            return self._resolve_answer(token, None, disconnected=True)
        if self.phase == "hot_wager" and token == self.g["selector"]:
            self.g["hot_wager"] = 0
            return self._begin_hot_answer()
        if self.phase == "hot_answer" and token == self.g["selector"]:
            return self._answer_hot(token, None, disconnected=True)
        if self.phase == "final_wager" and self._all_connected_in(self.g["final"]["wagers"]):
            return self._begin_final_answer()
        if self.phase == "final_answer" and self._all_connected_in(self.g["final"]["picks"]):
            return self._show_final()
        return []

    def game_player_back(self, token):
        score = self.g["scores"].get(token, 0) if self.g else 0
        return [self.fx("toast", to=token, msg="Welcome back — score %s" % score)]

    # ---- masked state --------------------------------------------------

    def game_state(self, viewer_token):
        g = self.g
        if g is None:
            return None
        public_board = [{
            "slug": cat["slug"], "title": cat["title"], "icon": cat["icon"],
            "cells": [{"id": c["id"], "value": c["value"], "used": c["used"]}
                      for c in cat["cells"]],
        } for cat in g["board"]]

        cell = g["current"]
        current = None
        if cell is not None:
            hide_hot_clue = self.phase == "hot_wager"
            current = {
                "id": cell["id"], "category": cell["category"],
                "icon": cell["icon"], "value": cell["value"],
                "clue": None if hide_hot_clue else cell["clue"],
                "hot": bool(cell["hot"]),
                "answer": cell["answer"] if self.phase == "reveal" else None,
            }

        roster = []
        final = g["final"]
        for t in self.participants:
            p = self.players.get(t)
            if p is None:
                continue
            roster.append({
                "pid": p.pid, "score": g["scores"].get(t, 0),
                "selector": t == g["selector"],
                "buzzed": t == g["buzzer"],
                "locked": t in g["locked"],
                "wagered": t in final["wagers"],
                "answered": t in final["picks"],
            })

        me = None
        if viewer_token in g["scores"]:
            choices = None
            if self.phase == "answer" and viewer_token == g["buzzer"]:
                choices = list(cell["choices"])
            elif self.phase == "hot_answer" and viewer_token == g["selector"]:
                choices = list(cell["choices"])
            elif self.phase == "final_answer":
                choices = list(final["card"]["choices"])
            me = {
                "selector": viewer_token == g["selector"],
                "can_buzz": self.phase == "buzz" and viewer_token not in g["locked"],
                "buzzed": viewer_token == g["buzzer"],
                "locked": viewer_token in g["locked"],
                "choices": choices,
                "hot_wager": g["hot_wager"] if viewer_token == g["selector"] else None,
                "hot_max": self._max_hot_wager(viewer_token) if self.phase == "hot_wager" and viewer_token == g["selector"] else None,
                "final_wager": final["wagers"].get(viewer_token),
                "final_max": self._max_final_wager(viewer_token) if self.phase == "final_wager" else None,
                "final_pick": final["picks"].get(viewer_token),
            }

        final_public = {
            "category": final["card"]["category"],
            "icon": final["card"]["icon"],
            "clue": final["card"]["clue"] if self.phase in ("final_answer", "final_reveal", "game_end") else None,
            "answer": final["card"]["answer"] if self.phase in ("final_reveal", "game_end") else None,
            "rows": final["rows"] if self.phase in ("final_reveal", "game_end") else None,
        }
        return {
            "kind": "buzzboard", "stage": self.phase,
            "board": public_board, "used": g["used"], "total": g["total"],
            "surged": g["surged"], "current": current,
            "roster": roster, "me": me,
            "reveal": g["reveal"] if self.phase in ("reveal", "game_end") else None,
            "final": final_public,
            "result": g["result"],
        }
