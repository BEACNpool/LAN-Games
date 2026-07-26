// catalogue_mobile_smoke_test.mjs — one 360px launch smoke for every visible
// title. This catches a broken mount, branding drift, missing suite navigation,
// first-screen overflow and undersized join controls without playing 27 matches.
//
// Usage: node tests/catalogue_mobile_smoke_test.mjs [baseURL] [failureShotDir]
import fs from "fs";
import os from "os";
import path from "path";
import { puppeteer, CHROME_PATH } from "./_resolve.mjs";

const BASE = process.argv[2] || "http://127.0.0.1:8096";
const OUT = process.argv[3] || path.join(os.homedir(), "tmp", "ghshot-catalogue");
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const profile = fs.mkdtempSync(path.join(os.homedir(), "tmp", "gh-catalogue-"));
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
  await page.setViewport({
    width: 360, height: 740, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
  });
  await page.goto(BASE + "/", { waitUntil: "networkidle2" });
  const catalogue = await page.evaluate(async () => {
    const data = await (await fetch("/api/games")).json();
    return [
      ...data.games.filter((game) => !game.hidden).map((game) => ({
        slug: game.slug, title: game.title, external: false,
      })),
      ...(data.external || []).map((game) => ({
        slug: game.slug, title: game.title, external: true, url: game.url,
      })),
    ];
  });

  for (const game of catalogue) {
    const route = game.url || `/games/${game.slug}/`;
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.setItem("lg-booted", "1");
    });

    const errors = [];
    const onPageError = (error) => errors.push(error.message);
    const onConsole = (message) => {
      if (message.type() === "error") errors.push(message.text());
    };
    const onResponse = (response) => {
      if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
    };
    page.on("pageerror", onPageError);
    page.on("console", onConsole);
    page.on("response", onResponse);
    const response = await page.goto(BASE + route, {
      waitUntil: "networkidle2", timeout: 12000,
    });
    await sleep(300);

    const state = await page.evaluate((isExternal) => {
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return !element.hidden && style.display !== "none" &&
          style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const small = [...document.querySelectorAll("button, a[href], input, [role=button]")]
        .filter(visible)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            label: element.getAttribute("aria-label") || element.id ||
              element.textContent.trim().slice(0, 24),
            width: Math.round(rect.width), height: Math.round(rect.height),
          };
        })
        .filter((item) => item.width < 44 || item.height < 44);
      const home = document.querySelector(isExternal ? ".suite-link" : ".suite-home");
      const homeRect = home?.getBoundingClientRect();
      return {
        title: document.title,
        overflow: document.documentElement.scrollWidth - innerWidth,
        home: homeRect ? {
          width: Math.round(homeRect.width), height: Math.round(homeRect.height),
          top: Math.round(homeRect.top),
        } : null,
        art: isExternal || !!document.querySelector(".join-stage-art .game-art"),
        small,
      };
    }, game.external);
    page.off("pageerror", onPageError);
    page.off("console", onConsole);
    page.off("response", onResponse);

    const ok = response?.status() === 200 && state.overflow <= 0 &&
      state.home && state.home.width >= 44 && state.home.height >= 44 &&
      state.home.top < 80 && state.art && !state.title.includes("GAMEHUB") &&
      state.small.length === 0 && errors.length === 0;
    check(ok, `${game.slug}: 360px launch` + (ok ? "" :
      ` (status=${response?.status()}, overflow=${state.overflow}, home=${JSON.stringify(state.home)},` +
      ` art=${state.art}, title=${JSON.stringify(state.title)}, small=${JSON.stringify(state.small)},` +
      ` errors=${JSON.stringify(errors)})`));
    if (!ok) {
      await page.screenshot({ path: path.join(OUT, `${game.slug}.png`), fullPage: false });
    }
  }
} finally {
  await browser.close();
}

console.log(bad ? `CATALOGUE MOBILE SMOKE FAIL (${bad})` : "CATALOGUE MOBILE SMOKE PASS");
process.exit(bad ? 1 : 0);
