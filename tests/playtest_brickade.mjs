// playtest_brickade.mjs — real-time canvas game (Pong-royale x Breakout).
// The human joins, drags the paddle a little, and bots + sudden-death resolve
// the match. Verifies the canvas renders (non-blank), a match completes,
// gameover + brag work, and no console errors. Also opens a 4-player polygon
// arena to exercise the per-client rotation + N-gon geometry.
// Usage: node tests/playtest_brickade.mjs [baseURL] [shotdir]

import os from "os";
import fs from "fs";
import { puppeteer, CHROME_PATH } from "./_resolve.mjs";

const BASE = process.argv[2] || "http://127.0.0.1:8096";
const OUT = process.argv[3] || os.homedir() + "/tmp/gamehub-shots/brickade";
fs.mkdirSync(OUT, { recursive: true });
const NARROW = { width: 360, height: 740, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const PHONE = { width: 390, height: 780, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const DESK = { width: 900, height: 760, deviceScaleFactor: 1 };
const errors = [];
let step = "boot";
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (pg, n) => pg.screenshot({ path: `${OUT}/${n}.png` }).then(() => log("shot " + n));
function fail(m) { console.error("FAIL @ " + step + ": " + m); process.exitCode = 1; }

const browser = await puppeteer.launch({
  executablePath: CHROME_PATH, headless: "new",
  userDataDir: os.homedir() + "/tmp/ghshot-brick",
  args: ["--no-sandbox", "--disable-gpu"],
});

async function setSeg(pg, host, label) {
  await pg.evaluate((h, l) => {
    for (const b of document.getElementById(h).querySelectorAll("button"))
      if (b.textContent.trim() === l) { b.click(); return; }
  }, host, label);
}
async function canvasNonBlank(pg) {
  return await pg.evaluate(() => {
    const c = document.getElementById("cv"); if (!c) return false;
    const g = c.getContext("2d");
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let min = 255, max = 0;
    for (let i = 0; i < d.length; i += 40) { min = Math.min(min, d[i]); max = Math.max(max, d[i]); }
    return max - min > 12;
  });
}
async function responsiveChrome(pg) {
  return await pg.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const overflow = document.documentElement.scrollWidth - width;
    const power = document.getElementById("power-btn")?.getBoundingClientRect();
    const mute = document.getElementById("game-mute-btn")?.getBoundingClientRect();
    return {
      overflow,
      powerInView: !power || (power.left >= 0 && power.right <= width && power.bottom <= innerHeight),
      muteInView: !mute || (mute.left >= 0 && mute.right <= width && mute.top >= 0),
    };
  });
}
async function dragPaddle(pg) {
  await pg.evaluate(() => {
    const c = document.getElementById("cv");
    const mk = (t, x, y) => c.dispatchEvent(new TouchEvent(t, { bubbles: true, cancelable: true,
      changedTouches: [new Touch({ identifier: 1, target: c, clientX: x, clientY: y })] }));
    mk("touchstart", 200, 600); mk("touchmove", 120, 600); mk("touchmove", 280, 600); mk("touchend", 280, 600);
  }).catch(() => {});
}

try {
  step = "join";
  const ctx = await (browser.createBrowserContext ? browser.createBrowserContext() : browser.createIncognitoBrowserContext());
  const pg = await ctx.newPage();
  await pg.setViewport(NARROW);
  pg.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  pg.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  await pg.goto(BASE + "/games/brickade/", { waitUntil: "networkidle2" });
  await pg.waitForSelector("#scr-join:not([hidden])", { timeout: 5000 });
  await shot(pg, "00-join-360");
  let chrome = await responsiveChrome(pg);
  if (chrome.overflow > 1) fail(`360px join overflows horizontally by ${chrome.overflow}px`);
  await pg.type("#name-input", "Ava");
  await pg.click("#join-btn");
  await pg.waitForSelector("#scr-lobby:not([hidden])", { timeout: 5000 });
  await sleep(300);
  await shot(pg, "01-lobby-360");
  chrome = await responsiveChrome(pg);
  if (chrome.overflow > 1) fail(`360px lobby overflows horizontally by ${chrome.overflow}px`);
  await pg.setViewport(PHONE);
  await sleep(200);

  step = "lobby";
  await setSeg(pg, "opt-players", "DUEL");
  await setSeg(pg, "opt-lives", "1");
  await setSeg(pg, "opt-diff", "EASY");   // weaker bots -> a goal actually lands
  await setSeg(pg, "opt-layout", "RING");
  await sleep(300);
  await shot(pg, "01-lobby");
  await pg.evaluate(() => document.getElementById("ready-btn").click());
  await pg.waitForSelector("#go-btn:not([hidden])", { timeout: 4000 });
  await pg.evaluate(() => document.getElementById("go-btn").click());
  await pg.waitForSelector("#scr-game:not([hidden])", { timeout: 6000 });
  await sleep(3300);   // countdown

  step = "play";
  await sleep(900);
  if (!(await canvasNonBlank(pg))) fail("arena canvas is blank — nothing rendered");
  else log("arena renders (non-blank) OK");
  chrome = await responsiveChrome(pg);
  if (chrome.overflow > 1 || !chrome.powerInView || !chrome.muteInView)
    fail(`mobile game chrome escaped viewport: ${JSON.stringify(chrome)}`);
  await dragPaddle(pg);
  await sleep(400);
  await shot(pg, "02-arena");

  step = "finish";
  let over = false;
  for (let i = 0; i < 260 && !over; i++) {
    over = await pg.evaluate(() => !document.getElementById("gameover").hidden);
    if (over) break;
    if (i % 20 === 10) await dragPaddle(pg);
    await sleep(500);
  }
  if (!over) fail("match did not finish");
  else { await sleep(400); await shot(pg, "03-gameover"); log("match finished + gameover OK"); }

  step = "brag";
  const bragBtn = await pg.$(".brag-btn-go");
  if (over && bragBtn) {
    await bragBtn.click();
    await pg.waitForSelector("#brag-modal:not([hidden])", { timeout: 4000 }).catch(() => {});
    await sleep(800);
    await shot(pg, "04-brag");
    const w = await pg.$eval("#brag-img", (i) => i.naturalWidth).catch(() => 0);
    if (w !== 1080) fail("brag not 1080 (" + w + ")"); else log("brag OK 1080");
  } else if (over) fail("no brag button");

  await pg.evaluate(() => { const b = document.getElementById("brag-close"); if (b) b.click(); });
  await pg.evaluate(() => { const b = document.getElementById("rematch-btn"); if (b) b.click(); });
  await sleep(400); await ctx.close(); await sleep(300);

  step = "polygon-desktop";
  const ctx2 = await (browser.createBrowserContext ? browser.createBrowserContext() : browser.createIncognitoBrowserContext());
  const pg2 = await ctx2.newPage();
  await pg2.setViewport(DESK);
  pg2.on("console", (m) => { if (m.type() === "error") errors.push("d2:" + m.text()); });
  pg2.on("pageerror", (e) => errors.push("pageerror2: " + e.message));
  await pg2.goto(BASE + "/games/brickade/", { waitUntil: "networkidle2" });
  await pg2.waitForSelector("#scr-join:not([hidden])", { timeout: 5000 });
  await pg2.type("#name-input", "Dev"); await pg2.click("#join-btn");
  await pg2.waitForSelector("#scr-lobby:not([hidden])", { timeout: 5000 });
  await sleep(300);
  await setSeg(pg2, "opt-players", "6");
  await setSeg(pg2, "opt-lives", "3");
  await setSeg(pg2, "opt-layout", "CHECKER");
  await sleep(200);
  await pg2.evaluate(() => document.getElementById("ready-btn").click());
  await pg2.waitForSelector("#go-btn:not([hidden])", { timeout: 4000 });
  await pg2.evaluate(() => document.getElementById("go-btn").click());
  await pg2.waitForSelector("#scr-game:not([hidden])", { timeout: 6000 });
  await sleep(4200);
  if (!(await canvasNonBlank(pg2))) fail("polygon arena blank");
  else log("6-player polygon renders OK");
  await shot(pg2, "05-polygon-desktop");

  if (errors.length) { console.error("CONSOLE ERRORS:\n" + errors.slice(0, 8).join("\n")); fail(errors.length + " console errors"); }
  log("DONE" + (process.exitCode ? " (with failures)" : " OK"));
} catch (e) { fail(e.message + "\n" + (e.stack || "")); }
finally { await browser.close(); }
