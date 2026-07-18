/* SNAKE ARENA client — the server owns the world and pushes a state every
   ~130 ms tick; this renders the arena and interpolates between states so
   movement glides instead of stepping. Input is direction changes ONLY
   (swipe / d-pad / keys) — never per-frame messages. */
"use strict";

const $ = (id) => document.getElementById(id);

const S = {
  st: null, pid: null, conn: null, joined: false,
  prevB: {},             // pid -> body from the previous tick (for lerp)
  stAt: 0,               // performance.now() when the current tick landed
  particles: [],
  floaters: [],
  flash: null,           // {text, until} round-start splash
  lastDir: null, lastDirAt: 0,
  ctrl: localStorage.getItem("snake-ctrl") || "swipe",  // swipe | tap | pad
  intendedDir: null, intendedTick: -1,   // optimistic heading for relative taps
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
    eat: () => tone(520, "triangle", 0.09, 0.11, 0, 240),
    pellet: () => tone(380, "triangle", 0.05, 0.06, 0, 120),
    gold: () => { tone(784, "sine", 0.12, 0.12); tone(1175, "sine", 0.16, 0.11, 0.08); tone(1568, "sine", 0.2, 0.1, 0.16); },
    crash: () => { tone(90, "sawtooth", 0.4, 0.2, 0, -40); tone(150, "square", 0.25, 0.1, 0.02, -80); },
    round: () => { tone(660, "sine", 0.12, 0.12); tone(880, "sine", 0.16, 0.1, 0.09); },
    win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, "sine", 0.24, 0.13, i * 0.09)),
    bad: () => tone(150, "sawtooth", 0.2, 0.08),
  };
})();

/* ---------------- helpers ---------------- */
const game = () => S.st?.game || null;
const playerByPid = (pid) => (S.st?.players || []).find((p) => p.pid === pid) || null;
const remainMs = () => S.st?.deadline ? Math.max(0, S.st.deadline - S.conn.now()) : 0;
const mySnake = () => {
  const g = game();
  return g ? g.snakes.find((sn) => sn.pid === S.pid) || null : null;
};

function show(id) {
  for (const s of ["scr-join", "scr-lobby", "scr-game"]) $(s).hidden = s !== id;
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
    ? "solo — a bot snake slithers in to chase you"
    : "1-8 snakes per pit · bots fill in";

  seg("opt-difficulty", [["sharp", "SHARP"], ["rookie", "ROOKIE"]],
      st.settings.difficulty, "difficulty");
  seg("opt-rounds", [[1, "1"], [3, "3"], [5, "5"]],
      st.settings.rounds, "rounds");
  $("bots-val").textContent = st.settings.bot_players;

  const me = st.you;
  const amReady = !!(me && me.ready);
  $("ready-btn").textContent = amReady ? "READY ✓" : "READY UP";
  $("ready-btn").classList.toggle("is-ready", amReady);
  $("go-btn").hidden = !(readyN >= st.min_players && amReady && st.phase === "lobby");
  $("lobby-hint").textContent =
    st.phase === "countdown" ? "OPENING THE PIT…"
    : readyN >= 1 ? "" : `waiting — ${location.host}`;
}

/* ---------------- canvas ---------------- */

const cv = $("arena");
const cx2 = cv.getContext("2d");
let scale = 10, cw = 0, ch = 0;    // canvas px per cell, canvas size

function fitCanvas() {
  const g = game();
  const cols = g ? g.grid[0] : 44, rows = g ? g.grid[1] : 26;
  const rect = cv.getBoundingClientRect();
  if (!rect.width) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cw = Math.round(rect.width * dpr);
  ch = Math.round(cw * rows / cols);
  if (cv.width !== cw) cv.width = cw;
  if (cv.height !== ch) cv.height = ch;
  scale = cw / cols;
}
addEventListener("resize", fitCanvas);

const cc = (v) => (v + 0.5) * scale;              // cell center -> px

function interpFrac() {
  const g = game();
  if (!g) return 1;
  return Math.min(1, (performance.now() - S.stAt) / (g.tick_ms || 130));
}

function drawItems(g, t) {
  for (const it of g.items) {
    const px = cc(it.x), py = cc(it.y);
    if (it.what === "pellet") {
      const a = it.ttl === null ? 1 : Math.min(1, it.ttl / 24);
      cx2.globalAlpha = 0.35 + 0.5 * a;
      cx2.fillStyle = "#9aa7c7";
      cx2.beginPath(); cx2.arc(px, py, scale * 0.16, 0, 7); cx2.fill();
      cx2.globalAlpha = 1;
    } else if (it.what === "gold") {
      const pul = 1 + 0.16 * Math.sin(t * 6 + it.x);
      cx2.save();
      cx2.translate(px, py);
      cx2.rotate(t * 1.6);
      cx2.strokeStyle = "rgba(234,179,8,0.55)";
      cx2.lineWidth = Math.max(1, scale * 0.08);
      const rr2 = scale * 0.52 * pul;
      for (let i = 0; i < 4; i++) {
        cx2.rotate(Math.PI / 2);
        cx2.beginPath(); cx2.moveTo(rr2 * 0.5, 0); cx2.lineTo(rr2, 0); cx2.stroke();
      }
      cx2.restore();
      cx2.shadowColor = "#eab308"; cx2.shadowBlur = scale * 0.9;
      cx2.fillStyle = "#fbbf24";
      cx2.beginPath(); cx2.arc(px, py, scale * 0.34 * pul, 0, 7); cx2.fill();
      cx2.shadowBlur = 0;
      cx2.fillStyle = "rgba(255,247,214,0.9)";
      cx2.beginPath(); cx2.arc(px - scale * 0.1, py - scale * 0.12, scale * 0.09, 0, 7); cx2.fill();
    } else {                                       // apple
      const pul = 1 + 0.1 * Math.sin(t * 4 + it.x + it.y);
      cx2.fillStyle = "#fb7185";
      cx2.beginPath(); cx2.arc(px, py + scale * 0.02, scale * 0.3 * pul, 0, 7); cx2.fill();
      cx2.strokeStyle = "#34d399";
      cx2.lineWidth = Math.max(1, scale * 0.07);
      cx2.beginPath();
      cx2.moveTo(px, py - scale * 0.26 * pul);
      cx2.quadraticCurveTo(px + scale * 0.16, py - scale * 0.42, px + scale * 0.2, py - scale * 0.3);
      cx2.stroke();
      cx2.fillStyle = "rgba(255,255,255,0.35)";
      cx2.beginPath(); cx2.arc(px - scale * 0.1, py - scale * 0.08, scale * 0.07, 0, 7); cx2.fill();
    }
  }
}

function drawSnakes(g, f) {
  const labels = [];
  for (const sn of g.snakes) {
    if (!sn.alive || !sn.body.length) continue;
    const p = playerByPid(sn.pid);
    const color = p ? p.color : "#8b96b3";
    const body = sn.body;
    const prev = S.prevB[sn.pid];

    // head glides from last tick's cell to this tick's cell
    let hx = body[0][0], hy = body[0][1];
    if (prev && prev.length && f < 1) {
      const dx = body[0][0] - prev[0][0], dy = body[0][1] - prev[0][1];
      if (Math.abs(dx) + Math.abs(dy) === 1) {
        hx = prev[0][0] + dx * f; hy = prev[0][1] + dy * f;
      }
    }
    // tail retracts the same way (only when it actually moved)
    const ti = body.length - 1;
    let tail = null, drawTo = ti;
    if (prev && prev.length === body.length && f < 1 && ti >= 1) {
      const dx = body[ti][0] - prev[ti][0], dy = body[ti][1] - prev[ti][1];
      if (Math.abs(dx) + Math.abs(dy) === 1) {
        tail = [prev[ti][0] + dx * f, prev[ti][1] + dy * f];
        drawTo = ti - 1;
      }
    }

    // one continuous rounded ribbon: lerped head -> cells -> lerped tail
    const pts = [[hx, hy]];
    for (let i = 1; i <= drawTo; i++) pts.push(body[i]);
    if (tail) pts.push(tail);
    cx2.globalAlpha = sn.auto ? 0.8 : 1;
    cx2.lineCap = "round";
    cx2.lineJoin = "round";
    cx2.beginPath();
    cx2.moveTo(cc(pts[0][0]), cc(pts[0][1]));
    for (let i = 1; i < pts.length; i++) cx2.lineTo(cc(pts[i][0]), cc(pts[i][1]));
    cx2.strokeStyle = color;
    cx2.lineWidth = scale * 0.68;
    cx2.shadowColor = color; cx2.shadowBlur = scale * 0.55;
    cx2.stroke();
    cx2.shadowBlur = 0;
    cx2.strokeStyle = "rgba(7,11,20,0.28)";      // inner stripe for depth
    cx2.lineWidth = scale * 0.24;
    cx2.stroke();

    // head knob: a touch bigger, glowing, eyes looking down-heading
    cx2.fillStyle = color;
    cx2.shadowColor = color; cx2.shadowBlur = scale * 0.95;
    cx2.beginPath(); cx2.arc(cc(hx), cc(hy), scale * 0.47, 0, 7); cx2.fill();
    cx2.shadowBlur = 0;
    const [ddx, ddy] = sn.dir;
    const ex = cc(hx) + ddx * scale * 0.16, ey = cc(hy) + ddy * scale * 0.16;
    const pxp = -ddy * scale * 0.18, pyp = ddx * scale * 0.18;
    cx2.fillStyle = "#ffffff";
    cx2.beginPath(); cx2.arc(ex + pxp, ey + pyp, scale * 0.12, 0, 7); cx2.fill();
    cx2.beginPath(); cx2.arc(ex - pxp, ey - pyp, scale * 0.12, 0, 7); cx2.fill();
    cx2.fillStyle = "#0a0f22";
    cx2.beginPath(); cx2.arc(ex + pxp + ddx * scale * 0.05, ey + pyp + ddy * scale * 0.05, scale * 0.055, 0, 7); cx2.fill();
    cx2.beginPath(); cx2.arc(ex - pxp + ddx * scale * 0.05, ey - pyp + ddy * scale * 0.05, scale * 0.055, 0, 7); cx2.fill();
    cx2.globalAlpha = 1;

    labels.push({ x: cc(hx), y: hy * scale - scale * 0.35, p, sn, color });
  }
  // name tags on top of everything
  cx2.textAlign = "center";
  const fs = Math.max(9, scale * 1.05);
  cx2.font = `700 ${fs}px JBMono, monospace`;
  for (const L of labels) {
    const name = (L.p ? `${L.p.avatar} ${L.p.name}` : "?")
      + (L.sn.auto && L.p && !L.p.bot ? " 🛰" : "");
    const y = Math.max(fs + 2, L.y);
    cx2.lineWidth = 3;
    cx2.strokeStyle = "rgba(7,11,20,0.85)";
    cx2.strokeText(name, L.x, y);
    cx2.fillStyle = L.sn.pid === S.pid ? "#e8edf9" : "rgba(232,237,249,0.75)";
    cx2.fillText(name, L.x, y);
  }
}

function drawScene() {
  const g = game();
  if (!g) return;
  fitCanvas();
  if (!cw) return;
  cx2.clearRect(0, 0, cw, ch);
  const t = performance.now() / 1000;

  // faint cell grid
  cx2.strokeStyle = "rgba(139,150,179,0.06)";
  cx2.lineWidth = 1;
  cx2.beginPath();
  for (let x = 1; x < g.grid[0]; x++) { cx2.moveTo(x * scale, 0); cx2.lineTo(x * scale, ch); }
  for (let y = 1; y < g.grid[1]; y++) { cx2.moveTo(0, y * scale); cx2.lineTo(cw, y * scale); }
  cx2.stroke();

  drawItems(g, t);
  drawSnakes(g, interpFrac());

  // particles + floaters
  for (const pt of S.particles) {
    cx2.globalAlpha = Math.max(0, pt.life / 34);
    cx2.fillStyle = pt.c;
    cx2.fillRect(pt.x, pt.y, Math.max(2, scale * 0.16), Math.max(2, scale * 0.16));
  }
  cx2.globalAlpha = 1;
  cx2.textAlign = "center";
  for (const fl of S.floaters) {
    cx2.globalAlpha = Math.max(0, fl.life / 46);
    cx2.font = `800 ${Math.max(11, scale * 1.2)}px JBMono, monospace`;
    cx2.strokeStyle = "rgba(7,11,20,0.8)"; cx2.lineWidth = 3;
    cx2.strokeText(fl.text, fl.x, fl.y);
    cx2.fillStyle = fl.c;
    cx2.fillText(fl.text, fl.x, fl.y);
  }
  cx2.globalAlpha = 1;
}

function burst(cells, color) {
  for (const [cxl, cyl] of cells) {
    for (let i = 0; i < 3; i++) {
      const a = Math.random() * 6.28, v = (0.4 + Math.random() * 1.6) * scale;
      S.particles.push({
        x: cc(cxl), y: cc(cyl),
        vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        life: 22 + Math.random() * 12,
        c: [color, "#e8edf9", "#fbbf24"][i % 3],
      });
    }
  }
  if (S.particles.length > 400) S.particles.splice(0, S.particles.length - 400);
}

function stepFx() {
  for (const pt of S.particles) {
    pt.x += pt.vx * 0.033; pt.y += pt.vy * 0.033;
    pt.vx *= 0.96; pt.vy *= 0.96; pt.life--;
  }
  S.particles = S.particles.filter((p) => p.life > 0);
  for (const fl of S.floaters) { fl.y -= scale * 0.03; fl.life--; }
  S.floaters = S.floaters.filter((f) => f.life > 0);
}

/* ---------------- arena chrome ---------------- */

function renderChips(g) {
  const row = $("score-row");
  row.textContent = "";
  for (const sn of g.snakes) {
    const p = playerByPid(sn.pid);
    const chip = document.createElement("span");
    chip.className = "sn-chip" + (sn.alive ? "" : " dead")
      + (sn.pid === S.pid ? " you" : "");
    const av = document.createElement("span");
    Hub.fillAvatar(av, p);
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = p ? p.color : "#8b96b3";
    const score = document.createElement("b");
    score.textContent = sn.score;
    const ln = document.createElement("span");
    ln.className = "ln";
    ln.textContent = sn.alive ? "·" + sn.len : "💀";
    chip.append(dot, av, score, ln);
    if (sn.wins > 0) {
      const st = document.createElement("span");
      st.className = "stars";
      st.textContent = "★".repeat(Math.min(sn.wins, 3));
      chip.appendChild(st);
    }
    row.appendChild(chip);
  }
}

function renderArena(st) {
  const g = game();
  $("sn-round").textContent =
    `ROUND ${Math.min(g.round, g.rounds_total)}/${g.rounds_total}`;
  const aliveN = g.snakes.filter((sn) => sn.alive).length;
  $("sn-alive").textContent = "🐍 " + aliveN;
  renderChips(g);
  const mine = mySnake();
  const watching = g.stage === "play" && (!mine || !mine.alive);
  $("watch-note").hidden = !watching;
  $("watch-note").textContent = mine && !mine.alive
    ? "💀 YOU'RE OUT — WATCHING THE PIT" : "WATCHING THE PIT";
  $("steer-hint").hidden = watching || g.stage !== "play";
}

let goShown = false;
function renderGameOver(st) {
  const g = game();
  const showIt = st.phase === "game_end" && g && g.result;
  $("gameover").hidden = !showIt;
  if (!showIt) { goShown = false; return; }
  const res = g.result;
  const wp = playerByPid(res.winner);
  const wrow = res.standings.find((r) => r.pid === res.winner);
  $("go-title").textContent = wp ? `${wp.name.toUpperCase()} RULES THE PIT` : "NOBODY SURVIVED";
  $("go-line").textContent = wrow
    ? `${wrow.wins} round ${wrow.wins === 1 ? "win" : "wins"} · ${wrow.score} pts · longest ${wrow.best_len}`
    : "";
  const rows = $("go-rows");
  rows.textContent = "";
  for (const r of res.standings) {
    const p = playerByPid(r.pid);
    const div = document.createElement("div");
    div.className = "go-row" + (r.pid === res.winner ? " first" : "");
    const av = document.createElement("span");
    Hub.fillAvatar(av, p);
    const nm = document.createElement("span");
    nm.textContent = p ? p.name : "?";
    const stars = document.createElement("span");
    stars.className = "gr-stars";
    stars.textContent = r.wins ? "★".repeat(Math.min(r.wins, 3)) : "";
    const b = document.createElement("b");
    b.textContent = r.score + " pts";
    div.append(av, nm, stars, b);
    rows.appendChild(div);
  }
  if (!goShown) {
    goShown = true;
    if (res.winner === S.pid) { Hub.confettiBurst(200); SFX.win(); }
    else SFX.crash();
  }
}

/* ---------------- state entry ---------------- */

function applyState(st) {
  if (!S.joined) return;
  if (st.phase === "lobby" || st.phase === "countdown") {
    show("scr-lobby");
    S.particles = []; S.floaters = []; S.prevB = {};
    renderLobby(st);
  } else if (st.game) {
    show("scr-game");
    renderArena(st);
  }
  renderGameOver(st);
  $("countdown-overlay").hidden = st.phase !== "countdown";
}

function onState(st) {
  const old = S.st;
  if (old && old.game && st.game && old.game.tick !== st.game.tick) {
    S.prevB = {};
    for (const sn of old.game.snakes) S.prevB[sn.pid] = sn.body;
    S.stAt = performance.now();
  } else if (!old || !old.game || !st.game) {
    S.prevB = {};
    S.stAt = performance.now();
  }
  S.st = st;
  applyState(st);
}

function onFx(fx) {
  switch (fx.kind) {
    case "toast": Hub.toast((fx.icon ? fx.icon + " " : "") + fx.msg); break;
    case "invalid": Hub.toast(fx.msg, "err"); SFX.bad(); break;
    case "eat": {
      if (fx.what === "gold") SFX.gold();
      else if (fx.what === "pellet") SFX.pellet();
      else SFX.eat();
      const c = fx.what === "gold" ? "#fbbf24"
        : fx.what === "pellet" ? "#9aa7c7" : "#fb7185";
      S.floaters.push({ x: cc(fx.x), y: cc(fx.y) - scale * 0.4,
                        text: "+" + fx.points, c, life: 46 });
      break;
    }
    case "gold_spawn":
      SFX.gold();
      Hub.toast("✨ GOLDEN APPLE — 8 seconds!");
      break;
    case "death": {
      const p = playerByPid(fx.pid);
      burst(fx.cells || [], p ? p.color : "#8b96b3");
      SFX.crash();
      if (fx.pid === S.pid) {
        try { navigator.vibrate && navigator.vibrate([60, 40, 80]); } catch (e) {}
      }
      break;
    }
    case "round_over": SFX.round(); break;
    case "round_start":
      SFX.round();
      S.flash = { text: `ROUND ${fx.round}`, until: performance.now() + 1200 };
      break;
    case "countdown": SFX.round(); break;
  }
}

/* ---------------- controls ---------------- */

function sendDir(name) {
  const g = game();
  if (!g || g.stage !== "play") return;
  const mine = mySnake();
  if (!mine || !mine.alive) return;
  const now = performance.now();
  if (S.lastDir === name && now - S.lastDirAt < 250) return;
  S.lastDir = name; S.lastDirAt = now;
  S.conn.send({ t: "turn", dir: name });
}

// relative steering: turn 90° left/right of a heading vector -> dir name
const DIRNAME = { "0,-1": "up", "0,1": "down", "-1,0": "left", "1,0": "right" };
function relTurn(dir, side) {
  const [dx, dy] = dir;
  const v = side === "right" ? [-dy, dx] : [dy, -dx];  // CW : CCW
  return DIRNAME[v[0] + "," + v[1]] || null;
}
function sendRel(side) {
  const g = game();
  if (!g || g.stage !== "play") return;
  const mine = mySnake();
  if (!mine || !mine.alive) return;
  // base each turn off an optimistic heading, reset to server truth per tick,
  // so a quick double-tap chains (up -> right -> down = a U-turn) instead of
  // computing both turns from the same stale heading
  if (S.intendedTick !== g.tick) { S.intendedDir = mine.dir; S.intendedTick = g.tick; }
  const [dx, dy] = S.intendedDir || mine.dir;
  const nv = side === "right" ? [-dy, dx] : [dy, -dx];
  const name = DIRNAME[nv[0] + "," + nv[1]];
  if (!name) return;
  S.intendedDir = nv;
  sendDir(name);
}

/* ---- control scheme (per-device preference) ---- */
const STEER_MODES = [["swipe", "SWIPE"], ["tap", "TAP L/R"], ["pad", "D-PAD"]];
const CTRL_ICON = { swipe: "↔", tap: "👆", pad: "✚" };

function updateSteerHint() {
  const h = $("steer-hint");
  if (!h) return;
  h.textContent =
    S.ctrl === "tap" ? "tap LEFT / RIGHT side to turn · arrows / WASD"
    : S.ctrl === "pad" ? "use the ✚ pad · arrows / WASD"
    : "swipe anywhere · arrows / WASD";
}
function setCtrl(mode) {
  if (!STEER_MODES.some(([v]) => v === mode)) mode = "swipe";
  S.ctrl = mode;
  localStorage.setItem("snake-ctrl", mode);
  $("scr-game").dataset.ctrl = mode;
  document.querySelectorAll("#opt-steer button").forEach((b) =>
    b.classList.toggle("sel", b.dataset.v === mode));
  const cb = $("ctrl-btn");
  if (cb) cb.textContent = CTRL_ICON[mode];
  updateSteerHint();
}
function cycleCtrl() {
  const i = STEER_MODES.findIndex(([v]) => v === S.ctrl);
  setCtrl(STEER_MODES[(i + 1) % STEER_MODES.length][0]);
}
function buildSteerSeg() {
  const host = $("opt-steer");
  if (!host) return;
  host.textContent = "";
  for (const [val, label] of STEER_MODES) {
    const b = document.createElement("button");
    b.dataset.v = val; b.textContent = label;
    b.onclick = () => { SFX.click(); setCtrl(val); };
    host.appendChild(b);
  }
}
window.__snake = { relTurn };   // test hook (pure)

// swipe anywhere on the arena screen (re-arms after each trigger so a
// quick L-shaped drag queues two turns)
let swipe = null;
const SWIPE_PX = 24;
$("scr-game").addEventListener("pointerdown", (e) => {
  if (e.target.closest("button") || e.target.closest("a")) return;
  SFX.unlock();
  if (S.ctrl === "tap") {
    // relative steering: which half of the screen was tapped
    sendRel(e.clientX < window.innerWidth / 2 ? "left" : "right");
  } else if (S.ctrl === "swipe") {
    swipe = { x: e.clientX, y: e.clientY, id: e.pointerId };
  }
  // pad mode: the arena ignores taps — steer with the ✚ pad
});
$("scr-game").addEventListener("pointermove", (e) => {
  if (S.ctrl !== "swipe" || !swipe || e.pointerId !== swipe.id) return;
  const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_PX) return;
  sendDir(Math.abs(dx) > Math.abs(dy)
    ? (dx > 0 ? "right" : "left")
    : (dy > 0 ? "down" : "up"));
  swipe = { x: e.clientX, y: e.clientY, id: e.pointerId };
});
addEventListener("pointerup", () => { swipe = null; });
addEventListener("pointercancel", () => { swipe = null; });

for (const b of document.querySelectorAll("#dpad .dp")) {
  b.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    SFX.unlock();
    sendDir(b.dataset.d);
  });
}

const KEYS = {
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  w: "up", s: "down", a: "left", d: "right",
  W: "up", S: "down", A: "left", D: "right",
};
addEventListener("keydown", (e) => {
  const dir = KEYS[e.key];
  if (!dir || $("scr-game").hidden) return;
  e.preventDefault();
  sendDir(dir);
});

/* brag */
if (window.Brag) {
  const btn = Brag.button(() => {
    const g = game();
    if (!g || !g.result || !g.result.winner) return null;
    const wp = playerByPid(g.result.winner);
    const wrow = g.result.standings.find((r) => r.pid === g.result.winner);
    const losers = g.result.standings.filter((r) => r.pid !== g.result.winner);
    return {
      title: "Snake Arena", icon: "🐍",
      winner: { name: wp ? wp.name : "?", avatar: wp ? wp.avatar : "🐍",
                pfp: wp ? wp.pfp : null },
      headline: `${wrow ? wrow.wins : 0} round ${wrow && wrow.wins === 1 ? "win" : "wins"} · ${wrow ? wrow.score : 0} pts`,
      beaten: losers.slice(0, 4).map((r) => {
        const p = playerByPid(r.pid);
        return { name: p ? p.name : "?", score: r.score };
      }),
    };
  });
  document.querySelector("#gameover .modal-card")
    .insertBefore(btn, $("rematch-btn"));
}

/* ---------------- render loop ---------------- */

function raf() {
  requestAnimationFrame(raf);
  stepFx();
  const st = S.st;
  if (!st) return;
  if (st.phase === "countdown") {
    $("countdown-num").textContent = Math.max(1, Math.ceil(remainMs() / 1000));
  }
  const g = game();
  if (!g || $("scr-game").hidden) return;
  drawScene();

  // round banner: between-round card, or a brief ROUND N splash
  const banner = $("round-banner");
  const now = performance.now();
  if (g.stage === "round_end") {
    const wp = playerByPid(g.round_winner);
    $("rb-title").textContent = wp
      ? `${wp.avatar} ${wp.name} TAKES ROUND ${g.round}` : "☠️ NO SURVIVORS";
    $("rb-sub").textContent = `round ${g.round + 1} in ${Math.ceil(remainMs() / 1000)}s`;
    banner.hidden = false;
  } else if (S.flash && now < S.flash.until) {
    $("rb-title").textContent = S.flash.text;
    $("rb-sub").textContent = "GO!";
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
  if (st.phase === "game_end") {
    $("go-auto").textContent = `lobby in ${Math.ceil(remainMs() / 1000)}s`;
  }
}
requestAnimationFrame(raf);

/* ---------------- boot & wiring ---------------- */

const stepBots = (delta) => {
  const cur = S.st?.settings.bot_players ?? 1;
  S.conn.send({ t: "settings",
                patch: { bot_players: Math.max(0, Math.min(7, cur + delta)) } });
};
$("bots-minus").onclick = () => { SFX.click(); stepBots(-1); };
$("bots-plus").onclick = () => { SFX.click(); stepBots(1); };

$("ready-btn").onclick = () => {
  SFX.unlock(); SFX.click();
  const me = S.st?.you;
  S.conn.send({ t: "ready", ready: !(me && me.ready) });
};
$("go-btn").onclick = () => { SFX.unlock(); S.conn.send({ t: "start" }); };
$("rematch-btn").onclick = () => S.conn.send({ t: "again" });

function wireMute(btn) {
  btn.onclick = () => {
    S.muted = !S.muted;
    localStorage.setItem("wc-muted", S.muted ? "1" : "0");
    $("mute-btn").textContent = $("mute-btn2").textContent = S.muted ? "🔇" : "🔊";
  };
  btn.textContent = S.muted ? "🔇" : "🔊";
}
wireMute($("mute-btn"));
wireMute($("mute-btn2"));

buildSteerSeg();
setCtrl(S.ctrl);
$("ctrl-btn").onclick = () => { SFX.click(); cycleCtrl(); };

function connect() {
  S.conn = Hub.connect("/games/snake/ws", {
    onWelcome: (m) => { S.pid = m.pid; },
    onState, onFx,
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
