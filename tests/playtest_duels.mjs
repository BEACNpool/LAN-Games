// playtest_duels.mjs — board games E2E: chess (2 humans, tap-move, resign),
// checkers (tap-move), connect four (solo vs bot to a finished game).
// Usage: node tests/playtest_duels.mjs [baseURL] [shotdir]

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
async function mkPlayer(path, name, avatarIdx) {
  const ctx = await newCtx();
  const page = await ctx.newPage();
  await page.setViewport(PHONE);
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${name}: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`${name} pageerror: ${e.message}`));
  await page.goto(BASE + path, { waitUntil: "networkidle2" });
  await page.waitForSelector("#scr-join:not([hidden])", { timeout: 5000 });
  await page.type("#name-input", name);
  await page.evaluate((i) =>
    document.querySelectorAll("#avatar-grid .avatar-cell")[i].click(), avatarIdx);
  await page.click("#join-btn");
  await page.waitForSelector("#scr-lobby:not([hidden])", { timeout: 5000 });
  return { page, ctx };
}
const readyGo = async (pages, goPage) => {
  for (const p of pages) {
    await p.evaluate(() => document.getElementById("ready-btn").click());
    await sleep(150);
  }
  await goPage.waitForSelector("#go-btn:not([hidden])", { timeout: 6000 });
  await goPage.evaluate(() => document.getElementById("go-btn").click());
};
const seatOf = async (p, color) =>
  p.$eval("#seat-" + color, (e) => e.classList.contains("me")).catch(() => false);

try {
  // ================= CHESS (2 humans) =================
  step = "chess";
  const A = await mkPlayer("/games/chess/", "Ava", 0);
  const B = await mkPlayer("/games/chess/", "Rex", 5);
  await sleep(300);
  await readyGo([A.page, B.page], A.page);
  await Promise.all([A, B].map((x) =>
    x.page.waitForSelector("#scr-game:not([hidden])", { timeout: 9000 })));
  await sleep(700);
  const white = (await seatOf(A.page, "w")) ? A.page : B.page;
  const black = white === A.page ? B.page : A.page;
  // white: tap e2, expect a target dot on e4, tap e4
  await white.evaluate(() => document.querySelector('[data-sq="e2"]').click());
  await sleep(200);
  const dot = await white.evaluate(() =>
    !!document.querySelector('[data-sq="e4"] .dot'));
  if (!dot) fail("no legal-move dot on e4 after selecting e2");
  await shot(white, "50-chess-select");
  await white.evaluate(() => document.querySelector('[data-sq="e4"]').click());
  await sleep(500);
  const lastB = await black.evaluate(() =>
    document.querySelectorAll(".sq.last").length);
  if (lastB !== 2) fail("black doesn't see the last-move highlight");
  // black replies e7e5
  await black.evaluate(() => document.querySelector('[data-sq="e7"]').click());
  await sleep(150);
  await black.evaluate(() => document.querySelector('[data-sq="e5"]').click());
  await sleep(400);
  await shot(white, "51-chess-board");
  // resign path ends the game (confirm() auto-accepted)
  white.on("dialog", (d) => d.accept());
  await white.evaluate(() => document.getElementById("act-resign").click());
  await sleep(600);
  const over = await black.$eval("#gameover", (e) => !e.hidden).catch(() => false);
  if (!over) fail("resign didn't end the chess game");
  const title = await black.$eval("#go-title", (e) => e.textContent);
  if (!title.includes("REX") && !title.includes("AVA")) fail("odd winner title: " + title);
  await shot(black, "52-chess-gameover");
  log("chess ok — " + title);
  await A.ctx.close(); await B.ctx.close();

  // ================= CHECKERS (2 humans, one capture) =================
  step = "checkers";
  const C = await mkPlayer("/games/checkers/", "Ava", 0);
  const D = await mkPlayer("/games/checkers/", "Rex", 5);
  await sleep(300);
  await readyGo([C.page, D.page], C.page);
  await Promise.all([C, D].map((x) =>
    x.page.waitForSelector("#scr-game:not([hidden])", { timeout: 9000 })));
  await sleep(700);
  const wPage = (await seatOf(C.page, "w")) ? C.page : D.page;
  const bPage = wPage === C.page ? D.page : C.page;
  const turnPages = { w: wPage, b: bPage };
  // play four legal moves via the UI (select first movable disc, first dest)
  for (let i = 0; i < 4; i++) {
    const pg = turnPages[i % 2 === 0 ? "w" : "b"];
    const moved = await pg.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const squares = [...document.querySelectorAll("#board .sq")];
      for (const sq of squares) {
        if (!sq.querySelector(".disc")) continue;
        sq.click();
        await sleep(80);
        const dest = document.querySelector("#board .sq .hopmark");
        if (dest) { dest.parentElement.click(); return true; }
      }
      return false;
    });
    if (!moved) { fail(`checkers: player ${i % 2 ? "b" : "w"} found no move via UI`); break; }
    await sleep(450);
  }
  await shot(wPage, "53-checkers-board");
  log("checkers ok — 4 UI moves played");
  await C.ctx.close(); await D.ctx.close();

  // ================= CONNECT FOUR (solo vs bot) =================
  step = "connect4";
  const E = await mkPlayer("/games/connect4/", "Ava", 0);
  await sleep(300);
  await readyGo([E.page], E.page);
  await E.page.waitForSelector("#scr-game:not([hidden])", { timeout: 9000 });
  await sleep(500);
  let finished = false;
  for (let i = 0; i < 40 && !finished; i++) {
    finished = await E.page.$eval("#gameover", (e) => !e.hidden).catch(() => false);
    if (finished) break;
    const mine = await E.page.$eval("#turn-note", (e) =>
      e.textContent.startsWith("YOUR MOVE")).catch(() => false);
    if (mine) {
      await E.page.evaluate(() => {
        const cols = [...document.querySelectorAll("#board .c4-col")];
        const legal = cols.filter((c) => c.classList.contains("legal"));
        const pick = legal.find((c, idx) => cols.indexOf(c) === 3) || legal[0];
        pick.click();
      });
      await sleep(250);
      if (i === 2) await shot(E.page, "54-c4-board");
    }
    await sleep(600);
  }
  if (!finished) fail("connect4 vs bot never finished");
  await shot(E.page, "55-c4-gameover");
  // brag card: open, image must actually render, LAN Games on the canvas
  const hasWinner = await E.page.evaluate(() => {
    const btn = document.querySelector(".brag-btn-go");
    return btn && !btn.hidden;
  });
  if (hasWinner) {
    await E.page.evaluate(() => document.querySelector(".brag-btn-go").click());
    await sleep(1200);
    const bragOk = await E.page.evaluate(() => {
      const img = document.getElementById("brag-img");
      return img && img.naturalWidth === 1080 && img.naturalHeight === 1080;
    });
    if (!bragOk) fail("brag card image didn't render at 1080x1080");
    await shot(E.page, "58-brag-card");
    log("brag card ok");
  } else log("c4 ended in a draw — no brag to test this run");
  log("connect4 ok — game vs bot completed");
  await E.ctx.close();

  // ================= BACKGAMMON (solo vs bot, UI taps, then resign) =====
  step = "backgammon";
  const F = await mkPlayer("/games/backgammon/", "Ava", 0);
  await sleep(300);
  await readyGo([F.page], F.page);
  await F.page.waitForSelector("#scr-game:not([hidden])", { timeout: 9000 });
  await sleep(800);
  let uiMoves = 0;
  for (let i = 0; i < 60 && uiMoves < 4; i++) {
    const over = await F.page.$eval("#gameover", (e) => !e.hidden).catch(() => false);
    if (over) break;
    const mine = await F.page.$eval("#turn-note", (e) =>
      e.textContent.startsWith("YOUR MOVE")).catch(() => false);
    if (mine) {
      const acted = await F.page.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let k = 0; k < 8; k++) {
          const src = document.querySelector(".bg-point.src, .bg-bar.src");
          if (!src) return k > 0;
          src.click();
          await sleep(120);
          const dst = document.querySelector(".bg-point.dst, .bg-off.hot");
          if (dst) { dst.click(); await sleep(120); }
        }
        return true;
      });
      if (acted) { uiMoves++; await sleep(600); }
    }
    await sleep(500);
  }
  if (uiMoves < 2) fail(`backgammon: only ${uiMoves} UI turns played`);
  await shot(F.page, "56-backgammon-board");
  F.page.on("dialog", (d) => d.accept());
  await F.page.evaluate(() => document.getElementById("act-resign").click());
  await sleep(700);
  const bgOver = await F.page.$eval("#gameover", (e) => !e.hidden).catch(() => false);
  if (!bgOver) fail("backgammon resign didn't end the game");
  await shot(F.page, "57-backgammon-gameover");
  log(`backgammon ok — ${uiMoves} UI turns + resign`);
  await F.ctx.close();

  step = "done";
  log(errors.length ? "CONSOLE ERRORS:\n" + errors.join("\n") : "zero console errors");
  if (errors.length) process.exitCode = 1;
  console.log(process.exitCode ? "DUELS PLAYTEST FAIL" : "DUELS PLAYTEST PASS");
} catch (e) {
  fail(e.message);
  console.log("DUELS PLAYTEST FAIL");
} finally {
  await browser.close();
}
