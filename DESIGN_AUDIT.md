# LAN Games — Design Audit & Console-UI Redesign

> An outside review of the LAN Games front end, the redesign that shipped in
> this branch, and a prioritized roadmap for what's next. Scope of the shipped
> work was deliberately limited to the **hub** (`web/hub.html`, `web/hub.js`);
> the 23 games, `shared.css`, the registry and the server were left untouched.

---

## 1. Executive summary

The engineering under the hood is in good shape — a clean two-layer split
(pure game rules vs. socket layer), a one-entry-per-game registry, a shared
design-token system, variable fonts, and no build step. **The code did not need
reorganizing.** The gap was in the hub's *presentation and hierarchy*: the front
door didn't sell the games and didn't feel like a game console.

The redesign turns the hub into a **console-style dashboard** — games lead, a
rotating featured spotlight up top, first-class box-art tiles, and classic
console flourishes (CRT mode, power-on boot, D-pad navigation) — while
preserving every tested behavior.

---

## 2. Findings

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| F1 | The empty **lobby chat consumed the entire first screen** on phone and desktop; the games started below the fold. | **High** | ✅ Fixed |
| F2 | **Tiles read as "an emoji on a gradient"** — no play affordance, plain metadata, no depth. Not first-class. | **High** | ✅ Fixed |
| F3 | **No featured hero / spotlight** — the signature element of every console dashboard was absent. | Medium | ✅ Fixed |
| F4 | **No "console" character** — nothing that evokes game night / arcade / a console OS. | Medium | ✅ Fixed |
| F5 | Metadata was thin — party size shown as a single mono string; bots/solo/teams/same-room not surfaced. | Medium | ✅ Fixed |
| F6 | Desktop wasted horizontal space; rails weren't visually anchored. | Low | ✅ Improved |
| F7 | In-game **lobbies don't yet share the new language** (out of scope this pass). | Medium | ▶ Roadmap P1 |

---

## 3. What shipped

### 3.1 Layout & hierarchy (F1, F3, F6)
- **Games lead.** A rotating **FEATURED spotlight** (curated marquee) opens the
  page: bespoke box art, tagline, player/mode chips, and a `PLAY` CTA. The whole
  card launches; the CTA stays the keyboard / assistive-tech target.
- **Chat became a dock.** The lobby chat moved below the rails into a compact,
  collapsible panel. It stays fully visible and functional on load; a header
  chat button jumps to it and shows an unread pip when it's collapsed or
  off-screen.
- Console-style top toolbar; party-size filters now carry **live counts**.

### 3.2 First-class tiles (F2, F5)
- **Generative cover art.** Each tile builds a 2-tone gradient from the game's
  registry `accent` (an HSL hue-shift of ~+42° derives the second tone), layered
  with gloss, a vignette, and a subtle scanline texture, plus an accent-glow
  glyph. **This scales to every current and future game with zero per-game art
  work.**
- **Richer metadata** — player-range plus `SOLO` / `BOTS` / `TEAMS` /
  `SAME ROOM` chips, and restyled `TV` / `LIVE` badges.
- **Console hover/focus state** — the tile lifts, glows in its accent color, and
  slides a `PLAY` bar up over the metadata (never overlapping it). Touch devices
  tap the whole tile, so the bar is dropped there.

### 3.3 Classic-console flourishes (F4)
- **CRT scanline mode** — optional toggle in the toolbar (📺), persisted per
  device; scanlines + vignette + a gentle flicker, disabled under
  `prefers-reduced-motion`.
- **Power-on boot sweep** — a quick scan-line power-on, once per tab session,
  reduced-motion aware.
- **D-pad navigation** — arrow keys move a roving focus spatially across the
  spotlight and tiles (progressive enhancement; never hijacks typing or modals).
- **Marquee brand glow** on the `LAN GAMES` wordmark.

### 3.4 Preserved contracts
No tested behavior changed: `#hero` stays absent, and every `lc-*` (chat),
`pf-*` (profile), and `share-*` id + flow is intact. Verified headless:
- **599 backend tests pass** (no Python changed).
- Two-client chat (text, emoji, 4032×3024 image round-trip, presence, history),
  **profile save + photo + in-game hand-off to Spades**, CRT persistence,
  spotlight rotation, and filters — all pass with **zero page errors**.

---

## 4. The console design language (for future contributors)

Keep new hub UI consistent by reusing these:

- **Tokens** live in `web/shared.css` (`--bg`, `--surface`, `--line`, `--grad`,
  the accent set, `--font` Sora / `--mono` JBMono). Don't hard-code colors.
- **Per-game accent** comes from the registry entry (`accent`). The second art
  tone is derived in `hub.js` (`shift(hex, +42, …)`) — one accent in, cohesive
  box art out.
- **Tile anatomy** (bottom → top): `tile-art` → `tile-glyph-ghost` →
  `tile-glyph` → `tile-gloss` → `tile-scan` → `tile-scrim` → `tile-badges`
  (TV / LIVE) → `tile-body` (title + `tile-tags`) → `tile-play` (hover bar).
- **Adding a game needs no art.** A registry entry with `accent`, `icon`
  (and optional `art` glyph) is enough — the generative system does the rest.
  See `ADDING_A_GAME.md`.

---

## 5. Recommended roadmap (prioritized)

### P1 — highest value, low risk
- **In-game lobby consistency pass (F7).** Bring the console language into the
  game clients' lobby/ready screens. Do it **additively in `shared.css`** (e.g.
  elevate `.player-card`, `.btn-go`, the countdown) so all 23 games inherit it
  at once, with per-game sheets only for exceptions.
- **"Jump back in" rail.** Record the last few launched slugs in `localStorage`
  and surface a recents rail at the top of the hub. Pure client, no server work,
  high everyday value.

### P2 — polish & de-hardcoding
- **Move curation into the registry.** The spotlight order is currently a
  client-side `SPOT_ORDER` list. Add optional `featured` / `spotlight_rank`
  (and maybe `is_new`) fields to registry entries and pass them through
  `/api/games`, so game owners control the marquee without touching `hub.js`.
- **Bespoke hero art for 2–3 marquee games** (Orbit Riot, Poker, Snake) — a
  small SVG/canvas cover for the spotlight, for extra wow beyond the generative
  system.
- **Contrast & motion review.** Text sits on the tile scrim (safe), but verify
  chip contrast on the brightest accents and add a `prefers-contrast: more`
  refinement.

### P3 — nice-to-have
- **Gamepad API** to complement the D-pad keys (real controllers on a TV setup).
- **Opt-in sound / haptics** — subtle launch blips and a mobile tap buzz, off by
  default (respect autoplay policies and reduced-motion).
- **Quick-find** if the catalog grows past ~30 titles.

### Optimization notes (not blocking)
The client is already lean (vanilla JS/CSS, variable woff2, no bundler). The
only recurring cost is the hub polling `/api/games` every 10s to refresh LIVE
badges — perfectly fine on a LAN. If ever desired, live counts could ride the
existing chat WebSocket (or a small presence channel) instead of polling. Micro-
optimization; not needed today.

---

## 6. Verification checklist (this branch)

- [x] `python -m pytest -q` → **599 passed**
- [x] Headless two-client chat: text, emoji-big, image round-trip, presence, history
- [x] Profile: save name/character, photo crop → upload → chip, reload persist, **feeds into a live game**, remove photo
- [x] CRT toggle persists across reload; boot sweep once per session
- [x] Spotlight rotation + whole-card launch; party-size filters re-render rails
- [x] Zero page errors across all flows; `#hero` remains absent

*Prepared as part of the hub UI/UX audit for LAN Games.*
