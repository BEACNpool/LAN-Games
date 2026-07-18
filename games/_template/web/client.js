/* _template client — the smallest complete hub game client.
   Shows the shape: identity via Hub, one connection, render(state), send actions. */
"use strict";

const $ = (id) => document.getElementById(id);
let ST = null, PID = null;

if (!Hub.identity.name) Hub.identity.name = "PLAYER";

const conn = Hub.connect("/games/template/ws", {
  onWelcome: (m) => { PID = m.pid; },
  onFx: (fx) => {
    if (fx.kind === "toast") Hub.toast((fx.icon ? fx.icon + " " : "") + fx.msg);
    if (fx.kind === "invalid") Hub.toast(fx.msg, "err");
    if (fx.kind === "reveal" && fx.winner === PID) Hub.confettiBurst(80);
  },
  onState: render,
});

function render(st) {
  ST = st;
  $("countdown-overlay").hidden = st.phase !== "countdown";
  const btn = $("action-btn");
  const stage = $("stage");
  if (st.phase === "lobby" || st.phase === "countdown") {
    const n = st.players.filter((p) => p.ready && p.connected).length;
    $("status").textContent = `LOBBY — ${n} ready of ${st.players.length}`;
    stage.textContent = "";
    const me = st.you;
    btn.hidden = false;
    if (me && me.ready && n >= st.min_players) {
      btn.textContent = "GO!";
      btn.onclick = () => conn.send({ t: "start" });
    } else {
      btn.textContent = me && me.ready ? "READY ✓" : "READY UP";
      btn.onclick = () => conn.send({ t: "ready", ready: !(me && me.ready) });
    }
    return;
  }
  const g = st.game;
  if (!g) return;
  $("status").textContent = `ROUND ${g.round}/${g.rounds} — ${g.stage.toUpperCase()}`;
  stage.textContent = "";
  if (g.stage === "game_end" && g.result) {
    const list = document.createElement("div");
    list.className = "results";
    for (const e of g.result) {
      const p = st.players.find((q) => q.pid === e.pid);
      const row = document.createElement("div");
      row.className = "rrow";
      row.textContent = `${p ? p.avatar + " " + p.name : e.pid} — ${e.points}`;
      list.appendChild(row);
    }
    stage.appendChild(list);
    btn.hidden = true;
    return;
  }
  const mine = g.cards[PID];
  const big = document.createElement("div");
  big.className = "bigcard";
  big.textContent = mine ? mine : "🂠";
  stage.appendChild(big);
  const others = document.createElement("div");
  others.className = "results";
  for (const [pid, c] of Object.entries(g.cards)) {
    if (pid === PID) continue;
    const p = st.players.find((q) => q.pid === pid);
    const row = document.createElement("div");
    row.className = "rrow";
    row.textContent = `${p ? p.name : pid}: ${c}`;
    others.appendChild(row);
  }
  stage.appendChild(others);
  btn.hidden = g.stage !== "drawing" || g.you_drew;
  btn.textContent = "DRAW";
  btn.onclick = () => conn.send({ t: "draw" });
}
