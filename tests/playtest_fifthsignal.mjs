// THE FIFTH SIGNAL: grow one real room from 3 -> 4 -> 5 phones, solve each
// generated mission using the private cross-console relays, and verify the TV
// stays public. Usage:
//   node tests/playtest_fifthsignal.mjs [baseURL] [shotdir]
import fs from "fs";
import os from "os";
import { puppeteer, CHROME_PATH } from "./_resolve.mjs";

const BASE = process.argv[2] || "http://127.0.0.1:8096";
const OUT = process.argv[3] || `${os.homedir()}/tmp/fifthsignal-shots`;
fs.mkdirSync(OUT, { recursive: true });

const PHONE = { width: 360, height: 740, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const TV = { width: 1440, height: 810, deviceScaleFactor: 1 };
const NAMES = ["NOVA", "MICA", "ORBIT", "SAGE", "JUNO"];
const PHOTO_TOKEN = `fifth-photo-${process.pid}-${Date.now()}`;
const CREW_SIZES = (process.env.FIFTH_SIGNAL_CREW_SIZES || "3,4,5")
  .split(",").map(Number).filter((value) => value >= 3 && value <= 5);
const errors = [];
let failures = 0;
let step = "boot";
const profile = fs.mkdtempSync(`${os.homedir()}/tmp/ghshot-fifthsignal-`);
const fail = (message) => { failures++; console.error(`FAIL @ ${step}: ${message}`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME_PATH,
  headless: "new",
  userDataDir: profile,
  args: ["--no-sandbox", "--disable-gpu"],
});
const newContext = () => browser.createBrowserContext
  ? browser.createBrowserContext() : browser.createIncognitoBrowserContext();
function watch(page, label) {
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`${label}: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`${label} pageerror: ${error.message}`));
}
async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
}
async function waitPhase(page, phases, timeout = 20000) {
  const allowed = Array.isArray(phases) ? phases : [phases];
  await page.waitForFunction(
    (wanted) => wanted.includes(window.__fifthSignalPhone?.state()?.phase),
    { timeout },
    allowed,
  );
  return page.evaluate(() => window.__fifthSignalPhone.state().phase);
}
async function makePhone(index) {
  const context = await newContext();
  const page = await context.newPage();
  await page.setViewport(PHONE);
  watch(page, NAMES[index]);
  await page.goto(`${BASE}/games/fifthsignal/`, { waitUntil: "networkidle2" });
  if (index === 0) {
    await page.evaluate(async (token) => {
      localStorage.setItem("wc-token", token);
      const canvas = document.createElement("canvas");
      canvas.width = 96;
      canvas.height = 96;
      const context = canvas.getContext("2d");
      const gradient = context.createLinearGradient(0, 0, 96, 96);
      gradient.addColorStop(0, "#19d9ff");
      gradient.addColorStop(1, "#6b35c9");
      context.fillStyle = gradient;
      context.fillRect(0, 0, 96, 96);
      context.fillStyle = "#f7dcbb";
      context.beginPath();
      context.arc(48, 42, 25, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = "#162139";
      context.beginPath();
      context.arc(39, 40, 3, 0, Math.PI * 2);
      context.arc(57, 40, 3, 0, Math.PI * 2);
      context.fill();
      context.strokeStyle = "#162139";
      context.lineWidth = 3;
      context.beginPath();
      context.arc(48, 47, 11, .2, Math.PI - .2);
      context.stroke();
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      const response = await fetch("/api/avatar", {
        method: "POST",
        headers: { "x-wc-token": token },
        body: blob,
      });
      if (!response.ok) throw new Error(`photo upload ${response.status}`);
      const payload = await response.json();
      localStorage.setItem("wc-pfp", payload.url);
    }, PHOTO_TOKEN);
  }
  await page.waitForSelector("#scr-join:not([hidden])", { timeout: 8000 });
  await page.type("#name-input", NAMES[index]);
  await page.evaluate((avatarIndex) => {
    document.querySelectorAll("#avatar-grid .avatar-cell")[avatarIndex]?.click();
  }, index);
  await page.click("#join-btn");
  await page.waitForSelector("#scr-lobby:not([hidden])", { timeout: 8000 });
  return { context, page };
}

async function makeLateSpectator(crewSize) {
  const context = await newContext();
  const page = await context.newPage();
  await page.setViewport(PHONE);
  watch(page, "WATCHER");
  await page.goto(`${BASE}/games/fifthsignal/`, { waitUntil: "networkidle2" });
  await page.waitForSelector("#scr-join:not([hidden])", { timeout: 8000 });
  await page.type("#name-input", "WATCHER");
  await page.click("#join-btn");
  await page.waitForSelector("#scr-spectator:not([hidden])", { timeout: 8000 });
  await page.waitForFunction(
    (count) => window.__fifthSignalPhone?.state()?.game?.me === null
      && document.querySelectorAll("#spectator-crew .spectator-person").length === count,
    { timeout: 8000 },
    crewSize,
  );
  const view = await page.evaluate(() => ({
    me: window.__fifthSignalPhone.state().game.me,
    title: document.getElementById("spectator-title").textContent.trim(),
    tvVisible: document.querySelector(".spectator-tv").getBoundingClientRect().height > 0,
    overflowX: document.documentElement.scrollWidth - innerWidth,
    crew: document.querySelectorAll("#spectator-crew .spectator-person").length,
  }));
  if (view.me !== null || !view.title || !view.tvVisible || view.crew !== crewSize) {
    fail(`bad late-join observer screen ${JSON.stringify(view)}`);
  }
  if (view.overflowX > 1) fail(`spectator horizontal overflow: ${view.overflowX}px`);
  return { context, page };
}

async function relayTargets(phones) {
  const rows = await Promise.all(phones.map((phone) => phone.page.evaluate(() =>
    (__fifthSignalPhone.state()?.game?.me?.consoles || []).map((console) => [
      console.relay?.target_role,
      console.relay?.value,
    ]))));
  return Object.fromEntries(rows.flat().filter(([role]) => role));
}

// Drive the rendered control widgets, not the server socket or game engine.
async function submitRole(page, role, target) {
  return page.evaluate(({ role, target }) => {
    const api = window.__fifthSignalPhone;
    api.selectRole(role, false);
    const state = api.state();
    const console = state.game.me.consoles.find((item) => item.role === role);
    if (!console) throw new Error(`missing ${role} console`);
    const host = document.getElementById("control-host");
    if (console.kind === "choice") {
      const button = [...host.querySelectorAll(".choice-button")]
        .find((item) => item.textContent.trim() === String(target));
      if (!button) throw new Error(`choice ${target} missing`);
      button.click();
      host.querySelector(".control-submit")?.click();
    } else if (console.kind === "sequence") {
      for (const value of target) {
        const button = [...host.querySelectorAll(".sequence-key")]
          .find((item) => item.textContent.trim() === String(value));
        if (!button) throw new Error(`sequence key ${value} missing`);
        button.click();
      }
      host.querySelector(".sequence-send")?.click();
    } else if (console.kind === "dial") {
      const input = host.querySelector('input[type="range"]');
      input.value = target;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      host.querySelector(".control-submit")?.click();
    } else if (console.kind === "switches") {
      target.forEach((on, index) => {
        const button = host.querySelectorAll(".switch-toggle")[index];
        if ((button.getAttribute("aria-pressed") === "true") !== on) button.click();
      });
      host.querySelector(".control-submit")?.click();
    } else if (console.kind === "balance") {
      for (const axis of ["x", "y"]) {
        const input = host.querySelector(`input[data-axis="${axis}"]`);
        input.value = target[axis];
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      host.querySelector(".control-submit")?.click();
    } else {
      throw new Error(`unsupported control ${console.kind}`);
    }
    return console.kind;
  }, { role, target });
}

async function solveCrisis(phones, tv) {
  const targets = await relayTargets(phones);
  if (Object.keys(targets).length !== 5) {
    fail(`relay map had ${Object.keys(targets).length}/5 targets`);
    return;
  }
  let checkedPublicRole = false;
  for (const phone of phones) {
    const roles = await phone.page.evaluate(() =>
      __fifthSignalPhone.state().game.me.consoles.map((console) => console.role));
    for (const role of roles) {
      await submitRole(phone.page, role, targets[role]);
      if (!checkedPublicRole) {
        await tv.waitForFunction(
          (roleId) => {
            const game = window.__fifthSignalTV?.state()?.game;
            const system = game?.progress?.systems?.find((item) => item.role === roleId);
            return system?.ready === true
              && document.querySelector(`.tv-console[data-role="${roleId}"]`)?.classList.contains("done");
          },
          { timeout: 5000 },
          role,
        );
        checkedPublicRole = true;
      }
      await sleep(80);
    }
  }
}

async function checkPhoneLayout(page) {
  const layout = await page.evaluate(() => ({
    overflowX: document.documentElement.scrollWidth - innerWidth,
    shown: [...document.querySelectorAll(".phone-screen")].find((screen) => !screen.hidden)?.id,
    smallTargets: [...document.querySelectorAll(
      ".phone-screen:not([hidden]) button, .phone-screen:not([hidden]) a",
    )].filter((element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && (box.width < 44 || box.height < 44);
    }).map((element) => [element.id || element.className, element.getBoundingClientRect().width,
      element.getBoundingClientRect().height]),
  }));
  if (layout.overflowX > 1) fail(`phone horizontal overflow: ${layout.overflowX}px`);
  if (layout.smallTargets.length) fail(`small targets: ${JSON.stringify(layout.smallTargets.slice(0, 4))}`);
}

const phones = [];
try {
  step = "TV boot";
  const tvContext = await newContext();
  const tv = await tvContext.newPage();
  await tv.setViewport(TV);
  watch(tv, "TV");
  await tv.goto(`${BASE}/games/fifthsignal/tv.html`, { waitUntil: "networkidle2" });
  await tv.waitForSelector("#tv-lobby:not([hidden])", { timeout: 8000 });
  await tv.click("#tv-curtain");
  const qr = await tv.$eval("#tv-qr", (element) => !!element.querySelector("svg, canvas, img"));
  if (!qr) fail("TV join QR missing");
  const lobbyLayout = await tv.evaluate(() => {
    const lobby = document.getElementById("tv-lobby");
    const qrBox = document.getElementById("tv-qr").getBoundingClientRect();
    const style = getComputedStyle(lobby);
    return {
      display: style.display,
      columns: style.gridTemplateColumns.trim().split(/\s+/).filter(Boolean).length,
      qrWidth: qrBox.width,
      qrRight: qrBox.right,
      qrBottom: qrBox.bottom,
      viewport: [innerWidth, innerHeight],
    };
  });
  if (lobbyLayout.display !== "grid" || lobbyLayout.columns < 2
      || lobbyLayout.qrWidth <= 0 || lobbyLayout.qrWidth > 400
      || lobbyLayout.qrRight > lobbyLayout.viewport[0] + 1
      || lobbyLayout.qrBottom > lobbyLayout.viewport[1] + 1) {
    fail(`TV lobby grid/QR bounds ${JSON.stringify(lobbyLayout)}`);
  }

  for (const crewSize of CREW_SIZES) {
    step = `${crewSize}-player lobby`;
    while (phones.length < crewSize) phones.push(await makePhone(phones.length));
    await phones[0].page.waitForFunction(
      (count) => document.querySelectorAll("#crew-grid .crew-card:not(.empty)").length === count,
      { timeout: 8000 },
      crewSize,
    );
    await phones[0].page.evaluate(() => {
      [...document.querySelectorAll("#opt-length button")].find((button) => button.textContent === "QUICK")?.click();
      [...document.querySelectorAll("#opt-difficulty button")].find((button) => button.textContent === "STORY")?.click();
    });
    for (const phone of phones) {
      const ready = await phone.page.evaluate(() => !!__fifthSignalPhone.state()?.you?.ready);
      if (!ready) await phone.page.click("#ready-btn");
      await sleep(80);
    }
    await phones[0].page.waitForSelector("#start-btn:not([hidden])", { timeout: 8000 });
    if (crewSize === 3) {
      await phones[0].page.waitForFunction(
        () => {
          const image = document.querySelector("#crew-grid .crew-card img.pfp");
          return image?.complete && image.naturalWidth > 0;
        },
        { timeout: 8000 },
      );
      await tv.waitForFunction(
        () => {
          const image = document.querySelector("#tv-lobby-crew img.pfp");
          return image?.complete && image.naturalWidth > 0;
        },
        { timeout: 8000 },
      );
      await checkPhoneLayout(phones[0].page);
      await shot(phones[0].page, "01-phone-lobby-360x740");
      await shot(tv, "02-tv-lobby");
    }
    await phones[0].page.click("#start-btn");
    if (crewSize === 3) {
      await tv.waitForFunction(
        () => {
          const image = document.querySelector("#tv-briefing:not([hidden]) .tv-assignment img.pfp");
          return image?.complete && image.naturalWidth > 0;
        },
        { timeout: 12000 },
      );
    }

    for (let round = 1; round <= 3; round++) {
      step = `${crewSize}p crisis ${round}`;
      await Promise.all(phones.map((phone) => waitPhase(phone.page, "crisis", 16000)));
      const privacy = await tv.evaluate(() => window.__fifthSignalTV?.state()?.game?.me);
      if (privacy !== null) fail(`TV received private me payload: ${JSON.stringify(privacy)}`);
      const ownership = await phones[0].page.evaluate(() =>
        __fifthSignalPhone.state().game.roster.map((person) => person.roles.length));
      if (ownership.reduce((sum, count) => sum + count, 0) !== 5
          || ownership.some((count) => count < 1 || count > 2)) {
        fail(`bad ${crewSize}p role ownership ${JSON.stringify(ownership)}`);
      }
      const systems = await tv.evaluate(() =>
        window.__fifthSignalTV?.state()?.game?.progress?.systems || []);
      if (systems.length !== 5
          || new Set(systems.map((system) => system.role)).size !== 5
          || systems.some((system) => typeof system.ready !== "boolean"
            || typeof system.autopilot !== "boolean")) {
        fail(`bad public per-role progress ${JSON.stringify(systems)}`);
      }
      if (crewSize === 3 && round === 1) {
        await checkPhoneLayout(phones[0].page);
        await shot(phones[0].page, "03-phone-private-console");
        await shot(tv, "04-tv-crisis");
        const spectator = await makeLateSpectator(crewSize);
        await shot(spectator.page, "05-phone-late-join-observer");
        await spectator.context.close();
      }
      await solveCrisis(phones, tv);
      await Promise.all(phones.map((phone) => waitPhase(phone.page, "resolution", 8000)));
      if (round < 3) await Promise.all(phones.map((phone) =>
        waitPhase(phone.page, ["briefing", "crisis"], 12000)));
    }

    step = `${crewSize}p final sync`;
    await Promise.all(phones.map((phone) => waitPhase(phone.page, "final_sync", 15000)));
    if (crewSize === 3) {
      await phones[0].page.focus("#sync-btn");
      await phones[0].page.keyboard.down("Space");
      await phones[0].page.waitForFunction(
        () => document.getElementById("sync-btn").getAttribute("aria-pressed") === "true"
          && __fifthSignalPhone.state().game.final.held.includes(
            __fifthSignalPhone.state().you.pid),
        { timeout: 5000 },
      );
      await phones[0].page.keyboard.up("Space");
      await phones[0].page.waitForFunction(
        () => document.getElementById("sync-btn").getAttribute("aria-pressed") === "false"
          && !__fifthSignalPhone.state().game.final.held.includes(
            __fifthSignalPhone.state().you.pid),
        { timeout: 5000 },
      );
    }
    await Promise.all(phones.map((phone) => phone.page.evaluate(() =>
      __fifthSignalPhone.holdSync(true))));
    if (crewSize === 5) {
      await shot(phones[0].page, "05-phone-final-sync");
      await shot(tv, "06-tv-final-sync");
    }
    await Promise.all(phones.map((phone) => waitPhase(phone.page, "game_end", 9000)));
    const result = await phones[0].page.evaluate(() => __fifthSignalPhone.state().game.result);
    if (!result?.won || result.crew?.length !== crewSize) {
      fail(`${crewSize}p mission result ${JSON.stringify(result)}`);
    }
    if (crewSize === 5) {
      await tv.waitForFunction(
        () => {
          const image = document.querySelector("#tv-end:not([hidden]) .tv-end-person img.pfp");
          return image?.complete && image.naturalWidth > 0;
        },
        { timeout: 8000 },
      );
      await phones[0].page.waitForFunction(
        () => {
          const image = document.querySelector("#scr-end:not([hidden]) .end-avatar img.pfp");
          return image?.complete && image.naturalWidth > 0;
        },
        { timeout: 8000 },
      );
      await shot(phones[0].page, "07-phone-team-ending");
      await shot(tv, "08-tv-team-ending");
      const endingLayout = await tv.evaluate(() => {
        const scene = document.getElementById("tv-end");
        const title = document.getElementById("tv-end-title").getBoundingClientRect();
        const style = getComputedStyle(scene);
        return {
          display: style.display,
          alignItems: style.alignItems,
          justifyContent: style.justifyContent,
          centerDelta: Math.abs(title.left + title.width / 2 - innerWidth / 2),
          titleBottom: title.bottom,
          viewport: [innerWidth, innerHeight],
        };
      });
      if (endingLayout.display !== "flex" || endingLayout.alignItems !== "center"
          || endingLayout.justifyContent !== "center" || endingLayout.centerDelta > 4
          || endingLayout.titleBottom > endingLayout.viewport[1]) {
        fail(`TV ending not centered ${JSON.stringify(endingLayout)}`);
      }
    }
    await checkPhoneLayout(phones[0].page);

    if (crewSize !== CREW_SIZES.at(-1)) {
      await phones[0].page.click("#again-btn");
      await Promise.all(phones.map((phone) => waitPhase(phone.page, "lobby", 8000)));
    }
  }

  const tvOverflow = await tv.evaluate(() => [
    document.documentElement.scrollWidth - innerWidth,
    document.documentElement.scrollHeight - innerHeight,
  ]);
  if (tvOverflow.some((amount) => amount > 1)) fail(`TV overflow ${tvOverflow}`);
  await tvContext.close();
} catch (error) {
  fail(error.stack || error.message);
} finally {
  if (phones[0]) {
    await phones[0].page.evaluate(async (token) => {
      await fetch("/api/avatar", {
        method: "DELETE",
        headers: { "x-wc-token": token },
      }).catch(() => {});
    }, PHOTO_TOKEN).catch(() => {});
  }
  await Promise.all(phones.map((phone) => phone.context.close()));
  await browser.close();
}

if (errors.length) {
  console.error(`CONSOLE ERRORS:\n${errors.join("\n")}`);
  failures++;
}
console.log(failures ? "THE FIFTH SIGNAL PLAYTEST FAIL" : "THE FIFTH SIGNAL PLAYTEST PASS");
process.exit(failures ? 1 : 0);
