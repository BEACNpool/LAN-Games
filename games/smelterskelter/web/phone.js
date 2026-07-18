/* SMELTER SKELTER phone — a real controller, not a miniature game screen. */
"use strict";

const $ = (id) => document.getElementById(id);
const S = {
  st: null, conn: null, pid: null, joined: false, stateAt: 0,
  aim: 270, dragging: null, sentAim: null, sentAt: 0, pendingAim: null,
  aimTimer: null, hook: false, reel: false, goShown: false,
  lastTension: 0, lastAlive: true, lastCarrying: false,
};
const game = () => S.st?.game || null;
const player = (pid) => S.st?.players?.find((p) => p.pid === pid) || null;
const me = () => player(S.pid);

const Audio = (() => {
  let ctx = null;
  const ac = () => {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  };
  const tone = (f, type, dur, vol = .055, glide = 0) => {
    if (localStorage.getItem("wc-muted") === "1") return;
    try {
      const c = ac(), at = c.currentTime, o = c.createOscillator(), gain = c.createGain();
      o.type = type; o.frequency.setValueAtTime(f, at);
      if (glide) o.frequency.exponentialRampToValueAtTime(Math.max(35, f + glide), at + dur);
      gain.gain.setValueAtTime(.0001, at); gain.gain.exponentialRampToValueAtTime(vol, at + .012);
      gain.gain.exponentialRampToValueAtTime(.0001, at + dur);
      o.connect(gain); gain.connect(c.destination); o.start(at); o.stop(at + dur + .03);
    } catch (error) { /* optional */ }
  };
  return {
    unlock: () => { try { ac(); } catch (error) {} },
    tap: () => tone(620, "square", .045, .035),
    hook: () => { tone(180, "square", .06, .07); tone(420, "triangle", .12, .045, 160); },
    release: () => tone(160, "triangle", .07, .035, -60),
    cargo: () => { tone(440, "square", .08, .06); tone(880, "triangle", .16, .05, 220); },
    slam: () => tone(95, "sawtooth", .2, .09, -45),
    bad: () => tone(130, "sawtooth", .16, .05),
  };
})();

function buzz(pattern) {
  try { navigator.vibrate?.(pattern); } catch (error) { /* optional */ }
}
function show(id) {
  for (const sid of ["scr-join", "scr-lobby", "scr-pad", "scr-watch"])
    $(sid).hidden = sid !== id;
}
function seg(hostId, options, current, key) {
  const host = $(hostId); host.textContent = "";
  for (const [value, label] of options) {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = label; b.className = value === current ? "sel" : "";
    b.onclick = () => { Audio.tap(); S.conn.send({ t: "settings", patch: { [key]: value } }); };
    host.appendChild(b);
  }
}

function renderLobby(st) {
  const humans = st.players.filter((p) => !p.bot);
  const ready = humans.filter((p) => p.ready && p.connected).length;
  $("ready-count").textContent = `${ready} READY`;
  const grid = $("player-grid"); grid.textContent = "";
  for (const p of humans) {
    const card = document.createElement("div");
    card.className = "crew-card" + (p.ready ? " ready" : "") + (p.connected ? "" : " away");
    const av = document.createElement("span"); av.className = "crew-av"; Hub.fillAvatar(av, p);
    const meta = document.createElement("span"); meta.className = "crew-meta";
    const name = document.createElement("b"); name.textContent = p.name + (p.pid === S.pid ? " · YOU" : "");
    const status = document.createElement("small");
    status.textContent = !p.connected ? "signal lost" : p.ready ? "HARD HAT ON" : "not ready";
    meta.append(name, status); card.append(av, meta); grid.appendChild(card);
  }
  $("seat-note").textContent = humans.length < 2
    ? "Two workers minimum. Open the TV view and clock in another phone."
    : `${humans.length}/8 workers on the gantry · every phone gets the same controls`;
  seg("opt-shifts", [[2, "2"], [3, "3"]], st.settings.shifts, "shifts");
  seg("opt-clock", [[45, "45s"], [60, "60s"]], st.settings.shift_seconds, "shift_seconds");
  const amReady = !!st.you?.ready;
  $("ready-btn").textContent = amReady ? "READY ✓" : "READY UP";
  $("ready-btn").classList.toggle("is-ready", amReady);
  $("go-btn").hidden = !(st.phase === "lobby" && amReady && ready >= st.min_players);
  $("lobby-hint").textContent = st.phase === "countdown" ? "POWERING THE GANTRY…"
    : ready < st.min_players ? `need ${st.min_players} ready workers` : "any ready worker can start";
}

function clockText(seconds) {
  return String(Math.max(0, Math.ceil(Number(seconds) || 0)));
}
function setStatus(cls, copy) {
  const ribbon = $("status-ribbon");
  ribbon.className = "status-ribbon" + (cls ? ` ${cls}` : "");
  $("status-copy").textContent = copy;
}
function renderPad(st) {
  const g = game(); if (!g) return;
  show("scr-pad");
  $("shift-label").textContent = `SHIFT ${g.shift}/${g.shifts_total}`;
  $("worker-name").textContent = me()?.name || "WORKER";
  $("my-score").textContent = g.score ?? 0;
  $("shift-clock").textContent = clockText(g.shift_left);
  $("shift-clock").classList.toggle("hot", !!g.overload);
  $("scr-pad").classList.toggle("overload", !!g.overload);
  $("rank-copy").textContent = g.rank ? `#${g.rank}` : "—";
  const tension = Math.max(0, Math.min(1, Number(g.tension) || 0));
  $("tension-fill").style.width = `${Math.round(tension * 100)}%`;
  $("tension-copy").textContent = tension > .86 ? "REDLINE" : tension > .58 ? "TAUT" : tension > .12 ? "PULLING" : "SLACK";
  if (tension > .86 && S.lastTension <= .86) buzz(24);
  if (!S.dragging && Number.isFinite(g.aim) && S.sentAim === null) S.aim = g.aim;

  const alive = g.alive !== false;
  $("hook-btn").disabled = !alive;
  const reelOk = alive && !!g.hooked;
  $("reel-btn").disabled = !reelOk;
  if (!reelOk && S.reel) setEdge("reel", false);
  if (!alive) {
    setStatus("dead", `SMELTERED · SUPER HOOK IN ${clockText(g.respawn)}s`);
    $("pad-hint").textContent = "FALLING ISN'T FAILURE · YOUR COMEBACK HAS EXTRA RANGE";
  } else if (g.carrying) {
    setStatus("carrying", "YOU HAVE THE CARGO · HIT THE CHUTE");
    $("pad-hint").textContent = g.overload ? "DOUBLE CARGO · EVERYBODY IS COMING FOR YOU" : "HEAVY LOAD · KEEP YOUR SWING LOW";
  } else if (g.hooked) {
    setStatus("hooked", g.super ? "SUPER CHAIN LOCKED" : "CHAIN LOCKED · PUMP THE REEL");
    $("pad-hint").textContent = tension > .82 ? "REDLINE · RELEASE TO FLY" : "HOLD REEL NEAR THE BOTTOM OF YOUR ARC";
  } else if (g.super) {
    setStatus("hooked", "SUPER HOOK ARMED · EXTRA RANGE");
    $("pad-hint").textContent = "AIM HIGH · YOUR NEXT HOOK REACHES FARTHER";
  } else {
    setStatus("", "AIM FOR AN ANCHOR OR ANOTHER WORKER");
    $("pad-hint").textContent = g.overload ? "OVERLOAD · CARGO IS WORTH DOUBLE" : "HOOK · SWING LOW · RELEASE AT THE TOP";
  }
  if (!alive && S.lastAlive) releaseControls();
  if (g.carrying && !S.lastCarrying) { Audio.cargo(); buzz([45, 25, 80]); }
  S.lastAlive = alive; S.lastCarrying = !!g.carrying; S.lastTension = tension;
  drawAim();
}

function renderWatch(st) {
  show("scr-watch");
  const g = game();
  $("watch-copy").textContent = g
    ? `SHIFT ${g.shift}/${g.shifts_total} · ${clockText(g.shift_left)}s · YOU'RE WATCHING THIS RUN`
    : "CLOCK IN FOR THE NEXT SHIFT";
}

function resetInputCache() {
  if (S.aimTimer) clearTimeout(S.aimTimer);
  S.aimTimer = null; S.pendingAim = null; S.sentAim = null; S.sentAt = 0;
  S.aim = 270; S.dragging = null; S.lastTension = 0;
  S.lastAlive = true; S.lastCarrying = false;
}

function renderResults(st) {
  const g = st.game;
  const result = g?.result;
  const visible = st.phase === "game_end" && !!result;
  $("gameover").hidden = !visible;
  if (!visible) { S.goShown = false; return; }
  const rows = result.standings || [];
  const winner = player(result.winner || rows[0]?.pid);
  $("go-title").textContent = winner ? `${winner.name.toUpperCase()} OWNS THE GANTRY` : "SHIFT COMPLETE";
  $("go-line").textContent = `${result.crew_deliveries ?? rows.reduce((n, r) => n + (r.deliveries || 0), 0)} cargo deliveries · nobody went home clean`;
  const host = $("go-rows"); host.textContent = "";
  rows.forEach((r, index) => {
    const p = player(r.pid), row = document.createElement("div");
    row.className = "go-row" + (index === 0 ? " first" : "");
    const av = document.createElement("span"); av.className = "av"; Hub.fillAvatar(av, p);
    const name = document.createElement("span"); name.textContent = `${index + 1}. ${p?.name || "WORKER"}`;
    const score = document.createElement("b"); score.textContent = `${r.score} pts`;
    const detail = document.createElement("small"); detail.textContent = `${r.deliveries || 0} deliveries · ${r.steals || 0} steals · ${r.wipes || 0} wipes`;
    row.append(av, name, score, detail); host.appendChild(row);
  });
  if (!S.goShown) {
    S.goShown = true;
    if ((result.winner || rows[0]?.pid) === S.pid) { Hub.confettiBurst(180); Audio.cargo(); }
  }
}

function onState(st) {
  const resetInputs = !S.st || !["lobby", "countdown"].includes(S.st.phase);
  S.st = st; S.stateAt = performance.now();
  if (st.phase === "lobby" || st.phase === "countdown") {
    show("scr-lobby"); releaseControls();
    if (resetInputs) resetInputCache();
    renderLobby(st);
  } else if (st.game?.mode === "pad") renderPad(st);
  else renderWatch(st);
  renderResults(st);
  $("countdown-overlay").hidden = st.phase !== "countdown";
}

function fxMine(fx) { return !fx.pid || fx.pid === S.pid || fx.to === S.pid; }
function onFx(fx) {
  switch (fx.kind) {
    case "invalid": if (fx.msg) Hub.toast(fx.msg, "err"); Audio.bad(); break;
    case "hook": if (fxMine(fx)) { Audio.hook(); buzz(18); } break;
    case "release": if (fxMine(fx)) Audio.release(); break;
    case "slam": Audio.slam(); if (fxMine(fx)) buzz(34); break;
    case "pickup": if (fxMine(fx)) { Hub.toast("📦 YOU GRABBED THE CARGO"); Audio.cargo(); } break;
    case "steal": Audio.slam(); if (fxMine(fx)) Hub.toast(`⚡ CARGO STEAL +${fx.points || 1}`); break;
    case "delivery": Audio.cargo(); buzz([30, 25, 55]); if (fxMine(fx)) Hub.toast(`🔥 DELIVERY +${fx.points || 3}`); break;
    case "fall": Audio.slam(); if (fxMine(fx)) buzz([70, 35, 90]); break;
    case "cargo_boom": Audio.slam(); buzz(30); break;
    case "overload": Hub.toast("⚠ OVERLOAD — CARGO WORTH DOUBLE"); buzz([25, 30, 25]); break;
    case "shift_start": Hub.toast(`SHIFT ${fx.shift || ""} — GO!`); break;
    case "toast": if (fx.msg) Hub.toast((fx.icon ? `${fx.icon} ` : "") + fx.msg); break;
  }
}

/* Aim pad: local 60fps response, coalesced network updates at <=5.5/sec. */
const aimPad = $("aim-pad"), aimCanvas = $("aim-canvas"), aimCx = aimCanvas.getContext("2d");
function normDeg(d) { return (d % 360 + 360) % 360; }
function diffDeg(a, b) { return Math.abs(((a - b + 540) % 360) - 180); }
function sendAimNow() {
  S.aimTimer = null;
  const d = Math.round(normDeg(S.pendingAim ?? S.aim)); S.pendingAim = null;
  if (S.sentAim !== null && diffDeg(d, S.sentAim) < 7) return;
  S.sentAim = d; S.sentAt = performance.now(); S.conn?.send({ t: "aim", d });
}
function queueAim() {
  S.pendingAim = S.aim;
  const wait = Math.max(0, 180 - (performance.now() - S.sentAt));
  if (!S.aimTimer) S.aimTimer = setTimeout(sendAimNow, wait);
}
function aimFromEvent(e) {
  const r = aimPad.getBoundingClientRect(), dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
  if (Math.hypot(dx, dy) < 8) return;
  S.aim = normDeg(Math.atan2(dy, dx) * 180 / Math.PI); queueAim(); drawAim();
}
aimPad.addEventListener("pointerdown", (e) => {
  e.preventDefault(); Audio.unlock(); S.dragging = e.pointerId; aimPad.setPointerCapture(e.pointerId); aimFromEvent(e);
});
aimPad.addEventListener("pointermove", (e) => { if (e.pointerId === S.dragging) aimFromEvent(e); });
const endAim = (e) => { if (e.pointerId === S.dragging) { aimFromEvent(e); S.dragging = null; } };
aimPad.addEventListener("pointerup", endAim); aimPad.addEventListener("pointercancel", endAim);

function drawAim() {
  const r = aimPad.getBoundingClientRect(); if (!r.width) return;
  const dpr = Math.min(2, devicePixelRatio || 1), w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
  if (aimCanvas.width !== w) { aimCanvas.width = w; aimCanvas.height = h; }
  const cx = w / 2, cy = h / 2, rad = S.aim * Math.PI / 180, len = Math.min(w, h) * .36;
  aimCx.clearRect(0, 0, w, h); aimCx.save(); aimCx.translate(cx, cy);
  aimCx.rotate(rad); aimCx.fillStyle = "rgba(255,176,32,.06)"; aimCx.beginPath(); aimCx.moveTo(0, 0);
  aimCx.arc(0, 0, len * 1.18, -.56, .56); aimCx.closePath(); aimCx.fill();
  aimCx.strokeStyle = "#ffb020"; aimCx.lineWidth = 4 * dpr; aimCx.setLineDash([12 * dpr, 8 * dpr]);
  aimCx.beginPath(); aimCx.moveTo(16 * dpr, 0); aimCx.lineTo(len, 0); aimCx.stroke(); aimCx.setLineDash([]);
  aimCx.fillStyle = "#ffb020"; aimCx.shadowColor = "#ff7a18"; aimCx.shadowBlur = 18 * dpr;
  aimCx.beginPath(); aimCx.moveTo(len + 8 * dpr, 0); aimCx.lineTo(len - 13 * dpr, -10 * dpr); aimCx.lineTo(len - 13 * dpr, 10 * dpr); aimCx.closePath(); aimCx.fill(); aimCx.restore();
  const knobR = Math.min(r.width, r.height) * .29;
  $("aim-knob").style.transform = `translate(${Math.cos(rad) * knobR}px,${Math.sin(rad) * knobR}px)`;
}
addEventListener("resize", drawAim);

function setEdge(kind, on) {
  if (kind === "hook") {
    if (S.hook === on) return; S.hook = on; $("hook-btn").classList.toggle("active", on);
  } else {
    if (S.reel === on) return; S.reel = on; $("reel-btn").classList.toggle("active", on);
  }
  Audio.unlock(); if (on) Audio.tap(); S.conn?.send({ t: kind, on });
}
function wireHold(btn, kind) {
  btn.addEventListener("pointerdown", (e) => { e.preventDefault(); btn.setPointerCapture(e.pointerId); setEdge(kind, true); });
  const up = (e) => { e.preventDefault(); setEdge(kind, false); };
  btn.addEventListener("pointerup", up); btn.addEventListener("pointercancel", up); btn.addEventListener("lostpointercapture", () => setEdge(kind, false));
}
wireHold($("hook-btn"), "hook"); wireHold($("reel-btn"), "reel");
function releaseControls() { setEdge("hook", false); setEdge("reel", false); }
addEventListener("pagehide", releaseControls);
document.addEventListener("visibilitychange", () => { if (document.hidden) releaseControls(); });
document.addEventListener("contextmenu", (e) => { if (e.target.closest(".pad-screen")) e.preventDefault(); });

const keys = new Set();
addEventListener("keydown", (e) => {
  if ($("scr-pad").hidden || keys.has(e.code)) return; keys.add(e.code);
  if (e.code === "Space") { e.preventDefault(); setEdge("hook", true); }
  if (e.code === "ShiftLeft" || e.code === "ShiftRight") { e.preventDefault(); setEdge("reel", true); }
  const turn = { ArrowUp: 270, ArrowRight: 0, ArrowDown: 90, ArrowLeft: 180 }[e.code];
  if (turn !== undefined) { e.preventDefault(); S.aim = turn; queueAim(); drawAim(); }
});
addEventListener("keyup", (e) => {
  keys.delete(e.code); if (e.code === "Space") setEdge("hook", false);
  if (e.code === "ShiftLeft" || e.code === "ShiftRight") setEdge("reel", false);
});

function connect() {
  S.conn = Hub.connect("/games/smelterskelter/ws", {
    onWelcome: (m) => { S.pid = m.pid; releaseControls(); }, onState, onFx,
  });
}

let avatarPick = Hub.identity.avatar || Hub.AVATARS[(Math.random() * Hub.AVATARS.length) | 0];
Hub.buildAvatarGrid($("avatar-grid"), avatarPick, (a) => { avatarPick = a; });
Hub.wirePfpButton($("pfp-btn"), () => S.conn);
Hub.wirePfpButton($("pfp-btn2"), () => S.conn);
$("name-input").value = Hub.identity.name;
$("join-btn").onclick = () => {
  Audio.unlock(); Hub.identity.name = $("name-input").value.trim() || "WORKER";
  Hub.identity.avatar = avatarPick; S.joined = true; connect(); show("scr-lobby");
};
$("name-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("join-btn").click(); });
$("ready-btn").onclick = () => { Audio.unlock(); Audio.tap(); S.conn.send({ t: "ready", ready: !S.st?.you?.ready }); };
$("go-btn").onclick = () => { Audio.unlock(); S.conn.send({ t: "start" }); };
$("rematch-btn").onclick = () => S.conn.send({ t: "again" });

if (window.Brag) {
  const b = Brag.button(() => {
    const result = game()?.result; if (!result?.standings?.length) return null;
    const top = result.standings[0], wp = player(top.pid);
    return {
      title: "Smelter Skelter", icon: "⛓",
      winner: { name: wp?.name || "WORKER", avatar: wp?.avatar || "⛓", pfp: wp?.pfp || null },
      headline: `${top.score} pts · ${top.deliveries || 0} deliveries · ${top.steals || 0} steals`,
      beaten: result.standings.slice(1, 5).map((r) => ({ name: player(r.pid)?.name || "WORKER", score: r.score })),
    };
  });
  $("gameover").querySelector(".modal-card").insertBefore(b, $("rematch-btn"));
}

function raf() {
  requestAnimationFrame(raf);
  if (S.st?.phase === "countdown" && S.st.deadline && S.conn) {
    $("countdown-num").textContent = Math.max(1, Math.ceil((S.st.deadline - S.conn.now()) / 1000));
  }
  if (S.st?.phase === "game_end" && S.st.deadline && S.conn)
    $("go-auto").textContent = `lobby in ${Math.max(0, Math.ceil((S.st.deadline - S.conn.now()) / 1000))}s`;
  if (!$('scr-pad').hidden) drawAim();
}
requestAnimationFrame(raf);

if (Hub.identity.name) { S.joined = true; connect(); show("scr-lobby"); }
else show("scr-join");

window.__smelterPhone = {
  state: () => S.st,
  input: () => ({ aim: S.aim, hook: S.hook, reel: S.reel }),
  setAim: (degrees) => { S.aim = normDeg(Number(degrees) || 0); queueAim(); drawAim(); },
  hold: (kind, on) => { if (kind === "hook" || kind === "reel") setEdge(kind, !!on); },
  normDeg, diffDeg, releaseControls,
};
