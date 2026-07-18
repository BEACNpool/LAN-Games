"""The game registry — THE one place a game plugs into the hub.

Each entry mounts, for slug <slug>:
  * WebSocket        /games/<slug>/ws
  * static client    /games/<slug>/   (the game's web/ dir)
  * a card on the hub page (from /api/games)

To add a game: copy games/_template/, implement your GameSession subclass,
then add an entry here. That's the whole integration surface.
"""

from pathlib import Path

from games.spades.game import SpadesSession
from games.rummikub.game import RummikubSession
from games.charades.game import CharadesSession
from games.chess.game import ChessSession
from games.connect4.game import Connect4Session
from games.checkers.game import CheckersSession
from games.backgammon.game import BackgammonSession
from games.tanks.game import TanksSession
from games.hearts.game import HeartsSession
from games.euchre.game import EuchreSession
from games.battleship.game import BattleshipSession
from games.trivia.game import TriviaSession
from games.snake.game import SnakeSession
from games.werewolf.game import WerewolfSession
from games.blitz.game import BlitzSession
from games.poker.game import PokerSession
from games.fab5feud.game import Fab5FeudSession
from games._template.game import HighCardSession

GAMES_DIR = Path(__file__).parent

REGISTRY = [
    {
        "slug": "poker",
        "category": "cards", "accent": "#10c96e",
        "tagline": "No-Limit Hold'em. Last stack standing.",
        "min_p": 1, "max_p": 9, "solo": True,
        "title": "TEXAS HOLD'EM",
        "icon": "♠️",
        "art": "♠︎",
        "blurb": "Real No-Limit Texas Hold'em — blinds, side pots, all-in "
                 "showdowns. Bots fill the table with 3 skill tiers. Solo or "
                 "up to 9-handed; last player with chips wins.",
        "players": "1–9 + bots",
        "session": PokerSession,
        "web": GAMES_DIR / "poker" / "web",
        "hidden": False,
    },
    {
        "slug": "spades",
        "art": "\u2660\ufe0e",
        "category": "cards", "accent": "#22d3ee",
        "tagline": "Partnership trick-taking to 500.",
        "min_p": 2, "max_p": 4, "solo": False,
        "title": "SPADES",
        "icon": "♠️",
        "blurb": "Partnership trick-taking to 500. Bots fill the empty chairs — "
                 "2 humans and the table is live.",
        "players": "2–4 + bots",
        "session": SpadesSession,
        "web": GAMES_DIR / "spades" / "web",
        "hidden": False,
    },
    {
        "slug": "hearts",
        "category": "cards", "accent": "#f43f5e",
        "tagline": "Duck the queen. Dodge the points.",
        "min_p": 1, "max_p": 4, "solo": True,
        "title": "HEARTS",
        "icon": "\u2665\ufe0f",
        "art": "\u2665\ufe0e",
        "blurb": "No partners, no mercy — dodge the hearts, fear the Queen "
                 "of Spades, shoot the moon. Solo vs 3 bots works.",
        "players": "1\u20134 + bots",
        "session": HeartsSession,
        "web": GAMES_DIR / "hearts" / "web",
        "hidden": False,
    },
    {
        "slug": "euchre",
        "category": "cards", "accent": "#38bdf8",
        "tagline": "Order it up. Go alone. Get euchred.",
        "min_p": 1, "max_p": 4, "solo": True,
        "title": "EUCHRE",
        "icon": "\U0001f3b4",
        "blurb": "24 cards, bowers, stick-the-dealer. Order it up, go alone, "
                 "or get euchred trying.",
        "players": "1\u20134 + bots",
        "session": EuchreSession,
        "web": GAMES_DIR / "euchre" / "web",
        "hidden": False,
    },
    {
        "slug": "charades",
        "category": "party", "accent": "#f472b6",
        "tagline": "One actor. Everyone races to type it.",
        "min_p": 2, "max_p": 10, "solo": False,
        "title": "CHARADES",
        "icon": "🎭",
        "blurb": "One actor, everyone races to type it first. Same room, "
                 "eyes up — 1,000+ subjects across 11 decks.",
        "players": "2–10, same room",
        "session": CharadesSession,
        "web": GAMES_DIR / "charades" / "web",
        "hidden": False,
    },
    {
        "slug": "trivia",
        "category": "party", "accent": "#facc15",
        "tagline": "Buzz first. Think later.",
        "min_p": 2, "max_p": 10, "solo": False,
        "title": "TRIVIA BUZZER",
        "icon": "\U0001f514",
        "blurb": "610 questions, buzzer lockouts and steals, or the "
                 "everyone-answers speed race. Kids Zone included.",
        "players": "2\u201310",
        "session": TriviaSession,
        "web": GAMES_DIR / "trivia" / "web",
        "hidden": False,
    },
    {
        "slug": "blitz",
        "category": "party", "accent": "#fb923c",
        "tagline": "Name things. Fast. Don't match.",
        "min_p": 2, "max_p": 10, "solo": False,
        "title": "CATEGORY BLITZ",
        "icon": "\U0001f9e0",
        "blurb": "Name things in the category before the sand runs out — "
                 "answers that match another player cancel. 455 categories.",
        "players": "2\u201310",
        "session": BlitzSession,
        "web": GAMES_DIR / "blitz" / "web",
        "hidden": False,
    },
    {
        "slug": "werewolf",
        "category": "party", "accent": "#c084fc",
        "tagline": "Someone here is lying.",
        "min_p": 5, "max_p": 10, "solo": False,
        "title": "WEREWOLF",
        "icon": "\U0001f43a",
        "blurb": "Phones hold the secrets: night crimes, seer visions, "
                 "day votes. The app is the moderator. Needs 5.",
        "players": "5\u201310, same room",
        "session": WerewolfSession,
        "web": GAMES_DIR / "werewolf" / "web",
        "hidden": False,
    },
    {
        "slug": "fab5feud",
        "category": "party", "accent": "#f59e0b",
        "tagline": "Survey says\u2026 head-to-head or teams.",
        "min_p": 2, "max_p": 10, "solo": False,
        "title": "FAB5 FEUD",
        "icon": "\U0001f4cb",
        "blurb": "Our take on the family survey showdown \u2014 face-off, three "
                 "strikes, steal the pot. 1v1 or split into teams.",
        "players": "2\u201310, teams",
        "session": Fab5FeudSession,
        "web": GAMES_DIR / "fab5feud" / "web",
        "hidden": False,
    },
    {
        "slug": "chess",
        "category": "board", "accent": "#a78bfa",
        "tagline": "Think three moves ahead.",
        "min_p": 1, "max_p": 2, "solo": True,
        "title": "CHESS",
        "icon": "♞",
        "blurb": "The classic, refereed by a real rules engine. Solo? "
                 "A bot takes the other chair.",
        "players": "1–2 + bot",
        "session": ChessSession,
        "web": GAMES_DIR / "chess" / "web",
        "hidden": False,
    },
    {
        "slug": "checkers",
        "category": "board", "accent": "#fb7185",
        "tagline": "Jump or be jumped.",
        "min_p": 1, "max_p": 2, "solo": True,
        "title": "CHECKERS",
        "icon": "⛀",
        "blurb": "Jump or be jumped — forced captures (toggleable), kings, "
                 "the whole playground feud.",
        "players": "1–2 + bot",
        "session": CheckersSession,
        "web": GAMES_DIR / "checkers" / "web",
        "hidden": False,
    },
    {
        "slug": "backgammon",
        "category": "board", "accent": "#34d399",
        "tagline": "Dice, blots, zero mercy.",
        "min_p": 1, "max_p": 2, "solo": True,
        "title": "BACKGAMMON",
        "icon": "🎲",
        "blurb": "Dice, blots, and the bar. Full movement rules — both dice, "
                 "higher die, honest bear-offs.",
        "players": "1–2 + bot",
        "session": BackgammonSession,
        "web": GAMES_DIR / "backgammon" / "web",
        "hidden": False,
    },
    {
        "slug": "connect4",
        "category": "battle", "accent": "#ef4444",
        "tagline": "Four in a row. Gravity does the rest.",
        "min_p": 1, "max_p": 2, "solo": True,
        "title": "CONNECT FOUR",
        "icon": "🔴",
        "blurb": "Four in a row, gravity does the rest. The quick one "
                 "between bigger games.",
        "players": "1–2 + bot",
        "session": Connect4Session,
        "web": GAMES_DIR / "connect4" / "web",
        "hidden": False,
    },
    {
        "slug": "tanks",
        "category": "battle", "accent": "#a3e635",
        "tagline": "Angle. Power. Apologize later.",
        "min_p": 1, "max_p": 6, "solo": True,
        "title": "TANKS",
        "icon": "🪖",
        "blurb": "Artillery duels on destructible terrain — angle, power, "
                 "wind, and no hard feelings. 2-6 tanks.",
        "players": "1–6 + bots",
        "session": TanksSession,
        "web": GAMES_DIR / "tanks" / "web",
        "hidden": False,
    },
    {
        "slug": "battleship",
        "category": "battle", "accent": "#60a5fa",
        "tagline": "Hidden fleets. Everyone's a target.",
        "min_p": 1, "max_p": 6, "solo": True,
        "title": "BATTLESHIP FFA",
        "icon": "\U0001f6a2",
        "blurb": "Free-for-all fleets — everyone fires at everyone, the kill "
                 "feed tells the room. QUICK 8\u00d78 or CLASSIC 10\u00d710.",
        "players": "1\u20136 + bots",
        "session": BattleshipSession,
        "web": GAMES_DIR / "battleship" / "web",
        "hidden": False,
    },
    {
        "slug": "snake",
        "category": "battle", "accent": "#4ade80",
        "tagline": "Don't hit anything. Especially yourself.",
        "min_p": 1, "max_p": 8, "solo": True,
        "title": "SNAKE ARENA",
        "icon": "\U0001f40d",
        "blurb": "Real-time arena snake for up to 8 — golden apples, corpse "
                 "pellets, best-of-3. Swipe to steer.",
        "players": "1\u20138 + bots",
        "session": SnakeSession,
        "web": GAMES_DIR / "snake" / "web",
        "hidden": False,
    },
    {
        "slug": "rummikub",
        "category": "cards", "accent": "#f59e0b",
        "tagline": "Open with 30. Then wreck the table.",
        "min_p": 2, "max_p": 6, "solo": False,
        "title": "RUMMIKUB",
        "icon": "🁵",
        "blurb": "Open with 30, then legally wreck the table. 5-6 players "
                 "auto-switches to the double tile set.",
        "players": "2–6 + bots",
        "session": RummikubSession,
        "web": GAMES_DIR / "rummikub" / "web",
        "hidden": False,
    },
    # ------------------------------------------------------------------
    # WORDCLASH (Sabotage Wordle) — currently its own service on :8095.
    # When it moves into this structure: port its Room to a GameSession
    # subclass (the lobby/timer/fx machinery maps 1:1 — see core/session.py),
    # drop its web/ under games/wordclash/web, and register it here:
    #
    # {
    #     "slug": "wordclash",
    #     "title": "WORDCLASH",
    #     "icon": "🟩",
    #     "blurb": "Multiplayer wordle: duel, relay, sabotage.",
    #     "players": "2–8",
    #     "session": WordclashSession,
    #     "web": GAMES_DIR / "wordclash" / "web",
    #     "hidden": False,
    # },
    # Until then the hub lists it via EXTERNAL below.
    # ------------------------------------------------------------------
    {
        "slug": "template",
        "category": "battle", "accent": "#8b96b3",
        "tagline": "The template stub.",
        "min_p": 2, "max_p": 8, "solo": False,
        "title": "HIGH CARD",
        "icon": "🃏",
        "blurb": "The _template stub — copy games/_template to start a new game.",
        "players": "2–8",
        "session": HighCardSession,
        "web": GAMES_DIR / "_template" / "web",
        "hidden": True,          # visible only with ?dev=1 on the hub
    },
]

# Games that live outside the hub (linked from the hub page, not mounted).
EXTERNAL = [
    {
        "slug": "wordclash",
        "title": "WORDCLASH",
        "icon": "🟩",
        "category": "party", "accent": "#10c96e",
        "tagline": "Duel. Relay. Sabotage.",
        "min_p": 2, "max_p": 8, "solo": False, "tv": True,
        "blurb": "Multiplayer wordle: duel, relay, sabotage. Wall-tablet TV view at /tv.",
        "players": "2–8",
        "url": "/games/wordclash/",   # merged into this server (same origin)
    },
]

# The seeded backlog — EMPTY as of 2026-07-17: all eight shipped
# (hearts, euchre, battleship, trivia, snake, werewolf, blitz + the smart
# rummikub bot). Add future ideas here as {title, icon, blurb}.
COMING_SOON = []
