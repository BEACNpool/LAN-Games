# LAN Games

A self-hosted **game hub for your local network**. One page, ~18 games, bots to
fill empty seats, shared identity across every game. Everyone plays from their
own phone/laptop on the same Wi‑Fi — **no accounts, no cloud, no build step.**

Run it on any always-on box on your LAN (a spare laptop, a Raspberry Pi, a home
server), open the URL on everyone's phones, and you've got game night.

---

## The games

- **Cards** — Texas Hold'em (No‑Limit, real side pots & all‑in showdowns),
  Spades, Hearts, Euchre, Rummikub
- **Board** — Chess, Checkers, Backgammon, Connect Four (real rules engines)
- **Party** (same room, phones as controllers) — Charades, Trivia Buzzer,
  Category Blitz, Werewolf
- **Battle** — Battleship, Tanks (2D artillery), Snake Arena
- **Word** — WordClash (multiplayer Wordle: duel / relay / sabotage)

Every seat that isn't a human gets a **bot**, so you can start a table solo or
with two people and fill the rest with AI.

---

## Quick start

Requires **Python 3.10+**. On the machine that will host the games:

```bash
git clone https://github.com/BEACNpool/LAN-Games.git
cd LAN-Games
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python server.py
```

That starts the hub on **port 8096**. Now open it from any device on the same
network:

```
http://<the-host-ip>:8096/
```

Find `<the-host-ip>` with `hostname -I` (Linux), `ipconfig getifaddr en0`
(macOS), or `ipconfig` (Windows) — e.g. `http://192.168.1.50:8096/`. Share that
URL with everyone in the room; they open it, pick a name + avatar, and join.

> **Tip:** give the host a static IP (or a hostname on your router) so the URL
> doesn't change, and bookmark it on everyone's phones.

---

## Run it as a service (optional, Linux)

So the hub survives reboots, install it as a **systemd user service**:

```bash
mkdir -p ~/.config/systemd/user
cp deploy/gamehub.service ~/.config/systemd/user/lan-games.service
# edit WorkingDirectory / ExecStart paths in that file to match where you cloned it
systemctl --user daemon-reload
systemctl --user enable --now lan-games.service
loginctl enable-linger "$USER"     # keep it running when you're not logged in
```

Check it: `systemctl --user status lan-games` · logs: `journalctl --user -u lan-games -f`.

---

## How it works

Two‑layer, cleanly split — game rules never touch sockets; the net layer never
touches rules:

```
core/session.py    GameSession base — player identity, ready/GO lobby,
                   3‑2‑1 countdown, a single (deadline, gen) timer, fx events,
                   bot players. Pure, synchronous, IO‑free.
core/net.py        GameBinding — per‑game WebSocket, personalized state pushes,
                   the timer task, and the bot scheduler.
games/registry.py  THE registry: one entry per game mounts its WS + client.
games/<slug>/      a game = a GameSession subclass + a web/ client dir.
web/               the hub page + shared design system + client runtime.
server.py          FastAPI app; loops the registry and mounts everything.
```

Game logic is **pure Python** (no external services); the clients are vanilla
JS/CSS served static (no bundler). Adding a game is one registry entry + one
directory — see **[ADDING_A_GAME.md](ADDING_A_GAME.md)** for the full guide, and
copy `games/_template/` (HIGH CARD, the smallest complete game) to start.

## Tests

```bash
pip install pytest
python -m pytest -q                                  # unit tests for every game
node tests/playtest_<game>.mjs http://127.0.0.1:8096 # headless browser playtest
```

## License

[MIT](LICENSE) — clone it, fork it, run it on your LAN, make it yours.
