/* EUCHRE client. Server-authoritative; this renders state + plays fx.
   Uses /shared/hubnet.js for identity, sockets, toasts, confetti.
   The left bower is a trump-suit card here too — legality dimming and the
   "follow suit" hints all route through effSuit(). */
"use strict";

const $ = (id) => document.getElementById(id);
const SUIT_GLYPH = { S: "♠", H: "♥", D: "♦", C: "♣" };
const SUIT_NAME = { S: "SPADES", H: "HEARTS", D: "DIAMONDS", C: "CLUBS" };
const SAME_COLOR = { S: "C", C: "S", H: "D", D: "H" };

const S = {
  st: null, pid: null, conn: null, joined: false,
  selCard: null, selSuit: null, trickFlashUntil: 0,
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
    alone: () => tone(420, "sawtooth", 0.24, 0.1, 0, 260),
    euchre: () => { tone(300, "sawtooth", 0.3, 0.11, 0, -160); tone(220, "sawtooth", 0.34, 0.1, 0.16, -120); },
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

/* left bower belongs to trump — the ONE rule the UI must not fumble */
function effSuit(c, trump) {
  if (trump && c[0] === "J" && c[1] === SAME_COLOR[trump]) return trump;
  return c[1];
}
function legalPlays(hand, trick, trump) {
  if (!trick.length) return hand.slice();
  const led = effSuit(trick[0].card, trump);
  const follow = hand.filter((c) => effSuit(c, trump) === led);
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
  const g = game();
  if (g && g.trump && effSuit(c, g.trump) === g.trump) d.classList.add("is-trump");
  d.appendChild(r); d.appendChild(s);
  return d;
}
function cardBackEl() {
  const d = document.createElement("div");
  d.className = "card back";
  return d;
}

function show(id) {
  for (const s of ["scr-join", "scr-lobby", "scr-table"]) $(s).hidden = s !== id;
}

/* ---------- lobby rendering ---------- */

const TARGETS = [5, 10];
const SEATINGS = [["partners", "SAME TEAM"], ["mixed", "VS EACH OTHER"]];
const DIFFS = [["standard", "SHARP"], ["rookie", "ROOKIE"]];
const STICKS = [[true, "ON"], [false, "OFF"]];

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
  seg("opt-stick", STICKS, st.settings.stick_dealer, "stick_dealer");
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
    : `waiting for you to ready up — ${location.host}`;
}

/* ---------- table rendering ---------- */

function plateFor(seat) {
  return $(["plate-me", "plate-left", "plate-top", "plate-right"][relPos(seat)]);
}

const BIDDING = (g) => g.stage === "bidding1" || g.stage === "bidding2";
const ACTING = (g) => BIDDING(g) || g.stage === "discard" || g.stage === "playing";

function renderPlates(st) {
  const g = game();
  for (let seat = 0; seat < 4; seat++) {
    const el = plateFor(seat);
    const info = seatInfo(seat);
    const p = playerByPid(info.pid);
    el.textContent = "";
    el.className = "plate " + ["pos-me", "pos-left", "pos-top", "pos-right"][relPos(seat)];
    if (g.turn === seat && ACTING(g)) el.classList.add("turn");
    if (mySeat() !== null && seat !== mySeat() && info.team === seatInfo(mySeat()).team)
      el.classList.add("teammate");
    if (info.auto && p && !p.bot) el.classList.add("auto");
    if (info.sitting_out) el.classList.add("bench");

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
    const bits = [];
    if (seat === g.dealer) bits.push("dealer");
    if (info.sitting_out) {
      bits.push("sitting out");
    } else if (g.maker_seat === seat) {
      const mk = document.createElement("span"); mk.className = "mk";
      mk.textContent = `${SUIT_GLYPH[g.trump]} maker` + (g.alone ? " · ALONE" : "");
      sub.appendChild(mk);
    }
    if (g.stage === "playing" || g.stage === "hand_end") bits.push(`took ${info.tricks}`);
    else if (BIDDING(g) && g.turn === seat) bits.push("deciding…");
    if (bits.length) sub.appendChild(document.createTextNode(
      (sub.childNodes.length ? " · " : "") + bits.join(" · ")));
    if (!sub.childNodes.length) sub.textContent = "—";
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
  // the upcard sits mid-table while the ordering round runs
  const up = $("up-slot");
  up.textContent = "";
  if (g.stage === "bidding1" && g.upcard) {
    up.hidden = false;
    up.appendChild(cardEl(g.upcard, innerWidth < 480));
    const tag = document.createElement("div"); tag.className = "up-tag";
    tag.textContent = "UP FOR GRABS";
    up.appendChild(tag);
  } else if (g.stage === "bidding2") {
    up.hidden = false;
    up.appendChild(cardBackEl());
    const tag = document.createElement("div"); tag.className = "up-tag down";
    tag.textContent = `${SUIT_GLYPH[g.turned_down]} TURNED DOWN`;
    up.appendChild(tag);
  } else {
    up.hidden = true;
  }
  $("table-note").textContent =
    g.stage === "bidding1" ? "ordering round — take it or pass" :
    g.stage === "bidding2" ? "name any other suit" :
    g.stage === "discard" ? "dealer is burying a card…" :
    g.stage === "playing" && !g.trick.length && g.last_trick
      ? `${playerByPid(seatInfo(g.last_trick.winner).pid)?.name || "?"} took it` : "";
}

function renderTrumpChip(st) {
  const g = game();
  const chip = $("trump-chip");
  if (!g.trump || g.stage === "bidding1" || g.stage === "bidding2") {
    chip.hidden = true;
    return;
  }
  chip.hidden = false;
  chip.textContent = "";
  const glyph = document.createElement("b");
  glyph.textContent = SUIT_GLYPH[g.trump];
  glyph.className = "HD".includes(g.trump) ? "red" : "";
  chip.appendChild(glyph);
  chip.appendChild(document.createTextNode(" " + SUIT_NAME[g.trump]));
  const role = document.createElement("span");
  if (mySeat() !== null) {
    const mine = seatInfo(mySeat()).team === g.maker_team;
    role.textContent = mine ? "MAKERS" : "DEFEND";
    role.className = mine ? "mkr" : "dfd";
  } else {
    role.textContent = `${playerByPid(seatInfo(g.maker_seat).pid)?.name || "?"} made it`;
  }
  chip.appendChild(role);
  if (g.alone) {
    const al = document.createElement("span"); al.className = "alone-tag";
    al.textContent = "⚡ALONE";
    chip.appendChild(al);
  }
}

function renderHand(st) {
  const g = game();
  const fan = $("hand-fan");
  fan.textContent = "";
  const watch = mySeat() === null;
  $("watch-note").hidden = !watch;
  if (watch) return;
  const me = mySeat();
  const benched = seatInfo(me).sitting_out;
  const hand = g.hand || [];
  const discarding = g.stage === "discard" && myTurn();
  const playing = g.stage === "playing" && myTurn() && !benched;
  // a raised card must not survive turn changes, autoplay, or leaving my hand
  if (S.selCard && (!(playing || discarding) || !hand.includes(S.selCard))) S.selCard = null;
  const legal = new Set(
    playing ? legalPlays(hand, g.trick, g.trump)
    : discarding ? hand : hand);
  fan.classList.toggle("my-turn", playing || discarding);
  fan.classList.toggle("benched", !!benched);
  // fit the fan to the viewport: shrink card + overlap as the hand grows
  const n = Math.max(1, hand.length);
  const avail = Math.min(innerWidth, 560) - 28;
  let cw = 64;
  let gap = -20;
  if (n > 1) {
    while (cw > 40 && cw + (n - 1) * (cw + gap) > avail) {
      cw -= 2; gap = -Math.round(cw * 0.38);
    }
  }
  fan.style.setProperty("--fan-cw", cw + "px");
  fan.style.setProperty("--fan-gap", gap + "px");
  for (const c of hand) {
    const el = cardEl(c);
    if (playing && !legal.has(c)) el.classList.add("dim");
    if (S.selCard === c) el.classList.add("sel");
    el.onclick = () => {
      SFX.unlock();
      if (!(playing || discarding) || !legal.has(c)) return;
      if (S.selCard === c) {
        S.selCard = null;
        S.conn.send(discarding ? { t: "discard", card: c } : { t: "play", card: c });
        SFX.snap();
      } else {
        S.selCard = c;   // first tap raises, second tap plays/buries
        SFX.click();
        renderHand(S.st);
      }
    };
    fan.appendChild(el);
  }
}

/* ---------- bid sheet ---------- */

function renderBidSheet(st) {
  const g = game();
  const sheet = $("bid-sheet");
  const me = mySeat();
  const iAmDealer = me !== null && me === g.dealer;
  const bidTurn = BIDDING(g) && myTurn();
  const discTurn = g.stage === "discard" && myTurn();
  const showSheet = bidTurn || discTurn;
  if (sheet.hidden === showSheet) { S.selSuit = null; $("alone-toggle").checked = false; }
  sheet.hidden = !showSheet;
  if (!showSheet) return;

  $("bs-round1").hidden = g.stage !== "bidding1";
  $("bs-round2").hidden = g.stage !== "bidding2";
  $("alone-row").hidden = !bidTurn;
  $("bs-discard-note").hidden = !discTurn;

  if (discTurn) {
    $("bs-title").textContent = "BURY ONE";
    return;
  }
  if (g.stage === "bidding1") {
    $("bs-title").textContent = "TRUMP ON OFFER";
    const up = $("bs-upcard");
    up.textContent = "";
    up.appendChild(cardEl(g.upcard));
    $("bs-up-note").textContent = iAmDealer
      ? "you deal — take it into your hand?"
      : `${SUIT_NAME[g.upcard[1]].toLowerCase()} trump · the dealer picks it up`;
    $("order-btn").textContent = iAmDealer ? "PICK IT UP" : "ORDER IT UP";
    return;
  }
  // round 2
  $("bs-title").textContent = "NAME YOUR TRUMP";
  const grid = $("suit-grid");
  grid.textContent = "";
  for (const suit of "SHDC") {
    const b = document.createElement("button");
    b.className = ("HD".includes(suit) ? "red" : "")
      + (S.selSuit === suit ? " sel" : "");
    b.disabled = suit === g.turned_down;
    b.innerHTML = `<b>${SUIT_GLYPH[suit]}</b><small>${SUIT_NAME[suit]}</small>`;
    if (b.disabled) b.title = "turned down";
    b.onclick = () => {
      SFX.click();
      S.selSuit = suit;
      renderBidSheet(S.st);
    };
    grid.appendChild(b);
  }
  $("call-btn").disabled = !S.selSuit;
  const stuck = g.stick_dealer && iAmDealer;
  $("pass2-btn").hidden = stuck;
  $("stick-note").hidden = !stuck;
}

/* ---------- scores ---------- */

function renderScores(st) {
  const g = game();
  const myTeam = mySeat() !== null ? seatInfo(mySeat()).team : 0;
  const set = (id, team) => {
    const el = $(id);
    el.querySelector("span").textContent = g.scores[String(team)];
    const pips = el.querySelector(".pips");
    pips.textContent = "";
    const took = seatInfo(team).tricks + seatInfo(team + 2).tricks;
    for (let i = 0; i < 5; i++) {
      const dot = document.createElement("i");
      dot.className = "pip" + (i < took ? " lit" : "");
      pips.appendChild(dot);
    }
  };
  set("score-us", myTeam); set("score-them", 1 - myTeam);
  $("score-target").textContent = `→ ${g.target}`;
}

function teamNames(team) {
  const g = game();
  return g.seats.filter((s) => s.team === team)
    .map((s) => playerByPid(s.pid)?.name || "?").join(" + ");
}

/* ---------- scorecard / game over ---------- */

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
  $("sc-title").textContent = `HAND ${g.hand_no} — ${SUIT_GLYPH[hr.trump]} ${SUIT_NAME[hr.trump]}`;
  $("sc-euchre").hidden = !hr.euchred;
  const myTeam = mySeat() !== null ? seatInfo(mySeat()).team : 0;
  if (hr.euchred && hr.maker_team === myTeam) SFX.euchre();
  const body = $("sc-body");
  body.textContent = "";
  for (const team of [myTeam, 1 - myTeam]) {
    const isMakers = team === hr.maker_team;
    const scored = team === hr.scoring_team;
    const div = document.createElement("div");
    div.className = "sc-team " + (scored ? "made" : "set");
    const makerName = playerByPid(seatInfo(hr.maker_seat).pid)?.name || "?";
    const label = isMakers
      ? `made it: ${makerName}${hr.alone ? " (ALONE)" : ""}`
      : "defending";
    const outcome = !isMakers ? (scored ? "EUCHRE! +2" : "")
      : hr.march ? `MARCH! +${hr.points}`
      : scored ? `made · +${hr.points}` : "EUCHRED";
    const rows = [
      [`${team === myTeam ? "US" : "THEM"} — ${teamNames(team)}`, ""],
      [label, outcome],
      [`tricks taken`, `${hr.tricks[String(team)]} / 5`],
      [`hand points`, scored ? `+${hr.points}` : "0"],
      [`match total (to ${g.target})`, String(g.scores[String(team)])],
    ];
    for (const [l, v] of rows) {
      const row = document.createElement("div");
      row.className = "sc-row";
      const a = document.createElement("span"); a.textContent = l;
      const b = document.createElement("b");
      b.textContent = v;
      if (v.startsWith("+") || v.includes("+")) b.className = "pos";
      if (v === "EUCHRED") b.className = "neg";
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
    renderTrumpChip(st);
    renderHand(st);
    renderBidSheet(st);
    renderScores(st);
    renderScorecard(st);
  }
  renderGameOver(st);
  $("countdown-overlay").hidden = st.phase !== "countdown";
  if (st.game && !["playing", "discard"].includes(game().stage)) S.selCard = null;
}

function onFx(fx) {
  switch (fx.kind) {
    case "toast": Hub.toast((fx.icon ? fx.icon + " " : "") + fx.msg); break;
    case "invalid": Hub.toast(fx.msg, "err"); SFX.bad(); break;
    case "played": if (fx.pid !== S.pid) SFX.snap(); break;
    case "bid_pass": {
      const p = playerByPid(fx.pid);
      Hub.toast(`${p ? p.name : "?"} passes`);
      SFX.click();
      break;
    }
    case "ordered": case "called": {
      const p = playerByPid(fx.pid);
      const verb = fx.kind === "ordered" ? "orders up" : "calls";
      Hub.toast(`${p ? p.name : "?"} ${verb} ${SUIT_GLYPH[fx.suit]}`
        + (fx.alone ? " — ALONE!" : ""));
      if (fx.alone) SFX.alone(); else SFX.turn();
      break;
    }
    case "turned_down":
      Hub.toast(`${SUIT_GLYPH[fx.suit]} turned down — name another suit`);
      SFX.click();
      break;
    case "picked": Hub.toast("dealer buried a card"); SFX.snap(); break;
    case "redeal": SFX.bad(); break;
    case "trick_won": {
      S.trickFlashUntil = Date.now() + 650;
      if (fx.pid === S.pid) SFX.win();
      setTimeout(() => $("trick-area").classList.add("won"), 420);  // sweep
      setTimeout(() => { if (S.st) onState(S.st); }, 700);
      break;
    }
    case "hand_start": S.selCard = null; S.selSuit = null; break;
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
  if (ACTING(g)) {
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
  S.conn = Hub.connect("/games/euchre/ws", {
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

$("order-btn").onclick = () => {
  SFX.unlock();
  S.conn.send({ t: "bid", call: "order", alone: $("alone-toggle").checked });
};
$("pass1-btn").onclick = () => { SFX.unlock(); S.conn.send({ t: "bid", call: "pass" }); };
$("pass2-btn").onclick = () => { SFX.unlock(); S.conn.send({ t: "bid", call: "pass" }); };
$("call-btn").onclick = () => {
  if (!S.selSuit) return;
  SFX.unlock();
  S.conn.send({ t: "bid", call: "call", suit: S.selSuit,
                alone: $("alone-toggle").checked });
};

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
      title: "Euchre", icon: "🎴",
      winner: { name: winners.map((p) => p.name).join(" + "),
                avatar: "🎴",
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
