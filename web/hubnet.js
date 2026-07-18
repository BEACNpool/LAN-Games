/* hubnet.js — shared client plumbing for every hub game.
   Identity (same localStorage keys as WORDCLASH so names carry over),
   reconnecting WebSocket, server-clock offset, toasts, confetti. */
"use strict";

const Hub = (() => {
  const AVATARS = ["🦊", "🐸", "🦖", "🐙", "🦉", "🐯", "🐼", "🦄",
                   "👾", "🤖", "🐲", "😈", "🦈", "🐝", "🦩", "🐢"];

  const identity = {
    get token() { return localStorage.getItem("wc-token") || ""; },
    set token(v) { localStorage.setItem("wc-token", v); },
    get name() { return localStorage.getItem("wc-name") || ""; },
    set name(v) { localStorage.setItem("wc-name", v); },
    get avatar() { return localStorage.getItem("wc-avatar") || ""; },
    set avatar(v) { localStorage.setItem("wc-avatar", v); },
    // the device's uploaded photo URL, remembered so the hub can show it
    // without a live game connection
    get pfp() { return localStorage.getItem("wc-pfp") || ""; },
    set pfp(v) { if (v) localStorage.setItem("wc-pfp", v); else localStorage.removeItem("wc-pfp"); },
    ensureToken() {
      // uploads can happen before the first WS welcome assigns a token —
      // mint one client-side (server accepts well-formed client tokens)
      if (!this.token) {
        const b = crypto.getRandomValues(new Uint8Array(16));
        this.token = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
      }
      return this.token;
    },
  };

  /* render a player's avatar into `el`: custom photo if they have one,
     else their emoji. Sizing is em-based, so it scales with the host. */
  function fillAvatar(el, p) {
    el.textContent = "";
    if (p && p.pfp) {
      const img = document.createElement("img");
      img.className = "pfp";
      img.src = p.pfp;
      img.alt = "";
      img.draggable = false;
      el.appendChild(img);
    } else {
      el.textContent = p ? p.avatar : "?";
    }
  }

  async function uploadPfp(file) {
    const res = await fetch("/api/avatar", {
      method: "POST",
      headers: { "x-wc-token": identity.ensureToken() },
      body: file,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "upload failed");
    }
    const url = (await res.json()).url;
    identity.pfp = url;
    return url;
  }

  async function removePfp() {
    await fetch("/api/avatar", {
      method: "DELETE",
      headers: { "x-wc-token": identity.ensureToken() },
    }).catch(() => {});
    identity.pfp = "";
  }

  /* editPhoto(file) -> Promise<Blob|null>: a crop+zoom modal. The user pans
     (drag), zooms (pinch / slider), frames their face in the circle, and we
     render the framed square to a 512px canvas. Resolves null if cancelled.
     Respects EXIF orientation so phone photos aren't sideways. */
  function editPhoto(file) {
    return new Promise((resolve) => {
      const ov = document.createElement("div");
      ov.className = "crop-ov";
      ov.innerHTML =
        '<div class="crop-card">'
        + '<p class="crop-title">FRAME YOUR FACE</p>'
        + '<div class="crop-stage"><canvas class="crop-cv"></canvas>'
        + '<div class="crop-ring"></div></div>'
        + '<div class="crop-zoom"><span>👤</span>'
        + '<input type="range" class="crop-slider" min="1" max="4" step="0.01" value="1">'
        + '<span>🔍</span></div>'
        + '<p class="crop-hint">drag to move · pinch or slide to zoom</p>'
        + '<div class="crop-btns"><button class="btn crop-cancel">CANCEL</button>'
        + '<button class="btn btn-primary crop-ok">USE PHOTO</button></div></div>';
      document.body.appendChild(ov);
      const cv = ov.querySelector(".crop-cv");
      const ctx = cv.getContext("2d");
      const slider = ov.querySelector(".crop-slider");
      let img = null, V = 0, iw = 0, ih = 0, base = 1, zoom = 1, ox = 0, oy = 0;

      function fit() {
        const stage = ov.querySelector(".crop-stage");
        V = stage.clientWidth || 260;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        cv.width = V * dpr; cv.height = V * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      function draw() {
        const s = base * zoom, dw = iw * s, dh = ih * s;
        ox = Math.min(0, Math.max(V - dw, ox));   // image always covers the frame
        oy = Math.min(0, Math.max(V - dh, oy));
        ctx.clearRect(0, 0, V, V);
        ctx.drawImage(img, ox, oy, dw, dh);
      }
      function loaded(im) {
        img = im; iw = im.width || im.naturalWidth; ih = im.height || im.naturalHeight;
        fit();
        base = Math.max(V / iw, V / ih);
        zoom = 1; slider.value = 1;
        ox = (V - iw * base) / 2; oy = (V - ih * base) / 2;
        draw();
      }
      (async () => {
        try {
          if (window.createImageBitmap) {
            loaded(await createImageBitmap(file, { imageOrientation: "from-image" }));
            return;
          }
        } catch (e) { /* fall through to <img> */ }
        const im = new Image();
        im.onload = () => loaded(im);
        im.onerror = () => { ov.remove(); toast("couldn't read that image", "err"); resolve(null); };
        im.src = URL.createObjectURL(file);
      })();

      function setZoom(z, fx, fy) {
        z = Math.min(4, Math.max(1, z));
        const rect = cv.getBoundingClientRect();
        const px = fx == null ? V / 2 : fx - rect.left;
        const py = fy == null ? V / 2 : fy - rect.top;
        const s0 = base * zoom, s1 = base * z;
        ox = px - (px - ox) * (s1 / s0);          // keep focal point steady
        oy = py - (py - oy) * (s1 / s0);
        zoom = z; slider.value = z;
        draw();
      }
      slider.addEventListener("input", () => setZoom(parseFloat(slider.value)));

      const pts = new Map();
      let drag = null, pinch = null;
      cv.addEventListener("pointerdown", (e) => {
        cv.setPointerCapture(e.pointerId);
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pts.size === 1) drag = { x: e.clientX, y: e.clientY };
        else if (pts.size === 2) {
          const [a, b] = [...pts.values()];
          pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: zoom }; drag = null;
        }
      });
      cv.addEventListener("pointermove", (e) => {
        if (!pts.has(e.pointerId) || !img) return;
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinch && pts.size >= 2) {
          const [a, b] = [...pts.values()];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          setZoom(pinch.z * (d / pinch.d), (a.x + b.x) / 2, (a.y + b.y) / 2);
        } else if (drag && pts.size === 1) {
          ox += e.clientX - drag.x; oy += e.clientY - drag.y;
          drag = { x: e.clientX, y: e.clientY }; draw();
        }
      });
      const endPtr = (e) => {
        pts.delete(e.pointerId);
        if (pts.size < 2) pinch = null;
        if (pts.size === 0) drag = null;
      };
      cv.addEventListener("pointerup", endPtr);
      cv.addEventListener("pointercancel", endPtr);

      const close = (val) => { ov.remove(); resolve(val); };
      ov.querySelector(".crop-cancel").onclick = () => close(null);
      ov.addEventListener("click", (e) => { if (e.target === ov) close(null); });
      ov.querySelector(".crop-ok").onclick = () => {
        if (!img) return close(null);
        const E = 512, out = document.createElement("canvas");
        out.width = E; out.height = E;
        const f = E / V, s = base * zoom;
        out.getContext("2d").drawImage(img, ox * f, oy * f, iw * s * f, ih * s * f);
        out.toBlob((blob) => close(blob), "image/webp", 0.9);
      };
    });
  }

  /* one-tap photo picker: file input -> crop/zoom -> upload -> notify the
     server via {t:"profile"} so game state refreshes */
  function wirePfpButton(btn, getConn, onDone) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.hidden = true;
    document.body.appendChild(input);
    btn.addEventListener("click", () => input.click());
    input.addEventListener("change", async () => {
      const f = input.files && input.files[0];
      input.value = "";
      if (!f) return;
      try {
        const blob = await editPhoto(f);
        if (!blob) return;                        // cancelled
        const url = await uploadPfp(blob);
        const conn = getConn && getConn();
        if (conn) conn.send({ t: "profile" });
        toast("📷 picture saved");
        onDone && onDone(url);
      } catch (e) {
        toast(e.message || "upload failed", "err");
      }
    });
  }

  function buildAvatarGrid(host, current, onPick) {
    host.textContent = "";
    for (const a of AVATARS) {
      const c = document.createElement("button");
      c.className = "avatar-cell" + (a === current ? " sel" : "");
      c.textContent = a;
      c.onclick = () => {
        host.querySelectorAll(".avatar-cell").forEach((x) => x.classList.remove("sel"));
        c.classList.add("sel");
        onPick(a);
      };
      host.appendChild(c);
    }
  }

  function toast(msg, cls = "") {
    let holder = document.getElementById("toasts");
    if (!holder) {
      holder = document.createElement("div");
      holder.id = "toasts";
      holder.className = "toasts";
      document.body.appendChild(holder);
    }
    const t = document.createElement("div");
    t.className = "toast " + cls;
    t.textContent = msg;
    holder.appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }

  /* connect(gamePath, handlers) -> conn
     handlers: onState(st), onFx(fx), onWelcome(msg)
     conn: send(obj), now() (server-synced ms), alive */
  function connect(wsPath, handlers) {
    const conn = { ws: null, offset: 0, retry: 0, closedByUs: false,
                   send(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); },
                   now() { return Date.now() + this.offset; } };
    let banner = document.getElementById("conn-banner");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "conn-banner";
      banner.className = "conn-banner";
      banner.textContent = "RECONNECTING…";
      banner.hidden = true;
      document.body.appendChild(banner);
    }
    let rejects = 0;
    function open() {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}${wsPath}`);
      conn.ws = ws;
      let welcomed = false;
      ws.onopen = () => {
        conn.retry = 0;
        banner.hidden = true;
        ws.send(JSON.stringify({
          t: "hello", token: identity.token || undefined,
          name: identity.name || undefined,
          avatar: identity.avatar || undefined,
        }));
      };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.type === "welcome") {
          welcomed = true;
          rejects = 0;
          if (msg.token) identity.token = msg.token;
          handlers.onWelcome && handlers.onWelcome(msg);
        } else if (msg.type === "fx" && !welcomed) {
          // pre-welcome fx = join rejection reason (e.g. room full)
          if (msg.msg) toast(msg.msg, "err");
        } else if (msg.type === "state") {
          const off = msg.now - Date.now();
          conn.offset = conn.offset === 0 ? off : conn.offset * 0.8 + off * 0.2;
          handlers.onState(msg);
        } else if (msg.type === "fx") {
          handlers.onFx && handlers.onFx(msg);
        }
      };
      ws.onclose = () => {
        if (conn.closedByUs) return;
        if (!welcomed) {
          // the server refused this join (room full / socket cap) — do NOT
          // hammer it forever
          rejects++;
          if (rejects >= 3) {
            banner.hidden = true;
            toast("can't join right now — the room is full", "err");
            return;
          }
        }
        banner.hidden = false;
        const wait = Math.min(5000, 600 + conn.retry * 800);
        conn.retry++;
        setTimeout(open, wait);
      };
      ws.onerror = () => { try { ws.close(); } catch (e) {} };
    }
    open();
    setInterval(() => conn.send({ t: "ping" }), 25000);
    return conn;
  }

  /* tiny confetti (canvas #confetti must exist) */
  function confettiBurst(n = 160) {
    const cv = document.getElementById("confetti");
    if (!cv) return;
    if (!cv._parts) {
      cv._parts = [];
      const fit = () => { cv.width = innerWidth; cv.height = innerHeight; };
      addEventListener("resize", fit); fit();
    }
    const COLS = ["#22d3ee", "#a78bfa", "#f472b6", "#10c96e", "#eab308"];
    for (let i = 0; i < n; i++) {
      cv._parts.push({
        x: Math.random() * innerWidth, y: -20 - Math.random() * 80,
        vx: (Math.random() - 0.5) * 3, vy: 2 + Math.random() * 4,
        rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.3,
        w: 6 + Math.random() * 7, h: 4 + Math.random() * 5,
        c: COLS[(Math.random() * COLS.length) | 0], life: 250,
      });
    }
    if (!cv._raf) {
      const cx = cv.getContext("2d");
      const loop = () => {
        cv._raf = requestAnimationFrame(loop);
        cx.clearRect(0, 0, cv.width, cv.height);
        cv._parts = cv._parts.filter((p) => p.life > 0 && p.y < cv.height + 30);
        if (!cv._parts.length) { cancelAnimationFrame(cv._raf); cv._raf = null; return; }
        for (const p of cv._parts) {
          p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.vy += 0.02; p.life--;
          cx.save(); cx.translate(p.x, p.y); cx.rotate(p.rot);
          cx.fillStyle = p.c; cx.globalAlpha = Math.min(1, p.life / 60);
          cx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); cx.restore();
        }
      };
      loop();
    }
  }

  return { AVATARS, identity, buildAvatarGrid, toast, connect, confettiBurst,
           fillAvatar, uploadPfp, removePfp, editPhoto, wirePfpButton };
})();
