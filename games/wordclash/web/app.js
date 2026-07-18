/* WORDCLASH client. No framework, no build step.
   Server is authoritative; this renders `state` pushes and plays `fx`. */
"use strict";

/* ---------------- constants ---------------- */

const AVATARS = ["🦊", "🐸", "🦖", "🐙", "🦉", "🐯", "🐼", "🦄",
                 "👾", "🤖", "🐲", "😈", "🦈", "🐝", "🦩", "🐢"];
const MODES = {
  duel: { icon: "⚔️", name: "DUEL",
    desc: "Same secret word. Everyone races on their own board. Fastest solve takes the bonus." },
  relay: { icon: "🔁", name: "RELAY",
    desc: "One shared board, timed turns. Solve it — or hand the next player free intel." },
  sabotage: { icon: "💣", name: "SABOTAGE",
    desc: "Relay with teeth. Spend your turn to cut timers, ban letters, or force a start." },
};
const KEY_ROWS = ["qwertyuiop", "asdfghjkl", "!zxcvbnm<"];
const REASONS = { solved: "SOLVED", time: "TIME'S UP", exhausted: "BOARD EXHAUSTED",
                  all_done: "ALL BOARDS IN" };

const $ = (id) => document.getElementById(id);
const els = {};
["screen-join", "screen-lobby", "screen-game", "screen-roundend", "screen-podium",
 "name-input", "avatar-grid", "join-btn", "player-grid", "ready-count", "mode-cards",
 "rounds-val", "rounds-minus", "rounds-plus", "ready-btn", "go-btn", "lobby-hint",
 "turn-row", "turn-val", "turn-minus", "turn-plus",
 "hud-round", "hud-timer", "hud-timer-fill", "hud-clock", "hud-scores",
 "turn-banner", "turn-avatar", "turn-name", "turn-sub", "ring-fg",
 "opp-strip", "board-scroll", "board", "sabotage-bar", "sab-charges", "pending-note",
 "keyboard", "spectate-note", "re-reason", "re-word", "re-scores", "re-next",
 "podium", "podium-rest", "rematch-btn", "podium-auto",
 "letter-modal", "letter-modal-title", "letter-grid", "letter-cancel",
 "profile-modal", "profile-name", "profile-avatars", "profile-cancel", "profile-save",
 "countdown-overlay", "countdown-num", "toasts", "conn-banner", "mute-btn",
 "edit-profile-btn", "confetti"].forEach((id) => { els[id] = $(id); });

/* ---------------- local state ---------------- */

const S = {
  ws: null, st: null, token: localStorage.getItem("wc-token") || "",
  pid: null, typed: "", offset: 0, joined: false,
  lastRows: {},          // boardKey -> row count (for flip animation)
  avatarPick: localStorage.getItem("wc-avatar") || "",
  countdownShown: -1, podiumDone: false, retry: 0,
  inputRowEl: null, spectating: false,
};

/* ---------------- sfx ---------------- */

const SFX = (() => {
  let ctx = null;
  let muted = localStorage.getItem("wc-muted") === "1";
  function ac() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }
  function tone(freq, type, dur, vol = 0.15, when = 0, glide = 0) {
    if (muted) return;
    try {
      const c = ac(), t = c.currentTime + when;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, t);
      if (glide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + glide), t + dur);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(c.destination);
      o.start(t); o.stop(t + dur + 0.05);
    } catch (e) { /* audio not available */ }
  }
  return {
    unlock: () => { try { ac(); } catch (e) {} },
    click: () => tone(700, "square", 0.045, 0.05),
    flip: () => tone(330, "triangle", 0.07, 0.09),
    good: () => { tone(660, "sine", 0.12, 0.13); tone(880, "sine", 0.16, 0.11, 0.06); },
    bad: () => tone(150, "sawtooth", 0.22, 0.08, 0, -60),
    win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, "sine", 0.22, 0.13, i * 0.09)),
    fanfare: () => [392, 523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, "sine", 0.3, 0.12, i * 0.11)),
    tick: () => tone(1150, "square", 0.03, 0.045),
    turn: () => { tone(880, "sine", 0.1, 0.13); tone(1175, "sine", 0.14, 0.11, 0.08); },
    sting: () => { tone(420, "sawtooth", 0.18, 0.11, 0, -220); tone(210, "sawtooth", 0.22, 0.09, 0.1, -90); },
    whoosh: () => tone(280, "triangle", 0.3, 0.09, 0, 520),
    toggle: () => { muted = !muted; localStorage.setItem("wc-muted", muted ? "1" : "0"); return muted; },
    get muted() { return muted; },
  };
})();

/* ---------------- confetti ---------------- */

const Confetti = (() => {
  const cv = els["confetti"], cx = cv.getContext("2d");
  let parts = [], raf = null;
  const COLS = ["#22d3ee", "#a78bfa", "#f472b6", "#10c96e", "#eab308"];
  function fit() { cv.width = innerWidth; cv.height = innerHeight; }
  addEventListener("resize", fit); fit();
  function burst(n = 120) {
    for (let i = 0; i < n; i++) {
      parts.push({
        x: innerWidth / 2 + (Math.random() - 0.5) * innerWidth * 0.6,
        y: -20 - Math.random() * 60,
        vx: (Math.random() - 0.5) * 3.2, vy: 2 + Math.random() * 3.5,
        rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.25,
        w: 6 + Math.random() * 6, h: 4 + Math.random() * 4,
        c: COLS[(Math.random() * COLS.length) | 0], life: 220 + Math.random() * 80,
      });
    }
    if (!raf) loop();
  }
  function loop() {
    raf = requestAnimationFrame(loop);
    cx.clearRect(0, 0, cv.width, cv.height);
    parts = parts.filter((p) => p.life > 0 && p.y < cv.height + 30);
    if (!parts.length) { cancelAnimationFrame(raf); raf = null; return; }
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.vy += 0.02; p.life--;
      cx.save(); cx.translate(p.x, p.y); cx.rotate(p.rot);
      cx.fillStyle = p.c; cx.globalAlpha = Math.min(1, p.life / 60);
      cx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); cx.restore();
    }
  }
  return { burst };
})();

/* ---------------- helpers ---------------- */

function show(screenId) {
  for (const id of ["screen-join", "screen-lobby", "screen-game",
                    "screen-roundend", "screen-podium"]) {
    els[id].hidden = id !== screenId;
  }
}

function toast(msg, cls = "") {
  const t = document.createElement("div");
  t.className = "toast " + cls;
  t.textContent = msg;
  els["toasts"].appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

function playerByPid(pid) {
  return (S.st?.players || []).find((p) => p.pid === pid) || null;
}

function me() { return S.st?.you || null; }

function send(obj) {
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj));
}

function now() { return Date.now() + S.offset; }

function remainMs() {
  if (!S.st || !S.st.deadline) return 0;
  return Math.max(0, S.st.deadline - now());
}

function fmtClock(ms) {
  const s = Math.ceil(ms / 1000);
  return `${(s / 60) | 0}:${String(s % 60).padStart(2, "0")}`;
}

function vibrate(pat) { try { navigator.vibrate && navigator.vibrate(pat); } catch (e) {} }

/* custom pfp support: render photo if the player has one, else emoji */
function fillAvatar(el, p) {
  el.textContent = "";
  if (p && p.pfp) {
    const img = document.createElement("img");
    img.className = "pfp";
    img.src = p.pfp;
    img.alt = "";
    img.draggable = false;
    el.appendChild(img);
  } else {
    el.textContent = p ? p.avatar : "?";
  }
}

function ensureToken() {
  if (!S.token) {
    const b = crypto.getRandomValues(new Uint8Array(16));
    S.token = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    localStorage.setItem("wc-token", S.token);
  }
  return S.token;
}

function wirePfpButton(btn) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.hidden = true;
  document.body.appendChild(input);
  btn.addEventListener("click", () => input.click());
  input.addEventListener("change", async () => {
    const f = input.files && input.files[0];
    input.value = "";
    if (!f) return;
    try {
      const res = await fetch("/api/avatar", {
        method: "POST",
        headers: { "x-wc-token": ensureToken() },
        body: f,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "upload failed");
      }
      send({ t: "profile" });   // server re-checks the pfp on profile
      toast("📷 picture saved");
    } catch (e) {
      toast(e.message, "err");
    }
  });
}

/* ---------------- websocket ---------------- */

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/games/wordclash/ws`);
  S.ws = ws;
  ws.onopen = () => {
    S.retry = 0;
    els["conn-banner"].hidden = true;
    ws.send(JSON.stringify({
      t: "hello", token: S.token || undefined,
      name: localStorage.getItem("wc-name") || undefined,
      avatar: S.avatarPick || undefined,
    }));
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type === "welcome") {
      S.token = msg.token; S.pid = msg.pid;
      localStorage.setItem("wc-token", msg.token);
    } else if (msg.type === "state") {
      onState(msg);
    } else if (msg.type === "fx") {
      onFx(msg);
    }
  };
  ws.onclose = () => {
    if (!S.joined) return;
    els["conn-banner"].hidden = false;
    const wait = Math.min(5000, 600 + S.retry * 800);
    S.retry++;
    setTimeout(() => { if (S.joined) connect(); }, wait);
  };
  ws.onerror = () => { try { ws.close(); } catch (e) {} };
}

/* ---------------- fx ---------------- */

function onFx(fx) {
  switch (fx.kind) {
    case "toast": toast((fx.icon ? fx.icon + " " : "") + fx.msg); break;
    case "invalid":
      toast(fx.msg, "err"); SFX.bad();
      if (S.inputRowEl) {
        S.inputRowEl.classList.remove("shake");
        void S.inputRowEl.offsetWidth;
        S.inputRowEl.classList.add("shake");
      }
      break;
    case "landed":
      SFX.flip();
      if (fx.pid === S.pid && fx.gained > 0) toast(`+${fx.gained} intel`, "");
      break;
    case "solved": {
      const p = playerByPid(fx.pid);
      if (fx.pid === S.pid) { Confetti.burst(140); SFX.win(); }
      else { toast(`${p ? p.avatar + " " + p.name : "someone"} solved it!`); SFX.good(); }
      break;
    }
    case "busted":
      if (fx.pid === S.pid) { toast("out of guesses", "err"); SFX.lose ? SFX.lose() : SFX.bad(); }
      break;
    case "timeout": {
      const p = playerByPid(fx.pid);
      toast(`⏱ ${p ? p.name : "player"} ran out of time (−${fx.penalty})`, "err");
      if (fx.pid === S.pid) { SFX.bad(); vibrate([60, 40, 60]); }
      break;
    }
    case "sabotage": {
      const by = playerByPid(fx.by), tg = playerByPid(fx.target);
      const what = fx.what === "time" ? "cut the timer to 7s"
        : fx.what === "ban" ? `banned the letter ${String(fx.letter || "").toUpperCase()}`
        : `forced a word starting with ${String(fx.letter || "").toUpperCase()}`;
      toast(`💣 ${by ? by.name : "?"} ${what} for ${tg ? tg.name : "?"}`, "sab");
      SFX.sting();
      if (fx.target === S.pid) vibrate([90, 50, 90]);
      break;
    }
    case "turn":
      if (fx.pid === S.pid) { SFX.turn(); vibrate(70); }
      break;
    case "countdown": SFX.whoosh(); break;
    case "round_start": S.typed = ""; S.lastRows = {}; break;
    case "round_end": SFX.good(); break;
    case "match_end": SFX.fanfare(); break;
  }
}

/* ---------------- state entry ---------------- */

function onState(st) {
  S.st = st;
  // clock sync (EMA)
  const off = st.now - Date.now();
  S.offset = S.offset === 0 ? off : S.offset * 0.8 + off * 0.2;

  const my = me();
  if (my && st.match && st.phase === "playing") {
    S.spectating = !my.in_match;
  } else {
    S.spectating = false;
  }

  syncTypedRow(st);

  if (!S.joined) return;   // still on join screen

  switch (st.phase) {
    case "lobby": show("screen-lobby"); renderLobby(st); break;
    case "countdown": show("screen-lobby"); renderLobby(st); break;
    case "playing": show("screen-game"); renderGame(st); break;
    case "round_end": show("screen-roundend"); renderRoundEnd(st); break;
    case "podium": show("screen-podium"); renderPodium(st); break;
  }
  els["countdown-overlay"].hidden = st.phase !== "countdown";
  if (st.phase !== "podium") S.podiumDone = false;
  if (st.phase !== "round_end") reRendered = "";
  // the sabotage letter picker dies with the turn it belonged to
  const rdNow = st.match?.round;
  if (!(st.phase === "playing" && rdNow && rdNow.kind === "sabotage"
        && rdNow.turn === S.pid)) {
    els["letter-modal"].hidden = true;
  }
}

/* ---------------- lobby ---------------- */

function renderLobby(st) {
  const grid = els["player-grid"];
  grid.textContent = "";
  const players = st.players || [];
  for (const p of players) {
    const card = document.createElement("div");
    card.className = "player-card" + (p.ready ? " is-ready" : "") + (p.connected ? "" : " is-away");
    const av = document.createElement("div"); av.className = "pc-avatar"; fillAvatar(av, p);
    const meta = document.createElement("div"); meta.className = "pc-meta";
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
  if (players.length < 3) {
    const inv = document.createElement("div");
    inv.className = "player-card empty-slot";
    inv.textContent = `join at ${location.host}`;
    grid.appendChild(inv);
  }

  const readyN = players.filter((p) => p.ready && p.connected).length;
  els["ready-count"].textContent = `${readyN} READY`;

  // mode cards
  const mc = els["mode-cards"];
  mc.textContent = "";
  for (const [key, m] of Object.entries(MODES)) {
    const b = document.createElement("button");
    b.className = "mode-card" + (st.settings.mode === key ? " sel" : "");
    const ic = document.createElement("span"); ic.className = "mc-icon"; ic.textContent = m.icon;
    const tx = document.createElement("span");
    const nm = document.createElement("div"); nm.className = "mc-name"; nm.textContent = m.name;
    const ds = document.createElement("div"); ds.className = "mc-desc"; ds.textContent = m.desc;
    tx.appendChild(nm); tx.appendChild(ds);
    b.appendChild(ic); b.appendChild(tx);
    b.onclick = () => { SFX.click(); send({ t: "settings", mode: key }); };
    mc.appendChild(b);
  }
  els["rounds-val"].textContent = st.settings.rounds;
  els["turn-row"].hidden = st.settings.mode === "duel";
  els["turn-val"].textContent = st.settings.turn_seconds + "s";

  // footer
  const my = me();
  const amReady = !!(my && my.ready);
  els["ready-btn"].textContent = amReady ? "READY ✓" : "READY UP";
  els["ready-btn"].classList.toggle("is-ready", amReady);
  const canGo = readyN >= 2 && amReady && st.phase === "lobby";
  els["go-btn"].hidden = !canGo;
  els["lobby-hint"].textContent =
    st.phase === "countdown" ? "LAUNCHING…"
    : readyN >= 2 ? "all set — smash GO!"
    : readyN === 1 ? "need one more ready player…"
    : `waiting for players — join at ${location.host}`;
}

/* ---------------- game ---------------- */

function keyStates(rows) {
  const ks = {};
  const rank = { b: 1, y: 2, g: 3 };
  for (const r of rows) {
    if (!r.w || !r.m) continue;
    for (let i = 0; i < r.w.length; i++) {
      const c = r.w[i], m = r.m[i];
      if (!ks[c] || rank[m] > rank[ks[c]]) ks[c] = m;
    }
  }
  return ks;
}

function makeRow(word, marks, opts = {}) {
  const row = document.createElement("div");
  row.className = "brow" + (opts.cls ? " " + opts.cls : "");
  for (let i = 0; i < 5; i++) {
    const t = document.createElement("div");
    let cls = "tile";
    const ch = word ? word[i] : "";
    if (marks) cls += " " + marks[i];
    else if (ch) cls += " typed";
    if (opts.flip && marks) {
      cls += " flip";
      t.style.animationDelay = `${i * 70}ms`;
    }
    t.className = cls;
    t.textContent = ch ? ch.toUpperCase() : "";
    row.appendChild(t);
  }
  return row;
}

function renderGame(st) {
  const m = st.match, rd = m.round;
  if (!rd) return;
  els["hud-round"].textContent = `R${m.round_num}/${m.rounds_total}`;

  // scores strip
  const hs = els["hud-scores"];
  hs.textContent = "";
  const inMatch = st.players.filter((p) => p.in_match)
    .sort((a, b) => b.score - a.score);
  for (const p of inMatch) {
    const chip = document.createElement("span");
    chip.className = "score-chip";
    const cav = document.createElement("span");
    fillAvatar(cav, p);
    chip.appendChild(cav);
    chip.appendChild(document.createTextNode(" " + p.score));
    chip.style.borderColor = p.pid === S.pid ? p.color : "";
    hs.appendChild(chip);
  }

  els["spectate-note"].hidden = !S.spectating;

  if (rd.kind === "duel") renderDuel(st, rd);
  else renderRelay(st, rd);
}

function renderDuel(st, rd) {
  els["turn-banner"].hidden = true;
  els["sabotage-bar"].hidden = true;
  els["pending-note"].hidden = true;
  els["opp-strip"].hidden = false;

  const myBoard = rd.boards[S.pid];

  // opponents strip (or all boards for spectators)
  const strip = els["opp-strip"];
  strip.textContent = "";
  for (const p of st.players.filter((q) => q.in_match)) {
    if (!S.spectating && p.pid === S.pid) continue;
    const b = rd.boards[p.pid];
    if (!b) continue;
    const card = document.createElement("div");
    card.className = "opp-card" + (b.solved ? " done-solved" : b.done ? " done-bust" : "");
    const head = document.createElement("div"); head.className = "opp-head";
    const av = document.createElement("span"); av.className = "oh-av"; fillAvatar(av, p);
    const nm = document.createElement("span"); nm.className = "oh-name"; nm.textContent = p.name;
    head.appendChild(av); head.appendChild(nm);
    const mini = document.createElement("div"); mini.className = "opp-mini";
    for (let r = 0; r < b.max; r++) {
      const mr = document.createElement("div"); mr.className = "opp-mrow";
      const row = b.rows[r];
      for (let i = 0; i < 5; i++) {
        const c = document.createElement("div");
        c.className = "opp-cell" + (row && row.m ? " " + row.m[i] : "");
        mr.appendChild(c);
      }
      mini.appendChild(mr);
    }
    const stt = document.createElement("div"); stt.className = "opp-status";
    stt.textContent = b.solved ? "SOLVED" : b.done ? "BUST" : `${b.n}/${b.max}`;
    card.appendChild(head); card.appendChild(mini); card.appendChild(stt);
    strip.appendChild(card);
  }

  // my board
  const board = els["board"];
  board.textContent = "";
  const kb = els["keyboard"];
  if (S.spectating || !myBoard) {
    kb.hidden = true;
    S.inputRowEl = null;
    return;
  }
  kb.hidden = false;

  const rows = myBoard.rows;
  const prevN = S.lastRows["me"] ?? rows.length;
  rows.forEach((r, idx) => {
    board.appendChild(makeRow(r.w, r.m, {
      flip: idx >= prevN,
      cls: r.w && r.m && r.m.every((x) => x === "g") ? "win" : "",
    }));
  });
  S.lastRows["me"] = rows.length;

  S.inputRowEl = null;
  if (!myBoard.done && rows.length < myBoard.max) {
    const inputRow = makeRow(S.typed.padEnd(0), null, {});
    // fill typed letters
    for (let i = 0; i < 5; i++) {
      const t = inputRow.children[i];
      const ch = S.typed[i];
      if (ch) { t.textContent = ch.toUpperCase(); t.className = "tile typed"; }
    }
    board.appendChild(inputRow);
    S.inputRowEl = inputRow;
    for (let r = rows.length + 1; r < myBoard.max; r++) board.appendChild(makeRow(null, null));
  } else {
    for (let r = rows.length; r < myBoard.max; r++) board.appendChild(makeRow(null, null));
  }

  renderKeyboard(keyStates(rows), !myBoard.done, null);
}

function renderRelay(st, rd) {
  els["opp-strip"].hidden = true;
  const myTurn = !S.spectating && rd.turn === S.pid;

  // turn banner
  const tb = els["turn-banner"];
  tb.hidden = false;
  tb.classList.toggle("my-turn", myTurn);
  const turnP = rd.turn ? playerByPid(rd.turn) : null;
  if (turnP) fillAvatar(els["turn-avatar"], turnP);
  else els["turn-avatar"].textContent = "⏸";
  els["turn-name"].textContent = rd.paused ? "PAUSED" : myTurn ? "YOUR TURN" : (turnP ? turnP.name : "—");
  els["turn-sub"].textContent = rd.paused ? "waiting for players"
    : myTurn ? "type a word!" : "is thinking…";

  // shared board
  const board = els["board"];
  board.textContent = "";
  const prevN = S.lastRows["shared"] ?? rd.rows.length;
  rd.rows.forEach((r, idx) => {
    const wrap = document.createElement("div");
    wrap.className = "relay-row";
    const owner = playerByPid(r.by);
    const tag = document.createElement("span");
    tag.className = "rr-owner";
    if (owner) fillAvatar(tag, owner); else tag.textContent = "·";
    wrap.appendChild(tag);
    if (r.skipped) {
      const sk = document.createElement("div");
      sk.className = "brow-skip";
      sk.textContent = `${owner ? owner.name : "?"} — TIMED OUT`;
      sk.style.width = "100%";
      wrap.appendChild(sk);
    } else {
      wrap.appendChild(makeRow(r.w, r.m, {
        flip: idx >= prevN,
        cls: r.m && r.m.every((x) => x === "g") ? "win" : "",
      }));
    }
    board.appendChild(wrap);
  });
  S.lastRows["shared"] = rd.rows.length;

  S.inputRowEl = null;
  if (myTurn) {
    const wrap = document.createElement("div");
    wrap.className = "relay-row";
    const tag = document.createElement("span");
    tag.className = "rr-owner me";
    if (me()) fillAvatar(tag, me()); else tag.textContent = "▶";
    wrap.appendChild(tag);
    const inputRow = makeRow(null, null);
    for (let i = 0; i < 5; i++) {
      const ch = S.typed[i];
      if (ch) {
        inputRow.children[i].textContent = ch.toUpperCase();
        inputRow.children[i].className = "tile typed";
      }
    }
    wrap.appendChild(inputRow);
    board.appendChild(wrap);
    S.inputRowEl = inputRow;
  }
  // remaining rows as slots
  const used = rd.rows.length + (myTurn ? 1 : 0);
  for (let r = used; r < rd.rows_max; r++) {
    const wrap = document.createElement("div");
    wrap.className = "relay-row";
    const tag = document.createElement("span"); tag.className = "rr-owner"; tag.textContent = "";
    wrap.appendChild(tag);
    wrap.appendChild(makeRow(null, null));
    board.appendChild(wrap);
  }
  // keep the action in view: the input row if it's my turn, else the latest
  // guess — never the trailing empty slots
  const anchor = S.inputRowEl
    ? S.inputRowEl.parentElement
    : board.children[Math.max(0, rd.rows.length - 1)];
  if (anchor && anchor.scrollIntoView) anchor.scrollIntoView({ block: "nearest" });

  // pending effect
  const pn = els["pending-note"];
  if (rd.pending) {
    const by = playerByPid(rd.pending.by), tg = playerByPid(rd.pending.target);
    const what = rd.pending.kind === "time" ? "⏱ timer cut to 7s"
      : rd.pending.kind === "ban" ? `🚫 letter ${String(rd.pending.letter).toUpperCase()} banned`
      : `🎯 must start with ${String(rd.pending.letter).toUpperCase()}`;
    pn.textContent = `${what} — ${by ? by.name : "?"} → ${tg ? tg.name : "?"}`;
    pn.hidden = false;
  } else pn.hidden = true;

  // sabotage bar
  const sb = els["sabotage-bar"];
  if (rd.kind === "sabotage" && myTurn && rd.charges) {
    const mine = rd.charges[S.pid] || 0;
    sb.hidden = mine <= 0;
    els["sab-charges"].textContent = "⚡".repeat(mine);
    sb.querySelectorAll(".sab-btn").forEach((b) => { b.disabled = mine <= 0; });
  } else sb.hidden = true;

  // keyboard
  const kb = els["keyboard"];
  kb.hidden = S.spectating;
  if (!S.spectating) {
    const banned = rd.pending && rd.pending.kind === "ban" && myTurn
      ? rd.pending.letter : null;
    renderKeyboard(keyStates(rd.rows), myTurn, banned);
    kb.classList.toggle("locked", !myTurn);
  }
}

function renderKeyboard(ks, enabled, bannedLetter) {
  const kb = els["keyboard"];
  kb.textContent = "";
  for (const rowStr of KEY_ROWS) {
    const kr = document.createElement("div");
    kr.className = "krow";
    for (const ch of rowStr) {
      const k = document.createElement("button");
      if (ch === "!") { k.className = "key wide"; k.textContent = "ENTER"; k.dataset.k = "enter"; }
      else if (ch === "<") { k.className = "key wide"; k.textContent = "⌫"; k.dataset.k = "back"; }
      else {
        k.className = "key" + (ks[ch] ? " " + ks[ch] : "");
        if (bannedLetter === ch) k.className = "key banned";
        k.textContent = ch; k.dataset.k = ch;
      }
      kr.appendChild(k);
    }
    kb.appendChild(kr);
  }
  kb.classList.toggle("locked", !enabled);
}

/* ---------------- input ---------------- */

function pressKey(k) {
  const st = S.st;
  if (!st || st.phase !== "playing" || S.spectating) return;
  const rd = st.match?.round;
  if (!rd) return;
  if (rd.kind !== "duel" && rd.turn !== S.pid) return;
  if (rd.kind === "duel") {
    const b = rd.boards[S.pid];
    if (!b || b.done) return;
  }
  if (k === "enter") {
    if (S.typed.length === 5) { send({ t: "guess", word: S.typed }); }
    else {
      toast("five letters needed", "err");
      if (S.inputRowEl) {
        S.inputRowEl.classList.remove("shake");
        void S.inputRowEl.offsetWidth;
        S.inputRowEl.classList.add("shake");
      }
    }
    return;
  }
  if (k === "back") { S.typed = S.typed.slice(0, -1); }
  else if (/^[a-z]$/.test(k) && S.typed.length < 5) { S.typed += k; SFX.click(); }
  refreshTypedRow();
}

function refreshTypedRow() {
  if (!S.inputRowEl) { renderGame(S.st); return; }
  for (let i = 0; i < 5; i++) {
    const t = S.inputRowEl.children[i];
    const ch = S.typed[i];
    t.textContent = ch ? ch.toUpperCase() : "";
    t.className = ch ? "tile typed" : "tile";
  }
}

els["keyboard"].addEventListener("click", (e) => {
  const b = e.target.closest(".key");
  if (b) { SFX.unlock(); pressKey(b.dataset.k); }
});
addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (!els["screen-game"].hidden) {
    if (e.key === "Enter") pressKey("enter");
    else if (e.key === "Backspace") pressKey("back");
    else if (/^[a-zA-Z]$/.test(e.key)) pressKey(e.key.toLowerCase());
  } else if (!els["screen-join"].hidden && e.key === "Enter") {
    els["join-btn"].click();
  }
});

/* clear the typed row the moment the server accepts a guess (synchronous —
   runs inside onState before any further keypresses can land), and reset all
   per-round client state when the authoritative round identity changes (a
   reconnect can skip the round_start fx entirely) */
let lastOwnRowCount = 0;
let roundKey = "";
function syncTypedRow(st) {
  const key = st.match ? `${st.match.id}:${st.match.round_num}` : "";
  if (key !== roundKey) {
    roundKey = key;
    S.typed = "";
    S.lastRows = {};
    lastOwnRowCount = 0;
  }
  if (!st || st.phase !== "playing" || !st.match?.round) { lastOwnRowCount = 0; return; }
  const rd = st.match.round;
  const n = rd.kind === "duel"
    ? (rd.boards[S.pid]?.rows.length || 0)
    : rd.rows.length;
  if (n > lastOwnRowCount) S.typed = "";
  lastOwnRowCount = n;
}

/* ---------------- sabotage UI ---------------- */

els["sabotage-bar"].addEventListener("click", (e) => {
  const b = e.target.closest(".sab-btn");
  if (!b) return;
  const kind = b.dataset.sab;
  if (kind === "time") { send({ t: "sabotage", kind: "time" }); return; }
  openLetterModal(kind);
});

let letterKind = null;
function openLetterModal(kind) {
  letterKind = kind;
  els["letter-modal-title"].textContent =
    kind === "ban" ? "BAN A LETTER" : "FORCE A STARTING LETTER";
  const grid = els["letter-grid"];
  grid.textContent = "";
  const rd = S.st?.match?.round;
  const revealed = new Set();
  if (rd && kind === "ban") {
    for (const r of rd.rows) {
      if (!r.w || !r.m) continue;
      for (let i = 0; i < 5; i++) if (r.m[i] !== "b") revealed.add(r.w[i]);
    }
  }
  for (const ch of "abcdefghijklmnopqrstuvwxyz") {
    const b = document.createElement("button");
    b.className = "letter-cell";
    b.textContent = ch;
    b.disabled = revealed.has(ch);
    b.onclick = () => {
      send({ t: "sabotage", kind: letterKind, letter: ch });
      els["letter-modal"].hidden = true;
    };
    grid.appendChild(b);
  }
  els["letter-modal"].hidden = false;
}
els["letter-cancel"].onclick = () => { els["letter-modal"].hidden = true; };

/* ---------------- round end ---------------- */

let reRendered = "";
function renderRoundEnd(st) {
  const m = st.match;
  if (!m || !m.reveal) return;
  const key = `${m.id}:${m.round_num}`;
  els["re-next"].textContent = "";
  if (reRendered === key) return;   // render once; timer handled in raf
  reRendered = key;

  els["re-reason"].textContent = REASONS[m.reveal.reason] || "ROUND OVER";
  const w = els["re-word"];
  w.textContent = "";
  m.reveal.secret.split("").forEach((ch, i) => {
    const t = document.createElement("div");
    t.className = "tile g flip";
    t.style.animationDelay = `${i * 120}ms`;
    t.textContent = ch.toUpperCase();
    w.appendChild(t);
  });

  const rs = els["re-scores"];
  rs.textContent = "";
  const entries = Object.entries(m.reveal.round_scores)
    .sort((a, b) => b[1].pts - a[1].pts);
  for (const [pid, sc] of entries) {
    const p = playerByPid(pid);
    if (!p) continue;
    const row = document.createElement("div");
    row.className = "re-row" + (sc.solved ? " winner" : "");
    const av = document.createElement("span"); av.className = "rr-av"; fillAvatar(av, p);
    const nm = document.createElement("span"); nm.className = "rr-name";
    nm.textContent = p.name + (sc.solved ? " 🏆" : "");
    const dl = document.createElement("span");
    dl.className = "rr-delta" + (sc.pts < 0 ? " neg" : "");
    dl.textContent = (sc.pts >= 0 ? "+" : "") + sc.pts;
    const tt = document.createElement("span"); tt.className = "rr-total";
    tt.textContent = m.scores[pid] ?? 0;
    row.appendChild(av); row.appendChild(nm); row.appendChild(dl); row.appendChild(tt);
    rs.appendChild(row);
  }
}

/* ---------------- podium ---------------- */

function renderPodium(st) {
  const m = st.match;
  if (!m || !m.podium) return;
  const pod = els["podium"];
  pod.textContent = "";
  const p = m.podium;
  const orderIdx = p.length >= 3 ? [1, 0, 2] : [1, 0];
  for (const i of orderIdx) {
    if (!p[i]) continue;
    const e = p[i];
    const col = document.createElement("div");
    col.className = `pod-col pod-${e.rank}`;
    if (e.rank === 1) {
      const cr = document.createElement("div"); cr.className = "pod-crown"; cr.textContent = "👑";
      col.appendChild(cr);
    }
    const av = document.createElement("div"); av.className = "pod-av"; fillAvatar(av, e);
    const nm = document.createElement("div"); nm.className = "pod-name"; nm.textContent = e.name;
    const sc = document.createElement("div"); sc.className = "pod-score"; sc.textContent = e.score;
    const bl = document.createElement("div"); bl.className = "pod-block"; bl.textContent = e.rank;
    col.appendChild(av); col.appendChild(nm); col.appendChild(sc); col.appendChild(bl);
    pod.appendChild(col);
  }
  const rest = els["podium-rest"];
  rest.textContent = "";
  for (const e of p.slice(3)) {
    const row = document.createElement("div");
    row.className = "re-row";
    const av = document.createElement("span"); av.className = "rr-av"; fillAvatar(av, e);
    const nm = document.createElement("span"); nm.className = "rr-name"; nm.textContent = `${e.rank}. ${e.name}`;
    const tt = document.createElement("span"); tt.className = "rr-total"; tt.textContent = e.score;
    row.appendChild(av); row.appendChild(nm); row.appendChild(tt);
    rest.appendChild(row);
  }
  if (!S.podiumDone) {
    S.podiumDone = true;
    Confetti.burst(220);
    setTimeout(() => Confetti.burst(160), 700);
  }
}
els["rematch-btn"].onclick = () => { SFX.click(); send({ t: "again" }); };

/* brag card from the podium */
if (window.Brag) {
  const MODE_LABEL = { duel: "DUEL", relay: "RELAY", sabotage: "SABOTAGE" };
  const btn = Brag.button(() => {
    const m = S.st?.match;
    if (!m || !m.podium || !m.podium.length) return null;
    const champs = m.podium.filter((e) => e.rank === 1);
    const rest = m.podium.filter((e) => e.rank !== 1);
    return {
      title: "Wordclash", icon: "🟩",
      winner: { name: champs.map((e) => e.name).join(" + "),
                avatar: champs[0].avatar,
                pfp: champs.length === 1 ? champs[0].pfp : null },
      headline: `${champs[0].score} pts · ${MODE_LABEL[m.mode] || "WORDLE"}`,
      beaten: rest.slice(0, 4).map((e) => ({ name: e.name, score: e.score })),
    };
  });
  document.querySelector(".podium-wrap")
    .insertBefore(btn, els["rematch-btn"]);
}

/* ---------------- timers (rAF) ---------------- */

let lastTickSec = -1;
function raf() {
  requestAnimationFrame(raf);
  const st = S.st;
  if (!st) return;
  const rem = remainMs();

  if (st.phase === "countdown") {
    const n = Math.max(1, Math.ceil(rem / 1000));
    els["countdown-num"].textContent = n;
    if (n !== S.countdownShown) { S.countdownShown = n; SFX.tick(); }
  } else S.countdownShown = -1;

  if (st.phase === "playing" && st.match?.round) {
    const rd = st.match.round;
    let total = 1;
    if (rd.kind === "duel") total = (rd.seconds || 180) * 1000;
    else total = (rd.turn_seconds || 15) * 1000;
    const frac = st.deadline ? Math.min(1, rem / total) : 0;
    els["hud-timer-fill"].style.transform = `scaleX(${frac})`;
    els["hud-timer"].classList.toggle("low", rem < 10500 && rem > 0);
    els["hud-clock"].textContent = fmtClock(rem);
    els["hud-clock"].classList.toggle("low", rem < 10500 && rem > 0);
    // relay ring
    if (rd.kind !== "duel") {
      const C = 119.4;
      els["ring-fg"].style.strokeDashoffset = C * (1 - frac);
      els["ring-fg"].style.stroke = frac < 0.3 ? "var(--danger)" : "var(--cyan)";
    }
    // urgency ticks: my relay turn last 5s, duel last 10s
    const sec = Math.ceil(rem / 1000);
    if (sec !== lastTickSec && sec <= 10 && sec > 0) {
      const myTurn = rd.kind !== "duel" && rd.turn === S.pid;
      if ((myTurn && sec <= 5) || (rd.kind === "duel" && sec <= 10)) SFX.tick();
      lastTickSec = sec;
    }
  }

  if (st.phase === "round_end" && st.match) {
    const last = st.match.round_num >= st.match.rounds_total;
    els["re-next"].textContent =
      `${last ? "final standings" : "next round"} in ${Math.ceil(rem / 1000)}s`;
  }
  if (st.phase === "podium") {
    els["podium-auto"].textContent = `back to lobby in ${Math.ceil(rem / 1000)}s`;
  }
}
requestAnimationFrame(raf);

/* ---------------- join & profile ---------------- */

function buildAvatarGrid(host, current, onPick) {
  host.textContent = "";
  for (const a of AVATARS) {
    const c = document.createElement("button");
    c.className = "avatar-cell" + (a === current ? " sel" : "");
    c.textContent = a;
    c.onclick = () => {
      host.querySelectorAll(".avatar-cell").forEach((x) => x.classList.remove("sel"));
      c.classList.add("sel");
      onPick(a);
    };
    host.appendChild(c);
  }
}

function initJoin() {
  els["name-input"].value = localStorage.getItem("wc-name") || "";
  if (!S.avatarPick) S.avatarPick = AVATARS[(Math.random() * AVATARS.length) | 0];
  buildAvatarGrid(els["avatar-grid"], S.avatarPick, (a) => { S.avatarPick = a; });
  els["join-btn"].onclick = () => {
    SFX.unlock();
    const name = els["name-input"].value.trim() || "PLAYER";
    localStorage.setItem("wc-name", name);
    localStorage.setItem("wc-avatar", S.avatarPick);
    S.joined = true;
    if (S.ws && S.ws.readyState === 1) {
      send({ t: "profile", name, avatar: S.avatarPick });
      if (S.st) onState(S.st);
    } else connect();
    show("screen-lobby");
  };
}

els["edit-profile-btn"].onclick = () => {
  els["profile-name"].value = localStorage.getItem("wc-name") || "";
  buildAvatarGrid(els["profile-avatars"], S.avatarPick, (a) => { S.avatarPick = a; });
  els["profile-modal"].hidden = false;
};
els["profile-cancel"].onclick = () => { els["profile-modal"].hidden = true; };
els["profile-save"].onclick = () => {
  const name = els["profile-name"].value.trim() || "PLAYER";
  localStorage.setItem("wc-name", name);
  localStorage.setItem("wc-avatar", S.avatarPick);
  send({ t: "profile", name, avatar: S.avatarPick });
  els["profile-modal"].hidden = true;
};

els["mute-btn"].onclick = () => {
  const m = SFX.toggle();
  els["mute-btn"].textContent = m ? "🔇" : "🔊";
};

els["ready-btn"].onclick = () => {
  SFX.unlock(); SFX.click();
  const my = me();
  send({ t: "ready", ready: !(my && my.ready) });
};
els["go-btn"].onclick = () => { SFX.unlock(); send({ t: "start" }); };

els["rounds-minus"].onclick = () => {
  send({ t: "settings", rounds: Math.max(1, (S.st?.settings.rounds || 3) - 1) });
};
els["rounds-plus"].onclick = () => {
  send({ t: "settings", rounds: Math.min(10, (S.st?.settings.rounds || 3) + 1) });
};
els["turn-minus"].onclick = () => {
  send({ t: "settings", turn_seconds: Math.max(5, (S.st?.settings.turn_seconds || 15) - 5) });
};
els["turn-plus"].onclick = () => {
  send({ t: "settings", turn_seconds: Math.min(60, (S.st?.settings.turn_seconds || 15) + 5) });
};

/* keepalive */
setInterval(() => send({ t: "ping" }), 25000);

/* ---------------- boot ---------------- */

initJoin();
wirePfpButton($("pfp-btn"));
wirePfpButton($("pfp-btn2"));
els["mute-btn"].textContent = SFX.muted ? "🔇" : "🔊";
if (localStorage.getItem("wc-name")) {
  // returning player: skip the join screen, connect straight away
  S.joined = true;
  connect();
  show("screen-lobby");
} else {
  show("screen-join");
}
