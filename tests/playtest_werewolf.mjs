// playtest_werewolf.mjs — FIVE browser players run a full scripted night:
// role cards -> night 1 (wolf kills a villager, seer reads the wolf, doctor
// misses) -> dawn -> day (everyone readies early) -> vote out the wolf ->
// VILLAGE WINS. Asserts role secrecy the hard way: every WS state a living
// villager received is scanned for wolf identity leaks, the vote tally stays
// sealed until the vote closes, and the dead villager's ghost view saw the
// wolf. Screenshots the role card, night screens, dawn, vote, and the win.
// Usage: node tests/playtest_werewolf.mjs [baseURL] [shotdir]

import { createRequire } from "module";
import os from "os";
import fs from "fs";
const require = createRequire("/home/ubuntudesktop/projects/webdev-toolkit/x.js");
const puppeteer = require("puppeteer-core");

const BASE = process.argv[2] || "http://127.0.0.1:8126";
const OUT = process.argv[3] || os.homedir() + "/tmp/gamehub-shots";
fs.mkdirSync(OUT, { recursive: true });

const PHONE = { width: +(process.env.SHOT_W || 390), height: +(process.env.SHOT_H || 844), deviceScaleFactor: 2 };
const errors = [];
let step = "boot";
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fail(msg) { console.error("FAIL @ " + step + ": " + msg); process.exitCode = 1; }

const browser = await puppeteer.launch({
  executablePath: "/snap/bin/chromium", headless: "new",
  userDataDir: os.homedir() + "/tmp/ghshot-ww",
  args: ["--no-sandbox", "--disable-gpu"],
});
const newCtx = () => browser.createBrowserContext
  ? browser.createBrowserContext() : browser.createIncognitoBrowserContext();

async function shot(page, nm) {
  await page.screenshot({ path: `${OUT}/${nm}.png` });
  log("shot: " + nm);
}

async function mkPlayer(name, avatarIdx) {
  const ctx = await newCtx();
  const page = await ctx.newPage();
  await page.setViewport(PHONE);
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${name}: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`${name} pageerror: ${e.message}`));
  // record every WS state message this client EVER receives (leak scan)
  await page.evaluateOnNewDocument(() => {
    window.__wsLog = [];
    const Orig = window.WebSocket;
    const Wrapped = function (...args) {
      const ws = new Orig(...args);
      ws.addEventListener("message", (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.type === "state" && window.__wsLog.length < 2000) window.__wsLog.push(m);
        } catch (e) {}
      });
      return ws;
    };
    Wrapped.prototype = Orig.prototype;
    for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Wrapped[k] = Orig[k];
    window.WebSocket = Wrapped;
  });
  await page.goto(BASE + "/games/werewolf/", { waitUntil: "networkidle2" });
  await page.waitForSelector("#scr-join:not([hidden])", { timeout: 5000 });
  await page.type("#name-input", name);
  await page.evaluate((i) =>
    document.querySelectorAll("#avatar-grid .avatar-cell")[i].click(), avatarIdx);
  await page.click("#join-btn");
  await page.waitForSelector("#scr-lobby:not([hidden])", { timeout: 5000 });
  page._name = name;
  return page;
}

const ww = (page) => page.evaluate(() => window.__ww ? window.__ww() : null);

async function waitStage(pages, stage, t = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < t) {
    const w = await ww(pages[0]);
    if (w && w.stage === stage) return true;
    await sleep(200);
  }
  return false;
}

try {
  step = "join";
  const names = ["Ava", "Rex", "Kai", "Zoe", "Moe"];
  const pages = [];
  for (let i = 0; i < names.length; i++) pages.push(await mkPlayer(names[i], i * 3));
  await sleep(400);

  step = "lobby";
  // day length 2:00 (irrelevant — everyone readies early)
  await pages[0].evaluate(() => document.querySelectorAll("#opt-day button")[0].click());
  await sleep(200);
  const dayVal = await pages[1].evaluate(() =>
    document.querySelector("#opt-day button.sel").textContent);
  if (dayVal !== "2:00") fail("day setting didn't sync: " + dayVal);
  for (const p of pages) {
    await p.evaluate(() => document.getElementById("ready-btn").click());
    await sleep(120);
  }
  await pages[0].waitForSelector("#go-btn:not([hidden])", { timeout: 6000 });
  await shot(pages[0], "80-werewolf-lobby");
  await pages[0].evaluate(() => document.getElementById("go-btn").click());
  log("the hunt begins");

  step = "roles";
  if (!await waitStage(pages, "role", 12000)) throw new Error("role stage never arrived");
  await sleep(300);
  const cast = {};              // role -> page
  for (const p of pages) {
    const w = await ww(p);
    p._pid = w.pid; p._role = w.role;
    if (w.role === "wolf") cast.wolf = p;
    else if (w.role === "seer") cast.seer = p;
    else if (w.role === "doctor") cast.doctor = p;
    else (cast.villagers = cast.villagers || []).push(p);
  }
  if (!cast.wolf || !cast.seer || !cast.doctor || cast.villagers.length !== 2) {
    throw new Error("role deal wrong: " + pages.map((p) => p._role).join(","));
  }
  log("cast: wolf=" + cast.wolf._name + " seer=" + cast.seer._name
      + " doctor=" + cast.doctor._name
      + " villagers=" + cast.villagers.map((p) => p._name).join("+"));
  // hold-to-peek: face shows only while the finger is down
  await cast.wolf.evaluate(() => {
    document.getElementById("role-card")
      .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  });
  await sleep(450);
  const peeked = await cast.wolf.evaluate(() =>
    document.getElementById("role-card").classList.contains("peek"));
  if (!peeked) fail("hold-to-peek didn't flip the card");
  await shot(cast.wolf, "81-werewolf-rolecard");
  await cast.wolf.evaluate(() => {
    document.getElementById("role-card")
      .dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  });
  const unpeeked = await cast.wolf.evaluate(() =>
    !document.getElementById("role-card").classList.contains("peek"));
  if (!unpeeked) fail("card stayed face-up after release");
  for (const p of pages) {
    await p.evaluate(() => document.getElementById("role-ack").click());
    await sleep(120);
  }

  step = "night1-wolf";
  if (!await waitStage(pages, "night_wolf", 15000)) throw new Error("wolf phase never arrived");
  await sleep(300);
  const victim = cast.villagers[0];
  await shot(cast.villagers[1], "82-werewolf-sleeping");   // a sleeper's screen
  await cast.wolf.evaluate((pid) => {
    document.querySelector(`#act-grid .tg-cell[data-pid="${pid}"]`).click();
  }, victim._pid);
  await sleep(300);
  await shot(cast.wolf, "83-werewolf-wolfpick");
  await cast.wolf.evaluate(() => document.getElementById("act-lock").click());
  log("wolf marked " + victim._name);

  step = "night1-seer";
  if (!await waitStage(pages, "night_seer", 12000)) throw new Error("seer phase never arrived");
  await sleep(300);
  await cast.seer.evaluate((pid) => {
    document.querySelector(`#act-grid .tg-cell[data-pid="${pid}"]`).click();
  }, cast.wolf._pid);
  await sleep(400);
  const vision = await ww(cast.seer);
  if (!vision.vision || vision.vision.wolf !== true) fail("seer vision wrong: " + JSON.stringify(vision.vision));
  const seerText = await cast.seer.$eval("#seer-result", (e) => e.textContent);
  if (!/A WEREWOLF/.test(seerText)) fail("seer result screen wrong: " + seerText);
  await shot(cast.seer, "84-werewolf-seer");
  log("seer saw the wolf");

  step = "night1-doctor";
  if (!await waitStage(pages, "night_doctor", 12000)) throw new Error("doctor phase never arrived");
  await sleep(300);
  await cast.doctor.evaluate((pid) => {
    document.querySelector(`#act-grid .tg-cell[data-pid="${pid}"]`).click();
  }, cast.doctor._pid);                                    // guards herself: miss
  log("doctor guarded herself");

  step = "dawn";
  if (!await waitStage(pages, "dawn", 12000)) throw new Error("dawn never arrived");
  await sleep(500);
  const dawnText = await cast.villagers[1].$eval("#dawn-body", (e) => e.textContent);
  if (!dawnText.includes(victim._name)) fail("dawn didn't name the victim: " + dawnText);
  if (!/VILLAGER/.test(dawnText)) fail("dawn didn't reveal the role: " + dawnText);
  await shot(cast.villagers[1], "85-werewolf-dawn");

  step = "day";
  if (!await waitStage(pages, "day", 15000)) throw new Error("day never arrived");
  await sleep(400);
  const ghostW = await ww(victim);
  if (!ghostW.ghost) fail("dead villager isn't flagged ghost");
  if (!ghostW.omniRoles || ghostW.omniRoles[cast.wolf._pid] !== "wolf") {
    fail("ghost can't see the wolf: " + JSON.stringify(ghostW.omniRoles));
  }
  const ghostBanner = await victim.$eval(".ghost-banner", (e) => e.textContent);
  if (!/GHOST/.test(ghostBanner)) fail("ghost banner missing");
  await shot(victim, "86-werewolf-ghost");
  const alivePages = pages.filter((p) => p !== victim);
  for (const p of alivePages) {
    await p.evaluate(() => document.getElementById("ready-vote").click());
    await sleep(150);
  }

  step = "vote";
  if (!await waitStage(pages, "vote", 12000)) throw new Error("vote never opened early");
  await sleep(300);
  // everyone (wolf included) votes the wolf; tally must stay sealed meanwhile
  for (const p of alivePages) {
    await p.evaluate((pid) => {
      document.querySelector(`#vote-grid .tg-cell[data-pid="${pid}"]`).click();
    }, cast.wolf._pid);
    await sleep(120);
    if (p === alivePages[0]) await shot(p, "87-werewolf-vote");
    const sealed = await p.evaluate(() => {
      const g = window.__ww();
      return g.stage !== "vote" || !document.body.innerText.match(/\d+ votes?/);
    });
    if (!sealed) fail("live tally visible during the vote");
    await p.evaluate(() => document.getElementById("vote-lock").click());
    await sleep(120);
  }

  step = "verdict";
  if (!await waitStage(pages, "verdict", 12000)) throw new Error("verdict never arrived");
  await sleep(500);
  const verdictText = await cast.seer.$eval("#verdict-body", (e) => e.textContent);
  if (!verdictText.includes(cast.wolf._name) || !/WEREWOLF/.test(verdictText)) {
    fail("verdict didn't expose the wolf: " + verdictText);
  }
  await shot(cast.seer, "88-werewolf-verdict");

  step = "gameover";
  const t0 = Date.now();
  let won = false;
  while (Date.now() - t0 < 15000) {
    const w = await ww(pages[0]);
    if (w.winner === "village") { won = true; break; }
    await sleep(250);
  }
  if (!won) throw new Error("village never won");
  await sleep(600);
  const bannerText = await cast.seer.$eval("#go-banner", (e) => e.textContent);
  if (!/VILLAGE WINS/.test(bannerText)) fail("winner banner wrong: " + bannerText);
  const roleRows = await cast.villagers[1].$$eval("#go-roles .go-row", (es) => es.length);
  if (roleRows !== 5) fail("full role reveal missing rows: " + roleRows);
  await cast.seer.evaluate(() =>
    document.querySelector(".go-logwrap").setAttribute("open", ""));
  await shot(cast.seer, "89-werewolf-gameover");

  step = "brag";
  const hasBrag = await cast.seer.evaluate(() => {
    const b = document.querySelector(".brag-btn-go");
    if (!b) return false;
    b.click();
    return true;
  });
  if (!hasBrag) fail("no brag button on the winner screen");
  await sleep(1500);
  const bragOk = await cast.seer.evaluate(() => {
    const img = document.getElementById("brag-img");
    return img && img.naturalWidth === 1080;
  });
  if (!bragOk) fail("brag card didn't render");
  await shot(cast.seer, "90-werewolf-brag");

  step = "leak-scan";
  // the surviving villager's ENTIRE message history: while they were an
  // alive villager mid-game, no role strings and no wolf pid may appear
  // outside their own card and the public death reveals.
  const leak = await cast.villagers[1].evaluate((wolfPid) => {
    const bad = [];
    for (const m of window.__wsLog) {
      const g = m.game;
      if (!g || !g.me || g.me.role !== "villager" || g.me.ghost) continue;
      if (g.stage === "game_end") continue;
      const pub = { ...g };
      delete pub.me; delete pub.dawn; delete pub.verdict; delete pub.result;
      const blob = JSON.stringify(pub);
      for (const r of ['"wolf"', '"seer"', '"doctor"', '"partners"']) {
        if (blob.includes(r)) bad.push(`${g.stage}: ${r} in ${blob.slice(0, 200)}`);
      }
      if (g.omni) bad.push(`${g.stage}: omni present for a living villager`);
      delete pub.alive; delete pub.acked; delete pub.ready_pids;
      delete pub.voted_pids; delete pub.act;
      if (JSON.stringify(pub).includes(wolfPid)) {
        bad.push(`${g.stage}: wolf pid outside public lists`);
      }
      if (g.stage === "vote" && JSON.stringify(g).includes('"tally"')) {
        bad.push("vote: tally leaked before close");
      }
    }
    return bad;
  }, cast.wolf._pid);
  if (leak.length) fail("LEAKS:\n" + leak.join("\n"));
  else log("leak scan clean: villager never saw wolf identity");

  step = "done";
  log(errors.length ? "CONSOLE ERRORS:\n" + errors.join("\n") : "zero console errors");
  if (errors.length) process.exitCode = 1;
  console.log(process.exitCode ? "WEREWOLF PLAYTEST FAIL" : "WEREWOLF PLAYTEST PASS");
} catch (e) {
  fail(e.message);
  console.log("WEREWOLF PLAYTEST FAIL");
} finally {
  await browser.close();
}
