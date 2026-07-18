/* PRICE CHECK — big-screen (TV) view. Shows the item + timer while phones
   guess, then the dramatic reveal + ranked guesses. Read-only spectator. */
"use strict";

const $ = (id) => document.getElementById(id);
let ST = null, curStage = "";

const joinUrl = new URL(".", location.href).href;
$("tv-url").textContent = joinUrl.replace(/^https?:\/\//, "");
try { renderQR($("tv-qr"), joinUrl); } catch (e) { $("tv-qr").textContent = "scan the address below"; }

const esc = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function nameOf(st, pid) { const p = st.players.find((q) => q.pid === pid); return p ? p.name : "player"; }

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

function renderGuessing(st) {
  const g = st.game, item = g.item;
  const locked = g.roster.filter((r) => r.locked).length;
  const total = g.roster.length;
  $("tv-stage").innerHTML =
    '<div class="pc-emoji-xl">' + esc(item.emoji) + "</div>"
    + '<div class="tv-kicker">R' + g.round + "/" + g.rounds + " · " + (item.money ? "WHAT'S THE PRICE?" : "WHAT'S THE NUMBER?") + "</div>"
    + '<div class="pc-prompt-xl">' + esc(item.prompt) + "</div>"
    + '<div class="pc-timer" id="pc-timer">–</div>'
    + '<div class="pc-lockline" id="pc-lockline">' + locked + " of " + total + " locked in</div>";
}

function renderReveal(st) {
  const g = st.game, item = g.item;
  let rows = "";
  for (const r of (g.reveal || [])) {
    const p = st.players.find((q) => q.pid === r.pid);
    rows += '<div class="pc-rank-xl' + (r.won ? " won" : "") + '">'
      + '<span class="rk-av" data-pid="' + r.pid + '"></span>'
      + '<span class="rk-name">' + esc(p ? p.name : r.pid) + (r.won ? " 👑" : "") + (r.bullseye ? " 🎯" : "") + "</span>"
      + '<span class="rk-guess">' + esc(fmt(r.guess, item)) + "</span></div>";
  }
  $("tv-stage").innerHTML =
    '<div class="tv-kicker">' + (item.money ? "ACTUAL PRICE" : "THE ANSWER") + "</div>"
    + '<div class="pc-answer-xl">' + esc(fmt(g.answer, item)) + "</div>"
    + '<div class="pc-fact-xl">' + esc(g.fact || "") + "</div>"
    + '<div class="pc-ranks-xl">' + rows + "</div>";
  // fill avatars (they need the player objects)
  for (const el of $("tv-stage").querySelectorAll(".rk-av")) {
    const p = st.players.find((q) => q.pid === el.dataset.pid);
    Hub.fillAvatar(el, p || {});
  }
}

function renderLobby(st) {
  const n = st.players.length;
  $("tv-stage").innerHTML =
    '<div class="tv-kicker">GET READY</div>'
    + '<div class="tv-headline">' + (n ? "Scan to join in" : "Waiting for players") + "</div>"
    + '<div class="tv-sub">' + (n ? n + " in the lobby — press START on a phone" : "point your phone camera at the code →") + "</div>";
}

function renderRoster(st) {
  const host = $("tv-roster"); host.textContent = "";
  const g = st.game, inGame = g && g.roster;
  const rows = inGame ? g.roster : st.players.map((p) => ({ pid: p.pid }));
  for (const r of rows) {
    const p = st.players.find((q) => q.pid === r.pid);
    if (!p) continue;
    const el = document.createElement("div");
    el.className = "tv-pl" + (r.won ? " win" : "") + (!inGame && p.ready ? " ready" : "");
    const av = document.createElement("span"); av.className = "tv-av"; Hub.fillAvatar(av, p);
    const nm = document.createElement("span"); nm.className = "tv-pl-name"; nm.textContent = p.name + (p.bot ? " 🤖" : "");
    const meta = document.createElement("span"); meta.className = "tv-pl-meta";
    if (inGame) {
      if (g.stage === "guessing") meta.textContent = r.locked ? "🔒" : (r.guessed ? "…" : "");
      else meta.innerHTML = (r.wins ? "🏆" + r.wins : "") + (r.won ? ' <span class="tv-pl-sub">round</span>' : "");
    } else meta.textContent = p.bot ? "BOT" : (p.ready ? "READY" : "…");
    el.append(av, nm, meta);
    host.appendChild(el);
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
    const top = res.length ? res[0].wins : 0;
    const champs = res.filter((e) => e.wins === top && top > 0).map((e) => nameOf(st, e.pid));
    banner("<h1>" + (champs.length ? esc(champs.join(" & ")) + (champs.length === 1 ? " WINS!" : " WIN!") : "Good game") + "</h1>"
      + "<p>" + res.map((e) => esc(nameOf(st, e.pid)) + " · " + e.wins).join("&nbsp;&nbsp;·&nbsp;&nbsp;") + "</p>");
    if (changed && champs.length) Hub.confettiBurst(200);
  } else {
    $("tv-banner").hidden = true;
    if (stage === "lobby") renderLobby(st);
    else if (stage === "guessing") renderGuessing(st);
    else if (stage === "reveal") { renderReveal(st); if (changed && (g.last_winners || []).length) Hub.confettiBurst(120); }
  }
  renderRoster(st);
  curStage = stage;
}

const conn = Hub.connect("/games/pricecheck/ws", { onState: render }, { watch: true });

// live countdown while guessing
setInterval(() => {
  if (!ST || !ST.game || ST.game.stage !== "guessing" || !ST.deadline) return;
  const t = $("pc-timer"); if (!t) return;
  const left = Math.max(0, Math.ceil((ST.deadline - conn.now()) / 1000));
  t.textContent = left;
  t.classList.toggle("low", left <= 5);
}, 250);
