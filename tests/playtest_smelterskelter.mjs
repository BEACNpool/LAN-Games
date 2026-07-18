// SMELTER SKELTER: read-only TV + three isolated phone controllers complete a
// two-shift live-physics match with real hold-state input and responsive checks.
// Usage: node tests/playtest_smelterskelter.mjs [baseURL] [shotdir]
import { createRequire } from "module";
import os from "os";
import fs from "fs";

const require = createRequire("/home/ubuntudesktop/projects/webdev-toolkit/x.js");
const puppeteer = require("puppeteer-core");
const BASE = process.argv[2] || "http://127.0.0.1:8797";
const OUT = process.argv[3] || os.homedir() + "/tmp/smelterskelter-shots";
fs.mkdirSync(OUT, { recursive: true });

const TV = { width: 1440, height: 810, deviceScaleFactor: 1 };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const SMALL = { width: 360, height: 740, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
const errors = [];
let failed = 0, step = "boot";
function fail(message) { failed++; console.error(`FAIL @ ${step}: ${message}`); }

const browser = await puppeteer.launch({
  executablePath: "/snap/bin/chromium", headless: "new",
  userDataDir: os.homedir() + "/tmp/ghshot-smelterskelter",
  args: ["--no-sandbox", "--disable-gpu"],
});
const newContext = () => browser.createBrowserContext
  ? browser.createBrowserContext() : browser.createIncognitoBrowserContext();
function watch(page, label) {
  page.on("console", (message) => { if (message.type() === "error") errors.push(`${label}: ${message.text()}`); });
  page.on("pageerror", (error) => errors.push(`${label} pageerror: ${error.message}`));
}
async function shot(page, name) { await page.screenshot({ path: `${OUT}/${name}.png` }); log(`shot: ${name}`); }
async function makePhone(name, avatar, viewport = PHONE) {
  const context = await newContext(), page = await context.newPage();
  await page.setViewport(viewport); watch(page, name);
  await page.goto(`${BASE}/games/smelterskelter/`, { waitUntil: "networkidle2" });
  await page.waitForSelector("#scr-join:not([hidden])", { timeout: 7000 });
  await page.type("#name-input", name);
  await page.evaluate((i) => document.querySelectorAll("#avatar-grid .avatar-cell")[i].click(), avatar);
  await page.click("#join-btn"); await page.waitForSelector("#scr-lobby:not([hidden])", { timeout: 7000 });
  return { context, page, name };
}

try {
  step = "hub registration";
  const hubContext = await newContext(), hub = await hubContext.newPage();
  await hub.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 }); watch(hub, "hub");
  await hub.goto(`${BASE}/`, { waitUntil: "networkidle2" });
  await hub.waitForSelector(".tile-title", { timeout: 7000 });
  const titles = await hub.$$eval(".tile-title", (els) => els.map((e) => e.textContent.trim()));
  if (!titles.includes("SMELTER SKELTER")) fail("hub tile missing");

  step = "TV and QR";
  const tvContext = await newContext(), tv = await tvContext.newPage();
  await tv.setViewport(TV); watch(tv, "TV");
  await tv.goto(`${BASE}/games/smelterskelter/tv.html`, { waitUntil: "networkidle2" });
  await tv.waitForSelector("#tv-lobby:not([hidden])", { timeout: 7000 });
  await tv.click("#tv-curtain");
  const qr = await tv.$eval("#tv-qr", (e) => !!e.querySelector("svg,canvas,img"));
  if (!qr) fail("join QR did not render");

  step = "join phones";
  const crew = [await makePhone("Maya", 0), await makePhone("Rex", 4, SMALL), await makePhone("Zed", 8)];
  const phones = crew.map((x) => x.page);
  await tv.waitForFunction(() => document.querySelectorAll(".tv-worker").length === 3, { timeout: 7000 });
  await shot(tv, "01-tv-lobby"); await shot(phones[1], "02-phone-lobby-360x740");

  step = "launch";
  await phones[0].evaluate(() => [...document.querySelectorAll("#opt-shifts button")].find((b) => b.textContent === "2")?.click());
  for (const page of phones) { await page.click("#ready-btn"); await sleep(120); }
  await phones[0].waitForSelector("#go-btn:not([hidden])", { timeout: 7000 }); await phones[0].click("#go-btn");
  await Promise.all(phones.map((page) => page.waitForSelector("#scr-pad:not([hidden])", { timeout: 10000 })));
  await tv.waitForSelector("#tv-arena:not([hidden])", { timeout: 10000 });
  const masks = await Promise.all([
    tv.evaluate(() => ({ you: __smelterTV.state()?.you, mode: __smelterTV.state()?.game?.mode })),
    phones[0].evaluate(() => ({ mode: __smelterPhone.state()?.game?.mode, hasWorld: "units" in (__smelterPhone.state()?.game || {}) })),
  ]);
  if (masks[0].you !== null || masks[0].mode !== "tv") fail(`TV masking wrong: ${JSON.stringify(masks[0])}`);
  if (masks[1].mode !== "pad" || masks[1].hasWorld) fail(`phone masking wrong: ${JSON.stringify(masks[1])}`);
  for (const page of phones) {
    const layout = await page.evaluate(() => ({
      overflowX: document.documentElement.scrollWidth - innerWidth,
      overflowY: document.documentElement.scrollHeight - innerHeight,
      faces: [...document.querySelectorAll(".face-btn")].map((b) => { const r = b.getBoundingClientRect(); return [r.width, r.height]; }),
      aim: (() => { const r = document.getElementById("aim-pad").getBoundingClientRect(); return [r.width, r.height]; })(),
    }));
    if (layout.overflowX > 1 || layout.overflowY > 1) fail(`controller overflow ${JSON.stringify(layout)}`);
    if (layout.faces.some(([w, h]) => w < 44 || h < 44) || Math.min(...layout.aim) < 180) fail("controller touch targets too small");
  }
  await sleep(1800); await shot(tv, "03-tv-live-physics"); await shot(phones[0], "04-phone-controller");

  step = "drive full match";
  const started = Date.now(); let sawOverload = false, sawShift2 = false, cycles = 0;
  while (Date.now() - started < 125000) {
    const states = await Promise.all(phones.map((page) => page.evaluate(() => __smelterPhone.state())));
    if (states.every((st) => st?.phase === "game_end")) break;
    for (let i = 0; i < phones.length; i++) {
      const angle = [245, 292, 215, 325, 270][(cycles + i * 2) % 5];
      await phones[i].evaluate((a) => { __smelterPhone.setAim(a); __smelterPhone.hold("hook", true); }, angle);
    }
    await sleep(700);
    for (const page of phones) await page.evaluate(() => __smelterPhone.hold("reel", true));
    await sleep(430);
    for (const page of phones) await page.evaluate(() => __smelterPhone.hold("reel", false));
    if (cycles % 3 === 2) {
      for (const page of phones) await page.evaluate(() => __smelterPhone.hold("hook", false));
      await sleep(230);
    }
    const g = await tv.evaluate(() => __smelterTV.state()?.game);
    if (g?.overload && !sawOverload) { sawOverload = true; await shot(tv, "05-tv-overload"); }
    if (g?.shift === 2 && !sawShift2) { sawShift2 = true; await sleep(900); await shot(tv, "06-tv-shift-two"); }
    cycles++;
  }
  for (const page of phones) await page.evaluate(() => __smelterPhone.releaseControls());
  if (!sawOverload) fail("never observed overload");
  if (!sawShift2) fail("never reached shift two");

  step = "results";
  await Promise.all(phones.map((page) => page.waitForSelector("#gameover:not([hidden])", { timeout: 12000 })));
  await tv.waitForSelector("#tv-results:not([hidden])", { timeout: 12000 });
  await shot(tv, "07-tv-results"); await shot(phones[0], "08-phone-results");
  const result = await phones[0].evaluate(() => __smelterPhone.state()?.game?.result);
  if (!result?.standings?.length || !result.winner) fail("result payload incomplete");
  const brag = await phones[0].$(".brag-btn-go");
  if (!brag) fail("brag button missing");
  else {
    await brag.click(); await phones[0].waitForSelector("#brag-modal:not([hidden])", { timeout: 8000 });
    const width = await phones[0].$eval("#brag-img", (img) => img.naturalWidth); if (width !== 1080) fail(`brag width ${width}`);
    await shot(phones[0], "09-brag-card");
  }
  const tvOverflow = await tv.evaluate(() => [document.documentElement.scrollWidth - innerWidth, document.documentElement.scrollHeight - innerHeight]);
  if (tvOverflow.some((n) => n > 1)) fail(`TV overflow ${tvOverflow}`);

  step = "done";
  log(errors.length ? `CONSOLE ERRORS:\n${errors.join("\n")}` : "zero console errors");
  if (errors.length) failed++;
  await Promise.all(crew.map((x) => x.context.close())); await tvContext.close(); await hubContext.close();
} catch (error) { fail(error.stack || error.message); }
finally { await browser.close(); }
console.log(failed ? "SMELTER SKELTER PLAYTEST FAIL" : "SMELTER SKELTER PLAYTEST PASS");
process.exit(failed ? 1 : 0);
