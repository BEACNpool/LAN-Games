// hub_profile_test.mjs — the LAN Games root profile section:
//   set name + character + photo (crop/zoom) once, it persists on the device
//   and feeds into the games. Also covers remove-photo.
// Usage: node tests/hub_profile_test.mjs [baseURL]
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
  userDataDir: os.homedir() + "/tmp/ghshot-hubprofile",
  args: ["--no-sandbox", "--disable-gpu"],
});
try {
  const pg = await browser.newPage();
  const errors = [];
  pg.on("pageerror", (e) => errors.push(e.message));
  pg.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await pg.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });

  // clean slate
  await pg.goto(BASE + "/", { waitUntil: "networkidle2" });
  await pg.evaluate(() => localStorage.clear());
  await pg.reload({ waitUntil: "networkidle2" });
  await sleep(300);
  check((await pg.$eval("#hp-name", (e) => e.textContent)) === "SET UP",
    "fresh device shows SET UP in the profile chip");

  // set name + character
  await pg.click("#profile-chip");
  await pg.waitForSelector("#profile-sheet:not([hidden])", { timeout: 3000 });
  await pg.type("#pf-name", "Ava");
  await pg.evaluate(() => document.querySelectorAll("#pf-grid .avatar-cell")[4].click());
  await pg.click("#pf-save");
  await sleep(200);
  const saved = await pg.evaluate(() => ({
    name: localStorage.getItem("wc-name"), av: localStorage.getItem("wc-avatar"),
    chip: document.getElementById("hp-name").textContent,
  }));
  check(saved.name === "Ava" && !!saved.av && saved.chip === "Ava",
    `profile saved to device (name=${saved.name}, chip=${saved.chip})`);

  // upload a photo through the crop/zoom editor
  await pg.click("#profile-chip");
  await pg.waitForSelector("#profile-sheet:not([hidden])", { timeout: 3000 });
  await pg.click("#pf-photo");
  await pg.evaluate(async () => {
    const c = document.createElement("canvas"); c.width = c.height = 300;
    const cx = c.getContext("2d");
    cx.fillStyle = "#e0345a"; cx.fillRect(0, 0, 300, 300);
    cx.fillStyle = "#22d3ee"; cx.beginPath(); cx.arc(150, 130, 80, 0, 7); cx.fill();
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    const file = new File([blob], "me.png", { type: "image/png" });
    const input = document.querySelector('input[type="file"]');
    const dt = new DataTransfer(); dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await pg.waitForSelector(".crop-ov .crop-ok", { timeout: 3000 });
  check(true, "crop/zoom editor opened on import");
  // exercise the zoom slider, then use the photo
  await pg.evaluate(() => {
    const s = document.querySelector(".crop-slider");
    s.value = "1.8"; s.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await sleep(150);
  await pg.click(".crop-ov .crop-ok");
  await sleep(1400);
  const photo = await pg.evaluate(() => ({
    pfp: localStorage.getItem("wc-pfp"),
    chipImg: !!document.querySelector("#hp-av img.pfp"),
    prevImg: !!document.querySelector("#pf-av img.pfp"),
    rmShown: !document.getElementById("pf-photo-rm").hidden,
  }));
  check(!!photo.pfp && photo.pfp.startsWith("/avatars/"), "photo uploaded → pfp URL stored");
  check(photo.chipImg && photo.prevImg, "chip + profile preview show the photo");
  check(photo.rmShown, "REMOVE PHOTO appears once a photo exists");
  const loads = await pg.$eval("#pf-av img.pfp", (img) => new Promise((r) => {
    if (img.complete) r(img.naturalWidth > 0);
    else { img.onload = () => r(true); img.onerror = () => r(false); }
  }));
  check(loads, "the uploaded photo actually renders (server round-trip ok)");

  // persists across a reload
  await pg.reload({ waitUntil: "networkidle2" });
  await sleep(300);
  const rel = await pg.evaluate(() => ({
    chip: document.getElementById("hp-name").textContent,
    chipImg: !!document.querySelector("#hp-av img.pfp"),
  }));
  check(rel.chip === "Ava" && rel.chipImg, "profile + photo survive a reload");

  // feeds into a game: spades auto-joins with the device identity
  await pg.goto(BASE + "/games/spades/", { waitUntil: "networkidle2" });
  await pg.waitForSelector("#scr-lobby:not([hidden])", { timeout: 6000 });
  await sleep(700);
  const inGame = await pg.evaluate(() => ({
    names: [...document.querySelectorAll("#player-grid .pc-name")].map((e) => e.textContent.replace("YOU", "").trim()),
    hasPfp: !!document.querySelector("#player-grid img.pfp"),
  }));
  check(inGame.names.includes("Ava"), `game shows the hub name → ${inGame.names.join(",")}`);
  check(inGame.hasPfp, "game shows the hub photo (fed through by device token)");

  // remove photo
  await pg.goto(BASE + "/", { waitUntil: "networkidle2" });
  await pg.click("#profile-chip");
  await pg.waitForSelector("#profile-sheet:not([hidden])", { timeout: 3000 });
  await pg.click("#pf-photo-rm");
  await sleep(600);
  const rm = await pg.evaluate(() => ({
    pfp: localStorage.getItem("wc-pfp"),
    chipImg: !!document.querySelector("#hp-av img.pfp"),
  }));
  check(!rm.pfp && !rm.chipImg, "remove clears the photo (chip back to character)");

  check(errors.length === 0, "zero page errors" + (errors.length ? ": " + errors.join(";") : ""));
} finally {
  await browser.close();
}
console.log(bad ? "HUB PROFILE TEST FAIL" : "HUB PROFILE TEST PASS");
process.exit(bad ? 1 : 0);
