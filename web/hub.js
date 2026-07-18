// LAN GAMES hub — console-style front end.
// Category rails + party-size filters (driven by /api/games) + a live lobby chat.
(() => {
  const $ = (id) => document.getElementById(id);

  const RAILS = [
    { key: "bigscreen", title: "BIG SCREEN", sub: "One screen · everyone's phone is the controller" },
    { key: "party",  title: "PARTY NIGHT" },
    { key: "cards",  title: "CARDS & TILES" },
    { key: "board",  title: "BOARD CLASSICS" },
    { key: "battle", title: "ARCADE & BATTLE" },
  ];
  const FILTERS = [
    { key: "all",  label: "ANY SIZE",  fn: () => true },
    { key: "solo", label: "JUST ME",   fn: (g) => g.solo },
    { key: "two",  label: "2 OF US",   fn: (g) => g.min_p <= 2 && g.max_p >= 2 },
    { key: "few",  label: "3–4",  fn: (g) => g.min_p <= 4 && g.max_p >= 3 },
    { key: "crowd", label: "5+",       fn: (g) => g.max_p >= 5 },
  ];

  const DEV = new URLSearchParams(location.search).has("dev");
  let games = [];            // launchable entries (registry + external)
  let soon = [];
  let filter = "all";
  const tileLive = {};       // slug -> tile element (for badge updates)

  const esc = (s) => String(s).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function rgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function art(accent) {
    const a = (x) => rgba(accent, x);
    return [
      `radial-gradient(120% 90% at 16% 10%, ${a(0.42)}, transparent 55%)`,
      `radial-gradient(90% 80% at 86% 92%, ${a(0.22)}, transparent 60%)`,
      `repeating-linear-gradient(-32deg, rgba(232,237,249,0.028) 0 2px, transparent 2px 9px)`,
      `linear-gradient(160deg, ${a(0.15)}, #0c1226 68%)`,
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

  /* ---------- tiles ---------- */
  function tile(g, i, isSoon) {
    const el = document.createElement(isSoon ? "div" : "a");
    el.className = "tile" + (isSoon ? " soon" : "");
    el.style.animationDelay = `${Math.min(i * 45, 400)}ms`;
    const accent = g.accent || "#8b96b3";
    if (!isSoon) {
      el.href = launchUrl(g);
      el.setAttribute("aria-label", `play ${g.title}`);
    }
    el.innerHTML = `
      <div class="tile-art" style="background:${art(accent)}"></div>
      <span class="tile-glyph-ghost" aria-hidden="true">${g.art || g.icon}</span>
      <span class="tile-glyph" aria-hidden="true"
        style="color:${rgba(accent, 0.95)};filter:drop-shadow(0 10px 22px rgba(0,0,0,0.55)) drop-shadow(0 0 30px ${rgba(accent, 0.85)})">${g.art || g.icon}</span>
      <div class="tile-scrim"></div>
      ${isSoon ? '<span class="tile-ribbon">SOON</span>' : ""}
      ${!isSoon && g.tv ? '<span class="tile-tv-badge">📺 TV</span>' : ""}
      <div class="tile-body">
        <span class="tile-title">${esc(g.title)}</span>
        <span class="tile-sub">${esc(isSoon ? g.blurb : String(g.players).toUpperCase())}</span>
      </div>`;
    if (!isSoon) {
      const live = liveText(g);
      if (live) {
        const b = document.createElement("span");
        b.className = "tile-live";
        b.textContent = live;
        el.appendChild(b);
      }
      tileLive[g.slug] = el;
    }
    return el;
  }

  function railEl(title, list, isSoon, sub) {
    const rail = document.createElement("section");
    rail.className = "rail" + (sub ? " rail-feature" : "");
    rail.innerHTML = `
      <div class="rail-head">
        <span class="rail-title">${title}</span>
        ${sub ? `<span class="rail-sub">${esc(sub)}</span>` : ""}
        <span class="rail-count">${list.length} TITLE${list.length === 1 ? "" : "S"}</span>
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
    for (const r of RAILS) {
      const list = games.filter((g) => (g.category || "battle") === r.key && f(g));
      if (list.length) host.appendChild(railEl(r.title, list, false, r.sub));
    }
    if (soon.length) host.appendChild(railEl("COMING SOON", soon, true));
  }

  function renderFilters() {
    const host = $("filters");
    host.textContent = "";
    for (const fdef of FILTERS) {
      const b = document.createElement("button");
      b.className = "fchip" + (filter === fdef.key ? " sel" : "");
      b.textContent = fdef.label;
      b.onclick = () => { filter = fdef.key; renderFilters(); renderRails(); };
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
      renderRails();
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
        const el = tileLive[g.slug];
        if (el) {
          let b = el.querySelector(".tile-live");
          if (!after) { if (b) b.remove(); }
          else {
            if (!b) {
              b = document.createElement("span");
              b.className = "tile-live";
              el.appendChild(b);
            }
            b.textContent = after;
          }
        }
      }
    } catch { /* transient — next tick */ }
  }

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
      img.loading = "lazy";
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
      } else if (m.type === "msg") renderMsg(m);
      else if (m.type === "presence") setOnline(m.online);
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
