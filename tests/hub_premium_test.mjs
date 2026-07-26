// hub_premium_test.mjs — responsive product-shell regression for the premium
// catalogue. Exercises the 360px header, procedural art, discovery tools,
// player preferences and the universal in-game escape hatch.
//
// Usage: node tests/hub_premium_test.mjs [baseURL] [screenshotDir]
import fs from "fs";
import os from "os";
import path from "path";
import { puppeteer, CHROME_PATH } from "./_resolve.mjs";

const BASE = process.argv[2] || "http://127.0.0.1:8096";
const OUT = process.argv[3] || path.join(os.homedir(), "tmp", "ghshot-premium");
fs.mkdirSync(OUT, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.homedir(), "tmp", "gh-premium-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let bad = 0;
const check = (ok, message) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${message}`);
  if (!ok) bad += 1;
};

const browser = await puppeteer.launch({
  executablePath: CHROME_PATH,
  headless: "new",
  userDataDir: profile,
  args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars"],
});

try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      errors.push(`${response.status()} ${response.url()}`);
    }
  });

  await page.setViewport({ width: 360, height: 740, deviceScaleFactor: 1 });
  await page.goto(BASE + "/", { waitUntil: "networkidle2" });
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload({ waitUntil: "networkidle2" });
  await page.waitForSelector("#rails .tile", { timeout: 8000 });
  await sleep(500);

  const mobile = await page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return !element.hidden && style.display !== "none" &&
        style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const smallTargets = [...document.querySelectorAll(
      "button, a[href], input, [role=button], select, textarea"
    )].filter(visible).map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        id: element.id,
        cls: String(element.className),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    }).filter((item) => item.width < 44 || item.height < 44);
    const header = document.querySelector(".hub-top").getBoundingClientRect();
    const firstRail = document.querySelector(".rail").getBoundingClientRect();
    return {
      viewport: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      headerLeft: Math.round(header.left),
      headerRight: Math.round(header.right),
      firstRailTop: Math.round(firstRail.top),
      collapsed: document.getElementById("lc-head").getAttribute("aria-expanded"),
      launchable: document.querySelectorAll("#rails .tile-launch").length,
      customArt: document.querySelectorAll("#rails .tile .game-art").length,
      smallTargets,
    };
  });
  check(mobile.scrollWidth <= mobile.viewport,
    `360px lobby has no horizontal overflow (${mobile.scrollWidth}/${mobile.viewport})`);
  check(mobile.headerLeft >= 0 && mobile.headerRight <= mobile.viewport,
    "360px header remains entirely inside the viewport");
  check(mobile.collapsed === "false", "chat starts compact instead of owning the first screen");
  check(mobile.firstRailTop < 400, `games appear in the opening viewport (y=${mobile.firstRailTop})`);
  check(mobile.launchable >= 27, `complete catalogue rendered (${mobile.launchable} launchable games)`);
  check(mobile.customArt === mobile.launchable, "every game card uses suite-owned key art");
  check(mobile.smallTargets.length === 0,
    "all initially visible controls meet the 44px mobile target" +
      (mobile.smallTargets.length ? `: ${JSON.stringify(mobile.smallTargets)}` : ""));
  await page.screenshot({ path: path.join(OUT, "01-hub-360.png") });

  await page.click("#rails .tile-fav");
  await sleep(150);
  const favorite = await page.evaluate(() => ({
    stored: JSON.parse(localStorage.getItem("lg-favorites") || "[]"),
    shelfHidden: document.getElementById("quick-section").hidden,
    shelfTiles: document.querySelectorAll("#quick-track .tile").length,
  }));
  check(favorite.stored.length === 1 && !favorite.shelfHidden && favorite.shelfTiles === 1,
    "favorite creates a persistent personal lineup");

  await page.click("#rails .tile-info");
  await page.waitForSelector("#game-sheet:not([hidden])");
  const details = await page.evaluate(() => ({
    title: document.getElementById("game-sheet-title").textContent.trim(),
    art: !!document.querySelector("#game-sheet-art .game-art"),
    metadata: document.querySelectorAll("#game-sheet-meta span").length,
    playHref: document.getElementById("game-sheet-play").getAttribute("href"),
  }));
  check(details.title && details.art && details.metadata >= 3 && details.playHref,
    `game detail sheet has art, context and CTA (${details.title})`);
  await page.screenshot({ path: path.join(OUT, "02-game-details-360.png") });
  await page.click("#game-sheet-close");

  await page.click("#search-open");
  await page.type("#game-search", "poker");
  const search = await page.evaluate(() => ({
    count: document.querySelectorAll("#search-results .search-result").length,
    title: document.querySelector("#search-results .search-result-copy b")?.textContent,
    art: !!document.querySelector("#search-results .game-art"),
  }));
  check(search.count === 1 && search.title === "TEXAS HOLD'EM" && search.art,
    "search finds Texas Hold'em from the natural “poker” query");
  await page.screenshot({ path: path.join(OUT, "03-search-360.png") });
  await page.click("#search-close");

  await page.click("#profile-chip");
  await page.waitForSelector("#profile-sheet:not([hidden])");
  await page.click("#pf-contrast");
  await page.click("#pf-motion");
  const preferences = await page.evaluate(() => ({
    contrast: document.documentElement.classList.contains("lg-high-contrast"),
    reduced: document.documentElement.classList.contains("lg-reduced-fx"),
    contrastStored: localStorage.getItem("lg-contrast"),
    motionStored: localStorage.getItem("lg-motion"),
  }));
  check(preferences.contrast && preferences.reduced &&
      preferences.contrastStored === "1" && preferences.motionStored === "reduced",
    "comfort settings apply immediately and persist");
  await page.click("#install-open");
  await page.waitForSelector("#install-sheet:not([hidden])");
  const installText = await page.$eval("#install-sheet", (element) => element.innerText);
  check(/Add to Home Screen/i.test(installText) && /iPhone/i.test(installText) &&
      /Android/i.test(installText), "home-screen guide is honest and cross-platform");
  await page.click("#install-close");

  await page.goto(BASE + "/games/poker/", { waitUntil: "networkidle2" });
  await page.waitForSelector("#scr-join:not([hidden])", { timeout: 6000 });
  await page.waitForSelector(".suite-home", { timeout: 3000 });
  await page.waitForSelector(".join-stage-art .game-art", { timeout: 3000 });
  const joinShell = await page.evaluate(() => {
    const home = document.querySelector(".suite-home").getBoundingClientRect();
    return {
      homeWidth: Math.round(home.width),
      homeHeight: Math.round(home.height),
      overflow: document.documentElement.scrollWidth > innerWidth,
      accent: getComputedStyle(document.documentElement).getPropertyValue("--game-accent").trim(),
    };
  });
  check(joinShell.homeWidth >= 44 && joinShell.homeHeight >= 44 && !joinShell.overflow,
    "game join shell keeps a large, standalone-safe route back to the catalogue");
  check(!!joinShell.accent, "game-specific visual accent is installed");
  await page.screenshot({ path: path.join(OUT, "04-poker-join-360.png") });

  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await page.goto(BASE + "/", { waitUntil: "networkidle2" });
  // The optional power-on sweep self-removes after 1.2s. Waiting for it keeps
  // this capture useful even when motion preferences changed during the test.
  await sleep(1300);
  const desktop = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > innerWidth,
    width: document.querySelector(".hub-inner").getBoundingClientRect().width,
    tiles: document.querySelectorAll("#rails .tile").length,
  }));
  check(!desktop.overflow && desktop.width <= 1280 && desktop.tiles >= 27,
    "desktop catalogue is bounded, complete and overflow-free");
  await page.screenshot({ path: path.join(OUT, "05-hub-desktop.png"), fullPage: true });

  check(errors.length === 0,
    "zero console, page or HTTP errors" + (errors.length ? `: ${errors.join(" | ")}` : ""));
} finally {
  await browser.close();
}

console.log(bad ? `HUB PREMIUM TEST FAIL (${bad})` : "HUB PREMIUM TEST PASS");
process.exit(bad ? 1 : 0);
