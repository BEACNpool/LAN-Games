// playtest_pricecheck.mjs — two phone controllers + a TV spectator play a full
// PRICE CHECK game (enter a number on the keypad, lock, see the reveal).
// Usage: node tests/playtest_pricecheck.mjs [baseURL] [shotdir]
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
  userDataDir: os.homedir() + "/tmp/ghshot-pricecheck",
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
  await pg.goto(BASE + "/games/pricecheck/", { waitUntil: "networkidle2" });
  await pg.waitForSelector("#scr-join:not([hidden])", { timeout: 5000 });
  await pg.type("#name-input", name);
  await pg.evaluate((i) => document.querySelectorAll("#avatar-grid .avatar-cell")[i].click(), avIdx);
  await pg.click("#join-btn");
  await pg.waitForSelector("#scr-lobby:not([hidden])", { timeout: 5000 });
  return pg;
}

async function lockAGuess(pg, digits) {
  for (const d of digits) await clickText(pg, ".pc-key", d);
  await pg.click("#lock-btn").catch(() => {});
}

try {
  // TV spectator
  const tv = await (await newCtx()).newPage();
  await tv.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  tv.on("pageerror", (e) => errors.push(`TV pageerror: ${e.message}`));
  await tv.goto(BASE + "/games/pricecheck/tv.html", { waitUntil: "networkidle2" });
  await tv.waitForSelector(".tv-stage", { timeout: 5000 });
  const qrOk = await tv.$eval("#tv-qr", (e) => e.querySelector("svg,canvas,img") != null).catch(() => false);
  if (!qrOk) fail("TV join QR did not render");

  const p1 = await phone("Ava", 0);
  const p2 = await phone("Ben", 5);
  await sleep(500);

  await clickText(p1, "#opt-rule button", "CLOSEST");
  await clickText(p1, "#opt-rounds button", "3");
  await clickText(p1, "#opt-clock button", "20s");
  await sleep(400);
  await p1.click("#ready-btn"); await sleep(150);
  await p2.click("#ready-btn"); await sleep(300);
  await p1.waitForSelector("#go-btn:not([hidden])", { timeout: 4000 });
  await p1.click("#go-btn");
  await Promise.all([p1, p2].map((p) => p.waitForSelector("#scr-game:not([hidden])", { timeout: 9000 })));
  log("game on");
  await sleep(900);

  // controller keypad shot
  if (!(await shown(p1, "#pc-guess"))) fail("guess panel not shown at start");
  await p1.screenshot({ path: `${OUT}/65-pc-keypad.png` }); log("shot: keypad");
  await tv.screenshot({ path: `${OUT}/66-pc-tv-item.png` }); log("shot: TV item");

  // play to game over: each round both phones enter a number + lock
  let over = false, revealShot = false;
  const locked = { p1: -1, p2: -1 };
  const t0 = Date.now();
  while (Date.now() - t0 < 150000) {
    over = await shown(p1, "#gameover");
    if (over) break;
    for (const [key, pg, digs] of [["p1", p1, ["5", "0"]], ["p2", p2, ["1", "2", "0"]]]) {
      const round = await pg.$eval("#pc-round", (e) => e.textContent).catch(() => "?");
      if (await shown(pg, "#pc-guess") && locked[key] !== round) {
        await lockAGuess(pg, digs);
        locked[key] = round;
      }
    }
    if (!revealShot && await shown(p1, "#pc-reveal")) {
      revealShot = true;
      const ans = await p1.$eval("#pc-answer", (e) => e.textContent).catch(() => "");
      if (!ans || ans === "—") fail("reveal answer empty");
      await p1.screenshot({ path: `${OUT}/67-pc-reveal.png` }); log("shot: reveal");
      await tv.screenshot({ path: `${OUT}/68-pc-tv-reveal.png` }); log("shot: TV reveal");
    }
    await sleep(700);
  }
  if (!over) fail("game never reached game over");
  if (!revealShot) fail("never observed a reveal");
  await sleep(500);
  await p1.screenshot({ path: `${OUT}/69-pc-gameover.png` }); log("shot: game over");
  const goTitle = await p1.$eval("#go-title", (e) => e.textContent).catch(() => "");
  if (!goTitle) fail("no game-over title");
  if (!(await shown(tv, "#tv-banner"))) fail("TV champion banner not shown");
  log("finished: " + goTitle);

  log(errors.length ? "CONSOLE ERRORS:\n" + errors.join("\n") : "zero console errors");
  if (errors.length) bad++;
  console.log(bad ? "PRICE CHECK PLAYTEST FAIL" : "PRICE CHECK PLAYTEST PASS");
} catch (e) {
  fail(e.message);
  console.log("PRICE CHECK PLAYTEST FAIL");
} finally {
  await browser.close();
}
process.exit(bad ? 1 : 0);
