// playtest.mjs — drives 3 real browser players + a TV page through full games
// against a live server, asserting sync/masking and capturing screenshots.
// Usage: node tests/playtest.mjs [serverURL] [shotdir]
// Requires: server running (default http://127.0.0.1:8096/games/wordclash), snap chromium.
// NEVER pkill chromium — this closes only its own instance.

import { createRequire } from "module";
import os from "os";
import fs from "fs";
const require = createRequire("/home/ubuntudesktop/projects/webdev-toolkit/x.js");
const puppeteer = require("puppeteer-core");

const BASE = process.argv[2] || "http://127.0.0.1:8096/games/wordclash";
const OUT = process.argv[3] || os.homedir() + "/tmp/wordclash-shots";
fs.mkdirSync(OUT, { recursive: true });

const PHONE = { width: +(process.env.SHOT_W || 390), height: +(process.env.SHOT_H || 844), deviceScaleFactor: 2 };
const TVVP = { width: 1280, height: 800 };
const WORDS = ["slate", "crony", "bumph", "vexed", "gizmo", "jawed"];
const errors = [];
let step = "boot";
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

function fail(msg) {
  console.error("FAIL @ " + step + ": " + msg);
  process.exitCode = 1;
}

const browser = await puppeteer.launch({
  executablePath: "/snap/bin/chromium",
  headless: "new",
  userDataDir: os.homedir() + "/tmp/wcshot-profile",
  args: ["--no-sandbox", "--disable-gpu"],
});

async function newCtx() {
  if (browser.createBrowserContext) return browser.createBrowserContext();
  return browser.createIncognitoBrowserContext();
}

async function mkPlayer(name, avatarIdx) {
  const ctx = await newCtx();
  const page = await ctx.newPage();
  await page.setViewport(PHONE);
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`${name}: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`${name} pageerror: ${e.message}`));
  await page.goto(BASE + "/", { waitUntil: "networkidle2" });
  await page.waitForSelector("#screen-join:not([hidden])", { timeout: 5000 });
  await page.type("#name-input", name);
  await page.evaluate((i) => {
    document.querySelectorAll("#avatar-grid .avatar-cell")[i].click();
  }, avatarIdx);
  await page.click("#join-btn");
  await page.waitForSelector("#screen-lobby:not([hidden])", { timeout: 5000 });
  return page;
}

const vis = (sel) => (el) => el && !el.hidden;
async function waitVis(page, sel, t = 8000) {
  await page.waitForSelector(`${sel}:not([hidden])`, { timeout: t });
}
async function shot(page, nm) {
  await page.screenshot({ path: `${OUT}/${nm}.png` });
  log(`shot: ${nm}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readyAll(pages) {
  for (const p of pages) {
    const isReady = await p.$eval("#ready-btn", (b) => b.classList.contains("is-ready"));
    if (!isReady) await p.click("#ready-btn");
    await sleep(120);
  }
}

async function typeGuess(page, word) {
  await page.keyboard.type(word, { delay: 25 });
  await page.keyboard.press("Enter");
  await sleep(220);
}

async function phaseOf(page) {
  return page.evaluate(() => {
    for (const id of ["screen-join", "screen-lobby", "screen-game",
                      "screen-roundend", "screen-podium"]) {
      if (!document.getElementById(id).hidden) return id;
    }
    return "?";
  });
}

try {
  // ---------- join ----------
  step = "join";
  const ava = await mkPlayer("Ava", 0);
  await shotJoin();
  async function shotJoin() {
    // grab a pristine join screen from a throwaway context
    const ctx = await newCtx();
    const p = await ctx.newPage();
    await p.setViewport(PHONE);
    await p.goto(BASE + "/", { waitUntil: "networkidle2" });
    await waitVis(p, "#screen-join");
    await shot(p, "01-join");
    await ctx.close();
  }
  const rex = await mkPlayer("Rex", 5);
  const kai = await mkPlayer("Kai", 9);
  const players = [ava, rex, kai];

  // TV
  const tvCtx = await newCtx();
  const tv = await tvCtx.newPage();
  await tv.setViewport(TVVP);
  tv.on("console", (m) => { if (m.type() === "error") errors.push("TV: " + m.text()); });
  tv.on("pageerror", (e) => errors.push("TV pageerror: " + e.message));
  await tv.goto(BASE + "/tv", { waitUntil: "networkidle2" });
  await waitVis(tv, "#tv-lobby");

  // ---------- lobby ----------
  step = "lobby";
  await sleep(400);
  const names = await ava.$$eval("#player-grid .pc-name", (es) => es.map((e) => e.textContent));
  if (names.length < 3) fail(`expected 3 players in lobby, saw ${names.length}: ${names}`);
  // settings persist in the room across runs — pin mode=duel, rounds=1
  await ava.evaluate(() => document.querySelectorAll("#mode-cards .mode-card")[0].click());
  await sleep(150);
  await ava.click("#rounds-minus"); await ava.click("#rounds-minus");
  await sleep(200);
  const rv = await rex.$eval("#rounds-val", (e) => e.textContent);
  if (rv !== "1") fail(`settings didn't sync: rounds=${rv} on Rex's phone`);
  await readyAll(players);
  await sleep(300);
  await shot(ava, "02-lobby-ready");
  await shot(tv, "03-tv-lobby");

  const goHidden = await ava.$eval("#go-btn", (b) => b.hidden);
  if (goHidden) fail("GO button not shown with 3 ready players");

  // ---------- duel ----------
  step = "duel";
  await ava.click("#go-btn");
  await waitVis(ava, "#screen-game", 8000);
  await Promise.all(players.map((p) => waitVis(p, "#screen-game", 8000)));
  log("duel started");
  await typeGuess(ava, WORDS[0]);
  await typeGuess(rex, WORDS[1]);
  await sleep(700);
  // masking: Rex's view of Ava's board must carry no letters
  const oppLetters = await rex.evaluate(() =>
    Array.from(document.querySelectorAll("#opp-strip .opp-card")).map((c) => c.innerText).join(" "));
  for (const w of [WORDS[0].toUpperCase(), WORDS[0]]) {
    if (oppLetters.includes(w)) fail("duel masking leak: opponent letters visible: " + oppLetters);
  }
  await shot(ava, "04-duel-board");
  await shot(tv, "05-tv-duel");
  // finish boards
  for (let i = 1; i < 6; i++) await typeGuess(ava, WORDS[i]);
  for (let i = 2; i < 6; i++) { await typeGuess(rex, WORDS[i]); }
  await typeGuess(rex, WORDS[0]);
  for (let i = 0; i < 6; i++) await typeGuess(kai, WORDS[5 - i] || WORDS[i]);
  await sleep(500);

  step = "roundend";
  await waitVis(ava, "#screen-roundend", 15000);
  await sleep(900);
  await shot(ava, "06-roundend");
  await shot(tv, "07-tv-roundend");

  step = "podium";
  await waitVis(ava, "#screen-podium", 15000);
  await sleep(900);
  await shot(ava, "08-podium");
  await shot(tv, "09-tv-podium");
  // brag card renders from the podium
  await ava.evaluate(() => document.querySelector(".brag-btn-go")?.click());
  await sleep(1200);
  const bragOk = await ava.evaluate(() => {
    const img = document.getElementById("brag-img");
    return img && img.naturalWidth === 1080;
  });
  if (!bragOk) fail("wordclash brag card didn't render");
  await shot(ava, "10-wc-brag");
  await ava.evaluate(() => document.getElementById("brag-close").click());
  await sleep(200);

  // ---------- rematch -> sabotage ----------
  step = "rematch";
  await ava.click("#rematch-btn");
  await Promise.all(players.map((p) => waitVis(p, "#screen-lobby", 8000)));
  await sleep(300);
  // pick sabotage mode (3rd card)
  await ava.evaluate(() => document.querySelectorAll("#mode-cards .mode-card")[2].click());
  await sleep(250);
  const modeSel = await rex.$eval("#mode-cards .mode-card.sel .mc-name", (e) => e.textContent);
  if (modeSel !== "SABOTAGE") fail("mode didn't sync: " + modeSel);
  await readyAll(players);
  await sleep(250);
  await ava.click("#go-btn");
  await Promise.all(players.map((p) => waitVis(p, "#screen-game", 9000)));
  log("sabotage started");

  step = "sabotage";
  async function currentPlayer() {
    for (const p of players) {
      const mine = await p.$eval("#turn-banner", (b) => b.classList.contains("my-turn"));
      if (mine) return p;
    }
    return null;
  }
  await sleep(600);
  let cur = await currentPlayer();
  if (!cur) fail("nobody has the turn in relay");
  // out-of-turn typing must be locked client-side
  const notCur = players.find((p) => p !== cur);
  const lockedBefore = await notCur.$eval("#keyboard", (k) => k.classList.contains("locked"));
  if (!lockedBefore) fail("keyboard not locked for out-of-turn player");
  // turn 1: guess
  await typeGuess(cur, "slate");
  await sleep(500);
  // turn 2: sabotage — open BAN modal, screenshot, cancel, then CUT time
  cur = await currentPlayer();
  if (cur) {
    await cur.evaluate(() => document.querySelector('[data-sab="ban"]').click());
    await waitVis(cur, "#letter-modal", 4000);
    await shot(cur, "10-sabotage-modal");
    await cur.click("#letter-cancel");
    await cur.evaluate(() => document.querySelector('[data-sab="time"]').click());
    await sleep(600);
    const pendingShown = await Promise.any(players.map((p) =>
      p.$eval("#pending-note", (n) => !n.hidden).then((v) => v ? true : Promise.reject())
    )).catch(() => false);
    if (!pendingShown) fail("pending sabotage note not visible anywhere");
    await shot((await currentPlayer()) || cur, "11-sabotage-target");
  }
  await shot(tv, "12-tv-relay");
  // play out the board (rows_max=8 for 3 players); guesses may solve early
  step = "relay-finish";
  for (let i = 0; i < 10; i++) {
    const ph = await phaseOf(ava);
    if (ph !== "screen-game") break;
    const c = await currentPlayer();
    if (c) await typeGuess(c, WORDS[i % WORDS.length]);
    else await sleep(800);
  }
  // if still going (invalid repeats etc.), let timers run it out — but cap the wait
  for (let i = 0; i < 40; i++) {
    const ph = await phaseOf(ava);
    if (ph !== "screen-game") break;
    await sleep(1000);
  }
  const finalPhase = await phaseOf(ava);
  log("after relay: " + finalPhase);
  if (finalPhase === "screen-game") fail("relay round never ended");

  step = "done";
  log(errors.length ? "CONSOLE ERRORS:\n" + errors.join("\n") : "zero console errors");
  if (errors.length) process.exitCode = 1;
  console.log(process.exitCode ? "PLAYTEST FAIL" : "PLAYTEST PASS");
} catch (e) {
  fail(e.message);
  console.log("PLAYTEST FAIL");
} finally {
  await browser.close();
}
