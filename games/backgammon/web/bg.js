/* backgammon client — server enumerates legal complete turns; the player
   builds theirs step by step (tap source, tap destination); it auto-submits
   when the turn is complete. Board preview applies pending steps locally. */
"use strict";

const $ = (id) => document.getElementById(id);
let pending = [];      // steps chosen so far this turn: [src,dst]
let sel = null;        // selected source ("bar" or point index)

const stepEq = (a, b) => a[0] === b[0] && a[1] === b[1];

function candidates(G) {
  const g = G.game();
  return (g.turns || []).filter((t) =>
    pending.every((s, i) => t[i] && stepEq(t[i], s)));
}

function nextSteps(G) {
  const i = pending.length;
  const out = [];
  for (const t of candidates(G)) {
    if (t[i] && !out.some((s) => stepEq(s, t[i]))) out.push(t[i]);
  }
  return out;
}

function previewState(G) {
  const g = G.game();
  const points = [...g.points];
  const bar = { ...g.bar };
  const off = { ...g.off };
  const me = g.my_color;
  const sign = me === "w" ? 1 : -1;
  for (const [src, dst] of pending) {
    if (src === "bar") bar[me]--;
    else points[src] -= sign;
    if (dst === "off") off[me]++;
    else {
      if (points[dst] === -sign) {          // hit a blot
        points[dst] = 0;
        bar[me === "w" ? "b" : "w"]++;
      }
      points[dst] += sign;
    }
  }
  return { points, bar, off };
}

function maybeSubmit(G) {
  const cands = candidates(G);
  if (cands.length && cands.some((t) => t.length === pending.length)) {
    G.send({ t: "move", steps: pending.map((s) => [s[0], s[1]]) });
    pending = [];
    sel = null;
    return true;
  }
  return false;
}

function tapSource(G, src) {
  const steps = nextSteps(G).filter((s) => s[0] === src);
  if (!steps.length) { sel = null; renderBoard(G); return; }
  if (steps.length === 1) {
    pending.push(steps[0]);
    G.SFX.place();
    sel = null;
    if (!maybeSubmit(G)) renderBoard(G);
    return;
  }
  sel = src;
  G.SFX.click();
  renderBoard(G);
}

function tapDest(G, dst) {
  const step = nextSteps(G).find((s) => s[0] === sel && s[1] === dst);
  if (!step) { sel = null; renderBoard(G); return; }
  pending.push(step);
  G.SFX.place();
  sel = null;
  if (!maybeSubmit(G)) renderBoard(G);
}

function checkerStack(host, count, color, topDown) {
  const n = Math.abs(count);
  const shown = Math.min(n, 5);
  for (let i = 0; i < shown; i++) {
    const c = document.createElement("span");
    c.className = "bg-chk " + color;
    if (i === shown - 1 && n > 5) {
      c.classList.add("count");
      c.textContent = n;
    }
    host.appendChild(c);
  }
}

function renderBoard(G) {
  const g = G.game();
  const view = previewState(G);
  const flip = g.my_color === "b";
  const el = $("board");
  el.textContent = "";

  const myTurn = G.myTurn();
  const next = myTurn ? nextSteps(G) : [];
  const srcSet = new Set(next.map((s) => s[0]));
  const dstSet = sel !== null
    ? new Set(next.filter((s) => s[0] === sel).map((s) => s[1])) : new Set();

  // quadrant layouts (white view); flip rotates the whole board
  const topIdx = [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];
  const botIdx = [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0];
  const rows = flip ? [botIdx.slice().reverse(), topIdx.slice().reverse()]
                    : [topIdx, botIdx];

  const mkQuad = (idxs, isTop) => {
    const q = document.createElement("div");
    q.className = "bg-quad";
    for (const idx of idxs) {
      const pt = document.createElement("div");
      pt.className = "bg-point " + (isTop ? "top" : "bottom")
        + (idx % 2 ? " odd" : " even");
      if (srcSet.has(idx)) pt.classList.add("src");
      if (dstSet.has(idx)) pt.classList.add("dst");
      if (sel === idx) pt.classList.add("sel");
      const v = view.points[idx];
      if (v !== 0) checkerStack(pt, v, v > 0 ? "w" : "b", isTop);
      pt.onclick = () => {
        if (!myTurn) return;
        if (sel !== null && dstSet.has(idx)) tapDest(G, idx);
        else tapSource(G, idx);
      };
      q.appendChild(pt);
    }
    return q;
  };

  // grid children in order: left quad (row1), bar, right quad (row1), off,
  // then row2 quads (bar/off span both rows)
  const topRow = rows[0], botRow = rows[1];
  const q1 = mkQuad(topRow.slice(0, 6), true);
  const q2 = mkQuad(topRow.slice(6), true);
  const q3 = mkQuad(botRow.slice(0, 6), false);
  const q4 = mkQuad(botRow.slice(6), false);

  const bar = document.createElement("div");
  bar.className = "bg-bar";
  for (const c of ["b", "w"]) {
    const cell = document.createElement("div");
    cell.style.display = "flex";
    cell.style.flexDirection = "column";
    cell.style.gap = "2px";
    checkerStack(cell, view.bar[c], c, true);
    bar.appendChild(cell);
  }
  if (srcSet.has("bar")) bar.classList.add("src");
  if (sel === "bar") bar.classList.add("sel");
  bar.onclick = () => { if (myTurn) tapSource(G, "bar"); };

  const off = document.createElement("div");
  off.className = "bg-off";
  if (sel !== null && dstSet.has("off")) off.classList.add("hot");
  for (const c of flip ? ["w", "b"] : ["b", "w"]) {
    const tray = document.createElement("div");
    tray.className = "off-tray";
    tray.textContent = "⌂" + view.off[c];
    off.appendChild(tray);
  }
  off.onclick = () => {
    if (myTurn && sel !== null && dstSet.has("off")) tapDest(G, "off");
  };

  q1.style.gridArea = "1 / 1";
  bar.style.gridArea = "1 / 2 / 3 / 3";
  q2.style.gridArea = "1 / 3";
  off.style.gridArea = "1 / 4 / 3 / 5";
  q3.style.gridArea = "2 / 1";
  q4.style.gridArea = "2 / 3";
  el.append(q1, bar, q2, off, q3, q4);

  // dice + pips + undo
  const diceEl = $("bg-dice");
  diceEl.textContent = "";
  const used = pending.length;
  const dice = g.remaining.length ? g.remaining
    : (g.dice || []);
  dice.forEach((d, i) => {
    const die = document.createElement("span");
    die.className = "die" + (i < used ? " used" : "");
    die.textContent = d;
    diceEl.appendChild(die);
  });
  $("bg-pips").textContent = `pips ${g.pips.w} · ${g.pips.b}`;
  $("bg-undo").hidden = !(myTurn && pending.length);
  $("bg-undo").onclick = () => {
    pending.pop();
    sel = null;
    renderBoard(G);
  };
}

DuelGame({
  wsPath: "/games/backgammon/ws",
  title: "Backgammon", icon: "🎲",
  colors: { w: { name: "White", icon: "⚪" }, b: { name: "Black", icon: "⚫" } },
  renderBoard,
  seatExtra(color, g) { return "pip " + g.pips[color]; },
  onMoved(G, fx) { G.SFX.place(); },
  onState(G, st) {
    const g = st.game;
    if (!g || !G.myTurn()) { pending = []; sel = null; }
  },
  onFx(G, fx) {
    if (fx.kind === "rolled") G.SFX.click();
  },
});
