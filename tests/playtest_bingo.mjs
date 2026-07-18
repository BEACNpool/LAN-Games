// playtest_bingo.mjs — BIG SCREEN integration: hub rail + badge, two phone
// controllers + a TV spectator, a full AUTO game to the winner banner.
// Usage: node tests/playtest_bingo.mjs [baseURL] [shotdir]
import { createRequire } from "module";
import os from "os";
import fs from "fs";
const require = createRequire("/home/ubuntudesktop/projects/webdev-toolkit/x.js");
const puppeteer = require("puppeteer-core");

const BASE = process.argv[2] || "http://127.0.0.1:8097";
const OUT = process.argv[3] || os.homedir() + "/tmp/gamehub-shots";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const errors = [];
let bad = 0;
const fail = (m) => { console.error("FAIL: " + m); bad++; };

const browser = await puppeteer.launch({
  executablePath: "/snap/bin/chromium", headless: "new",
  userDataDir: os.homedir() + "/tmp/ghshot-bingo",
  args: ["--no-sandbox", "--disable-gpu"],
});
const newCtx = () => browser.createBrowserContext
  ? browser.createBrowserContext() : browser.createIncognitoBrowserContext();
const shown = (pg, sel) => pg.$eval(sel, (e) => !e.hidden).catch(() => false);
const clickText = (pg, sel, txt) => pg.evaluate((s, t) => {
  const b = [...document.querySelectorAll(s)].find((x) => x.textContent.trim() === t);
  if (b) { b.click(); return true; } return false;
}, sel, txt);

async function phone(name, avIdx) {
  const ctx = await newCtx();
  const pg = await ctx.newPage();
  await pg.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  pg.on("console", (m) => { if (m.type() === "error") errors.push(`${name}: ${m.text()}`); });
  pg.on("pageerror", (e) => errors.push(`${name} pageerror: ${e.message}`));
  await pg.goto(BASE + "/games/bingo/", { waitUntil: "networkidle2" });
  await pg.waitForSelector("#scr-join:not([hidden])", { timeout: 5000 });
  await pg.type("#name-input", name);
  await pg.evaluate((i) => document.querySelectorAll("#avatar-grid .avatar-cell")[i].click(), avIdx);
  await pg.click("#join-btn");
  await pg.waitForSelector("#scr-lobby:not([hidden])", { timeout: 5000 });
  return pg;
}

try {
  // ---- hub: BIG SCREEN rail + TV badge ----
  const hub = await (await newCtx()).newPage();
  await hub.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await hub.goto(BASE + "/", { waitUntil: "networkidle2" });
  await hub.waitForSelector(".rail", { timeout: 6000 });
  await sleep(400);
  const railTitles = await hub.$$eval(".rail-title", (e) => e.map((x) => x.textContent.trim()));
  if (!railTitles.includes("BIG SCREEN")) fail("no BIG SCREEN rail: " + railTitles.join(","));
  const tvBadges = await hub.$$eval(".tile-tv-badge", (e) => e.length);
  if (tvBadges < 2) fail("expected >=2 TV badges, saw " + tvBadges);
  const titles = await hub.$$eval(".tile-title", (e) => e.map((x) => x.textContent));
  if (!titles.includes("BINGO") || !titles.includes("PRICE CHECK")) fail("bigscreen tiles missing");
  await hub.screenshot({ path: `${OUT}/60-hub-bigscreen.png` }); log("shot: hub rail");

  // ---- TV spectator ----
  const tv = await (await newCtx()).newPage();
  await tv.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  tv.on("pageerror", (e) => errors.push(`TV pageerror: ${e.message}`));
  await tv.goto(BASE + "/games/bingo/tv.html", { waitUntil: "networkidle2" });
  await tv.waitForSelector(".tv-stage", { timeout: 5000 });
  const qrOk = await tv.$eval("#tv-qr", (e) => e.querySelector("svg,canvas,img") != null).catch(() => false);
  if (!qrOk) fail("TV join QR did not render");

  // ---- two controllers ----
  const p1 = await phone("Ava", 0);
  const p2 = await phone("Ben", 5);
  await sleep(500);

  // host sets AUTO / FAST / 1 round / LINE
  await clickText(p1, "#opt-auto button", "HANDS-OFF");
  await clickText(p1, "#opt-pace button", "FAST");
  await clickText(p1, "#opt-rounds button", "1");
  await clickText(p1, "#opt-pattern button", "LINE");
  await sleep(400);
  await p1.click("#ready-btn"); await sleep(150);
  await p2.click("#ready-btn"); await sleep(300);
  await p1.waitForSelector("#go-btn:not([hidden])", { timeout: 4000 });
  await p1.click("#go-btn");
  await Promise.all([p1, p2].map((p) => p.waitForSelector("#scr-game:not([hidden])", { timeout: 9000 })));
  log("game on");
  await sleep(1200);

  // card renders 25 cells with a free centre
  const cells = await p1.$$eval("#card .cell", (e) => e.length);
  if (cells !== 25) fail("card did not render 25 cells: " + cells);
  const freeCentre = await p1.$eval("#card .cell:nth-child(13)", (e) => e.classList.contains("free")).catch(() => false);
  if (!freeCentre) fail("centre cell is not FREE");
  await sleep(600);
  await p1.screenshot({ path: `${OUT}/61-bingo-card.png` }); log("shot: controller card");
  await tv.screenshot({ path: `${OUT}/62-bingo-tv-board.png` }); log("shot: TV board");
  const litBefore = await tv.$$eval("#board75 .b75.lit", (e) => e.length).catch(() => 0);

  // ---- run to game over (auto play; pace=3s, one LINE) ----
  let over = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    over = await shown(p1, "#gameover");
    if (over) break;
    await sleep(1500);
  }
  if (!over) fail("game never reached game over");
  const litAfter = await tv.$$eval("#board75 .b75.lit", (e) => e.length).catch(() => 0);
  if (litAfter <= litBefore) fail(`TV board didn't advance (lit ${litBefore} -> ${litAfter})`);
  await sleep(600);
  await p1.screenshot({ path: `${OUT}/63-bingo-gameover.png` }); log("shot: controller game over");
  await tv.screenshot({ path: `${OUT}/64-bingo-tv-winner.png` }); log("shot: TV winner");
  const goTitle = await p1.$eval("#go-title", (e) => e.textContent).catch(() => "");
  if (!goTitle) fail("no game-over title");
  const tvBanner = await shown(tv, "#tv-banner");
  if (!tvBanner) fail("TV winner banner not shown");
  log("finished: " + goTitle);

  log(errors.length ? "CONSOLE ERRORS:\n" + errors.join("\n") : "zero console errors");
  if (errors.length) bad++;
  console.log(bad ? "BINGO PLAYTEST FAIL" : "BINGO PLAYTEST PASS");
} catch (e) {
  fail(e.message);
  console.log("BINGO PLAYTEST FAIL");
} finally {
  await browser.close();
}
process.exit(bad ? 1 : 0);
