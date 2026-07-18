"""PRICE CHECK item bank — schema + loader.

Each item: {prompt, emoji, answer, money, unit, fact, category}
  prompt  short noun phrase for the thing being guessed
  emoji   one representative emoji
  answer  the authoritative number (float only for money-with-cents)
  money   True -> render "$answer"; False -> render "answer unit"
  unit    "" for money, else a short suffix ("bones", "mph", "feet"…)
  fact    one friendly sentence revealed with the answer
  category grocery | stuff | body | world | space | animals | fun

The full ~120-item bank lives in `_items_data.py` (authored separately, same
pattern as fab5feud's surveys). `load()` uses it when present and falls back to
this small SEED bank so the game always runs.
"""

from __future__ import annotations

SEED_ITEMS = [
    {"prompt": "A dozen large eggs at the store", "emoji": "🥚", "answer": 4,
     "money": True, "unit": "", "fact": "Eggs come 12 to a carton — a 'dozen'.",
     "category": "grocery"},
    {"prompt": "A first-class US postage stamp", "emoji": "📮", "answer": 0.73,
     "money": True, "unit": "", "fact": "The 'Forever' stamp is about 73¢.",
     "category": "stuff"},
    {"prompt": "A gallon of milk", "emoji": "🥛", "answer": 4,
     "money": True, "unit": "", "fact": "A gallon is 8 pints of milk.",
     "category": "grocery"},
    {"prompt": "A single movie ticket", "emoji": "🎟️", "answer": 12,
     "money": True, "unit": "", "fact": "US movie tickets average around $12.",
     "category": "fun"},
    {"prompt": "Bones in the adult human body", "emoji": "🦴", "answer": 206,
     "money": False, "unit": "bones", "fact": "Babies are born with ~300; some fuse to 206.",
     "category": "body"},
    {"prompt": "Keys on a standard piano", "emoji": "🎹", "answer": 88,
     "money": False, "unit": "keys", "fact": "52 white keys + 36 black = 88.",
     "category": "fun"},
    {"prompt": "States in the USA", "emoji": "🇺🇸", "answer": 50,
     "money": False, "unit": "states", "fact": "50 stars on the flag, one per state.",
     "category": "world"},
    {"prompt": "Planets in our solar system", "emoji": "🪐", "answer": 8,
     "money": False, "unit": "planets", "fact": "Pluto was reclassified in 2006.",
     "category": "space"},
    {"prompt": "Top speed of a cheetah", "emoji": "🐆", "answer": 70,
     "money": False, "unit": "mph", "fact": "The fastest land animal — up to ~70 mph.",
     "category": "animals"},
    {"prompt": "Height of the Statue of Liberty (torch to base)", "emoji": "🗽",
     "answer": 305, "money": False, "unit": "feet", "fact": "About 305 ft including the pedestal.",
     "category": "world"},
    {"prompt": "Legs on a spider", "emoji": "🕷️", "answer": 8,
     "money": False, "unit": "legs", "fact": "All spiders have 8 legs; insects have 6.",
     "category": "animals"},
    {"prompt": "A scoop of ice cream at a shop", "emoji": "🍦", "answer": 4,
     "money": True, "unit": "", "fact": "One scoop runs a few dollars these days.",
     "category": "grocery"},
    {"prompt": "Days in a leap year", "emoji": "📅", "answer": 366,
     "money": False, "unit": "days", "fact": "Every 4 years February gets a 29th day.",
     "category": "fun"},
    {"prompt": "Distance from Earth to the Moon", "emoji": "🌙", "answer": 238900,
     "money": False, "unit": "miles", "fact": "About 238,900 miles on average.",
     "category": "space"},
]


def load():
    """Return the full item bank (big data file if present, else the seed)."""
    try:
        from ._items_data import ITEMS  # noqa: WPS433 (lazy, optional)
        if isinstance(ITEMS, list) and len(ITEMS) >= len(SEED_ITEMS):
            return ITEMS
    except Exception:
        pass
    return SEED_ITEMS


def pick(rng, n):
    """n distinct items, shuffled by the seeded rng."""
    bank = load()
    n = min(n, len(bank))
    return rng.sample(bank, n)
