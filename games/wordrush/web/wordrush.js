/* WORD RUSH controller — build words from the shared rack (tap tiles or type). */
"use strict";

const $ = (id) => document.getElementById(id);
let ST = null, PID = null, joined = false;
let avatar = Hub.identity.avatar || Hub.AVATARS[0];
let rackLetters = [], order = [], current = [], roundKey = "", justFound = "";

function show(id) { for (const s of ["scr-join", "scr-lobby", "scr-game"]) $(s).hidden = s !== id; }

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
  { host: "opt-size",   key: "size",   opts: [[6, "6"], [7, "7"], [8, "8"]] },
  { host: "opt-rounds", key: "rounds", opts: [[2, "2"], [3, "3"], [5, "5"]] },
  { host: "opt-clock",  key: "clock",  opts: [[60, "60s"], [90, "90s"], [120, "120s"]] },
];
for (const seg of SEGS)
  for (const [val, label] of seg.opts) {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = label; b._val = val;
    b.onclick = () => conn.send({ t: "settings", patch: { [seg.key]: val } });
    $(seg.host).appendChild(b);
  }
function renderSegs(st) {
  for (const seg of SEGS)
    for (const b of $(seg.host).children) b.classList.toggle("sel", b._val === st.settings[seg.key]);
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
    t.onclick = () => { if (!used.has(i)) { current.push(i); renderCurrent(); renderTiles(); } };
    host.appendChild(t);
  }
}
function renderCurrent(cls) {
  const el = $("wr-current");
  el.className = "wr-current" + (cls ? " " + cls : "");
  if (!current.length) { el.innerHTML = '<span class="wr-cur-empty">tap letters to spell a word</span>'; }
  else el.textContent = current.map((i) => rackLetters[i]).join("").toUpperCase();
  $("wr-enter").disabled = current.length < 3;
}
function submitWord() {
  if (current.length < 3) return;
  const w = current.map((i) => rackLetters[i]).join("").toLowerCase();
  conn.send({ t: "word", w });
  current = [];
  renderCurrent(); renderTiles();
}
function typeLetter(ch) {
  const used = usedSet();
  const i = order.find((k) => !used.has(k) && rackLetters[k] === ch);
  if (i !== undefined) { current.push(i); renderCurrent(); renderTiles(); }
}
$("wr-enter").onclick = submitWord;
$("wr-del").onclick = () => { current.pop(); renderCurrent(); renderTiles(); };
$("wr-shuffle").onclick = () => {
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  current = []; renderCurrent(); renderTiles();
};
document.addEventListener("keydown", (e) => {
  if ($("scr-game").hidden || !ST || !ST.game || ST.game.stage !== "playing") return;
  if (e.key === "Enter") { e.preventDefault(); submitWord(); }
  else if (e.key === "Backspace") { e.preventDefault(); current.pop(); renderCurrent(); renderTiles(); }
  else if (e.key === "Escape") { current = []; renderCurrent(); renderTiles(); }
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
    $("gameover").hidden = true; $("wr-reveal").hidden = true;
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
    roundKey = "";
    return;
  }

  show("scr-game");
  const g = st.game;
  if (!g) return;
  $("wr-round").textContent = "R" + g.round + (g.rounds > 1 ? "/" + g.rounds : "");
  // (re)build the rack on a new round
  const rk = g.round + ":" + g.rack.join("");
  if (rk !== roundKey) { roundKey = rk; resetRack(g.rack); renderCurrent(); renderTiles(); }
  renderFound(g);
  renderBoard(st, g);

  if (g.stage === "reveal" && g.reveal) renderReveal(st, g.reveal);
  else $("wr-reveal").hidden = true;

  if (st.phase === "game_end") renderGameOver(st, g);
  else $("gameover").hidden = true;
}

$("rematch-btn").onclick = () => { conn.send({ t: "again" }); $("gameover").hidden = true; };

/* ---------- timer ---------- */
setInterval(() => {
  if (!ST || !ST.game || ST.game.stage !== "playing" || !ST.deadline) return;
  const left = Math.max(0, Math.ceil((ST.deadline - conn.now()) / 1000));
  const el = $("wr-timer");
  el.textContent = Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0");
  el.classList.toggle("low", left <= 15);
}, 250);

/* ---------- connection ---------- */
const conn = Hub.connect("/games/wordrush/ws", {
  onWelcome: (m) => { PID = m.pid; if (Hub.identity.name) joined = true; render(ST); },
  onFx: (fx) => {
    if (fx.kind === "toast") Hub.toast((fx.icon ? fx.icon + " " : "") + fx.msg);
    if (fx.kind === "invalid") Hub.toast(fx.msg, "err");
    if (fx.kind === "found") {
      justFound = fx.w;
      renderCurrent("good");
      setTimeout(() => renderCurrent(), 220);
      if (fx.pangram) { Hub.confettiBurst(70); Hub.toast("FULL RACK! +" + fx.pts, ""); }
    }
    if (fx.kind === "reject") { renderCurrent("bad"); setTimeout(() => renderCurrent(), 300); Hub.toast('"' + (fx.w || "").toUpperCase() + '" — ' + fx.why, "err"); }
  },
  onState: render,
});

if (Hub.identity.name) joined = true;
show(joined ? "scr-lobby" : "scr-join");

// test hooks (harmless in prod; used by tests/playtest_wordrush.mjs)
window.__st = () => ST;
window.__wrSubmit = (w) => conn.send({ t: "word", w });
