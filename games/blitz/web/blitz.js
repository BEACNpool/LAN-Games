/* CATEGORY BLITZ client. The phone is a secret answer pad.
   UX rule #1: the answer input is never re-rendered and never loses focus.
   Answers are coalesced client-side (outbox flush ≤ every 160ms) so a
   machine-gunning typist can never trip the server's rate limit. */
"use strict";

const $ = (id) => document.getElementById(id);

const S = {
  st: null, pid: null, conn: null, joined: false,
  pending: [],            // [{text, key}] optimistic chips awaiting server echo
  prevScores: {}, introKey: "", revealKey: "", blitzKey: "",
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
    click: () => tone(700, "square", 0.04, 0.05),
    send: () => tone(560, "triangle", 0.05, 0.1),
    dupe: () => tone(190, "sawtooth", 0.16, 0.08, 0, -50),
    blip: () => tone(300, "triangle", 0.04, 0.04),
    go: () => { tone(392, "sine", 0.14, 0.12); tone(587, "sine", 0.2, 0.12, 0.1); },
    cancel: () => tone(240, "sawtooth", 0.18, 0.08, 0, -90),
    ding: () => { tone(784, "sine", 0.16, 0.11); tone(1175, "sine", 0.2, 0.09, 0.06); },
    fanfare: () => [392, 523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, "sine", 0.3, 0.12, i * 0.1)),
    tick: () => tone(1150, "square", 0.03, 0.045),
    buzz: () => tone(150, "sawtooth", 0.2, 0.08, 0, -60),
  };
})();

/* ---------------- normalizer (mirror of the server's, for instant
   own-dupe feedback; the server stays authoritative) ---------------- */

const KEEP_S = new Set(["news", "lens", "series", "species", "chess", "glass",
  "physics", "mathematics", "gymnastics", "texas", "paris", "swiss", "dallas"]);

function singLite(w) {
  if (w.length > 3 && !KEEP_S.has(w) && !/(ss|us|is)$/.test(w)) {
    if (/ies$/.test(w) && w.length >= 5) w = w.slice(0, -1);
    else if (/(sses|ches|shes|xes|zes)$/.test(w) && w.length >= 4) w = w.slice(0, -2);
    else if (/s$/.test(w)) w = w.slice(0, -1);
  }
  if (w.length >= 3 && /y$/.test(w) && !/[aeiou]y$/.test(w)) w = w.slice(0, -1) + "ie";
  return w;
}

function normLite(s) {
  s = String(s).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/['’]/g, "").replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ").trim();
  const w = s.split(" ").filter(Boolean);
  while (w.length && ["a", "an", "the"].includes(w[0])) w.shift();
  if (!w.length) return "";
  w[w.length - 1] = singLite(w[w.length - 1]);
  return w.join(" ");
}

/* ---------------- helpers ---------------- */
const game = () => S.st?.game || null;
const playerByPid = (pid) => (S.st?.players || []).find((p) => p.pid === pid) || null;
const remainMs = () => S.st?.deadline ? Math.max(0, S.st.deadline - S.conn.now()) : 0;
const inGame = () => { const g = game(); return g && g.order.includes(S.pid); };

function show(id) {
  for (const s of ["scr-join", "scr-lobby", "scr-game"]) $(s).hidden = s !== id;
}

/* ---------------- the outbox (rate-limit-proof submit) ---------------- */

const outbox = [];
let lastFlush = 0, flushTimer = null;

function flushOutbox() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!outbox.length) return;
  lastFlush = Date.now();
  S.conn.send({ t: "answer", texts: outbox.splice(0, 6) });
  if (outbox.length) flushTimer = setTimeout(flushOutbox, 160);
}

function queueAnswer(text) {
  outbox.push(text);
  const since = Date.now() - lastFlush;
  if (since >= 160) flushOutbox();
  else if (!flushTimer) flushTimer = setTimeout(flushOutbox, 160 - since);
}

/* ---------------- lobby ---------------- */

const SPICE_HINTS = {
  family: "family mix — the tough ones show up rarely",
  wild: "wild — every category is fair game",
};

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

  renderDecks(st);
  renderSeg("opt-rounds", [[5, "5"], [8, "8"], [12, "12"]],
    st.settings.rounds, (v) => ({ rounds: v }));
  renderSeg("opt-seconds", [[30, "30S"], [45, "45S"], [60, "60S"]],
    st.settings.seconds, (v) => ({ seconds: v }));
  renderSeg("opt-spice", [["family", "FAMILY"], ["wild", "WILD"]],
    st.settings.spice, (v) => ({ spice: v }));
  $("spice-hint").textContent = SPICE_HINTS[st.settings.spice] || "";

  const me = st.you;
  const amReady = !!(me && me.ready);
  $("ready-btn").textContent = amReady ? "READY ✓" : "READY UP";
  $("ready-btn").classList.toggle("is-ready", amReady);
  $("go-btn").hidden = !(readyN >= st.min_players && amReady && st.phase === "lobby");
  $("lobby-hint").textContent =
    st.phase === "countdown" ? "FINGERS ON KEYBOARDS…"
    : readyN >= 4 ? "full table — flip the timer!"
    : readyN >= st.min_players ? "playable at 2 — chaos at 4+"
    : readyN === 1 ? "need one more human…"
    : `waiting for players — ${location.host}`;
}

function renderSeg(hostId, options, current, patchOf) {
  const seg = $(hostId);
  seg.textContent = "";
  for (const [val, label] of options) {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = current === val ? "sel" : "";
    b.onclick = () => { SFX.click(); S.conn.send({ t: "settings", patch: patchOf(val) }); };
    seg.appendChild(b);
  }
}

function renderDecks(st) {
  const grid = $("deck-grid");
  const sel = st.settings.decks || [];
  const decks = st.decks || [];
  const armed = decks.filter((d) => sel.includes(d.slug))
    .reduce((n, d) => n + d.count, 0);
  $("deck-count").textContent = `${armed} CATEGORIES ARMED`;
  const sig = sel.join(",");
  if (grid.dataset.sig === sig && grid.childElementCount) return;
  grid.dataset.sig = sig;
  grid.textContent = "";
  for (const d of decks) {
    const on = sel.includes(d.slug);
    const b = document.createElement("button");
    b.className = "bz-deck " + (on ? "on" : "off");
    const top = document.createElement("div"); top.className = "dk-top";
    const ic = document.createElement("span"); ic.className = "dk-icon"; ic.textContent = d.icon;
    const tt = document.createElement("span"); tt.className = "dk-title"; tt.textContent = d.title;
    const ct = document.createElement("span"); ct.className = "dk-count"; ct.textContent = d.count;
    top.append(ic, tt, ct);
    const bl = document.createElement("div"); bl.className = "dk-blurb"; bl.textContent = d.blurb;
    const ck = document.createElement("span"); ck.className = "dk-check"; ck.textContent = "✅";
    b.append(top, bl, ck);
    b.onclick = () => {
      SFX.click();
      const next = on ? sel.filter((s) => s !== d.slug) : [...sel, d.slug];
      if (!next.length) { Hub.toast("keep at least one deck", "err"); return; }
      S.conn.send({ t: "settings", patch: { decks: next } });
    };
    grid.appendChild(b);
  }
}

/* ---------------- game rendering ---------------- */

function catFontSize(text) {
  const n = (text || "").length;
  if (n <= 14) return 30;
  if (n <= 24) return 26;
  if (n <= 34) return 22;
  return 19;
}

function renderScores(st) {
  const g = game();
  const strip = $("score-strip");
  strip.textContent = "";
  const byScore = [...g.order].sort((a, b) => (g.scores[b] || 0) - (g.scores[a] || 0));
  for (const pid of byScore) {
    const p = playerByPid(pid);
    if (!p) continue;
    const chip = document.createElement("span");
    chip.className = "ss-chip";
    chip.dataset.pid = pid;
    const av = document.createElement("span");
    Hub.fillAvatar(av, p);
    chip.appendChild(av);
    chip.appendChild(document.createTextNode(String(g.scores[pid] || 0)));
    if (g.stage === "blitz" || g.stage === "intro") {
      const c = document.createElement("span");
      c.className = "cnt";
      c.textContent = ` ✎${(g.counts && g.counts[pid]) || 0}`;
      chip.appendChild(c);
    }
    const prev = S.prevScores[pid];
    if (prev !== undefined && g.scores[pid] > prev) {
      const d = document.createElement("span");
      d.className = "delta";
      d.textContent = "+" + (g.scores[pid] - prev);
      chip.appendChild(d);
    }
    strip.appendChild(chip);
  }
  S.prevScores = { ...g.scores };
}

function renderChips(g) {
  const host = $("chips");
  host.textContent = "";
  const mine = g.mine || [];
  const mineKeys = new Set(mine.map((t) => normLite(t)));
  S.pending = S.pending.filter((p) => !mineKeys.has(p.key));
  const mk = (text, pending) => {
    const chip = document.createElement("span");
    chip.className = "chip" + (pending ? " pending" : "");
    chip.dataset.key = normLite(text);
    const tx = document.createElement("span"); tx.textContent = text;
    chip.appendChild(tx);
    if (!pending && g.stage === "blitz") {
      const x = document.createElement("button");
      x.type = "button"; x.className = "cx-btn"; x.textContent = "✕";
      x.onclick = () => {
        SFX.blip();
        S.conn.send({ t: "retract", text });
        chip.remove();
        $("answer-input").focus();
      };
      chip.appendChild(x);
    }
    host.appendChild(chip);
  };
  for (const t of mine) mk(t, false);
  for (const p of S.pending) mk(p.text, true);
  host.scrollTop = host.scrollHeight;
}

function renderGame(st) {
  const g = game();
  if (!g) return;
  $("bz-roundchip").textContent = `R${g.round_no}/${g.rounds}`;
  renderScores(st);

  const live = g.stage === "intro" || g.stage === "blitz";
  const me = inGame();

  // category banner
  if (live && g.cat) {
    $("cb-deck").textContent = g.deck || "";
    const cb = $("cb-cat");
    cb.textContent = g.cat;
    cb.style.fontSize = catFontSize(g.cat) + "px";
  }
  document.querySelector(".cat-banner").hidden = !live;
  $("play-zone").hidden = !(live && me);
  $("watch-note").hidden = me || !live;

  // the sacred answer bar: toggle visibility/enabled only, never rebuild
  $("answer-form").hidden = !(live && me);
  const canType = g.stage === "blitz" && me;
  $("answer-input").disabled = !canType;
  $("answer-send").disabled = !canType;
  $("answer-input").placeholder = canType ? "name one…" : "get ready…";

  if (live && me) renderChips(g);

  // intro overlay
  const showIntro = g.stage === "intro";
  $("intro-overlay").hidden = !showIntro;
  if (showIntro) {
    const key = "i" + g.round_no;
    $("io-round").textContent = `ROUND ${g.round_no} OF ${g.rounds}`;
    $("io-deck").textContent = g.deck || "";
    $("io-cat").textContent = g.cat || "";
    if (S.introKey !== key) {
      S.introKey = key;
      S.pending = [];
      $("answer-input").value = "";
      SFX.go();
      try { navigator.vibrate && navigator.vibrate(60); } catch (e) {}
    }
  }

  // blitz start: lock focus the moment the sand flips
  if (g.stage === "blitz" && S.blitzKey !== "b" + g.round_no) {
    S.blitzKey = "b" + g.round_no;
    if (me) setTimeout(() => $("answer-input").focus(), 30);
  }

  // reveal overlay
  const showReveal = g.stage === "reveal" && g.reveal;
  $("reveal-overlay").hidden = !showReveal;
  if (showReveal) {
    const key = "r" + g.round_no;
    if (S.revealKey !== key) {
      S.revealKey = key;
      buildReveal(g);
    }
    updateTapBtn(g);
  }
}

/* group colors: same hue = same matched answer across players */
const GROUP_COLORS = ["#fb7185", "#22d3ee", "#a78bfa", "#f59e0b",
                      "#34d399", "#f472b6", "#60a5fa", "#c084fc"];

function buildReveal(g) {
  const rv = g.reveal;
  $("rv-cat").textContent = rv.cat;
  $("rv-eyebrow").textContent = rv.last_round
    ? "LAST ROUND! THE CATEGORY WAS" : "TIME! THE CATEGORY WAS";
  const grid = $("rv-grid");
  grid.textContent = "";
  const cancelMs = (i) => 350 + i * 320;
  const cancelEnd = cancelMs(Math.max(0, rv.groups - 1)) + 500;
  let uq = 0;

  for (const row of rv.rows) {
    const p = playerByPid(row.pid);
    const card = document.createElement("div");
    card.className = "rv-card";
    const who = document.createElement("div"); who.className = "rv-who";
    const av = document.createElement("span"); av.className = "rw-av";
    Hub.fillAvatar(av, p);
    const nm = document.createElement("span"); nm.className = "rw-name";
    nm.textContent = (p ? p.name : "?") + (row.pid === S.pid ? " (you)" : "");
    const gain = document.createElement("span");
    gain.className = "rw-gain" + (row.gain ? "" : " zero");
    gain.textContent = row.gain ? `+${row.gain}` : "+0";
    gain.style.animationDelay = cancelEnd + 250 + "ms";
    who.append(av, nm, gain);
    card.appendChild(who);

    const list = document.createElement("div"); list.className = "rv-answers";
    if (!row.answers.length) {
      const none = document.createElement("span");
      none.className = "rv-none";
      none.textContent = "…nothing. the pressure got them.";
      list.appendChild(none);
    }
    for (const a of row.answers) {
      const chip = document.createElement("span");
      chip.className = "rv-chip";
      chip.dataset.owner = row.pid;
      const tx = document.createElement("span");
      tx.className = "rc-text"; tx.textContent = a.text;
      chip.appendChild(tx);
      if (a.group !== null && a.group !== undefined) {
        chip.classList.add("cx");
        chip.style.setProperty("--gc", GROUP_COLORS[a.group % GROUP_COLORS.length]);
        chip.style.animationDelay = cancelMs(a.group) + "ms";
        const w = document.createElement("span");
        w.className = "rc-with";
        const names = a.with.map((pd) => (playerByPid(pd)?.name || "?")).join(" & ");
        w.textContent = `✕ matched ${names}`;
        chip.appendChild(w);
      } else {
        chip.classList.add("uq");
        chip.style.animationDelay = cancelEnd + (uq++ % 10) * 90 + "ms";
        const pts = document.createElement("span");
        pts.className = "rc-pts"; pts.textContent = "+10";
        chip.appendChild(pts);
      }
      // long-press someone else's answer to call BS (theater only)
      if (row.pid !== S.pid) wireBS(chip, row.pid, a.text);
      list.appendChild(chip);
    }
    card.appendChild(list);
    grid.appendChild(card);
  }
  if (rv.groups > 0) setTimeout(() => SFX.cancel(), 380);
  setTimeout(() => SFX.ding(), Math.min(cancelEnd, 4000));
}

function wireBS(chip, pid, text) {
  let timer = null;
  const start = (e) => {
    timer = setTimeout(() => {
      timer = null;
      S.conn.send({ t: "bs", target: pid, text });
      try { navigator.vibrate && navigator.vibrate(80); } catch (err) {}
    }, 550);
  };
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  chip.addEventListener("pointerdown", start);
  chip.addEventListener("pointerup", cancel);
  chip.addEventListener("pointerleave", cancel);
  chip.addEventListener("contextmenu", (e) => e.preventDefault());
}

function updateTapBtn(g) {
  const t = g.taps || { done: 0, need: 0, tapped: [] };
  const meTapped = t.tapped.includes(S.pid);
  const btn = $("tap-btn");
  btn.disabled = meTapped || !inGame();
  btn.textContent = !inGame() ? `WAITING · ${t.done}/${t.need}`
    : meTapped ? `WAITING FOR THE OTHERS · ${t.done}/${t.need}`
    : `TAP WHEN DONE · ${t.done}/${t.need}`;
}

/* ---------------- game over ---------------- */

let goShown = false;
function renderGameOver(st) {
  const g = game();
  const showIt = st.phase === "game_end" && g && g.result;
  $("gameover").hidden = !showIt;
  if (!showIt) { goShown = false; return; }
  $("intro-overlay").hidden = true;
  $("reveal-overlay").hidden = true;
  $("answer-form").hidden = true;
  const res = g.result;
  const w = playerByPid(res.winner);
  $("go-title").textContent = w ? `${w.name.toUpperCase()} WINS` : "GAME OVER";

  const pod = $("podium");
  pod.textContent = "";
  const medals = ["🥇", "🥈", "🥉"];
  const slots = [1, 0, 2];                    // 2nd, 1st, 3rd visual order
  for (const idx of slots) {
    const r = res.rows[idx];
    if (!r) continue;
    const p = playerByPid(r.pid);
    const div = document.createElement("div");
    div.className = "pod p" + (idx + 1);
    const av = document.createElement("span"); av.className = "pd-av";
    Hub.fillAvatar(av, p);
    const nm = document.createElement("span"); nm.className = "pd-name";
    nm.textContent = p ? p.name : "?";
    const sc = document.createElement("span"); sc.className = "pd-score";
    sc.textContent = r.score + " pts";
    const blk = document.createElement("div"); blk.className = "pd-block";
    blk.textContent = medals[idx];
    div.append(av, nm, sc, blk);
    pod.appendChild(div);
  }

  const rows = $("go-rows");
  rows.textContent = "";
  for (const r of res.rows) {
    const p = playerByPid(r.pid);
    const div = document.createElement("div");
    div.className = "go-row" + (r.rank === 1 ? " first" : "");
    const av = document.createElement("span");
    Hub.fillAvatar(av, p);
    const nm = document.createElement("span");
    nm.textContent = `${r.rank}. ${p ? p.name : "?"}`;
    const sc = document.createElement("b");
    sc.textContent = String(r.score);
    div.append(av, nm, sc);
    rows.appendChild(div);
  }

  const best = res.best;
  $("go-best").hidden = !best;
  if (best) {
    const p = playerByPid(best.pid);
    $("go-best").textContent =
      `🔥 BEST ROUND · ${p ? p.name : "?"} +${best.pts} on “${best.cat}” (R${best.round})`;
  }
  if (!goShown) {
    goShown = true;
    Hub.confettiBurst(200);
    SFX.fanfare();
  }
}

/* ---------------- state & fx ---------------- */

function onState(st) {
  S.st = st;
  if (!S.joined) return;
  if (st.phase === "lobby" || st.phase === "countdown") {
    show("scr-lobby");
    $("intro-overlay").hidden = true;
    $("reveal-overlay").hidden = true;
    $("answer-form").hidden = true;
    S.prevScores = {};
    S.pending = [];
    renderLobby(st);
  } else if (st.game) {
    show("scr-game");
    renderGame(st);
  }
  renderGameOver(st);
  $("countdown-overlay").hidden = st.phase !== "countdown";
}

function onFx(fx) {
  switch (fx.kind) {
    case "toast": Hub.toast((fx.icon ? fx.icon + " " : "") + fx.msg); break;
    case "invalid": Hub.toast(fx.msg, "err"); SFX.buzz(); break;
    case "answered": SFX.send(); break;
    case "retracted": break;
    case "dupe": {
      SFX.dupe();
      const chip = [...document.querySelectorAll("#chips .chip")]
        .find((c) => c.dataset.key === normLite(fx.text));
      if (chip) {
        chip.classList.remove("flash");
        void chip.offsetWidth;
        chip.classList.add("flash");
      }
      S.pending = S.pending.filter((p) => p.key !== normLite(fx.text));
      dupePop();
      break;
    }
    case "typed": {
      if (fx.pid === S.pid) break;
      const chip = document.querySelector(`#score-strip .ss-chip[data-pid="${fx.pid}"]`);
      if (chip) {
        chip.classList.remove("pulse");
        void chip.offsetWidth;
        chip.classList.add("pulse");
      }
      break;
    }
    case "round_intro": break;                 // overlay handled by state
    case "blitz_start": SFX.go(); break;
    case "reveal": break;                      // sounds staged in buildReveal
    case "tapped": SFX.blip(); break;
    case "bs": {
      const by = playerByPid(fx.by), tg = playerByPid(fx.target);
      Hub.toast(`🚨 ${by ? by.name : "?"} calls BS on ${tg ? tg.name : "?"}` +
                (fx.text ? ` — “${fx.text}”` : ""));
      SFX.buzz();
      const chip = [...document.querySelectorAll(`#rv-grid .rv-chip[data-owner="${fx.target}"]`)]
        .find((c) => c.querySelector(".rc-text")?.textContent === fx.text);
      if (chip) {
        chip.classList.remove("wobble");
        void chip.offsetWidth;
        chip.classList.add("wobble");
      }
      break;
    }
    case "game_over": break;
    case "countdown": SFX.go(); break;
  }
}

let dupeTimer = null;
function dupePop() {
  $("dupe-pop").hidden = false;
  clearTimeout(dupeTimer);
  dupeTimer = setTimeout(() => { $("dupe-pop").hidden = true; }, 1200);
}

/* ---------------- the answer bar (never re-rendered) ---------------- */

$("answer-form").addEventListener("submit", (e) => {
  e.preventDefault();
  SFX.unlock();
  const input = $("answer-input");
  const text = input.value.trim().replace(/\s+/g, " ");
  input.value = "";
  input.focus();                    // keyboard stays up, always
  const g = game();
  if (!text || !g || g.stage !== "blitz" || !inGame()) return;
  const key = normLite(text);
  if (!key) return;
  const known = new Set([...(g.mine || []).map(normLite),
                         ...S.pending.map((p) => p.key)]);
  if (known.has(key)) { SFX.dupe(); dupePop(); return; }
  S.pending.push({ text, key });
  renderChips(g);
  SFX.send();
  queueAnswer(text);
});

$("tap-btn").addEventListener("click", () => {
  SFX.unlock(); SFX.click();
  S.conn.send({ t: "tap" });
});

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
  if (g.stage === "blitz") {
    const rem = remainMs();
    const frac = Math.min(1, rem / (g.seconds * 1000));
    $("sand-fill").style.transform = `scaleX(${frac})`;
    $("bz-clock").textContent =
      `${(Math.ceil(rem / 1000) / 60) | 0}:${String(Math.ceil(rem / 1000) % 60).padStart(2, "0")}`;
    const low = rem < 10500 && rem > 0;
    $("bz-clock").classList.toggle("low", low);
    document.querySelector(".sand-track").classList.toggle("low", low);
    const sec = Math.ceil(rem / 1000);
    if (sec !== lastTick && sec <= 5 && sec > 0) { SFX.tick(); lastTick = sec; }
  } else if (g.stage === "intro") {
    $("sand-fill").style.transform = "scaleX(1)";
    $("bz-clock").textContent = `0:${String(g.seconds).padStart(2, "0")}`;
  }
  if (g.stage === "reveal") {
    $("rv-auto").textContent = `auto-continue in ${Math.ceil(remainMs() / 1000)}s`;
  }
  if (st.phase === "game_end") {
    $("go-auto").textContent = `lobby in ${Math.ceil(remainMs() / 1000)}s`;
  }
}
requestAnimationFrame(raf);

/* ---------------- boot & wiring ---------------- */

function connect() {
  S.conn = Hub.connect("/games/blitz/ws", {
    onWelcome: (m) => { S.pid = m.pid; },
    onState, onFx,
  });
}

$("ready-btn").onclick = () => {
  SFX.unlock(); SFX.click();
  const me = S.st?.you;
  S.conn.send({ t: "ready", ready: !(me && me.ready) });
};
$("go-btn").onclick = () => { SFX.unlock(); S.conn.send({ t: "start" }); };
$("rematch-btn").onclick = () => S.conn.send({ t: "again" });

/* brag card */
if (window.Brag) {
  const btn = Brag.button(() => {
    const g = game();
    if (!g || !g.result || !g.result.winner) return null;
    const res = g.result;
    const wp = playerByPid(res.winner);
    const wRow = res.rows.find((r) => r.pid === res.winner);
    const best = res.best && res.best.pid === res.winner
      ? ` · best round +${res.best.pts}` : "";
    return {
      title: "Category Blitz", icon: "🧠",
      winner: { name: wp ? wp.name : "?", avatar: wp ? wp.avatar : "🧠",
                pfp: wp ? wp.pfp : null },
      headline: `${wRow ? wRow.score : 0} points · ${g.rounds} rounds${best}`,
      beaten: res.rows.filter((r) => r.pid !== res.winner).slice(0, 4)
        .map((r) => {
          const p = playerByPid(r.pid);
          return { name: p ? p.name : "?", score: r.score };
        }),
    };
  });
  document.querySelector("#gameover .modal-card")
    .insertBefore(btn, $("rematch-btn"));
}

$("mute-btn").onclick = () => {
  S.muted = !S.muted;
  localStorage.setItem("wc-muted", S.muted ? "1" : "0");
  $("mute-btn").textContent = S.muted ? "🔇" : "🔊";
};
$("mute-btn").textContent = S.muted ? "🔇" : "🔊";

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
