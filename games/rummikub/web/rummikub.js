/* RUMMIKUB client.
   All rearranging is LOCAL: on my turn I snapshot the server board+hand,
   drag tiles freely with live per-group validation, and either COMMIT the
   full proposed board (server referees it), DRAW, or UNDO back to the
   snapshot. The server never sees mid-drag mess. */
"use strict";

const $ = (id) => document.getElementById(id);
const SHAPES = { r: "●", b: "▲", k: "■", y: "★" };   // colorblind secondary cue

const S = {
  st: null, pid: null, conn: null, joined: false,
  local: null,           // {groups, hand, startGroups, startHand}
  wasMyTurn: false,
  sortMode: localStorage.getItem("rk-sort") || "runs",
  badIdx: [], badReason: "",
  muted: localStorage.getItem("wc-muted") === "1",
};

/* ---------------- sounds ---------------- */
const SFX = (() => {
  let ctx = null;
  const ac = () => {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  };
  const tone = (f, type, dur, vol = 0.12, when = 0, glide = 0) => {
    if (S.muted) return;
    try {
      const c = ac(), t = c.currentTime + when;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(f, t);
      if (glide) o.frequency.exponentialRampToValueAtTime(Math.max(40, f + glide), t + dur);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + dur + 0.05);
    } catch (e) {}
  };
  return {
    unlock: () => { try { ac(); } catch (e) {} },
    pick: () => tone(500, "triangle", 0.05, 0.09),
    drop: () => tone(300, "triangle", 0.07, 0.12),
    click: () => tone(700, "square", 0.04, 0.05),
    turn: () => { tone(880, "sine", 0.1, 0.13); tone(1175, "sine", 0.14, 0.11, 0.08); },
    good: () => [523, 659, 784].forEach((f, i) => tone(f, "sine", 0.18, 0.11, i * 0.07)),
    fanfare: () => [392, 523, 659, 784, 1047].forEach((f, i) => tone(f, "sine", 0.28, 0.12, i * 0.1)),
    bad: () => tone(150, "sawtooth", 0.2, 0.08, 0, -60),
    tick: () => tone(1150, "square", 0.03, 0.045),
  };
})();

/* ---------------- rules mirror (client-side live validation) ---------------- */

const isJoker = (t) => t[0] === "J";
const colorOf = (t) => t[0];
const numberOf = (t) => parseInt(t.slice(1, 3), 10);

function validateGroup(tiles) {
  const n = tiles.length;
  if (n < 3) return { ok: false, reason: "needs 3+ tiles", values: null };
  const real = tiles.map((t, i) => [i, t]).filter(([, t]) => !isJoker(t));
  if (!real.length) return { ok: false, reason: "jokers need a real tile", values: null };
  const nums = new Set(real.map(([, t]) => numberOf(t)));
  if (nums.size === 1) {
    const colors = real.map(([, t]) => colorOf(t));
    if (n <= 4 && new Set(colors).size === colors.length) {
      const v = numberOf(real[0][1]);
      return { ok: true, reason: "", values: Array(n).fill(v) };
    }
    if (n > 4) return { ok: false, reason: "max 4 in a group", values: null };
    return { ok: false, reason: "same color twice", values: null };
  }
  const colors = new Set(real.map(([, t]) => colorOf(t)));
  if (colors.size === 1) {
    const [i0, t0] = real[0];
    const start = numberOf(t0) - i0;
    if (start < 1 || start + n - 1 > 13)
      return { ok: false, reason: "runs stay inside 1-13", values: null };
    for (const [i, t] of real) {
      if (numberOf(t) !== start + i)
        return { ok: false, reason: "not consecutive", values: null };
    }
    return { ok: true, reason: "", values: tiles.map((_, i) => start + i) };
  }
  return { ok: false, reason: "not a run or a group", values: null };
}

/* When a tile is pulled out of the middle of a run, the leftover tiles are
   still one group with a gap (e.g. r1 r2 r3 _ r5 r6 r7 → invalid). Borrowing
   off the board should leave CLEAN sets, so split a gapped, single-colour,
   joker-free run into its maximal consecutive segments. Groups of a kind and
   any set holding a joker are left untouched — their gaps are ambiguous and
   the player is arranging those by hand. */
function resplitRun(grp) {
  const real = grp.filter((t) => !isJoker(t));
  if (real.length < 2) return [grp];
  if (grp.length !== real.length) return [grp];             // holds a joker
  if (new Set(real.map(colorOf)).size !== 1) return [grp];  // not one colour
  if (new Set(real.map(numberOf)).size === 1) return [grp]; // group of a kind
  const segs = [];
  let seg = [grp[0]];
  for (let i = 1; i < grp.length; i++) {
    if (numberOf(grp[i]) === numberOf(grp[i - 1]) + 1) seg.push(grp[i]);
    else { segs.push(seg); seg = [grp[i]]; }
  }
  segs.push(seg);
  return segs;
}
window.__rk = { resplitRun, validateGroup };   // test hook (pure, read-only)

/* ---------------- helpers ---------------- */

const game = () => S.st?.game || null;
const playerByPid = (pid) => (S.st?.players || []).find((p) => p.pid === pid);
const myTurn = () => {
  const g = game();
  return g && g.stage === "playing" && g.turn === S.pid && g.hand !== null;
};
const remainMs = () => S.st?.deadline ? Math.max(0, S.st.deadline - S.conn.now()) : 0;

function sortHand(hand) {
  const key = S.sortMode === "runs"
    ? (t) => (isJoker(t) ? [9, 99, t] : ["rbky".indexOf(colorOf(t)), numberOf(t), t])
    : (t) => (isJoker(t) ? [99, 9, t] : [numberOf(t), "rbky".indexOf(colorOf(t)), t]);
  // element-wise tuple compare — arrays with </> coerce to strings ("13"<"2")
  const cmp = (ka, kb) => {
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] < kb[i]) return -1;
      if (ka[i] > kb[i]) return 1;
    }
    return 0;
  };
  return [...hand].sort((a, b) => cmp(key(a), key(b)));
}

function placedSet() {
  // tiles on the local board that came from my hand this turn
  if (!S.local) return new Set();
  const startBoard = new Set(S.local.startGroups.flat());
  return new Set(S.local.groups.flat().filter((t) => !startBoard.has(t)));
}

function localPlayedCount() { return placedSet().size; }

function meldInfo() {
  // for an unopened player: created groups made purely of my placed tiles
  const placed = placedSet();
  let total = 0;
  const startSeq = S.local.startGroups.map((g) => g.join(","));
  for (const grp of S.local.groups) {
    if (startSeq.includes(grp.join(","))) continue;
    if (!grp.every((t) => placed.has(t))) continue;
    const v = validateGroup(grp);
    if (v.ok) total += v.values.reduce((a, b) => a + b, 0);
  }
  return total;
}

function tileEl(t, opts = {}) {
  const d = document.createElement("div");
  d.className = "tile" + (isJoker(t) ? " joker" : " c-" + colorOf(t));
  d.dataset.t = t;
  const n = document.createElement("span");
  n.className = "tn";
  n.textContent = isJoker(t) ? "☺" : numberOf(t);
  d.appendChild(n);
  if (!isJoker(t)) {
    const s = document.createElement("span");
    s.className = "ts";
    s.textContent = SHAPES[colorOf(t)];
    d.appendChild(s);
  }
  if (opts.draggable) d.classList.add("draggable");
  if (opts.placed) d.classList.add("placed-now");
  return d;
}

function show(id) {
  for (const s of ["scr-join", "scr-lobby", "scr-game"]) $(s).hidden = s !== id;
}

/* ---------------- lobby ---------------- */

function renderLobby(st) {
  const grid = $("player-grid");
  grid.textContent = "";
  const humans = st.players.filter((p) => !p.bot);
  for (const p of humans) {
    const card = document.createElement("div");
    card.className = "player-card" + (p.ready ? " is-ready" : "") + (p.connected ? "" : " is-away");
    const av = document.createElement("div"); av.className = "pc-avatar";
    Hub.fillAvatar(av, p);
    const meta = document.createElement("div");
    const nm = document.createElement("div"); nm.className = "pc-name"; nm.textContent = p.name;
    if (p.pid === S.pid) {
      const yt = document.createElement("span"); yt.className = "you-tag"; yt.textContent = "YOU";
      nm.appendChild(yt);
    }
    const stt = document.createElement("div");
    stt.className = "pc-status" + (p.ready ? " rdy" : "");
    stt.textContent = !p.connected ? "away" : p.ready ? "READY" : "not ready";
    meta.appendChild(nm); meta.appendChild(stt);
    card.appendChild(av); card.appendChild(meta);
    grid.appendChild(card);
  }
  const readyN = humans.filter((p) => p.ready && p.connected).length;
  $("ready-count").textContent = `${readyN} READY`;
  const total = Math.min(6, readyN + (st.settings.bot_players || 0));
  $("set-note").textContent = total >= 5
    ? `${total} players → DOUBLE set (212 tiles, 4 jokers)`
    : "single set (106 tiles) — 5+ players switches to the double set";
  $("rounds-val").textContent = st.settings.rounds;
  $("turn-val").textContent = st.settings.turn_seconds + "s";
  $("bots-val").textContent = st.settings.bot_players;
  document.querySelectorAll("#skill-seg button").forEach((b) =>
    b.classList.toggle("sel", b.dataset.v === (st.settings.bot_skill || "smart")));

  const me = st.you;
  const amReady = !!(me && me.ready);
  $("ready-btn").textContent = amReady ? "READY ✓" : "READY UP";
  $("ready-btn").classList.toggle("is-ready", amReady);
  $("go-btn").hidden = !(readyN >= st.min_players && amReady && st.phase === "lobby");
  $("lobby-hint").textContent =
    st.phase === "countdown" ? "RACKING…"
    : readyN >= st.min_players ? "tiles are itching — rack 'em!"
    : readyN === 1 ? "need one more human…"
    : `waiting for players — ${location.host}`;
}

/* ---------------- game rendering ---------------- */

function renderSeats(st) {
  const g = game();
  const strip = $("seat-strip");
  strip.textContent = "";
  for (const seat of g.seats) {
    const p = playerByPid(seat.pid);
    const chip = document.createElement("div");
    chip.className = "seat-chip"
      + (g.turn === seat.pid && g.stage === "playing" ? " turn" : "")
      + (seat.pid === S.pid ? " me" : "");
    const av = document.createElement("span"); av.className = "sc-av";
    Hub.fillAvatar(av, p);
    const n = document.createElement("span"); n.className = "sc-n";
    n.textContent = seat.tiles + (seat.auto && p && !p.bot ? "🛰" : "");
    const meld = document.createElement("span");
    meld.className = "sc-meld" + (seat.melded ? " yes" : "");
    meld.title = seat.melded ? "opened" : "hasn't opened";
    chip.appendChild(av); chip.appendChild(n); chip.appendChild(meld);
    strip.appendChild(chip);
  }
  $("pool-chip").innerHTML = "";
  $("pool-chip").append("🁵 ");
  const b = document.createElement("b");
  b.textContent = g.pool;
  $("pool-chip").appendChild(b);
}

function currentGroups() {
  return S.local ? S.local.groups : (game().board || []);
}

function renderBoard() {
  const g = game();
  const host = $("board-groups");
  host.textContent = "";
  const groups = currentGroups();
  const editing = !!S.local;
  $("board-wrap").classList.toggle("editing", editing);
  const placed = placedSet();
  const preMeld = editing && !g.melded;
  groups.forEach((grp, gi) => {
    const el = document.createElement("div");
    el.className = "tile-group";
    el.dataset.gi = gi;
    const v = validateGroup(grp);
    if (editing && !v.ok) {
      el.classList.add("bad");
      el.title = v.reason;
    }
    if (S.badIdx.includes(gi)) el.classList.add("bad");
    grp.forEach((t) => {
      const draggable = editing && (placed.has(t) || (!preMeld && g.melded));
      el.appendChild(tileEl(t, { draggable, placed: placed.has(t) }));
    });
    host.appendChild(el);
  });
  $("board-empty").hidden = groups.length > 0 || editing;
}

function renderHand() {
  const g = game();
  const tray = $("hand-tray");
  tray.textContent = "";
  const watching = g.hand === null;
  $("watch-note").hidden = !watching;
  if (watching) return;
  const hand = S.local ? S.local.hand : g.hand;
  for (const t of sortHand(hand)) {
    tray.appendChild(tileEl(t, { draggable: !!S.local }));
  }
}

function endTurnBlocker() {
  /* null if the commit would succeed; otherwise a human-readable reason */
  const g = game();
  if (!S.local) return "not your turn";
  if (localPlayedCount() === 0)
    return "play at least one tile from your hand — or tap DRAW to pass";
  const bad = S.local.groups.find((grp) => !validateGroup(grp).ok);
  if (bad) return "fix the red set: " + validateGroup(bad).reason;
  if (!g.melded && meldInfo() < 30)
    return `your opening needs 30+ points of NEW sets from your own hand — you have ${meldInfo()}`;
  return null;
}

function renderControls() {
  const g = game();
  const mine = myTurn();
  const editing = !!S.local;
  $("draw-btn").disabled = !mine;
  const movedBoard = editing &&
    JSON.stringify(S.local.groups) !== JSON.stringify(S.local.startGroups);
  $("undo-btn").disabled = !(editing && movedBoard);
  // END TURN stays tappable so a blocked commit can explain itself
  const endOk = editing && endTurnBlocker() === null;
  $("end-btn").disabled = !editing;
  $("end-btn").classList.toggle("inactive", !endOk);

  const meter = $("meld-meter");
  if (editing && !g.melded) {
    meter.hidden = false;
    const total = meldInfo();
    $("meld-val").textContent = total;
    meter.classList.toggle("ok", total >= 30);
  } else meter.hidden = true;

  const note = $("turn-note");
  if (g.stage !== "playing") { note.textContent = "—"; return; }
  if (mine) {
    note.textContent = "YOUR TURN";
    note.classList.add("mine");
  } else {
    const p = playerByPid(g.turn);
    note.textContent = p ? `${p.name} is arranging…` : "…";
    note.classList.remove("mine");
  }
}

let sumShownFor = "";
function renderSummary(st) {
  const g = game();
  const showIt = g.stage === "round_end" && g.summary;
  $("summary").hidden = !showIt;
  if (!showIt) { sumShownFor = ""; return; }
  const key = "r" + g.round_no;
  $("sum-next").textContent = "";
  if (sumShownFor === key) return;
  sumShownFor = key;
  const w = playerByPid(g.summary.winner);
  $("sum-title").textContent = g.summary.stalemate
    ? `POOL EMPTY — ${w ? w.name : "?"} WINS THE STALEMATE`
    : `ROUND ${g.round_no} — ${w ? w.name.toUpperCase() : "?"} GOES OUT`;
  const body = $("sum-body");
  body.textContent = "";
  for (const row of g.summary.rows) {
    const p = playerByPid(row.pid);
    const div = document.createElement("div");
    div.className = "sum-row" + (row.pid === g.summary.winner ? " winner" : "");
    const av = document.createElement("span");
    Hub.fillAvatar(av, p);
    const nm = document.createElement("span"); nm.className = "sr-name";
    nm.textContent = p ? p.name : row.pid;
    const left = document.createElement("span"); left.className = "sr-left";
    left.textContent = row.left ? `${row.left} tiles · ${row.value} pts left` : "went out";
    const gain = document.createElement("b");
    gain.textContent = (row.gain >= 0 ? "+" : "") + row.gain;
    gain.className = row.gain >= 0 ? "pos" : "neg";
    const tot = document.createElement("b");
    tot.textContent = " → " + row.total;
    div.append(av, nm, left, gain, tot);
    body.appendChild(div);
  }
}

let goShown = false;
function renderGameOver(st) {
  const g = game();
  const showIt = st.phase === "game_end" && g && g.result;
  $("gameover").hidden = !showIt;
  if (!showIt) { goShown = false; return; }
  const w = playerByPid(g.result.winner);
  $("go-title").textContent = `${w ? w.name.toUpperCase() : "?"} WINS`;
  const rows = $("go-rows");
  rows.textContent = "";
  g.result.rows.forEach((r, i) => {
    const p = playerByPid(r.pid);
    const div = document.createElement("div");
    div.className = "sum-row" + (i === 0 ? " winner" : "");
    const av = document.createElement("span");
    Hub.fillAvatar(av, p);
    const nm = document.createElement("span");
    nm.className = "sr-name";
    nm.textContent = `${i + 1}. ${p ? p.name : r.pid}`;
    const tot = document.createElement("b");
    tot.textContent = String(r.total);
    div.append(av, nm, tot);
    rows.appendChild(div);
  });
  if (!goShown) {
    goShown = true;
    Hub.confettiBurst(220);
    SFX.fanfare();
  }
}

function renderGame(st) {
  renderSeats(st);
  renderBoard();
  renderHand();
  renderControls();
  renderSummary(st);
}

/* ---------------- state entry ---------------- */

function onState(st) {
  S.st = st;
  if (!S.joined) return;
  if (Drag.active && Drag.active.started) cancelDrag();  // world moved under us
  const g = st.game;
  if (st.phase === "lobby" || st.phase === "countdown") {
    show("scr-lobby");
    S.local = null;
    S.wasMyTurn = false;
    $("summary").hidden = true;
    sumShownFor = "";
    renderLobby(st);
  } else if (g) {
    show("scr-game");
    const mine = myTurn();
    if (mine && !S.wasMyTurn) {
      // my turn just began: take the local snapshot
      S.local = {
        groups: g.board.map((x) => [...x]),
        hand: [...g.hand],
        startGroups: g.board.map((x) => [...x]),
        startHand: [...g.hand],
      };
      S.badIdx = [];
      SFX.turn();
      try { navigator.vibrate && navigator.vibrate(70); } catch (e) {}
    }
    if (!mine) { S.local = null; S.badIdx = []; }
    S.wasMyTurn = mine;
    renderGame(st);
  }
  renderGameOver(st);
  $("countdown-overlay").hidden = st.phase !== "countdown";
}

function onFx(fx) {
  switch (fx.kind) {
    case "toast": Hub.toast((fx.icon ? fx.icon + " " : "") + fx.msg); break;
    case "invalid": Hub.toast(fx.msg, "err"); SFX.bad(); break;
    case "commit_rejected":
      Hub.toast(fx.msg, "err"); SFX.bad();
      S.badIdx = fx.bad_groups || [];
      renderBoard(); renderControls();
      break;
    case "played": {
      const p = playerByPid(fx.pid);
      if (fx.opened && fx.meld_total)
        Hub.toast(`${p ? p.name : "?"} opens with ${fx.meld_total} points`);
      else if (p && fx.pid !== S.pid)
        Hub.toast(`${p.name} plays ${fx.n} tile${fx.n > 1 ? "s" : ""}`);
      if (fx.pid !== S.pid) SFX.drop();
      break;
    }
    case "drew": {
      const p = playerByPid(fx.pid);
      if (p && fx.pid !== S.pid) Hub.toast(`${p.name} draws`);
      break;
    }
    case "passed": {
      const p = playerByPid(fx.pid);
      Hub.toast(`${p ? p.name : "?"} passes — pool is empty`);
      break;
    }
    case "round_end": SFX.good(); break;
    case "countdown": SFX.turn(); break;
  }
}

/* ---------------- drag engine (pointer events) ---------------- */

const Drag = { active: null };

function cancelDrag() {
  const d = Drag.active;
  Drag.active = null;
  if (!d) return;
  d.clone?.remove();
  d.srcEl?.classList.remove("ghosted");
  $("board-wrap").classList.remove("dragging");
  document.querySelectorAll(".drop-hint").forEach((x) => x.classList.remove("drop-hint"));
}

document.addEventListener("pointerdown", (e) => {
  const tile = e.target.closest(".tile.draggable");
  if (!tile || !S.local) return;
  Drag.active = {
    t: tile.dataset.t, startX: e.clientX, startY: e.clientY,
    lastY: e.clientY,
    started: false, mode: null, clone: null, srcEl: tile,
    fromBoard: !!tile.closest(".tile-group"),
  };
  tile.setPointerCapture && tile.setPointerCapture(e.pointerId);
});

document.addEventListener("pointermove", (e) => {
  const d = Drag.active;
  if (!d) return;
  if (d.mode === "scroll") {
    // vertical swipe that began on a board tile pans the board manually
    // (touch-action:none suppresses native scrolling on tiles)
    $("board-wrap").scrollTop -= (e.clientY - d.lastY);
    d.lastY = e.clientY;
    return;
  }
  if (!d.started) {
    const dx = e.clientX - d.startX, dy = e.clientY - d.startY;
    if (Math.hypot(dx, dy) < 7) return;
    if (d.fromBoard && Math.abs(dy) > Math.abs(dx) * 1.4) {
      d.mode = "scroll";        // full boards must stay scrollable
      d.lastY = e.clientY;
      return;
    }
    d.started = true;
    d.mode = "drag";
    SFX.unlock(); SFX.pick();
    d.clone = d.srcEl.cloneNode(true);
    d.clone.classList.add("drag-clone");
    d.clone.classList.remove("draggable", "ghosted");
    document.body.appendChild(d.clone);
    d.srcEl.classList.add("ghosted");
    $("board-wrap").classList.add("dragging");
  }
  // on touch, hold the clone ABOVE the finger so it isn't hidden under it
  const lift = e.pointerType === "touch" ? 76 : 30;
  d.clone.style.left = (e.clientX - 23) + "px";
  d.clone.style.top = (e.clientY - lift) + "px";
  // edge autoscroll so far-away groups are reachable while dragging
  const bw = $("board-wrap");
  const r = bw.getBoundingClientRect();
  if (e.clientY < r.top + 44) bw.scrollTop -= 10;
  else if (e.clientY > r.bottom - 44) bw.scrollTop += 10;
  // live drop-target highlight
  document.querySelectorAll(".drop-hint").forEach((x) => x.classList.remove("drop-hint"));
  const target = dropTargetAt(e.clientX, e.clientY);
  if (target?.el) target.el.classList.add("drop-hint");
});

document.addEventListener("pointercancel", cancelDrag);
addEventListener("blur", cancelDrag);

function dropTargetAt(x, y) {
  const els = document.elementsFromPoint(x, y);
  for (const el of els) {
    if (el.classList?.contains("tile-group"))
      return { type: "group", gi: +el.dataset.gi, el, x };
    if (el.id === "new-group-zone") return { type: "new", el };
    if (el.id === "hand-tray") return { type: "hand", el };
    if (el.id === "board-wrap") return { type: "new", el: $("new-group-zone") };
  }
  return null;
}

document.addEventListener("pointerup", (e) => {
  const d = Drag.active;
  Drag.active = null;
  if (!d || !d.started) { Drag.active = null; return; }
  d.clone?.remove();
  d.srcEl?.classList.remove("ghosted");
  $("board-wrap").classList.remove("dragging");
  document.querySelectorAll(".drop-hint").forEach((x) => x.classList.remove("drop-hint"));
  const target = dropTargetAt(e.clientX, e.clientY);
  if (target && S.local) applyMove(d.t, target);
  else renderGame(S.st);
});

function removeTileLocally(t) {
  const L = S.local;
  const hi = L.hand.indexOf(t);
  if (hi >= 0) { L.hand.splice(hi, 1); return { from: "hand" }; }
  for (const grp of L.groups) {
    const i = grp.indexOf(t);
    if (i >= 0) { grp.splice(i, 1); return { from: "group", grp }; }
  }
  return { from: null };
}

function splitSourceRun(src, destGrp) {
  // after a tile leaves a board run (into another set or the hand), split any
  // gap it left so the borrow yields clean sets, not one broken red run.
  // A reorder WITHIN the same group (src.grp === destGrp) must not split.
  if (!src || src.from !== "group") return;
  const sg = src.grp;
  if (sg === destGrp || sg.length === 0) return;
  const parts = resplitRun(sg);
  if (parts.length <= 1) return;
  const gi = S.local.groups.indexOf(sg);
  if (gi >= 0) S.local.groups.splice(gi, 1, ...parts);
}

function applyMove(t, target) {
  const L = S.local;
  const g = game();
  const cameFromHandThisTurn = L.startHand.includes(t);
  if (target.type === "hand") {
    // only tiles that started in my hand may come back to it
    if (!cameFromHandThisTurn) { SFX.bad(); renderGame(S.st); return; }
    const src = removeTileLocally(t);
    if (src.from === null) return;
    if (!L.hand.includes(t)) L.hand.push(t);
    splitSourceRun(src, null);
  } else if (target.type === "new") {
    const src = removeTileLocally(t);
    if (src.from === null) return;
    const dest = [t];
    L.groups.push(dest);
    splitSourceRun(src, dest);
  } else if (target.type === "group") {
    const grp = L.groups[target.gi];
    if (!grp) return;
    // before your 30-point opening you may only build NEW sets from your
    // own hand — mixing with table groups is always rejected by the server
    if (!game().melded && grp.some((x) => !L.startHand.includes(x))) {
      Hub.toast("open with 30+ from your own hand first — new sets only", "err");
      SFX.bad();
      renderGame(S.st);
      return;
    }
    // insertion index from pointer x among the group's tiles
    const groupEl = target.el;
    const tiles = [...groupEl.querySelectorAll(".tile")];
    let idx = tiles.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.left + r.width / 2 < target.x;
    }).length;
    const selfIdx = grp.indexOf(t);
    const src = removeTileLocally(t);
    if (src.from === null) return;
    if (selfIdx >= 0 && selfIdx < idx) idx--;   // removed from same group
    grp.splice(Math.max(0, Math.min(idx, grp.length)), 0, t);
    splitSourceRun(src, grp);
  }
  S.local.groups = L.groups.filter((grp) => grp.length > 0);
  S.badIdx = [];
  SFX.drop();
  renderGame(S.st);
}

// test driver: exercise the REAL pull-to-new-group path (removeTileLocally +
// splitSourceRun) without the DOM/render, so a borrow can be asserted headless
window.__rk.__test_pullToNew = (groups, hand, tileId) => {
  S.local = { groups: groups.map((g) => [...g]), hand: [...hand],
              startGroups: groups.map((g) => [...g]), startHand: [...hand] };
  const src = removeTileLocally(tileId);
  const dest = [tileId];
  S.local.groups.push(dest);
  splitSourceRun(src, dest);
  S.local.groups = S.local.groups.filter((g) => g.length > 0);
  const out = S.local.groups;
  S.local = null;
  return out;
};

/* ---------------- controls ---------------- */

$("undo-btn").onclick = () => {
  if (!S.local) return;
  S.local.groups = S.local.startGroups.map((x) => [...x]);
  S.local.hand = [...S.local.startHand];
  S.badIdx = [];
  SFX.click();
  renderGame(S.st);
};
let drawArmed = false;
$("draw-btn").onclick = () => {
  if (!myTurn()) return;
  SFX.unlock();
  const movedBoard = S.local &&
    JSON.stringify(S.local.groups) !== JSON.stringify(S.local.startGroups);
  if (movedBoard && !drawArmed) {
    // drawing ends the turn — don't let 40s of arranging vanish on one tap
    drawArmed = true;
    $("draw-btn").textContent = "SURE?";
    Hub.toast("drawing ends your turn and undoes your arranging — tap again if you're sure", "err");
    setTimeout(() => { drawArmed = false; $("draw-btn").textContent = "DRAW"; }, 3000);
    return;
  }
  drawArmed = false;
  $("draw-btn").textContent = "DRAW";
  SFX.click();
  S.conn.send({ t: "draw" });
};
$("end-btn").onclick = () => {
  if (!S.local) return;
  SFX.unlock();
  const why = endTurnBlocker();
  if (why) { Hub.toast(why, "err"); SFX.bad(); return; }
  S.conn.send({ t: "commit", board: S.local.groups.filter((g) => g.length) });
};
$("sort-btn").onclick = () => {
  S.sortMode = S.sortMode === "runs" ? "groups" : "runs";
  localStorage.setItem("rk-sort", S.sortMode);
  SFX.click();
  renderHand();
};
$("rematch-btn").onclick = () => S.conn.send({ t: "again" });

/* brag card */
if (window.Brag) {
  const btn = Brag.button(() => {
    const g = game();
    if (!g || !g.result) return null;
    const rows = g.result.rows;
    const wp = playerByPid(g.result.winner);
    return {
      title: "Rummikub", icon: "🁵",
      winner: { name: wp ? wp.name : "?", avatar: wp ? wp.avatar : "🁵",
                pfp: wp ? wp.pfp : null },
      headline: `${rows[0].total} points`,
      beaten: rows.slice(1).map((r) => {
        const p = playerByPid(r.pid);
        return { name: p ? p.name : "?", score: r.total };
      }),
    };
  });
  document.querySelector("#gameover .modal-card")
    .insertBefore(btn, $("rematch-btn"));
}

/* lobby steppers */
const step = (key, delta, min, max) => {
  const cur = S.st?.settings[key] ?? min;
  S.conn.send({ t: "settings", patch: { [key]: Math.max(min, Math.min(max, cur + delta)) } });
};
$("rounds-minus").onclick = () => step("rounds", -1, 1, 5);
$("rounds-plus").onclick = () => step("rounds", 1, 1, 5);
$("turn-minus").onclick = () => step("turn_seconds", -10, 20, 120);
$("turn-plus").onclick = () => step("turn_seconds", 10, 20, 120);
$("bots-minus").onclick = () => step("bot_players", -1, 0, 4);
$("bots-plus").onclick = () => step("bot_players", 1, 0, 4);
document.querySelectorAll("#skill-seg button").forEach((b) => {
  b.onclick = () => S.conn.send({ t: "settings", patch: { bot_skill: b.dataset.v } });
});

$("ready-btn").onclick = () => {
  SFX.unlock(); SFX.click();
  const me = S.st?.you;
  S.conn.send({ t: "ready", ready: !(me && me.ready) });
};
$("go-btn").onclick = () => { SFX.unlock(); S.conn.send({ t: "start" }); };
$("mute-btn").onclick = () => {
  S.muted = !S.muted;
  localStorage.setItem("wc-muted", S.muted ? "1" : "0");
  $("mute-btn").textContent = S.muted ? "🔇" : "🔊";
};
$("mute-btn").textContent = S.muted ? "🔇" : "🔊";

/* ---------------- timers ---------------- */

let lastTick = -1;
function raf() {
  requestAnimationFrame(raf);
  const st = S.st;
  if (!st) return;
  if (st.phase === "countdown") {
    $("countdown-num").textContent = Math.max(1, Math.ceil(remainMs() / 1000));
  }
  const g = game();
  if (!g) return;
  if (g.stage === "playing") {
    const rem = Math.ceil(remainMs() / 1000);
    const note = $("turn-note");
    if (myTurn()) {
      note.textContent = `YOUR TURN — ${rem}s`;
      if (rem !== lastTick && rem <= 10 && rem > 0) { SFX.tick(); lastTick = rem; }
    } else {
      const p = playerByPid(g.turn);
      if (p) note.textContent = `${p.name} is arranging… ${rem}s`;
    }
  }
  if (g.stage === "round_end") {
    $("sum-next").textContent = `next round in ${Math.ceil(remainMs() / 1000)}s`;
  }
  if (st.phase === "game_end") {
    $("go-auto").textContent = `lobby in ${Math.ceil(remainMs() / 1000)}s`;
  }
}
requestAnimationFrame(raf);

/* ---------------- boot ---------------- */

function connect() {
  S.conn = Hub.connect("/games/rummikub/ws", {
    onWelcome: (m) => {
      S.pid = m.pid;
      // fresh socket = the server may have autopiloted turns while we were
      // gone; drop any stale local snapshot and re-snapshot from fresh state
      S.local = null;
      S.wasMyTurn = false;
    },
    onState, onFx,
  });
}

let avatarPick = Hub.identity.avatar
  || Hub.AVATARS[(Math.random() * Hub.AVATARS.length) | 0];
Hub.buildAvatarGrid($("avatar-grid"), avatarPick, (a) => { avatarPick = a; });
Hub.wirePfpButton($("pfp-btn"), () => S.conn);
Hub.wirePfpButton($("pfp-btn2"), () => S.conn);
$("name-input").value = Hub.identity.name;
$("join-btn").onclick = () => {
  SFX.unlock();
  Hub.identity.name = $("name-input").value.trim() || "PLAYER";
  Hub.identity.avatar = avatarPick;
  S.joined = true;
  connect();
  show("scr-lobby");
};
$("name-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("join-btn").click();
});

if (Hub.identity.name) {
  S.joined = true;
  connect();
  show("scr-lobby");
} else {
  show("scr-join");
}
