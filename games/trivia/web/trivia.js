/* TRIVIA client. The buzz moment is everything: optimistic press state,
   server-ordered truth, dramatic lockouts, snappy reveal beats. */
"use strict";

const $ = (id) => document.getElementById(id);

const S = {
  st: null, pid: null, conn: null, joined: false,
  prevScores: {}, qKey: "", revealKey: "", standKey: "",
  buzzPending: false, optimisticPick: null,
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
    question: () => { tone(392, "sine", 0.14, 0.11); tone(587, "sine", 0.2, 0.11, 0.1); },
    buzz: () => { tone(180, "sawtooth", 0.22, 0.14, 0, -70); tone(120, "square", 0.18, 0.1, 0.02); },
    tooLate: () => tone(240, "sawtooth", 0.14, 0.07, 0, -60),
    correct: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, "sine", 0.22, 0.13, i * 0.07)),
    wrong: () => { tone(220, "sawtooth", 0.2, 0.1, 0, -80); tone(160, "sawtooth", 0.26, 0.09, 0.12, -60); },
    reopen: () => { tone(520, "triangle", 0.08, 0.09); tone(660, "triangle", 0.1, 0.09, 0.09); },
    pick: () => tone(520, "triangle", 0.06, 0.1),
    reveal: () => tone(660, "sine", 0.14, 0.1),
    fanfare: () => [392, 523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, "sine", 0.3, 0.12, i * 0.1)),
    tick: () => tone(1150, "square", 0.03, 0.045),
  };
})();

/* ---------------- helpers ---------------- */
const game = () => S.st?.game || null;
const playerByPid = (pid) => (S.st?.players || []).find((p) => p.pid === pid) || null;
const remainMs = () => S.st?.deadline ? Math.max(0, S.st.deadline - S.conn.now()) : 0;
const iAmIn = () => { const g = game(); return !!(g && g.order.includes(S.pid)); };

function show(id) {
  for (const s of ["scr-join", "scr-lobby", "scr-game"]) $(s).hidden = s !== id;
}

/* ---------------- lobby ---------------- */

const MODE_HINTS = {
  buzzer: "first buzz freezes the room — wrong answers sting (−50)",
  race: "everyone answers at once — faster correct = more points",
};
const DIFF_HINTS = {
  family: "difficulty 1–2, tilted toward the easy stuff",
  all: "the full bank — grown-up questions included",
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

  const seg = $("opt-mode");
  seg.textContent = "";
  for (const [val, label] of [["buzzer", "🚨 BUZZER"], ["race", "🏁 RACE"]]) {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = st.settings.mode === val ? "sel" : "";
    b.onclick = () => { SFX.click(); S.conn.send({ t: "settings", patch: { mode: val } }); };
    seg.appendChild(b);
  }
  $("mode-hint").textContent = MODE_HINTS[st.settings.mode] || "";

  renderCats(st);

  const rSeg = $("opt-rounds");
  rSeg.textContent = "";
  for (const n of [10, 15, 20]) {
    const b = document.createElement("button");
    b.textContent = n;
    b.className = st.settings.rounds === n ? "sel" : "";
    b.onclick = () => { SFX.click(); S.conn.send({ t: "settings", patch: { rounds: n } }); };
    rSeg.appendChild(b);
  }
  const dSeg = $("opt-diff");
  dSeg.textContent = "";
  for (const [val, label] of [["family", "FAMILY"], ["all", "ALL"]]) {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = st.settings.diff === val ? "sel" : "";
    b.onclick = () => { SFX.click(); S.conn.send({ t: "settings", patch: { diff: val } }); };
    dSeg.appendChild(b);
  }
  $("diff-hint").textContent = DIFF_HINTS[st.settings.diff] || "";

  const me = st.you;
  const amReady = !!(me && me.ready);
  $("ready-btn").textContent = amReady ? "READY ✓" : "READY UP";
  $("ready-btn").classList.toggle("is-ready", amReady);
  $("go-btn").hidden = !(readyN >= st.min_players && amReady && st.phase === "lobby");
  $("lobby-hint").textContent =
    st.phase === "countdown" ? "FINGERS ON BUZZERS…"
    : readyN >= 3 ? "full panel — start the show!"
    : readyN >= st.min_players ? "playable at 2 — louder with more"
    : readyN === 1 ? "need one more contestant…"
    : `waiting for players — ${location.host}`;
}

function renderCats(st) {
  const grid = $("cat-grid");
  const sel = st.settings.cat;
  const fam = st.settings.diff === "family";
  const cats = st.cats || [];
  const total = cats.reduce((a, c) => a + (fam ? c.family_count : c.count), 0);
  const selCat = cats.find((c) => c.slug === sel);
  $("cat-count").textContent = sel === "mixed"
    ? `${total} QUESTIONS`
    : selCat ? `${fam ? selCat.family_count : selCat.count} QUESTIONS` : "";
  const key = sel + "|" + (fam ? "f" : "a");
  if (grid.dataset.key === key) return;
  grid.dataset.key = key;
  grid.textContent = "";
  const mk = (slug, icon, title, count) => {
    const b = document.createElement("button");
    b.className = "cat-card" + (slug === sel ? " sel" : "");
    const ic = document.createElement("span"); ic.className = "cc-icon"; ic.textContent = icon;
    const tt = document.createElement("span"); tt.className = "cc-title"; tt.textContent = title;
    const ct = document.createElement("span"); ct.className = "cc-count"; ct.textContent = count;
    b.append(ic, tt, ct);
    b.onclick = () => { SFX.click(); S.conn.send({ t: "settings", patch: { cat: slug } }); };
    grid.appendChild(b);
  };
  mk("mixed", "🎲", "MIXED — EVERYTHING", total);
  for (const c of cats) mk(c.slug, c.icon, c.title.toUpperCase(),
                           fam ? c.family_count : c.count);
}

/* ---------------- score strip ---------------- */

function renderScores(st) {
  const g = game();
  const strip = $("score-strip");
  strip.textContent = "";
  const byScore = [...g.order].sort((a, b) => (g.scores[b] || 0) - (g.scores[a] || 0));
  for (const pid of byScore) {
    const p = playerByPid(pid);
    if (!p) continue;
    const chip = document.createElement("span");
    chip.className = "ss-chip" + (pid === S.pid ? " me" : "")
      + (g.locked.includes(pid) && (g.stage === "question" || g.stage === "answer")
         ? " locked-chip" : "");
    const av = document.createElement("span");
    Hub.fillAvatar(av, p);
    chip.appendChild(av);
    chip.appendChild(document.createTextNode(String(g.scores[pid] || 0)));
    const prev = S.prevScores[pid];
    if (prev !== undefined && g.scores[pid] !== prev) {
      const d = document.createElement("span");
      const diff = g.scores[pid] - prev;
      d.className = "delta" + (diff < 0 ? " neg" : "");
      d.textContent = (diff > 0 ? "+" : "") + diff;
      chip.appendChild(d);
    }
    strip.appendChild(chip);
  }
  S.prevScores = { ...g.scores };
}

/* ---------------- the quiz ---------------- */

function renderQuestion(g) {
  const key = "q" + g.qno;
  $("tv-qchip").textContent = `Q${g.qno}/${g.total}`;
  if (S.qKey !== key && g.q) {
    S.qKey = key;
    S.optimisticPick = null;
    S.buzzPending = false;
    $("q-cat").textContent = `${g.q.icon} ${g.q.cat.toUpperCase()}`;
    $("q-diff").textContent = "★".repeat(g.q.diff);
    const qt = $("q-text");
    qt.textContent = g.q.text;
    qt.classList.toggle("long", g.q.text.length > 90);
    const box = $("choices");
    box.textContent = "";
    const KEYS = ["A", "B", "C", "D"];
    g.q.choices.forEach((c, i) => {
      const b = document.createElement("button");
      b.className = "choice";
      b.dataset.i = i;
      const k = document.createElement("span"); k.className = "ck"; k.textContent = KEYS[i];
      const tx = document.createElement("span"); tx.textContent = c;
      b.append(k, tx);
      b.onclick = () => tapChoice(i);
      box.appendChild(b);
    });
    SFX.question();
  }
}

function canPickNow(g) {
  if (!iAmIn()) return false;
  if (g.mode === "buzzer") return g.stage === "answer" && g.you_buzzed;
  return g.stage === "question" && g.your_pick === null && S.optimisticPick === null;
}

function tapChoice(i) {
  const g = game();
  if (!g || !canPickNow(g)) return;
  SFX.unlock(); SFX.pick();
  S.optimisticPick = i;
  const btn = $("choices").querySelector(`[data-i="${i}"]`);
  if (btn) btn.classList.add("picked");
  S.conn.send({ t: "pick", i });
}

function renderChoices(g) {
  const box = $("choices");
  box.classList.toggle("locked", !canPickNow(g));
  const rv = g.stage === "reveal" ? g.reveal : null;
  const myPick = g.your_pick !== null ? g.your_pick : S.optimisticPick;
  const picksByChoice = {};
  if (rv) for (const d of rv.deltas) {
    if (d.pick !== undefined && d.pick !== null) {
      (picksByChoice[d.pick] = picksByChoice[d.pick] || []).push(d.pid);
    }
  }
  for (const btn of box.children) {
    const i = +btn.dataset.i;
    btn.classList.toggle("picked", !rv && myPick === i);
    btn.classList.toggle("correct", !!rv && rv.correct === i);
    btn.classList.toggle("wrong-pick", !!rv && rv.correct !== i && myPick === i);
    let who = btn.querySelector(".who");
    if (rv && picksByChoice[i] && !who) {
      who = document.createElement("span");
      who.className = "who";
      for (const pid of picksByChoice[i].slice(0, 5)) {
        const av = document.createElement("span");
        Hub.fillAvatar(av, playerByPid(pid));
        who.appendChild(av);
      }
      btn.appendChild(who);
    } else if (!rv && who) who.remove();
  }
}

function renderBanner(g) {
  const banner = $("room-banner");
  if (g.mode === "buzzer" && g.stage === "answer" && g.buzzer) {
    const p = playerByPid(g.buzzer);
    banner.hidden = false;
    banner.classList.toggle("mine", g.you_buzzed);
    Hub.fillAvatar($("rb-avatar"), p);
    $("rb-title").textContent = g.you_buzzed
      ? "YOU BUZZED FIRST!" : `${p ? p.name.toUpperCase() : "?"} BUZZED FIRST`;
    $("rb-sub").textContent = g.you_buzzed
      ? "tap the answer — clock's running" : "everyone else is locked out";
    $("rb-count").hidden = false;
  } else if (g.mode === "race" && g.stage === "question") {
    banner.hidden = false;
    banner.classList.remove("mine");
    $("rb-avatar").textContent = "🏁";
    const n = g.answered.length, total = g.order.length;
    $("rb-title").textContent = g.your_pick !== null || S.optimisticPick !== null
      ? "ANSWER LOCKED IN" : "PICK FAST FOR POINTS";
    $("rb-sub").textContent = `${n}/${total} answered`;
    $("rb-count").hidden = true;
  } else if (g.mode === "buzzer" && g.stage === "question" && g.locked.length) {
    banner.hidden = false;
    banner.classList.remove("mine");
    $("rb-avatar").textContent = "🔁";
    $("rb-title").textContent = g.you_locked ? "YOU'RE LOCKED OUT" : "STEAL IT!";
    $("rb-sub").textContent = `${g.locked.length} locked out — question is live again`;
    $("rb-count").hidden = true;
  } else {
    banner.hidden = true;
  }
}

function renderBuzz(g) {
  const wrap = $("buzz-wrap");
  const showIt = g.mode === "buzzer" && iAmIn()
    && (g.stage === "question" || g.stage === "answer");
  wrap.hidden = !showIt;
  if (!showIt) return;
  const btn = $("buzz-btn");
  const canBuzz = g.stage === "question" && !g.you_locked;
  btn.disabled = !canBuzz;
  btn.classList.toggle("pressed", S.buzzPending && g.stage === "question");
  $("buzz-note").textContent =
    g.you_locked ? "locked out — wait for the reveal"
    : g.stage === "answer" ? (g.you_buzzed ? "answer above! ☝️" : "beaten to the buzz…")
    : "know it? SLAM IT";
}

function renderReveal(g) {
  const strip = $("reveal-strip");
  const showIt = g.stage === "reveal" && g.reveal;
  strip.hidden = !showIt;
  if (!showIt) return;
  const key = "r" + g.qno;
  const rv = g.reveal;
  const myDelta = rv.deltas.filter((d) => d.pid === S.pid)
    .reduce((a, d) => a + d.pts, 0);
  const iScored = myDelta > 0;
  strip.classList.toggle("good", iScored);
  strip.classList.toggle("bad", !iScored && iAmIn());
  if (rv.by) {
    const p = playerByPid(rv.by);
    $("rs-icon").textContent = rv.by === S.pid ? "🎉" : "⚡";
    $("rs-title").textContent = rv.by === S.pid
      ? `YOU TAKE IT +${rv.pts}` : `${p ? p.name.toUpperCase() : "?"} TAKES IT +${rv.pts}`;
  } else if (g.mode === "race") {
    $("rs-icon").textContent = iScored ? "🎉" : "⏱";
    $("rs-title").textContent = iScored ? `CORRECT +${myDelta}`
      : iAmIn() ? "NOT THIS TIME" : "TIME!";
  } else {
    $("rs-icon").textContent = "🤷";
    $("rs-title").textContent = "NOBODY TOOK IT";
  }
  $("rs-sub").textContent = "answer highlighted above";
  if (S.revealKey !== key) {
    S.revealKey = key;
    SFX.reveal();
    if (iScored) { Hub.confettiBurst(90); SFX.correct(); }
  }
}

function renderStandings(g, st) {
  const ov = $("standings-overlay");
  const showIt = g.stage === "standings" && g.standings;
  ov.hidden = !showIt;
  if (!showIt) return;
  const key = "s" + g.qno;
  const rows = $("st-rows");
  rows.textContent = "";
  g.standings.forEach((r, idx) => {
    const p = playerByPid(r.pid);
    const div = document.createElement("div");
    div.className = "st-row" + (r.rank === 1 ? " first" : "");
    div.style.animationDelay = (idx * 70) + "ms";
    const rk = document.createElement("span"); rk.className = "rk"; rk.textContent = r.rank;
    const av = document.createElement("span");
    Hub.fillAvatar(av, p);
    const nm = document.createElement("span");
    nm.textContent = p ? p.name : "?";
    const sc = document.createElement("b");
    sc.textContent = String(r.score);
    div.append(rk, av, nm, sc);
    rows.appendChild(div);
  });
  if (S.standKey !== key) { S.standKey = key; SFX.question(); }
}

function renderGame(st) {
  const g = game();
  if (!g || !g.q) {
    // game_end keeps the last board behind the modal; nothing to draw
    if (g) renderScores(st);
    return;
  }
  renderScores(st);
  renderQuestion(g);
  renderChoices(g);
  renderBanner(g);
  renderBuzz(g);
  renderReveal(g);
  renderStandings(g, st);
  $("quiz-zone").hidden = false;
  $("watch-note").hidden = iAmIn();
}

/* ---------------- game over ---------------- */

let goShown = false;
function renderGameOver(st) {
  const g = game();
  const showIt = st.phase === "game_end" && g && g.result;
  $("gameover").hidden = !showIt;
  if (!showIt) { goShown = false; return; }
  $("reveal-strip").hidden = true;
  $("standings-overlay").hidden = true;
  const res = g.result;
  const w = playerByPid(res.winner);
  $("go-title").textContent = w ? `${w.name.toUpperCase()} WINS` : "GAME OVER";
  const pod = $("podium");
  pod.textContent = "";
  const top = res.rows.slice(0, 3);
  const slots = [top[1], top[0], top[2]];       // 2nd, 1st, 3rd
  const cls = ["p2", "p1", "p3"];
  const medal = ["🥈", "🥇", "🥉"];
  slots.forEach((r, i) => {
    if (!r) return;
    const p = playerByPid(r.pid);
    const div = document.createElement("div");
    div.className = "pod " + cls[i];
    const av = document.createElement("div"); av.className = "pd-av";
    Hub.fillAvatar(av, p);
    const nm = document.createElement("div"); nm.className = "pd-name";
    nm.textContent = p ? p.name : "?";
    const sc = document.createElement("div"); sc.className = "pd-score";
    sc.textContent = r.score + " pts";
    const blk = document.createElement("div"); blk.className = "pd-block";
    blk.textContent = medal[i];
    div.append(av, nm, sc, blk);
    pod.appendChild(div);
  });
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
  if (!goShown) {
    goShown = true;
    if (res.winner === S.pid) Hub.confettiBurst(220);
    SFX.fanfare();
  }
}

/* ---------------- state & fx ---------------- */

function onState(st) {
  S.st = st;
  if (!S.joined) return;
  if (st.phase === "lobby" || st.phase === "countdown") {
    show("scr-lobby");
    $("reveal-strip").hidden = true;
    $("standings-overlay").hidden = true;
    S.prevScores = {};
    S.qKey = "";
    S.revealKey = "";
    S.standKey = "";
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
    case "invalid": Hub.toast(fx.msg, "err"); SFX.tooLate(); break;
    case "question": break;                      // sound fires on render key
    case "buzz": {
      SFX.buzz();
      if (fx.pid === S.pid) {
        try { navigator.vibrate && navigator.vibrate(60); } catch (e) {}
      }
      S.buzzPending = false;
      break;
    }
    case "too_late":
      S.buzzPending = false;
      SFX.tooLate();
      Hub.toast("⚡ beaten to the buzz!");
      break;
    case "wrong": {
      SFX.wrong();
      const p = playerByPid(fx.pid);
      if (fx.pid === S.pid) {
        try { navigator.vibrate && navigator.vibrate([50, 40, 90]); } catch (e) {}
        Hub.toast(fx.timeout ? "⏱ too slow — locked out −50" : "❌ wrong — locked out −50", "err");
      } else if (p) {
        Hub.toast(`${p.name} ${fx.timeout ? "froze" : "missed"} −50`);
      }
      break;
    }
    case "reopen": SFX.reopen(); break;
    case "correct": if (fx.pid !== S.pid) SFX.correct(); break;
    case "picked": break;
    case "race_pick": if (fx.pid !== S.pid) SFX.click(); break;
    case "reveal": break;                        // strip handles it
    case "standings": break;
    case "game_over": break;
    case "countdown": SFX.question(); break;
  }
}

/* ---------------- the buzz — pointerdown for zero-latency feel -------- */

$("buzz-btn").addEventListener("pointerdown", (e) => {
  e.preventDefault();
  const g = game();
  if (!g || g.mode !== "buzzer" || g.stage !== "question"
      || g.you_locked || !iAmIn() || S.buzzPending) return;
  SFX.unlock();
  S.buzzPending = true;                          // optimistic press
  $("buzz-btn").classList.add("pressed");
  S.conn.send({ t: "buzz" });
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
  const setClock = (remMs, totalMs) => {
    const frac = Math.min(1, Math.max(0, remMs / totalMs));
    $("tv-timer-fill").style.transform = `scaleX(${frac})`;
    const sec = Math.ceil(remMs / 1000);
    $("tv-clock").textContent =
      `0:${String(Math.max(0, sec)).padStart(2, "0")}`;
    const low = remMs < 5500 && remMs > 0;
    $("tv-clock").classList.toggle("low", low);
    document.querySelector(".tv-timer").classList.toggle("low", low);
    if (sec !== lastTick && sec <= 5 && sec > 0
        && (g.stage === "question" || g.stage === "answer")) {
      SFX.tick(); lastTick = sec;
    }
  };
  if (g.stage === "question") {
    const total = (g.mode === "race" ? g.race_seconds : g.question_seconds) * 1000;
    setClock(remainMs(), total);
  } else if (g.stage === "answer") {
    // master question clock keeps draining in the header…
    const masterRem = g.q_deadline ? Math.max(0, g.q_deadline - S.conn.now()) : 0;
    setClock(masterRem, g.question_seconds * 1000);
    // …while the 6s answer window counts down in the banner
    $("rb-count").textContent = Math.max(0, Math.ceil(remainMs() / 1000));
  }
  if (g.stage === "standings") {
    $("st-next").textContent = `next question in ${Math.ceil(remainMs() / 1000)}s`;
  }
  if (st.phase === "game_end") {
    $("go-auto").textContent = `lobby in ${Math.ceil(remainMs() / 1000)}s`;
  }
}
requestAnimationFrame(raf);

/* ---------------- boot & wiring ---------------- */

function connect() {
  S.conn = Hub.connect("/games/trivia/ws", {
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
    if (!g || !g.result) return null;
    const rows = g.result.rows;
    const wp = playerByPid(g.result.winner);
    const wRow = rows.find((r) => r.pid === g.result.winner);
    return {
      title: "Trivia", icon: "🚨",
      winner: { name: wp ? wp.name : "?", avatar: wp ? wp.avatar : "🚨",
                pfp: wp ? wp.pfp : null },
      headline: `${wRow ? wRow.score : 0} points · ${g.mode === "race" ? "RACE" : "BUZZER"} · ${g.total} questions`,
      beaten: rows.filter((r) => r.pid !== g.result.winner).slice(0, 4)
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

/* dev/test hook — lets the playtest pin the hidden 4-question match */
window.TRIVIA_DEV = { send: (m) => { if (S.conn) S.conn.send(m); } };
