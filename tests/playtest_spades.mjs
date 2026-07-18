// playtest_spades.mjs — 2 real browser humans + 2 server bots play Spades.
// Drives: hub page -> join -> lobby/ready/GO -> bidding -> a full hand ->
// scorecard -> hand 2 begins. Asserts sync + zero console errors.
// Usage: node tests/playtest_spades.mjs [baseURL] [shotdir]

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
  await page.goto(BASE + "/games/spades/", { waitUntil: "networkidle2" });
  await page.waitForSelector("#scr-join:not([hidden])", { timeout: 5000 });
  await page.type("#name-input", name);
  await page.evaluate((i) =>
    document.querySelectorAll("#avatar-grid .avatar-cell")[i].click(), avatarIdx);
  await page.click("#join-btn");
  await page.waitForSelector("#scr-lobby:not([hidden])", { timeout: 5000 });
  return page;
}

async function bidIfAsked(page, value) {
  const visible = await page.$eval("#bid-sheet", (e) => !e.hidden).catch(() => false);
  if (!visible) return false;
  await page.evaluate((v) => {
    const btns = document.querySelectorAll("#bid-grid button");
    btns[v - 1].click();
  }, value);
  return true;
}

async function playIfMyTurn(page) {
  const myTurn = await page.$eval("#hand-fan", (e) => e.classList.contains("my-turn"))
    .catch(() => false);
  if (!myTurn) return false;
  const c = await page.evaluate(() => {
    const el = document.querySelector("#hand-fan .card:not(.dim)");
    return el ? el.dataset.c : null;
  });
  if (!c) return false;
  // first tap selects, second tap plays (re-query — render replaces nodes)
  await page.evaluate((cc) => {
    document.querySelector(`#hand-fan .card[data-c="${cc}"]`)?.click();
  }, c);
  await sleep(80);
  await page.evaluate((cc) => {
    document.querySelector(`#hand-fan .card[data-c="${cc}"]`)?.click();
  }, c);
  return true;
}

try {
  // hub page
  step = "hub";
  const hubCtx = await newCtx();
  const hub = await hubCtx.newPage();
  await hub.setViewport(PHONE);
  hub.on("pageerror", (e) => errors.push("hub pageerror: " + e.message));
  await hub.goto(BASE + "/", { waitUntil: "networkidle2" });
  await hub.waitForSelector(".tile", { timeout: 5000 });
  const titles = await hub.$$eval(".tile-title", (es) => es.map((e) => e.textContent));
  if (!titles.includes("SPADES")) fail("spades tile missing on hub: " + titles);
  if (!titles.includes("WORDCLASH")) fail("wordclash external tile missing");
  const chatOk = await hub.$("#lc-msgs") !== null;
  if (!chatOk) fail("lobby chat panel missing on hub");
  await shot(hub, "20-hub");
  await hubCtx.close();

  // two humans
  step = "join";
  const ava = await mkPlayer("Ava", 0);
  const rex = await mkPlayer("Rex", 5);
  const players = [ava, rex];
  await sleep(400);
  await shot(ava, "21-spades-lobby");

  step = "lobby";
  for (const p of players) { await p.click("#ready-btn"); await sleep(150); }
  await sleep(300);
  const goHidden = await ava.$eval("#go-btn", (b) => b.hidden);
  if (goHidden) fail("GO not shown with 2 ready humans");
  await shot(ava, "22-spades-ready");
  await ava.click("#go-btn");

  step = "bidding";
  await ava.waitForSelector("#scr-table:not([hidden])", { timeout: 9000 });
  await rex.waitForSelector("#scr-table:not([hidden])", { timeout: 9000 });
  log("table up — bidding");
  let bidsDone = 0;
  const bidT0 = Date.now();
  let bidShotTaken = false;
  while (bidsDone < 2 && Date.now() - bidT0 < 40000) {
    for (const p of players) {
      const visible = await p.$eval("#bid-sheet", (e) => !e.hidden).catch(() => false);
      if (visible && !bidShotTaken) { bidShotTaken = true; await shot(p, "23-bid-sheet"); }
      if (await bidIfAsked(p, 3)) { bidsDone++; await sleep(250); }
    }
    await sleep(250);
  }
  if (bidsDone < 2) fail("humans never got to bid");

  step = "playing";
  let trickShot = false, scorecard = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    scorecard = await ava.$eval("#scorecard", (e) => !e.hidden).catch(() => false);
    if (scorecard) break;
    for (const p of players) await playIfMyTurn(p);
    if (!trickShot && Date.now() - t0 > 6000) {
      trickShot = true;
      await shot(ava, "24-table-midtrick");
    }
    await sleep(280);
  }
  if (!scorecard) fail("hand never reached the scorecard");
  await sleep(600);
  await shot(ava, "25-scorecard");
  log("hand 1 scored");

  // scores consistent on both screens
  const usAva = await ava.$eval("#score-us span", (e) => e.textContent);
  const usRex = await rex.$eval("#score-us span", (e) => e.textContent);
  if (usAva !== usRex) fail(`partner scores disagree: ${usAva} vs ${usRex}`);

  step = "hand2";
  const t1 = Date.now();
  let hand2 = false;
  while (Date.now() - t1 < 30000) {
    const sc = await ava.$eval("#scorecard", (e) => !e.hidden).catch(() => true);
    if (!sc) { hand2 = true; break; }
    await sleep(500);
  }
  if (!hand2) fail("hand 2 never started");
  log("hand 2 began — game loop works");
  await shot(ava, "26-hand2");

  step = "done";
  log(errors.length ? "CONSOLE ERRORS:\n" + errors.join("\n") : "zero console errors");
  if (errors.length) process.exitCode = 1;
  console.log(process.exitCode ? "SPADES PLAYTEST FAIL" : "SPADES PLAYTEST PASS");
} catch (e) {
  fail(e.message);
  console.log("SPADES PLAYTEST FAIL");
} finally {
  await browser.close();
}
