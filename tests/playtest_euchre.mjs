// playtest_euchre.mjs — solo human + 3 server bots play Euchre to 5.
// Drives: join -> lobby (pin target 5, fastest timer) -> both bidding rounds
// (pass when allowed, forced call when stuck as dealer) -> discard if we're
// the dealer on a pickup -> full tricks -> scorecards -> game over -> brag.
// Asserts the match completes and the brag card renders at 1080px.
// Usage: node tests/playtest_euchre.mjs [baseURL] [shotdir]

import { createRequire } from "module";
import os from "os";
import fs from "fs";
const require = createRequire("/home/ubuntudesktop/projects/webdev-toolkit/x.js");
const puppeteer = require("puppeteer-core");

const BASE = process.argv[2] || "http://127.0.0.1:8122";
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
  userDataDir: os.homedir() + "/tmp/ghshot-euchre",
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
  await pg.goto(BASE + "/games/euchre/", { waitUntil: "networkidle2" });
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
  // pin settings: play to 5, fastest timer (10s), sharp bots
  await pg.evaluate(() => {
    for (const b of document.querySelectorAll("#opt-target button")) {
      if (b.textContent === "5") b.click();
    }
  });
  await sleep(250);
  // each minus click patches from server state — let it round-trip
  for (let i = 0; i < 6; i++) {
    await pg.evaluate(() => document.getElementById("turn-minus").click());
    await sleep(180);
  }
  await sleep(300);
  const tval = await pg.$eval("#turn-val", (e) => e.textContent);
  if (tval !== "10s") fail("turn timer didn't pin: " + tval);
  const target = await pg.evaluate(() =>
    document.querySelector("#opt-target button.sel")?.textContent);
  if (target !== "5") fail("target didn't pin: " + target);
  await pg.evaluate(() => document.getElementById("ready-btn").click());
  await pg.waitForSelector("#go-btn:not([hidden])", { timeout: 6000 });
  await shotPage("80-euchre-lobby");
  await pg.evaluate(() => document.getElementById("go-btn").click());
  await pg.waitForSelector("#scr-table:not([hidden])", { timeout: 9000 });
  log("table up — hand 1");
  await sleep(500);

  step = "match";
  let over = false;
  let bids = 0, calls = 0, plays = 0, buries = 0, scorecards = 0;
  let shotBid = false, shotTrick = false, shotCard = false;
  let sawTrump = false, sawPips = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 480000) {
    over = await pg.$eval("#gameover", (e) => !e.hidden).catch(() => false);
    if (over) break;

    const sc = await pg.$eval("#scorecard", (e) => !e.hidden).catch(() => false);
    if (sc) {
      if (!shotCard) { shotCard = true; await sleep(400); await shotPage("83-euchre-scorecard"); }
      scorecards++;
      await sleep(800);
      continue;
    }

    // trump chip + pips light up once a hand is on
    if (!sawTrump) {
      sawTrump = await pg.$eval("#trump-chip", (e) => !e.hidden).catch(() => false);
    }
    if (!sawPips) {
      sawPips = await pg.$$eval(".team-chip .pip.lit", (es) => es.length > 0).catch(() => false);
    }

    const sheet = await pg.$eval("#bid-sheet", (e) => !e.hidden).catch(() => false);
    if (sheet) {
      const r1 = await pg.$eval("#bs-round1", (e) => !e.hidden).catch(() => false);
      const r2 = await pg.$eval("#bs-round2", (e) => !e.hidden).catch(() => false);
      const bury = await pg.$eval("#bs-discard-note", (e) => !e.hidden).catch(() => false);
      if (r1) {
        if (!shotBid) { shotBid = true; await shotPage("81-euchre-bid1"); }
        await pg.evaluate(() => document.getElementById("pass1-btn").click());
        bids++;
      } else if (r2) {
        const canPass = await pg.$eval("#pass2-btn", (e) => !e.hidden);
        if (canPass) {
          await pg.evaluate(() => document.getElementById("pass2-btn").click());
          bids++;
        } else {
          // stick the dealer: pick the first legal suit and call it
          await pg.evaluate(() => {
            const b = document.querySelector("#suit-grid button:not(:disabled)");
            if (b) b.click();
          });
          await sleep(150);
          await pg.evaluate(() => document.getElementById("call-btn").click());
          calls++;
          log("stuck as dealer — called trump");
        }
      } else if (bury) {
        // we ordered/were ordered as dealer: bury the first card (tap twice)
        const c = await pg.evaluate(() => {
          const el = document.querySelector("#hand-fan .card");
          return el ? el.dataset.c : null;
        });
        if (c) {
          await pg.evaluate((cc) => {
            document.querySelector(`#hand-fan .card[data-c="${cc}"]`)?.click();
          }, c);
          await sleep(120);
          await pg.evaluate((cc) => {
            document.querySelector(`#hand-fan .card[data-c="${cc}"]`)?.click();
          }, c);
          buries++;
          log("buried a card as dealer");
        }
      }
      await sleep(400);
      continue;
    }

    // trick play: first tap raises, second tap plays (re-query — nodes churn)
    const myTurn = await pg.$eval("#hand-fan", (e) =>
      e.classList.contains("my-turn")).catch(() => false);
    if (myTurn) {
      const c = await pg.evaluate(() => {
        const el = document.querySelector("#hand-fan .card:not(.dim)");
        return el ? el.dataset.c : null;
      });
      if (c) {
        await pg.evaluate((cc) => {
          document.querySelector(`#hand-fan .card[data-c="${cc}"]`)?.click();
        }, c);
        await sleep(120);
        await pg.evaluate((cc) => {
          document.querySelector(`#hand-fan .card[data-c="${cc}"]`)?.click();
        }, c);
        plays++;
        if (!shotTrick && plays >= 3) { shotTrick = true; await sleep(500); await shotPage("82-euchre-trick"); }
      }
    }
    await sleep(350);
  }
  if (!over) fail("match never ended");
  if (bids < 1) fail("human never bid");
  if (plays < 3) fail("human barely played: " + plays);
  if (scorecards < 1) fail("no hand scorecard ever showed");
  if (!sawTrump) fail("trump chip never appeared");
  if (!sawPips) fail("trick pips never lit");
  log(`match over — bids:${bids} calls:${calls} buries:${buries} plays:${plays}`);
  await sleep(500);
  await shotPage("84-euchre-gameover");

  step = "brag";
  const hasBrag = await pg.evaluate(() => {
    const b = document.querySelector(".brag-btn-go");
    if (!b) return false;
    b.click();
    return true;
  });
  if (!hasBrag) fail("no brag button on euchre gameover");
  await sleep(1400);
  const bragOk = await pg.evaluate(() => {
    const img = document.getElementById("brag-img");
    return img && img.naturalWidth === 1080;
  });
  if (!bragOk) fail("euchre brag card didn't render");
  await shotPage("85-euchre-brag");

  step = "done";
  log(errors.length ? "CONSOLE ERRORS:\n" + errors.join("\n") : "zero console errors");
  if (errors.length) process.exitCode = 1;
  console.log(process.exitCode ? "EUCHRE PLAYTEST FAIL" : "EUCHRE PLAYTEST PASS");
  await ctx.close();
} catch (e) {
  fail(e.message);
  console.log("EUCHRE PLAYTEST FAIL");
} finally {
  await browser.close();
}
