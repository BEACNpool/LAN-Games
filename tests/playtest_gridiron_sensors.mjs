// GRIDIRON sensor gate: exercise the iOS-style permission handshake, live
// orientation steering, reload behavior, and the complete touch fallback.
//
// This is still browser automation, not an iPhone/WebKit substitute. The
// release checklist also requires one physical-iPhone grant/deny/reload pass.
//
// Usage: node tests/playtest_gridiron_sensors.mjs [baseURL]
import fs from "fs";
import os from "os";

import { puppeteer, CHROME_PATH } from "./_resolve.mjs";

const BASE = process.argv[2] || "http://127.0.0.1:8096";
const PHONE = {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
};
const profile = fs.mkdtempSync(`${os.homedir()}/tmp/gh-gridiron-sensors-`);
const errors = [];
const results = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(condition, message, detail = "") {
  if (!condition) {
    throw new Error(`${message}${detail ? `: ${detail}` : ""}`);
  }
  results.push(message);
  console.log(`PASS: ${message}`);
}

async function sensorStatus(page) {
  return page.evaluate(() => window.__gridironPhone?.sensorStatus?.() || null);
}

async function permissionCalls(page) {
  return page.evaluate(() => window.__gridironSensorTest?.calls || []);
}

async function clickVisibleMotionButton(page) {
  const selector = await page.evaluate(() => {
    const screen = [...document.querySelectorAll(".phone-screen")]
      .find((node) => !node.hidden);
    if (!screen?.id || !screen.querySelector("[data-enable-motion]")) return null;
    return `#${screen.id} [data-enable-motion]`;
  });
  check(!!selector, "visible Enable Motion button exists");
  await page.click(selector);
}

async function dispatchOrientation(page, beta, gamma) {
  await page.evaluate(({ beta: nextBeta, gamma: nextGamma }) => {
    window.dispatchEvent(new DeviceOrientationEvent("deviceorientation", {
      alpha: 0,
      beta: nextBeta,
      gamma: nextGamma,
      absolute: false,
    }));
  }, { beta, gamma });
}

async function waitForPhase(page, phase, timeout = 12000) {
  await page.waitForFunction(
    (wanted) => window.__gridironPhone?.phase?.() === wanted,
    { timeout },
    phase,
  );
}

async function pickPlay(page, preferred, label) {
  await page.waitForSelector(".play-card[data-play]:not([disabled])", { timeout: 5000 });
  const picked = await page.evaluate((play) => {
    const card = document.querySelector(`.play-card[data-play="${play}"]:not([disabled])`)
      || document.querySelector(".play-card[data-play]:not([disabled])");
    if (!card) return null;
    card.click();
    return card.dataset.play;
  }, preferred);
  check(!!picked, `${label} private play call remains usable`);
}

function watchPage(page, label) {
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`${label} console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`${label} pageerror: ${error.message}`));
}

async function installSensorMocks(page) {
  /*
   * Model the current iOS API shape before application code runs. The capture
   * listener records whether both permission calls happen synchronously inside
   * the trusted Enable Motion click; resolving the Promises happens later.
   */
  await page.evaluateOnNewDocument(() => {
    const sensorTest = {
      calls: [],
      inClickDispatch: false,
      clickTrusted: false,
      callsAtClickEnd: 0,
      angle: 0,
    };
    Object.defineProperty(window, "__gridironSensorTest", {
      configurable: true,
      value: sensorTest,
    });

    window.addEventListener("click", (event) => {
      if (!event.target?.closest?.("[data-enable-motion]")) return;
      sensorTest.inClickDispatch = true;
      sensorTest.clickTrusted = event.isTrusted;
    }, true);
    window.addEventListener("click", (event) => {
      if (!event.target?.closest?.("[data-enable-motion]")) return;
      sensorTest.callsAtClickEnd = sensorTest.calls.length;
      sensorTest.inClickDispatch = false;
      sensorTest.clickTrusted = false;
    });

    const requestPermission = (kind) => {
      sensorTest.calls.push({
        kind,
        insideClick: sensorTest.inClickDispatch,
        clickTrusted: sensorTest.clickTrusted,
        userActive: navigator.userActivation?.isActive ?? null,
      });
      return Promise.resolve(localStorage.getItem("gridiron-sensor-mode") || "granted");
    };

    class FakeDeviceOrientationEvent extends Event {
      constructor(type, init = {}) {
        super(type, init);
        this.alpha = init.alpha ?? null;
        this.beta = init.beta ?? null;
        this.gamma = init.gamma ?? null;
        this.absolute = init.absolute ?? false;
      }
      static requestPermission() {
        return requestPermission("orientation");
      }
    }
    class FakeDeviceMotionEvent extends Event {
      constructor(type, init = {}) {
        super(type, init);
        this.acceleration = init.acceleration ?? null;
        this.accelerationIncludingGravity = init.accelerationIncludingGravity ?? null;
        this.rotationRate = init.rotationRate ?? null;
        this.interval = init.interval ?? 16;
      }
      static requestPermission() {
        return requestPermission("motion");
      }
    }
    Object.defineProperty(window, "DeviceOrientationEvent", {
      configurable: true,
      writable: true,
      value: FakeDeviceOrientationEvent,
    });
    Object.defineProperty(window, "DeviceMotionEvent", {
      configurable: true,
      writable: true,
      value: FakeDeviceMotionEvent,
    });
    // Chromium's headless mobile mode reports its gesture policy as a console
    // error when the app attempts optional Android haptics. Haptics are outside
    // this sensor contract, so keep that unrelated browser warning out.
    Object.defineProperty(navigator, "vibrate", {
      configurable: true,
      value: () => true,
    });

    try {
      Object.defineProperty(screen.orientation, "angle", {
        configurable: true,
        get: () => sensorTest.angle,
      });
    } catch {
      Object.defineProperty(screen, "orientation", {
        configurable: true,
        value: { get angle() { return sensorTest.angle; } },
      });
    }
  });
}

const browser = await puppeteer.launch({
  executablePath: CHROME_PATH,
  headless: "new",
  userDataDir: profile,
  args: ["--no-sandbox", "--disable-gpu"],
});

try {
  const deniedContext = await browser.createBrowserContext();
  const denied = await deniedContext.newPage();
  await denied.setViewport(PHONE);
  watchPage(denied, "denied phone");
  await installSensorMocks(denied);
  await denied.goto(`${BASE}/games/gridiron/`, { waitUntil: "networkidle2" });
  await denied.waitForSelector("#scr-join:not([hidden])", { timeout: 8000 });
  await denied.evaluate(() => localStorage.setItem("gridiron-sensor-mode", "denied"));

  check(await sensorStatus(denied) === "gated",
    "denied phone starts behind the motion gate");
  await clickVisibleMotionButton(denied);
  await denied.waitForFunction(
    () => window.__gridironSensorTest?.calls.length === 2
      && window.__gridironPhone?.sensorStatus?.() === "fallback",
    { timeout: 3000 },
  );
  const deniedCalls = await permissionCalls(denied);
  check(deniedCalls.map((call) => call.kind).sort().join(",") === "motion,orientation",
    "denied path requests both iOS permission APIs");
  check(deniedCalls.every((call) => call.insideClick && call.clickTrusted),
    "denied permission calls run inside the trusted click",
    JSON.stringify(deniedCalls));
  check(await sensorStatus(denied) === "fallback",
    "denied permission enters explicit touch mode");
  await denied.type("#name-input", "TOUCH");
  await denied.click("#join-btn");
  await denied.waitForSelector("#scr-lobby:not([hidden])", { timeout: 8000 });

  const grantContext = await browser.createBrowserContext();
  const granted = await grantContext.newPage();
  await granted.setViewport(PHONE);
  watchPage(granted, "granted phone");
  await installSensorMocks(granted);
  await granted.goto(`${BASE}/games/gridiron/`, { waitUntil: "networkidle2" });
  await granted.waitForSelector("#scr-join:not([hidden])", { timeout: 8000 });

  check(await sensorStatus(granted) === "gated", "motion is gated on first load");
  await clickVisibleMotionButton(granted);
  await granted.waitForFunction(
    () => window.__gridironSensorTest?.calls.length === 2
      && window.__gridironPhone?.sensorStatus?.() === "reading",
    { timeout: 3000 },
  );
  const grantCalls = await permissionCalls(granted);
  check(grantCalls.map((call) => call.kind).sort().join(",") === "motion,orientation",
    "both iOS permission APIs are requested");
  check(grantCalls.every((call) => call.insideClick && call.clickTrusted),
    "both permission APIs run synchronously inside the trusted click",
    JSON.stringify(grantCalls));
  check(await granted.evaluate(() => window.__gridironSensorTest.callsAtClickEnd) === 2,
    "both permission calls finish before the Enable Motion click bubbles");
  check(grantCalls.every((call) => call.userActive !== false),
    "permission calls retain browser user activation",
    JSON.stringify(grantCalls));

  await dispatchOrientation(granted, 10, 5);
  await granted.waitForFunction(
    () => window.__gridironPhone?.sensorStatus?.() === "active",
    { timeout: 3000 },
  );
  check(await sensorStatus(granted) === "active",
    "granted permission plus a useful reading activates motion");

  await granted.type("#name-input", "SENSOR");
  await granted.click("#join-btn");
  await granted.waitForSelector("#scr-lobby:not([hidden])", { timeout: 8000 });
  await denied.evaluate(() => {
    [...document.querySelectorAll("#opt-possessions button")]
      .find((button) => button.textContent.trim() === "4")?.click();
  });
  await denied.click("#ready-btn");
  await granted.click("#ready-btn");
  await denied.waitForSelector("#start-btn:not([hidden])", { timeout: 5000 });
  await denied.click("#start-btn");
  await Promise.all([
    waitForPhase(denied, "huddle"),
    waitForPhase(granted, "huddle"),
  ]);
  await Promise.all([
    pickPlay(denied, "slant", "touch phone"),
    pickPlay(granted, "press", "motion phone"),
  ]);
  await Promise.all([
    waitForPhase(denied, "setup"),
    waitForPhase(granted, "setup"),
  ]);

  for (let sample = 0; sample < 5; sample += 1) {
    await dispatchOrientation(granted, 10, 5);
    await sleep(60);
  }
  await Promise.all([
    waitForPhase(denied, "live", 8000),
    waitForPhase(granted, "live", 8000),
  ]);
  check(await denied.evaluate(() => window.__gridironPhone.control()) === "qb",
    "touch-mode phone receives the quarterback control");
  check(await sensorStatus(denied) === "fallback",
    "touch mode remains active when the play goes live");

  await denied.waitForSelector(".target-btn.open:not([disabled])", { timeout: 3000 });
  const touchTarget = await denied.$eval(".target-btn.open:not([disabled])", (button) => {
    const box = button.getBoundingClientRect();
    return {
      width: box.width,
      height: box.height,
      label: button.textContent.trim(),
    };
  });
  check(touchTarget.width >= 44 && touchTarget.height >= 44,
    "denied motion leaves a finger-sized touch throw control",
    JSON.stringify(touchTarget));
  await denied.click(".target-btn.open:not([disabled])");
  await granted.waitForFunction(
    () => window.__gridironPhone?.control?.() === "defender"
      && !!document.querySelector(".steer-buttons"),
    { timeout: 3000 },
  );
  check(await granted.evaluate(() => window.__gridironPhone.control()) === "defender",
    "touch throw is accepted after motion denial");

  await granted.evaluate(() => { window.__gridironSensorTest.angle = 270; });
  const reportedAngle = await granted.evaluate(() => screen.orientation?.angle);
  check(reportedAngle === 270, "test phone reports screen orientation angle 270");

  await dispatchOrientation(granted, 10, 5);
  await sleep(130);
  let steer = await granted.evaluate(() => window.__gridironPhone.steer());
  check(Math.abs(steer) < 0.05, "dispatched baseline orientation maps to center", `steer=${steer}`);

  await dispatchOrientation(granted, 40, 5);
  await sleep(130);
  steer = await granted.evaluate(() => window.__gridironPhone.steer());
  check(steer < -0.95,
    "angle 270 maps a +30° beta delta to full left", `steer=${steer}`);

  await dispatchOrientation(granted, -20, 5);
  await sleep(130);
  steer = await granted.evaluate(() => window.__gridironPhone.steer());
  check(steer > 0.95,
    "angle 270 maps a -30° beta delta to full right", `steer=${steer}`);

  await granted.reload({ waitUntil: "networkidle2" });
  await granted.waitForFunction(() => window.__gridironPhone?.sensorStatus?.() === "gated",
    { timeout: 5000 });
  check(await sensorStatus(granted) === "gated",
    "reload re-gates motion after an earlier grant");
  check((await permissionCalls(granted)).length === 0,
    "reload never requests sensor permission without a new gesture");

  check(errors.length === 0, "sensor gate produced no browser errors",
    errors.join(" | "));
  console.log(`GRIDIRON sensor playtest passed (${results.length} checks).`);
} catch (error) {
  console.error(`GRIDIRON sensor playtest failed: ${error.stack || error.message}`);
  if (errors.length) console.error(`Browser errors: ${errors.join(" | ")}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
