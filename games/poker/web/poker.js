/* TEXAS HOLD'EM client. Server-authoritative: renders state snapshots, plays fx.
   Uses /shared/hubnet.js (identity/sockets/toasts/confetti) + /shared/brag.js. */
"use strict";

const $ = (id) => document.getElementById(id);
const SUIT = { S: "♠", H: "♥", D: "♦", C: "♣" };

const S = {
  st: null, pid: null, conn: null, joined: false,
  raiseOpen: false, lastBoard: 0, lastHand: "", lastTick: -1,
  muted: localStorage.getItem("wc-muted") === "1",
};

/* ---------- tiny synth ---------- */
const SFX = (() => {
  let ctx = null;
  const ac = () => {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  };
  function tone(f, type, dur, vol = 0.13, when = 0, glide = 0) {
    if (S.muted) return;
    try {
      const c = ac(), t = c.currentTime + when;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(f, t);
      if (glide) o.frequency.exponentialRampToValueAtTime(Math.max(40, f + glide), t + dur);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + dur + 0.05);
    } catch (e) {}
  }
  return {
    unlock: () => { try { ac(); } catch (e) {} },
    chip: () => { tone(760, "square", 0.05, 0.06); tone(520, "square", 0.05, 0.05, 0.03); },
    deal: () => tone(320, "triangle", 0.05, 0.09, 0, 120),
    check: () => tone(300, "sine", 0.09, 0.1),
    call: () => { tone(680, "square", 0.05, 0.06); tone(500, "square", 0.06, 0.05, 0.04); },
    raise: () => { [600, 780, 960].forEach((f, i) => tone(f, "square", 0.06, 0.06, i * 0.04)); },
    allin: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, "sine", 0.16, 0.1, i * 0.06)),
    fold: () => tone(160, "sawtooth", 0.12, 0.07, 0, -50),
    turn: () => { tone(880, "sine", 0.1, 0.12); tone(1175, "sine", 0.13, 0.1, 0.08); },
    win: () => [523, 659, 784].forEach((f, i) => tone(f, "sine", 0.2, 0.12, i * 0.08)),
    fanfare: () => [392, 523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, "sine", 0.3, 0.12, i * 0.11)),
    bad: () => tone(150, "sawtooth", 0.2, 0.08, 0, -60),
    tick: () => tone(1150, "square", 0.03, 0.045),
  };
})();

/* ---------- helpers ---------- */
const fmt = (n) => (n || 0).toLocaleString("en-US");
function game() { return S.st?.game || null; }
function mySeat() { const g = game(); return g ? g.my_seat : null; }
function baseSeat() { const m = mySeat(); return m === null ? 0 : m; }
function relPos(seat, n) { return (seat - baseSeat() + n) % n; }
function playerByPid(pid) { return (S.st?.players || []).find((p) => p.pid === pid) || null; }
function remainMs() { return S.st?.deadline ? Math.max(0, S.st.deadline - S.conn.now()) : 0; }

function cardEl(card, cls = "") {
  const d = document.createElement("div");
  d.className = "card " + cls + ("HD".includes(card[1]) ? " red" : "");
  const r = document.createElement("span"); r.className = "cr";
  r.textContent = card[0] === "T" ? "10" : card[0];
  const s = document.createElement("span"); s.className = "cs";
  s.textContent = SUIT[card[1]];
  d.appendChild(r); d.appendChild(s);
  return d;
}
function backEl(cls = "") {
  const d = document.createElement("div");
  d.className = "card back " + cls;
  return d;
}
function show(id) {
  for (const s of ["scr-join", "scr-lobby", "scr-table"]) $(s).hidden = s !== id;
}

/* ---------- lobby ---------- */
const TABLES = [[2, "HEADS-UP"], [4, "4-MAX"], [6, "6-MAX"], [9, "FULL RING"]];
const SPEEDS = [["turbo", "TURBO"], ["standard", "STANDARD"], ["deep", "DEEP"]];
const DIFFS = [["mixed", "MIXED"], ["fish", "FISH"], ["shark", "SHARK"], ["maniac", "MANIAC"]];
const SPEED_NOTE = {
  turbo: "1,000 chips · 10/20 · blinds jump fast",
  standard: "1,500 chips · 10/20 · blinds rise steady",
  deep: "3,000 chips · 10/20 · deep stacks, slow rise",
};

function seg(hostId, options, current, key) {
  const host = $(hostId); host.textContent = "";
  for (const [val, label] of options) {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = val === current ? "sel" : "";
    b.onclick = () => { SFX.unlock(); SFX.chip(); S.conn.send({ t: "settings", patch: { [key]: val } }); };
    host.appendChild(b);
  }
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
    if (p.pid === S.pid) {
      const yt = document.createElement("span"); yt.className = "you-tag"; yt.textContent = "YOU"; nm.appendChild(yt);
    }
    const stt = document.createElement("div");
    stt.className = "pc-status" + (p.ready ? " rdy" : "");
    stt.textContent = !p.connected ? "away" : p.ready ? "READY" : "not ready";
    meta.appendChild(nm); meta.appendChild(stt);
    card.appendChild(av); card.appendChild(meta); grid.appendChild(card);
  }
  const readyN = humans.filter((p) => p.ready && p.connected).length;
  $("ready-count").textContent = `${readyN} READY`;
  const ts = st.settings.table_size;
  const fill = Math.max(humans.length, ts) - humans.length;
  $("seat-note").textContent = humans.length > ts
    ? `${humans.length} humans — table grows to seat everyone`
    : fill > 0 ? `${fill} bot${fill > 1 ? "s" : ""} fill the empty seats`
      : "full human table — no bots";

  seg("opt-table", TABLES, st.settings.table_size, "table_size");
  seg("opt-speed", SPEEDS, st.settings.speed, "speed");
  seg("opt-diff", DIFFS, st.settings.difficulty, "difficulty");
  $("turn-val").textContent = st.settings.turn_seconds + "s";
  $("rules-note").textContent = SPEED_NOTE[st.settings.speed] || "";

  const me = st.you, amReady = !!(me && me.ready);
  $("ready-btn").textContent = amReady ? "READY ✓" : "READY UP";
  $("ready-btn").classList.toggle("is-ready", amReady);
  $("go-btn").hidden = !(readyN >= st.min_players && amReady && st.phase === "lobby");
  $("lobby-hint").textContent =
    st.phase === "countdown" ? "SHUFFLING UP…"
    : readyN >= st.min_players ? "you're good — deal it out!"
    : `waiting for players — ${location.host}`;
}

/* ---------- table geometry ---------- */
const CX = 50, CY = 47, RX = 44, RY = 37;
function seatXY(rel, n) {
  const a = (90 + rel * (360 / n)) * Math.PI / 180;
  return [CX + RX * Math.cos(a), CY + RY * Math.sin(a)];
}
function lerp(px, py, cx, cy, f) { return [px + (cx - px) * f, py + (cy - py) * f]; }

function seatFor(seat) { return $("seats").querySelector(`[data-seat="${seat}"]`); }

/* ---------- table rendering ---------- */
function renderSeats(st) {
  const g = game(), n = g.n, host = $("seats");
  host.textContent = "";
  const showdownWinners = new Set((g.hand_result && g.stage === "hand_end")
    ? g.hand_result.winner_seats : []);
  for (const info of g.seats) {
    const seat = info.seat;
    const rel = relPos(seat, n);
    const [px, py] = seatXY(rel, n);

    const el = document.createElement("div");
    el.className = "seat";
    el.dataset.seat = seat;
    el.style.left = px + "%"; el.style.top = py + "%";
    const betting = ["preflop", "flop", "turn", "river"].includes(g.stage);
    if (seat === g.to_act && betting) el.classList.add("turn");
    if (!info.in_hand) el.classList.add("folded");
    if (info.all_in) el.classList.add("allin");
    if (info.bot === false && !info.connected) el.classList.add("away");
    if (showdownWinners.has(seat)) el.classList.add("winner");

    // last-action badge (above avatar)
    if (info.last_action && betting) {
      const badge = document.createElement("div");
      const aggr = ["bet", "raise", "allin"].includes(info.last_action);
      badge.className = "act-badge " + (aggr ? "aggr" : "pass");
      badge.textContent = info.last_action.toUpperCase();
      badge.style.left = "50%"; badge.style.top = "-8px";
      el.appendChild(badge);
    }

    // avatar + timer ring
    const avw = document.createElement("div"); avw.className = "seat-av";
    avw.innerHTML = '<svg viewBox="0 0 60 60"><circle class="rbg" cx="30" cy="30" r="26"/>'
      + '<circle class="rfg" cx="30" cy="30" r="26" style="stroke-dashoffset:163.4"/></svg>';
    const disc = document.createElement("div"); disc.className = "seat-disc";
    const p = playerByPid(info.pid);
    if (p) Hub.fillAvatar(disc, p); else disc.textContent = "🪑";
    avw.appendChild(disc); el.appendChild(avw);

    const nm = document.createElement("div"); nm.className = "seat-name";
    nm.textContent = info.name;
    if (seat === mySeat()) { const y = document.createElement("span"); y.className = "you-badge"; y.textContent = " YOU"; nm.appendChild(y); }
    else if (info.bot && info.tier) { const b = document.createElement("span"); b.className = "bot-badge"; b.textContent = " " + info.tier; nm.appendChild(b); }
    el.appendChild(nm);

    const stk = document.createElement("div"); stk.className = "seat-stack";
    stk.textContent = info.all_in ? "ALL-IN" : fmt(info.stack);
    el.appendChild(stk);

    // seat cards: mine + revealed face-up, others as backs
    const cards = document.createElement("div"); cards.className = "seat-cards";
    if (info.cards) { for (const c of info.cards) cards.appendChild(cardEl(c, "mini")); }
    else if (info.has_cards) { cards.appendChild(backEl("mini")); cards.appendChild(backEl("mini")); }
    el.appendChild(cards);
    host.appendChild(el);

    // dealer button
    if (info.is_button) {
      const [bx, by] = lerp(px, py, CX, CY, 0.26);
      const btn = document.createElement("div"); btn.className = "dealer-btn"; btn.textContent = "D";
      btn.style.left = (bx + 6) + "%"; btn.style.top = by + "%";
      host.appendChild(btn);
    }
    // committed chips this street, toward centre
    if (info.committed > 0 && betting) {
      const [cx, cy] = lerp(px, py, CX, CY, 0.42);
      const chip = document.createElement("div"); chip.className = "bet-chip";
      chip.textContent = fmt(info.committed);
      chip.style.left = cx + "%"; chip.style.top = cy + "%";
      host.appendChild(chip);
    }
  }
}

function renderBoard(st) {
  const g = game(), board = $("board");
  board.textContent = "";
  g.board.forEach((c, i) => {
    const el = cardEl(c, i >= S.lastBoard ? "deal-in" : "");
    board.appendChild(el);
  });
  S.lastBoard = g.board.length;
  $("pot").hidden = !(g.pot > 0);
  $("pot-amt").textContent = fmt(g.pot);
  $("head-hand").textContent = "HAND " + g.hand_no;
  $("head-blinds").textContent = fmt(g.sb) + " / " + fmt(g.bb);

  let msg = "";
  if (g.stage === "runout") msg = "ALL IN — running it out";
  else if (g.stage === "preflop" && g.board.length === 0 && g.pot > 0) msg = "";
  $("table-msg").textContent = msg;
}

function renderMyHand(st) {
  const g = game(), fan = $("my-hand");
  fan.textContent = "";
  const ms = mySeat();
  $("watch-note").hidden = ms !== null;
  if (ms === null) return;
  const me = g.seats[ms];
  fan.classList.toggle("fold", !me.in_hand);
  if (me.cards) for (const c of me.cards) fan.appendChild(cardEl(c, "big"));
  else if (me.has_cards) { fan.appendChild(backEl("big")); fan.appendChild(backEl("big")); }
}

function renderShowdown(st) {
  const g = game();
  const el = $("showdown-banner");
  if (g.stage === "hand_end" && g.hand_result) {
    const hr = g.hand_result;
    const names = hr.winner_pids.map((pid) => playerByPid(pid)?.name || "?");
    let hand = "";
    if (!hr.fold_win && hr.pots.length) {
      const best = hr.pots[hr.pots.length - 1].best;
      if (best) hand = "with " + best;
    }
    const won = Object.values(hr.winnings || {}).reduce((a, b) => a + b, 0);
    el.textContent = "";
    const w = document.createElement("div"); w.className = "sd-win";
    w.textContent = `${names.join(" & ")} win${names.length > 1 ? "" : "s"} ${fmt(won)}`;
    el.appendChild(w);
    const subText = hand || (hr.fold_win ? "everyone folded" : "");
    if (subText) {
      const h = document.createElement("div"); h.className = "sd-hand";
      h.textContent = subText; el.appendChild(h);
    }
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

/* ---------- action bar ---------- */
function renderAction(st) {
  const g = game(), bar = $("action-bar"), me = g.me;
  if (!me) { bar.hidden = true; S.raiseOpen = false; $("raise-panel").hidden = true; return; }
  bar.hidden = false;

  $("btn-check").hidden = !me.can_check;
  $("btn-call").hidden = me.can_check;
  if (!me.can_check) {
    const allin = me.to_call >= me.stack;
    $("btn-call").innerHTML = allin ? "CALL<small>ALL-IN " + fmt(me.stack) + "</small>"
      : "CALL<small>" + fmt(me.to_call) + "</small>";
  }
  $("btn-raise").hidden = !me.can_raise;
  if (me.can_raise) $("btn-raise").textContent = (me.current_bet === 0 ? "BET ▸" : "RAISE ▸");
  if (!me.can_raise && S.raiseOpen) S.raiseOpen = false;
  $("raise-panel").hidden = !S.raiseOpen;

  if (S.raiseOpen) {
    const sl = $("raise-slider");
    sl.min = me.min_raise_to; sl.max = me.max_raise_to; sl.step = 1;
    if (+sl.value < me.min_raise_to || +sl.value > me.max_raise_to) sl.value = me.min_raise_to;
    $("raise-amt").textContent = fmt(+sl.value);
    // pot-based presets clamped to [min,max]. A true no-limit pot-sized raise
    // first covers the call, THEN raises by the resulting pot:
    //   raise_to = current_bet + (pot_now + to_call).   (me.pot already includes
    //   the outstanding bet, so pot-after-call = me.pot + me.to_call.)
    const clamp = (v) => Math.max(me.min_raise_to, Math.min(me.max_raise_to, Math.round(v)));
    const potAfterCall = me.pot + me.to_call;
    const presets = [
      ["MIN", me.min_raise_to],
      ["½ POT", clamp(me.current_bet + potAfterCall * 0.5)],
      ["POT", clamp(me.current_bet + potAfterCall)],
      ["ALL-IN", me.max_raise_to],
    ];
    const host = $("raise-presets"); host.textContent = "";
    for (const [label, val] of presets) {
      const b = document.createElement("button"); b.textContent = label;
      b.onclick = () => { sl.value = val; $("raise-amt").textContent = fmt(val); SFX.chip(); };
      host.appendChild(b);
    }
  }
}

/* ---------- game over ---------- */
let goShown = false;
function renderGameOver(st) {
  const g = game();
  const showIt = st.phase === "game_end" && g && g.result;
  $("gameover").hidden = !showIt;
  if (!showIt) { goShown = false; return; }
  const r = g.result, w = playerByPid(r.winner_pid);
  $("go-title").textContent = (w ? w.name : "WINNER").toUpperCase() + " WINS";
  $("go-line").textContent = `took every chip in ${r.hands} hand${r.hands === 1 ? "" : "s"}`;
  if (!goShown) {
    goShown = true;
    Hub.confettiBurst(220); SFX.fanfare();
    if (r.winner_seat === mySeat()) setTimeout(() => Hub.confettiBurst(180), 600);
  }
}

/* ---------- state entry ---------- */
function onState(st) {
  S.st = st;
  if (!S.joined) return;
  if (st.phase === "lobby" || st.phase === "countdown") {
    show("scr-lobby");
    $("action-bar").hidden = true; $("showdown-banner").hidden = true;
    renderLobby(st);
  } else if (st.game) {
    show("scr-table");
    const g = st.game;
    if (g.hand_no + "" !== S.lastHand) { S.lastBoard = 0; S.lastHand = g.hand_no + ""; }
    renderSeats(st); renderBoard(st); renderMyHand(st);
    renderShowdown(st); renderAction(st);
  }
  renderGameOver(st);
  $("countdown-overlay").hidden = st.phase !== "countdown";
}

function onFx(fx) {
  switch (fx.kind) {
    case "toast": Hub.toast((fx.icon ? fx.icon + " " : "") + fx.msg); break;
    case "invalid": Hub.toast(fx.msg, "err"); SFX.bad(); break;
    case "post_blind": SFX.chip(); break;
    case "hand_start": S.raiseOpen = false; $("raise-panel").hidden = true; SFX.deal(); break;
    case "board": SFX.deal(); break;
    case "allin_runout": SFX.allin(); break;
    case "acted":
      if (fx.pid === S.pid) break;
      if (fx.action === "fold") SFX.fold();
      else if (fx.action === "check") SFX.check();
      else if (fx.action === "call") SFX.call();
      else if (fx.action === "allin") SFX.allin();
      else SFX.raise();
      break;
    case "showdown": break;
    case "pot_won": if (fx.pid === S.pid) SFX.win(); else SFX.chip(); break;
    case "game_over": break;
    case "countdown": SFX.turn(); break;
  }
}

/* ---------- rAF timers ---------- */
function raf() {
  requestAnimationFrame(raf);
  const st = S.st; if (!st) return;
  if (st.phase === "countdown") $("countdown-num").textContent = Math.max(1, Math.ceil(remainMs() / 1000));
  const g = game(); if (!g) return;
  const betting = ["preflop", "flop", "turn", "river"].includes(g.stage);
  if (betting && g.to_act !== null && g.to_act !== undefined) {
    const seatEl = seatFor(g.to_act);
    const ring = seatEl && seatEl.querySelector(".rfg");
    if (ring) {
      const frac = Math.min(1, remainMs() / (g.turn_seconds * 1000));
      ring.style.strokeDashoffset = 163.4 * (1 - frac);
      ring.style.stroke = frac < 0.25 ? "var(--danger)" : "var(--cyan)";
    }
    const sec = Math.ceil(remainMs() / 1000);
    if (sec !== S.lastTick && sec <= 5 && sec > 0 && g.to_act === mySeat()) { SFX.tick(); S.lastTick = sec; }
  }
  if (g.stage === "hand_end") {
    const b = $("showdown-banner");
    if (!b.hidden) { /* banner already shows result; countdown implicit */ }
  }
  if (st.phase === "game_end") $("go-auto").textContent = `back to lobby in ${Math.ceil(remainMs() / 1000)}s`;
}
requestAnimationFrame(raf);

let resizeT = null;
addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (S.st) onState(S.st); }, 150); });

/* ---------- action wiring ---------- */
function sendAct(move, amount) { SFX.unlock(); S.conn.send({ t: "act", move, amount: amount || 0 }); S.raiseOpen = false; }
$("btn-fold").onclick = () => { SFX.fold(); sendAct("fold"); };
$("btn-check").onclick = () => { SFX.check(); sendAct("check"); };
$("btn-call").onclick = () => { SFX.call(); sendAct("call"); };
$("btn-raise").onclick = () => { SFX.unlock(); S.raiseOpen = true; SFX.chip(); renderAction(S.st); };
$("raise-cancel").onclick = () => { S.raiseOpen = false; renderAction(S.st); };
$("raise-slider").oninput = () => { $("raise-amt").textContent = fmt(+$("raise-slider").value); };
$("raise-confirm").onclick = () => { SFX.raise(); sendAct("raise", +$("raise-slider").value); };

/* ---------- boot ---------- */
function connect() {
  S.conn = Hub.connect("/games/poker/ws", { onWelcome: (m) => { S.pid = m.pid; }, onState, onFx });
}
let avatarPick = Hub.identity.avatar || Hub.AVATARS[(Math.random() * Hub.AVATARS.length) | 0];

$("join-btn").onclick = () => {
  SFX.unlock();
  Hub.identity.name = $("name-input").value.trim() || "PLAYER";
  Hub.identity.avatar = avatarPick;
  S.joined = true; connect(); show("scr-lobby");
};
$("name-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("join-btn").click(); });
$("ready-btn").onclick = () => { SFX.unlock(); SFX.chip(); const me = S.st?.you; S.conn.send({ t: "ready", ready: !(me && me.ready) }); };
$("go-btn").onclick = () => { SFX.unlock(); S.conn.send({ t: "start" }); };
$("turn-minus").onclick = () => S.conn.send({ t: "settings", patch: { turn_seconds: Math.max(10, (S.st?.settings.turn_seconds || 25) - 5) } });
$("turn-plus").onclick = () => S.conn.send({ t: "settings", patch: { turn_seconds: Math.min(60, (S.st?.settings.turn_seconds || 25) + 5) } });
$("rematch-btn").onclick = () => S.conn.send({ t: "again" });

/* brag card */
if (window.Brag) {
  const btn = Brag.button(() => {
    const g = game();
    if (!g || !g.result) return null;
    const w = playerByPid(g.result.winner_pid);
    const losers = g.result.standings.filter((r) => r.pid !== g.result.winner_pid);
    return {
      title: "Texas Hold'em", icon: "♠️",
      winner: { name: w ? w.name : "?", avatar: w ? w.avatar : "♠️", pfp: w ? w.pfp : null },
      headline: `took every chip in ${g.result.hands} hands`,
      beaten: losers.slice(0, 4).map((r) => ({ name: playerByPid(r.pid)?.name || "?" })),
    };
  });
  document.querySelector("#gameover .modal-card").insertBefore(btn, $("rematch-btn"));
}

function wireMute(btn) {
  btn.textContent = S.muted ? "🔇" : "🔊";
  btn.onclick = () => {
    S.muted = !S.muted; localStorage.setItem("wc-muted", S.muted ? "1" : "0");
    $("mute-btn").textContent = $("mute-btn2").textContent = S.muted ? "🔇" : "🔊";
  };
}
wireMute($("mute-btn")); wireMute($("mute-btn2"));
Hub.wirePfpButton($("pfp-btn"), () => S.conn);
Hub.wirePfpButton($("pfp-btn2"), () => S.conn);
Hub.buildAvatarGrid($("avatar-grid"), avatarPick, (a) => { avatarPick = a; });
$("name-input").value = Hub.identity.name;

if (Hub.identity.name) { S.joined = true; connect(); show("scr-lobby"); }
else show("scr-join");
