/* brag.js — the winner's share card. Dependency-free (used by gamehub AND
   wordclash): renders a 1080x1080 canvas brag card — winner, who they beat,
   the score, and the LAN Games brand — into a modal with native share
   (when the browser allows it), save-image, and long-press as the
   always-works path on LAN http.

   API:
     Brag.button(getData [, label]) -> <button> to drop into a game-over modal
     Brag.open(data)                -> show the card now
   data: { title, icon, winner: {name, avatar, pfp}, headline,
           beaten: [{name, score?}...], sub? } */
"use strict";

const Brag = (() => {
  const SITE = "LAN Games";
  const S = 1080;
  let modal = null;
  let lastBlob = null;
  let lastText = "";

  /* ---------- canvas card ---------- */

  function rr(cx, x, y, w, h, r) {
    cx.beginPath();
    cx.moveTo(x + r, y);
    cx.arcTo(x + w, y, x + w, y + h, r);
    cx.arcTo(x + w, y + h, x, y + h, r);
    cx.arcTo(x, y + h, x, y, r);
    cx.arcTo(x, y, x + w, y, r);
    cx.closePath();
  }

  function fitFont(cx, text, weight, family, max, maxWidth) {
    let size = max;
    while (size > 20) {
      cx.font = `${weight} ${size}px ${family}`;
      if (cx.measureText(text).width <= maxWidth) break;
      size -= 4;
    }
    return size;
  }

  async function loadImage(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  async function drawCard(d) {
    try {
      await Promise.all([
        document.fonts.load("800 100px Sora"),
        document.fonts.load("700 40px JBMono"),
      ]);
    } catch (e) {}
    const cv = document.createElement("canvas");
    cv.width = cv.height = S;
    const cx = cv.getContext("2d");

    // backdrop
    cx.fillStyle = "#070b14";
    cx.fillRect(0, 0, S, S);
    let g = cx.createRadialGradient(160, -60, 0, 160, -60, 700);
    g.addColorStop(0, "rgba(34,211,238,0.16)");
    g.addColorStop(1, "rgba(34,211,238,0)");
    cx.fillStyle = g; cx.fillRect(0, 0, S, S);
    g = cx.createRadialGradient(S - 100, S * 0.45, 0, S - 100, S * 0.45, 760);
    g.addColorStop(0, "rgba(167,139,250,0.15)");
    g.addColorStop(1, "rgba(167,139,250,0)");
    cx.fillStyle = g; cx.fillRect(0, 0, S, S);
    cx.strokeStyle = "rgba(139,150,179,0.07)";
    cx.lineWidth = 1;
    for (let i = 60; i < S; i += 60) {
      cx.beginPath(); cx.moveTo(i, 0); cx.lineTo(i, S); cx.stroke();
      cx.beginPath(); cx.moveTo(0, i); cx.lineTo(S, i); cx.stroke();
    }
    // gradient border ring
    const ring = cx.createLinearGradient(0, 0, S, S);
    ring.addColorStop(0, "#22d3ee");
    ring.addColorStop(0.55, "#818cf8");
    ring.addColorStop(1, "#c084fc");
    cx.strokeStyle = ring;
    cx.lineWidth = 10;
    rr(cx, 18, 18, S - 36, S - 36, 42);
    cx.stroke();

    // header: game icon + title
    cx.textAlign = "center";
    cx.font = "92px serif";
    cx.fillText(d.icon || "🏆", S / 2, 148);
    cx.fillStyle = "#8b96b3";
    cx.font = "700 34px JBMono, monospace";
    const spacedTitle = (d.title || "").toUpperCase().split("").join(" ");
    cx.fillText(spacedTitle, S / 2, 208);

    // winner block
    cx.font = "700 30px JBMono, monospace";
    cx.fillStyle = "#eab308";
    cx.fillText("👑  W I N N E R", S / 2, 286);

    // avatar: photo circle or emoji
    const AV_Y = 420, AV_R = 108;
    const pfpImg = d.winner && d.winner.pfp ? await loadImage(d.winner.pfp) : null;
    cx.save();
    cx.beginPath();
    cx.arc(S / 2, AV_Y, AV_R, 0, 7);
    cx.strokeStyle = ring;
    cx.lineWidth = 7;
    cx.stroke();
    cx.clip();
    if (pfpImg) {
      cx.drawImage(pfpImg, S / 2 - AV_R, AV_Y - AV_R, AV_R * 2, AV_R * 2);
    } else {
      cx.fillStyle = "#161e33";
      cx.fillRect(S / 2 - AV_R, AV_Y - AV_R, AV_R * 2, AV_R * 2);
      cx.font = "120px serif";
      cx.fillText((d.winner && d.winner.avatar) || "🏆", S / 2, AV_Y + 44);
    }
    cx.restore();

    // winner name (gradient)
    const name = (d.winner && d.winner.name) || "WINNER";
    const nameSize = fitFont(cx, name, "800", "Sora, sans-serif", 96, S - 200);
    cx.font = `800 ${nameSize}px Sora, sans-serif`;
    const ng = cx.createLinearGradient(S / 2 - 300, 0, S / 2 + 300, 0);
    ng.addColorStop(0, "#22d3ee");
    ng.addColorStop(0.55, "#818cf8");
    ng.addColorStop(1, "#c084fc");
    cx.fillStyle = ng;
    cx.fillText(name, S / 2, 638);

    // headline (result / score)
    if (d.headline) {
      cx.fillStyle = "#e8edf9";
      const hs = fitFont(cx, d.headline, "700", "JBMono, monospace", 44, S - 220);
      cx.font = `700 ${hs}px JBMono, monospace`;
      cx.fillText(d.headline, S / 2, 704);
    }

    // defeated list
    const beaten = (d.beaten || []).slice(0, 4);
    if (beaten.length) {
      cx.fillStyle = "#5a6580";
      cx.font = "700 26px JBMono, monospace";
      cx.fillText("— D E F E A T E D —", S / 2, 774);
      cx.font = "700 36px JBMono, monospace";
      let y = 826;
      for (const b of beaten) {
        const label = b.score !== undefined && b.score !== null
          ? `${b.name}   ·   ${b.score}` : b.name;
        cx.fillStyle = "#8b96b3";
        cx.fillText(label, S / 2, y);
        y += 50;
      }
    }
    if (d.sub) {
      cx.fillStyle = "#5a6580";
      cx.font = "600 26px JBMono, monospace";
      cx.fillText(d.sub, S / 2, 1032 - 96);
    }

    // footer brand
    cx.fillStyle = "#5a6580";
    cx.font = "700 24px JBMono, monospace";
    const date = new Date().toLocaleDateString(undefined,
      { month: "short", day: "numeric", year: "numeric" });
    cx.fillText(`${date}   ·   PLAY AT`, S / 2, 962);
    cx.font = "italic 800 74px Sora, sans-serif";
    cx.fillStyle = ng;
    cx.fillText(SITE, S / 2, 1032);
    return cv;
  }

  /* ---------- modal ---------- */

  function ensureModal() {
    if (modal) return;
    const style = document.createElement("style");
    style.textContent = `
      #brag-modal .modal-card { max-width: 420px; }
      #brag-img { width: 100%; border-radius: 16px; display: block;
                  box-shadow: 0 18px 50px rgba(0,0,0,0.6); }
      .brag-hint { text-align: center; font-family: var(--mono);
                   font-size: 11px; color: var(--faint); margin: 10px 0; }
      .brag-btns { display: flex; gap: 8px; }
      .brag-btns button { flex: 1; border: 1px solid var(--line);
                          background: var(--raised); color: var(--text);
                          border-radius: 12px; padding: 12px 8px;
                          font-family: var(--font); font-weight: 800;
                          font-size: 13px; cursor: pointer; }
      .brag-btns #brag-share { background: linear-gradient(135deg,#22d3ee,#818cf8,#c084fc);
                               color: #05070e; border: none; }
      .brag-btn-go { margin-bottom: 10px; }
    `;
    document.head.appendChild(style);
    modal = document.createElement("div");
    modal.id = "brag-modal";
    modal.className = "modal";
    modal.hidden = true;
    modal.innerHTML = `
      <div class="modal-card">
        <img id="brag-img" alt="brag card">
        <p class="brag-hint">long-press the card to share or save it anywhere</p>
        <div class="brag-btns">
          <button id="brag-share">📤 SHARE</button>
          <button id="brag-save">💾 SAVE</button>
          <button id="brag-close">CLOSE</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector("#brag-close").onclick = () => { modal.hidden = true; };
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.hidden = true;
    });
    modal.querySelector("#brag-save").onclick = () => {
      if (!lastBlob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(lastBlob);
      a.download = "lan-games-win.png";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    };
    modal.querySelector("#brag-share").onclick = async () => {
      if (!lastBlob) return;
      const file = new File([lastBlob], "lan-games-win.png",
                            { type: "image/png" });
      try {
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], text: lastText });
        } else if (navigator.share) {
          await navigator.share({ text: lastText });
        }
      } catch (e) { /* user cancelled */ }
    };
  }

  async function open(d) {
    ensureModal();
    const cv = await drawCard(d);
    lastBlob = await new Promise((r) => cv.toBlob(r, "image/png"));
    const names = (d.beaten || []).map((b) => b.name).join(", ");
    lastText = `👑 ${d.winner.name} won ${d.title} on ${SITE}`
      + (names ? ` — defeated ${names}!` : "!")
      + (d.headline ? ` (${d.headline})` : "");
    const img = modal.querySelector("#brag-img");
    img.src = URL.createObjectURL(lastBlob);
    // native share only exists in secure contexts; hide when unavailable
    modal.querySelector("#brag-share").style.display =
      navigator.share ? "" : "none";
    modal.hidden = false;
  }

  function button(getData, label) {
    const b = document.createElement("button");
    b.className = "btn btn-ghost btn-big brag-btn-go";
    b.textContent = label || "📸 BRAG ABOUT IT";
    b.onclick = async () => {
      try {
        const d = await getData();
        if (d) await open(d);
      } catch (e) { console.error("brag", e); }
    };
    return b;
  }

  return { open, button };
})();

window.Brag = Brag;
