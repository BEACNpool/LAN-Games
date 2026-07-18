import json
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from games.werewolf import game as ww
from games.werewolf.game import WerewolfSession, role_plan


# ---------------- harness ----------------

def make(n=7, seed=11, **settings):
    s = WerewolfSession(rng=random.Random(seed))
    toks = [f"ww-token-{i:02d}xx" for i in range(n)]
    for i, t in enumerate(toks):
        s.join(t, f"P{i}", None)
        s.set_ready(t, True)
    if settings:
        s.settings.update(settings)
    s.start(toks[0])
    s.tick(s.gen)               # countdown fires -> game_start -> "role"
    assert s.phase == "role"
    return s, toks


def by_role(s):
    m = {"wolf": [], "seer": [], "doctor": [], "villager": []}
    for t in s.g["order"]:
        m[s.g["roles"][t]].append(t)
    return m


def to_wolf_phase(s):
    assert s.phase == "role"
    s.tick(s.gen)               # -> night_intro
    assert s.phase == "night_intro"
    s.tick(s.gen)               # -> night_wolf
    assert s.phase == "night_wolf"


def pid(s, tok):
    return s.players[tok].pid


def run_night(s, kill, seer_target=None, doctor_target=None):
    """Drive night_wolf..dawn. kill=None leaves the wolves idle (timeout)."""
    r = by_role(s)
    assert s.phase == "night_wolf"
    if kill is not None:
        for w in [t for t in r["wolf"] if t in s.g["alive"]]:
            s.game_action(w, {"t": "wolf_pick", "pid": pid(s, kill)})
            s.game_action(w, {"t": "wolf_lock"})
    s.tick(s.gen)               # resolve wolves -> seer (or onward)
    if s.phase == "night_seer":
        if seer_target is not None:
            s.game_action(r["seer"][0], {"t": "seer_pick", "pid": pid(s, seer_target)})
        s.tick(s.gen)           # -> doctor (or onward)
    if s.phase == "night_doctor":
        if doctor_target is not None:
            s.game_action(r["doctor"][0], {"t": "doctor_pick", "pid": pid(s, doctor_target)})
        s.tick(s.gen)           # -> dawn
    assert s.phase in ("dawn", "game_end")


def past_dawn(s):
    assert s.phase == "dawn"
    s.tick(s.gen)               # -> day or game_end


def vote_out(s, target, voters=None):
    """day -> vote -> everyone (or `voters`) votes `target` -> verdict."""
    assert s.phase == "day"
    alive = [t for t in s.g["order"] if t in s.g["alive"]]
    for t in alive:
        s.game_action(t, {"t": "day_ready"})
    assert s.phase == "vote"
    for t in (voters or alive):
        s.game_action(t, {"t": "vote", "pid": pid(s, target)})
    if s.phase == "vote":       # some abstained
        s.tick(s.gen)
    assert s.phase in ("verdict", "game_end")


# ---------------- role distribution ----------------

def test_role_plan_table():
    assert role_plan(5) == (1, 1, 1)
    assert role_plan(6) == (1, 1, 1)
    assert role_plan(7) == (2, 1, 1)
    assert role_plan(8) == (2, 1, 1)
    assert role_plan(10) == (2, 1, 1)


def test_role_distribution_per_count():
    for n in range(5, 11):
        s, toks = make(n, seed=n * 7)
        r = by_role(s)
        wolves, seers, docs = role_plan(n)
        assert len(r["wolf"]) == wolves, n
        assert len(r["seer"]) == seers
        assert len(r["doctor"]) == docs
        assert len(r["villager"]) == n - wolves - seers - docs
        assert set(s.g["roles"]) == set(toks)
        assert s.g["alive"] == set(toks)


def test_no_bots_and_lobby_knobs():
    s, _ = make(5)
    assert WerewolfSession.MIN_PLAYERS == 5
    assert WerewolfSession.MAX_HUMANS == 10
    assert s.next_bot_action() is None
    assert s.validate_settings({"day_seconds": 300}) == {"day_seconds": 300}
    assert s.validate_settings({"day_seconds": 90}) == {}
    assert s.validate_settings({"day_seconds": True}) == {}


# ---------------- role reveal phase ----------------

def test_role_ack_early_advance():
    s, toks = make(6)
    for t in toks[:-1]:
        s.game_action(t, {"t": "role_ack"})
        assert s.phase == "role"
    s.game_action(toks[-1], {"t": "role_ack"})
    assert s.phase == "night_intro"
    assert s.g["night_no"] == 1


def test_role_phase_timeout_advances():
    s, toks = make(5)
    s.tick(s.gen)
    assert s.phase == "night_intro"


# ---------------- night resolution matrix ----------------

def test_wolf_kill_unprotected():
    s, toks = make(5)
    r = by_role(s)
    victim = r["villager"][0]
    to_wolf_phase(s)
    run_night(s, kill=victim, doctor_target=r["doctor"][0])
    assert victim not in s.g["alive"]
    d = s.g["dawn"]
    assert d["died"] == pid(s, victim)
    assert d["role"] == "villager"          # deaths reveal the role
    assert d["saved"] is False


def test_doctor_save():
    s, toks = make(5)
    r = by_role(s)
    victim = r["villager"][0]
    to_wolf_phase(s)
    run_night(s, kill=victim, doctor_target=victim)
    assert victim in s.g["alive"]
    d = s.g["dawn"]
    assert d["died"] is None and d["saved"] is True


def test_doctor_self_and_consecutive_repeat_allowed():
    s, toks = make(5)
    r = by_role(s)
    doc = r["doctor"][0]
    to_wolf_phase(s)
    run_night(s, kill=doc, doctor_target=doc)      # self-save
    assert doc in s.g["alive"] and s.g["dawn"]["saved"]
    past_dawn(s)
    vote_out(s, by_role(s)["villager"][0])         # burn a day
    s.tick(s.gen)                                  # verdict -> night 2
    s.tick(s.gen)                                  # night_intro -> wolves
    run_night(s, kill=doc, doctor_target=doc)      # repeat: same pick, fine
    assert doc in s.g["alive"] and s.g["dawn"]["saved"]


def test_two_wolves_agree_and_early_advance():
    s, toks = make(7)
    r = by_role(s)
    w1, w2 = r["wolf"]
    victim = r["villager"][0]
    to_wolf_phase(s)
    s.game_action(w1, {"t": "wolf_pick", "pid": pid(s, victim)})
    s.game_action(w1, {"t": "wolf_lock"})
    assert s.phase == "night_wolf"          # partner hasn't agreed yet
    s.game_action(w2, {"t": "wolf_pick", "pid": pid(s, victim)})
    s.game_action(w2, {"t": "wolf_lock"})
    # agreement shortened the phase; the tick resolves it
    s.tick(s.gen)
    assert s.g["night_kill"] == victim
    assert s.phase == "night_seer"


def test_two_wolves_disagree_timeout_random_pick():
    s, toks = make(7, seed=3)
    r = by_role(s)
    w1, w2 = r["wolf"]
    v1, v2 = r["villager"][0], r["villager"][1]
    to_wolf_phase(s)
    s.game_action(w1, {"t": "wolf_pick", "pid": pid(s, v1)})
    s.game_action(w2, {"t": "wolf_pick", "pid": pid(s, v2)})
    s.tick(s.gen)                           # timeout: random of the two
    assert s.g["night_kill"] in (v1, v2)


def test_repick_unlocks_and_lock_needs_pick():
    s, toks = make(7)
    r = by_role(s)
    w1, w2 = r["wolf"]
    v1, v2 = r["villager"][0], r["villager"][1]
    to_wolf_phase(s)
    fx = s.game_action(w1, {"t": "wolf_lock"})
    assert any(f["kind"] == "invalid" for f in fx)
    s.game_action(w1, {"t": "wolf_pick", "pid": pid(s, v1)})
    s.game_action(w1, {"t": "wolf_lock"})
    assert w1 in s.g["wolf_locks"]
    s.game_action(w1, {"t": "wolf_pick", "pid": pid(s, v2)})
    assert w1 not in s.g["wolf_locks"]      # changing your mind unlocks


def test_wolves_dawdle_random_victim_and_private_warning():
    s, toks = make(7, seed=9)
    r = by_role(s)
    to_wolf_phase(s)
    fx = s.tick(s.gen)                      # nobody picked anything
    kill = s.g["night_kill"]
    assert kill is not None and s.g["roles"][kill] != "wolf"
    warns = [f for f in fx if f["kind"] == "dawdled"]
    assert {f["to"] for f in warns} == set(r["wolf"])


def test_wolf_cannot_target_wolf_or_dead():
    s, toks = make(7)
    r = by_role(s)
    w1, w2 = r["wolf"]
    to_wolf_phase(s)
    fx = s.game_action(w1, {"t": "wolf_pick", "pid": pid(s, w2)})
    assert any(f["kind"] == "invalid" for f in fx)
    fx = s.game_action(w1, {"t": "wolf_pick", "pid": "nope"})
    assert any(f["kind"] == "invalid" for f in fx)


def test_seer_accuracy_and_one_per_night():
    s, toks = make(7)
    r = by_role(s)
    seer = r["seer"][0]
    to_wolf_phase(s)
    run_night(s, kill=r["villager"][0], seer_target=r["wolf"][0],
              doctor_target=r["doctor"][0])
    assert s.g["visions"][0]["wolf"] is True
    # vision fx went to the seer only
    past_dawn(s)
    vote_out(s, r["villager"][1])
    s.tick(s.gen); s.tick(s.gen)            # -> night 2 wolves
    run_night(s, kill=None, seer_target=r["doctor"][0])
    assert s.g["visions"][1]["wolf"] is False


def test_seer_fx_private_and_self_rejected():
    s, toks = make(7)
    r = by_role(s)
    seer = r["seer"][0]
    to_wolf_phase(s)
    s.game_action(r["wolf"][0], {"t": "wolf_pick", "pid": pid(s, r["villager"][0])})
    s.tick(s.gen)
    assert s.phase == "night_seer"
    fx = s.game_action(seer, {"t": "seer_pick", "pid": pid(s, seer)})
    assert any(f["kind"] == "invalid" for f in fx)
    fx = s.game_action(seer, {"t": "seer_pick", "pid": pid(s, r["wolf"][0])})
    vis = [f for f in fx if f["kind"] == "vision"]
    assert len(vis) == 1 and vis[0]["to"] == seer and vis[0]["wolf"] is True
    fx = s.game_action(seer, {"t": "seer_pick", "pid": pid(s, r["wolf"][1])})
    assert any(f["kind"] == "invalid" for f in fx)   # one vision per night


def test_dead_seer_and_doctor_phases_skipped():
    s, toks = make(7)
    r = by_role(s)
    to_wolf_phase(s)
    run_night(s, kill=r["seer"][0], doctor_target=r["doctor"][0])
    assert r["seer"][0] not in s.g["alive"]
    past_dawn(s)
    vote_out(s, r["doctor"][0])             # village lynches its own doctor
    s.tick(s.gen)                           # verdict -> night 2
    s.tick(s.gen)                           # night_intro -> wolves
    assert s.phase == "night_wolf"
    s.game_action(r["wolf"][0], {"t": "wolf_pick", "pid": pid(s, r["villager"][0])})
    s.game_action(r["wolf"][0], {"t": "wolf_lock"})
    s.game_action(r["wolf"][1], {"t": "wolf_pick", "pid": pid(s, r["villager"][0])})
    s.game_action(r["wolf"][1], {"t": "wolf_lock"})
    s.tick(s.gen)                           # resolve: seer AND doctor skipped
    assert s.phase == "dawn"


# ---------------- day & vote ----------------

def test_day_ready_opens_vote_early():
    s, toks = make(5)
    r = by_role(s)
    to_wolf_phase(s)
    run_night(s, kill=r["villager"][0], doctor_target=r["doctor"][0])
    past_dawn(s)
    assert s.phase == "day"
    alive = [t for t in s.g["order"] if t in s.g["alive"]]
    for t in alive[:-1]:
        s.game_action(t, {"t": "day_ready"})
        assert s.phase == "day"
    s.game_action(alive[-1], {"t": "day_ready"})
    assert s.phase == "vote"


def test_day_timeout_opens_vote():
    s, toks = make(5)
    r = by_role(s)
    to_wolf_phase(s)
    run_night(s, kill=None, doctor_target=r["doctor"][0])
    past_dawn(s)
    assert s.phase == "day"
    s.tick(s.gen)
    assert s.phase == "vote"


def test_vote_plurality_eliminates_and_reveals():
    s, toks = make(7)
    r = by_role(s)
    wolf = r["wolf"][0]
    to_wolf_phase(s)
    run_night(s, kill=r["villager"][0], doctor_target=r["doctor"][0])
    past_dawn(s)
    alive = [t for t in s.g["order"] if t in s.g["alive"]]
    for t in alive:
        s.game_action(t, {"t": "day_ready"})
    others = [t for t in alive if t != wolf]
    for t in others[:4]:
        s.game_action(t, {"t": "vote", "pid": pid(s, wolf)})
    s.game_action(wolf, {"t": "vote", "pid": pid(s, others[0])})
    s.game_action(others[4], {"t": "vote", "pid": pid(s, others[0])})
    assert s.phase == "verdict"             # all voted -> closed early
    v = s.g["verdict"]
    assert v["eliminated"] == pid(s, wolf)
    assert v["role"] == "wolf"              # elimination reveals the role
    assert v["tally"][pid(s, wolf)] == 4
    assert wolf not in s.g["alive"]


def test_vote_tie_nobody_dies():
    s, toks = make(5)
    r = by_role(s)
    to_wolf_phase(s)
    run_night(s, kill=None, doctor_target=r["doctor"][0])
    past_dawn(s)
    alive = [t for t in s.g["order"] if t in s.g["alive"]]
    a, b = alive[0], alive[1]
    for t in alive:
        s.game_action(t, {"t": "day_ready"})
    for i, t in enumerate(alive[:4]):
        s.game_action(t, {"t": "vote", "pid": pid(s, a if i % 2 else b)})
    s.game_action(alive[4], {"t": "vote", "pid": pid(s, alive[4])})
    assert s.phase == "verdict"
    v = s.g["verdict"]
    assert v["eliminated"] is None and v["tie"] is True
    assert len(s.g["alive"]) == 5           # nobody died


def test_vote_timeout_abstains():
    s, toks = make(5)
    r = by_role(s)
    to_wolf_phase(s)
    run_night(s, kill=None, doctor_target=r["doctor"][0])
    past_dawn(s)
    alive = [t for t in s.g["order"] if t in s.g["alive"]]
    for t in alive:
        s.game_action(t, {"t": "day_ready"})
    s.game_action(alive[0], {"t": "vote", "pid": pid(s, alive[1])})
    s.game_action(alive[2], {"t": "vote", "pid": pid(s, alive[1])})
    s.tick(s.gen)                           # 45s timeout
    assert s.phase == "verdict"
    v = s.g["verdict"]
    assert v["eliminated"] == pid(s, alive[1])
    assert len(v["abstained"]) == 3
    assert alive[1] not in s.g["alive"]


def test_vote_lock_is_final_and_dead_cannot_vote():
    s, toks = make(5)
    r = by_role(s)
    dead = r["villager"][0]
    to_wolf_phase(s)
    run_night(s, kill=dead, doctor_target=r["doctor"][0])
    past_dawn(s)
    alive = [t for t in s.g["order"] if t in s.g["alive"]]
    fx = s.game_action(dead, {"t": "day_ready"})
    assert any(f["kind"] == "invalid" for f in fx)
    for t in alive:
        s.game_action(t, {"t": "day_ready"})
    fx = s.game_action(dead, {"t": "vote", "pid": pid(s, alive[0])})
    assert any(f["kind"] == "invalid" for f in fx)
    s.game_action(alive[0], {"t": "vote", "pid": pid(s, alive[1])})
    fx = s.game_action(alive[0], {"t": "vote", "pid": pid(s, alive[2])})
    assert any(f["kind"] == "invalid" for f in fx)
    assert s.g["votes"][alive[0]] == alive[1]


# ---------------- win conditions ----------------

def test_village_wins_when_all_wolves_dead():
    s, toks = make(5)
    r = by_role(s)
    wolf = r["wolf"][0]
    to_wolf_phase(s)
    run_night(s, kill=r["villager"][0], doctor_target=r["doctor"][0])
    past_dawn(s)
    vote_out(s, wolf)
    s.tick(s.gen)                           # verdict beat -> win check
    assert s.phase == "game_end"
    res = s.g["result"]
    assert res["winner"] == "village"
    assert pid(s, wolf) in res["losers"]
    assert set(res["winners"]) == {pid(s, t) for t in toks if t != wolf}
    assert len(res["roles"]) == 5 and res["log"]


def test_wolves_win_by_parity_at_dawn():
    s, toks = make(5)
    r = by_role(s)
    wolf = r["wolf"][0]
    prey = [t for t in s.g["order"] if t != wolf]
    to_wolf_phase(s)
    for n in range(3):                      # 5 -> 4 -> tie day -> 3 -> ... -> 2
        run_night(s, kill=prey[n], doctor_target=None
                  if by_role(s)["doctor"][0] not in s.g["alive"]
                  else prey[(n + 1) % len(prey)])
        if s.phase == "game_end":
            break
        past_dawn(s)
        if s.phase == "game_end":
            break
        # forced 1-1 tie vote: nobody eliminated
        alive = [t for t in s.g["order"] if t in s.g["alive"]]
        for t in alive:
            s.game_action(t, {"t": "day_ready"})
        s.game_action(alive[0], {"t": "vote", "pid": pid(s, alive[1])})
        s.game_action(alive[1], {"t": "vote", "pid": pid(s, alive[0])})
        if s.phase == "vote":
            s.tick(s.gen)                   # the rest abstain on timeout
        assert s.g["verdict"]["eliminated"] is None
        s.tick(s.gen)                       # -> next night (tie kept everyone)
        s.tick(s.gen)                       # night_intro -> wolves
    assert s.phase == "game_end"
    assert s.g["result"]["winner"] == "wolves"
    assert s.g["result"]["reason"] == "parity"
    assert wolf in s.g["alive"]


def test_wolves_win_parity_after_vote():
    s, toks = make(7)                       # 2 wolves
    r = by_role(s)
    w1, w2 = r["wolf"]
    to_wolf_phase(s)
    run_night(s, kill=r["villager"][0], doctor_target=None)   # 6 alive, 2 wolves
    past_dawn(s)
    vote_out(s, r["villager"][1])           # 5 alive, 2 wolves
    s.tick(s.gen); s.tick(s.gen)
    run_night(s, kill=r["villager"][2], doctor_target=None)   # 4 alive, 2 wolves
    assert s.phase == "dawn"
    s.tick(s.gen)                           # 2 wolves vs 2 -> parity at dawn
    assert s.phase == "game_end"
    assert s.g["result"]["winner"] == "wolves"


# ---------------- anti-leak: state_for every role x viewer ----------------

ROLE_STRINGS = ('"wolf"', '"seer"', '"doctor"', '"villager"')


def stripped_blob(st, drop=("me", "dawn", "verdict", "result")):
    """Serialize the game payload minus the fields where role info is
    legitimately allowed: the viewer's own card (me), public death reveals
    (dawn/verdict/result), and the viewer's own act.type marker."""
    game = {k: v for k, v in (st["game"] or {}).items() if k not in drop}
    if isinstance(game.get("act"), dict):
        game["act"] = {k: v for k, v in game["act"].items() if k != "type"}
    return json.dumps(game, sort_keys=True)


def assert_clean_for(s, viewer, wolf_pids):
    """The core promise: an alive non-wolf viewer's payload carries ZERO role
    information about others, and no wolf pid outside neutral public lists."""
    st = s.state_for(viewer)
    for p in st["players"]:                 # envelope: no role keys at all
        assert "role" not in p and "wolf" not in json.dumps(p)
    blob = stripped_blob(st)
    for r in ROLE_STRINGS:
        assert r not in blob, (s.phase, viewer, r, blob)
    assert '"partners"' not in blob and '"omni": {' not in blob
    assert st["game"]["omni"] is None
    # wolf pids must not appear outside the neutral public lists
    game = dict(st["game"])
    for k in ("me", "dawn", "verdict", "result", "alive", "acked",
              "ready_pids", "voted_pids", "act"):
        game.pop(k, None)
    residue = json.dumps(game)
    for wp in wolf_pids:
        assert wp not in residue, (s.phase, viewer, residue)


def leak_sweep(s):
    r = by_role(s)
    wolf_pids = [pid(s, w) for w in r["wolf"]]
    # every alive non-wolf viewer, plus spectator None, plus outsider
    for viewer in r["seer"] + r["doctor"] + r["villager"]:
        if viewer in s.g["alive"]:
            assert_clean_for(s, viewer, wolf_pids)
    assert_clean_for(s, None, wolf_pids)
    # wolves never learn who the seer/doctor are
    for w in r["wolf"]:
        if w not in s.g["alive"]:
            continue
        st = s.state_for(w)
        blob = stripped_blob(st, drop=("me", "dawn", "verdict", "result"))
        assert '"seer"' not in blob and '"doctor"' not in blob, (s.phase, blob)
        assert '"villager"' not in blob
        assert st["game"]["omni"] is None
    # seer visions appear ONLY in seer (me.visions) and ghost payloads
    for viewer in r["wolf"] + r["doctor"] + r["villager"]:
        if viewer in s.g["alive"]:
            st = s.state_for(viewer)
            assert '"visions"' not in json.dumps(st["game"])


def test_leak_matrix_every_phase():
    s, toks = make(7, seed=21)
    r = by_role(s)
    leak_sweep(s)                                    # role phase
    to_wolf_phase(s)
    leak_sweep(s)                                    # night_intro passed; wolf phase
    w1, w2 = r["wolf"]
    s.game_action(w1, {"t": "wolf_pick", "pid": pid(s, r["villager"][0])})
    s.game_action(w2, {"t": "wolf_pick", "pid": pid(s, r["villager"][0])})
    leak_sweep(s)                                    # live wolf picks exist
    s.game_action(w1, {"t": "wolf_lock"})
    s.game_action(w2, {"t": "wolf_lock"})
    s.tick(s.gen)
    assert s.phase == "night_seer"
    s.game_action(r["seer"][0], {"t": "seer_pick", "pid": pid(s, w1)})
    leak_sweep(s)                                    # a vision exists now
    s.tick(s.gen)
    assert s.phase == "night_doctor"
    s.game_action(r["doctor"][0], {"t": "doctor_pick", "pid": pid(s, r["doctor"][0])})
    leak_sweep(s)
    s.tick(s.gen)
    assert s.phase == "dawn"
    leak_sweep(s)                                    # dawn reveals dead role only
    dead = r["villager"][0]
    assert s.state_for(r["villager"][1])["game"]["dawn"]["role"] == "villager"
    past_dawn(s)
    assert s.phase == "day"
    leak_sweep(s)
    alive = [t for t in s.g["order"] if t in s.g["alive"]]
    for t in alive:
        s.game_action(t, {"t": "day_ready"})
    assert s.phase == "vote"
    s.game_action(alive[0], {"t": "vote", "pid": pid(s, alive[1])})
    leak_sweep(s)                                    # votes cast, still hidden
    # ghost sweep: the dead villager is omniscient and clearly flagged
    gst = s.state_for(dead)["game"]
    assert gst["me"]["ghost"] is True
    assert gst["omni"]["roles"][pid(s, w1)] == "wolf"
    assert gst["omni"]["votes"][pid(s, alive[0])] == pid(s, alive[1])
    assert gst["omni"]["visions"][0]["wolf"] is True


def test_wolf_sees_partner_but_not_specials():
    s, toks = make(7, seed=5)
    r = by_role(s)
    w1, w2 = r["wolf"]
    to_wolf_phase(s)
    st = s.state_for(w1)["game"]
    assert st["me"]["partners"] == [pid(s, w2)]
    assert st["act"]["type"] == "wolf"
    assert pid(s, w2) not in st["act"]["targets"]    # can't eat your partner
    s.game_action(w2, {"t": "wolf_pick", "pid": pid(s, r["villager"][0])})
    st = s.state_for(w1)["game"]
    assert st["act"]["picks"][pid(s, w2)] == pid(s, r["villager"][0])
    # a villager in the same phase sees NO act block and no picks
    vst = s.state_for(r["villager"][0])["game"]
    assert vst["act"] is None and vst["me"]["role"] == "villager"


def test_vote_tally_hidden_until_closed():
    s, toks = make(5)
    r = by_role(s)
    to_wolf_phase(s)
    run_night(s, kill=None, doctor_target=r["doctor"][0])
    past_dawn(s)
    alive = [t for t in s.g["order"] if t in s.g["alive"]]
    for t in alive:
        s.game_action(t, {"t": "day_ready"})
    s.game_action(alive[0], {"t": "vote", "pid": pid(s, alive[1])})
    s.game_action(alive[2], {"t": "vote", "pid": pid(s, alive[1])})
    for viewer in alive:
        blob = json.dumps(s.state_for(viewer)["game"])
        assert '"tally"' not in blob
        st = s.state_for(viewer)["game"]
        assert st["verdict"] is None
        assert set(st["voted_pids"]) == {pid(s, alive[0]), pid(s, alive[2])}
        # my own locked vote is mine to see; nobody else's
        if viewer == alive[0]:
            assert st["act"]["vote"] == pid(s, alive[1])
        elif viewer not in (alive[0], alive[2]):
            assert st["act"]["vote"] is None
    s.tick(s.gen)
    assert s.phase == "verdict"
    st = s.state_for(alive[3])["game"]
    assert st["verdict"]["tally"][pid(s, alive[1])] == 2


def test_spectator_and_midgame_joiner_get_public_only():
    s, toks = make(5)
    to_wolf_phase(s)
    s.join("spec-token-99zz", "Late", None)
    for viewer in (None, "spec-token-99zz"):
        st = s.state_for(viewer)
        assert st["game"]["me"] is None
        assert st["game"]["act"] is None
        assert st["game"]["omni"] is None
        blob = stripped_blob(st)
        for r in ROLE_STRINGS:
            assert r not in blob


def test_ghost_omniscience_live_wolf_picks():
    s, toks = make(7, seed=8)
    r = by_role(s)
    dead = r["villager"][0]
    to_wolf_phase(s)
    run_night(s, kill=dead, doctor_target=None)
    past_dawn(s)
    vote_out(s, r["villager"][1], voters=[t for t in s.g["order"]
                                          if t in s.g["alive"]][:3])
    s.tick(s.gen); s.tick(s.gen)            # -> night 2 wolves
    assert s.phase == "night_wolf"
    s.game_action(r["wolf"][0], {"t": "wolf_pick", "pid": pid(s, r["seer"][0])})
    gst = s.state_for(dead)["game"]
    assert gst["me"]["ghost"] is True
    assert gst["omni"]["wolf_picks"][pid(s, r["wolf"][0])] == pid(s, r["seer"][0])
    assert gst["omni"]["roles"][pid(s, r["wolf"][1])] == "wolf"
    # ghosts cannot act
    fx = s.game_action(dead, {"t": "wolf_pick", "pid": pid(s, r["seer"][0])})
    assert any(f["kind"] == "invalid" for f in fx)


# ---------------- disconnects ----------------

def test_solo_wolf_disconnect_forfeit():
    s, toks = make(5)
    r = by_role(s)
    wolf = r["wolf"][0]
    to_wolf_phase(s)
    run_night(s, kill=r["villager"][0], doctor_target=r["doctor"][0])
    past_dawn(s)
    assert s.phase == "day"
    s.leave(wolf)
    assert s.g["wolf_gone_at"] is not None
    assert s.deadline <= time.time() + ww.FORFEIT_SECONDS + 1   # watch armed
    s.g["wolf_gone_at"] = time.time() - ww.FORFEIT_SECONDS - 1  # fast-forward
    s.tick(s.gen)
    assert s.phase == "game_end"
    assert s.g["result"]["winner"] == "village"
    assert s.g["result"]["reason"] == "forfeit"


def test_wolf_reconnect_cancels_forfeit():
    s, toks = make(5)
    r = by_role(s)
    wolf = r["wolf"][0]
    to_wolf_phase(s)
    run_night(s, kill=r["villager"][0], doctor_target=r["doctor"][0])
    past_dawn(s)
    s.leave(wolf)
    assert s.g["wolf_gone_at"] is not None
    s.join(wolf)                            # reconnect grace
    assert s.g["wolf_gone_at"] is None
    assert abs(s.deadline - s.g["phase_ends"]) < 0.01   # day clock restored
    s.g["wolf_gone_at"] = None
    s.tick(s.gen)                           # day timeout still works
    assert s.phase == "vote"


def test_pair_wolf_disconnect_no_forfeit():
    s, toks = make(7)
    r = by_role(s)
    to_wolf_phase(s)
    s.leave(r["wolf"][0])
    assert s.g["wolf_gone_at"] is None      # the pack hunts on alone
    s.game_action(r["wolf"][1], {"t": "wolf_pick", "pid": pid(s, r["villager"][0])})
    s.game_action(r["wolf"][1], {"t": "wolf_lock"})
    s.tick(s.gen)                           # solo connected wolf's lock counts
    assert s.g["night_kill"] == r["villager"][0]


def test_disconnected_wolf_pick_does_not_override_confirmed_kill():
    # W2 taps a victim then drops WITHOUT locking; the connected W1 then locks
    # a different victim and sees KILL CONFIRMED. The resolved kill must be
    # W1's pick every time — an absent wolf's stale tap must never win the flip.
    for seed in range(8):
        s, toks = make(7, seed=seed)
        r = by_role(s)
        w1, w2 = r["wolf"][0], r["wolf"][1]
        vills = [t for t in r["villager"] if t in s.g["alive"]]
        v_conn, v_disc = vills[0], vills[1]
        to_wolf_phase(s)
        s.game_action(w2, {"t": "wolf_pick", "pid": pid(s, v_disc)})   # no lock
        s.leave(w2)                                                    # drops
        s.game_action(w1, {"t": "wolf_pick", "pid": pid(s, v_conn)})
        s.game_action(w1, {"t": "wolf_lock"})
        s.tick(s.gen)                                                  # resolve
        assert s.g["night_kill"] == v_conn, "seed %d picked the absent wolf's tap" % seed


def test_forfeit_arms_when_last_connected_wolf_voted_out():
    # 2 wolves: W2 drops while W1 is connected (no forfeit yet). The village
    # then votes out W1, leaving only the absent W2 alive — the forfeit clock
    # must start rather than stranding the village against an AFK wolf.
    s, toks = make(7, seed=3)
    r = by_role(s)
    w1, w2 = r["wolf"][0], r["wolf"][1]
    victim = r["villager"][0]
    to_wolf_phase(s)
    run_night(s, kill=victim, doctor_target=victim)   # doctor saves — nobody dies
    past_dawn(s)
    assert s.phase == "day"
    s.leave(w2)
    assert s.g["wolf_gone_at"] is None                # W1 still connected
    vote_out(s, w1)                                    # -> verdict
    s.tick(s.gen)                                      # verdict beat -> night_falls
    assert w2 in s.g["alive"] and s.phase != "game_end"
    assert s.g["wolf_gone_at"] is not None            # forfeit now armed


def test_disconnected_wolves_idle_no_random_kill():
    s, toks = make(5)
    r = by_role(s)
    wolf = r["wolf"][0]
    to_wolf_phase(s)
    s.leave(wolf)
    s.tick(s.gen)                           # wolf phase times out — idle, no kill
    while s.phase in ("night_seer", "night_doctor"):
        s.tick(s.gen)
    assert s.phase == "dawn"
    assert s.g["dawn"]["died"] is None and s.g["dawn"]["saved"] is False


def test_reconnect_restores_private_screen():
    s, toks = make(7)
    r = by_role(s)
    w1 = r["wolf"][0]
    to_wolf_phase(s)
    s.game_action(w1, {"t": "wolf_pick", "pid": pid(s, r["villager"][0])})
    s.leave(w1)
    s.join(w1)
    st = s.state_for(w1)["game"]
    assert st["me"]["role"] == "wolf"
    assert st["act"]["picks"][pid(s, w1)] == pid(s, r["villager"][0])


def test_nonvoter_disconnect_closes_vote():
    s, toks = make(5)
    r = by_role(s)
    to_wolf_phase(s)
    run_night(s, kill=None, doctor_target=r["doctor"][0])
    past_dawn(s)
    alive = [t for t in s.g["order"] if t in s.g["alive"]]
    for t in alive:
        s.game_action(t, {"t": "day_ready"})
    for t in alive[:4]:
        s.game_action(t, {"t": "vote", "pid": pid(s, alive[0])})
    assert s.phase == "vote"
    s.leave(alive[4])                       # last holdout's phone dies
    assert s.phase == "verdict"
    assert pid(s, alive[4]) in s.g["verdict"]["abstained"]


# ---------------- the full scripted seven-player night ----------------

def test_full_seeded_seven_player_game():
    s, toks = make(7, seed=42)
    r = by_role(s)
    w1, w2 = r["wolf"]
    seer, doc = r["seer"][0], r["doctor"][0]
    v1, v2, v3 = r["villager"]

    for t in toks:                          # everyone confirms their card
        s.game_action(t, {"t": "role_ack"})
    assert s.phase == "night_intro"
    s.tick(s.gen)

    # NIGHT 1: wolves agree on v1; seer reads w1; doctor guards v2 (miss)
    s.game_action(w1, {"t": "wolf_pick", "pid": pid(s, v1)})
    s.game_action(w1, {"t": "wolf_lock"})
    s.game_action(w2, {"t": "wolf_pick", "pid": pid(s, v1)})
    s.game_action(w2, {"t": "wolf_lock"})
    s.tick(s.gen)
    s.game_action(seer, {"t": "seer_pick", "pid": pid(s, w1)})
    s.tick(s.gen)
    s.game_action(doc, {"t": "doctor_pick", "pid": pid(s, v2)})
    s.tick(s.gen)
    assert s.phase == "dawn"
    assert s.g["dawn"]["died"] == pid(s, v1)
    s.tick(s.gen)

    # DAY 1: the seer talks; everyone votes out w1
    assert s.phase == "day"
    vote_out(s, w1)
    assert s.g["verdict"]["role"] == "wolf"
    s.tick(s.gen)
    assert s.phase == "night_intro"         # 5 alive, 1 wolf: game continues

    # NIGHT 2: w2 goes for the seer; doctor saves the seer
    s.tick(s.gen)
    s.game_action(w2, {"t": "wolf_pick", "pid": pid(s, seer)})
    s.game_action(w2, {"t": "wolf_lock"})
    s.tick(s.gen)
    s.game_action(seer, {"t": "seer_pick", "pid": pid(s, w2)})
    s.tick(s.gen)
    s.game_action(doc, {"t": "doctor_pick", "pid": pid(s, seer)})
    s.tick(s.gen)
    assert s.phase == "dawn"
    assert s.g["dawn"]["saved"] is True and s.g["dawn"]["died"] is None
    s.tick(s.gen)

    # DAY 2: seer has both wolves confirmed; w2 goes down
    vote_out(s, w2)
    s.tick(s.gen)
    assert s.phase == "game_end"
    res = s.g["result"]
    assert res["winner"] == "village"
    assert res["nights"] == 2
    assert [e["type"] for e in res["log"]] == ["night", "day", "night", "day"]
    assert res["log"][2]["saved"] is True
    assert {v["wolf"] for v in s.g["visions"]} == {True}
    assert set(res["winners"]) == {pid(s, t) for t in (seer, doc, v1, v2, v3)}
    assert set(res["losers"]) == {pid(s, w1), pid(s, w2)}
    # everyone's role is on the table at game end — including for a villager
    blob = json.dumps(s.state_for(v3)["game"]["result"])
    assert '"wolf"' in blob and '"seer"' in blob
