"""Deterministic, modular crisis generation for THE FIFTH SIGNAL.

The game has five semantic stations and five tactile console types.  Every
crisis uses every console type exactly once, but shuffles which station gets
which hardware.  A station never receives its own answer: its target is carried
as a private relay by another station owned by a different human.

There are deliberately far more combinations here than a family can exhaust.
Frames, console panels, target values, kind permutations, relay wording and
role ownership all combine under the session RNG.  ``signature`` is a stable
content hash used by the session to reject recently played combinations.
"""

from __future__ import annotations

import copy
import hashlib
import itertools
import json


ROLES = (
    {"id": "helm", "title": "HELM", "icon": "🧭",
     "description": "Thread the station through moving debris."},
    {"id": "core", "title": "CORE", "icon": "⚡",
     "description": "Keep power inside the safe envelope."},
    {"id": "relay", "title": "RELAY", "icon": "📡",
     "description": "Decode and route the crew's hidden signals."},
    {"id": "life", "title": "LIFE", "icon": "✚",
     "description": "Protect atmosphere, temperature and crew."},
    {"id": "ops", "title": "OPS", "icon": "◫",
     "description": "Coordinate the station's physical systems."},
)
ROLE_IDS = tuple(role["id"] for role in ROLES)
ROLE_BY_ID = {role["id"]: role for role in ROLES}
CONTROL_KINDS = ("choice", "sequence", "dial", "switches", "balance")


# Public story frames.  They contain atmosphere only; solutions live solely in
# generated task targets and are never copied into the public crisis payload.
CRISIS_BANK = (
    {"id": "solar-shear", "title": "SOLAR SHEAR",
     "alert": "A magnetic wave is twisting the station out of orbit.",
     "system": "MAGNETIC SHIELD", "icon": "☀"},
    {"id": "ghost-beacon", "title": "GHOST BEACON",
     "alert": "A distress call is echoing from a ship that does not exist.",
     "system": "SIGNAL ARRAY", "icon": "◌"},
    {"id": "ice-bloom", "title": "ICE BLOOM",
     "alert": "Flash-frozen coolant is spreading through the service ring.",
     "system": "THERMAL LOOP", "icon": "❄"},
    {"id": "meteor-lattice", "title": "METEOR LATTICE",
     "alert": "A rotating debris field has closed around the hull.",
     "system": "DEFLECTOR GRID", "icon": "◆"},
    {"id": "gravity-knot", "title": "GRAVITY KNOT",
     "alert": "Local gravity is folding corridors across one another.",
     "system": "GRAVITY RING", "icon": "◎"},
    {"id": "oxygen-ghost", "title": "OXYGEN GHOST",
     "alert": "Atmosphere readings disagree in every occupied deck.",
     "system": "AIR PROCESSOR", "icon": "◒"},
    {"id": "reactor-echo", "title": "REACTOR ECHO",
     "alert": "The core is answering its own pulses half a second late.",
     "system": "REACTOR CLOCK", "icon": "⬡"},
    {"id": "drone-awakening", "title": "DRONE AWAKENING",
     "alert": "Dormant repair drones have mistaken the crew for damage.",
     "system": "DRONE MESH", "icon": "⬢"},
    {"id": "dark-transit", "title": "DARK TRANSIT",
     "alert": "The station has entered a region where the stars disappear.",
     "system": "INERTIAL MAP", "icon": "●"},
    {"id": "hull-song", "title": "HULL SONG",
     "alert": "A resonance is turning the outer hull into a giant speaker.",
     "system": "DAMPING FIELD", "icon": "≋"},
    {"id": "plasma-tide", "title": "PLASMA TIDE",
     "alert": "Charged gas is climbing the station like a breaking wave.",
     "system": "GROUNDING WEB", "icon": "ϟ"},
    {"id": "memory-rain", "title": "MEMORY RAIN",
     "alert": "Navigation data is falling out of storage in random fragments.",
     "system": "ARCHIVE CORE", "icon": "▦"},
    {"id": "false-dawn", "title": "FALSE DAWN",
     "alert": "Every exterior sensor reports a different sunrise.",
     "system": "SENSOR CLOCK", "icon": "◐"},
    {"id": "silent-boarder", "title": "SILENT BOARDER",
     "alert": "Something has docked without mass, heat or an identity code.",
     "system": "DOCKING SPINE", "icon": "◇"},
    {"id": "quantum-leak", "title": "QUANTUM LEAK",
     "alert": "Small objects are arriving moments before they are moved.",
     "system": "CAUSALITY SEAL", "icon": "⌁"},
    {"id": "comet-tail", "title": "COMET TAIL",
     "alert": "A comet plume has blinded the station and charged the hull.",
     "system": "POLARITY SKIN", "icon": "☄"},
    {"id": "tidal-lock", "title": "TIDAL LOCK",
     "alert": "A moonlet is forcing the station to face one direction.",
     "system": "ATTITUDE RING", "icon": "◑"},
    {"id": "nanite-fog", "title": "NANITE FOG",
     "alert": "Repair nanites are rebuilding working systems into sculptures.",
     "system": "FABRICATOR BUS", "icon": "▪"},
    {"id": "clock-split", "title": "CLOCK SPLIT",
     "alert": "The bow and stern now disagree about what second it is.",
     "system": "TIME BUS", "icon": "◷"},
    {"id": "stowaway-star", "title": "STOWAWAY STAR",
     "alert": "A miniature fusion point has appeared in cargo storage.",
     "system": "CONTAINMENT BAY", "icon": "✦"},
    {"id": "mirror-swarm", "title": "MIRROR SWARM",
     "alert": "Thousands of reflective fragments are copying our maneuvers.",
     "system": "OPTICAL SCREEN", "icon": "◈"},
    {"id": "pressure-cascade", "title": "PRESSURE CASCADE",
     "alert": "Deck pressure is stepping upward one compartment at a time.",
     "system": "BULKHEAD NET", "icon": "▤"},
    {"id": "orbit-skip", "title": "ORBIT SKIP",
     "alert": "The station is jumping forward several kilometers per pulse.",
     "system": "POSITION LOCK", "icon": "⌖"},
    {"id": "sleeping-sun", "title": "SLEEPING SUN",
     "alert": "Solar output vanished, but the station is still overheating.",
     "system": "RADIATOR CROWN", "icon": "◉"},
)


CHOICE_PANELS = (
    ("VECTOR GATE", ("ORION", "LYRA", "DRACO", "VESTA", "NOVA")),
    ("COOLANT TYPE", ("ARGON", "NEON", "XENON", "HELIUM", "KRYPTON")),
    ("ROUTE BAND", ("AMBER", "CYAN", "VIOLET", "WHITE", "SCARLET")),
    ("ORBIT MARK", ("APEX", "NADIR", "ZENITH", "UMBRA", "PERIGEE")),
    ("LOCK CODE", ("FALCON", "MANTIS", "COBRA", "RAVEN", "TIGER")),
    ("WAVE SHAPE", ("PULSE", "SAW", "SINE", "STEP", "ARC")),
    ("DOCK LANE", ("ATLAS", "BASIL", "CERES", "DELTA", "ECHO")),
    ("FILTER", ("QUARTZ", "CARBON", "SILVER", "COBALT", "GLASS")),
    ("PROTOCOL", ("AURORA", "CINDER", "HALO", "MIRAGE", "TEMPEST")),
    ("CHAMBER", ("ALPHA", "BRAVO", "GAMMA", "KAPPA", "OMEGA")),
)

SEQUENCE_PANELS = (
    ("IGNITION KEYS", ("△", "○", "□", "◇", "✦")),
    ("PULSE KEYS", ("RED", "BLUE", "GOLD", "GREEN", "WHITE")),
    ("BEACON NOTES", ("DO", "RE", "MI", "FA", "SO")),
    ("THRUSTER BANKS", ("A", "B", "C", "D", "E")),
    ("GLYPH BUS", ("SUN", "MOON", "STAR", "WAVE", "EYE")),
    ("DECK KEYS", ("ONE", "TWO", "THREE", "FOUR", "FIVE")),
    ("PHASE TAPS", ("IN", "OUT", "UP", "DOWN", "HOLD")),
    ("RELAY NODES", ("KILO", "LIMA", "MIKE", "NOVEMBER", "OSCAR")),
    ("CORE CHORD", ("ION", "ARC", "FLUX", "VOID", "NOVA")),
    ("VALVE ORDER", ("NORTH", "EAST", "SOUTH", "WEST", "CENTER")),
)

DIAL_PANELS = (
    ("FREQUENCY", "MHz", 10, 90, 5),
    ("COOLANT", "K", 180, 300, 10),
    ("THRUST", "%", 10, 90, 10),
    ("PHASE", "°", 0, 315, 45),
    ("PRESSURE", "kPa", 40, 120, 10),
    ("GAIN", "dB", -12, 12, 3),
    ("ROTATION", "rpm", 20, 100, 10),
    ("OXYGEN", "%", 16, 28, 2),
    ("FIELD", "mT", 5, 45, 5),
    ("DELAY", "ms", 20, 180, 20),
)

SWITCH_PANELS = (
    ("POWER BUSES", ("ALPHA", "BETA", "GAMMA", "DELTA", "EPSILON")),
    ("DECK VALVES", ("BRIDGE", "LAB", "BAY", "RING", "HAB")),
    ("SHIELD SECTORS", ("FORE", "AFT", "PORT", "STARBOARD", "CORE")),
    ("DATA PATHS", ("ONE", "TWO", "THREE", "FOUR", "FIVE")),
    ("COOLANT LOOPS", ("RED", "BLUE", "GREEN", "WHITE", "GOLD")),
    ("RELAY MASTS", ("NORTH", "EAST", "SOUTH", "WEST", "CROWN")),
    ("FUEL CELLS", ("ION", "ARC", "FLUX", "NOVA", "PRIME")),
    ("BULKHEADS", ("A1", "B2", "C3", "D4", "E5")),
    ("SENSOR BANKS", ("OPTIC", "THERMAL", "MASS", "RADAR", "TIME")),
    ("GROUND NODES", ("ATLAS", "CERES", "LYRA", "ORION", "VESTA")),
)

BALANCE_PANELS = (
    ("GRAVITY TRIM", "PORT / STARBOARD", "BOW / STERN"),
    ("INERTIAL BUBBLE", "LEFT / RIGHT", "UP / DOWN"),
    ("REACTOR FLOAT", "NEGATIVE / POSITIVE", "LOW / HIGH"),
    ("ATTITUDE PLATE", "PORT / STARBOARD", "DIVE / CLIMB"),
    ("FIELD CENTER", "WEST / EAST", "SOUTH / NORTH"),
    ("COOLANT LEVEL", "LOOP A / LOOP B", "FORE / AFT"),
    ("SIGNAL LENS", "LOW BAND / HIGH BAND", "NEAR / FAR"),
    ("MASS CRADLE", "RING / CORE", "BOW / STERN"),
    ("SHIELD BIAS", "PORT / STARBOARD", "VENTRAL / DORSAL"),
    ("DOCKING TRIM", "LEFT / RIGHT", "DOWN / UP"),
)

RELAY_LINES = (
    "{target} needs {value}. Say it clearly.",
    "Pass this to {name}: {target} = {value}.",
    "Your decoded fragment belongs to {target}: {value}.",
    "Tell {name} to set {target} to {value}.",
    "Signal recovered for {target}. The answer is {value}.",
    "Cross-channel key for {name}: {value} on {target}.",
    "Do not use this on your panel. Relay {value} to {target}.",
    "{target} calibration confirmed as {value}. Get it to {name}.",
)

DIFFICULTY = {
    "easy": {"choice_n": 3, "sequence_n": 3, "switch_n": 3, "balance": 1},
    "standard": {"choice_n": 4, "sequence_n": 4, "switch_n": 4, "balance": 2},
    "expert": {"choice_n": 5, "sequence_n": 5, "switch_n": 5, "balance": 2},
}


def role_public(role_id):
    """Return a fresh, public-safe role descriptor."""
    role = ROLE_BY_ID[role_id]
    return {key: role[key] for key in ("id", "title", "icon", "description")}


def assign_roles(tokens, rng):
    """Return balanced role ownership plus a cross-human relay cycle.

    ``owners`` maps semantic role id to an internal token. ``relay_targets``
    maps the role carrying a clue to the role whose console that clue solves.
    The latter is a five-cycle and every edge crosses between different humans,
    including the fused-role layouts used by three- and four-player crews.
    """
    people = list(tokens)
    if not 3 <= len(people) <= 5:
        raise ValueError("THE FIFTH SIGNAL requires three to five humans")
    rng.shuffle(people)
    shuffled_roles = list(ROLE_IDS)
    rng.shuffle(shuffled_roles)
    owners = {
        role_id: people[index % len(people)]
        for index, role_id in enumerate(shuffled_roles)
    }

    valid_cycles = [
        cycle for cycle in itertools.permutations(ROLE_IDS)
        if all(owners[cycle[i]] != owners[cycle[(i + 1) % len(cycle)]]
               for i in range(len(cycle)))
    ]
    # The balanced 3/4/5 layouts above always admit a cycle.  Keep the explicit
    # guard because silently giving somebody their own answer breaks the game.
    if not valid_cycles:
        raise RuntimeError("could not construct a cross-human relay cycle")
    cycle = valid_cycles[rng.randrange(len(valid_cycles))]
    relay_targets = {
        cycle[index]: cycle[(index + 1) % len(cycle)]
        for index in range(len(cycle))
    }
    return owners, relay_targets


def _choice_task(rng, level):
    label, all_options = rng.choice(CHOICE_PANELS)
    options = list(all_options[:level["choice_n"]])
    rng.shuffle(options)
    return {
        "kind": "choice",
        "prompt": label,
        "spec": {"options": options},
        "target": rng.choice(options),
        "panel": label,
    }


def _sequence_task(rng, level):
    label, keys = rng.choice(SEQUENCE_PANELS)
    keys = list(keys)
    length = level["sequence_n"]
    return {
        "kind": "sequence",
        "prompt": label,
        "spec": {"keys": keys, "length": length},
        "target": [rng.choice(keys) for _ in range(length)],
        "panel": label,
    }


def _dial_task(rng, _level):
    label, unit, low, high, step = rng.choice(DIAL_PANELS)
    slots = ((high - low) // step) + 1
    return {
        "kind": "dial",
        "prompt": label,
        "spec": {"min": low, "max": high, "step": step, "unit": unit},
        "target": low + step * rng.randrange(slots),
        "panel": label,
    }


def _switches_task(rng, level):
    label, all_labels = rng.choice(SWITCH_PANELS)
    labels = list(all_labels[:level["switch_n"]])
    target = [bool(rng.randrange(2)) for _ in labels]
    if all(target) or not any(target):
        target[rng.randrange(len(target))] = not target[0]
    return {
        "kind": "switches",
        "prompt": label,
        "spec": {"labels": labels},
        "target": target,
        "panel": label,
    }


def _balance_task(rng, level):
    label, x_axis, y_axis = rng.choice(BALANCE_PANELS)
    limit = level["balance"]
    target = {"x": rng.randint(-limit, limit), "y": rng.randint(-limit, limit)}
    if target == {"x": 0, "y": 0}:
        target["x"] = rng.choice((-limit, limit))
    return {
        "kind": "balance",
        "prompt": label,
        "spec": {
            "min": -limit, "max": limit, "step": 1, "motion": True,
            "x_axis": x_axis, "y_axis": y_axis,
        },
        "target": target,
        "panel": label,
    }


TASK_BUILDERS = {
    "choice": _choice_task,
    "sequence": _sequence_task,
    "dial": _dial_task,
    "switches": _switches_task,
    "balance": _balance_task,
}


def format_value(task, value):
    """Human-readable relay text for a control value."""
    kind = task["kind"]
    if kind == "sequence":
        return " → ".join(value)
    if kind == "dial":
        return "%s%s" % (value, task["spec"]["unit"])
    if kind == "switches":
        return ", ".join(
            "%s %s" % (label, "ON" if enabled else "OFF")
            for label, enabled in zip(task["spec"]["labels"], value)
        )
    if kind == "balance":
        return "X %s, Y %s" % (
            "%+d" % value["x"], "%+d" % value["y"])
    return str(value)


def _signature(frame, tasks):
    shape = {
        "frame": frame["id"],
        "tasks": {
            role_id: {
                "kind": task["kind"],
                "panel": task["panel"],
                "target": task["target"],
            }
            for role_id, task in sorted(tasks.items())
        },
    }
    raw = json.dumps(shape, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _candidate(rng, difficulty):
    frame = copy.deepcopy(rng.choice(CRISIS_BANK))
    kinds = list(CONTROL_KINDS)
    rng.shuffle(kinds)
    level = DIFFICULTY[difficulty]
    tasks = {
        role_id: TASK_BUILDERS[kind](rng, level)
        for role_id, kind in zip(ROLE_IDS, kinds)
    }
    return frame, tasks, _signature(frame, tasks)


def generate_crisis(
        rng, difficulty="standard", recent=(), blocked_frames=(),
        previous_kinds=None):
    """Generate a deterministic crisis satisfying the mission cooldowns.

    Rejection uses only the supplied RNG, so equal RNG state plus equal recent
    history produces byte-identical output.  Besides rejecting full signatures,
    callers may forbid story frames for the rest of a mission and forbid each
    semantic role's immediately previous console kind.
    """
    if difficulty not in DIFFICULTY:
        raise ValueError("unknown difficulty")
    blocked = set(recent)
    blocked_frames = set(blocked_frames)
    previous_kinds = dict(previous_kinds or {})
    last = None
    for _ in range(160):
        frame, tasks, signature = _candidate(rng, difficulty)
        last = (frame, tasks, signature)
        if (
            signature not in blocked
            and frame["id"] not in blocked_frames
            and all(task["kind"] != previous_kinds.get(role_id)
                    for role_id, task in tasks.items())
        ):
            return {
                "signature": signature,
                "frame": frame,
                "tasks": tasks,
            }

    # A pathological/custom RNG can repeat one draw forever.  Reassign the
    # already-generated distinct panels across roles and walk unused frames.
    # This changes real playable content and remains deterministic.
    _, last_tasks, _ = last
    available_frames = [
        copy.deepcopy(frame) for frame in CRISIS_BANK
        if frame["id"] not in blocked_frames
    ]
    for frame in available_frames:
        task_list = [last_tasks[role_id] for role_id in ROLE_IDS]
        for order in itertools.permutations(range(len(task_list))):
            tasks = {
                role_id: copy.deepcopy(task_list[order[index]])
                for index, role_id in enumerate(ROLE_IDS)
            }
            if any(task["kind"] == previous_kinds.get(role_id)
                   for role_id, task in tasks.items()):
                continue
            signature = _signature(frame, tasks)
            if signature not in blocked:
                return {
                    "signature": signature,
                    "frame": frame,
                    "tasks": tasks,
                }
    raise RuntimeError("scenario bank exhausted by mission cooldowns")


def build_relays(scenario, relay_targets, owners, players, rng):
    """Build one private solution-bearing relay per semantic role.

    Keys are the roles carrying the relay.  ``players`` is token -> Player and
    is consulted only to personalize the intended recipient with public fields.
    """
    relays = {}
    for holder_role, target_role in relay_targets.items():
        target_task = scenario["tasks"][target_role]
        target_owner = owners[target_role]
        target_player = players[target_owner]
        target_meta = ROLE_BY_ID[target_role]
        value = copy.deepcopy(target_task["target"])
        rendered = format_value(target_task, value)
        template = rng.choice(RELAY_LINES)
        relays[holder_role] = {
            "target_role": target_role,
            "target_title": target_meta["title"],
            "target_icon": target_meta["icon"],
            "target_pid": target_player.pid,
            "target_name": target_player.name,
            "text": template.format(
                target=target_meta["title"], name=target_player.name,
                value=rendered),
            "value": value,
        }
    return relays
