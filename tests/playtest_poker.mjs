// playtest_poker.mjs — solo human vs bots, No-Limit Hold'em.
// Heads-up TURBO: the human shoves all-in whenever it can raise (else call/
// check), so the match resolves fast and we walk through preflop -> board
// runout -> showdown -> gameover -> brag. A second desktop pass validates the
// 6-max seat layout.  Usage: node tests/playtest_poker.mjs [baseURL] [shotdir]

import { createRequire } from "module";
import os from "os";
import fs from "fs";
const require = createRequire("/home/ubuntudesktop/projects/webdev-toolkit/x.js");
const puppeteer = require("puppeteer-core");

const BASE = process.argv[2] || "http://127.0.0.1:8096";
const OUT = process.argv[3] || os.homedir() + "/tmp/gamehub-shots/poker";
fs.mkdirSync(OUT, { recursive: true });

const PHONE = { width: 390, height: 844, deviceScaleFactor: 2 };
const DESK = { width: 1000, height: 820, deviceScaleFactor: 1 };
const errors = [];
let step = "boot";
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fail(msg) { console.error("FAIL @ " + step + ": " + msg); process.exitCode = 1; }
const shot = (pg, name) => pg.screenshot({ path: `${OUT}/${name}.png` }).then(() => log("shot " + name));

const browser = await puppeteer.launch({
  executablePath: "/snap/bin/chromium", headless: "new",
  userDataDir: os.homedir() + "/tmp/ghshot-poker",
  args: ["--no-sandbox", "--disable-gpu"],
});

async function setSeg(pg, hostId, label) {
  await pg.evaluate((h, l) => {
    for (const b of document.getElementById(h).querySelectorAll("button"))
      if (b.textContent.trim() === l) { b.click(); return; }
  }, hostId, label);
}
// "surrender": check when it's free, else fold. The human blinds out
// deterministically (fast, rising blinds), busting on a forced all-in that
// produces a real board + showdown right before gameover.
async function takeAction(pg) {
  return await pg.evaluate(() => {
    const bar = document.getElementById("action-bar");
    if (bar.hidden) return "none";
    const check = document.getElementById("btn-check");
    if (check && !check.hidden) { check.click(); return "check"; }
    const fold = document.getElementById("btn-fold");
    if (fold && !fold.hidden) { fold.click(); return "fold"; }
    return "none";
  });
}

try {
  // ---------------- PHONE: heads-up shove to gameover ----------------
  step = "join";
  const ctx = await (browser.createBrowserContext
    ? browser.createBrowserContext() : browser.createIncognitoBrowserContext());
  const pg = await ctx.newPage();
  await pg.setViewport(PHONE);
  pg.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  pg.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  await pg.goto(BASE + "/games/poker/", { waitUntil: "networkidle2" });
  await pg.waitForSelector("#scr-join:not([hidden])", { timeout: 5000 });
  await pg.type("#name-input", "Ava");
  await pg.click("#join-btn");
  await pg.waitForSelector("#scr-lobby:not([hidden])", { timeout: 5000 });
  await sleep(300);

  step = "lobby";
  await setSeg(pg, "opt-table", "HEADS-UP");
  await setSeg(pg, "opt-speed", "TURBO");
  await sleep(300);
  await shot(pg, "01-lobby");
  await pg.evaluate(() => document.getElementById("ready-btn").click());
  await pg.waitForSelector("#go-btn:not([hidden])", { timeout: 4000 });
  await pg.evaluate(() => document.getElementById("go-btn").click());
  await pg.waitForSelector("#scr-table:not([hidden])", { timeout: 6000 });
  log("table up");
  await sleep(3200);   // countdown

  step = "play";
  // For the first few hands, just call/check so we reach a flop (board shot) and
  // a real showdown; after that, shove all-in every hand to force a bust.
  let gotPreflop = false, gotBoard = false, gotShowdown = false, gotOver = false;
  for (let i = 0; i < 1500 && !gotOver; i++) {
    const info = await pg.evaluate(() => ({
      barVisible: !document.getElementById("action-bar").hidden,
      boardN: document.querySelectorAll("#board .card").length,
      showdown: !document.getElementById("showdown-banner").hidden,
      over: !document.getElementById("gameover").hidden,
    }));
    if (!gotPreflop && info.barVisible) { await shot(pg, "02-preflop"); gotPreflop = true; }
    if (!gotBoard && info.boardN >= 3) { await shot(pg, "03-board"); gotBoard = true; }
    // a real showdown = the banner is up AND community cards are on the board
    if (!gotShowdown && info.showdown && info.boardN >= 3) { await shot(pg, "04-showdown"); gotShowdown = true; }
    if (info.over) { gotOver = true; await shot(pg, "05-gameover"); break; }
    if (info.barVisible) await takeAction(pg);
    await sleep(130);
  }
  if (!gotPreflop) fail("never saw my action bar");
  if (!gotOver) fail("match did not finish in budget");

  step = "brag";
  const bragBtn = await pg.$(".brag-btn-go");
  if (bragBtn) {
    await bragBtn.click();
    await pg.waitForSelector("#brag-modal:not([hidden])", { timeout: 4000 }).catch(() => {});
    await sleep(800);
    await shot(pg, "06-brag");
    const w = await pg.$eval("#brag-img", (i) => i.naturalWidth).catch(() => 0);
    if (w !== 1080) fail("brag image not 1080px (got " + w + ")");
    else log("brag card OK 1080px");
  } else fail("no brag button");

  // one PokerSession is shared by all clients, so reset the room to lobby before
  // the desktop client joins (else it lands on the finished table).
  await pg.evaluate(() => document.getElementById("brag-close")?.click());
  await pg.evaluate(() => document.getElementById("rematch-btn").click());
  await sleep(500);
  await ctx.close();
  await sleep(300);

  // ---------------- DESKTOP: 6-max seat layout ----------------
  step = "desktop-6max";
  const ctx2 = await (browser.createBrowserContext
    ? browser.createBrowserContext() : browser.createIncognitoBrowserContext());
  const pg2 = await ctx2.newPage();
  await pg2.setViewport(DESK);
  pg2.on("pageerror", (e) => errors.push("pageerror2: " + e.message));
  await pg2.goto(BASE + "/games/poker/", { waitUntil: "networkidle2" });
  await pg2.waitForSelector("#scr-join:not([hidden])", { timeout: 5000 });
  await pg2.type("#name-input", "Dev");
  await pg2.click("#join-btn");
  await pg2.waitForSelector("#scr-lobby:not([hidden])", { timeout: 5000 });
  await sleep(300);
  await setSeg(pg2, "opt-table", "6-MAX");
  await sleep(200);
  await pg2.evaluate(() => document.getElementById("ready-btn").click());
  await pg2.waitForSelector("#go-btn:not([hidden])", { timeout: 4000 });
  await pg2.evaluate(() => document.getElementById("go-btn").click());
  await pg2.waitForSelector("#scr-table:not([hidden])", { timeout: 6000 });
  await sleep(3600);
  await shot(pg2, "07-table-6max-desktop");
  // let a few actions happen so the board/pot show
  for (let i = 0; i < 30; i++) {
    const barV = await pg2.evaluate(() => !document.getElementById("action-bar").hidden);
    if (barV) await takeAction(pg2);
    await sleep(200);
    const bn = await pg2.evaluate(() => document.querySelectorAll("#board .card").length);
    if (bn >= 3) break;
  }
  await sleep(400);
  await shot(pg2, "08-6max-inhand");

  if (errors.length) { console.error("CONSOLE ERRORS:\n" + errors.join("\n")); fail(errors.length + " console errors"); }
  log("DONE" + (process.exitCode ? " (with failures)" : " OK"));
} catch (e) {
  fail(e.message + "\n" + (e.stack || ""));
} finally {
  await browser.close();
}
