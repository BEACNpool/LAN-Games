// pfp_test.mjs — E2E: player uploads a custom photo through the REAL hidden
// file-input path; assert their own lobby card AND the other player's view
// switch from emoji to the image. Tests gamehub (spades page) and wordclash.
// Usage: node tests/pfp_test.mjs [gamehubURL] [wordclashURL]

import { createRequire } from "module";
import os from "os";
const require = createRequire("/home/ubuntudesktop/projects/webdev-toolkit/x.js");
const puppeteer = require("puppeteer-core");

const HUB = process.argv[2] || "http://127.0.0.1:8096";
const WC = process.argv[3] || "http://127.0.0.1:8095";
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
const newCtx = () => browser.createBrowserContext
  ? browser.createBrowserContext() : browser.createIncognitoBrowserContext();

async function join(page, url, name, joinSel, lobbySel) {
  await page.goto(url, { waitUntil: "networkidle2" });
  await page.waitForSelector(`${joinSel}:not([hidden])`, { timeout: 5000 });
  await page.type("#name-input", name);
  await page.click("#join-btn");
  await page.waitForSelector(`${lobbySel}:not([hidden])`, { timeout: 5000 });
}

async function uploadViaInput(page) {
  // feed a canvas-rendered PNG through the FIRST hidden file input —
  // exercises the exact code path a phone photo takes
  return page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 220;
    const cx = canvas.getContext("2d");
    cx.fillStyle = "#e0345a"; cx.fillRect(0, 0, 220, 220);
    cx.fillStyle = "#22d3ee"; cx.beginPath();
    cx.arc(110, 110, 70, 0, 7); cx.fill();
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    const file = new File([blob], "me.png", { type: "image/png" });
    const input = document.querySelector('input[type="file"]');
    if (!input) return "no file input found";
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return "ok";
  });
}

async function pfpCount(page) {
  return page.$$eval("#player-grid img.pfp", (es) => es.length).catch(() => 0);
}

async function confirmCropIfPresent(page) {
  // gamehub routes uploads through the crop/zoom modal — click USE PHOTO.
  // wordclash (separate app on :8095) uploads directly, so no modal appears.
  try {
    await page.waitForSelector(".crop-ov .crop-ok", { timeout: 1500 });
    await sleep(350);                 // let the framed image draw
    await page.click(".crop-ov .crop-ok");
    return true;
  } catch (e) { return false; }
}

async function testApp(label, base, path, joinSel, lobbySel) {
  step = label;
  const ctxA = await newCtx(), ctxB = await newCtx();
  const a = await ctxA.newPage(), b = await ctxB.newPage();
  for (const [p, nm] of [[a, "Pixel"], [b, "Watcher"]]) {
    await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
    p.on("pageerror", (e) => errors.push(`${label}/${nm} pageerror: ${e.message}`));
    p.on("console", (m) => { if (m.type() === "error") errors.push(`${label}/${nm}: ${m.text()}`); });
    await join(p, base + path, nm, joinSel, lobbySel);
  }
  await sleep(400);
  if (await pfpCount(a) !== 0) fail(`${label}: unexpected pfp before upload`);
  const up = await uploadViaInput(a);
  if (up !== "ok") fail(`${label}: ${up}`);
  await confirmCropIfPresent(a);
  await sleep(1400);
  const own = await pfpCount(a);
  const other = await pfpCount(b);
  if (own < 1) fail(`${label}: uploader doesn't see their own pfp`);
  if (other < 1) fail(`${label}: other player doesn't see the pfp`);
  // image actually loads (naturalWidth > 0)
  const loaded = await b.$eval("#player-grid img.pfp", (img) =>
    new Promise((r) => {
      if (img.complete) r(img.naturalWidth > 0);
      else { img.onload = () => r(true); img.onerror = () => r(false); }
    }));
  if (!loaded) fail(`${label}: pfp image failed to load`);
  log(`${label}: pfp visible to uploader + peer, image loads`);
  await ctxA.close(); await ctxB.close();
}

try {
  await testApp("gamehub", HUB, "/games/spades/", "#scr-join", "#scr-lobby");
  await testApp("wordclash", WC, "/", "#screen-join", "#screen-lobby");
  step = "done";
  log(errors.length ? "CONSOLE ERRORS:\n" + errors.join("\n") : "zero console errors");
  if (errors.length) process.exitCode = 1;
  console.log(process.exitCode ? "PFP TEST FAIL" : "PFP TEST PASS");
} catch (e) {
  fail(e.message);
  console.log("PFP TEST FAIL");
} finally {
  await browser.close();
}
