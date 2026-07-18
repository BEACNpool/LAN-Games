"""CATEGORY BLITZ — the category bank + the answer normalizer.

The content IS the game, so every category is curated by hand:
family-safe, timeless, and phrased for shouting-range clarity (you should
be able to yell it across the kitchen once and everyone gets it).

Each entry: {"cat": str, "deck": slug, "spice": 1|2}
  spice 1 = everyone at the table can rattle off answers
  spice 2 = harder / nichier — grown-up-night material

The normalizer here is blitz's own (games stay self-contained — charades
has a sibling, but blitz needs word-level singularization, not letter-soup
matching): lowercase, accents stripped, punctuation collapsed, leading
articles dropped, and a careful naive singularization of the final word so
"The Lions" and "lion" cancel each other like they should.
"""

from __future__ import annotations

import random
import re
import unicodedata

# words that end in s but must not be trimmed into nonsense
_KEEP_S = {"news", "lens", "series", "species", "chess", "glass", "physics",
           "mathematics", "gymnastics", "texas", "paris", "swiss", "dallas"}


def _singular(w: str) -> str:
    """Naive singularize + canonicalize one word. Deliberately simple:
    consistency matters more than linguistic truth — both players' spellings
    just have to land on the same key."""
    if len(w) > 3 and w not in _KEEP_S \
            and not w.endswith(("ss", "us", "is")):
        if w.endswith("ies") and len(w) >= 5:
            w = w[:-1]                      # cookies -> cookie, fries -> frie
        elif w.endswith("es") and len(w) >= 4 \
                and (w[-4:-2] in ("ss", "ch", "sh") or w[-3] in "xz"):
            w = w[:-2]                      # boxes -> box, dishes -> dish
        elif w.endswith("s"):
            w = w[:-1]                      # lions -> lion
    # canonical final-y: fry -> frie (so fry/fries, city/cities meet)
    if len(w) >= 3 and w.endswith("y") and w[-2] not in "aeiou":
        w = w[:-1] + "ie"
    return w


def norm(s) -> str:
    """The one normalization every answer goes through before matching."""
    s = unicodedata.normalize("NFKD", str(s).lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.replace("'", "").replace("’", "")     # mcdonald's -> mcdonalds
    s = s.replace("&", " and ")
    s = re.sub(r"[^a-z0-9]+", " ", s).strip()
    words = s.split()
    while words and words[0] in ("a", "an", "the"):
        words.pop(0)
    if not words:
        return ""
    words[-1] = _singular(words[-1])
    return " ".join(words)


DECKS = {
    "easy":   {"title": "EASY STREET",      "icon": "🍦",
               "blurb": "The crowd-pleasers — everyone at the table has ten answers."},
    "house":  {"title": "AROUND THE HOUSE", "icon": "🛋️",
               "blurb": "Drawers, garages, and the junk everyone owns."},
    "food":   {"title": "FOOD COURT",       "icon": "🍔",
               "blurb": "Toppings, takeout, and snack-aisle warfare."},
    "screen": {"title": "SCREEN TIME",      "icon": "🎬",
               "blurb": "Movies, TV, and video games."},
    "sports": {"title": "SPORTS DESK",      "icon": "🏈",
               "blurb": "Balls, courts, teams, and trash talk."},
    "wild":   {"title": "WILD KINGDOM",     "icon": "🦁",
               "blurb": "Creatures great, small, and extremely specific."},
    "earth":  {"title": "PLANET EARTH",     "icon": "🌍",
               "blurb": "Places, maps, and the great outdoors."},
    "time":   {"title": "TIME MACHINE",     "icon": "⏳",
               "blurb": "History-flavored — knights, pharaohs, and grandpa tech."},
    "kids":   {"title": "KIDS ZONE",        "icon": "🧸",
               "blurb": "Very easy — the little ones can win these."},
    "grab":   {"title": "GRAB BAG",         "icon": "🎲",
               "blurb": "Weird ones. Funny ones. No theme, no mercy."},
}


def _deck(slug, ones, twos=()):
    out = [{"cat": c, "deck": slug, "spice": 1} for c in ones]
    out += [{"cat": c, "deck": slug, "spice": 2} for c in twos]
    return out


CATEGORIES: list[dict] = []

# ---------------- EASY STREET ----------------
CATEGORIES += _deck("easy", [
    "PIZZA TOPPINGS",
    "ICE-CREAM FLAVORS",
    "ANIMALS AT THE ZOO",
    "THINGS THAT ARE STICKY",
    "THINGS THAT ARE ROUND",
    "THINGS THAT ARE RED",
    "THINGS THAT ARE YELLOW",
    "THINGS THAT ARE GREEN",
    "BREAKFAST FOODS",
    "FRUITS",
    "VEGETABLES",
    "THINGS AT THE BEACH",
    "THINGS IN A PARK",
    "SUPERHEROES",
    "THINGS THAT FLY",
    "THINGS WITH WHEELS",
    "FARM ANIMALS",
    "THINGS IN THE SKY",
    "THINGS THAT ARE COLD",
    "THINGS THAT ARE HOT",
    "KINDS OF CANDY",
    "SANDWICH FILLINGS",
    "THINGS YOU DRINK",
    "THINGS IN A BACKPACK",
    "SCHOOL SUBJECTS",
    "MUSICAL INSTRUMENTS",
    "THINGS THAT SMELL AMAZING",
    "THINGS THAT SMELL TERRIBLE",
    "HOLIDAYS",
    "THINGS IN THE OCEAN",
    "KINDS OF BIRDS",
    "BUGS AND INSECTS",
    "KINDS OF FLOWERS",
    "THINGS THAT BOUNCE",
    "THINGS THAT ARE SOFT",
    "PETS PEOPLE KEEP",
    "THINGS YOU WEAR ON YOUR HEAD",
    "THINGS YOU DO AT A SLEEPOVER",
    "ICE-CREAM TOPPINGS",
    "THINGS IN A PURSE",
    "THINGS THAT MAKE YOU LAUGH",
    "WAYS TO SAY HELLO",
    "THINGS THAT ARE LOUD",
    "THINGS THAT ARE STRIPED",
    "KINDS OF WEATHER",
    "THINGS YOU DO BEFORE BED",
])

# ---------------- AROUND THE HOUSE ----------------
CATEGORIES += _deck("house", [
    "THINGS IN A KITCHEN DRAWER",
    "THINGS IN THE FRIDGE",
    "THINGS IN THE FREEZER",
    "THINGS IN THE GARAGE",
    "CHORES NOBODY WANTS TO DO",
    "THINGS THAT NEED BATTERIES",
    "THINGS YOU PLUG IN",
    "THINGS IN A BATHROOM",
    "THINGS ON A DESK",
    "TOOLS IN A TOOLBOX",
    "THINGS IN A JUNK DRAWER",
    "CLEANING SUPPLIES",
    "THINGS HANGING IN A CLOSET",
    "PIECES OF FURNITURE",
    "KITCHEN APPLIANCES",
    "THINGS UNDER THE BED",
    "THINGS IN THE LAUNDRY PILE",
    "THINGS HANGING ON WALLS",
    "THINGS IN THE YARD",
    "THINGS THAT BREAK IF YOU DROP THEM",
    "THINGS EVERYONE LOSES",
    "THINGS ON A NIGHTSTAND",
    "THINGS IN A MEDICINE CABINET",
    "THINGS IN THE PANTRY",
    "THINGS WITH BUTTONS",
    "THINGS WITH SCREENS",
    "THINGS THAT USE WATER",
    "THINGS YOU'D GRAB IF THE POWER WENT OUT",
    "THINGS ON A KEYCHAIN",
    "THINGS IN A GARDEN SHED",
    "WAYS TO ANNOY YOUR SIBLINGS",
    "THINGS ON A BOOKSHELF",
    "THINGS ON THE KITCHEN COUNTER",
    "THINGS YOU SIT ON",
    "THINGS MADE OF WOOD",
    "THINGS MADE OF GLASS",
    "THINGS MADE OF METAL",
    "THINGS IN A FIRST-AID KIT",
    "THINGS THAT MAKE NOISE AT NIGHT",
    "EXCUSES FOR A MESSY ROOM",
    "THINGS ON A PORCH",
    "THINGS IN THE MAIL",
    "THINGS YOU SET ON THE DINNER TABLE",
], [
    "THINGS IN A SEWING KIT",
    "THINGS THAT LIVE IN THE ATTIC",
])

# ---------------- FOOD COURT ----------------
CATEGORIES += _deck("food", [
    "FAST-FOOD CHAINS",
    "BURGER TOPPINGS",
    "THINGS AT A TACO BAR",
    "KINDS OF CEREAL",
    "KINDS OF SODA",
    "KINDS OF PIE",
    "KINDS OF CAKE",
    "THINGS IN A SALAD",
    "CONDIMENTS",
    "THINGS ON A HOT DOG",
    "KINDS OF SOUP",
    "FOODS AT A COOKOUT",
    "THANKSGIVING FOODS",
    "VENDING-MACHINE SNACKS",
    "KINDS OF CHIPS",
    "KINDS OF COOKIES",
    "THINGS YOU DIP IN RANCH",
    "FOODS THAT ARE MESSY TO EAT",
    "FOODS KIDS REFUSE TO EAT",
    "KINDS OF DONUTS",
    "MILKSHAKE FLAVORS",
    "MOVIE-THEATER SNACKS",
    "SPICY FOODS",
    "FOODS ON A STICK",
    "KINDS OF SANDWICHES",
    "TOPPINGS AT A FROYO BAR",
    "KINDS OF JUICE",
    "FOODS THAT COME IN A CAN",
    "FOODS YOU EAT WITH YOUR HANDS",
    "THINGS YOU PUT ON PANCAKES",
    "HALLOWEEN CANDY",
    "FOODS THAT ARE ORANGE",
    "KINDS OF BERRIES",
    "KINDS OF NUTS",
    "FOODS ITALY IS FAMOUS FOR",
    "FOODS MEXICO IS FAMOUS FOR",
    "KINDS OF SEAFOOD",
    "THINGS IN A LUNCHBOX",
], [
    "CHINESE TAKEOUT ORDERS",
    "KINDS OF CHEESE",
    "PASTA SHAPES",
    "SUSHI ORDERS",
    "KINDS OF BREAD",
    "COFFEE-SHOP ORDERS",
    "STATE-FAIR FOODS",
    "RAMEN TOPPINGS",
])

# ---------------- SCREEN TIME ----------------
CATEGORIES += _deck("screen", [
    "ANIMATED MOVIES",
    "DISNEY CHARACTERS",
    "SUPERHERO MOVIES",
    "MOVIE VILLAINS",
    "STAR WARS CHARACTERS",
    "HARRY POTTER CHARACTERS",
    "VIDEO GAMES",
    "VIDEO-GAME CHARACTERS",
    "THINGS IN MARIO GAMES",
    "THINGS IN MINECRAFT",
    "GAMES YOU PLAY ON A PHONE",
    "CARTOON ANIMALS",
    "THINGS IN A SCARY MOVIE",
    "MOVIES WITH TALKING ANIMALS",
    "FAMOUS WIZARDS AND WITCHES",
    "PRINCESSES",
    "THINGS A SUPERHERO NEEDS",
    "CHRISTMAS MOVIES",
    "THINGS IN A RACING GAME",
    "CARD GAMES",
    "KINDS OF YOUTUBE VIDEOS",
    "EMOJI EVERYONE USES",
    "APPS ON EVERY PHONE",
    "SONGS EVERYONE KNOWS THE WORDS TO",
    "THINGS IN A VILLAIN'S LAIR",
    "THINGS IN A COOKING SHOW",
    "THINGS IN AN ALIEN MOVIE",
], [
    "PIXAR MOVIES",
    "FAMOUS ROBOTS",
    "TV GAME SHOWS",
    "MOVIES THAT MAKE YOU CRY",
    "SPACE MOVIES",
    "SITCOMS",
    "REALITY SHOWS",
    "CARTOON DOGS",
    "MOVIE SIDEKICKS",
    "FAMOUS MOVIE CARS",
    "MOVIE QUOTES EVERYONE KNOWS",
    "SPORTS VIDEO GAMES",
    "THINGS THAT HAPPEN IN EVERY ACTION MOVIE",
    "MOVIES WITH DRAGONS",
    "FAMOUS CARTOON DUOS",
    "SONGS FROM MOVIES",
    "MOVIES WITH A NUMBER IN THE TITLE",
    "SATURDAY-MORNING CARTOONS",
])

# ---------------- SPORTS DESK ----------------
CATEGORIES += _deck("sports", [
    "SPORTS PLAYED WITH A BALL",
    "OLYMPIC SPORTS",
    "WATER SPORTS",
    "THINGS IN A GYM",
    "THINGS A REFEREE DOES",
    "SPORTS EQUIPMENT",
    "KINDS OF RACES",
    "THINGS AT A BASEBALL GAME",
    "THINGS A COACH YELLS",
    "SPORTS PLAYED INDOORS",
    "SPORTS WITHOUT A BALL",
    "KINDS OF EXERCISE",
    "GYM-CLASS ACTIVITIES",
    "THINGS IN A SKATE PARK",
    "SPORTS YOU PLAY ON A TEAM",
    "SPORTS YOU PLAY ALONE",
    "THINGS IN A SPORTS BAG",
    "THINGS ON A GOLF COURSE",
    "THINGS AT A BOWLING ALLEY",
    "THINGS AT A POOL",
    "THINGS FANS DO AT GAMES",
    "SPORTS PLAYED ON ICE",
    "SPORTS PLAYED ON A COURT",
    "THINGS A CHEERLEADER DOES",
], [
    "WINTER OLYMPIC SPORTS",
    "NBA TEAMS",
    "NFL TEAMS",
    "MLB TEAMS",
    "BASEBALL POSITIONS",
    "FOOTBALL POSITIONS",
    "MARTIAL ARTS",
    "FAMOUS ATHLETES",
    "EXTREME SPORTS",
    "THINGS AT A FOOTBALL TAILGATE",
    "THINGS A GOALIE WEARS",
    "COLLEGE MASCOTS",
    "SWIMMING STROKES",
    "GYMNASTICS MOVES",
    "WRESTLING MOVES",
    "BIKE PARTS",
    "FAMOUS SPORTS TROPHIES",
    "PENALTIES IN SPORTS",
    "THINGS AT A HOCKEY GAME",
    "SPORTS FROM OTHER COUNTRIES",
    "WAYS TO GET OUT IN BASEBALL",
])

# ---------------- WILD KINGDOM ----------------
CATEGORIES += _deck("wild", [
    "ANIMALS WITH STRIPES",
    "ANIMALS WITH SPOTS",
    "ANIMALS THAT LIVE UNDERGROUND",
    "SEA CREATURES",
    "ANIMALS IN AFRICA",
    "KINDS OF DINOSAURS",
    "DOG BREEDS",
    "ANIMALS WITH HORNS OR ANTLERS",
    "ANIMALS THAT SWIM",
    "ANIMALS BIGGER THAN A CAR",
    "ANIMALS SMALLER THAN YOUR HAND",
    "ANIMALS WITH SHELLS",
    "ANIMALS THAT JUMP",
    "ANIMALS THAT CLIMB TREES",
    "ANIMALS IN THE ARCTIC",
    "JUNGLE ANIMALS",
    "MYTHICAL CREATURES",
    "ANIMALS YOU'D NEVER WANT AS A PET",
    "ANIMALS WITH BIG TEETH",
    "ANIMALS THAT ARE BLACK AND WHITE",
    "KINDS OF BEARS",
    "ANIMALS WITH LONG NECKS",
    "ANIMALS THAT CARRY THEIR BABIES",
    "ANIMALS IN A PET STORE",
    "ANIMALS FASTER THAN A HUMAN",
    "ANIMALS THAT SLEEP A LOT",
    "ANIMAL HOMES",
    "ANIMALS THAT ONLY EAT PLANTS",
], [
    "KINDS OF SNAKES",
    "ANIMALS THAT HIBERNATE",
    "BIRDS OF PREY",
    "CAT BREEDS",
    "NOCTURNAL ANIMALS",
    "BABY ANIMAL NAMES",
    "POISONOUS OR VENOMOUS ANIMALS",
    "ANIMALS IN AUSTRALIA",
    "DESERT ANIMALS",
    "ANIMALS THAT EAT BUGS",
    "KINDS OF FISH",
    "KINDS OF SHARKS",
    "WHALES AND DOLPHINS",
    "KINDS OF MONKEYS AND APES",
    "REPTILES AND AMPHIBIANS",
    "ANIMALS THAT WORK FOR HUMANS",
    "EXTINCT ANIMALS",
])

# ---------------- PLANET EARTH ----------------
CATEGORIES += _deck("earth", [
    "COUNTRIES",
    "US STATES",
    "THINGS IN A RAINFOREST",
    "WORLD LANDMARKS",
    "BIG CITIES IN AMERICA",
    "LANGUAGES",
    "TROPICAL VACATION SPOTS",
    "COLD PLACES ON EARTH",
    "THINGS IN A DESERT",
    "THINGS ON A MOUNTAIN",
    "THINGS IN A CAVE",
    "NATURAL DISASTERS",
    "THINGS IN THE NIGHT SKY",
    "THINGS IN OUR SOLAR SYSTEM",
    "THINGS YOU SEE ON A ROAD TRIP",
    "THINGS ON A FARM",
    "BODIES OF WATER",
    "THINGS THAT GROW IN A GARDEN",
    "WAYS TO GET AROUND A CITY",
    "PLACES KIDS DREAM OF VISITING",
    "HOT PLACES ON EARTH",
    "THINGS IN A FOREST",
    "THINGS IN A SWAMP",
], [
    "CAPITAL CITIES",
    "FAMOUS ISLANDS",
    "FAMOUS RIVERS",
    "MOUNTAIN RANGES",
    "DESERTS OF THE WORLD",
    "COUNTRIES IN EUROPE",
    "COUNTRIES IN ASIA",
    "COUNTRIES IN SOUTH AMERICA",
    "COUNTRIES IN AFRICA",
    "OCEANS AND SEAS",
    "US STATES THAT START WITH M",
    "COUNTRIES THAT START WITH B",
    "KINDS OF ROCKS AND GEMS",
    "FAMOUS BRIDGES",
    "US STATE CAPITALS",
    "NATIONAL PARKS",
    "KINDS OF TREES",
    "KINDS OF CLOUDS",
    "COUNTRIES FAMOUS FOR FOOD",
    "COUNTRIES WITH RED IN THEIR FLAG",
    "US STATES WITH BEACHES",
    "ROMANTIC CITIES",
])

# ---------------- TIME MACHINE (mostly spice 2 by design) ----------------
CATEGORIES += _deck("time", [
    "THINGS A KNIGHT WEARS OR CARRIES",
    "THINGS IN ANCIENT EGYPT",
    "THINGS IN A CASTLE",
    "THINGS CAVE PEOPLE HAD",
    "THINGS ON A PIRATE SHIP",
    "THINGS FROM THE WILD WEST",
    "THINGS VIKINGS HAD",
    "THINGS IN A MUSEUM",
    "OLD TECHNOLOGY KIDS WON'T RECOGNIZE",
    "THINGS GRANDPARENTS SAY",
    "THINGS IN A TIME CAPSULE",
    "TRANSPORT BEFORE CARS",
    "THINGS KIDS DID BEFORE PHONES",
], [
    "ANCIENT CIVILIZATIONS",
    "FAMOUS KINGS AND QUEENS",
    "US PRESIDENTS",
    "FAMOUS INVENTORS",
    "FAMOUS EXPLORERS",
    "INVENTIONS FROM BEFORE 1900",
    "FAMOUS SCIENTISTS",
    "THINGS THE ROMANS BUILT",
    "OLD-TIMEY JOBS",
    "FAMOUS ARTISTS FROM HISTORY",
    "FAMOUS COMPOSERS",
    "GREEK GODS AND GODDESSES",
    "EGYPTIAN GODS",
    "WONDERS OF THE ANCIENT WORLD",
    "FAMOUS LINES FROM HISTORY",
    "THINGS AT A MEDIEVAL FEAST",
    "THINGS FROM THE 1980S",
    "THINGS FROM THE 1990S",
    "HISTORICAL FIGURES ON MONEY",
    "PEOPLE ON STATUES",
    "THINGS AN ARCHAEOLOGIST DIGS UP",
    "FAMOUS SHIPS FROM HISTORY",
    "CASTLE DEFENSES",
    "FAMOUS BATTLES",
    "SPACE-RACE THINGS",
    "THINGS A GOLD MINER NEEDED",
    "ANCIENT WEAPONS",
    "THINGS AT A RENAISSANCE FAIR",
    "KINGDOMS AND EMPIRES",
    "THINGS BEN FRANKLIN DID",
    "FAMOUS WOMEN FROM HISTORY",
    "OLD DANCE MOVES",
])

# ---------------- KIDS ZONE (all spice 1, very easy) ----------------
CATEGORIES += _deck("kids", [
    "COLORS",
    "ANIMAL SOUNDS",
    "THINGS AT A BIRTHDAY PARTY",
    "THINGS ON A PLAYGROUND",
    "NURSERY RHYMES",
    "THINGS THAT ARE BIG",
    "THINGS THAT ARE TINY",
    "FAVORITE TOYS",
    "THINGS IN A PENCIL CASE",
    "SHAPES",
    "THINGS AT THE FAIR",
    "ANIMALS WITH FUR",
    "THINGS THAT GO FAST",
    "THINGS THAT GO SLOW",
    "THINGS IN THE BATHTUB",
    "THINGS YOU CAN BUILD",
    "THINGS AT A PICNIC",
    "THINGS THAT ARE BLUE",
    "THINGS THAT ARE PINK",
    "THINGS THAT LIGHT UP",
    "THINGS THAT SPIN",
    "THINGS YOU DO AT RECESS",
    "SONGS KIDS SING",
    "STORYBOOK CHARACTERS",
    "MAGICAL THINGS",
    "THINGS AT THE DOCTOR'S OFFICE",
    "THINGS IN A CLASSROOM",
    "THINGS ON A SCHOOL BUS",
    "HALLOWEEN COSTUMES",
    "CHRISTMAS THINGS",
    "THINGS IN AN EASTER BASKET",
    "THINGS THAT FLOAT",
    "THINGS THAT ARE SQUISHY",
    "THINGS YOU SAY TO A BABY",
    "GAMES YOU PLAY IN THE CAR",
    "THINGS THAT ARE FUZZY",
    "ICE-CREAM-TRUCK TREATS",
    "THINGS IN A SANDBOX",
    "THINGS YOU DO IN THE SNOW",
    "THINGS YOU DO IN SUMMER",
    "PLACES TO HIDE IN HIDE-AND-SEEK",
    "THINGS THAT ARE SPARKLY",
    "THINGS A PUPPY DOES",
    "SNACKS AFTER SCHOOL",
    "WORDS THAT RHYME WITH CAT",
    "WORDS THAT RHYME WITH BEE",
])

# ---------------- GRAB BAG ----------------
CATEGORIES += _deck("grab", [
    "EXCUSES FOR BEING LATE",
    "THINGS YOU SHOUT AT THE TV",
    "THINGS TO BRING TO A DESERT ISLAND",
    "THINGS THAT GLOW",
    "SUPERPOWERS",
    "WISHES FOR A GENIE",
    "THINGS IN A WIZARD'S POCKET",
    "THINGS THAT ARE FREE",
    "THINGS PEOPLE COLLECT",
    "THINGS THAT COME IN PAIRS",
    "THINGS YOU SHOULDN'T DO IN A LIBRARY",
    "WAYS TO SAY GOODBYE",
    "THINGS THAT FIT IN YOUR POCKET",
    "THINGS THAT ARE IMPOSSIBLE TO DO QUIETLY",
    "REASONS TO STAY UP LATE",
    "THINGS YOU DO WHEN THE WIFI IS DOWN",
    "THINGS GROWN-UPS COMPLAIN ABOUT",
    "THINGS THAT MAKE YOU SLEEPY",
    "THINGS PEOPLE FORGET TO PACK",
    "KINDS OF HATS",
    "JOBS THAT NEED UNIFORMS",
    "THINGS SOLD BY THE DOZEN",
    "WORDS THAT SOUND FUNNY",
    "THINGS YOU CAN DO WITH ONE HAND",
    "NICKNAMES FOR GRANDMA",
    "GOOD NAMES FOR A DOG",
    "THINGS A SPY CARRIES",
    "THINGS AT THE CIRCUS",
    "THINGS AT A WEDDING",
    "THINGS AT SUMMER CAMP",
    "THINGS THAT ARE INVISIBLE",
    "NOISES THAT WAKE YOU UP",
    "THINGS IN A PARADE",
    "THINGS AT A MAGIC SHOW",
    "KINDS OF DANCES",
    "WAYS TO SAY 'AWESOME'",
    "THINGS PEOPLE DO IN ELEVATORS",
    "THINGS YOU DO ON A RAINY DAY",
    "GOOD LUCK CHARMS",
    "THINGS MADE OF PAPER",
    "THINGS YOU SAVE UP TO BUY",
], [
    "JOBS ROBOTS CAN'T DO",
    "WORST THINGS TO SAY AT A JOB INTERVIEW",
    "ONE-WORD MOVIE TITLES",
    "GOOD NAMES FOR A BOAT",
    "INSTRUMENTS IN A MARCHING BAND",
    "WORDS WITH DOUBLE LETTERS",
])


# ---------------- helpers ----------------

def _spice2_fraction(slug: str) -> float:
    cats = [c for c in CATEGORIES if c["deck"] == slug]
    return sum(1 for c in cats if c["spice"] == 2) / max(1, len(cats))


# lobby default: every deck that isn't spice-2-heavy
DEFAULT_DECK_SLUGS = [s for s in DECKS if _spice2_fraction(s) <= 0.5]

_FAMILY_WEIGHT = 4.0     # family mode: spice-1 cats 4x more likely


def deck_meta() -> list[dict]:
    """Static deck info for the lobby (shipped inside every state push)."""
    out = []
    for slug, d in DECKS.items():
        cats = [c for c in CATEGORIES if c["deck"] == slug]
        out.append({
            "slug": slug, "title": d["title"], "icon": d["icon"],
            "blurb": d["blurb"], "count": len(cats),
            "hard": sum(1 for c in cats if c["spice"] == 2),
            "default": slug in DEFAULT_DECK_SLUGS,
        })
    return out


_DECK_META = None


def deck_meta_cached() -> list[dict]:
    global _DECK_META
    if _DECK_META is None:
        _DECK_META = deck_meta()
    return _DECK_META


def draw(decks, n, seed, wild=False) -> list[dict]:
    """Draw n categories from the given decks — deterministic for a seed,
    never repeating within the draw (i.e. within a match). Family mode
    (wild=False) weights spice-1 categories heavily; wild treats all equal.
    Weighted sampling without replacement (Efraimidis–Spirakis keys)."""
    decks = set(decks)
    pool = [c for c in CATEGORIES if c["deck"] in decks]
    rng = random.Random(seed)
    keyed = []
    for c in pool:
        w = 1.0 if (wild or c["spice"] == 2) else _FAMILY_WEIGHT
        keyed.append((rng.random() ** (1.0 / w), c))
    keyed.sort(key=lambda kv: -kv[0])
    return [c for _, c in keyed[:max(0, n)]]
