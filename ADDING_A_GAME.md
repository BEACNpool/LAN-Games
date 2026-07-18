# GAMEHUB — How to Add a Game

This is the canonical guide for adding a new game to the LAN GAMES / GAMEHUB
platform (`~/projects/gamehub`, live at **http://<lan-ip>:8096** and
`http://<lan-ip>:8096`). A fresh context should be able to read this top to
bottom and ship a new game that matches every existing one.

**Golden rule:** a new game plugs in through ONE registry entry + ONE game
directory. You never edit the core, and you never touch another game's files.
Copy the closest existing game and adapt it.

---

## 0. The recipe (what "add a game" actually means)

1. **Copy the closest sibling.** Party/round game → copy `games/charades/` or the
   stub `games/_template/`. 2-seat board game → copy `games/checkers/` (uses
   `DuelSession`). Multi-seat with bots filling → copy `games/spades/` or
   `games/tanks/`. Real-time → copy `games/snake/`.
2. **Write the session** (`games/<slug>/game.py`): subclass `GameSession` (or
   `DuelSession`) and implement the hooks (§4).
3. **Write the client** (`games/<slug>/web/`: `index.html`, `<slug>.css`,
   `<slug>.js`) using the shared kit (§6).
4. **Register it** — add ONE entry to `games/registry.py` (§5). That mounts the
   WebSocket, the static client, and the hub card automatically.
5. **Test it** — `tests/test_<slug>.py` (pytest) + `tests/playtest_<slug>.mjs`
   (headless browser) (§7).
6. **Deploy & verify** — rsync to your-server, restart if Python changed, confirm
   via LAN Games (§8).

Then run the full suite and, for anything non-trivial, an adversarial review
pass. **Read §9 (footguns) before you start** — every one of them cost real time.

---

## 1. Mental model

Two layers, cleanly split — **games never touch sockets; the net layer never
touches rules.**

- **`core/session.py` — `GameSession`**: pure, synchronous, IO-free game state.
  Owns player identity (secret `token` → public `pid`), the lobby (ready/GO/
  3-2-1 countdown), the phase envelope (`lobby`/`countdown` → your phases →
  `game_end`), a single `(deadline, gen)` timer, and `fx` events. A game is a
  subclass that implements the `game_*` hooks. **No `async`, no sockets, no
  `sleep`, no wall-clock waiting** — return `fx`; the net layer does the rest.
- **`core/net.py` — `GameBinding`**: one per registered game. Owns the WebSocket
  at `/games/<slug>/ws`, an `asyncio.Lock` around every mutation, personalized
  state pushes, the deadline timer task, and the bot scheduler. You almost never
  edit this.
- **`core/duel.py` — `DuelSession`**: a `GameSession` subclass that pre-builds
  everything identical across **2-seat** board games (seating, turn plumbing,
  auto-bot opponent, resign/draw/takeback, per-move timer). Chess/checkers/
  backgammon/connect4 use it.
- **`games/registry.py`**: the one integration point. `server.py` reads it and
  mounts everything.

Data flow each turn: client sends a JSON message over the WS → `GameBinding.
dispatch` routes lobby verbs itself and everything else to your
`game_action(token, msg)` → your method mutates state and returns `fx` → the
binding pushes a **personalized `state_for(token)`** to every socket + routes
the `fx`, then re-arms the timer and bot scheduler.

---

## 2. File layout of a game

```
games/<slug>/
  __init__.py            # empty
  game.py                # your GameSession/DuelSession subclass  (REQUIRED)
  rules.py               # pure rules/validation helpers          (optional)
  bots.py                # rule-based bot(s)                       (if it has bots)
  <extra>.py             # data banks etc (questions.py, decks.py, categories.py)
  web/
    index.html           # loads /shared/shared.css, /shared/hubnet.js,
                         #       /shared/brag.js, and <slug>.css + <slug>.js
    <slug>.css
    <slug>.js
tests/
  test_<slug>.py         # pytest
  playtest_<slug>.mjs    # headless browser playtest
```

Nothing else. Shared assets (`web/shared.css`, `web/hubnet.js`, `web/brag.js`,
fonts) live at the repo `web/` dir and are served at `/shared/*`.

---

## 3. Pick your base class

| Your game is… | Base | Copy from |
|---|---|---|
| Strictly 2 players/seats, turn-based (board game) | `core.duel.DuelSession` | `games/checkers` |
| 2–N seats, bots fill empty chairs, turn-based | `GameSession` | `games/spades`, `games/tanks` |
| Party/round game, everyone acts, no fixed seats | `GameSession` | `games/charades`, `games/_template` |
| Real-time (server ticks continuously) | `GameSession` | `games/snake` |
| Social/hidden-role, secrets per player | `GameSession` | `games/werewolf` |

`DuelSession` saves the most code for 2-seat games — you only implement
`duel_start / current_color / duel_move / duel_auto / duel_takeback /
duel_state` and call `self.finish(winner_color_or_None, why)`. It handles
seating, the auto-bot opponent for a solo human, resign/draw/takeback offers,
the optional per-move timer, disconnect autopilot, and the result/rematch flow.

---

## 4. The server side — `GameSession` API reference

### Subclass knobs (class attributes)
```python
class MyGameSession(GameSession):
    MIN_PLAYERS = 2          # humans needed before GO appears (1 = solo-vs-bot ok)
    MAX_HUMANS  = 8          # joinable humans; bots don't count
    DEFAULT_SETTINGS = {"rounds": 5, "turn_seconds": 45}  # shallow-copied per session
```

### Hooks you override (all return a list of `fx` dicts)
- `validate_settings(patch) -> dict` — return the **sanitized subset** of a
  lobby settings patch to apply. Validate types hard (`isinstance(x, int) and
  not isinstance(x, bool)`) and clamp to allowed values. Lobby-only.
- `game_start() -> [fx]` — participants are locked in (`self.participants`).
  Deal/seat, add bots, set `self.phase` to a game-specific string, arm your
  first deadline, return fx. **Required.**
- `game_action(token, msg) -> [fx]` — a client message that isn't a lobby verb.
  Validate token/turn/phase, mutate, return fx. Reject bad input with
  `self.fx("invalid", to=token, msg="…")` — **never raise** (see §9).
- `game_tick() -> [fx]` — your `deadline` fired. Advance the phase / autopilot a
  slow player / run the next real-time step. **Re-arm a new deadline or end the
  game**, or it freezes.
- `game_state(viewer_token) -> dict|None` — the personalized game payload.
  **Mask everything hidden from this viewer** (other hands, roles, unrevealed
  answers). `viewer_token` is `None` for spectator/TV sockets.
- `game_player_left(token)` / `game_player_back(token)` — a participant's last
  socket dropped / reconnected mid-game. Start autopilot / restore their view.
- `next_bot_action() -> (delay_seconds, bot_token) | None` and
  `run_bot(bot_token) -> [fx]` — the async bot scheduler. Return when a bot is
  due; the net layer calls `run_bot` after the delay (dropped if `self.seq`
  moved). Real-time games compute bots inside `game_tick` instead and leave
  `next_bot_action` unused.

### Machinery you call (don't reimplement)
- `self.fx(kind, to=None, **kw)` — build an event. `to=None` broadcasts; `to=token`
  is private. **`kind` is the positional first arg — see the §9 footgun.**
- `self._bump(deadline)` — set `self.deadline` (epoch seconds, or `None` for no
  timer) and increment `self.gen`. This is THE timer primitive.
- `self.add_bot(name)` — create a bot `Player` (call from `game_start`); append
  its `.token` to `self.participants`.
- `self.end_game()` — enter the shared `game_end` phase (results screen, then
  auto-return to lobby after 20s). Build your final results into your own state
  FIRST, then call this.
- `self.players` (dict token→`Player`), `self.humans()`, `self.by_pid(pid)`,
  `self.participants`, `self.phase`, `self.settings`, `self.rng` (seeded — use it
  for ALL randomness, never `random`/`Math.random` directly, so tests reproduce).
- `Player`: `.token` (secret, never serialize), `.pid` (public), `.name`,
  `.avatar`, `.color`, `.connected`, `.is_bot`, `.pfp`, `.public()`.

### The timer pattern (memorize this)
There is ONE `(deadline, gen)` pair. To schedule "fire in N seconds":
`self._bump(time.time() + N)`. When it fires, the net layer calls
`self.tick(gen)`, which (during your phases) calls `game_tick()`. A stale
generation is ignored, so re-arming always cancels the old timer. **Every exit
path of `game_tick` must either `_bump` a new deadline or `end_game()`** —
forget once and a real-time game freezes forever.

### State masking (security-critical)
`state_for(viewer)` wraps your `game_state(viewer_token)`. Anything a player
must not see (opponents' hands, wolf identities, hidden ships, unrevealed
answers, sealed votes) **must be absent from other viewers' payloads** — not
merely hidden in the client. Write a pytest that checks every role×viewer
combination (see `tests/test_werewolf.py::test_leak_matrix_every_phase`).

---

## 5. The registry entry

Add ONE dict to `REGISTRY` in `games/registry.py` (and import your session at
the top). Every field matters — the hub reads them for its rails and filters:

```python
{
    "slug": "mygame",                 # url + ws path segment; [a-z0-9]
    "title": "MY GAME",
    "icon": "🎲",                      # emoji, shown on the card & used as key art
    "art": "♠︎",            # OPTIONAL: hub key-art override (see footgun)
    "category": "party",              # party | cards | board | battle  -> which hub rail
    "accent": "#22d3ee",              # hex; drives the card's generated key-art gradient
    "tagline": "Short punchy line.",  # hero spotlight subtitle
    "blurb": "One or two sentences for the card.",
    "players": "2–6 + bots",          # human-readable capacity string on the card
    "min_p": 2, "max_p": 6,           # ints — feed the party-size filter chips
    "solo": True,                     # True if playable solo-vs-bot (JUST ME filter)
    "session": MyGameSession,         # the class
    "web": GAMES_DIR / "mygame" / "web",
    "hidden": False,                  # True = only shown on the hub with ?dev=1
},
```

Rails are chosen by `category`: **party** (charades/trivia/blitz/werewolf),
**cards** (spades/hearts/euchre/rummikub), **board** (chess/checkers/backgammon),
**battle** (connect4/tanks/battleship/snake). Filters use `min_p`/`max_p`/`solo`.

- `EXTERNAL` is for games not mounted as a normal registry `GameBinding`. Use a
  same-origin path `"url": "/games/<slug>/"` (preferred — shares identity/profile),
  or a separate port `"url": ":8095"` (hub.js rewrites to `http://<host>:8095/`;
  a separate origin, so it does NOT share the profile). WORDCLASH lives here with
  `"url": "/games/wordclash/"` — it runs as a **sub-app mounted in server.py**
  (`app.mount("/games/wordclash", wc_app)`) rather than a GameBinding, because it
  brought its own Room engine + `/tv` view. Same process, venv, origin, and (via
  `core.avatars`) the same photo store, so the hub profile carries in. Pattern to
  copy if a future game also has a bespoke engine/extra routes.
- `COMING_SOON` is a list of `{title, icon, blurb}` for un-built backlog cards.
  Currently empty — all shipped.

That's the whole integration surface. `server.py` loops `REGISTRY` and mounts
`/games/<slug>/ws`, the static client at `/games/<slug>/`, and the API card.

---

## 6. The web client (shared kit)

No build step, no framework, no CDN — vanilla JS/CSS served static, self-hosted
fonts. Mobile-first (design at 390px; it must also be clean at 820/1440).

### `index.html` skeleton
Load, in order:
```html
<link rel="stylesheet" href="/shared/shared.css">   <!-- design tokens -->
<link rel="stylesheet" href="mygame.css">
...
<script src="/shared/hubnet.js"></script>            <!-- Hub module -->
<script src="/shared/brag.js"></script>              <!-- Brag.button -->
<script src="mygame.js"></script>
```
Standard screens: `#scr-join` (name + avatar grid + `📷 use a photo`),
`#scr-lobby` (players, settings steppers/segments, READY + GO), `#scr-game`.
Copy the structure from `games/spades/web/index.html` or the stub
`games/_template/web/index.html`.

### `/shared/shared.css` — design tokens
Dark, app-like, urban. Use the CSS vars: `--bg #070b14`, `--surface`, `--raised`,
`--line`, `--text`, `--muted`, `--grad` (cyan→indigo→violet), accent colors
`--cyan/--violet/--green/--yellow/--danger`, `--mono` (JetBrains) / `--font`
(Sora). Reusable classes: `.btn/.btn-go`, `.player-card`, `.avatar-grid`,
`.toasts`, `.modal`, `.countdown-overlay`, `img.pfp`. Never hardcode colors that
a token already covers.

### `/shared/hubnet.js` — the `Hub` module (identity + connection)
- `Hub.identity` — `{name, avatar}` persisted in `localStorage` (keys shared
  across ALL hub games so a player is the same everywhere).
- `Hub.connect(wsPath, {onWelcome, onState, onFx})` — opens the WS, sends the
  `hello`, auto-reconnects with backoff, tracks a server-time offset; returns a
  conn with `.send(obj)` and `.now()`. `onWelcome(m)` gives you `m.pid`/`m.token`;
  `onState(st)` is the full personalized state; `onFx(fx)` is an event.
- `Hub.fillAvatar(el, player)` — render a player's pfp image or emoji avatar.
- `Hub.buildAvatarGrid(el, current, onPick)` / `Hub.wirePfpButton(btn, ()=>conn)`
  — join-screen avatar picker + photo upload (`POST /api/avatar`, `x-wc-token`).
  `wirePfpButton` routes the pick through `Hub.editPhoto(file)` (a crop/zoom
  modal) automatically — no extra work per game. Also: `Hub.identity.pfp`
  (device's photo URL, remembered locally), `Hub.removePfp()`. The **root
  LAN Games hub has a profile section** (name + character + photo) whose
  identity is the SAME localStorage as the games (same origin), so a device
  that set its profile on the hub auto-fills every game's join screen.
- `Hub.toast(msg, "err"?)`, `Hub.confettiBurst(n)`.

### Client message protocol (what you `.send`)
Lobby verbs handled by the base for you: `{t:"ready", ready}`, `{t:"start"}`,
`{t:"settings", patch:{…}}`, `{t:"profile", name, avatar}`, `{t:"again"}` (rematch
from `game_end`), `{t:"ping"}`. **Anything else** → your `game_action(token, msg)`.
Keep client→server messages to discrete user actions (never per-frame) — the
rate limit is **20 messages / 2s** per socket.

### `/shared/brag.js` — the win-share card (put it on every game-over)
```js
if (window.Brag) {
  const btn = Brag.button(() => {           // return null if no result yet
    const r = /* winner + beaten list from your state */;
    return { title: "My Game", icon: "🎲",
             winner: {name, avatar, pfp}, headline: "…",
             beaten: [{name, score}, …] };
  });
  document.querySelector("#gameover .modal-card").insertBefore(btn, rematchBtn);
}
```
Copy the exact wiring from `games/tanks/web/tanks.js`. `Brag` is a global (guard
with `if (window.Brag)`; the module ends with `window.Brag = Brag;`).

### Live game-state rendering
`onState(st)` gives `st.phase`, `st.players`, `st.you`, `st.settings`,
`st.deadline`, and `st.game` (your `game_state` payload, or `null` pre-game). Take
a local snapshot on your turn if the player arranges things locally (see
rummikub), otherwise render straight from `st`.

---

## 7. Testing (both are required)

### `tests/test_<slug>.py` — pytest
Instantiate the session with a **seeded** rng (`MyGameSession(rng=random.Random(
7))`), join tokens, `set_ready`, `start`, drive `tick`/`game_action` directly.
Cover: setup/deal, every rule, scoring, win/end conditions, **state masking per
viewer**, disconnect+reconnect, and **full seeded bot-only games producing only
legal actions**. Match the style of `tests/test_spades.py`. Run:
```
cd ~/projects/gamehub && .venv/bin/python -m pytest -q         # whole suite
.venv/bin/python -m pytest tests/test_<slug>.py -q             # just yours
```

### `tests/playtest_<slug>.mjs` — headless browser
Copy `tests/playtest_tanks.mjs` verbatim and adapt. The fixed harness idioms:
```js
import { createRequire } from "module";
const require = createRequire("/home/ubuntudesktop/projects/webdev-toolkit/x.js");
const puppeteer = require("puppeteer-core");
const browser = await puppeteer.launch({
  executablePath: "/snap/bin/chromium", headless: "new",
  userDataDir: os.homedir() + "/tmp/ghshot-<slug>",   // snap CAN'T read /tmp or dotdirs
  args: ["--no-sandbox", "--disable-gpu"],
});
const BASE = process.argv[2] || "http://127.0.0.1:8096";
```
Drive: join → pin settings → ready → GO → play a full game to the result screen
→ assert the brag card renders (`img#brag-img` `naturalWidth === 1080`). Multi-
player games open 2+ browser contexts (see `playtest_charades.mjs`). **Screenshot
key moments, Read the PNGs, and fix visual jank before finishing.** Run against a
live local server:
```
cd ~/projects/gamehub && ops/dev_restart.sh          # (re)start local on :8096
node tests/playtest_<slug>.mjs http://127.0.0.1:8096
```

### The webdesign loop for the UI
Before shipping the client, screenshot it at mobile/tablet/desktop and actually
critique it: `node <your-screenshot-tool> <url> <outdir>`. 2–4 rounds.
**Never `pkill chromium`** (kills your desktop browser); `shot.mjs` closes itself.

---

## 8. Deploy & verify

Claude Code runs on the **dev machine (<dev-machine>)**; the games run on **your-server
(<lan-ip>, ssh alias `your-server`)** as `systemctl --user` units.

```bash
cd ~/projects/gamehub
git add -A && git commit -m "Add <GAME>: …"
rsync -a --delete --exclude .venv --exclude __pycache__ --exclude .git \
      --exclude data/avatars ~/projects/gamehub/ your-server:~/projects/gamehub/
# Python changed (new/edited .py)  -> restart the service:
ssh your-server 'systemctl --user restart gamehub && sleep 2 && systemctl --user is-active gamehub'
# UI-ONLY change (html/css/js)     -> NO restart needed: StaticFiles serves web/ off disk.
# verify live through the real nginx path:
curl -s -o /dev/null -w "%{http_code}\n" http://<lan-ip>:8096/games/<slug>/
node tests/playtest_<slug>.mjs http://<lan-ip>:8096      # optional: playtest live
```
Notes: `data/avatars` is excluded so user uploads on the server aren't wiped.
`systemctl --user status gamehub` in the **system** scope wrongly reads
`inactive` — always use `--user`. New pip deps → install into the server's venv.
If you front the games with a reverse proxy (optional), map :80 →
:8096 with WebSocket upgrade headers (already configured; no nginx work needed
for a new game — it rides the same proxy).

---

## 9. Footguns (each of these cost real time — read before starting)

1. **`fx()` `kind` is positional.** `self.fx("toast", kind="win")` throws
   `TypeError` (two values for `kind`). Payload keys must avoid `kind`/`to` —
   the house convention is `what=` (e.g. `self.fx("offer", what="draw")`).
2. **Malformed client input must never raise.** A WS client can send any JSON.
   `dict.get(x)` / `set` lookups with an unhashable value (`[…]`, `{…}`) raise
   `TypeError`. Guard `isinstance(x, str)` (or int) **before** the lookup and
   return `fx("invalid", …)` instead. The net layer catches exceptions so the
   server won't crash, but it logs a traceback and silently drops the action
   (this shipped as bugs in snake, hearts, euchre).
3. **`game_tick` must always re-arm or end.** Any exit path that neither
   `_bump`s a new deadline nor `end_game()`s freezes the game (fatal for
   real-time). Snake chains `self._bump(base + TICK)` every tick.
4. **State masking is server-side.** Never rely on the client to hide secrets —
   `game_state` must omit them from other viewers' payloads. Test every
   viewer×secret combination.
5. **Use `self.rng`, never bare `random`/`Math.random`.** Tests seed the rng for
   reproducibility; wall-clock/`Math.random` in game logic breaks that. (Vary
   bot behavior by index/seed, not by `Date.now`.)
6. **Snap chromium can't read `/tmp` or dot-dirs.** Playtest/`shot.mjs`
   `userDataDir` must be under `~/tmp/...`. Use the scratchpad or `~/tmp`, never
   `/tmp`.
7. **Never `pkill -f chromium`** (and never a broad `pkill` matching your own
   shell). It kills your real desktop browser. Kill by exact PID / use
   `browser.close()` / `ops/dev_restart.sh` (which uses `fuser -k <port>/tcp`).
8. **Dark emoji key art disappears on the hub.** The hub renders `icon` as giant
   glyph art on `--bg #070b14`; a near-black emoji (♠️) vanishes. Set the
   optional `"art"` field to a **text-presentation** variant (`"♠︎"`)
   so it takes the accent color. Spades does this.
9. **`systemctl --user`, with `Linger`.** The games are user units on the server;
   the system scope lies (`inactive`). `ssh your-server` lands as the right user
   (`ubuntudesktop`); `ssh your-server` is a DIFFERENT account with none of these
   services (see workspace `TOOLS.md`).
10. **Rate limit is 20 msgs / 2s per socket.** Send discrete user actions only;
    coalesce anything chatty client-side (blitz batches typed answers).
11. **Reject room-full BEFORE bumping `seq`.** `join` returns `(None, fx)` when
    full without a seq bump — a seq bump with no following push orphans a pending
    bot action. Follow the base's pattern; don't fight it.
12. **Ties share, never award by order.** Copy the `_template` `_reveal` instinct:
    on a tie, all winners get the point/rank; never pick by draw/seat order.
13. **`COMING_SOON` is empty now** → there's no trailing "coming soon" hub rail.
    Any hub test using `.rail:not(:last-child)` to skip it is stale and will drop
    the last real rail. Select `.rail .tile-title` for all tiles.

---

## 10. Copy-paste checklist

```
[ ] copied the closest sibling game dir to games/<slug>/
[ ] game.py: subclass + all hooks; MIN_PLAYERS/MAX_HUMANS/DEFAULT_SETTINGS set
[ ] bots (if any) in bots.py, seeded via self.rng, only ever produce legal moves
[ ] game_state masks every per-viewer secret
[ ] web/index.html loads /shared/shared.css + hubnet.js + brag.js + own css/js
[ ] client uses Hub.connect/fillAvatar/toast; brag card wired on game-over
[ ] mobile-first: clean at 390 / 820 / 1440 (ran shot.mjs, read the PNGs)
[ ] registry.py: one entry with slug/title/icon/category/accent/tagline/
    blurb/players/min_p/max_p/solo/session/web (+ art if the emoji is dark)
[ ] tests/test_<slug>.py green; full suite `.venv/bin/python -m pytest -q` green
[ ] tests/playtest_<slug>.mjs PASS against http://127.0.0.1:8096
[ ] deployed (rsync); restarted gamehub if Python changed; verified via LAN Games
[ ] daily memory + (if notable) MEMORY.md updated
```

---

*Reference implementations to crib from:* `games/_template` (smallest complete
game), `games/spades` (multi-seat + bots + partnerships), `games/checkers`
(`DuelSession` board game), `games/charades` (party/typing + data bank),
`games/snake` (real-time tick), `games/werewolf` (hidden-role + anti-leak),
`games/rummikub` (local board arrangement + commit/referee). Core contracts:
`core/session.py`, `core/net.py`, `core/duel.py`, `core/avatars.py`.
