// playtest_tanks.mjs — solo human vs bot artillery. Exercises move buttons,
// angle/power sliders, FIRE, tracer animation, HP loss, gameover + brag.
// The human aims straight up at low power (self-shelling) so the battle
// ends fast and deterministically enough for CI.
// Usage: node tests/playtest_tanks.mjs [baseURL] [shotdir]

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

try {
  step = "join";
  const ctx = await (browser.createBrowserContext
    ? browser.createBrowserContext() : browser.createIncognitoBrowserContext());
  const pg = await ctx.newPage();
  await pg.setViewport(PHONE);
  pg.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  pg.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  await pg.goto(BASE + "/games/tanks/", { waitUntil: "networkidle2" });
  await pg.waitForSelector("#scr-join:not([hidden])", { timeout: 5000 });
  await pg.type("#name-input", "Ava");
  await pg.click("#join-btn");
  await pg.waitForSelector("#scr-lobby:not([hidden])", { timeout: 5000 });
  await sleep(300);

  step = "lobby";
  // pin settings: exactly 1 bot, sharp, 30s, craggy
  await pg.evaluate(() => {
    for (let i = 0; i < 6; i++) document.getElementById("bots-minus").click();
  });
  await sleep(300);
  await pg.evaluate(() => document.getElementById("bots-plus").click());
  await sleep(250);
  const bots = await pg.$eval("#bots-val", (e) => e.textContent);
  if (bots !== "1") fail("bot count didn't set: " + bots);
  await pg.evaluate(() => document.getElementById("ready-btn").click());
  await pg.waitForSelector("#go-btn:not([hidden])", { timeout: 6000 });
  await shotPage("70-tanks-lobby");
  await pg.evaluate(() => document.getElementById("go-btn").click());
  await pg.waitForSelector("#scr-game:not([hidden])", { timeout: 9000 });
  log("battle started");
  await sleep(800);

  async function shotPage(nm) {
    await pg.screenshot({ path: `${OUT}/${nm}.png` });
    log("shot: " + nm);
  }

  step = "canvas";
  const canvasOk = await pg.evaluate(() => {
    const cv = document.getElementById("field");
    const cx = cv.getContext("2d");
    const data = cx.getImageData(0, cv.height - 10, cv.width, 1).data;
    let lit = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] + data[i + 1] + data[i + 2] > 30) lit++;
    }
    return lit > cv.width * 0.5;   // terrain fill spans the bottom row
  });
  if (!canvasOk) fail("battlefield canvas looks blank");
  const chips = await pg.$$eval(".hp-chip", (es) => es.length);
  if (chips !== 2) fail("expected 2 hp chips, saw " + chips);

  step = "battle";
  let fired = 0, over = false, shotMid = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 150000) {
    over = await pg.$eval("#gameover", (e) => !e.hidden).catch(() => false);
    if (over) break;
    const mine = await pg.$eval("#controls", (e) => !e.hidden).catch(() => false);
    if (mine) {
      if (fired === 0) {
        // exercise movement: hold right for ~0.5s via pointer events
        await pg.evaluate(async () => {
          const btn = document.getElementById("mv-right");
          btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
          await new Promise((r) => setTimeout(r, 480));
          btn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
        });
        await sleep(300);
        const fuel = await pg.$eval("#fuel-fill", (e) => e.style.width);
        if (fuel === "100%") log("note: movement didn't burn fuel (wall?)");
        else log("moved — fuel " + fuel);
      }
      // aim straight up, low power: shell yourself to end the battle fast
      await pg.evaluate(() => {
        const set = (id, v) => {
          const el = document.getElementById(id);
          el.value = v;
          el.dispatchEvent(new Event("input", { bubbles: true }));
        };
        set("angle", 90);
        set("power", 22);
      });
      await sleep(250);
      await pg.evaluate(() => document.getElementById("fire-btn").click());
      fired++;
      log("FIRE " + fired);
      await sleep(1600);
      if (!shotMid) { shotMid = true; await shotPage("71-tanks-battle"); }
    }
    await sleep(600);
  }
  if (!over) fail("battle never ended");
  if (fired < 1) fail("human never fired");
  await sleep(500);
  await shotPage("72-tanks-gameover");

  step = "brag";
  const hasBrag = await pg.evaluate(() => {
    const b = document.querySelector(".brag-btn-go");
    if (!b) return false;
    b.click();
    return true;
  });
  if (!hasBrag) fail("no brag button on tanks gameover");
  await sleep(1400);
  const bragOk = await pg.evaluate(() => {
    const img = document.getElementById("brag-img");
    return img && img.naturalWidth === 1080;
  });
  if (!bragOk) fail("tanks brag card didn't render");
  await shotPage("73-tanks-brag");

  step = "done";
  log(errors.length ? "CONSOLE ERRORS:\n" + errors.join("\n") : "zero console errors");
  if (errors.length) process.exitCode = 1;
  console.log(process.exitCode ? "TANKS PLAYTEST FAIL" : "TANKS PLAYTEST PASS");
  await ctx.close();
} catch (e) {
  fail(e.message);
  console.log("TANKS PLAYTEST FAIL");
} finally {
  await browser.close();
}
