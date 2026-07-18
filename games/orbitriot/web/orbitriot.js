/* ORBIT RIOT — private phone slings + shared cinematic TV replay. */
"use strict";

const $ = (id) => document.getElementById(id);
const IS_TV = location.pathname.endsWith("/tv.html")
  || new URLSearchParams(location.search).get("tv") === "1";
const WORLD = { w: 1200, h: 675 };

const S = {
  st: null, pid: null, conn: null, joined: false,
  aim: { angle: 180, power: .65 }, ability: "none", drag: null,
  heat: 0, replayKey: "", eventIndex: 0, phoneEventIndex: 0,
  gameoverShown: false, muted: localStorage.getItem("wc-muted") === "1",
  tv: { offset: 0, ws: null, retry: 0, particles: [], floaters: [], trails: {},
    shake: 0, lastFrameAt: 0, launchShown: "" },
};

const game = () => S.st?.game || null;
const playerByPid = (pid) => (S.st?.players || []).find((p) => p.pid === pid) || null;
const now = () => S.conn ? S.conn.now() : Date.now();
const remainMs = () => S.st?.deadline ? Math.max(0, S.st.deadline - now()) : 0;
const myRoster = () => game()?.roster?.find((r) => r.pid === S.pid) || null;

/* ---------- tiny synth: all audio is optional and locally generated ---------- */
const SFX = (() => {
  let ctx = null;
  const ac = () => {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  };
  const tone = (frequency, type, duration, volume = .08, delay = 0, glide = 0) => {
    if (S.muted) return;
    try {
      const c = ac(), at = c.currentTime + delay;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(frequency, at);
      if (glide) o.frequency.exponentialRampToValueAtTime(Math.max(35, frequency + glide), at + duration);
      g.gain.setValueAtTime(.0001, at); g.gain.exponentialRampToValueAtTime(volume, at + .014);
      g.gain.exponentialRampToValueAtTime(.0001, at + duration);
      o.connect(g); g.connect(c.destination); o.start(at); o.stop(at + duration + .03);
    } catch (error) { /* autoplay policy / no WebAudio */ }
  };
  return {
    unlock: () => { try { ac(); } catch (error) {} },
    tap: () => tone(720, "square", .045, .035),
    tick: () => tone(1100, "square", .03, .035),
    lock: () => { tone(410, "sine", .1, .08); tone(820, "sine", .13, .07, .07); },
    launch: () => { tone(90, "sawtooth", .8, .12, 0, 760); tone(220, "triangle", .5, .08, .08, 500); },
    crash: (power = .5) => tone(110 + power * 90, "square", .13, .05 + power * .07, 0, -70),
    bumper: () => { tone(320, "sine", .09, .06); tone(640, "sine", .08, .04, .04); },
    star: () => { tone(880, "sine", .1, .07); tone(1320, "sine", .12, .05, .07); },
    void: () => { tone(105, "sawtooth", .7, .15, 0, -60); tone(56, "sine", .8, .11); },
    shield: () => { tone(260, "sine", .4, .08, 0, 760); tone(1040, "sine", .2, .05, .1); },
    win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, "sine", .22, .09, i * .09)),
    bad: () => tone(145, "sawtooth", .16, .07),
  };
})();

function showPhone(id) {
  for (const sid of ["scr-join", "scr-lobby", "scr-aim", "scr-watch"])
    $(sid).hidden = sid !== id;
}

function showTV(id) {
  for (const sid of ["tv-lobby", "tv-arena", "tv-podium"])
    $(sid).hidden = sid !== id;
}

function fillAvatar(el, player) {
  if (window.Hub) Hub.fillAvatar(el, player);
  else { el.textContent = player?.avatar || "?"; }
}

function seg(hostId, options, current, key) {
  const host = $(hostId); host.textContent = "";
  for (const [value, label] of options) {
    const button = document.createElement("button");
    button.type = "button"; button.textContent = label;
    button.className = value === current ? "sel" : "";
    button.onclick = () => { SFX.tap(); S.conn.send({ t: "settings", patch: { [key]: value } }); };
    host.appendChild(button);
  }
}

/* ---------- lobby, shared data but phone-specific rendering ---------- */
function renderPhoneLobby(st) {
  const humans = st.players.filter((p) => !p.bot);
  const ready = humans.filter((p) => p.ready && p.connected).length;
  $("ready-count").textContent = `${ready}/${Math.max(2, humans.length)} READY`;
  const grid = $("player-grid"); grid.textContent = "";
  for (let i = 0; i < 8; i++) {
    const p = humans[i];
    const card = document.createElement("div");
    card.className = "pilot-card" + (p?.ready ? " ready" : "") + (!p ? " empty" : "");
    const av = document.createElement("span"); av.className = "pilot-av";
    if (p) fillAvatar(av, p); else av.textContent = "·";
    const meta = document.createElement("span"); meta.className = "pilot-meta";
    const name = document.createElement("b");
    name.textContent = p ? p.name + (p.pid === S.pid ? " · YOU" : "") : "OPEN ORBIT";
    const state = document.createElement("small");
    state.textContent = !p ? "waiting" : !p.connected ? "signal lost" : p.ready ? "trajectory ready" : "not ready";
    meta.append(name, state);
    const mark = document.createElement("span"); mark.className = "ready-mark"; mark.textContent = p?.ready ? "✓" : "";
    card.append(av, meta, mark); grid.appendChild(card);
  }
  $("seat-note").textContent = humans.length < 2
    ? "Two pilots minimum. Open the TV view, then send friends to this same address."
    : humans.length < 8 ? `${8 - humans.length} launch slot${8 - humans.length === 1 ? "" : "s"} still open.`
      : "Launch bay full — eight comets armed.";
  seg("opt-heats", [[3,"3"],[5,"5"],[7,"7"]], st.settings.heats, "heats");
  seg("opt-aim", [[15,"15s"],[20,"20s"],[30,"30s"]], st.settings.aim_seconds, "aim_seconds");
  const amReady = !!st.you?.ready;
  $("ready-btn").textContent = amReady ? "READY ✓" : "READY UP";
  $("ready-btn").classList.toggle("is-ready", amReady);
  $("go-btn").hidden = !(amReady && ready >= 2 && st.phase === "lobby");
  $("lobby-hint").textContent = st.phase === "countdown" ? "THE ORBIT IS FORMING…"
    : ready < 2 ? "need two ready pilots" : "ready to riot";
}

/* ---------- arena drawing shared by phone radar and TV ---------- */
function playerColor(pid) { return playerByPid(pid)?.color || "#4cf7ff"; }

function drawStarShape(ctx, x, y, radius, alpha = 1) {
  ctx.save(); ctx.translate(x, y); ctx.globalAlpha = alpha; ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? radius * .43 : radius;
    const px = Math.cos(a) * r, py = Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath(); ctx.fillStyle = "#ffd65a"; ctx.shadowColor = "#ffd65a";
  ctx.shadowBlur = radius * 1.1; ctx.fill(); ctx.restore();
}

function drawArenaBase(ctx, g, stamp, compact = false) {
  const w = ctx.canvas.width, h = ctx.canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, w, h);
  ctx.save(); ctx.scale(w / WORLD.w, h / WORLD.h);
  const bg = ctx.createRadialGradient(600, 338, 30, 600, 338, 720);
  bg.addColorStop(0, "#15103b"); bg.addColorStop(.42, "#0b1027"); bg.addColorStop(1, "#03050d");
  ctx.fillStyle = bg; ctx.fillRect(0, 0, WORLD.w, WORLD.h);
  // deterministic star field, no bitmap assets and no client game randomness
  for (let i = 0; i < (compact ? 55 : 120); i++) {
    const x = (i * 193 + 47) % WORLD.w, y = (i * 109 + 31) % WORLD.h;
    const pulse = .25 + .45 * (1 + Math.sin(stamp * .0014 + i * 1.7)) / 2;
    ctx.globalAlpha = pulse; ctx.fillStyle = i % 7 ? "#cad5ff" : "#4cf7ff";
    ctx.fillRect(x, y, i % 11 === 0 ? 2.2 : 1.1, i % 11 === 0 ? 2.2 : 1.1);
  }
  ctx.globalAlpha = 1;
  // playfield glass and luminous boundary
  const field = ctx.createLinearGradient(34, 34, 1166, 641);
  field.addColorStop(0, "rgba(76,247,255,.035)"); field.addColorStop(.5, "rgba(139,92,255,.03)");
  field.addColorStop(1, "rgba(255,61,187,.04)");
  ctx.fillStyle = field; ctx.beginPath(); ctx.roundRect(34, 34, 1132, 607, 42); ctx.fill();
  ctx.strokeStyle = "rgba(118,147,218,.24)"; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.roundRect(34, 34, 1132, 607, 42); ctx.stroke();
  ctx.strokeStyle = "rgba(76,247,255,.07)"; ctx.lineWidth = 1;
  for (let x = 90; x < 1160; x += 70) { ctx.beginPath(); ctx.moveTo(x, 38); ctx.lineTo(x, 637); ctx.stroke(); }
  for (let y = 80; y < 630; y += 70) { ctx.beginPath(); ctx.moveTo(38, y); ctx.lineTo(1162, y); ctx.stroke(); }

  const hole = g.hole;
  // safe scoring annulus
  ctx.setLineDash([12, 12]); ctx.lineDashOffset = -(stamp * .025 % 24);
  ctx.strokeStyle = "rgba(76,247,255,.38)"; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.arc(hole.x, hole.y, hole.safe_inner, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = "rgba(255,61,187,.25)";
  ctx.beginPath(); ctx.arc(hole.x, hole.y, hole.safe_outer, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(76,247,255,.65)"; ctx.font = "800 11px JBMono, monospace";
  ctx.textAlign = "center"; ctx.fillText("+2 SAFE ORBIT", hole.x, hole.y - hole.safe_outer - 12);

  // black hole and rotating accretion glow
  ctx.save(); ctx.translate(hole.x, hole.y); ctx.rotate(stamp * .00035);
  const acc = ctx.createRadialGradient(0, 0, 30, 0, 0, 95);
  acc.addColorStop(0, "rgba(0,0,0,0)"); acc.addColorStop(.42, "rgba(0,0,0,.15)");
  acc.addColorStop(.62, "rgba(255,61,187,.8)"); acc.addColorStop(.72, "rgba(76,247,255,.45)");
  acc.addColorStop(1, "rgba(139,92,255,0)");
  ctx.scale(1, .35); ctx.fillStyle = acc; ctx.beginPath(); ctx.arc(0, 0, 98, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  const voidGrad = ctx.createRadialGradient(hole.x - 12, hole.y - 14, 2, hole.x, hole.y, hole.r + 16);
  voidGrad.addColorStop(0, "#11142a"); voidGrad.addColorStop(.32, "#020208");
  voidGrad.addColorStop(.72, "#000"); voidGrad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = voidGrad; ctx.shadowColor = "#8b5cff"; ctx.shadowBlur = 32;
  ctx.beginPath(); ctx.arc(hole.x, hole.y, hole.r + 12, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;

  for (const [index, b] of g.bumpers.entries()) {
    const grad = ctx.createRadialGradient(b.x - 10, b.y - 12, 4, b.x, b.y, b.r);
    grad.addColorStop(0, "#fff"); grad.addColorStop(.13, index % 2 ? "#ff9ee2" : "#9affff");
    grad.addColorStop(.52, index % 2 ? "#ac35d7" : "#287ea5"); grad.addColorStop(1, "#171b3c");
    ctx.fillStyle = grad; ctx.shadowColor = index % 2 ? "#ff3dbb" : "#4cf7ff"; ctx.shadowBlur = 24;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0; ctx.strokeStyle = "rgba(255,255,255,.32)"; ctx.lineWidth = 2; ctx.stroke();
  }
  ctx.restore();
}

function drawPuck(ctx, x, y, pid, options = {}) {
  const scaleX = ctx.canvas.width / WORLD.w, scaleY = ctx.canvas.height / WORLD.h;
  ctx.save(); ctx.scale(scaleX, scaleY);
  const p = playerByPid(pid), color = p?.color || "#4cf7ff";
  const radius = options.radius || 23;
  ctx.globalAlpha = options.alpha ?? 1;
  ctx.shadowColor = color; ctx.shadowBlur = options.glow || 22;
  const grad = ctx.createRadialGradient(x - radius * .35, y - radius * .38, 2, x, y, radius);
  grad.addColorStop(0, "#fff"); grad.addColorStop(.14, color); grad.addColorStop(.62, color + "bb"); grad.addColorStop(1, "#080a18");
  ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0; ctx.strokeStyle = options.mine ? "#fff" : color; ctx.lineWidth = options.mine ? 4 : 2; ctx.stroke();
  ctx.font = `${Math.round(radius * .9)}px serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(p?.avatar || "●", x, y + 1);
  if (options.label) {
    ctx.fillStyle = "rgba(5,7,17,.82)"; ctx.beginPath(); ctx.roundRect(x - 48, y + radius + 7, 96, 22, 11); ctx.fill();
    ctx.fillStyle = "#eef1ff"; ctx.font = "750 11px Sora, sans-serif";
    ctx.fillText((p?.name || "?").slice(0, 12), x, y + radius + 18);
  }
  if (options.ability && options.ability !== "none") {
    const icon = { boost: "⚡", anchor: "⚓", shield: "◉" }[options.ability];
    ctx.fillStyle = "#090b18"; ctx.beginPath(); ctx.arc(x + radius * .75, y - radius * .75, 11, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = options.ability === "shield" ? "#4cf7ff" : "#fff";
    ctx.font = "12px sans-serif"; ctx.fillText(icon, x + radius * .75, y - radius * .75);
  }
  ctx.restore();
}

function drawPhoneRadar() {
  const g = game(), canvas = $("phone-radar"); if (!g || !canvas) return;
  const ctx = canvas.getContext("2d"); drawArenaBase(ctx, g, performance.now(), true);
  ctx.save(); ctx.scale(canvas.width / WORLD.w, canvas.height / WORLD.h);
  for (const star of g.stars) drawStarShape(ctx, star.x, star.y, 11);
  const mine = g.pucks.find((p) => p.pid === S.pid);
  if (mine && !g.my_locked) {
    const a = S.aim.angle * Math.PI / 180, len = 82 + S.aim.power * 105;
    ctx.strokeStyle = playerColor(S.pid); ctx.lineWidth = 5; ctx.setLineDash([10,7]);
    ctx.beginPath(); ctx.moveTo(mine.x, mine.y); ctx.lineTo(mine.x + Math.cos(a) * len, mine.y + Math.sin(a) * len); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = playerColor(S.pid); ctx.beginPath();
    const ex = mine.x + Math.cos(a) * len, ey = mine.y + Math.sin(a) * len;
    ctx.arc(ex, ey, 8, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
  for (const puck of g.pucks) drawPuck(ctx, puck.x, puck.y, puck.pid,
    { radius: puck.pid === S.pid ? 27 : 20, mine: puck.pid === S.pid });
}

/* ---------- gravity sling controller ---------- */
const slingCanvas = $("sling-canvas");
const slingCtx = slingCanvas?.getContext("2d");

function drawSling() {
  if (!slingCtx) return;
  const ctx = slingCtx, w = ctx.canvas.width, c = w / 2;
  ctx.clearRect(0, 0, w, w);
  const bg = ctx.createRadialGradient(c, c, 20, c, c, c);
  bg.addColorStop(0, "rgba(29,37,73,.92)"); bg.addColorStop(.62, "rgba(13,18,42,.95)"); bg.addColorStop(1, "rgba(5,8,19,.98)");
  ctx.fillStyle = bg; ctx.beginPath(); ctx.arc(c, c, c - 5, 0, Math.PI * 2); ctx.fill();
  for (let i = 1; i <= 4; i++) {
    ctx.strokeStyle = `rgba(113,132,190,${.17 - i * .02})`; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(c, c, i * 52, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.strokeStyle = "rgba(76,247,255,.2)"; ctx.beginPath(); ctx.moveTo(34,c); ctx.lineTo(w-34,c);
  ctx.moveTo(c,34); ctx.lineTo(c,w-34); ctx.stroke();
  const a = S.aim.angle * Math.PI / 180, len = 55 + S.aim.power * 174;
  const x = c + Math.cos(a) * len, y = c + Math.sin(a) * len;
  const glow = ctx.createLinearGradient(c, c, x, y); glow.addColorStop(0, "#8b5cff"); glow.addColorStop(1, "#4cf7ff");
  ctx.strokeStyle = glow; ctx.lineWidth = 14; ctx.lineCap = "round"; ctx.shadowColor = "#4cf7ff"; ctx.shadowBlur = 22;
  ctx.beginPath(); ctx.moveTo(c, c); ctx.lineTo(x, y); ctx.stroke(); ctx.shadowBlur = 0;
  // arrowhead
  ctx.save(); ctx.translate(x, y); ctx.rotate(a); ctx.fillStyle = "#dfffff"; ctx.beginPath();
  ctx.moveTo(18, 0); ctx.lineTo(-8, -13); ctx.lineTo(-5, 0); ctx.lineTo(-8, 13); ctx.closePath(); ctx.fill(); ctx.restore();
  const color = playerColor(S.pid);
  const orb = ctx.createRadialGradient(c - 12, c - 14, 2, c, c, 43);
  orb.addColorStop(0, "#fff"); orb.addColorStop(.14, color); orb.addColorStop(.65, color + "bb"); orb.addColorStop(1, "#090b1d");
  ctx.fillStyle = orb; ctx.shadowColor = color; ctx.shadowBlur = 30; ctx.beginPath(); ctx.arc(c, c, 43, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
  const p = playerByPid(S.pid); ctx.font = "35px serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(p?.avatar || "●", c, c + 2);
  $("aim-angle").textContent = `${Math.round(S.aim.angle)}°`;
  $("aim-power").textContent = `${Math.round(S.aim.power * 100)}%`;
  drawPhoneRadar();
}

function setAimFromPointer(event) {
  const rect = slingCanvas.getBoundingClientRect();
  const dx = (event.clientX - (rect.left + rect.width / 2));
  const dy = (event.clientY - (rect.top + rect.height / 2));
  const dist = Math.hypot(dx, dy), max = rect.width * .4;
  if (dist > 6) S.aim.angle = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
  S.aim.power = Math.max(.25, Math.min(1, dist / max));
  drawSling();
}

if (slingCanvas) {
  slingCanvas.addEventListener("pointerdown", (event) => {
    if (game()?.my_locked) return;
    event.preventDefault(); SFX.unlock(); slingCanvas.setPointerCapture(event.pointerId);
    S.drag = event.pointerId; setAimFromPointer(event);
  });
  slingCanvas.addEventListener("pointermove", (event) => {
    if (S.drag !== event.pointerId) return; event.preventDefault(); setAimFromPointer(event);
  });
  const release = (event) => { if (S.drag === event.pointerId) { event.preventDefault(); S.drag = null; drawSling(); } };
  slingCanvas.addEventListener("pointerup", release); slingCanvas.addEventListener("pointercancel", release);
}

function pickAbility(ability) {
  if (game()?.my_locked) return;
  const remaining = game()?.my_abilities?.[ability] || 0;
  if (!remaining) return;
  S.ability = S.ability === ability ? "none" : ability; SFX.tap(); renderAbilities(); drawSling();
}

function renderAbilities() {
  const abilities = game()?.my_abilities || {};
  for (const button of document.querySelectorAll("#ability-row button")) {
    const ability = button.dataset.ability, count = abilities[ability] || 0;
    button.classList.toggle("sel", S.ability === ability);
    button.disabled = count <= 0 || game()?.my_locked;
    button.querySelector("i").textContent = `×${count}`;
  }
}
document.querySelectorAll("#ability-row button").forEach((b) => b.onclick = () => pickAbility(b.dataset.ability));

function defaultAim(g) {
  const mine = g.pucks.find((p) => p.pid === S.pid); if (!mine) return;
  const target = [...g.stars].sort((a,b) => Math.hypot(a.x-mine.x,a.y-mine.y)-Math.hypot(b.x-mine.x,b.y-mine.y))[0]
    || g.hole;
  S.aim.angle = (Math.atan2(target.y - mine.y, target.x - mine.x) * 180 / Math.PI + 360) % 360;
  S.aim.power = .66; S.ability = "none";
}

function renderAim(st) {
  const g = st.game, roster = myRoster();
  if (S.heat !== g.heat) { S.heat = g.heat; defaultAim(g); S.phoneEventIndex = 0; }
  $("heat-chip").textContent = `HEAT ${g.heat}/${g.heats}`;
  $("my-score").textContent = roster?.score || 0;
  $("aim-title").textContent = g.my_locked ? "TRAJECTORY LOCKED" : "DRAG TO AIM";
  $("aim-kicker").textContent = g.my_locked ? "WAITING FOR THE CREW" : "TRAJECTORY OPEN";
  $("aim-copy").textContent = g.my_locked
    ? `${g.roster.filter((r) => r.locked).length}/${g.roster.length} pilots locked. Keep your aim secret.`
    : "Point the comet where you want it to fly. The farther you drag, the harder it launches.";
  $("lock-btn").disabled = g.my_locked;
  $("lock-btn").textContent = g.my_locked ? "LOCKED ✓" : "LOCK TRAJECTORY";
  $("lock-note").textContent = g.my_locked ? "Look up — launch begins when everybody locks." : "You cannot change it after locking.";
  renderAbilities(); drawSling();
}

function eventOwner(event) { return event.what === "knockout" ? event.by : event.token; }
function eventText(event) {
  const who = playerByPid(event.token)?.name || "A comet";
  const by = playerByPid(event.by)?.name;
  if (event.what === "star") return `⭐ ${who.toUpperCase()} GRABBED +1`;
  if (event.what === "orbit") return `◎ ${who.toUpperCase()} BANKED SAFE ORBIT +2`;
  if (event.what === "knockout") return event.by
    ? `🌀 ${by.toUpperCase()} VOIDED ${who.toUpperCase()} +3`
    : `🌀 THE VOID CLAIMED ${who.toUpperCase()}`;
  if (event.what === "shield") return `◉ ${who.toUpperCase()}'S SHIELD HELD`;
  if (event.what === "bumper") return `✦ ${who.toUpperCase()} HIT THE BUMPER`;
  if (event.what === "crash") return `💥 ${playerByPid(event.a)?.name || "COMET"} × ${playerByPid(event.b)?.name || "COMET"}`.toUpperCase();
  return "GRAVITY IS LIVE";
}

function replayElapsed(g) {
  return g?.replay ? Math.max(0, Math.min(g.replay.duration_ms, now() - g.replay.started_ms)) : 0;
}

function progressiveScore(roster, g, elapsed) {
  let score = roster.score - roster.delta;
  if (!g.replay) return roster.score;
  for (const event of g.replay.events) {
    if (event.t > elapsed || !event.points) continue;
    if (eventOwner(event) === roster.pid) score += event.points;
  }
  return score;
}

function renderPhoneScoreboard(g, elapsed) {
  const host = $("phone-scoreboard"); host.textContent = "";
  const rows = [...g.roster].sort((a,b) => progressiveScore(b,g,elapsed)-progressiveScore(a,g,elapsed));
  for (const r of rows) {
    const p = playerByPid(r.pid), row = document.createElement("div");
    row.className = "phone-score-row" + (r.pid === S.pid ? " me" : "");
    const av = document.createElement("span"); av.className = "av"; fillAvatar(av,p);
    const name = document.createElement("span"); name.textContent = p?.name || "?";
    const score = document.createElement("b"); score.textContent = progressiveScore(r,g,elapsed);
    row.append(av,name,score); host.appendChild(row);
  }
}

function renderPhoneWatch(st) {
  const g = st.game, r = myRoster();
  $("watch-heat").textContent = `HEAT ${g.heat}/${g.heats}`;
  const elapsed = replayElapsed(g);
  $("watch-score").textContent = r ? progressiveScore(r,g,elapsed) : 0;
  renderPhoneScoreboard(g,elapsed);
  if (!g.replay) {
    $("phone-event").textContent = `${g.roster.filter((x) => x.locked).length}/${g.roster.length} TRAJECTORIES LOCKED`;
  }
}

/* ---------- phone final result ---------- */
function renderGameOver(st) {
  const g = st.game, shown = st.phase === "game_end" && g?.result;
  $("gameover").hidden = !shown;
  if (!shown) { S.gameoverShown = false; return; }
  const winners = g.result.filter((r) => r.rank === 1);
  const winnerNames = winners.map((r) => playerByPid(r.pid)?.name || "?");
  $("go-title").textContent = winners.some((r) => r.pid === S.pid) ? "YOU RULE THE ORBIT" : `${winnerNames.join(" + ").toUpperCase()} WINS`;
  $("go-line").textContent = `${g.heats} heats · ${winners[0]?.score || 0} points on top`;
  const host = $("go-rows"); host.textContent = "";
  for (const result of g.result) {
    const p = playerByPid(result.pid), row = document.createElement("div");
    row.className = "go-row" + (result.rank === 1 ? " winner" : "");
    const av = document.createElement("span"); av.className = "av"; fillAvatar(av,p);
    const name = document.createElement("span"); name.textContent = `${result.rank}. ${p?.name || "?"}`;
    const score = document.createElement("b"); score.textContent = `${result.score} PTS`;
    row.append(av,name,score); host.appendChild(row);
  }
  if (!S.gameoverShown) {
    S.gameoverShown = true;
    if (winners.some((r) => r.pid === S.pid)) { Hub.confettiBurst(240); SFX.win(); }
  }
}

if (window.Brag) {
  const button = Brag.button(() => {
    const g = game(); if (!g?.result) return null;
    const winnerResult = g.result.find((r) => r.rank === 1 && r.pid === S.pid);
    if (!winnerResult) return null;
    const winner = playerByPid(S.pid);
    return { title: "Orbit Riot", icon: "🪐",
      winner: { name: winner?.name || "?", avatar: winner?.avatar || "🪐", pfp: winner?.pfp || null },
      headline: `${winnerResult.score} points · gravity champion`,
      beaten: g.result.filter((r) => r.pid !== S.pid).slice(0,5).map((r) =>
        ({ name: playerByPid(r.pid)?.name || "?", score: r.score })) };
  });
  document.querySelector("#gameover .modal-card").insertBefore(button, $("rematch-btn"));
}

function applyPhoneState(st) {
  S.st = st; if (!S.joined) return;
  if (st.phase === "lobby" || st.phase === "countdown") {
    showPhone("scr-lobby"); renderPhoneLobby(st);
  } else if (st.game?.stage === "aiming" && !st.game.my_locked) {
    showPhone("scr-aim"); renderAim(st);
  } else if (st.game) {
    showPhone("scr-watch"); renderPhoneWatch(st);
  }
  renderGameOver(st);
  $("countdown-overlay").hidden = st.phase !== "countdown";
}

function onPhoneFx(fx) {
  if (fx.kind === "toast") Hub.toast((fx.icon ? `${fx.icon} ` : "") + fx.msg);
  if (fx.kind === "invalid") { Hub.toast(fx.msg, "err"); SFX.bad(); }
  if (fx.kind === "locked" && fx.pid === S.pid) SFX.lock();
  if (fx.kind === "launch") { SFX.launch(); try { navigator.vibrate?.([60,35,90]); } catch (e) {} }
}

/* ---------- TV spectator connection and lobby ---------- */
function connectTV() {
  S.conn = Hub.connect("/games/orbitriot/ws", {
    onState: (st) => { S.st = st; renderTVState(st); },
    onFx: (fx) => { if (fx.kind === "launch") showLaunchFlash(`${fx.heat}-${Date.now()}`); },
  }, { watch: true });
}

let qrDrawn = false;
function renderTVLobby(st) {
  if (!qrDrawn) {
    qrDrawn = true;
    const url = location.pathname.endsWith("/tv.html")
      ? new URL(".", location.href) : new URL(location.href);
    url.searchParams.delete("tv");
    $("tv-url").textContent = `${location.host}${url.pathname}`;
    try { renderQR($("tv-qr"), url.toString()); } catch (error) { console.error("QR failed", error); }
  }
  const host = $("tv-pilots"); host.textContent = "";
  for (const p of st.players.filter((x) => !x.bot)) {
    const card = document.createElement("div"); card.className = "tv-pilot" + (p.ready ? " ready" : "");
    const av = document.createElement("span"); av.className = "av"; fillAvatar(av,p);
    const name = document.createElement("b"); name.textContent = p.name;
    const state = document.createElement("small"); state.textContent = p.ready ? "READY ✓" : p.connected ? "AIMING SOON" : "SIGNAL LOST";
    card.append(av,name,state); host.appendChild(card);
  }
  const ready = st.players.filter((p) => !p.bot && p.ready && p.connected).length;
  $("tv-hint").textContent = st.phase === "countdown" ? "GRAVITY WELL FORMING…"
    : ready >= 2 ? `${ready} PILOTS READY · HIT LAUNCH GAME ON ANY PHONE`
      : "SCAN TO JOIN · READY UP ON YOUR PHONE";
}

function renderTVLeaderboard(g, elapsed = 0) {
  const host = $("tv-leaderboard"); host.textContent = "";
  const sorted = [...g.roster].sort((a,b) => progressiveScore(b,g,elapsed)-progressiveScore(a,g,elapsed));
  const high = sorted.length ? progressiveScore(sorted[0],g,elapsed) : 0;
  for (const r of sorted) {
    const p = playerByPid(r.pid), scoreNow = progressiveScore(r,g,elapsed);
    const row = document.createElement("div");
    row.className = "tv-score-row" + (scoreNow === high && high > 0 ? " lead" : "") + (r.locked ? " locked" : "");
    const av = document.createElement("span"); av.className = "av"; fillAvatar(av,p);
    const name = document.createElement("span"); name.textContent = p?.name || "?";
    const score = document.createElement("b"); score.textContent = scoreNow;
    const base = r.score - r.delta;
    if (scoreNow > base) { const plus = document.createElement("i"); plus.textContent = `+${scoreNow-base}`; score.appendChild(plus); }
    row.append(av,name,score); host.appendChild(row);
  }
}

function showLaunchFlash(key) {
  if (S.tv.launchShown === key) return;
  S.tv.launchShown = key; const flash = $("tv-launch-flash"); flash.hidden = false;
  SFX.launch(); setTimeout(() => { flash.hidden = true; }, 1250);
}

function renderTVState(st) {
  if (st.phase === "lobby" || st.phase === "countdown") {
    showTV("tv-lobby"); renderTVLobby(st); S.replayKey = ""; return;
  }
  if (st.phase === "game_end" && st.game?.result) {
    showTV("tv-podium"); renderTVPodium(st); return;
  }
  if (st.game) {
    showTV("tv-arena");
    const g = st.game;
    $("tv-phase").textContent = g.stage === "aiming" ? `HEAT ${g.heat}/${g.heats} · AIM IN SECRET`
      : `HEAT ${g.heat}/${g.heats} · GRAVITY LIVE`;
    if (g.stage === "aiming") {
      renderTVLeaderboard(g,0);
      $("tv-callout").textContent = `${g.roster.filter((r) => r.locked).length}/${g.roster.length} TRAJECTORIES LOCKED`;
    }
    if (g.replay) {
      const key = `${g.heat}-${g.replay.started_ms}`;
      if (S.replayKey !== key) {
        S.replayKey = key; S.eventIndex = 0; S.tv.trails = {}; S.tv.particles = []; S.tv.floaters = [];
        showLaunchFlash(key);
      }
    }
  }
}

/* ---------- TV replay interpolation + particles ---------- */
function replayFrame(replay, elapsed) {
  const frames = replay.frames; if (!frames?.length) return null;
  const simTime = Math.min(replay.sim_ms, elapsed);
  let hi = frames.findIndex((f) => f.t >= simTime);
  if (hi < 0) hi = frames.length - 1;
  const lo = Math.max(0, hi - 1), a = frames[lo], b = frames[hi];
  const mix = b.t === a.t ? 0 : Math.max(0, Math.min(1, (simTime - a.t) / (b.t - a.t)));
  return {
    stars: mix < .5 ? a.s : b.s,
    positions: a.p.map((p,i) => [p[0] + (b.p[i][0]-p[0])*mix,
      p[1] + (b.p[i][1]-p[1])*mix, mix < .6 ? p[2] : b.p[i][2]]),
  };
}

function addParticles(event, color, count, speed) {
  for (let i = 0; i < count; i++) {
    const angle = i * 2.399963 + event.t * .001, mag = speed * (.35 + (i * 37 % 100) / 100);
    S.tv.particles.push({ x: event.x, y: event.y, vx: Math.cos(angle)*mag,
      vy: Math.sin(angle)*mag, life: .45 + (i % 7) * .045, max: .72, color, size: 2 + i % 5 });
  }
}

function triggerTVEvent(event) {
  const color = event.token ? playerColor(event.token) : event.a ? playerColor(event.a) : "#ff3dbb";
  if (event.what === "star") { SFX.star(); addParticles(event,"#ffd65a",28,170); }
  else if (event.what === "crash") { SFX.crash(event.power); addParticles(event,color,26,210); S.tv.shake = Math.max(S.tv.shake,4+event.power*8); }
  else if (event.what === "bumper") { SFX.bumper(); addParticles(event,"#4cf7ff",18,160); }
  else if (event.what === "shield") { SFX.shield(); addParticles(event,"#4cf7ff",42,230); S.tv.shake = 5; }
  else if (event.what === "knockout") { SFX.void(); addParticles(event,"#ff3dbb",70,300); S.tv.shake = 16; }
  else if (event.what === "orbit") addParticles(event,"#4cf7ff",22,120);
  if (event.points) {
    const owner = eventOwner(event), p = playerByPid(owner);
    S.tv.floaters.push({ x:event.x, y:event.y-20, text:`${p?.name || "COMET"} +${event.points}`,
      color: playerColor(owner), life: 1.35 });
  }
  const callout = $("tv-callout"); callout.textContent = eventText(event);
  callout.classList.remove("pop"); void callout.offsetWidth; callout.classList.add("pop");
}

function updateTVEffects(dt) {
  for (const p of S.tv.particles) { p.x += p.vx*dt; p.y += p.vy*dt; p.vx *= .975; p.vy *= .975; p.life -= dt; }
  S.tv.particles = S.tv.particles.filter((p) => p.life > 0);
  for (const f of S.tv.floaters) { f.y -= 25*dt; f.life -= dt; }
  S.tv.floaters = S.tv.floaters.filter((f) => f.life > 0);
  S.tv.shake *= Math.pow(.015, dt);
}

function drawTVCanvas(stamp) {
  const g = game(), canvas = $("tv-canvas"); if (!g || !canvas || $("tv-arena").hidden) return;
  const ctx = canvas.getContext("2d"), elapsed = replayElapsed(g);
  const frame = g.replay ? replayFrame(g.replay,elapsed) : null;
  drawArenaBase(ctx,g,stamp,false);
  ctx.save();
  const sx = S.tv.shake ? Math.sin(stamp*.09)*S.tv.shake : 0, sy = S.tv.shake ? Math.cos(stamp*.11)*S.tv.shake*.6 : 0;
  ctx.translate(sx,sy); ctx.scale(canvas.width/WORLD.w,canvas.height/WORLD.h);
  const starMask = frame ? frame.stars : (1 << g.stars.length) - 1;
  for (const star of g.stars) if (starMask & (1 << star.id))
    drawStarShape(ctx,star.x,star.y,15, .78 + .22*Math.sin(stamp*.006+star.id));
  // comet trails are local visual history; physics positions remain server frames
  if (frame) {
    frame.positions.forEach((pos,i) => {
      const pid = g.replay.order[i];
      if (!S.tv.trails[pid]) S.tv.trails[pid] = [];
      const trail = S.tv.trails[pid];
      if (pos[2]) trail.push([pos[0],pos[1]]);
      if (trail.length > 28) trail.shift();
      if (trail.length > 1) {
        ctx.lineCap = "round"; ctx.lineJoin = "round";
        for (let j=1;j<trail.length;j++) {
          ctx.globalAlpha = j/trail.length*.35; ctx.strokeStyle = playerColor(pid); ctx.lineWidth = 2+j/trail.length*7;
          ctx.beginPath(); ctx.moveTo(trail[j-1][0],trail[j-1][1]); ctx.lineTo(trail[j][0],trail[j][1]); ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
    });
  }
  for (const p of S.tv.particles) {
    ctx.globalAlpha = Math.max(0,p.life/p.max); ctx.fillStyle = p.color; ctx.shadowColor = p.color; ctx.shadowBlur = 10;
    ctx.fillRect(p.x-p.size/2,p.y-p.size/2,p.size,p.size); ctx.shadowBlur = 0;
  }
  for (const f of S.tv.floaters) {
    ctx.globalAlpha = Math.min(1,f.life*1.5); ctx.fillStyle = f.color; ctx.textAlign="center"; ctx.textBaseline="middle";
    ctx.font="900 22px JBMono, monospace"; ctx.shadowColor="#050711";ctx.shadowBlur=8;ctx.fillText(f.text.toUpperCase(),f.x,f.y);ctx.shadowBlur=0;
  }
  ctx.globalAlpha = 1; ctx.restore();
  const shots = Object.fromEntries((g.replay?.shots || []).map((s) => [s.pid,s.ability]));
  if (frame) frame.positions.forEach((pos,i) => {
    const pid = g.replay.order[i]; drawPuck(ctx,pos[0],pos[1],pid,{label:true,ability:shots[pid],alpha:pos[2]?1:.08,glow:30});
  });
  else for (const puck of g.pucks) drawPuck(ctx,puck.x,puck.y,puck.pid,{label:true,glow:g.roster.find((r)=>r.pid===puck.pid)?.locked?28:14});
}

function renderTVPodium(st) {
  const g = st.game, host = $("tv-podium-blocks");
  const key = g.result.map((r)=>`${r.pid}:${r.score}`).join("|");
  if (host.dataset.key === key) return; host.dataset.key = key; host.textContent = "";
  for (const result of g.result.slice(0,3)) {
    const p = playerByPid(result.pid), col = document.createElement("div");
    col.className = `pod-col rank-${Math.min(3,result.rank)}`;
    if (result.rank === 1) { const crown=document.createElement("div");crown.className="pod-crown";crown.textContent="👑";col.appendChild(crown); }
    const av=document.createElement("div");av.className="pod-av";fillAvatar(av,p);
    const name=document.createElement("div");name.className="pod-name";name.textContent=p?.name||"?";
    const score=document.createElement("div");score.className="pod-score";score.textContent=`${result.score} PTS`;
    const block=document.createElement("div");block.className="pod-block";block.textContent=result.rank;
    col.append(av,name,score,block);host.appendChild(col);
  }
  Hub.confettiBurst?.(280); SFX.win();
}

/* ---------- animation clocks ---------- */
let lastPhoneTick = -1;
function animationFrame(stamp) {
  requestAnimationFrame(animationFrame);
  if (!S.st) return;
  if (IS_TV) {
    const dt = S.tv.lastFrameAt ? Math.min(.05,(stamp-S.tv.lastFrameAt)/1000) : 0;
    S.tv.lastFrameAt = stamp; updateTVEffects(dt);
    const g=game();
    if (g?.stage === "aiming") {
      const seconds=Math.ceil(remainMs()/1000);$("tv-clock").textContent=seconds;$("tv-clock").classList.toggle("low",seconds<=5);
    } else if (g?.replay) {
      const elapsed=replayElapsed(g);$("tv-clock").textContent=Math.max(0,Math.ceil((g.replay.duration_ms-elapsed)/1000));
      $("tv-clock").classList.remove("low");renderTVLeaderboard(g,elapsed);
      while (S.eventIndex < g.replay.events.length && g.replay.events[S.eventIndex].t <= elapsed) triggerTVEvent(g.replay.events[S.eventIndex++]);
    }
    if (S.st.phase === "game_end") $("tv-podium-auto").textContent=`RETURNING TO LOBBY IN ${Math.ceil(remainMs()/1000)}S`;
    drawTVCanvas(stamp); return;
  }
  if (S.st.phase === "countdown") $("countdown-num").textContent=Math.max(1,Math.ceil(remainMs()/1000));
  const g=game();
  if (g?.stage === "aiming") {
    const seconds=Math.ceil(remainMs()/1000);$("aim-clock").textContent=seconds;$("aim-clock").classList.toggle("low",seconds<=5);
    if (seconds<=5 && seconds>0 && seconds!==lastPhoneTick) { lastPhoneTick=seconds; SFX.tick(); }
  }
  if (g?.replay && !$("scr-watch").hidden) {
    const elapsed=replayElapsed(g), r=myRoster();
    if (r) $("watch-score").textContent=progressiveScore(r,g,elapsed);
    renderPhoneScoreboard(g,elapsed);
    while (S.phoneEventIndex<g.replay.events.length && g.replay.events[S.phoneEventIndex].t<=elapsed) {
      const event=g.replay.events[S.phoneEventIndex++], el=$("phone-event");el.textContent=eventText(event);
      el.classList.remove("pop");void el.offsetWidth;el.classList.add("pop");
    }
  }
  if (S.st.phase === "game_end") $("go-auto").textContent=`lobby in ${Math.ceil(remainMs()/1000)}s`;
}
requestAnimationFrame(animationFrame);

/* ---------- phone boot ---------- */
function connectPhone() {
  S.conn = Hub.connect("/games/orbitriot/ws", {
    onWelcome: (msg) => { S.pid = msg.pid; }, onState: applyPhoneState, onFx: onPhoneFx,
  });
}

function bootPhone() {
  $("phone-app").hidden = false;
  let avatarPick = Hub.identity.avatar || Hub.AVATARS[(Math.random()*Hub.AVATARS.length)|0];
  Hub.buildAvatarGrid($("avatar-grid"),avatarPick,(avatar)=>{avatarPick=avatar;});
  Hub.wirePfpButton($("pfp-btn"),()=>S.conn);Hub.wirePfpButton($("pfp-btn2"),()=>S.conn);
  $("name-input").value=Hub.identity.name;
  $("join-btn").onclick=()=>{SFX.unlock();Hub.identity.name=$("name-input").value.trim()||"PLAYER";
    Hub.identity.avatar=avatarPick;S.joined=true;connectPhone();showPhone("scr-lobby");};
  $("name-input").addEventListener("keydown",(e)=>{if(e.key==="Enter")$("join-btn").click();});
  $("ready-btn").onclick=()=>{SFX.unlock();SFX.tap();S.conn.send({t:"ready",ready:!S.st?.you?.ready});};
  $("go-btn").onclick=()=>{SFX.unlock();S.conn.send({t:"start"});};
  $("lock-btn").onclick=()=>{if(game()?.my_locked)return;SFX.unlock();S.conn.send({t:"lock",angle:S.aim.angle,power:S.aim.power,ability:S.ability});
    try{navigator.vibrate?.(70);}catch(e){}};
  $("rematch-btn").onclick=()=>S.conn.send({t:"again"});
  if(Hub.identity.name){S.joined=true;connectPhone();showPhone("scr-lobby");}else showPhone("scr-join");
}

function bootTV() {
  document.body.classList.add("tv-mode");$("tv-app").hidden=false;connectTV();
}

if (IS_TV) bootTV(); else bootPhone();

/* Browser-test hook: every action uses the real public message path. */
window.ORBIT_RIOT_DEV = {
  state:()=>S.st,isTV:()=>IS_TV,
  lock:(angle=180,power=.7,ability="none")=>S.conn?.send({t:"lock",angle,power,ability}),
  aim:(angle,power)=>{S.aim={angle,power};drawSling();},
  elapsed:()=>replayElapsed(game()),
};
