/* SPADES client. Server-authoritative; this renders state + plays fx.
   Uses /shared/hubnet.js for identity, sockets, toasts, confetti. */
"use strict";

const $ = (id) => document.getElementById(id);
const SUIT_GLYPH = { S: "♠", H: "♥", D: "♦", C: "♣" };
const RANKS = "23456789TJQKA";

const S = {
  st: null, pid: null, conn: null, joined: false,
  selCard: null, lastTrickKey: "", trickFlashUntil: 0,
  goAuto: false, muted: localStorage.getItem("wc-muted") === "1",
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
    nil: () => tone(420, "sawtooth", 0.2, 0.1, 0, -220),
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

function legalPlays(hand, trick, broken) {
  if (!trick.length) {
    if (broken) return hand.slice();
    const ns = hand.filter((c) => c[1] !== "S");
    return ns.length ? ns : hand.slice();
  }
  const led = trick[0].card[1];
  const follow = hand.filter((c) => c[1] === led);
  return follow.length ? follow : hand.slice();
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

const TARGETS = [200, 300, 400, 500];
const SEATINGS = [["partners", "SAME TEAM"], ["mixed", "VS EACH OTHER"]];
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
    : humans.length >= 3 ? "teams by ready order: 1st+3rd vs 2nd+4th"
      + (empty ? " · a bot takes the last chair" : "")
    : empty > 0 ? `${empty} empty chair${empty > 1 ? "s" : ""} → bots sit in`
    : "full human table — no bots";

  seg("opt-target", TARGETS, st.settings.target, "target");
  seg("opt-seating", SEATINGS, st.settings.seating, "seating");
  seg("opt-difficulty", DIFFS, st.settings.difficulty, "difficulty");
  $("row-seating").hidden = humans.length !== 2;
  $("turn-val").textContent = st.settings.turn_seconds + "s";

  const me = st.you;
  const amReady = !!(me && me.ready);
  $("ready-btn").textContent = amReady ? "READY ✓" : "READY UP";
  $("ready-btn").classList.toggle("is-ready", amReady);
  $("go-btn").hidden = !(readyN >= st.min_players && amReady && st.phase === "lobby");
  $("lobby-hint").textContent =
    st.phase === "countdown" ? "SHUFFLING…"
    : readyN >= st.min_players ? "table's hot — deal in!"
    : readyN === 1 ? "need one more human…"
    : `waiting for players — ${location.host}`;
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
    if (g.turn === seat && (g.stage === "bidding" || g.stage === "playing")) el.classList.add("turn");
    if (mySeat() !== null && seat !== mySeat() && info.team === seatInfo(mySeat()).team)
      el.classList.add("teammate");
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
    const isPartner = mySeat() !== null && seat === (mySeat() + 2) % 4;
    nm.textContent = (p ? p.name : "—")
      + (seat === mySeat() ? " (you)" : isPartner ? " 🤝" : "");
    if (isPartner) nm.title = "your partner";
    const sub = document.createElement("div"); sub.className = "pl-sub";
    if (isPartner && info.bid === null && g.stage === "bidding") {
      sub.textContent = "partner · bidding…";
    } else if (info.bid === null || info.bid === undefined) {
      sub.textContent = g.stage === "bidding" ? "bidding…" : "—";
    } else if (info.bid === "nil") {
      sub.innerHTML = "";
      const n = document.createElement("span"); n.className = "nil"; n.textContent = "NIL";
      sub.appendChild(n);
      sub.appendChild(document.createTextNode(` · took ${info.tricks}`));
    } else {
      sub.textContent = (isPartner ? "partner · " : "")
        + `bid ${info.bid} · took ${info.tricks}`;
    }
    meta.appendChild(nm); meta.appendChild(sub);
    el.appendChild(ring); el.appendChild(meta);
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
    g.stage === "bidding" ? "bidding round" :
    !g.trick.length && g.last_trick
      ? `${playerByPid(seatInfo(g.last_trick.winner).pid)?.name || "?"} took it` : "";
  $("broken-chip").hidden = !g.spades_broken;
}

function renderHand(st) {
  const g = game();
  const fan = $("hand-fan");
  fan.textContent = "";
  const watch = mySeat() === null;
  $("watch-note").hidden = !watch;
  if (watch) return;
  const hand = g.hand || [];
  // a raised card must not survive turn changes, autoplay, or leaving my hand
  if (S.selCard && (!myTurn() || !hand.includes(S.selCard))) S.selCard = null;
  const legal = new Set(
    g.stage === "playing" && myTurn()
      ? legalPlays(hand, g.trick, g.spades_broken) : hand);
  fan.classList.toggle("my-turn", myTurn() && g.stage === "playing");
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
  for (const c of hand) {
    const el = cardEl(c);
    if (g.stage === "playing" && myTurn() && !legal.has(c)) el.classList.add("dim");
    if (S.selCard === c) el.classList.add("sel");
    el.onclick = () => {
      SFX.unlock();
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

let nilArmed = false;
function renderBidSheet(st) {
  const g = game();
  const showSheet = g.stage === "bidding" && myTurn();
  if ($("bid-sheet").hidden === showSheet) nilArmed = false;
  $("bid-sheet").hidden = !showSheet;
  if (!showSheet) return;
  const grid = $("bid-grid");
  if (!grid.childElementCount) {
    for (let v = 1; v <= 13; v++) {
      const b = document.createElement("button");
      b.textContent = v;
      b.onclick = () => { SFX.click(); S.conn.send({ t: "bid", value: v }); };
      grid.appendChild(b);
    }
    // NIL is a big swing — require a confirming second tap
    $("bid-nil").onclick = () => {
      if (!nilArmed) {
        nilArmed = true;
        $("bid-nil").textContent = "SURE? NIL means ZERO tricks — tap again";
        SFX.nil();
        return;
      }
      S.conn.send({ t: "bid", value: "nil" });
    };
  }
  if (!nilArmed) $("bid-nil").textContent = "NIL — zero tricks, ±100";
}

function renderScores(st) {
  const g = game();
  const myTeam = mySeat() !== null ? seatInfo(mySeat()).team : 0;
  const us = g.scores[String(myTeam)], them = g.scores[String(1 - myTeam)];
  const set = (id, sc) => {
    const el = $(id);
    el.querySelector("span").textContent = sc.score;
    el.querySelector("small").textContent = `${sc.bags} bags`;
  };
  set("score-us", us); set("score-them", them);
  $("score-target").textContent = `→ ${g.target}`;
}

function teamNames(team) {
  const g = game();
  return g.seats.filter((s) => s.team === team)
    .map((s) => playerByPid(s.pid)?.name || "?").join(" + ");
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
  $("sc-title").textContent = `HAND ${g.hand_no} — SCORES`;
  const body = $("sc-body");
  body.textContent = "";
  const myTeam = mySeat() !== null ? seatInfo(mySeat()).team : 0;
  for (const team of [myTeam, 1 - myTeam]) {
    const r = g.hand_result.teams[String(team)];
    const div = document.createElement("div");
    div.className = "sc-team " + (r.made ? "made" : (r.bid > 0 ? "set" : ""));
    const rows = [
      [`${team === myTeam ? "US" : "THEM"} — ${teamNames(team)}`, ""],
      [`bid ${r.bid} · took ${r.tricks}`, r.made ? "MADE" : (r.bid > 0 ? "SET" : "")],
      ["hand points", (r.delta >= 0 ? "+" : "") + r.delta],
      ["bags now", String(r.bags)],
      [`match total (to ${g.target})`, String(g.scores[String(team)].score)],
    ];
    for (const [l, v] of rows) {
      const row = document.createElement("div");
      row.className = "sc-row";
      const a = document.createElement("span"); a.textContent = l;
      const b = document.createElement("b");
      b.textContent = v;
      if (v.startsWith("+")) b.className = "pos";
      if (v.startsWith("-")) b.className = "neg";
      row.appendChild(a); row.appendChild(b);
      div.appendChild(row);
    }
    for (const nil of r.nil) {
      const row = document.createElement("div");
      row.className = "sc-row";
      const p = playerByPid(seatInfo(nil.seat).pid);
      const a = document.createElement("span");
      a.textContent = `${p ? p.name : "?"} nil ${nil.ok ? "✓" : "✗"}`;
      const b = document.createElement("b");
      b.textContent = (nil.delta >= 0 ? "+" : "") + nil.delta;
      b.className = nil.delta >= 0 ? "pos" : "neg";
      row.appendChild(a); row.appendChild(b);
      div.appendChild(row);
    }
    body.appendChild(div);
  }
}

let goShown = false;
function renderGameOver(st) {
  const g = game();
  const showIt = st.phase === "game_end" && g && g.result;
  $("gameover").hidden = !showIt;
  if (!showIt) { goShown = false; return; }
  const w = g.result.winner_team;
  $("go-title").textContent = `${teamNames(w).toUpperCase()} WIN`;
  $("go-line").textContent =
    `${g.result.scores[String(w)]} — ${g.result.scores[String(1 - w)]} in ${g.result.hands} hands`;
  if (!goShown) {
    goShown = true;
    Hub.confettiBurst(220);
    SFX.fanfare();
    const myTeam = mySeat() !== null ? seatInfo(mySeat()).team : null;
    if (myTeam === w) setTimeout(() => Hub.confettiBurst(180), 600);
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
    $("bid-sheet").hidden = true;
    scShownFor = "";
    renderLobby(st);
  } else if (st.game) {
    show("scr-table");
    renderPlates(st);
    renderTrick(st);
    renderHand(st);
    renderBidSheet(st);
    renderScores(st);
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
    case "bid_made": {
      const p = playerByPid(fx.pid);
      Hub.toast(`${p ? p.name : "?"} bids ${fx.value === "nil" ? "NIL" : fx.value}`);
      if (fx.value === "nil") SFX.nil(); else SFX.click();
      break;
    }
    case "trick_won": {
      S.trickFlashUntil = Date.now() + 650;
      const p = playerByPid(fx.pid);
      if (p && fx.pid === S.pid) SFX.win();
      setTimeout(() => $("trick-area").classList.add("won"), 420);  // sweep
      setTimeout(() => { if (S.st) onState(S.st); }, 700);
      break;
    }
    case "hand_start": S.selCard = null; break;
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
  if (g.stage === "bidding" || g.stage === "playing") {
    const rem = remainMs();
    const frac = Math.min(1, rem / (g.turn_seconds * 1000));
    const plate = plateFor(g.turn);
    const ring = plate && plate.querySelector(".rfg");
    if (ring) {
      ring.style.strokeDashoffset = 106.8 * (1 - frac);
      ring.style.stroke = frac < 0.25 ? "var(--danger)" : "var(--cyan)";
    }
    const sec = Math.ceil(rem / 1000);
    if (sec !== lastTick && sec <= 5 && sec > 0 && myTurn()) { SFX.tick(); lastTick = sec; }
  }
  if (g.stage === "bidding" && myTurn()) {
    $("bid-sheet").querySelector(".bs-title").textContent =
      `YOUR BID — how many tricks will you take? · ${Math.ceil(remainMs() / 1000)}s`;
  }
  if (g.stage === "hand_end") {
    $("sc-next").textContent = `next hand in ${Math.ceil(remainMs() / 1000)}s`;
  }
  if (st.phase === "game_end") {
    $("go-auto").textContent = `lobby in ${Math.ceil(remainMs() / 1000)}s`;
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
  S.conn = Hub.connect("/games/spades/ws", {
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

/* brag card: the winning TEAM and the score they ran up */
if (window.Brag) {
  const btn = Brag.button(() => {
    const g = game();
    if (!g || !g.result) return null;
    const w = g.result.winner_team;
    const winners = g.seats.filter((s) => s.team === w)
      .map((s) => playerByPid(s.pid)).filter(Boolean);
    const losers = g.seats.filter((s) => s.team !== w)
      .map((s) => playerByPid(s.pid)).filter(Boolean);
    const humanWinner = winners.find((p) => !p.bot) || winners[0];
    return {
      title: "Spades", icon: "♠️",
      winner: { name: winners.map((p) => p.name).join(" + "),
                avatar: "♠️",
                pfp: humanWinner ? humanWinner.pfp : null },
      headline: `${g.result.scores[String(w)]} — ${g.result.scores[String(1 - w)]} in ${g.result.hands} hands`,
      beaten: losers.map((p) => ({ name: p.name })),
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
