// snake_controls_test.mjs — the per-device steering toggle:
//   * relTurn maps a heading + left/right to the correct absolute direction
//   * the lobby STEERING seg switches scheme, persists it, and shows/hides
//     the d-pad (only the D-PAD scheme renders it)
// Usage: node tests/snake_controls_test.mjs [baseURL]
import { createRequire } from "module";
import os from "os";
const require = createRequire("/home/ubuntudesktop/projects/webdev-toolkit/x.js");
const puppeteer = require("puppeteer-core");

const BASE = process.argv[2] || "http://127.0.0.1:8096";
let bad = 0;
const check = (ok, msg) => { console.log((ok ? "PASS " : "FAIL ") + msg); if (!ok) bad++; };

const browser = await puppeteer.launch({
  executablePath: "/snap/bin/chromium", headless: "new",
  userDataDir: os.homedir() + "/tmp/ghshot-snakectrl",
  args: ["--no-sandbox", "--disable-gpu"],
});
try {
  const pg = await browser.newPage();
  const errors = [];
  pg.on("pageerror", (e) => errors.push(e.message));
  await pg.goto(BASE + "/games/snake/", { waitUntil: "networkidle2" });
  await pg.waitForFunction(() => window.__snake && window.__snake.relTurn, { timeout: 5000 });

  // relative-turn math: headings as [dx,dy], up=(0,-1) down=(0,1) left=(-1,0) right=(1,0)
  const U = [0, -1], D = [0, 1], L = [-1, 0], R = [1, 0];
  const rel = (dir, side) => pg.evaluate((d, s) => window.__snake.relTurn(d, s), dir, side);
  // clockwise (tap right): up->right->down->left->up
  check(await rel(U, "right") === "right", "right-turn from up → right");
  check(await rel(R, "right") === "down", "right-turn from right → down");
  check(await rel(D, "right") === "left", "right-turn from down → left");
  check(await rel(L, "right") === "up", "right-turn from left → up");
  // counter-clockwise (tap left): up->left->down->right->up
  check(await rel(U, "left") === "left", "left-turn from up → left");
  check(await rel(L, "left") === "down", "left-turn from left → down");
  check(await rel(D, "left") === "right", "left-turn from down → right");
  check(await rel(R, "left") === "up", "left-turn from right → up");

  // the lobby STEERING seg exists with all three schemes
  const labels = await pg.$$eval("#opt-steer button", (bs) => bs.map((b) => b.dataset.v));
  check(JSON.stringify(labels) === JSON.stringify(["swipe", "tap", "pad"]),
    "STEERING seg has swipe/tap/pad → " + labels.join(","));

  // switching scheme: attribute + localStorage + d-pad visibility + highlight
  await pg.evaluate(() => { document.getElementById("scr-game").hidden = false; });
  for (const [mode, wantDpad] of [["pad", "grid"], ["tap", "none"], ["swipe", "none"]]) {
    await pg.evaluate((m) =>
      document.querySelector(`#opt-steer button[data-v="${m}"]`).click(), mode);
    const r = await pg.evaluate(() => ({
      attr: document.getElementById("scr-game").dataset.ctrl,
      ls: localStorage.getItem("snake-ctrl"),
      dpad: getComputedStyle(document.getElementById("dpad")).display,
      sel: document.querySelector("#opt-steer button.sel")?.dataset.v,
      nSel: document.querySelectorAll("#opt-steer button.sel").length,
      icon: document.getElementById("ctrl-btn").textContent,
    }));
    check(r.attr === mode && r.ls === mode, `${mode}: data-ctrl + persisted`);
    check(r.dpad === wantDpad, `${mode}: d-pad display = ${r.dpad}`);
    check(r.nSel === 1 && r.sel === mode, `${mode}: exactly its seg button highlighted`);
  }

  // preference survives a reload (localStorage), and the header cycle button works
  await pg.evaluate(() =>
    document.querySelector('#opt-steer button[data-v="tap"]').click());
  await pg.reload({ waitUntil: "networkidle2" });
  await pg.waitForFunction(() => window.__snake, { timeout: 5000 });
  const persisted = await pg.evaluate(() => document.getElementById("scr-game").dataset.ctrl);
  check(persisted === "tap", "scheme persists across reload → " + persisted);
  await pg.evaluate(() => document.getElementById("ctrl-btn").click());  // tap -> pad
  const cycled = await pg.evaluate(() => document.getElementById("scr-game").dataset.ctrl);
  check(cycled === "pad", "header ↔ button cycles the scheme → " + cycled);

  check(errors.length === 0, "zero page errors" + (errors.length ? ": " + errors.join(";") : ""));
} finally {
  await browser.close();
}
console.log(bad ? "SNAKE CONTROLS TEST FAIL" : "SNAKE CONTROLS TEST PASS");
process.exit(bad ? 1 : 0);
