/* FORT FLING — two-phone pull-and-release slingshot client.
   Physics and damage are authoritative on the server; the local preview is
   deliberately only an aiming guide. */
"use strict";

const $ = (id) => document.getElementById(id);

const S = {
  st: null, pid: null, conn: null, joined: false,
  selected: localStorage.getItem("ff-weapon") || "boulder",
  aim: { angle: 45, power: 0.40 },
  drag: null, localFired: false,
  anim: null, pendingState: null,
  particles: [], floaters: [],
  muted: localStorage.getItem("wc-muted") === "1",
};

const PHYSICS = {
  boulder: { speed: 1, gravity: 1 }, bomb: { speed: .94, gravity: 1.05 },
  cluster: { speed: 1, gravity: 1 }, rocket: { speed: 1.16, gravity: .58 },
  ricochet: { speed: 1.03, gravity: .92 },
};

/* ---------- sound ---------- */
const SFX = (() => {
  let ctx = null;
  const ac = () => {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  };
  const tone = (frequency, type, duration, volume = .1, delay = 0, glide = 0) => {
    if (S.muted) return;
    try {
      const c = ac(), at = c.currentTime + delay;
      const osc = c.createOscillator(), gain = c.createGain();
      osc.type = type; osc.frequency.setValueAtTime(frequency, at);
      if (glide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, frequency + glide), at + duration);
      gain.gain.setValueAtTime(.0001, at);
      gain.gain.exponentialRampToValueAtTime(volume, at + .015);
      gain.gain.exponentialRampToValueAtTime(.0001, at + duration);
      osc.connect(gain); gain.connect(c.destination); osc.start(at); osc.stop(at + duration + .04);
    } catch (error) { /* audio is optional */ }
  };
  return {
    unlock: () => { try { ac(); } catch (error) {} },
    click: () => tone(700, "square", .05, .045),
    stretch: () => tone(190, "triangle", .04, .035),
    launch: (weapon) => {
      if (weapon === "rocket") tone(115, "sawtooth", .55, .15, 0, 540);
      else tone(230, "sawtooth", .28, .12, 0, 240);
    },
    boom: () => { tone(68, "sawtooth", .5, .2, 0, -30); tone(130, "square", .24, .1, .02, -70); },
    hit: () => tone(310, "square", .14, .1, 0, -140),
    turn: () => { tone(740, "sine", .1, .1); tone(1047, "sine", .14, .09, .08); },
    win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, "sine", .23, .12, i * .08)),
    bad: () => tone(145, "sawtooth", .18, .08),
    tick: () => tone(1100, "square", .03, .04),
  };
})();

/* ---------- shared helpers ---------- */
const game = () => S.st?.game || null;
const playerByPid = (pid) => (S.st?.players || []).find((player) => player.pid === pid) || null;
const remainMs = () => S.st?.deadline ? Math.max(0, S.st.deadline - S.conn.now()) : 0;
const myTurn = () => game()?.your_turn === true && !S.localFired;
const ownFort = () => game()?.forts.find((fort) => fort.pid === S.pid) || null;

function show(id) {
  for (const screen of ["scr-join", "scr-lobby", "scr-game"]) screen === id
    ? ($(screen).hidden = false) : ($(screen).hidden = true);
}

function seg(hostId, options, current, key) {
  const host = $(hostId);
  host.textContent = "";
  for (const [value, label] of options) {
    const button = document.createElement("button");
    button.textContent = label;
    button.className = value === current ? "sel" : "";
    button.onclick = () => {
      SFX.click();
      S.conn.send({ t: "settings", patch: { [key]: value } });
    };
    host.appendChild(button);
  }
}

/* ---------- lobby ---------- */
function renderLobby(st) {
  const humans = st.players.filter((player) => !player.bot);
  const grid = $("player-grid");
  grid.textContent = "";
  for (let i = 0; i < 2; i++) {
    const player = humans[i];
    const card = document.createElement("div");
    card.className = "rival-card" + (player?.ready ? " ready" : "") + (!player ? " empty" : "");
    const avatar = document.createElement("div");
    avatar.className = "rival-av";
    if (player) Hub.fillAvatar(avatar, player); else avatar.textContent = "?";
    const name = document.createElement("div");
    name.className = "rival-name";
    name.textContent = player ? player.name + (player.pid === S.pid ? " · YOU" : "") : "OPEN FORT";
    const state = document.createElement("div");
    state.className = "rival-state";
    state.textContent = !player ? "waiting" : !player.connected ? "away" : player.ready ? "READY" : "not ready";
    card.append(avatar, name, state);
    grid.appendChild(card);
  }
  const ready = humans.filter((player) => player.ready && player.connected).length;
  $("ready-count").textContent = `${ready}/2 READY`;
  $("seat-note").textContent = humans.length < 2
    ? "Send the rival your hub QR — this arena needs exactly two phones."
    : "Both forts claimed. Ready up, then either player can launch.";
  seg("opt-timer", [[30, "30s"], [40, "40s"], [60, "60s"]], st.settings.turn_seconds, "turn_seconds");
  const me = st.you;
  const amReady = !!me?.ready;
  $("ready-btn").textContent = amReady ? "READY ✓" : "READY UP";
  $("ready-btn").classList.toggle("is-ready", amReady);
  $("go-btn").hidden = !(amReady && ready === 2 && st.phase === "lobby");
  $("lobby-hint").textContent = st.phase === "countdown" ? "FORTS LOCKING IN…"
    : humans.length < 2 ? `waiting at ${location.host}` : ready < 2 ? "both players must ready up" : "";
}

/* ---------- canvas ---------- */
const canvas = $("arena");
const ctx = canvas.getContext("2d");
let CW = 0, CH = 0;

function fitCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width; canvas.height = height;
  }
  CW = width; CH = height;
}

const px = (x) => x * CW / 1000;
const py = (y) => CH - y * CH / 560;
const ps = (value) => value * Math.min(CW / 1000, CH / 560);

function worldPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / rect.width * 1000,
    y: 560 - (event.clientY - rect.top) / rect.height * 560,
  };
}

function drawSky() {
  const sky = ctx.createLinearGradient(0, 0, 0, CH);
  sky.addColorStop(0, "#152952"); sky.addColorStop(.62, "#553061"); sky.addColorStop(1, "#d16a66");
  ctx.fillStyle = sky; ctx.fillRect(0, 0, CW, CH);
  ctx.fillStyle = "rgba(255,238,190,.84)";
  ctx.beginPath(); ctx.arc(CW * .76, CH * .17, Math.max(10, CH * .065), 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,.3)";
  for (let i = 0; i < 18; i++) {
    const x = (i * 173.7 % 1000), y = 500 - (i * 61.3 % 210);
    ctx.fillRect(px(x), py(y), Math.max(1, ps(2)), Math.max(1, ps(2)));
  }
  // soft code-drawn clouds
  for (const [x, y, size] of [[160, 430, 1], [615, 390, .75], [875, 475, .6]]) {
    ctx.fillStyle = "rgba(232,237,249,.11)";
    ctx.beginPath();
    ctx.ellipse(px(x), py(y), ps(65 * size), ps(18 * size), 0, 0, Math.PI * 2);
    ctx.ellipse(px(x - 32 * size), py(y + 5), ps(30 * size), ps(22 * size), 0, 0, Math.PI * 2);
    ctx.ellipse(px(x + 28 * size), py(y + 8), ps(38 * size), ps(26 * size), 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawTerrain(g) {
  ctx.beginPath(); ctx.moveTo(0, CH);
  for (let x = 0; x < g.terrain.length; x += 2) ctx.lineTo(px(x), py(g.terrain[x]));
  ctx.lineTo(CW, CH); ctx.closePath();
  const dirt = ctx.createLinearGradient(0, CH * .65, 0, CH);
  dirt.addColorStop(0, "#506849"); dirt.addColorStop(.13, "#263e36"); dirt.addColorStop(1, "#14232b");
  ctx.fillStyle = dirt; ctx.fill();
  ctx.beginPath();
  for (let x = 0; x < g.terrain.length; x += 3) {
    if (x === 0) ctx.moveTo(px(x), py(g.terrain[x])); else ctx.lineTo(px(x), py(g.terrain[x]));
  }
  ctx.strokeStyle = "rgba(142,205,108,.75)"; ctx.lineWidth = Math.max(2, ps(4)); ctx.stroke();
}

function roundedRect(x, y, width, height, radius) {
  ctx.beginPath(); ctx.roundRect(x, y, width, height, radius); ctx.fill();
}

function drawFort(fort, g) {
  const player = playerByPid(fort.pid);
  const color = player?.color || (fort.side === "left" ? "#22d3ee" : "#f472b6");
  const direction = fort.side === "left" ? 1 : -1;
  const baseX = px(fort.x), groundY = py(fort.y);
  const towerW = ps(74), towerH = ps(82);

  ctx.save();
  ctx.globalAlpha = fort.hp <= 0 ? .35 : 1;
  ctx.fillStyle = "rgba(18,25,44,.92)";
  roundedRect(baseX - towerW / 2, groundY - towerH, towerW, towerH, ps(8));
  ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.5, ps(3)); ctx.stroke();
  // battlements
  ctx.fillStyle = color;
  for (let i = -2; i <= 2; i += 2) ctx.fillRect(baseX + ps(i * 13) - ps(8), groundY - towerH - ps(11), ps(16), ps(13));
  // window and flag
  ctx.fillStyle = "rgba(7,11,20,.8)";
  roundedRect(baseX - ps(10), groundY - ps(48), ps(20), ps(31), ps(8));
  ctx.strokeStyle = color; ctx.lineWidth = Math.max(1, ps(2));
  ctx.beginPath(); ctx.moveTo(baseX, groundY - towerH - ps(12)); ctx.lineTo(baseX, groundY - towerH - ps(57)); ctx.stroke();
  ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(baseX, groundY - towerH - ps(55));
  ctx.lineTo(baseX + ps(35 * direction), groundY - towerH - ps(44));
  ctx.lineTo(baseX, groundY - towerH - ps(33)); ctx.closePath(); ctx.fill();
  ctx.font = `${Math.max(15, ps(34))}px serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(player?.avatar || "🏰", baseX, groundY - ps(48));
  ctx.restore();

  // Shield wall: stacked blocks fade and crack as health falls.
  if (fort.cover > 0) {
    const wallX = px(fort.cover_x), wallBottom = py(fort.cover_y);
    const blockW = ps(43), blockH = ps(28);
    const blocks = Math.max(1, Math.ceil(fort.cover / 15));
    for (let i = 0; i < blocks; i++) {
      const row = i, shift = i % 2 ? ps(4) : -ps(4);
      ctx.fillStyle = i === blocks - 1 && fort.cover < 20 ? "#8b5d52" : "#a97a62";
      roundedRect(wallX - blockW / 2 + shift, wallBottom - blockH * (row + 1), blockW, blockH - ps(2), ps(3));
      ctx.strokeStyle = "rgba(34,20,25,.55)"; ctx.lineWidth = Math.max(1, ps(1.5)); ctx.stroke();
      if (fort.cover < 35 && i === blocks - 1) {
        ctx.beginPath(); ctx.moveTo(wallX, wallBottom - blockH * row - ps(4));
        ctx.lineTo(wallX - ps(8), wallBottom - blockH * row - ps(14));
        ctx.lineTo(wallX + ps(5), wallBottom - blockH * row - ps(21)); ctx.stroke();
      }
    }
  }
}

function aimProjectile(fort) {
  const direction = fort.side === "left" ? 1 : -1;
  const length = S.aim.power * 155;
  const angle = S.aim.angle * Math.PI / 180;
  return {
    x: fort.sling_x - direction * Math.cos(angle) * length,
    y: fort.sling_y - Math.sin(angle) * length,
  };
}

function drawPreview(g, fort) {
  if (!myTurn()) return;
  const physics = PHYSICS[S.selected] || PHYSICS.boulder;
  const direction = fort.side === "left" ? 1 : -1;
  const angle = S.aim.angle * Math.PI / 180;
  const speed = (270 + 330 * S.aim.power) * physics.speed;
  let x = fort.sling_x, y = fort.sling_y;
  let vx = Math.cos(angle) * speed * direction, vy = Math.sin(angle) * speed;
  ctx.fillStyle = "rgba(232,237,249,.55)";
  for (let i = 0; i < 56; i++) {
    vx += g.wind * .78 * .06;
    vy -= 260 * physics.gravity * .06;
    x += vx * .06; y += vy * .06;
    if (i % 3 === 0) {
      ctx.beginPath(); ctx.arc(px(x), py(y), Math.max(1.5, ps(2.5)), 0, Math.PI * 2); ctx.fill();
    }
    if (x < 0 || x > 1000 || y < 0) break;
  }
}

function drawSling(fort, g) {
  const x = px(fort.sling_x), y = py(fort.sling_y);
  const mine = fort.pid === S.pid && myTurn();
  const projectile = mine && S.drag ? aimProjectile(fort) : { x: fort.sling_x, y: fort.sling_y };
  const qx = px(projectile.x), qy = py(projectile.y);
  const fork = ps(17);
  ctx.lineCap = "round";
  ctx.strokeStyle = mine ? "rgba(34,211,238,.95)" : "rgba(139,150,179,.65)";
  ctx.lineWidth = Math.max(3, ps(7));
  ctx.beginPath(); ctx.moveTo(x, py(g.terrain[Math.round(fort.sling_x)]));
  ctx.lineTo(x, y + ps(28)); ctx.moveTo(x, y + ps(28)); ctx.lineTo(x - fork, y - fork);
  ctx.moveTo(x, y + ps(28)); ctx.lineTo(x + fork, y - fork); ctx.stroke();
  if (mine) {
    ctx.strokeStyle = "rgba(251,191,36,.85)"; ctx.lineWidth = Math.max(1.5, ps(3));
    ctx.beginPath(); ctx.moveTo(x - fork, y - fork); ctx.lineTo(qx, qy);
    ctx.lineTo(x + fork, y - fork); ctx.stroke();
    ctx.shadowColor = "#22d3ee"; ctx.shadowBlur = ps(20);
  }
  ctx.font = `${Math.max(15, ps(27))}px serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const icon = game()?.weapons[S.selected]?.icon || "🪨";
  ctx.fillText(icon, qx, qy);
  ctx.shadowBlur = 0;
  if (mine && !S.drag) {
    ctx.strokeStyle = "rgba(34,211,238,.6)"; ctx.lineWidth = Math.max(1, ps(2));
    ctx.beginPath(); ctx.arc(x, y, ps(34), 0, Math.PI * 2); ctx.stroke();
  }
}

function drawAnimation() {
  const animation = S.anim;
  if (!animation || animation.done) return;
  const icon = game()?.weapons[animation.weapon]?.icon || animation.icon || "🪨";
  for (const path of animation.paths) {
    if (!path.points.length) continue;
    const index = Math.min(path.points.length - 1, Math.floor(animation.progress * (path.points.length - 1)));
    ctx.beginPath();
    for (let i = Math.max(0, index - 22); i <= index; i++) {
      const point = path.points[i];
      if (i === Math.max(0, index - 22)) ctx.moveTo(px(point[0]), py(point[1]));
      else ctx.lineTo(px(point[0]), py(point[1]));
    }
    ctx.strokeStyle = animation.weapon === "rocket" ? "rgba(251,113,133,.9)" : "rgba(251,191,36,.75)";
    ctx.lineWidth = Math.max(1.5, ps(3)); ctx.stroke();
    const point = path.points[index];
    ctx.font = `${Math.max(13, ps(23))}px serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(icon, px(point[0]), py(point[1]));
  }
}

function drawEffects() {
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (const particle of S.particles) {
    ctx.globalAlpha = Math.max(0, particle.life / 45);
    ctx.fillStyle = particle.color;
    ctx.fillRect(px(particle.x), py(particle.y), Math.max(2, ps(5)), Math.max(2, ps(5)));
  }
  for (const floater of S.floaters) {
    ctx.globalAlpha = Math.max(0, floater.life / 65);
    ctx.fillStyle = floater.part === "cover" ? "#fbbf24" : "#fb7185";
    ctx.font = `900 ${Math.max(12, ps(20))}px JBMono, monospace`;
    ctx.fillText(`-${floater.damage} ${floater.part === "cover" ? "SHIELD" : "HP"}`, px(floater.x), py(floater.y));
  }
  ctx.globalAlpha = 1;
}

function drawScene() {
  const g = game();
  if (!g) return;
  fitCanvas(); drawSky(); drawTerrain(g);
  for (const fort of g.forts) drawFort(fort, g);
  const mine = ownFort();
  if (mine) drawPreview(g, mine);
  for (const fort of g.forts) drawSling(fort, g);
  drawAnimation(); drawEffects();
}

addEventListener("resize", () => { fitCanvas(); drawScene(); });

/* ---------- pull-and-release ---------- */
function updateAim(point) {
  const fort = ownFort();
  if (!fort) return;
  const pullX = fort.side === "left" ? fort.sling_x - point.x : point.x - fort.sling_x;
  const pullY = fort.sling_y - point.y;
  const usefulX = Math.max(10, pullX), usefulY = Math.max(3, pullY);
  S.aim.angle = Math.max(10, Math.min(82, Math.atan2(usefulY, usefulX) * 180 / Math.PI));
  S.aim.power = Math.max(.2, Math.min(1, Math.hypot(usefulX, usefulY) / 155));
  $("aim-angle").textContent = `${Math.round(S.aim.angle)}°`;
  $("aim-power").textContent = `${Math.round(S.aim.power * 100)}%`;
  $("power-fill").style.width = `${Math.round(S.aim.power * 100)}%`;
  drawScene();
}

canvas.addEventListener("pointerdown", (event) => {
  if (!myTurn() || S.anim) return;
  const fort = ownFort();
  if (!fort) return;
  const point = worldPoint(event);
  if (Math.hypot(point.x - fort.sling_x, point.y - fort.sling_y) > 105) {
    Hub.toast("Grab the glowing sling first");
    return;
  }
  event.preventDefault(); SFX.unlock();
  canvas.setPointerCapture(event.pointerId);
  S.drag = { pointerId: event.pointerId, start: point, moved: 0 };
  updateAim(point);
});

canvas.addEventListener("pointermove", (event) => {
  if (!S.drag || event.pointerId !== S.drag.pointerId) return;
  event.preventDefault();
  const point = worldPoint(event);
  S.drag.moved = Math.max(S.drag.moved, Math.hypot(point.x - S.drag.start.x, point.y - S.drag.start.y));
  updateAim(point);
});

function releaseSling(event) {
  if (!S.drag || event.pointerId !== S.drag.pointerId) return;
  event.preventDefault();
  const moved = S.drag.moved;
  S.drag = null;
  drawScene();
  if (moved < 24 || !myTurn()) {
    Hub.toast("Pull farther before releasing");
    return;
  }
  S.localFired = true;
  S.conn.send({ t: "fire", weapon: S.selected,
                angle: S.aim.angle, power: S.aim.power });
  $("arena-callout").textContent = "FLING AWAY!";
}
canvas.addEventListener("pointerup", releaseSling);
canvas.addEventListener("pointercancel", (event) => {
  if (S.drag?.pointerId === event.pointerId) { S.drag = null; drawScene(); }
});

/* ---------- battle UI ---------- */
function renderFortBars(g) {
  const host = $("fort-bars"); host.textContent = "";
  g.forts.forEach((fort, index) => {
    if (index === 1) {
      const vs = document.createElement("span"); vs.className = "vs-chip"; vs.textContent = "VS"; host.appendChild(vs);
    }
    const player = playerByPid(fort.pid);
    const hud = document.createElement("div");
    hud.className = `fort-hud ${fort.side}` + (g.turn === fort.pid && g.stage === "battle" ? " turn" : "");
    const name = document.createElement("div"); name.className = "fh-name";
    const avatar = document.createElement("span"); Hub.fillAvatar(avatar, player);
    const label = document.createElement("span"); label.textContent = player?.name || "?";
    name.append(avatar, label);
    const bars = document.createElement("div"); bars.className = "fh-bars";
    const track = document.createElement("span"); track.className = "fh-track";
    const fill = document.createElement("span");
    fill.className = "fh-fill" + (fort.hp <= 30 ? " low" : fort.hp <= 60 ? " mid" : "");
    fill.style.width = `${fort.hp}%`; track.appendChild(fill);
    const hp = document.createElement("span"); hp.className = "fh-hp";
    hp.textContent = `${fort.hp}HP · 🧱${fort.cover}`;
    if (fort.side === "right") bars.append(hp, track); else bars.append(track, hp);
    hud.append(name, bars); host.appendChild(hud);
  });
}

function selectAvailableWeapon(g) {
  const fort = ownFort();
  if (!fort) return;
  if (!fort.inventory[S.selected]) {
    S.selected = Object.keys(g.weapons).find((key) => fort.inventory[key] > 0) || "boulder";
  }
}

function renderWeapons(g) {
  selectAvailableWeapon(g);
  const fort = ownFort();
  const belt = $("weapon-belt"); belt.textContent = "";
  for (const [key, weapon] of Object.entries(g.weapons)) {
    const count = fort?.inventory[key] ?? 0;
    const button = document.createElement("button");
    button.className = "weapon-btn" + (S.selected === key ? " sel" : "");
    button.disabled = !fort || count <= 0;
    button.title = weapon.desc;
    const icon = document.createElement("span"); icon.className = "wb-icon"; icon.textContent = weapon.icon;
    const name = document.createElement("span"); name.className = "wb-name"; name.textContent = weapon.name;
    const badge = document.createElement("span"); badge.className = "wb-count"; badge.textContent = count;
    button.append(icon, name, badge);
    button.onclick = () => {
      if (count <= 0) return;
      S.selected = key; localStorage.setItem("ff-weapon", key); SFX.click();
      renderWeapons(game()); drawScene();
    };
    belt.appendChild(button);
  }
  const selected = g.weapons[S.selected];
  $("belt-hint").textContent = selected?.name || "PICK ONE";
  $("drag-hint").textContent = myTurn()
    ? `${selected?.desc || "Pick a weapon"} · grab the glowing sling and release`
    : "You can choose your next weapon while your rival aims.";
}

function renderBattle(st) {
  const g = game();
  const turnPlayer = playerByPid(g.turn);
  Hub.fillAvatar($("turn-av"), turnPlayer);
  $("turn-name").textContent = myTurn() ? "YOUR FLING" : `${turnPlayer?.name || "RIVAL"} IS AIMING`;
  $("wind-chip").textContent = `WIND ${g.wind === 0 ? "·0" : (g.wind > 0 ? "→" : "←") + Math.abs(g.wind)}`;
  $("arena-callout").textContent = myTurn() ? "GRAB THE GLOWING SLING" : "WATCH THE RIVAL SHOT";
  $("arena-callout").classList.toggle("mine", myTurn());
  renderFortBars(g); renderWeapons(g); drawScene();
}

/* ---------- shot animation ---------- */
function explode(x, y) {
  SFX.boom();
  for (let i = 0; i < 44; i++) {
    const angle = Math.random() * Math.PI * 2;
    const velocity = 38 + Math.random() * 125;
    S.particles.push({ x, y, vx: Math.cos(angle) * velocity,
      vy: Math.sin(angle) * velocity + 42, life: 30 + Math.random() * 18,
      color: ["#fbbf24", "#fb7185", "#f59e0b", "#e8edf9"][i % 4] });
  }
}

function finishAnimation() {
  const animation = S.anim;
  if (!animation || animation.done) return;
  animation.done = true;
  for (const path of animation.paths) if (path.impact) explode(path.impact[0], path.impact[1]);
  for (const damage of animation.damages) {
    const fort = game()?.forts.find((item) => item.side === damage.side);
    if (fort) S.floaters.push({ x: damage.part === "cover" ? fort.cover_x : fort.x,
      y: fort.y + (damage.part === "cover" ? 120 : 145), damage: damage.damage,
      part: damage.part, life: 65 });
    if (fort?.pid === S.pid && damage.part === "fort") SFX.hit();
  }
  setTimeout(() => {
    S.anim = null;
    if (S.pendingState) {
      const pending = S.pendingState; S.pendingState = null; applyState(pending);
    }
  }, 700);
}

function stepEffects() {
  if (S.anim && !S.anim.done) {
    S.anim.progress += .018;
    if (S.anim.progress >= 1) finishAnimation();
  }
  for (const particle of S.particles) {
    particle.x += particle.vx * .026; particle.y += particle.vy * .026;
    particle.vy -= 190 * .026; particle.life--;
  }
  S.particles = S.particles.filter((particle) => particle.life > 0);
  for (const floater of S.floaters) { floater.y += .75; floater.life--; }
  S.floaters = S.floaters.filter((floater) => floater.life > 0);
  if (S.anim || S.particles.length || S.floaters.length) drawScene();
}

/* ---------- results ---------- */
let gameoverShown = false;
function renderGameOver(st) {
  const g = game();
  const shown = st.phase === "game_end" && g?.result;
  $("gameover").hidden = !shown;
  if (!shown) { gameoverShown = false; return; }
  const winner = playerByPid(g.result.winner);
  $("go-title").textContent = winner ? `${winner.name.toUpperCase()} HOLDS THE FORT` : "FORTRESS DRAW";
  $("go-line").textContent = `${g.result.shots} flings · ${g.result.why}`;
  const rows = $("go-rows"); rows.textContent = "";
  for (const standing of [...g.result.standings].sort((a, b) => b.hp - a.hp || b.dealt - a.dealt)) {
    const player = playerByPid(standing.pid);
    const row = document.createElement("div"); row.className = "go-row" + (standing.pid === g.result.winner ? " win" : "");
    const avatar = document.createElement("span"); Hub.fillAvatar(avatar, player);
    const name = document.createElement("span"); name.textContent = `${player?.name || "?"} · ${standing.hp}HP`;
    const detail = document.createElement("b"); detail.textContent = `${standing.dealt} dmg`;
    row.append(avatar, name, detail); rows.appendChild(row);
  }
  if (!gameoverShown) {
    gameoverShown = true;
    if (g.result.winner === S.pid) { Hub.confettiBurst(220); SFX.win(); }
    else SFX.boom();
  }
}

/* ---------- state/fx ---------- */
function applyState(st) {
  S.st = st;
  if (!S.joined) return;
  if (st.phase === "lobby" || st.phase === "countdown") {
    show("scr-lobby"); S.localFired = false; S.drag = null; S.anim = null;
    S.particles = []; S.floaters = []; renderLobby(st);
  } else if (st.game) {
    show("scr-game");
    if (st.game.stage === "battle") S.localFired = false;
    renderBattle(st);
  }
  renderGameOver(st);
  $("countdown-overlay").hidden = st.phase !== "countdown";
}

function onState(st) {
  if (S.anim && !S.anim.done) {
    S.pendingState = st;
    S.st = { ...S.st, players: st.players, deadline: st.deadline, now: st.now };
    return;
  }
  applyState(st);
}

function onFx(fx) {
  switch (fx.kind) {
    case "toast": Hub.toast((fx.icon ? fx.icon + " " : "") + fx.msg); break;
    case "invalid": S.localFired = false; Hub.toast(fx.msg, "err"); SFX.bad(); break;
    case "flung":
      SFX.launch(fx.weapon);
      S.anim = { paths: fx.paths || [], damages: fx.damages || [], weapon: fx.weapon,
        icon: fx.icon, progress: 0, done: false };
      break;
    case "turn":
      if (fx.pid === S.pid) {
        SFX.turn();
        try { if (navigator.vibrate) navigator.vibrate(70); } catch (error) {}
      }
      break;
    case "battle_start": SFX.turn(); break;
  }
}

/* brag card */
if (window.Brag) {
  const button = Brag.button(() => {
    const g = game();
    if (!g?.result?.winner) return null;
    const winner = playerByPid(g.result.winner);
    const loser = g.result.standings.find((standing) => standing.pid !== g.result.winner);
    const rival = playerByPid(loser?.pid);
    return {
      title: "Fort Fling", icon: "🏰",
      winner: { name: winner?.name || "?", avatar: winner?.avatar || "🏰", pfp: winner?.pfp || null },
      headline: `${g.result.shots} flings · ${g.result.why}`,
      beaten: rival ? [{ name: rival.name }] : [],
    };
  });
  document.querySelector("#gameover .modal-card").insertBefore(button, $("rematch-btn"));
}

/* ---------- timer loop ---------- */
let lastTick = -1;
function frame() {
  requestAnimationFrame(frame); stepEffects();
  if (!S.st) return;
  if (S.st.phase === "countdown") $("countdown-num").textContent = Math.max(1, Math.ceil(remainMs() / 1000));
  const g = game();
  if (S.anim && !S.anim.done) {
    $("turn-clock").textContent = "—";
    $("turn-clock").classList.remove("low");
  } else if (g?.stage === "battle") {
    const seconds = Math.ceil(remainMs() / 1000);
    $("turn-clock").textContent = seconds;
    $("turn-clock").classList.toggle("low", seconds <= 10);
    if (myTurn() && seconds <= 5 && seconds > 0 && seconds !== lastTick) { lastTick = seconds; SFX.tick(); }
  }
  if (S.st.phase === "game_end") $("go-auto").textContent = `lobby in ${Math.ceil(remainMs() / 1000)}s`;
}
requestAnimationFrame(frame);

/* ---------- boot ---------- */
$("ready-btn").onclick = () => {
  SFX.unlock(); SFX.click();
  S.conn.send({ t: "ready", ready: !S.st?.you?.ready });
};
$("go-btn").onclick = () => { SFX.unlock(); S.conn.send({ t: "start" }); };
$("rematch-btn").onclick = () => S.conn.send({ t: "again" });
$("mute-btn").onclick = () => {
  S.muted = !S.muted; localStorage.setItem("wc-muted", S.muted ? "1" : "0");
  $("mute-btn").textContent = S.muted ? "🔇" : "🔊";
};
$("mute-btn").textContent = S.muted ? "🔇" : "🔊";

function connect() {
  S.conn = Hub.connect("/games/fortfling/ws", {
    onWelcome: (message) => { S.pid = message.pid; },
    onState, onFx,
  });
}

let avatarPick = Hub.identity.avatar || Hub.AVATARS[(Math.random() * Hub.AVATARS.length) | 0];
Hub.buildAvatarGrid($("avatar-grid"), avatarPick, (avatar) => { avatarPick = avatar; });
Hub.wirePfpButton($("pfp-btn"), () => S.conn);
Hub.wirePfpButton($("pfp-btn2"), () => S.conn);
$("name-input").value = Hub.identity.name;
$("join-btn").onclick = () => {
  SFX.unlock();
  Hub.identity.name = $("name-input").value.trim() || "PLAYER";
  Hub.identity.avatar = avatarPick;
  S.joined = true; connect(); show("scr-lobby");
};
$("name-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") $("join-btn").click();
});

if (Hub.identity.name) {
  S.joined = true; connect(); show("scr-lobby");
} else {
  show("scr-join");
}

/* Test hook: uses the exact public action path, never mutates client state. */
window.FORT_FLING_DEV = {
  fire: (weapon = S.selected, angle = 45, power = .55) =>
    S.conn?.send({ t: "fire", weapon, angle, power }),
  state: () => S.pendingState || S.st,
};
