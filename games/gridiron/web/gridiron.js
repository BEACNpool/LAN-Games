/* GRIDIRON phone — private playbook and body-driven football controller. */
"use strict";

const $ = (id) => document.getElementById(id);
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const norm = (value) => String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
const finite = (value) => Number.isFinite(Number(value));
const asNumber = (value, fallback = 0) => finite(value) ? Number(value) : fallback;
const reduceMotion = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const ROLE_META = {
  qb:  { title: "QUARTERBACK", icon: "◎", control: "qb", color: "#c8ff69",
         copy: "Read the TV. Tap the receiver who breaks open." },
  rb:  { title: "RUNNING BACK", icon: "↯", control: "carrier", color: "#ffca57",
         copy: "Lean to steer through the lane. Tap to dive." },
  wr:  { title: "RECEIVER", icon: "↑", control: "receiver", color: "#48e0ad",
         copy: "Run your route. Raise the phone when the ball arrives." },
  wr1: { title: "RECEIVER 1", icon: "↑", control: "receiver", color: "#48e0ad",
         copy: "Run your route. Raise the phone when the ball arrives." },
  wr2: { title: "RECEIVER 2", icon: "↑", control: "receiver", color: "#48e0ad",
         copy: "Run your route. Raise the phone when the ball arrives." },
  cb:  { title: "CORNERBACK", icon: "✕", control: "defender", color: "#ff7a66",
         copy: "Angle your pursuit. Time the dive tackle to the TV cue." },
  lb:  { title: "LINEBACKER", icon: "◆", control: "defender", color: "#ff7a66",
         copy: "Close the running lane. Time the tackle, not the vibration." },
  dl:  { title: "PASS RUSHER", icon: "▰", control: "defender", color: "#ff7a66",
         copy: "Collapse the pocket. Watch the TV for your attack lane." },
  s:   { title: "SAFETY", icon: "◇", control: "defender", color: "#ff7a66",
         copy: "Protect the deep field, then close on the ball." },
  crowd: { title: "SIDELINE", icon: "▣", control: "watch", color: "#8b96b3",
           copy: "Look up and make noise for your side." },
  bench: { title: "SIDELINE", icon: "▣", control: "watch", color: "#8b96b3",
           copy: "Look up. Your next assignment is coming." },
};

const S = {
  st: null,
  conn: null,
  pid: null,
  joined: false,
  lastPhase: "",
  possessionKey: "",
  controlKey: "",
  selectedLocal: null,
  swapOpen: false,
  scrambleLocal: false,
  liveCue: "BALL IS LIVE",
  liveStartedAt: 0,
  actions: new Set(),
  gameoverKey: "",
  wakeLock: null,
  steer: {
    value: 0,
    pending: null,
    sent: null,
    lastSentAt: 0,
    timer: null,
    pointer: null,
  },
  sensors: {
    status: "gated",
    requestId: 0,
    orientationHandler: null,
    motionHandler: null,
    orientationSeen: false,
    motionSeen: false,
    current: null,
    baseline: null,
    baselineSamples: [],
    gravity: null,
    watchdog: null,
    lastRaiseAt: 0,
    raiseEnergy: 0,
  },
};

const game = (st = S.st) => st?.game || null;
const players = () => S.st?.players || [];
const playerByPid = (pid) => players().find((p) => p.pid === pid) || null;

function ownSources() {
  const g = game() || {};
  return [g.me, g.you, g.private, g.assignment, S.st?.you, g]
    .filter((item) => item && typeof item === "object" && !Array.isArray(item));
}
function ownField(...keys) {
  for (const source of ownSources()) {
    for (const key of keys) {
      if (source[key] !== undefined && source[key] !== null) return source[key];
    }
  }
  return undefined;
}
function roleCode(raw = ownField("role", "my_role", "position")) {
  if (raw && typeof raw === "object") raw = raw.id ?? raw.role ?? raw.code ?? raw.name;
  const role = norm(raw);
  if (role === "wide_receiver" || role === "receiver") return "wr";
  if (role === "running_back" || role === "halfback" || role === "ball_carrier") return "rb";
  if (role === "quarterback") return "qb";
  if (role === "corner" || role === "cornerback") return "cb";
  if (role === "linebacker") return "lb";
  if (role === "defensive_line" || role === "defensive_lineman" || role === "rusher") return "dl";
  if (role === "safety") return "s";
  return role || "bench";
}
function roleMeta(role = roleCode()) {
  return ROLE_META[role] || {
    title: String(role || "SIDELINE").replaceAll("_", " ").toUpperCase(),
    icon: "◆",
    control: "watch",
    color: "#8b96b3",
    copy: "Watch the TV for your assignment.",
  };
}
function myTeamKey() {
  const team = ownField("team", "team_id", "side");
  if (team && typeof team === "object") return String(team.id ?? team.key ?? team.name ?? "");
  return team == null ? "" : String(team);
}
function offenseTeamKey(g = game() || {}) {
  const value = g.offense_team ?? g.offense ?? g.possession_team
    ?? g.possession?.team ?? g.possession?.team_id;
  if (value && typeof value === "object") return String(value.id ?? value.key ?? value.name ?? "");
  return value == null ? "" : String(value);
}
function sideName() {
  const explicit = norm(ownField("side", "unit"));
  if (explicit === "offense" || explicit === "defense") return explicit;
  const mine = myTeamKey(), offense = offenseTeamKey();
  if (mine && offense) return mine === offense ? "offense" : "defense";
  return ["qb", "rb", "wr", "wr1", "wr2"].includes(roleCode()) ? "offense" : "defense";
}

function phaseOf(st = S.st) {
  if (!st) return "lobby";
  if (["lobby", "countdown", "game_end"].includes(st.phase)) return st.phase;
  const raw = norm(st.game?.phase ?? st.game?.stage ?? st.phase);
  if (["huddle", "setup", "live", "whistle"].includes(raw)) return raw;
  if (["pre_snap", "presnap", "formation"].includes(raw)) return "setup";
  if (["play", "playing", "action"].includes(raw)) return "live";
  if (["dead_ball", "post_play", "result", "replay"].includes(raw)) return "whistle";
  return raw || "huddle";
}
function possessionId(g = game() || {}) {
  const value = g.possession_no ?? g.possession_number ?? g.possession?.number
    ?? g.possession ?? g.drive ?? g.series ?? 0;
  const possession = typeof value === "object"
    ? String(value.number ?? value.id ?? 0) : String(value);
  const down = String(g.down ?? g.situation?.down ?? 0);
  return `${possession}:${down}`;
}
function participantState() {
  const explicit = ownField("participant", "playing", "active_player");
  if (explicit === false) return false;
  if (game()?.spectator === true || ownField("spectator") === true) return false;
  return !!roleCode() && roleCode() !== "bench" || explicit === true;
}

function controlMode() {
  const g = game() || {};
  const explicitRaw = ownField("control", "control_mode", "live_control", "controller");
  let explicit = explicitRaw && typeof explicitRaw === "object"
    ? norm(explicitRaw.kind ?? explicitRaw.mode ?? explicitRaw.id)
    : norm(explicitRaw);
  const aliases = {
    call_play: "watch",
    quarterback: "qb",
    run: "carrier",
    runner: "carrier",
    ball_carrier: "carrier",
    pursuit: "defender",
    pursue: "defender",
    coverage: "defender",
    pass: "qb",
    passer: "qb",
    route: "receiver",
    catch: "receiver",
    spectator: "watch",
    idle: "watch",
  };
  explicit = aliases[explicit] || explicit;

  if (S.scrambleLocal && roleCode() === "qb") return "carrier";
  if (explicit) return explicit;

  // Legacy engines may not send an explicit personalized control. Only then
  // infer it from the public ball/defender snapshot. GRIDIRON's authoritative
  // `me.control` must win: the QB holds the pre-throw ball but is still a QB,
  // not a carrier, until SCRAMBLE succeeds.
  const carrierPid = g.ball_carrier_pid ?? g.carrier_pid ?? g.ball?.carrier_pid;
  if (carrierPid && carrierPid === S.pid) return "carrier";
  if (ownField("has_ball", "is_ball_carrier", "is_carrier") === true) return "carrier";

  const activeDefender = g.active_defender_pid ?? g.nearest_defender_pid;
  if (activeDefender && activeDefender !== S.pid && ["cb", "lb", "dl", "s"].includes(roleCode())) {
    return "watch";
  }
  if (ownField("active_defender", "can_pursue", "is_nearest_defender") === false) return "watch";
  return roleMeta().control;
}

function normalizeTeams(g = game() || {}) {
  let entries = [];
  if (Array.isArray(g.teams)) {
    entries = g.teams.map((team, index) => [String(team?.id ?? team?.key ?? index), team || {}]);
  } else if (g.teams && typeof g.teams === "object") {
    entries = Object.entries(g.teams);
  } else {
    entries = [
      ["home", g.home && typeof g.home === "object" ? g.home : {}],
      ["away", g.away && typeof g.away === "object" ? g.away : {}],
    ];
  }
  if (entries.length < 2) entries.push(["away", {}]);
  return entries.slice(0, 2).map(([key, raw], index) => {
    const team = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const scores = g.scores && typeof g.scores === "object" ? g.scores : {};
    const score = team.score ?? scores[key]
      ?? (index === 0 ? g.home_score : g.away_score) ?? 0;
    return {
      key: String(team.id ?? team.key ?? key),
      name: String(team.name ?? team.label ?? (index === 0 ? "HOME" : "AWAY")),
      score: asNumber(score),
      players: team.players ?? team.roster ?? (Array.isArray(raw) ? raw : []),
    };
  });
}

function show(id) {
  for (const screen of ["scr-join", "scr-lobby", "scr-game"]) {
    $(screen).hidden = screen !== id;
  }
}
function announce(message) {
  const host = $("game-status");
  if (!host || !message) return;
  if (host.textContent === message) {
    host.textContent = "";
    requestAnimationFrame(() => { host.textContent = message; });
  } else {
    host.textContent = message;
  }
}
function feedback(kind, haptic) {
  try { Hub.feedback?.[kind]?.(); } catch (error) { /* optional */ }
  if (haptic !== undefined) {
    try { Hub.feedback?.haptic?.(haptic); } catch (error) { /* Android bonus only */ }
  }
}
function celebrate(amount = 160) {
  if (!reduceMotion()) Hub.confettiBurst(amount);
}
function send(message) {
  S.conn?.send(message);
}

/* ---------- motion permission, tilt, raise-to-catch ---------- */

function sensorCapability() {
  if (!window.isSecureContext) {
    return { ok: false, note: "Motion needs HTTPS. Every touch control still works." };
  }
  if (typeof window.DeviceOrientationEvent === "undefined"
      && typeof window.DeviceMotionEvent === "undefined") {
    return { ok: false, note: "No motion sensor found. Every touch control still works." };
  }
  return { ok: true, note: "Tilt and raise gestures are optional." };
}
function setSensorStatus(status, note = "") {
  S.sensors.status = status;
  document.body.classList.toggle("motion-reading", status === "reading");
  document.body.classList.toggle("motion-active", status === "active");
  document.body.classList.toggle("motion-fallback", status === "fallback");

  const copy = {
    gated: ["ENABLE MOTION", note || "Tilt and raise gestures are optional."],
    reading: ["READING SENSOR…", note || "Hold your phone still for a moment."],
    active: ["MOTION READY", note || "Motion is live. Touch controls stay available."],
    fallback: ["TOUCH MODE", note || "Motion is unavailable. Touch controls are fully active."],
  }[status] || ["MOTION", note];
  document.querySelectorAll("[data-motion-title]").forEach((node) => { node.textContent = copy[0]; });
  document.querySelectorAll("[data-motion-note]").forEach((node) => { node.textContent = copy[1]; });
  document.querySelectorAll("[data-enable-motion]").forEach((button) => {
    button.disabled = status === "reading" || status === "active";
    const label = status === "active" ? "READY" : status === "reading" ? "READING…" : status === "fallback" ? "RETRY" : "ENABLE";
    const bold = button.querySelector("b");
    if (bold) bold.textContent = status === "active" ? "MOTION READY" : status === "reading" ? "READING SENSOR…" : status === "fallback" ? "RETRY MOTION" : "ENABLE MOTION";
    else button.textContent = label;
  });
  $("recenter-btn").hidden = status !== "active";
}
function detachSensors() {
  if (S.sensors.orientationHandler) {
    window.removeEventListener("deviceorientation", S.sensors.orientationHandler);
  }
  if (S.sensors.motionHandler) {
    window.removeEventListener("devicemotion", S.sensors.motionHandler);
  }
  clearTimeout(S.sensors.watchdog);
  S.sensors.orientationHandler = null;
  S.sensors.motionHandler = null;
  S.sensors.watchdog = null;
}
function usefulSensorReading(kind) {
  if (kind === "orientation") S.sensors.orientationSeen = true;
  if (kind === "motion") S.sensors.motionSeen = true;
  if (S.sensors.status === "reading") {
    setSensorStatus("active", "Motion is live. Touch controls stay available.");
    feedback("success", 18);
  }
}
function angleDelta(value, baseline) {
  return ((value - baseline + 540) % 360) - 180;
}
function steeringFromOrientation(
  current,
  baseline,
  rawAngle = screen.orientation?.angle ?? window.orientation ?? 0,
) {
  const angle = ((Number(rawAngle) || 0) % 360 + 360) % 360;
  if (angle === 90 || angle === 270) {
    const sign = angle === 90 ? 1 : -1;
    return clamp(angleDelta(current.beta, baseline.beta) / 30 * sign, -1, 1);
  }
  return clamp(angleDelta(current.gamma, baseline.gamma) / 30, -1, 1);
}
function onOrientation(event) {
  if (!Number.isFinite(event.gamma) || !Number.isFinite(event.beta)) return;
  const current = { gamma: event.gamma, beta: event.beta };
  S.sensors.current = current;
  usefulSensorReading("orientation");

  const phase = phaseOf();
  if (phase === "setup") {
    S.sensors.baselineSamples.push(current);
    if (S.sensors.baselineSamples.length > 16) S.sensors.baselineSamples.shift();
  }
  if (phase !== "live") return;
  if (!S.sensors.baseline) S.sensors.baseline = { ...current };
  if (!["carrier", "defender"].includes(controlMode())) return;
  queueSteer(steeringFromOrientation(current, S.sensors.baseline));
}
function accelerationEnergy(event) {
  const linear = event.acceleration;
  if (linear && [linear.x, linear.y, linear.z].some(Number.isFinite)) {
    return Math.hypot(linear.x || 0, linear.y || 0, linear.z || 0);
  }
  const gravity = event.accelerationIncludingGravity;
  if (!gravity || ![gravity.x, gravity.y, gravity.z].every(Number.isFinite)) return null;
  const current = { x: gravity.x, y: gravity.y, z: gravity.z };
  if (!S.sensors.gravity) {
    S.sensors.gravity = current;
    return 0;
  }
  const energy = Math.hypot(
    current.x - S.sensors.gravity.x,
    current.y - S.sensors.gravity.y,
    current.z - S.sensors.gravity.z,
  );
  if (energy < 2.2) {
    S.sensors.gravity = {
      x: S.sensors.gravity.x * .9 + current.x * .1,
      y: S.sensors.gravity.y * .9 + current.y * .1,
      z: S.sensors.gravity.z * .9 + current.z * .1,
    };
  }
  return energy;
}
function onMotion(event) {
  const energy = accelerationEnergy(event);
  if (energy == null) return;
  usefulSensorReading("motion");
  S.sensors.raiseEnergy = clamp(Math.max(S.sensors.raiseEnergy, energy / 7), 0, 1);

  const now = performance.now();
  if (phaseOf() !== "live" || controlMode() !== "receiver") return;
  if (now - S.liveStartedAt < 300 || now - S.sensors.lastRaiseAt < 900) return;
  if (energy >= 5.2) {
    S.sensors.lastRaiseAt = now;
    triggerAction("catch");
    announce("Catch attempt sent. Look at the TV.");
  }
}
function attachSensors() {
  detachSensors();
  S.sensors.orientationSeen = false;
  S.sensors.motionSeen = false;
  S.sensors.current = null;
  S.sensors.gravity = null;
  S.sensors.orientationHandler = onOrientation;
  S.sensors.motionHandler = onMotion;
  window.addEventListener("deviceorientation", S.sensors.orientationHandler, { passive: true });
  window.addEventListener("devicemotion", S.sensors.motionHandler, { passive: true });
  S.sensors.watchdog = setTimeout(() => {
    if (!S.sensors.orientationSeen && !S.sensors.motionSeen) {
      detachSensors();
      setSensorStatus("fallback", "No useful reading arrived. Touch controls are fully active.");
      Hub.toast("No motion reading. Touch controls are ready.", "err");
    }
  }, 2500);
}
function requestSensorsFromGesture() {
  const capability = sensorCapability();
  if (!capability.ok) {
    setSensorStatus("fallback", capability.note);
    Hub.toast(capability.note, "err");
    return;
  }
  if (S.sensors.status === "reading" || S.sensors.status === "active") return;
  const requestId = ++S.sensors.requestId;
  setSensorStatus("reading");

  /*
   * Both iOS permission functions are invoked now, in this same click stack.
   * Do not put an await between them: WebKit can consume the user activation.
   */
  let requests;
  try {
    const gates = [window.DeviceMotionEvent, window.DeviceOrientationEvent]
      .filter((SensorEvent) => SensorEvent
        && typeof SensorEvent.requestPermission === "function");
    requests = gates.map((SensorEvent) => SensorEvent.requestPermission());
  } catch (error) {
    setSensorStatus("fallback", "Motion permission failed. Touch controls are fully active.");
    Hub.toast("Motion permission failed. Use touch controls.", "err");
    return;
  }

  Promise.all(requests).then((results) => {
    if (requestId !== S.sensors.requestId) return;
    if (results.some((result) => result !== "granted")) {
      throw new Error("Motion was not allowed. Touch controls are fully active.");
    }
    attachSensors();
    S.sensors.baselineSamples = [];
    S.sensors.baseline = null;
  }).catch((error) => {
    if (requestId !== S.sensors.requestId) return;
    detachSensors();
    setSensorStatus("fallback", error.message || "Motion unavailable. Touch controls are fully active.");
    Hub.toast(error.message || "Motion unavailable. Use touch controls.", "err");
  });
}
function beginBaselineCapture() {
  S.sensors.baseline = null;
  S.sensors.baselineSamples = [];
  if (S.sensors.current) S.sensors.baselineSamples.push({ ...S.sensors.current });
}
function freezeBaseline() {
  const samples = S.sensors.baselineSamples;
  if (samples.length) {
    S.sensors.baseline = {
      gamma: samples.reduce((sum, sample) => sum + sample.gamma, 0) / samples.length,
      beta: samples.reduce((sum, sample) => sum + sample.beta, 0) / samples.length,
    };
  } else if (S.sensors.current) {
    S.sensors.baseline = { ...S.sensors.current };
  }
}
function recenterMotion() {
  if (!S.sensors.current) {
    Hub.toast("Hold still until the sensor reads your phone.", "err");
    return;
  }
  S.sensors.baseline = { ...S.sensors.current };
  S.sensors.baselineSamples = [{ ...S.sensors.current }];
  queueSteer(0);
  feedback("select", 14);
  Hub.toast("Steering center captured.");
}

document.querySelectorAll("[data-enable-motion]").forEach((button) => {
  button.addEventListener("click", requestSensorsFromGesture);
});
$("recenter-btn").addEventListener("click", recenterMotion);
setSensorStatus("gated", sensorCapability().note);

/* ---------- wake lock ---------- */

async function ensureWakeLock() {
  if (!S.joined || document.hidden || !("wakeLock" in navigator) || !window.isSecureContext) return;
  if (S.wakeLock && !S.wakeLock.released) return;
  try {
    S.wakeLock = await navigator.wakeLock.request("screen");
    S.wakeLock.addEventListener("release", () => { S.wakeLock = null; });
  } catch (error) { /* Touch and gameplay do not depend on Wake Lock. */ }
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    S.wakeLock = null;
    queueSteer(0);
  } else {
    ensureWakeLock();
  }
});
window.addEventListener("pagehide", () => {
  clearTimeout(S.steer.timer);
  try { S.wakeLock?.release(); } catch (error) { /* optional */ }
});

/* ---------- join + lobby ---------- */

let avatarPick = Hub.identity.avatar || Hub.AVATARS[0];
Hub.buildAvatarGrid($("avatar-grid"), avatarPick, (avatar) => {
  avatarPick = avatar;
  feedback("tap", 8);
});
$("name-input").value = Hub.identity.name || "";
Hub.wirePfpButton($("pfp-btn"), () => S.conn);
Hub.wirePfpButton($("pfp-btn2"), () => S.conn);

function renderPlayerCard(player) {
  const card = document.createElement("div");
  card.className = "player-card";
  if (player.ready) card.classList.add("is-ready");
  if (player.connected === false) card.classList.add("is-away");
  const avatar = document.createElement("span");
  avatar.className = "pc-avatar";
  Hub.fillAvatar(avatar, player);
  const copy = document.createElement("span");
  copy.className = "pc-copy";
  const name = document.createElement("span");
  name.className = "pc-name";
  name.textContent = `${player.name || "PLAYER"}${player.pid === S.pid ? " · YOU" : ""}`;
  const status = document.createElement("span");
  status.className = "pc-status" + (player.ready ? " rdy" : "");
  status.textContent = player.connected === false ? "SIGNAL LOST"
    : player.ready ? "READY" : "LOCKER ROOM";
  copy.append(name, status);
  card.append(avatar, copy);
  return card;
}
function settingKey(settings, candidates, fallback) {
  return candidates.find((key) => Object.prototype.hasOwnProperty.call(settings, key)) || fallback;
}
function renderSegment(hostId, key, options, current) {
  const host = $(hostId);
  host.textContent = "";
  options.forEach(([value, label]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.className = value === current ? "sel" : "";
    button.setAttribute("aria-pressed", value === current ? "true" : "false");
    button.onclick = () => {
      feedback("select", 10);
      send({ t: "settings", patch: { [key]: value } });
    };
    host.appendChild(button);
  });
}
function assistOptions(key, current) {
  if (typeof current === "boolean") return [[true, "WIDE"], [false, "STD"]];
  if (key === "difficulty") {
    if (["easy", "normal"].includes(current)) return [["easy", "WIDE"], ["normal", "STD"]];
    if (["rookie", "standard"].includes(current)) return [["rookie", "WIDE"], ["standard", "STD"]];
    return [["family", "WIDE"], ["standard", "STD"]];
  }
  if (current === "family") return [["family", "WIDE"], ["standard", "STD"]];
  return [["wide", "WIDE"], ["standard", "STD"]];
}
function renderLobby(st) {
  const humans = (st.players || []).filter((player) => !player.bot && !player.is_bot);
  const ready = humans.filter((player) => player.ready && player.connected !== false).length;
  $("ready-count").textContent = `${ready}/${humans.length || 1} READY`;
  const grid = $("player-grid");
  grid.textContent = "";
  humans.forEach((player) => grid.appendChild(renderPlayerCard(player)));
  $("roster-note").textContent = humans.length === 1
    ? "Solo is live · bots fill both sidelines."
    : `${humans.length}/8 players · roles rotate every possession.`;

  const settings = st.settings || {};
  const possessionKey = settingKey(settings,
    ["possessions", "total_possessions", "possession_count"], "possessions");
  const possessionValue = asNumber(settings[possessionKey], 6);
  renderSegment("opt-possessions", possessionKey, [[4, "4"], [6, "6"], [8, "8"]], possessionValue);
  $("possessions-note").textContent = possessionValue <= 4 ? "a quick 7–9 minute game"
    : possessionValue >= 8 ? "a full 13–16 minute game" : "a 10–12 minute game";

  const assistKey = settingKey(settings, ["assist", "assists", "assist_mode", "difficulty"], "assist");
  const assistValue = settings[assistKey] ?? true;
  renderSegment("opt-assist", assistKey, assistOptions(assistKey, assistValue), assistValue);
  const wide = assistValue === true || ["wide", "family", "easy", "rookie"].includes(assistValue);
  $("assist-note").textContent = wide ? "generous timing windows" : "standard timing windows";

  const readyButton = $("ready-btn");
  const amReady = !!st.you?.ready;
  readyButton.textContent = amReady ? "READY ✓" : "READY UP";
  readyButton.classList.toggle("is-ready", amReady);
  const minPlayers = st.min_players ?? 1;
  const canStart = st.phase === "lobby" && amReady && ready >= minPlayers;
  readyButton.hidden = canStart;
  $("start-btn").hidden = !canStart;
  $("lobby-hint").textContent = st.phase === "countdown" ? "breaking the huddle…"
    : ready < minPlayers ? `need ${minPlayers - ready} more ready`
      : canStart ? "any ready player can start" : "ready up when you’re set";
}

$("join-btn").onclick = () => {
  feedback("select", 20);
  Hub.identity.name = $("name-input").value.trim() || "PLAYER";
  Hub.identity.avatar = avatarPick;
  S.joined = true;
  connect();
  ensureWakeLock();
  show("scr-lobby");
};
$("name-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") $("join-btn").click();
});
$("ready-btn").onclick = () => {
  feedback("select", 20);
  ensureWakeLock();
  send({ t: "ready", ready: !S.st?.you?.ready });
};
$("start-btn").onclick = () => {
  feedback("success", [30, 25, 55]);
  ensureWakeLock();
  send({ t: "start" });
};
$("rematch-btn").onclick = () => {
  feedback("select", 18);
  send({ t: "again" });
  $("gameover").hidden = true;
};

/* ---------- game chrome ---------- */

function situation(g = game() || {}) {
  const down = asNumber(g.down ?? g.situation?.down, 1);
  const distanceRaw = g.distance ?? g.to_go ?? g.situation?.distance ?? 10;
  const distance = String(distanceRaw).toLowerCase() === "goal" ? "GOAL" : Math.max(1, asNumber(distanceRaw, 10));
  const ordinal = down === 1 ? "1ST" : down === 2 ? "2ND" : down === 3 ? "3RD" : "4TH";
  const possession = asNumber(g.possession_no ?? g.possession_number ?? g.possession?.number, 1);
  const total = asNumber(g.possessions_total ?? g.total_possessions ?? g.max_possessions
    ?? S.st?.settings?.possessions, 6);
  const yard = asNumber(g.yard_line ?? g.yard ?? g.ball?.yard_line ?? g.situation?.yard_line, 50);
  return { down, distance, ordinal, possession, total, yard };
}
function updateScoreboard() {
  const g = game() || {};
  const teams = normalizeTeams(g);
  $("home-label").textContent = teams[0].name.toUpperCase();
  $("home-score").textContent = teams[0].score;
  $("away-label").textContent = teams[1].name.toUpperCase();
  $("away-score").textContent = teams[1].score;
  const sit = situation(g);
  $("possession-label").textContent = `POSSESSION ${sit.possession} / ${sit.total}`;
  $("down-label").textContent = `${sit.ordinal} & ${sit.distance}`;
}
function updateAssignment() {
  const ownRole = roleCode();
  const meta = roleMeta(ownRole);
  const assignment = ownField("assignment_text", "instructions", "assignment", "directive");
  const assignmentText = typeof assignment === "string" ? assignment : meta.copy;
  $("assignment-card").style.setProperty("--role", meta.color);
  $("team-chip").textContent = sideName().toUpperCase();
  $("team-chip").style.setProperty("--role", meta.color);
  $("role-icon").textContent = meta.icon;
  $("role-title").textContent = meta.title;
  $("role-copy").textContent = assignmentText;
  $("role-instruction").textContent = phaseOf() === "huddle"
    ? "Keep this private. The other side cannot see your call or assignment."
    : controlMode() === "receiver"
      ? "Listen for the TV catch cue. Motion and the CATCH button do the same thing."
      : ["carrier", "defender"].includes(controlMode())
        ? "Your center was captured at the snap. Touch controls stay live below."
        : "Critical cues come from the TV. Keep your eyes on the field.";
}
function showPhasePanel(phase) {
  const ids = {
    huddle: "phase-huddle",
    setup: "phase-setup",
    live: "phase-live",
    whistle: "phase-whistle",
    sideline: "phase-sideline",
  };
  Object.values(ids).forEach((id) => { $(id).hidden = id !== ids[phase]; });
}
function updatePhaseRibbon(phase) {
  const ribbon = $("phase-ribbon");
  ribbon.className = `phase-ribbon ${phase}`;
  const labels = {
    huddle: ["HUDDLE", "CALL IT IN SECRET"],
    setup: ["BREAK", "HOLD STEADY"],
    live: ["BALL LIVE", "WATCH THE TV"],
    whistle: ["WHISTLE", "PLAY OVER"],
    game_end: ["FINAL", "GAME OVER"],
    sideline: ["SIDELINE", "WATCH THE TV"],
  };
  const copy = labels[phase] || [phase.toUpperCase(), "WATCH THE FIELD"];
  $("phase-label").textContent = copy[0];
  $("phase-note").textContent = copy[1];
}

/* ---------- huddle + hidden play cards ---------- */

function playCards() {
  const value = ownField("play_cards", "play_choices", "plays", "playbook", "available_plays");
  if (!Array.isArray(value)) return [];
  return value.map((raw, index) => {
    if (typeof raw === "string") return {
      id: raw, name: raw.replaceAll("_", " ").toUpperCase(), kind: "PLAY", detail: "Run the call on the TV.",
    };
    return {
      id: String(raw.id ?? raw.code ?? raw.play ?? index),
      name: String(raw.name ?? raw.title ?? raw.label ?? `PLAY ${index + 1}`),
      kind: String(raw.kind ?? raw.type ?? raw.family ?? (sideName() === "offense" ? "OFFENSE" : "DEFENSE")),
      detail: String(raw.detail ?? raw.description ?? raw.summary ?? raw.assignment ?? "Run the call on the TV."),
    };
  });
}
function selectedPlay() {
  const raw = ownField("selected_play", "my_play", "play_call", "called_play");
  const value = raw ?? S.selectedLocal;
  if (value && typeof value === "object") {
    return {
      id: String(value.id ?? value.code ?? value.play ?? ""),
      name: String(value.name ?? value.title ?? value.label ?? value.id ?? "PLAY LOCKED"),
    };
  }
  if (value == null || value === "") return null;
  const card = playCards().find((play) => play.id === String(value));
  return card || { id: String(value), name: String(value).replaceAll("_", " ").toUpperCase() };
}
function swapCandidates() {
  const direct = ownField("swap_targets", "role_swap_targets", "teammates");
  if (Array.isArray(direct)) return direct;
  const mine = myTeamKey();
  return players().filter((player) => {
    const team = player.team ?? player.team_id ?? player.side;
    return player.pid !== S.pid && !player.bot && !player.is_bot && (!mine || String(team) === mine);
  });
}
function renderSwapTargets() {
  const host = $("swap-targets");
  host.textContent = "";
  const targets = swapCandidates();
  if (!targets.length) {
    const note = document.createElement("p");
    note.className = "control-status";
    note.textContent = "No human teammate is available to swap.";
    host.appendChild(note);
    return;
  }
  targets.forEach((raw) => {
    const pid = String(raw.pid ?? raw.id ?? "");
    if (!pid) return;
    const player = playerByPid(pid) || raw;
    const role = roleCode(raw.role ?? raw.position);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "swap-target";
    const avatar = document.createElement("span");
    avatar.className = "av";
    Hub.fillAvatar(avatar, player);
    const copy = document.createElement("span");
    const name = document.createElement("b");
    name.textContent = player.name || "TEAMMATE";
    const detail = document.createElement("small");
    detail.textContent = role && role !== "bench" ? roleMeta(role).title : "TEAMMATE";
    copy.append(name, detail);
    const action = document.createElement("b");
    action.textContent = "SWAP";
    button.append(avatar, copy, action);
    button.onclick = () => {
      feedback("select", 18);
      send({ t: "swap_role", pid });
      S.swapOpen = false;
      $("swap-panel").hidden = true;
      Hub.toast(`Swap requested with ${player.name || "teammate"}.`);
    };
    host.appendChild(button);
  });
}
function renderHuddle() {
  showPhasePanel("huddle");
  $("playbook-title").textContent = sideName() === "offense" ? "CALL THE OFFENSE" : "CALL THE DEFENSE";
  $("huddle-copy").textContent = sideName() === "offense"
    ? "The defense cannot see your routes."
    : "The offense cannot see your coverage.";

  const selected = selectedPlay();
  const host = $("play-cards");
  host.textContent = "";
  host.hidden = !!selected;
  $("play-locked").hidden = !selected;
  if (selected) {
    $("locked-play-name").textContent = selected.name.toUpperCase();
  } else {
    const cards = playCards();
    cards.forEach((play) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "play-card";
      button.dataset.play = play.id;
      const kind = document.createElement("span");
      kind.className = "play-kind";
      kind.textContent = play.kind.toUpperCase();
      const title = document.createElement("b");
      title.textContent = play.name.toUpperCase();
      const detail = document.createElement("p");
      detail.textContent = play.detail;
      button.append(kind, title, detail);
      button.onclick = () => {
        S.selectedLocal = { id: play.id, name: play.name };
        feedback("select", [18, 20, 30]);
        send({ t: "call_play", play: play.id });
        announce(`${play.name} selected. Look at the TV.`);
        renderHuddle();
      };
      host.appendChild(button);
    });
    if (!cards.length) {
      const note = document.createElement("p");
      note.className = "control-status";
      note.textContent = "Your play caller is choosing. Keep this assignment private.";
      host.appendChild(note);
    }
  }

  $("swap-panel").hidden = !S.swapOpen;
  if (S.swapOpen) renderSwapTargets();
  const canSwap = ownField("can_swap", "role_swap_allowed");
  $("swap-open-btn").disabled = canSwap === false;
  $("swap-open-btn").textContent = canSwap === false ? "ROLE SWAP CLOSED" : "⇄ HUDDLE ROLE SWAP";
}
$("swap-open-btn").onclick = () => {
  S.swapOpen = !S.swapOpen;
  feedback("tap", 10);
  $("swap-panel").hidden = !S.swapOpen;
  if (S.swapOpen) renderSwapTargets();
};
$("swap-close-btn").onclick = () => {
  S.swapOpen = false;
  $("swap-panel").hidden = true;
};

/* ---------- live touch controls ---------- */

function paintSteer(value = S.steer.value) {
  S.steer.value = clamp(asNumber(value), -1, 1);
  const thumb = document.querySelector(".steer-thumb");
  if (thumb) thumb.style.transform = `translateX(${Math.round(S.steer.value * 122)}px)`;
  const output = document.querySelector("[data-steer-value]");
  if (output) {
    const abs = Math.abs(S.steer.value);
    output.textContent = abs < .08 ? "CENTER"
      : `${S.steer.value < 0 ? "LEFT" : "RIGHT"} ${Math.round(abs * 100)}%`;
  }
}
function flushSteer() {
  S.steer.timer = null;
  if (S.steer.pending == null) return;
  const value = Math.round(clamp(S.steer.pending, -1, 1) * 100) / 100;
  S.steer.pending = null;
  if (S.steer.sent !== null && Math.abs(value - S.steer.sent) < .03) return;
  S.steer.sent = value;
  S.steer.lastSentAt = performance.now();
  send({ t: "steer", x: value });
}
function queueSteer(value) {
  value = clamp(asNumber(value), -1, 1);
  S.steer.pending = value;
  paintSteer(value);
  if (S.steer.timer) return;
  const wait = Math.max(0, 100 - (performance.now() - S.steer.lastSentAt));
  S.steer.timer = setTimeout(flushSteer, wait);
}
function resetSteer() {
  clearTimeout(S.steer.timer);
  S.steer.timer = null;
  S.steer.pending = null;
  S.steer.sent = null;
  S.steer.lastSentAt = 0;
  paintSteer(0);
}
function triggerAction(kind, payload = {}) {
  // A throw can be rejected when its receiver closes between snapshots; keep
  // it retryable. Successful throws immediately switch the authoritative
  // control away from QB, so they do not need an optimistic one-shot lock.
  const single = ["dive", "tackle", "catch"].includes(kind);
  if (single && S.actions.has(kind)) return false;
  if (single) S.actions.add(kind);
  if (kind === "scramble") S.scrambleLocal = true;
  send({ t: kind, ...payload });
  feedback(kind === "tackle" ? "success" : "select",
    kind === "tackle" ? [28, 18, 48] : 18);
  updateLiveControl();
  return true;
}
function makeControlShell(kicker, title, copy) {
  const card = document.createElement("article");
  card.className = "control-card";
  const head = document.createElement("header");
  head.className = "control-head";
  const words = document.createElement("div");
  const small = document.createElement("small");
  small.textContent = kicker;
  const heading = document.createElement("h3");
  heading.textContent = title;
  words.append(small, heading);
  const badge = document.createElement("b");
  badge.textContent = S.sensors.status === "active" ? "MOTION + TOUCH" : "TOUCH READY";
  head.append(words, badge);
  const paragraph = document.createElement("p");
  paragraph.className = "control-copy";
  paragraph.textContent = copy;
  card.append(head, paragraph);
  return card;
}
function steerFromPointer(event, track) {
  const box = track.getBoundingClientRect();
  const x = ((event.clientX - box.left) / Math.max(1, box.width)) * 2 - 1;
  queueSteer(x);
}
function wireHoldSteer(button, value) {
  const down = (event) => {
    event.preventDefault();
    button.setPointerCapture?.(event.pointerId);
    queueSteer(value);
  };
  const up = (event) => {
    event.preventDefault();
    queueSteer(0);
  };
  button.addEventListener("pointerdown", down);
  button.addEventListener("pointerup", up);
  button.addEventListener("pointercancel", up);
  button.addEventListener("lostpointercapture", () => queueSteer(0));
}
function addSteering(card, label) {
  const shell = document.createElement("div");
  shell.className = "steer-shell";
  const readout = document.createElement("div");
  readout.className = "steer-readout";
  const left = document.createElement("span");
  left.textContent = "LEFT";
  const value = document.createElement("b");
  value.dataset.steerValue = "";
  value.textContent = "CENTER";
  const right = document.createElement("span");
  right.textContent = "RIGHT";
  readout.append(left, value, right);

  const track = document.createElement("div");
  track.className = "steer-track";
  track.setAttribute("role", "slider");
  track.setAttribute("aria-label", label);
  track.setAttribute("aria-valuemin", "-1");
  track.setAttribute("aria-valuemax", "1");
  const thumb = document.createElement("span");
  thumb.className = "steer-thumb";
  thumb.textContent = "↕";
  track.appendChild(thumb);
  track.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    S.steer.pointer = event.pointerId;
    track.setPointerCapture?.(event.pointerId);
    steerFromPointer(event, track);
  });
  track.addEventListener("pointermove", (event) => {
    if (event.pointerId === S.steer.pointer) steerFromPointer(event, track);
  });
  const release = (event) => {
    if (event.pointerId !== S.steer.pointer) return;
    S.steer.pointer = null;
    queueSteer(0);
  };
  track.addEventListener("pointerup", release);
  track.addEventListener("pointercancel", release);

  const buttons = document.createElement("div");
  buttons.className = "steer-buttons";
  const leftButton = document.createElement("button");
  leftButton.type = "button";
  leftButton.className = "steer-btn";
  leftButton.textContent = "←";
  leftButton.setAttribute("aria-label", "Hold to steer left");
  const centerButton = document.createElement("button");
  centerButton.type = "button";
  centerButton.className = "steer-btn center";
  centerButton.textContent = "CENTER";
  const rightButton = document.createElement("button");
  rightButton.type = "button";
  rightButton.className = "steer-btn";
  rightButton.textContent = "→";
  rightButton.setAttribute("aria-label", "Hold to steer right");
  wireHoldSteer(leftButton, -1);
  wireHoldSteer(rightButton, 1);
  centerButton.onclick = () => queueSteer(0);
  buttons.append(leftButton, centerButton, rightButton);
  shell.append(readout, track, buttons);
  card.appendChild(shell);
}
function actionButton(kind, icon, title, note) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `action-button ${kind}-btn`;
  button.dataset.action = kind;
  const iconNode = document.createElement("span");
  iconNode.textContent = icon;
  const label = document.createElement("b");
  label.textContent = title;
  const detail = document.createElement("small");
  detail.textContent = note;
  button.append(iconNode, label, detail);
  button.onclick = () => {
    if (triggerAction(kind)) announce(`${title} sent. Look at the TV.`);
  };
  return button;
}
function buildCarrierControl() {
  const card = makeControlShell("BALL CARRIER", "RUN THE LANE",
    S.sensors.status === "active"
      ? "Lean left or right. The buttons below are always live too."
      : "Hold left or right to steer. Center releases the lane.");
  addSteering(card, "Ball carrier steering");
  card.appendChild(actionButton("dive", "↘", "DIVE", "LUNGE FOR THE MARKER · PLAY ENDS"));
  return card;
}
function buildDefenderControl() {
  const card = makeControlShell("PURSUIT", "CLOSE THE ANGLE",
    "Steer toward the carrier. Hit tackle on the TV timing cue.");
  addSteering(card, "Defender pursuit steering");
  card.appendChild(actionButton("tackle", "✕", "DIVE TACKLE", "EARLY WHIFFS · LATE DRAGS"));
  return card;
}
function receiverTargets() {
  const raw = ownField("receivers", "available_receivers", "targets", "throw_targets");
  if (!Array.isArray(raw)) return [];
  return raw.map((target, index) => {
    if (typeof target === "string") {
      const player = playerByPid(target);
      return { id: target, name: player?.name || target.toUpperCase(), route: `TARGET ${index + 1}`, open: false };
    }
    const pid = String(target.pid ?? target.id ?? target.target ?? target.role ?? index);
    const player = playerByPid(pid);
    return {
      id: pid,
      name: String(target.name ?? player?.name ?? target.label ?? target.role ?? `TARGET ${index + 1}`),
      route: String(target.route ?? target.assignment ?? target.role ?? `TARGET ${index + 1}`),
      open: target.open === true || target.status === "open" || target.window === "open",
    };
  });
}
function timingWindowOpen(kind) {
  const raw = game()?.windows?.[kind];
  if (raw === true) return true;
  if (!raw) return false;
  if (Array.isArray(raw)) {
    return raw.some((entry) => entry === S.pid
      || (entry && typeof entry === "object"
        && (entry.pid === S.pid || entry.target === S.pid || entry.open === true)));
  }
  if (typeof raw !== "object") return false;
  const target = raw.pid ?? raw.target ?? raw.player_pid ?? raw.defender_pid ?? raw.receiver_pid;
  return raw.open !== false && (!target || target === S.pid);
}
function buildQbControl() {
  const card = makeControlShell("QUARTERBACK", "READ THE COVERAGE",
    "Receiver buttons light up as routes open. Direction is automatic.");
  const grid = document.createElement("div");
  grid.className = "receiver-grid";
  const targets = receiverTargets();
  targets.forEach((target) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `target-btn${target.open ? " open" : ""}`;
    button.dataset.target = target.id;
    const route = document.createElement("small");
    route.textContent = target.route.toUpperCase();
    const name = document.createElement("b");
    name.textContent = target.name.toUpperCase();
    const status = document.createElement("span");
    status.textContent = target.open ? "OPEN · THROW" : "COVERED";
    button.disabled = !target.open;
    button.append(route, name, status);
    button.onclick = () => {
      if (triggerAction("throw", { target: target.id })) {
        announce(`Pass thrown to ${target.name}. Look at the TV.`);
      }
    };
    grid.appendChild(button);
  });
  if (!targets.length) {
    const note = document.createElement("p");
    note.className = "control-status";
    note.textContent = "No route is open yet. Watch the TV or scramble.";
    grid.appendChild(note);
  }
  const scramble = document.createElement("button");
  scramble.type = "button";
  scramble.className = "scramble-btn";
  scramble.dataset.action = "scramble";
  scramble.textContent = "↯ NOBODY OPEN — SCRAMBLE";
  scramble.onclick = () => {
    if (triggerAction("scramble")) {
      S.controlKey = "";
      renderLive();
      announce("Scramble started. Steer and dive.");
    }
  };
  card.append(grid, scramble);
  return card;
}
function buildReceiverControl() {
  const card = makeControlShell("RECEIVER", "WIN THE CATCH",
    S.sensors.status === "active"
      ? "Raise the phone when the TV calls your window. Tap works too."
      : "Tap CATCH on the TV cue. Motion is optional.");
  card.appendChild(actionButton("catch", "🙌", "CATCH", "RAISE THE PHONE OR TAP HERE"));
  const meter = document.createElement("div");
  meter.className = "raise-meter";
  meter.setAttribute("aria-hidden", "true");
  const fill = document.createElement("i");
  meter.appendChild(fill);
  card.appendChild(meter);
  return card;
}
function buildWatchControl() {
  const card = document.createElement("article");
  card.className = "control-card watch-control";
  const icon = document.createElement("span");
  icon.textContent = "▣";
  const heading = document.createElement("h3");
  heading.textContent = "EYES ON THE FIELD";
  const copy = document.createElement("p");
  copy.textContent = ownField("live_instruction", "assignment_text")
    || "Your assignment is automatic on this play. The next possession rotates the roles.";
  card.append(icon, heading, copy);
  return card;
}
function buildLiveControl(mode) {
  const host = $("control-host");
  host.textContent = "";
  const control = mode === "carrier" ? buildCarrierControl()
    : mode === "defender" ? buildDefenderControl()
      : mode === "receiver" ? buildReceiverControl()
        : mode === "qb" ? buildQbControl()
          : buildWatchControl();
  host.appendChild(control);
  paintSteer();
  updateLiveControl();
}
function updateLiveControl() {
  paintSteer();
  document.querySelectorAll("[data-action]").forEach((button) => {
    const kind = button.dataset.action;
    if (["dive", "tackle", "catch", "throw"].includes(kind)) {
      button.disabled = S.actions.has(kind);
      if (S.actions.has(kind)) {
        const detail = button.querySelector("small");
        if (detail) detail.textContent = "ATTEMPT SENT · WATCH THE TV";
      }
    }
  });
  const targets = receiverTargets();
  document.querySelectorAll(".target-btn").forEach((button) => {
    const target = targets.find((item) => item.id === button.dataset.target);
    button.classList.toggle("open", !!target?.open);
    const status = button.querySelector("span");
    if (status) status.textContent = target?.open ? "OPEN · THROW" : "COVERED";
    button.disabled = !target?.open;
  });
  const meter = document.querySelector(".raise-meter i");
  if (meter) meter.style.width = `${Math.round(S.sensors.raiseEnergy * 100)}%`;
  const mode = controlMode();
  const windowCue = mode === "receiver" && timingWindowOpen("catch") ? "HANDS UP — CATCH!"
    : mode === "defender" && timingWindowOpen("tackle") ? "HIT NOW!"
      : null;
  const cue = windowCue ?? ownField("live_cue", "cue", "prompt") ?? game()?.live_cue ?? S.liveCue;
  $("live-cue-copy").textContent = String(cue || "BALL IS LIVE").toUpperCase();
}
function renderLive() {
  showPhasePanel("live");
  const mode = controlMode();
  const key = `${possessionId()}:${roleCode()}:${mode}`;
  if (key !== S.controlKey) {
    S.controlKey = key;
    buildLiveControl(mode);
  } else {
    updateLiveControl();
  }
}

/* ---------- setup, whistle, result ---------- */

function renderSetup() {
  showPhasePanel("setup");
  const meta = roleMeta();
  $("setup-title").textContent = ["carrier", "defender"].includes(controlMode())
    ? "HOLD YOUR PHONE LEVEL" : meta.control === "receiver" ? "GET READY TO GO UP" : "LOOK UP AT THE FIELD";
  $("setup-copy").textContent = ["carrier", "defender"].includes(controlMode())
    ? "Your steering center is being captured at the snap."
    : meta.control === "receiver"
      ? "The TV will call the catch window. Raise the phone or tap CATCH."
      : "Your assignment is set. The play lasts only a few seconds.";
}
function playResult() {
  const g = game() || {};
  const raw = g.last_play ?? g.play_result ?? g.whistle ?? g.last_result ?? g.result_play ?? {};
  return raw && typeof raw === "object" ? raw : { text: String(raw || "") };
}
function renderWhistle() {
  showPhasePanel("whistle");
  const result = playResult();
  const type = norm(result.type ?? result.outcome ?? result.kind);
  const yards = asNumber(result.yards ?? result.gain ?? result.yards_gained, 0);
  const touchdown = result.touchdown === true || type === "touchdown";
  const turnover = result.turnover === true
    || type === "turnover" || type === "interception";
  const incomplete = type.startsWith("incomplete");
  const title = result.title ?? (touchdown ? "TOUCHDOWN"
    : turnover ? "TURNOVER"
      : incomplete ? "INCOMPLETE" : "PLAY OVER");
  $("whistle-title").textContent = String(title).toUpperCase();
  $("whistle-copy").textContent = String(result.text ?? result.description ?? result.summary
    ?? (yards > 0 ? `${yards} yards before the whistle.` : yards < 0 ? `Dropped for ${Math.abs(yards)} yards.` : "The chains are moving."));
  $("result-yards").textContent = `${yards > 0 ? "+" : ""}${yards} YDS`;
  const sit = situation();
  $("result-next").textContent = result.next ?? result.next_down
    ?? `${sit.ordinal} & ${sit.distance}`;
  $("whistle-mark").textContent = touchdown ? "★"
    : turnover ? "↺" : "◉";
}

function finalResult() {
  const g = game() || {};
  const result = g.result && typeof g.result === "object" ? g.result : {};
  const teams = Array.isArray(result.teams)
    ? normalizeTeams({ ...g, teams: result.teams })
    : normalizeTeams(g);
  const winnerRaw = result.winner_team ?? result.winner ?? result.champion ?? g.winner_team;
  const winnerKey = winnerRaw && typeof winnerRaw === "object"
    ? String(winnerRaw.id ?? winnerRaw.key ?? winnerRaw.name ?? "")
    : winnerRaw == null ? "" : String(winnerRaw);
  const winnerIndex = teams.findIndex((team) => team.key === winnerKey || team.name === winnerKey);
  const computedWinner = winnerIndex >= 0 ? teams[winnerIndex]
    : teams[0].score === teams[1].score ? null
      : teams[0].score > teams[1].score ? teams[0] : teams[1];
  return { result, teams, winner: computedWinner, winnerKey: computedWinner?.key || winnerKey };
}
function resultRows(final) {
  const standings = final.result.standings;
  if (Array.isArray(standings) && standings.length && standings.some((row) => row.pid)) {
    return standings.slice(0, 6).map((row) => ({
      player: playerByPid(row.pid) || row,
      name: playerByPid(row.pid)?.name || row.name || "PLAYER",
      detail: row.detail || row.role || `${row.touchdowns ?? 0} TD · ${row.tackles ?? 0} TKL`,
      score: row.score ?? row.points ?? "",
      winner: row.pid === final.result.mvp_pid,
    }));
  }
  return final.teams.map((team) => ({
    player: { avatar: team.key === final.teams[0].key ? "🟢" : "🔴" },
    name: team.name,
    detail: team.key === final.winner?.key ? "WINNER" : "FINAL",
    score: team.score,
    winner: team.key === final.winner?.key,
  }));
}
function renderGameover() {
  const final = finalResult();
  const score = `${final.teams[0].score}–${final.teams[1].score}`;
  $("gameover-title").textContent = final.winner
    ? `${final.winner.name.toUpperCase()} WINS` : "GAME ENDS TIED";
  $("gameover-score").textContent = score;
  const host = $("gameover-rows");
  host.textContent = "";
  resultRows(final).forEach((entry) => {
    const row = document.createElement("div");
    row.className = `gameover-row${entry.winner ? " winner" : ""}`;
    const avatar = document.createElement("span");
    avatar.className = "av";
    Hub.fillAvatar(avatar, entry.player);
    const copy = document.createElement("span");
    const name = document.createElement("b");
    name.textContent = entry.name.toUpperCase();
    const detail = document.createElement("small");
    detail.textContent = String(entry.detail || "");
    copy.append(name, detail);
    const scoreNode = document.createElement("b");
    scoreNode.textContent = String(entry.score);
    row.append(avatar, copy, scoreNode);
    host.appendChild(row);
  });
  $("gameover").hidden = false;

  const resultKey = JSON.stringify({
    winner: final.winnerKey,
    score,
    result: final.result,
  });
  if (resultKey !== S.gameoverKey) {
    S.gameoverKey = resultKey;
    const mine = myTeamKey();
    if (final.winner && mine && final.winner.key === mine) {
      celebrate(190);
      feedback("success", [55, 35, 100]);
      announce(`Game over. ${final.winner.name} wins. Your team won.`);
    } else {
      announce(`Game over. ${final.winner ? `${final.winner.name} wins.` : "The game is tied."}`);
    }
  }
}
function bragPayload() {
  if (phaseOf() !== "game_end") return null;
  const final = finalResult();
  const score = `${final.teams[0].score}–${final.teams[1].score}`;
  const mvp = playerByPid(final.result.mvp_pid);
  return {
    title: "GRIDIRON",
    icon: "🏈",
    winner: {
      name: final.winner?.name || "TIE GAME",
      avatar: mvp?.avatar || "🏈",
      pfp: mvp?.pfp || null,
    },
    headline: final.result.headline || `${score} final${mvp ? ` · ${mvp.name} MVP` : ""}`,
    beaten: final.winner ? final.teams
      .filter((team) => team.key !== final.winner?.key)
      .map((team) => ({ name: team.name, score: team.score })) : [],
  };
}
if (window.Brag) {
  const button = Brag.button(bragPayload);
  document.querySelector("#gameover .modal-card").insertBefore(button, $("rematch-btn"));
}

/* ---------- state + effects ---------- */

function phaseChanged(previous, current) {
  if (current === "setup") {
    beginBaselineCapture();
    S.actions.clear();
    S.scrambleLocal = false;
    S.liveCue = "HOLD STEADY — SNAP COMING";
    resetSteer();
  }
  if (current === "live") {
    freezeBaseline();
    S.liveStartedAt = performance.now();
    S.liveCue = "BALL IS LIVE";
  }
  if (previous === "live" && current !== "live") queueSteer(0);
  if (current === "huddle") {
    // Every down is a fresh private call. Never let the prior optimistic
    // card lock survive a phase transition.
    S.selectedLocal = null;
    S.swapOpen = false;
    S.controlKey = "";
  }
}
function renderGame() {
  const phase = phaseOf();
  updateScoreboard();
  updateAssignment();
  updatePhaseRibbon(phase);
  if (!participantState() && phase !== "game_end") {
    showPhasePanel("sideline");
    updatePhaseRibbon("sideline");
    return;
  }
  if (phase === "huddle") renderHuddle();
  else if (phase === "setup") renderSetup();
  else if (phase === "live") renderLive();
  else if (phase === "whistle") renderWhistle();
  else if (phase === "game_end") {
    showPhasePanel("whistle");
    renderGameover();
  } else {
    showPhasePanel("sideline");
  }
}
function onState(st) {
  const previousPhase = phaseOf(S.st);
  const previousPossession = S.possessionKey;
  S.st = st;
  const currentPhase = phaseOf(st);
  S.possessionKey = possessionId(st.game || {});
  if (S.possessionKey !== previousPossession) {
    S.selectedLocal = null;
    S.actions.clear();
    S.scrambleLocal = false;
    S.controlKey = "";
  }
  if (currentPhase !== previousPhase) phaseChanged(previousPhase, currentPhase);

  $("countdown-overlay").hidden = st.phase !== "countdown";
  if (!S.joined) {
    show("scr-join");
  } else if (st.phase === "lobby" || st.phase === "countdown") {
    show("scr-lobby");
    $("gameover").hidden = true;
    renderLobby(st);
  } else {
    show("scr-game");
    ensureWakeLock();
    renderGame();
  }
  S.lastPhase = currentPhase;
}
function fxIsMine(fx) {
  return !fx.pid || fx.pid === S.pid || fx.to === S.pid;
}
function onFx(fx) {
  const message = fx.msg || fx.text || "";
  switch (fx.kind) {
    case "invalid":
      Hub.toast(message || "That action is not available.", "err");
      feedback("error", 30);
      announce(message || "Action unavailable.");
      break;
    case "toast":
      if (message) Hub.toast((fx.icon ? `${fx.icon} ` : "") + message);
      break;
    case "snap":
    case "play_start":
      S.liveCue = "SNAP — GO!";
      feedback("select", 22);
      if (fxIsMine(fx)) announce("Ball snapped. Watch the TV.");
      break;
    case "catch_window":
      if (fxIsMine(fx)) {
        S.liveCue = "HANDS UP — CATCH!";
        feedback("select", [18, 20, 18]);
        announce("Catch window. Raise the phone or tap catch.");
      }
      break;
    case "tackle_window":
      if (fxIsMine(fx)) {
        S.liveCue = "HIT NOW!";
        feedback("select", 24);
        announce("Tackle window. Tap tackle now.");
      }
      break;
    case "catch":
    case "completion":
      S.liveCue = fxIsMine(fx) ? "YOU GOT IT — RUN!" : "CATCH!";
      feedback("success", [28, 20, 55]);
      break;
    case "tackle":
      if (fx.result === "early" || fx.result === "miss") {
        if (fxIsMine(fx)) {
          S.liveCue = fx.result === "early"
            ? "TOO EARLY — HE’S GONE" : "WHIFF — HE’S GONE";
          feedback("error", 35);
          announce(S.liveCue);
        }
      } else {
        S.liveCue = fx.result === "late" ? "ARM TACKLE!" : "TACKLE!";
        feedback("success", [35, 20, 60]);
      }
      break;
    case "whiff":
      if (fxIsMine(fx)) {
        S.liveCue = "WHIFF — HE’S GONE";
        feedback("error", 35);
      }
      break;
    case "touchdown":
      S.liveCue = "TOUCHDOWN!";
      feedback("success", [55, 30, 90]);
      if (fxIsMine(fx)) celebrate(90);
      break;
    case "turnover":
    case "interception":
      S.liveCue = "TURNOVER!";
      feedback("select", [28, 28, 45]);
      break;
    case "whistle":
      S.liveCue = "WHISTLE";
      feedback("tap", 20);
      break;
    case "role_swap":
    case "swap":
      if (fxIsMine(fx)) {
        Hub.toast(message || "Assignments swapped.");
        feedback("success", 20);
      }
      break;
  }
  if (phaseOf() === "live") updateLiveControl();
}

/* ---------- connection, timers, test seam ---------- */

function connect() {
  if (S.conn) return;
  S.conn = Hub.connect("/games/gridiron/ws", {
    onWelcome: (message) => {
      S.pid = message.pid;
      if (S.joined) send({ t: "profile", name: Hub.identity.name, avatar: Hub.identity.avatar });
      if (S.st) onState(S.st);
    },
    onState,
    onFx,
  });
}
function secondsLeft() {
  if (phaseOf() === "live") {
    const left = game()?.stage_left;
    if (finite(left)) return Math.max(0, Math.ceil(Number(left)));
    const tick = asNumber(game()?.tick, 0);
    const tickMs = asNumber(game()?.tick_ms, 50);
    const totalTicks = asNumber(game()?.live_ticks, 120);
    return Math.max(0, Math.ceil((totalTicks - tick) * tickMs / 1000));
  }
  if (!S.st?.deadline || !S.conn) return 0;
  return Math.max(0, Math.ceil((S.st.deadline - S.conn.now()) / 1000));
}
function animationFrame() {
  requestAnimationFrame(animationFrame);
  const phase = phaseOf();
  const seconds = secondsLeft();
  if (S.st?.phase === "countdown") $("countdown-num").textContent = Math.max(1, seconds);
  if (phase === "huddle") $("huddle-clock").textContent = seconds;
  if (phase === "setup") $("setup-clock").textContent = Math.max(1, seconds);
  if (["huddle", "setup", "live", "whistle"].includes(phase)) {
    $("play-clock").textContent = phase === "whistle" ? "—" : seconds;
  }
  if (phase === "game_end") {
    $("gameover-auto").textContent = `locker room in ${seconds}s`;
  }
  S.sensors.raiseEnergy *= .91;
  const meter = document.querySelector(".raise-meter i");
  if (meter) meter.style.width = `${Math.round(S.sensors.raiseEnergy * 100)}%`;
}
requestAnimationFrame(animationFrame);

if (Hub.identity.name) {
  S.joined = true;
  connect();
  show("scr-lobby");
} else {
  show("scr-join");
}

/*
 * Browser playtests inspect this seam, but still drive the real DOM controls.
 * No state mutator or sensor-permission bypass is exposed.
 */
window.__gridironPhone = Object.freeze({
  state: () => S.st,
  phase: () => phaseOf(),
  control: () => controlMode(),
  sensorStatus: () => S.sensors.status,
  steer: () => S.steer.value,
  orientationSteer: (current, baseline, angle) => (
    steeringFromOrientation(current, baseline, angle)
  ),
});
