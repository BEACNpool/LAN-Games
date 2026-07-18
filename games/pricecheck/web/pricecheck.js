/* PRICE CHECK controller — lock in a number; closest wins. */
"use strict";

const $ = (id) => document.getElementById(id);
let ST = null, PID = null, joined = false;
let entry = "", entryRound = -1, sentLock = false;
let avatar = Hub.identity.avatar || Hub.AVATARS[0];
const esc = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

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
  Hub.identity.name = ($("name-input").value || "").trim() || "PLAYER";
  Hub.identity.avatar = avatar;
  joined = true;
  conn.send({ t: "profile", name: Hub.identity.name, avatar });
  render(ST);
};

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
    b.onclick = () => conn.send({ t: "settings", patch: { [seg.key]: val } });
    $(seg.host).appendChild(b);
  }
}
function renderSegs(st) {
  for (const seg of SEGS)
    for (const b of $(seg.host).children) b.classList.toggle("sel", b._val === st.settings[seg.key]);
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
    b.onclick = () => tapKey(k);
    host.appendChild(b);
  }
})();
function tapKey(k) {
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
  sentLock = true;
  $("lock-btn").disabled = true;
  conn.send({ t: "guess", value: v });
  conn.send({ t: "lock" });
};

/* ---------- game render ---------- */
function subPanel(id) { for (const s of ["pc-guess", "pc-locked", "pc-reveal"]) $(s).hidden = s !== id; }

function renderGame(st) {
  const g = st.game; if (!g) return;
  const item = g.item;
  $("pc-round").textContent = g.round + "/" + g.rounds;
  $("pc-header").textContent = item.money ? "WHAT'S THE PRICE?" : "WHAT'S THE NUMBER?";
  $("pc-emoji").textContent = item.emoji;
  $("pc-prompt").textContent = item.prompt;

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
  if ((g.last_winners || []).includes(PID)) Hub.confettiBurst(120);
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
  if (champs.includes(nameOf(PID))) Hub.confettiBurst(180);
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
    $("ready-btn").onclick = () => conn.send({ t: "ready", ready: true });
    $("go-btn").onclick = () => conn.send({ t: "start" });
    $("lobby-hint").textContent = canGo ? "you're the host — tap START"
      : (me && me.ready ? "waiting for the host to start…" : "ready up to play");
    entryRound = -1;
    return;
  }

  show("scr-game");
  renderGame(st);
  if (st.phase === "game_end" && st.game) renderGameOver(st, st.game);
  else $("gameover").hidden = true;
}

$("rematch-btn").onclick = () => { conn.send({ t: "again" }); $("gameover").hidden = true; };

const conn = Hub.connect("/games/pricecheck/ws", {
  onWelcome: (m) => { PID = m.pid; if (Hub.identity.name) joined = true; render(ST); },
  onFx: (fx) => {
    if (fx.kind === "toast") Hub.toast((fx.icon ? fx.icon + " " : "") + fx.msg);
    if (fx.kind === "invalid") { Hub.toast(fx.msg, "err"); sentLock = false; paintEntry(); }
  },
  onState: render,
});

if (Hub.identity.name) joined = true;
show(joined ? "scr-lobby" : "scr-join");
