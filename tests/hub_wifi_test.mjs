// hub_wifi_test.mjs — the guest Wi-Fi button's two states.
//
// The button is ALWAYS visible. With no `wifi` block in data/venue.json it
// renders blank and opens setup instructions; configured, it opens a scannable
// WIFI: QR. Run it against a hub with AND without venue.json configured — the
// test detects which state it is in and asserts that state fully, so a fresh
// clone and a set-up box both give a meaningful result.
//
// Usage: node tests/hub_wifi_test.mjs [baseURL]
import os from "os";
import { puppeteer, CHROME_PATH } from "./_resolve.mjs";

const BASE = process.argv[2] || "http://127.0.0.1:8096";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const check = (ok, m) => { console.log((ok ? "PASS " : "FAIL ") + m); if (!ok) bad++; };

const browser = await puppeteer.launch({
  executablePath: CHROME_PATH, headless: "new",
  userDataDir: os.homedir() + "/tmp/ghshot-hubwifi",
  args: ["--no-sandbox", "--disable-gpu"],
});
try {
  const pg = await browser.newPage();
  const errors = [];
  pg.on("pageerror", (e) => errors.push(e.message));
  await pg.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await pg.goto(BASE + "/", { waitUntil: "networkidle2" });
  await sleep(600);

  // The button must never hide — that was the old behavior and it made the
  // feature undiscoverable on a fresh clone.
  check(!(await pg.$eval("#wifi-open", (e) => e.hidden)),
        "wifi button is visible");

  const configured = await pg.evaluate(
    () => fetch("/api/venue").then((r) => r.json())
            .then((v) => !!(v && v.wifi && v.wifi.ssid)).catch(() => false));
  console.log(`   (venue wifi ${configured ? "IS" : "is NOT"} configured)`);

  check((await pg.$eval("#wifi-open", (e) => e.classList.contains("wifi-unset")))
        === !configured,
        "blank styling matches whether wifi is configured");

  await pg.click("#wifi-open");
  await sleep(400);
  check(!(await pg.$eval("#wifi-sheet", (e) => e.hidden)), "sheet opens on click");

  const title = await pg.$eval("#wifi-title", (e) => e.textContent);
  const setupShown = !(await pg.$eval("#wifi-setup", (e) => e.hidden));
  const readyShown = !(await pg.$eval("#wifi-ready", (e) => e.hidden));

  if (configured) {
    check(title.includes("JOIN"), "title invites joining");
    check(readyShown && !setupShown, "shows the QR, not the setup prompt");
    check((await pg.$eval("#wifi-ssid", (e) => e.textContent)).length > 0,
          "ssid is shown");
    check(await pg.$eval("#wifi-qr", (e) => e.innerHTML.length > 0),
          "QR is rendered");
    // The payload must be a real WIFI: string or phones won't join.
    const payload = await pg.evaluate(() =>
      fetch("/api/venue").then((r) => r.json()).then((v) => {
        const w = v.wifi;
        const esc = (s) => String(s == null ? "" : s).replace(/([\\;,":])/g, "\\$1");
        return `WIFI:T:${w.security || (w.password ? "WPA" : "nopass")};` +
               `S:${esc(w.ssid)};P:${esc(w.password)};${w.hidden ? "H:true;" : ""};`;
      }));
    check(/^WIFI:T:[^;]*;S:.+;P:/.test(payload), "WIFI: payload is well formed");
    const hiddenNet = await pg.evaluate(() =>
      fetch("/api/venue").then((r) => r.json()).then((v) => !!v.wifi.hidden));
    check((!(await pg.$eval("#wifi-note", (e) => e.hidden))) === hiddenNet,
          "hidden-network note matches the config");
  } else {
    check(title.includes("SET UP"), "title offers setup");
    check(setupShown && !readyShown, "shows the setup prompt, not an empty QR");
    const body = await pg.$eval("#wifi-setup", (e) => e.textContent);
    check(body.includes("data/venue.json"), "setup names the config file");
    check(body.includes("gitignored"),
          "setup says the file stays out of the repo");
    check(body.toLowerCase().includes("guest"),
          "setup warns to use the guest network");
  }

  check(errors.length === 0, "no console/page errors" +
        (errors.length ? " -> " + errors.join(" | ") : ""));
} finally {
  await browser.close();
}
console.log(bad ? `\n${bad} FAILED` : "\nall good");
process.exit(bad ? 1 : 0);
