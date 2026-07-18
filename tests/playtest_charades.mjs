// playtest_charades.mjs — 3 browser players: full classic game (rotation to
// the final scoreboard) + a blitz chain, asserting subject masking, feed
// broadcast, near-miss privacy, and that the guess input NEVER loses focus.
// Usage: node tests/playtest_charades.mjs [baseURL] [shotdir]

import { createRequire } from "module";
import os from "os";
import fs from "fs";
const require = createRequire("/home/ubuntudesktop/projects/webdev-toolkit/x.js");
const puppeteer = require("puppeteer-core");

const BASE = process.argv[2] || "http://127.0.0.1:8096";
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
  userDataDir: os.homedir() + "/tmp/ghshot-profile",
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
  await page.goto(BASE + "/games/charades/", { waitUntil: "networkidle2" });
  await page.waitForSelector("#scr-join:not([hidden])", { timeout: 5000 });
  await page.type("#name-input", name);
  await page.evaluate((i) =>
    document.querySelectorAll("#avatar-grid .avatar-cell")[i].click(), avatarIdx);
  await page.click("#join-btn");
  await page.waitForSelector("#scr-lobby:not([hidden])", { timeout: 5000 });
  return page;
}

const actorPage = async (players) => {
  for (const p of players) {
    const acting = await p.evaluate(() =>
      !document.getElementById("actor-zone").hidden
      && document.getElementById("intro-overlay").hidden).catch(() => false);
    if (acting) return p;
  }
  return null;
};

async function guessOn(page, text) {
  await page.evaluate(() => document.getElementById("guess-input").focus());
  await page.type("#guess-input", text, { delay: 12 });
  await page.keyboard.press("Enter");
  await sleep(200);
}

async function waitStage(players, sel, t = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < t) {
    for (const p of players) {
      const on = await p.$eval(sel, (e) => !e.hidden).catch(() => false);
      if (on) return p;
    }
    await sleep(250);
  }
  return null;
}

try {
  step = "join";
  const ava = await mkPlayer("Ava", 0);
  const rex = await mkPlayer("Rex", 5);
  const kai = await mkPlayer("Kai", 9);
  const players = [ava, rex, kai];
  await sleep(400);

  step = "lobby";
  // pin settings (they persist in the room): classic, ANIMALS deck,
  // 30s turns, 1 rotation
  await ava.evaluate(() => {
    const segs = document.querySelectorAll("#opt-mode button");
    segs[0].click();     // CLASSIC
  });
  await sleep(150);
  await ava.evaluate(() => {
    const cards = [...document.querySelectorAll("#deck-grid .deck-card")];
    const animals = cards.find((c) => c.textContent.includes("ANIMALS"));
    animals.click();
  });
  await sleep(150);
  for (let i = 0; i < 8; i++) {
    await ava.evaluate(() => document.getElementById("turn-minus").click());
    await sleep(60);
  }
  for (let i = 0; i < 4; i++) {
    await ava.evaluate(() => document.getElementById("rounds-minus").click());
    await sleep(60);
  }
  await sleep(250);
  const tv = await rex.$eval("#turn-val", (e) => e.textContent);
  if (tv !== "30s") fail("turn seconds didn't sync: " + tv);
  const deckSel = await kai.$eval("#deck-grid .deck-card.sel .dc-title", (e) => e.textContent);
  if (deckSel !== "ANIMALS") fail("deck didn't sync: " + deckSel);
  await shot(ava, "40-charades-lobby");
  for (const p of players) {
    await p.evaluate(() => document.getElementById("ready-btn").click());
    await sleep(140);
  }
  await ava.waitForSelector("#go-btn:not([hidden])", { timeout: 6000 });
  await ava.evaluate(() => document.getElementById("go-btn").click());
  log("curtain up");

  // ---------- classic: 3 turns, each solved fast ----------
  step = "classic";
  let gameOver = false;
  for (let turn = 0; turn < 3 && !gameOver; turn++) {
    const actor = await (async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 25000) {
        const a = await actorPage(players);
        if (a) {
          const stage = await a.$eval("#az-subject", (e) => e.textContent).catch(() => "");
          if (stage && stage !== "SUBJECT") return a;
        }
        await sleep(250);
      }
      return null;
    })();
    if (!actor) { fail(`turn ${turn + 1}: no actor appeared`); break; }
    const subject = await actor.$eval("#az-subject", (e) => e.textContent);
    log(`turn ${turn + 1}: subject "${subject}"`);
    const guessers = [];
    for (const p of players) {
      if (p === actor) continue;
      guessers.push(p);
    }
    // masking: subject must not appear anywhere in a guesser's page
    const leak = await guessers[0].evaluate((s) =>
      document.body.innerText.toLowerCase().includes(s.toLowerCase()), subject);
    if (leak) fail("subject leaked to a guesser's screen: " + subject);

    if (turn === 0) {
      await shot(actor, "41-charades-actor");
      // wrong guess broadcast + actor skip + near-miss + focus checks
      await guessOn(guessers[0], "definitely wrong");
      await sleep(400);
      const seen = await guessers[1].evaluate(() =>
        document.getElementById("feed").innerText.includes("definitely wrong"));
      if (!seen) fail("wrong guess not broadcast to other guessers");
      const focused = await guessers[0].evaluate(() =>
        document.activeElement === document.getElementById("guess-input"));
      if (!focused) fail("guess input lost focus after submit");
      // near miss: last letter swapped
      const typo = subject.slice(0, -1) + (subject.endsWith("x") ? "y" : "x");
      await guessOn(guessers[0], typo);
      await sleep(350);
      const closeShown = await guessers[0].$eval("#close-pop", (e) => !e.hidden).catch(() => false);
      if (!closeShown) fail("near-miss pop not shown to the close guesser");
      const closeLeak = await guessers[1].$eval("#close-pop", (e) => !e.hidden).catch(() => false);
      if (closeLeak) fail("near-miss pop leaked to another guesser");
      await shot(guessers[0], "42-charades-guesser");
      // actor skips once
      await actor.click("#skip-btn");
      await sleep(400);
      const newSubject = await actor.$eval("#az-subject", (e) => e.textContent);
      if (newSubject === subject) fail("skip didn't change the subject");
      log(`skip ok -> "${newSubject}"`);
      await guessOn(guessers[0], newSubject);
    } else {
      await guessOn(guessers[0], subject);
    }
    const rev = await waitStage(players, "#reveal-overlay", 10000);
    if (!rev) { fail(`turn ${turn + 1}: reveal never appeared`); break; }
    if (turn === 0) await shot(guessers[0], "43-charades-reveal");
    // wait for reveal to clear into intro or game over
    const t0 = Date.now();
    while (Date.now() - t0 < 12000) {
      gameOver = await ava.$eval("#gameover", (e) => !e.hidden).catch(() => false);
      const revealGone = await ava.$eval("#reveal-overlay", (e) => e.hidden).catch(() => false);
      if (gameOver || revealGone) break;
      await sleep(300);
    }
  }
  if (!gameOver) {
    const end = await waitStage(players, "#gameover", 15000);
    if (!end) fail("game never reached final scores");
  }
  await sleep(500);
  await shot(ava, "44-charades-gameover");
  log("classic complete");

  // ---------- blitz: verify the chain ----------
  step = "blitz";
  await ava.evaluate(() => document.getElementById("rematch-btn").click());
  await Promise.all(players.map((p) =>
    p.waitForSelector("#scr-lobby:not([hidden])", { timeout: 10000 })));
  await ava.evaluate(() => document.querySelectorAll("#opt-mode button")[1].click());
  await sleep(200);
  for (const p of players) {
    await p.evaluate(() => document.getElementById("ready-btn").click());
    await sleep(140);
  }
  await ava.waitForSelector("#go-btn:not([hidden])", { timeout: 6000 });
  await ava.evaluate(() => document.getElementById("go-btn").click());
  const actor2 = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 25000) {
      const a = await actorPage(players);
      if (a) {
        const s = await a.$eval("#az-subject", (e) => e.textContent).catch(() => "");
        if (s && s !== "SUBJECT") return a;
      }
      await sleep(250);
    }
    return null;
  })();
  if (!actor2) fail("blitz: no actor");
  const g2 = players.find((p) => p !== actor2);
  for (let i = 0; i < 3; i++) {
    const subj = await actor2.$eval("#az-subject", (e) => e.textContent);
    await guessOn(g2, subj);
    await sleep(500);
    const still = await actor2.$eval("#actor-zone", (e) => !e.hidden).catch(() => false);
    if (!still) { fail("blitz ended after a solve — should chain"); break; }
    const next = await actor2.$eval("#az-subject", (e) => e.textContent);
    if (next === subj) fail("blitz: subject didn't advance after solve");
  }
  const chain = await g2.$eval("#sb-chain", (e) => e.textContent).catch(() => "");
  if (!chain.includes("3")) fail("blitz chain counter wrong: " + chain);
  await shot(actor2, "45-charades-blitz");
  log("blitz chain ok: " + chain);

  step = "done";
  log(errors.length ? "CONSOLE ERRORS:\n" + errors.join("\n") : "zero console errors");
  if (errors.length) process.exitCode = 1;
  console.log(process.exitCode ? "CHARADES PLAYTEST FAIL" : "CHARADES PLAYTEST PASS");
} catch (e) {
  fail(e.message);
  console.log("CHARADES PLAYTEST FAIL");
} finally {
  await browser.close();
}
