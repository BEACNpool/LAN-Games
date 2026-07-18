// playtest_battleship.mjs — solo human vs one bot fleet on the QUICK board.
// Drives join -> lobby settings -> randomize + ready -> a few manual shots
// (hit/miss must render) -> then walks away and lets the turn-timer
// autopilot finish the match (first timeout flags AFK, later turns run at
// bot speed) -> result screen -> brag card if the human won, standings
// otherwise.
// Usage: node tests/playtest_battleship.mjs [baseURL] [shotdir]

import { createRequire } from "module";
import os from "os";
import fs from "fs";
const require = createRequire("/home/ubuntudesktop/projects/webdev-toolkit/x.js");
const puppeteer = require("puppeteer-core");

const BASE = process.argv[2] || "http://127.0.0.1:8123";
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
  userDataDir: os.homedir() + "/tmp/ghshot-battleship",
  args: ["--no-sandbox", "--disable-gpu"],
});

try {
  step = "join";
  const ctx = await (browser.createBrowserContext
    ? browser.createBrowserContext() : browser.createIncognitoBrowserContext());
  const pg = await ctx.newPage();
  await pg.setViewport(PHONE);
  pg.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  pg.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  await pg.goto(BASE + "/games/battleship/", { waitUntil: "networkidle2" });
  await pg.waitForSelector("#scr-join:not([hidden])", { timeout: 5000 });
  await pg.type("#name-input", "Ava");
  await pg.click("#join-btn");
  await pg.waitForSelector("#scr-lobby:not([hidden])", { timeout: 5000 });
  await sleep(300);

  async function shotPage(nm) {
    await pg.screenshot({ path: `${OUT}/${nm}.png` });
    log("shot: " + nm);
  }

  step = "lobby";
  // pin settings: QUICK board, exactly 1 bot, 20s timer
  await pg.evaluate(() => {
    for (const b of document.querySelectorAll("#opt-board button")) {
      if (b.textContent.includes("QUICK")) b.click();
    }
  });
  await sleep(250);
  await pg.evaluate(() => {
    for (let i = 0; i < 6; i++) document.getElementById("bots-minus").click();
  });
  await sleep(300);
  await pg.evaluate(() => document.getElementById("bots-plus").click());
  await sleep(250);
  await pg.evaluate(() => {
    for (const b of document.querySelectorAll("#opt-timer button")) {
      if (b.textContent === "20s") b.click();
    }
  });
  await sleep(250);
  const bots = await pg.$eval("#bots-val", (e) => e.textContent);
  if (bots !== "1") fail("bot count didn't set: " + bots);
  const boardSel = await pg.evaluate(() =>
    [...document.querySelectorAll("#opt-board button")]
      .find((b) => b.classList.contains("sel"))?.textContent || "");
  if (!boardSel.includes("QUICK")) fail("QUICK board didn't select: " + boardSel);
  await shotPage("80-bship-lobby");
  await pg.evaluate(() => document.getElementById("ready-btn").click());
  await pg.waitForSelector("#go-btn:not([hidden])", { timeout: 6000 });
  await pg.evaluate(() => document.getElementById("go-btn").click());

  step = "placement";
  await pg.waitForSelector("#scr-place:not([hidden])", { timeout: 9000 });
  log("placement started");
  await sleep(400);
  const gridCells = await pg.$$eval("#place-grid .cell", (es) => es.length);
  if (gridCells !== 64) fail("expected 8x8 = 64 place cells, saw " + gridCells);
  await pg.evaluate(() => document.getElementById("rand-btn").click());
  await sleep(500);
  const shipCells = await pg.$$eval("#place-grid .cell.ship", (es) => es.length);
  if (shipCells !== 12) fail("quick fleet should cover 12 cells, saw " + shipCells);
  await shotPage("81-bship-place");
  const readyDisabled = await pg.$eval("#place-ready-btn", (e) => e.disabled);
  if (readyDisabled) fail("READY still disabled after randomize");
  await pg.evaluate(() => document.getElementById("place-ready-btn").click());

  step = "battle";
  await pg.waitForSelector("#scr-game:not([hidden])", { timeout: 9000 });
  log("battle started");
  await sleep(600);
  const tabN = await pg.$$eval(".foe-tab", (es) => es.length);
  if (tabN !== 1) fail("expected 1 foe tab, saw " + tabN);

  // ---- a few manual shots ----
  const myTurn = () => pg.$eval("#bs-turn-name",
    (e) => e.textContent === "YOUR SHOT").catch(() => false);
  let manual = 0, over = false, shotMid = false;
  const t0 = Date.now();
  while (manual < 3 && Date.now() - t0 < 90000) {
    over = await pg.$eval("#gameover", (e) => !e.hidden).catch(() => false);
    if (over) break;
    if (await myTurn()) {
      const aimed = await pg.evaluate(() => {
        const cells = [...document.querySelectorAll("#target-grid .cell")];
        const open = cells.filter((c) =>
          !c.classList.contains("hit") && !c.classList.contains("miss")
          && !c.classList.contains("sunk"));
        if (!open.length) return false;
        open[(Math.random() * open.length) | 0].click();
        return true;
      });
      if (!aimed) { fail("no open cell to aim at"); break; }
      await sleep(250);
      const fireLabel = await pg.$eval("#fire-btn", (e) => e.textContent);
      if (!/FIRE AT [A-H][1-8]/.test(fireLabel)) fail("aim label wrong: " + fireLabel);
      await pg.evaluate(() => document.getElementById("fire-btn").click());
      manual++;
      log("manual FIRE " + manual + " (" + fireLabel.trim() + ")");
      await sleep(900);
      const marks = await pg.$$eval("#target-grid .cell.hit, #target-grid .cell.miss, #target-grid .cell.sunk",
        (es) => es.length);
      if (marks < manual) fail(`shot ${manual} didn't render (marks=${marks})`);
      if (!shotMid) { shotMid = true; await shotPage("82-bship-battle"); }
    }
    await sleep(500);
  }
  if (manual < 3 && !over) fail("couldn't land 3 manual shots");

  // ---- walk away: the turn-timer autopilot finishes the match ----
  step = "autopilot";
  log("hands off — autopilot takes the helm");
  const t1 = Date.now();
  let midShot = false;
  while (Date.now() - t1 < 360000) {
    over = await pg.$eval("#gameover", (e) => !e.hidden).catch(() => false);
    if (over) break;
    if (!midShot && Date.now() - t1 > 60000) {
      midShot = true;
      await shotPage("83-bship-mid");
    }
    await sleep(1500);
  }
  if (!over) fail("battle never ended (cap 6min)");
  log(`match finished in ${Math.round((Date.now() - t1) / 1000)}s of autopilot`);
  await sleep(600);
  await shotPage("84-bship-gameover");

  step = "result";
  const rows = await pg.$$eval("#res-rows .res-row", (es) => es.length);
  if (rows !== 2) fail("expected 2 standings rows, saw " + rows);
  const stats = await pg.$eval("#res-rows", (e) => e.textContent);
  if (!/\d+\/\d+/.test(stats)) fail("standings missing shot stats: " + stats);
  const iWon = await pg.evaluate(() =>
    !!document.querySelector("#res-rows .res-row.first .you-tag"));
  log("human " + (iWon ? "WON" : "lost — bot fleet prevails"));

  if (iWon) {
    step = "brag";
    const hasBrag = await pg.evaluate(() => {
      const b = document.querySelector(".brag-btn-go");
      if (!b) return false;
      b.click();
      return true;
    });
    if (!hasBrag) fail("no brag button on battleship gameover");
    await sleep(1400);
    const bragOk = await pg.evaluate(() => {
      const img = document.getElementById("brag-img");
      return img && img.naturalWidth === 1080;
    });
    if (!bragOk) fail("battleship brag card didn't render");
    await shotPage("85-bship-brag");
  }

  step = "done";
  log(errors.length ? "CONSOLE ERRORS:\n" + errors.join("\n") : "zero console errors");
  if (errors.length) process.exitCode = 1;
  console.log(process.exitCode ? "BATTLESHIP PLAYTEST FAIL" : "BATTLESHIP PLAYTEST PASS");
  await ctx.close();
} catch (e) {
  fail(e.message);
  console.log("BATTLESHIP PLAYTEST FAIL");
} finally {
  await browser.close();
}
