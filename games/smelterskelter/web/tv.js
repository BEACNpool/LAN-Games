/* SMELTER SKELTER TV — interpolated industrial pendulum spectacle. */
"use strict";

const $ = (id) => document.getElementById(id);
const cv = $("arena"), ctx = cv.getContext("2d");
const S = {
  st: null, conn: null, at: 0, prev: new Map(), prevCargo: null,
  particles: [], floaters: [], trails: new Map(), shake: 0,
  lastStage: "", lastShift: 0, resultShown: false, audio: false, wake: null,
};
const game = () => S.st?.game || null;
const player = (pid) => S.st?.players?.find((p) => p.pid === pid) || null;
const unitByPid = (pid) => game()?.units?.find((u) => u[0] === pid) || null;
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const lerp = (a, b, f) => a + (b - a) * f;

const Sound = (() => {
  let ac = null;
  const audio = () => {
    if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === "suspended") ac.resume();
    return ac;
  };
  const tone = (f, type, dur, vol = .08, delay = 0, glide = 0) => {
    if (!S.audio || localStorage.getItem("wc-muted") === "1") return;
    try {
      const c = audio(), at = c.currentTime + delay, o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(f, at);
      if (glide) o.frequency.exponentialRampToValueAtTime(Math.max(30, f + glide), at + dur);
      g.gain.setValueAtTime(.0001, at); g.gain.exponentialRampToValueAtTime(vol, at + .012);
      g.gain.exponentialRampToValueAtTime(.0001, at + dur);
      o.connect(g); g.connect(c.destination); o.start(at); o.stop(at + dur + .04);
    } catch (error) { /* optional */ }
  };
  const noise = (dur = .18, vol = .11, low = 900) => {
    if (!S.audio || localStorage.getItem("wc-muted") === "1") return;
    try {
      const c = audio(), n = Math.ceil(c.sampleRate * dur), buf = c.createBuffer(1, n, c.sampleRate), data = buf.getChannelData(0);
      for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 1.4);
      const src = c.createBufferSource(), filter = c.createBiquadFilter(), gain = c.createGain();
      src.buffer = buf; filter.type = "lowpass"; filter.frequency.value = low; gain.gain.value = vol;
      src.connect(filter); filter.connect(gain); gain.connect(c.destination); src.start();
    } catch (error) { /* optional */ }
  };
  return {
    unlock() { S.audio = true; try { audio(); } catch (error) {} },
    hook() { tone(185, "square", .08, .07); tone(460, "triangle", .12, .045, .04, -160); },
    release() { tone(210, "triangle", .08, .045, 0, -120); },
    slam(power = .5) { noise(.16, .08 + power * .09, 650); tone(85 + power * 40, "sawtooth", .23, .11, 0, -45); },
    pickup() { tone(370, "square", .07, .07); tone(740, "triangle", .14, .06, .06, 180); },
    deliver() { [196, 294, 392, 587].forEach((f, i) => tone(f, "square", .22, .075, i * .075)); noise(.32, .12, 1200); },
    boom() { noise(.65, .18, 460); tone(73, "sawtooth", .7, .16, 0, -35); },
    fall() { noise(.35, .12, 520); tone(100, "triangle", .55, .12, 0, -55); },
    overload() { tone(115, "sawtooth", .75, .12, 0, 680); tone(880, "square", .18, .05, .48); },
    shift() { [220, 330, 440].forEach((f, i) => tone(f, "square", .18, .06, i * .1)); },
    win() { [392, 523, 659, 784, 1047].forEach((f, i) => tone(f, "triangle", .35, .075, i * .095)); },
  };
})();

const joinUrl = new URL(".", location.href).href;
$("tv-url").textContent = joinUrl.replace(/^https?:\/\//, "");
try { renderQR($("tv-qr"), joinUrl); } catch (error) { $("tv-qr").textContent = "OPEN THE ADDRESS BELOW"; }
async function holdWake() { try { S.wake = await navigator.wakeLock?.request("screen"); } catch (error) {} }
$("tv-curtain").onclick = () => { Sound.unlock(); holdWake(); $("tv-curtain").hidden = true; };
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && S.audio) holdWake(); });

function show(id) {
  for (const sid of ["tv-lobby", "tv-arena", "tv-results"]) $(sid).hidden = sid !== id;
}
function escText(value) { return String(value ?? ""); }

function renderLobby(st) {
  show("tv-lobby");
  S.trails.clear();
  const host = $("tv-crew"); host.textContent = "";
  const humans = st.players.filter((p) => !p.bot);
  for (const p of humans) {
    const row = document.createElement("div"); row.className = "tv-worker" + (p.ready ? " ready" : "");
    const av = document.createElement("span"); av.className = "av"; Hub.fillAvatar(av, p);
    const meta = document.createElement("span");
    const name = document.createElement("b"); name.textContent = p.name;
    const status = document.createElement("small"); status.textContent = p.ready ? "READY TO SWING" : p.connected ? "CLOCKING IN" : "SIGNAL LOST";
    meta.append(name, status); row.append(av, meta); host.appendChild(row);
  }
  if (st.phase === "countdown") {
    const n = st.deadline && S.conn ? Math.max(1, Math.ceil((st.deadline - S.conn.now()) / 1000)) : 3;
    $("tv-lobby-hint").textContent = `GANTRY POWERING UP · ${n}`;
  } else {
    $("tv-lobby-hint").textContent = humans.length
      ? `${humans.length} WORKER${humans.length === 1 ? "" : "S"} CLOCKED IN · READY UP ON A PHONE`
      : "SCAN TO CLOCK IN · READY UP ON YOUR PHONE";
  }
}

function renderScores(g) {
  const host = $("score-stack"); host.textContent = "";
  const carrier = g.cargo?.[4] || null;
  const rows = [...(g.scores || [])].sort((a, b) => b.score - a.score || String(a.pid).localeCompare(String(b.pid)));
  for (const r of rows) {
    const p = player(r.pid), row = document.createElement("div");
    row.className = "score-row" + (r.pid === carrier ? " carrier" : "");
    const av = document.createElement("span"); av.className = "av"; Hub.fillAvatar(av, p);
    const name = document.createElement("span"); name.textContent = `${r.pid === carrier ? "📦 " : ""}${p?.name || "WORKER"}`;
    const score = document.createElement("b"); score.textContent = r.score;
    row.append(av, name, score); host.appendChild(row);
  }
}
function renderArena(st) {
  show("tv-arena"); const g = st.game;
  $("shift-chip").textContent = `SHIFT ${g.shift}/${g.shifts_total}`;
  $("tv-clock").textContent = String(Math.max(0, Math.ceil(g.shift_left || 0)));
  $("tv-clock").classList.toggle("hot", !!g.overload);
  $("overload-chip").hidden = !g.overload;
  const carrier = g.cargo?.[4], cp = player(carrier);
  $("cargo-callout").textContent = carrier
    ? `📦 ${escText(cp?.name || "A WORKER").toUpperCase()} HAS THE CARGO · HIT THE CHUTE`
    : g.cargo && g.cargo[5] <= 5 ? `⚠ CARGO BLOWS IN ${Math.max(0, Math.ceil(g.cargo[5]))}` : "GRAB THE GLOWING CARGO";
  $("cargo-callout").classList.toggle("hot", !!g.overload || (g.cargo && g.cargo[5] <= 5));
  renderScores(g);
}

function renderResults(st) {
  show("tv-results"); const result = st.game?.result;
  if (!result) return;
  const rows = result.standings || [], winner = player(result.winner || rows[0]?.pid);
  $("tv-winner").textContent = winner ? `${winner.name.toUpperCase()} OWNS THE GANTRY` : "SHIFT COMPLETE";
  const podium = $("tv-podium"); podium.textContent = "";
  rows.slice(0, 5).forEach((r, i) => {
    const p = player(r.pid), card = document.createElement("div");
    card.className = "podium-card" + (i === 0 ? " first" : i === 1 ? " second" : "");
    const place = document.createElement("span"); place.className = "place"; place.textContent = `#${i + 1}`;
    const av = document.createElement("span"); av.className = "av"; Hub.fillAvatar(av, p);
    const name = document.createElement("h2"); name.textContent = p?.name || "WORKER";
    const score = document.createElement("b"); score.textContent = `${r.score} PTS`;
    const stats = document.createElement("small"); stats.textContent = `${r.deliveries || 0} DELIVERIES · ${r.steals || 0} STEALS · ${r.wipes || 0} WIPES`;
    card.append(place, av, name, score, stats); podium.appendChild(card);
  });
  $("tv-result-line").textContent = `${result.crew_deliveries ?? rows.reduce((n, r) => n + (r.deliveries || 0), 0)} TOTAL CARGO DELIVERIES · NEW LOBBY SOON`;
  if (!S.resultShown) { S.resultShown = true; Hub.confettiBurst(300); Sound.win(); }
}

function onState(st) {
  const old = S.st?.game;
  if (old?.units && st.game?.units && old.tick !== st.game.tick) {
    S.prev = new Map(old.units.map((u) => [u[0], u]));
    S.prevCargo = old.cargo ? [...old.cargo] : null; S.at = performance.now();
  } else if (!old || !st.game) { S.prev = new Map(); S.prevCargo = null; S.at = performance.now(); }
  S.st = st;
  if (st.phase === "lobby" || st.phase === "countdown") { S.resultShown = false; renderLobby(st); }
  else if (st.phase === "game_end") renderResults(st);
  else renderArena(st);
  const stage = st.game?.stage || st.phase;
  if (st.game?.shift && st.game.shift !== S.lastShift && stage === "play") {
    S.trails.clear(); showShift(st.game.shift);
  }
  S.lastShift = st.game?.shift || 0; S.lastStage = stage;
}

function unitPoint(pid) {
  const u = unitByPid(pid); return u ? { x: u[1], y: u[2] } : { x: 600, y: 340 };
}
function burst(x, y, color, count = 28, speed = 340) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (.25 + Math.random() * .75);
    S.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: .45 + Math.random() * .55, max: 1, c: color, size: 2 + Math.random() * 5 });
  }
  if (S.particles.length > 480) S.particles.splice(0, S.particles.length - 480);
}
function floater(x, y, text, color = "#fff") { S.floaters.push({ x, y, text, color, life: 1.35, max: 1.35 }); }
function flash(text, ms = 650) {
  const el = $("tv-flash"); el.textContent = text; el.hidden = false; el.style.animation = "none"; void el.offsetWidth; el.style.animation = `impact ${ms}ms ease both`;
  clearTimeout(el._timer); el._timer = setTimeout(() => { el.hidden = true; }, ms);
}
function showShift(shift) {
  const box = $("shift-flash"); box.querySelector("b").textContent = `SHIFT ${shift}`; box.hidden = false;
  Sound.shift(); setTimeout(() => { box.hidden = true; }, 1600);
}
function onFx(fx) {
  const p = unitPoint(fx.pid || fx.carrier || fx.winner), color = player(fx.pid)?.color || "#ffb020";
  switch (fx.kind) {
    case "hook": burst(fx.x ?? p.x, fx.y ?? p.y, color, 13, 180); Sound.hook(); break;
    case "release": Sound.release(); break;
    case "slam": {
      const q = fx.x !== undefined ? { x: fx.x, y: fx.y } : p;
      burst(q.x, q.y, "#f4f7fb", 38, 520); S.shake = Math.max(S.shake, 11 + 10 * (fx.power || .5));
      floater(q.x, q.y - 25, "SLAM!", "#ffb020"); Sound.slam(fx.power || .5); break;
    }
    case "pickup": burst(p.x, p.y, "#ffb020", 34, 280); floater(p.x, p.y - 35, "CARGO!", "#ffd166"); Sound.pickup(); break;
    case "steal": burst(fx.x ?? p.x, fx.y ?? p.y, "#ff4d1a", 44, 480); floater(p.x, p.y - 40, `STEAL +${fx.points || 1}`, "#ff4d1a"); S.shake = 16; Sound.slam(.8); break;
    case "delivery": burst(fx.x ?? p.x, fx.y ?? p.y, "#ffb020", 90, 560); floater(p.x, p.y - 55, `DELIVERY +${fx.points || 3}`, "#ffd166"); S.shake = 22; flash("DELIVERY!", 820); Sound.deliver(); break;
    case "fall": burst(p.x, game()?.hazard_y || 620, "#ff4d1a", 50, 430); S.shake = 12; Sound.fall(); break;
    case "cargo_boom": { const c = game()?.cargo; const x = fx.x ?? c?.[0] ?? 600, y = fx.y ?? c?.[1] ?? 340; burst(x, y, "#ff4d1a", 120, 700); S.shake = 30; flash("CARGO BLOWOUT", 900); Sound.boom(); break; }
    case "overload": flash("⚠ OVERLOAD\nDOUBLE CARGO", 1200); Sound.overload(); break;
    case "shift_start": showShift(fx.shift || game()?.shift || 1); break;
    case "shift_end": flash(`SHIFT ${fx.shift || ""} COMPLETE`, 950); break;
    case "toast": if (fx.msg) Hub.toast((fx.icon ? `${fx.icon} ` : "") + fx.msg); break;
  }
}

function fit() {
  const rect = cv.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
  const w = Math.max(1, Math.round(rect.width * dpr)), h = Math.max(1, Math.round(rect.height * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; S.trails.clear(); }
}
addEventListener("resize", fit);

function interpUnit(u, f) {
  const prev = S.prev.get(u[0]);
  if (!prev) return { raw: u, x: u[1], y: u[2], vx: u[3], vy: u[4] };
  return { raw: u, x: lerp(prev[1], u[1], f), y: lerp(prev[2], u[2], f), vx: lerp(prev[3], u[3], f), vy: lerp(prev[4], u[4], f) };
}
function interpCargo(c, f) {
  if (!c) return null; const p = S.prevCargo;
  return { raw: c, x: p ? lerp(p[0], c[0], f) : c[0], y: p ? lerp(p[1], c[1], f) : c[1], vx: c[2], vy: c[3] };
}
function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }

function drawBackground(g, t, W, H) {
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, "#080b10"); grad.addColorStop(.58, "#121821"); grad.addColorStop(1, "#1a0b08");
  ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
  // Parallax factory windows and distant furnaces.
  ctx.fillStyle = "rgba(106,124,145,.065)";
  for (let x = 25; x < W; x += 150) { ctx.fillRect(x, 100, 86, H * .47); ctx.clearRect(x + 7, 110, 72, H * .43); }
  ctx.strokeStyle = "rgba(117,136,158,.11)"; ctx.lineWidth = 3;
  for (let x = -H; x < W + H; x += 190) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + H, H); ctx.stroke(); }
  for (let y = 105; y < H * .75; y += 84) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  // Overhead beam.
  ctx.fillStyle = "#252d37"; ctx.fillRect(0, 26, W, 30);
  ctx.fillStyle = "#090b0f";
  for (let x = -20; x < W; x += 48) { ctx.save(); ctx.translate(x, 26); ctx.rotate(-.7); ctx.fillRect(0, -10, 15, 52); ctx.restore(); }
  ctx.fillStyle = "#596675";
  for (let x = 18; x < W; x += 96) { ctx.beginPath(); ctx.arc(x, 41, 3.5, 0, 7); ctx.fill(); }
  // Lamps.
  for (let x = 115; x < W; x += 280) {
    ctx.strokeStyle = "#39434f"; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x, 55); ctx.lineTo(x, 94); ctx.stroke();
    const lamp = ctx.createRadialGradient(x, 102, 3, x, 102, 125);
    lamp.addColorStop(0, "rgba(255,190,78,.24)"); lamp.addColorStop(1, "rgba(255,176,32,0)");
    ctx.fillStyle = lamp; ctx.beginPath(); ctx.arc(x, 102, 125, 0, 7); ctx.fill();
    ctx.fillStyle = "#ffbd45"; ctx.fillRect(x - 13, 91, 26, 8);
  }
  // Smelter surface.
  const hy = g.hazard_y * H / g.arena[1], wave = 5 + 4 * Math.sin(t * 1.7);
  const lava = ctx.createLinearGradient(0, hy - 8, 0, H);
  lava.addColorStop(0, "#ffcc63"); lava.addColorStop(.05, "#ff5a1f"); lava.addColorStop(.42, "#a31b08"); lava.addColorStop(1, "#270603");
  ctx.fillStyle = lava; ctx.beginPath(); ctx.moveTo(0, H);
  for (let x = 0; x <= W + 20; x += 18) ctx.lineTo(x, hy + Math.sin(x * .028 + t * 3.2) * wave + Math.sin(x * .071 - t * 2) * 3);
  ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
  ctx.globalCompositeOperation = "screen"; ctx.fillStyle = "rgba(255,103,30,.18)";
  for (let i = 0; i < 18; i++) { const x = (i * 173 + t * 37) % W, y = hy + 18 + ((i * 59) % Math.max(30, H - hy - 20)); ctx.beginPath(); ctx.arc(x, y, 3 + (i % 4), 0, 7); ctx.fill(); }
  ctx.globalCompositeOperation = "source-over";
}

function drawChute(g, sx, sy, t) {
  const [x, y, w, h] = g.chute || [1050, 430, 110, 125];
  const X = x * sx, Y = y * sy, W = w * sx, H = h * sy;
  ctx.save(); ctx.shadowColor = "#c7ff4a"; ctx.shadowBlur = 18 + 6 * Math.sin(t * 4);
  ctx.fillStyle = "rgba(16,24,13,.78)"; roundRect(X, Y, W, H, 10); ctx.fill();
  ctx.shadowBlur = 0; ctx.strokeStyle = "#c7ff4a"; ctx.lineWidth = 4; ctx.setLineDash([14, 9]); ctx.lineDashOffset = -t * 38;
  roundRect(X, Y, W, H, 10); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = "#dfff9b"; ctx.font = `900 ${Math.max(11, 17 * sy)}px JBMono,monospace`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("CARGO", X + W / 2, Y + H / 2 - 8 * sy); ctx.font = `900 ${Math.max(16, 30 * sy)}px sans-serif`; ctx.fillText("⇣", X + W / 2, Y + H / 2 + 20 * sy); ctx.restore();
}

function drawAnchor(a, sx, sy, t) {
  const x = a[1] * sx, y = a[2] * sy, kind = a[3] || "fixed";
  ctx.save();
  if (kind === "crane" || kind === "moving") { ctx.strokeStyle = "rgba(255,176,32,.28)"; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x, 55); ctx.lineTo(x, y); ctx.stroke(); }
  ctx.shadowColor = kind === "crane" || kind === "moving" ? "#ffb020" : "#8fa3c0"; ctx.shadowBlur = 11;
  ctx.fillStyle = "#161c23"; ctx.strokeStyle = kind === "crane" || kind === "moving" ? "#ffb020" : "#8190a3"; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(x, y, 11 * Math.min(sx, sy), 0, 7); ctx.fill(); ctx.stroke(); ctx.shadowBlur = 0;
  ctx.fillStyle = "#05070a"; ctx.beginPath(); ctx.arc(x, y, 3.5 * Math.min(sx, sy), 0, 7); ctx.fill();
  if (kind === "crane" || kind === "moving") { ctx.strokeStyle = "rgba(255,176,32,.7)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, y, (16 + Math.sin(t * 4) * 3) * Math.min(sx, sy), 0, 7); ctx.stroke(); }
  ctx.restore();
}

function drawChain(u, allUnits, x, y, sx, sy, t) {
  const hx = u.raw[6], hy = u.raw[7]; if (hx === null || hy === null || hx === undefined || hy === undefined) return;
  const host = allUnits.find((v) => v.raw[0] !== u.raw[0] && v.raw[1] === hx && v.raw[2] === hy);
  const ax = (host ? host.x : hx) * sx, ay = (host ? host.y : hy) * sy;
  const dx = x - ax, dy = y - ay, dist = Math.hypot(dx, dy), tension = clamp(Number(u.raw[8]) || 0, 0, 1);
  const p = player(u.raw[0]), color = p?.color || "#ffb020", sag = (1 - tension) * Math.min(70 * sy, dist * .2);
  const cx = (ax + x) / 2, cy = (ay + y) / 2 + sag;
  ctx.save(); ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(2,3,5,.9)"; ctx.lineWidth = 9 * Math.min(sx, sy); ctx.beginPath(); ctx.moveTo(ax, ay); ctx.quadraticCurveTo(cx, cy, x, y); ctx.stroke();
  ctx.strokeStyle = tension > .82 ? "#ffd166" : color; ctx.lineWidth = 3.2 * Math.min(sx, sy); ctx.shadowColor = color; ctx.shadowBlur = tension * 13;
  ctx.setLineDash([8 * Math.min(sx, sy), 5 * Math.min(sx, sy)]); ctx.lineDashOffset = -t * (u.raw[5] & 4 ? 35 : 10);
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.quadraticCurveTo(cx, cy, x, y); ctx.stroke(); ctx.setLineDash([]); ctx.shadowBlur = 0;
  ctx.restore();
}

function drawUnit(u, allUnits, sx, sy, t) {
  const pid = u.raw[0], flags = u.raw[5] | 0, alive = !!(flags & 1), p = player(pid); if (!alive) return;
  const x = u.x * sx, y = u.y * sy, color = p?.color || "#ffb020";
  drawChain(u, allUnits, x, y, sx, sy, t);
  const trail = S.trails.get(pid) || []; trail.push([x, y]); if (trail.length > 12) trail.shift(); S.trails.set(pid, trail);
  ctx.save(); ctx.lineCap = "round"; ctx.lineJoin = "round";
  if (trail.length > 2) { ctx.beginPath(); ctx.moveTo(trail[0][0], trail[0][1]); for (const q of trail.slice(1)) ctx.lineTo(q[0], q[1]); ctx.strokeStyle = color + "35"; ctx.lineWidth = 9 * Math.min(sx, sy); ctx.stroke(); }
  const r = 22 * Math.min(sx, sy), lean = clamp(u.vx / 700, -.45, .45);
  ctx.translate(x, y); ctx.rotate(lean);
  if (flags & 4) { ctx.shadowColor = "#ffb020"; ctx.shadowBlur = 30; ctx.fillStyle = "rgba(255,176,32,.16)"; ctx.beginPath(); ctx.arc(0, 0, r * 1.65, 0, 7); ctx.fill(); }
  if (flags & 8) { ctx.strokeStyle = "#c7ff4a"; ctx.lineWidth = 3; ctx.setLineDash([5,5]); ctx.beginPath(); ctx.arc(0,0,r*1.35,0,7);ctx.stroke();ctx.setLineDash([]); }
  ctx.shadowColor = color; ctx.shadowBlur = 17; const body = ctx.createLinearGradient(-r, -r, r, r); body.addColorStop(0, "#edf2f7"); body.addColorStop(.16, color); body.addColorStop(1, "#121820");
  ctx.fillStyle = body; ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
  // Hard hat brim and visor.
  ctx.fillStyle = flags & 4 ? "#ffb020" : color; ctx.beginPath(); ctx.arc(0, -r * .08, r * .72, Math.PI, Math.PI * 2); ctx.lineTo(r * .82, 0); ctx.lineTo(-r * .82, 0); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "rgba(5,8,11,.78)"; roundRect(-r * .55, r * .03, r * 1.1, r * .52, r * .16); ctx.fill();
  ctx.fillStyle = "#fff"; ctx.font = `${Math.max(11, r * .75)}px serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(p?.avatar || "●", 0, r * .29);
  ctx.restore();
  // Nameplate stays horizontal.
  ctx.font = `800 ${Math.max(9, 11 * sy)}px Sora,sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
  ctx.lineWidth = 4; ctx.strokeStyle = "rgba(3,4,6,.9)"; ctx.strokeText(p?.name || "WORKER", x, y - r - 7); ctx.fillStyle = "#eef2f6"; ctx.fillText(p?.name || "WORKER", x, y - r - 7);
  if (flags & 16) { ctx.fillStyle = "#ffb020"; ctx.font = `800 ${Math.max(8, 9 * sy)}px JBMono`; ctx.fillText("SIGNAL LOST", x, y + r + 17); }
}

function drawCargo(c, units, g, sx, sy, t) {
  if (!c) return; const x = c.x * sx, y = c.y * sy, carrier = c.raw[4], unit = units.find((u) => u.raw[0] === carrier);
  if (unit) {
    ctx.strokeStyle = "rgba(255,176,32,.75)"; ctx.lineWidth = 4 * Math.min(sx, sy); ctx.setLineDash([8,5]);
    ctx.beginPath(); ctx.moveTo(unit.x * sx, unit.y * sy); ctx.lineTo(x, y); ctx.stroke(); ctx.setLineDash([]);
  } else if (g.cargo_anchor !== null && g.cargo_anchor !== undefined) {
    const a = (g.anchors || []).find((row) => row[0] === g.cargo_anchor);
    if (a) {
      ctx.strokeStyle = "rgba(255,176,32,.68)"; ctx.lineWidth = 3 * Math.min(sx, sy); ctx.setLineDash([7, 5]);
      ctx.beginPath(); ctx.moveTo(a[1] * sx, a[2] * sy); ctx.lineTo(x, y); ctx.stroke(); ctx.setLineDash([]);
    }
  }
  const size = 34 * Math.min(sx, sy), ang = Math.atan2(c.vy, c.vx) * .12 + Math.sin(t * 2.7) * .05;
  ctx.save(); ctx.translate(x, y); ctx.rotate(ang); ctx.shadowColor = "#ff7a18"; ctx.shadowBlur = 26 + Math.sin(t * 5) * 7;
  ctx.fillStyle = "#f28b18"; roundRect(-size, -size * .75, size * 2, size * 1.5, size * .12); ctx.fill(); ctx.shadowBlur = 0;
  ctx.strokeStyle = "#ffd166"; ctx.lineWidth = 3; ctx.stroke(); ctx.strokeStyle = "rgba(32,15,3,.58)"; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.moveTo(-size * .62, -size * .62); ctx.lineTo(size * .62, size * .62); ctx.moveTo(size * .62, -size * .62); ctx.lineTo(-size * .62, size * .62); ctx.stroke();
  ctx.fillStyle = "#1d0d02"; ctx.font = `900 ${size * .38}px JBMono`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("CARGO", 0, 0); ctx.restore();
  if (c.raw[5] <= 5) { ctx.fillStyle = "#fff"; ctx.font = `900 ${Math.max(17, 26 * sy)}px JBMono`; ctx.textAlign = "center"; ctx.fillText(Math.max(0, Math.ceil(c.raw[5])), x, y - size - 13); }
}

function stepFx(dt, sx, sy) {
  for (const p of S.particles) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 410 * dt; p.vx *= .985; p.life -= dt; }
  S.particles = S.particles.filter((p) => p.life > 0);
  for (const f of S.floaters) { f.y -= 34 * dt; f.life -= dt; }
  S.floaters = S.floaters.filter((f) => f.life > 0);
  ctx.save();
  for (const p of S.particles) { ctx.globalAlpha = clamp(p.life / p.max, 0, 1); ctx.fillStyle = p.c; ctx.shadowColor = p.c; ctx.shadowBlur = 5; ctx.fillRect(p.x * sx - p.size / 2, p.y * sy - p.size / 2, p.size, p.size); }
  ctx.globalAlpha = 1; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (const f of S.floaters) { ctx.globalAlpha = clamp(f.life / f.max, 0, 1); ctx.font = `900 ${Math.max(17, 29 * sy)}px Sora`; ctx.lineWidth = 6; ctx.strokeStyle = "#050609"; ctx.strokeText(f.text, f.x * sx, f.y * sy); ctx.fillStyle = f.color; ctx.fillText(f.text, f.x * sx, f.y * sy); }
  ctx.restore(); ctx.globalAlpha = 1;
}

let lastRaf = performance.now();
function frame(now) {
  requestAnimationFrame(frame); const st = S.st, g = game();
  if (!st || st.phase === "lobby" || st.phase === "countdown" || st.phase === "game_end" || !g?.arena) return;
  fit(); const dt = Math.min(.04, (now - lastRaf) / 1000); lastRaf = now;
  const f = clamp((now - S.at) / (g.tick_ms || 83), 0, 1), W = cv.width, H = cv.height, sx = W / g.arena[0], sy = H / g.arena[1], t = now / 1000;
  ctx.save(); if (S.shake > .2) { const a = Math.random() * Math.PI * 2; ctx.translate(Math.cos(a) * S.shake, Math.sin(a) * S.shake); S.shake *= .86; }
  drawBackground(g, t, W, H); drawChute(g, sx, sy, t);
  for (const a of g.anchors || []) drawAnchor(a, sx, sy, t);
  const units = (g.units || []).map((u) => interpUnit(u, f));
  for (const u of units) {
    if (!(u.raw[5] & 1)) S.trails.delete(u.raw[0]);
    drawUnit(u, units, sx, sy, t);
  }
  drawCargo(interpCargo(g.cargo, f), units, g, sx, sy, t); stepFx(dt, sx, sy); ctx.restore();
}
requestAnimationFrame(frame);

S.conn = Hub.connect("/games/smelterskelter/ws", { onState, onFx }, { watch: true });
window.__smelterTV = { state: () => S.st, interpUnit, interpCargo, clamp };
