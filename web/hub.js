// LAN GAMES hub — a console-style dashboard.
// Featured spotlight + category rails + party-size filters (driven by /api/games)
// + a docked lobby chat + classic-console flourishes (CRT, boot sweep, D-pad).
(() => {
  const $ = (id) => document.getElementById(id);
  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

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
  // Curated marquee order for the featured spotlight (falls back to the rest).
  const SPOT_ORDER = ["orbitriot", "poker", "snake", "werewolf", "bingo",
                      "tanks", "charades", "spades"];

  const DEV = new URLSearchParams(location.search).has("dev");
  let games = [];            // launchable entries (registry + external)
  let soon = [];
  let filter = "all";
  const tileLive = {};       // slug -> tile element (for badge updates)

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

  /* layered "cover art" background for a tile / spotlight */
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

  /* players / mode chips shared by tiles + spotlight */
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
    const el = document.createElement(isSoon ? "div" : "a");
    el.className = "tile" + (isSoon ? " soon" : "");
    el.style.animationDelay = `${Math.min(i * 45, 400)}ms`;
    const accent = g.accent || "#8b96b3";
    el.style.setProperty("--tile-accent", accent);
    const glyph = g.art || g.icon;
    if (!isSoon) {
      el.href = launchUrl(g);
      el.setAttribute("aria-label", `play ${g.title}`);
    }
    el.innerHTML = `
      <div class="tile-art" style="background:${art(accent)}"></div>
      <span class="tile-glyph-ghost" aria-hidden="true">${glyph}</span>
      <span class="tile-glyph" aria-hidden="true"
        style="filter:drop-shadow(0 10px 22px rgba(0,0,0,0.55)) drop-shadow(0 0 28px ${rgba(accent, 0.8)})">${glyph}</span>
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
      ${isSoon ? "" : '<span class="tile-play">PLAY ▶</span>'}`;
    if (!isSoon) {
      const live = liveText(g);
      if (live) setLiveBadge(el, live);
      tileLive[g.slug] = el;
    }
    return el;
  }

  /* the LIVE badge sits at the top-left of the badges row */
  function setLiveBadge(el, text) {
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
    renderSpotlight(matching);
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
      b.onclick = () => { filter = fdef.key; renderFilters(); renderRails(); };
      host.appendChild(b);
    }
  }

  /* ---------- featured spotlight (rotating marquee) ---------- */
  let spotPool = [], spotIdx = 0, spotTimer = null;

  function buildSpotPool(matching) {
    const rank = (g) => {
      const i = SPOT_ORDER.indexOf(g.slug);
      return i === -1 ? SPOT_ORDER.length + 1 : i;
    };
    return [...matching].sort((a, b) => rank(a) - rank(b)).slice(0, 6);
  }

  function showSpot(i) {
    const host = $("spotlight");
    if (!spotPool.length) { host.textContent = ""; return; }
    spotIdx = (i + spotPool.length) % spotPool.length;
    const g = spotPool[spotIdx];
    const accent = g.accent || "#22d3ee";
    const glyph = g.art || g.icon;
    const kicker = g.tv ? "📺 BIG SCREEN" : (CAT_LABEL[g.category] || "PLAY");
    const dots = spotPool.map((_, k) =>
      `<button class="spot-dot ${k === spotIdx ? "on" : ""}" data-i="${k}"
         aria-label="featured game ${k + 1}"></button>`).join("");
    host.innerHTML = `
      <div class="spot">
        <div class="spot-art" style="background:${art(accent)}"></div>
        <div class="spot-scan"></div>
        <span class="spot-glyph" aria-hidden="true"
          style="filter:drop-shadow(0 16px 30px rgba(0,0,0,0.6)) drop-shadow(0 0 44px ${rgba(accent, 0.7)})">${glyph}</span>
        <div class="spot-scrim"></div>
        <div class="spot-body">
          <span class="spot-kicker" style="background:${accent}">${esc(kicker)}</span>
          <span class="spot-title">${esc(g.title)}</span>
          <span class="spot-tag">${esc(g.tagline || g.blurb || "")}</span>
          <div class="spot-meta">${tagsHtml(g)}</div>
          <a class="spot-cta" href="${launchUrl(g)}" style="background:linear-gradient(135deg, ${accent}, ${shift(accent, 42, 0.06, -0.05)})">
            PLAY <span class="arw" aria-hidden="true">▶</span></a>
        </div>
        ${spotPool.length > 1 ? `<div class="spot-dots">${dots}</div>` : ""}
      </div>`;
    host.querySelectorAll(".spot-dot").forEach((d) => {
      d.onclick = (e) => {
        e.preventDefault(); e.stopPropagation();
        showSpot(parseInt(d.dataset.i, 10)); armSpot();
      };
    });
    // whole card launches; the CTA <a> stays the keyboard/AT target
    host.querySelector(".spot").addEventListener("click", (e) => {
      if (e.target.closest(".spot-dot") || e.target.closest(".spot-cta")) return;
      location.href = launchUrl(g);
    });
  }

  function armSpot() {
    if (spotTimer) { clearInterval(spotTimer); spotTimer = null; }
    if (REDUCED || spotPool.length < 2) return;
    spotTimer = setInterval(() => {
      if (document.hidden) return;
      showSpot(spotIdx + 1);
    }, 6500);
  }

  function renderSpotlight(matching) {
    spotPool = buildSpotPool(matching);
    spotIdx = 0;
    document.querySelector(".spot-wrap").hidden = spotPool.length === 0;
    showSpot(0);
    armSpot();
  }
  // pause rotation while the pointer is on the spotlight
  $("spotlight").addEventListener("pointerenter", () => {
    if (spotTimer) { clearInterval(spotTimer); spotTimer = null; }
  });
  $("spotlight").addEventListener("pointerleave", armSpot);

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
      renderRails();
    } catch (e) {
      $("rails").innerHTML =
        `<p style="text-align:center;color:var(--muted);padding:40px">
           hub API unreachable — refresh to retry</p>`;
      document.querySelector(".spot-wrap").hidden = true;
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
        const el = tileLive[g.slug];
        if (el) { if (after) setLiveBadge(el, after); else clearLiveBadge(el); }
      }
    } catch { /* transient — next tick */ }
  }

  /* ---------- classic-console flourishes ---------- */
  // CRT scanline toggle (persists)
  (() => {
    const btn = $("crt-toggle");
    const set = (on) => {
      document.body.classList.toggle("crt-on", on);
      btn.classList.toggle("on", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    };
    set(localStorage.getItem("lg-crt") === "1");
    btn.onclick = () => {
      const on = !document.body.classList.contains("crt-on");
      localStorage.setItem("lg-crt", on ? "1" : "0");
      set(on);
      Hub.toast(on ? "📺 CRT mode on" : "CRT mode off");
    };
  })();

  // power-on boot sweep, once per tab session
  if (!REDUCED && !sessionStorage.getItem("lg-booted")) {
    sessionStorage.setItem("lg-booted", "1");
    const b = document.createElement("div");
    b.className = "boot";
    b.setAttribute("aria-hidden", "true");
    document.body.appendChild(b);
    setTimeout(() => b.remove(), 1200);
  }

  // D-pad / arrow-key roving focus across tiles + the spotlight CTA
  function navTargets() {
    return [...document.querySelectorAll(".spot-cta, a.tile")];
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

  /* ---------- one-scan phone onboarding (entirely local) ---------- */
  const shareUrl = new URL("/", location.href).href;
  const localOnlyHost = ["localhost", "127.0.0.1", "0.0.0.0", "::1"]
    .includes(location.hostname);

  function closeShare() { $("share-sheet").hidden = true; }

  function openShare() {
    const qr = $("share-qr");
    qr.textContent = "";
    $("share-url").textContent = shareUrl;
    $("share-hint").textContent = localOnlyHost
      ? "This address only works on the host. Reopen LAN Games using the host's LAN IP, then share again."
      : "Connect to the same Wi-Fi, then scan this code.";
    $("share-sheet").hidden = false;
    try { renderQR(qr, shareUrl); }
    catch (e) { qr.textContent = "QR unavailable"; }
    $("share-copy").focus();
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

  $("share-open").onclick = openShare;
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

  /* ---------- profile (name + character + photo, shared with every game) ---------- */
  let pfAvatar = "";
  const pfMe = () => ({ pfp: Hub.identity.pfp || null,
                        avatar: pfAvatar || Hub.identity.avatar || "🎮" });

  function renderChip() {
    Hub.fillAvatar($("hp-av"), pfMe());
    $("hp-name").textContent = Hub.identity.name || "SET UP";
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
    $("profile-sheet").hidden = false;
  }
  const closeProfile = () => { $("profile-sheet").hidden = true; };

  $("profile-chip").onclick = openProfile;
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
    closeProfile();
    Hub.toast("✓ profile saved");
    reconnectChat();          // new identity on future messages
  };
  renderChip();

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
  // restore persisted state (default: open — keeps the input reachable on load)
  if (localStorage.getItem("lg-chat-open") === "0") setCollapsed(true);
  $("lc-head").onclick = () => setCollapsed(!isCollapsed());
  $("lc-head").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setCollapsed(!isCollapsed()); }
  });
  $("chat-jump").onclick = () => {
    if (isCollapsed()) setCollapsed(false);
    chatSection.scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "end" });
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
    row.append(av, bub);
    $("lc-msgs").appendChild(row);
    if (stick) scrollDown();
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

  // meme / gif upload
  const gifInput = document.createElement("input");
  gifInput.type = "file"; gifInput.accept = "image/*,image/gif"; gifInput.hidden = true;
  document.body.appendChild(gifInput);
  $("lc-gif-btn").onclick = () => gifInput.click();
  gifInput.addEventListener("change", async () => {
    const f = gifInput.files && gifInput.files[0];
    gifInput.value = "";
    if (!f) return;
    $("lc-gif-btn").classList.add("on");
    try {
      const res = await fetch("/api/chatmedia", {
        method: "POST",
        headers: { "x-wc-token": Hub.identity.ensureToken() },
        body: f,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "upload failed");
      sendMsg({ img: data.url, iw: data.w, ih: data.h });
    } catch (e) {
      Hub.toast(e.message || "couldn't send that image", "err");
    } finally {
      $("lc-gif-btn").classList.remove("on");
    }
  });

  emptyHint();
  connectChat();
  setInterval(() => sendMsg && chatWS && chatWS.readyState === 1
    && chatWS.send(JSON.stringify({ t: "ping" })), 25000);

  boot();
  setInterval(refreshLive, 10000);
})();
