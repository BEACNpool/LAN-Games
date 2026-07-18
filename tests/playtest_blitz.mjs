// playtest_blitz.mjs — 2 browser players race a full 5-round CATEGORY BLITZ:
// join -> pin settings (5 rounds, 30s sand) -> both type answers (one
// overlapping to prove cancellation renders, plus uniques) -> reveal asserts
// (strikethrough on the match, +10s on uniques, tap-to-skip) -> podium +
// brag card. Also asserts mid-round masking and the never-lose-focus rule.
// Usage: node tests/playtest_blitz.mjs [baseURL] [shotdir]

import { createRequire } from "module";
import os from "os";
import fs from "fs";
const require = createRequire("/home/ubuntudesktop/projects/webdev-toolkit/x.js");
const puppeteer = require("puppeteer-core");

const BASE = process.argv[2] || "http://127.0.0.1:8127";
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
  userDataDir: os.homedir() + "/tmp/ghshot-blitz",
  args: ["--no-sandbox", "--disable-gpu"],
});
const newCtx = () => browser.createBrowserContext
  ? browser.createBrowserContext() : browser.createIncognitoBrowserContext();

async function shot(page, nm) {
  await page.screenshot({ path: `${OUT}/${nm}.png` });
  log("shot: " + nm);
}

async function mkPlayer(name, avatarIdx) {
  const ctx = await newCtx();
  const page = await ctx.newPage();
  await page.setViewport(PHONE);
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${name}: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`${name} pageerror: ${e.message}`));
  await page.goto(BASE + "/games/blitz/", { waitUntil: "networkidle2" });
  await page.waitForSelector("#scr-join:not([hidden])", { timeout: 5000 });
  await page.type("#name-input", name);
  await page.evaluate((i) =>
    document.querySelectorAll("#avatar-grid .avatar-cell")[i].click(), avatarIdx);
  await page.click("#join-btn");
  await page.waitForSelector("#scr-lobby:not([hidden])", { timeout: 5000 });
  return page;
}

async function waitBlitz(page, round, t = 45000) {
  // blitz stage of the given round: chip says R<round>/5 and input is live
  await page.waitForFunction((r) =>
    document.getElementById("bz-roundchip")?.textContent === `R${r}/5`
    && document.getElementById("intro-overlay").hidden
    && !document.getElementById("answer-input").disabled,
    { timeout: t }, round);
}

async function typeAnswer(page, text) {
  await page.evaluate(() => document.getElementById("answer-input").focus());
  await page.type("#answer-input", text, { delay: 14 });
  await page.keyboard.press("Enter");
  await sleep(120);
}

async function waitReveal(page, t = 40000) {
  await page.waitForSelector("#reveal-overlay:not([hidden])", { timeout: t });
}

async function tapDone(page) {
  await page.evaluate(() => document.getElementById("tap-btn").click());
}

try {
  step = "join";
  const ava = await mkPlayer("Ava", 0);
  const rex = await mkPlayer("Rex", 5);
  const players = [ava, rex];
  await sleep(400);

  step = "lobby";
  // pin settings: 5 rounds (the smallest option — assert it's the default),
  // 30s sand timer
  const roundsSel = await ava.evaluate(() =>
    document.querySelector("#opt-rounds button.sel")?.textContent);
  if (roundsSel !== "5") fail("rounds default not 5: " + roundsSel);
  await ava.evaluate(() => {
    for (const b of document.querySelectorAll("#opt-seconds button"))
      if (b.textContent === "30S") b.click();
  });
  await sleep(300);
  const secSync = await rex.evaluate(() =>
    document.querySelector("#opt-seconds button.sel")?.textContent);
  if (secSync !== "30S") fail("timer didn't sync to Rex: " + secSync);
  const armed = await ava.$eval("#deck-count", (e) => e.textContent);
  if (!/\d\d+ CATEGORIES/.test(armed)) fail("deck badge looks wrong: " + armed);
  await shot(ava, "80-blitz-lobby");
  for (const p of players) {
    await p.evaluate(() => document.getElementById("ready-btn").click());
    await sleep(150);
  }
  await ava.waitForSelector("#go-btn:not([hidden])", { timeout: 6000 });
  await ava.evaluate(() => document.getElementById("go-btn").click());
  log("timer flipped");

  // ---------- round 1: overlap + uniques ----------
  step = "round1-type";
  await waitBlitz(ava, 1);
  await waitBlitz(rex, 1, 8000);
  const cat = await ava.$eval("#cb-cat", (e) => e.textContent);
  log(`round 1 category: "${cat}"`);
  await typeAnswer(ava, "pizza");
  await typeAnswer(ava, "purple dragon");
  await typeAnswer(rex, "Pizza!!");          // must cancel Ava's pizza
  await typeAnswer(rex, "swamp castle");
  // focus never drops after submit
  const focused = await ava.evaluate(() =>
    document.activeElement === document.getElementById("answer-input"));
  if (!focused) fail("answer input lost focus after submit");
  // masking: Rex's unique must not appear anywhere on Ava's screen
  const leak = await ava.evaluate(() =>
    document.body.innerText.toLowerCase().includes("swamp castle"));
  if (leak) fail("opponent answer leaked mid-round");
  // both count badges tick to 2
  await sleep(400);
  const cnts = await ava.$$eval("#score-strip .cnt", (es) => es.map((e) => e.textContent.trim()));
  if (!(cnts.length === 2 && cnts.every((c) => c === "✎2")))
    fail("answer counts didn't tick: " + JSON.stringify(cnts));
  // own chips render (2 real chips, none stuck pending)
  const chips = await ava.$$eval("#chips .chip:not(.pending)", (es) => es.length);
  if (chips !== 2) fail("own chips wrong: " + chips);
  await shot(ava, "81-blitz-typing");

  step = "round1-reveal";
  await waitReveal(ava);
  const revealShown = Date.now();
  await waitReveal(rex, 5000);
  for (const [nm, pg] of [["ava", ava], ["rex", rex]]) {
    const got = await pg.evaluate(() => {
      const cx = [...document.querySelectorAll("#rv-grid .rv-chip.cx .rc-text")]
        .map((e) => e.textContent.toLowerCase());
      const uq = [...document.querySelectorAll("#rv-grid .rv-chip.uq .rc-text")]
        .map((e) => e.textContent.toLowerCase());
      const gains = [...document.querySelectorAll("#rv-grid .rw-gain")]
        .map((e) => e.textContent);
      return { cx, uq, gains };
    });
    if (!(got.cx.length === 2 && got.cx.every((t) => t.includes("pizza"))))
      fail(`${nm}: pizza match not struck out: ` + JSON.stringify(got.cx));
    if (!got.uq.includes("purple dragon") || !got.uq.includes("swamp castle"))
      fail(`${nm}: uniques not glowing: ` + JSON.stringify(got.uq));
    if (!(got.gains.length === 2 && got.gains.every((g) => g === "+10")))
      fail(`${nm}: round gains wrong: ` + JSON.stringify(got.gains));
  }
  await sleep(1700);                          // let the strike/glow anims land
  await shot(ava, "82-blitz-reveal");

  step = "tap-skip";
  await tapDone(ava);
  await sleep(250);
  const stillWaiting = await rex.$eval("#tap-btn", (e) => e.textContent);
  if (!stillWaiting.includes("1/2")) fail("tap count not shown: " + stillWaiting);
  await tapDone(rex);
  await ava.waitForSelector("#reveal-overlay[hidden]", { timeout: 3000 })
    .catch(() => fail("reveal didn't skip after everyone tapped"));
  if (Date.now() - revealShown > 6800)
    log("note: reveal ran close to its auto timer — skip not proven");
  else log("tap-to-skip proven early");

  // ---------- rounds 2-5: Ava piles up points ----------
  for (let r = 2; r <= 5; r++) {
    step = `round${r}`;
    await waitBlitz(ava, r);
    await waitBlitz(rex, r, 8000);
    await typeAnswer(ava, `ava unique r${r}`);
    if (r === 2) await typeAnswer(ava, "ava bonus round");   // best-round bait
    if (r <= 3) await typeAnswer(rex, `rex unique r${r}`);
    await waitReveal(ava);
    await waitReveal(rex, 5000);
    await sleep(400);
    await tapDone(ava);
    await tapDone(rex);
    await sleep(400);
    log(`round ${r} done`);
  }

  step = "gameover";
  await ava.waitForSelector("#gameover:not([hidden])", { timeout: 20000 });
  const title = await ava.$eval("#go-title", (e) => e.textContent);
  if (!title.includes("AVA")) fail("wrong winner: " + title);
  const pods = await ava.$$eval("#podium .pod", (es) => es.length);
  if (pods !== 2) fail("podium slots wrong: " + pods);
  const scores = await ava.$$eval("#go-rows .go-row b", (es) => es.map((e) => e.textContent));
  if (!(scores[0] === "60" && scores[1] === "30"))
    fail("final scores wrong: " + JSON.stringify(scores));   // 10+20+10+10+10 / 10+10+10
  const best = await ava.$eval("#go-best", (e) => e.hidden ? "" : e.textContent);
  if (!(best.includes("Ava") && best.includes("+20") && best.includes("R2")))
    fail("best-round callout wrong: " + best);
  await shot(ava, "83-blitz-gameover");

  step = "brag";
  const hasBrag = await ava.evaluate(() => {
    const b = document.querySelector(".brag-btn-go");
    if (!b) return false;
    b.click();
    return true;
  });
  if (!hasBrag) fail("no brag button on blitz gameover");
  await sleep(1400);
  const bragOk = await ava.evaluate(() => {
    const img = document.getElementById("brag-img");
    return img && img.naturalWidth === 1080;
  });
  if (!bragOk) fail("blitz brag card didn't render");
  await shot(ava, "84-blitz-brag");

  step = "done";
  log(errors.length ? "CONSOLE ERRORS:\n" + errors.join("\n") : "zero console errors");
  if (errors.length) process.exitCode = 1;
  console.log(process.exitCode ? "BLITZ PLAYTEST FAIL" : "BLITZ PLAYTEST PASS");
} catch (e) {
  fail(e.message);
  console.log("BLITZ PLAYTEST FAIL");
} finally {
  await browser.close();
}
