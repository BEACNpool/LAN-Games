// ORBIT RIOT: TV spectator + three isolated phone controllers, a real pointer
// sling, power-up, three complete physics heats, podium, responsive layout,
// and winner brag card.

import { createRequire } from "module";
import os from "os";
import fs from "fs";

const require = createRequire("/home/ubuntudesktop/projects/webdev-toolkit/x.js");
const puppeteer = require("puppeteer-core");
const BASE = process.argv[2] || "http://127.0.0.1:8797";
const OUT = process.argv[3] || os.homedir() + "/tmp/orbitriot-shots";
fs.mkdirSync(OUT, { recursive: true });

const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const SMALL_PHONE = { width: 360, height: 740, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const TV = { width: 1440, height: 810, deviceScaleFactor: 1 };
const errors = [];
let step = "boot";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.log(`[${new Date().toISOString().slice(11,19)}] ${message}`);
function fail(message) { console.error(`FAIL @ ${step}: ${message}`); process.exitCode = 1; }

const browser = await puppeteer.launch({
  executablePath: "/snap/bin/chromium", headless: "new",
  userDataDir: os.homedir() + "/tmp/ghshot-orbitriot",
  args: ["--no-sandbox", "--disable-gpu"],
});
const newContext = () => browser.createBrowserContext
  ? browser.createBrowserContext() : browser.createIncognitoBrowserContext();

function watchErrors(page, label) {
  page.on("console", (message) => { if (message.type() === "error") errors.push(`${label}: ${message.text()}`); });
  page.on("pageerror", (error) => errors.push(`${label} pageerror: ${error.message}`));
}

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  log(`shot: ${name}`);
}

async function phone(name, avatarIndex, viewport = PHONE) {
  const context = await newContext(), page = await context.newPage();
  await page.setViewport(viewport); watchErrors(page, name);
  await page.goto(`${BASE}/games/orbitriot/`, { waitUntil: "networkidle2" });
  await page.waitForSelector("#scr-join:not([hidden])", { timeout: 7000 });
  await page.type("#name-input", name);
  await page.evaluate((index) => document.querySelectorAll("#avatar-grid .avatar-cell")[index].click(), avatarIndex);
  await page.click("#join-btn");
  await page.waitForSelector("#scr-lobby:not([hidden])", { timeout: 7000 });
  return { context, page, name };
}

async function lock(page, angle, power, ability = "none") {
  await page.waitForFunction(() => window.ORBIT_RIOT_DEV.state()?.game?.stage === "aiming", { timeout: 12000 });
  await page.evaluate((a,p,ab) => window.ORBIT_RIOT_DEV.lock(a,p,ab), angle, power, ability);
}

try {
  step = "open TV";
  const tvContext = await newContext(), tv = await tvContext.newPage();
  await tv.setViewport(TV); watchErrors(tv,"TV");
  await tv.goto(`${BASE}/games/orbitriot/tv.html`, { waitUntil: "networkidle2" });
  await tv.waitForSelector("#tv-lobby:not([hidden])", { timeout: 7000 });
  const tvIdentity = await tv.evaluate(() => ({ tv: ORBIT_RIOT_DEV.isTV(), you: ORBIT_RIOT_DEV.state()?.you }));
  if (!tvIdentity.tv || tvIdentity.you !== null) throw new Error("TV did not connect as read-only spectator");

  step = "join phones";
  const ava = await phone("Ava",0), rex = await phone("Rex",4,SMALL_PHONE), mia = await phone("Mia",7);
  const players = [ava,rex,mia], pages = players.map((p)=>p.page);
  await tv.waitForFunction(() => document.querySelectorAll(".tv-pilot").length === 3, { timeout: 7000 });
  const qr = await tv.evaluate(() => document.querySelector("#tv-qr svg")?.getAttribute("viewBox"));
  if (!qr) throw new Error("TV join QR did not render");
  await shot(tv,"01-tv-lobby"); await shot(ava.page,"02-phone-lobby");

  step = "ready and launch";
  await ava.page.evaluate(() => [...document.querySelectorAll("#opt-heats button")].find((b)=>b.textContent==="3").click());
  for (const page of pages) { await page.click("#ready-btn"); await sleep(120); }
  await ava.page.waitForSelector("#go-btn:not([hidden])", { timeout: 7000 });
  await ava.page.click("#go-btn");
  await Promise.all(pages.map((page)=>page.waitForSelector("#scr-aim:not([hidden])", { timeout: 9000 })));
  await tv.waitForSelector("#tv-arena:not([hidden])", { timeout: 9000 });
  await shot(tv,"03-tv-aiming"); await shot(ava.page,"04-phone-controller");
  for (const page of pages) {
    const layout = await page.evaluate(() => ({ overflow:document.documentElement.scrollWidth-innerWidth,
      abilities:[...document.querySelectorAll(".ability-row button")].map((b)=>{const r=b.getBoundingClientRect();return[r.width,r.height];}),
      lock:(()=>{const r=document.getElementById("lock-btn").getBoundingClientRect();return[r.width,r.height];})() }));
    if(layout.overflow>1)throw new Error(`controller overflowed horizontally by ${layout.overflow}px`);
    if(layout.abilities.some(([w,h])=>w<44||h<44)||layout.lock[1]<44)throw new Error("controller has sub-44px touch target");
  }

  step = "real pointer sling";
  const box = await ava.page.$eval("#sling-canvas", (el) => {
    const r=el.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height};
  });
  await ava.page.mouse.move(box.x+box.w/2,box.y+box.h/2); await ava.page.mouse.down();
  await ava.page.mouse.move(box.x+box.w*.82,box.y+box.h*.27,{steps:10}); await ava.page.mouse.up();
  await ava.page.click('[data-ability="boost"]');
  const aimed = await ava.page.evaluate(() => {
    const before=ORBIT_RIOT_DEV.state().game.my_locked;
    document.getElementById("lock-btn").click(); return before;
  });
  if (aimed) throw new Error("opening player unexpectedly started locked");
  await lock(rex.page,205,.78,"anchor"); await lock(mia.page,315,.82,"shield");
  await Promise.all(pages.map((page)=>page.waitForFunction(() => ORBIT_RIOT_DEV.state()?.game?.stage === "replay", { timeout: 7000 })));
  await tv.waitForFunction(() => ORBIT_RIOT_DEV.state()?.game?.stage === "replay", { timeout: 7000 });
  await sleep(1900); await shot(tv,"05-tv-physics-replay"); await shot(ava.page,"06-phone-look-up");

  step = "complete match";
  for (let heat=2; heat<=3; heat++) {
    await Promise.all(pages.map((page)=>page.waitForFunction((h) => {
      const g=ORBIT_RIOT_DEV.state()?.game; return g?.stage === "aiming" && g.heat === h;
    }, { timeout: 13000 }, heat)));
    await lock(ava.page,35+heat*39,.72); await lock(rex.page,165+heat*27,.83); await lock(mia.page,275+heat*17,.67);
    await Promise.all(pages.map((page)=>page.waitForFunction(() => ORBIT_RIOT_DEV.state()?.game?.stage === "replay", { timeout: 7000 })));
    log(`heat ${heat} launched`);
  }
  await Promise.all(pages.map((page)=>page.waitForSelector("#gameover:not([hidden])", { timeout: 14000 })));
  await tv.waitForSelector("#tv-podium:not([hidden])", { timeout: 14000 });
  await shot(tv,"07-tv-podium"); await shot(ava.page,"08-phone-results");

  step = "winner brag";
  const final = await ava.page.evaluate(() => ORBIT_RIOT_DEV.state().game.result);
  const winnerPid = final.find((r)=>r.rank===1).pid;
  let winnerPage = null;
  for (const page of pages) {
    if (await page.evaluate((pid)=>ORBIT_RIOT_DEV.state().you.pid===pid,winnerPid)) { winnerPage=page; break; }
  }
  if (!winnerPage) throw new Error("winner phone not found");
  const clicked = await winnerPage.evaluate(() => { const b=document.querySelector(".brag-btn-go"); if(!b)return false;b.click();return true; });
  if (!clicked) throw new Error("winner brag button missing");
  await sleep(1200);
  const brag = await winnerPage.evaluate(() => document.getElementById("brag-img")?.naturalWidth === 1080);
  if (!brag) throw new Error("brag card did not render at 1080px");
  await shot(winnerPage,"09-winner-brag");

  step = "layout";
  for (const page of pages) {
    const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth-innerWidth }));
    if (layout.overflow > 1) throw new Error(`phone overflowed horizontally by ${layout.overflow}px`);
  }
  const tvLayout = await tv.evaluate(() => ({ overflowX:document.documentElement.scrollWidth-innerWidth,
    overflowY:document.documentElement.scrollHeight-innerHeight }));
  if (tvLayout.overflowX>1 || tvLayout.overflowY>1) throw new Error(`TV overflow ${JSON.stringify(tvLayout)}`);

  step = "done";
  log(errors.length ? `CONSOLE ERRORS:\n${errors.join("\n")}` : "zero console errors");
  if (errors.length) process.exitCode=1;
  console.log(process.exitCode ? "ORBIT RIOT PLAYTEST FAIL" : "ORBIT RIOT PLAYTEST PASS");
  await Promise.all(players.map((p)=>p.context.close())); await tvContext.close();
} catch (error) {
  fail(error.message); console.log("ORBIT RIOT PLAYTEST FAIL");
} finally {
  await browser.close();
}
