/* BATTLESHIP client — DOM grids, no canvas. The server owns every rule and
   hides un-hit ship positions per viewer; this just renders the state it is
   given, animates shot results from fx, and sends taps. */
"use strict";

const $ = (id) => document.getElementById(id);

const S = {
  st: null, pid: null, conn: null, joined: false,
  target: null,          // pid of the board being viewed
  aim: null,             // {pid, r, c} pending shot
  pick: null,            // ship index selected in the placement dock
  dirs: {},              // ship index -> "h"|"v" (client-side dir memory)
  flash: null,           // {target, r, c, result, ts} from the last shot fx
  myFlash: null,         // same, when someone shoots at ME (mini board)
  muted: localStorage.getItem("wc-muted") === "1",
};

/* ---------------- sounds ---------------- */
const SFX = (() => {
  let ctx = null;
  const ac = () => {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  };
  const tone = (f, type, dur, vol = 0.12, when = 0, glide = 0) => {
    if (S.muted) return;
    try {
      const c = ac(), t = c.currentTime + when;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(f, t);
      if (glide) o.frequency.exponentialRampToValueAtTime(Math.max(30, f + glide), t + dur);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + dur + 0.05);
    } catch (e) {}
  };
  return {
    unlock: () => { try { ac(); } catch (e) {} },
    click: () => tone(700, "square", 0.04, 0.05),
    splash: () => tone(220, "sine", 0.28, 0.11, 0, -140),
    hit: () => { tone(330, "square", 0.16, 0.14, 0, -120); tone(90, "sawtooth", 0.3, 0.14, 0.02, -40); },
    sunk: () => { tone(70, "sawtooth", 0.55, 0.22, 0, -30); tone(120, "square", 0.35, 0.13, 0.05, -70); },
    place: () => tone(500, "triangle", 0.07, 0.09),
    turn: () => { tone(880, "sine", 0.1, 0.12); tone(1175, "sine", 0.14, 0.1, 0.08); },
    win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, "sine", 0.24, 0.13, i * 0.09)),
    tick: () => tone(1150, "square", 0.03, 0.045),
    bad: () => tone(150, "sawtooth", 0.2, 0.08),
  };
})();

/* ---------------- helpers ---------------- */
const game = () => S.st?.game || null;
const playerByPid = (pid) => (S.st?.players || []).find((p) => p.pid === pid) || null;
const remainMs = () => S.st?.deadline ? Math.max(0, S.st.deadline - S.conn.now()) : 0;
const myTurn = () => game()?.your_turn === true;
const myBoard = () => (game()?.boards || []).find((b) => b.pid === S.pid) || null;
const boardOf = (pid) => (game()?.boards || []).find((b) => b.pid === pid) || null;
const cellLabel = (r, c) => String.fromCharCode(65 + r) + (c + 1);

function show(id) {
  for (const s of ["scr-join", "scr-lobby", "scr-place", "scr-game"]) $(s).hidden = s !== id;
}

/* ---------------- lobby ---------------- */

function seg(hostId, options, current, key) {
  const host = $(hostId);
  host.textContent = "";
  for (const opt of options) {
    const [val, label] = Array.isArray(opt) ? opt : [opt, String(opt).toUpperCase()];
    const b = document.createElement("button");
    b.textContent = label;
    b.className = val === current ? "sel" : "";
    b.onclick = () => { SFX.click(); S.conn.send({ t: "settings", patch: { [key]: val } }); };
    host.appendChild(b);
  }
}

function renderLobby(st) {
  const grid = $("player-grid");
  grid.textContent = "";
  const humans = st.players.filter((p) => !p.bot);
  for (const p of humans) {
    const card = document.createElement("div");
    card.className = "player-card" + (p.ready ? " is-ready" : "") + (p.connected ? "" : " is-away");
    const av = document.createElement("div"); av.className = "pc-avatar";
    Hub.fillAvatar(av, p);
    const meta = document.createElement("div");
    const nm = document.createElement("div"); nm.className = "pc-name"; nm.textContent = p.name;
    if (p.pid === S.pid) {
      const yt = document.createElement("span"); yt.className = "you-tag"; yt.textContent = "YOU";
      nm.appendChild(yt);
    }
    const stt = document.createElement("div");
    stt.className = "pc-status" + (p.ready ? " rdy" : "");
    stt.textContent = !p.connected ? "away" : p.ready ? "READY" : "not ready";
    meta.appendChild(nm); meta.appendChild(stt);
    card.appendChild(av); card.appendChild(meta);
    grid.appendChild(card);
  }
  const readyN = humans.filter((p) => p.ready && p.connected).length;
  $("ready-count").textContent = `${readyN} READY`;
  $("seat-note").textContent = readyN === 1 && st.settings.bot_players === 0
    ? "solo — a bot fleet will sail in to fight you"
    : "2-6 fleets per battle · bots fill in";

  seg("opt-board", [["classic", "CLASSIC 10×10"], ["quick", "QUICK 8×8"]],
      st.settings.board, "board");
  seg("opt-difficulty", [["sharp", "SHARP"], ["rookie", "ROOKIE"]],
      st.settings.difficulty, "difficulty");
  seg("opt-timer", [[20, "20s"], [40, "40s"], [0, "NONE"]],
      st.settings.turn_seconds, "turn_seconds");
  $("bots-val").textContent = st.settings.bot_players;

  const me = st.you;
  const amReady = !!(me && me.ready);
  $("ready-btn").textContent = amReady ? "READY ✓" : "READY UP";
  $("ready-btn").classList.toggle("is-ready", amReady);
  $("go-btn").hidden = !(readyN >= st.min_players && amReady && st.phase === "lobby");
  $("lobby-hint").textContent =
    st.phase === "countdown" ? "SHIPS TO SEA…"
    : readyN >= 1 ? "" : `waiting — ${location.host}`;
}

/* ---------------- grid building ---------------- */

function buildGrid(host, n, decorate, onTap) {
  host.style.setProperty("--n", n);
  host.textContent = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const el = document.createElement("button");
      el.className = "cell";
      el.type = "button";
      decorate(el, r, c);
      if (onTap) el.onclick = () => onTap(r, c);
      host.appendChild(el);
    }
  }
}

function shotMapOf(board) {
  const m = {};
  for (const [r, c, hit] of board.shots || []) m[r + "," + c] = hit;
  return m;
}

function sunkSetOf(board) {
  const s = new Set();
  for (const sh of board.sunk || []) for (const [r, c] of sh.cells) s.add(r + "," + c);
  return s;
}

function shipCellMap(board) {
  const m = {};
  (board.ships || []).forEach((sh, i) => {
    for (const [r, c] of sh.cells || []) m[r + "," + c] = i;
  });
  return m;
}

const flashClass = (flash, pid, r, c) => {
  if (!flash || flash.target !== pid || flash.r !== r || flash.c !== c) return "";
  if (Date.now() - flash.ts > 900) return "";
  return flash.result === "hit" ? " fx-hit" : " fx-miss";
};

/* ---------------- placement ---------------- */

function renderPlace(st) {
  const g = game();
  const mine = myBoard();
  const locked = !!(mine && g.placement && g.placement.ready[S.pid]);

  // roster
  const roster = $("pl-roster");
  roster.textContent = "";
  for (const pid of g.order) {
    const p = playerByPid(pid);
    const chip = document.createElement("span");
    chip.className = "pl-chip" + (g.placement.ready[pid] ? " rdy" : "");
    const av = document.createElement("span");
    Hub.fillAvatar(av, p);
    chip.append(av, document.createTextNode(
      (p ? p.name : "?") + (g.placement.ready[pid] ? " ⚓" : " …")));
    roster.appendChild(chip);
  }

  // my grid
  const ships = mine ? mine.ships || [] : [];
  const occ = mine ? shipCellMap(mine) : {};
  buildGrid($("place-grid"), g.n, (el, r, c) => {
    const k = r + "," + c;
    if (k in occ) {
      el.classList.add("ship");
      if (occ[k] === S.pick) el.classList.add("picked");
    }
  }, (r, c) => placeTap(r, c));

  // dock
  const dock = $("dock");
  dock.textContent = "";
  ships.forEach((sh, i) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "dock-chip" + (sh.cells ? " placed" : "")
      + (S.pick === i ? " sel" : "");
    const sqs = document.createElement("span");
    sqs.className = "sqs";
    for (let j = 0; j < sh.size; j++) {
      const sq = document.createElement("span"); sq.className = "sq";
      sqs.appendChild(sq);
    }
    chip.append(sqs, document.createTextNode(sh.name));
    chip.onclick = () => {
      if (locked) return;
      SFX.click();
      S.pick = S.pick === i ? null : i;
      renderPlace(S.st);
    };
    dock.appendChild(chip);
  });

  const placed = ships.filter((sh) => sh.cells).length;
  $("pl-status").textContent = !mine
    ? "fleets are deploying — you're watching this one"
    : locked ? "LOCKED IN — waiting for the other fleets…"
    : S.pick !== null ? `tap the grid to drop your ${ships[S.pick].name}`
    : placed < ships.length ? "tap a ship, tap the grid · tap a placed ship to rotate"
    : "fleet set — rotate by tapping, or lock it in";
  $("rand-btn").disabled = locked || !mine;
  $("place-ready-btn").disabled = locked || !mine || placed < ships.length;
  $("place-ready-btn").textContent = locked ? "⚓ LOCKED IN" : "⚓ READY";
}

function placeTap(r, c) {
  const g = game();
  const mine = myBoard();
  if (!mine || !g.placement || g.placement.ready[S.pid]) return;
  const ships = mine.ships || [];
  const occ = shipCellMap(mine);
  const k = r + "," + c;
  if (S.pick === null && k in occ) {
    // rotate the tapped ship around its anchor (clamped to the board)
    const i = occ[k];
    const sh = ships[i];
    const d = sh.dir === "h" ? "v" : "h";   // server truth, not client memory
    let [ar, ac] = sh.cells[0];
    if (d === "h") ac = Math.min(ac, g.n - sh.size);
    else ar = Math.min(ar, g.n - sh.size);
    S.dirs[i] = d;
    SFX.place();
    S.conn.send({ t: "place", ship: i, r: ar, c: ac, dir: d });
    return;
  }
  if (S.pick !== null) {
    const sh = ships[S.pick];
    const d = S.dirs[S.pick] || sh.dir || "h";
    // clamp the anchor so the ship stays on the board
    const ar = d === "v" ? Math.min(r, g.n - sh.size) : r;
    const ac = d === "h" ? Math.min(c, g.n - sh.size) : c;
    SFX.place();
    S.conn.send({ t: "place", ship: S.pick, r: ar, c: ac, dir: d });
    S.pick = null;
  }
}

/* ---------------- battle ---------------- */

function pipsFor(board, fleetLen) {
  const left = board.ships_left;
  return "●".repeat(left) + "○".repeat(Math.max(0, fleetLen - left));
}

function ensureTarget() {
  const g = game();
  const foes = g.boards.filter((b) => b.pid !== S.pid);
  if (!foes.length) { S.target = null; return; }
  const cur = foes.find((b) => b.pid === S.target);
  if (!cur) {
    const alive = foes.find((b) => b.alive);
    S.target = (alive || foes[0]).pid;
  } else if (!cur.alive && myTurn()) {
    const alive = foes.find((b) => b.alive);
    if (alive) S.target = alive.pid;
  }
}

function renderBattle(st) {
  const g = game();
  ensureTarget();
  const fleetLen = g.fleet.length;

  // turn chip + clock chrome
  const turnP = playerByPid(g.turn);
  const mineNow = g.turn === S.pid;         // incl. the resolve beat
  Hub.fillAvatar($("bs-turn-av"), mineNow ? playerByPid(S.pid) : turnP);
  $("bs-turn-name").textContent = mineNow
    ? "YOUR SHOT" + (g.stage === "resolve" ? "…" : "")
    : turnP ? turnP.name + (g.stage === "resolve" ? "…" : "") : "—";
  $("bs-turnchip").classList.toggle("mine", mineNow);

  // foe tabs
  const tabs = $("foe-tabs");
  tabs.textContent = "";
  for (const b of g.boards) {
    if (b.pid === S.pid) continue;
    const p = playerByPid(b.pid);
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "foe-tab" + (b.pid === S.target ? " sel" : "")
      + (!b.alive ? " dead" : "") + (g.turn === b.pid ? " turn" : "");
    const av = document.createElement("span"); av.className = "ft-av";
    Hub.fillAvatar(av, p);
    const meta = document.createElement("span"); meta.className = "ft-meta";
    const nm = document.createElement("span"); nm.className = "ft-name";
    nm.textContent = (p ? p.name : "?") + (b.auto && b.alive && !(p && p.bot) ? " 🛰" : "");
    const pips = document.createElement("span"); pips.className = "pips";
    pips.textContent = b.alive ? pipsFor(b, fleetLen) : "☠️ SUNK";
    meta.append(nm, pips);
    tab.append(av, meta);
    tab.onclick = () => { SFX.click(); S.target = b.pid; S.aim = null; renderBattle(S.st); };
    tabs.appendChild(tab);
  }

  // target board
  const tb = boardOf(S.target);
  const tp = playerByPid(S.target);
  $("target-name").textContent = tp ? tp.name.toUpperCase() : "—";
  if (tb) {
    const shots = shotMapOf(tb);
    const sunk = sunkSetOf(tb);
    const revealed = shipCellMap(tb);       // only present when server reveals
    const canAim = myTurn() && tb.alive;
    if (S.aim && (S.aim.pid !== S.target || !canAim
        || (S.aim.r + "," + S.aim.c) in shots)) S.aim = null;
    buildGrid($("target-grid"), g.n, (el, r, c) => {
      const k = r + "," + c;
      if (sunk.has(k)) el.classList.add("sunk");
      else if (k in shots) el.classList.add(shots[k] ? "hit" : "miss");
      else if (k in revealed) el.classList.add("ship");
      if (S.aim && S.aim.r === r && S.aim.c === c) el.classList.add("aim");
      const f = flashClass(S.flash, tb.pid, r, c);
      if (f) el.className += f;
    }, (r, c) => {
      if (!canAim || (r + "," + c) in shotMapOf(tb)) return;
      SFX.click();
      S.aim = { pid: tb.pid, r, c };
      renderBattle(S.st);
    });
  }

  // fire button
  const fire = $("fire-btn");
  const me = myBoard();
  const iFight = !!(me && me.alive);
  fire.hidden = !iFight;
  fire.classList.toggle("wait", !myTurn());
  if (myTurn()) {
    fire.disabled = !S.aim;
    fire.textContent = S.aim ? `🔥 FIRE AT ${cellLabel(S.aim.r, S.aim.c)}` : "PICK A CELL";
  } else {
    fire.disabled = true;
    fire.textContent = g.stage === "resolve" ? "…"
      : turnP ? `${turnP.name}'S TURN` : "…";
  }
  $("watch-note").hidden = iFight;
  $("watch-note").textContent = me && !me.alive
    ? "YOUR FLEET IS SUNK — ALL BOARDS REVEALED" : "WATCHING THE CARNAGE";

  // my mini board
  if (me) {
    const shots = shotMapOf(me);
    const sunk = sunkSetOf(me);
    const occ = shipCellMap(me);
    buildGrid($("my-mini"), g.n, (el, r, c) => {
      const k = r + "," + c;
      if (sunk.has(k)) el.classList.add("sunk");
      else if (k in shots) el.classList.add(shots[k] ? "hit" : "miss");
      else if (k in occ) el.classList.add("ship");
      const f = flashClass(S.myFlash, S.pid, r, c);
      if (f) el.className += f;
    }, null);
    $("my-pips").textContent = pipsFor(me, fleetLen);
  }

  // kill feed — newest first, last 3
  const feed = $("feed");
  feed.textContent = "";
  for (const e of (g.feed || []).slice(-3).reverse()) {
    const line = document.createElement("div");
    line.className = "feed-line " + (e.k || "");
    line.textContent = e.msg;
    feed.appendChild(line);
  }
}

/* ---------------- game over ---------------- */

let goShown = false;
function renderGameOver(st) {
  const g = game();
  const showIt = st.phase === "game_end" && g && g.result;
  $("gameover").hidden = !showIt;
  if (!showIt) { goShown = false; return; }
  const res = g.result;
  const wp = playerByPid(res.winner);
  const wrow = res.standings[0];
  $("go-title").textContent = wp ? `${wp.name.toUpperCase()} RULES THE SEAS` : "MUTUAL DESTRUCTION";
  $("go-line").textContent =
    `${wrow.ships_left} ship${wrow.ships_left === 1 ? "" : "s"} afloat · `
    + `${wrow.hits}/${wrow.shots} shots on target`;
  const rows = $("res-rows");
  rows.textContent = "";
  for (const r of res.standings) {
    const p = playerByPid(r.pid);
    const div = document.createElement("div");
    div.className = "res-row" + (r.place === 1 ? " first" : "");
    const place = document.createElement("span");
    place.className = "res-place";
    place.textContent = r.place === 1 ? "👑" : "#" + r.place;
    const av = document.createElement("span"); av.className = "res-av";
    Hub.fillAvatar(av, p);
    const nm = document.createElement("span"); nm.className = "res-name";
    nm.textContent = p ? p.name : "?";
    if (r.pid === S.pid) {
      const yt = document.createElement("span"); yt.className = "you-tag"; yt.textContent = "YOU";
      nm.appendChild(yt);
    }
    const stat = document.createElement("span"); stat.className = "res-stat";
    const acc = r.shots ? Math.round(100 * r.hits / r.shots) : 0;
    stat.innerHTML = `<b>${r.hits}/${r.shots}</b> · ${acc}%<br>`
      + (r.alive ? `${r.cells_left} cells afloat` : "fleet lost");
    div.append(place, av, nm, stat);
    rows.appendChild(div);
  }
  if (!goShown) {
    goShown = true;
    if (res.winner === S.pid) { Hub.confettiBurst(200); SFX.win(); }
    else SFX.sunk();
  }
}

/* ---------------- state entry ---------------- */

function applyState(st) {
  S.st = st;
  if (!S.joined) return;
  if (st.phase === "lobby" || st.phase === "countdown") {
    show("scr-lobby");
    S.pick = null; S.aim = null; S.target = null; S.dirs = {};
    renderLobby(st);
  } else if (st.game) {
    if (st.game.stage === "placement") {
      show("scr-place");
      renderPlace(st);
    } else {
      show("scr-game");
      renderBattle(st);
    }
  }
  renderGameOver(st);
  $("countdown-overlay").hidden = st.phase !== "countdown";
}

function onFx(fx) {
  switch (fx.kind) {
    case "toast": Hub.toast((fx.icon ? fx.icon + " " : "") + fx.msg); break;
    case "invalid": Hub.toast(fx.msg, "err"); SFX.bad(); break;
    case "shot": {
      const rec = { target: fx.target, r: fx.r, c: fx.c,
                    result: fx.result, ts: Date.now() };
      S.flash = rec;
      if (fx.target === S.pid) S.myFlash = rec;
      if (fx.result === "hit") SFX.hit(); else SFX.splash();
      if (fx.sunk) {
        SFX.sunk();
        $("target-grid").classList.add("shake");
        setTimeout(() => $("target-grid").classList.remove("shake"), 550);
        if (fx.shooter === S.pid) Hub.confettiBurst(120);
      }
      if (fx.eliminated === S.pid) {
        try { navigator.vibrate && navigator.vibrate([80, 60, 200]); } catch (e) {}
      }
      break;
    }
    case "turn":
      if (fx.pid === S.pid) {
        SFX.turn();
        try { navigator.vibrate && navigator.vibrate(70); } catch (e) {}
      }
      break;
    case "battle_start": SFX.turn(); break;
    case "place_start": SFX.place(); break;
    case "countdown": SFX.turn(); break;
  }
}

/* ---------------- controls ---------------- */

$("rand-btn").onclick = () => {
  SFX.unlock(); SFX.place();
  S.pick = null;
  S.conn.send({ t: "randomize" });
};
$("place-ready-btn").onclick = () => {
  SFX.unlock(); SFX.click();
  S.conn.send({ t: "place_ready" });
};
$("fire-btn").onclick = () => {
  if (!myTurn() || !S.aim) return;
  SFX.unlock();
  S.conn.send({ t: "fire", target: S.aim.pid, r: S.aim.r, c: S.aim.c });
  S.aim = null;
};

/* brag */
if (window.Brag) {
  const btn = Brag.button(() => {
    const g = game();
    if (!g || !g.result || !g.result.winner) return null;
    const wp = playerByPid(g.result.winner);
    const wrow = g.result.standings[0];
    const losers = g.result.standings.filter((r) => r.pid !== g.result.winner);
    return {
      title: "Battleship", icon: "🚢",
      winner: { name: wp ? wp.name : "?", avatar: wp ? wp.avatar : "🚢",
                pfp: wp ? wp.pfp : null },
      headline: `last fleet afloat · ${wrow.hits}/${wrow.shots} on target`,
      beaten: losers.slice(0, 4).map((r) => {
        const p = playerByPid(r.pid);
        return { name: p ? p.name : "?" };
      }),
    };
  });
  document.querySelector("#gameover .modal-card")
    .insertBefore(btn, $("rematch-btn"));
}

/* ---------------- timers ---------------- */

let lastTick = -1;
function raf() {
  requestAnimationFrame(raf);
  const st = S.st;
  if (!st) return;
  if (st.phase === "countdown") {
    $("countdown-num").textContent = Math.max(1, Math.ceil(remainMs() / 1000));
  }
  const g = game();
  if (!g) return;
  if (g.stage === "placement") {
    $("pl-clock").textContent = Math.ceil(remainMs() / 1000);
  } else if (g.stage === "battle" || g.stage === "resolve") {
    if (st.deadline) {
      const sec = Math.ceil(remainMs() / 1000);
      $("bs-clock").textContent = sec;
      $("bs-clock").classList.toggle("low",
        g.stage === "battle" && g.turn_seconds > 0 && sec <= 5);
      if (g.stage === "battle" && sec !== lastTick && sec <= 5 && sec > 0
          && myTurn()) { SFX.tick(); lastTick = sec; }
    } else {
      $("bs-clock").textContent = "∞";
      $("bs-clock").classList.remove("low");
    }
  }
  if (st.phase === "game_end") {
    $("go-auto").textContent = `back to port in ${Math.ceil(remainMs() / 1000)}s`;
  }
}
requestAnimationFrame(raf);

/* ---------------- boot & wiring ---------------- */

const step2 = (key, delta, min, max) => {
  const cur = S.st?.settings[key] ?? min;
  S.conn.send({ t: "settings", patch: { [key]: Math.max(min, Math.min(max, cur + delta)) } });
};
$("bots-minus").onclick = () => step2("bot_players", -1, 0, 5);
$("bots-plus").onclick = () => step2("bot_players", 1, 0, 5);

$("ready-btn").onclick = () => {
  SFX.unlock(); SFX.click();
  const me = S.st?.you;
  S.conn.send({ t: "ready", ready: !(me && me.ready) });
};
$("go-btn").onclick = () => { SFX.unlock(); S.conn.send({ t: "start" }); };
$("rematch-btn").onclick = () => S.conn.send({ t: "again" });
$("mute-btn").onclick = () => {
  S.muted = !S.muted;
  localStorage.setItem("wc-muted", S.muted ? "1" : "0");
  $("mute-btn").textContent = S.muted ? "🔇" : "🔊";
};
$("mute-btn").textContent = S.muted ? "🔇" : "🔊";

function connect() {
  S.conn = Hub.connect("/games/battleship/ws", {
    onWelcome: (m) => { S.pid = m.pid; },
    onState: applyState, onFx,
  });
}

let avatarPick = Hub.identity.avatar
  || Hub.AVATARS[(Math.random() * Hub.AVATARS.length) | 0];
Hub.buildAvatarGrid($("avatar-grid"), avatarPick, (a) => { avatarPick = a; });
Hub.wirePfpButton($("pfp-btn"), () => S.conn);
Hub.wirePfpButton($("pfp-btn2"), () => S.conn);
$("name-input").value = Hub.identity.name;
$("join-btn").onclick = () => {
  SFX.unlock();
  Hub.identity.name = $("name-input").value.trim() || "PLAYER";
  Hub.identity.avatar = avatarPick;
  S.joined = true;
  connect();
  show("scr-lobby");
};
$("name-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("join-btn").click();
});

if (Hub.identity.name) {
  S.joined = true;
  connect();
  show("scr-lobby");
} else {
  show("scr-join");
}
