/* CHARADES client. The phone is a secret card + a buzzer.
   UX rule #1: the guess input is never re-rendered and never loses focus —
   fast thumbs win games. */
"use strict";

const $ = (id) => document.getElementById(id);

const S = {
  st: null, pid: null, conn: null, joined: false,
  decks: [], prevScores: {}, introKey: "", revealKey: "",
  lastSent: "", lastSentAt: 0,
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
    send: () => tone(520, "triangle", 0.06, 0.1),
    blip: () => tone(300, "triangle", 0.04, 0.04),
    close: () => { tone(660, "sine", 0.09, 0.12); tone(520, "sine", 0.12, 0.1, 0.07); },
    solved: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, "sine", 0.22, 0.13, i * 0.08)),
    fanfare: () => [392, 523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, "sine", 0.3, 0.12, i * 0.1)),
    intro: () => { tone(392, "sine", 0.18, 0.12); tone(587, "sine", 0.24, 0.12, 0.12); },
    skip: () => tone(360, "sawtooth", 0.12, 0.07, 0, -80),
    tick: () => tone(1150, "square", 0.03, 0.045),
    buzz: () => tone(150, "sawtooth", 0.2, 0.08, 0, -60),
  };
})();

/* ---------------- helpers ---------------- */
const game = () => S.st?.game || null;
const playerByPid = (pid) => (S.st?.players || []).find((p) => p.pid === pid) || null;
const remainMs = () => S.st?.deadline ? Math.max(0, S.st.deadline - S.conn.now()) : 0;
const iAmGuesser = () => {
  const g = game();
  return g && g.stage === "acting" && !g.you_act
      && g.order.includes(S.pid);
};

function show(id) {
  for (const s of ["scr-join", "scr-lobby", "scr-game"]) $(s).hidden = s !== id;
}

/* ---------------- lobby ---------------- */

const MODE_HINTS = {
  classic: "one subject per turn — first correct guess takes it",
  blitz: "chain as many subjects as the clock allows",
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
  const seg = $("opt-mode");
  seg.textContent = "";
  for (const [val, label] of [["classic", "CLASSIC"], ["blitz", "BLITZ"]]) {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = st.settings.mode === val ? "sel" : "";
    b.onclick = () => { SFX.click(); S.conn.send({ t: "settings", patch: { mode: val } }); };
    seg.appendChild(b);
  }
  $("mode-hint").textContent = MODE_HINTS[st.settings.mode] || "";
  $("turn-val").textContent = st.settings.turn_seconds + "s";
  $("rounds-val").textContent = st.settings.rounds;

  const me = st.you;
  const amReady = !!(me && me.ready);
  $("ready-btn").textContent = amReady ? "READY ✓" : "READY UP";
  $("ready-btn").classList.toggle("is-ready", amReady);
  $("go-btn").hidden = !(readyN >= st.min_players && amReady && st.phase === "lobby");
  $("lobby-hint").textContent =
    st.phase === "countdown" ? "PLACES, EVERYONE…"
    : readyN >= 3 ? "full room — curtain up!"
    : readyN >= st.min_players ? "playable at 2 — better with 3+"
    : readyN === 1 ? "need one more human…"
    : `waiting for players — ${location.host}`;
}

function renderDecks(st) {
  const grid = $("deck-grid");
  const sel = st.settings.deck;
  const selDeck = S.decks.find((d) => d.slug === sel);
  $("deck-count").textContent = selDeck ? `${selDeck.count} SUBJECTS` : "";
  if (grid.dataset.built && grid.dataset.sel === sel) return;
  grid.dataset.built = "1";
  grid.dataset.sel = sel;
  grid.textContent = "";
  for (const d of S.decks) {
    const b = document.createElement("button");
    b.className = "deck-card" + (d.slug === sel ? " sel" : "");
    const top = document.createElement("div"); top.className = "dc-top";
    const ic = document.createElement("span"); ic.className = "dc-icon"; ic.textContent = d.icon;
    const tt = document.createElement("span"); tt.className = "dc-title"; tt.textContent = d.title;
    const ct = document.createElement("span"); ct.className = "dc-count"; ct.textContent = d.count;
    top.append(ic, tt, ct);
    const bl = document.createElement("div"); bl.className = "dc-blurb"; bl.textContent = d.blurb;
    const df = document.createElement("span"); df.className = "dc-diff " + d.difficulty;
    df.textContent = d.difficulty.toUpperCase();
    b.append(top, bl, df);
    b.onclick = () => { SFX.click(); S.conn.send({ t: "settings", patch: { deck: d.slug } }); };
    grid.appendChild(b);
  }
}

/* ---------------- game rendering ---------------- */

function subjectFontSize(text) {
  const n = text.length;
  if (n <= 8) return 52;
  if (n <= 14) return 44;
  if (n <= 22) return 36;
  return 29;
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
    chip.className = "ss-chip" + (pid === g.actor && g.stage !== "game_end" ? " acting" : "");
    const av = document.createElement("span");
    Hub.fillAvatar(av, p);
    chip.appendChild(av);
    chip.appendChild(document.createTextNode(String(g.scores[pid] || 0)));
    if (pid === g.actor) chip.appendChild(document.createTextNode(" 🎭"));
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

function renderGame(st) {
  const g = game();
  if (!g) return;
  $("ch-roundchip").textContent =
    `R${g.round_no}/${g.rounds} · ${g.turn_no}/${g.turns_total}`;
  renderScores(st);

  const acting = g.stage === "acting" || g.stage === "intro";
  const inGame = g.order.includes(S.pid);

  // actor zone
  const showActor = acting && g.you_act;
  $("actor-zone").hidden = !showActor;
  if (showActor && g.subject) {
    $("az-deck").textContent = g.deck;
    const subj = $("az-subject");
    subj.textContent = g.subject;
    subj.style.fontSize = subjectFontSize(g.subject) + "px";
    $("skip-count").textContent = `${g.skips_left} left`;
    $("skip-btn").disabled = g.skips_left <= 0;
    $("az-chain").hidden = g.mode !== "blitz";
    if (g.mode === "blitz") $("az-chain").textContent = `⚡ chain ${g.chain}`;
  }

  // guesser zone
  const showGuess = acting && !g.you_act;
  $("guess-zone").hidden = !showGuess;
  if (showGuess) {
    const actor = playerByPid(g.actor);
    Hub.fillAvatar($("sb-avatar"), actor);
    $("sb-name").textContent = actor ? actor.name : "—";
    $("sb-sub").textContent = `is acting · ${g.deck}${g.mode === "blitz" ? " · BLITZ" : ""}`;
    $("sb-chain").hidden = g.mode !== "blitz";
    if (g.mode === "blitz") $("sb-chain").textContent = `⚡${g.chain}`;
  }
  $("watch-note").hidden = inGame || !acting;

  // the sacred guess bar: toggle visibility only, never rebuild
  $("guess-form").hidden = !(showGuess && inGame);

  // intro overlay
  const showIntro = g.stage === "intro";
  $("intro-overlay").hidden = !showIntro;
  if (showIntro) {
    const key = "t" + g.turn_no;
    const actor = playerByPid(g.actor);
    Hub.fillAvatar($("io-avatar"), actor);
    $("io-name").textContent = actor ? actor.name : "—";
    $("io-deck").textContent = `${g.deck} · ${g.mode.toUpperCase()}`;
    $("io-you").hidden = !g.you_act;
    if (S.introKey !== key) {
      S.introKey = key;
      SFX.intro();
      if (g.you_act) { try { navigator.vibrate && navigator.vibrate([90, 60, 90]); } catch (e) {} }
      $("feed").textContent = "";     // fresh feed per turn
    }
  }

  // reveal overlay
  const showReveal = g.stage === "reveal" && g.reveal;
  $("reveal-overlay").hidden = !showReveal;
  if (showReveal) {
    const key = "r" + g.turn_no;
    const rv = g.reveal;
    $("rv-word").textContent = rv.subject;
    const w = $("rv-winner");
    if (rv.winner) {
      const p = playerByPid(rv.winner);
      w.textContent = `${p ? p.name : "?"} got it!`;
      w.className = "rv-winner";
    } else if (g.mode === "blitz") {
      w.textContent = `${rv.solved.length} solved this run`;
      w.className = "rv-winner";
    } else {
      w.textContent = "nobody got it";
      w.className = "rv-winner nobody";
    }
    const chain = $("rv-chain");
    chain.textContent = "";
    for (const srow of rv.solved) {
      const p = playerByPid(srow.by);
      const div = document.createElement("div");
      const b = document.createElement("b"); b.textContent = srow.word;
      div.appendChild(b);
      div.appendChild(document.createTextNode(` — ${p ? p.name : "?"} +${srow.pts}`));
      chain.appendChild(div);
    }
    $("rv-eyebrow").textContent = g.mode === "blitz" ? "TIME! LAST ONE WAS" : "THE ANSWER WAS";
    if (S.revealKey !== key) {
      S.revealKey = key;
      if (rv.winner === S.pid) Hub.confettiBurst(120);
    }
  }
}

let goShown = false;
function renderGameOver(st) {
  const g = game();
  const showIt = st.phase === "game_end" && g && g.result;
  $("gameover").hidden = !showIt;
  if (!showIt) { goShown = false; return; }
  $("intro-overlay").hidden = true;
  $("reveal-overlay").hidden = true;
  $("guess-form").hidden = true;
  const w = playerByPid(g.result.winner);
  $("go-title").textContent = w ? `${w.name.toUpperCase()} WINS` : "GAME OVER";
  const rows = $("go-rows");
  rows.textContent = "";
  for (const r of g.result.rows) {
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
    Hub.confettiBurst(200);
    SFX.fanfare();
  }
}

/* ---------------- feed ---------------- */

function feedRow({ p, text, cls = "" }) {
  const row = document.createElement("div");
  row.className = "feed-row " + cls;
  if (p) {
    const av = document.createElement("span"); av.className = "fr-av";
    Hub.fillAvatar(av, p);
    const nm = document.createElement("span"); nm.className = "fr-name";
    nm.textContent = p.name;
    row.append(av, nm);
  }
  const tx = document.createElement("span"); tx.className = "fr-text";
  tx.textContent = text;
  row.appendChild(tx);
  const feed = $("feed");
  feed.appendChild(row);
  while (feed.childElementCount > 50) feed.firstElementChild.remove();
  feed.scrollTop = feed.scrollHeight;
  return row;
}

function sysRow(text) { feedRow({ p: null, text, cls: "sys" }); }

/* ---------------- state & fx ---------------- */

function onState(st) {
  S.st = st;
  if (!S.joined) return;
  if (st.phase === "lobby" || st.phase === "countdown") {
    show("scr-lobby");
    $("intro-overlay").hidden = true;
    $("reveal-overlay").hidden = true;
    $("guess-form").hidden = true;
    S.prevScores = {};
    renderLobby(st);
  } else if (st.game) {
    show("scr-game");
    renderGame(st);
  }
  renderGameOver(st);
  $("countdown-overlay").hidden = st.phase !== "countdown";
}

function onFx(fx) {
  const g = game();
  switch (fx.kind) {
    case "toast": Hub.toast((fx.icon ? fx.icon + " " : "") + fx.msg); break;
    case "invalid": Hub.toast(fx.msg, "err"); SFX.buzz(); break;
    case "guess": {
      const p = playerByPid(fx.pid);
      if (fx.pid === S.pid) {
        // upgrade my optimistic pending row instead of duplicating
        const pend = $("feed").querySelector(".feed-row.pending");
        if (pend) { pend.classList.remove("pending"); break; }
      } else SFX.blip();
      feedRow({ p, text: fx.text, cls: fx.pid === S.pid ? "mine" : "" });
      break;
    }
    case "close":
      SFX.close();
      $("guess-input").classList.remove("close-flash");
      void $("guess-input").offsetWidth;
      $("guess-input").classList.add("close-flash");
      $("close-pop").hidden = false;
      setTimeout(() => { $("close-pop").hidden = true; }, 1400);
      try { navigator.vibrate && navigator.vibrate(40); } catch (e) {}
      break;
    case "solved": {
      const p = playerByPid(fx.pid);
      feedRow({ p, text: `${fx.word}  ✓ +${fx.pts}`, cls: "hit" });
      if (fx.pid === S.pid) { SFX.solved(); Hub.confettiBurst(90); }
      else SFX.solved();
      break;
    }
    case "skipped":
      sysRow(`actor skipped — ${fx.left} skip${fx.left === 1 ? "" : "s"} left`);
      SFX.skip();
      break;
    case "turn_intro": break;                     // overlay handled by state
    case "acting": if (game()?.you_act) SFX.intro(); break;
    case "reveal": SFX.solved(); break;
    case "game_over": break;
    case "countdown": SFX.intro(); break;
  }
}

/* ---------------- guess bar (never re-rendered) ---------------- */

$("guess-form").addEventListener("submit", (e) => {
  e.preventDefault();
  SFX.unlock();
  const input = $("guess-input");
  const text = input.value.trim();
  input.value = "";
  input.focus();                    // keyboard stays up, always
  if (!text) return;
  const now = Date.now();
  if (text.toLowerCase() === S.lastSent && now - S.lastSentAt < 800) return;
  S.lastSent = text.toLowerCase();
  S.lastSentAt = now;
  SFX.send();
  feedRow({ p: playerByPid(S.pid) || S.st?.you, text, cls: "mine pending" });
  S.conn.send({ t: "guess", text });
});

$("skip-btn").addEventListener("click", () => {
  SFX.unlock();
  S.conn.send({ t: "skip" });
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
  if (g.stage === "acting") {
    const rem = remainMs();
    const frac = Math.min(1, rem / (g.turn_seconds * 1000));
    $("ch-timer-fill").style.transform = `scaleX(${frac})`;
    $("ch-clock").textContent =
      `${(Math.ceil(rem / 1000) / 60) | 0}:${String(Math.ceil(rem / 1000) % 60).padStart(2, "0")}`;
    const low = rem < 10500 && rem > 0;
    $("ch-clock").classList.toggle("low", low);
    document.querySelector(".ch-timer").classList.toggle("low", low);
    const sec = Math.ceil(rem / 1000);
    if (sec !== lastTick && sec <= 5 && sec > 0) { SFX.tick(); lastTick = sec; }
  }
  if (g.stage === "reveal") {
    const nxt = $("rv-next");
    const rem = Math.ceil(remainMs() / 1000);
    nxt.textContent = g.reveal?.last_turn
      ? `final scores in ${rem}s` : `next actor in ${rem}s`;
  }
  if (st.phase === "game_end") {
    $("go-auto").textContent = `lobby in ${Math.ceil(remainMs() / 1000)}s`;
  }
}
requestAnimationFrame(raf);

/* ---------------- boot & wiring ---------------- */

async function loadDecks() {
  try {
    const res = await fetch("/api/charades/decks");
    S.decks = (await res.json()).decks;
  } catch (e) { S.decks = []; }
}

function connect() {
  S.conn = Hub.connect("/games/charades/ws", {
    onWelcome: (m) => { S.pid = m.pid; },
    onState, onFx,
  });
}

const step = (key, delta, min, max) => {
  const cur = S.st?.settings[key] ?? min;
  S.conn.send({ t: "settings", patch: { [key]: Math.max(min, Math.min(max, cur + delta)) } });
};
$("turn-minus").onclick = () => step("turn_seconds", -15, 30, 150);
$("turn-plus").onclick = () => step("turn_seconds", 15, 30, 150);
$("rounds-minus").onclick = () => step("rounds", -1, 1, 4);
$("rounds-plus").onclick = () => step("rounds", 1, 1, 4);

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
      title: "Charades", icon: "🎭",
      winner: { name: wp ? wp.name : "?", avatar: wp ? wp.avatar : "🎭",
                pfp: wp ? wp.pfp : null },
      headline: `${wRow ? wRow.score : 0} points · ${g.deck}`,
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

loadDecks().then(() => {
  if (Hub.identity.name) {
    S.joined = true;
    connect();
    show("scr-lobby");
  } else {
    show("scr-join");
  }
});
