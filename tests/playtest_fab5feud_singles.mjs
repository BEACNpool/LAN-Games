// playtest_fab5feud_singles.mjs — 3 players in SINGLES (free-for-all) mode.
// Verifies the mode toggle hides the team picker, the standings strip renders,
// and an odd-count game plays to a finish.
// Usage: node tests/playtest_fab5feud_singles.mjs [baseURL] [shotdir]
import { createRequire } from "module";
import os from "os";
import fs from "fs";
const require = createRequire("/home/ubuntudesktop/projects/webdev-toolkit/x.js");
const puppeteer = require("puppeteer-core");

const BASE = process.argv[2] || "http://127.0.0.1:8096";
const OUT = process.argv[3] || os.homedir() + "/tmp/gamehub-shots";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const errors = [];
let bad = 0;
const fail = (m) => { console.error("FAIL: " + m); bad++; };

const browser = await puppeteer.launch({
  executablePath: "/snap/bin/chromium", headless: "new",
  userDataDir: os.homedir() + "/tmp/ghshot-feuds",
  args: ["--no-sandbox", "--disable-gpu"],
});
const newCtx = () => browser.createBrowserContext
  ? browser.createBrowserContext() : browser.createIncognitoBrowserContext();
const shown = (pg, sel) => pg.$eval(sel, (e) => !e.hidden).catch(() => false);

async function join(name, i) {
  const ctx = await newCtx();
  const pg = await ctx.newPage();
  await pg.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  pg.on("console", (m) => { if (m.type() === "error") errors.push(`${name}: ${m.text()}`); });
  pg.on("pageerror", (e) => errors.push(`${name} pageerror: ${e.message}`));
  await pg.goto(BASE + "/games/fab5feud/", { waitUntil: "networkidle2" });
  await pg.waitForSelector("#scr-join:not([hidden])", { timeout: 5000 });
  await pg.type("#name-input", name);
  await pg.evaluate((k) => document.querySelectorAll("#avatar-grid .avatar-cell")[k].click(), i);
  await pg.click("#join-btn");
  await pg.waitForSelector("#scr-lobby:not([hidden])", { timeout: 5000 });
  return pg;
}

let wrongN = 0;
const lastAt = new Map();          // page -> last-act timestamp (throttled retries)
async function act(pg) {
  const g = await pg.evaluate(() => {
    const st = window.__st && window.__st();
    if (!st || !st.game) return null;
    const x = st.game;
    return { stage: x.stage, im_rep: x.im_rep, my_side: x.my_side, done: x.faceoff_done,
             im_captain: x.im_captain, my_turn: x.my_turn, can_steal: x.can_steal };
  }).catch(() => null);
  if (!g) return null;
  const canAct = (g.stage === "choice" && g.im_captain)
    || (g.stage === "faceoff" && g.im_rep && !g.done[g.my_side])
    || (g.stage === "play" && g.my_turn)
    || (g.stage === "steal" && g.can_steal);
  if (!canAct) return null;
  // retry at most ~once/sec (a dropped WS send self-heals; stops when the
  // state advances and canAct goes false — well under the 20/2s rate limit)
  const now = Date.now();
  if (now - (lastAt.get(pg) || 0) < 1000) return null;
  lastAt.set(pg, now);
  if (g.stage === "choice") { await pg.click("#btn-play").catch(() => {}); return 1; }
  await pg.evaluate((w) => {
    document.getElementById("guess-input").value = w;
    document.getElementById("ctl-guess").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }, "zqx" + (++wrongN)).catch(() => {});
  return 1;
}

try {
  const p = [await join("Ava", 0), await join("Ben", 5), await join("Cy", 8)];
  await sleep(400);

  // switch to SINGLES via the mode toggle
  await p[0].evaluate(() => [...document.querySelectorAll("#opt-mode button")]
    .find((b) => b.textContent === "SINGLES").click());
  await sleep(400);
  if (await shown(p[0], "#sec-teams")) fail("team picker still shown in SINGLES");
  if (!(await shown(p[0], "#sec-singles"))) fail("singles note not shown");
  await p[0].screenshot({ path: `${OUT}/44-feud-singles-lobby.png` }); log("shot: singles lobby");

  for (const pg of p) { await pg.click("#ready-btn"); await sleep(120); }
  await sleep(250);
  await p[0].click("#go-btn");
  await Promise.all(p.map((pg) => pg.waitForSelector("#scr-game:not([hidden])", { timeout: 9000 })));
  await sleep(600);

  if (!(await shown(p[0], "#standings"))) fail("standings strip not shown in singles game");
  const nStand = await p[0].$$eval("#standings .st-chip", (e) => e.length).catch(() => 0);
  if (nStand !== 3) fail("expected 3 players in standings, saw " + nStand);
  await p[0].screenshot({ path: `${OUT}/45-feud-singles-game.png` }); log("shot: singles game");

  const t0 = Date.now();
  let over = false, actions = 0, lastStage = "";
  const names = ["Ava", "Ben", "Cy"];
  while (Date.now() - t0 < 150000) {
    over = await p[0].$eval("#gameover", (e) => !e.hidden).catch(() => false);
    if (over) break;
    const stage = await p[0].evaluate(() => {
      const st = window.__st && window.__st();
      return st ? (st.game ? st.game.stage : st.phase) : "?";
    }).catch(() => "?");
    if (stage !== lastStage) { log("stage → " + stage); lastStage = stage; }
    for (let k = 0; k < p.length; k++) {
      if (await act(p[k])) { actions++; log("  act by " + names[k]); await sleep(250); }
    }
    await sleep(300);
  }
  if (!over) fail("singles game never finished");
  if (actions < 6) fail("too few actions: " + actions);
  await sleep(400);
  await p[0].screenshot({ path: `${OUT}/46-feud-singles-over.png` }); log("shot: singles over");
  const goTitle = await p[0].$eval("#go-title", (e) => e.textContent).catch(() => "");
  log("finished: " + goTitle);
  if (!goTitle) fail("no game-over title");

  log(errors.length ? "CONSOLE ERRORS:\n" + errors.join("\n") : "zero console errors");
  if (errors.length) bad++;
  console.log(bad ? "FAB5 FEUD SINGLES PLAYTEST FAIL" : "FAB5 FEUD SINGLES PLAYTEST PASS");
} catch (e) {
  fail(e.message);
  console.log("FAB5 FEUD SINGLES PLAYTEST FAIL");
} finally {
  await browser.close();
}
process.exit(bad ? 1 : 0);
