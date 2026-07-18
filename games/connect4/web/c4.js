/* connect four client — tap a column to drop */
"use strict";

const $ = (id) => document.getElementById(id);
let lastCount = 0;

function discCount(g) {
  return g.cols.reduce((a, c) => a + c.length, 0);
}

function renderBoard(G) {
  const g = G.game();
  const el = $("board");
  el.textContent = "";
  const n = discCount(g);
  const animate = n === lastCount + 1;
  lastCount = n;
  const winSet = new Set((g.win_line || []).map(([c, r]) => c + ":" + r));
  for (let c = 0; c < 7; c++) {
    const col = document.createElement("div");
    col.className = "c4-col"
      + (G.myTurn() && g.legal.includes(c) ? " legal" : "");
    for (let r = 0; r < 6; r++) {
      const cell = document.createElement("div");
      const v = g.cols[c][r];
      cell.className = "c4-cell " + (v || "empty");
      if (v && winSet.has(c + ":" + r)) cell.classList.add("winline");
      if (animate && g.last_col === c && r === g.cols[c].length - 1 && v) {
        cell.classList.add("dropped");
      }
      col.appendChild(cell);
    }
    col.onclick = () => {
      if (!G.myTurn() || !g.legal.includes(c)) return;
      G.SFX.unlock();
      G.send({ t: "move", col: c });
    };
    el.appendChild(col);
  }
}

DuelGame({
  wsPath: "/games/connect4/ws",
  title: "Connect Four", icon: "🔴",
  colors: { r: { name: "Red", icon: "🔴" }, y: { name: "Yellow", icon: "🟡" } },
  renderBoard,
  onMoved(G, fx) { G.SFX.place(); },
});
