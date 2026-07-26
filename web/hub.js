// LAN GAMES hub — a console-style dashboard.
// Category rails + party-size filters (driven by /api/games)
// + a docked lobby chat + classic-console flourishes (boot sweep, D-pad).
(() => {
  const $ = (id) => document.getElementById(id);
  const REDUCED = Hub.prefs.reducedFx;

  const RAILS = [
    { key: "bigscreen", title: "BIG SCREEN", ico: "📺" },
    { key: "party",  title: "PARTY NIGHT", ico: "🎉" },
    { key: "cards",  title: "CARDS & TILES", ico: "🃏" },
    { key: "board",  title: "BOARD CLASSICS", ico: "♟️" },
    { key: "battle", title: "ARCADE & BATTLE", ico: "🕹️" },
  ];
  const CAT_LABEL = { bigscreen: "BIG SCREEN", party: "PARTY",
                      cards: "CARDS", board: "BOARD", battle: "ARCADE" };
  const FILTERS = [
    { key: "all",  label: "ALL",     fn: () => true },
    { key: "solo", label: "JUST ME", fn: (g) => g.solo },
    { key: "two",  label: "2 OF US", fn: (g) => g.min_p <= 2 && g.max_p >= 2 },
    { key: "few",  label: "3–4",     fn: (g) => g.min_p <= 4 && g.max_p >= 3 },
    { key: "crowd", label: "5+",     fn: (g) => g.max_p >= 5 },
  ];

  const DEV = new URLSearchParams(location.search).has("dev");
  let games = [];            // launchable entries (registry + external)
  let soon = [];
  let filter = "all";
  const tileLive = {};       // slug -> tile element (for badge updates)
  let selectedGame = null;
  const modalOpeners = new WeakMap();

  function showSheet(id, focusId, fallbackOpenerId) {
    const sheet = $(id);
    let opener = document.activeElement;
    if (!(opener instanceof HTMLElement) || opener === document.body
        || opener.closest("[hidden]")) {
      opener = fallbackOpenerId ? $(fallbackOpenerId) : null;
    }
    modalOpeners.set(sheet, {
      opener,
      fallback: fallbackOpenerId ? $(fallbackOpenerId) : null,
    });
    sheet.hidden = false;
    if (focusId) setTimeout(() => $(focusId)?.focus(), 20);
  }

  function hideSheet(id) {
    const sheet = $(id);
    sheet.hidden = true;
    const state = modalOpeners.get(sheet);
    modalOpeners.delete(sheet);
    let target = state?.opener;
    if (!target?.isConnected || target.closest("[hidden]")) target = state?.fallback;
    if (target?.isConnected && !target.closest("[hidden]")) {
      setTimeout(() => target.focus({ preventScroll: true }), 0);
    }
  }

  const readList = (key) => {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || "[]");
      return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
    } catch (error) { return []; }
  };
  let favorites = new Set(readList("lg-favorites"));
  let recent = readList("lg-recent");
  let playTotal = Math.max(0, Number(localStorage.getItem("lg-play-total")) || 0);

  const TIMES = {
    brickade: "5–10 min", dodgeball: "5–10 min", smelterskelter: "8–12 min",
    buzzboard: "20–35 min", bingo: "10–25 min", pricecheck: "10–15 min",
    orbitriot: "8–12 min", poker: "20–45 min", spades: "25–45 min",
    hearts: "15–25 min", euchre: "15–25 min", charades: "10–20 min",
    trivia: "15–30 min", blitz: "10–15 min", werewolf: "20–35 min",
    famfeud: "15–25 min", wordrush: "5–10 min",
    wordclash: "10–20 min", chess: "10–45 min", checkers: "10–20 min",
    backgammon: "15–30 min", connect4: "5–10 min", fortfling: "5–10 min",
    tanks: "10–20 min", battleship: "10–20 min", snake: "5–10 min",
    rummikub: "25–45 min",
  };
  const MOODS = {
    bigscreen: "TV PARTY", party: "GROUP CHAOS", cards: "STRATEGY",
    board: "CLASSIC", battle: "QUICK COMPETITION",
  };

  const esc = (s) => String(s).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------- colour helpers (derive rich 2-tone box art from one accent) --- */
  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgba = (hex, a) => { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; };
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    let h = 0, s = 0, l = (mx + mn) / 2;
    if (mx !== mn) {
      const d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return [h * 360, s, l];
  }
  function hslToHex(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    s = Math.min(1, Math.max(0, s)); l = Math.min(1, Math.max(0, l));
    let r, g, b;
    if (s === 0) { r = g = b = l; }
    else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
      const hue = (t) => {
        t = (t + 1) % 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      r = hue(h + 1 / 3); g = hue(h); b = hue(h - 1 / 3);
    }
    const to = (x) => Math.round(x * 255).toString(16).padStart(2, "0");
    return `#${to(r)}${to(g)}${to(b)}`;
  }
  function shift(hex, dh, ds, dl) {
    const [h, s, l] = rgbToHsl(...hexToRgb(hex));
    return hslToHex(h + dh, s + (ds || 0), l + (dl || 0));
  }

  /* layered "cover art" background for a game tile */
  function art(accent) {
    const a2 = shift(accent, 42, 0.06, -0.05);
    return [
      `radial-gradient(115% 85% at 14% 8%, ${rgba(accent, 0.55)}, transparent 52%)`,
      `radial-gradient(95% 85% at 90% 96%, ${rgba(a2, 0.5)}, transparent 58%)`,
      `repeating-linear-gradient(-34deg, rgba(232,237,249,0.03) 0 2px, transparent 2px 9px)`,
      `linear-gradient(155deg, ${rgba(accent, 0.2)} 0%, ${rgba(a2, 0.1)} 42%, #0a0f20 78%)`,
    ].join(",");
  }

  function launchUrl(g) {
    if (g.url) {
      return g.url.startsWith(":")
        ? `http://${location.hostname}${g.url}/` : g.url;
    }
    return `/games/${g.slug}/`;
  }

  function liveText(g) {
    if (!g.live) return null;
    if (g.live.phase && g.live.phase !== "lobby") return "IN GAME";
    if (g.live.players > 0) return `${g.live.players} IN LOBBY`;
    return null;
  }

  /* players / mode chips shown on the tiles */
  function playersRange(g) {
    let s = String(g.players || "");
    s = s.split("+")[0].split(",")[0].replace(/\bplayers?\b/i, "").trim();
    if (s) return s;
    return g.max_p > g.min_p ? `${g.min_p}–${g.max_p}` : `${g.min_p}`;
  }
  function tagList(g) {
    const bots = /\+\s*bots?\b/i.test(g.players || "");
    const out = [{ t: "👥 " + playersRange(g), cls: "players" }];
    if (g.solo) out.push({ t: "SOLO", cls: "solo" });
    if (bots) out.push({ t: "BOTS", cls: "bots" });
    if (/teams/i.test(g.players || "")) out.push({ t: "TEAMS", cls: "" });
    else if (/same room/i.test(g.players || "")) out.push({ t: "SAME ROOM", cls: "" });
    return out.slice(0, 3);
  }
  const tagsHtml = (g) => tagList(g)
    .map((x) => `<span class="tag ${x.cls}">${esc(x.t)}</span>`).join("");

  /* ---------- tiles ---------- */
  function tile(g, i, isSoon) {
    const el = document.createElement("article");
    el.className = "tile" + (isSoon ? " soon" : "");
    el.dataset.slug = g.slug || "";
    el.style.animationDelay = `${Math.min(i * 45, 400)}ms`;
    const accent = g.accent || "#8b96b3";
    el.style.setProperty("--tile-accent", accent);
    const artHtml = window.GameArt
      ? GameArt.html(g)
      : `<div class="game-art" style="background:${art(accent)}"></div>`;
    el.innerHTML = `
      ${isSoon ? "" : `<a class="tile-launch" href="${esc(launchUrl(g))}"
        aria-label="play ${esc(g.title)}">`}
        <div class="tile-art">${artHtml}</div>
        <div class="tile-gloss"></div>
        <div class="tile-scan"></div>
        <div class="tile-scrim"></div>
        ${isSoon ? '<span class="tile-ribbon">SOON</span>' : ""}
        ${!isSoon ? `<div class="tile-badges">
          ${g.tv ? '<span class="tile-tv-badge">📺 TV</span>' : ""}
        </div>` : ""}
        <div class="tile-body">
          <span class="tile-title">${esc(g.title)}</span>
          ${isSoon
            ? `<span class="tile-sub">${esc(g.blurb || "")}</span>`
            : `<div class="tile-tags">${tagsHtml(g)}</div>`}
        </div>
        ${isSoon ? "" : '<span class="tile-play">PLAY ▶</span>'}
      ${isSoon ? "" : "</a>"}
      ${isSoon ? "" : `
        <button class="tile-fav${favorites.has(g.slug) ? " on" : ""}" type="button"
          aria-label="${favorites.has(g.slug) ? "remove from" : "add to"} favorites"
          title="favorite">${favorites.has(g.slug) ? "★" : "☆"}</button>
        <button class="tile-info" type="button" aria-label="details for ${esc(g.title)}"
          title="game details">i</button>`}`;
    if (!isSoon) {
      const live = liveText(g);
      if (live) setLiveBadge(el, live);
      tileLive[g.slug] = el;
      if (g.tv) el.classList.add("has-tv");
      el.querySelector(".tile-launch").addEventListener("click", () => rememberGame(g));
      el.querySelector(".tile-info").addEventListener("click", (event) => {
        event.preventDefault(); event.stopPropagation(); openGameSheet(g);
      });
      el.querySelector(".tile-fav").addEventListener("click", (event) => {
        event.preventDefault(); event.stopPropagation(); toggleFavorite(g.slug);
      });
      wireTilt(el);
    }
    return el;
  }

  function saveFavorites() {
    localStorage.setItem("lg-favorites", JSON.stringify([...favorites]));
  }
  function rememberGame(g) {
    recent = [g.slug, ...recent.filter((slug) => slug !== g.slug)].slice(0, 8);
    localStorage.setItem("lg-recent", JSON.stringify(recent));
    playTotal += 1;
    localStorage.setItem("lg-play-total", String(playTotal));
  }
  function toggleFavorite(slug) {
    if (favorites.has(slug)) favorites.delete(slug);
    else favorites.add(slug);
    saveFavorites();
    Hub.feedback.select(); Hub.feedback.haptic(16);
    document.querySelectorAll(`.tile[data-slug="${CSS.escape(slug)}"] .tile-fav`)
      .forEach((button) => {
        const on = favorites.has(slug);
        button.classList.toggle("on", on);
        button.textContent = on ? "★" : "☆";
        button.setAttribute("aria-label", `${on ? "remove from" : "add to"} favorites`);
      });
    if (selectedGame && selectedGame.slug === slug) renderGameFavorite();
    renderQuick();
    renderProfileStats();
  }

  function wireTilt(el) {
    if (matchMedia("(pointer: coarse)").matches) return;
    el.addEventListener("pointermove", (event) => {
      if (Hub.prefs.reducedFx) {
        el.style.transform = "";
        return;
      }
      const box = el.getBoundingClientRect();
      const x = (event.clientX - box.left) / box.width - .5;
      const y = (event.clientY - box.top) / box.height - .5;
      el.style.transform = `perspective(700px) rotateX(${-y * 5}deg) rotateY(${x * 7}deg) translateY(-5px) scale(1.025)`;
    });
    el.addEventListener("pointerleave", () => { el.style.transform = ""; });
  }

  function renderQuick() {
    const section = $("quick-section");
    if (!section || !games.length) return;
    const slugs = [...favorites, ...recent.filter((slug) => !favorites.has(slug))];
    const list = slugs.map((slug) => games.find((g) => g.slug === slug)).filter(Boolean).slice(0, 8);
    section.hidden = list.length === 0;
    const track = $("quick-track");
    track.textContent = "";
    list.forEach((game, index) => track.appendChild(tile(game, index, false)));
  }

  function renderGameFavorite() {
    if (!selectedGame) return;
    const on = favorites.has(selectedGame.slug);
    const button = $("game-sheet-fav");
    button.classList.toggle("on", on);
    button.textContent = `${on ? "★" : "☆"} ${on ? "FAVORITED" : "FAVORITE"}`;
  }

  function openGameSheet(g) {
    selectedGame = g;
    $("game-sheet-art").innerHTML = GameArt.html(g, "game-art--hero");
    $("game-sheet-category").textContent =
      `${CAT_LABEL[g.category] || "GAME"} · ${MOODS[g.category] || "PLAY TOGETHER"}`;
    $("game-sheet-title").textContent = g.title;
    $("game-sheet-tagline").textContent = g.tagline || "";
    $("game-sheet-description").textContent = g.blurb || "";
    const meta = [
      `👥 ${playersRange(g)}`,
      TIMES[g.slug] || "10–20 min",
      g.tv ? "📺 TV required" : "📱 phone play",
      g.solo ? "solo ready" : null,
      /\+\s*bots?/i.test(g.players || "") ? "bots available" : null,
    ].filter(Boolean);
    $("game-sheet-meta").innerHTML = meta.map((value) => `<span>${esc(value)}</span>`).join("");
    const play = $("game-sheet-play");
    play.href = launchUrl(g);
    play.onclick = () => rememberGame(g);
    renderGameFavorite();
    showSheet("game-sheet", "game-sheet-play");
    Hub.feedback.select(); Hub.feedback.haptic(14);
  }

  function closeGameSheet() {
    hideSheet("game-sheet");
    selectedGame = null;
  }

  function searchable(g) {
    return [
      g.slug, g.title, g.tagline, g.blurb, g.category, g.players,
      MOODS[g.category], g.solo ? "solo single player just me" : "",
      /\bbots?\b/i.test(g.players || "") ? "bots computer" : "",
      TIMES[g.slug],
    ].join(" ").toLowerCase();
  }

  function renderSearch() {
    const query = $("game-search").value.trim().toLowerCase();
    const words = query.split(/\s+/).filter(Boolean);
    const list = games.filter((g) => words.every((word) => searchable(g).includes(word)));
    const host = $("search-results");
    host.textContent = "";
    if (!list.length) {
      host.innerHTML = '<p class="search-empty">No match. Try a player count, category or shorter title.</p>';
      return;
    }
    list.forEach((g) => {
      const link = document.createElement("a");
      link.className = "search-result";
      link.href = launchUrl(g);
      link.innerHTML = `<span class="search-result-art">${GameArt.html(g)}</span>
        <span class="search-result-copy"><b>${esc(g.title)}</b>
          <span>${esc(g.tagline || g.blurb || "")}</span>
          <small>${esc(CAT_LABEL[g.category] || "GAME")} · ${esc(playersRange(g))} players · ${esc(TIMES[g.slug] || "10–20 min")}</small>
        </span><span class="search-result-go" aria-hidden="true">›</span>`;
      link.onclick = () => rememberGame(g);
      host.appendChild(link);
    });
  }

  function openSearch() {
    $("game-search").value = "";
    renderSearch();
    showSheet("search-sheet", "game-search", "search-open");
    Hub.feedback.tap();
  }
  function closeSearch() { hideSheet("search-sheet"); }

  /* the LIVE badge sits at the top-left of the badges row */
  function setLiveBadge(el, text) {
    el.classList.add("has-live");
    let row = el.querySelector(".tile-badges");
    if (!row) {
      row = document.createElement("div");
      row.className = "tile-badges";
      el.appendChild(row);
    }
    let b = row.querySelector(".tile-live");
    if (!b) {
      b = document.createElement("span");
      b.className = "tile-live";
      row.prepend(b);
    }
    b.textContent = text;
  }
  function clearLiveBadge(el) {
    const b = el.querySelector(".tile-live");
    if (b) b.remove();
    el.classList.remove("has-live");
  }

  function railEl(title, ico, list, isSoon) {
    const rail = document.createElement("section");
    rail.className = "rail";
    rail.innerHTML = `
      <div class="rail-head">
        <span class="rail-ico" aria-hidden="true">${ico || ""}</span>
        <span class="rail-title">${title}</span>
        <span class="rail-count">${list.length}</span>
      </div>`;
    const track = document.createElement("div");
    track.className = "rail-track";
    list.forEach((g, i) => track.appendChild(tile(g, i, isSoon)));
    rail.appendChild(track);
    return rail;
  }

  function renderRails() {
    const host = $("rails");
    host.textContent = "";
    Object.keys(tileLive).forEach((k) => delete tileLive[k]);
    const f = FILTERS.find((x) => x.key === filter).fn;
    const matching = games.filter(f);
    for (const r of RAILS) {
      const list = matching.filter((g) => (g.category || "battle") === r.key);
      if (list.length) host.appendChild(railEl(r.title, r.ico, list, false));
    }
    if (soon.length) host.appendChild(railEl("COMING SOON", "🔜", soon, true));
  }

  function renderFilters() {
    const host = $("filters");
    host.textContent = "";
    for (const fdef of FILTERS) {
      const n = fdef.key === "all" ? games.length : games.filter(fdef.fn).length;
      const b = document.createElement("button");
      b.className = "fchip" + (filter === fdef.key ? " sel" : "");
      b.innerHTML = `${esc(fdef.label)}<span class="fc-n">${n}</span>`;
      b.disabled = n === 0;
      b.onclick = () => {
        filter = fdef.key;
        Hub.feedback.tap(); Hub.feedback.haptic(10);
        renderFilters(); renderRails();
      };
      host.appendChild(b);
    }
  }


  /* ---------- data ---------- */
  function ingest(data) {
    const reg = data.games.filter((g) => !g.hidden || DEV);
    const ext = (data.external || []).map((g) => ({ ...g }));
    games = [...reg, ...ext];
    soon = data.coming_soon || [];
  }

  async function boot() {
    try {
      const data = await (await fetch("/api/games")).json();
      ingest(data);
      renderFilters();
      renderQuick();
      renderRails();
      renderWelcome();
    } catch (e) {
      $("rails").innerHTML =
        `<p style="text-align:center;color:var(--muted);padding:40px">
           hub API unreachable — refresh to retry</p>`;
    }
  }

  async function refreshLive() {
    try {
      const data = await (await fetch("/api/games")).json();
      const byslug = {};
      for (const g of data.games) byslug[g.slug] = g;
      for (const g of games) {
        const fresh = byslug[g.slug];
        if (!fresh) continue;
        const before = liveText(g);
        g.live = fresh.live;
        const after = liveText(g);
        if (before === after) continue;
        document.querySelectorAll(`.tile[data-slug="${CSS.escape(g.slug)}"]`)
          .forEach((el) => { if (after) setLiveBadge(el, after); else clearLiveBadge(el); });
      }
    } catch { /* transient — next tick */ }
  }

  /* ---------- classic-console flourishes ---------- */
  // power-on boot sweep, once per tab session
  if (!REDUCED && !sessionStorage.getItem("lg-booted")) {
    sessionStorage.setItem("lg-booted", "1");
    const b = document.createElement("div");
    b.className = "boot";
    b.setAttribute("aria-hidden", "true");
    document.body.appendChild(b);
    setTimeout(() => b.remove(), 1200);
  }

  // D-pad / arrow-key roving focus across the game tiles
  function navTargets() {
    return [...document.querySelectorAll("a.tile-launch")];
  }
  function spatialNav(dir) {
    const cur = document.activeElement;
    const items = navTargets();
    if (!items.includes(cur)) return false;
    const r = cur.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    let best = null, bestScore = Infinity;
    for (const el of items) {
      if (el === cur) continue;
      const b = el.getBoundingClientRect();
      const bx = b.left + b.width / 2, by = b.top + b.height / 2;
      const dx = bx - cx, dy = by - cy;
      const ok = dir === "right" ? dx > 8 : dir === "left" ? dx < -8
               : dir === "down" ? dy > 8 : dy < -8;
      if (!ok) continue;
      // primary axis distance dominates; penalise cross-axis drift
      const along = (dir === "left" || dir === "right") ? Math.abs(dx) : Math.abs(dy);
      const cross = (dir === "left" || dir === "right") ? Math.abs(dy) : Math.abs(dx);
      const score = along + cross * 2.2;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (best) {
      best.focus({ preventScroll: false });
      best.scrollIntoView({ block: "nearest", inline: "center" });
      return true;
    }
    return false;
  }
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    if (document.querySelector(".modal:not([hidden]), .crop-ov")) return;
    const dir = { ArrowRight: "right", ArrowLeft: "left",
                  ArrowDown: "down", ArrowUp: "up" }[e.key];
    if (!dir) return;
    if (spatialNav(dir)) e.preventDefault();
  });

  $("search-open").onclick = openSearch;
  $("search-close").onclick = closeSearch;
  $("search-sheet").addEventListener("click", (event) => {
    if (event.target.id === "search-sheet") closeSearch();
  });
  $("game-search").addEventListener("input", renderSearch);
  $("surprise-game").onclick = () => {
    const rule = FILTERS.find((entry) => entry.key === filter)?.fn || (() => true);
    const pool = games.filter(rule);
    if (!pool.length) return;
    const game = pool[Math.floor(Math.random() * pool.length)];
    rememberGame(game);
    Hub.feedback.success(); Hub.feedback.haptic([24, 30, 36]);
    location.href = launchUrl(game);
  };
  $("game-sheet-close").onclick = closeGameSheet;
  $("game-sheet").addEventListener("click", (event) => {
    if (event.target.id === "game-sheet") closeGameSheet();
  });
  $("game-sheet-fav").onclick = () => selectedGame && toggleFavorite(selectedGame.slug);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!$("search-sheet").hidden) closeSearch();
      else if (!$("game-sheet").hidden) closeGameSheet();
      else if (!$("install-sheet").hidden) closeInstall();
      else if (!$("profile-sheet").hidden) closeProfile();
      else if (!$("share-sheet").hidden) closeShare();
      else if (!$("wifi-sheet").hidden) closeWifi();
      return;
    }
    if (event.key === "/" && !/^(INPUT|TEXTAREA)$/.test(event.target?.tagName || "")
        && document.querySelector(".modal:not([hidden])") === null) {
      event.preventDefault(); openSearch();
    }
  });
  // Keep keyboard focus inside whichever sheet is open. This is especially
  // important on tablets with a hardware keyboard and for screen-reader users.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const open = [...document.querySelectorAll(".modal:not([hidden])")].at(-1);
    if (!open) return;
    const focusable = [...open.querySelectorAll(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )].filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  });

  /* ---------- one-scan phone onboarding (entirely local) ---------- */
  const shareUrl = new URL("/", location.href).href;
  const localOnlyHost = ["localhost", "127.0.0.1", "0.0.0.0", "::1"]
    .includes(location.hostname);

  function closeShare() { hideSheet("share-sheet"); }

  function openShare() {
    const qr = $("share-qr");
    qr.textContent = "";
    $("share-url").textContent = shareUrl;
    $("share-hint").textContent = localOnlyHost
      ? "This address only works on the host. Reopen LAN Games using the host's LAN IP, then share again."
      : "Connect to the same Wi-Fi, then scan this code.";
    showSheet("share-sheet", "share-copy", "share-open");
    try { renderQR(qr, shareUrl); }
    catch (e) { qr.textContent = "QR unavailable"; }
  }

  async function copyJoinLink() {
    let copied = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(shareUrl);
        copied = true;
      }
    } catch (e) { /* use the HTTP-safe fallback below */ }
    if (!copied) {
      const ta = document.createElement("textarea");
      ta.value = shareUrl;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.appendChild(ta);
      ta.select();
      try { copied = document.execCommand("copy"); } catch (e) { /* no-op */ }
      ta.remove();
    }
    Hub.toast(copied ? "✓ join link copied" : "press and hold the link to copy",
      copied ? "" : "err");
  }

  $("share-open").onclick = (event) => {
    event.stopPropagation();
    openShare();
  };
  $("share-close").onclick = closeShare;
  $("share-copy").onclick = copyJoinLink;
  $("share-sheet").addEventListener("click", (e) => {
    if (e.target.id === "share-sheet") closeShare();
  });
  $("share-qr").addEventListener("qr-overflow", () => {
    $("share-qr").textContent = "Address is too long for the QR code";
  });
  if (typeof navigator.share === "function") {
    $("share-native").hidden = false;
    $("share-native").onclick = async () => {
      try { await navigator.share({ title: "LAN Games", url: shareUrl }); }
      catch (e) { if (e.name !== "AbortError") copyJoinLink(); }
    };
  }

  /* ---------- guest Wi-Fi QR (config from gitignored data/venue.json) ---------- */
  function wifiQRString(w) {
    // WIFI: payload; ; , : \ and " must be backslash-escaped. H:true is REQUIRED
    // for a hidden SSID or phones won't join from the scan.
    const esc = (s) => String(s == null ? "" : s).replace(/([\\;,":])/g, "\\$1");
    const sec = w.security || (w.password ? "WPA" : "nopass");
    return `WIFI:T:${sec};S:${esc(w.ssid)};P:${esc(w.password)};${w.hidden ? "H:true;" : ""};`;
  }
  // The button is ALWAYS shown. Unconfigured it opens setup instructions rather
  // than hiding, so the feature is discoverable on a fresh clone instead of
  // being invisible until you happen to read the README.
  let venueWifi = null;
  function closeWifi() { hideSheet("wifi-sheet"); }
  function openWifi() {
    const ready = !!venueWifi;
    $("wifi-title").textContent = ready ? "📶 JOIN THE WI-FI" : "📶 SET UP GUEST WI-FI";
    $("wifi-ready").hidden = !ready;
    $("wifi-setup").hidden = ready;
    showSheet("wifi-sheet", "wifi-close", "wifi-open");
    if (!ready) return;
    const qr = $("wifi-qr"); qr.textContent = "";
    $("wifi-ssid").textContent = venueWifi.ssid || "";
    $("wifi-pass").textContent = venueWifi.password || "(open)";
    $("wifi-note").hidden = !venueWifi.hidden;
    try { renderQR(qr, wifiQRString(venueWifi)); }
    catch (e) { qr.textContent = "QR unavailable"; }
  }
  $("wifi-open").onclick = (event) => {
    event.stopPropagation();
    openWifi();
  };
  $("wifi-close").onclick = closeWifi;
  $("wifi-sheet").addEventListener("click", (e) => {
    if (e.target.id === "wifi-sheet") closeWifi();
  });
  fetch("/api/venue").then((r) => r.json()).then((v) => {
    if (v && v.wifi && v.wifi.ssid) {
      venueWifi = v.wifi;
      const btn = $("wifi-open");
      btn.classList.remove("wifi-unset");
      btn.setAttribute("aria-label", "guest Wi-Fi QR");
      btn.title = "guest Wi-Fi QR";
    }
  }).catch(() => { /* no venue config — button stays in its set-up state */ });

  /* ---------- profile (name + character + photo, shared with every game) ---------- */
  let pfAvatar = "";
  const pfMe = () => ({ pfp: Hub.identity.pfp || null,
                        avatar: pfAvatar || Hub.identity.avatar || "🎮" });

  function renderChip() {
    Hub.fillAvatar($("hp-av"), pfMe());
    $("hp-name").textContent = Hub.identity.name || "SET UP";
  }
  function renderWelcome() {
    const card = $("welcome-card");
    if (card) card.hidden = !!Hub.identity.name;
  }
  function renderProfileStats() {
    $("pf-played").textContent = String(playTotal);
    $("pf-faves").textContent = String(favorites.size);
  }
  function renderPrefs() {
    const states = {
      "pf-sound": Hub.prefs.sound,
      "pf-haptics": Hub.prefs.haptics,
      "pf-motion": !Hub.prefs.reducedFx,
      "pf-contrast": Hub.prefs.contrast,
    };
    Object.entries(states).forEach(([id, on]) => {
      $(id).classList.toggle("on", on);
      $(id).setAttribute("aria-pressed", on ? "true" : "false");
    });
  }
  function renderPfPreview() {
    Hub.fillAvatar($("pf-av"), pfMe());
    $("pf-photo-rm").hidden = !Hub.identity.pfp;
    $("pf-photo").textContent = Hub.identity.pfp ? "📷 CHANGE PHOTO" : "📷 ADD PHOTO";
  }
  function openProfile() {
    pfAvatar = Hub.identity.avatar
      || Hub.AVATARS[Math.floor(Math.random() * Hub.AVATARS.length)];
    $("pf-name").value = Hub.identity.name;
    Hub.buildAvatarGrid($("pf-grid"), pfAvatar, (a) => { pfAvatar = a; renderPfPreview(); });
    renderPfPreview();
    renderProfileStats();
    renderPrefs();
    showSheet("profile-sheet", "pf-name", "profile-chip");
  }
  function closeProfile() { hideSheet("profile-sheet"); }

  $("profile-chip").onclick = openProfile;
  $("welcome-setup").onclick = openProfile;
  $("pf-close").onclick = closeProfile;
  $("profile-sheet").addEventListener("click", (e) => {
    if (e.target.id === "profile-sheet") closeProfile();
  });
  Hub.wirePfpButton($("pf-photo"), () => null, () => { renderPfPreview(); renderChip(); });
  $("pf-photo-rm").onclick = async () => {
    await Hub.removePfp();
    renderPfPreview(); renderChip();
    Hub.toast("photo removed");
  };
  $("pf-save").onclick = () => {
    Hub.identity.ensureToken();
    Hub.identity.name = ($("pf-name").value || "").trim() || "PLAYER";
    Hub.identity.avatar = pfAvatar || Hub.identity.avatar;
    renderChip();
    renderWelcome();
    closeProfile();
    Hub.toast("✓ profile saved");
    Hub.feedback.success(); Hub.feedback.haptic([20, 25, 35]);
    reconnectChat();          // new identity on future messages
  };
  $("pf-sound").onclick = () => { Hub.prefs.sound = !Hub.prefs.sound; renderPrefs(); Hub.feedback.select(); };
  $("pf-haptics").onclick = () => {
    Hub.prefs.haptics = !Hub.prefs.haptics; renderPrefs(); Hub.feedback.haptic(24);
  };
  $("pf-motion").onclick = () => { Hub.prefs.reducedFx = !Hub.prefs.reducedFx; renderPrefs(); };
  $("pf-contrast").onclick = () => { Hub.prefs.contrast = !Hub.prefs.contrast; renderPrefs(); };
  $("install-open").onclick = () => {
    $("install-note").textContent = window.isSecureContext
      ? "On supported browsers, the suite can launch full screen."
      : "This private LAN uses HTTP, so your browser saves a home-screen shortcut rather than an offline app.";
    showSheet("install-sheet", "install-close", "install-open");
  };
  function closeInstall() { hideSheet("install-sheet"); }
  $("install-close").onclick = closeInstall;
  $("install-sheet").addEventListener("click", (event) => {
    if (event.target.id === "install-sheet") closeInstall();
  });
  renderChip();
  renderWelcome();

  /* ---------- lobby chat ---------- */
  const EMOJI = ["😀","😂","🤣","😅","😍","😎","🤩","🥳","😜","🤪","😇","🙃",
    "😏","😱","🤯","😭","😤","😡","🥶","🤔","🙄","😴","🤗","🫡",
    "👍","👎","👏","🙌","🙏","💪","🤝","👑","❤️","🔥","💯","✨",
    "🎉","🎊","⭐","⚡","🎮","🕹️","🏆","🥇","🃏","🎲","🐍","💣",
    "😈","🤖","👾","💀","🤡","🍕","🍺","🤷"];

  let chatWS = null, myUid = null, chatRetry = 0, chatClosedByUs = false;
  let unread = 0, chatVisible = true;
  const nearBottom = () => {
    const m = $("lc-msgs");
    return m.scrollHeight - m.scrollTop - m.clientHeight < 60;
  };
  const scrollDown = () => { const m = $("lc-msgs"); m.scrollTop = m.scrollHeight; };

  function emptyHint() {
    $("lc-msgs").innerHTML =
      '<p class="lc-empty">no messages yet<br>say hi, drop an emoji or a meme 👋</p>';
  }

  function isEmojiOnly(t) {
    // short + no ascii letters/digits -> render big
    return t.length <= 8 && !/[a-z0-9]/i.test(t) && /\p{Extended_Pictographic}/u.test(t);
  }

  /* collapse / expand + unread pip on the header CHAT button */
  const chatSection = $("chat-section");
  function setUnread(n) {
    unread = Math.max(0, n);
    const btn = $("chat-jump"), pip = $("chat-pip");
    pip.textContent = unread > 9 ? "9+" : String(unread);
    btn.classList.toggle("has-unread", unread > 0);
  }
  function isCollapsed() { return chatSection.classList.contains("collapsed"); }
  function setCollapsed(c) {
    chatSection.classList.toggle("collapsed", c);
    $("lc-head").setAttribute("aria-expanded", c ? "false" : "true");
    localStorage.setItem("lg-chat-open", c ? "0" : "1");
    if (!c) { setUnread(0); scrollDown(); }
  }
  // Games are the first task. Chat stays one tap away, but an empty 300px panel
  // no longer owns half of the phone's opening screen.
  if (localStorage.getItem("lg-chat-open") !== "1") setCollapsed(true);
  $("lc-head").onclick = () => setCollapsed(!isCollapsed());
  $("lc-head").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setCollapsed(!isCollapsed()); }
  });
  $("chat-jump").onclick = () => {
    if (isCollapsed()) setCollapsed(false);
    chatSection.scrollIntoView({
      behavior: Hub.prefs.reducedFx ? "auto" : "smooth", block: "end",
    });
    setUnread(0);
  };
  // know when the chat is actually on screen (so we only badge unread when it's not)
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((ents) => {
      chatVisible = ents[0].isIntersecting;
      if (chatVisible && !isCollapsed()) setUnread(0);
    }, { threshold: 0.25 }).observe(chatSection);
  }

  function renderMsg(m) {
    const empty = $("lc-msgs").querySelector(".lc-empty");
    if (empty) empty.remove();
    const stick = nearBottom();
    const row = document.createElement("div");
    row.className = "lc-row" + (m.by === myUid ? " mine" : "");
    const av = document.createElement("span");
    av.className = "lc-av";
    Hub.fillAvatar(av, { pfp: m.pfp, avatar: m.avatar });
    const bub = document.createElement("div");
    bub.className = "lc-bub";
    if (m.by !== myUid) {
      const nm = document.createElement("div");
      nm.className = "lc-name";
      nm.textContent = m.name || "PLAYER";
      bub.appendChild(nm);
    }
    if (m.text) {
      const tx = document.createElement("div");
      tx.className = "lc-text" + (isEmojiOnly(m.text) ? " big" : "");
      tx.textContent = m.text;
      bub.appendChild(tx);
    }
    if (m.img) {
      const img = document.createElement("img");
      img.className = "lc-img";
      img.src = m.img;
      img.alt = "shared image";
      if (m.iw && m.ih) img.style.aspectRatio = `${m.iw} / ${m.ih}`;
      img.onclick = () => lightbox(m.img);
      img.onload = () => { if (stick) scrollDown(); };
      bub.appendChild(img);
    }
    const reacts = document.createElement("div");
    reacts.className = "lc-reacts";
    bub.appendChild(reacts);
    row.dataset.mid = m.id;
    row.append(av, bub);
    $("lc-msgs").appendChild(row);
    renderReacts(m.id, m.reactions || {});
    if (stick) scrollDown();
  }

  /* ---------- emoji reactions on a message ---------- */
  const REACTS = ["👍", "❤️", "😂", "🔥", "🎉", "😮"];
  function sendReact(id, emoji) {
    if (chatWS && chatWS.readyState === 1)
      chatWS.send(JSON.stringify({ t: "react", id, emoji }));
  }
  function renderReacts(id, map) {
    const row = $("lc-msgs").querySelector(`.lc-row[data-mid="${id}"]`);
    const host = row && row.querySelector(".lc-reacts");
    if (!host) return;
    host.textContent = "";
    for (const e of REACTS) {
      const users = map[e] || [];
      if (!users.length) continue;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "lc-react" + (users.includes(myUid) ? " mine" : "");
      b.innerHTML = `${e}<span class="n">${users.length}</span>`;
      b.onclick = () => sendReact(id, e);
      host.appendChild(b);
    }
    const add = document.createElement("button");
    add.type = "button";
    add.className = "lc-react lc-react-add";
    add.textContent = "＋";
    add.setAttribute("aria-label", "add a reaction");
    add.onclick = () => {
      host.querySelectorAll(".lc-pick").forEach((x) => x.remove());
      for (const e of REACTS) {
        const p = document.createElement("button");
        p.type = "button"; p.className = "lc-react lc-pick"; p.textContent = e;
        p.onclick = () => sendReact(id, e);
        host.appendChild(p);
      }
    };
    host.appendChild(add);
  }

  function lightbox(src) {
    const ov = document.createElement("div");
    ov.className = "lc-lightbox";
    ov.innerHTML = `<img src="${esc(src)}" alt="">`;
    ov.onclick = () => ov.remove();
    document.body.appendChild(ov);
  }

  function setOnline(n) {
    const el = $("lc-online");
    el.textContent = n > 0 ? `● ${n} online` : "offline";
    el.classList.toggle("on", n > 0);
  }

  function sendMsg(payload) {
    if (chatWS && chatWS.readyState === 1) {
      chatWS.send(JSON.stringify({ t: "msg", ...payload }));
      return true;
    }
    return false;
  }

  function connectChat() {
    chatClosedByUs = false;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/chat/ws`);
    chatWS = ws;
    ws.onopen = () => {
      chatRetry = 0;
      ws.send(JSON.stringify({
        t: "hello", token: Hub.identity.ensureToken(),
        name: Hub.identity.name || undefined,
        avatar: Hub.identity.avatar || undefined,
      }));
    };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === "welcome") { myUid = m.you; }
      else if (m.type === "history") {
        $("lc-msgs").textContent = "";
        if (!m.messages.length) emptyHint();
        else { m.messages.forEach(renderMsg); scrollDown(); }
      } else if (m.type === "msg") {
        renderMsg(m);
        if (m.by !== myUid && (isCollapsed() || !chatVisible)) setUnread(unread + 1);
      } else if (m.type === "presence") setOnline(m.online);
      else if (m.type === "react") renderReacts(m.id, m.reactions || {});
      else if (m.type === "typing") { if (m.by !== myUid) showTyping(m.name); }
      else if (m.type === "cleared") {
        $("lc-msgs").textContent = "";
        const s = document.createElement("p");
        s.className = "lc-sys";
        s.textContent = `🧹 chat cleared by ${m.name || "someone"}`;
        $("lc-msgs").appendChild(s);
        $("lc-typing").textContent = "";
      }
    };
    ws.onclose = () => {
      if (chatClosedByUs) return;
      setOnline(0);
      const wait = Math.min(5000, 600 + chatRetry * 700);
      chatRetry++;
      setTimeout(connectChat, wait);
    };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
  }
  function reconnectChat() {
    chatClosedByUs = true;
    try { chatWS && chatWS.close(); } catch (e) {}
    connectChat();
  }

  // input
  $("lc-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const t = $("lc-text").value.trim();
    if (!t) return;
    if (sendMsg({ text: t })) { $("lc-text").value = ""; $("lc-emoji").hidden = true;
                                $("lc-emoji-btn").classList.remove("on"); }
  });

  // emoji picker
  (() => {
    const host = $("lc-emoji");
    for (const e of EMOJI) {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = e;
      b.onclick = () => {
        const inp = $("lc-text");
        const s = inp.selectionStart ?? inp.value.length;
        inp.value = inp.value.slice(0, s) + e + inp.value.slice(inp.selectionEnd ?? s);
        inp.focus();
        inp.selectionStart = inp.selectionEnd = s + e.length;
      };
      host.appendChild(b);
    }
  })();
  $("lc-emoji-btn").onclick = () => {
    const p = $("lc-emoji");
    p.hidden = !p.hidden;
    $("lc-emoji-btn").classList.toggle("on", !p.hidden);
  };

  /* ---------- images: picker, PASTE (mobile GIF keyboard), drag & drop ------- */
  async function uploadImage(file) {
    if (!file || !/^image\//.test(file.type || "")) return;
    $("lc-gif-btn").classList.add("on");
    try {
      const res = await fetch("/api/chatmedia", {
        method: "POST",
        headers: { "x-wc-token": Hub.identity.ensureToken() },
        body: file,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "upload failed");
      sendMsg({ img: data.url, iw: data.w, ih: data.h });
    } catch (e) {
      Hub.toast(e.message || "couldn't send that image", "err");
    } finally {
      $("lc-gif-btn").classList.remove("on");
    }
  }

  const gifInput = document.createElement("input");
  gifInput.type = "file"; gifInput.accept = "image/*,image/gif"; gifInput.hidden = true;
  document.body.appendChild(gifInput);
  $("lc-gif-btn").onclick = () => gifInput.click();
  gifInput.addEventListener("change", () => {
    const f = gifInput.files && gifInput.files[0];
    gifInput.value = "";
    uploadImage(f);
  });

  // GBoard / iOS GIF keyboards hand the image to the page as a PASTE — catch it
  // on the message box (and anywhere in the dock) and upload it like any image.
  function pasteHandler(ev) {
    const items = (ev.clipboardData && ev.clipboardData.items) || [];
    for (const it of items) {
      if (it.kind === "file" && /^image\//.test(it.type || "")) {
        const f = it.getAsFile();
        if (f) { ev.preventDefault(); uploadImage(f); return; }
      }
    }
  }
  $("lc-text").addEventListener("paste", pasteHandler);
  $("chat-section").addEventListener("paste", pasteHandler);

  const dock = $("chat-section");
  dock.addEventListener("dragover", (e) => {
    if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) {
      e.preventDefault(); dock.classList.add("dropping");
    }
  });
  dock.addEventListener("dragleave", (e) => {
    if (e.target === dock) dock.classList.remove("dropping");
  });
  dock.addEventListener("drop", (e) => {
    e.preventDefault();
    dock.classList.remove("dropping");
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) uploadImage(f);
  });

  /* ---------- "… is typing" ---------- */
  let typingTimer = null, lastTypingSent = 0;
  function showTyping(name) {
    const el = $("lc-typing");
    el.textContent = `${name || "someone"} is typing…`;
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => { el.textContent = ""; }, 2600);
  }
  $("lc-text").addEventListener("input", () => {
    const now = Date.now();
    if (now - lastTypingSent < 1600) return;
    lastTypingSent = now;
    if (chatWS && chatWS.readyState === 1) chatWS.send(JSON.stringify({ t: "typing" }));
  });

  /* ---------- clear / reset the room ---------- */
  $("lc-clear").addEventListener("click", (e) => {
    e.stopPropagation();                    // don't collapse the dock
    if (!confirm("Clear the lobby chat for everyone?")) return;
    if (chatWS && chatWS.readyState === 1) chatWS.send(JSON.stringify({ t: "clear" }));
  });
  $("lc-clear").addEventListener("keydown", (e) => e.stopPropagation());

  emptyHint();
  connectChat();
  setInterval(() => sendMsg && chatWS && chatWS.readyState === 1
    && chatWS.send(JSON.stringify({ t: "ping" })), 25000);

  boot();
  setInterval(refreshLive, 10000);
})();
