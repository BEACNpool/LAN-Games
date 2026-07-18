// playtest_trivia.mjs — two browser players. Full RACE match (4-question dev
// short) with one player answering right and one wrong via the dev server's
// /debug/answer peek, through reveal beats to the podium + brag card. Then a
// BUZZER match exercising buzz -> lockout -> steal for 2+ questions.
// Usage: node tests/playtest_trivia.mjs [baseURL] [shotdir]

import { createRequire } from "module";
import os from "os";
import fs from "fs";
const require = createRequire("/home/ubuntudesktop/projects/webdev-toolkit/x.js");
const puppeteer = require("puppeteer-core");

const BASE = process.argv[2] || "http://127.0.0.1:8124";
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
  userDataDir: os.homedir() + "/tmp/ghshot-trivia",
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
  await page.goto(BASE + "/games/trivia/", { waitUntil: "networkidle2" });
  await page.waitForSelector("#scr-join:not([hidden])", { timeout: 5000 });
  await page.type("#name-input", name);
  await page.evaluate((i) =>
    document.querySelectorAll("#avatar-grid .avatar-cell")[i].click(), avatarIdx);
  await page.click("#join-btn");
  await page.waitForSelector("#scr-lobby:not([hidden])", { timeout: 5000 });
  return page;
}

const answerPeek = async () => (await (await fetch(BASE + "/debug/answer")).json());

async function waitQuestion(page, qno, t = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < t) {
    const on = await page.evaluate((q) => {
      const chip = document.getElementById("tv-qchip");
      return !document.getElementById("scr-game").hidden
        && chip.textContent.startsWith(`Q${q}/`)
        && document.querySelectorAll("#choices .choice").length === 4
        && document.getElementById("reveal-strip").hidden;
    }, qno).catch(() => false);
    if (on) return true;
    await sleep(200);
  }
  return false;
}

const clickChoice = (page, i) =>
  page.evaluate((j) =>
    document.querySelector(`#choices .choice[data-i="${j}"]`).click(), i);

const buzz = (page) => page.evaluate(() => {
  document.getElementById("buzz-btn")
    .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
});

async function readyAndGo(pages) {
  for (const p of pages) {
    await p.evaluate(() => document.getElementById("ready-btn").click());
    await sleep(150);
  }
  await pages[0].waitForSelector("#go-btn:not([hidden])", { timeout: 6000 });
  await pages[0].evaluate(() => document.getElementById("go-btn").click());
}

try {
  step = "join";
  const ava = await mkPlayer("Ava", 0);
  const rex = await mkPlayer("Rex", 5);
  const players = [ava, rex];
  await sleep(400);

  step = "lobby";
  // RACE mode + the hidden 4-question dev short (settings sync to the room)
  await ava.evaluate(() => {
    document.querySelectorAll("#opt-mode button")[1].click();   // RACE
  });
  await sleep(200);
  await ava.evaluate(() => window.TRIVIA_DEV.send({ t: "settings", patch: { rounds: 4 } }));
  await sleep(300);
  const modeOnRex = await rex.$eval("#opt-mode button.sel", (e) => e.textContent);
  if (!modeOnRex.includes("RACE")) fail("mode didn't sync: " + modeOnRex);
  const catCards = await ava.$$eval("#cat-grid .cat-card", (es) => es.length);
  if (catCards !== 11) fail("expected 11 category cards, saw " + catCards);
  await shot(ava, "80-trivia-lobby");
  await readyAndGo(players);
  log("race match started");

  // ---------- RACE: 4 questions, Ava right / Rex wrong ----------
  step = "race";
  for (let q = 1; q <= 4; q++) {
    if (!(await waitQuestion(ava, q))) { fail(`race q${q} never appeared`); break; }
    await waitQuestion(rex, q);
    const peek = await answerPeek();
    if (peek.correct === null) { fail(`no live question at q${q}`); break; }
    if (q === 1) await shot(ava, "81-trivia-race-question");
    await clickChoice(ava, peek.correct);
    await sleep(250);
    await clickChoice(rex, (peek.correct + 1) % 4);
    // both answered -> early reveal
    const revealed = await ava.waitForSelector("#reveal-strip:not([hidden])",
      { timeout: 8000 }).then(() => true).catch(() => false);
    if (!revealed) { fail(`race q${q}: reveal never showed`); break; }
    const goodHi = await ava.evaluate((c) => {
      const el = document.querySelector(`#choices .choice[data-i="${c}"]`);
      return el && el.classList.contains("correct");
    }, peek.correct);
    if (!goodHi) fail(`race q${q}: correct answer not highlighted`);
    const rexWrong = await rex.evaluate((c) => {
      const el = document.querySelector(`#choices .choice[data-i="${(c + 1) % 4}"]`);
      return el && el.classList.contains("wrong-pick");
    }, peek.correct);
    if (!rexWrong) fail(`race q${q}: Rex's wrong pick not marked`);
    if (q === 1) await shot(rex, "82-trivia-race-reveal");
    log(`race q${q} revealed ok`);
  }

  step = "podium";
  const over = await ava.waitForSelector("#gameover:not([hidden])", { timeout: 15000 })
    .then(() => true).catch(() => false);
  if (!over) fail("race match never reached the podium");
  const title = await ava.$eval("#go-title", (e) => e.textContent);
  if (!title.includes("AVA")) fail("Ava should have won the race match: " + title);
  const pods = await ava.$$eval("#podium .pod", (es) => es.length);
  if (pods !== 2) fail("expected 2 podium spots for 2 players, saw " + pods);
  await shot(ava, "83-trivia-podium");

  step = "brag";
  const hasBrag = await ava.evaluate(() => {
    const b = document.querySelector(".brag-btn-go");
    if (!b) return false;
    b.click();
    return true;
  });
  if (!hasBrag) fail("no brag button on trivia gameover");
  await sleep(1400);
  const bragOk = await ava.evaluate(() => {
    const img = document.getElementById("brag-img");
    return img && img.naturalWidth === 1080;
  });
  if (!bragOk) fail("trivia brag card didn't render");
  await shot(ava, "84-trivia-brag");
  await ava.evaluate(() => document.getElementById("brag-close").click());

  // ---------- BUZZER: buzz, lockout, steal ----------
  step = "buzzer-lobby";
  await ava.evaluate(() => document.getElementById("rematch-btn").click());
  await Promise.all(players.map((p) =>
    p.waitForSelector("#scr-lobby:not([hidden])", { timeout: 10000 })));
  await ava.evaluate(() => {
    document.querySelectorAll("#opt-mode button")[0].click();   // BUZZER
  });
  await sleep(200);
  await ava.evaluate(() => window.TRIVIA_DEV.send({ t: "settings", patch: { rounds: 4 } }));
  await sleep(250);
  await readyAndGo(players);
  log("buzzer match started");

  step = "buzzer";
  // q1: Rex buzzes first, answers wrong (lockout), Ava steals it
  if (!(await waitQuestion(rex, 1))) fail("buzzer q1 never appeared");
  await waitQuestion(ava, 1);
  let peek = await answerPeek();
  await buzz(rex);
  await sleep(400);
  const avaSees = await ava.$eval("#rb-title", (e) => e.textContent).catch(() => "");
  if (!avaSees.includes("REX")) fail("Ava should see REX BUZZED FIRST, saw: " + avaSees);
  const avaBuzzDead = await ava.$eval("#buzz-btn", (e) => e.disabled);
  if (!avaBuzzDead) fail("Ava's buzzer should be dead while Rex answers");
  await shot(ava, "85-trivia-buzzer-lockout");
  await clickChoice(rex, (peek.correct + 1) % 4);                // wrong
  await sleep(500);
  const rexLocked = await rex.$eval("#buzz-btn", (e) => e.disabled);
  if (!rexLocked) fail("Rex should be locked out after a wrong answer");
  const avaSteal = await ava.$eval("#rb-title", (e) => e.textContent).catch(() => "");
  if (!avaSteal.includes("STEAL")) fail("Ava should see the steal banner, saw: " + avaSteal);
  await buzz(ava);
  await sleep(350);
  await shot(ava, "86-trivia-buzzer-steal");
  await clickChoice(ava, peek.correct);                          // the steal
  const r1 = await ava.waitForSelector("#reveal-strip:not([hidden])", { timeout: 8000 })
    .then(() => true).catch(() => false);
  if (!r1) fail("buzzer q1: no reveal after the steal");
  log("buzzer q1: lockout + steal ok");

  // q2: Ava buzzes and answers correctly straight away
  if (!(await waitQuestion(ava, 2))) fail("buzzer q2 never appeared");
  peek = await answerPeek();
  await buzz(ava);
  await sleep(350);
  const youBuzzed = await ava.$eval("#rb-title", (e) => e.textContent).catch(() => "");
  if (!youBuzzed.includes("YOU")) fail("Ava should see YOU BUZZED FIRST: " + youBuzzed);
  await clickChoice(ava, peek.correct);
  const r2 = await ava.waitForSelector("#reveal-strip:not([hidden])", { timeout: 8000 })
    .then(() => true).catch(() => false);
  if (!r2) fail("buzzer q2: no reveal after correct answer");
  log("buzzer q2: instant buzz-and-take ok");

  // q3+q4: play out fast so the match ends (Rex takes them)
  for (let q = 3; q <= 4; q++) {
    if (!(await waitQuestion(rex, q))) { fail(`buzzer q${q} never appeared`); break; }
    peek = await answerPeek();
    await buzz(rex);
    await sleep(300);
    await clickChoice(rex, peek.correct);
    await rex.waitForSelector("#reveal-strip:not([hidden])", { timeout: 8000 })
      .catch(() => fail(`buzzer q${q}: no reveal`));
  }
  const over2 = await ava.waitForSelector("#gameover:not([hidden])", { timeout: 15000 })
    .then(() => true).catch(() => false);
  if (!over2) fail("buzzer match never ended");
  await shot(ava, "87-trivia-buzzer-podium");

  step = "done";
  log(errors.length ? "CONSOLE ERRORS:\n" + errors.join("\n") : "zero console errors");
  if (errors.length) process.exitCode = 1;
  console.log(process.exitCode ? "TRIVIA PLAYTEST FAIL" : "TRIVIA PLAYTEST PASS");
} catch (e) {
  fail(e.message);
  console.log("TRIVIA PLAYTEST FAIL");
} finally {
  await browser.close();
}
