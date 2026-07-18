// playtest_snake.mjs — solo human vs one bot in the real-time arena.
// Run 1: join -> settings (1 bot, best-of-1) -> GO -> assert the canvas is
// actually animating -> steer with key events -> deliberately drive into
// the top wall -> the bot survives -> result standings + brag render.
// Run 2: rematch, steer a lazy square; assert the round completes either
// way and the result screen renders again.
// Usage: node tests/playtest_snake.mjs [baseURL] [shotdir]

import { createRequire } from "module";
import os from "os";
import fs from "fs";
const require = createRequire("/home/ubuntudesktop/projects/webdev-toolkit/x.js");
const puppeteer = require("puppeteer-core");

const BASE = process.argv[2] || "http://127.0.0.1:8125";
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
  userDataDir: os.homedir() + "/tmp/ghshot-snake",
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
  await pg.goto(BASE + "/games/snake/", { waitUntil: "networkidle2" });
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
  // pin settings: exactly 1 bot, best-of-1, sharp. The stepper reads the
  // last-pushed state, so give each click a beat to round-trip (the shared
  // session may carry any bot count from a previous run).
  for (let i = 0; i < 8; i++) {
    await pg.evaluate(() => document.getElementById("bots-minus").click());
    await sleep(140);
  }
  await pg.evaluate(() => document.getElementById("bots-plus").click());
  await sleep(250);
  const bots = await pg.$eval("#bots-val", (e) => e.textContent);
  if (bots !== "1") fail("bot count didn't set: " + bots);
  await pg.evaluate(() => {
    for (const b of document.querySelectorAll("#opt-rounds button")) {
      if (b.textContent === "1") b.click();
    }
  });
  await sleep(250);
  const rounds = await pg.evaluate(() =>
    document.querySelector("#opt-rounds button.sel")?.textContent);
  if (rounds !== "1") fail("rounds didn't set to 1: " + rounds);
  await pg.evaluate(() => document.getElementById("ready-btn").click());
  await pg.waitForSelector("#go-btn:not([hidden])", { timeout: 6000 });
  await shotPage("80-snake-lobby");
  await pg.evaluate(() => document.getElementById("go-btn").click());
  await pg.waitForSelector("#scr-game:not([hidden])", { timeout: 9000 });
  log("arena live");
  await sleep(600);

  step = "canvas-motion";
  // the world ticks ~130ms — sampled pixels must change between frames
  const sample = () => pg.evaluate(() => {
    const cv = document.getElementById("arena");
    const cx = cv.getContext("2d");
    const d = cx.getImageData(0, 0, cv.width, cv.height).data;
    let h = 0, lit = 0;
    for (let i = 0; i < d.length; i += 397) {
      h = (h * 31 + d[i]) >>> 0;
      if (d[i] + d[i + 1] + d[i + 2] > 40) lit++;
    }
    return { h, lit };
  });
  const s1 = await sample();
  await sleep(450);
  const s2 = await sample();
  await sleep(450);
  const s3 = await sample();
  if (s1.lit < 5) fail("arena canvas looks blank (lit=" + s1.lit + ")");
  if (s1.h === s2.h && s2.h === s3.h) fail("canvas is not animating between ticks");
  log(`canvas animating (lit=${s1.lit})`);
  const chips = await pg.$$eval(".sn-chip", (es) => es.length);
  if (chips !== 2) fail("expected 2 score chips, saw " + chips);
  await shotPage("81-snake-play");

  step = "steer-and-crash";
  // steer, then drive into a wall: left then up always registers at least
  // one of the two (reversals are silently rejected), and an unsteered
  // snake heading up/left hits a wall within ~6 s. With 2 snakes and
  // best-of-1 our death ends the match the same tick, so wait for the
  // result modal directly (if the bot somehow dies first, same modal).
  await pg.keyboard.press("ArrowLeft");
  await sleep(300);
  await pg.keyboard.press("ArrowUp");
  await sleep(300);
  await pg.keyboard.press("ArrowLeft");

  step = "result";
  await pg.waitForSelector("#gameover:not([hidden])", { timeout: 30000 });
  await sleep(600);
  const rows = await pg.$$eval("#go-rows .go-row", (es) => es.length);
  if (rows !== 2) fail("expected 2 standings rows, saw " + rows);
  const title = await pg.$eval("#go-title", (e) => e.textContent);
  if (!title || title.length < 3) fail("empty result title");
  log("result: " + title);
  await shotPage("83-snake-gameover");

  step = "brag";
  const hasBrag = await pg.evaluate(() => {
    const b = document.querySelector(".brag-btn-go");
    if (!b) return false;
    b.click();
    return true;
  });
  if (!hasBrag) fail("no brag button on snake gameover");
  await sleep(1400);
  const bragOk = await pg.evaluate(() => {
    const img = document.getElementById("brag-img");
    return img && img.naturalWidth === 1080;
  });
  if (!bragOk) fail("snake brag card didn't render");
  await shotPage("84-snake-brag");
  await pg.evaluate(() => document.getElementById("brag-close").click());

  step = "rematch";
  await pg.evaluate(() => document.getElementById("rematch-btn").click());
  await pg.waitForSelector("#scr-lobby:not([hidden])", { timeout: 6000 });
  await sleep(300);
  await pg.evaluate(() => document.getElementById("ready-btn").click());
  await pg.waitForSelector("#go-btn:not([hidden])", { timeout: 6000 });
  await pg.evaluate(() => document.getElementById("go-btn").click());
  await pg.waitForSelector("#scr-game:not([hidden])", { timeout: 9000 });
  log("round 2 (rematch) live");

  step = "battle2";
  // lazy square steering; the round must complete either way (we die or
  // we outlive the bot) — assert on completion, not on who wins
  const seqDirs = ["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"];
  let i = 0, over = false;
  const t0 = Date.now();
  let shotMid = false;
  while (Date.now() - t0 < 150000) {
    over = await pg.$eval("#gameover", (e) => !e.hidden).catch(() => false);
    if (over) break;
    await pg.keyboard.press(seqDirs[i++ % 4]);
    if (!shotMid && Date.now() - t0 > 2500) {
      shotMid = true;
      await shotPage("85-snake-play2");
    }
    await sleep(500);
  }
  if (!over) fail("rematch round never completed");
  await sleep(500);
  const rows2 = await pg.$$eval("#go-rows .go-row", (es) => es.length);
  if (rows2 !== 2) fail("rematch standings missing rows: " + rows2);
  await shotPage("86-snake-gameover2");

  step = "done";
  log(errors.length ? "CONSOLE ERRORS:\n" + errors.join("\n") : "zero console errors");
  if (errors.length) process.exitCode = 1;
  console.log(process.exitCode ? "SNAKE PLAYTEST FAIL" : "SNAKE PLAYTEST PASS");
  await ctx.close();
} catch (e) {
  fail(e.message);
  console.log("SNAKE PLAYTEST FAIL");
} finally {
  await browser.close();
}
