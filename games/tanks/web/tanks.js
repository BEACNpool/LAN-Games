/* TANKS client — canvas battlefield. The server simulates every shot;
   this renders terrain/tanks and animates the tracer + explosion from the
   trajectory the server returns. */
"use strict";

const $ = (id) => document.getElementById(id);

const S = {
  st: null, pid: null, conn: null, joined: false,
  anim: null,            // {points, i, impact, damages, done}
  pendingState: null,    // state deferred until the animation finishes
  particles: [],
  floaters: [],          // damage numbers
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
    launch: () => tone(180, "sawtooth", 0.4, 0.14, 0, 300),
    boom: () => { tone(70, "sawtooth", 0.5, 0.22, 0, -30);
                  tone(120, "square", 0.3, 0.12, 0.02, -60); },
    hit: () => tone(320, "square", 0.15, 0.13, 0, -120),
    move: () => tone(140, "triangle", 0.05, 0.06),
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
    ? "solo — a bot tank will roll in to fight you"
    : "2-6 tanks per battle · bots fill in";

  seg("opt-terrain", [["rolling", "ROLLING"], ["craggy", "CRAGGY"], ["canyon", "CANYON"]],
      st.settings.terrain, "terrain");
  seg("opt-difficulty", [["sharp", "SHARP"], ["rookie", "ROOKIE"]],
      st.settings.difficulty, "difficulty");
  seg("opt-timer", [[30, "30s"], [45, "45s"], [60, "60s"], [90, "90s"]],
      st.settings.turn_seconds, "turn_seconds");
  $("bots-val").textContent = st.settings.bot_players;

  const me = st.you;
  const amReady = !!(me && me.ready);
  $("ready-btn").textContent = amReady ? "READY ✓" : "READY UP";
  $("ready-btn").classList.toggle("is-ready", amReady);
  $("go-btn").hidden = !(readyN >= st.min_players && amReady && st.phase === "lobby");
  $("lobby-hint").textContent =
    st.phase === "countdown" ? "DEPLOYING…"
    : readyN >= 1 ? "" : `waiting — ${location.host}`;
}

/* ---------------- canvas ---------------- */

const cv = $("field");
const cx2 = cv.getContext("2d");
let scale = 1, cw = 0, ch = 0;

function fitCanvas() {
  const g = game();
  if (!g) return;
  const [W, H] = g.world;
  const rect = cv.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cw = Math.round(rect.width * dpr);
  ch = Math.round(rect.height * dpr);
  if (cv.width !== cw) cv.width = cw;
  if (cv.height !== ch) cv.height = ch;
  scale = cw / W;
}
addEventListener("resize", () => { fitCanvas(); drawScene(); });

const wx = (x) => x * scale;
const wy = (y) => ch - y * scale * (ch / (600 * scale));   // fit H into canvas

function drawScene() {
  const g = game();
  if (!g) return;
  fitCanvas();
  cx2.clearRect(0, 0, cw, ch);
  const [W, H] = g.world;
  const sy = ch / H / scale;      // vertical squeeze factor world->canvas

  // stars
  cx2.fillStyle = "rgba(200,215,255,0.25)";
  for (let i = 0; i < 40; i++) {
    const sxr = (i * 137.5) % W;
    const syr = H - 40 - ((i * 73.1) % (H * 0.5));
    cx2.fillRect(wx(sxr), wy(syr), 2, 2);
  }

  // terrain
  const h = g.heights;
  cx2.beginPath();
  cx2.moveTo(0, ch);
  for (let x = 0; x < W; x += 2) {
    cx2.lineTo(wx(x), wy(h[x]));
  }
  cx2.lineTo(cw, ch);
  cx2.closePath();
  const grad = cx2.createLinearGradient(0, ch * 0.3, 0, ch);
  grad.addColorStop(0, "#2b3a63");
  grad.addColorStop(1, "#141b31");
  cx2.fillStyle = grad;
  cx2.fill();
  // glowing crust
  cx2.beginPath();
  for (let x = 0; x < W; x += 2) {
    const px = wx(x), py = wy(h[x]);
    if (x === 0) cx2.moveTo(px, py); else cx2.lineTo(px, py);
  }
  cx2.strokeStyle = "rgba(34,211,238,0.55)";
  cx2.lineWidth = 2;
  cx2.stroke();

  // tanks
  for (const tk of g.tanks) {
    const p = playerByPid(tk.pid);
    const color = p ? p.color : "#8b96b3";
    const x = wx(tk.x), y = wy(tk.y);
    if (tk.hp <= 0) {
      cx2.font = `${14 * (scale * 4)}px serif`;
      cx2.textAlign = "center";
      cx2.fillText("💀", x, y - 2);
      continue;
    }
    // turret
    const a = tk.angle * Math.PI / 180;
    cx2.strokeStyle = color;
    cx2.lineWidth = 3;
    cx2.beginPath();
    cx2.moveTo(x, y - 10 * scale * 2);
    cx2.lineTo(x + Math.cos(a) * 16 * scale * 2,
               y - 10 * scale * 2 - Math.sin(a) * 16 * scale * 2);
    cx2.stroke();
    // body
    cx2.fillStyle = color;
    const bw = 22 * scale * 2, bh = 9 * scale * 2;
    cx2.beginPath();
    cx2.roundRect(x - bw / 2, y - bh - 4 * scale * 2, bw, bh, 4);
    cx2.fill();
    cx2.fillStyle = "rgba(7,11,20,0.55)";
    cx2.beginPath();
    cx2.roundRect(x - bw / 2, y - 5 * scale * 2, bw, 5 * scale * 2, 3);
    cx2.fill();
    // name + hp
    cx2.font = `700 ${11 * Math.max(1, scale * 2.4)}px JBMono, monospace`;
    cx2.textAlign = "center";
    cx2.fillStyle = "rgba(232,237,249,0.85)";
    cx2.fillText(p ? p.name : "?", x, y - 26 * scale * 2);
    if (g.turn === tk.pid && g.stage === "battle") {
      cx2.fillStyle = "#22d3ee";
      cx2.fillText("▼", x, y - 38 * scale * 2);
    }
  }

  // projectile animation
  if (S.anim && !S.anim.done) {
    const pts = S.anim.points;
    const upto = Math.min(S.anim.i, pts.length - 1);
    cx2.beginPath();
    for (let i = Math.max(0, upto - 26); i <= upto; i++) {
      const [px, py] = pts[i];
      if (i === 0) cx2.moveTo(wx(px), wy(py)); else cx2.lineTo(wx(px), wy(py));
    }
    cx2.strokeStyle = "rgba(251,191,36,0.8)";
    cx2.lineWidth = 2.5;
    cx2.stroke();
    const [hx, hy] = pts[upto];
    cx2.beginPath();
    cx2.arc(wx(hx), wy(hy), 4, 0, 7);
    cx2.fillStyle = "#fff7d6";
    cx2.fill();
  }

  // particles + floaters
  for (const pt of S.particles) {
    cx2.globalAlpha = Math.max(0, pt.life / 40);
    cx2.fillStyle = pt.c;
    cx2.fillRect(wx(pt.x), wy(pt.y), 3, 3);
  }
  cx2.globalAlpha = 1;
  cx2.textAlign = "center";
  for (const fl of S.floaters) {
    cx2.globalAlpha = Math.max(0, fl.life / 60);
    cx2.font = `800 ${13 * Math.max(1, scale * 2.6)}px JBMono, monospace`;
    cx2.fillStyle = fl.c;
    cx2.fillText(fl.text, wx(fl.x), wy(fl.y));
  }
  cx2.globalAlpha = 1;
}

/* ---------------- animation loop ---------------- */

function boom(x, y) {
  SFX.boom();
  for (let i = 0; i < 46; i++) {
    const a = Math.random() * 6.28;
    const v = 30 + Math.random() * 120;
    S.particles.push({
      x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.8 + 40,
      life: 30 + Math.random() * 16,
      c: ["#fbbf24", "#fb7185", "#f59e0b", "#e8edf9"][i % 4],
    });
  }
}

function stepAnim() {
  const a = S.anim;
  if (a && !a.done) {
    a.i += 3;
    if (a.i >= a.points.length) {
      a.done = true;
      if (a.impact) {
        boom(a.impact[0], a.impact[1]);
        for (const d of a.damages || []) {
          const p = playerByPid(d.pid);
          const g = game();
          const tk = g && g.tanks.find((t) => t.pid === d.pid);
          if (tk) S.floaters.push({
            x: tk.x, y: tk.y + 40, text: "-" + d.dmg,
            c: d.fall ? "#fbbf24" : "#fb7185", life: 60,
          });
          if (d.pid === S.pid) SFX.hit();
        }
      }
      // release the deferred state once the bang has landed
      setTimeout(() => {
        S.anim = null;
        if (S.pendingState) {
          const st = S.pendingState;
          S.pendingState = null;
          applyState(st);
        }
      }, 650);
    }
  }
  for (const pt of S.particles) {
    pt.x += pt.vx * 0.033; pt.y += pt.vy * 0.033;
    pt.vy -= 140 * 0.033; pt.life--;
  }
  S.particles = S.particles.filter((p) => p.life > 0);
  for (const fl of S.floaters) { fl.y += 0.8; fl.life--; }
  S.floaters = S.floaters.filter((f) => f.life > 0);
  if (S.anim || S.particles.length || S.floaters.length) drawScene();
}

/* ---------------- battle chrome ---------------- */

function renderHpRow(st) {
  const g = game();
  const row = $("hp-bar-row");
  row.textContent = "";
  for (const tk of g.tanks) {
    const p = playerByPid(tk.pid);
    const chip = document.createElement("span");
    chip.className = "hp-chip"
      + (g.turn === tk.pid && g.stage === "battle" ? " turn" : "")
      + (tk.hp <= 0 ? " dead" : "");
    const av = document.createElement("span");
    Hub.fillAvatar(av, p);
    const track = document.createElement("span");
    track.className = "hp-track";
    const fill = document.createElement("span");
    fill.className = "hp-fill" + (tk.hp <= 30 ? " low" : tk.hp <= 60 ? " mid" : "");
    fill.style.display = "block";
    fill.style.width = Math.max(0, tk.hp) + "%";
    track.appendChild(fill);
    chip.append(av, track, document.createTextNode(tk.hp <= 0 ? "💀" : tk.hp));
    row.appendChild(chip);
  }
}

function renderBattle(st) {
  const g = game();
  const turnP = playerByPid(g.turn);
  Hub.fillAvatar($("tk-turn-av"), turnP);
  $("tk-turn-name").textContent = myTurn() ? "YOUR SHOT" : (turnP ? turnP.name : "—");
  const w = g.wind;
  $("tk-wind").textContent = "WIND " + (w === 0 ? "·0" : (w > 0 ? "→" : "←") + Math.abs(w));
  renderHpRow(st);

  const mine = myTurn();
  $("controls").hidden = !mine;
  // spectators and the dead watch; living combatants just wait their turn
  const iFight = g.tanks.some((t) => t.pid === S.pid && t.hp > 0);
  $("watch-note").hidden = mine || iFight;
  if (mine && g.fuel !== null) {
    $("fuel-fill").style.width = g.fuel + "%";
  }
  drawScene();
}

let goShown = false;
function renderGameOver(st) {
  const g = game();
  const showIt = st.phase === "game_end" && g && g.result;
  $("gameover").hidden = !showIt;
  if (!showIt) { goShown = false; return; }
  const wp = playerByPid(g.result.winner);
  $("go-title").textContent = wp ? `${wp.name.toUpperCase()} SURVIVES` : "MUTUAL DESTRUCTION";
  $("go-line").textContent =
    `${g.result.dealt} damage dealt · ${g.result.shots} shells fired`;
  const rows = $("go-rows");
  rows.textContent = "";
  const sorted = [...g.result.standings].sort((a, b) =>
    (b.hp > 0) - (a.hp > 0) || b.dealt - a.dealt);
  for (const r of sorted) {
    const p = playerByPid(r.pid);
    const div = document.createElement("div");
    div.className = "go-row" + (r.pid === g.result.winner ? " first" : "");
    const av = document.createElement("span");
    Hub.fillAvatar(av, p);
    const nm = document.createElement("span");
    nm.textContent = (p ? p.name : "?") + (r.hp <= 0 ? " 💀" : ` · ${r.hp}hp`);
    const b = document.createElement("b");
    b.textContent = r.dealt + " dmg";
    div.append(av, nm, b);
    rows.appendChild(div);
  }
  if (!goShown) {
    goShown = true;
    if (g.result.winner === S.pid) { Hub.confettiBurst(200); SFX.win(); }
    else SFX.boom();
  }
}

/* ---------------- state entry ---------------- */

function applyState(st) {
  S.st = st;
  if (!S.joined) return;
  if (st.phase === "lobby" || st.phase === "countdown") {
    show("scr-lobby");
    S.anim = null; S.particles = []; S.floaters = [];
    renderLobby(st);
  } else if (st.game) {
    show("scr-game");
    renderBattle(st);
  }
  renderGameOver(st);
  $("countdown-overlay").hidden = st.phase !== "countdown";
}

function onState(st) {
  if (S.anim && !S.anim.done) {
    S.pendingState = st;     // let the tracer finish first
    S.st = { ...S.st, players: st.players, deadline: st.deadline, now: st.now };
    return;
  }
  applyState(st);
}

function onFx(fx) {
  switch (fx.kind) {
    case "toast": Hub.toast((fx.icon ? fx.icon + " " : "") + fx.msg); break;
    case "invalid": Hub.toast(fx.msg, "err"); SFX.bad(); break;
    case "fired":
      SFX.launch();
      S.anim = { points: fx.points, i: 0, impact: fx.impact,
                 damages: fx.damages, done: fx.points.length === 0 };
      break;
    case "turn":
      if (fx.pid === S.pid) { SFX.turn(); try { navigator.vibrate && navigator.vibrate(70); } catch (e) {} }
      break;
    case "battle_start": SFX.turn(); break;
    case "countdown": SFX.turn(); break;
  }
}

/* ---------------- controls ---------------- */

function sendAim() {
  const a = +$("angle").value;
  $("angle-val").textContent = a + "°";
  $("power-val").textContent = $("power").value;
  localStorage.setItem("tk-angle", $("angle").value);
  localStorage.setItem("tk-power", $("power").value);
  if (myTurn()) S.conn.send({ t: "aim", angle: a });
  drawScene();
}
let aimT = null;
$("angle").addEventListener("input", () => {
  clearTimeout(aimT);
  aimT = setTimeout(sendAim, 120);
  $("angle-val").textContent = $("angle").value + "°";
});
$("power").addEventListener("input", () => {
  $("power-val").textContent = $("power").value;
  localStorage.setItem("tk-power", $("power").value);
});
$("angle").value = localStorage.getItem("tk-angle") || 60;
$("power").value = localStorage.getItem("tk-power") || 55;
$("angle-val").textContent = $("angle").value + "°";
$("power-val").textContent = $("power").value;

function holdMove(btn, dir) {
  let iv = null;
  const start = (e) => {
    e.preventDefault();
    if (!myTurn()) return;
    SFX.unlock();
    S.conn.send({ t: "move", dir });
    SFX.move();
    iv = setInterval(() => {
      if (!myTurn()) { stop(); return; }
      S.conn.send({ t: "move", dir });
      SFX.move();
    }, 110);
  };
  const stop = () => { if (iv) { clearInterval(iv); iv = null; } };
  btn.addEventListener("pointerdown", start);
  btn.addEventListener("pointerup", stop);
  btn.addEventListener("pointercancel", stop);
  btn.addEventListener("pointerleave", stop);
}
holdMove($("mv-left"), -1);
holdMove($("mv-right"), 1);

$("fire-btn").onclick = () => {
  if (!myTurn()) return;
  SFX.unlock();
  S.conn.send({ t: "fire", angle: +$("angle").value, power: +$("power").value });
};

/* brag */
if (window.Brag) {
  const btn = Brag.button(() => {
    const g = game();
    if (!g || !g.result || !g.result.winner) return null;
    const wp = playerByPid(g.result.winner);
    const losers = g.result.standings.filter((r) => r.pid !== g.result.winner);
    return {
      title: "Tanks", icon: "🪖",
      winner: { name: wp ? wp.name : "?", avatar: wp ? wp.avatar : "🪖",
                pfp: wp ? wp.pfp : null },
      headline: `last tank standing · ${g.result.dealt} dmg dealt`,
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
  stepAnim();
  const st = S.st;
  if (!st) return;
  if (st.phase === "countdown") {
    $("countdown-num").textContent = Math.max(1, Math.ceil(remainMs() / 1000));
  }
  const g = game();
  if (!g) return;
  if (g.stage === "battle") {
    const sec = Math.ceil(remainMs() / 1000);
    $("tk-clock").textContent = sec;
    $("tk-clock").classList.toggle("low", sec <= 10);
    if (sec !== lastTick && sec <= 5 && sec > 0 && myTurn()) { SFX.tick(); lastTick = sec; }
  }
  if (st.phase === "game_end") {
    $("go-auto").textContent = `lobby in ${Math.ceil(remainMs() / 1000)}s`;
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
  S.conn = Hub.connect("/games/tanks/ws", {
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
