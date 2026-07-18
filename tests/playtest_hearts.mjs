// playtest_hearts.mjs — solo human vs 3 server bots plays a FULL match of
// Hearts to the result screen. Drives: join -> lobby (target 50, fastest
// timer) -> ready/GO -> pass 3 cards -> tricks/hands loop -> gameover ->
// brag card. Asserts settings stuck, legality UI, zero console errors.
// Usage: node tests/playtest_hearts.mjs [baseURL] [shotdir]

import { createRequire } from "module";
import os from "os";
import fs from "fs";
const require = createRequire("/home/ubuntudesktop/projects/webdev-toolkit/x.js");
const puppeteer = require("puppeteer-core");

const BASE = process.argv[2] || "http://127.0.0.1:8121";
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
  userDataDir: os.homedir() + "/tmp/ghshot-hearts",
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
  await pg.goto(BASE + "/games/hearts/", { waitUntil: "networkidle2" });
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
  // pin settings: target 50, fastest timer (10s)
  await pg.evaluate(() => {
    for (const b of document.querySelectorAll("#opt-target button")) {
      if (b.textContent.trim() === "50") b.click();
    }
  });
  await sleep(250);
  for (let i = 0; i < 5; i++) {
    await pg.evaluate(() => document.getElementById("turn-minus").click());
    await sleep(120);
  }
  await sleep(300);
  const tval = await pg.$eval("#turn-val", (e) => e.textContent);
  if (tval !== "10s") fail("turn timer didn't pin to 10s: " + tval);
  const t50 = await pg.evaluate(() =>
    [...document.querySelectorAll("#opt-target button")]
      .find((b) => b.textContent.trim() === "50")?.classList.contains("sel"));
  if (!t50) fail("target 50 didn't stick");
  await pg.evaluate(() => document.getElementById("ready-btn").click());
  await pg.waitForSelector("#go-btn:not([hidden])", { timeout: 6000 });
  await shotPage("80-hearts-lobby");
  await pg.evaluate(() => document.getElementById("go-btn").click());
  await pg.waitForSelector("#scr-table:not([hidden])", { timeout: 9000 });
  log("table up");

  // helpers -----------------------------------------------------------
  async function passIfAsked(firstTime) {
    const picking = await pg.evaluate(() => {
      const sheet = document.getElementById("pass-sheet");
      const btn = document.getElementById("pass-btn");
      return !sheet.hidden && !btn.hidden;
    }).catch(() => false);
    if (!picking) return false;
    // pick the first 3 cards in the fan (re-query per click — renders replace nodes)
    for (let i = 0; i < 3; i++) {
      await pg.evaluate((idx) => {
        const cards = document.querySelectorAll("#hand-fan .card");
        const unpicked = [...cards].filter((c) => !c.classList.contains("sel"));
        if (unpicked[0]) unpicked[0].click();
      }, i);
      await sleep(120);
    }
    const ok = await pg.$eval("#pass-btn", (b) => !b.disabled).catch(() => false);
    if (!ok) return false;
    if (firstTime) await shotPage("81-hearts-passing");
    await pg.evaluate(() => document.getElementById("pass-btn").click());
    return true;
  }

  async function playIfMyTurn() {
    const myTurn = await pg.$eval("#hand-fan", (e) => e.classList.contains("my-turn"))
      .catch(() => false);
    const stagePlaying = await pg.$eval("#pass-sheet", (e) => e.hidden).catch(() => false);
    if (!myTurn || !stagePlaying) return false;
    const c = await pg.evaluate(() => {
      const el = document.querySelector("#hand-fan .card:not(.dim)");
      return el ? el.dataset.c : null;
    });
    if (!c) return false;
    // first tap selects, second tap plays (re-query — render replaces nodes)
    await pg.evaluate((cc) => {
      document.querySelector(`#hand-fan .card[data-c="${cc}"]`)?.click();
    }, c);
    await sleep(90);
    await pg.evaluate((cc) => {
      document.querySelector(`#hand-fan .card[data-c="${cc}"]`)?.click();
    }, c);
    return true;
  }

  step = "match";
  let passed = 0, played = 0, over = false;
  let shotTrick = false, shotScorecard = false, sawBroken = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 900000) {
    over = await pg.$eval("#gameover", (e) => !e.hidden).catch(() => false);
    if (over) break;
    const scorecard = await pg.$eval("#scorecard", (e) => !e.hidden).catch(() => false);
    if (scorecard) {
      if (!shotScorecard) { shotScorecard = true; await sleep(400); await shotPage("83-hearts-scorecard"); }
      await sleep(600);
      continue;
    }
    if (await passIfAsked(passed === 0)) { passed++; log("passed 3 cards (#" + passed + ")"); continue; }
    if (await playIfMyTurn()) {
      played++;
      if (!sawBroken) {
        sawBroken = await pg.$eval("#broken-chip", (e) => !e.hidden).catch(() => false);
        if (sawBroken) log("hearts broken");
      }
      if (!shotTrick && played >= 5) { shotTrick = true; await sleep(500); await shotPage("82-hearts-midtrick"); }
    }
    await sleep(260);
  }
  if (!over) fail("match never reached the result screen");
  if (passed < 1) fail("human never passed cards");
  if (played < 10) fail("human barely played: " + played);
  log(`match over — passed ${passed} rounds, played ${played} cards`);
  await sleep(600);

  step = "gameover";
  const rows = await pg.$$eval("#go-standings .go-row", (es) =>
    es.map((e) => e.querySelector(".go-score").textContent));
  if (rows.length !== 4) fail("expected 4 standings rows, saw " + rows.length);
  const nums = rows.map(Number);
  const sorted = [...nums].sort((a, b) => a - b);
  if (nums.join() !== sorted.join()) fail("standings not lowest-first: " + nums);
  await shotPage("84-hearts-gameover");

  step = "brag";
  const hasBrag = await pg.evaluate(() => {
    const b = document.querySelector(".brag-btn-go");
    if (!b) return false;
    b.click();
    return true;
  });
  if (!hasBrag) fail("no brag button on hearts gameover");
  await sleep(1400);
  const bragOk = await pg.evaluate(() => {
    const img = document.getElementById("brag-img");
    return img && img.naturalWidth === 1080;
  });
  if (!bragOk) fail("hearts brag card didn't render");
  await shotPage("85-hearts-brag");

  step = "done";
  log(errors.length ? "CONSOLE ERRORS:\n" + errors.join("\n") : "zero console errors");
  if (errors.length) process.exitCode = 1;
  console.log(process.exitCode ? "HEARTS PLAYTEST FAIL" : "HEARTS PLAYTEST PASS");
  await ctx.close();
} catch (e) {
  fail(e.message);
  console.log("HEARTS PLAYTEST FAIL");
} finally {
  await browser.close();
}
