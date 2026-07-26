/* PRICE CHECK controller — lock in a number; closest wins. */
"use strict";

const $ = (id) => document.getElementById(id);
let ST = null, PID = null, joined = false;
let entry = "", entryRound = -1, sentLock = false;
let avatar = Hub.identity.avatar || Hub.AVATARS[0];
let muted = localStorage.getItem("wc-muted") === "1";
let lastItemKey = "", lastRevealKey = "", lastGameOverKey = "";
const esc = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------- feedback + accessibility ---------- */
const reduceMotion = () => !!(window.matchMedia
  && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
function announce(message) {
  const el = $("game-status");
  if (!el || !message) return;
  if (el.textContent === message) {
    el.textContent = "";
    requestAnimationFrame(() => { el.textContent = message; });
  } else {
    el.textContent = message;
  }
}
function buzz(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (error) {}
}
function celebrate(amount) {
  if (!reduceMotion()) Hub.confettiBurst(amount);
}
const SFX = (() => {
  let ctx = null;
  const ac = () => {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  };
  const tone = (frequency, type, duration, volume = 0.07, delay = 0, glide = 0) => {
    if (muted) return;
    try {
      const c = ac(), at = c.currentTime + delay;
      const osc = c.createOscillator(), gain = c.createGain();
      osc.type = type; osc.frequency.setValueAtTime(frequency, at);
      if (glide) osc.frequency.exponentialRampToValueAtTime(
        Math.max(35, frequency + glide), at + duration);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(volume, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
      osc.connect(gain); gain.connect(c.destination);
      osc.start(at); osc.stop(at + duration + 0.03);
    } catch (error) { /* WebAudio is optional and may be gesture-gated. */ }
  };
  return {
    unlock: () => { try { ac(); } catch (error) {} },
    tap: () => tone(690, "square", 0.04, 0.03),
    erase: () => tone(260, "triangle", 0.055, 0.035, 0, -90),
    item: () => { tone(440, "triangle", 0.08, 0.045); tone(660, "triangle", 0.11, 0.05, 0.06); },
    lock: () => { tone(330, "sine", 0.1, 0.075); tone(660, "sine", 0.14, 0.065, 0.07); },
    reveal: () => { tone(880, "triangle", 0.1, 0.065); tone(440, "triangle", 0.18, 0.055, 0.12); },
    win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, "sine", 0.24, 0.095, i * 0.09)),
    bad: () => tone(145, "sawtooth", 0.18, 0.065, 0, -55),
  };
})();
function syncMuteControls() {
  for (const id of ["mute-btn", "mute-btn2"]) {
    const button = $(id);
    if (!button) continue;
    button.textContent = muted ? "🔇" : "🔊";
    button.setAttribute("aria-pressed", muted ? "true" : "false");
    button.setAttribute("aria-label", muted ? "Unmute sound" : "Mute sound");
    button.title = muted ? "Sound off" : "Sound on";
  }
}
function wireMute(id) {
  const button = $(id);
  button.onclick = () => {
    SFX.unlock();
    if (!muted) SFX.tap();
    muted = !muted;
    localStorage.setItem("wc-muted", muted ? "1" : "0");
    syncMuteControls();
    if (!muted) SFX.item();
    announce(muted ? "Sound off" : "Sound on");
  };
}

function show(id) { for (const s of ["scr-join", "scr-lobby", "scr-game"]) $(s).hidden = s !== id; }

function fmt(v, item) {
  const n = Number(v);
  if (!isFinite(n)) return "—";
  if (item && item.money) {
    const s = Number.isInteger(n) ? n.toLocaleString()
      : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return "$" + s;
  }
  const s = Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return s + (item && item.unit ? " " + item.unit : "");
}

/* ---------- join ---------- */
Hub.buildAvatarGrid($("avatar-grid"), avatar, (a) => { avatar = a; });
$("name-input").value = Hub.identity.name || "";
Hub.wirePfpButton($("pfp-btn"), () => conn, () => {});
Hub.wirePfpButton($("pfp-btn2"), () => conn, () => {});
$("join-btn").onclick = () => {
  SFX.unlock(); SFX.tap();
  Hub.identity.name = ($("name-input").value || "").trim() || "PLAYER";
  Hub.identity.avatar = avatar;
  joined = true;
  conn.send({ t: "profile", name: Hub.identity.name, avatar });
  render(ST);
};
$("name-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") $("join-btn").click();
});

/* ---------- lobby settings ---------- */
const SEGS = [
  { host: "opt-rule",   key: "rule",   opts: [["closest", "CLOSEST"], ["over", "NO OVER"]] },
  { host: "opt-rounds", key: "rounds", opts: [[3, "3"], [5, "5"], [8, "8"]] },
  { host: "opt-clock",  key: "clock",  opts: [[20, "20s"], [30, "30s"], [45, "45s"]] },
];
for (const seg of SEGS) {
  for (const [val, label] of seg.opts) {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = label; b._val = val;
    b.onclick = () => {
      SFX.unlock(); SFX.tap();
      conn.send({ t: "settings", patch: { [seg.key]: val } });
    };
    $(seg.host).appendChild(b);
  }
}
function renderSegs(st) {
  for (const seg of SEGS) {
    for (const b of $(seg.host).children) {
      const selected = b._val === st.settings[seg.key];
      b.classList.toggle("sel", selected);
      b.setAttribute("aria-pressed", selected ? "true" : "false");
    }
  }
  $("rule-note").innerHTML = st.settings.rule === "over"
    ? "🎯 <b>NO OVER</b> — closest without going over wins the round (go over and you're out). Price-Is-Right style."
    : "🎯 <b>CLOSEST</b> — nearest guess wins, over or under. Most round wins takes it.";
}

function renderPlayers(st) {
  const host = $("player-grid"); host.textContent = "";
  for (const p of st.players) {
    const card = document.createElement("div");
    card.className = "player-card" + (p.ready ? " is-ready" : "") + (p.connected ? "" : " is-away");
    const av = document.createElement("span"); av.className = "pc-avatar"; Hub.fillAvatar(av, p);
    const nm = document.createElement("span"); nm.className = "pc-name"; nm.textContent = p.name + (p.bot ? " 🤖" : "");
    const stt = document.createElement("span"); stt.className = "pc-status"; stt.textContent = p.bot ? "BOT" : (p.ready ? "READY" : "…");
    card.append(av, nm, stt); host.appendChild(card);
  }
}

/* ---------- keypad ---------- */
(function buildPad() {
  const host = $("pc-pad");
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"];
  for (const k of keys) {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = k;
    b.className = "pc-key" + (k === "⌫" || k === "." ? " util" : "");
    b.setAttribute("aria-label", k === "⌫" ? "Delete last digit" : (k === "." ? "Decimal point" : k));
    b.onclick = () => tapKey(k);
    host.appendChild(b);
  }
})();
function tapKey(k) {
  SFX.unlock();
  if (k === "⌫") SFX.erase(); else SFX.tap();
  buzz(10);
  if (k === "⌫") entry = entry.slice(0, -1);
  else if (k === ".") { if (!entry.includes(".") && entry.length < 12) entry += entry ? "." : "0."; }
  else if (entry.replace(".", "").length < 12) {
    if (entry === "0") entry = k; else entry += k;
  }
  paintEntry();
}
function paintEntry() {
  const item = ST && ST.game && ST.game.item;
  const money = item && item.money;
  $("pc-readout").innerHTML = (money ? "$" : "") + esc(entry || "0")
    + (!money && item && item.unit ? ` <small style="font-size:0.5em;color:var(--muted)">${esc(item.unit)}</small>` : "");
  const ok = entry !== "" && entry !== "." && isFinite(Number(entry));
  $("lock-btn").disabled = !ok;
}
$("lock-btn").onclick = () => {
  const v = Number(entry);
  if (!isFinite(v) || entry === "") return;
  SFX.unlock(); SFX.lock(); buzz([35, 25, 60]);
  sentLock = true;
  $("lock-btn").disabled = true;
  const item = ST && ST.game && ST.game.item;
  announce("Locked in " + fmt(v, item));
  conn.send({ t: "guess", value: v });
  conn.send({ t: "lock" });
};
document.addEventListener("keydown", (event) => {
  if ($("scr-game").hidden || $("pc-guess").hidden || sentLock) return;
  if (/^[0-9]$/.test(event.key)) { event.preventDefault(); tapKey(event.key); }
  else if (event.key === ".") { event.preventDefault(); tapKey("."); }
  else if (event.key === "Backspace") { event.preventDefault(); tapKey("⌫"); }
  else if (event.key === "Enter" && !$("lock-btn").disabled) {
    event.preventDefault(); $("lock-btn").click();
  }
});

/* ---------- game render ---------- */
function subPanel(id) { for (const s of ["pc-guess", "pc-locked", "pc-reveal"]) $(s).hidden = s !== id; }

function renderGame(st) {
  const g = st.game; if (!g) return;
  const item = g.item;
  $("pc-round").textContent = g.round + "/" + g.rounds;
  $("pc-header").textContent = item.money ? "WHAT'S THE PRICE?" : "WHAT'S THE NUMBER?";
  $("pc-emoji").textContent = item.emoji;
  $("pc-prompt").textContent = item.prompt;
  const itemKey = g.round + ":" + item.prompt;
  if (g.stage === "guessing" && itemKey !== lastItemKey) {
    lastItemKey = itemKey;
    SFX.item();
    announce("Round " + g.round + ". " + item.prompt + ". Enter your guess.");
  }

  if (g.stage === "guessing") {
    if (g.round !== entryRound) { entry = ""; entryRound = g.round; sentLock = false; }
    if (g.my_locked || sentLock) {
      subPanel("pc-locked");
      $("pc-mylock").textContent = g.my_guess != null ? fmt(g.my_guess, item) : "—";
    } else {
      subPanel("pc-guess");
      paintEntry();
    }
  } else if (g.stage === "reveal" || g.stage === "game_end") {
    subPanel("pc-reveal");
    $("pc-answer").textContent = g.answer != null ? fmt(g.answer, item) : "—";
    $("pc-fact").textContent = g.fact || "";
    renderRanks(st, g);
    const revealKey = g.round + ":" + g.answer;
    if (revealKey !== lastRevealKey) {
      lastRevealKey = revealKey;
      const mine = (g.last_winners || []).includes(PID);
      if (mine) {
        SFX.win(); buzz([55, 35, 110]); celebrate(120);
      } else {
        SFX.reveal(); buzz(35);
      }
      const winners = (g.last_winners || []).map(nameOf);
      announce("Actual answer: " + fmt(g.answer, item) + ". "
        + (mine ? "You won the round."
          : (winners.length ? winners.join(" and ") + " won the round." : "No round winner.")));
    }
  }
}

function nameOf(pid) { const p = ST && ST.players.find((q) => q.pid === pid); return p ? p.name : "player"; }

function renderRanks(st, g) {
  const host = $("pc-ranks"); host.textContent = "";
  for (const r of (g.reveal || [])) {
    const p = st.players.find((q) => q.pid === r.pid);
    const el = document.createElement("div");
    el.className = "pc-rank" + (r.won ? " won" : "");
    const av = document.createElement("span"); av.className = "pr-av"; Hub.fillAvatar(av, p || {});
    const nm = document.createElement("span"); nm.className = "pr-name";
    nm.textContent = (p ? p.name : r.pid) + (r.won ? " 👑" : "") + (r.bullseye ? " 🎯" : "");
    const gs = document.createElement("span"); gs.className = "pr-guess"; gs.textContent = fmt(r.guess, g.item);
    el.append(av, nm, gs); host.appendChild(el);
  }
}

function renderGameOver(st, g) {
  const res = g.result || [];
  const top = res.length ? res[0].wins : 0;
  const champs = res.filter((e) => e.wins === top && top > 0).map((e) => nameOf(e.pid));
  $("go-title").textContent = champs.length
    ? champs.join(" & ") + (champs.length === 1 ? " WINS!" : " WIN!") : "GOOD GAME";
  const host = $("go-rows"); host.textContent = "";
  for (const e of res) {
    const p = st.players.find((q) => q.pid === e.pid);
    const row = document.createElement("div");
    row.className = "go-row" + (e.wins === top && top > 0 ? " first" : "");
    const av = document.createElement("span"); av.className = "gr-av"; Hub.fillAvatar(av, p || {});
    const nm = document.createElement("span"); nm.className = "gr-name"; nm.textContent = p ? p.name : e.pid;
    const b = document.createElement("b"); b.textContent = e.wins + (e.wins === 1 ? " win" : " wins");
    row.append(av, nm, b); host.appendChild(row);
  }
  const resultKey = JSON.stringify(res);
  if (resultKey !== lastGameOverKey) {
    lastGameOverKey = resultKey;
    if (champs.includes(nameOf(PID))) {
      SFX.win(); buzz([70, 45, 140]); celebrate(180);
      announce("Game over. You are the Price Check champion.");
    } else {
      SFX.reveal();
      announce("Game over. " + (champs.length ? champs.join(" and ") + " won." : "Good game."));
    }
  }
  $("gameover").hidden = false;
}

/* ---------- top-level ---------- */
function render(st) {
  if (!st) return;
  ST = st;
  $("countdown-overlay").hidden = st.phase !== "countdown";
  if (!joined) { show("scr-join"); return; }

  if (st.phase === "lobby" || st.phase === "countdown") {
    show("scr-lobby");
    $("gameover").hidden = true;
    renderSegs(st); renderPlayers(st);
    const me = st.you;
    const readyN = st.players.filter((p) => p.ready && p.connected).length;
    $("ready-count").textContent = readyN + "/" + st.players.length + " ready";
    const canGo = me && me.ready && readyN >= st.min_players;
    $("ready-btn").hidden = !!(me && me.ready);
    $("go-btn").hidden = !canGo;
    $("ready-btn").onclick = () => {
      SFX.unlock(); SFX.lock(); buzz(35);
      conn.send({ t: "ready", ready: true });
      announce("Ready. Waiting for the game to start.");
    };
    $("go-btn").onclick = () => {
      SFX.unlock(); SFX.item(); buzz(45);
      conn.send({ t: "start" });
      announce("Starting Price Check.");
    };
    $("lobby-hint").textContent = canGo ? "you're the host — tap START"
      : (me && me.ready ? "waiting for the host to start…" : "ready up to play");
    entryRound = -1; lastItemKey = ""; lastRevealKey = ""; lastGameOverKey = "";
    return;
  }

  show("scr-game");
  renderGame(st);
  if (st.phase === "game_end" && st.game) renderGameOver(st, st.game);
  else $("gameover").hidden = true;
}

$("rematch-btn").onclick = () => {
  SFX.unlock(); SFX.tap();
  conn.send({ t: "again" }); $("gameover").hidden = true;
};

const conn = Hub.connect("/games/pricecheck/ws", {
  onWelcome: (m) => { PID = m.pid; if (Hub.identity.name) joined = true; render(ST); },
  onFx: (fx) => {
    if (fx.kind === "toast") Hub.toast((fx.icon ? fx.icon + " " : "") + fx.msg);
    if (fx.kind === "locked" && fx.pid === PID) {
      SFX.lock(); announce("Guess locked. Waiting for the others.");
    }
    if (fx.kind === "invalid") {
      Hub.toast(fx.msg, "err"); SFX.bad(); buzz(35); announce(fx.msg);
      sentLock = false; paintEntry();
    }
  },
  onState: render,
});

wireMute("mute-btn");
wireMute("mute-btn2");
syncMuteControls();
window.addEventListener("storage", (event) => {
  if (event.key !== "wc-muted") return;
  muted = event.newValue === "1";
  syncMuteControls();
});

if (Hub.identity.name) joined = true;
show(joined ? "scr-lobby" : "scr-join");
