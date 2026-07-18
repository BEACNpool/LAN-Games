/* chess client — FEN renderer, tap-to-move with legal-move dots,
   promotion picker. Server (python-chess) is the referee. */
"use strict";

const $ = (id) => document.getElementById(id);
const GLYPHS = { K: "♔", Q: "♕", R: "♖", B: "♗", N: "♘", P: "♙",
                 k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
const VALS = { p: 1, n: 3, b: 3, r: 5, q: 9 };

let sel = null;          // selected square name e.g. "e2"
let pendingPromo = null; // {from, to, options}

function sqName(file, rank) { return "abcdefgh"[file] + (rank + 1); }

function parseFen(fen) {
  const board = {};
  const rows = fen.split(" ")[0].split("/");
  for (let r = 0; r < 8; r++) {
    let f = 0;
    for (const ch of rows[r]) {
      if (/\d/.test(ch)) f += +ch;
      else { board[sqName(f, 7 - r)] = ch; f++; }
    }
  }
  return board;
}

function renderBoard(G) {
  const g = G.game();
  const board = parseFen(g.fen);
  const flip = g.my_color === "b";
  const el = $("board");
  el.textContent = "";
  const myMoves = {};
  if (G.myTurn()) {
    for (const uci of g.legal) {
      const from = uci.slice(0, 2);
      (myMoves[from] = myMoves[from] || []).push(uci);
    }
  }
  if (sel && !myMoves[sel]) sel = null;
  const targets = new Set(
    sel ? myMoves[sel].map((u) => u.slice(2, 4)) : []);
  const last = g.last_move
    ? [g.last_move.slice(0, 2), g.last_move.slice(2, 4)] : [];

  for (let i = 0; i < 64; i++) {
    const vr = 7 - ((i / 8) | 0);          // rank from top
    const rank = flip ? 7 - vr : vr;
    const vf = i % 8;
    const file = flip ? 7 - vf : vf;
    const name = sqName(file, rank);
    const sq = document.createElement("div");
    sq.className = "sq " + ((file + rank) % 2 ? "light" : "dark");
    sq.dataset.sq = name;
    if (last.includes(name)) sq.classList.add("last");
    if (g.check_sq === name) sq.classList.add("check");
    if (sel === name) sq.classList.add("sel");
    const piece = board[name];
    if (piece) {
      const pc = document.createElement("span");
      pc.className = "pc " + (piece === piece.toUpperCase() ? "white" : "black");
      pc.textContent = GLYPHS[piece];
      sq.appendChild(pc);
    }
    if (targets.has(name)) {
      const marker = document.createElement("span");
      marker.className = piece ? "ring" : "dot";
      sq.appendChild(marker);
    }
    if (file === (flip ? 7 : 0)) {
      const c = document.createElement("span");
      c.className = "coord";
      c.textContent = rank + 1;
      sq.appendChild(c);
    }
    sq.onclick = () => tap(G, name, myMoves);
    el.appendChild(sq);
  }
  renderCaptured(G, flip);
}

function tap(G, name, myMoves) {
  if (!G.myTurn()) return;
  const g = G.game();
  if (sel && sel !== name) {
    const moves = (myMoves[sel] || []).filter((u) => u.slice(2, 4) === name);
    if (moves.length === 1) {
      G.SFX.unlock();
      G.send({ t: "move", uci: moves[0] });
      sel = null;
      return;
    }
    if (moves.length > 1) {        // promotion — q/r/b/n variants
      openPromo(G, moves);
      sel = null;
      return;
    }
  }
  sel = myMoves[name] ? (sel === name ? null : name) : null;
  G.SFX.click();
  renderBoard(G);
}

function openPromo(G, moves) {
  const row = $("promo-row");
  row.textContent = "";
  const white = G.game().my_color === "w";
  for (const u of moves) {
    const piece = u[4];
    const b = document.createElement("button");
    b.textContent = GLYPHS[white ? piece.toUpperCase() : piece];
    b.onclick = () => {
      $("promo-modal").hidden = true;
      G.send({ t: "move", uci: u });
    };
    row.appendChild(b);
  }
  $("promo-modal").hidden = false;
}

function renderCaptured(G, flip) {
  const g = G.game();
  // pieces WHITE has lost go in black's tray and vice versa
  const trays = { top: flip ? "b" : "w", bottom: flip ? "w" : "b" };
  let diff = 0;
  for (const [c, list] of Object.entries(g.captured)) {
    for (const p of list) diff += (c === "b" ? 1 : -1) * (VALS[p] || 0);
  }
  for (const [pos, color] of Object.entries(trays)) {
    const el = $("captured-" + pos);
    el.textContent = "";
    for (const p of g.captured[color]) {
      const s = document.createElement("span");
      s.className = color === "w" ? "cw" : "cb";
      s.textContent = GLYPHS[color === "w" ? p.toUpperCase() : p];
      el.appendChild(s);
    }
    const lead = color === "w" ? -diff : diff;   // advantage of the OTHER side
    if (lead > 0) {
      const m = document.createElement("span");
      m.className = "mat";
      m.textContent = "+" + lead;
      el.appendChild(m);
    }
  }
}

DuelGame({
  wsPath: "/games/chess/ws",
  title: "Chess", icon: "♞",
  colors: { w: { name: "White", icon: "⚪" }, b: { name: "Black", icon: "⚫" } },
  renderBoard,
  onMoved(G, fx) {
    sel = null;
    if (fx.check) G.SFX.capture(); else G.SFX.place();
  },
  onState(G, st) {
    if (st.phase !== "playing" && !st.game) { sel = null; }
    if ($("promo-modal") && !G.myTurn()) $("promo-modal").hidden = true;
  },
});
