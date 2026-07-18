/* WORDCLASH TV — read-only spectator display for the wall tablet.
   Connects with {tv:true}; server sends masked spectator state. */
"use strict";

const $ = (id) => document.getElementById(id);
let ST = null, OFFSET = 0, ws = null, retry = 0;
let podiumDone = false, lastRows = {};

const REASONS = { solved: "SOLVED", time: "TIME'S UP", exhausted: "BOARD EXHAUSTED",
                  all_done: "ALL BOARDS IN" };

/* confetti (same as app, trimmed) */
const Confetti = (() => {
  const cv = $("confetti"), cx = cv.getContext("2d");
  let parts = [], raf = null;
  const COLS = ["#22d3ee", "#a78bfa", "#f472b6", "#10c96e", "#eab308"];
  function fit() { cv.width = innerWidth; cv.height = innerHeight; }
  addEventListener("resize", fit); fit();
  function burst(n = 200) {
    for (let i = 0; i < n; i++) parts.push({
      x: Math.random() * innerWidth, y: -20 - Math.random() * 80,
      vx: (Math.random() - 0.5) * 3, vy: 2 + Math.random() * 4,
      rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.3,
      w: 7 + Math.random() * 7, h: 5 + Math.random() * 5,
      c: COLS[(Math.random() * COLS.length) | 0], life: 260,
    });
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

function connect() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/games/wordclash/ws`);
  ws.onopen = () => { retry = 0; $("tv-conn").hidden = true; ws.send(JSON.stringify({ t: "hello", tv: true })); };
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type === "state") { ST = msg; OFFSET = msg.now - Date.now(); render(); }
  };
  ws.onclose = () => {
    $("tv-conn").hidden = false;
    setTimeout(connect, Math.min(5000, 600 + retry++ * 800));
  };
  ws.onerror = () => { try { ws.close(); } catch (e) {} };
}

function playerByPid(pid) { return (ST?.players || []).find((p) => p.pid === pid); }

/* custom pfp support (mirrors app.js) */
function fillAvatar(el, p) {
  el.textContent = "";
  if (p && p.pfp) {
    const img = document.createElement("img");
    img.className = "pfp";
    img.src = p.pfp;
    img.alt = "";
    el.appendChild(img);
  } else {
    el.textContent = p ? p.avatar : "?";
  }
}
function remainMs() { return ST?.deadline ? Math.max(0, ST.deadline - (Date.now() + OFFSET)) : 0; }
function fmtClock(ms) { const s = Math.ceil(ms / 1000); return `${(s / 60) | 0}:${String(s % 60).padStart(2, "0")}`; }

function showTv(id) {
  for (const s of ["tv-lobby", "tv-game", "tv-roundend", "tv-podium"]) $(s).hidden = s !== id;
}

function makeRow(word, marks, flip) {
  const row = document.createElement("div");
  row.className = "brow";
  for (let i = 0; i < 5; i++) {
    const t = document.createElement("div");
    let cls = "tile";
    if (marks) cls += " " + marks[i];
    if (flip && marks) { cls += " flip"; t.style.animationDelay = `${i * 70}ms`; }
    t.className = cls;
    t.textContent = word && word[i] ? word[i].toUpperCase() : "";
    row.appendChild(t);
  }
  return row;
}

let qrDone = false;
function render() {
  const st = ST;
  if (!st) return;
  if (st.phase === "lobby" || st.phase === "countdown") { showTv("tv-lobby"); renderLobby(st); }
  else if (st.phase === "playing") { showTv("tv-game"); renderGame(st); }
  else if (st.phase === "round_end") { showTv("tv-roundend"); renderRoundEnd(st); }
  else if (st.phase === "podium") { showTv("tv-podium"); renderPodium(st); }
  if (st.phase !== "podium") podiumDone = false;
  if (st.phase !== "playing") lastRows = {};
}

function renderLobby(st) {
  if (!qrDone) {
    qrDone = true;
    const url = `http://${location.host}/games/wordclash/`;
    $("tv-url").textContent = `${location.host}/games/wordclash`;
    try { renderQR($("tv-qr-host"), url); } catch (e) {}
  }
  const wrap = $("tv-players");
  wrap.textContent = "";
  for (const p of st.players) {
    const c = document.createElement("div");
    c.className = "tv-pcard" + (p.ready ? " is-ready" : "");
    const av = document.createElement("span");
    fillAvatar(av, p);
    c.appendChild(av);
    c.appendChild(document.createTextNode(` ${p.name}` + (p.ready ? " ✓" : "")));
    wrap.appendChild(c);
  }
  const n = st.players.filter((p) => p.ready && p.connected).length;
  $("tv-hint").textContent =
    st.phase === "countdown" ? "LAUNCHING…"
    : n >= 2 ? "ready to launch — smash GO on any phone"
    : "scan the code, ready up, and the GO button appears";
}

function renderGame(st) {
  const m = st.match, rd = m?.round;
  if (!rd) return;
  $("tv-round").textContent = `R${m.round_num}/${m.rounds_total}`;
  const duel = rd.kind === "duel";
  $("tv-duel-boards").hidden = !duel;
  $("tv-relay").hidden = duel;
  $("tv-game-foot").textContent =
    duel ? "letters hidden until the reveal — watch the colors race"
         : (rd.kind === "sabotage" ? "SABOTAGE — expect treachery" : "RELAY — one board, no mercy");

  if (duel) {
    const host = $("tv-duel-boards");
    host.textContent = "";
    for (const p of st.players.filter((q) => q.in_match)) {
      const b = rd.boards[p.pid];
      if (!b) continue;
      const col = document.createElement("div");
      col.className = "tv-board";
      const nm = document.createElement("div");
      nm.className = "tv-bname";
      const bav = document.createElement("span");
      fillAvatar(bav, p);
      nm.appendChild(bav);
      nm.appendChild(document.createTextNode(" " + p.name + (b.solved ? " ✓" : "")));
      const bd = document.createElement("div");
      bd.className = "board";
      const key = "d" + p.pid;
      const prev = lastRows[key] ?? b.rows.length;
      b.rows.forEach((r, idx) => bd.appendChild(makeRow(null, r.m, idx >= prev)));
      lastRows[key] = b.rows.length;
      for (let i = b.rows.length; i < b.max; i++) bd.appendChild(makeRow(null, null));
      col.appendChild(nm); col.appendChild(bd);
      host.appendChild(col);
    }
  } else {
    const bd = $("tv-relay-board");
    bd.textContent = "";
    const prev = lastRows["r"] ?? rd.rows.length;
    rd.rows.forEach((r, idx) => {
      if (r.skipped) {
        const sk = document.createElement("div");
        sk.className = "brow-skip";
        const owner = playerByPid(r.by);
        sk.textContent = `${owner ? owner.name : "?"} — TIMED OUT`;
        bd.appendChild(sk);
      } else bd.appendChild(makeRow(r.w, r.m, idx >= prev));
    });
    lastRows["r"] = rd.rows.length;
    for (let i = rd.rows.length; i < rd.rows_max; i++) bd.appendChild(makeRow(null, null));

    const turnP = rd.turn ? playerByPid(rd.turn) : null;
    if (turnP) fillAvatar($("tv-turn-av"), turnP);
    else $("tv-turn-av").textContent = "⏸";
    $("tv-turn-name").textContent = rd.paused ? "PAUSED" : turnP ? turnP.name : "—";
    if (rd.pending) {
      const what = rd.pending.kind === "time" ? "⏱ 7s timer"
        : rd.pending.kind === "ban" ? `🚫 no ${String(rd.pending.letter).toUpperCase()}`
        : `🎯 starts with ${String(rd.pending.letter).toUpperCase()}`;
      $("tv-pending").textContent = what;
    } else $("tv-pending").textContent = "";

    const sc = $("tv-scores");
    sc.textContent = "";
    for (const p of st.players.filter((q) => q.in_match).sort((a, b) => b.score - a.score)) {
      const row = document.createElement("div");
      row.className = "tv-scorerow";
      row.innerHTML = "";
      const av = document.createElement("span"); fillAvatar(av, p);
      const nm = document.createElement("span"); nm.textContent = p.name;
      const b = document.createElement("b"); b.textContent = p.score;
      row.appendChild(av); row.appendChild(nm); row.appendChild(b);
      sc.appendChild(row);
    }
  }
}

function renderRoundEnd(st) {
  const m = st.match;
  if (!m?.reveal) return;
  $("tv-re-reason").textContent = REASONS[m.reveal.reason] || "ROUND OVER";
  const w = $("tv-re-word");
  if (w.dataset.word !== m.reveal.secret) {
    w.dataset.word = m.reveal.secret;
    w.textContent = "";
    m.reveal.secret.split("").forEach((ch, i) => {
      const t = document.createElement("div");
      t.className = "tile g flip";
      t.style.animationDelay = `${i * 120}ms`;
      t.textContent = ch.toUpperCase();
      w.appendChild(t);
    });
  }
  // duel: the promised reveal — everyone's board, letters now unmasked
  const rb = $("tv-re-boards");
  rb.textContent = "";
  if (m.round && m.round.kind === "duel" && m.round.boards) {
    for (const p of st.players.filter((q) => q.in_match)) {
      const b = m.round.boards[p.pid];
      if (!b || !b.rows.length) continue;
      const col = document.createElement("div");
      col.className = "tv-board";
      const nm = document.createElement("div");
      nm.className = "tv-bname";
      const rav = document.createElement("span");
      fillAvatar(rav, p);
      nm.appendChild(rav);
      nm.appendChild(document.createTextNode(` ${p.name}` + (b.solved ? " ✓" : "")));
      const bd = document.createElement("div");
      bd.className = "board";
      b.rows.forEach((r) => bd.appendChild(makeRow(r.w, r.m, false)));
      col.appendChild(nm); col.appendChild(bd);
      rb.appendChild(col);
    }
  }
  const sc = $("tv-re-scores");
  sc.textContent = "";
  const entries = Object.entries(m.reveal.round_scores).sort((a, b) => b[1].pts - a[1].pts);
  for (const [pid, s] of entries) {
    const p = playerByPid(pid);
    if (!p) continue;
    const row = document.createElement("div");
    row.className = "tv-scorerow";
    const av = document.createElement("span"); fillAvatar(av, p);
    const nm = document.createElement("span"); nm.textContent = p.name + (s.solved ? " 🏆" : "");
    const b = document.createElement("b");
    b.textContent = `${s.pts >= 0 ? "+" : ""}${s.pts}  →  ${m.scores[pid] ?? 0}`;
    row.appendChild(av); row.appendChild(nm); row.appendChild(b);
    sc.appendChild(row);
  }
}

function renderPodium(st) {
  const m = st.match;
  if (!m?.podium) return;
  const pod = $("tv-podium-blocks");
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
  const rest = $("tv-podium-rest");
  rest.textContent = "";
  for (const e of p.slice(3)) {
    const row = document.createElement("div");
    row.className = "tv-scorerow";
    const av = document.createElement("span"); fillAvatar(av, e);
    const nm = document.createElement("span"); nm.textContent = `${e.rank}. ${e.name}`;
    const b = document.createElement("b"); b.textContent = e.score;
    row.appendChild(av); row.appendChild(nm); row.appendChild(b);
    rest.appendChild(row);
  }
  if (!podiumDone) {
    podiumDone = true;
    Confetti.burst(260);
    setTimeout(() => Confetti.burst(200), 800);
  }
}

/* clocks */
function raf() {
  requestAnimationFrame(raf);
  const st = ST;
  if (!st) return;
  const rem = remainMs();
  if (st.phase === "playing" && st.match?.round) {
    const rd = st.match.round;
    const total = (rd.kind === "duel" ? (rd.seconds || 180) : (rd.turn_seconds || 15)) * 1000;
    const frac = st.deadline ? Math.min(1, rem / total) : 0;
    $("tv-timer-fill").style.transform = `scaleX(${frac})`;
    $("tv-clock").textContent = fmtClock(rem);
    if (rd.kind !== "duel") $("tv-ring-fg").style.strokeDashoffset = 119.4 * (1 - frac);
  }
  if (st.phase === "round_end" && st.match) {
    const last = st.match.round_num >= st.match.rounds_total;
    $("tv-re-next").textContent = `${last ? "final standings" : "next round"} in ${Math.ceil(rem / 1000)}s`;
  }
  if (st.phase === "podium") {
    $("tv-podium-auto").textContent = `back to lobby in ${Math.ceil(rem / 1000)}s`;
  }
}
requestAnimationFrame(raf);
connect();
