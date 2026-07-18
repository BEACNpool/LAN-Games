// hub_chat_test.mjs — the LAN Games lobby chat that replaced the hero:
// two people exchange text + emoji + an uploaded image; presence + no hero.
// Usage: node tests/hub_chat_test.mjs [baseURL]
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
  userDataDir: os.homedir() + "/tmp/ghshot-hubchat",
  args: ["--no-sandbox", "--disable-gpu"],
});
const newCtx = () => browser.createBrowserContext
  ? browser.createBrowserContext() : browser.createIncognitoBrowserContext();
const errors = [];

async function member(name, token) {
  const ctx = await newCtx();
  const pg = await ctx.newPage();
  await pg.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  pg.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  pg.on("console", (m) => { if (m.type() === "error") errors.push(`${name}: ${m.text()}`); });
  await pg.goto(BASE + "/", { waitUntil: "networkidle2" });
  await pg.evaluate((n, t) => {
    localStorage.setItem("wc-name", n);
    localStorage.setItem("wc-token", t);
    localStorage.setItem("wc-avatar", "🦊");
  }, name, token);
  await pg.reload({ waitUntil: "networkidle2" });
  await pg.waitForSelector("#lc-msgs", { timeout: 5000 });
  return pg;
}
const msgTexts = (pg) =>
  pg.$$eval("#lc-msgs .lc-row", (rs) => rs.map((r) => ({
    name: r.querySelector(".lc-name")?.textContent || "(me)",
    text: r.querySelector(".lc-text")?.textContent || "",
    big: !!r.querySelector(".lc-text.big"),
    img: !!r.querySelector(".lc-img"),
    mine: r.classList.contains("mine"),
  })));

try {
  // hero is gone
  const ava = await member("Ava", "avatoken0001");
  check(await ava.$("#hero") === null, "the big TONIGHT'S PICK hero is gone");
  check(await ava.$("#lc-msgs") !== null, "lobby chat panel is present");

  const ben = await member("Ben", "bentoken0002");
  await sleep(700);
  const online = await ava.$eval("#lc-online", (e) => e.textContent);
  const n = parseInt((online.match(/(\d+) online/) || [])[1] || "0", 10);
  check(n >= 2, `presence shows at least both online → ${online}`);

  // Ava sends text -> Ben sees it (attributed, not "mine")
  await ava.type("#lc-text", "hey team, game night?");
  await ava.click("#lc-send");
  await sleep(500);
  const benSees = await msgTexts(ben);
  const fromAva = benSees.find((m) => m.text === "hey team, game night?");
  check(fromAva && fromAva.name === "Ava" && !fromAva.mine,
    "Ben sees Ava's text attributed to Ava");
  const avaSees = await msgTexts(ava);
  check(avaSees.some((m) => m.text === "hey team, game night?" && m.mine),
    "Ava sees her own message as mine");

  // emoji picker inserts, and an emoji-only message renders big
  await ava.click("#lc-emoji-btn");
  await ava.waitForSelector("#lc-emoji:not([hidden])", { timeout: 2000 });
  await ava.evaluate(() => document.querySelector("#lc-emoji button").click());
  const afterPick = await ava.$eval("#lc-text", (e) => e.value);
  check(afterPick.length > 0, `emoji picker inserts into the input → "${afterPick}"`);
  await ava.evaluate(() => { document.getElementById("lc-text").value = "🔥🎉"; });
  await ava.click("#lc-send");
  await sleep(500);
  const benBig = (await msgTexts(ben)).find((m) => m.text === "🔥🎉");
  check(benBig && benBig.big, "emoji-only message renders big for everyone");

  // Ava uploads a big landscape "phone photo" (4032x3024 used to fail) -> Ben sees it
  await ava.evaluate(async () => {
    const c = document.createElement("canvas"); c.width = 4032; c.height = 3024;
    const cx = c.getContext("2d");
    cx.fillStyle = "#10c96e"; cx.fillRect(0, 0, c.width, c.height);
    cx.fillStyle = "#05070e"; cx.font = "bold 600px sans-serif"; cx.fillText("GG", 1400, 1800);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
    const input = document.querySelector('input[type="file"][accept*="gif"]');
    const dt = new DataTransfer(); dt.items.add(new File([blob], "gg.jpg", { type: "image/jpeg" }));
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await sleep(1200);
  const benImg = (await msgTexts(ben)).find((m) => m.img);
  check(!!benImg, "Ben sees the uploaded meme inline");
  const imgLoads = await ben.$eval("#lc-msgs .lc-img", (img) => new Promise((r) => {
    if (img.complete) r(img.naturalWidth > 0);
    else { img.onload = () => r(true); img.onerror = () => r(false); }
  })).catch(() => false);
  check(imgLoads, "the shared image actually loads (server round-trip)");

  // a fresh phone opening the hub sees the recent history
  const cara = await member("Cara", "caratoken0003");
  await sleep(600);
  const caraHist = await msgTexts(cara);
  check(caraHist.some((m) => m.text === "hey team, game night?") && caraHist.some((m) => m.img),
    `late joiner sees chat history (${caraHist.length} msgs)`);

  check(errors.length === 0, "zero page errors" + (errors.length ? ": " + errors.join(";") : ""));
} finally {
  await browser.close();
}
console.log(bad ? "HUB CHAT TEST FAIL" : "HUB CHAT TEST PASS");
process.exit(bad ? 1 : 0);
