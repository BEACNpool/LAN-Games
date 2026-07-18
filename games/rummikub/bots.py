"""Rummikub bots — rule-based AI opponents for the game hub.

Two tiers, created through make_bot(difficulty, rng):

  * "baseline" — BaselineBot: honest greedy play with NO board-rearrangement
    search. Decision policy:
      - Not melded: find disjoint valid sets in its own hand (natural,
        joker-free runs/groups first — longest, then highest points — then
        joker-completed 3-sets from the leftovers). If together they are
        worth rules.MELD_MIN+ points, play them all as NEW groups appended
        to the untouched board; otherwise draw and keep waiting.
      - Melded: play every disjoint new set it can find in hand, plus as
        many single-tile extensions of the existing board as are
        simultaneously legal (append/prepend a tile to a run, add a fourth
        distinct color to a group of three), all in ONE commit. Nothing
        playable -> draw.
      - Jokers are spent only to complete a set that could not exist
        without them (turning a pair into a run/group, bridging a
        one-number gap) — never as spare filler on a set that is already
        valid on its own.

  * "smart" — SmartBot: everything above, plus a bounded deterministic
    search over FULL-BOARD REARRANGEMENTS (split runs, steal group tiles,
    reclaim and reuse tabled jokers, recombine freed tiles with hand
    tiles). Pre-meld it searches pure-hand combinations for the true best
    30+ opening; post-meld it searches the whole table. Budgeted by NODE
    COUNT (not wallclock) so the same position always yields the same
    move; the baseline move is the fallback and the tie-breaking default.

All randomness flows through the injected random.Random — same seed + same
view => same choice. Both tiers are fully deterministic and consume no
randomness at all (hands, candidates and board groups are scanned in sorted
order); the rng parameter is part of the bot contract for future tiers.

choose() validates its own proposal with rules.check_turn before returning;
a final safety net (which the fuzz tests prove never fires) degrades any
illegal proposal to {"draw": True}, so a bot bug can never wedge the game.

EXTENSION POINT — board rearrangement (v2, now filled). Baseline never
rearranges existing groups: they appear unchanged in every returned board
(extensions are applied to fresh copies, new groups are appended after
them). SmartBot overrides _rearrangement_candidates(view) to yield whole
candidate boards that DO break up and recombine table groups; the baseline
melded turn logic still consults that hook (last, only when nothing simpler
plays) and commits the first candidate that passes rules.check_turn, while
SmartBot's own _propose drives the search directly and compares its result
against the baseline move.
"""

import itertools
import random
import time
from collections import Counter

from games.rummikub import rules
from games.rummikub.rules import (COLORS, color_of, is_joker, number_of,
                                  validate_group)


def make_bot(difficulty="baseline", rng=None):
    """Factory the game engine calls. difficulty: "baseline" or "smart"."""
    if rng is None:
        rng = random.Random()
    if difficulty == "baseline":
        return BaselineBot(rng)
    if difficulty == "smart":
        return SmartBot(rng)
    raise ValueError(f"unknown bot difficulty: {difficulty!r}")


# ---------------------------------------------------------------------------
# set finding (hand tiles only)


def _points(group):
    """Meld value of a valid group (jokers count as what they represent)."""
    return sum(validate_group(group)["values"])


def _index(pool):
    """(by_color, by_number) maps: color -> number -> [tiles], and
    number -> color -> [tiles]. pool must be sorted and joker-free."""
    by_color, by_number = {}, {}
    for t in pool:
        c, n = color_of(t), number_of(t)
        by_color.setdefault(c, {}).setdefault(n, []).append(t)
        by_number.setdefault(n, {}).setdefault(c, []).append(t)
    return by_color, by_number


def _natural_candidates(pool):
    """All maximal joker-free sets available in `pool` (sorted tile ids):
    per-color maximal consecutive stretches >= 3, and per-number groups of
    3-4 distinct colors. One deterministic copy per number/color slot."""
    by_color, by_number = _index(pool)
    cands = []
    for c in sorted(by_color):
        stretch = []
        for n in sorted(by_color[c]) + [None]:
            if stretch and n is not None and n == stretch[-1] + 1:
                stretch.append(n)
                continue
            if len(stretch) >= 3:
                cands.append([min(by_color[c][m]) for m in stretch])
            stretch = [] if n is None else [n]
    for n in sorted(by_number):
        colors = sorted(by_number[n])
        if len(colors) >= 3:  # at most 4 colors exist
            cands.append([min(by_number[n][c]) for c in colors])
    return cands


def _best_natural_set(pool):
    """Greedy pick: longest candidate, then highest points, then lexical."""
    cands = _natural_candidates(pool)
    if not cands:
        return None
    return sorted(cands, key=lambda g: (-len(g), -_points(g), g))[0]


def _joker_set(pool, joker):
    """Best 3-set that `joker` completes from two real tiles in `pool`, or
    None. Only sets that could NOT exist without the joker are considered:
    a same-color pair n/n+1 (joker takes an end), a same-color gap n/n+2
    (joker bridges it), or a same-number pair of distinct colors (joker is
    the third of a group). Never extends an already-valid set."""
    by_color, by_number = _index(pool)
    cands = []
    for c in sorted(by_color):
        nums = sorted(by_color[c])
        for a, b in zip(nums, nums[1:]):
            t1, t2 = min(by_color[c][a]), min(by_color[c][b])
            if b == a + 1:  # pair: joker sits after (or before at the top)
                cands.append([t1, t2, joker] if a + 2 <= 13
                             else [joker, t1, t2])
            elif b == a + 2:  # gap: joker bridges
                cands.append([t1, joker, t2])
    for n in sorted(by_number):
        colors = sorted(by_number[n])
        if len(colors) >= 2:
            cands.append([min(by_number[n][colors[0]]),
                          min(by_number[n][colors[1]]), joker])
    if not cands:
        return None
    return sorted(cands, key=lambda g: (-_points(g), g))[0]


def _find_sets(hand):
    """Greedy disjoint complete sets from a hand: natural sets first
    (longest first, recomputed after each pick), then one joker-completed
    set per leftover joker. Returns a list of groups (tile-id lists)."""
    pool = sorted(t for t in hand if not is_joker(t))
    jokers = sorted(t for t in hand if is_joker(t))
    found = []
    while True:
        best = _best_natural_set(pool)
        if best is None:
            break
        found.append(best)
        for t in best:
            pool.remove(t)
    for j in jokers:
        s = _joker_set(pool, j)
        if s is None:
            continue  # hold the joker rather than burn it
        found.append(s)
        for t in s:
            if t != j:
                pool.remove(t)
    return found


# ---------------------------------------------------------------------------
# single-tile board extensions (melded play only)


def _take(avail, color, number):
    """Remove and return the lowest tile of color+number from avail, or
    None (also when the number falls outside 1-13)."""
    if not 1 <= number <= 13:
        return None
    want = "%s%02d." % (color, number)
    for t in avail:
        if t.startswith(want):
            avail.remove(t)
            return t
    return None


def _extend_one(group, avail):
    """Try ONE single-tile extension of `group` from `avail`: prepend or
    append to a run, or a fourth distinct color onto a group of three.
    Mutates group/avail; returns the tile placed, or None."""
    info = validate_group(group)
    if not info["ok"]:  # defensive: never touch a group we can't read
        return None
    if info["kind"] == "run":
        color = next(color_of(t) for t in group if not is_joker(t))
        t = _take(avail, color, info["values"][0] - 1)
        if t is not None:
            group.insert(0, t)
            return t
        t = _take(avail, color, info["values"][-1] + 1)
        if t is not None:
            group.append(t)
            return t
        return None
    if info["kind"] == "group" and len(group) == 3:
        have = {color_of(t) for t in group if not is_joker(t)}
        for c in sorted(set(COLORS) - have):
            t = _take(avail, c, info["values"][0])
            if t is not None:
                group.append(t)
                return t
    return None


def _extend_board(groups, tiles):
    """Apply every single-tile extension that fits, one at a time, until a
    full pass adds nothing (an appended tile can itself be extended on the
    next pass). `groups` must be fresh copies — they are mutated in place,
    preserving existing tile order. Jokers are never used here: gluing a
    joker onto an already-valid set is exactly the "spare filler" the
    baseline refuses to burn them on. Returns the tiles played."""
    avail = sorted(t for t in tiles if not is_joker(t))
    played = []
    progress = True
    while progress and avail:
        progress = False
        for g in groups:
            t = _extend_one(g, avail)
            if t is not None:
                played.append(t)
                progress = True
    return played


# ---------------------------------------------------------------------------
# bots


def _normalize_view(view):
    """Defensive copy of the engine view — never mutate the caller's state."""
    return {
        "hand": [str(t) for t in view["hand"]],
        "board": [[str(t) for t in g] for g in view["board"]],
        "melded": bool(view["melded"]),
        "pool_count": int(view["pool_count"]),
    }


class RummikubBot:
    """Base bot: view normalization + the legality safety net.

    Subclasses implement _propose(view) -> a full new board (list of tile-id
    groups) to commit, or None to draw. choose() re-checks every proposal
    with rules.check_turn and degrades an illegal one to {"draw": True} —
    the engine trusts but verifies, and a bot bug can never wedge the game.
    """

    def __init__(self, rng):
        self.rng = rng

    def choose(self, view):
        """view = {"hand": [tile ids], "board": [[tile ids]], "melded": bool,
                   "pool_count": int}
        Returns {"board": new_groups} to commit a play, or {"draw": True}.
        A returned board always passes rules.check_turn(view["board"],
        new_groups, view["hand"], view["melded"])."""
        view = _normalize_view(view)
        proposal = self._propose(view)
        if proposal is not None:
            res = rules.check_turn(view["board"], proposal, view["hand"],
                                   view["melded"])
            if res["ok"]:
                return {"board": proposal}
            # Safety net — must never trigger (the fuzz tests prove it).
        return {"draw": True}

    def _propose(self, view):
        raise NotImplementedError

    def _rearrangement_candidates(self, view):
        """EXTENSION POINT for a future SmartBot (v2): yield candidate whole
        boards that rearrange existing groups (split/recombine table sets to
        slot hand tiles in). Consulted only after new-sets + extensions found
        nothing; the first candidate that passes rules.check_turn is played.
        Baseline yields none — v1 never touches existing groups."""
        return []


class BaselineBot(RummikubBot):
    """v1 tier: greedy hand-only sets + single-tile board extensions."""

    def _propose(self, view):
        board = view["board"]
        sets = _find_sets(view["hand"])

        if not view["melded"]:
            # Opening: new groups from hand only, 30+ points, board untouched.
            if not sets:
                return None
            if sum(_points(g) for g in sets) < rules.MELD_MIN:
                return None  # hold the hand and draw instead
            return [list(g) for g in board] + sets

        # Melded: complete new sets + every legal single-tile extension,
        # combined into one commit.
        used = Counter(t for g in sets for t in g)
        remaining = list((Counter(view["hand"]) - used).elements())
        groups = [list(g) for g in board]
        extended = _extend_board(groups, remaining)
        if sets or extended:
            return groups + sets

        # Last resort: the v2 rearrangement hook (empty in baseline).
        for cand in self._rearrangement_candidates(view):
            if rules.check_turn(board, cand, view["hand"], True)["ok"]:
                return [list(g) for g in cand]
        return None


# ---------------------------------------------------------------------------
# SmartBot (v2) — bounded full-board rearrangement search

_MISS = object()


class _BudgetExceeded(Exception):
    """Search budget ran out — unwind and keep the best solution found."""


def _slot_index(t):
    """Real tiles only: slot = (number - 1) * 4 + color index in COLORS."""
    return (number_of(t) - 1) * 4 + COLORS.index(color_of(t))


class _Solver:
    """Deterministic anytime DFS over complete board rearrangements.

    The position is reduced to per-(number, color) slot counts — 52 slots,
    index (number-1)*4 + COLORS.index(color) — split into board copies
    (must ALL be used: tiles never leave the table) and hand copies
    (optional), plus two joker counters (board obligation / hand supply).

    The search scans slots in ascending index (number-major, then color)
    and, at the first slot with tiles remaining, branches over every meld
    that could contain that tile:

      * runs in its color: that tile is necessarily the run's lowest REAL
        tile (all lower slots are already empty by the scan order), so the
        run may start up to two values lower with joker-filled lead slots;
        one candidate per end point, higher slots filled real-first with a
        joker only where no real copy remains;
      * groups of its number: that color is necessarily the group's lowest,
        so every subset of the HIGHER colors with remaining copies, plus
        0+ jokers, sizes 3-4;
      * dropping the slot's remaining copies (hand copies only — never
        legal while a board copy is unplaced there).

    Board copies and board jokers are consumed before hand ones (canonical
    and score-neutral: any feasible solution places every board copy, so
    per slot exactly used-minus-board hand tiles are played). A state is
    complete when every slot is used-or-dropped and no board joker is left
    homeless; a homeless board joker makes the branch infeasible.

    Deliberate, bounded approximations (documented gaps): a run slot whose
    real copy is still available never takes a joker in its place, and runs
    never start more than two joker slots below their lowest real tile.

    Anytime + deterministic: nodes expand in a fixed order with a memo on
    the remaining-tiles signature; every completed solution (including via
    memo hits) updates a global best, so exhausting the NODE budget (the
    binding limit — wallclock is only a generous safety net) still returns
    the best board found so far, identically on every run.

    mode "play": maximize (hand tiles played, adjusted hand value played,
    meld points). mode "meld" (opening search, hand-only): maximize (meld
    points, tiles, value) so the >= MELD_MIN test is decided against the
    true optimum the search reached.
    """

    N_SLOTS = 52
    WALL_CHECK_EVERY = 1024

    def __init__(self, board, hand, mode, joker_value, node_budget, wall_cap):
        self.mode = mode
        self.joker_value = joker_value
        self.node_budget = node_budget
        self.wall_cap = wall_cap
        self.nodes = 0
        self.bneed = bytearray(self.N_SLOTS)   # board copies still unplaced
        self.havail = bytearray(self.N_SLOTS)  # hand copies still available
        self.jb = 0                            # board jokers still unplaced
        self.jh = 0                            # hand jokers still available
        self._bids = {}                        # slot -> board tile ids
        self._hids = {}                        # slot -> hand tile ids
        self._jbids = []
        self._jhids = []
        for g in board:
            for t in g:
                if is_joker(t):
                    self.jb += 1
                    self._jbids.append(t)
                else:
                    i = _slot_index(t)
                    self.bneed[i] += 1
                    self._bids.setdefault(i, []).append(t)
        for t in hand:
            if is_joker(t):
                self.jh += 1
                self._jhids.append(t)
            else:
                i = _slot_index(t)
                self.havail[i] += 1
                self._hids.setdefault(i, []).append(t)

    # ---- scoring ----------------------------------------------------------

    def _key(self, dt, dv, dp):
        """Comparison key: bigger is better."""
        if self.mode == "meld":
            return (dp, dt, dv)
        return (dt, dv, dp)

    # ---- search -----------------------------------------------------------

    def solve(self):
        """Best (tiles_played, value_played, meld_points, melds) with
        tiles_played >= 1, or None. Deterministic for a given position,
        mode and node budget."""
        self.nodes = 0
        self._t0 = time.monotonic()
        self._memo = {}
        self._best = None
        self._acc = [0, 0, 0]
        self._path = []
        self._undo_log = []
        try:
            self._dfs(0)
        except _BudgetExceeded:
            pass
        return self._best

    def _record(self, completion=(0, 0, 0, ())):
        """A complete solution = melds placed so far + a known completion."""
        dt = self._acc[0] + completion[0]
        if dt < 1:
            return  # plays nothing from hand — not a legal commit
        dv = self._acc[1] + completion[1]
        dp = self._acc[2] + completion[2]
        if self._best is None or \
                self._key(dt, dv, dp) > self._key(*self._best[:3]):
            self._best = (dt, dv, dp, tuple(self._path) + completion[3])

    def _dfs(self, pos):
        """Best completion (dt, dv, dp, melds) from the current state, or
        None when infeasible (a board tile/joker cannot be placed)."""
        if self.nodes >= self.node_budget or \
                (self.nodes % self.WALL_CHECK_EVERY == 0
                 and time.monotonic() - self._t0 > self.wall_cap):
            raise _BudgetExceeded
        self.nodes += 1
        bneed, havail = self.bneed, self.havail
        while pos < self.N_SLOTS and not (bneed[pos] or havail[pos]):
            pos += 1
        if pos == self.N_SLOTS:
            if self.jb:
                return None  # a board joker has nowhere to live
            self._record()
            return (0, 0, 0, ())
        key = (pos, bytes(bneed), bytes(havail), self.jb, self.jh)
        hit = self._memo.get(key, _MISS)
        if hit is not _MISS:
            if hit is not None:
                self._record(hit)
            return hit
        best = None
        for meld in self._candidates(pos):
            deltas = self._apply(meld)
            sub = self._dfs(pos)
            self._undo()
            if sub is not None:
                cand = (deltas[0] + sub[0], deltas[1] + sub[1],
                        deltas[2] + sub[2], (meld,) + sub[3])
                if best is None or \
                        self._key(*cand[:3]) > self._key(*best[:3]):
                    best = cand
        if not bneed[pos]:
            dropped = havail[pos]
            havail[pos] = 0
            sub = self._dfs(pos + 1)
            havail[pos] = dropped
            if sub is not None and (best is None or
                                    self._key(*sub[:3]) > self._key(*best[:3])):
                best = sub
        self._memo[key] = best
        return best

    def _candidates(self, pos):
        """Every meld that could contain the tile at slot `pos`, in a fixed
        deterministic order (runs by start/end, then groups by subset)."""
        n = pos // 4 + 1
        ci = pos % 4
        bneed, havail = self.bneed, self.havail
        jokers = self.jb + self.jh
        out = []
        # runs — this tile is the run's lowest real; lead slots are jokers
        for s in range(max(1, n - 2), n + 1):
            lead = n - s
            if lead > jokers:
                continue
            fills = [True] * lead + [False]  # True = joker fills that value
            used_j = lead
            e = n
            while True:
                if e - s + 1 >= 3:
                    out.append(("run", ci, s, e, tuple(fills)))
                if e == 13:
                    break
                i = e * 4 + ci  # slot index of value e + 1
                if bneed[i] or havail[i]:
                    fills.append(False)
                elif used_j < jokers:
                    fills.append(True)
                    used_j += 1
                else:
                    break
                e += 1
        # groups — this color is the group's lowest (lower slots are empty)
        base_i = (n - 1) * 4
        others = [c for c in range(ci + 1, 4)
                  if bneed[base_i + c] or havail[base_i + c]]
        for k in range(len(others) + 1):
            for combo in itertools.combinations(others, k):
                for nj in range(min(jokers, 3 - k) + 1):
                    if 3 <= 1 + k + nj <= 4:
                        out.append(("grp", n, (ci,) + combo, nj))
        return out

    def _take_real(self, ci, num, ops):
        """Consume one real (color, number) copy, board copies first.
        Returns 1 if the copy came from the hand (a tile played), else 0."""
        i = (num - 1) * 4 + ci
        if self.bneed[i]:
            self.bneed[i] -= 1
            ops.append((0, i))
            return 0
        self.havail[i] -= 1
        ops.append((1, i))
        return 1

    def _take_joker(self, ops):
        """Consume one joker, board obligation first. Returns
        (tiles_played_delta, value_delta)."""
        if self.jb:
            self.jb -= 1
            ops.append((2, 0))
            return 0, 0
        self.jh -= 1
        ops.append((3, 0))
        return 1, self.joker_value

    def _apply(self, meld):
        """Consume the meld's tiles; returns its (dt, dv, dp) deltas."""
        ops = []
        dt = dv = dp = 0
        if meld[0] == "run":
            _, ci, s, e, fills = meld
            for num, fj in zip(range(s, e + 1), fills):
                dp += num
                if fj:
                    a, b = self._take_joker(ops)
                    dt += a
                    dv += b
                else:
                    a = self._take_real(ci, num, ops)
                    dt += a
                    dv += a * num
        else:
            _, num, cols, nj = meld
            for c in cols:
                dp += num
                a = self._take_real(c, num, ops)
                dt += a
                dv += a * num
            for _ in range(nj):
                dp += num
                a, b = self._take_joker(ops)
                dt += a
                dv += b
        self._undo_log.append((ops, (dt, dv, dp)))
        self._acc[0] += dt
        self._acc[1] += dv
        self._acc[2] += dp
        self._path.append(meld)
        return (dt, dv, dp)

    def _undo(self):
        ops, (dt, dv, dp) = self._undo_log.pop()
        for kind, i in reversed(ops):
            if kind == 0:
                self.bneed[i] += 1
            elif kind == 1:
                self.havail[i] += 1
            elif kind == 2:
                self.jb += 1
            else:
                self.jh += 1
        self._acc[0] -= dt
        self._acc[1] -= dv
        self._acc[2] -= dp
        self._path.pop()

    # ---- reconstruction ---------------------------------------------------

    def rebuild(self, melds):
        """Turn symbolic melds back into tile-id groups. Board ids are
        assigned before hand ids per slot — the same order the search
        consumed them in, so counts and ids line up exactly."""
        q = {}
        for i in set(self._bids) | set(self._hids):
            q[i] = sorted(self._bids.get(i, [])) + sorted(self._hids.get(i, []))
        jq = sorted(self._jbids) + sorted(self._jhids)
        jpos = 0
        board = []
        for meld in melds:
            g = []
            if meld[0] == "run":
                _, ci, s, e, fills = meld
                for num, fj in zip(range(s, e + 1), fills):
                    if fj:
                        g.append(jq[jpos])
                        jpos += 1
                    else:
                        g.append(q[(num - 1) * 4 + ci].pop(0))
            else:
                _, num, cols, nj = meld
                for c in cols:
                    g.append(q[(num - 1) * 4 + c].pop(0))
                for _ in range(nj):
                    g.append(jq[jpos])
                    jpos += 1
            board.append(g)
        return board


class SmartBot(BaselineBot):
    """v2 tier: the baseline plus a bounded full-board rearrangement search.

    Decision policy:
      - Not melded: exact-as-budget-allows search over pure-hand
        combinations (the initial-meld rule forbids touching the table);
        plays the highest-scoring 30+ opening it finds, else falls back to
        the baseline opening logic (which will draw).
      - Melded: searches rearrangements of the ENTIRE table plus hand.
        Early game (hand > ENDGAME_HAND) it first searches with hand
        jokers withheld, releasing them only when nothing plays without
        them AND the joker play carries at least one real tile (dt >= 2) —
        the baseline's "never burn a joker as spare filler" discipline.
        Endgame (small hand) jokers are valued at their 30-point penalty
        and dumped. The result is compared against the plain baseline move
        by (tiles played, adjusted value played); ties go to the baseline.
      - Anything illegal or empty degrades to the baseline move, then to a
        draw. Every returned board passes rules.check_turn (re-verified
        here AND by the base-class safety net).

    Telemetry / knobs: node_budget caps solver node expansions per
    choose() call (shared across the call's solver runs), last_nodes
    reports what the most recent choose() actually spent. Both exist so
    tests can pin determinism and cost.
    """

    NODE_BUDGET = 20000
    WALL_CAP_SECONDS = 2.0   # safety net only; the node budget binds first
    ENDGAME_HAND = 6
    JOKER_HOLD_PENALTY = -25  # early game: a played joker costs value

    def __init__(self, rng, node_budget=None):
        super().__init__(rng)
        self.node_budget = self.NODE_BUDGET if node_budget is None \
            else node_budget
        self.last_nodes = 0

    # ---- helpers ----------------------------------------------------------

    def _joker_value(self, hand):
        if len(hand) <= self.ENDGAME_HAND:
            return rules.JOKER_HAND_VALUE
        return self.JOKER_HOLD_PENALTY

    def _solve(self, board, hand, mode, joker_value):
        """One budgeted solver run, drawing down this choose()'s budget."""
        budget = max(0, self.node_budget - self.last_nodes)
        solver = _Solver(board, hand, mode, joker_value, budget,
                         self.WALL_CAP_SECONDS)
        best = solver.solve()
        self.last_nodes += solver.nodes
        return best, solver

    def _play_score(self, view, board):
        """(tiles played, adjusted value played) of a proposal, or None if
        the proposal is missing or fails full-board validation."""
        if board is None:
            return None
        res = rules.check_turn(view["board"], board, view["hand"], True)
        if not res["ok"]:
            return None
        jv = self._joker_value(view["hand"])
        val = sum(jv if is_joker(t) else number_of(t) for t in res["played"])
        return (len(res["played"]), val)

    def _baseline_melded(self, view):
        """BaselineBot's melded move (new sets + extensions) without the
        rearrangement hook — the fallback and tie-breaking default.
        (Mirrors BaselineBot._propose's melded branch, which cannot be
        called directly without re-entering the hook.)"""
        sets = _find_sets(view["hand"])
        used = Counter(t for g in sets for t in g)
        remaining = list((Counter(view["hand"]) - used).elements())
        groups = [list(g) for g in view["board"]]
        extended = _extend_board(groups, remaining)
        if sets or extended:
            return groups + sets
        return None

    # ---- decision flow ----------------------------------------------------

    def _propose(self, view):
        self.last_nodes = 0
        if not view["melded"]:
            return self._propose_opening(view)
        cands = self._rearrangement_candidates(view)
        smart = cands[0] if cands else None
        base = self._baseline_melded(view)
        s_score = self._play_score(view, smart)
        b_score = self._play_score(view, base)
        if s_score is None and b_score is None:
            return None
        if b_score is None:
            return smart
        if s_score is None or s_score <= b_score:
            return base
        return smart

    def _propose_opening(self, view):
        best, solver = self._solve([], view["hand"], "meld", 0)
        if best is not None and best[2] >= rules.MELD_MIN:
            proposal = [list(g) for g in view["board"]] \
                + solver.rebuild(best[3])
            if rules.check_turn(view["board"], proposal, view["hand"],
                                False)["ok"]:
                return proposal
        return super()._propose(view)  # baseline opening logic (or draw)

    def _rearrangement_candidates(self, view):
        """The v2 hook, for real: search full-board rearrangements and
        yield the best board found ([] when nothing plays a hand tile)."""
        hand = view["hand"]
        jv = self._joker_value(hand)
        endgame = len(hand) <= self.ENDGAME_HAND
        no_jokers = [t for t in hand if not is_joker(t)]
        attempts = [hand] if endgame or len(no_jokers) == len(hand) \
            else [no_jokers, hand]
        for i, hand_try in enumerate(attempts):
            best, solver = self._solve(view["board"], hand_try, "play", jv)
            if best is None:
                continue
            if i > 0 and not endgame and best[0] < 2:
                continue  # a lone joker dump — hold the joker instead
            return [solver.rebuild(best[3])]
        return []
