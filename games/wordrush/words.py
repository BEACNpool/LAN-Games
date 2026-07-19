"""WORD RUSH dictionary — validation + fast rack word-finding.

The playable dictionary is `data/words.txt` (ENABLE1 filtered to 3-8 letters,
family-safe; ~80k words). Loaded once, lazily, into:
  * WORDS   — a frozenset for O(1) validity checks
  * _ANAG   — signature ("".join(sorted(word))) -> tuple(words), so all words
              findable from a rack are gathered by enumerating the rack's
              sub-multisets (<=219 lookups for an 8-tile rack) instead of
              scanning the whole dictionary.
"""

from __future__ import annotations

import itertools
import pathlib
from collections import Counter

_DATA = pathlib.Path(__file__).parent / "data" / "words.txt"
_WORDS: frozenset | None = None
_ANAG: dict[str, tuple] | None = None

# Playability-tuned letter bag (Scrabble-like weights, vowel-rich so racks
# reliably yield lots of words). Drawn from with replacement, so double letters
# happen naturally.
_BAG = ("a" * 9 + "b" * 2 + "c" * 3 + "d" * 5 + "e" * 12 + "f" * 2 + "g" * 4
        + "h" * 3 + "i" * 9 + "j" * 1 + "k" * 2 + "l" * 5 + "m" * 3 + "n" * 7
        + "o" * 8 + "p" * 3 + "q" * 1 + "r" * 7 + "s" * 6 + "t" * 7 + "u" * 4
        + "v" * 2 + "w" * 2 + "x" * 1 + "y" * 3 + "z" * 1)
VOWELS = frozenset("aeiou")


def _load():
    global _WORDS, _ANAG
    if _WORDS is not None:
        return
    words = []
    anag: dict[str, list] = {}
    with open(_DATA, encoding="utf-8") as f:
        for line in f:
            w = line.strip()
            if w:
                words.append(w)
                anag.setdefault("".join(sorted(w)), []).append(w)
    _WORDS = frozenset(words)
    _ANAG = {k: tuple(v) for k, v in anag.items()}


def is_word(w: str) -> bool:
    _load()
    return w in _WORDS


def can_make(word: str, rack) -> bool:
    """Can `word` be spelled from the `rack` letters (multiset subset)?"""
    have = rack if isinstance(rack, Counter) else Counter(rack)
    need = Counter(word)
    return all(have.get(ch, 0) >= n for ch, n in need.items())


def words_in_rack(rack, min_len: int = 3, max_len: int | None = None) -> set:
    """Every dictionary word (min_len..max_len) formable from the rack letters."""
    _load()
    letters = list(rack)
    if max_len is None:
        max_len = len(letters)
    found: set = set()
    seen_sig: set = set()
    for k in range(min_len, max_len + 1):
        for combo in itertools.combinations(letters, k):
            sig = "".join(sorted(combo))
            if sig in seen_sig:
                continue
            seen_sig.add(sig)
            ws = _ANAG.get(sig)
            if ws:
                found.update(ws)
    return found


def make_rack(rng, size: int = 7, min_words: int = 25,
              min_vowels: int = 2, max_vowels: int = 4, tries: int = 500):
    """Draw a playable rack: enough findable words, a sane vowel count, and at
    least one long (>= size-1) word. Returns (rack_list, findable_word_set).
    Seeded entirely by `rng` so games reproduce."""
    _load()
    best = None
    best_n = -1
    for _ in range(tries):
        rack = [rng.choice(_BAG) for _ in range(size)]
        nv = sum(1 for c in rack if c in VOWELS)
        if nv < min_vowels or nv > max_vowels:
            continue
        ws = words_in_rack(rack)
        if len(ws) >= min_words and any(len(w) >= size - 1 for w in ws):
            rng.shuffle(rack)
            return rack, ws
        if len(ws) > best_n:
            best, best_n = (rack, ws), len(ws)
    rack, ws = best if best else ([rng.choice(_BAG) for _ in range(size)], set())
    rng.shuffle(rack)
    return rack, ws


# points by word length; longer words are worth disproportionately more
LEN_POINTS = {3: 1, 4: 2, 5: 4, 6: 7, 7: 11, 8: 16}
PANGRAM_BONUS = 5          # using ALL rack tiles in one word


def score_word(word: str, rack_size: int) -> int:
    pts = LEN_POINTS.get(len(word), 16)
    if len(word) >= rack_size:      # used the whole rack
        pts += PANGRAM_BONUS
    return pts
