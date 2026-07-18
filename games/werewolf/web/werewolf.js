/* WEREWOLF client. The phone is your secret role, your night actions, and
   your ballot. UX rule #1: every night screen — sleeping or acting — shares
   the same dark backdrop, so a glance across the room reveals nothing. */
"use strict";

const $ = (id) => document.getElementById(id);

const S = {
  st: null, pid: null, conn: null, joined: false,
  votePick: null, voteKey: "",
  nightKey: "", dawnKey: "", verdictKey: "", goShown: false,
  muted: localStorage.getItem("wc-muted") === "1",
};

const ROLE_META = {
  wolf: { art: "🐺", name: "WEREWOLF",
          mission: "Eat the village. Don't get caught.", cls: "is-wolf" },
  seer: { art: "🔮", name: "SEER",
          mission: "Each night, read one player's true nature." },
  doctor: { art: "🩺", name: "DOCTOR",
            mission: "Each night, choose one player to protect." },
  villager: { art: "🌾", name: "VILLAGER",
              mission: "Find the wolves. Vote them out." },
};
const STAGE_SECONDS = { night_wolf: 25, night_seer: 20, night_doctor: 20, vote: 45 };

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
    blip: () => tone(300, "triangle", 0.05, 0.05),
    buzz: () => tone(150, "sawtooth", 0.2, 0.08, 0, -60),
    howl: () => { tone(240, "sine", 0.9, 0.1, 0, 260); tone(480, "sine", 1.1, 0.09, 0.85, -220); },
    dawn: () => [262, 330, 392, 523].forEach((f, i) => tone(f, "sine", 0.3, 0.11, i * 0.12)),
    rooster: () => [660, 880, 660, 990].forEach((f, i) => tone(f, "triangle", 0.12, 0.08, i * 0.1)),
    drum: () => { tone(120, "sawtooth", 0.18, 0.14); tone(95, "sawtooth", 0.24, 0.14, 0.22); },
    sting: () => tone(330, "sawtooth", 0.5, 0.1, 0, -240),
    tick: () => tone(1150, "square", 0.03, 0.045),
    fanfare: () => [392, 523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, "sine", 0.3, 0.12, i * 0.1)),
    intro: () => { tone(392, "sine", 0.18, 0.12); tone(587, "sine", 0.24, 0.12, 0.12); },
  };
})();

/* ---------------- helpers ---------------- */
const game = () => S.st?.game || null;
const playerByPid = (pid) => (S.st?.players || []).find((p) => p.pid === pid) || null;
const nameOf = (pid) => { const p = playerByPid(pid); return p ? p.name : "?"; };
const remainMs = () => S.st?.deadline ? Math.max(0, S.st.deadline - S.conn.now()) : 0;
const gameRemainMs = () => {
  const g = game();
  return g && g.ends ? Math.max(0, g.ends - S.conn.now()) : 0;
};

function show(id) {
  for (const s of ["scr-join", "scr-lobby", "scr-game"]) $(s).hidden = s !== id;
}

const PANES = ["pane-role", "pane-night", "pane-day", "pane-vote", "pane-ghost", "pane-watch"];
function showPane(id) {
  for (const p of PANES) $(p).hidden = p !== id;
}

/* the playtest's periscope — reads ONLY this client's own state */
window.__ww = () => {
  const st = S.st, g = st && st.game;
  return {
    phase: st ? st.phase : null,
    stage: g ? g.stage : null,
    pid: S.pid,
    role: g && g.me ? g.me.role : null,
    ghost: !!(g && g.me && g.me.ghost),
    alive: g ? g.alive : null,
    act: g && g.act ? g.act.type : null,
    acked: g && g.act ? g.act.acked : null,
    myVote: g && g.act ? g.act.vote : null,
    vision: g && g.me && g.me.visions ? g.me.visions[g.me.visions.length - 1] || null : null,
    omniRoles: g && g.omni ? g.omni.roles : null,
    winner: g && g.result ? g.result.winner : null,
  };
};

/* ---------------- lobby ---------------- */

function planText(n) {
  if (n < 5) return `werewolf needs 5 — ${5 - n} more to open the gates`;
  const wolves = n <= 6 ? 1 : 2;
  const vill = n - wolves - 2;
  return `${n} players → 🐺 ${wolves} werewol${wolves > 1 ? "ves" : "f"} · ` +
         `🔮 1 seer · 🩺 1 doctor · 🌾 ${vill} villager${vill === 1 ? "" : "s"}`;
}

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
  $("role-plan").textContent = planText(readyN || humans.length);

  const seg = $("opt-day");
  seg.textContent = "";
  for (const [val, label] of [[120, "2:00"], [180, "3:00"], [300, "5:00"]]) {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = st.settings.day_seconds === val ? "sel" : "";
    b.onclick = () => { SFX.click(); S.conn.send({ t: "settings", patch: { day_seconds: val } }); };
    seg.appendChild(b);
  }

  const me = st.you;
  const amReady = !!(me && me.ready);
  $("ready-btn").textContent = amReady ? "READY ✓" : "READY UP";
  $("ready-btn").classList.toggle("is-ready", amReady);
  $("go-btn").hidden = !(readyN >= st.min_players && amReady && st.phase === "lobby");
  $("lobby-hint").textContent =
    st.phase === "countdown" ? "THE MOON RISES…"
    : readyN >= st.min_players ? `${readyN} villagers ready — begin when you are`
    : `need ${st.min_players - readyN} more ready — ${location.host}`;
}

/* ---------------- shared widgets ---------------- */

function avEl(p, cls = "tg-av") {
  const av = document.createElement("span");
  av.className = cls;
  Hub.fillAvatar(av, p);
  return av;
}

/* target grid: tap-to-pick with per-pid marks. Rebuilt every state push. */
function buildTargets(host, targets, { selPid, selCls, marks = {}, disabled, onTap }) {
  host.textContent = "";
  for (const pid of targets) {
    const p = playerByPid(pid);
    const b = document.createElement("button");
    b.className = "tg-cell" + (pid === selPid ? " " + selCls : "");
    b.dataset.pid = pid;
    b.disabled = !!disabled;
    b.appendChild(avEl(p));
    const nm = document.createElement("span"); nm.className = "tg-name";
    nm.textContent = (p ? p.name : "?") + (pid === S.pid ? " (you)" : "");
    b.appendChild(nm);
    if (marks[pid]) {
      const mk = document.createElement("span"); mk.className = "tg-mark";
      mk.textContent = marks[pid];
      b.appendChild(mk);
    }
    if (onTap && !disabled) b.onclick = () => onTap(pid);
    host.appendChild(b);
  }
}

function deathCard(pid, name, role) {
  const p = playerByPid(pid);
  const card = document.createElement("div");
  card.className = "death-card";
  card.appendChild(avEl(p, "dc-av"));
  const nm = document.createElement("span"); nm.className = "dc-name";
  nm.textContent = name || nameOf(pid);
  const rl = document.createElement("span");
  rl.className = "dc-role" + (role === "wolf" ? " was-wolf" : "");
  const meta = ROLE_META[role] || { art: "❓", name: "?" };
  rl.textContent = `WAS ${meta.name} ${meta.art}`;
  card.append(nm, rl);
  return card;
}

/* ---------------- role reveal ---------------- */

function renderRole(g) {
  showPane("pane-role");
  const meta = ROLE_META[g.me.role];
  $("rc-art").textContent = meta.art;
  $("rc-name").textContent = meta.name;
  $("rc-mission").textContent = meta.mission;
  document.querySelector(".rc-face").classList.toggle("is-wolf", g.me.role === "wolf");
  const partner = $("rc-partner");
  const partners = g.me.partners || [];
  partner.hidden = !(g.me.role === "wolf" && partners.length);
  if (!partner.hidden) {
    partner.textContent = `your pack: ${partners.map(nameOf).join(" · ")} 🐺`;
  }
  const acked = !!(g.act && g.act.acked);
  const k = (g.acked || []).length, n = (g.alive || []).length;
  $("role-ack").disabled = acked;
  $("role-ack").textContent = acked ? "MEMORIZED ✓" : "I KNOW WHO I AM";
  $("role-wait").textContent = `${k}/${n} have memorized their card`;
}

/* ---------------- night ---------------- */

function renderNight(g) {
  showPane("pane-night");
  const act = g.act;
  const acting = act && ["wolf", "seer", "doctor"].includes(act.type);
  $("sleep-view").hidden = acting;
  $("act-view").hidden = !acting;

  // the seer keeps tonight's vision on the sleep screen (private, dim)
  const note = $("seer-note");
  note.hidden = true;
  if (!acting && g.me.role === "seer" && g.me.visions) {
    const v = g.me.visions[g.me.visions.length - 1];
    if (v && v.night === g.night_no) {
      note.hidden = false;
      note.textContent = `🔮 ${nameOf(v.pid)} — ${v.wolf ? "A WEREWOLF" : "not a werewolf"}`;
    }
  }
  if (!acting) return;

  const grid = $("act-grid"), lock = $("act-lock"), res = $("seer-result");
  res.hidden = true; lock.hidden = true; grid.hidden = false;

  if (act.type === "wolf") {
    $("act-title").textContent = "🐺 CHOOSE YOUR PREY";
    const myPick = act.picks[S.pid] || null;
    const myLocked = act.locks.includes(S.pid);
    const partners = (game().me.partners || []);
    const marks = {};
    for (const [wpid, tpid] of Object.entries(act.picks)) {
      if (!tpid) continue;
      marks[tpid] = (marks[tpid] || "") + (wpid === S.pid ? (myLocked ? "🔒" : "✔") : "🐺");
    }
    buildTargets(grid, act.targets, {
      selPid: myPick, selCls: "sel-wolf", marks,
      onTap: (pid) => { SFX.unlock(); S.conn.send({ t: "wolf_pick", pid }); },
    });
    const pPick = partners.map((w) => act.picks[w]).find((x) => x);
    const agree = myPick && partners.length &&
      partners.every((w) => act.picks[w] === myPick);
    $("act-sub").textContent =
      !partners.length ? "the pack is yours alone tonight"
      : pPick ? `your partner eyes ${nameOf(pPick)}${agree ? " — THE PACK AGREES" : ""}`
      : "your partner is still deciding…";
    lock.hidden = false;
    lock.disabled = !myPick || myLocked;
    lock.classList.toggle("armed", !!(myPick && !myLocked && (agree || !partners.length)));
    lock.textContent = !myPick ? "MARK YOUR PREY"
      : myLocked ? "🔒 KILL CONFIRMED — WAIT…" : "🔪 CONFIRM THE KILL";
  } else if (act.type === "seer") {
    $("act-title").textContent = "🔮 READ A SOUL";
    $("act-sub").textContent = act.done ? "" : "one vision per night — choose well";
    if (act.done) {
      grid.hidden = true;
      const v = (game().me.visions || []).slice(-1)[0];
      if (v) {
        res.hidden = false;
        res.className = "seer-result " + (v.wolf ? "is-wolf" : "not-wolf");
        res.textContent = "";
        const who = document.createElement("span"); who.className = "sr-who";
        who.textContent = nameOf(v.pid).toUpperCase();
        res.appendChild(who);
        res.appendChild(document.createTextNode(
          v.wolf ? "🐺 A WEREWOLF" : "✋ NOT A WEREWOLF"));
      }
    } else {
      buildTargets(grid, act.targets, {
        selPid: null, selCls: "sel-seer",
        onTap: (pid) => { SFX.unlock(); S.conn.send({ t: "seer_pick", pid }); },
      });
    }
  } else if (act.type === "doctor") {
    $("act-title").textContent = "🩺 GUARD A LIFE";
    $("act-sub").textContent = act.pick
      ? `you stand guard over ${nameOf(act.pick)} tonight`
      : "pick anyone — even yourself";
    buildTargets(grid, act.targets, {
      selPid: act.pick, selCls: "sel-doctor", disabled: !!act.pick,
      marks: act.pick ? { [act.pick]: "🛡" } : {},
      onTap: (pid) => { SFX.unlock(); S.conn.send({ t: "doctor_pick", pid }); },
    });
  }
}

/* ---------------- day & vote ---------------- */

function renderDay(g) {
  showPane("pane-day");
  const recap = $("day-recap");
  if (g.dawn && g.dawn.died) {
    recap.className = "day-recap death";
    const meta = ROLE_META[g.dawn.role] || { name: "?" };
    recap.textContent = `☠️ ${g.dawn.name || nameOf(g.dawn.died)} was taken in the night — ${meta.name}`;
  } else {
    recap.className = "day-recap saved";
    recap.textContent = "🕊 nobody died last night";
  }
  const w = g.wolves_alive;
  $("wolf-count").textContent = `🐺 ${w} ${w === 1 ? "WOLF WALKS" : "WOLVES WALK"} AMONG YOU`;
  const grid = $("day-grid");
  grid.textContent = "";
  const ready = new Set(g.ready_pids || []);
  for (const pid of g.alive) {
    const p = playerByPid(pid);
    const chip = document.createElement("span");
    chip.className = "ag-chip" + (ready.has(pid) ? " is-ready" : "");
    chip.appendChild(avEl(p));
    chip.appendChild(document.createTextNode(p ? p.name : "?"));
    if (ready.has(pid)) chip.appendChild(document.createTextNode(" 🗳"));
    grid.appendChild(chip);
  }
  const mine = !!(g.act && g.act.ready);
  const btn = $("ready-vote");
  btn.disabled = mine;
  btn.classList.toggle("is-done", mine);
  btn.textContent = mine ? `WAITING ${ready.size}/${g.alive.length}` : "🗳 READY TO VOTE";
  $("ready-status").textContent = ready.size
    ? `${ready.size}/${g.alive.length} ready — all in opens the vote early`
    : "vote opens when the clock runs out — or when everyone's ready";
}

function renderVote(g) {
  showPane("pane-vote");
  const act = g.act;
  const key = "v" + g.night_no;
  if (S.voteKey !== key) { S.voteKey = key; S.votePick = null; }
  const locked = !!(act && act.vote);
  const sel = locked ? act.vote : S.votePick;
  buildTargets($("vote-grid"), act ? act.targets : g.alive, {
    selPid: sel, selCls: "sel-vote", disabled: locked || !act,
    marks: locked ? { [act.vote]: "🔒" } : {},
    onTap: (pid) => { SFX.click(); S.votePick = pid; renderVote(game()); },
  });
  const k = (g.voted_pids || []).length, n = g.alive.length;
  const lockBtn = $("vote-lock");
  lockBtn.disabled = locked || !sel;
  lockBtn.classList.toggle("is-done", locked);
  lockBtn.textContent = locked ? `VOTE LOCKED — ${k}/${n} IN` : "LOCK IT IN";
  $("vote-status").textContent = locked
    ? "tally stays sealed until every vote is in"
    : sel ? `sending ${nameOf(sel)} to the gallows?` : "tap a name, then lock it in";
}

/* ---------------- ghost ---------------- */

function glRow(text, hot) {
  const div = document.createElement("div");
  div.className = "gl-row" + (hot ? " hot" : "");
  div.innerHTML = text;
  return div;
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function renderGhost(g) {
  showPane("pane-ghost");
  const omni = g.omni || {};
  const truth = $("ghost-truth");
  truth.textContent = "";
  const aliveSet = new Set(g.alive);
  for (const p of (S.st.players || [])) {
    if (!(p.pid in (omni.roles || {}))) continue;
    const role = omni.roles[p.pid];
    const row = document.createElement("div");
    row.className = "gt-row" + (role === "wolf" ? " is-wolf" : "")
      + (aliveSet.has(p.pid) ? "" : " is-dead");
    row.appendChild(avEl(p));
    row.appendChild(document.createTextNode(p.name));
    const rl = document.createElement("span"); rl.className = "gt-role";
    rl.textContent = (ROLE_META[role] || {}).art || "❓";
    row.appendChild(rl);
    truth.appendChild(row);
  }
  const live = $("ghost-live");
  live.textContent = "";
  const stage = g.stage;
  if (stage === "night_wolf") {
    const picks = Object.entries(omni.wolf_picks || {});
    if (!picks.length) live.appendChild(glRow("🐺 the wolves stir…", true));
    for (const [wp, tp] of picks) {
      live.appendChild(glRow(`🐺 <b>${esc(nameOf(wp))}</b> eyes <b>${esc(nameOf(tp))}</b>`, true));
    }
  } else if (stage === "night_seer") {
    live.appendChild(glRow(omni.seer_pick
      ? `🔮 the seer reads <b>${esc(nameOf(omni.seer_pick))}</b>`
      : "🔮 the seer gazes into the dark…"));
  } else if (stage === "night_doctor") {
    live.appendChild(glRow(omni.doctor_pick
      ? `🩺 the doctor guards <b>${esc(nameOf(omni.doctor_pick))}</b>`
      : "🩺 the doctor makes their rounds…"));
  } else if (stage === "vote") {
    const votes = Object.entries(omni.votes || {});
    if (!votes.length) live.appendChild(glRow("🗳 ballots are moving…"));
    for (const [vp, tp] of votes) {
      live.appendChild(glRow(`🗳 <b>${esc(nameOf(vp))}</b> → <b>${esc(nameOf(tp))}</b>`));
    }
  } else if (stage === "day") {
    live.appendChild(glRow("☀️ the living argue. you know everything. say nothing."));
  }
  for (const v of (omni.visions || [])) {
    live.appendChild(glRow(
      `🔮 N${v.night}: <b>${esc(nameOf(v.pid))}</b> — ${v.wolf ? "WOLF" : "not a wolf"}`, v.wolf));
  }
}

/* ---------------- overlays ---------------- */

function renderOverlays(g) {
  $("nightfall-overlay").hidden = g.stage !== "night_intro";
  const dawnO = $("dawn-overlay");
  dawnO.hidden = g.stage !== "dawn";
  if (!dawnO.hidden && g.dawn) {
    const key = "d" + g.night_no;
    const body = $("dawn-body");
    body.textContent = "";
    if (g.dawn.died) {
      body.appendChild(deathCard(g.dawn.died, g.dawn.name, g.dawn.role));
    } else {
      const card = document.createElement("div");
      card.className = "nobody-card";
      card.innerHTML = `<span class="nb-big">🕊</span>
        <span class="nb-line">EVERYONE WAKES UP… NOBODY DIED</span>
        <span class="nb-sub">${g.dawn.saved ? "someone was pulled back from the brink" : "an uneasy quiet hangs over the village"}</span>`;
      body.appendChild(card);
    }
    if (S.dawnKey !== key) { S.dawnKey = key; SFX.dawn(); try { navigator.vibrate && navigator.vibrate(80); } catch (e) {} }
  }
  const verdO = $("verdict-overlay");
  verdO.hidden = g.stage !== "verdict";
  if (!verdO.hidden && g.verdict) {
    const key = "e" + g.night_no;
    const body = $("verdict-body");
    body.textContent = "";
    if (g.verdict.eliminated) {
      body.appendChild(deathCard(g.verdict.eliminated, g.verdict.name, g.verdict.role));
    } else {
      const t = document.createElement("p");
      t.className = "tie-line";
      t.textContent = g.verdict.tie
        ? "A DEADLOCK — the village argues until sunset"
        : "NO VERDICT — nobody hangs today";
      body.appendChild(t);
    }
    const tally = $("verdict-tally");
    tally.textContent = "";
    const rows = Object.entries(g.verdict.tally || {}).sort((a, b) => b[1] - a[1]);
    for (const [pid, n] of rows) {
      const row = document.createElement("div"); row.className = "vt-row";
      row.appendChild(avEl(playerByPid(pid)));
      row.appendChild(document.createTextNode(nameOf(pid)));
      const b = document.createElement("b"); b.textContent = `${n} vote${n === 1 ? "" : "s"}`;
      row.appendChild(b);
      tally.appendChild(row);
    }
    const ab = (g.verdict.abstained || []).length;
    if (ab) {
      const row = document.createElement("div"); row.className = "vt-row";
      row.textContent = `${ab} abstained`;
      tally.appendChild(row);
    }
    if (S.verdictKey !== key) { S.verdictKey = key; SFX.sting(); }
  }
}

/* ---------------- game over ---------------- */

function logLines(res) {
  const lines = [];
  for (const e of res.log || []) {
    if (e.type === "night") {
      let s = `🌙 <b>NIGHT ${e.n}</b> — `;
      if (!e.target) s += "the wolves never struck";
      else if (e.saved) s += `wolves went for <b>${esc(nameOf(e.target))}</b> — the doctor saved them`;
      else if (e.died) {
        const meta = ROLE_META[e.died_role] || { name: "?" };
        s += `wolves took <b>${esc(nameOf(e.died))}</b> (${meta.name})`;
      } else s += "nobody died";
      const extra = [];
      if (e.seer) extra.push(`seer read ${esc(nameOf(e.seer))}`);
      if (e.doctor) extra.push(`doctor guarded ${esc(nameOf(e.doctor))}`);
      if (extra.length) s += ` · ${extra.join(" · ")}`;
      lines.push(s);
    } else {
      let s = `☀️ <b>DAY ${e.n}</b> — `;
      if (e.eliminated) {
        const meta = ROLE_META[e.role] || { name: "?" };
        s += `voted out <b>${esc(nameOf(e.eliminated))}</b> (${meta.name})`;
      } else s += "deadlock — nobody eliminated";
      lines.push(s);
    }
  }
  return lines;
}

function renderGameOver(st) {
  const g = game();
  const showIt = st.phase === "game_end" && g && g.result;
  $("gameover").hidden = !showIt;
  if (!showIt) { S.goShown = false; return; }
  const res = g.result;
  const wolves = res.winner === "wolves";
  const banner = $("go-banner");
  banner.className = "go-banner " + (wolves ? "wolves" : "village");
  banner.textContent = wolves ? "🐺 WEREWOLVES WIN" : "🌾 VILLAGE WINS";
  $("go-sub").textContent =
    (res.reason === "forfeit" ? "the wolves fled the village"
     : wolves ? "the wolves reached parity" : "every wolf is gone")
    + ` · ${res.nights} night${res.nights === 1 ? "" : "s"}`;
  const rows = $("go-roles");
  rows.textContent = "";
  const winSet = new Set(res.winners || []);
  for (const r of res.roles) {
    const p = playerByPid(r.pid);
    const div = document.createElement("div");
    div.className = "go-row" + (winSet.has(r.pid) ? " winner" : "")
      + (r.alive ? "" : " dead-row");
    div.appendChild(avEl(p));
    const nm = document.createElement("span"); nm.className = "go-nm";
    nm.textContent = r.name || (p ? p.name : "?");
    div.appendChild(nm);
    const meta = ROLE_META[r.role] || { art: "❓", name: "?" };
    const rl = document.createElement("span");
    rl.className = "go-role" + (r.role === "wolf" ? " wolf" : "");
    rl.textContent = `${meta.name} ${meta.art}${r.alive ? "" : " ☠"}`;
    div.appendChild(rl);
    rows.appendChild(div);
  }
  const log = $("go-log");
  log.textContent = "";
  for (const line of logLines(res)) {
    const div = document.createElement("div");
    div.innerHTML = line;
    log.appendChild(div);
  }
  if (!S.goShown) {
    S.goShown = true;
    if ((res.winners || []).includes(S.pid)) { Hub.confettiBurst(220); SFX.fanfare(); }
    else SFX.sting();
  }
}

/* ---------------- state & fx ---------------- */

function renderGame(st) {
  const g = game();
  if (!g) return;
  const stage = g.stage;
  const nightish = ["night_intro", "night_wolf", "night_seer", "night_doctor", "dawn"].includes(stage);
  $("ww-chip").textContent = stage === "role" ? "ROLES"
    : nightish ? `NIGHT ${g.night_no}` : `DAY ${g.night_no}`;
  $("ww-sub").textContent =
    stage === "role" ? "memorize your card"
    : stage === "day" ? "talk it out — out loud"
    : stage === "vote" ? "the tally is sealed until all vote"
    : nightish ? "" : "";
  const ghost = !!(g.me && g.me.ghost);
  $("ghost-chip").hidden = !ghost;

  if (!g.me) { showPane("pane-watch"); }
  else if (ghost) { renderGhost(g); }
  else if (stage === "role") { renderRole(g); }
  else if (nightish) { renderNight(g); }
  else if (stage === "day") { renderDay(g); }
  else if (stage === "vote" || stage === "verdict") { renderVote(g); }
  renderOverlays(g);

  if (S.nightKey !== "n" + g.night_no && g.night_no > 0) {
    S.nightKey = "n" + g.night_no;
  }
}

function onState(st) {
  S.st = st;
  if (!S.joined) return;
  if (st.phase === "lobby" || st.phase === "countdown") {
    show("scr-lobby");
    $("nightfall-overlay").hidden = true;
    $("dawn-overlay").hidden = true;
    $("verdict-overlay").hidden = true;
    S.votePick = null; S.voteKey = ""; S.dawnKey = ""; S.verdictKey = "";
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
    case "roles_dealt": SFX.intro(); break;
    case "night": SFX.howl(); break;
    case "dawdled": Hub.toast("🐺 You dawdled — the pack chose for you", "err"); break;
    case "dawn": break;                      // sound keyed off the overlay
    case "day": SFX.rooster(); break;
    case "ready_vote": SFX.blip(); break;
    case "vote_open": SFX.drum(); break;
    case "voted": SFX.blip(); break;
    case "verdict": break;                   // sound keyed off the overlay
    case "vision": break;                    // silence at night — no leaks
    case "protected": break;
    case "wolves_wake": break;
    case "game_over": break;
    case "countdown": SFX.intro(); break;
  }
}

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
  const rem = gameRemainMs();
  if (g.stage === "day") {
    const sec = Math.ceil(rem / 1000);
    $("day-clock").textContent =
      `${(sec / 60) | 0}:${String(sec % 60).padStart(2, "0")}`;
    $("day-clock").classList.toggle("low", sec <= 15 && sec > 0);
    $("day-fill").style.transform =
      `scaleX(${Math.min(1, rem / ((st.settings.day_seconds || 180) * 1000))})`;
    if (sec !== lastTick && sec <= 10 && sec > 0) { SFX.tick(); lastTick = sec; }
  }
  if (g.stage === "vote") {
    $("vote-bar").style.transform =
      `scaleX(${Math.min(1, rem / (STAGE_SECONDS.vote * 1000))})`;
  }
  if (STAGE_SECONDS[g.stage] && g.act && ["wolf", "seer", "doctor"].includes(g.act.type)) {
    $("act-bar").style.transform =
      `scaleX(${Math.min(1, rem / (STAGE_SECONDS[g.stage] * 1000))})`;
  }
  if (st.phase === "game_end") {
    $("go-auto").textContent = `back to the village in ${Math.ceil(remainMs() / 1000)}s`;
  }
}
requestAnimationFrame(raf);

/* ---------------- input wiring ---------------- */

/* hold-to-peek: nothing shows unless a finger is down on the card */
const roleCard = $("role-card");
const peek = (on) => roleCard.classList.toggle("peek", on);
roleCard.addEventListener("pointerdown", (e) => { e.preventDefault(); SFX.unlock(); peek(true); });
for (const ev of ["pointerup", "pointercancel", "pointerleave"]) {
  roleCard.addEventListener(ev, () => peek(false));
}
roleCard.addEventListener("contextmenu", (e) => e.preventDefault());

$("role-ack").onclick = () => { SFX.click(); S.conn.send({ t: "role_ack" }); };
$("ready-vote").onclick = () => { SFX.unlock(); SFX.click(); S.conn.send({ t: "day_ready" }); };
$("vote-lock").onclick = () => {
  if (!S.votePick) return;
  SFX.unlock(); SFX.click();
  S.conn.send({ t: "vote", pid: S.votePick });
};
$("act-lock").onclick = () => { SFX.unlock(); S.conn.send({ t: "wolf_lock" }); };

$("ready-btn").onclick = () => {
  SFX.unlock(); SFX.click();
  const me = S.st?.you;
  S.conn.send({ t: "ready", ready: !(me && me.ready) });
};
$("go-btn").onclick = () => { SFX.unlock(); S.conn.send({ t: "start" }); };
$("rematch-btn").onclick = () => S.conn.send({ t: "again" });

/* brag card — the winning team takes the trophy shot */
if (window.Brag) {
  const btn = Brag.button(() => {
    const g = game();
    if (!g || !g.result) return null;
    const res = g.result;
    const wolves = res.winner === "wolves";
    const winners = res.roles.filter((r) => (res.winners || []).includes(r.pid));
    const losers = res.roles.filter((r) => (res.losers || []).includes(r.pid));
    return {
      title: "Werewolf", icon: "🐺",
      winner: { name: wolves ? "THE WOLF PACK" : "THE VILLAGE",
                avatar: wolves ? "🐺" : "🌾", pfp: null },
      headline: winners.map((r) => r.name).join(" · "),
      beaten: losers.slice(0, 4).map((r) => ({ name: r.name })),
      sub: `${res.nights} night${res.nights === 1 ? "" : "s"} of lies`,
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

/* ---------------- boot ---------------- */

function connect() {
  S.conn = Hub.connect("/games/werewolf/ws", {
    onWelcome: (m) => { S.pid = m.pid; },
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
