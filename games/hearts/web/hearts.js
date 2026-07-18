/* HEARTS client. Server-authoritative; this renders state + plays fx.
   Uses /shared/hubnet.js for identity, sockets, toasts, confetti.
   Same skeleton as spades.js — hearts swaps bidding for the passing sheet
   and team scores for per-seat point badges. */
"use strict";

const $ = (id) => document.getElementById(id);
const SUIT_GLYPH = { S: "♠", H: "♥", D: "♦", C: "♣" };
const DIR_LABEL = { left: "LEFT ←", right: "RIGHT →", across: "ACROSS ↑" };

const S = {
  st: null, pid: null, conn: null, joined: false,
  selCard: null, passPicks: [], lastHandNo: null, lastTrickKey: "", trickFlashUntil: 0,
  muted: localStorage.getItem("wc-muted") === "1",
};

/* ---------- tiny synth ---------- */
const SFX = (() => {
  let ctx = null;
  function ac() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }
  function tone(f, type, dur, vol = 0.13, when = 0, glide = 0) {
    if (S.muted) return;
    try {
      const c = ac(), t = c.currentTime + when;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(f, t);
      if (glide) o.frequency.exponentialRampToValueAtTime(Math.max(40, f + glide), t + dur);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + dur + 0.05);
    } catch (e) {}
  }
  return {
    unlock: () => { try { ac(); } catch (e) {} },
    snap: () => tone(240, "triangle", 0.06, 0.12),
    click: () => tone(700, "square", 0.04, 0.05),
    turn: () => { tone(880, "sine", 0.1, 0.13); tone(1175, "sine", 0.14, 0.11, 0.08); },
    win: () => [523, 659, 784].forEach((f, i) => tone(f, "sine", 0.2, 0.12, i * 0.08)),
    fanfare: () => [392, 523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, "sine", 0.3, 0.12, i * 0.11)),
    bad: () => tone(150, "sawtooth", 0.2, 0.08, 0, -60),
    tick: () => tone(1150, "square", 0.03, 0.045),
    drama: () => { tone(420, "sawtooth", 0.22, 0.11, 0, -220); tone(110, "sawtooth", 0.35, 0.1, 0.1, -40); },
  };
})();

/* ---------- helpers ---------- */

function playerByPid(pid) {
  return (S.st?.players || []).find((p) => p.pid === pid) || null;
}
function game() { return S.st?.game || null; }
function mySeat() { const g = game(); return g ? g.my_seat : null; }
function baseSeat() { const m = mySeat(); return m === null ? 0 : m; }
function relPos(seat) { return (seat - baseSeat() + 4) % 4; }   // 0=me 1=left 2=top 3=right
function seatInfo(seat) { return game().seats[seat]; }
function myTurn() {
  const g = game();
  return g && mySeat() !== null && g.turn === mySeat();
}
function remainMs() {
  if (!S.st?.deadline) return 0;
  return Math.max(0, S.st.deadline - S.conn.now());
}
function amPicking() {
  const g = game();
  return g && g.stage === "passing" && mySeat() !== null && !g.my_pass;
}

function cardEl(c, mini = false) {
  const d = document.createElement("div");
  d.className = "card" + (mini ? " mini" : "") + ("HD".includes(c[1]) ? " red" : "");
  d.dataset.c = c;
  const r = document.createElement("span"); r.className = "cr";
  r.textContent = c[0] === "T" ? "10" : c[0];
  const s = document.createElement("span"); s.className = "cs";
  s.textContent = SUIT_GLYPH[c[1]];
  d.appendChild(r); d.appendChild(s);
  return d;
}

function show(id) {
  for (const s of ["scr-join", "scr-lobby", "scr-table"]) $(s).hidden = s !== id;
}

/* ---------- lobby rendering ---------- */

const TARGETS = [50, 100];
const DIFFS = [["standard", "SHARP"], ["rookie", "ROOKIE"]];

function seg(hostId, options, current, key) {
  const host = $(hostId);
  host.textContent = "";
  for (const opt of options) {
    const [val, label] = Array.isArray(opt) ? opt : [opt, String(opt)];
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
  const empty = 4 - Math.min(4, humans.length);
  $("seat-note").textContent =
    humans.length > 4 ? "table seats 4 — extras watch and rotate in"
    : empty > 0 ? `${empty} empty chair${empty > 1 ? "s" : ""} → bots sit in (solo works)`
    : "full human table — no bots";

  seg("opt-target", TARGETS, st.settings.target, "target");
  seg("opt-difficulty", DIFFS, st.settings.difficulty, "difficulty");
  $("turn-val").textContent = st.settings.turn_seconds + "s";

  const me = st.you;
  const amReady = !!(me && me.ready);
  $("ready-btn").textContent = amReady ? "READY ✓" : "READY UP";
  $("ready-btn").classList.toggle("is-ready", amReady);
  $("go-btn").hidden = !(readyN >= st.min_players && amReady && st.phase === "lobby");
  $("lobby-hint").textContent =
    st.phase === "countdown" ? "SHUFFLING…"
    : readyN >= st.min_players ? "table's hot — deal in!"
    : `ready up to deal — ${location.host}`;
}

/* ---------- table rendering ---------- */

function plateFor(seat) {
  return $(["plate-me", "plate-left", "plate-top", "plate-right"][relPos(seat)]);
}

function renderPlates(st) {
  const g = game();
  for (let seat = 0; seat < 4; seat++) {
    const el = plateFor(seat);
    const info = seatInfo(seat);
    const p = playerByPid(info.pid);
    el.textContent = "";
    el.className = "plate " + ["pos-me", "pos-left", "pos-top", "pos-right"][relPos(seat)];
    if (g.stage === "playing" && g.turn === seat) el.classList.add("turn");
    if (g.stage === "passing" && !info.passed) el.classList.add("turn");
    if (info.auto && p && !p.bot) el.classList.add("auto");

    const ring = document.createElement("div");
    ring.className = "pl-ring";
    ring.innerHTML = '<svg viewBox="0 0 40 40"><circle class="rbg" cx="20" cy="20" r="17"/>'
      + '<circle class="rfg" cx="20" cy="20" r="17" style="stroke-dashoffset:106.8"/></svg>';
    const av = document.createElement("span"); av.className = "pl-av";
    if (p) Hub.fillAvatar(av, p); else av.textContent = "🪑";
    ring.appendChild(av);

    const meta = document.createElement("div"); meta.className = "pl-meta";
    const nm = document.createElement("div"); nm.className = "pl-name";
    nm.textContent = (p ? p.name : "—") + (seat === mySeat() ? " (you)" : "");
    const sub = document.createElement("div"); sub.className = "pl-sub";
    if (g.stage === "passing") {
      if (info.passed) {
        const ok = document.createElement("span"); ok.className = "ok";
        ok.textContent = "passed ✓";
        sub.appendChild(ok);
      } else {
        sub.textContent = "picking 3…";
      }
    } else {
      sub.textContent = `${info.score} pts`;
    }
    meta.appendChild(nm); meta.appendChild(sub);
    el.appendChild(ring); el.appendChild(meta);
    if (g.stage !== "passing" && info.pts > 0) {
      const b = document.createElement("span");
      b.className = "pl-pts";
      b.title = "points taken this hand";
      b.textContent = `+${info.pts}`;
      el.appendChild(b);
    }
  }
}

function renderTrick(st) {
  const g = game();
  const area = $("trick-area");
  area.classList.remove("won");
  for (const slot of area.querySelectorAll(".tslot")) slot.textContent = "";
  let cards = g.trick;
  // brief flash of the completed trick before it sweeps away
  if (!cards.length && g.last_trick && Date.now() < S.trickFlashUntil) {
    cards = g.last_trick.cards;
  }
  for (const t of cards) {
    const slot = area.querySelector(`[data-ts="${relPos(t.seat)}"]`);
    if (slot) slot.appendChild(cardEl(t.card, innerWidth < 480));
  }
  $("table-note").textContent =
    g.stage === "passing" ? "pick 3 cards to pass" :
    !g.trick.length && g.last_trick
      ? `${playerByPid(seatInfo(g.last_trick.winner).pid)?.name || "?"} took it`
        + (g.last_trick.pts ? ` +${g.last_trick.pts}` : "")
      : "";
}

function renderHeader(st) {
  const g = game();
  $("hand-chip").textContent = `HAND ${g.hand_no}`;
  $("target-chip").textContent = `→ ${g.target}`;
  $("broken-chip").hidden = !g.hearts_broken;
  const threat = g.moon_threat;
  const banner = $("moon-banner");
  banner.hidden = threat === null || threat === undefined;
  if (!banner.hidden) {
    const p = playerByPid(seatInfo(threat).pid);
    banner.textContent = `🌙 ${p ? p.name : "?"} is shooting for the moon…`;
  }
}

function renderHand(st) {
  const g = game();
  const fan = $("hand-fan");
  fan.textContent = "";
  const watch = mySeat() === null;
  $("watch-note").hidden = !watch;
  if (watch) return;
  const hand = g.hand || [];
  const picking = amPicking();
  // stale picks/selection must not survive renders, autoplay, or new deals
  S.passPicks = S.passPicks.filter((c) => hand.includes(c));
  if (S.selCard && (!myTurn() || !hand.includes(S.selCard))) S.selCard = null;
  const legal = new Set(
    g.stage === "playing" && myTurn() ? (g.legal || hand) : hand);
  fan.classList.toggle("my-turn", (myTurn() && g.stage === "playing") || picking);
  // fit the fan to the viewport: shrink card + overlap as the hand grows
  const n = Math.max(1, hand.length);
  const avail = Math.min(innerWidth, 560) - 28;
  let cw = 58;
  let gap = -22;
  if (n > 1) {
    while (cw > 40 && cw + (n - 1) * (cw + gap) > avail) {
      cw -= 2; gap = -Math.round(cw * 0.42);
    }
  }
  fan.style.setProperty("--fan-cw", cw + "px");
  fan.style.setProperty("--fan-gap", gap + "px");
  const recv = new Set(g.received || []);
  for (const c of hand) {
    const el = cardEl(c);
    if (g.stage === "playing" && myTurn() && !legal.has(c)) el.classList.add("dim");
    if (picking ? S.passPicks.includes(c) : S.selCard === c) el.classList.add("sel");
    if (g.stage === "playing" && g.trick_no === 1 && recv.has(c)) el.classList.add("recv");
    el.onclick = () => {
      SFX.unlock();
      if (picking) {
        const i = S.passPicks.indexOf(c);
        if (i >= 0) S.passPicks.splice(i, 1);
        else if (S.passPicks.length < 3) S.passPicks.push(c);
        else { SFX.bad(); return; }
        SFX.click();
        renderHand(S.st); renderPassSheet(S.st);
        return;
      }
      if (!(g.stage === "playing" && myTurn()) || !legal.has(c)) return;
      if (S.selCard === c) {
        S.selCard = null;
        S.conn.send({ t: "play", card: c });
        SFX.snap();
      } else {
        S.selCard = c;   // first tap raises, second tap plays
        SFX.click();
        renderHand(S.st);
      }
    };
    fan.appendChild(el);
  }
}

function renderPassSheet(st) {
  const g = game();
  const showSheet = g.stage === "passing" && mySeat() !== null;
  $("pass-sheet").hidden = !showSheet;
  // the sheet sits where my plate lives — don't let the plate poke out
  $("plate-me").style.visibility = showSheet ? "hidden" : "";
  if (!showSheet) return;
  const done = !!g.my_pass;
  const tgt = playerByPid(g.pass_to);
  $("ps-title").textContent = done ? "PASSED ✓"
    : `PASS 3 ${DIR_LABEL[g.pass_dir] || ""}${tgt ? " to " + tgt.name : ""}`;
  const picks = done ? g.my_pass : S.passPicks;
  const host = $("ps-picks");
  host.textContent = "";
  for (let i = 0; i < 3; i++) {
    if (picks[i]) host.appendChild(cardEl(picks[i], true));
    else {
      const d = document.createElement("div");
      d.className = "ps-slot";
      host.appendChild(d);
    }
  }
  $("pass-btn").hidden = done;
  $("pass-btn").disabled = S.passPicks.length !== 3;
  const waiting = g.seats.filter((x) => !x.passed).length;
  $("ps-wait").hidden = !done;
  $("ps-wait").textContent =
    waiting ? `waiting for ${waiting} more…` : "dealing…";
}

let scShownFor = "";
function renderScorecard(st) {
  const g = game();
  const showIt = g.stage === "hand_end" && g.hand_result;
  $("scorecard").hidden = !showIt;
  if (!showIt) { scShownFor = ""; return; }
  const key = `h${g.hand_no}`;
  $("sc-next").textContent = "";
  if (scShownFor === key) return;
  scShownFor = key;
  const hr = g.hand_result;
  $("sc-title").textContent = `HAND ${g.hand_no} — SCORES · to ${g.target}`;
  const moonP = hr.moon !== null && hr.moon !== undefined
    ? playerByPid(seatInfo(hr.moon).pid) : null;
  $("sc-moon").hidden = !moonP;
  if (moonP) $("sc-moon").textContent = `🌙 ${moonP.name} SHOT THE MOON — everyone else +26`;
  const body = $("sc-body");
  body.textContent = "";
  const order = [0, 1, 2, 3].sort((a, b) =>
    hr.totals[String(a)] - hr.totals[String(b)] || a - b);
  const lo = hr.totals[String(order[0])];
  for (const seat of order) {
    const p = playerByPid(seatInfo(seat).pid);
    const delta = hr.deltas[String(seat)];
    const row = document.createElement("div");
    row.className = "sc-p" + (hr.totals[String(seat)] === lo ? " lead" : "")
      + (seat === mySeat() ? " me" : "");
    const nm = document.createElement("span"); nm.className = "sc-name";
    nm.textContent = p ? p.name : "?";
    if (seat === mySeat()) {
      const yt = document.createElement("span"); yt.className = "you-tag";
      yt.textContent = "YOU"; nm.appendChild(yt);
    }
    const d = document.createElement("span");
    d.className = "sc-delta " + (delta === 0 ? "zero" : "hit");
    d.textContent = delta === 0 ? "clean" : `+${delta}`;
    const tot = document.createElement("b"); tot.className = "sc-total";
    tot.textContent = hr.totals[String(seat)];
    row.appendChild(nm); row.appendChild(d); row.appendChild(tot);
    body.appendChild(row);
  }
}

let goShown = false;
function renderGameOver(st) {
  const g = game();
  const showIt = st.phase === "game_end" && g && g.result;
  $("gameover").hidden = !showIt;
  if (!showIt) { goShown = false; return; }
  const res = g.result;
  const wp = playerByPid(res.winner_pid);
  $("go-title").textContent = `${(wp ? wp.name : "?").toUpperCase()} WINS`;
  $("go-line").textContent = `lowest score after ${res.hands} hand${res.hands > 1 ? "s" : ""}`;
  const host = $("go-standings");
  host.textContent = "";
  res.standings.forEach((r, i) => {
    const p = playerByPid(r.pid);
    const row = document.createElement("div");
    row.className = "go-row" + (i === 0 ? " first" : "");
    const rank = document.createElement("span"); rank.className = "go-rank";
    rank.textContent = i === 0 ? "👑" : `${i + 1}.`;
    const nm = document.createElement("span"); nm.className = "go-name";
    nm.textContent = (p ? p.name : "?") + (r.pid === S.pid ? " (you)" : "");
    const sc = document.createElement("b"); sc.className = "go-score";
    sc.textContent = r.score;
    row.appendChild(rank); row.appendChild(nm); row.appendChild(sc);
    host.appendChild(row);
  });
  if (!goShown) {
    goShown = true;
    Hub.confettiBurst(220);
    SFX.fanfare();
    if (res.winner_pid === S.pid) setTimeout(() => Hub.confettiBurst(180), 600);
  }
}

/* ---------- state entry ---------- */

function onState(st) {
  S.st = st;
  if (!S.joined) return;
  if (st.phase === "lobby" || st.phase === "countdown") {
    show("scr-lobby");
    // kill any leftover overlays from a game that ended abruptly
    $("scorecard").hidden = true;
    $("pass-sheet").hidden = true;
    $("moon-banner").hidden = true;
    scShownFor = "";
    renderLobby(st);
  } else if (st.game) {
    if (st.game.hand_no !== S.lastHandNo) {
      S.lastHandNo = st.game.hand_no;
      S.passPicks = [];
    }
    show("scr-table");
    renderHeader(st);
    renderPlates(st);
    renderTrick(st);
    renderHand(st);
    renderPassSheet(st);
    renderScorecard(st);
  }
  renderGameOver(st);
  $("countdown-overlay").hidden = st.phase !== "countdown";
  if (st.game && game().stage !== "playing") S.selCard = null;
}

function onFx(fx) {
  switch (fx.kind) {
    case "toast": Hub.toast((fx.icon ? fx.icon + " " : "") + fx.msg); break;
    case "invalid": Hub.toast(fx.msg, "err"); SFX.bad(); break;
    case "played": if (fx.pid !== S.pid) SFX.snap(); break;
    case "passed": if (fx.pid !== S.pid) SFX.click(); break;
    case "passes_done": Hub.toast(`🔀 cards passed ${fx.dir}`); break;
    case "play_begins": {
      const p = playerByPid(fx.pid);
      Hub.toast(`♣ ${p ? p.name : "?"} holds the 2♣ and opens`);
      break;
    }
    case "hearts_broken": {
      const p = playerByPid(fx.pid);
      Hub.toast(`💔 ${p ? p.name : "?"} broke hearts`);
      SFX.drama();
      break;
    }
    case "queen_played": {
      const p = playerByPid(fx.pid);
      Hub.toast(`⚠️ ${p ? p.name : "?"} drops THE QUEEN`);
      SFX.drama();
      const area = $("trick-area");
      area.classList.remove("q-drama");
      void area.offsetWidth;               // restart the shake
      area.classList.add("q-drama");
      break;
    }
    case "queen_taken": {
      const p = playerByPid(fx.pid);
      Hub.toast(`🖤 ${p ? p.name : "?"} eats the Q♠ — +13`);
      if (fx.pid === S.pid) SFX.bad();
      break;
    }
    case "trick_won": {
      S.trickFlashUntil = Date.now() + 650;
      if (fx.pid === S.pid) { if (fx.pts > 0) SFX.bad(); else SFX.win(); }
      setTimeout(() => $("trick-area").classList.add("won"), 420);  // sweep
      setTimeout(() => { if (S.st) onState(S.st); }, 700);
      break;
    }
    case "moon": {
      const p = playerByPid(fx.pid);
      Hub.toast(`🌙 ${p ? p.name : "?"} SHOT THE MOON`);
      Hub.confettiBurst(140);
      SFX.fanfare();
      break;
    }
    case "hand_start": S.selCard = null; S.passPicks = []; break;
    case "game_over": break;
    case "countdown": SFX.turn(); break;
  }
}

/* ---------- timers (rAF) ---------- */

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
  const sec = Math.ceil(remainMs() / 1000);
  if (g.stage === "passing") {
    $("ps-timer").textContent = amPicking() ? `· ${sec}s` : "";
    if (sec !== lastTick && sec <= 5 && sec > 0 && amPicking()) { SFX.tick(); lastTick = sec; }
  }
  if (g.stage === "playing" && g.turn !== null && g.turn !== undefined) {
    const rem = remainMs();
    const frac = Math.min(1, rem / (g.turn_seconds * 1000));
    const plate = plateFor(g.turn);
    const ring = plate && plate.querySelector(".rfg");
    if (ring) {
      ring.style.strokeDashoffset = 106.8 * (1 - frac);
      ring.style.stroke = frac < 0.25 ? "var(--danger)" : "var(--pink)";
    }
    if (sec !== lastTick && sec <= 5 && sec > 0 && myTurn()) { SFX.tick(); lastTick = sec; }
  }
  if (g.stage === "hand_end") {
    $("sc-next").textContent = `next hand in ${sec}s`;
  }
  if (st.phase === "game_end") {
    $("go-auto").textContent = `lobby in ${sec}s`;
  }
}
requestAnimationFrame(raf);

/* refit cards on rotation / resize */
let resizeT = null;
addEventListener("resize", () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => { if (S.st) onState(S.st); }, 150);
});

/* ---------- boot & wiring ---------- */

function connect() {
  S.conn = Hub.connect("/games/hearts/ws", {
    onWelcome: (msg) => { S.pid = msg.pid; },
    onState, onFx,
  });
}

let avatarPick = Hub.identity.avatar
  || Hub.AVATARS[(Math.random() * Hub.AVATARS.length) | 0];

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

$("ready-btn").onclick = () => {
  SFX.unlock(); SFX.click();
  const me = S.st?.you;
  S.conn.send({ t: "ready", ready: !(me && me.ready) });
};
$("go-btn").onclick = () => { SFX.unlock(); S.conn.send({ t: "start" }); };
$("turn-minus").onclick = () =>
  S.conn.send({ t: "settings", patch: { turn_seconds: Math.max(10, (S.st?.settings.turn_seconds || 30) - 5) } });
$("turn-plus").onclick = () =>
  S.conn.send({ t: "settings", patch: { turn_seconds: Math.min(60, (S.st?.settings.turn_seconds || 30) + 5) } });
$("rematch-btn").onclick = () => S.conn.send({ t: "again" });

$("pass-btn").onclick = () => {
  SFX.unlock();
  if (S.passPicks.length !== 3) return;
  S.conn.send({ t: "pass", cards: S.passPicks.slice() });
  SFX.snap();
};

/* brag card: the low scorer and everyone they out-ducked */
if (window.Brag) {
  const btn = Brag.button(() => {
    const g = game();
    if (!g || !g.result) return null;
    const res = g.result;
    const wp = playerByPid(res.winner_pid);
    const losers = res.standings.filter((r) => r.pid !== res.winner_pid);
    return {
      title: "Hearts", icon: "♥️",
      winner: { name: wp ? wp.name : "?", avatar: wp ? wp.avatar : "♥️",
                pfp: wp ? wp.pfp : null },
      headline: `${res.standings[0].score} points — lowest wins`,
      beaten: losers.slice(0, 4).map((r) => {
        const p = playerByPid(r.pid);
        return { name: p ? p.name : "?", score: r.score };
      }),
    };
  });
  document.querySelector("#gameover .modal-card")
    .insertBefore(btn, $("rematch-btn"));
}

function wireMute(btn) {
  btn.textContent = S.muted ? "🔇" : "🔊";
  btn.onclick = () => {
    S.muted = !S.muted;
    localStorage.setItem("wc-muted", S.muted ? "1" : "0");
    $("mute-btn").textContent = $("mute-btn2").textContent = S.muted ? "🔇" : "🔊";
  };
}
wireMute($("mute-btn")); wireMute($("mute-btn2"));

Hub.wirePfpButton($("pfp-btn"), () => S.conn);
Hub.wirePfpButton($("pfp-btn2"), () => S.conn);

Hub.buildAvatarGrid($("avatar-grid"), avatarPick, (a) => { avatarPick = a; });
$("name-input").value = Hub.identity.name;

if (Hub.identity.name) {
  S.joined = true;
  connect();
  show("scr-lobby");
} else {
  show("scr-join");
}
