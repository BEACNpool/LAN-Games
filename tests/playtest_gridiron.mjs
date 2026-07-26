// GRIDIRON: a read-only TV and three isolated touch controllers call hidden
// plays, drive a complete four-possession match, and verify the broadcast,
// timing cues, privacy masking, responsive controls, result, and brag card.
// Usage: node tests/playtest_gridiron.mjs [baseURL] [shotdir]
import fs from "fs";
import os from "os";

import { puppeteer, CHROME_PATH } from "./_resolve.mjs";

const BASE = process.argv[2] || "http://127.0.0.1:8096";
const OUT = process.argv[3] || `${os.homedir()}/tmp/gridiron-shots`;
fs.mkdirSync(OUT, { recursive: true });

const TV = { width: 1440, height: 810, deviceScaleFactor: 1 };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const SMALL_PHONE = { width: 360, height: 740, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const NAMES = ["ACE", "NOVA", "REX"];
const profile = fs.mkdtempSync(`${os.homedir()}/tmp/ghshot-gridiron-`);
const errors = [];
let failures = 0;
let step = "boot";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
const fail = (message) => { failures++; console.error(`FAIL @ ${step}: ${message}`); };

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
  log(`shot: ${name}`);
}

async function makePhone(index, viewport = PHONE) {
  const context = await newContext();
  const page = await context.newPage();
  await page.setViewport(viewport);
  watch(page, NAMES[index]);
  await page.goto(`${BASE}/games/gridiron/`, { waitUntil: "networkidle2" });
  await page.waitForSelector("#scr-join:not([hidden])", { timeout: 8000 });
  await page.type("#name-input", NAMES[index]);
  await page.evaluate((avatarIndex) => {
    document.querySelectorAll("#avatar-grid .avatar-cell")[avatarIndex]?.click();
  }, index * 3);
  await page.click("#join-btn");
  await page.waitForSelector("#scr-lobby:not([hidden])", { timeout: 8000 });
  return { context, page, name: NAMES[index] };
}

async function phonePhase(page) {
  return page.evaluate(() => window.__gridironPhone?.phase?.() || null);
}

async function teamAndPid(page) {
  return page.evaluate(() => {
    const state = window.__gridironPhone?.state?.();
    const me = state?.game?.me || state?.game?.you || state?.game?.private || {};
    return {
      team: String(me.team ?? me.team_id ?? me.side ?? ""),
      pid: state?.you?.pid ?? me.pid ?? null,
      role: me.role ?? me.position ?? null,
    };
  });
}

async function callVisiblePlay(page) {
  return page.evaluate(() => {
    const card = document.querySelector('.play-card[data-play="deep"]')
      || document.querySelector('.play-card[data-play="blitz"]')
      || document.querySelector(".play-card[data-play]");
    if (!card || card.disabled || card.getBoundingClientRect().height === 0) return null;
    const picked = { id: card.dataset.play, title: card.querySelector("b")?.textContent || "" };
    card.click();
    return picked;
  });
}

async function waitForTVStage(tv, wanted, timeout = 15000) {
  const stages = Array.isArray(wanted) ? wanted : [wanted];
  await tv.waitForFunction(
    (allowed) => allowed.includes(window.__gridironTV?.normalized?.()?.stage),
    { timeout },
    stages,
  );
}

async function checkPhoneLayout(page, label) {
  const layout = await page.evaluate(() => {
    const shown = [...document.querySelectorAll(".phone-screen")].find((screen) => !screen.hidden);
    const targets = [...document.querySelectorAll(
      ".phone-screen:not([hidden]) button:not([disabled]), .phone-screen:not([hidden]) a",
    )].map((element) => {
      const box = element.getBoundingClientRect();
      return { name: element.id || element.className, width: box.width, height: box.height };
    }).filter((target) => target.width > 0 && target.height > 0);
    return {
      shown: shown?.id,
      overflowX: document.documentElement.scrollWidth - innerWidth,
      small: targets.filter((target) => target.width < 44 || target.height < 44).slice(0, 8),
    };
  });
  if (layout.overflowX > 1) fail(`${label} horizontal overflow ${layout.overflowX}px`);
  if (layout.small.length) fail(`${label} sub-44px controls ${JSON.stringify(layout.small)}`);
}

async function holdSteer(page, direction = "right") {
  const selector = direction === "left" ? ".steer-buttons .steer-btn:first-child"
    : ".steer-buttons .steer-btn:last-child";
  const box = await page.$eval(selector, (element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }).catch(() => null);
  if (!box) return false;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await sleep(150);
  const value = await page.evaluate(() => window.__gridironPhone.steer());
  await page.mouse.up();
  if (Math.abs(value) < .5) fail(`touch steering did not move: ${value}`);
  return true;
}

async function clickTimingAction(phones, cue) {
  if (!cue) return false;
  const wanted = cue.kind === "catch" ? "catch" : cue.kind === "tackle" ? "tackle" : null;
  if (!wanted) return false;
  for (const phone of phones) {
    const identity = await teamAndPid(phone.page);
    if (cue.target != null && String(identity.pid) !== String(cue.target)) continue;
    const clicked = await phone.page.evaluate((action) => {
      const button = document.querySelector(`[data-action="${action}"]:not([disabled])`);
      if (!button) return false;
      button.click();
      return true;
    }, wanted);
    if (clicked) return true;
  }
  return false;
}

async function driveLiveControls(phones, liveAge, allowFinish) {
  let didSomething = false;
  for (const phone of phones) {
    const mode = await phone.page.evaluate(() => window.__gridironPhone?.control?.());
    if (mode === "qb") {
      const threw = await phone.page.evaluate(() => {
        const open = document.querySelector(".target-btn.open:not([disabled])");
        const first = document.querySelector(".target-btn:not([disabled])");
        const button = open || first;
        if (!button) return false;
        button.click();
        return true;
      });
      if (threw) didSomething = true;
      else if (liveAge > 700) {
        didSomething = await phone.page.evaluate(() => {
          const button = document.querySelector('[data-action="scramble"]:not([disabled])');
          if (!button) return false;
          button.click();
          return true;
        }) || didSomething;
      }
    }
    if (allowFinish && liveAge > 1200) {
      didSomething = await phone.page.evaluate(() => {
        const button = document.querySelector(
          '[data-action="dive"]:not([disabled]), [data-action="tackle"]:not([disabled]), [data-action="catch"]:not([disabled])',
        );
        if (!button) return false;
        button.click();
        return true;
      }) || didSomething;
    }
  }
  return didSomething;
}

const phones = [];
let hubContext = null;
let tvContext = null;
try {
  step = "hub registration";
  hubContext = await newContext();
  const hub = await hubContext.newPage();
  await hub.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  watch(hub, "hub");
  await hub.goto(`${BASE}/`, { waitUntil: "networkidle2" });
  await hub.waitForSelector(".tile-title", { timeout: 8000 });
  const tile = await hub.$$eval(".tile-title", (nodes) =>
    nodes.find((node) => node.textContent.trim() === "GRIDIRON")?.closest(".game-tile, .tile")?.textContent || "");
  if (!tile) fail("GRIDIRON hub tile missing");

  step = "TV boot";
  tvContext = await newContext();
  const tv = await tvContext.newPage();
  await tv.setViewport(TV);
  watch(tv, "TV");
  await tv.goto(`${BASE}/games/gridiron/tv.html`, { waitUntil: "networkidle2" });
  await tv.waitForFunction(() => window.__gridironTV?.state?.() != null, { timeout: 8000 });
  await tv.click("#tv-curtain");
  await tv.waitForSelector("#tv-lobby:not([hidden])", { timeout: 8000 });
  const tvBoot = await tv.evaluate(() => ({
    isTV: window.__gridironTV.isTV(),
    you: window.__gridironTV.state()?.you,
    qr: !!document.querySelector("#tv-qr svg, #tv-qr canvas, #tv-qr img"),
  }));
  if (!tvBoot.isTV || tvBoot.you !== null) fail(`TV was not a read-only watcher: ${JSON.stringify(tvBoot)}`);
  if (!tvBoot.qr) fail("TV join QR did not render");

  step = "join controllers";
  phones.push(await makePhone(0), await makePhone(1, SMALL_PHONE), await makePhone(2));
  await tv.waitForFunction(() => document.querySelectorAll(".lobby-player").length === 3, { timeout: 8000 });
  await shot(tv, "01-tv-lobby");
  await shot(phones[1].page, "02-phone-lobby-360x740");
  await checkPhoneLayout(phones[0].page, "390x844 lobby");
  await checkPhoneLayout(phones[1].page, "360x740 lobby");

  step = "short match settings";
  const pickedFour = await phones[0].page.evaluate(() => {
    const button = [...document.querySelectorAll("#opt-possessions button")]
      .find((item) => item.textContent.trim() === "4");
    button?.click();
    return !!button;
  });
  if (!pickedFour) fail("four-possession setting missing");
  for (const phone of phones) {
    await phone.page.click("#ready-btn");
    await sleep(130);
  }
  await phones[0].page.waitForSelector("#start-btn:not([hidden])", { timeout: 8000 });
  await phones[0].page.click("#start-btn");
  await Promise.all(phones.map((phone) =>
    phone.page.waitForSelector("#scr-game:not([hidden])", { timeout: 12000 })));
  await waitForTVStage(tv, "huddle", 12000);

  step = "huddle masking";
  const maskBefore = await tv.evaluate(() => {
    const state = window.__gridironTV.state();
    const game = state?.game || {};
    const forbidden = new Set([
      "me", "private", "play_cards", "play_choices", "playbook",
      "available_plays", "selected_play", "my_play", "play_call", "called_play",
    ]);
    const found = [];
    const walk = (value, path = "") => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (forbidden.has(key)) found.push(`${path}.${key}`);
        walk(child, `${path}.${key}`);
      }
    };
    walk(game, "game");
    return {
      found,
      routes: game.field?.routes?.length ?? game.routes?.length ?? 0,
      leakedCalls: (game.play_status || []).filter((row) => row && Object.prototype.hasOwnProperty.call(row, "play")),
    };
  });
  if (maskBefore.found.length) fail(`TV private keys leaked: ${maskBefore.found.join(", ")}`);
  if (maskBefore.routes) fail(`huddle leaked ${maskBefore.routes} routes`);
  if (maskBefore.leakedCalls.length) fail(`huddle leaked play IDs: ${JSON.stringify(maskBefore.leakedCalls)}`);

  const callers = [];
  for (let index = 0; index < phones.length; index++) {
    const card = await phones[index].page.evaluate(() => {
      const element = document.querySelector(".play-card[data-play]");
      return element ? { id: element.dataset.play, title: element.querySelector("b")?.textContent || "" } : null;
    });
    if (card) callers.push({ index, ...(await teamAndPid(phones[index].page)), ...card });
  }
  const callersByTeam = [...new Map(callers.map((caller) => [caller.team, caller])).values()];
  if (callersByTeam.length < 2) {
    fail(`did not find both hidden callers: ${JSON.stringify(callers)}`);
  }
  const firstCalls = [];
  if (callersByTeam[0]) {
    const call = await callVisiblePlay(phones[callersByTeam[0].index].page);
    if (call) firstCalls.push({ ...callersByTeam[0], ...call });
  }
  await tv.waitForFunction(() => {
    const status = window.__gridironTV.state()?.game?.play_status || [];
    return window.__gridironTV.normalized()?.stage === "huddle"
      && status.filter((row) => row?.locked).length >= 1;
  }, { timeout: 8000 });
  const maskAfter = await tv.evaluate(() =>
    (window.__gridironTV.state()?.game?.play_status || [])
      .map((row) => ({ team: row.team, locked: row.locked, hasPlay: Object.prototype.hasOwnProperty.call(row, "play") })));
  if (maskAfter.some((row) => row.hasPlay)) fail(`locked huddle calls leaked to TV: ${JSON.stringify(maskAfter)}`);
  await shot(phones[callersByTeam[0]?.index || 0].page, "03-phone-private-play-locked");
  if (callersByTeam[1]) {
    const call = await callVisiblePlay(phones[callersByTeam[1].index].page);
    if (call) firstCalls.push({ ...callersByTeam[1], ...call });
  }

  step = "drive complete match";
  const started = Date.now();
  let lastPhase = "";
  let liveStarted = 0;
  let sawSetup = false;
  let sawLive = false;
  let sawWhistle = false;
  let sawTimingCue = false;
  let setupShot = false;
  let liveShot = false;
  let whistleShot = false;
  let cueShot = false;
  let steeringChecked = false;
  while (Date.now() - started < 600000) {
    const phase = await phonePhase(phones[0].page);
    if (phase === "game_end") break;
    const view = await tv.evaluate(() => window.__gridironTV.normalized());
    const enteredPhase = phase !== lastPhase;
    if (enteredPhase) {
      log(`phase ${phase} · drive ${view?.possessionNo || "?"} · down ${view?.down || "?"}`);
      if (phase === "live") liveStarted = Date.now();
      lastPhase = phase;
    }

    if (phase === "huddle") {
      if (enteredPhase) {
        for (const phone of phones) await callVisiblePlay(phone.page);
      }
    } else if (phase === "setup") {
      sawSetup = true;
      if (!setupShot) {
        await waitForTVStage(tv, "setup", 5000);
        await sleep(250);
        const routes = await tv.evaluate(() => window.__gridironTV.normalized()?.routes?.length || 0);
        if (!routes) fail("setup did not publish formation routes to the TV");
        await shot(tv, "04-tv-formation-routes");
        await shot(phones[0].page, "05-phone-look-up-setup");
        setupShot = true;
      }
    } else if (phase === "live") {
      sawLive = true;
      const age = Date.now() - liveStarted;
      const cue = await tv.evaluate(() => window.__gridironTV.cue());
      if (cue && !cueShot) {
        sawTimingCue = true;
        await shot(tv, `06-tv-${cue.kind}-window`);
        cueShot = true;
      }
      if (cue) await clickTimingAction(phones, cue);
      if (!liveShot && age > 250) {
        await shot(tv, "07-tv-ball-live");
        await shot(phones[0].page, "08-phone-touch-controller");
        liveShot = true;
        await checkPhoneLayout(phones[0].page, "live controller");
      }
      if (!steeringChecked) {
        for (const phone of phones) {
          const mode = await phone.page.evaluate(() => __gridironPhone.control());
          if (["carrier", "defender"].includes(mode)) {
            steeringChecked = await holdSteer(phone.page, mode === "carrier" ? "right" : "left");
            break;
          }
        }
      }
      await driveLiveControls(phones, age, !!cue || age > 2600);
    } else if (phase === "whistle") {
      sawWhistle = true;
      if (!whistleShot) {
        await waitForTVStage(tv, "whistle", 5000);
        await sleep(280);
        await shot(tv, "09-tv-whistle-replay");
        whistleShot = true;
      }
    }
    await sleep(110);
  }

  if (!sawSetup || !sawLive || !sawWhistle) {
    fail(`phase coverage setup=${sawSetup} live=${sawLive} whistle=${sawWhistle}`);
  }
  if (!sawTimingCue) fail("never observed a public catch/tackle timing window");
  if (!steeringChecked) fail("never exercised touch steering");

  step = "final";
  await Promise.all(phones.map((phone) =>
    phone.page.waitForSelector("#gameover:not([hidden])", { timeout: 12000 })));
  await tv.waitForSelector("#tv-results:not([hidden])", { timeout: 12000 });
  await shot(tv, "10-tv-final");
  await shot(phones[0].page, "11-phone-final");
  const final = await tv.evaluate(() => {
    const view = window.__gridironTV.normalized();
    const overflow = [
      document.documentElement.scrollWidth - innerWidth,
      document.documentElement.scrollHeight - innerHeight,
    ];
    return { stage: view?.stage, result: view?.result, overflow };
  });
  if (final.stage !== "game_end" || !final.result) fail(`incomplete TV result: ${JSON.stringify(final)}`);
  if (final.overflow.some((value) => value > 1)) fail(`TV overflow ${JSON.stringify(final.overflow)}`);

  step = "brag card";
  let bragPhone = phones[0];
  for (const phone of phones) {
    if (await phone.page.$(".brag-btn-go")) { bragPhone = phone; break; }
  }
  const clickedBrag = await bragPhone.page.evaluate(() => {
    const button = document.querySelector(".brag-btn-go");
    if (!button) return false;
    button.click();
    return true;
  });
  if (!clickedBrag) fail("brag button missing");
  else {
    await bragPhone.page.waitForSelector("#brag-modal:not([hidden])", { timeout: 8000 });
    const bragSize = await bragPhone.page.$eval("#brag-img", (image) =>
      [image.naturalWidth, image.naturalHeight]);
    if (bragSize[0] !== 1080 || bragSize[1] !== 1080) fail(`brag card was ${bragSize.join("x")}`);
    await shot(bragPhone.page, "12-brag-1080-square");
  }

  step = "console";
  log(errors.length ? `CONSOLE ERRORS:\n${errors.join("\n")}` : "zero console/page errors");
  if (errors.length) failures++;
} catch (error) {
  fail(error.stack || error.message);
} finally {
  await Promise.all(phones.map((phone) => phone.context.close().catch(() => {})));
  if (tvContext) await tvContext.close().catch(() => {});
  if (hubContext) await hubContext.close().catch(() => {});
  await browser.close();
}

console.log(failures ? "GRIDIRON PLAYTEST FAIL" : "GRIDIRON PLAYTEST PASS");
process.exit(failures ? 1 : 0);
