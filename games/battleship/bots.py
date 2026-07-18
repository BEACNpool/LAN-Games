"""Battleship bots — hunt/target gunners for the FFA arena.

Two tiers via make_bot(difficulty, rng):

  * "rookie" — RookieBot: random victim, random unshot cell. Exists to lose.
  * "sharp"  — SharpBot: classic hunt/target play, per victim:
      - HUNT: parity pattern keyed to that victim's smallest surviving ship
        ((r + c) % size lattice — no ship of that length can hide between
        lattice points), offset chosen where the most cells remain open.
      - TARGET: any hit that isn't part of a revealed sunk ship spawns
        adjacent candidates; two hits in a line lock the orientation and
        the open line ends are tried first.
      - victim selection is weighted toward whoever is closest to
        elimination (fewest ship cells afloat), with rng noise.

Everything is derived from PUBLIC information: the union of every shot
anyone has fired at each victim, plus revealed sunk ships. That means the
per-(bot, victim) memory is rebuilt from the shared boards each turn — a
bot exploits other players' reconnaissance exactly like a human watching
the table would, and it stays correct across autopilot handoffs.

All randomness flows through the injected random.Random. No IO, no clocks.
choose() always returns a legal (victim, cell); game.py keeps a final
safety net anyway so a bot bug can never wedge the match.
"""

from __future__ import annotations


class Bot:
    def __init__(self, rng):
        self.rng = rng

    # -- subclass hooks --
    def pick_victim(self, victims):
        raise NotImplementedError

    def pick_cell(self, n, victim):
        raise NotImplementedError

    def choose(self, view):
        """view: {"n": board_size, "victims": [victim, ...]} where victim =
        {"token", "cells_left", "shots": {(r,c): hit_bool}, "sunk_cells":
        set[(r,c)], "remaining_sizes": [int]}.
        Returns (victim_token, (r, c)) or None when nobody is targetable."""
        victims = [v for v in view["victims"] if _open_cells(view["n"], v)]
        if not victims:
            return None
        victim = self.pick_victim(victims)
        cell = self.pick_cell(view["n"], victim)
        if cell is None or cell in victim["shots"]:
            cell = self.rng.choice(_open_cells(view["n"], victim))
        return victim["token"], cell


def _open_cells(n, victim):
    shots = victim["shots"]
    return [(r, c) for r in range(n) for c in range(n) if (r, c) not in shots]


class RookieBot(Bot):
    """Pure random fire — no parity, no targeting, no favorites."""

    def pick_victim(self, victims):
        return self.rng.choice(victims)

    def pick_cell(self, n, victim):
        return self.rng.choice(_open_cells(n, victim))


class SharpBot(Bot):
    def pick_victim(self, victims):
        # weight toward the fewest cells afloat; noise keeps it non-robotic
        max_cl = max(v["cells_left"] for v in victims)
        weights = [(max_cl - v["cells_left"] + 1) ** 2 for v in victims]
        return self.rng.choices(victims, weights=weights, k=1)[0]

    def pick_cell(self, n, victim):
        shots = victim["shots"]
        active = [cell for cell, hit in shots.items()
                  if hit and cell not in victim["sunk_cells"]]
        if active:
            return self._target(n, victim, active)
        return self._hunt(n, victim)

    def _target(self, n, victim, active):
        """Stack candidates next to unresolved hits; when two hits line up,
        the open ends of that line come first (orientation is known)."""
        shots = victim["shots"]
        hitset = set(active)
        line_ends, adjacent = [], []
        for (r, c) in active:
            for dr, dc in ((0, 1), (0, -1), (1, 0), (-1, 0)):
                nr, nc = r + dr, c + dc
                if not (0 <= nr < n and 0 <= nc < n) or (nr, nc) in shots:
                    continue
                if (r - dr, c - dc) in hitset:
                    line_ends.append((nr, nc))
                else:
                    adjacent.append((nr, nc))
        pool = line_ends or adjacent
        if pool:
            return self.rng.choice(sorted(set(pool)))
        return None    # boxed-in hits (neighbors all shot) -> fall back to hunt

    def _hunt(self, n, victim):
        shots = victim["shots"]
        step = max(2, min(victim["remaining_sizes"], default=2))
        best = []
        for off in range(step):               # stable: ties keep the lowest
            cells = [(r, c) for r in range(n) for c in range(n)
                     if (r + c) % step == off and (r, c) not in shots]
            if len(cells) > len(best):
                best = cells
        if not best:
            best = _open_cells(n, victim)
        return self.rng.choice(best) if best else None


def make_bot(difficulty, rng):
    return SharpBot(rng) if difficulty == "sharp" else RookieBot(rng)
