// tests/_resolve.mjs — portable dependency resolution for the browser playtests.
//
// The .mjs playtests drive a real browser through puppeteer-core. It is declared
// as a reproducible dev dependency, but is not vendored. Two ways to satisfy it:
//
//   1. Install the lockfile:    npm ci                       (in the repo root)
//   2. Reuse an existing copy:  export GAMEHUB_NODE_MODULES=/path/to/other/project
//      — handy if you already keep one shared puppeteer install for several
//      projects. Point it at the project directory or straight at its
//      node_modules; both work.
//
// The browser binary itself is separate from the driver library. Override it
// with CHROME_PATH (or PUPPETEER_EXECUTABLE_PATH) if chromium/chrome lives
// somewhere other than the default below:
//
//   CHROME_PATH=/usr/bin/google-chrome node tests/playtest_spades.mjs
//
// Snap-packaged chromium footgun: a snap browser is confined and cannot read
// most of the host's /tmp, so puppeteer's default temp profile dir fails.
// The playtests already work around this by putting userDataDir under $HOME.

import { createRequire } from "module";
import path from "path";

const localRequire = createRequire(import.meta.url);

function sharedRequire() {
  const configured = process.env.GAMEHUB_NODE_MODULES;
  if (!configured) return null;
  const base = path.resolve(configured);
  // createRequire() resolves relative to a FILE, walking up through each
  // parent's node_modules. Anchor it just inside the target project so its
  // node_modules is the first one found.
  const anchorDir = path.basename(base) === "node_modules" ? path.dirname(base) : base;
  return createRequire(path.join(anchorDir, "noop.js"));
}

/**
 * Require a CommonJS dependency, preferring GAMEHUB_NODE_MODULES and falling
 * back to this repo's own node_modules. Throws an actionable error if neither
 * has it.
 */
export function requireModule(name) {
  const attempts = [];
  for (const resolver of [sharedRequire(), localRequire]) {
    if (!resolver) continue;
    try {
      return resolver(name);
    } catch (err) {
      attempts.push(err.message.split("\n")[0]);
    }
  }
  throw new Error(
    `Could not resolve "${name}" for the browser playtests.\n` +
      `  Fix it either way:\n` +
      `    npm i ${name}                      # install it in this repo\n` +
      `    export GAMEHUB_NODE_MODULES=/path/to/a/project/that/has/it\n` +
      (attempts.length ? `  (tried: ${attempts.join(" | ")})` : "")
  );
}

/** Path to the Chrome/Chromium binary puppeteer-core should drive. */
export const CHROME_PATH =
  process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || "/snap/bin/chromium";

export const puppeteer = requireModule("puppeteer-core");
