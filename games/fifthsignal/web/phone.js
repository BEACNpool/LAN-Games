/* THE FIFTH SIGNAL phone — private, reconnect-safe role consoles. */
"use strict";

const $ = (id) => document.getElementById(id);
const ROLE_FALLBACK = {
  helm:  { title: "HELM",  icon: "🧭", color: "#22d3ee" },
  core:  { title: "CORE",  icon: "⚡", color: "#f5b301" },
  relay: { title: "RELAY", icon: "📡", color: "#ec4899" },
  life:  { title: "LIFE",  icon: "✚",  color: "#34d399" },
  ops:   { title: "OPS",   icon: "◫",  color: "#a78bfa" },
};
const S = {
  st: null,
  pid: null,
  conn: null,
  joined: false,
  activeRole: null,
  controlKey: "",
  local: new Map(),
  syncDown: false,
  lastPhase: "",
  lastRound: 0,
  lastResultKey: "",
  tilt: {
    status: "off",
    role: null,
    listener: null,
    baseline: null,
    samples: 0,
    timer: null,
  },
};

const game = () => S.st?.game || null;
const roster = () => game()?.roster || S.st?.players || [];
const player = (pid) => roster().find((p) => p.pid === pid)
  || S.st?.players?.find((p) => p.pid === pid) || null;
const me = () => game()?.me || null;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function roleId(role) {
  return typeof role === "string" ? role : role?.role || role?.id || role?.key || "";
}
function roleMeta(role, fallback = {}) {
  const id = roleId(role);
  const known = ROLE_FALLBACK[id] || {};
  return {
    role: id,
    title: role?.title || role?.label || fallback.title || known.title || id.toUpperCase() || "CONSOLE",
    icon: role?.icon || fallback.icon || known.icon || "◈",
    color: role?.color || fallback.color || known.color || "#42e8ff",
  };
}
function myRoles() {
  const own = me();
  if (own?.roles?.length) return own.roles.map((r) => roleMeta(r));
  return (own?.consoles || []).map((c) => roleMeta(c));
}
function consoleFor(role) {
  return me()?.consoles?.find((console) => console.role === role) || null;
}
function integrity(g = game()) {
  if (!g) return { value: 0, max: 100, pct: 0 };
  const max = Math.max(1, Number(g.integrity_max ?? 100) || 100);
  const value = clamp(Number(g.integrity ?? g.hull ?? max) || 0, 0, max);
  return { value, max, pct: Math.round(value / max * 100) };
}
function missionTitle(g = game()) {
  return g?.mission?.title || g?.mission_title || "AURORA";
}
function missionId(g = game()) {
  return g?.mission?.id || g?.mission_id || "MISSION // AURORA";
}
function signalCount(g = game()) {
  const derived = g?.round
    ? Math.max(0, g.round - (S.st?.phase === "resolution" ? 0 : 1))
    : 0;
  return Number(g?.progress?.ready ?? g?.signal ?? g?.signals ?? derived) || 0;
}
function controlSpec(console) {
  const spec = console?.spec || {};
  return {
    options: console?.options || spec.options || [],
    keys: spec.keys || console?.options || [],
    length: Number(spec.length ?? console?.sequence_length ?? 3) || 3,
    labels: spec.labels || console?.switch_labels || [],
    min: Number(spec.min ?? console?.min ?? 0),
    max: Number(spec.max ?? console?.max ?? 100),
    step: Number(spec.step ?? console?.step ?? 1) || 1,
    unit: spec.unit || console?.unit || "",
    motion: spec.motion ?? console?.motion ?? true,
  };
}
function optionParts(option) {
  if (option && typeof option === "object") {
    return {
      value: option.value ?? option.id ?? option.label,
      label: String(option.label ?? option.value ?? option.id ?? ""),
      icon: option.icon || "",
    };
  }
  return { value: option, label: String(option), icon: "" };
}
function flattenRelays(value, output = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => flattenRelays(item, output));
  } else if (value && typeof value === "object") {
    if ("text" in value || "target_role" in value || "target_title" in value) {
      output.push(value);
    } else {
      Object.values(value).forEach((item) => flattenRelays(item, output));
    }
  }
  return output;
}
function readableRelayValue(value) {
  if (value == null) return "";
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "boolean")) {
      return value.map((item, index) => `${index + 1} ${item ? "ON" : "OFF"}`).join(" · ");
    }
    return value.map(String).join(" → ");
  }
  if (typeof value === "object") {
    if (Number.isFinite(value.x) && Number.isFinite(value.y)) {
      return `X ${value.x >= 0 ? "+" : ""}${value.x}, Y ${value.y >= 0 ? "+" : ""}${value.y}`;
    }
    return Object.entries(value).map(([key, item]) => `${key.toUpperCase()} ${String(item)}`).join(" · ");
  }
  return String(value);
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
  try { Hub.feedback?.[kind]?.(); } catch (error) { /* feedback is optional */ }
  if (haptic !== undefined) {
    try { Hub.feedback?.haptic?.(haptic); } catch (error) { /* optional */ }
  }
}
function show(id) {
  for (const sid of [
    "scr-join", "scr-lobby", "scr-briefing", "scr-console",
    "scr-resolution", "scr-spectator", "scr-sync", "scr-end",
  ]) $(sid).hidden = sid !== id;
}
function setRoleColor(color) {
  $("scr-console").style.setProperty("--role", color || "#42e8ff");
}

/* ---------- profile + lobby ---------- */
let avatarPick = Hub.identity.avatar || Hub.AVATARS[0];
Hub.buildAvatarGrid($("avatar-grid"), avatarPick, (avatar) => {
  avatarPick = avatar;
  feedback("tap", 10);
});
$("name-input").value = Hub.identity.name || "";

function renderCrewCard(p, emptyIndex = 0) {
  const card = document.createElement("div");
  card.className = "crew-card";
  if (!p) card.classList.add("empty");
  else {
    if (p.ready) card.classList.add("ready");
    if (p.connected === false) card.classList.add("away");
  }
  const av = document.createElement("span");
  av.className = "crew-avatar";
  if (p) Hub.fillAvatar(av, p); else av.textContent = "·";
  const meta = document.createElement("span");
  meta.className = "crew-meta";
  const name = document.createElement("b");
  name.textContent = p ? `${p.name || "CREW"}${p.pid === S.pid ? " · YOU" : ""}` : `OPEN SEAT ${emptyIndex}`;
  const state = document.createElement("small");
  state.textContent = !p ? "waiting for signal"
    : p.connected === false ? "signal lost"
      : p.ready ? "ready for assignment" : "boarding";
  meta.append(name, state);
  const check = document.createElement("span");
  check.className = "crew-check";
  check.textContent = p?.ready ? "✓" : "";
  card.append(av, meta, check);
  return card;
}

const SETTING_OPTIONS = {
  length: [["short", "QUICK"], ["full", "FULL"]],
  difficulty: [["easy", "STORY"], ["standard", "CREW"], ["expert", "EXPERT"]],
};
function renderSegment(hostId, key, current) {
  const host = $(hostId);
  host.textContent = "";
  for (const [value, label] of SETTING_OPTIONS[key]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.className = value === current ? "sel" : "";
    button.setAttribute("aria-pressed", value === current ? "true" : "false");
    button.onclick = () => {
      feedback("select", 12);
      S.conn?.send({ t: "settings", patch: { [key]: value } });
    };
    host.appendChild(button);
  }
}

function renderLobby(st) {
  show("scr-lobby");
  const humans = (st.players || []).filter((p) => !p.bot);
  const ready = humans.filter((p) => p.ready && p.connected !== false).length;
  $("ready-count").textContent = `${ready}/${humans.length || 3} READY`;
  const host = $("crew-grid");
  host.textContent = "";
  for (let index = 0; index < 5; index++) {
    host.appendChild(renderCrewCard(humans[index], index + 1));
  }
  const need = Math.max(0, (st.min_players || 3) - humans.length);
  $("crew-note").textContent = need
    ? `${need} more crew member${need === 1 ? "" : "s"} needed. Three phones can run all five consoles.`
    : humans.length < 5
      ? `${humans.length} crew aboard · role tabs keep each fused console separate.`
      : "Full five-person crew · one console per phone.";

  const settings = st.settings || {};
  renderSegment("opt-length", "length", settings.length || "full");
  renderSegment("opt-difficulty", "difficulty", settings.difficulty || "standard");
  $("length-note").textContent = settings.length === "short"
    ? "three unique crises · about 3–6 min" : "five unique crises · about 6–10 min";
  $("difficulty-note").textContent = settings.difficulty === "easy"
    ? "more time · gentler damage" : settings.difficulty === "expert"
      ? "tight clocks · no mercy" : "built for a family crew";

  const amReady = !!st.you?.ready;
  $("ready-btn").textContent = amReady ? "READY ✓" : "READY FOR ASSIGNMENT";
  $("ready-btn").classList.toggle("is-ready", amReady);
  const canStart = st.phase === "lobby" && amReady && ready >= (st.min_players || 3);
  $("ready-btn").hidden = canStart;
  $("start-btn").hidden = !canStart;
  $("lobby-hint").textContent = st.phase === "countdown" ? "mission sequence initializing…"
    : ready < (st.min_players || 3) ? `need ${Math.max(0, (st.min_players || 3) - ready)} more ready`
      : canStart ? "any ready crew member can launch" : "ready up when your crew is here";
}

$("join-btn").onclick = () => {
  feedback("select", 18);
  Hub.identity.name = $("name-input").value.trim() || "CREW";
  Hub.identity.avatar = avatarPick;
  S.joined = true;
  connect();
  S.conn?.send({ t: "profile", name: Hub.identity.name, avatar: avatarPick });
  if (S.st) renderLobby(S.st); else show("scr-lobby");
};
$("name-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") $("join-btn").click();
});
$("ready-btn").onclick = () => {
  feedback("select", 24);
  S.conn?.send({ t: "ready", ready: !S.st?.you?.ready });
};
$("start-btn").onclick = () => {
  feedback("success", [35, 25, 60]);
  S.conn?.send({ t: "start" });
};
$("again-btn").onclick = () => {
  feedback("select", 22);
  S.conn?.send({ t: "again" });
};

/* ---------- mission briefing ---------- */
function assignmentText(roles) {
  const ids = roles.map(roleId);
  if (ids.length < 2) return "PRIMARY CONSOLE";
  if (ids.includes("helm") && ids.includes("ops")) return "FLIGHT OPS";
  if (ids.includes("core") && ids.includes("life")) return "SHIP SYSTEMS";
  return "FUSED STATION";
}
function renderBriefing(st) {
  show("scr-briefing");
  const g = st.game || {};
  $("brief-mission-id").textContent = missionId(g).toUpperCase();
  $("brief-title").textContent = missionTitle(g).toUpperCase();
  $("brief-copy").textContent = g.briefing
    || "Every phone sees a different part of the truth. Speak clearly. Trust your crew.";
  const roles = myRoles();
  $("brief-role-count").textContent = `${roles.length} ${roles.length === 1 ? "ROLE" : "ROLES"}`;
  const roleHost = $("brief-roles");
  roleHost.textContent = "";
  for (const role of roles) {
    const row = document.createElement("div");
    row.className = "brief-role";
    row.style.setProperty("--role", role.color);
    const icon = document.createElement("span");
    icon.textContent = role.icon;
    const copy = document.createElement("p");
    const title = document.createElement("b");
    title.textContent = role.title;
    const detail = document.createElement("small");
    detail.textContent = role.role === "helm" ? "course, vector and stabilization"
      : role.role === "core" ? "power routing and reactor control"
        : role.role === "relay" ? "signal phase and communication"
          : role.role === "life" ? "pressure, valves and crew safety"
            : role.role === "ops" ? "drone routes and command order" : "private ship system";
    copy.append(title, detail);
    const badge = document.createElement("b");
    badge.textContent = assignmentText(roles);
    row.append(icon, copy, badge);
    roleHost.appendChild(row);
  }
  renderPortraitStrip($("brief-crew"), roster(), "brief");
  if (S.lastPhase !== "briefing") {
    feedback("select", [25, 30, 25]);
    announce(`Mission briefing. Your ${roles.length === 1 ? "role is" : "roles are"} ${roles.map((r) => r.title).join(" and ")}.`);
  }
}

function renderPortraitStrip(host, people, mode = "brief") {
  host.textContent = "";
  for (const p of people) {
    const person = document.createElement("div");
    person.className = `${mode}-person`;
    const av = document.createElement("span");
    av.className = mode === "end" ? "end-avatar" : mode === "sync" ? "sync-avatar" : "brief-avatar";
    Hub.fillAvatar(av, p);
    const name = document.createElement("b");
    name.textContent = p.name || "CREW";
    person.append(av, name);
    if (mode === "end" && p.commendation) {
      const commendation = document.createElement("small");
      commendation.textContent = p.commendation;
      person.appendChild(commendation);
    }
    host.appendChild(person);
  }
}

/* ---------- role controls ---------- */
function selectRole(role, announceRole = true) {
  if (!consoleFor(role)) return;
  if (S.activeRole !== role) {
    stopTilt("Role changed");
    S.activeRole = role;
    feedback("tap", 10);
  }
  if (S.st?.phase === "crisis") renderConsole(S.st);
  if (announceRole) {
    const console = consoleFor(role);
    announce(`${console?.title || role} console selected.`);
  }
}

function renderRoleTabs(consoles) {
  const host = $("role-tabs");
  host.textContent = "";
  for (const console of consoles) {
    const meta = roleMeta(console);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "role-tab";
    button.dataset.role = console.role;
    if (console.role === S.activeRole) button.classList.add("sel");
    if (console.submitted) button.classList.add("done");
    else if (consoles.length > 1 && console.role !== S.activeRole) button.classList.add("attention");
    button.style.setProperty("--tab-role", meta.color);
    button.setAttribute("aria-pressed", console.role === S.activeRole ? "true" : "false");
    const icon = document.createElement("span");
    icon.textContent = meta.icon;
    const label = document.createElement("b");
    label.textContent = meta.title;
    button.append(icon, label);
    button.onclick = () => selectRole(console.role);
    host.appendChild(button);
  }
}

function localFor(console) {
  const crisis = game()?.crisis?.id || game()?.round || 0;
  const key = `${crisis}:${console.role}:${console.kind}`;
  if (!S.local.has(key)) {
    const spec = controlSpec(console);
    let value;
    if (console.kind === "sequence") value = [];
    else if (console.kind === "switches") {
      const server = Array.isArray(console.value) ? console.value : [];
      value = spec.labels.map((unused, index) => !!server[index]);
    } else if (console.kind === "balance") {
      value = {
        x: Number(console.value?.x ?? 0) || 0,
        y: Number(console.value?.y ?? 0) || 0,
      };
    } else if (console.kind === "dial") {
      value = Number(console.value ?? Math.round((spec.min + spec.max) / 2));
    } else value = console.value ?? null;
    S.local.set(key, value);
  }
  S.controlKey = key;
  return S.local.get(key);
}
function saveLocal(value) {
  if (S.controlKey) S.local.set(S.controlKey, value);
}
function sendControl(console, value) {
  if (!console || console.submitted) return;
  feedback("select", [18, 18, 28]);
  S.conn?.send({ t: "control", role: console.role, value });
  announce(`${console.title || console.role} response transmitted.`);
}
function snapToStep(raw, spec) {
  const steps = Math.round((Number(raw) - spec.min) / spec.step);
  return clamp(spec.min + steps * spec.step, spec.min, spec.max);
}
function caption(left, right = "") {
  const row = document.createElement("div");
  row.className = "control-caption";
  const a = document.createElement("span");
  a.textContent = left;
  const b = document.createElement("b");
  b.textContent = right;
  row.append(a, b);
  return row;
}

function renderChoice(host, console) {
  const spec = controlSpec(console);
  const selected = localFor(console);
  host.appendChild(caption("SELECT ONE RESPONSE", `${spec.options.length} CHANNELS`));
  const grid = document.createElement("div");
  grid.className = "choice-grid";
  for (const raw of spec.options) {
    const option = optionParts(raw);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "choice-button";
    if (option.value === selected) button.classList.add("selected");
    if (option.icon) {
      const icon = document.createElement("span");
      icon.textContent = option.icon;
      button.appendChild(icon);
    }
    button.appendChild(document.createTextNode(option.label));
    button.onclick = () => {
      saveLocal(option.value);
      feedback("select", 12);
      renderControl(console);
    };
    grid.appendChild(button);
  }
  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "control-submit";
  submit.textContent = "TRANSMIT SELECTION";
  submit.disabled = selected == null;
  submit.onclick = () => sendControl(console, selected);
  host.append(grid, submit);
}

function renderSequence(host, console) {
  const spec = controlSpec(console);
  const sequence = localFor(console);
  host.appendChild(caption("ENTER THE PATTERN IN ORDER", `${sequence.length}/${spec.length}`));
  const readout = document.createElement("div");
  readout.className = "sequence-readout";
  for (let index = 0; index < spec.length; index++) {
    const slot = document.createElement("span");
    slot.className = "sequence-slot" + (index < sequence.length ? " filled" : "");
    slot.textContent = index < sequence.length ? String(sequence[index]) : "·";
    readout.appendChild(slot);
  }
  const pad = document.createElement("div");
  pad.className = "sequence-pad";
  for (const raw of spec.keys) {
    const option = optionParts(raw);
    const key = document.createElement("button");
    key.type = "button";
    key.className = "sequence-key";
    key.textContent = option.icon ? `${option.icon} ${option.label}` : option.label;
    key.disabled = sequence.length >= spec.length;
    key.onclick = () => {
      if (sequence.length >= spec.length) return;
      sequence.push(option.value);
      saveLocal(sequence);
      feedback("tap", 10);
      renderControl(console);
    };
    pad.appendChild(key);
  }
  const actions = document.createElement("div");
  actions.className = "sequence-actions";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "sequence-clear";
  clear.textContent = "CLEAR";
  clear.disabled = !sequence.length;
  clear.onclick = () => {
    sequence.length = 0;
    saveLocal(sequence);
    feedback("tap", 12);
    renderControl(console);
  };
  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "sequence-send";
  submit.textContent = "TRANSMIT PATTERN";
  submit.disabled = sequence.length !== spec.length;
  submit.onclick = () => sendControl(console, [...sequence]);
  actions.append(clear, submit);
  host.append(readout, pad, actions);
}

function renderDial(host, console) {
  const spec = controlSpec(console);
  let value = snapToStep(Number(localFor(console)), spec);
  host.appendChild(caption("TUNE THE CONTROL", `${value}${spec.unit}`));
  const shell = document.createElement("div");
  shell.className = "dial-console";
  const face = document.createElement("div");
  face.className = "dial-face";
  const needle = document.createElement("i");
  needle.className = "dial-needle";
  const readout = document.createElement("b");
  readout.textContent = `${value}${spec.unit}`;
  face.append(needle, readout);
  const side = document.createElement("div");
  side.className = "dial-side";
  const input = document.createElement("input");
  input.type = "range";
  input.min = spec.min;
  input.max = spec.max;
  input.step = spec.step;
  input.value = value;
  input.setAttribute("aria-label", `${console.title || console.role} dial`);
  const minmax = document.createElement("small");
  const min = document.createElement("span");
  min.textContent = `${spec.min}${spec.unit}`;
  const max = document.createElement("span");
  max.textContent = `${spec.max}${spec.unit}`;
  minmax.append(min, max);
  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "control-submit";
  submit.textContent = "LOCK FREQUENCY";
  const paint = () => {
    value = Number(input.value);
    saveLocal(value);
    readout.textContent = `${value}${spec.unit}`;
    const ratio = (value - spec.min) / Math.max(1, spec.max - spec.min);
    needle.style.transform = `rotate(${-130 + ratio * 260}deg)`;
  };
  input.oninput = () => { paint(); feedback("tap", 4); };
  submit.onclick = () => sendControl(console, value);
  paint();
  side.append(input, minmax, submit);
  shell.append(face, side);
  host.appendChild(shell);
}

function renderSwitches(host, console) {
  const spec = controlSpec(console);
  const values = localFor(console);
  host.appendChild(caption("CONFIGURE THE BANK", `${values.filter(Boolean).length} ACTIVE`));
  const bank = document.createElement("div");
  bank.className = "switch-bank";
  spec.labels.forEach((label, index) => {
    const row = document.createElement("div");
    row.className = "switch-row";
    const text = document.createElement("span");
    text.textContent = label;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "switch-toggle";
    toggle.setAttribute("aria-label", `${label}: ${values[index] ? "on" : "off"}`);
    toggle.setAttribute("aria-pressed", values[index] ? "true" : "false");
    const knob = document.createElement("i");
    toggle.appendChild(knob);
    toggle.onclick = () => {
      values[index] = !values[index];
      saveLocal(values);
      feedback(values[index] ? "select" : "tap", 14);
      renderControl(console);
    };
    row.append(text, toggle);
    bank.appendChild(row);
  });
  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "control-submit";
  submit.textContent = "LOCK SWITCH BANK";
  submit.onclick = () => sendControl(console, [...values]);
  host.append(bank, submit);
}

function balancePercent(value, spec) {
  return (clamp(value, spec.min, spec.max) - spec.min) / Math.max(1, spec.max - spec.min) * 100;
}
function setBalanceAxis(console, axis, raw, repaint = true) {
  const spec = controlSpec(console);
  const value = localFor(console);
  value[axis] = snapToStep(raw, spec);
  saveLocal(value);
  if (repaint) paintBalance(console, value);
}
function paintBalance(console, value) {
  const spec = controlSpec(console);
  const bubble = document.querySelector("#control-host .balance-bubble");
  if (bubble) {
    bubble.style.left = `calc(${balancePercent(value.x, spec)}% - 20px)`;
    bubble.style.top = `calc(${balancePercent(value.y, spec)}% - 20px)`;
  }
  const x = document.querySelector('#control-host input[data-axis="x"]');
  const y = document.querySelector('#control-host input[data-axis="y"]');
  if (x) x.value = value.x;
  if (y) y.value = value.y;
  const out = document.querySelector("#control-host .balance-value");
  if (out) out.textContent = `X ${value.x} · Y ${value.y}`;
}
function setBalanceFromPointer(console, event) {
  const plane = event.currentTarget;
  const box = plane.getBoundingClientRect();
  const spec = controlSpec(console);
  const x = spec.min + clamp((event.clientX - box.left) / box.width, 0, 1) * (spec.max - spec.min);
  const y = spec.min + clamp((event.clientY - box.top) / box.height, 0, 1) * (spec.max - spec.min);
  setBalanceAxis(console, "x", x, false);
  setBalanceAxis(console, "y", y, true);
}
function tiltCapability(console) {
  const spec = controlSpec(console);
  if (!spec.motion) return { ok: false, note: "This console uses touch control." };
  if (!window.isSecureContext) return { ok: false, note: "Tilt needs HTTPS. Touch controls remain fully available." };
  if (typeof window.DeviceOrientationEvent === "undefined") return { ok: false, note: "No motion sensor found. Use touch." };
  return { ok: true, note: "Optional: tilt can move the bubble after you allow it." };
}
function stopTilt(reason = "") {
  if (S.tilt.listener) window.removeEventListener("deviceorientation", S.tilt.listener);
  clearTimeout(S.tilt.timer);
  S.tilt.listener = null;
  S.tilt.baseline = null;
  S.tilt.samples = 0;
  S.tilt.role = null;
  S.tilt.status = "off";
  const button = document.querySelector("#control-host .tilt-button");
  if (button) {
    button.textContent = "ENABLE TILT";
    button.classList.remove("active");
  }
  if (reason && S.st?.phase === "crisis") {
    const note = document.querySelector("#control-host .tilt-note");
    if (note) note.textContent = reason;
  }
}
async function enableTilt(console) {
  const capability = tiltCapability(console);
  if (!capability.ok) {
    Hub.toast(capability.note, "err");
    return;
  }
  stopTilt();
  S.tilt.status = "requesting";
  S.tilt.role = console.role;
  renderControl(console);
  try {
    const Orientation = window.DeviceOrientationEvent;
    if (typeof Orientation.requestPermission === "function") {
      const permission = await Orientation.requestPermission();
      if (permission !== "granted") throw new Error("Motion permission was not granted. Touch still works.");
    }
    S.tilt.listener = (event) => {
      if (document.hidden || S.st?.phase !== "crisis" || S.activeRole !== console.role) {
        stopTilt();
        return;
      }
      if (!Number.isFinite(event.gamma) || !Number.isFinite(event.beta)) return;
      if (!S.tilt.baseline) S.tilt.baseline = { gamma: event.gamma, beta: event.beta };
      S.tilt.samples++;
      const spec = controlSpec(console);
      const span = spec.max - spec.min;
      const x = clamp((event.gamma - S.tilt.baseline.gamma) / 26, -1, 1);
      const y = clamp((event.beta - S.tilt.baseline.beta) / 26, -1, 1);
      const toValue = (n) => spec.min + (n + 1) / 2 * span;
      setBalanceAxis(console, "x", toValue(x), false);
      setBalanceAxis(console, "y", toValue(y), true);
      if (S.tilt.status !== "active") {
        S.tilt.status = "active";
        feedback("success", 20);
        const button = document.querySelector("#control-host .tilt-button");
        const note = document.querySelector("#control-host .tilt-note");
        if (button) { button.textContent = "TILT ACTIVE"; button.classList.add("active"); }
        if (note) note.textContent = "Tilt is live. Touch sliders still work.";
      }
    };
    window.addEventListener("deviceorientation", S.tilt.listener);
    S.tilt.timer = setTimeout(() => {
      if (S.tilt.status !== "active") {
        stopTilt();
        Hub.toast("No useful motion reading. Use touch controls.", "err");
        if (S.st?.phase === "crisis" && S.activeRole === console.role) renderControl(console);
      }
    }, 2500);
  } catch (error) {
    stopTilt();
    Hub.toast(error.message || "Tilt unavailable. Touch still works.", "err");
    if (S.st?.phase === "crisis" && S.activeRole === console.role) renderControl(console);
  }
}

function renderBalance(host, console) {
  const spec = controlSpec(console);
  const value = localFor(console);
  host.appendChild(caption("STABILIZE BOTH AXES", "TOUCH FIRST"));
  const shell = document.createElement("div");
  shell.className = "balance-console";
  const plane = document.createElement("div");
  plane.className = "balance-plane";
  plane.setAttribute("role", "application");
  plane.setAttribute("aria-label", "Two-axis balance pad");
  const safe = document.createElement("span");
  safe.className = "balance-safe";
  const bubble = document.createElement("i");
  bubble.className = "balance-bubble";
  plane.append(safe, bubble);
  let pointer = null;
  plane.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    pointer = event.pointerId;
    plane.setPointerCapture(pointer);
    stopTilt("Touch control active.");
    setBalanceFromPointer(console, event);
    feedback("tap", 8);
  });
  plane.addEventListener("pointermove", (event) => {
    if (pointer === event.pointerId) setBalanceFromPointer(console, event);
  });
  const release = (event) => { if (pointer === event.pointerId) pointer = null; };
  plane.addEventListener("pointerup", release);
  plane.addEventListener("pointercancel", release);

  const axes = document.createElement("div");
  axes.className = "balance-axes";
  for (const axis of ["x", "y"]) {
    const row = document.createElement("label");
    row.className = "balance-axis";
    const label = document.createElement("span");
    label.textContent = axis.toUpperCase();
    const input = document.createElement("input");
    input.type = "range";
    input.min = spec.min;
    input.max = spec.max;
    input.step = spec.step;
    input.value = value[axis];
    input.dataset.axis = axis;
    input.setAttribute("aria-label", `${axis.toUpperCase()} axis`);
    input.oninput = () => {
      stopTilt("Touch control active.");
      setBalanceAxis(console, axis, Number(input.value));
    };
    row.append(label, input);
    axes.appendChild(row);
  }
  const valueText = document.createElement("p");
  valueText.className = "balance-value";
  const tiltRow = document.createElement("div");
  tiltRow.className = "tilt-row";
  const tilt = document.createElement("button");
  tilt.type = "button";
  tilt.className = "tilt-button";
  const capability = tiltCapability(console);
  tilt.disabled = !capability.ok;
  tilt.textContent = S.tilt.status === "active" && S.tilt.role === console.role
    ? "TILT ACTIVE" : S.tilt.status === "requesting" && S.tilt.role === console.role
      ? "READING SENSOR…" : "ENABLE TILT";
  tilt.classList.toggle("active", S.tilt.status === "active" && S.tilt.role === console.role);
  tilt.onclick = () => {
    if (S.tilt.status === "active" && S.tilt.role === console.role) {
      stopTilt();
      renderControl(console);
    } else {
      enableTilt(console);
    }
  };
  const tiltNote = document.createElement("p");
  tiltNote.className = "tilt-note";
  tiltNote.textContent = S.tilt.status === "active" && S.tilt.role === console.role
    ? "Tilt is live. Touch sliders still work." : capability.note;
  tiltRow.append(tilt, tiltNote);
  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "control-submit";
  submit.textContent = "LOCK STABILIZER";
  submit.onclick = () => sendControl(console, { x: value.x, y: value.y });
  shell.append(plane, axes, valueText, tiltRow, submit);
  host.appendChild(shell);
  paintBalance(console, value);
}

function renderControl(console) {
  const host = $("control-host");
  host.textContent = "";
  if (!console || console.submitted) return;
  switch (console.kind) {
    case "choice": renderChoice(host, console); break;
    case "sequence": renderSequence(host, console); break;
    case "dial": renderDial(host, console); break;
    case "switches": renderSwitches(host, console); break;
    case "balance": renderBalance(host, console); break;
    default: {
      host.appendChild(caption("CONSOLE FORMAT", String(console.kind || "UNKNOWN").toUpperCase()));
      const submit = document.createElement("button");
      submit.type = "button";
      submit.className = "control-submit";
      submit.textContent = "ACKNOWLEDGE";
      submit.onclick = () => sendControl(console, console.value ?? true);
      host.appendChild(submit);
    }
  }
}

function renderBackupRelays(rawRelays) {
  const relays = flattenRelays(rawRelays);
  const section = $("backup-relays");
  const host = $("backup-relay-list");
  section.hidden = relays.length === 0;
  host.textContent = "";
  for (const relay of relays) {
    const card = document.createElement("article");
    card.className = "backup-relay";
    const target = relay.target_title || roleMeta(relay.target_role || "").title || "CREW CONSOLE";
    const recipient = relay.target_name ? ` · FOR ${relay.target_name.toUpperCase()}` : "";
    const label = document.createElement("span");
    label.textContent = `⚠ EMERGENCY · ${String(target).toUpperCase()}${recipient}`;
    const clue = document.createElement("p");
    const fallbackValue = readableRelayValue(relay.value);
    clue.textContent = relay.text || `${target} requires ${fallbackValue || "the recovered setting"}.`;
    const source = document.createElement("small");
    const recoveredFrom = relay.source_name || relay.holder_name || relay.source_title || relay.holder_title;
    source.textContent = recoveredFrom
      ? `RECOVERED FROM ${String(recoveredFrom).toUpperCase()} · READ THIS ALOUD`
      : "RECOVERED LOST CLUE · READ THIS ALOUD";
    card.append(label, clue, source);
    host.appendChild(card);
  }
}

function renderConsole(st) {
  show("scr-console");
  const g = st.game || {};
  const consoles = g.me?.consoles || [];
  if (!consoles.length) return;
  if (!S.activeRole || !consoles.some((c) => c.role === S.activeRole)) {
    S.activeRole = consoles.find((c) => !c.submitted)?.role || consoles[0].role;
  }
  const console = consoleFor(S.activeRole) || consoles[0];
  const meta = roleMeta(console);
  setRoleColor(meta.color);
  renderRoleTabs(consoles);

  $("console-round").textContent = `CRISIS ${g.round || 1} / ${g.rounds || 1}`;
  $("console-mission").textContent = missionTitle(g).toUpperCase();
  const hull = integrity(g);
  $("phone-hull").textContent = hull.pct;
  $("phone-hull-fill").style.width = `${hull.pct}%`;
  $("phone-signal").textContent = signalCount(g);
  const crisis = g.crisis || {};
  $("crisis-class").textContent = (crisis.system || "ACTIVE CRISIS").toUpperCase();
  $("crisis-title").textContent = `${crisis.icon ? `${crisis.icon} ` : ""}${crisis.title || "UNKNOWN SIGNAL"}`;
  $("crisis-public").textContent = crisis.alert || crisis.public || crisis.description
    || "Your private consoles contain different pieces of the solution. Talk now.";

  $("role-icon").textContent = meta.icon;
  $("role-label").textContent = `${meta.title} // PRIVATE`;
  $("role-title").textContent = meta.title;
  $("role-status").textContent = console.submitted ? (console.autopilot ? "AUTOPILOT" : "LOCKED") : "LIVE";
  $("role-status").classList.toggle("done", !!console.submitted);
  $("console-prompt").textContent = console.prompt || "Read the private relay and configure your console.";

  const relay = console.relay;
  $("relay-card").hidden = !relay;
  if (relay) {
    $("relay-target").textContent = (relay.target_title || roleMeta(relay.target_role || "").title).toUpperCase();
    $("relay-text").textContent = relay.text || `Tell ${relay.target_name || "your crewmate"} what you can see.`;
    $("relay-value").textContent = "";
    $("relay-value").hidden = true;
  }
  renderBackupRelays(g.me?.backup_relays);
  $("console-complete").hidden = !console.submitted;
  renderControl(console);

  if (g.round !== S.lastRound) {
    S.lastRound = g.round;
    feedback("error", [22, 20, 22]);
    announce(`Crisis ${g.round}. ${crisis.title || "Unknown signal"}. Check your private ${meta.title} directive.`);
  }
}

/* ---------- resolution, final sync, ending ---------- */
function resolutionCleared(resolution) {
  return !!(resolution?.cleared ?? resolution?.success ?? resolution?.stabilized >= resolution?.total);
}
function renderResolutionCrew(host, g) {
  host.textContent = "";
  const systems = new Map((g.resolution?.systems || []).map((system) => [system.role, system.stable]));
  for (const p of roster()) {
    const assigned = (p.roles || []).map(roleId);
    const stable = assigned.length ? assigned.every((role) => systems.get(role) !== false) : true;
    const person = document.createElement("div");
    person.className = "resolution-person" + (stable ? "" : " missed");
    const av = document.createElement("span");
    av.className = "brief-avatar";
    Hub.fillAvatar(av, p);
    const status = document.createElement("i");
    status.textContent = stable ? "✓" : "!";
    person.append(av, status);
    host.appendChild(person);
  }
}
function renderResolution(st) {
  show("scr-resolution");
  stopTilt();
  setSync(false);
  const g = st.game || {};
  const result = g.resolution || g.last_result || {};
  const cleared = resolutionCleared(result);
  $("scr-resolution").classList.toggle("failed", !cleared);
  $("resolution-count").textContent = `${g.round || 1} / ${g.rounds || 1}`;
  $("resolution-mark").textContent = cleared ? "✓" : "!";
  $("resolution-kicker").textContent = cleared ? "CRISIS CONTAINED" : "HULL IMPACT";
  $("resolution-title").textContent = cleared ? "THE SHIP HELD" : "THE SIGNAL BROKE";
  $("resolution-copy").textContent = result.copy || (cleared
    ? `${result.stabilized ?? result.total ?? 5} systems stabilized. The next signal is already forming.`
    : `${result.stabilized ?? 0} of ${result.total ?? 5} systems answered before impact.`);
  renderResolutionCrew($("resolution-crew"), g);
  const hull = integrity(g);
  $("resolution-hull").textContent = `${hull.pct}%`;
  $("resolution-signal").textContent = `${result.stabilized ?? 0}/${result.total ?? 5}`;
  const key = `${g.round}:${cleared}:${hull.value}`;
  if (key !== S.lastResultKey) {
    S.lastResultKey = key;
    feedback(cleared ? "success" : "error", cleared ? [35, 22, 75] : [80, 30, 90]);
    if (cleared) Hub.confettiBurst(55);
    announce(cleared ? "Crisis contained." : "Crisis missed. The hull took damage.");
  }
}

function spectatorRoleProgress(g) {
  return new Map((g.progress?.systems || []).map((system) => [system.role, system]));
}
function renderSpectator(st) {
  show("scr-spectator");
  stopTilt();
  S.syncDown = false;
  const g = st.game || {};
  const crisis = g.crisis || {};
  const phase = st.phase;
  const result = g.resolution || {};
  const systems = spectatorRoleProgress(g);
  const people = roster();
  const total = Number(g.progress?.total || 5);
  const ready = systems.size
    ? [...systems.values()].filter((system) => system.ready).length
    : Number(g.progress?.ready || 0);
  const held = new Set(finalHeld(g));

  let phaseLabel = `CRISIS ${g.round || 1} / ${g.rounds || 1}`;
  let title = `${crisis.icon ? `${crisis.icon} ` : ""}${crisis.title || missionTitle(g)}`;
  let copy = crisis.alert
    || "The active crew is comparing private directives and stabilizing every console.";
  let progress = `${ready}/${total}`;
  if (phase === "briefing") {
    phaseLabel = `CRISIS ${g.round || 1} BRIEFING`;
    copy = "The active crew is receiving new assignments. Mission Control will reveal the public alert next.";
  } else if (phase === "resolution") {
    const cleared = resolutionCleared(result);
    phaseLabel = "INCIDENT REPORT";
    title = cleared ? "CRISIS CONTAINED" : "HULL IMPACT";
    copy = result.copy || (cleared
      ? "The crew stabilized the signal and is preparing for the next crisis."
      : "The signal struck the hull. The crew is still in the mission.");
    progress = `${result.stabilized ?? ready}/${result.total ?? total}`;
  } else if (phase === "final_sync") {
    const needed = Number(g.final?.needed || people.length || 3);
    phaseLabel = "FINAL TRANSMISSION";
    title = g.final?.synchronized ? "SIGNAL LOCKED" : "THE CREW IS LINKING";
    copy = "Every active crew member must hold the carrier wave together. Watch their signals connect live.";
    progress = `${held.size}/${needed}`;
  }

  $("spectator-phase").textContent = phaseLabel;
  $("spectator-title").textContent = title;
  $("spectator-copy").textContent = copy;
  $("spectator-hull").textContent = `${integrity(g).pct}%`;
  $("spectator-progress").textContent = progress;

  const stableByRole = new Map(
    (g.resolution?.systems || []).map((system) => [system.role, system.stable]),
  );
  const host = $("spectator-crew");
  host.textContent = "";
  for (const p of people) {
    const assigned = (p.roles || []).map(roleId);
    const assignedSystems = assigned.map((role) => systems.get(role)).filter(Boolean);
    const locked = assigned.length > 0 && assignedSystems.length === assigned.length
      && assignedSystems.every((system) => system.ready);
    const autopilot = assignedSystems.some((system) => system.autopilot);
    const linked = held.has(p.pid);
    const stable = assigned.length > 0
      && assigned.every((role) => stableByRole.get(role) !== false);
    const person = document.createElement("article");
    const active = phase === "final_sync" ? linked : phase === "resolution" ? stable : locked;
    person.className = `spectator-person${active ? " ready" : ""}${p.connected === false ? " away" : ""}`;
    const avatar = document.createElement("span");
    avatar.className = "brief-avatar";
    Hub.fillAvatar(avatar, p);
    const meta = document.createElement("p");
    const name = document.createElement("b");
    name.textContent = p.name || "CREW";
    const status = document.createElement("small");
    if (phase === "final_sync") {
      status.textContent = linked ? "SIGNAL LINKED" : "LINKING SIGNAL";
    } else if (phase === "resolution") {
      status.textContent = stable ? "SYSTEMS STABLE" : "SYSTEM IMPACT";
    } else if (phase === "briefing") {
      status.textContent = assigned.map((role) => roleMeta(role).title).join(" + ") || "ASSIGNING";
    } else if (p.connected === false) {
      status.textContent = autopilot ? "SIGNAL LOST · AUTOPILOT" : "SIGNAL LOST";
    } else if (locked) {
      status.textContent = autopilot ? "AUTOPILOT SECURED" : "CONSOLES LOCKED";
    } else {
      status.textContent = `${assignedSystems.filter((system) => system.ready).length}/${assigned.length || 1} CONSOLES LOCKED`;
    }
    const mark = document.createElement("i");
    mark.textContent = active ? "✓" : "LIVE";
    meta.append(name, status);
    person.append(avatar, meta, mark);
    host.appendChild(person);
  }
}

function finalHeld(g) {
  return Array.isArray(g?.final?.held) ? g.final.held : [];
}
function setSync(down) {
  down = !!down;
  if (S.syncDown === down) return;
  S.syncDown = down;
  const button = $("sync-btn");
  button?.classList.toggle("held", down);
  button?.setAttribute("aria-pressed", down ? "true" : "false");
  button?.setAttribute(
    "aria-label",
    down ? "Release to unlink your signal" : "Hold to link your signal with the crew",
  );
  if (S.st?.phase === "final_sync") S.conn?.send({ t: "sync", down });
  if (down) feedback("select", 30);
}
function renderSync(st) {
  show("scr-sync");
  stopTilt();
  const g = st.game || {};
  const final = g.final || {};
  const held = new Set(finalHeld(g));
  const mineHeld = held.has(S.pid) || !!final.holding;
  S.syncDown = mineHeld;
  $("sync-btn").classList.toggle("held", mineHeld);
  $("sync-btn").setAttribute("aria-pressed", mineHeld ? "true" : "false");
  $("sync-btn").setAttribute(
    "aria-label",
    mineHeld ? "Release to unlink your signal" : "Hold to link your signal with the crew",
  );
  $("sync-hull").textContent = `HULL ${integrity(g).pct}%`;
  $("sync-title").textContent = final.title || "HOLD TOGETHER";
  $("sync-copy").textContent = final.copy || "Every living console must hold the carrier wave at the same time.";
  const people = roster();
  const host = $("sync-crew");
  host.textContent = "";
  for (const p of people) {
    const person = document.createElement("div");
    person.className = "sync-person" + (held.has(p.pid) ? " holding" : "");
    const av = document.createElement("span");
    av.className = "sync-avatar";
    Hub.fillAvatar(av, p);
    person.appendChild(av);
    host.appendChild(person);
  }
  const needed = Number(final.needed || people.length || 3);
  $("sync-note").textContent = `${held.size} / ${needed} SIGNALS LINKED`;
}

const syncButton = $("sync-btn");
syncButton.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  syncButton.setPointerCapture(event.pointerId);
  setSync(true);
});
for (const eventName of ["pointerup", "pointercancel", "lostpointercapture"]) {
  syncButton.addEventListener(eventName, (event) => {
    event.preventDefault();
    setSync(false);
  });
}
syncButton.addEventListener("contextmenu", (event) => event.preventDefault());
syncButton.addEventListener("keydown", (event) => {
  if ((event.key === " " || event.key === "Enter") && !event.repeat) {
    event.preventDefault();
    setSync(true);
  }
});
syncButton.addEventListener("keyup", (event) => {
  if (event.key === " " || event.key === "Enter") {
    event.preventDefault();
    setSync(false);
  }
});
syncButton.addEventListener("blur", () => setSync(false));

function resultSuccess(result, g) {
  return !!(result?.success ?? result?.won ?? result?.escaped ?? integrity(g).value > 0);
}
function stat(host, label, value) {
  const item = document.createElement("span");
  const small = document.createElement("small");
  small.textContent = label;
  const strong = document.createElement("b");
  strong.textContent = value;
  item.append(small, strong);
  host.appendChild(item);
}
function renderEnd(st) {
  show("scr-end");
  stopTilt();
  setSync(false);
  const g = st.game || {};
  const result = g.result || {};
  const success = resultSuccess(result, g);
  $("scr-end").classList.toggle("failed", !success);
  $("end-kicker").textContent = result.kicker || (success ? "TRANSMISSION COMPLETE" : "TRANSMISSION LOST");
  $("end-title").textContent = result.title || (success ? "THE AURORA CAME HOME" : "THE DARK ANSWERED");
  $("end-copy").textContent = result.message || result.copy || (success
    ? `${roster().length} signals entered the dark. One crew answered.`
    : "The crew lost the carrier wave, but the next mission will never be the same.");
  const resultCrew = Array.isArray(result.crew) && result.crew.length ? result.crew : roster();
  renderPortraitStrip($("end-crew"), resultCrew, "end");
  const stats = $("end-stats");
  stats.textContent = "";
  stat(stats, "HULL", `${Number(result.integrity_pct ?? integrity(g).pct)}%`);
  stat(stats, "SIGNALS", result.crises_cleared ?? result.signals ?? result.cleared ?? 0);
  stat(stats, "CREW", resultCrew.length);
  const key = JSON.stringify(result);
  if (key !== S.lastResultKey) {
    S.lastResultKey = key;
    feedback(success ? "success" : "error", success ? [60, 30, 120] : [100, 40, 100]);
    if (success) Hub.confettiBurst(220);
    announce(success ? "Mission complete. Your crew came home." : "Mission lost. Your crew can answer another signal.");
  }
}

/* ---------- state / effects / lifecycle ---------- */
function onState(st) {
  const priorPhase = S.st?.phase || "";
  S.st = st;
  if (!S.joined) {
    show("scr-join");
    return;
  }
  if (st.game?.me === null
      && ["briefing", "crisis", "resolution", "final_sync"].includes(st.phase)) {
    renderSpectator(st);
    if (priorPhase && priorPhase !== st.phase) {
      announce(`Observer update: ${st.phase.replace("_", " ")}.`);
    }
    S.lastPhase = st.phase;
    return;
  }
  switch (st.phase) {
    case "lobby":
    case "countdown":
      stopTilt();
      setSync(false);
      S.activeRole = null;
      S.local.clear();
      S.lastRound = 0;
      S.lastResultKey = "";
      renderLobby(st);
      break;
    case "briefing": renderBriefing(st); break;
    case "crisis": renderConsole(st); break;
    case "resolution": renderResolution(st); break;
    case "final_sync": renderSync(st); break;
    case "game_end": renderEnd(st); break;
    default:
      if (st.game?.me?.consoles) renderConsole(st);
      else renderLobby(st);
  }
  if (priorPhase && priorPhase !== st.phase && st.phase !== "crisis") announce(`Mission phase: ${st.phase.replace("_", " ")}.`);
  S.lastPhase = st.phase;
}
function onFx(fx) {
  const mine = !fx.pid || fx.pid === S.pid || fx.to === S.pid;
  if (fx.kind === "invalid") {
    if (fx.msg) Hub.toast(fx.msg, "err");
    feedback("error", [45, 25, 45]);
    announce(fx.msg || "That console input did not stabilize the system.");
  } else if (fx.kind === "correct" || fx.kind === "stable" || fx.kind === "console_complete") {
    if (mine) {
      feedback("success", [24, 18, 58]);
      announce("Console stabilized.");
    }
  } else if (fx.kind === "damage" || fx.kind === "crisis_failed") {
    feedback("error", [75, 30, 90]);
  } else if (fx.kind === "toast" && fx.msg) {
    Hub.toast(`${fx.icon ? `${fx.icon} ` : ""}${fx.msg}`);
  }
}

function releaseTransientInputs() {
  setSync(false);
  stopTilt();
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) releaseTransientInputs();
});
window.addEventListener("pagehide", releaseTransientInputs);
window.addEventListener("blur", () => {
  if (S.syncDown) setSync(false);
});

Hub.wirePfpButton($("pfp-btn"), () => S.conn);
Hub.wirePfpButton($("pfp-btn2"), () => S.conn);
function connect() {
  if (S.conn) return S.conn;
  S.conn = Hub.connect("/games/fifthsignal/ws", {
    onWelcome: (message) => {
      S.pid = message.pid;
      if (Hub.identity.name) S.joined = true;
      if (S.st) onState(S.st);
    },
    onState,
    onFx,
  });
  return S.conn;
}

function updateClock() {
  const st = S.st;
  if (st?.deadline && S.conn) {
    const seconds = Math.max(0, Math.ceil((st.deadline - S.conn.now()) / 1000));
    if (st.phase === "crisis") $("crisis-clock").textContent = String(seconds);
  } else if (st?.phase === "crisis") {
    const progress = st.game?.progress;
    $("crisis-clock").textContent = progress ? `${progress.ready}/${progress.total}` : "LIVE";
  }
  requestAnimationFrame(updateClock);
}
requestAnimationFrame(updateClock);

if (Hub.identity.name) {
  S.joined = true;
  connect();
}
show(S.joined ? "scr-lobby" : "scr-join");

window.__fifthSignalPhone = {
  state: () => S.st,
  activeRole: () => S.activeRole,
  localControl: () => S.controlKey ? S.local.get(S.controlKey) : null,
  selectRole,
  choose(value) { const console = consoleFor(S.activeRole); if (console) sendControl(console, value); },
  sequenceKey(value) {
    const console = consoleFor(S.activeRole);
    if (!console || console.kind !== "sequence") return;
    const spec = controlSpec(console), sequence = localFor(console);
    if (sequence.length < spec.length) sequence.push(value);
    saveLocal(sequence);
    renderControl(console);
  },
  setDial(value) {
    const console = consoleFor(S.activeRole);
    if (!console || console.kind !== "dial") return;
    saveLocal(Number(value));
    renderControl(console);
  },
  setSwitch(index, value) {
    const console = consoleFor(S.activeRole);
    if (!console || console.kind !== "switches") return;
    const values = localFor(console);
    values[index] = !!value;
    saveLocal(values);
    renderControl(console);
  },
  setBalance(x, y) {
    const console = consoleFor(S.activeRole);
    if (!console || console.kind !== "balance") return;
    setBalanceAxis(console, "x", x, false);
    setBalanceAxis(console, "y", y, true);
  },
  submit() {
    const console = consoleFor(S.activeRole);
    if (console) sendControl(console, localFor(console));
  },
  holdSync: setSync,
  tiltStatus: () => S.tilt.status,
  releaseTransientInputs,
};
