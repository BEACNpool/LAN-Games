/* WORD RUSH — big-screen (TV) view. Shared rack + live timer + a masked "found"
   ticker (length + points only, so nobody copies) + leaderboard. Spectator. */
"use strict";

const $ = (id) => document.getElementById(id);
let ST = null, curStage = "", seenTicker = 0;

const joinUrl = new URL(".", location.href).href;
$("tv-url").textContent = joinUrl.replace(/^https?:\/\//, "");
try { renderQR($("tv-qr"), joinUrl); } catch (e) { $("tv-qr").textContent = "scan the address below"; }

const esc = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function nameOf(st, pid) { const p = st.players.find((q) => q.pid === pid); return p ? p.name : "player"; }

function renderPlaying(st) {
  const g = st.game;
  const tiles = g.rack.map((c) => '<div class="wr-tv-tile">' + esc(c.toUpperCase()) + "</div>").join("");
  const feed = g.ticker.slice(-4).reverse().map((f) => {
    const nm = nameOf(st, f.pid);
    return '<div class="wr-feed-line">' + esc(nm) + " found a <b>" + f.len + "-letter</b> word · +" + f.pts + "</div>";
  }).join("") || '<div class="wr-feed-line" style="color:var(--faint)">first word gets it started…</div>';
  $("tv-stage").innerHTML =
    '<div class="wr-tv-top"><span class="wr-tv-round">ROUND ' + g.round + " / " + g.rounds + "</span>"
    + '<span class="wr-tv-timer" id="wr-tv-timer">–</span></div>'
    + '<div class="wr-tv-rack">' + tiles + "</div>"
    + '<div class="wr-tv-feed">' + feed + "</div>";
}

function renderReveal(st) {
  const g = st.game, rev = g.reveal;
  const top = rev.rows.length ? rev.rows[0].score : 0;
  let rows = "";
  for (const r of rev.rows) {
    const p = st.players.find((q) => q.pid === r.pid);
    rows += '<div class="wr-rv-row' + (r.score === top && top > 0 ? " win" : "") + '">'
      + '<span class="rk-av" data-pid="' + r.pid + '"></span>'
      + '<span class="rk-nm">' + esc(p ? p.name : r.pid)
      + (r.best ? '<span class="rk-best">best: ' + esc(r.best.toUpperCase()) + "</span>" : "") + "</span>"
      + '<span class="rk-sc">' + r.score + " · " + r.words + "w</span></div>";
  }
  const missed = rev.top_missed.map((w) => "<span>" + esc(w.toUpperCase()) + "</span>").join("");
  $("tv-stage").innerHTML =
    '<div class="tv-kicker">ROUND ' + g.round + " OVER · " + rev.possible + " WORDS WERE POSSIBLE</div>"
    + '<div class="wr-rv-rows">' + rows + "</div>"
    + (missed ? '<div class="tv-kicker" style="margin-top:6px">NOBODY FOUND</div><div class="wr-missed">' + missed + "</div>" : "");
  for (const el of $("tv-stage").querySelectorAll(".rk-av")) {
    const p = st.players.find((q) => q.pid === el.dataset.pid);
    Hub.fillAvatar(el, p || {});
  }
}

function renderLobby(st) {
  const n = st.players.length;
  $("tv-stage").innerHTML =
    '<div class="tv-kicker">GET READY</div>'
    + '<div class="tv-headline">' + (n ? "Scan to join the rush" : "Waiting for players") + "</div>"
    + '<div class="tv-sub">' + (n ? n + " in the lobby — press START on a phone" : "point your phone camera at the code →") + "</div>";
}

function renderRoster(st) {
  const host = $("tv-roster"); host.textContent = "";
  const g = st.game, inGame = g && g.leaderboard;
  const rows = inGame ? g.leaderboard : st.players.map((p) => ({ pid: p.pid }));
  const top = inGame && rows.length ? rows[0].total : 0;
  for (const r of rows) {
    const p = st.players.find((q) => q.pid === r.pid);
    if (!p) continue;
    const el = document.createElement("div");
    el.className = "tv-pl" + (inGame && r.total === top && top > 0 ? " win" : "") + (!inGame && p.ready ? " ready" : "");
    const av = document.createElement("span"); av.className = "tv-av"; Hub.fillAvatar(av, p);
    const nm = document.createElement("span"); nm.className = "tv-pl-name"; nm.textContent = p.name + (p.bot ? " 🤖" : "");
    const meta = document.createElement("span"); meta.className = "tv-pl-meta";
    if (inGame) meta.innerHTML = r.total + ' <span class="tv-pl-sub">' + r.words + "w</span>";
    else meta.textContent = p.bot ? "BOT" : (p.ready ? "READY" : "…");
    el.append(av, nm, meta); host.appendChild(el);
  }
}

function banner(html) { $("tv-banner").innerHTML = html; $("tv-banner").hidden = false; }

function render(st) {
  ST = st;
  const humans = st.players.filter((p) => !p.bot).length;
  $("tv-online").textContent = humans ? "● " + humans + " playing" : "no players yet";
  $("tv-online").classList.toggle("on", humans > 0);

  const g = st.game;
  const stage = st.phase === "lobby" || st.phase === "countdown" ? "lobby" : (g ? g.stage : st.phase);
  const changed = stage !== curStage;

  if (st.phase === "game_end") {
    const res = (g && g.result) || [];
    const top = res.length ? res[0].score : 0;
    const champs = res.filter((e) => e.score === top && top > 0).map((e) => nameOf(st, e.pid));
    banner("<h1>" + (champs.length ? esc(champs.join(" & ")) + (champs.length === 1 ? " WINS!" : " WIN!") : "Good game") + "</h1>"
      + "<p>" + res.map((e) => esc(nameOf(st, e.pid)) + " · " + e.score).join("&nbsp;&nbsp;·&nbsp;&nbsp;") + "</p>");
    if (changed && champs.length) Hub.confettiBurst(200);
  } else {
    $("tv-banner").hidden = true;
    if (stage === "lobby") renderLobby(st);
    else if (stage === "playing") renderPlaying(st);
    else if (stage === "reveal") renderReveal(st);
  }
  renderRoster(st);
  curStage = stage;
}

const conn = Hub.connect("/games/wordrush/ws", { onState: render }, { watch: true });

setInterval(() => {
  if (!ST || !ST.game || ST.game.stage !== "playing" || !ST.deadline) return;
  const t = $("wr-tv-timer"); if (!t) return;
  const left = Math.max(0, Math.ceil((ST.deadline - conn.now()) / 1000));
  t.textContent = Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0");
  t.classList.toggle("low", left <= 15);
}, 250);
