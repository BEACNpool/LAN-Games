/* THE FIFTH SIGNAL TV — public mission control, never private answers. */
"use strict";

const $ = (id) => document.getElementById(id);
const ROLE_ORDER = ["helm", "core", "relay", "life", "ops"];
const ROLES = {
  helm:  { title: "HELM",  icon: "🧭", color: "#22d3ee" },
  core:  { title: "CORE",  icon: "⚡", color: "#f5b301" },
  relay: { title: "RELAY", icon: "📡", color: "#ec4899" },
  life:  { title: "LIFE",  icon: "✚",  color: "#34d399" },
  ops:   { title: "OPS",   icon: "◫",  color: "#a78bfa" },
};
const S = {
  st: null,
  conn: null,
  audio: false,
  wake: null,
  lastPhase: "",
  lastRound: 0,
  lastResolutionKey: "",
  lastEndKey: "",
};

const game = () => S.st?.game || null;
const roster = () => game()?.roster || S.st?.players || [];
const player = (pid) => roster().find((p) => p.pid === pid)
  || S.st?.players?.find((p) => p.pid === pid) || null;
const roleId = (role) => typeof role === "string" ? role : role?.id || role?.role || "";
const roleMeta = (role) => {
  const id = roleId(role);
  const known = ROLES[id] || {};
  return {
    id,
    title: role?.title || role?.label || known.title || id.toUpperCase() || "CONSOLE",
    icon: role?.icon || known.icon || "◈",
    color: role?.color || known.color || "#42e8ff",
  };
};
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
function integrity(g = game()) {
  const max = Math.max(1, Number(g?.integrity_max ?? 100) || 100);
  const value = clamp(Number(g?.integrity ?? max) || 0, 0, max);
  return { value, max, pct: Math.round(value / max * 100) };
}
function missionCode(g = game()) {
  const suffix = String(g?.crisis?.id || "AURORA").slice(0, 6).toUpperCase();
  return `AURORA // ${suffix}`;
}
function show(id) {
  for (const sid of ["tv-lobby", "tv-briefing", "tv-crisis", "tv-resolution", "tv-sync", "tv-end"]) {
    $(sid).hidden = sid !== id;
  }
}
function personAvatar(className, p) {
  const avatar = document.createElement("span");
  avatar.className = className;
  Hub.fillAvatar(avatar, p || {});
  return avatar;
}
function ownerOf(role) {
  return roster().find((p) => (p.roles || []).some((candidate) => roleId(candidate) === role)) || null;
}

/* The curtain provides the deliberate gesture WebAudio and wake lock require. */
async function holdWake() {
  try { S.wake = await navigator.wakeLock?.request("screen"); } catch (error) { /* optional */ }
}
$("tv-curtain").onclick = () => {
  S.audio = true;
  Hub.feedback?.select?.();
  holdWake();
  $("tv-curtain").hidden = true;
};
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && S.audio) holdWake();
});
function cue(kind, pattern) {
  if (!S.audio) return;
  try { Hub.feedback?.[kind]?.(); } catch (error) { /* optional */ }
  try { Hub.feedback?.haptic?.(pattern); } catch (error) { /* TV haptics are optional */ }
}
function flash(message, duration = 900) {
  const host = $("tv-flash");
  host.textContent = message;
  host.hidden = false;
  host.style.animation = "none";
  void host.offsetWidth;
  host.style.animation = `flash-in ${duration}ms ease both`;
  clearTimeout(host._timer);
  host._timer = setTimeout(() => { host.hidden = true; }, duration);
}

const joinUrl = new URL(".", location.href).href;
$("tv-url").textContent = joinUrl.replace(/^https?:\/\//, "");
try {
  renderQR($("tv-qr"), joinUrl);
} catch (error) {
  $("tv-qr").textContent = "OPEN THE ADDRESS BELOW";
}

/* ---------- lobby ---------- */
function renderLobby(st) {
  show("tv-lobby");
  const people = (st.players || []).filter((p) => !p.bot);
  const host = $("tv-lobby-crew");
  host.textContent = "";
  for (const p of people) {
    const card = document.createElement("div");
    card.className = "tv-crew-person" + (p.ready ? " ready" : "");
    const avatar = personAvatar("brief-avatar", p);
    const copy = document.createElement("p");
    const name = document.createElement("b");
    name.textContent = p.name || "CREW";
    const status = document.createElement("small");
    status.textContent = p.connected === false ? "SIGNAL LOST" : p.ready ? "READY FOR ASSIGNMENT" : "BOARDING";
    copy.append(name, status);
    const mark = document.createElement("i");
    mark.textContent = p.ready ? "✓" : "";
    card.append(avatar, copy, mark);
    host.appendChild(card);
  }
  const ready = people.filter((p) => p.ready && p.connected !== false).length;
  $("tv-lobby-hint").textContent = st.phase === "countdown"
    ? "MISSION SEQUENCE INITIALIZING"
    : people.length
      ? `${people.length} CREW ABOARD · ${ready} READY · ${people.length < 5 ? "FUSED CONSOLES ENABLED" : "FULL CREW"}`
      : "SCAN TO JOIN · 3–5 CREW";
}

/* ---------- public role assignments ---------- */
function assignmentRows(g) {
  const rows = [];
  for (const id of ROLE_ORDER) {
    const owner = ownerOf(id);
    const source = owner?.roles?.find((role) => roleId(role) === id);
    rows.push({ role: roleMeta(source || id), owner });
  }
  return rows;
}
function renderBriefing(st) {
  show("tv-briefing");
  const g = st.game || {};
  $("tv-brief-id").textContent = `${missionCode(g)} · ${g.round || 1}/${g.rounds || 1}`;
  $("tv-brief-title").textContent = g.crisis?.title || "INCOMING SIGNAL";
  const host = $("tv-assignment-grid");
  host.textContent = "";
  for (const { role, owner } of assignmentRows(g)) {
    const card = document.createElement("div");
    card.className = "tv-assignment";
    card.style.setProperty("--role", role.color);
    const icon = document.createElement("span");
    icon.textContent = role.icon;
    const title = document.createElement("b");
    title.textContent = role.title;
    const name = document.createElement("small");
    name.textContent = owner?.name || "ASSIGNING";
    const avatar = personAvatar("brief-avatar", owner);
    card.append(icon, title, name, avatar);
    host.appendChild(card);
  }
}

/* ---------- live crisis ---------- */
function publicCrisisCopy(crisis) {
  if (!crisis) return "Crew consoles are receiving private telemetry.";
  return crisis.alert
    ? `${crisis.alert} Each phone holds one part of the recovery pattern.`
    : `${crisis.system || "A ship system"} is unstable. Each phone holds one part of the recovery pattern.`;
}
function renderConsoleGrid(g, resolution = null) {
  const host = $("tv-console-grid");
  host.textContent = "";
  const stableByRole = new Map((resolution?.systems || []).map((system) => [system.role, system.stable]));
  const progressByRole = new Map((g.progress?.systems || []).map((system) => [system.role, system]));
  for (const { role, owner } of assignmentRows(g)) {
    const roleProgress = progressByRole.get(role.id);
    const done = resolution
      ? stableByRole.get(role.id) === true
      : roleProgress ? !!roleProgress.ready : !!owner?.ready;
    const autopilot = !resolution && (
      roleProgress ? !!roleProgress.autopilot : owner?.connected === false && done
    );
    const failed = resolution && stableByRole.get(role.id) === false;
    const card = document.createElement("div");
    card.className = "tv-console" + (done ? " done" : "")
      + (failed ? " failed" : "") + (autopilot ? " autopilot" : "");
    card.dataset.role = role.id;
    card.style.setProperty("--role", role.color);
    const icon = document.createElement("span");
    icon.className = "tv-console-icon";
    icon.textContent = role.icon;
    const copy = document.createElement("p");
    const title = document.createElement("b");
    title.textContent = role.title;
    const status = document.createElement("small");
    status.textContent = failed ? "UNSTABLE"
      : autopilot ? (done ? "AUTOPILOT SECURED" : "AUTOPILOT ENGAGING")
        : done ? "CONSOLE LOCKED"
          : owner?.connected === false ? "SIGNAL LOST" : `${owner?.name || "CREW"} WORKING`;
    copy.append(title, status);
    const avatar = personAvatar("tv-console-owner", owner);
    card.append(icon, copy, avatar);
    host.appendChild(card);
  }
}
function renderCrisis(st) {
  show("tv-crisis");
  const g = st.game || {};
  const crisis = g.crisis || {};
  $("tv-crisis-count").textContent = `CRISIS ${g.round || 1} / ${g.rounds || 1}`;
  $("tv-crisis-class").textContent = (crisis.system || "PRIORITY ALERT").toUpperCase();
  $("tv-crisis-title").textContent = `${crisis.icon ? `${crisis.icon} ` : ""}${crisis.title || "UNKNOWN SIGNAL"}`;
  $("tv-crisis-public").textContent = publicCrisisCopy(crisis);
  const hull = integrity(g);
  $("tv-hull-number").textContent = `${hull.pct}%`;
  $("tv-hull-fill").style.width = `${hull.pct}%`;
  $("tv-signal-number").textContent = g.progress?.ready ?? 0;
  renderConsoleGrid(g);
  const progress = g.progress || { ready: 0, total: 5 };
  $("tv-command-copy").textContent = `${progress.ready}/${progress.total} CONSOLES LOCKED · TALK TO YOUR CREW`;
}

/* ---------- incident report ---------- */
function renderResolutionCrew(host, g) {
  host.textContent = "";
  const stable = new Map((g.resolution?.systems || []).map((system) => [system.role, system.stable]));
  for (const p of roster()) {
    const assigned = (p.roles || []).map(roleId);
    const ok = assigned.every((role) => stable.get(role) !== false);
    const person = document.createElement("div");
    person.className = "resolution-person" + (ok ? "" : " missed");
    const avatar = personAvatar("brief-avatar", p);
    const mark = document.createElement("i");
    mark.textContent = ok ? "✓" : "!";
    person.append(avatar, mark);
    host.appendChild(person);
  }
}
function renderResolution(st) {
  show("tv-resolution");
  const g = st.game || {};
  const result = g.resolution || {};
  const cleared = !!result.cleared;
  $("tv-resolution").classList.toggle("failed", !cleared);
  $("tv-resolution-kicker").textContent = cleared ? "CRISIS CONTAINED" : result.timed_out ? "SIGNAL TIMED OUT" : "HULL IMPACT";
  $("tv-resolution-title").textContent = cleared ? "THE SHIP HELD" : "THE SIGNAL BROKE";
  $("tv-resolution-copy").textContent = cleared
    ? `${result.stabilized || 0} of ${result.total || 5} systems stabilized.`
    : `${result.stabilized || 0} of ${result.total || 5} systems answered before impact.`;
  renderResolutionCrew($("tv-resolution-crew"), g);
  $("tv-resolution-hull").textContent = `${integrity(g).pct}%`;
  $("tv-resolution-signal").textContent = `${result.stabilized || 0}/${result.total || 5}`;
  const key = `${g.round}:${cleared}:${g.integrity}:${result.stabilized}`;
  if (key !== S.lastResolutionKey) {
    S.lastResolutionKey = key;
    cue(cleared ? "success" : "error");
    flash(cleared ? "SIGNAL HELD" : "HULL IMPACT", 950);
  }
}

/* ---------- final synchronized hold ---------- */
function renderSync(st) {
  show("tv-sync");
  const g = st.game || {};
  const final = g.final || {};
  const held = new Set(final.held || []);
  $("tv-sync-title").textContent = final.synchronized ? "SIGNAL LOCKED" : "HOLD TOGETHER";
  $("tv-sync-copy").textContent = final.holding
    ? "Carrier wave aligned. Do not let go."
    : "Every crew member: hold the carrier wave on your phone.";
  const host = $("tv-sync-crew");
  host.textContent = "";
  for (const p of roster()) {
    const active = held.has(p.pid);
    const card = document.createElement("div");
    card.className = "tv-sync-person" + (active ? " holding" : "");
    const avatar = personAvatar("brief-avatar", p);
    const name = document.createElement("b");
    name.textContent = p.name || "CREW";
    const status = document.createElement("small");
    status.textContent = active ? (p.connected === false ? "AUTO-LINKED" : "LINKED") : "WAITING";
    card.append(avatar, name, status);
    host.appendChild(card);
  }
  const needed = Number(final.needed || roster().length || 3);
  $("tv-sync-note").textContent = `${held.size} / ${needed} SIGNALS LINKED`;
  $("tv-sync-main").classList.toggle("all-linked", held.size >= needed);
}

/* ---------- team ending ---------- */
function resultCrew(result) {
  return Array.isArray(result?.crew) && result.crew.length ? result.crew : roster();
}
function addEndStat(host, label, value) {
  const item = document.createElement("span");
  const small = document.createElement("small");
  small.textContent = label;
  const strong = document.createElement("b");
  strong.textContent = value;
  item.append(small, strong);
  host.appendChild(item);
}
function renderEnd(st) {
  show("tv-end");
  const g = st.game || {};
  const result = g.result || {};
  const won = !!result.won;
  $("tv-end").classList.toggle("failed", !won);
  $("tv-end-kicker").textContent = won ? "TRANSMISSION COMPLETE" : "MISSION REPORT";
  $("tv-end-title").textContent = result.title || (won ? "THE FIFTH SIGNAL IS LIVE" : "SIGNAL INTERRUPTED");
  $("tv-end-copy").textContent = result.message || "Your crew map is intact and the next transmission will be different.";
  const host = $("tv-end-crew");
  host.textContent = "";
  for (const p of resultCrew(result)) {
    const person = document.createElement("div");
    person.className = "tv-end-person";
    const avatar = personAvatar("end-avatar", p);
    const name = document.createElement("b");
    name.textContent = p.name || "CREW";
    const commendation = document.createElement("small");
    commendation.textContent = p.commendation || (p.roles || []).map((role) => roleMeta(role).title).join(" + ");
    person.append(avatar, name, commendation);
    host.appendChild(person);
  }
  const stats = $("tv-end-stats");
  stats.textContent = "";
  addEndStat(stats, "CREW SCORE", Number(result.score || 0).toLocaleString());
  addEndStat(stats, "CRISES CLEARED", `${result.crises_cleared ?? 0}/${g.rounds || (result.length === "full" ? 5 : 3)}`);
  addEndStat(stats, "HULL", `${Math.round((Number(result.integrity || 0) / Math.max(1, Number(g.integrity_max || result.integrity || 1))) * 100)}%`);
  const key = JSON.stringify(result);
  if (key !== S.lastEndKey) {
    S.lastEndKey = key;
    cue(won ? "success" : "error");
    if (won) Hub.confettiBurst(340);
  }
}

function onState(st) {
  const prior = S.st?.phase || "";
  S.st = st;
  switch (st.phase) {
    case "lobby":
    case "countdown":
      S.lastRound = 0;
      S.lastResolutionKey = "";
      S.lastEndKey = "";
      renderLobby(st);
      break;
    case "briefing": renderBriefing(st); break;
    case "crisis": renderCrisis(st); break;
    case "resolution": renderResolution(st); break;
    case "final_sync": renderSync(st); break;
    case "game_end": renderEnd(st); break;
    default: renderLobby(st);
  }
  if (prior !== st.phase) {
    if (st.phase === "briefing") {
      cue("select");
      flash(`CRISIS ${st.game?.round || 1}`, 850);
    } else if (st.phase === "crisis") {
      cue("error");
    } else if (st.phase === "final_sync") {
      cue("select");
      flash("FINAL SIGNAL", 1050);
    }
  }
  if (st.phase === "crisis" && st.game?.round !== S.lastRound) {
    S.lastRound = st.game?.round || 0;
    flash(st.game?.crisis?.title || "CRISIS LIVE", 900);
  }
  S.lastPhase = st.phase;
}
function onFx(fx) {
  if (fx.kind === "console_ready") cue("select");
  else if (fx.kind === "autopilot") {
    Hub.toast("AUTOPILOT SECURED A LOST CONSOLE");
    cue("tap");
  } else if (fx.kind === "sync") {
    cue(fx.down ? "select" : "tap");
  } else if (fx.kind === "toast" && fx.msg) {
    Hub.toast(`${fx.icon ? `${fx.icon} ` : ""}${fx.msg}`);
  }
}

function updateClock() {
  const st = S.st;
  const remaining = st?.deadline && S.conn
    ? Math.max(0, Math.ceil((st.deadline - S.conn.now()) / 1000)) : null;
  if (st?.phase === "crisis") {
    $("tv-clock").textContent = remaining == null ? "LIVE" : String(remaining);
    $("tv-clock").style.color = remaining != null && remaining <= 10 ? "var(--danger)" : "";
  } else if (st?.phase === "final_sync") {
    $("tv-sync-clock").textContent = st.game?.final?.holding
      ? `LOCK ${remaining == null ? "" : remaining}` : remaining == null ? "LINK NOW" : `${remaining}s`;
  }
  requestAnimationFrame(updateClock);
}
requestAnimationFrame(updateClock);

S.conn = Hub.connect("/games/fifthsignal/ws", { onState, onFx }, { watch: true });
window.__fifthSignalTV = {
  state: () => S.st,
  assignmentRows: () => assignmentRows(game()),
  integrity,
  missionCode,
};
