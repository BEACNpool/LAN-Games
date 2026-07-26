/* GRIDIRON — read-only broadcast screen.
   The spectator receives only state_for(None); private play cards are never
   requested or rendered. The canvas interpolates compact public field
   snapshots while every timing-critical cue also appears in the TV overlay. */
"use strict";

const $ = (id) => document.getElementById(id);
const canvas = $("field-canvas");
const ctx = canvas.getContext("2d");
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const lerp = (a, b, amount) => a + (b - a) * amount;
const asNumber = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const plain = (value, fallback = "") => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || fallback;
};

const S = {
  st: null,
  view: null,
  previous: null,
  snapshotAt: performance.now(),
  conn: null,
  audio: false,
  wake: null,
  lastStage: "",
  lastCue: "",
  fxCue: null,
  fxCueTimer: null,
  lastResultKey: "",
  history: [],
  replay: null,
  ballTrail: [],
  confetti: false,
};

const TEAM_PALETTE = ["#2ba7ff", "#ff4f55"];
const ROLE_LABELS = {
  QB: "QB", RB: "RB", WR: "WR", WR1: "WR1", WR2: "WR2",
  CB: "CB", LB: "LB", DL: "DL", S: "S",
};
const ORDINAL = ["", "1ST", "2ND", "3RD", "4TH"];

function playerById(st, pid) {
  return (st?.players || []).find((player) => String(player.pid) === String(pid)) || null;
}

function validColor(value, fallback) {
  const color = String(value || "");
  return /^(#[\da-f]{3,8}|hsl[a]?\([^)]+\)|rgb[a]?\([^)]+\))$/i.test(color) ? color : fallback;
}

function normalizeTeams(g) {
  let raw = g?.teams;
  let rows = [];
  if (Array.isArray(raw)) {
    rows = raw.map((team, index) => {
      if (team && typeof team === "object") return { ...team, _key: team.id ?? team.team ?? index };
      return { id: team, name: team, _key: team };
    });
  } else if (raw && typeof raw === "object") {
    rows = Object.entries(raw).map(([key, team]) => (
      team && typeof team === "object"
        ? { ...team, _key: team.id ?? key }
        : { id: key, name: key, score: team, _key: key }
    ));
  }

  const scoreMap = g?.scores && typeof g.scores === "object" ? g.scores : {};
  if (!rows.length) {
    const scoreKeys = Object.keys(scoreMap);
    rows = (scoreKeys.length >= 2 ? scoreKeys.slice(0, 2) : ["blue", "red"])
      .map((key) => ({ id: key, name: key, _key: key }));
  }
  while (rows.length < 2) {
    const index = rows.length;
    rows.push({ id: index ? "red" : "blue", name: index ? "RED" : "BLUE", _key: index });
  }

  return rows.slice(0, 2).map((team, index) => {
    const id = team.id ?? team.team ?? team.side ?? team._key ?? index;
    const score = team.score ?? team.points ?? scoreMap[id] ?? scoreMap[String(id)] ?? 0;
    return {
      id: String(id),
      name: plain(team.name ?? team.label ?? id, index ? "RED" : "BLUE").toUpperCase(),
      score: asNumber(score),
      color: validColor(team.color, TEAM_PALETTE[index]),
      index,
    };
  });
}

function possessionId(g, teams) {
  let value = g?.possession_team ?? g?.possession ?? g?.offense_team ?? g?.offense;
  if (value && typeof value === "object") value = value.id ?? value.team ?? value.side;
  if (typeof value === "number" && teams[value]) return teams[value].id;
  if (value !== undefined && value !== null) {
    const match = teams.find((team) => team.id === String(value)
      || team.name.toLowerCase() === String(value).toLowerCase());
    if (match) return match.id;
  }
  return teams[0].id;
}

function normalizeRoster(st, g, teams, possession) {
  let raw = g?.roster ?? g?.assignments ?? [];
  if (!Array.isArray(raw) && raw && typeof raw === "object") {
    raw = Object.entries(raw).map(([pid, row]) => (
      row && typeof row === "object" ? { ...row, pid: row.pid ?? pid } : { pid, role: row }
    ));
  }
  if (!Array.isArray(raw)) raw = [];

  const carrier = g?.carrier_pid ?? g?.carrier ?? g?.ball?.carrier_pid ?? g?.ball?.carrier;
  const status = g?.play_status && typeof g.play_status === "object" ? g.play_status : {};
  const tackleWindow = g?.windows?.tackle;
  const catchWindow = g?.windows?.catch;
  const activeIds = new Set([
    carrier,
    status.carrier_pid,
    status.defender_pid,
    status.target_pid,
    status.receiver_pid,
    tackleWindow?.open ? tackleWindow.pid : null,
    catchWindow?.open ? catchWindow.pid : null,
  ].filter((value) => value !== undefined && value !== null).map(String));

  let rows = raw.map((entry, index) => {
    let row;
    if (Array.isArray(entry)) {
      row = { pid: entry[0], team: entry[1], role: entry[2], active: entry[3] };
    } else {
      row = entry && typeof entry === "object" ? entry : { pid: entry };
    }
    const pid = row.pid ?? row.player_id ?? row.token ?? row.id;
    const player = playerById(st, pid);
    let teamValue = row.team ?? row.team_id ?? row.side;
    if (teamValue && typeof teamValue === "object") teamValue = teamValue.id ?? teamValue.team;
    let team = teams.find((item) => item.id === String(teamValue));
    if (!team && typeof teamValue === "number") team = teams[teamValue];
    if (!team) team = teams[index % 2];
    const role = plain(row.role ?? row.position ?? row.assignment, "");
    return {
      pid,
      team: team.id,
      role: ROLE_LABELS[role.toUpperCase()] || role.toUpperCase() || "—",
      name: plain(row.name ?? player?.name, row.bot || player?.bot ? "BOT" : "PLAYER"),
      avatar: row.avatar ?? player?.avatar ?? (row.bot || player?.bot ? "🤖" : "●"),
      pfp: row.pfp ?? player?.pfp ?? "",
      bot: !!(row.bot ?? player?.bot),
      active: !!(row.active ?? row.is_carrier ?? row.is_nearest_defender) || activeIds.has(String(pid)),
      offense: team.id === possession,
    };
  });

  if (!rows.length) {
    rows = (st?.players || []).map((player, index) => ({
      pid: player.pid,
      team: teams[index % 2].id,
      role: "",
      name: plain(player.name, player.bot ? "BOT" : "PLAYER"),
      avatar: player.avatar || (player.bot ? "🤖" : "●"),
      pfp: player.pfp || "",
      bot: !!player.bot,
      active: false,
      offense: teams[index % 2].id === possession,
    }));
  }
  return rows;
}

function axis(value, limit) {
  let number = asNumber(value, limit / 2);
  if (number >= 0 && number <= 1) number *= limit;
  else if (limit < 60 && number > limit && number <= 100) number = number / 100 * limit;
  return clamp(number, 0, limit);
}

function fieldX(value, g) {
  const width = asNumber(g?.field?.w, 0);
  if (width > 0) return clamp(asNumber(value, width / 2) / width * 100, 0, 100);
  return axis(value, 100);
}

function fieldY(value, g) {
  const height = asNumber(g?.field?.h, 0);
  const number = asNumber(value, 0);
  // GRIDIRON's compact field uses a signed cross-field axis (-1..+1)
  // and advertises h=2. Convert it to the canvas' conventional 0..53.3.
  if (height > 0 && height <= 2.1) {
    return clamp((number + height / 2) / height * 53.3, 0, 53.3);
  }
  if (height > 0) return clamp(number / height * 53.3, 0, 53.3);
  return axis(value, 53.3);
}

function rawFieldRows(g) {
  if (Array.isArray(g?.field)) return g.field;
  if (Array.isArray(g?.field?.players)) return g.field.players;
  if (Array.isArray(g?.field?.units)) return g.field.units;
  if (Array.isArray(g?.units)) return g.units;
  if (Array.isArray(g?.chips)) return g.chips;
  return [];
}

function normalizeUnits(st, g, teams, roster) {
  const rosterMap = new Map(roster.map((row) => [String(row.pid), row]));
  const rows = rawFieldRows(g);
  return rows.map((entry, index) => {
    let row;
    if (Array.isArray(entry)) {
      row = {
        pid: entry[0], x: entry[1], y: entry[2], team: entry[3],
        role: entry[4], status: entry[5], has_ball: entry[6],
      };
    } else {
      row = entry && typeof entry === "object" ? entry : {};
    }
    const pid = row.pid ?? row.player_id ?? row.id ?? `unit-${index}`;
    const rosterRow = rosterMap.get(String(pid));
    const position = row.pos ?? row.coords ?? (typeof row.position === "object" ? row.position : null);
    const x = row.x ?? row.yard ?? position?.x ?? position?.[0] ?? 50;
    const y = row.y ?? row.lane ?? position?.y ?? position?.[1] ?? (8 + index * 4);
    let teamValue = row.team ?? row.team_id ?? row.side ?? rosterRow?.team;
    if (teamValue && typeof teamValue === "object") teamValue = teamValue.id ?? teamValue.team;
    let team = teams.find((item) => item.id === String(teamValue));
    if (!team && typeof teamValue === "number") team = teams[teamValue];
    team ||= teams[index % 2];
    const role = plain(
      row.role ?? (typeof row.position === "string" ? row.position : "") ?? rosterRow?.role,
      rosterRow?.role || "",
    ).toUpperCase();
    const p = playerById(st, pid);
    return {
      pid,
      x: fieldX(x, g),
      y: fieldY(y, g),
      team: team.id,
      color: team.color,
      role: ROLE_LABELS[role] || role,
      name: plain(row.name ?? rosterRow?.name ?? p?.name, row.bot || p?.bot ? "BOT" : "PLAYER"),
      avatar: row.avatar ?? rosterRow?.avatar ?? p?.avatar ?? (row.bot || p?.bot ? "🤖" : "●"),
      status: plain(row.status ?? row.state, ""),
      active: !!(row.active ?? row.is_carrier ?? row.is_nearest_defender ?? rosterRow?.active),
      hasBall: !!(row.has_ball ?? row.hasBall ?? row.is_carrier),
    };
  });
}

function normalizeBall(g, units) {
  let raw = g?.field && !Array.isArray(g.field) ? g.field.ball : null;
  raw ??= g?.ball;
  if (!raw) {
    const carrier = units.find((unit) => unit.hasBall);
    return carrier ? { x: carrier.x, y: carrier.y, carrier: carrier.pid, air: false } : null;
  }
  if (Array.isArray(raw)) {
    raw = {
      x: raw[0], y: raw[1],
      carrier: raw.length >= 5 ? raw[4] : raw[2],
      state: raw.length >= 5 ? raw[5] : raw[3],
    };
  }
  if (typeof raw !== "object") return null;
  const carrier = raw.carrier_pid ?? raw.carrier ?? raw.holder_pid ?? raw.holder;
  const holder = units.find((unit) => String(unit.pid) === String(carrier));
  const position = raw.pos ?? raw.position;
  return {
    x: holder ? holder.x : fieldX(raw.x ?? raw.yard ?? position?.x ?? position?.[0] ?? 50, g),
    y: holder ? holder.y : fieldY(raw.y ?? raw.lane ?? position?.y ?? position?.[1] ?? 0, g),
    carrier,
    air: !!(raw.air ?? raw.airborne ?? raw.in_air ?? raw.thrown) || plain(raw.state).toLowerCase() === "air",
    target: raw.target_pid ?? raw.target,
  };
}

function normalizeRoutes(g) {
  let raw = g?.field && !Array.isArray(g.field) ? g.field.routes : null;
  raw ??= g?.routes;
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const route = Array.isArray(entry)
      ? { pid: entry[0], points: entry[1], team: entry[2] }
      : (entry && typeof entry === "object" ? entry : {});
    const points = route.points ?? route.path ?? route.route ?? [];
    return {
      pid: route.pid ?? route.player_id,
      team: route.team ?? route.team_id,
      points: Array.isArray(points) ? points.map((point) => ({
        x: fieldX(Array.isArray(point) ? point[0] : point?.x, g),
        y: fieldY(Array.isArray(point) ? point[1] : point?.y, g),
      })).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)) : [],
    };
  }).filter((route) => route.points.length > 1);
}

function stageOf(st, g) {
  if (!st || st.phase === "lobby" || st.phase === "countdown") return st?.phase || "lobby";
  if (st.phase === "game_end") return "game_end";
  return plain(g?.stage ?? g?.phase ?? st.phase, "huddle").toLowerCase();
}

function normalize(st) {
  const g = st?.game || {};
  const teams = normalizeTeams(g);
  const possession = possessionId(g, teams);
  const roster = normalizeRoster(st, g, teams, possession);
  const units = normalizeUnits(st, g, teams, roster);
  const stage = stageOf(st, g);
  const directionValue = g.direction ?? g.drive_direction ?? g.offense_direction;
  const direction = asNumber(directionValue, teams.findIndex((team) => team.id === possession) === 1 ? -1 : 1) < 0 ? -1 : 1;
  const clockValue = g.stage_left ?? g.clock ?? g.play_clock ?? g.seconds_left ?? null;
  return {
    raw: g,
    stage,
    teams,
    possession,
    possessionNo: Math.max(1, asNumber(g.possession_no ?? g.possession_number ?? g.drive ?? 1, 1)),
    maxPossessions: Math.max(1, asNumber(g.max_possessions ?? g.possessions_total ?? 6, 6)),
    down: clamp(Math.round(asNumber(g.down, 1)), 1, 4),
    toGo: Math.max(0, Math.round(asNumber(g.to_go ?? g.distance, 10))),
    yard: clamp(asNumber(
      g.yard ?? g.ball_yard ?? g.line_of_scrimmage ?? g.field?.line_of_scrimmage,
      50,
    ), 0, 100),
    firstDown: g.field?.first_down === undefined
      ? null
      : clamp(asNumber(g.field.first_down), 0, 100),
    direction,
    clock: clockValue === null ? null : Math.max(0, asNumber(clockValue)),
    deadline: asNumber(g.stage_deadline ?? g.deadline ?? st?.deadline, 0),
    tick: asNumber(g.tick ?? g.seq ?? g.frame, 0),
    tickMs: clamp(asNumber(g.tick_ms ?? g.frame_ms, 75), 30, 500),
    roster,
    units,
    ball: normalizeBall(g, units),
    routes: normalizeRoutes(g),
    status: g.play_status ?? g.status ?? null,
    lastPlay: g.last_play ?? g.lastPlay ?? null,
    result: g.result ?? null,
  };
}

function roleName(role) {
  const key = plain(role).toUpperCase();
  return ROLE_LABELS[key] || key || "—";
}

function teamFor(view, value) {
  if (value && typeof value === "object") value = value.id ?? value.team ?? value.side;
  return view.teams.find((team) => team.id === String(value)
    || team.name.toLowerCase() === String(value || "").toLowerCase()) || null;
}

function cueFor(view) {
  if (view.stage !== "live" && view.stage !== "play") return null;
  const g = view.raw;
  const status = view.status;
  let kind = "";
  let row = {};
  if (g.windows?.catch?.open) {
    kind = "catch";
    row = g.windows.catch;
  } else if (g.windows?.tackle?.open) {
    kind = "tackle";
    row = g.windows.tackle;
  }
  if (status && typeof status === "object") {
    // play_status is normally an array of public team lock/reveal rows. Only
    // an object-shaped status can carry a legacy timing cue.
    if (!Array.isArray(status) && !kind) {
      row = status;
      const candidate = status.window ?? status.cue ?? status.moment
        ?? (status.window_open ? status.kind : "");
      kind = plain(candidate).toLowerCase();
      if (status.open === false || status.window_open === false) kind = "";
    }
  } else if (!kind) {
    kind = plain(status).toLowerCase();
  }
  if (!kind && g.catch_window && g.catch_window.open !== false) {
    kind = "catch";
    row = typeof g.catch_window === "object" ? g.catch_window : {};
  }
  if (!kind && g.tackle_window && g.tackle_window.open !== false) {
    kind = "tackle";
    row = typeof g.tackle_window === "object" ? g.tackle_window : {};
  }
  if (!kind && g.throw_window) {
    kind = "throw";
    row = typeof g.throw_window === "object" ? g.throw_window : {};
  }
  if (kind.includes("catch") || kind.includes("receive")) kind = "catch";
  else if (kind.includes("tackle") || kind.includes("hit")) kind = "tackle";
  else if (kind.includes("throw") || kind.includes("pass")) kind = "throw";
  else return null;

  const target = row.target_pid ?? row.receiver_pid ?? row.defender_pid ?? row.pid;
  const actor = playerById(S.st, target);
  if (kind === "catch") {
    return { kind, key: `catch:${target ?? ""}`, target, eyebrow: "CATCH WINDOW", label: "HANDS UP!", sub: actor ? `${actor.name.toUpperCase()} · REACH NOW` : "RECEIVER · REACH NOW" };
  }
  if (kind === "tackle") {
    return { kind, key: `tackle:${target ?? ""}`, target, eyebrow: "TACKLE WINDOW", label: "DIVE!", sub: actor ? `${actor.name.toUpperCase()} · TAP NOW` : "DEFENDER · TAP NOW" };
  }
  return { kind, key: `throw:${target ?? ""}`, target, eyebrow: "RECEIVER OPEN", label: "THROW!", sub: actor ? `${actor.name.toUpperCase()} IS OPEN` : "PICK YOUR TARGET" };
}

function displayClock(view) {
  let seconds = view.clock;
  if (view.stage !== "live" && view.stage !== "play" && view.deadline && S.conn) {
    seconds = Math.max(0, (view.deadline - S.conn.now()) / 1000);
  }
  if (seconds === null || seconds === undefined) {
    if (view.stage === "huddle") seconds = 12;
    else if (view.stage === "setup") seconds = 3;
    else if (view.stage === "whistle") seconds = 4;
    else seconds = 0;
  }
  return Math.max(0, Math.ceil(seconds));
}

function showScene(id) {
  for (const sceneId of ["tv-lobby", "tv-field", "tv-results"]) $(sceneId).hidden = sceneId !== id;
}

function avatarElement(className, row) {
  const avatar = document.createElement("span");
  avatar.className = className;
  Hub.fillAvatar(avatar, row);
  return avatar;
}

function renderLobby(st, view) {
  showScene("tv-lobby");
  const host = $("tv-lobby-roster");
  host.textContent = "";
  const humans = (st.players || []).filter((player) => !player.bot);
  for (const player of humans) {
    const row = document.createElement("div");
    row.className = `lobby-player${player.ready ? " ready" : ""}`;
    const name = document.createElement("b");
    name.textContent = plain(player.name, "PLAYER");
    const state = document.createElement("small");
    state.textContent = player.ready ? "READY" : "SUITING UP";
    row.append(avatarElement("av", player), name, state);
    host.appendChild(row);
  }
  const countdown = st.phase === "countdown";
  const seconds = view.deadline && S.conn ? Math.max(1, Math.ceil((view.deadline - S.conn.now()) / 1000)) : 3;
  $("tv-lobby-hint").textContent = countdown
    ? `TEAMS TAKING THE FIELD · ${seconds}`
    : humans.length
      ? `${humans.length} PLAYER${humans.length === 1 ? "" : "S"} DRESSED · READY UP ON A PHONE`
      : "SCAN TO SUIT UP · READY ON YOUR PHONE";
  $("tv-online").textContent = humans.length ? `● ${humans.length} CONNECTED` : "WAITING FOR PLAYERS";
}

function renderRoster(host, view, team) {
  host.textContent = "";
  const label = document.createElement("div");
  label.className = "roster-label";
  label.textContent = `${team.name} · ${team.id === view.possession ? "OFFENSE" : "DEFENSE"}`;
  host.appendChild(label);
  const rows = view.roster.filter((row) => row.team === team.id);
  for (const player of rows.slice(0, 8)) {
    const row = document.createElement("div");
    row.className = `role-row${player.active ? " live" : ""}`;
    row.style.setProperty("--team-color", team.color);
    const role = document.createElement("span");
    role.className = "role";
    role.textContent = roleName(player.role);
    const name = document.createElement("span");
    name.className = "player-name";
    name.textContent = `${player.name}${player.bot ? " 🤖" : ""}`;
    row.append(role, name, avatarElement("mini-av", player));
    host.appendChild(row);
  }
}

function stageCallout(view) {
  const status = view.status;
  if (Array.isArray(status) && view.stage === "huddle") {
    const locked = status.filter((row) => row?.locked).length;
    if (locked >= 2) return "BOTH PLAY CALLS LOCKED";
    if (locked === 1) return "ONE CALL LOCKED · OTHER SIDELINE IS HUDDLING";
  }
  if (status && typeof status === "object") {
    const publicText = !Array.isArray(status)
      ? status.public_text ?? status.message ?? status.label
      : null;
    if (publicText) return plain(publicText).toUpperCase();
  }
  if (view.stage === "huddle") return "PICK YOUR PLAY ON YOUR PHONE";
  if (view.stage === "setup") return "ASSIGNMENTS LOCKED · EYES ON THE FIELD";
  if (view.stage === "live" || view.stage === "play") {
    if (view.ball?.air) return "BALL IN THE AIR";
    const carrier = view.roster.find((row) => String(row.pid) === String(view.ball?.carrier));
    return carrier ? `${carrier.name.toUpperCase()} HAS THE BALL` : "THE PLAY IS LIVE";
  }
  if (view.stage === "whistle") return "PLAY DEAD · NEXT HUDDLE";
  return plain(view.stage, "GRIDIRON").toUpperCase();
}

function renderPossessions(view) {
  const host = $("possession-track");
  host.textContent = "";
  for (let index = 1; index <= view.maxPossessions; index++) {
    const dot = document.createElement("span");
    dot.className = `possession-dot${index < view.possessionNo ? " done" : ""}${index === view.possessionNo ? " now" : ""}`;
    host.appendChild(dot);
  }
}

function renderScoreboard(view) {
  const [teamA, teamB] = view.teams;
  document.documentElement.style.setProperty("--team-a-color", teamA.color);
  document.documentElement.style.setProperty("--team-b-color", teamB.color);
  $("team-a-name").textContent = teamA.name;
  $("team-b-name").textContent = teamB.name;
  $("team-a-score").textContent = String(teamA.score);
  $("team-b-score").textContent = String(teamB.score);
  $("team-a-possession").classList.toggle("off", teamA.id !== view.possession);
  $("team-b-possession").classList.toggle("off", teamB.id !== view.possession);
  $("phase-bug").textContent = view.stage === "live" || view.stage === "play" ? "BALL LIVE" : view.stage.toUpperCase();
  $("down-distance").textContent = `${ORDINAL[view.down]} & ${view.toGo || "GOAL"}`;
  $("field-position").textContent = `BALL ON ${Math.round(view.yard)} · DRIVE ${view.possessionNo}/${view.maxPossessions}`;
  const seconds = displayClock(view);
  $("tv-clock").textContent = `:${String(seconds).padStart(2, "0")}`;
  $("tv-clock").classList.toggle("hot", seconds <= 3 && !["whistle", "game_end"].includes(view.stage));
  $("play-callout").textContent = stageCallout(view);
  renderRoster($("team-a-roster"), view, teamA);
  renderRoster($("team-b-roster"), view, teamB);
  renderPossessions(view);
  $("assignment-strip").hidden = view.stage !== "setup";
}

function whistleCopy(view) {
  const last = view.lastPlay && typeof view.lastPlay === "object" ? view.lastPlay : {};
  const outcome = plain(last.outcome ?? last.kind ?? last.result ?? view.status).toLowerCase();
  let headline = "PLAY DEAD";
  if (outcome.includes("touchdown") || outcome === "td" || last.touchdown) headline = "TOUCHDOWN!";
  else if (last.turnover) headline = "TURNOVER!";
  else if (outcome.includes("intercept")) headline = "INTERCEPTED!";
  else if (outcome.includes("turnover")) headline = "TURNOVER!";
  else if (outcome.includes("sack")) headline = "SACKED!";
  else if (outcome.includes("incomplete") || outcome.includes("drop")) headline = "INCOMPLETE";
  else if (outcome.includes("catch") || outcome.includes("complete")) headline = "COMPLETE!";
  else if (outcome.includes("tackle") || outcome.includes("down")) headline = "TACKLED";

  const yards = last.yards ?? last.gain ?? last.yards_gained;
  let detail = plain(last.text ?? last.summary ?? last.public_text ?? last.message, "");
  if (!detail && yards !== undefined) detail = `${asNumber(yards) >= 0 ? "GAIN" : "LOSS"} OF ${Math.abs(Math.round(asNumber(yards)))} YARD${Math.abs(Math.round(asNumber(yards))) === 1 ? "" : "S"}`;
  const actorId = last.tackler_pid ?? last.receiver_pid ?? last.scorer_pid ?? last.actor_pid;
  const actor = playerById(S.st, actorId);
  if (actor && !detail) detail = actor.name.toUpperCase();
  return { headline, detail: detail.toUpperCase() || "NEXT DOWN" };
}

function renderCue(view) {
  const activeFxCue = S.fxCue
    && performance.now() < S.fxCue.until
    && (view.stage === "live" || view.stage === "play")
    ? S.fxCue : null;
  const cue = activeFxCue || cueFor(view);
  const host = $("moment-cue");
  host.hidden = !cue;
  if (cue) {
    host.className = `moment-cue ${cue.kind}${activeFxCue ? " result" : ""}`;
    $("moment-eyebrow").textContent = cue.eyebrow;
    $("moment-label").textContent = cue.label;
    $("moment-sub").textContent = cue.sub;
  }
  const whistle = $("whistle-card");
  whistle.hidden = view.stage !== "whistle";
  if (view.stage === "whistle") {
    const copy = whistleCopy(view);
    $("whistle-headline").textContent = copy.headline;
    $("whistle-detail").textContent = copy.detail;
  }
}

function winnerTeam(view) {
  const result = view.result;
  if ((result && !Array.isArray(result) && result.tie)
      || view.teams[0]?.score === view.teams[1]?.score) return null;
  let value = view.raw.winner_team ?? view.raw.winner;
  if (result && !Array.isArray(result) && typeof result === "object") {
    value = result.winner_team ?? result.team ?? result.winner ?? value;
  }
  const explicit = teamFor(view, value);
  if (explicit) return explicit;
  return [...view.teams].sort((a, b) => b.score - a.score)[0] || view.teams[0];
}

function renderResults(view) {
  showScene("tv-results");
  const [teamA, teamB] = view.teams;
  const winner = winnerTeam(view);
  document.documentElement.style.setProperty("--team-a-color", teamA.color);
  document.documentElement.style.setProperty("--team-b-color", teamB.color);
  $("winner-name").textContent = winner ? `${winner.name} WINS` : "GRIDIRON DRAW";
  $("final-a-name").textContent = teamA.name;
  $("final-b-name").textContent = teamB.name;
  $("final-a-score").textContent = String(teamA.score);
  $("final-b-score").textContent = String(teamB.score);

  const result = view.result && typeof view.result === "object" && !Array.isArray(view.result) ? view.result : {};
  $("result-detail").textContent = plain(
    result.headline ?? result.summary ?? result.detail,
    "FINAL WHISTLE · GREAT GAME",
  ).toUpperCase();
  const host = $("result-roster");
  host.textContent = "";
  for (const player of view.roster.filter((row) => !winner || row.team === winner.id)) {
    const row = document.createElement("div");
    row.className = `result-player${winner ? " win" : ""}`;
    row.append(avatarElement("mini-av", player));
    const name = document.createElement("span");
    name.textContent = `${player.name} · ${roleName(player.role)}`;
    row.appendChild(name);
    host.appendChild(row);
  }
  if (!S.confetti) {
    S.confetti = true;
    if (winner) {
      Hub.confettiBurst(300);
      Sound.win();
    }
  }
}

function render(st) {
  const oldView = S.view;
  const view = normalize(st);
  S.st = st;
  S.previous = oldView;
  S.view = view;
  S.snapshotAt = performance.now();

  if (view.stage === "live" || view.stage === "play") {
    S.history.push(view);
    if (S.history.length > 34) S.history.shift();
    if (view.ball) {
      const prior = S.ballTrail[S.ballTrail.length - 1];
      if (!prior || Math.hypot(prior.x - view.ball.x, prior.y - view.ball.y) > .12) {
        S.ballTrail.push({ x: view.ball.x, y: view.ball.y, air: view.ball.air });
        if (S.ballTrail.length > 24) S.ballTrail.shift();
      }
    }
  }
  if (view.stage === "huddle" || view.stage === "setup") {
    if (view.stage !== S.lastStage) {
      S.history = [];
      S.replay = null;
      S.ballTrail = [];
    }
  }
  if (view.stage === "whistle" && S.lastStage !== "whistle") {
    S.replay = { frames: [...S.history, view], at: performance.now() };
  }

  if (view.stage === "lobby" || view.stage === "countdown") {
    S.confetti = false;
    renderLobby(st, view);
  } else if (view.stage === "game_end") {
    renderResults(view);
  } else {
    showScene("tv-field");
    renderScoreboard(view);
    renderCue(view);
  }
  handleTransitions(oldView, view);
  S.lastStage = view.stage;
}

const Sound = (() => {
  let audioContext = null;
  const context = () => {
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === "suspended") audioContext.resume();
    return audioContext;
  };
  const tone = (frequency, duration, volume = .065, type = "square", delay = 0, endFrequency = null) => {
    if (!S.audio || localStorage.getItem("wc-muted") === "1") return;
    try {
      const ac = context();
      const start = ac.currentTime + delay;
      const oscillator = ac.createOscillator();
      const gain = ac.createGain();
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, start);
      if (endFrequency) oscillator.frequency.exponentialRampToValueAtTime(endFrequency, start + duration);
      gain.gain.setValueAtTime(.0001, start);
      gain.gain.exponentialRampToValueAtTime(volume, start + .015);
      gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
      oscillator.connect(gain);
      gain.connect(ac.destination);
      oscillator.start(start);
      oscillator.stop(start + duration + .04);
    } catch (error) { /* sound is optional; every cue is visual too */ }
  };
  const noise = (duration = .2, volume = .06) => {
    if (!S.audio || localStorage.getItem("wc-muted") === "1") return;
    try {
      const ac = context();
      const length = Math.ceil(ac.sampleRate * duration);
      const buffer = ac.createBuffer(1, length, ac.sampleRate);
      const data = buffer.getChannelData(0);
      for (let index = 0; index < length; index++) {
        data[index] = (Math.random() * 2 - 1) * Math.pow(1 - index / length, 1.5);
      }
      const source = ac.createBufferSource();
      const filter = ac.createBiquadFilter();
      const gain = ac.createGain();
      source.buffer = buffer;
      filter.type = "lowpass";
      filter.frequency.value = 1100;
      gain.gain.value = volume;
      source.connect(filter);
      filter.connect(gain);
      gain.connect(ac.destination);
      source.start();
    } catch (error) { /* optional */ }
  };
  return {
    unlock() { S.audio = true; try { context(); } catch (error) {} },
    snap() { noise(.13, .1); tone(120, .11, .08, "square", 0, 72); },
    catchWindow() { tone(760, .08, .075); tone(1040, .13, .07, "sine", .1); },
    tackleWindow() { tone(190, .09, .085, "square"); tone(240, .1, .08, "square", .11); },
    throwWindow() { tone(520, .08, .06); tone(720, .12, .06, "sine", .09); },
    whistle() { tone(2200, .22, .07, "sine"); tone(1750, .25, .07, "sine", .18); },
    touchdown() {
      noise(.55, .11);
      [262, 330, 392, 523].forEach((frequency, index) => tone(frequency, .32, .065, "square", index * .105));
    },
    win() { [262, 330, 392, 523, 659].forEach((frequency, index) => tone(frequency, .4, .06, "triangle", index * .11)); },
  };
})();

function flashSnap() {
  const flash = $("snap-flash");
  flash.hidden = false;
  flash.style.animation = "none";
  void flash.offsetWidth;
  flash.style.animation = "";
  clearTimeout(flash._timer);
  flash._timer = setTimeout(() => { flash.hidden = true; }, 600);
}

function handleTransitions(previous, view) {
  if (!previous) return;
  if ((view.stage === "live" || view.stage === "play")
      && previous.stage !== "live" && previous.stage !== "play") {
    flashSnap();
    Sound.snap();
  }
  const cue = cueFor(view);
  if (cue?.key !== S.lastCue) {
    if (cue?.kind === "catch") Sound.catchWindow();
    else if (cue?.kind === "tackle") Sound.tackleWindow();
    else if (cue?.kind === "throw") Sound.throwWindow();
  }
  S.lastCue = cue?.key || "";
  if (view.stage === "whistle" && previous.stage !== "whistle") {
    const copy = whistleCopy(view);
    if (copy.headline.includes("TOUCHDOWN")) Sound.touchdown();
    else Sound.whistle();
  }
}

function onFx(fx) {
  // Authoritative state transitions and public timing windows drive sound.
  // The same mutation also carries FX, so sounding both paths doubles every
  // snap/whistle. A tackle FX may also be an early whiff while play continues.
  if (fx?.kind === "tackle") {
    const result = plain(fx.result).toLowerCase();
    const copy = {
      early: {
        eyebrow: "TACKLE RESULT",
        label: "TOO EARLY!",
        sub: "WHIFF — THE RUNNER BREAKS FREE",
        toast: "Too early — tackle missed.",
      },
      miss: {
        eyebrow: "TACKLE RESULT",
        label: "WHIFF!",
        sub: "HE’S GONE",
        toast: "Tackle missed — runner breaks free.",
      },
      clean: {
        toast: "Clean tackle!",
      },
      late: {
        toast: "Arm tackle — the runner drags forward.",
      },
    }[result];
    if (copy) {
      Hub.toast(copy.toast);
      if (copy.label) {
        clearTimeout(S.fxCueTimer);
        S.fxCue = {
          kind: "tackle",
          eyebrow: copy.eyebrow,
          label: copy.label,
          sub: copy.sub,
          until: performance.now() + 1300,
        };
        if (S.view) renderCue(S.view);
        S.fxCueTimer = setTimeout(() => {
          S.fxCue = null;
          if (S.view) renderCue(S.view);
        }, 1300);
      }
      return;
    }
  }
  if (fx?.msg) Hub.toast(`${fx.icon ? `${fx.icon} ` : ""}${plain(fx.msg)}`);
}

function fitCanvas() {
  const box = canvas.getBoundingClientRect();
  const dpr = Math.min(2, devicePixelRatio || 1);
  const width = Math.max(1, Math.round(box.width * dpr));
  const height = Math.max(1, Math.round(box.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

function fieldGeometry() {
  const width = canvas.width;
  const height = canvas.height;
  return {
    width,
    height,
    left: width * .035,
    top: height * .105,
    fieldWidth: width * .93,
    fieldHeight: height * .79,
  };
}

function pointOnField(point, geometry) {
  return {
    x: geometry.left + clamp(point.x, 0, 100) / 100 * geometry.fieldWidth,
    y: geometry.top + clamp(point.y, 0, 53.3) / 53.3 * geometry.fieldHeight,
  };
}

function roundRectPath(x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function drawField(view, geometry) {
  const { width, height, left, top, fieldWidth, fieldHeight } = geometry;
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, "#020806");
  sky.addColorStop(.12, "#0a2418");
  sky.addColorStop(1, "#020705");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.shadowColor = "#000";
  ctx.shadowBlur = height * .045;
  ctx.fillStyle = "#0b6738";
  ctx.fillRect(left, top, fieldWidth, fieldHeight);
  ctx.shadowBlur = 0;

  const stripeWidth = fieldWidth / 20;
  for (let index = 0; index < 20; index++) {
    ctx.fillStyle = index % 2 ? "rgba(255,255,255,.026)" : "rgba(0,0,0,.035)";
    ctx.fillRect(left + index * stripeWidth, top, stripeWidth, fieldHeight);
  }

  const endWidth = fieldWidth * .075;
  const [teamA, teamB] = view.teams;
  ctx.globalAlpha = .66;
  ctx.fillStyle = teamA.color;
  ctx.fillRect(left, top, endWidth, fieldHeight);
  ctx.fillStyle = teamB.color;
  ctx.fillRect(left + fieldWidth - endWidth, top, endWidth, fieldHeight);
  ctx.globalAlpha = 1;

  ctx.strokeStyle = "rgba(255,255,255,.82)";
  ctx.lineWidth = Math.max(2, width * .0015);
  ctx.strokeRect(left, top, fieldWidth, fieldHeight);
  for (let yard = 10; yard < 100; yard += 5) {
    const x = left + yard / 100 * fieldWidth;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, top + fieldHeight);
    ctx.globalAlpha = yard % 10 === 0 ? .62 : .29;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  const hashLength = fieldHeight * .025;
  ctx.strokeStyle = "rgba(255,255,255,.68)";
  ctx.lineWidth = Math.max(1, width * .001);
  for (let yard = 11; yard < 100; yard++) {
    const x = left + yard / 100 * fieldWidth;
    for (const fraction of [.35, .65]) {
      const y = top + fieldHeight * fraction;
      ctx.beginPath();
      ctx.moveTo(x, y - hashLength / 2);
      ctx.lineTo(x, y + hashLength / 2);
      ctx.stroke();
    }
  }

  ctx.fillStyle = "rgba(255,255,255,.5)";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `900 ${Math.max(12, height * .029)}px JBMono, monospace`;
  for (let yard = 10; yard <= 90; yard += 10) {
    const label = yard <= 50 ? yard : 100 - yard;
    const x = left + yard / 100 * fieldWidth;
    ctx.save();
    ctx.translate(x, top + fieldHeight * .16);
    ctx.rotate(Math.PI);
    ctx.fillText(String(label), 0, 0);
    ctx.restore();
    ctx.fillText(String(label), x, top + fieldHeight * .84);
  }

  ctx.fillStyle = "rgba(255,255,255,.74)";
  ctx.font = `italic 900 ${Math.max(15, height * .042)}px Sora, sans-serif`;
  ctx.save();
  ctx.translate(left + endWidth / 2, top + fieldHeight / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(teamA.name.slice(0, 10), 0, 0);
  ctx.restore();
  ctx.save();
  ctx.translate(left + fieldWidth - endWidth / 2, top + fieldHeight / 2);
  ctx.rotate(Math.PI / 2);
  ctx.fillText(teamB.name.slice(0, 10), 0, 0);
  ctx.restore();

  const lineX = left + view.yard / 100 * fieldWidth;
  const gainYard = view.firstDown ?? clamp(view.yard + view.direction * view.toGo, 0, 100);
  const gainX = left + gainYard / 100 * fieldWidth;
  ctx.lineWidth = Math.max(3, width * .003);
  ctx.strokeStyle = "#48baff";
  ctx.shadowColor = "#48baff";
  ctx.shadowBlur = 9;
  ctx.beginPath();
  ctx.moveTo(lineX, top);
  ctx.lineTo(lineX, top + fieldHeight);
  ctx.stroke();
  ctx.strokeStyle = "#ffdf47";
  ctx.shadowColor = "#ffdf47";
  ctx.beginPath();
  ctx.moveTo(gainX, top);
  ctx.lineTo(gainX, top + fieldHeight);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.restore();
}

function drawRoutes(view, geometry) {
  if (view.stage !== "setup" || !view.routes.length) return;
  ctx.save();
  ctx.lineWidth = Math.max(3, geometry.width * .0027);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.setLineDash([geometry.width * .009, geometry.width * .006]);
  ctx.lineDashOffset = -(performance.now() / 38) % (geometry.width * .015);
  for (const route of view.routes) {
    const unit = view.units.find((entry) => String(entry.pid) === String(route.pid));
    const team = teamFor(view, route.team ?? unit?.team);
    ctx.strokeStyle = team?.color || "#ffffff";
    ctx.globalAlpha = .88;
    ctx.shadowColor = team?.color || "#fff";
    ctx.shadowBlur = 10;
    ctx.beginPath();
    route.points.forEach((point, index) => {
      const target = pointOnField(point, geometry);
      if (index) ctx.lineTo(target.x, target.y);
      else ctx.moveTo(target.x, target.y);
    });
    ctx.stroke();
    const end = pointOnField(route.points[route.points.length - 1], geometry);
    const before = pointOnField(route.points[route.points.length - 2], geometry);
    const angle = Math.atan2(end.y - before.y, end.x - before.x);
    const size = Math.max(10, geometry.width * .009);
    ctx.setLineDash([]);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.moveTo(end.x, end.y);
    ctx.lineTo(end.x - Math.cos(angle - .55) * size, end.y - Math.sin(angle - .55) * size);
    ctx.lineTo(end.x - Math.cos(angle + .55) * size, end.y - Math.sin(angle + .55) * size);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.setLineDash([geometry.width * .009, geometry.width * .006]);
  }
  ctx.restore();
}

function interpolatedUnits(view) {
  const previous = S.previous;
  if (!previous || previous.stage !== view.stage) return view.units;
  const amount = clamp((performance.now() - S.snapshotAt) / view.tickMs, 0, 1);
  const before = new Map(previous.units.map((unit) => [String(unit.pid), unit]));
  return view.units.map((unit) => {
    const old = before.get(String(unit.pid));
    return old ? { ...unit, x: lerp(old.x, unit.x, amount), y: lerp(old.y, unit.y, amount) } : unit;
  });
}

function interpolatedBall(view) {
  if (!view.ball || !S.previous?.ball || S.previous.stage !== view.stage) return view.ball;
  const amount = clamp((performance.now() - S.snapshotAt) / view.tickMs, 0, 1);
  return {
    ...view.ball,
    x: lerp(S.previous.ball.x, view.ball.x, amount),
    y: lerp(S.previous.ball.y, view.ball.y, amount),
  };
}

function replayView(view) {
  if (view.stage !== "whistle" || !S.replay?.frames?.length) return null;
  const elapsed = performance.now() - S.replay.at;
  const frames = S.replay.frames;
  const index = Math.min(frames.length - 1, Math.floor(clamp(elapsed / 1900, 0, 1) * frames.length));
  return frames[index];
}

function drawTrail(view, geometry) {
  if (!S.ballTrail.length) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let index = 1; index < S.ballTrail.length; index++) {
    const start = pointOnField(S.ballTrail[index - 1], geometry);
    const end = pointOnField(S.ballTrail[index], geometry);
    ctx.globalAlpha = index / S.ballTrail.length * .68;
    ctx.strokeStyle = S.ballTrail[index].air ? "#fff7d2" : "#ffcb47";
    ctx.lineWidth = Math.max(2, geometry.width * .0035 * index / S.ballTrail.length);
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawUnit(unit, view, geometry, cue, ghost = false) {
  const point = pointOnField(unit, geometry);
  const scale = Math.min(geometry.width / 1600, geometry.height / 900);
  const radius = clamp(22 * scale, 12, 30);
  const team = teamFor(view, unit.team);
  const color = team?.color || unit.color || "#fff";
  const isCarrier = String(view.ball?.carrier) === String(unit.pid) || unit.hasBall;
  const isCue = cue?.target !== undefined && String(cue.target) === String(unit.pid);

  ctx.save();
  ctx.globalAlpha = ghost ? .2 : 1;
  if (unit.active || isCarrier || isCue) {
    ctx.strokeStyle = isCue ? (cue.kind === "catch" ? "#45e7ff" : "#ffcb47") : "#ffdf67";
    ctx.lineWidth = Math.max(2, radius * .14);
    ctx.shadowColor = ctx.strokeStyle;
    ctx.shadowBlur = ghost ? 0 : radius * 1.2;
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius * (1.38 + .08 * Math.sin(performance.now() / 130)), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.shadowColor = "#000";
  ctx.shadowBlur = radius * .5;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = "rgba(255,255,255,.92)";
  ctx.lineWidth = Math.max(2, radius * .12);
  ctx.stroke();

  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `900 ${Math.max(9, radius * .68)}px JBMono, monospace`;
  ctx.fillText(roleName(unit.role).slice(0, 3) || "●", point.x, point.y + 1);

  if (!ghost) {
    ctx.font = `800 ${Math.max(9, radius * .58)}px Sora, sans-serif`;
    ctx.lineWidth = Math.max(3, radius * .24);
    ctx.strokeStyle = "rgba(0,0,0,.88)";
    ctx.textBaseline = "bottom";
    ctx.strokeText(unit.name.slice(0, 13), point.x, point.y - radius - 5);
    ctx.fillStyle = "#fff";
    ctx.fillText(unit.name.slice(0, 13), point.x, point.y - radius - 5);
  }
  ctx.restore();
}

function drawBall(ball, geometry) {
  if (!ball) return;
  const point = pointOnField(ball, geometry);
  const scale = Math.min(geometry.width / 1600, geometry.height / 900);
  const width = clamp(22 * scale, 12, 28);
  const height = width * .62;
  ctx.save();
  ctx.translate(point.x, point.y - (ball.carrier ? width * .72 : 0));
  ctx.rotate(ball.air ? -.38 + Math.sin(performance.now() / 70) * .15 : -.42);
  ctx.shadowColor = ball.air ? "#fff3bd" : "#000";
  ctx.shadowBlur = ball.air ? width * 1.25 : width * .5;
  ctx.fillStyle = "#8f3b20";
  ctx.beginPath();
  ctx.moveTo(-width, 0);
  ctx.bezierCurveTo(-width * .55, -height, width * .55, -height, width, 0);
  ctx.bezierCurveTo(width * .55, height, -width * .55, height, -width, 0);
  ctx.fill();
  ctx.strokeStyle = "#f4e8ca";
  ctx.lineWidth = Math.max(1.5, width * .12);
  ctx.beginPath();
  ctx.moveTo(-width * .35, 0);
  ctx.lineTo(width * .35, 0);
  ctx.stroke();
  for (let x = -width * .22; x <= width * .22; x += width * .15) {
    ctx.beginPath();
    ctx.moveTo(x, -height * .25);
    ctx.lineTo(x, height * .25);
    ctx.stroke();
  }
  ctx.restore();
}

function drawBroadcast() {
  requestAnimationFrame(drawBroadcast);
  const current = S.view;
  if (!current || ["lobby", "countdown", "game_end"].includes(current.stage) || $("tv-field").hidden) return;
  fitCanvas();
  const geometry = fieldGeometry();
  const replay = replayView(current);
  const view = replay || current;
  const cue = cueFor(current);
  drawField(current, geometry);
  drawRoutes(current, geometry);
  drawTrail(view, geometry);

  if (current.stage === "whistle" && S.replay?.frames?.length > 2) {
    const frames = S.replay.frames;
    for (const sample of [frames[Math.floor(frames.length * .28)], frames[Math.floor(frames.length * .58)]]) {
      for (const unit of sample?.units || []) drawUnit(unit, sample, geometry, null, true);
    }
  }

  const units = replay ? view.units : interpolatedUnits(view);
  for (const unit of units) drawUnit(unit, view, geometry, cue);
  drawBall(replay ? view.ball : interpolatedBall(view), geometry);
}

function refreshClock() {
  if (S.view && !["lobby", "countdown", "game_end"].includes(S.view.stage)) {
    const seconds = displayClock(S.view);
    $("tv-clock").textContent = `:${String(seconds).padStart(2, "0")}`;
    $("tv-clock").classList.toggle("hot", seconds <= 3 && S.view.stage !== "whistle");
  }
  if (S.view && ["lobby", "countdown"].includes(S.view.stage) && S.st) renderLobby(S.st, S.view);
}

async function holdWakeLock() {
  try { S.wake = await navigator.wakeLock?.request("screen"); } catch (error) { /* optional */ }
}

const joinUrl = new URL(".", location.href).href;
$("tv-url").textContent = joinUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
try {
  renderQR($("tv-qr"), joinUrl);
} catch (error) {
  $("tv-qr").textContent = "OPEN THE ADDRESS BELOW";
}

$("tv-curtain").addEventListener("click", () => {
  Sound.unlock();
  holdWakeLock();
  $("tv-curtain").hidden = true;
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && S.audio) holdWakeLock();
});
addEventListener("resize", fitCanvas);
setInterval(refreshClock, 250);
requestAnimationFrame(drawBroadcast);

S.conn = Hub.connect("/games/gridiron/ws", { onState: render, onFx }, { watch: true });
window.__gridironTV = {
  state: () => S.st,
  normalized: () => S.view,
  isTV: () => true,
  cue: () => S.view ? cueFor(S.view) : null,
  preview: (state) => render(state),
};
