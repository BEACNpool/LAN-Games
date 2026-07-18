// playtest_rummikub.mjs — 2 browser humans + 2 bots. Exercises the drag
// engine (drag 3 tiles to new groups, live invalid highlight, UNDO), then
// lets bots/draws run the round toward stalemate or a win.
// Usage: node tests/playtest_rummikub.mjs [baseURL] [shotdir]

import { createRequire } from "module";
import os from "os";
import fs from "fs";
const require = createRequire("/home/ubuntudesktop/projects/webdev-toolkit/x.js");
const puppeteer = require("puppeteer-core");

const BASE = process.argv[2] || "http://127.0.0.1:8096";
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
  userDataDir: os.homedir() + "/tmp/ghshot-profile",
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
  await page.goto(BASE + "/games/rummikub/", { waitUntil: "networkidle2" });
  await page.waitForSelector("#scr-join:not([hidden])", { timeout: 5000 });
  await page.type("#name-input", name);
  await page.evaluate((i) =>
    document.querySelectorAll("#avatar-grid .avatar-cell")[i].click(), avatarIdx);
  await page.click("#join-btn");
  await page.waitForSelector("#scr-lobby:not([hidden])", { timeout: 5000 });
  return page;
}

const isMyTurn = (p) =>
  p.$eval("#turn-note", (e) => e.textContent.startsWith("YOUR TURN")).catch(() => false);

async function dragNthHandTile(page, n, target) {
  // target: "new" | {gi} — uses real mouse moves through the pointer-event engine
  const tiles = await page.$$("#hand-tray .tile.draggable");
  if (tiles.length <= n) return false;
  const box = await tiles[n].boundingBox();
  if (!box) return false;
  const sx = box.x + box.width / 2, sy = box.y + box.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 18, sy - 14, { steps: 4 });   // pass drag threshold
  await sleep(60);
  let tb;
  if (target === "new") {
    const zone = await page.$("#new-group-zone");
    tb = await zone.boundingBox();
  } else {
    const groups = await page.$$("#board-groups .tile-group");
    tb = await groups[target.gi].boundingBox();
  }
  if (!tb) { await page.mouse.up(); return false; }
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 10 });
  await sleep(60);
  await page.mouse.up();
  await sleep(150);
  return true;
}

try {
  step = "join";
  const ava = await mkPlayer("Ava", 0);
  const rex = await mkPlayer("Rex", 5);
  const players = [ava, rex];
  await sleep(300);

  step = "lobby";
  // settings persist in the room across visits — set bots to exactly 2
  for (let i = 0; i < 4; i++) { await ava.click("#bots-minus"); await sleep(80); }
  await ava.click("#bots-plus"); await ava.click("#bots-plus");
  await sleep(300);
  const botsVal = await rex.$eval("#bots-val", (e) => e.textContent);
  if (botsVal !== "2") fail("bot setting didn't sync: " + botsVal);
  for (const p of players) { await p.click("#ready-btn"); await sleep(150); }
  await sleep(250);
  await shot(ava, "30-rummikub-lobby");
  await ava.click("#go-btn");
  await Promise.all(players.map((p) =>
    p.waitForSelector("#scr-game:not([hidden])", { timeout: 9000 })));
  log("game up");
  await sleep(500);

  step = "sanity";
  const chips = await ava.$$eval("#seat-strip .seat-chip", (es) => es.length);
  if (chips !== 4) fail(`expected 4 seat chips, saw ${chips}`);
  const pool = await ava.$eval("#pool-chip b", (e) => +e.textContent);
  if (pool !== 106 - 4 * 14) fail(`pool should be 50, saw ${pool}`);
  const handN = await ava.$$eval("#hand-tray .tile", (es) => es.length);
  if (handN !== 14) fail(`hand should be 14 tiles, saw ${handN}`);

  step = "drag";
  // wait for a human turn, then exercise the drag engine
  let dragTested = false;
  const t0 = Date.now();
  while (!dragTested && Date.now() - t0 < 90000) {
    for (const p of players) {
      if (!(await isMyTurn(p))) continue;
      // drag three tiles out: 1st to a new group, next two into that group
      if (!(await dragNthHandTile(p, 0, "new"))) continue;
      const groupsNow = await p.$$eval("#board-groups .tile-group", (es) => es.length);
      const gi = groupsNow - 1;
      await dragNthHandTile(p, 0, { gi });
      await dragNthHandTile(p, 0, { gi });
      await sleep(200);
      const state = await p.evaluate(() => {
        const grp = [...document.querySelectorAll("#board-groups .tile-group")].pop();
        return {
          tiles: grp ? grp.querySelectorAll(".tile").length : 0,
          bad: grp ? grp.classList.contains("bad") : false,
          endInactive: document.getElementById("end-btn").classList.contains("inactive"),
          handN: document.querySelectorAll("#hand-tray .tile").length,
          undoDisabled: document.getElementById("undo-btn").disabled,
        };
      });
      if (state.tiles !== 3) fail(`drag: expected 3 tiles in new group, got ${state.tiles}`);
      if (state.handN !== 11) fail(`drag: hand should be 11, got ${state.handN}`);
      if (state.undoDisabled) fail("drag: UNDO should be enabled after moves");
      // invalid board -> END TURN shows inactive and a tap must NOT commit,
      // it must explain (toast) — verify the tap is refused
      if (state.bad) {
        if (!state.endInactive) fail("invalid group but END TURN not marked inactive");
        await p.click("#end-btn");
        await sleep(250);
        const stillEditing = await p.$eval("#hand-tray .tile", () => true).catch(() => false);
        const handAfter = await p.$$eval("#hand-tray .tile", (es) => es.length);
        if (handAfter !== 11) fail("blocked END TURN somehow changed the hand");
      }
      log(`drag ok (group valid=${!state.bad}, end inactive=${state.endInactive})`);
      await shot(p, "31-rummikub-drag" + (state.bad ? "-invalid" : ""));
      await p.click("#undo-btn");
      await sleep(250);
      const back = await p.evaluate(() => ({
        handN: document.querySelectorAll("#hand-tray .tile").length,
        undoDisabled: document.getElementById("undo-btn").disabled,
      }));
      if (back.handN !== 14) fail(`undo: hand should be back to 14, got ${back.handN}`);
      log("undo ok");
      await p.click("#draw-btn");
      dragTested = true;
      break;
    }
    await sleep(400);
  }
  if (!dragTested) fail("never got a human turn to test dragging");
  await shot(ava, "32-rummikub-table");

  step = "letitrun";
  // humans just draw; bots try to play. run until round/game ends or cap.
  const t1 = Date.now();
  let finished = false, sawBoardSet = false, summaryShot = false;
  while (Date.now() - t1 < 240000) {
    const over = await ava.$eval("#gameover", (e) => !e.hidden).catch(() => false);
    const sum = await ava.$eval("#summary", (e) => !e.hidden).catch(() => false);
    if (sum && !summaryShot) { summaryShot = true; await shot(ava, "33-rummikub-summary"); }
    if (over) { finished = true; break; }
    const boardGroups = await ava.$$eval("#board-groups .tile-group", (es) => es.length).catch(() => 0);
    if (boardGroups > 0 && !sawBoardSet) {
      sawBoardSet = true;
      log("a bot opened — board has sets");
      await shot(ava, "34-rummikub-board-live");
    }
    for (const p of players) {
      if (await isMyTurn(p)) {
        await p.click("#draw-btn").catch(() => {});
        await sleep(120);
      }
    }
    await sleep(450);
  }
  if (!finished) fail("game never reached the end screen");
  await shot(ava, "35-rummikub-gameover");
  log(`done — bots opened: ${sawBoardSet}`);

  step = "done";
  log(errors.length ? "CONSOLE ERRORS:\n" + errors.join("\n") : "zero console errors");
  if (errors.length) process.exitCode = 1;
  console.log(process.exitCode ? "RUMMIKUB PLAYTEST FAIL" : "RUMMIKUB PLAYTEST PASS");
} catch (e) {
  fail(e.message);
  console.log("RUMMIKUB PLAYTEST FAIL");
} finally {
  await browser.close();
}
