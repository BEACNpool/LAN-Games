/* DODGEBALL client. Server-authoritative realtime sim: buffer snapshots and
   render interpolated ~90ms behind, predict own movement locally, send coalesced
   input. Everything (arena, players, balls, HUD, controls) draws on one canvas. */
"use strict";

const $ = (id) => document.getElementById(id);

// client-side physics mirrors of games/dodgeball/physics.py (prediction + preview)
const RUN = 300, ATAU = 0.10, STAU = 0.07;
const INTERP = 90;                 // ms of interpolation buffer

const S = {
  st: null, pid: null, mySeat: null, conn: null, joined: false,
  muted: localStorage.getItem("wc-muted") === "1",
  assist: localStorage.getItem("db-assist") === "1",
  buf: [], lastTick: -1,
  pred: { active: false, x: 0, y: 0, vx: 0, vy: 0 },
  shake: 0, particles: [], flash: {},
  goShown: false, ballsN: 4,
  sent: { x: 0, y: 0, at: 0 },
  arena: { w: 1100, h: 700 },
  consts: { pr: 24, br: 11, body: 90, tmin: 460, tmax: 850, vz: 300, grav: 1400 },
  cam: { scale: 1, ox: 0, oy: 0 },
  cd: 0,   // dash cooldown display (client estimate)
};

/* ---------- audio ---------- */
const SFX = (() => {
  let ctx = null;
  const ac = () => { if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)(); if (ctx.state === "suspended") ctx.resume(); return ctx; };
  function tone(f, type, dur, vol = 0.12, when = 0, glide = 0) {
    if (S.muted) return;
    try { const c = ac(), t = c.currentTime + when, o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(f, t);
      if (glide) o.frequency.exponentialRampToValueAtTime(Math.max(40, f + glide), t + dur);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + dur + 0.04);
    } catch (e) {}
  }
  return {
    unlock: () => { try { ac(); } catch (e) {} },
    throw: () => tone(520, "sawtooth", 0.12, 0.09, 0, 420),
    hit: () => { tone(150, "square", 0.12, 0.14); tone(90, "sawtooth", 0.16, 0.1, 0, -40); },
    catch: () => { [520, 780, 1040].forEach((f, i) => tone(f, "sine", 0.12, 0.11, i * 0.04)); },
    bounce: () => tone(340, "sine", 0.07, 0.06, 0, 120),
    dash: () => tone(680, "sine", 0.08, 0.07, 0, 260),
    pickup: () => tone(880, "triangle", 0.05, 0.06),
    elim: () => [392, 330, 262].forEach((f, i) => tone(f, "sawtooth", 0.22, 0.11, i * 0.09)),
    whistle: () => { tone(1200, "sine", 0.14, 0.12); tone(1600, "sine", 0.14, 0.1, 0.12); },
    win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, "sine", 0.24, 0.12, i * 0.1)),
    bad: () => tone(140, "sawtooth", 0.18, 0.07, 0, -60),
  };
})();

function buzz(p) { if (navigator.vibrate) try { navigator.vibrate(p); } catch (e) {} }

/* ---------- helpers ---------- */
const cv = $("cv"), ctx = cv.getContext("2d");
function game() { return S.st?.game || null; }
function nowSrv() { return S.conn ? S.conn.now() : Date.now(); }
const TEAM_COLORS = ["#22d3ee", "#f472b6", "#eab308", "#10c96e", "#a78bfa", "#fb7185", "#38bdf8", "#f97316"];
function seatColor(u) { const g = game(); return (g && g.mode === "teams") ? (u.team === 0 ? "#22d3ee" : "#f472b6") : TEAM_COLORS[u.seat % TEAM_COLORS.length]; }
function show(id) { for (const s of ["scr-join", "scr-lobby", "scr-game"]) $(s).hidden = s !== id; }

/* ---------- snapshot buffer + interpolation ---------- */
function onSnapshot(g, srv) {
  if (g.tick === S.lastTick) return;         // ignore input-echo pushes (same sim tick)
  S.lastTick = g.tick;
  S.buf.push({ tick: g.tick, srv, g });
  if (S.buf.length > 8) S.buf.shift();
  S.arena = g.arena; if (g.consts) S.consts = g.consts;
}
function interpState() {
  const rt = nowSrv() - INTERP;
  const b = S.buf;
  if (!b.length) return null;
  let a = b[0], c = b[b.length - 1];
  for (let i = 0; i < b.length - 1; i++) { if (b[i].srv <= rt && b[i + 1].srv >= rt) { a = b[i]; c = b[i + 1]; break; } }
  const span = c.srv - a.srv;
  const t = span > 0 ? Math.max(0, Math.min(1, (rt - a.srv) / span)) : 0;
  return { a: a.g, b: c.g, t };
}
function lerp(x, y, t) { return x + (y - x) * t; }
function unitAt(fr, seat) {
  const A = fr.a.units.find((u) => u.seat === seat), B = fr.b.units.find((u) => u.seat === seat);
  if (!A) return B; if (!B) return A;
  return { ...B, x: lerp(A.x, B.x, fr.t), y: lerp(A.y, B.y, fr.t), facing: alerp(A.facing, B.facing, fr.t) };
}
function ballAt(fr, id) {
  const A = fr.a.balls.find((x) => x.id === id), B = fr.b.balls.find((x) => x.id === id);
  if (!A) return B; if (!B) return A;
  return { ...B, x: lerp(A.x, B.x, fr.t), y: lerp(A.y, B.y, fr.t), z: lerp(A.z, B.z, fr.t) };
}
function alerp(a, b, t) { let d = ((b - a + Math.PI) % (2 * Math.PI)) - Math.PI; return a + d * t; }

/* ---------- multi-touch input ---------- */
const IN = {
  move: { active: false, id: null, ox: 0, oy: 0, dx: 0, dy: 0, mag: 0 },
  aim: { active: false, id: null, ox: 0, oy: 0, x: 0, y: 0, ax: 0, ay: 0, power: 0 },
  dash: { id: null, fired: false },
};
const MAXR = 68, DEADF = 0.15, CANCELR = 16;
function dashRect() { return { x: cv.width - 74 * DPR(), y: cv.height - 96 * DPR(), r: 46 * DPR() }; }
function DPR() { return Math.min(2, window.devicePixelRatio || 1); }
function localXY(t) { const r = cv.getBoundingClientRect(); return { x: (t.clientX - r.left) * DPR(), y: (t.clientY - r.top) * DPR() }; }

function tStart(idf, p) {
  const d = dashRect();
  if (IN.dash.id === null && Math.hypot(p.x - d.x, p.y - d.y) <= d.r) {
    IN.dash.id = idf; IN.dash.fired = true; buzz(15); return;
  }
  if (!IN.aim.active && p.x > cv.width * 0.5) {
    Object.assign(IN.aim, { active: true, id: idf, ox: p.x, oy: p.y, x: p.x, y: p.y, ax: 0, ay: 0, power: 0 });
    return;
  }
  if (!IN.move.active) Object.assign(IN.move, { active: true, id: idf, ox: p.x, oy: p.y, dx: 0, dy: 0, mag: 0 });
}
function tMove(idf, p) {
  if (idf === IN.move.id) {
    let vx = p.x - IN.move.ox, vy = p.y - IN.move.oy, len = Math.hypot(vx, vy);
    const R = MAXR * DPR();
    if (len > R) { vx *= R / len; vy *= R / len; len = R; }
    const dz = DEADF * R;
    if (len < dz) { IN.move.dx = IN.move.dy = IN.move.mag = 0; }
    else { const sc = (len - dz) / (R - dz); IN.move.dx = vx / len * sc; IN.move.dy = vy / len * sc; IN.move.mag = sc; }
  } else if (idf === IN.aim.id) {
    IN.aim.x = p.x; IN.aim.y = p.y;
    let vx = p.x - IN.aim.ox, vy = p.y - IN.aim.oy, len = Math.hypot(vx, vy);
    IN.aim.power = Math.min(len, MAXR * DPR()) / (MAXR * DPR());
    if (len > 1) { IN.aim.ax = vx / len; IN.aim.ay = vy / len; }
  }
}
function tEnd(idf) {
  if (idf === IN.move.id) { IN.move.active = false; IN.move.id = null; IN.move.dx = IN.move.dy = IN.move.mag = 0; }
  else if (idf === IN.aim.id) { fireAim(); IN.aim.active = false; IN.aim.id = null; }
  else if (idf === IN.dash.id) { IN.dash.id = null; }
}
function fireAim() {
  const a = IN.aim, g = game();
  const iHold = myUnit()?.holding;
  const dragLen = Math.hypot(a.x - a.ox, a.y - a.oy) / DPR();
  if (!iHold) { S.conn?.send({ t: "catch" }); buzz(15); return; }   // empty-handed tap/drag = catch
  let ax = a.ax, ay = a.ay;
  if (dragLen < CANCELR) {                    // quick tap while holding -> auto-aim throw
    const tgt = nearestEnemy();
    if (tgt) { const me = myUnit(); ax = tgt.x - me.x; ay = tgt.y - me.y; const l = Math.hypot(ax, ay) || 1; ax /= l; ay /= l; }
    else return;
  } else if (S.assist) { [ax, ay] = assistAim(ax, ay); }
  const angle = Math.atan2(ay, ax);
  const power = Math.max(0.25, a.power);
  S.conn?.send({ t: "throw", a: angle, p: power });
  buzz(20); SFX.throw();
}
function assistAim(ax, ay) {
  const me = myUnit(), tgt = nearestEnemy(); if (!me || !tgt) return [ax, ay];
  let tx = tgt.x - me.x, ty = tgt.y - me.y; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
  const dot = ax * tx + ay * ty;
  if (dot < Math.cos(0.7)) return [ax, ay];   // outside ~40° cone: leave manual
  let bx = ax + (tx - ax) * 0.75, by = ay + (ty - ay) * 0.75; const bl = Math.hypot(bx, by) || 1;
  return [bx / bl, by / bl];
}
function myUnit() { const g = game(); if (!g || S.mySeat == null) return null; return g.units.find((u) => u.seat === S.mySeat); }
function nearestEnemy() {
  const g = game(), me = myUnit(); if (!g || !me) return null;
  let best = null, bd = 1e18;
  for (const u of g.units) { if (!u.alive || u.seat === me.seat) continue; if (g.mode === "teams" && u.team === me.team) continue; const d = (u.x - me.x) ** 2 + (u.y - me.y) ** 2; if (d < bd) { best = u; bd = d; } }
  return best;
}

function bindTouch() {
  const opt = { passive: false };
  cv.addEventListener("touchstart", (e) => { e.preventDefault(); SFX.unlock(); for (const t of e.changedTouches) tStart(t.identifier, localXY(t)); }, opt);
  cv.addEventListener("touchmove", (e) => { e.preventDefault(); for (const t of e.changedTouches) tMove(t.identifier, localXY(t)); }, opt);
  cv.addEventListener("touchend", (e) => { e.preventDefault(); for (const t of e.changedTouches) tEnd(t.identifier); }, opt);
  cv.addEventListener("touchcancel", (e) => { e.preventDefault(); for (const t of e.changedTouches) tEnd(t.identifier); }, opt);
  // mouse fallback (desktop / playtest): single pointer
  let mid = null;
  cv.addEventListener("mousedown", (e) => { SFX.unlock(); mid = 1; tStart(1, localXY(e)); });
  cv.addEventListener("mousemove", (e) => { if (mid) tMove(1, localXY(e)); });
  cv.addEventListener("mouseup", (e) => { if (mid) { tEnd(1); mid = null; } });
  cv.addEventListener("contextmenu", (e) => e.preventDefault());
}

/* ---------- input send (coalesced) ---------- */
function pumpInput() {
  const g = game(); if (!g || S.mySeat == null) return;
  // dash
  if (IN.dash.fired) { IN.dash.fired = false; S.conn?.send({ t: "dash" }); SFX.dash(); }
  const mv = IN.move.active ? { x: IN.move.dx, y: IN.move.dy } : { x: 0, y: 0 };
  const dt = performance.now() - S.sent.at;
  const changed = Math.hypot(mv.x - S.sent.x, mv.y - S.sent.y) > 0.06;
  // ~11Hz on change (fits RATE_N=30 with room for discrete throw/dash/catch),
  // PLUS an unconditional 250ms keepalive so a dropped 'stop' always converges
  // fast (otherwise a lost (0,0) leaves the server drifting you in a stale dir).
  if ((changed && dt > 90) || dt > 250) {
    S.conn?.send({ t: "move", x: +mv.x.toFixed(3), y: +mv.y.toFixed(3) });
    S.sent = { x: mv.x, y: mv.y, at: performance.now() };
  }
}

/* ---------- own-avatar prediction ---------- */
function predictMe(server, dt) {
  const p = S.pred;
  // predict only during normal free movement; follow the server during a dash
  // or a knockback (the reconcile snap below also catches big divergence)
  if (!server || !server.alive || server.dashing) { p.active = false; return server; }
  if (!p.active) { p.active = true; p.x = server.x; p.y = server.y; p.vx = server.vx; p.vy = server.vy; }
  const mx = IN.move.active ? IN.move.dx : 0, my = IN.move.active ? IN.move.dy : 0;
  const moving = (mx || my);
  const tau = moving ? ATAU : STAU;
  const A = 1 - Math.exp(-dt / tau);
  p.vx += (mx * RUN - p.vx) * A; p.vy += (my * RUN - p.vy) * A;
  p.x += p.vx * dt; p.y += p.vy * dt;
  // reconcile toward the authoritative interpolated position (gentle, snap if far)
  const gap = Math.hypot(server.x - p.x, server.y - p.y);
  const k = gap > 90 ? 1 : 0.10;
  p.x += (server.x - p.x) * k; p.y += (server.y - p.y) * k;
  // clamp to zone/walls
  const g = game(), pr = S.consts.pr, mxg = g.mx || 0, myg = g.my || 0;
  p.x = Math.max(mxg + pr, Math.min(S.arena.w - mxg - pr, p.x));
  p.y = Math.max(myg + pr, Math.min(S.arena.h - myg - pr, p.y));
  return { ...server, x: p.x, y: p.y };
}

/* ---------- render ---------- */
function resize() {
  const d = DPR();
  cv.width = Math.round(innerWidth * d); cv.height = Math.round(innerHeight * d);
  $("rotate-hint").hidden = !(innerHeight > innerWidth && innerWidth < 520);
}
addEventListener("resize", resize); addEventListener("orientationchange", resize);

function camera() {
  const a = S.arena, pad = 16 * DPR();
  const sc = Math.min((cv.width - pad * 2) / a.w, (cv.height - pad * 2) / a.h);
  S.cam.scale = sc;
  S.cam.ox = (cv.width - a.w * sc) / 2;
  S.cam.oy = (cv.height - a.h * sc) / 2;
}
function W2S(x, y) { return [S.cam.ox + x * S.cam.scale, S.cam.oy + y * S.cam.scale]; }

let lastFrame = 0;
function raf(ts) {
  requestAnimationFrame(raf);
  const dt = lastFrame ? Math.min(0.05, (ts - lastFrame) / 1000) : 0.016; lastFrame = ts;
  const st = S.st; if (!st) return;
  if (st.phase === "countdown") $("countdown-num").textContent = Math.max(1, Math.ceil((st.deadline - nowSrv()) / 1000));
  $("countdown-overlay").hidden = st.phase !== "countdown";
  const g = game();
  if (!g || (st.phase !== "play" && st.phase !== "game_end")) { ctx.clearRect(0, 0, cv.width, cv.height); return; }
  camera();
  const fr = interpState(); if (!fr) return;

  // camera shake
  S.shake = Math.max(0, S.shake - 1.2 * dt);
  const sh = S.shake * S.shake, mag = 14 * DPR() * sh;
  const shx = mag * (Math.sin(ts * 0.07) + Math.sin(ts * 0.031)) * 0.5;
  const shy = mag * (Math.cos(ts * 0.061) + Math.sin(ts * 0.043)) * 0.5;

  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.save(); ctx.translate(shx, shy);
  drawCourt(g, ts);
  // balls: shadow first (under players), then in z-order
  const balls = fr.b.balls.map((b) => ballAt(fr, b.id)).filter(Boolean);
  for (const b of balls) drawBallShadow(b);
  // players
  for (const su of fr.b.units) {
    let u = unitAt(fr, su.seat);
    if (su.seat === S.mySeat) {
      // reconcile prediction against the LATEST snapshot (not the ~90ms-delayed
      // interpolation) so the predicted avatar stays ahead of the render buffer
      const latest = S.buf.length ? S.buf[S.buf.length - 1].g.units.find((x) => x.seat === S.mySeat) : u;
      u = predictMe(latest || u, dt);
    }
    drawPlayer(u, ts);
  }
  for (const b of balls) drawBall(b, ts);
  drawParticles(dt);
  ctx.restore();

  drawHUD(g, ts);
  drawControls(g);
  pumpInput();
  renderGameOver(st);
}

function drawCourt(g, ts) {
  const a = S.arena;
  const [x0, y0] = W2S(0, 0), sc = S.cam.scale;
  // floor
  const grad = ctx.createRadialGradient(x0 + a.w * sc / 2, y0 + a.h * sc / 2, 20, x0 + a.w * sc / 2, y0 + a.h * sc / 2, a.w * sc * 0.7);
  grad.addColorStop(0, "#14324a"); grad.addColorStop(1, "#0a1e30");
  ctx.fillStyle = grad; ctx.fillRect(x0, y0, a.w * sc, a.h * sc);
  // center line
  ctx.strokeStyle = "rgba(255,255,255,.12)"; ctx.lineWidth = 2 * DPR();
  ctx.beginPath(); ctx.moveTo(x0 + a.w * sc / 2, y0); ctx.lineTo(x0 + a.w * sc / 2, y0 + a.h * sc); ctx.stroke();
  ctx.strokeRect(x0, y0, a.w * sc, a.h * sc);
  // sudden-death closing walls
  const mx = g.mx || 0, my = g.my || 0;
  if (mx > 0 || my > 0) {
    const [zx, zy] = W2S(mx, my);
    ctx.save();
    ctx.fillStyle = "rgba(249,115,22,.10)";
    ctx.fillRect(x0, y0, a.w * sc, a.h * sc);
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillRect(zx, zy, (a.w - 2 * mx) * sc, (a.h - 2 * my) * sc);
    ctx.restore();
    ctx.strokeStyle = "#f97316"; ctx.lineWidth = 3 * DPR();
    ctx.setLineDash([10 * DPR(), 8 * DPR()]); ctx.lineDashOffset = -ts * 0.02;
    ctx.strokeRect(zx, zy, (a.w - 2 * mx) * sc, (a.h - 2 * my) * sc); ctx.setLineDash([]);
  }
}

function drawBallShadow(b) {
  const [sx, sy] = W2S(b.x, b.y + 0.15 * b.z), sc = S.cam.scale, br = S.consts.br;
  const scale = 1 + b.z / 280, alpha = 0.4 * (1 - Math.min(1, b.z / 260));
  ctx.fillStyle = `rgba(0,0,0,${alpha})`;
  ctx.beginPath(); ctx.ellipse(sx, sy, br * sc * scale, br * sc * scale * 0.5, 0, 0, 7); ctx.fill();
}
function drawBall(b, ts) {
  const [sx, sy] = W2S(b.x, b.y - b.z * 0.6), sc = S.cam.scale, br = S.consts.br * sc;
  if (b.live) { ctx.fillStyle = "rgba(251,191,36,.9)"; ctx.beginPath(); ctx.arc(sx, sy, br * 1.9, 0, 7); ctx.fill(); }
  const g2 = ctx.createRadialGradient(sx - br * 0.3, sy - br * 0.3, br * 0.2, sx, sy, br);
  g2.addColorStop(0, b.live ? "#fff3c4" : "#ffe08a"); g2.addColorStop(1, b.live ? "#f59e0b" : "#c98a1a");
  ctx.fillStyle = g2; ctx.beginPath(); ctx.arc(sx, sy, br, 0, 7); ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,.3)"; ctx.lineWidth = 1.5 * DPR(); ctx.stroke();
}

function drawPlayer(u, ts) {
  if (!u) return;
  const [sx, sy] = W2S(u.x, u.y), sc = S.cam.scale, pr = S.consts.pr * sc;
  const col = seatColor(u), me = u.seat === S.mySeat;
  const flash = S.flash[u.seat] && ts < S.flash[u.seat];
  ctx.save();
  if (!u.alive) ctx.globalAlpha = 0.25;
  // body shadow
  ctx.fillStyle = "rgba(0,0,0,.35)"; ctx.beginPath(); ctx.ellipse(sx, sy + pr * 0.7, pr, pr * 0.4, 0, 0, 7); ctx.fill();
  // dash streak
  if (u.dashing) { ctx.strokeStyle = col + "66"; ctx.lineWidth = pr * 1.4; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx - Math.cos(u.facing) * pr * 2.2, sy - Math.sin(u.facing) * pr * 2.2); ctx.stroke(); }
  // body
  const bodyGrad = ctx.createRadialGradient(sx - pr * 0.3, sy - pr * 0.3, pr * 0.2, sx, sy, pr);
  bodyGrad.addColorStop(0, col); bodyGrad.addColorStop(1, shade(col, -0.35));
  ctx.fillStyle = flash ? "#fff" : bodyGrad;
  ctx.beginPath(); ctx.arc(sx, sy, pr, 0, 7); ctx.fill();
  // rings: invuln (blink), catch (glow), me
  if (u.invuln && !u.dashing && Math.floor(ts / 90) % 2 === 0) { ctx.globalAlpha *= 0.4; }
  if (u.catching) { ctx.strokeStyle = "#10c96e"; ctx.lineWidth = 4 * DPR(); ctx.beginPath(); ctx.arc(sx, sy, pr + 6 * DPR(), 0, 7); ctx.stroke(); }
  ctx.lineWidth = (me ? 3.5 : 2) * DPR(); ctx.strokeStyle = me ? "#fff" : "rgba(0,0,0,.4)";
  ctx.beginPath(); ctx.arc(sx, sy, pr, 0, 7); ctx.stroke();
  // facing nub / holding ball
  const fx = sx + Math.cos(u.facing) * pr, fy = sy + Math.sin(u.facing) * pr;
  if (u.holding) { ctx.fillStyle = "#ffd34d"; ctx.beginPath(); ctx.arc(fx, fy, S.consts.br * sc * 0.9, 0, 7); ctx.fill(); }
  else { ctx.fillStyle = "rgba(255,255,255,.7)"; ctx.beginPath(); ctx.arc(fx, fy, 3 * DPR(), 0, 7); ctx.fill(); }
  ctx.restore();
  // name + lives
  ctx.globalAlpha = u.alive ? 1 : 0.4;
  ctx.textAlign = "center"; ctx.fillStyle = "#fff"; ctx.font = `${Math.round(11 * DPR())}px Sora, sans-serif`;
  ctx.fillText((me ? "▸ " : "") + u.name, sx, sy - pr - 8 * DPR());
  let hearts = ""; for (let i = 0; i < u.lives; i++) hearts += "♥";
  ctx.fillStyle = col; ctx.font = `${Math.round(10 * DPR())}px Sora`;
  ctx.fillText(hearts || (u.alive ? "" : "✖"), sx, sy - pr - 20 * DPR());
  ctx.globalAlpha = 1;
}
function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16); let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  r = Math.max(0, Math.min(255, r + r * f)); g = Math.max(0, Math.min(255, g + g * f)); b = Math.max(0, Math.min(255, b + b * f));
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

/* ---------- particles ---------- */
function burst(x, y, n, color, spd) {
  for (let i = 0; i < n; i++) { const a = Math.random() * 7, s = spd * (0.4 + Math.random());
    S.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.4 + Math.random() * 0.3, t: 0, color }); }
}
function drawParticles(dt) {
  const sc = S.cam.scale;
  for (const p of S.particles) { p.t += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.9; p.vy *= 0.9;
    const [sx, sy] = W2S(p.x, p.y); const a = Math.max(0, 1 - p.t / p.life);
    ctx.globalAlpha = a; ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(sx, sy, 3 * DPR() * (0.5 + a), 0, 7); ctx.fill(); }
  ctx.globalAlpha = 1;
  S.particles = S.particles.filter((p) => p.t < p.life);
}

/* ---------- HUD + controls ---------- */
function drawHUD(g, ts) {
  const d = DPR();
  ctx.textAlign = "left"; ctx.font = `${Math.round(13 * d)}px JBMono, monospace`;
  const alive = g.units.filter((u) => u.alive).length;
  ctx.fillStyle = "rgba(232,237,249,.85)";
  ctx.fillText(`${g.mode === "teams" ? "TEAMS" : "FFA"} · ${alive} left`, 14 * d, 24 * d);
  if (g.sd) { ctx.fillStyle = "#f97316"; ctx.textAlign = "center";
    ctx.font = `800 ${Math.round(14 * d)}px JBMono`; ctx.fillText("⚠ SUDDEN DEATH", cv.width / 2, 24 * d); ctx.textAlign = "left"; }
  const me = myUnit();
  if (me) {
    ctx.textAlign = "left"; ctx.font = `${Math.round(20 * d)}px Sora`;
    let h = ""; for (let i = 0; i < me.lives; i++) h += "♥"; for (let i = me.lives; i < g.lives; i++) h += "·";
    ctx.fillStyle = "#fb7185"; ctx.fillText(h, 14 * d, cv.height - 20 * d);
    ctx.font = `${Math.round(12 * d)}px JBMono`; ctx.fillStyle = me.holding ? "#ffd34d" : "rgba(139,150,179,.8)";
    ctx.fillText(me.holding ? "● ARMED" : "○ grab a ball", 14 * d, cv.height - 42 * d);
  }
}
function drawControls(g) {
  const d = DPR();
  // move stick
  if (IN.move.active) {
    ctx.globalAlpha = 0.32; ctx.strokeStyle = "#fff"; ctx.lineWidth = 3 * d;
    ctx.beginPath(); ctx.arc(IN.move.ox, IN.move.oy, MAXR * d, 0, 7); ctx.stroke();
    ctx.fillStyle = "#22d3ee";
    ctx.beginPath(); ctx.arc(IN.move.ox + IN.move.dx * MAXR * d, IN.move.oy + IN.move.dy * MAXR * d, 20 * d, 0, 7); ctx.fill();
    ctx.globalAlpha = 1;
  }
  // aim / throw preview
  const me = myUnit();
  if (IN.aim.active && me) {
    const dragLen = Math.hypot(IN.aim.x - IN.aim.ox, IN.aim.y - IN.aim.oy) / d;
    if (me.holding && dragLen >= CANCELR) drawAimArc(me);
    // origin ring
    ctx.globalAlpha = 0.3; ctx.strokeStyle = me.holding ? "#a78bfa" : "#10c96e"; ctx.lineWidth = 3 * d;
    ctx.beginPath(); ctx.arc(IN.aim.ox, IN.aim.oy, MAXR * d, 0, 7); ctx.stroke();
    ctx.fillStyle = me.holding ? "#a78bfa" : "#10c96e";
    ctx.beginPath(); ctx.arc(IN.aim.x, IN.aim.y, 18 * d, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
    if (!me.holding) { ctx.fillStyle = "#10c96e"; ctx.textAlign = "center"; ctx.font = `800 ${Math.round(12 * d)}px Sora`; ctx.fillText("CATCH", IN.aim.ox, IN.aim.oy - MAXR * d - 8 * d); }
  }
  // dash button
  const dr = dashRect();
  ctx.globalAlpha = 0.9; ctx.fillStyle = "rgba(22,30,51,.85)"; ctx.strokeStyle = "#f97316"; ctx.lineWidth = 2.5 * d;
  ctx.beginPath(); ctx.arc(dr.x, dr.y, dr.r, 0, 7); ctx.fill(); ctx.stroke();
  ctx.fillStyle = "#f97316"; ctx.textAlign = "center"; ctx.font = `800 ${Math.round(13 * d)}px Sora`;
  ctx.fillText("DASH", dr.x, dr.y + 5 * d); ctx.globalAlpha = 1;
}
function drawAimArc(me) {
  const d = DPR(), c = S.consts;
  const power = Math.max(0.25, IN.aim.power);
  const speed = c.tmin + (c.tmax - c.tmin) * power;
  let ax = IN.aim.ax, ay = IN.aim.ay;
  if (S.assist) [ax, ay] = assistAim(ax, ay);
  let vx = ax * speed, vy = ay * speed, vz = c.vz, x = me.x, y = me.y, z = c.body * 0.5;
  ctx.fillStyle = "rgba(255,255,255,.75)";
  for (let i = 0; i < 26; i++) {
    const t = 0.035;
    vz -= c.grav * t; x += vx * t; y += vy * t; z += vz * t;
    if (z < 0) break;
    if (x < 0 || x > S.arena.w || y < 0 || y > S.arena.h) break;
    const [sx, sy] = W2S(x, y - z * 0.6);
    ctx.globalAlpha = 0.75 * (1 - i / 26); ctx.beginPath(); ctx.arc(sx, sy, 3.2 * d, 0, 7); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/* ---------- fx / juice ---------- */
function onFx(fx) {
  if (fx.kind === "toast") { Hub.toast((fx.icon ? fx.icon + " " : "") + fx.msg); return; }
  if (fx.kind === "invalid") { SFX.bad(); return; }
  if (fx.kind === "match_start") { SFX.whistle(); return; }
  if (fx.kind === "game_over") { return; }
  if (fx.kind !== "ev") return;
  const a = fx.a, e = fx.kind_;
  if (e === "hit") { S.shake += 0.5; S.flash[a[1]] = performance.now() + 90; SFX.hit(); const g = game(); const u = g?.units.find((x) => x.seat === a[1]); if (u) burst(a[3], a[4], 10, "#fb7185", 260); if (a[1] === S.mySeat) buzz([40, 30, 40]); }
  else if (e === "catch") { S.shake += 0.4; SFX.catch(); if (a[1] === S.mySeat) buzz(25); }
  else if (e === "bounce") { if (a[4] > 300) S.shake += 0.12; SFX.bounce(); }
  else if (e === "throw") { }
  else if (e === "eliminate") { S.shake += 0.7; SFX.elim(); }
  else if (e === "storm_out") { S.shake += 0.6; SFX.elim(); }
  else if (e === "pickup") { if (a[1] === S.mySeat) SFX.pickup(); }
  else if (e === "sudden_death") { Hub.toast("⚠ SUDDEN DEATH — the walls close in!"); buzz([30, 40, 30]); }
  else if (e === "dash") { }
}

/* ---------- lobby ---------- */
const PLAYERS = [[2, "1v1"], [4, "4"], [6, "6"], [8, "8"]];
const MODES = [["ffa", "FREE-FOR-ALL"], ["teams", "TEAMS"]];
const LIVESO = [[1, "1"], [3, "3"], [5, "5"]];
const DIFFS = [["mixed", "MIXED"], ["easy", "EASY"], ["hard", "HARD"]];
function seg(hostId, opts, cur, key) {
  const host = $(hostId); host.textContent = "";
  for (const [val, label] of opts) { const b = document.createElement("button"); b.textContent = label;
    b.className = val === cur ? "sel" : ""; b.onclick = () => { SFX.unlock(); S.conn.send({ t: "settings", patch: { [key]: val } }); }; host.appendChild(b); }
}
function renderLobby(st) {
  const grid = $("player-grid"); grid.textContent = "";
  const humans = st.players.filter((p) => !p.bot);
  for (const p of humans) {
    const card = document.createElement("div");
    card.className = "player-card" + (p.ready ? " is-ready" : "") + (p.connected ? "" : " is-away");
    const av = document.createElement("div"); av.className = "pc-avatar"; Hub.fillAvatar(av, p);
    const meta = document.createElement("div");
    const nm = document.createElement("div"); nm.className = "pc-name"; nm.textContent = p.name;
    if (p.pid === S.pid) { const y = document.createElement("span"); y.className = "you-tag"; y.textContent = "YOU"; nm.appendChild(y); }
    const stt = document.createElement("div"); stt.className = "pc-status" + (p.ready ? " rdy" : "");
    stt.textContent = !p.connected ? "away" : p.ready ? "READY" : "not ready";
    meta.appendChild(nm); meta.appendChild(stt); card.appendChild(av); card.appendChild(meta); grid.appendChild(card);
  }
  const readyN = humans.filter((p) => p.ready && p.connected).length;
  $("ready-count").textContent = `${readyN} READY`;
  const ts = st.settings.players, fill = Math.max(humans.length, ts) - humans.length;
  $("seat-note").textContent = fill > 0 ? `${fill} bot${fill > 1 ? "s" : ""} fill the court` : "full human court";
  seg("opt-players", PLAYERS, st.settings.players, "players");
  seg("opt-mode", MODES, st.settings.mode, "mode");
  seg("opt-lives", LIVESO, st.settings.lives, "lives");
  seg("opt-diff", DIFFS, st.settings.difficulty, "difficulty");
  $("balls-val").textContent = st.settings.balls;
  $("assist-btn").textContent = S.assist ? "ON" : "OFF"; $("assist-btn").classList.toggle("on", S.assist);
  const me = st.you, amReady = !!(me && me.ready);
  $("ready-btn").textContent = amReady ? "READY ✓" : "READY UP"; $("ready-btn").classList.toggle("is-ready", amReady);
  $("go-btn").hidden = !(readyN >= st.min_players && amReady && st.phase === "lobby");
  $("lobby-hint").textContent = st.phase === "countdown" ? "GET READY…" : readyN >= st.min_players ? "court's hot — start it!" : `waiting — ${location.host}`;
}

let goShown = false;
function renderGameOver(st) {
  const g = game(); const show = st.phase === "game_end" && g && g.result;
  $("gameover").hidden = !show;
  if (!show) { goShown = false; return; }
  const r = g.result;
  let title, line;
  if (g.mode === "teams") {
    const win = r.winner_team; title = win == null ? "DRAW" : `TEAM ${win === 0 ? "CYAN" : "PINK"} WINS`;
    line = "last team standing";
  } else {
    const w = r.winner_pids[0]; const wp = st.players.find((p) => p.pid === w);
    title = wp ? wp.name.toUpperCase() + " WINS" : "DRAW"; line = "last one standing";
  }
  $("go-title").textContent = title; $("go-line").textContent = line;
  if (!goShown) { goShown = true; Hub.confettiBurst(200); SFX.win();
    if (r.winner_seats.includes(S.mySeat)) setTimeout(() => Hub.confettiBurst(160), 500); }
}

/* ---------- state entry ---------- */
function onState(st) {
  S.st = st;
  if (!S.joined) return;
  if (st.phase === "lobby" || st.phase === "countdown") { show("scr-lobby"); renderLobby(st); }
  else if (st.game) {
    show("scr-game");
    S.mySeat = st.game.my_seat;
    onSnapshot(st.game, st.now);
  }
  $("countdown-overlay").hidden = st.phase !== "countdown";
}

/* ---------- boot ---------- */
function connect() { S.conn = Hub.connect("/games/dodgeball/ws", { onWelcome: (m) => { S.pid = m.pid; }, onState, onFx }); }
let avatarPick = Hub.identity.avatar || Hub.AVATARS[(Math.random() * Hub.AVATARS.length) | 0];
resize(); bindTouch(); requestAnimationFrame(raf);

$("join-btn").onclick = () => { SFX.unlock(); Hub.identity.name = $("name-input").value.trim() || "PLAYER"; Hub.identity.avatar = avatarPick; S.joined = true; connect(); show("scr-lobby"); };
$("name-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("join-btn").click(); });
$("ready-btn").onclick = () => { SFX.unlock(); const me = S.st?.you; S.conn.send({ t: "ready", ready: !(me && me.ready) }); };
$("go-btn").onclick = () => { SFX.unlock(); S.conn.send({ t: "start" }); };
$("balls-minus").onclick = () => S.conn.send({ t: "settings", patch: { balls: Math.max(2, (S.st?.settings.balls || 4) - 1) } });
$("balls-plus").onclick = () => S.conn.send({ t: "settings", patch: { balls: Math.min(8, (S.st?.settings.balls || 4) + 1) } });
$("assist-btn").onclick = () => { S.assist = !S.assist; localStorage.setItem("db-assist", S.assist ? "1" : "0"); if (S.st) renderLobby(S.st); };
$("rematch-btn").onclick = () => S.conn.send({ t: "again" });

/* brag */
if (window.Brag) {
  const btn = Brag.button(() => {
    const g = game(); if (!g || !g.result) return null;
    const st = S.st, r = g.result;
    const winSeats = r.winner_seats;
    const winner = g.units.find((u) => u.seat === winSeats[0]);
    const wp = winner ? st.players.find((p) => p.pid === winner.pid) : null;
    const losers = g.units.filter((u) => !winSeats.includes(u.seat)).map((u) => ({ name: u.name }));
    return { title: "Dodgeball", icon: "🏐",
      winner: { name: wp ? wp.name : (g.mode === "teams" ? "Team" : "?"), avatar: wp ? wp.avatar : "🏐", pfp: wp ? wp.pfp : null },
      headline: g.mode === "teams" ? "last team standing" : "last one standing", beaten: losers.slice(0, 4) };
  });
  document.querySelector("#gameover .modal-card").insertBefore(btn, $("rematch-btn"));
}

function wireMute(btn) { btn.textContent = S.muted ? "🔇" : "🔊"; btn.onclick = () => { S.muted = !S.muted; localStorage.setItem("wc-muted", S.muted ? "1" : "0"); $("mute-btn").textContent = S.muted ? "🔇" : "🔊"; }; }
wireMute($("mute-btn"));
Hub.wirePfpButton($("pfp-btn"), () => S.conn); Hub.wirePfpButton($("pfp-btn2"), () => S.conn);
Hub.buildAvatarGrid($("avatar-grid"), avatarPick, (a) => { avatarPick = a; });
$("name-input").value = Hub.identity.name;
if (Hub.identity.name) { S.joined = true; connect(); show("scr-lobby"); } else show("scr-join");
