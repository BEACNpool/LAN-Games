// playtest_dodgeball.mjs — real-time canvas game. The human joins and mostly
// idles; bots + sudden-death resolve the match. Verifies the canvas renders
// (non-blank), a match completes, gameover + brag work, and no console errors.
// Usage: node tests/playtest_dodgeball.mjs [baseURL] [shotdir]

import os from "os";
import fs from "fs";
import { puppeteer, CHROME_PATH } from "./_resolve.mjs";

const BASE = process.argv[2] || "http://127.0.0.1:8096";
const OUT = process.argv[3] || os.homedir() + "/tmp/gamehub-shots/dodgeball";
fs.mkdirSync(OUT, { recursive: true });
const PHONE = { width: 844, height: 390, deviceScaleFactor: 2, isMobile: true, hasTouch: true };  // landscape
const DESK = { width: 1000, height: 700, deviceScaleFactor: 1 };
const errors = [];
let step = "boot";
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (pg, n) => pg.screenshot({ path: `${OUT}/${n}.png` }).then(() => log("shot " + n));
function fail(m) { console.error("FAIL @ " + step + ": " + m); process.exitCode = 1; }

const browser = await puppeteer.launch({
  executablePath: CHROME_PATH, headless: "new",
  userDataDir: os.homedir() + "/tmp/ghshot-dodge",
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
    return max - min > 12;   // real variance = something drew
  });
}

try {
  step = "join";
  const ctx = await (browser.createBrowserContext ? browser.createBrowserContext() : browser.createIncognitoBrowserContext());
  const pg = await ctx.newPage();
  await pg.setViewport(PHONE);
  pg.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  pg.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  await pg.goto(BASE + "/games/dodgeball/", { waitUntil: "networkidle2" });
  await pg.waitForSelector("#scr-join:not([hidden])", { timeout: 5000 });
  await pg.type("#name-input", "Ava");
  await pg.click("#join-btn");
  await pg.waitForSelector("#scr-lobby:not([hidden])", { timeout: 5000 });
  await sleep(300);

  step = "lobby";
  await setSeg(pg, "opt-players", "4");
  await setSeg(pg, "opt-lives", "1");     // fast finish
  await setSeg(pg, "opt-diff", "HARD");
  await sleep(300);
  await shot(pg, "01-lobby");
  await pg.evaluate(() => document.getElementById("ready-btn").click());
  await pg.waitForSelector("#go-btn:not([hidden])", { timeout: 4000 });
  await pg.evaluate(() => document.getElementById("go-btn").click());
  await pg.waitForSelector("#scr-game:not([hidden])", { timeout: 6000 });
  await sleep(3200);   // countdown

  step = "play";
  await sleep(900);
  if (!(await canvasNonBlank(pg))) fail("court canvas is blank — nothing rendered");
  else log("court renders (non-blank) OK");
  await shot(pg, "02-court");
  // simulate a bit of touch input (left joystick) so the control overlay draws
  await pg.evaluate(() => {
    const c = document.getElementById("cv");
    const mk = (t, x, y) => c.dispatchEvent(new TouchEvent(t, { bubbles: true, cancelable: true,
      changedTouches: [new Touch({ identifier: 1, target: c, clientX: x, clientY: y })] }));
    mk("touchstart", 90, 200); mk("touchmove", 130, 170);
  }).catch(() => {});
  await sleep(400);
  await shot(pg, "03-controls");

  step = "finish";
  let over = false;
  for (let i = 0; i < 120 && !over; i++) {
    over = await pg.evaluate(() => !document.getElementById("gameover").hidden);
    if (over) break;
    await sleep(500);
  }
  if (!over) fail("match did not finish");
  else { await sleep(400); await shot(pg, "04-gameover"); }

  step = "brag";
  const bragBtn = await pg.$(".brag-btn-go");
  if (over && bragBtn) {
    await bragBtn.click();
    await pg.waitForSelector("#brag-modal:not([hidden])", { timeout: 4000 }).catch(() => {});
    await sleep(800);
    await shot(pg, "05-brag");
    const w = await pg.$eval("#brag-img", (i) => i.naturalWidth).catch(() => 0);
    if (w !== 1080) fail("brag not 1080 (" + w + ")"); else log("brag OK 1080");
  } else if (over) fail("no brag button");

  // reset shared session for the desktop pass
  await pg.evaluate(() => document.getElementById("brag-close")?.click());
  await pg.evaluate(() => document.getElementById("rematch-btn")?.click());
  await sleep(400); await ctx.close(); await sleep(300);

  step = "desktop-teams";
  const ctx2 = await (browser.createBrowserContext ? browser.createBrowserContext() : browser.createIncognitoBrowserContext());
  const pg2 = await ctx2.newPage();
  await pg2.setViewport(DESK);
  pg2.on("pageerror", (e) => errors.push("pageerror2: " + e.message));
  await pg2.goto(BASE + "/games/dodgeball/", { waitUntil: "networkidle2" });
  await pg2.waitForSelector("#scr-join:not([hidden])", { timeout: 5000 });
  await pg2.type("#name-input", "Dev"); await pg2.click("#join-btn");
  await pg2.waitForSelector("#scr-lobby:not([hidden])", { timeout: 5000 });
  await sleep(300);
  await setSeg(pg2, "opt-players", "6");
  await setSeg(pg2, "opt-mode", "TEAMS");
  await setSeg(pg2, "opt-lives", "3");
  await sleep(200);
  await pg2.evaluate(() => document.getElementById("ready-btn").click());
  await pg2.waitForSelector("#go-btn:not([hidden])", { timeout: 4000 });
  await pg2.evaluate(() => document.getElementById("go-btn").click());
  await pg2.waitForSelector("#scr-game:not([hidden])", { timeout: 6000 });
  await sleep(4200);
  await shot(pg2, "06-teams-desktop");

  if (errors.length) { console.error("CONSOLE ERRORS:\n" + errors.slice(0, 8).join("\n")); fail(errors.length + " console errors"); }
  log("DONE" + (process.exitCode ? " (with failures)" : " OK"));
} catch (e) { fail(e.message + "\n" + (e.stack || "")); }
finally { await browser.close(); }
