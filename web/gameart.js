/* Procedural key art for the LAN Games catalogue and shared game shell.
 *
 * Everything is inline SVG: no CDN, no image downloads, no platform-dependent
 * emoji.  Each title gets a recognisable scene while the lighting, framing and
 * motion stay consistent across the whole library.
 */
"use strict";

window.GameArt = (() => {
  const safe = (value) => String(value || "").replace(/[^a-z0-9-]/gi, "");
  const hex = (value) => /^#[0-9a-f]{6}$/i.test(value || "") ? value : "#22d3ee";

  function shift(color, amount) {
    const n = parseInt(hex(color).slice(1), 16);
    const clamp = (v) => Math.max(0, Math.min(255, v));
    const r = clamp((n >> 16) + amount);
    const g = clamp(((n >> 8) & 255) + Math.round(amount * 0.55));
    const b = clamp((n & 255) - Math.round(amount * 0.35));
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }

  const ball = (x, y, r = 26, cls = "ga-a") =>
    `<circle class="${cls}" cx="${x}" cy="${y}" r="${r}"/>`;
  const tile = (x, y, w, h, text = "", cls = "ga-panel") =>
    `<g><rect class="${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="10"/>`
    + (text ? `<text class="ga-label" x="${x + w / 2}" y="${y + h * .64}" text-anchor="middle">${text}</text>` : "")
    + "</g>";

  const motifs = {
    brickade: `
      <g class="ga-drift">${[0, 1, 2, 3].map((r) =>
        [0, 1, 2].map((c) => `<rect class="${(r + c) % 3 ? "ga-panel" : "ga-b"}"
          x="${35 + c * 76}" y="${70 + r * 38}" width="60" height="25" rx="6"/>`).join("")).join("")}</g>
      <path class="ga-streak" d="M48 310 Q132 210 236 128"/>
      ${ball(224, 139, 17, "ga-core ga-pulse")}
      <path class="ga-a ga-solid" d="M53 335h194l-15 17H68z"/>`,
    dodgeball: `
      <path class="ga-line" d="M34 303L266 99M54 336L278 139M23 220h254"/>
      <circle class="ga-b ga-ring ga-spin" cx="173" cy="198" r="81"/>
      ${ball(174, 197, 57, "ga-core ga-float")}
      <path class="ga-cut" d="M120 163q54 31 108 0M122 232q52-31 104 0M174 140v115"/>
      <path class="ga-streak" d="M32 318Q80 282 121 236"/>`,
    smelterskelter: `
      <g class="ga-float" transform="rotate(-18 150 200)">
        <rect class="ga-ring" x="58" y="68" width="72" height="115" rx="36"/>
        <rect class="ga-ring ga-b-stroke" x="118" y="144" width="72" height="115" rx="36"/>
        <rect class="ga-ring" x="178" y="220" width="72" height="115" rx="36"/>
      </g>
      <path class="ga-streak" d="M151 28v118"/>
      <circle class="ga-core ga-pulse" cx="151" cy="150" r="13"/>
      <path class="ga-b ga-solid" d="M116 322h70l24 32h-118z"/>`,
    fifthsignal: `
      <g class="ga-spin">
        <circle class="ga-ring" cx="150" cy="191" r="111"/>
        <circle class="ga-b-stroke ga-ring" cx="150" cy="191" r="72"/>
        <path class="ga-line" d="M150 80v222M39 191h222M70 120l160 142M230 120L70 262"/>
      </g>
      <g class="ga-drift">
        <circle class="ga-panel" cx="150" cy="72" r="22"/>
        <circle class="ga-b" cx="257" cy="157" r="22"/>
        <circle class="ga-panel" cx="216" cy="287" r="22"/>
        <circle class="ga-b" cx="84" cy="287" r="22"/>
        <circle class="ga-panel" cx="43" cy="157" r="22"/>
      </g>
      <circle class="ga-core ga-pulse" cx="150" cy="191" r="38"/>
      <path class="ga-cut-stroke" d="M121 191h13l8-18 14 37 9-19h15"/>
      <path class="ga-streak" d="M45 337Q150 300 255 337"/>`,
    buzzboard: `
      <g class="ga-drift">${[0, 1, 2].map((r) => [0, 1, 2].map((c) =>
        tile(39 + c * 76, 72 + r * 66, 61, 48, c === 1 && r === 1 ? "?" : `${(r + 1) * 2}00`,
          c === 1 && r === 1 ? "ga-core" : "ga-panel")).join("")).join("")}</g>
      <circle class="ga-b ga-ring ga-pulse" cx="150" cy="313" r="37"/>
      <circle class="ga-core" cx="150" cy="313" r="21"/>`,
    bingo: `
      <g class="ga-drift">
        ${ball(78, 123, 45, "ga-panel")}${ball(192, 105, 35, "ga-b")}
        ${ball(224, 225, 50, "ga-panel")}${ball(91, 254, 40, "ga-core")}
        <text class="ga-ball-label" x="78" y="138">B</text>
        <text class="ga-ball-label" x="192" y="116">7</text>
        <text class="ga-ball-label" x="224" y="241">O</text>
        <text class="ga-ball-label ga-dark" x="91" y="267">5</text>
      </g>
      <path class="ga-streak" d="M43 342Q132 294 272 279"/>`,
    pricecheck: `
      <g class="ga-float" transform="rotate(-10 150 195)">
        <path class="ga-panel ga-solid" d="M48 112h145l63 74-116 116-92-92z"/>
        <circle class="ga-cut-stroke" cx="85" cy="151" r="14"/>
        <path class="ga-core ga-solid" d="M118 163h86v17h-86zm0 38h65v17h-65z"/>
      </g>
      <text class="ga-price" x="154" y="323">$?</text>`,
    orbitriot: `
      <g class="ga-spin">
        <circle class="ga-ring" cx="150" cy="196" r="113"/>
        <circle class="ga-b-stroke ga-ring" cx="150" cy="196" r="72"/>
        <ellipse class="ga-line" cx="150" cy="196" rx="128" ry="48" transform="rotate(-22 150 196)"/>
      </g>
      <circle class="ga-hole" cx="150" cy="196" r="38"/>
      <circle class="ga-core ga-pulse" cx="236" cy="126" r="15"/>
      <path class="ga-streak" d="M282 75Q248 89 232 121"/>`,
    poker: `
      <g class="ga-float" transform="rotate(-12 145 180)">
        ${tile(50, 80, 91, 132, "A", "ga-card")}
        ${tile(117, 69, 91, 132, "K", "ga-card ga-card-b")}
        ${tile(180, 95, 75, 116, "Q", "ga-card")}
      </g>
      <g class="ga-drift">${ball(105, 300, 43, "ga-panel")}${ball(145, 285, 43, "ga-b")}
        ${ball(186, 302, 43, "ga-core")}<path class="ga-cut-stroke" d="M73 300h65m-24-15h64m-23 18h64"/></g>`,
    spades: `
      <path class="ga-core ga-solid ga-float" d="M150 62C129 103 61 139 61 204c0 43 48 57 78 26-5 44-16 65-35 85h92c-19-20-30-41-35-85 30 31 78 17 78-26 0-65-68-101-89-142z"/>
      <path class="ga-line" d="M55 335h190"/>`,
    hearts: `
      <path class="ga-core ga-solid ga-float" d="M150 321C120 277 54 236 54 158c0-74 89-83 96-22 7-61 96-52 96 22 0 78-66 119-96 163z"/>
      <path class="ga-b-stroke ga-ring ga-drift" d="M150 284C125 249 82 215 82 168c0-42 54-48 68-9 14-39 68-33 68 9 0 47-43 81-68 116z"/>`,
    euchre: `
      <g class="ga-float">
        ${tile(47, 91, 82, 123, "J", "ga-card")}
        ${tile(111, 70, 82, 123, "J", "ga-card ga-card-b")}
        ${tile(175, 96, 82, 123, "A", "ga-card")}
      </g>
      <path class="ga-streak" d="M61 308Q146 252 246 310"/>`,
    charades: `
      <g class="ga-float">
        <path class="ga-panel ga-solid" d="M43 116q53-37 106 0v96q-53 63-106 0z"/>
        <path class="ga-b ga-solid" d="M151 103q53-37 106 0v96q-53 63-106 0z"/>
        <path class="ga-cut" d="M67 151q15-15 30 0m17 0q15-15 30 0m33-13q15 15 30 0m17 0q15 15 30 0"/>
        <path class="ga-cut-stroke" d="M75 189q27 24 54 0m47 13q27-24 54 0"/>
      </g>
      <path class="ga-line" d="M150 42v276M59 342h182"/>`,
    trivia: `
      <g class="ga-pulse"><circle class="ga-ring" cx="150" cy="167" r="92"/>
        <circle class="ga-b-stroke ga-ring" cx="150" cy="167" r="65"/>
        <path class="ga-core ga-solid" d="M136 237h28v49h-28zm-24 50h76l19 29H93z"/>
        <circle class="ga-core" cx="150" cy="167" r="38"/></g>
      <path class="ga-streak" d="M47 85l27 23m179-23l-27 23M150 42v34"/>`,
    blitz: `
      <path class="ga-core ga-solid ga-float" d="M169 45L77 216h74l-24 140 97-187h-72z"/>
      <g class="ga-drift"><circle class="ga-panel" cx="71" cy="100" r="28"/><circle class="ga-b" cx="237" cy="274" r="34"/>
        <circle class="ga-panel" cx="62" cy="291" r="15"/></g>`,
    werewolf: `
      <circle class="ga-core ga-pulse" cx="188" cy="137" r="83"/>
      <path class="ga-night ga-solid" d="M166 224l-31-67-23 34-35-56-22 151h197l-23-105-30 43z"/>
      <path class="ga-b ga-solid ga-float" d="M111 296l19-68 20 27 22-27 19 68-40 42z"/>
      <path class="ga-cut" d="M133 283l13 7m24-7l-13 7"/>`,
    famfeud: `
      <rect class="ga-panel" x="34" y="58" width="232" height="260" rx="25"/>
      ${[0, 1, 2, 3].map((r) =>
        `<rect class="${r === 0 ? "ga-core" : "ga-b"}" x="58" y="${85 + r * 49}" width="${150 - r * 13}" height="28" rx="7"/>
         <text class="ga-score" x="232" y="${107 + r * 49}">${r + 1}</text>`).join("")}
      <g class="ga-pulse"><path class="ga-x" d="M107 294l20 20m0-20l-20 20m35-20l20 20m0-20l-20 20m35-20l20 20m0-20l-20 20"/></g>`,
    wordrush: `
      <g class="ga-float">${["R", "U", "S", "H"].map((v, i) => tile(35 + i * 59, 113 + (i % 2) * 14, 50, 60, v,
        i === 2 ? "ga-core" : "ga-card")).join("")}</g>
      <g class="ga-drift">${["W", "O", "R", "D"].map((v, i) => tile(35 + i * 59, 215 - (i % 2) * 12, 50, 60, v,
        i === 0 ? "ga-b" : "ga-panel")).join("")}</g>
      <path class="ga-streak" d="M37 323h226"/>`,
    chess: `
      <path class="ga-core ga-solid ga-float" d="M88 319h142l-13-29h-19l-11-48c35-38 37-96 4-129l-14-52-31 35-51 14 40 45-35 89-11 46H99z"/>
      <path class="ga-cut-stroke" d="M141 122l37 18m-77 104h94M82 319h158"/>
      <circle class="ga-cut" cx="158" cy="121" r="6"/>`,
    checkers: `
      <g transform="rotate(-8 150 200)">${[0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((c) =>
        `<rect class="${(r + c) % 2 ? "ga-panel" : "ga-night"}" x="${47 + c * 52}" y="${91 + r * 52}" width="48" height="48" rx="4"/>`).join("")).join("")}
        ${ball(98, 244, 28, "ga-core")}${ball(202, 140, 28, "ga-b")}
        <circle class="ga-ring ga-cut-stroke" cx="98" cy="244" r="17"/></g>`,
    backgammon: `
      <g class="ga-drift">${[0, 1, 2, 3, 4, 5].map((i) =>
        `<path class="${i % 2 ? "ga-b ga-solid" : "ga-panel ga-solid"}" d="M${34 + i * 39} 80h34l-17 139z"/>`
        + `<path class="${i % 2 ? "ga-panel ga-solid" : "ga-core ga-solid"}" d="M${34 + i * 39} 321h34l-17-92z"/>`).join("")}</g>
      ${tile(98, 170, 48, 48, "•", "ga-card")}${tile(157, 190, 48, 48, "••", "ga-card ga-card-b")}`,
    connect4: `
      <rect class="ga-panel" x="35" y="82" width="230" height="247" rx="25"/>
      <g>${[0, 1, 2, 3, 4, 5].map((r) => [0, 1, 2, 3, 4, 5, 6].map((c) =>
        `<circle class="${r > 3 && (c + r) % 3 === 0 ? "ga-core" : r > 2 && (c + r) % 4 === 0 ? "ga-b" : "ga-hole"}"
          cx="${58 + c * 31}" cy="${108 + r * 36}" r="12"/>`).join("")).join("")}</g>
      <path class="ga-streak" d="M211 46v51"/>`,
    fortfling: `
      <path class="ga-panel ga-solid" d="M30 310V173h28v-33h30v33h29v137zM185 310V173h29v-33h30v33h28v137z"/>
      <path class="ga-core ga-solid" d="M53 310v-59h42v59zm154 0v-59h42v59z"/>
      <path class="ga-streak ga-drift" d="M86 230Q150 73 225 226"/>
      ${ball(160, 120, 13, "ga-b ga-pulse")}`,
    tanks: `
      <path class="ga-night ga-solid" d="M20 301q45-64 92-28t84-15q42-35 84 9v93H20z"/>
      <g class="ga-float"><rect class="ga-panel" x="73" y="227" width="112" height="44" rx="13"/>
        <path class="ga-core ga-solid" d="M101 227l15-30h47l18 30z"/>
        <path class="ga-b-stroke ga-ring" d="M119 198l87-50"/>
        ${ball(99, 275, 22, "ga-b")}${ball(159, 275, 22, "ga-b")}</g>
      <path class="ga-streak" d="M208 145q32-15 56-1"/>`,
    battleship: `
      <g class="ga-spin"><circle class="ga-ring" cx="153" cy="190" r="112"/><circle class="ga-line" cx="153" cy="190" r="72"/>
        <path class="ga-line" d="M153 77v226M40 190h226"/></g>
      <path class="ga-core ga-solid ga-float" d="M49 228l41-49h84l31 29h51l-25 55H74z"/>
      <path class="ga-b-stroke ga-ring" d="M112 177v-46h51v48m-30-48V99"/>`,
    snake: `
      <path class="ga-a-stroke ga-snake" d="M63 294C15 198 125 245 104 161S247 86 243 191s-91 142-152 101"/>
      <circle class="ga-core ga-pulse" cx="244" cy="191" r="25"/>
      <circle class="ga-cut" cx="253" cy="182" r="4"/>
      ${ball(70, 112, 15, "ga-b ga-pulse")}`,
    rummikub: `
      <g class="ga-float">${tile(42, 85, 72, 102, "12", "ga-card")}
        ${tile(114, 111, 72, 102, "7", "ga-card ga-card-b")}
        ${tile(186, 78, 72, 102, "3", "ga-card")}</g>
      <g class="ga-drift">${tile(65, 231, 72, 102, "9", "ga-panel")}
        ${tile(148, 223, 72, 102, "J", "ga-core")}</g>`,
    wordclash: `
      <g>${[0, 1, 2, 3, 4].map((r) => [0, 1, 2, 3, 4].map((c) =>
        `<rect class="${r === 2 && c < 3 ? "ga-core" : r === 3 && c % 2 ? "ga-b" : "ga-panel"}"
          x="${46 + c * 43}" y="${76 + r * 53}" width="36" height="43" rx="6"/>`).join("")).join("")}</g>
      <path class="ga-streak" d="M57 354h186"/>`,
  };

  function fallback(g) {
    const title = String(g.title || "PLAY").split(/\s+/).slice(0, 2)
      .map((part) => part[0]).join("").slice(0, 2);
    return `<circle class="ga-ring ga-spin" cx="150" cy="184" r="103"/>
      <circle class="ga-b-stroke ga-ring" cx="150" cy="184" r="70"/>
      <text class="ga-fallback" x="150" y="207" text-anchor="middle">${title}</text>`;
  }

  function html(game, extraClass = "") {
    const slug = safe(game.slug);
    const accent = hex(game.accent);
    const accent2 = shift(accent, 44);
    return `<div class="game-art game-art--${slug} ${safe(extraClass)}"
      data-game-art="${slug}" style="--ga:${accent};--ga2:${accent2}">
      <span class="ga-ambient ga-ambient-a"></span>
      <span class="ga-ambient ga-ambient-b"></span>
      <svg class="ga-svg" viewBox="0 0 300 400" preserveAspectRatio="xMidYMid slice"
        aria-hidden="true" focusable="false">
        <path class="ga-beam" d="M-42 394L182-12h112L84 410z"/>
        <path class="ga-grid" d="M16 351h268M25 318h250M35 285h230M46 252h208M58 219h184"/>
        ${motifs[slug] || fallback(game)}
      </svg>
      <span class="ga-grain"></span>
      <span class="ga-vignette"></span>
    </div>`;
  }

  function installJoinArt(game) {
    const join = document.querySelector("#scr-join");
    if (!join || join.querySelector(".join-stage-art")) return;
    document.documentElement.dataset.game = safe(game.slug);
    document.documentElement.style.setProperty("--game-accent", hex(game.accent));
    document.documentElement.style.setProperty("--game-accent-2", shift(hex(game.accent), 44));
    const stage = document.createElement("div");
    stage.className = "join-stage-art";
    stage.setAttribute("aria-hidden", "true");
    stage.innerHTML = html(game, "game-art--join");
    join.prepend(stage);
  }

  return { html, installJoinArt };
})();
