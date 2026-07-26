// playtest_wordrush.mjs — two phone controllers + a TV spectator play a full
// WORD RUSH round: tap-build a word, submit a real word, see the reveal + winner.
// Usage: node tests/playtest_wordrush.mjs [baseURL] [shotdir]
import os from "os";
import fs from "fs";
import { puppeteer, CHROME_PATH } from "./_resolve.mjs";

const BASE = process.argv[2] || "http://127.0.0.1:8096";
const OUT = process.argv[3] || os.homedir() + "/tmp/gamehub-shots";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const errors = [];
let bad = 0;
const fail = (m) => { console.error("FAIL: " + m); bad++; };

// common short words to try to form from a rack (so a human actually scores)
const COMMON = ["cat", "dog", "ear", "eat", "tea", "ate", "ten", "net", "one", "ton",
  "are", "era", "ear", "sit", "its", "tie", "toe", "oat", "ran", "tan", "rat", "art",
  "ore", "roe", "sea", "ace", "cab", "bad", "dab", "log", "god", "pot", "top", "opt",
  "sun", "nut", "run", "urn", "ice", "lie", "oil", "din", "rid", "nod", "don", "old"];
const canMake = (w, rack) => {
  const bag = {}; for (const c of rack) bag[c] = (bag[c] || 0) + 1;
  for (const c of w) { if (!bag[c]) return false; bag[c]--; }
  return true;
};

const browser = await puppeteer.launch({
  executablePath: CHROME_PATH, headless: "new",
  userDataDir: os.homedir() + "/tmp/ghshot-wordrush",
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
  await pg.goto(BASE + "/games/wordrush/", { waitUntil: "networkidle2" });
  await pg.waitForSelector("#scr-join:not([hidden])", { timeout: 5000 });
  await pg.type("#name-input", name);
  await pg.evaluate((i) => document.querySelectorAll("#avatar-grid .avatar-cell")[i].click(), avIdx);
  await pg.click("#join-btn");
  await pg.waitForSelector("#scr-lobby:not([hidden])", { timeout: 5000 });
  return pg;
}

try {
  const tv = await (await newCtx()).newPage();
  await tv.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  tv.on("pageerror", (e) => errors.push(`TV pageerror: ${e.message}`));
  await tv.goto(BASE + "/games/wordrush/tv.html", { waitUntil: "networkidle2" });
  await tv.waitForSelector(".tv-stage", { timeout: 5000 });
  if (!(await tv.$eval("#tv-qr", (e) => e.querySelector("svg,canvas,img") != null).catch(() => false)))
    fail("TV join QR did not render");

  const p1 = await phone("Ava", 0);
  const p2 = await phone("Ben", 5);
  await sleep(500);
  const feedbackUI = await p1.evaluate(() => {
    const mute = document.querySelector("#mute-btn");
    const box = mute.getBoundingClientRect();
    return { w: box.width, h: box.height, label: mute.getAttribute("aria-label"),
      live: document.querySelector("#game-status")?.getAttribute("aria-live") };
  });
  if (feedbackUI.w < 44 || feedbackUI.h < 44 || !feedbackUI.label)
    fail("mute control is not an accessible 44px touch target");
  if (feedbackUI.live !== "polite") fail("missing polite game status live region");
  await p1.click("#mute-btn");
  if (await p1.evaluate(() => localStorage.getItem("wc-muted")) !== "1")
    fail("shared mute preference was not persisted");
  await p1.click("#mute-btn"); // restore sound for the playtest

  await clickText(p1, "#opt-size button", "7");
  await clickText(p1, "#opt-rounds button", "2");
  await clickText(p1, "#opt-clock button", "60s");
  await sleep(400);
  await p1.click("#ready-btn"); await sleep(150);
  await p2.click("#ready-btn"); await sleep(300);
  await p1.waitForSelector("#go-btn:not([hidden])", { timeout: 4000 });
  await p1.click("#go-btn");
  await Promise.all([p1, p2].map((p) => p.waitForSelector("#scr-game:not([hidden])", { timeout: 9000 })));
  log("game on");
  await sleep(1000);

  // rack renders as tappable tiles
  const nTiles = await p1.$$eval("#wr-rack .wr-tile", (e) => e.length);
  if (nTiles !== 7) fail("rack did not render 7 tiles: " + nTiles);
  const rackA11y = await p1.evaluate(() => {
    const tiles = [...document.querySelectorAll(".wr-tile")];
    return { minW: Math.min(...tiles.map((el) => el.getBoundingClientRect().width)),
      minH: Math.min(...tiles.map((el) => el.getBoundingClientRect().height)),
      labelled: tiles.every((el) => el.hasAttribute("aria-label")),
      gameMute: document.querySelector("#mute-btn2").getBoundingClientRect().height };
  });
  if (rackA11y.minW < 44 || rackA11y.minH < 44 || !rackA11y.labelled)
    fail("rack accessibility/touch targets regressed: " + JSON.stringify(rackA11y));
  if (rackA11y.gameMute < 44) fail("in-game mute target is too small");

  // tap 3 tiles -> current word builds -> ENTER enables
  await p1.$$eval("#wr-rack .wr-tile:not(.used)", (els) => { els.slice(0, 3).forEach((e) => e.click()); });
  await sleep(200);
  const curLen = await p1.$eval("#wr-current", (e) => e.textContent.trim().length);
  if (curLen < 3) fail("tapping tiles didn't build a 3-letter word: got " + curLen);
  await p1.screenshot({ path: `${OUT}/70-wordrush-game.png` }); log("shot: controller game");
  await tv.screenshot({ path: `${OUT}/71-wordrush-tv.png` }); log("shot: TV rack");
  await p1.click("#wr-del"); await p1.click("#wr-del"); await p1.click("#wr-del");   // clear taps

  // submit a REAL word from the rack so a human scores
  const rack = await p1.evaluate(() => window.__st().game.rack.join(""));
  const word = COMMON.find((w) => canMake(w, rack));
  if (word) {
    await p1.evaluate((w) => window.__wrSubmit(w), word);
    await sleep(600);
    const found = await p1.evaluate(() => window.__st().game.my_words.length);
    if (found < 1) fail(`submitted '${word}' from rack '${rack}' but found list is empty`);
    const myTotal = await p1.evaluate(() => window.__st().game.my_total);
    if (myTotal < 1) fail("score did not increase after a valid word");
    log(`scored with "${word}" (rack ${rack})`);
  } else {
    log(`no common word formable from rack '${rack}' — relying on bots`);
  }

  // wait for the round reveal
  let sawReveal = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 80000) {
    if (await shown(p1, "#wr-reveal")) { sawReveal = true; break; }
    if (await shown(p1, "#gameover")) break;
    await sleep(1000);
  }
  if (sawReveal) {
    const rows = await p1.$$eval("#rv-rows .rv-row", (e) => e.length).catch(() => 0);
    if (rows < 1) fail("reveal showed no player rows");
    await p1.screenshot({ path: `${OUT}/72-wordrush-reveal.png` }); log("shot: reveal");
    await tv.screenshot({ path: `${OUT}/73-wordrush-tv-reveal.png` }); log("shot: TV reveal");
  } else fail("never saw the round reveal");

  // play out to game over
  let over = false;
  const t1 = Date.now();
  while (Date.now() - t1 < 120000) {
    over = await shown(p1, "#gameover");
    if (over) break;
    // keep scoring a little in round 2 if we can
    await sleep(1500);
  }
  if (!over) fail("game never reached game over");
  await sleep(500);
  await p1.screenshot({ path: `${OUT}/74-wordrush-gameover.png` }); log("shot: game over");
  const goTitle = await p1.$eval("#go-title", (e) => e.textContent).catch(() => "");
  if (!goTitle) fail("no game-over title");
  if (!(await shown(tv, "#tv-banner"))) fail("TV champion banner not shown");
  log("finished: " + goTitle);

  log(errors.length ? "CONSOLE ERRORS:\n" + errors.join("\n") : "zero console errors");
  if (errors.length) bad++;
  console.log(bad ? "WORD RUSH PLAYTEST FAIL" : "WORD RUSH PLAYTEST PASS");
} catch (e) {
  fail(e.message);
  console.log("WORD RUSH PLAYTEST FAIL");
} finally {
  await browser.close();
}
process.exit(bad ? 1 : 0);
