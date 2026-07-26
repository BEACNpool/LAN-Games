/* BRICKADE client. Server-authoritative realtime sim (the dodgeball engine):
   buffer snapshots, render interpolated ~85ms behind, predict own paddle, send
   coalesced input. The whole arena is ROTATED per-client so YOUR goal is always
   at the bottom. Everything draws on one canvas. */
"use strict";

const $ = (id) => document.getElementById(id);
const INTERP = 85;                 // ms interpolation buffer
const CX = 500, CY = 500;
const PADDLE_SPEED = 1050;          // mirror of physics.PADDLE_SPEED (px/s), for prediction

const COLORS = ["#22d3ee", "#f472b6", "#eab308", "#10c96e", "#a855f7", "#fb7185", "#38bdf8", "#f97316"];
const PU = {
  big:   { icon: "🏓", label: "BIG PADDLE", col: "#22d3ee" },
  multi: { icon: "🔮", label: "MULTIBALL",  col: "#a855f7" },
  phase: { icon: "👻", label: "PHASE",      col: "#c4b5fd" },
  slow:  { icon: "🐢", label: "SLOW-MO",    col: "#38bdf8" },
  over:  { icon: "🔥", label: "OVERDRIVE",  col: "#f97316" },
  shield:{ icon: "🛡", label: "SHIELD",     col: "#10c96e" },
};

const S = {
  st: null, pid: null, mySeat: null, myAngle: null, conn: null, joined: false,
  muted: localStorage.getItem("wc-muted") === "1",
  buf: [], lastTick: -1,
  wantF: 0.5, controlling: false, wantAct: false,
  pred: { active: false, qc: 0 },
  sent: { f: 0.5, at: 0 },
  cam: { sc: 1, ox: 0, oy: 0, rot: 0 },
  trails: new Map(), shake: 0, particles: [], rings: [], floaters: [],
  flash: { a: 0, color: "#ffffff" }, goShown: false,
  prevPhase: null, gameEnteredAt: 0, tutorialTimer: 0, bannerTimer: 0, hudSig: "", lastCount: null,
};

/* ---------- audio ---------- */
const SFX = (() => {
  let ctx = null, master = null;
  const ac = () => {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16; comp.knee.value = 14; comp.ratio.value = 7;
      master = ctx.createGain(); master.gain.value = 0.82;
      master.connect(comp); comp.connect(ctx.destination);
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  };
  function tone(f, type, dur, vol = 0.12, when = 0, glide = 0) {
    if (S.muted) return;
    try { const c = ac(), t = c.currentTime + when, o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(f, t);
      if (glide) o.frequency.exponentialRampToValueAtTime(Math.max(40, f + glide), t + dur);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.04);
    } catch (e) {}
  }
  function noise(dur = 0.08, vol = 0.035, cutoff = 900, when = 0) {
    if (S.muted) return;
    try {
      const c = ac(), t = c.currentTime + when, frames = Math.ceil(c.sampleRate * dur);
      const buffer = c.createBuffer(1, frames, c.sampleRate), data = buffer.getChannelData(0);
      for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
      const src = c.createBufferSource(), filter = c.createBiquadFilter(), gain = c.createGain();
      src.buffer = buffer; filter.type = "lowpass"; filter.frequency.value = cutoff;
      gain.gain.setValueAtTime(vol, t); gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(filter); filter.connect(gain); gain.connect(master); src.start(t); src.stop(t + dur);
    } catch (e) {}
  }
  return {
    unlock: () => { try { ac(); } catch (e) {} },
    save: () => { tone(260, "sine", 0.1, 0.09, 0, 260); noise(0.055, 0.028, 1500); },
    wall: () => tone(220, "sine", 0.06, 0.05, 0, 90),
    brick: () => { tone(430, "square", 0.045, 0.055, 0, 80); noise(0.05, 0.023, 2100); },
    special: () => { [520, 780].forEach((f, i) => tone(f, "triangle", 0.1, 0.08, i * 0.04)); noise(0.1, 0.025, 3500); },
    arm: () => [660, 990, 1320].forEach((f, i) => tone(f, "sine", 0.11, 0.075, i * 0.05)),
    use: () => { tone(180, "sawtooth", 0.2, 0.08, 0, 900); noise(0.12, 0.04, 1900); },
    goal: () => { tone(160, "square", 0.19, 0.13); tone(90, "sawtooth", 0.27, 0.1, 0, -40); noise(0.2, 0.065, 620); },
    shield: () => tone(520, "triangle", 0.12, 0.09),
    elim: () => [392, 330, 262].forEach((f, i) => tone(f, "sawtooth", 0.22, 0.11, i * 0.09)),
    whistle: () => { tone(1200, "sine", 0.14, 0.12); tone(1600, "sine", 0.14, 0.1, 0.12); },
    countdown: (n) => tone(n <= 1 ? 980 : 520 + (3 - n) * 120, "square", 0.08, n <= 1 ? .1 : .055),
    win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, "sine", 0.24, 0.12, i * 0.1)),
    bad: () => tone(140, "sawtooth", 0.18, 0.07, 0, -60),
  };
})();
function buzz(p) { if (navigator.vibrate) try { navigator.vibrate(p); } catch (e) {} }

/* ---------- helpers ---------- */
const cv = $("cv"), ctx = cv.getContext("2d");
function game() { return S.st && S.st.game ? S.st.game : null; }
function latest() { return S.buf.length ? S.buf[S.buf.length - 1].g : game(); }
function nowSrv() { return S.conn ? S.conn.now() : Date.now(); }
function DPR() { return Math.min(2, window.devicePixelRatio || 1); }
function show(id) { for (const s of ["scr-join", "scr-lobby", "scr-game"]) $(s).hidden = s !== id; }
function seatColor(seat) { return seat == null ? "#cbd5e1" : COLORS[seat % COLORS.length]; }
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
function lerp(a, b, t) { return a + (b - a) * t; }

/* ---------- snapshot buffer + interpolation ---------- */
function onSnapshot(g, srv) {
  if (g.tick === S.lastTick) return;
  S.lastTick = g.tick;
  S.buf.push({ tick: g.tick, srv, g });
  if (S.buf.length > 10) S.buf.shift();
}
function interpFrame() {
  const rt = nowSrv() - INTERP, b = S.buf;
  if (!b.length) return null;
  let a = b[0], c = b[b.length - 1];
  for (let i = 0; i < b.length - 1; i++) { if (b[i].srv <= rt && b[i + 1].srv >= rt) { a = b[i]; c = b[i + 1]; break; } }
  const span = c.srv - a.srv, t = span > 0 ? clamp((rt - a.srv) / span, 0, 1) : 0;
  return { a: a.g, b: c.g, t };
}
function ballAt(fr, id) {
  const A = fr.a.balls.find((x) => x.id === id), B = fr.b.balls.find((x) => x.id === id);
  if (!A) return B; if (!B) return A;
  return { ...B, x: lerp(A.x, B.x, fr.t), y: lerp(A.y, B.y, fr.t) };
}
function goalEdge(g, seat) { return g ? g.edges.find((e) => e.owner === seat) : null; }
function paddleAt(fr, seat) {
  const A = goalEdge(fr.a, seat), B = goalEdge(fr.b, seat);
  if (!A || !A.p0) return B; if (!B || !B.p0) return A;
  return { p0: [lerp(A.p0[0], B.p0[0], fr.t), lerp(A.p0[1], B.p0[1], fr.t)],
           p1: [lerp(A.p1[0], B.p1[0], fr.t), lerp(A.p1[1], B.p1[1], fr.t)] };
}

/* ---------- rotation + camera ---------- */
function rotP(x, y) {
  const r = S.cam.rot, dx = x - CX, dy = y - CY, c = Math.cos(r), s = Math.sin(r);
  return [CX + dx * c - dy * s, CY + dx * s + dy * c];
}
function W2S(x, y) { const [rx, ry] = rotP(x, y); return [S.cam.ox + rx * S.cam.sc, S.cam.oy + ry * S.cam.sc]; }
function camera(g) {
  S.cam.rot = (S.mySeat != null && S.myAngle != null) ? (Math.PI / 2 - S.myAngle) : 0;
  let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
  for (const e of g.edges) for (const p of [e.a, e.b]) {
    const [rx, ry] = rotP(p[0], p[1]);
    if (rx < minx) minx = rx; if (rx > maxx) maxx = rx;
    if (ry < miny) miny = ry; if (ry > maxy) maxy = ry;
  }
  const M = 42;                                  // world margin (tags + health markers)
  minx -= M; maxx += M; miny -= M; maxy += M;
  const d = DPR(), portrait = cv.height > cv.width * 1.12;
  const sidePad = (portrait ? 10 : 34) * d;
  const topPad = (portrait ? (innerHeight < 700 ? 58 : 68) : 72) * d;
  const botPad = (portrait ? (innerHeight < 700 ? 104 : 122) : 96) * d;
  const bw = maxx - minx, bh = maxy - miny;
  const availW = cv.width - sidePad * 2, availH = cv.height - topPad - botPad;
  S.cam.sc = Math.min(availW / bw, availH / bh);
  const dw = bw * S.cam.sc, dh = bh * S.cam.sc;
  S.cam.ox = (cv.width - dw) / 2 - minx * S.cam.sc;
  S.cam.oy = topPad + (availH - dh) / 2 - miny * S.cam.sc;
}

/* ---------- input (paddle drag + power-up button) ---------- */
const IN = { pad: { id: null }, actBtnDown: false };
function localXY(t) { const r = cv.getBoundingClientRect(); return { x: (t.clientX - r.left) * DPR(), y: (t.clientY - r.top) * DPR() }; }
function actBtn() { const d = DPR(); return { x: cv.width - 66 * d, y: cv.height - 60 * d, r: 44 * d }; }
function inActBtn(p) { const b = actBtn(); return Math.hypot(p.x - b.x, p.y - b.y) <= b.r * 1.15; }

function projectFinger(p) {
  const g = latest(), e = goalEdge(g, S.mySeat); if (!e || !e.p0) return;
  const [ax, ay] = W2S(e.a[0], e.a[1]), [bx, by] = W2S(e.b[0], e.b[1]);
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
  S.wantF = clamp(((p.x - ax) * dx + (p.y - ay) * dy) / L2, 0, 1);
  S.controlling = true;
}
function tStart(id, p) {
  if (!IN.actBtnDown && inActBtn(p)) { IN.actBtnDown = true; IN.actId = id; fireAct(); return; }
  if (IN.pad.id === null) { IN.pad.id = id; projectFinger(p); }
}
function tMove(id, p) { if (id === IN.pad.id) projectFinger(p); }
function tEnd(id) {
  if (id === IN.pad.id) { IN.pad.id = null; S.controlling = false; }
  if (id === IN.actId) { IN.actBtnDown = false; IN.actId = null; }
}
function fireAct() {
  const g = game();
  if (!g || !g.inv) { SFX.bad(); buzz(8); showEvent("POWER EMPTY", "BREAK A ✦ BRICK TO CHARGE", "#7b86a3"); return; }
  S.conn && S.conn.send({ t: "act" }); S.wantAct = true; buzz(18);
}
function bindTouch() {
  const opt = { passive: false };
  cv.addEventListener("touchstart", (e) => { e.preventDefault(); SFX.unlock(); for (const t of e.changedTouches) tStart(t.identifier, localXY(t)); }, opt);
  cv.addEventListener("touchmove", (e) => { e.preventDefault(); for (const t of e.changedTouches) tMove(t.identifier, localXY(t)); }, opt);
  cv.addEventListener("touchend", (e) => { e.preventDefault(); for (const t of e.changedTouches) tEnd(t.identifier); }, opt);
  cv.addEventListener("touchcancel", (e) => { e.preventDefault(); for (const t of e.changedTouches) tEnd(t.identifier); }, opt);
  let mid = null;
  cv.addEventListener("mousedown", (e) => { SFX.unlock(); mid = 1; tStart(1, localXY(e)); });
  cv.addEventListener("mousemove", (e) => { if (mid) tMove(1, localXY(e)); });
  cv.addEventListener("mouseup", () => { if (mid) { tEnd(1); mid = null; } });
  cv.addEventListener("contextmenu", (e) => e.preventDefault());
}

/* ---------- coalesced input send ---------- */
function pumpInput() {
  const g = game(); if (!g || S.mySeat == null) return;
  const dt = performance.now() - S.sent.at;
  const changed = Math.abs(S.wantF - S.sent.f) > 0.004;
  if ((S.controlling && changed && dt > 90) || dt > 300) {
    S.conn && S.conn.send({ t: "paddle", p: +S.wantF.toFixed(4) });
    S.sent = { f: S.wantF, at: performance.now() };
  }
}

/* ---------- my-paddle prediction (in edge-center q-space) ---------- */
function qOf(e, x, y) { return (x - e.a[0]) * e.u[0] + (y - e.a[1]) * e.u[1]; }
function predictMyPaddle(g, dt) {
  const e = goalEdge(g, S.mySeat); if (!e || !e.p0) { S.pred.active = false; return null; }
  const half = Math.hypot(e.p1[0] - e.p0[0], e.p1[1] - e.p0[1]) / 2;
  const serverQc = (qOf(e, e.p0[0], e.p0[1]) + qOf(e, e.p1[0], e.p1[1])) / 2;
  if (!S.pred.active) { S.pred.qc = serverQc; S.pred.active = true; }
  const target = S.controlling ? clamp(S.wantF * e.s, half, e.s - half) : serverQc;
  const step = PADDLE_SPEED * dt;
  S.pred.qc += clamp(target - S.pred.qc, -step, step);
  const gap = Math.abs(serverQc - S.pred.qc);
  S.pred.qc += (serverQc - S.pred.qc) * (gap > 55 ? 1 : 0.12);
  S.pred.qc = clamp(S.pred.qc, half, e.s - half);
  return { p0: [e.a[0] + e.u[0] * (S.pred.qc - half), e.a[1] + e.u[1] * (S.pred.qc - half)],
           p1: [e.a[0] + e.u[0] * (S.pred.qc + half), e.a[1] + e.u[1] * (S.pred.qc + half)] };
}

/* ---------- render ---------- */
function resize() { const d = DPR(); cv.width = Math.round(innerWidth * d); cv.height = Math.round(innerHeight * d); }
addEventListener("resize", resize); addEventListener("orientationchange", resize);
if (window.visualViewport) visualViewport.addEventListener("resize", resize);

let lastFrame = 0;
function raf(ts) {
  requestAnimationFrame(raf);
  const dt = lastFrame ? Math.min(0.05, (ts - lastFrame) / 1000) : 0.016; lastFrame = ts;
  const st = S.st; if (!st) return;
  if (st.phase === "countdown") {
    const n = Math.max(1, Math.ceil((st.deadline - nowSrv()) / 1000));
    $("countdown-num").textContent = n;
    if (n !== S.lastCount) { S.lastCount = n; SFX.countdown(n); if (n === 1) buzz(12); }
  } else S.lastCount = null;
  $("countdown-overlay").hidden = st.phase !== "countdown";
  const g = game();
  if (!g || (st.phase !== "play" && st.phase !== "game_end")) { ctx.clearRect(0, 0, cv.width, cv.height); return; }
  const L = latest(); if (!L) return;
  S.mySeat = g.my_seat; S.myAngle = g.my_angle;
  camera(L);
  const fr = interpFrame();

  S.shake = Math.max(0, S.shake - 1.2 * dt);
  S.flash.a = Math.max(0, S.flash.a - 2.4 * dt);
  const sh = S.shake * S.shake, mag = 12 * DPR() * sh;
  const shx = mag * Math.sin(ts * 0.05), shy = mag * Math.cos(ts * 0.043);
  ctx.clearRect(0, 0, cv.width, cv.height);
  drawBackdrop(L, ts);
  ctx.save(); ctx.translate(shx, shy);

  drawArena(L, ts);
  drawBricks(L, ts);
  // paddles
  for (const e of L.edges) {
    if (e.kind !== "goal" || !e.alive) continue;
    let pd;
    if (e.owner === S.mySeat) pd = predictMyPaddle(L, dt) || (fr ? paddleAt(fr, e.owner) : e);
    else pd = fr ? paddleAt(fr, e.owner) : e;
    if (pd && pd.p0) drawPaddle(e, pd, ts);
  }
  // balls
  const balls = fr ? L.balls.map((b) => ({ ...b, ...ballAt(fr, b.id) })) : L.balls;
  for (const b of balls) drawBall(b, ts);
  drawIncomingChevrons(L, balls);
  drawParticles(dt);
  drawRings(dt);
  drawFloaters(dt);
  ctx.restore();

  drawScreenFlash();
  updateGameChrome(L);
  pumpInput();
  renderGameOver(st);
}

function traceArena(g, factor = 1) {
  ctx.beginPath();
  for (let i = 0; i < g.edges.length; i++) {
    const p = g.edges[i].a, wx = CX + (p[0] - CX) * factor, wy = CY + (p[1] - CY) * factor;
    const [sx, sy] = W2S(wx, wy);
    if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
  }
  ctx.closePath();
}

function drawBackdrop(g, ts) {
  const d = DPR(), w = cv.width, h = cv.height;
  ctx.save();
  const base = ctx.createRadialGradient(w * 0.5, h * 0.43, 8 * d, w * 0.5, h * 0.45, Math.max(w, h) * 0.72);
  base.addColorStop(0, "#111431"); base.addColorStop(0.38, "#080b1d");
  base.addColorStop(0.72, "#040712"); base.addColorStop(1, "#02040b");
  ctx.fillStyle = base; ctx.fillRect(0, 0, w, h);

  // Deterministic animated light field: atmosphere without network assets.
  const starN = clamp(Math.round((w * h) / (22000 * d * d)), 48, 110);
  for (let i = 0; i < starN; i++) {
    const x = ((i * 193 + 47) % 997) / 997 * w;
    const y = ((i * 109 + 31) % 991) / 991 * h;
    const pulse = 0.12 + 0.36 * (1 + Math.sin(ts * 0.0011 + i * 1.73)) / 2;
    const r = (i % 13 === 0 ? 1.45 : 0.72) * d;
    ctx.globalAlpha = pulse; ctx.fillStyle = i % 9 === 0 ? "#32e7ff" : i % 11 === 0 ? "#ff4ecb" : "#cbd5ff";
    ctx.fillRect(x, y, r, r);
  }
  ctx.globalAlpha = 1;

  // Technical grid recedes behind the arena and gives the court physical scale.
  ctx.strokeStyle = "rgba(78,111,170,.055)"; ctx.lineWidth = 1 * d;
  const grid = 54 * d, drift = (ts * 0.004 * d) % grid;
  for (let x = -grid + drift; x < w + grid; x += grid) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + h * 0.13, h); ctx.stroke();
  }
  for (let y = -grid + drift * 0.55; y < h + grid; y += grid) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y + w * 0.05); ctx.stroke();
  }

  const [cx, cy] = W2S(CX, CY), halo = Math.min(w, h) * 0.46;
  const aura = ctx.createRadialGradient(cx, cy, 0, cx, cy, halo);
  aura.addColorStop(0, "rgba(157,92,255,.08)"); aura.addColorStop(0.58, "rgba(50,231,255,.025)");
  aura.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = aura; ctx.fillRect(cx - halo, cy - halo, halo * 2, halo * 2);
  ctx.restore();
}

function drawArena(g, ts) {
  const d = DPR(), [cxs, cys] = W2S(CX, CY);
  ctx.save();

  // Polygon court: layered glass, clipped grid, inner scoring lanes.
  traceArena(g);
  const floor = ctx.createRadialGradient(cxs, cys, 10 * d, cxs, cys, 440 * S.cam.sc);
  floor.addColorStop(0, "rgba(29,33,76,.72)");
  floor.addColorStop(0.52, "rgba(11,18,43,.64)");
  floor.addColorStop(1, "rgba(4,9,23,.88)");
  ctx.fillStyle = floor; ctx.shadowColor = "rgba(74,106,190,.34)"; ctx.shadowBlur = 28 * d; ctx.fill();
  ctx.shadowBlur = 0;

  ctx.save(); traceArena(g); ctx.clip();
  ctx.strokeStyle = "rgba(109,139,205,.075)"; ctx.lineWidth = 1 * d;
  const step = 52;
  for (let x = 100; x <= 900; x += step) {
    const [ax, ay] = W2S(x, 80), [bx, by] = W2S(x, 920);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  }
  for (let y = 100; y <= 900; y += step) {
    const [ax, ay] = W2S(80, y), [bx, by] = W2S(920, y);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  }
  const scanY = ((ts * 0.026) % Math.max(1, cv.height * 0.65)) + cv.height * 0.14;
  const scan = ctx.createLinearGradient(0, scanY - 18 * d, 0, scanY + 18 * d);
  scan.addColorStop(0, "rgba(50,231,255,0)"); scan.addColorStop(.5, "rgba(50,231,255,.035)");
  scan.addColorStop(1, "rgba(50,231,255,0)");
  ctx.fillStyle = scan; ctx.fillRect(0, scanY - 20 * d, cv.width, 40 * d);
  ctx.restore();

  for (const [factor, alpha] of [[0.76, .14], [0.5, .1]]) {
    traceArena(g, factor); ctx.strokeStyle = `rgba(92,128,196,${alpha})`; ctx.lineWidth = 1 * d; ctx.stroke();
  }
  ctx.setLineDash([5 * d, 9 * d]); ctx.lineDashOffset = -ts * 0.012;
  ctx.strokeStyle = "rgba(50,231,255,.15)"; ctx.lineWidth = 1 * d;
  ctx.beginPath(); ctx.arc(cxs, cys, 74 * S.cam.sc, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(192,205,255,.035)"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.font = `900 ${Math.round(44 * S.cam.sc)}px Sora`;
  ctx.fillText("BRICKADE", cxs, cys + 2 * S.cam.sc);

  // Edge rails, goal energy, and junction nodes.
  for (const e of g.edges) {
    const [ax, ay] = W2S(e.a[0], e.a[1]), [bx, by] = W2S(e.b[0], e.b[1]);
    const isGoal = e.kind === "goal", dead = isGoal && !e.alive, mine = e.owner === S.mySeat;
    const col = (!isGoal || dead) ? "#566079" : seatColor(e.owner);

    ctx.lineCap = "round";
    ctx.globalAlpha = dead ? .65 : 1;
    ctx.strokeStyle = "rgba(1,3,10,.94)"; ctx.lineWidth = (isGoal ? 13 : 11) * d;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    ctx.strokeStyle = col; ctx.lineWidth = (mine ? 6.5 : isGoal ? 4.5 : 4) * d;
    ctx.globalAlpha = dead ? .32 : mine ? .92 : isGoal ? .65 : .55;
    if (isGoal && !dead) {
      ctx.shadowColor = col; ctx.shadowBlur = (mine ? 22 : 12) * d;
    }
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;

    if (isGoal && !dead) {
      const pulse = (0.5 + 0.5 * Math.sin(ts * .004 + e.owner * 1.3));
      const t = (ts * 0.00008 + e.owner / Math.max(1, g.n)) % 1;
      const qx = lerp(ax, bx, t), qy = lerp(ay, by, t);
      ctx.fillStyle = col; ctx.globalAlpha = .38 + .28 * pulse;
      ctx.shadowColor = col; ctx.shadowBlur = 12 * d;
      ctx.beginPath(); ctx.arc(qx, qy, 2.4 * d, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0; ctx.globalAlpha = 1;
    }

    ctx.fillStyle = dead ? "#333a4d" : col; ctx.globalAlpha = dead ? .6 : .85;
    ctx.beginPath(); ctx.arc(ax, ay, 3.4 * d, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Sudden death is a visible pressure ring, not just a small text label.
  if (g.shrink < 0.999) {
    ctx.globalAlpha = 0.42 + 0.16 * Math.sin(ts * 0.008);
    ctx.strokeStyle = "#ff7a42"; ctx.lineWidth = 2 * d; ctx.setLineDash([10 * d, 7 * d]);
    ctx.lineDashOffset = -ts * 0.04; traceArena(g, .94); ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;
  }

  // Player identity plates live inside their edge, with health visible at a glance.
  const compact = cv.width / d < 450 && g.n > 4;
  for (const e of g.edges) {
    if (e.kind !== "goal" || e.hp == null) continue;
    if (compact && e.owner !== S.mySeat && e.owner % 2) continue;
    const mx = (e.a[0] + e.b[0]) / 2 + e.n[0] * (compact ? 20 : 25);
    const my = (e.a[1] + e.b[1]) / 2 + e.n[1] * (compact ? 20 : 25);
    const [sx, sy] = W2S(mx, my), col = seatColor(e.owner);
    const label = e.owner === S.mySeat ? "YOU" : String(e.name || `P${e.owner + 1}`).toUpperCase();
    const txt = label.slice(0, compact ? 5 : 10), pw = (compact ? 48 : 72) * d, ph = 19 * d;
    ctx.fillStyle = "rgba(3,7,17,.76)"; ctx.beginPath(); ctx.roundRect(sx - pw / 2, sy - ph / 2, pw, ph, ph / 2); ctx.fill();
    ctx.strokeStyle = e.alive ? `${col}88` : "rgba(99,109,135,.4)"; ctx.lineWidth = 1 * d; ctx.stroke();
    ctx.fillStyle = e.alive ? "#eaf0ff" : "#69728a";
    ctx.font = `800 ${Math.round((compact ? 7 : 8) * d)}px JBMono`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(e.alive ? txt : `${txt} · KO`, sx, sy + .5 * d);
  }
  ctx.restore();
}

function drawBricks(g, ts) {
  const d = DPR();
  for (const b of g.bricks) {
    const hw = b.w / 2, hh = b.h / 2;
    const c = [[b.x - hw, b.y - hh], [b.x + hw, b.y - hh], [b.x + hw, b.y + hh], [b.x - hw, b.y + hh]];
    ctx.beginPath();
    for (let i = 0; i < 4; i++) { const [sx, sy] = W2S(c[i][0], c[i][1]); if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy); }
    ctx.closePath();
    if (b.sp) {
      const p = 0.5 + 0.5 * Math.sin(ts * 0.006 + b.x * 0.01);
      const [sx, sy] = W2S(b.x, b.y);
      const grad = ctx.createRadialGradient(sx - 5 * d, sy - 5 * d, 1, sx, sy, Math.max(12 * d, hw * S.cam.sc));
      grad.addColorStop(0, "#f8f0ff"); grad.addColorStop(.14, "#d996ff");
      grad.addColorStop(.52, "#8e3ce4"); grad.addColorStop(1, "#35135e");
      ctx.fillStyle = grad;
      ctx.shadowColor = "#b95cff"; ctx.shadowBlur = (9 + 10 * p) * d; ctx.fill(); ctx.shadowBlur = 0;
      ctx.strokeStyle = `rgba(240,219,255,${.68 + .3 * p})`; ctx.lineWidth = 1.2 * d; ctx.stroke();
      ctx.fillStyle = "#fff"; ctx.font = `${Math.round(12 * d)}px Sora`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.shadowColor = "#fff"; ctx.shadowBlur = 8 * d;
      ctx.fillText("✦", sx, sy); ctx.textBaseline = "alphabetic";
      ctx.shadowBlur = 0;
    } else {
      const [sx, sy] = W2S(b.x, b.y), grad = ctx.createLinearGradient(sx - 18 * d, sy - 9 * d, sx + 18 * d, sy + 9 * d);
      grad.addColorStop(0, "rgba(90,115,169,.92)"); grad.addColorStop(.48, "rgba(130,151,202,.95)");
      grad.addColorStop(1, "rgba(48,65,108,.94)");
      ctx.fillStyle = grad; ctx.shadowColor = "rgba(56,97,176,.3)"; ctx.shadowBlur = 4 * d; ctx.fill(); ctx.shadowBlur = 0;
      ctx.strokeStyle = "rgba(204,221,255,.28)"; ctx.lineWidth = 1 * d; ctx.stroke();
    }
  }
}

function drawBall(b, ts) {
  const d = DPR(), col = b.owner == null ? "#e5edf7" : seatColor(b.owner);
  // Velocity-reactive ribbon trail.
  let tr = S.trails.get(b.id); if (!tr) { tr = []; S.trails.set(b.id, tr); }
  tr.push([b.x, b.y]); if (tr.length > 16) tr.shift();
  if (tr.length > 1) {
    ctx.save(); ctx.lineCap = "round"; ctx.lineJoin = "round";
    for (let i = 1; i < tr.length; i++) {
      const [ax, ay] = W2S(tr[i - 1][0], tr[i - 1][1]), [bx, by] = W2S(tr[i][0], tr[i][1]);
      const p = i / tr.length;
      ctx.globalAlpha = .025 + p * .22; ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(.6 * d, 8 * S.cam.sc * p);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    }
    ctx.restore();
  }
  for (let i = 0; i < tr.length - 1; i++) {
    const [sx, sy] = W2S(tr[i][0], tr[i][1]);
    const p = i / tr.length;
    ctx.globalAlpha = p * 0.2;
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(sx, sy, 9 * S.cam.sc * p, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  const [sx, sy] = W2S(b.x, b.y), r = 12.3 * S.cam.sc;
  const over = b.over, slow = b.slow, phase = b.phase;
  let glow = col, gr = over ? r * 3.2 : r * 2.15;
  if (over) glow = "#f97316"; else if (slow) glow = "#38bdf8";
  ctx.globalAlpha = phase ? 0.5 : 1;
  const aura = ctx.createRadialGradient(sx, sy, r * .5, sx, sy, gr);
  aura.addColorStop(0, `${glow}8f`); aura.addColorStop(1, `${glow}00`);
  ctx.fillStyle = aura; ctx.globalAlpha *= .75; ctx.beginPath(); ctx.arc(sx, sy, gr, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = phase ? 0.55 : 1;
  const g2 = ctx.createRadialGradient(sx - r * 0.3, sy - r * 0.3, r * 0.2, sx, sy, r);
  g2.addColorStop(0, "#ffffff"); g2.addColorStop(1, glow);
  ctx.fillStyle = g2; ctx.shadowColor = glow; ctx.shadowBlur = (over ? 19 : 11) * d;
  ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
  if (phase) { ctx.strokeStyle = "#e9d5ff"; ctx.lineWidth = 1.5 * d; ctx.setLineDash([4 * d, 4 * d]); ctx.stroke(); ctx.setLineDash([]); }
  else { ctx.strokeStyle = "rgba(0,0,0,.3)"; ctx.lineWidth = 1.2 * d; ctx.stroke(); }
  if (over || slow) {
    ctx.strokeStyle = glow; ctx.globalAlpha = .55; ctx.lineWidth = 1.2 * d;
    ctx.beginPath(); ctx.arc(sx, sy, r * 1.5, ts * .004, ts * .004 + Math.PI * 1.25); ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawPaddle(e, pd, ts) {
  const d = DPR(), col = seatColor(e.owner), mine = e.owner === S.mySeat;
  const [ax, ay] = W2S(pd.p0[0], pd.p0[1]), [bx, by] = W2S(pd.p1[0], pd.p1[1]);
  ctx.save(); ctx.lineCap = "round";
  if (e.shield) {
    const pulse = .72 + .22 * Math.sin(ts * .008);
    ctx.strokeStyle = "#20e68a"; ctx.globalAlpha = pulse; ctx.lineWidth = 20 * d;
    ctx.shadowColor = "#20e68a"; ctx.shadowBlur = 20 * d;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.shadowBlur = 0; ctx.globalAlpha = 1;
  }
  // Deep extrusion gives the paddle a solid, premium arcade-controller feel.
  ctx.strokeStyle = "rgba(0,0,0,.72)"; ctx.lineWidth = 17 * d;
  ctx.beginPath(); ctx.moveTo(ax, ay + 2 * d); ctx.lineTo(bx, by + 2 * d); ctx.stroke();
  ctx.strokeStyle = col; ctx.globalAlpha = mine ? .58 : .42; ctx.lineWidth = 15 * d;
  ctx.shadowColor = col; ctx.shadowBlur = (mine ? 20 : 11) * d;
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  ctx.shadowBlur = 0; ctx.globalAlpha = 1;
  ctx.strokeStyle = mine ? "#f8fbff" : col; ctx.lineWidth = 10 * d;
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  ctx.strokeStyle = mine ? col : "rgba(255,255,255,.4)"; ctx.lineWidth = 3 * d;
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  for (const [x, y] of [[ax, ay], [bx, by]]) {
    ctx.fillStyle = mine ? "#fff" : col; ctx.shadowColor = col; ctx.shadowBlur = 9 * d;
    ctx.beginPath(); ctx.arc(x, y, 3.5 * d, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
  }
  ctx.restore();
}

function drawIncomingChevrons(g, balls) {
  if (S.mySeat == null) return;
  const e = goalEdge(g, S.mySeat); if (!e || !e.alive) return;
  const nx = e.n[0], ny = e.n[1];
  let best = null, bt = 1e9;
  for (const b of balls) {
    const vn = b.vx * nx + b.vy * ny; if (vn >= -1) continue;
    const tt = -((b.x - e.a[0]) * nx + (b.y - e.a[1]) * ny) / vn; if (tt <= 0 || tt > 1.6) continue;
    const q = (b.x + b.vx * tt - e.a[0]) * e.u[0] + (b.y + b.vy * tt - e.a[1]) * e.u[1];
    if (q < -20 || q > e.s + 20 || tt >= bt) continue;
    bt = tt; best = clamp(q, 0, e.s);
  }
  if (best == null) return;
  const wx = e.a[0] + e.u[0] * best - e.n[0] * -18, wy = e.a[1] + e.u[1] * best - e.n[1] * -18;
  const [sx, sy] = W2S(wx, wy), d = DPR(), a = clamp(1 - bt / 1.6, 0.3, 1);
  const danger = bt < .5, col = danger ? "#ff4f7f" : "#ffd45e";
  ctx.save(); ctx.globalAlpha = a; ctx.translate(sx, sy);
  ctx.strokeStyle = col; ctx.lineWidth = 2.4 * d; ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.shadowColor = col; ctx.shadowBlur = 9 * d;
  for (let i = 0; i < 2; i++) {
    const y = i * 8 * d;
    ctx.beginPath(); ctx.moveTo(-9 * d, y - 5 * d); ctx.lineTo(0, y + 4 * d); ctx.lineTo(9 * d, y - 5 * d); ctx.stroke();
  }
  if (danger) {
    ctx.fillStyle = col; ctx.font = `900 ${Math.round(7 * d)}px JBMono`; ctx.textAlign = "center";
    ctx.fillText("DANGER", 0, -13 * d);
  }
  ctx.restore();
}

/* ---------- particles ---------- */
function burst(x, y, n, color, spd, kind = "spark") {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, s = spd * (0.35 + Math.random() * .85);
    S.particles.push({
      x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
      life: 0.34 + Math.random() * 0.48, t: 0, color, kind,
      size: 1.4 + Math.random() * 3.2, spin: Math.random() * Math.PI,
    });
  }
  if (S.particles.length > 180) S.particles.splice(0, S.particles.length - 180);
}
function shockwave(x, y, color, size = 58) {
  S.rings.push({ x, y, color, size, t: 0, life: .46 });
}
function floater(x, y, text, color) {
  S.floaters.push({ x, y, text, color, t: 0, life: .8 });
}
function drawParticles(dt) {
  for (const p of S.particles) {
    p.t += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.93; p.vy *= 0.93;
    const [sx, sy] = W2S(p.x, p.y), a = Math.max(0, 1 - p.t / p.life);
    ctx.save(); ctx.globalAlpha = a; ctx.fillStyle = p.color; ctx.shadowColor = p.color; ctx.shadowBlur = 7 * DPR();
    ctx.translate(sx, sy); ctx.rotate(p.spin + p.t * 8);
    if (p.kind === "shard") {
      ctx.fillRect(-p.size * DPR() * 1.7, -p.size * DPR() * .4, p.size * DPR() * 3.4, p.size * DPR() * .8);
    } else {
      ctx.beginPath(); ctx.arc(0, 0, p.size * DPR() * (.35 + a * .65), 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  ctx.globalAlpha = 1;
  S.particles = S.particles.filter((p) => p.t < p.life);
}
function drawRings(dt) {
  for (const r of S.rings) {
    r.t += dt; const p = clamp(r.t / r.life, 0, 1), [sx, sy] = W2S(r.x, r.y);
    ctx.save(); ctx.globalAlpha = (1 - p) * .9; ctx.strokeStyle = r.color;
    ctx.lineWidth = Math.max(.6 * DPR(), (3 - p * 2) * DPR()); ctx.shadowColor = r.color; ctx.shadowBlur = 10 * DPR();
    ctx.beginPath(); ctx.arc(sx, sy, r.size * S.cam.sc * (.18 + p), 0, Math.PI * 2); ctx.stroke(); ctx.restore();
  }
  S.rings = S.rings.filter((r) => r.t < r.life);
}
function drawFloaters(dt) {
  for (const f of S.floaters) {
    f.t += dt; const p = clamp(f.t / f.life, 0, 1), [sx, sy] = W2S(f.x, f.y - p * 30);
    ctx.save(); ctx.globalAlpha = Math.sin(p * Math.PI); ctx.fillStyle = f.color;
    ctx.font = `900 ${Math.round(10 * DPR())}px JBMono`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.shadowColor = f.color; ctx.shadowBlur = 8 * DPR(); ctx.fillText(f.text, sx, sy); ctx.restore();
  }
  S.floaters = S.floaters.filter((f) => f.t < f.life);
}
function drawScreenFlash() {
  if (S.flash.a <= 0) return;
  const w = cv.width, h = cv.height, grad = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * .18, w / 2, h / 2, Math.max(w, h) * .7);
  grad.addColorStop(0, `${S.flash.color}00`); grad.addColorStop(1, `${S.flash.color}99`);
  ctx.save(); ctx.globalAlpha = S.flash.a; ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h); ctx.restore();
}
function flash(color, amount = .26) {
  S.flash.color = color; S.flash.a = Math.max(S.flash.a, amount);
}
function showEvent(title, sub, color = "#32e7ff") {
  const box = $("event-banner"); if (!box) return;
  clearTimeout(S.bannerTimer); box.hidden = true; void box.offsetWidth;
  $("event-title").textContent = title; $("event-sub").textContent = sub;
  box.style.setProperty("--event-color", color); box.hidden = false;
  S.bannerTimer = setTimeout(() => { box.hidden = true; }, 1500);
}

/* ---------- HUD ---------- */
function updateGameChrome(g) {
  const alive = g.edges.filter((e) => e.kind === "goal" && e.alive).length;
  const maxSpeed = g.balls.reduce((m, b) => Math.max(m, b.speed || 0), 0);
  const me = goalEdge(g, S.mySeat), inv = g.inv, meta = inv ? PU[inv] : null;
  const sig = [alive, Math.round(maxSpeed / 47), me && me.hp, me && me.alive, inv, me && me.name, g.shrink < .999].join("|");
  if (sig === S.hudSig) return;
  S.hudSig = sig;

  $("match-mode").textContent = g.shrink < .999 ? "SUDDEN DEATH" : (g.n <= 2 ? "DUEL PROTOCOL" : `${g.n}-NET ROYALE`);
  $("alive-count").textContent = `${alive} NET${alive === 1 ? "" : "S"}`;
  $("ball-speed").textContent = `BALL ${Math.max(1, maxSpeed / 470).toFixed(1)}×`;

  if (me) {
    const col = seatColor(S.mySeat);
    $("hud-color").style.background = col; $("hud-color").style.color = col;
    $("hud-name").textContent = me.alive ? (me.name || "KEEPER") : "ELIMINATED";
    const hp = $("health-pips"); hp.textContent = ""; hp.style.setProperty("--hud-color", col);
    hp.setAttribute("aria-label", `${Math.max(0, me.hp)} of ${g.lives} net health`);
    for (let i = 0; i < g.lives; i++) {
      const pip = document.createElement("i"); pip.className = i < me.hp ? "is-live" : ""; hp.appendChild(pip);
    }
  }

  const btn = $("power-btn");
  btn.classList.toggle("is-ready", !!meta); btn.classList.toggle("is-empty", !meta);
  btn.setAttribute("aria-disabled", meta ? "false" : "true");
  if (meta) {
    btn.style.setProperty("--power-color", meta.col);
    btn.setAttribute("aria-label", `${meta.label} ready. Tap to activate.`);
    $("power-icon").textContent = meta.icon; $("power-label").textContent = meta.label;
    $("power-state").textContent = "TAP TO UNLEASH";
  } else {
    btn.style.removeProperty("--power-color"); btn.setAttribute("aria-label", "Power-up not charged. Break a star brick.");
    $("power-icon").textContent = "✦"; $("power-label").textContent = "SMASH";
    $("power-state").textContent = "BREAK ✦ BRICKS";
  }
}

/* ---------- fx / juice ---------- */
function onFx(fx) {
  if (fx.kind === "toast") { Hub.toast((fx.icon ? fx.icon + " " : "") + fx.msg); return; }
  if (fx.kind === "match_start") { SFX.whistle(); showEvent("NETS HOT", "FIRST RETURN OWNS THE BALL", "#32e7ff"); return; }
  if (fx.kind === "game_over" || fx.kind === "invalid") { if (fx.kind === "invalid") SFX.bad(); return; }
  if (fx.kind !== "ev") return;
  const a = fx.a, e = fx.kind_;
  if (e === "save") {
    const col = seatColor(a[1]); S.shake += a[1] === S.mySeat ? .28 : .14; SFX.save();
    if (a[1] === S.mySeat) { buzz(15); showEvent("CLUTCH SAVE", "YOU OWN THE RETURN", col); }
    burst(a[2], a[3], 11, col, 235, "spark"); shockwave(a[2], a[3], col, 42); floater(a[2], a[3], "SAVE", col);
  }
  else if (e === "bounce") { SFX.wall(); }
  else if (e === "brick") {
    if (a[3]) {
      SFX.special(); burst(a[1], a[2], 20, "#b95cff", 270, "shard"); shockwave(a[1], a[2], "#b95cff", 54);
      floater(a[1], a[2], "POWER", "#dfb4ff"); flash("#9d5cff", .12);
    } else {
      SFX.brick(); burst(a[1], a[2], 9, "#9fb4df", 185, "shard"); shockwave(a[1], a[2], "#7794cf", 30);
    }
  }
  else if (e === "arm") {
    if (a[1] === S.mySeat) {
      const meta = PU[a[2]]; SFX.arm(); buzz([20, 30, 20]); flash(meta ? meta.col : "#9d5cff", .18);
      showEvent(meta ? meta.label : "POWER-UP", "CHARGED · TAP TO UNLEASH", meta ? meta.col : "#9d5cff");
    }
  }
  else if (e === "use") {
    const meta = PU[a[2]], col = meta ? meta.col : seatColor(a[1]);
    SFX.use(); flash(col, a[1] === S.mySeat ? .2 : .1);
    if (a[1] === S.mySeat) { buzz(25); showEvent(meta ? meta.label : "POWER-UP", "DEPLOYED", col); }
  }
  else if (e === "shield") {
    SFX.shield(); if (a[1] === S.mySeat) { buzz([12, 18, 12]); showEvent("SHIELD HOLD", "DAMAGE BLOCKED", "#20e68a"); }
  }
  else if (e === "goal") {
    const conceded = a[1], credit = a[2], col = credit >= 0 ? seatColor(credit) : "#ff4f7f";
    S.shake += .78; SFX.goal(); burst(a[3], a[4], 30, col, 340, "shard"); shockwave(a[3], a[4], col, 85); flash(col, .34);
    if (conceded === S.mySeat) { buzz([55, 35, 70]); showEvent("NET BREACHED", "LIFE LOST", "#ff4f7f"); }
    else if (credit === S.mySeat) { buzz([18, 25, 32]); showEvent("DIRECT HIT", "ENEMY NET DAMAGED", seatColor(S.mySeat)); }
  }
  else if (e === "eliminate") {
    S.shake += .9; SFX.elim(); flash("#ff4f7f", .3);
    showEvent(a[1] === S.mySeat ? "NET OFFLINE" : "KEEPER ELIMINATED", `${a[2]} NETS REMAIN`, "#ff4f7f");
  }
  else if (e === "storm_out") {
    S.shake += .68; SFX.elim(); flash("#ff7a42", .24);
    showEvent("STORM STRIKE", "WEAKEST NET ERASED", "#ff7a42");
  }
}

/* ---------- lobby ---------- */
const PLAYERS = [[2, "DUEL"], [3, "3"], [4, "4"], [6, "6"], [8, "8"]];
const LIVESO = [[1, "1"], [3, "3"], [5, "5"]];
const DIFFS = [["mixed", "MIXED"], ["easy", "EASY"], ["hard", "HARD"]];
const LAYOUTS = [["random", "RANDOM"], ["ring", "RING"], ["block", "BLOCK"], ["cross", "CROSS"], ["checker", "CHECKER"]];
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
  $("seat-note").textContent = fill > 0 ? `${fill} bot${fill > 1 ? "s" : ""} guard the other nets` : "full human table";
  seg("opt-players", PLAYERS, st.settings.players, "players");
  seg("opt-lives", LIVESO, st.settings.lives, "lives");
  seg("opt-diff", DIFFS, st.settings.difficulty, "difficulty");
  seg("opt-layout", LAYOUTS, st.settings.layout, "layout");
  const me = st.you, amReady = !!(me && me.ready);
  $("ready-btn").textContent = amReady ? "READY ✓" : "READY UP"; $("ready-btn").classList.toggle("is-ready", amReady);
  $("go-btn").hidden = !(readyN >= st.min_players && amReady && st.phase === "lobby");
  $("lobby-hint").textContent = st.phase === "countdown" ? "GET READY…" : readyN >= st.min_players ? "nets are hot — start it!" : `waiting — ${location.host}`;
}

function renderGameOver(st) {
  const g = game(), show = st.phase === "game_end" && g && g.result;
  $("gameover").hidden = !show;
  if (!show) { S.goShown = false; return; }
  const r = g.result, wp = st.players.find((p) => p.pid === r.winner_pid);
  const draw = r.draw || !r.winner_pid;
  const crown = document.querySelector("#gameover .go-crown");
  if (crown) crown.textContent = draw ? "🤝" : "🏆";
  $("go-title").textContent = draw ? "DRAW" : (wp ? wp.name.toUpperCase() + " WINS" : "WINNER");
  $("go-line").textContent = draw ? "a dead heat — every net fell together"
    : (g.n <= 2 ? "last net standing" : "last keeper standing");
  if (!S.goShown) { S.goShown = true; if (draw) SFX.bad(); else { Hub.confettiBurst(200); SFX.win();
    if (r.winner_seat === S.mySeat) setTimeout(() => Hub.confettiBurst(160), 500); } }
}

/* ---------- state entry ---------- */
function dismissTutorial() {
  clearTimeout(S.tutorialTimer);
  const card = $("tutorial-card"); if (card) card.hidden = true;
}
function showTutorial() {
  const card = $("tutorial-card"); if (!card) return;
  dismissTutorial(); card.hidden = false;
  S.tutorialTimer = setTimeout(dismissTutorial, 3800);
}
function onState(st) {
  const changed = st.phase !== S.prevPhase;
  S.st = st;
  if (!S.joined) return;
  if (st.phase === "lobby" || st.phase === "countdown") { show("scr-lobby"); renderLobby(st); }
  else if (st.game) {
    show("scr-game"); S.mySeat = st.game.my_seat; S.myAngle = st.game.my_angle; onSnapshot(st.game, st.now);
    if (st.phase === "play" && changed) {
      S.gameEnteredAt = performance.now(); S.hudSig = "";
      S.trails.clear(); S.particles.length = 0; S.rings.length = 0; S.floaters.length = 0;
      showTutorial();
    } else if (st.phase === "game_end") dismissTutorial();
  }
  $("countdown-overlay").hidden = st.phase !== "countdown";
  S.prevPhase = st.phase;
}

/* ---------- boot ---------- */
function connect() { S.conn = Hub.connect("/games/brickade/ws", { onWelcome: (m) => { S.pid = m.pid; }, onState, onFx }); }
let avatarPick = Hub.identity.avatar || Hub.AVATARS[(Math.random() * Hub.AVATARS.length) | 0];
resize(); bindTouch(); requestAnimationFrame(raf);

$("join-btn").onclick = () => { SFX.unlock(); Hub.identity.name = $("name-input").value.trim() || "PLAYER"; Hub.identity.avatar = avatarPick; S.joined = true; connect(); show("scr-lobby"); };
$("name-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("join-btn").click(); });
$("ready-btn").onclick = () => { SFX.unlock(); const me = S.st && S.st.you; S.conn.send({ t: "ready", ready: !(me && me.ready) }); };
$("go-btn").onclick = () => { SFX.unlock(); S.conn.send({ t: "start" }); };
$("rematch-btn").onclick = () => { dismissTutorial(); S.conn.send({ t: "again" }); };
$("tutorial-close").onclick = dismissTutorial;
$("power-btn").addEventListener("pointerdown", (e) => {
  e.preventDefault(); e.stopPropagation(); SFX.unlock(); fireAct();
});

/* brag */
if (window.Brag) {
  const btn = Brag.button(() => {
    const g = game(); if (!g || !g.result) return null;
    const st = S.st, r = g.result, wp = st.players.find((p) => p.pid === r.winner_pid);
    const losers = (r.standings || []).filter((s) => s.seat !== r.winner_seat)
      .map((s) => { const p = st.players.find((q) => q.pid === s.pid); return { name: p ? p.name : "Bot" }; });
    return { title: "Brickade", icon: "🧱",
      winner: { name: wp ? wp.name : "?", avatar: wp ? wp.avatar : "🧱", pfp: wp ? wp.pfp : null },
      headline: g.n <= 2 ? "last net standing" : "last keeper standing", beaten: losers.slice(0, 4) };
  });
  document.querySelector("#gameover .modal-card").insertBefore(btn, $("rematch-btn"));
}

function syncMuteButtons() {
  for (const btn of [$("mute-btn"), $("game-mute-btn")]) {
    if (!btn) continue;
    btn.textContent = S.muted ? "🔇" : "🔊";
    btn.setAttribute("aria-label", S.muted ? "Turn sound on" : "Mute sound");
  }
}
function wireMute(btn) {
  btn.onclick = (e) => {
    e.stopPropagation(); SFX.unlock(); S.muted = !S.muted;
    localStorage.setItem("wc-muted", S.muted ? "1" : "0"); syncMuteButtons();
  };
}
wireMute($("mute-btn")); wireMute($("game-mute-btn")); syncMuteButtons();
Hub.wirePfpButton($("pfp-btn"), () => S.conn); Hub.wirePfpButton($("pfp-btn2"), () => S.conn);
Hub.buildAvatarGrid($("avatar-grid"), avatarPick, (a) => { avatarPick = a; });
$("name-input").value = Hub.identity.name;
if (Hub.identity.name) { S.joined = true; connect(); show("scr-lobby"); } else show("scr-join");
