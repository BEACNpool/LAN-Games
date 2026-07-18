/* checkers client — tap a disc, tap where it lands (multi-jumps land far;
   intermediate hops are shown numbered) */
"use strict";

const $ = (id) => document.getElementById(id);
let sel = null;   // selected source square index

function renderBoard(G) {
  const g = G.game();
  const flip = g.my_color === "b";
  const el = $("board");
  el.textContent = "";
  const mine = {};
  if (G.myTurn()) {
    for (const path of g.legal) {
      (mine[path[0]] = mine[path[0]] || []).push(path);
    }
  }
  if (sel !== null && !mine[sel]) sel = null;
  // destination -> path; intermediate hop squares -> step number
  const dests = {}, hops = {};
  if (sel !== null) {
    for (const path of mine[sel]) {
      dests[path[path.length - 1]] = path;
      path.slice(1, -1).forEach((sq, i) => { hops[sq] = i + 1; });
    }
  }

  for (let vi = 0; vi < 64; vi++) {
    const idx = flip ? 63 - vi : vi;
    const row = (idx / 8) | 0, col = idx % 8;
    const sq = document.createElement("div");
    // playable squares (where the engine puts pieces) render as the darker
    // tone — the classic look
    sq.className = "sq " + ((row + col) % 2 ? "light" : "dark");
    const piece = g.board[idx];
    if (piece) {
      const d = document.createElement("span");
      d.className = "disc " + piece.toLowerCase()
        + (piece === piece.toUpperCase() ? " king" : "");
      sq.appendChild(d);
    }
    if (sel === idx) sq.classList.add("sel");
    if (dests[idx] !== undefined) {
      const m = document.createElement("span");
      m.className = "hopmark";
      sq.appendChild(m);
    }
    if (hops[idx] !== undefined) {
      const n = document.createElement("span");
      n.className = "hopnum";
      n.textContent = hops[idx];
      sq.appendChild(n);
    }
    sq.onclick = () => {
      if (!G.myTurn()) return;
      if (sel !== null && dests[idx]) {
        G.SFX.unlock();
        G.send({ t: "move", path: dests[idx] });
        sel = null;
        return;
      }
      sel = mine[idx] ? (sel === idx ? null : idx) : null;
      G.SFX.click();
      renderBoard(G);
    };
    el.appendChild(sq);
  }
}

const Game = DuelGame({
  wsPath: "/games/checkers/ws",
  title: "Checkers", icon: "⛀",
  colors: { w: { name: "Cream", icon: "⚪" }, b: { name: "Navy", icon: "🔵" } },
  renderBoard,
  seatExtra(color, g) {
    // pieces remaining
    let n = 0;
    for (const v of g.board) if (v && v.toLowerCase() === color) n++;
    return "●" + n;
  },
  onMoved(G, fx) {
    sel = null;
    if (fx.capture) G.SFX.capture(); else G.SFX.place();
  },
});

/* forced-captures house rule toggle (lobby) */
(function wireForced() {
  const seg = $("opt-forced");
  if (!seg) return;
  const render = () => {
    const st = Game.st;
    if (!st) return;
    seg.textContent = "";
    for (const [val, label] of [[true, "ON"], [false, "OFF"]]) {
      const b = document.createElement("button");
      b.textContent = label;
      b.className = st.settings.forced === val ? "sel" : "";
      b.onclick = () => Game.send({ t: "settings", patch: { forced: val } });
      seg.appendChild(b);
    }
  };
  setInterval(render, 600);
})();
