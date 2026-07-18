"""Word list loading. answers.txt = curated secrets (official Wordle answer
list); allowed = answers ∪ allowed_extra (full valid-guess dictionary)."""

from pathlib import Path

DATA = Path(__file__).parent / "data"


def load_words():
    answers = [w.strip().lower() for w in
               (DATA / "answers.txt").read_text().splitlines()
               if len(w.strip()) == 5 and w.strip().isalpha()]
    extra = [w.strip().lower() for w in
             (DATA / "allowed_extra.txt").read_text().splitlines()
             if len(w.strip()) == 5 and w.strip().isalpha()]
    allowed = set(answers) | set(extra)
    return answers, allowed
