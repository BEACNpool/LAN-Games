"""Rummikub rules — tiles, group validation, and turn/board validation.

Pure functions, no state. This is the load-bearing module: "rearrange the
whole board" is what makes Rummikub Rummikub, so every proposed board state
is validated in full, not just the newly placed tiles.

Tile ids are strings, one per PHYSICAL tile:
    "r05.0"  = red 5, copy 0        colors: r red, b blue, k black, y yellow
    "J.2"    = joker #2
Copies: single set (2-4 players) has 2 copies of each number+color and 2
jokers (106 tiles); the official 5-6 player variant combines two sets:
4 copies of each and 4 jokers (212 tiles). Hand size is 14 in both modes.

A board is a list of groups; a group is an ORDERED list of tile ids. Runs are
validated in the order the player arranged them ascending left-to-right
(which pins each joker's represented value); groups-of-a-kind are order-free.

HOUSE RULE (deliberate, documented): full free-form rearrangement. A joker on
the table may be moved between sets freely; the tile that frees it may come
from the table or the rack; the freed joker may extend an existing set. This
is laxer than the boxed reclaim rule ("replace from rack, reuse in a new set")
and is the common digital convention — the one hard rule kept is that jokers
(like all board tiles) can never return to a hand.
"""

from __future__ import annotations

from collections import Counter

COLORS = "rbky"
NUMBERS = range(1, 14)
HAND_SIZE = 14
MELD_MIN = 30
JOKER_HAND_VALUE = 30
DOUBLE_SET_FROM = 5      # 5+ players -> two combined sets


def is_joker(t):
    return t.startswith("J")


def color_of(t):
    return t[0]


def number_of(t):
    return int(t[1:3])


def build_pool(n_players):
    """All tile ids for a game. Double set at DOUBLE_SET_FROM+ players."""
    copies = 4 if n_players >= DOUBLE_SET_FROM else 2
    pool = ["%s%02d.%d" % (c, n, k)
            for c in COLORS for n in NUMBERS for k in range(copies)]
    pool += ["J.%d" % k for k in range(copies)]
    return pool


def hand_value(hand):
    """Penalty value of a leftover hand: face value, joker = 30."""
    return sum(JOKER_HAND_VALUE if is_joker(t) else number_of(t) for t in hand)


def validate_group(tiles):
    """Validate ONE group. Returns
    {"ok": bool, "kind": "run"|"group"|None, "values": [int]|None, "reason": str}

    values[i] = the number tile i represents (jokers get their implied value),
    used for initial-meld arithmetic.
    """
    n = len(tiles)
    if n < 3:
        return {"ok": False, "kind": None, "values": None,
                "reason": "needs at least 3 tiles"}
    if len(set(tiles)) != n:
        return {"ok": False, "kind": None, "values": None,
                "reason": "duplicate tile"}
    real = [(i, t) for i, t in enumerate(tiles) if not is_joker(t)]
    if not real:
        return {"ok": False, "kind": None, "values": None,
                "reason": "jokers need a real tile with them"}

    # candidate: group of a kind (same number, distinct colors, 3-4 tiles)
    group_res = None
    nums = {number_of(t) for _, t in real}
    colors_list = [color_of(t) for _, t in real]
    if len(nums) == 1 and n <= 4 and len(set(colors_list)) == len(colors_list):
        v = next(iter(nums))
        group_res = {"ok": True, "kind": "group", "values": [v] * n, "reason": ""}

    # candidate: run — same color, ascending in the arranged order (jokers
    # fill their slots; the arrangement pins each joker's value)
    run_res = None
    colors = {color_of(t) for _, t in real}
    if len(colors) == 1:
        i0, t0 = real[0]
        start = number_of(t0) - i0
        if start >= 1 and start + n - 1 <= 13 \
                and all(number_of(t) == start + i for i, t in real):
            run_res = {"ok": True, "kind": "run",
                       "values": [start + i for i in range(n)], "reason": ""}

    # a single real tile + jokers is legal both ways — honor whichever pays
    # more (the arrangement is the player's declaration; [r09,J,J] is the
    # 9-10-11 run worth 30, not a 27-point group of nines)
    if group_res and run_res:
        return run_res if sum(run_res["values"]) > sum(group_res["values"]) \
            else group_res
    if group_res:
        return group_res
    if run_res:
        return run_res

    if len(nums) == 1 and n > 4:
        return {"ok": False, "kind": None, "values": None,
                "reason": "a group can hold at most 4 tiles"}
    if len(nums) == 1 and len(set(colors_list)) != len(colors_list):
        return {"ok": False, "kind": None, "values": None,
                "reason": "same color twice in a group"}
    if len(colors) == 1:
        return {"ok": False, "kind": None, "values": None,
                "reason": "runs go low → high, left to right, no gaps"}
    return {"ok": False, "kind": None, "values": None,
            "reason": "not a run (one color, consecutive) or a group (one number, distinct colors)"}


def validate_board(groups):
    """[per-group validate_group results]; board is legal iff all ok."""
    return [validate_group(g) for g in groups]


def board_tiles(groups):
    return [t for g in groups for t in g]


def check_turn(old_groups, new_groups, hand, melded):
    """Validate a proposed end-of-turn board against the rules.

    old_groups: board at turn start; new_groups: proposed board;
    hand: the player's current hand; melded: has this player made the
    30-point initial meld already?

    Returns {"ok": bool, "reason": str, "played": [tile ids],
             "bad_groups": [indices], "meld_total": int|None}
    """
    bad = [i for i, r in enumerate(validate_board(new_groups)) if not r["ok"]]
    if bad:
        reasons = validate_board(new_groups)
        return {"ok": False, "played": [], "bad_groups": bad, "meld_total": None,
                "reason": "invalid set on the board: " + reasons[bad[0]]["reason"]}

    old = Counter(board_tiles(old_groups))
    new = Counter(board_tiles(new_groups))
    if any(v > 1 for v in new.values()):
        return {"ok": False, "played": [], "bad_groups": [], "meld_total": None,
                "reason": "the same tile appears twice"}
    if old - new:
        return {"ok": False, "played": [], "bad_groups": [], "meld_total": None,
                "reason": "tiles can't leave the board"}
    played = list((new - old).elements())
    if not played:
        return {"ok": False, "played": [], "bad_groups": [], "meld_total": None,
                "reason": "play at least one tile from your hand (or draw)"}
    hand_count = Counter(hand)
    if Counter(played) - hand_count:
        return {"ok": False, "played": [], "bad_groups": [], "meld_total": None,
                "reason": "those tiles aren't in your hand"}

    meld_total = None
    if not melded:
        # initial meld: existing groups untouched; new groups from hand only,
        # totalling 30+
        old_seq = [tuple(g) for g in old_groups]
        new_seq = [tuple(g) for g in new_groups]
        remaining = list(old_seq)
        created = []
        for g in new_seq:
            if g in remaining:
                remaining.remove(g)
            else:
                created.append(g)
        if remaining:
            return {"ok": False, "played": [], "bad_groups": [],
                    "meld_total": None,
                    "reason": "make your 30-point opening from your own hand "
                              "before touching the table"}
        played_set = Counter(played)
        total = 0
        for g in created:
            if Counter(g) - played_set:
                return {"ok": False, "played": [], "bad_groups": [],
                        "meld_total": None,
                        "reason": "opening sets must use only your own tiles"}
            total += sum(validate_group(list(g))["values"])
        if total < MELD_MIN:
            return {"ok": False, "played": played, "bad_groups": [],
                    "meld_total": total,
                    "reason": "opening needs %d+ points (you have %d)"
                              % (MELD_MIN, total)}
        meld_total = total

    return {"ok": True, "played": played, "bad_groups": [],
            "meld_total": meld_total, "reason": ""}
