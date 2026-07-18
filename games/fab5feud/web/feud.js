/* FAB5 FEUD client — survey board, team scores, contextual answering. */
"use strict";
const $ = (id) => document.getElementById(id);

const S = { st: null, pid: null, conn: null, joined: false,
            muted: localStorage.getItem("wc-muted") === "1" };

/* ---------------- sounds ---------------- */
const SFX = (() => {
  let ctx = null;
  const ac = () => { if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume(); return ctx; };
  const tone = (f, type, dur, vol = 0.12, when = 0, glide = 0) => {
    if (S.muted) return;
    try { const c = ac(), t = c.currentTime + when;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(f, t);
      if (glide) o.frequency.exponentialRampToValueAtTime(Math.max(40, f + glide), t + dur);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + dur + 0.05);
    } catch (e) {}
  };
  return {
    unlock: () => { try { ac(); } catch (e) {} },
    click: () => tone(700, "square", 0.04, 0.05),
    ding: () => { tone(784, "sine", 0.12, 0.14); tone(1175, "sine", 0.16, 0.12, 0.07); },
    buzz: () => tone(300, "square", 0.12, 0.1),
    strike: () => tone(150, "sawtooth", 0.32, 0.16, 0, -60),
    steal: () => { tone(523, "sine", 0.1, 0.12); tone(659, "sine", 0.12, 0.11, 0.08); },
    win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, "sine", 0.24, 0.13, i * 0.09)),
    turn: () => { tone(880, "sine", 0.1, 0.12); tone(1175, "sine", 0.13, 0.1, 0.07); },
  };
})();

const game = () => S.st?.game || null;
const playerByPid = (pid) => (S.st?.players || []).find((p) => p.pid === pid) || null;
const remainMs = () => S.st?.deadline ? Math.max(0, S.st.deadline - S.conn.now()) : 0;
function show(id) { for (const s of ["scr-join", "scr-lobby", "scr-game"]) $(s).hidden = s !== id; }

/* ---------------- lobby ---------------- */
function seg(hostId, options, current, key) {
  const host = $(hostId); host.textContent = "";
  for (const [val, label] of options) {
    const b = document.createElement("button");
    b.textContent = label; b.className = val === current ? "sel" : "";
    b.onclick = () => { SFX.click(); S.conn.send({ t: "settings", patch: { [key]: val } }); };
    host.appendChild(b);
  }
}

function renderLobby(st) {
  const ff = st.ff || { teams: {}, names: {}, counts: { A: 0, B: 0 }, my_side: null };
  const humans = st.players.filter((p) => !p.bot);
  const readyN = humans.filter((p) => p.ready && p.connected).length;
  $("ready-count").textContent = `${readyN} READY`;
  const total = humans.length;
  $("mode-note").textContent = total <= 2
    ? "2 players → HEAD-TO-HEAD (one per side)"
    : "3+ players → TEAMS (split into two sides)";

  for (const side of ["A", "B"]) {
    const col = $("col-" + side); col.textContent = "";
    const mem = humans.filter((p) => ff.teams[p.pid] === side);
    $("cap-" + side).textContent = ff.names[side] || ("SIDE " + side);
    for (const p of mem) {
      const chip = document.createElement("div");
      chip.className = "tp-chip" + (p.pid === S.pid ? " me" : "");
      const av = document.createElement("span"); av.className = "av";
      Hub.fillAvatar(av, p);
      const nm = document.createElement("span"); nm.textContent = p.name + (p.pid === S.pid ? " (you)" : "");
      chip.append(av, nm); col.appendChild(chip);
    }
    const jb = $("join-" + side);
    jb.classList.toggle("on", ff.my_side === side);
    jb.textContent = ff.my_side === side ? `✓ SIDE ${side}` : `JOIN ${side}`;
  }

  seg("opt-rounds", [[3, "3"], [5, "5"], [7, "7"]], st.settings.rounds, "rounds");
  const me = st.you;
  const amReady = !!(me && me.ready);
  $("ready-btn").textContent = amReady ? "READY ✓" : "READY UP";
  $("ready-btn").classList.toggle("is-ready", amReady);
  $("go-btn").hidden = !(readyN >= st.min_players && amReady && st.phase === "lobby");
  $("lobby-hint").textContent = st.phase === "countdown" ? "SURVEY SAYS…"
    : readyN >= 2 ? "ready when you are — first to START kicks it off"
    : readyN === 1 ? "need one more player…" : `waiting — ${location.host}`;
}

/* ---------------- game ---------------- */
function renderGame(st) {
  const g = st.game; if (!g) return;
  $("fd-round").textContent = `ROUND ${g.round_no}/${g.rounds_total}`;
  $("fd-mult").hidden = g.mult <= 1;

  // scores
  for (const side of ["A", "B"]) {
    const el = $("ss-" + side);
    el.className = "side-score " + side.toLowerCase() + "-side" + (g.control === side ? " control" : "");
    el.querySelector(".ss-name").textContent = g.names[side];
    el.querySelector(".ss-pts").textContent = g.scores[side];
  }
  $("pot-val").textContent = g.pot;

  // strikes
  const sk = $("strikes"); sk.textContent = "";
  for (let i = 0; i < 3; i++) {
    const x = document.createElement("span");
    x.className = "strike-x" + (i < g.strikes ? " on" : "");
    x.textContent = "✕"; sk.appendChild(x);
  }

  // board
  $("fd-q").textContent = g.q;
  const bd = $("board"); bd.textContent = "";
  for (const a of g.answers) {
    const slot = document.createElement("div");
    slot.className = "slot " + (a.revealed ? "revealed" : "hidden");
    const rank = document.createElement("span"); rank.className = "rank"; rank.textContent = a.rank;
    const txt = document.createElement("span"); txt.className = "txt";
    txt.textContent = a.revealed ? a.text : "• • •";
    const pts = document.createElement("span"); pts.className = "pts";
    pts.textContent = a.revealed ? a.pts : "";
    slot.append(rank, txt, pts); bd.appendChild(slot);
  }

  renderStatusAndControls(g);
}

function renderStatusAndControls(g) {
  const status = $("fd-status");
  const choice = $("ctl-choice"), guess = $("ctl-guess"), wait = $("ctl-wait");
  choice.hidden = true; guess.hidden = true; wait.hidden = true;
  status.className = "fd-status";
  const nameOf = (pid) => { const p = playerByPid(pid); return p ? p.name : "?"; };

  if (g.stage === "faceoff") {
    if (g.im_rep && !g.faceoff_done[g.my_side]) {
      status.innerHTML = `<span class="hot">FACE-OFF!</span> buzz in — the top answer wins control`;
      status.classList.add("mine"); guess.hidden = false; focusGuess();
    } else {
      const a = nameOf(g.reps.A), b = nameOf(g.reps.B);
      status.innerHTML = `<span class="hot">FACE-OFF</span> · ${a} vs ${b}`;
      wait.hidden = false; wait.textContent = g.im_rep ? "answer locked in — waiting…" : "the reps are facing off…";
    }
  } else if (g.stage === "choice") {
    status.textContent = `${g.names[g.control]} won the face-off!`;
    if (g.im_captain) { status.classList.add("mine"); choice.hidden = false; }
    else { wait.hidden = false; wait.textContent = `${nameOf(g.captain)} is choosing play or pass…`; }
  } else if (g.stage === "play") {
    if (g.my_turn) {
      status.innerHTML = `your turn — name an answer!`;
      status.classList.add("mine"); guess.hidden = false; focusGuess();
    } else {
      status.textContent = `${g.names[g.control]} playing · ${nameOf(g.turn)}'s turn`;
      wait.hidden = false; wait.textContent = "give the board a moment…";
    }
  } else if (g.stage === "steal") {
    status.innerHTML = `<span class="hot">STEAL!</span> ${g.names[g.steal_side]} — one guess for ${g.pot} pts`;
    if (g.can_steal) { status.classList.add("mine"); guess.hidden = false; focusGuess(); }
    else { wait.hidden = false; wait.textContent = `${g.names[g.steal_side]} is trying to steal it…`; }
  } else if (g.stage === "reveal") {
    wait.hidden = false; wait.textContent = "board revealed — next survey coming up";
  }
}

let lastFocus = "";
function focusGuess() {
  const key = (game() || {}).stage + (game() || {}).turn + (game() || {}).my_turn;
  if (key !== lastFocus) { lastFocus = key; setTimeout(() => $("guess-input").focus(), 30); }
}

/* round banner + game over */
let bannerKey = "";
function renderBanner(st) {
  const g = st.game;
  const showIt = g && g.stage === "reveal" && g.outcome;
  $("round-banner").hidden = !showIt;
  if (!showIt) { bannerKey = ""; return; }
  const o = g.outcome;
  const key = "r" + g.round_no;
  if (bannerKey === key) return;
  bannerKey = key;
  const reason = { swept: "SWEPT THE BOARD!", stole: "STOLE IT!", held: "HELD ON!", timeout: "" }[o.reason] || "";
  $("rb-title").textContent = `${o.name} +${o.award}`;
  $("rb-sub").textContent = reason + (o.mult > 1 ? `  (×${o.mult} double round)` : "");
}

let goShown = false;
function renderGameOver(st) {
  const g = st.game;
  const showIt = st.phase === "game_end" && g && g.result;
  $("gameover").hidden = !showIt;
  if (!showIt) { goShown = false; return; }
  const r = g.result;
  $("go-title").textContent = r.tie ? "IT'S A TIE!" : `${r.winner_name} WINS!`;
  const rows = $("go-rows"); rows.textContent = "";
  const sides = [...r.sides].sort((a, b) => b.score - a.score);
  for (const sd of sides) {
    const div = document.createElement("div");
    div.className = "go-row" + (!r.tie && sd.side === r.winner ? " first" : "");
    const nm = document.createElement("span"); nm.className = "gr-name"; nm.textContent = sd.name;
    const b = document.createElement("b"); b.textContent = sd.score;
    div.append(nm, b); rows.appendChild(div);
  }
  if (!goShown) {
    goShown = true;
    if (!r.tie && g.my_side === r.winner) { Hub.confettiBurst(200); SFX.win(); }
    else SFX.ding();
  }
}

/* ---------------- fx ---------------- */
function onFx(fx) {
  switch (fx.kind) {
    case "toast": Hub.toast((fx.icon ? fx.icon + " " : "") + fx.msg); break;
    case "invalid": Hub.toast(fx.msg, "err"); SFX.buzz(); break;
    case "buzz": SFX.buzz(); break;
    case "reveal": SFX.ding(); break;
    case "strike": SFX.strike(); if (fx.pid !== S.pid) Hub.toast("STRIKE! ✕", "err"); break;
    case "steal_open": SFX.steal(); break;
    case "faceoff_won": Hub.toast(`${fx.name} takes control`, ""); break;
    case "play_begins": if (fx.passed) Hub.toast(`passed to ${fx.name}`); SFX.turn(); break;
    case "round_start": SFX.turn(); break;
    case "round_end": SFX.ding(); break;
  }
}

/* ---------------- state ---------------- */
function onState(st) {
  S.st = st;
  if (!S.joined) return;
  if (st.phase === "lobby" || st.phase === "countdown") { show("scr-lobby"); renderLobby(st); }
  else if (st.game) { show("scr-game"); renderGame(st); renderBanner(st); }
  renderGameOver(st);
  $("countdown-overlay").hidden = st.phase !== "countdown";
}

/* ---------------- controls ---------------- */
$("join-A").onclick = () => { SFX.click(); S.conn.send({ t: "team", side: "A" }); };
$("join-B").onclick = () => { SFX.click(); S.conn.send({ t: "team", side: "B" }); };
$("ready-btn").onclick = () => { SFX.unlock(); SFX.click();
  const me = S.st?.you; S.conn.send({ t: "ready", ready: !(me && me.ready) }); };
$("go-btn").onclick = () => { SFX.unlock(); S.conn.send({ t: "start" }); };
$("btn-play").onclick = () => { SFX.click(); S.conn.send({ t: "choice", play: true }); };
$("btn-pass").onclick = () => { SFX.click(); S.conn.send({ t: "choice", play: false }); };
$("ctl-guess").addEventListener("submit", (e) => {
  e.preventDefault();
  const w = $("guess-input").value.trim();
  if (!w) return;
  S.conn.send({ t: "guess", word: w });
  $("guess-input").value = "";
});
$("rematch-btn").onclick = () => S.conn.send({ t: "again" });

/* brag */
if (window.Brag) {
  const btn = Brag.button(() => {
    const g = game();
    if (!g || !g.result || g.result.tie) return null;
    const r = g.result;
    const win = r.sides.find((s) => s.side === r.winner);
    const lose = r.sides.find((s) => s.side !== r.winner);
    let av = "📋", pfp = null;
    if (win.members.length === 1) { const p = playerByPid(win.members[0]); if (p) { av = p.avatar; pfp = p.pfp; } }
    return {
      title: "Fab5 Feud", icon: "📋",
      winner: { name: r.winner_name, avatar: av, pfp },
      headline: `${win.score} points`,
      beaten: [{ name: lose.name, score: lose.score }],
    };
  });
  document.querySelector("#gameover .modal-card").insertBefore(btn, $("rematch-btn"));
}

function wireMute(btn) {
  btn.onclick = () => { S.muted = !S.muted; localStorage.setItem("wc-muted", S.muted ? "1" : "0");
    $("mute-btn").textContent = $("mute-btn2").textContent = S.muted ? "🔇" : "🔊"; };
  btn.textContent = S.muted ? "🔇" : "🔊";
}
wireMute($("mute-btn")); wireMute($("mute-btn2"));

/* timers (countdown + reveal next) */
function raf() {
  requestAnimationFrame(raf);
  const st = S.st; if (!st) return;
  if (st.phase === "countdown") $("countdown-num").textContent = Math.max(1, Math.ceil(remainMs() / 1000));
  if (st.game && st.game.stage === "reveal") $("rb-next").textContent = `next in ${Math.ceil(remainMs() / 1000)}s`;
  if (st.phase === "game_end") $("go-auto").textContent = `lobby in ${Math.ceil(remainMs() / 1000)}s`;
}
requestAnimationFrame(raf);

window.__st = () => S.st;    // test hook (read-only)

/* ---------------- boot ---------------- */
function connect() {
  S.conn = Hub.connect("/games/fab5feud/ws", { onWelcome: (m) => { S.pid = m.pid; }, onState, onFx });
}
let avatarPick = Hub.identity.avatar || Hub.AVATARS[(Math.random() * Hub.AVATARS.length) | 0];
Hub.buildAvatarGrid($("avatar-grid"), avatarPick, (a) => { avatarPick = a; });
Hub.wirePfpButton($("pfp-btn"), () => S.conn);
Hub.wirePfpButton($("pfp-btn2"), () => S.conn);
$("name-input").value = Hub.identity.name;
$("join-btn").onclick = () => {
  SFX.unlock();
  Hub.identity.name = $("name-input").value.trim() || "PLAYER";
  Hub.identity.avatar = avatarPick;
  S.joined = true; connect(); show("scr-lobby");
};
$("name-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("join-btn").click(); });
if (Hub.identity.name) { S.joined = true; connect(); show("scr-lobby"); } else { show("scr-join"); }
