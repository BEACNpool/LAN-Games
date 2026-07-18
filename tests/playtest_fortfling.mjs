// FORT FLING — two isolated phone browsers, real pointer sling, inventory,
// alternating turns, full ammo/KO resolution, game-over, and brag card.
// Usage: node tests/playtest_fortfling.mjs [baseURL] [shotdir]

import { createRequire } from "module";
import os from "os";
import fs from "fs";

const require = createRequire("/home/ubuntudesktop/projects/webdev-toolkit/x.js");
const puppeteer = require("puppeteer-core");
const BASE = process.argv[2] || "http://127.0.0.1:8797";
const OUT = process.argv[3] || os.homedir() + "/tmp/fortfling-shots";
fs.mkdirSync(OUT, { recursive: true });

const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const errors = [];
let step = "boot";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
function fail(message) { console.error(`FAIL @ ${step}: ${message}`); process.exitCode = 1; }

const browser = await puppeteer.launch({
  executablePath: "/snap/bin/chromium", headless: "new",
  userDataDir: os.homedir() + "/tmp/ghshot-fortfling",
  args: ["--no-sandbox", "--disable-gpu"],
});
const newContext = () => browser.createBrowserContext
  ? browser.createBrowserContext() : browser.createIncognitoBrowserContext();

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  log(`shot: ${name}`);
}

async function player(name, avatarIndex) {
  const context = await newContext();
  const page = await context.newPage();
  await page.setViewport(PHONE);
  page.on("console", (message) => { if (message.type() === "error") errors.push(`${name}: ${message.text()}`); });
  page.on("pageerror", (error) => errors.push(`${name} pageerror: ${error.message}`));
  await page.goto(`${BASE}/games/fortfling/`, { waitUntil: "networkidle2" });
  await page.waitForSelector("#scr-join:not([hidden])", { timeout: 6000 });
  await page.type("#name-input", name);
  await page.evaluate((index) => document.querySelectorAll("#avatar-grid .avatar-cell")[index].click(), avatarIndex);
  await page.click("#join-btn");
  await page.waitForSelector("#scr-lobby:not([hidden])", { timeout: 6000 });
  return { context, page };
}

async function waitForTurn(pages, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const page of pages) {
      const mine = await page.evaluate(() => window.FORT_FLING_DEV.state()?.game?.your_turn === true)
        .catch(() => false);
      if (mine) return page;
    }
    await sleep(120);
  }
  return null;
}

async function realPointerFling(page) {
  const data = await page.evaluate(() => {
    const state = window.FORT_FLING_DEV.state();
    const fort = state.game.forts.find((item) => item.pid === state.you.pid);
    const rect = document.getElementById("arena").getBoundingClientRect();
    return {
      side: fort.side,
      anchorX: rect.left + fort.sling_x / 1000 * rect.width,
      anchorY: rect.top + (1 - fort.sling_y / 560) * rect.height,
    };
  });
  await page.mouse.move(data.anchorX, data.anchorY);
  await page.mouse.down();
  await page.mouse.move(data.anchorX + (data.side === "left" ? -58 : 58), data.anchorY + 42,
    { steps: 8 });
  await page.mouse.up();
}

function bestAvailable(inventory) {
  for (const weapon of ["cluster", "bomb", "rocket", "boulder", "ricochet"])
    if (inventory[weapon] > 0) return weapon;
  return null;
}

function shotFor(weapon) {
  if (weapon === "cluster") return [40, .4];
  if (weapon === "bomb") return [55, .6];
  if (weapon === "rocket") return [10, .25];
  if (weapon === "ricochet") return [25, .3];
  return [55, .5];
}

try {
  step = "join";
  const ava = await player("Ava", 0);
  const rex = await player("Rex", 5);
  const pages = [ava.page, rex.page];
  await sleep(300);
  await shot(ava.page, "90-fortfling-lobby");

  step = "ready";
  for (const page of pages) { await page.click("#ready-btn"); await sleep(140); }
  await ava.page.waitForSelector("#go-btn:not([hidden])", { timeout: 6000 });
  await ava.page.click("#go-btn");
  await Promise.all(pages.map((page) => page.waitForSelector("#scr-game:not([hidden])", { timeout: 8000 })));
  log("battle started");
  await shot(ava.page, "91-fortfling-battle");

  step = "pointer fling";
  let current = await waitForTurn(pages);
  if (!current) throw new Error("no opening turn");
  const before = await current.evaluate(() => window.FORT_FLING_DEV.state().game.shots);
  await realPointerFling(current);
  const pointerWorked = await current.waitForFunction((shots) =>
    window.FORT_FLING_DEV.state()?.game?.shots > shots, { timeout: 6000 }, before)
    .then(() => true).catch(() => false);
  if (!pointerWorked) throw new Error("pull-and-release gesture did not fire");
  log("real pointer pull-and-release fired");
  await sleep(750);
  await shot(current, "92-fortfling-projectile");

  step = "full match";
  let flings = 1;
  for (let guard = 0; guard < 35; guard++) {
    const over = await ava.page.$("#gameover:not([hidden])");
    if (over) break;
    current = await waitForTurn(pages, 8000);
    if (!current) {
      if (await ava.page.$("#gameover:not([hidden])")) break;
      throw new Error("next turn never appeared");
    }
    const state = await current.evaluate(() => window.FORT_FLING_DEV.state());
    const fort = state.game.forts.find((item) => item.pid === state.you.pid);
    const weapon = bestAvailable(fort.inventory);
    if (!weapon) throw new Error("turn owner has no selectable ammo");
    const [angle, power] = shotFor(weapon);
    await current.evaluate((w, a, p) => window.FORT_FLING_DEV.fire(w, a, p), weapon, angle, power);
    flings++;
    await sleep(260);
  }
  const over = await ava.page.waitForSelector("#gameover:not([hidden])", { timeout: 12000 })
    .then(() => true).catch(() => false);
  if (!over) throw new Error("match did not reach game over");
  if (flings < 3) throw new Error(`match ended suspiciously early (${flings} flings)`);
  const finalState = await ava.page.evaluate(() => window.FORT_FLING_DEV.state());
  const actualShots = finalState.game.result.shots;
  if (actualShots < 3) throw new Error(`match ended suspiciously early (${actualShots} server shots)`);
  log(`match finished after ${actualShots} server-authoritative flings (${flings} attempts)`);
  await shot(ava.page, "93-fortfling-gameover");

  step = "brag";
  const hasBrag = await ava.page.evaluate(() => {
    const button = document.querySelector(".brag-btn-go");
    if (!button) return false;
    button.click(); return true;
  });
  if (!hasBrag) throw new Error("brag button missing");
  await sleep(1400);
  const brag = await ava.page.evaluate(() => document.getElementById("brag-img")?.naturalWidth === 1080);
  if (!brag) throw new Error("brag card did not render at 1080px");
  await shot(ava.page, "94-fortfling-brag");

  step = "layout";
  for (const page of pages) {
    const layout = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - innerWidth,
      weaponTargets: [...document.querySelectorAll(".weapon-btn")].map((button) => {
        const rect = button.getBoundingClientRect(); return [rect.width, rect.height];
      }),
    }));
    if (layout.overflow > 1) throw new Error(`phone overflowed horizontally by ${layout.overflow}px`);
    if (layout.weaponTargets.some(([width, height]) => width < 44 || height < 44))
      throw new Error("weapon belt has a sub-44px touch target");
  }

  step = "done";
  log(errors.length ? `CONSOLE ERRORS:\n${errors.join("\n")}` : "zero console errors");
  if (errors.length) process.exitCode = 1;
  console.log(process.exitCode ? "FORT FLING PLAYTEST FAIL" : "FORT FLING PLAYTEST PASS");
  await ava.context.close(); await rex.context.close();
} catch (error) {
  fail(error.message);
  console.log("FORT FLING PLAYTEST FAIL");
} finally {
  await browser.close();
}
