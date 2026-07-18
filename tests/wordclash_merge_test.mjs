// wordclash_merge_test.mjs — proves WORDCLASH now runs INSIDE gamehub (same
// origin), so a profile set on the LAN Games hub carries straight into it:
// name + character + PHOTO all appear, with no re-entry. Also confirms the
// hub card links to the merged path.
// Usage: node tests/wordclash_merge_test.mjs [hubBase]
import { createRequire } from "module";
import os from "os";
const require = createRequire("/home/ubuntudesktop/projects/webdev-toolkit/x.js");
const puppeteer = require("puppeteer-core");

const BASE = process.argv[2] || "http://127.0.0.1:8096";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const check = (ok, m) => { console.log((ok ? "PASS " : "FAIL ") + m); if (!ok) bad++; };

const browser = await puppeteer.launch({
  executablePath: "/snap/bin/chromium", headless: "new",
  userDataDir: os.homedir() + "/tmp/ghshot-wcmerge",
  args: ["--no-sandbox", "--disable-gpu"],
});
try {
  const pg = await browser.newPage();
  const errors = [];
  pg.on("pageerror", (e) => errors.push(e.message));
  await pg.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });

  // 1) set up a full profile (name + character + photo) on the hub
  await pg.goto(BASE + "/", { waitUntil: "networkidle2" });
  await pg.evaluate(() => localStorage.clear());
  await pg.reload({ waitUntil: "networkidle2" });
  await sleep(300);
  // the hub card for wordclash links to the merged same-origin path
  const wcHref = await pg.evaluate(() => {
    const a = [...document.querySelectorAll("a.tile")].find(
      (e) => e.querySelector(".tile-title")?.textContent === "WORDCLASH");
    return a ? a.getAttribute("href") : null;
  });
  check(wcHref === "/games/wordclash/", `hub card links to merged path → ${wcHref}`);

  await pg.click("#profile-chip");
  await pg.waitForSelector("#profile-sheet:not([hidden])", { timeout: 3000 });
  await pg.type("#pf-name", "Wanda");
  await pg.evaluate(() => document.querySelectorAll("#pf-grid .avatar-cell")[6].click());
  await pg.click("#pf-photo");
  await pg.evaluate(async () => {
    const c = document.createElement("canvas"); c.width = c.height = 300;
    const cx = c.getContext("2d");
    cx.fillStyle = "#7c3aed"; cx.fillRect(0, 0, 300, 300);
    cx.fillStyle = "#fbbf24"; cx.beginPath(); cx.arc(150, 140, 90, 0, 7); cx.fill();
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    const input = document.querySelector('input[type="file"]');
    const dt = new DataTransfer(); dt.items.add(new File([blob], "w.png", { type: "image/png" }));
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await pg.waitForSelector(".crop-ov .crop-ok", { timeout: 3000 });
  await pg.click(".crop-ov .crop-ok");
  await sleep(1400);
  await pg.click("#pf-save");
  await sleep(300);

  // 2) go to WORDCLASH (now same origin) — it should auto-join with that identity
  await pg.goto(BASE + "/games/wordclash/", { waitUntil: "networkidle2" });
  await pg.waitForSelector("#screen-lobby:not([hidden])", { timeout: 6000 });
  await sleep(800);
  const seen = await pg.evaluate(() => ({
    names: [...document.querySelectorAll("#player-grid .pc-name")].map((e) => e.textContent.replace(/YOU/i, "").trim()),
    hasPfp: !!document.querySelector("#player-grid img.pfp"),
  }));
  check(seen.names.includes("Wanda"), `WORDCLASH shows the hub name → ${seen.names.join(",")}`);
  check(seen.hasPfp, "WORDCLASH shows the hub PHOTO (shared store, same token)");
  const pfpLoads = await pg.$eval("#player-grid img.pfp", (img) => new Promise((r) => {
    if (img.complete) r(img.naturalWidth > 0);
    else { img.onload = () => r(true); img.onerror = () => r(false); }
  })).catch(() => false);
  check(pfpLoads, "the shared photo actually renders in WORDCLASH");
  // WS is live (state received -> lobby rendered, no lingering conn banner)
  const connected = await pg.evaluate(() => {
    const b = document.getElementById("conn-banner");
    return !b || b.hidden;
  });
  check(connected, "WORDCLASH WebSocket connected through the mount");

  check(errors.length === 0, "zero page errors" + (errors.length ? ": " + errors.join(";") : ""));
} finally {
  await browser.close();
}
console.log(bad ? "WORDCLASH MERGE TEST FAIL" : "WORDCLASH MERGE TEST PASS");
process.exit(bad ? 1 : 0);
