/* BINGO — big-screen (TV) view. Read-only spectator: shows the current call,
   the called board, everyone's progress, and a join QR. */
"use strict";

const $ = (id) => document.getElementById(id);
const COLS = "BINGO";
const GOAL = { line: "a full LINE", corners: "all 4 CORNERS", blackout: "the WHOLE CARD" };
let lastStage = "", built75 = false;

/* join QR points at the controller page (this file sits next to it) */
const joinUrl = new URL(".", location.href).href;
$("tv-url").textContent = joinUrl.replace(/^https?:\/\//, "");
try { renderQR($("tv-qr"), joinUrl); } catch (e) { $("tv-qr").textContent = "scan the address below"; }

const esc = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function nameOf(st, pid) { const p = st.players.find((q) => q.pid === pid); return p ? p.name : "player"; }

function build75() {
  const stage = $("tv-stage");
  stage.innerHTML =
    '<div class="bg-call"><span class="tv-kicker" id="bg-goal">BINGO</span>'
    + '<span class="chip" id="bg-chip">—</span></div>'
    + '<div class="board75" id="board75"></div>';
  const board = $("board75");
  for (let c = 0; c < 5; c++) {
    const row = document.createElement("div");
    row.className = "b75-row";
    row.innerHTML = '<span class="b75-lab">' + COLS[c] + "</span>";
    for (let n = 1; n <= 15; n++) {
      const cell = document.createElement("div");
      cell.className = "b75"; cell.dataset.v = c * 15 + n;
      cell.textContent = c * 15 + n;
      row.appendChild(cell);
    }
    board.appendChild(row);
  }
  built75 = true;
}

function renderCalling(st) {
  const g = st.game;
  const pics = g.mode === "pics";
  const stage = $("tv-stage");
  if (pics) {
    built75 = false;
    stage.innerHTML =
      '<div class="bg-call"><span class="tv-kicker" id="bg-goal"></span>'
      + '<span class="chip pics" id="bg-chip">—</span></div>'
      + '<div class="picwrap" id="picwrap"></div>';
  } else if (!built75) {
    build75();
  }
  $("bg-goal").textContent = "R" + g.round + (g.rounds > 1 ? "/" + g.rounds : "") + " · FILL " + (GOAL[g.pattern] || g.pattern).toUpperCase();
  $("bg-chip").textContent = g.call_label || "—";
  const calledVals = (g.called || []).map((c) => c.v);
  const now = g.call;
  if (pics) {
    const wrap = $("picwrap"); wrap.textContent = "";
    for (const c of g.called) {
      const e = document.createElement("span");
      e.className = "piccall lit" + (c.v === now ? " now" : "");
      e.textContent = c.v; wrap.appendChild(e);
    }
  } else {
    const set = new Set(calledVals);
    for (const cell of $("board75").querySelectorAll(".b75")) {
      const v = +cell.dataset.v;
      cell.classList.toggle("lit", set.has(v));
      cell.classList.toggle("now", v === now);
    }
  }
}

function renderLobby(st) {
  built75 = false;
  const n = st.players.length;
  $("tv-stage").innerHTML =
    '<div class="tv-kicker">GET READY</div>'
    + '<div class="tv-headline">' + (n ? "Scan to grab a card" : "Waiting for players") + "</div>"
    + '<div class="tv-sub">' + (n ? n + " in the lobby — press START on a phone when ready" : "point your phone camera at the code →") + "</div>";
}

function renderRoster(st) {
  const host = $("tv-roster");
  host.textContent = "";
  const g = st.game;
  const inGame = g && g.roster;
  const rows = inGame ? g.roster : st.players.map((p) => ({ pid: p.pid }));
  for (const r of rows) {
    const p = st.players.find((q) => q.pid === r.pid);
    if (!p) continue;
    const won = r.won;
    const el = document.createElement("div");
    el.className = "tv-pl" + (won ? " win" : "") + (!inGame && p.ready ? " ready" : "");
    const av = document.createElement("span"); av.className = "tv-av"; Hub.fillAvatar(av, p);
    const nm = document.createElement("span"); nm.className = "tv-pl-name";
    nm.textContent = p.name + (p.bot ? " 🤖" : "");
    const meta = document.createElement("span"); meta.className = "tv-pl-meta";
    if (inGame) meta.innerHTML = (r.wins ? "🏆" + r.wins + " " : "") + '<span class="tv-pl-sub">' + r.marks + " ●</span>";
    else meta.textContent = p.bot ? "BOT" : (p.ready ? "READY" : "…");
    el.append(av, nm, meta);
    host.appendChild(el);
  }
}

function banner(html) { $("tv-banner").innerHTML = html; $("tv-banner").hidden = false; }

function render(st) {
  const humans = st.players.filter((p) => !p.bot).length;
  $("tv-online").textContent = humans ? "● " + humans + " playing" : "no players yet";
  $("tv-online").classList.toggle("on", humans > 0);

  const g = st.game;
  const stage = st.phase === "lobby" || st.phase === "countdown" ? "lobby" : (g ? g.stage : st.phase);

  if (stage === "lobby") { renderLobby(st); $("tv-banner").hidden = true; }
  else if (stage === "calling") { renderCalling(st); $("tv-banner").hidden = true; }
  else if (stage === "roundwin") {
    const w = g.last_winners || [];
    if (w.length) { banner("<h1>BINGO!</h1><p>" + esc(w.map((p) => nameOf(st, p)).join(" & ")) + "</p>"); Hub.confettiBurst(160); }
    else banner("<h1>No bingo</h1><p>the board ran out — next round</p>");
  } else if (st.phase === "game_end") {
    const res = (g && g.result) || [];
    const top = res.length ? res[0].wins : 0;
    const champs = res.filter((e) => e.wins === top && top > 0).map((e) => nameOf(st, e.pid));
    banner("<h1>" + (champs.length ? esc(champs.join(" & ")) + (champs.length === 1 ? " WINS!" : " WIN!") : "Good game") + "</h1>"
      + "<p>" + res.map((e) => esc(nameOf(st, e.pid)) + " · " + e.wins).join("&nbsp;&nbsp;·&nbsp;&nbsp;") + "</p>");
    if (champs.length) Hub.confettiBurst(200);
  }

  renderRoster(st);
  lastStage = stage;
}

Hub.connect("/games/bingo/ws", { onState: render }, { watch: true });
