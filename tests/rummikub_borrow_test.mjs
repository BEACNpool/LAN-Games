// rummikub_borrow_test.mjs — unit-tests the borrow-off-the-board split logic
// (resplitRun, exposed on window.__rk). Pulling a tile from the middle of a
// run must leave CLEAN consecutive sets, not one gapped/red group.
// Usage: node tests/rummikub_borrow_test.mjs [baseURL]
import { createRequire } from "module";
import os from "os";
const require = createRequire("/home/ubuntudesktop/projects/webdev-toolkit/x.js");
const puppeteer = require("puppeteer-core");

const BASE = process.argv[2] || "http://127.0.0.1:8096";
let bad = 0;
const check = (ok, msg) => { console.log((ok ? "PASS " : "FAIL ") + msg); if (!ok) bad++; };

const browser = await puppeteer.launch({
  executablePath: "/snap/bin/chromium", headless: "new",
  userDataDir: os.homedir() + "/tmp/ghshot-rkborrow",
  args: ["--no-sandbox", "--disable-gpu"],
});
try {
  const pg = await browser.newPage();
  const errors = [];
  pg.on("pageerror", (e) => errors.push(e.message));
  await pg.goto(BASE + "/games/rummikub/", { waitUntil: "networkidle2" });
  await pg.waitForFunction(() => window.__rk && window.__rk.resplitRun, { timeout: 5000 });

  // [input, expected segments, label]
  const cases = [
    [["r01.0", "r02.0", "r03.0", "r05.0", "r06.0", "r07.0"],
     [["r01.0", "r02.0", "r03.0"], ["r05.0", "r06.0", "r07.0"]],
     "pull-middle splits a 7-run into two clean runs"],
    [["r01.0", "r02.0", "r03.0"],
     [["r01.0", "r02.0", "r03.0"]],
     "intact run is left alone"],
    [["y06.0", "y07.0", "y08.0", "y10.0"],
     [["y06.0", "y07.0", "y08.0"], ["y10.0"]],
     "trailing gap peels off the stray tile"],
    [["r07.0", "b07.0", "k07.0"],
     [["r07.0", "b07.0", "k07.0"]],
     "group of a kind is never split"],
    [["r07.0", "b07.0", "y07.0"],
     [["r07.0", "b07.0", "y07.0"]],
     "3-colour group survives even though numbers don't ascend"],
    [["r05.0", "J.0", "r07.0"],
     [["r05.0", "J.0", "r07.0"]],
     "a set holding a joker is left for the player to arrange"],
    [["r01.0", "r02.0", "r04.0", "r05.0", "r07.0"],
     [["r01.0", "r02.0"], ["r04.0", "r05.0"], ["r07.0"]],
     "two gaps make three segments"],
    [["k09.0"],
     [["k09.0"]],
     "a lone tile stays whole"],
  ];
  for (const [input, expected, label] of cases) {
    const got = await pg.evaluate((g) => window.__rk.resplitRun(g), input);
    check(JSON.stringify(got) === JSON.stringify(expected),
      `${label} → ${JSON.stringify(got)}`);
  }
  // full pull path: the REAL removeTileLocally + splitSourceRun composing a borrow
  const pulls = [
    [[["r01.0", "r02.0", "r03.0", "r04.0", "r05.0", "r06.0", "r07.0"]], ["k04.0", "y04.0"], "r04.0",
     [["r01.0", "r02.0", "r03.0"], ["r05.0", "r06.0", "r07.0"], ["r04.0"]],
     "borrow the middle of a 7-run leaves two clean runs + the freed tile"],
    [[["r07.0", "b07.0", "k07.0", "y07.0"]], [], "y07.0",
     [["r07.0", "b07.0", "k07.0"], ["y07.0"]],
     "borrow the 4th of a group leaves a valid group + the freed tile"],
    [[["r01.0", "r02.0", "r03.0", "r04.0"]], [], "r04.0",
     [["r01.0", "r02.0", "r03.0"], ["r04.0"]],
     "borrow the end of a run needs no split"],
  ];
  for (const [groups, hand, tile, expected, label] of pulls) {
    const got = await pg.evaluate((g, h, t) => window.__rk.__test_pullToNew(g, h, t),
      groups, hand, tile);
    check(JSON.stringify(got) === JSON.stringify(expected),
      `${label} → ${JSON.stringify(got)}`);
  }

  check(errors.length === 0, "zero page errors" + (errors.length ? ": " + errors.join(";") : ""));
} finally {
  await browser.close();
}
console.log(bad ? "RUMMIKUB BORROW TEST FAIL" : "RUMMIKUB BORROW TEST PASS");
process.exit(bad ? 1 : 0);
