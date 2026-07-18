"""Snake bots — synchronous, deterministic steering (seeded rng only).

Called from inside the game tick (snake is real-time; the async bot
scheduler in core.net is for turn-based games and is unused here).

SHARP: BFS toward the nearest item through free cells, avoiding cells
that will certainly be occupied next tick (bodies minus vacating tails)
AND the predicted next-head cells of the other snakes; if no safe path
to any item exists, pick the safe move that maximizes flood-fill open
space (don't trap yourself).

ROOKIE: skips the lookahead — avoids only immediate collisions (walls +
cells occupied next tick) and drifts greedily toward the nearest item.

All iteration orders are fixed and ties are broken with the session rng,
so a seeded session replays identically.
"""

from __future__ import annotations

from collections import deque

UP, RIGHT, DOWN, LEFT = (0, -1), (1, 0), (0, 1), (-1, 0)
DIRS = (UP, RIGHT, DOWN, LEFT)


def _blocked_next(snakes):
    """Cells certainly occupied after everyone moves: every body cell,
    minus each snake's tail when it is not growing (the tail vacates)."""
    blocked = set()
    for s in snakes.values():
        if not s["alive"] or not s["body"]:
            continue
        cells = s["body"] if s["grow"] > 0 else s["body"][:-1]
        blocked.update(cells)
    return blocked


def _predicted_heads(snakes, me_token):
    """Where every OTHER snake's head lands if it keeps its heading."""
    preds = set()
    for tok, s in snakes.items():
        if tok == me_token or not s["alive"] or not s["body"]:
            continue
        hx, hy = s["body"][0]
        dx, dy = s["dir"]
        preds.add((hx + dx, hy + dy))
    return preds


def _body_cells(snakes):
    cells = set()
    for s in snakes.values():
        if s["alive"]:
            cells.update(s["body"])
    return cells


def _bfs_nearest(w, h, start, targets, solid):
    """Steps from `start` to the nearest target through non-solid cells;
    None when unreachable. Deterministic (fixed neighbor order)."""
    if start in targets:
        return 0
    seen = {start}
    q = deque([(start, 0)])
    while q:
        (x, y), d = q.popleft()
        for dx, dy in DIRS:
            nx, ny = x + dx, y + dy
            if not (0 <= nx < w and 0 <= ny < h):
                continue
            c = (nx, ny)
            if c in seen:
                continue
            if c in targets:
                return d + 1
            if c in solid:
                continue
            seen.add(c)
            q.append((c, d + 1))
    return None


def _flood_size(w, h, start, solid):
    """How many cells are reachable from `start` through non-solid cells."""
    seen = {start}
    q = deque([start])
    n = 0
    while q:
        x, y = q.popleft()
        n += 1
        for dx, dy in DIRS:
            nx, ny = x + dx, y + dy
            c = (nx, ny)
            if 0 <= nx < w and 0 <= ny < h and c not in seen and c not in solid:
                seen.add(c)
                q.append(c)
    return n


def choose_dir(w, h, snakes, token, items, rng, tier="sharp"):
    """Pick this bot's heading for the coming tick.

    snakes: {token: {"body": [(x,y)...], "dir": (dx,dy), "grow": int,
                     "alive": bool}}  (head first)
    items:  iterable of (x, y) item cells.
    Returns a (dx, dy) never reversing the current heading, or None to
    keep drifting straight (only when the snake is boxed in / dead).
    """
    me = snakes.get(token)
    if me is None or not me["alive"] or not me["body"]:
        return None
    head = me["body"][0]
    cdir = tuple(me["dir"])
    rev = (-cdir[0], -cdir[1])
    blocked = _blocked_next(snakes)

    cands = []
    for d in DIRS:
        if d == rev:
            continue
        c = (head[0] + d[0], head[1] + d[1])
        if not (0 <= c[0] < w and 0 <= c[1] < h):
            continue
        if c in blocked:
            continue
        cands.append((d, c))
    if not cands:
        return None                    # boxed in — drift into fate

    targets = set(items)

    if tier == "rookie":
        # immediate-collision avoidance + greedy drift toward food
        best_d, best_key = None, None
        for d, c in cands:
            m = (min(abs(c[0] - tx) + abs(c[1] - ty) for tx, ty in targets)
                 if targets else 0)
            key = (m, rng.random())
            if best_key is None or key < best_key:
                best_key, best_d = key, d
        return best_d

    # SHARP — also dodge predicted head moves (head-on avoidance)
    preds = _predicted_heads(snakes, token)
    safe = [(d, c) for d, c in cands if c not in preds] or cands
    solid = _body_cells(snakes)

    if targets:
        reach = []
        for d, c in safe:
            dist = _bfs_nearest(w, h, c, targets, solid - {c})
            if dist is not None:
                reach.append((d, c, dist))
        if reach:
            m = min(dist for _, _, dist in reach)
            pick = [(d, c) for d, c, dist in reach if dist == m]
            return _tiebreak(pick, cdir, rng)

    # no safe path to food — keep the most open space ahead
    areas = [(d, c, _flood_size(w, h, c, solid - {c})) for d, c in safe]
    m = max(a for _, _, a in areas)
    pick = [(d, c) for d, c, a in areas if a == m]
    return _tiebreak(pick, cdir, rng)


def _tiebreak(pick, cdir, rng):
    if len(pick) == 1:
        return pick[0][0]
    for d, _ in pick:                  # prefer holding course
        if d == cdir:
            return d
    return pick[rng.randrange(len(pick))][0]
