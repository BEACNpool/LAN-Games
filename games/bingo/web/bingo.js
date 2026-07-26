/* BINGO controller — your card lives here; the caller is on the TV. */
"use strict";

const $ = (id) => document.getElementById(id);
let ST = null, PID = null, joined = false, lastStage = "";
let avatar = Hub.identity.avatar || Hub.AVATARS[0];
let muted = localStorage.getItem("wc-muted") === "1";
let lastCallKey = "", hadBingo = false, lastGameOverKey = "";

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
      osc.type = type;
      osc.frequency.setValueAtTime(frequency, at);
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
    tap: () => tone(720, "square", 0.045, 0.035),
    daub: () => { tone(340, "sine", 0.07, 0.075); tone(680, "sine", 0.09, 0.055, 0.035); },
    call: () => { tone(520, "triangle", 0.07, 0.045); tone(780, "triangle", 0.1, 0.04, 0.055); },
    ready: () => [660, 880, 1100].forEach((f, i) => tone(f, "sine", 0.11, 0.065, i * 0.055)),
    claim: () => { tone(260, "sawtooth", 0.18, 0.08, 0, 520); tone(1040, "sine", 0.2, 0.07, 0.12); },
    win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, "sine", 0.24, 0.095, i * 0.09)),
    round: () => { tone(392, "triangle", 0.13, 0.055); tone(523, "triangle", 0.16, 0.05, 0.08); },
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
    if (!muted) SFX.ready();
    announce(muted ? "Sound off" : "Sound on");
  };
}

/* ---------- screens ---------- */
function show(id) {
  for (const s of ["scr-join", "scr-lobby", "scr-game"]) $(s).hidden = s !== id;
}

/* ---------- join ---------- */
Hub.buildAvatarGrid($("avatar-grid"), avatar, (a) => { avatar = a; });
$("name-input").value = Hub.identity.name || "";
Hub.wirePfpButton($("pfp-btn"), () => conn, () => {});
Hub.wirePfpButton($("pfp-btn2"), () => conn, () => {});
$("join-btn").onclick = () => {
  SFX.unlock();
  SFX.tap();
  const nm = ($("name-input").value || "").trim();
  Hub.identity.name = nm || "PLAYER";
  Hub.identity.avatar = avatar;
  joined = true;
  conn.send({ t: "profile", name: Hub.identity.name, avatar });
  show(ST && ST.phase && ST.phase !== "lobby" && ST.phase !== "countdown" ? "scr-game" : "scr-lobby");
  render(ST);
};
$("name-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") $("join-btn").click();
});

/* ---------- lobby settings ---------- */
const SEGS = [
  { host: "opt-mode",    key: "mode",    opts: [["numbers", "NUMBERS"], ["pics", "PICTURES"]] },
  { host: "opt-pattern", key: "pattern", opts: [["line", "LINE"], ["corners", "CORNERS"], ["blackout", "BLACKOUT"]] },
  { host: "opt-pace",    key: "pace",    opts: [[3, "FAST"], [4, "NORMAL"], [6, "CHILL"]] },
  { host: "opt-rounds",  key: "rounds",  opts: [[1, "1"], [3, "3"], [5, "5"]] },
  { host: "opt-auto",    key: "auto",    opts: [[false, "TAP TO DAUB"], [true, "HANDS-OFF"]] },
];
for (const seg of SEGS) {
  const host = $(seg.host);
  for (const [val, label] of seg.opts) {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = label; b._val = val;
    b.onclick = () => {
      SFX.unlock(); SFX.tap();
      conn.send({ t: "settings", patch: { [seg.key]: val } });
    };
    host.appendChild(b);
  }
}
function renderSegs(st) {
  for (const seg of SEGS) {
    const cur = st.settings[seg.key];
    for (const b of $(seg.host).children) {
      const selected = b._val === cur;
      b.classList.toggle("sel", selected);
      b.setAttribute("aria-pressed", selected ? "true" : "false");
    }
  }
  $("auto-note").innerHTML = st.settings.auto
    ? "🧸 <b>HANDS-OFF</b> — the caller daubs every card and calls BINGO for you. Great for little kids."
    : "✏️ <b>TAP TO DAUB</b> — mark your own squares and smash <b>BINGO!</b> when you get the pattern.";
}

function renderPlayers(st) {
  const host = $("player-grid");
  host.textContent = "";
  for (const p of st.players) {
    const card = document.createElement("div");
    card.className = "player-card" + (p.ready ? " is-ready" : "") + (p.connected ? "" : " is-away");
    const av = document.createElement("span");
    av.className = "pc-avatar";
    Hub.fillAvatar(av, p);
    const nm = document.createElement("span");
    nm.className = "pc-name"; nm.textContent = p.name + (p.bot ? " 🤖" : "");
    const stt = document.createElement("span");
    stt.className = "pc-status"; stt.textContent = p.bot ? "BOT" : (p.ready ? "READY" : "…");
    card.append(av, nm, stt);
    host.appendChild(card);
  }
}

/* ---------- game render ---------- */
const GOAL = { line: "a full LINE", corners: "all 4 CORNERS", blackout: "the WHOLE CARD" };

function renderCard(g) {
  const host = $("card");
  const daub = new Set(g.my_daubed || []);
  const pics = g.mode === "pics";
  if (host.children.length !== 25) {
    host.textContent = "";
    for (let i = 0; i < 25; i++) {
      const c = document.createElement("button");
      c.type = "button"; c.dataset.i = i;
      c.innerHTML = "<span></span>";
      c.onclick = () => {
        const cell = g_current && g_current.my_card && g_current.my_card[i];
        if (cell && !cell.free && cell.called && !daubSet().has(i)) {
          SFX.unlock(); SFX.daub(); buzz(22);
          announce("Daubed " + cell.label);
          conn.send({ t: "daub", cell: i });
        }
      };
      host.appendChild(c);
    }
  }
  const cells = g.my_card || [];
  for (let i = 0; i < 25; i++) {
    const c = host.children[i];
    const cell = cells[i] || { label: "", free: false, called: false };
    const isDaub = daub.has(i) || cell.free;
    c.className = "cell" + (pics ? " pics" : "") + (cell.free ? " free" : "")
      + (isDaub ? " daubed" : "") + (!cell.free && cell.called && !isDaub ? " callable" : "");
    c.firstChild.textContent = cell.label;
    c.setAttribute("role", "gridcell");
    c.setAttribute("aria-pressed", isDaub ? "true" : "false");
    c.setAttribute("aria-label", cell.free ? "Free space, marked"
      : cell.label + (isDaub ? ", marked" : (cell.called ? ", called, tap to mark" : ", not called")));
  }
}
let g_current = null;
const daubSet = () => new Set((g_current && g_current.my_daubed) || []);

function renderGame(st) {
  const g = st.game;
  g_current = g;
  if (!g) return;
  $("bg-round").textContent = "R" + g.round + (g.rounds > 1 ? "/" + g.rounds : "");
  const chip = $("call-chip");
  chip.textContent = g.call_label || "—";
  chip.classList.toggle("pics", g.mode === "pics");
  const callKey = g.round + ":" + (g.call_label || "");
  if (g.stage === "calling" && g.call_label && callKey !== lastCallKey) {
    lastCallKey = callKey;
    SFX.call();
    announce("Now calling " + g.call_label);
  }
  $("bg-goal").innerHTML = "Fill <b>" + (GOAL[g.pattern] || g.pattern) + "</b>"
    + (g.auto ? " · auto-play on" : "");
  renderCard(g);

  // auto-daub-for-me convenience (client-side)
  if ($("auto-me").checked && g.stage === "calling") {
    const dset = new Set(g.my_daubed || []);
    (g.my_card || []).forEach((cell, i) => {
      if (cell && !cell.free && cell.called && !dset.has(i)) conn.send({ t: "daub", cell: i });
    });
  }

  const btn = $("bingo-btn");
  btn.hidden = g.stage !== "calling" || g.auto;
  btn.classList.toggle("ready", !!g.you_bingo);
  btn.setAttribute("aria-disabled", g.you_bingo ? "false" : "true");
  if (g.you_bingo && !hadBingo) {
    SFX.ready(); buzz([35, 30, 70]);
    announce("You have BINGO. Tap BINGO now.");
  }
  hadBingo = !!g.you_bingo;
}

/* ---------- banners ---------- */
function nameOf(pid) {
  const p = ST && ST.players.find((q) => q.pid === pid);
  return p ? p.name : "someone";
}
function showRoundBanner(g) {
  const w = g.last_winners || [];
  $("rb-emoji").textContent = w.length ? "🎉" : "🫥";
  if (!w.length) { $("rb-title").textContent = "NO BINGO"; $("rb-sub").textContent = "the board ran out — next round!"; }
  else {
    const mine = w.includes(PID);
    $("rb-title").textContent = mine ? "BINGO! 🎉" : "BINGO!";
    $("rb-sub").textContent = w.map(nameOf).join(" & ") + (mine ? " — that's you!" : " got it");
    if (mine) {
      celebrate(140); SFX.win(); buzz([60, 40, 120]);
      announce("BINGO! You won the round.");
    } else {
      SFX.round();
      announce(w.map(nameOf).join(" and ") + " won the round.");
    }
  }
  if (!w.length) { SFX.bad(); announce("No BINGO this round."); }
  $("round-banner").hidden = false;
}
function renderGameOver(g) {
  const res = g.result || [];
  const top = res.length ? res[0].wins : 0;
  const champs = res.filter((e) => e.wins === top && top > 0).map((e) => nameOf(e.pid));
  $("go-title").textContent = champs.length
    ? champs.join(" & ") + (champs.length === 1 ? " WINS!" : " WIN!") : "GOOD GAME";
  const host = $("go-rows"); host.textContent = "";
  for (const e of res) {
    const p = ST.players.find((q) => q.pid === e.pid);
    const row = document.createElement("div");
    row.className = "go-row" + (e.wins === top && top > 0 ? " first" : "");
    const av = document.createElement("span"); av.className = "gr-av"; Hub.fillAvatar(av, p || {});
    const nm = document.createElement("span"); nm.className = "gr-name";
    nm.textContent = p ? p.name : e.pid;
    const b = document.createElement("b"); b.textContent = e.wins + (e.wins === 1 ? " win" : " wins");
    row.append(av, nm, b); host.appendChild(row);
  }
  const resultKey = JSON.stringify(res);
  if (resultKey !== lastGameOverKey) {
    lastGameOverKey = resultKey;
    if (champs.includes(nameOf(PID))) {
      celebrate(180); SFX.win(); buzz([70, 45, 140]);
      announce("Game over. You are the BINGO champion.");
    } else {
      SFX.round();
      announce("Game over. " + (champs.length ? champs.join(" and ") + " won." : "Good game."));
    }
  }
  $("gameover").hidden = false;
}

/* ---------- top-level render ---------- */
function render(st) {
  if (!st) return;
  ST = st;
  $("countdown-overlay").hidden = st.phase !== "countdown";
  if (!joined) { show("scr-join"); return; }

  if (st.phase === "lobby" || st.phase === "countdown") {
    show("scr-lobby");
    $("gameover").hidden = true; $("round-banner").hidden = true;
    renderSegs(st); renderPlayers(st);
    const me = st.you;
    const readyN = st.players.filter((p) => p.ready && p.connected).length;
    $("ready-count").textContent = readyN + "/" + st.players.length + " ready";
    const canGo = me && me.ready && readyN >= st.min_players;
    $("ready-btn").hidden = !!(me && me.ready);
    $("go-btn").hidden = !canGo;
    $("ready-btn").onclick = () => {
      SFX.unlock(); SFX.ready(); buzz(35);
      conn.send({ t: "ready", ready: true });
      announce("Ready. Waiting for the game to start.");
    };
    $("go-btn").onclick = () => {
      SFX.unlock(); SFX.ready(); buzz(45);
      conn.send({ t: "start" });
      announce("Starting BINGO.");
    };
    $("lobby-hint").textContent = canGo ? "you're the host — tap START"
      : (me && me.ready ? "waiting for the host to start…" : "ready up to play");
    lastStage = "lobby"; lastCallKey = ""; hadBingo = false; lastGameOverKey = "";
    return;
  }

  show("scr-game");
  const g = st.game;
  renderGame(st);
  const stage = g ? g.stage : st.phase;
  // banner transitions
  if (stage === "roundwin" && lastStage !== "roundwin") showRoundBanner(g);
  if (stage !== "roundwin") $("round-banner").hidden = true;
  if (st.phase === "game_end") renderGameOver(g);
  else $("gameover").hidden = true;
  lastStage = stage;
}

$("bingo-btn").onclick = () => {
  if (!g_current || g_current.stage !== "calling") return;
  SFX.unlock();
  if (g_current.you_bingo) {
    SFX.claim(); buzz([45, 25, 90]); announce("BINGO claimed.");
  } else {
    SFX.bad(); buzz(35); announce("You do not have BINGO yet.");
  }
  conn.send({ t: "bingo" });
};
$("rematch-btn").onclick = () => {
  SFX.unlock(); SFX.tap();
  conn.send({ t: "again" }); $("gameover").hidden = true;
};

/* ---------- connection ---------- */
const conn = Hub.connect("/games/bingo/ws", {
  onWelcome: (m) => { PID = m.pid; if (!joined && Hub.identity.name) { joined = true; } render(ST); },
  onFx: (fx) => {
    if (fx.kind === "toast") Hub.toast((fx.icon ? fx.icon + " " : "") + fx.msg);
    if (fx.kind === "invalid") {
      Hub.toast(fx.msg, "err"); SFX.bad(); buzz(35); announce(fx.msg);
    }
  },
  onState: render,
});

// remember auto-daub preference
$("auto-me").checked = localStorage.getItem("bingo-auto-me") === "1";
$("auto-me").onchange = () => {
  SFX.unlock(); SFX.tap();
  localStorage.setItem("bingo-auto-me", $("auto-me").checked ? "1" : "0");
  announce($("auto-me").checked ? "Auto daub on" : "Auto daub off");
};
wireMute("mute-btn");
wireMute("mute-btn2");
syncMuteControls();
window.addEventListener("storage", (event) => {
  if (event.key !== "wc-muted") return;
  muted = event.newValue === "1";
  syncMuteControls();
});

// if the device already has a name, skip the join card straight into the lobby
if (Hub.identity.name) { joined = true; }
show(joined ? "scr-lobby" : "scr-join");
