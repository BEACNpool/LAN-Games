// playtest_fab5feud.mjs — 2 humans head-to-head. Picks sides, plays every phase
// (face-off, play/pass, three strikes, steal, round progression) to game over.
// Answers are masked server-side, so it guesses "wrong" and drives the flow via
// strikes/steals — correctness is covered by tests/test_fab5feud.py.
// Usage: node tests/playtest_fab5feud.mjs [baseURL] [shotdir]
import { createRequire } from "module";
import os from "os";
import fs from "fs";
const require = createRequire("/home/ubuntudesktop/projects/webdev-toolkit/x.js");
const puppeteer = require("puppeteer-core");

const BASE = process.argv[2] || "http://127.0.0.1:8096";
const OUT = process.argv[3] || os.homedir() + "/tmp/gamehub-shots";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const errors = [];
let step = "boot", bad = 0;
const fail = (m) => { console.error("FAIL @ " + step + ": " + m); bad++; };

const browser = await puppeteer.launch({
  executablePath: "/snap/bin/chromium", headless: "new",
  userDataDir: os.homedir() + "/tmp/ghshot-feud",
  args: ["--no-sandbox", "--disable-gpu"],
});
const newCtx = () => browser.createBrowserContext
  ? browser.createBrowserContext() : browser.createIncognitoBrowserContext();

async function join(name, avIdx) {
  const ctx = await newCtx();
  const pg = await ctx.newPage();
  await pg.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  pg.on("console", (m) => { if (m.type() === "error") errors.push(`${name}: ${m.text()}`); });
  pg.on("pageerror", (e) => errors.push(`${name} pageerror: ${e.message}`));
  await pg.goto(BASE + "/games/fab5feud/", { waitUntil: "networkidle2" });
  await pg.waitForSelector("#scr-join:not([hidden])", { timeout: 5000 });
  await pg.type("#name-input", name);
  await pg.evaluate((i) => document.querySelectorAll("#avatar-grid .avatar-cell")[i].click(), avIdx);
  await pg.click("#join-btn");
  await pg.waitForSelector("#scr-lobby:not([hidden])", { timeout: 5000 });
  return pg;
}
const vis = (pg, sel) => pg.$eval(sel, (e) => !e.hidden && e.offsetParent !== null).catch(() => false);

let wrongN = 0;
async function actIfPossible(pg) {
  const g = await pg.evaluate(() => {
    const st = window.__st && window.__st();
    if (!st || !st.game) return null;
    const x = st.game;
    return { stage: x.stage, im_rep: x.im_rep, my_side: x.my_side,
             done: x.faceoff_done, im_captain: x.im_captain,
             my_turn: x.my_turn, can_steal: x.can_steal };
  }).catch(() => null);
  if (!g) return null;
  const wrong = "zqxno" + (++wrongN);
  const doGuess = () => pg.evaluate((w) => {
    document.getElementById("guess-input").value = w;
    document.getElementById("ctl-guess").dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }));
  }, wrong);
  if (g.stage === "choice" && g.im_captain) { await pg.click("#btn-play").catch(() => {}); return "choice"; }
  if (g.stage === "faceoff" && g.im_rep && !g.done[g.my_side]) { await doGuess(); return "faceoff"; }
  if (g.stage === "play" && g.my_turn) { await doGuess(); return "strike"; }
  if (g.stage === "steal" && g.can_steal) { await doGuess(); return "steal"; }
  return null;
}

async function shot(pg, nm) { await pg.screenshot({ path: `${OUT}/${nm}.png` }); log("shot: " + nm); }

try {
  step = "join";
  const ava = await join("Ava", 0);
  const rex = await join("Rex", 5);
  const players = [ava, rex];
  await sleep(400);

  step = "teams";
  await ava.click("#join-A"); await sleep(150);
  await rex.click("#join-B"); await sleep(300);
  const colA = await ava.$$eval("#col-A .tp-chip", (e) => e.length);
  const colB = await ava.$$eval("#col-B .tp-chip", (e) => e.length);
  if (colA !== 1 || colB !== 1) fail(`head-to-head split wrong: A=${colA} B=${colB}`);
  await shot(ava, "40-feud-lobby");

  step = "start";
  for (const p of players) { await p.click("#ready-btn"); await sleep(150); }
  await sleep(250);
  await ava.click("#go-btn");
  await Promise.all(players.map((p) => p.waitForSelector("#scr-game:not([hidden])", { timeout: 9000 })));
  log("game on");
  await sleep(600);

  step = "sanity";
  const slots = await ava.$$eval("#board .slot", (e) => e.length);
  if (slots < 4) fail("board didn't render answer slots: " + slots);
  const strikes = await ava.$$eval("#strikes .strike-x", (e) => e.length);
  if (strikes !== 3) fail("expected 3 strike markers, saw " + strikes);

  step = "play";
  const t0 = Date.now();
  let over = false, actions = 0, shotBoard = false, shotReveal = false, lastStage = "";
  // NB: modals are position:fixed, so offsetParent is null even when shown —
  // check the [hidden] attribute directly, not vis().
  const modalShown = (pg, sel) => pg.$eval(sel, (e) => !e.hidden).catch(() => false);
  while (Date.now() - t0 < 180000) {
    over = await modalShown(ava, "#gameover");
    if (over) break;
    const stage = await ava.evaluate(() => {
      const st = window.__st && window.__st();
      return st ? (st.game ? st.game.stage : st.phase) : "?";
    }).catch(() => "?");
    if (stage !== lastStage) { log("stage → " + stage); lastStage = stage; }
    for (const p of players) {
      const did = await actIfPossible(p);
      if (did) { actions++; log("  act: " + did); await sleep(250); }
    }
    if (!shotBoard && actions >= 2) { shotBoard = true; await shot(ava, "41-feud-board"); }
    const rev = await modalShown(ava, "#round-banner");
    if (rev && !shotReveal) { shotReveal = true; await shot(ava, "42-feud-reveal"); }
    await sleep(300);
  }
  if (!over) fail("game never reached game over");
  if (actions < 6) fail("suspiciously few actions: " + actions);
  await sleep(400);
  await shot(ava, "43-feud-gameover");
  const goTitle = await ava.$eval("#go-title", (e) => e.textContent).catch(() => "");
  if (!goTitle) fail("no game-over title");
  log("finished: " + goTitle);

  step = "done";
  log(errors.length ? "CONSOLE ERRORS:\n" + errors.join("\n") : "zero console errors");
  if (errors.length) bad++;
  console.log(bad ? "FAB5 FEUD PLAYTEST FAIL" : "FAB5 FEUD PLAYTEST PASS");
} catch (e) {
  fail(e.message);
  console.log("FAB5 FEUD PLAYTEST FAIL");
} finally {
  await browser.close();
}
process.exit(bad ? 1 : 0);
