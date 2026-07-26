/* WORD RUSH controller — build words from the shared rack (tap tiles or type). */
"use strict";

const $ = (id) => document.getElementById(id);
let ST = null, PID = null, joined = false;
let avatar = Hub.identity.avatar || Hub.AVATARS[0];
let rackLetters = [], order = [], current = [], roundKey = "", justFound = "";
let muted = localStorage.getItem("wc-muted") === "1";
let lastRevealKey = "", lastGameOverKey = "", lastTimerCue = -1;

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
    tap: () => tone(720, "square", 0.04, 0.03),
    tile: () => tone(420 + current.length * 55, "triangle", 0.055, 0.045),
    erase: () => tone(250, "triangle", 0.06, 0.04, 0, -85),
    shuffle: () => [420, 560, 700].forEach((f, i) => tone(f, "square", 0.045, 0.035, i * 0.035)),
    submit: () => tone(600, "sine", 0.1, 0.06, 0, 260),
    found: () => { tone(660, "sine", 0.11, 0.075); tone(990, "sine", 0.15, 0.065, 0.07); },
    pangram: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, "sine", 0.25, 0.095, i * 0.08)),
    reveal: () => { tone(440, "triangle", 0.12, 0.055); tone(330, "triangle", 0.16, 0.05, 0.09); },
    tick: () => tone(1100, "square", 0.035, 0.04),
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
    if (!muted) SFX.found();
    announce(muted ? "Sound off" : "Sound on");
  };
}

function show(id) { for (const s of ["scr-join", "scr-lobby", "scr-game"]) $(s).hidden = s !== id; }

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
  { host: "opt-size",   key: "size",   opts: [[6, "6"], [7, "7"], [8, "8"]] },
  { host: "opt-rounds", key: "rounds", opts: [[2, "2"], [3, "3"], [5, "5"]] },
  { host: "opt-clock",  key: "clock",  opts: [[60, "60s"], [90, "90s"], [120, "120s"]] },
];
for (const seg of SEGS)
  for (const [val, label] of seg.opts) {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = label; b._val = val;
    b.onclick = () => {
      SFX.unlock(); SFX.tap();
      conn.send({ t: "settings", patch: { [seg.key]: val } });
    };
    $(seg.host).appendChild(b);
  }
function renderSegs(st) {
  for (const seg of SEGS) {
    for (const b of $(seg.host).children) {
      const selected = b._val === st.settings[seg.key];
      b.classList.toggle("sel", selected);
      b.setAttribute("aria-pressed", selected ? "true" : "false");
    }
  }
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

/* ---------- word building ---------- */
function resetRack(rack) {
  rackLetters = rack.slice();
  order = rackLetters.map((_, i) => i);
  current = [];
}
function usedSet() { return new Set(current); }
function renderTiles() {
  const host = $("wr-rack");
  host.textContent = "";
  const used = usedSet();
  for (const i of order) {
    const t = document.createElement("button");
    t.type = "button";
    t.className = "wr-tile" + (used.has(i) ? " used" : "");
    t.textContent = (rackLetters[i] || "").toUpperCase();
    t.disabled = used.has(i);
    t.setAttribute("aria-pressed", used.has(i) ? "true" : "false");
    t.setAttribute("aria-label", "Letter " + t.textContent + (used.has(i) ? ", selected" : ""));
    t.onclick = () => {
      if (!used.has(i)) {
        current.push(i); SFX.unlock(); SFX.tile(); buzz(10);
        renderCurrent(); renderTiles();
      }
    };
    host.appendChild(t);
  }
}
function renderCurrent(cls) {
  const el = $("wr-current");
  el.className = "wr-current" + (cls ? " " + cls : "");
  if (!current.length) { el.innerHTML = '<span class="wr-cur-empty">tap letters to spell a word</span>'; }
  else el.textContent = current.map((i) => rackLetters[i]).join("").toUpperCase();
  el.setAttribute("aria-label", current.length
    ? "Current word: " + current.map((i) => rackLetters[i]).join(" ")
    : "No letters selected");
  $("wr-enter").disabled = current.length < 3;
}
function submitWord() {
  if (current.length < 3) return;
  const w = current.map((i) => rackLetters[i]).join("").toLowerCase();
  SFX.unlock(); SFX.submit(); buzz(20);
  announce("Submitting " + w.toUpperCase());
  conn.send({ t: "word", w });
  current = [];
  renderCurrent(); renderTiles();
}
function typeLetter(ch) {
  const used = usedSet();
  const i = order.find((k) => !used.has(k) && rackLetters[k] === ch);
  if (i !== undefined) {
    current.push(i); SFX.unlock(); SFX.tile(); buzz(10);
    renderCurrent(); renderTiles();
  }
}
$("wr-enter").onclick = submitWord;
$("wr-del").onclick = () => {
  if (!current.length) return;
  current.pop(); SFX.unlock(); SFX.erase(); buzz(10);
  renderCurrent(); renderTiles();
};
$("wr-shuffle").onclick = () => {
  SFX.unlock(); SFX.shuffle(); buzz(18);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  current = []; renderCurrent(); renderTiles(); announce("Letters shuffled.");
};
document.addEventListener("keydown", (e) => {
  if ($("scr-game").hidden || !ST || !ST.game || ST.game.stage !== "playing") return;
  if (e.key === "Enter") { e.preventDefault(); submitWord(); }
  else if (e.key === "Backspace") { e.preventDefault(); $("wr-del").click(); }
  else if (e.key === "Escape") {
    current = []; SFX.erase(); renderCurrent(); renderTiles(); announce("Word cleared.");
  }
  else if (/^[a-zA-Z]$/.test(e.key)) { typeLetter(e.key.toLowerCase()); }
});

function renderFound(g) {
  const host = $("wr-found"); host.textContent = "";
  $("wr-mine").textContent = g.my_words.length + (g.my_words.length === 1 ? " word · " : " words · ") + g.my_round + " pts";
  if (!g.my_words.length) {
    host.innerHTML = '<p style="width:100%;text-align:center;color:var(--faint);'
      + 'font-family:var(--mono);font-size:12px;margin-top:18px">your words stack up here 🔤<br>longer = more points</p>';
    return;
  }
  for (const it of g.my_words) {
    const c = document.createElement("div");
    c.className = "wr-chip" + (it.w.length >= g.size ? " pan" : "") + (it.w === justFound ? " fresh" : "");
    c.innerHTML = it.w.toUpperCase() + " <b>" + it.pts + "</b>";
    host.appendChild(c);
  }
  justFound = "";
}
function renderBoard(st, g) {
  const host = $("wr-board"); host.textContent = "";
  for (const e of g.leaderboard) {
    const p = st.players.find((q) => q.pid === e.pid);
    if (!p) continue;
    const el = document.createElement("div");
    el.className = "wr-lb" + (e.pid === PID ? " me" : "");
    const av = document.createElement("span"); av.className = "lb-av"; Hub.fillAvatar(av, p);
    const sc = document.createElement("span"); sc.className = "lb-sc"; sc.textContent = e.total;
    const wc = document.createElement("span"); wc.className = "lb-wc"; wc.textContent = e.words + "w";
    el.append(av, sc, wc); host.appendChild(el);
  }
}

/* ---------- reveal / game over ---------- */
function nameOf(pid) { const p = ST && ST.players.find((q) => q.pid === pid); return p ? p.name : "player"; }
function renderReveal(st, rev) {
  const host = $("rv-rows"); host.textContent = "";
  const top = rev.rows.length ? rev.rows[0].score : 0;
  for (const r of rev.rows) {
    const p = st.players.find((q) => q.pid === r.pid);
    const row = document.createElement("div");
    row.className = "rv-row" + (r.score === top && top > 0 ? " win" : "");
    const av = document.createElement("span"); av.className = "rv-av"; Hub.fillAvatar(av, p || {});
    const nm = document.createElement("span"); nm.className = "rv-nm";
    nm.innerHTML = (p ? p.name : r.pid) + (r.best ? ' <span class="rv-best">best: ' + r.best.toUpperCase() + "</span>" : "");
    const b = document.createElement("b"); b.textContent = r.score + " · " + r.words + "w";
    row.append(av, nm, b); host.appendChild(row);
  }
  $("rv-possible").textContent = rev.possible + " words were possible this round";
  const m = $("rv-missed"); m.textContent = "";
  for (const w of rev.top_missed) { const s = document.createElement("span"); s.textContent = w.toUpperCase(); m.appendChild(s); }
  $("rv-next").textContent = "next round starting…";
  const revealKey = st.game.round + ":" + JSON.stringify(rev.rows);
  if (revealKey !== lastRevealKey) {
    lastRevealKey = revealKey;
    const leaders = rev.rows.filter((row) => row.score === top && top > 0);
    const mine = leaders.some((row) => row.pid === PID);
    if (mine) {
      SFX.pangram(); buzz([55, 35, 110]); celebrate(120);
      announce("Round over. You won the round with " + top + " points.");
    } else {
      SFX.reveal(); buzz(35);
      announce("Round over. " + (leaders.length
        ? leaders.map((row) => nameOf(row.pid)).join(" and ") + " led with " + top + " points."
        : "No words were scored."));
    }
  }
  $("wr-reveal").hidden = false;
}
function renderGameOver(st, g) {
  const res = g.result || [];
  const top = res.length ? res[0].score : 0;
  const champs = res.filter((e) => e.score === top && top > 0).map((e) => nameOf(e.pid));
  $("go-title").textContent = champs.length ? champs.join(" & ") + (champs.length === 1 ? " WINS!" : " WIN!") : "GOOD GAME";
  const host = $("go-rows"); host.textContent = "";
  for (const e of res) {
    const p = st.players.find((q) => q.pid === e.pid);
    const row = document.createElement("div");
    row.className = "go-row" + (e.score === top && top > 0 ? " first" : "");
    const av = document.createElement("span"); av.className = "gr-av"; Hub.fillAvatar(av, p || {});
    const nm = document.createElement("span"); nm.className = "gr-name"; nm.textContent = p ? p.name : e.pid;
    const wc = document.createElement("span"); wc.className = "gr-wc"; wc.textContent = e.words + "w";
    const b = document.createElement("b"); b.textContent = e.score;
    row.append(av, nm, wc, b); host.appendChild(row);
  }
  const resultKey = JSON.stringify(res);
  if (resultKey !== lastGameOverKey) {
    lastGameOverKey = resultKey;
    if (champs.includes(nameOf(PID))) {
      SFX.pangram(); buzz([70, 45, 140]); celebrate(180);
      announce("Game over. You are the Word Rush champion.");
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
    $("gameover").hidden = true; $("wr-reveal").hidden = true;
    renderSegs(st); renderPlayers(st);
    const me = st.you;
    const readyN = st.players.filter((p) => p.ready && p.connected).length;
    $("ready-count").textContent = readyN + "/" + st.players.length + " ready";
    const canGo = me && me.ready && readyN >= st.min_players;
    $("ready-btn").hidden = !!(me && me.ready);
    $("go-btn").hidden = !canGo;
    $("ready-btn").onclick = () => {
      SFX.unlock(); SFX.found(); buzz(35);
      conn.send({ t: "ready", ready: true });
      announce("Ready. Waiting for the game to start.");
    };
    $("go-btn").onclick = () => {
      SFX.unlock(); SFX.found(); buzz(45);
      conn.send({ t: "start" });
      announce("Starting Word Rush.");
    };
    $("lobby-hint").textContent = canGo ? "you're the host — tap START"
      : (me && me.ready ? "waiting for the host to start…" : "ready up to play");
    roundKey = ""; lastRevealKey = ""; lastGameOverKey = ""; lastTimerCue = -1;
    return;
  }

  show("scr-game");
  const g = st.game;
  if (!g) return;
  $("wr-round").textContent = "R" + g.round + (g.rounds > 1 ? "/" + g.rounds : "");
  // (re)build the rack on a new round
  const rk = g.round + ":" + g.rack.join("");
  if (rk !== roundKey) {
    roundKey = rk; lastTimerCue = -1;
    resetRack(g.rack); renderCurrent(); renderTiles();
    SFX.found();
    announce("Round " + g.round + ". Letters: " + g.rack.join(", ") + ". Go.");
  }
  renderFound(g);
  renderBoard(st, g);

  if (g.stage === "reveal" && g.reveal) renderReveal(st, g.reveal);
  else $("wr-reveal").hidden = true;

  if (st.phase === "game_end") renderGameOver(st, g);
  else $("gameover").hidden = true;
}

$("rematch-btn").onclick = () => {
  SFX.unlock(); SFX.tap();
  conn.send({ t: "again" }); $("gameover").hidden = true;
};

/* ---------- timer ---------- */
setInterval(() => {
  if (!ST || !ST.game || ST.game.stage !== "playing" || !ST.deadline) return;
  const left = Math.max(0, Math.ceil((ST.deadline - conn.now()) / 1000));
  const el = $("wr-timer");
  el.textContent = Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0");
  el.classList.toggle("low", left <= 15);
  if (left <= 5 && left > 0 && left !== lastTimerCue) {
    lastTimerCue = left; SFX.tick();
    if (left <= 3) buzz(15);
    announce(left + (left === 1 ? " second remaining" : " seconds remaining"));
  }
}, 250);

/* ---------- connection ---------- */
const conn = Hub.connect("/games/wordrush/ws", {
  onWelcome: (m) => { PID = m.pid; if (Hub.identity.name) joined = true; render(ST); },
  onFx: (fx) => {
    if (fx.kind === "toast") Hub.toast((fx.icon ? fx.icon + " " : "") + fx.msg);
    if (fx.kind === "invalid") {
      Hub.toast(fx.msg, "err"); SFX.bad(); buzz(40); announce(fx.msg);
    }
    if (fx.kind === "found") {
      justFound = fx.w;
      if (fx.pangram) {
        SFX.pangram(); buzz([35, 25, 70]); celebrate(70);
      } else {
        SFX.found(); buzz([18, 12, 30]);
      }
      announce(fx.w.toUpperCase() + " accepted for " + fx.pts
        + (fx.pts === 1 ? " point." : " points."));
      renderCurrent("good");
      setTimeout(() => renderCurrent(), 220);
      if (fx.pangram) Hub.toast("FULL RACK! +" + fx.pts, "");
    }
    if (fx.kind === "reject") {
      SFX.bad(); buzz(45);
      renderCurrent("bad"); setTimeout(() => renderCurrent(), 300);
      const message = '"' + (fx.w || "").toUpperCase() + '" — ' + fx.why;
      Hub.toast(message, "err"); announce(message);
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

// test hooks (harmless in prod; used by tests/playtest_wordrush.mjs)
window.__st = () => ST;
window.__wrSubmit = (w) => conn.send({ t: "word", w });
