"""FAB5 FEUD survey bank + answer matching.

The bank itself lives in `_surveys_data.py` (pure data, big). This module owns
the logic: normalizing a typed guess and matching it against a survey's ranked
answers (each answer carries `aliases` — the things a real person might type).

Matching is deliberately lenient (Family-Feud style) but guarded against tiny-
word false positives: exact normalized match, whole-phrase containment, or a
single distinctive word token. First (highest-ranked) answer wins ties.
"""

from __future__ import annotations

import re

_ARTICLES = {"a", "an", "the"}
_KEEP = {"gas", "bus", "kiss", "glass", "class", "dress", "boss", "grass",
         "news", "chess", "us", "this", "is", "his", "plus", "less"}


def _singular(w: str) -> str:
    if w in _KEEP or len(w) <= 3:
        return w
    if w.endswith("ies"):
        return w[:-3] + "y"
    if w.endswith(("ches", "shes", "sses", "xes", "zes")):
        return w[:-2]
    if w.endswith("s") and not w.endswith(("ss", "us", "is")):
        return w[:-1]
    return w


def norm(s) -> str:
    """Lowercase, de-punctuate, drop articles, singularize tokens, collapse."""
    if not isinstance(s, str):
        return ""
    s = s.lower().replace("&", " and ")
    s = re.sub(r"[^a-z0-9\s-]", " ", s)
    s = s.replace("-", " ")
    toks = [_singular(t) for t in s.split() if t and t not in _ARTICLES]
    return " ".join(toks)


def _candidates(answer) -> list:
    seen, out = set(), []
    for c in [answer["text"]] + list(answer.get("aliases", [])):
        n = norm(c)
        if n and n not in seen:
            seen.add(n)
            out.append(n)
    return out


def match_answer(guess, answers):
    """Index of the answer the guess matches, or None.

    An EXACT normalized match always wins (so 'toilet paper' hits "Toilet Paper",
    not "Toilet"). Otherwise the BEST containment match wins — the longest, most
    specific candidate — never merely the first one scanned. Ties break to the
    higher-ranked (lower-index) answer.
    """
    g = norm(guess)
    if not g:
        return None
    # 1) exact match — highest-ranked among exact hits
    for i, a in enumerate(answers):
        if g in _candidates(a):
            return i
    # 2) best fuzzy match: prefer the longest matching candidate
    gp = " %s " % g
    gtoks = set(g.split())
    best_i, best_score = None, 0
    for i, a in enumerate(answers):
        for nc in _candidates(a):
            score = 0
            if " " in nc and len(nc) >= 4 and (" %s " % nc in gp or nc in g):
                score = 2 * len(nc)          # multi-word phrase — strong + specific
            elif " " not in nc and len(nc) >= 4 and nc in gtoks:
                score = len(nc)              # single distinctive word — weaker
            if score > best_score:           # strictly greater -> ties keep lower index
                best_score, best_i = score, i
    return best_i


def load() -> list:
    """The full survey bank (imported lazily so the data file is optional
    at import time — engine tests inject their own surveys)."""
    from games.fab5feud._surveys_data import SURVEYS
    return SURVEYS
