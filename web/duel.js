/* duel.js — shared client chrome for 2-seat board games.
   A game page supplies: DuelGame({ wsPath, colors, renderBoard, onState? })
   and gets: join/lobby flow, seat plates, turn indicator, resign/draw/
   takeback bar with offer prompts, result modal + rematch, timers.
   The page must contain the standard duel DOM (see chess/index.html). */
"use strict";

function DuelGame(cfg) {
  const $ = (id) => document.getElementById(id);
  const G = {
    st: null, pid: null, conn: null, joined: false,
    muted: localStorage.getItem("wc-muted") === "1",
    cfg,
  };

  const SFX = (() => {
    let ctx = null;
    const ac = () => {
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === "suspended") ctx.resume();
      return ctx;
    };
    const tone = (f, type, dur, vol = 0.12, when = 0) => {
      if (G.muted) return;
      try {
        const c = ac(), t = c.currentTime + when;
        const o = c.createOscillator(), g = c.createGain();
        o.type = type; o.frequency.setValueAtTime(f, t);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(vol, t + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + dur + 0.05);
      } catch (e) {}
    };
    return {
      unlock: () => { try { ac(); } catch (e) {} },
      click: () => tone(700, "square", 0.04, 0.05),
      place: () => tone(260, "triangle", 0.07, 0.13),
      capture: () => { tone(320, "triangle", 0.07, 0.13); tone(180, "triangle", 0.1, 0.11, 0.05); },
      turn: () => { tone(880, "sine", 0.1, 0.12); tone(1175, "sine", 0.14, 0.1, 0.08); },
      win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, "sine", 0.24, 0.13, i * 0.09)),
      lose: () => tone(220, "sawtooth", 0.5, 0.09),
      bad: () => tone(150, "sawtooth", 0.2, 0.08),
      offer: () => tone(600, "sine", 0.14, 0.11),
    };
  })();
  G.SFX = SFX;

  const game = () => G.st?.game || null;
  const playerByPid = (pid) => (G.st?.players || []).find((p) => p.pid === pid) || null;
  G.game = game;
  G.playerByPid = playerByPid;
  G.myColor = () => game()?.my_color || null;
  G.myTurn = () => {
    const g = game();
    return g && g.stage === "playing" && g.my_color && g.turn === g.my_color;
  };
  G.send = (obj) => G.conn.send(obj);

  function show(id) {
    for (const s of ["scr-join", "scr-lobby", "scr-game"]) $(s).hidden = s !== id;
  }

  /* ---------- lobby ---------- */
  function renderLobby(st) {
    const grid = $("player-grid");
    grid.textContent = "";
    const humans = st.players.filter((p) => !p.bot);
    for (const p of humans) {
      const card = document.createElement("div");
      card.className = "player-card" + (p.ready ? " is-ready" : "") + (p.connected ? "" : " is-away");
      const av = document.createElement("div"); av.className = "pc-avatar";
      Hub.fillAvatar(av, p);
      const meta = document.createElement("div");
      const nm = document.createElement("div"); nm.className = "pc-name"; nm.textContent = p.name;
      if (p.pid === G.pid) {
        const yt = document.createElement("span"); yt.className = "you-tag"; yt.textContent = "YOU";
        nm.appendChild(yt);
      }
      const stt = document.createElement("div");
      stt.className = "pc-status" + (p.ready ? " rdy" : "");
      stt.textContent = !p.connected ? "away" : p.ready ? "READY" : "not ready";
      meta.appendChild(nm); meta.appendChild(stt);
      card.appendChild(av); card.appendChild(meta);
      grid.appendChild(card);
    }
    const readyN = humans.filter((p) => p.ready && p.connected).length;
    $("ready-count").textContent = `${readyN} READY`;
    $("seat-note").textContent =
      readyN === 1 ? "solo? a bot takes the other seat"
      : readyN > 2 ? "two seats — extras watch and rotate in"
      : "";

    const segD = $("opt-difficulty");
    segD.textContent = "";
    for (const [val, label] of [["sharp", "SHARP BOT"], ["rookie", "ROOKIE BOT"]]) {
      const b = document.createElement("button");
      b.textContent = label;
      b.className = st.settings.difficulty === val ? "sel" : "";
      b.onclick = () => { SFX.click(); G.send({ t: "settings", patch: { difficulty: val } }); };
      segD.appendChild(b);
    }
    const segT = $("opt-timer");
    segT.textContent = "";
    for (const [val, label] of [[0, "NONE"], [30, "30s"], [60, "60s"], [120, "2m"]]) {
      const b = document.createElement("button");
      b.textContent = label;
      b.className = st.settings.turn_seconds === val ? "sel" : "";
      b.onclick = () => { SFX.click(); G.send({ t: "settings", patch: { turn_seconds: val } }); };
      segT.appendChild(b);
    }

    const me = st.you;
    const amReady = !!(me && me.ready);
    $("ready-btn").textContent = amReady ? "READY ✓" : "READY UP";
    $("ready-btn").classList.toggle("is-ready", amReady);
    $("go-btn").hidden = !(readyN >= st.min_players && amReady && st.phase === "lobby");
    $("lobby-hint").textContent =
      st.phase === "countdown" ? "SETTING UP…"
      : readyN >= 1 ? "" : `waiting — ${location.host}`;
  }

  /* ---------- game chrome ---------- */
  function renderSeats(st) {
    const g = game();
    for (const color of Object.keys(cfg.colors)) {
      const el = $("seat-" + color);
      if (!el) continue;
      const seatInfo = g.seats[color];
      const p = playerByPid(seatInfo.pid);
      el.textContent = "";
      el.className = "duel-seat"
        + (g.turn === color && g.stage === "playing" ? " turn" : "")
        + (g.my_color === color ? " me" : "");
      const sw = document.createElement("span");
      sw.className = "ds-swatch " + color;
      sw.textContent = cfg.colors[color].icon || "";
      const av = document.createElement("span"); av.className = "ds-av";
      Hub.fillAvatar(av, p);
      const nm = document.createElement("span"); nm.className = "ds-name";
      nm.textContent = (p ? p.name : "—")
        + (seatInfo.auto && p && !p.bot ? " 🛰" : "");
      el.append(sw, av, nm);
      const extra = cfg.seatExtra && cfg.seatExtra(color, g);
      if (extra) {
        const ex = document.createElement("span"); ex.className = "ds-extra";
        ex.textContent = extra;
        el.appendChild(ex);
      }
    }
  }

  function renderOffers(st) {
    const g = game();
    const bar = $("offer-bar");
    bar.hidden = true;
    if (g.stage !== "playing" || !g.my_color) return;
    const mine = g.my_color;
    if (g.draw_offer && g.draw_offer !== mine) {
      bar.hidden = false;
      $("offer-text").textContent = "Opponent offers a DRAW";
      $("offer-yes").onclick = () => G.send({ t: "draw_offer" });
      $("offer-no").onclick = () => G.send({ t: "draw_decline" });
    } else if (g.takeback_offer && g.takeback_offer !== mine) {
      bar.hidden = false;
      $("offer-text").textContent = "Opponent asks for a TAKEBACK";
      $("offer-yes").onclick = () => G.send({ t: "takeback_accept" });
      $("offer-no").onclick = () => G.send({ t: "takeback_decline" });
    }
  }

  function renderActions(st) {
    const g = game();
    const inSeat = !!g.my_color;
    $("duel-actions").hidden = !inSeat || g.stage !== "playing";
    $("act-draw").hidden = !g.supports.draw;
    $("act-takeback").hidden = !g.supports.takeback;
    $("watch-note").hidden = inSeat || g.stage !== "playing";
    const note = $("turn-note");
    if (g.stage !== "playing") { note.textContent = ""; return; }
    if (G.myTurn()) {
      note.textContent = "YOUR MOVE";
      note.classList.add("mine");
    } else {
      const p = playerByPid(g.seats[g.turn]?.pid);
      note.textContent = p ? `${p.name} is thinking…` : "…";
      note.classList.remove("mine");
    }
  }

  /* brag button — winners only (nobody brags about a draw) */
  let bragBtn = null;
  if (window.Brag) {
    bragBtn = Brag.button(() => {
      const g = game();
      if (!g || !g.result || !g.result.winner) return null;
      const wc = g.result.winner;
      const lc = Object.keys(cfg.colors).find((c) => c !== wc);
      const wp = playerByPid(g.seats[wc].pid);
      const lp = playerByPid(g.seats[lc].pid);
      return {
        title: cfg.title || document.title.split("—")[0].trim(),
        icon: cfg.icon || "🏆",
        winner: { name: wp ? wp.name : cfg.colors[wc].name,
                  avatar: wp ? wp.avatar : cfg.colors[wc].icon,
                  pfp: wp ? wp.pfp : null },
        headline: g.result.why,
        beaten: [{ name: lp ? lp.name : cfg.colors[lc].name }],
      };
    });
    const card = document.querySelector("#gameover .modal-card");
    if (card) card.insertBefore(bragBtn, $("rematch-btn"));
  }

  let goShown = false;
  function renderResult(st) {
    const g = game();
    const showIt = st.phase === "game_end" && g && g.result;
    $("gameover").hidden = !showIt;
    if (bragBtn) bragBtn.hidden = !(showIt && g.result.winner);
    if (!showIt) { goShown = false; return; }
    const r = g.result;
    let title, line;
    if (r.winner) {
      const p = playerByPid(g.seats[r.winner]?.pid);
      title = `${(p ? p.name : cfg.colors[r.winner].name).toUpperCase()} WINS`;
      line = `${cfg.colors[r.winner].name} · ${r.why}`;
    } else {
      title = "DRAW";
      line = r.why;
    }
    $("go-title").textContent = title;
    $("go-line").textContent = line;
    if (!goShown) {
      goShown = true;
      const iWon = r.winner && g.my_color === r.winner;
      if (iWon) { Hub.confettiBurst(180); SFX.win(); }
      else if (r.winner && g.my_color) SFX.lose();
      else SFX.win();
    }
  }

  function onState(st) {
    G.st = st;
    if (!G.joined) return;
    if (st.phase === "lobby" || st.phase === "countdown") {
      show("scr-lobby");
      renderLobby(st);
    } else if (st.game) {
      show("scr-game");
      renderSeats(st);
      renderOffers(st);
      renderActions(st);
      cfg.renderBoard(G);
    }
    renderResult(st);
    $("countdown-overlay").hidden = st.phase !== "countdown";
    cfg.onState && cfg.onState(G, st);
  }

  function onFx(fx) {
    switch (fx.kind) {
      case "toast": Hub.toast((fx.icon ? fx.icon + " " : "") + fx.msg); break;
      case "invalid": Hub.toast(fx.msg, "err"); SFX.bad(); break;
      case "offer": SFX.offer(); break;
      case "moved":
        if (cfg.onMoved) cfg.onMoved(G, fx);
        else SFX.place();
        break;
      case "board": break;
      case "game_over": break;
      case "countdown": SFX.turn(); break;
      default: cfg.onFx && cfg.onFx(G, fx);
    }
  }

  /* timers */
  let lastTurnWasMine = false;
  function raf() {
    requestAnimationFrame(raf);
    const st = G.st;
    if (!st) return;
    if (st.phase === "countdown") {
      $("countdown-num").textContent =
        Math.max(1, Math.ceil((st.deadline - G.conn.now()) / 1000));
    }
    const g = game();
    if (!g) return;
    const mine = G.myTurn();
    if (mine && !lastTurnWasMine) { SFX.turn(); }
    lastTurnWasMine = mine;
    const clock = $("duel-clock");
    if (g.stage === "playing" && g.turn_seconds > 0 && st.deadline) {
      const rem = Math.max(0, st.deadline - G.conn.now());
      clock.hidden = false;
      clock.textContent = Math.ceil(rem / 1000) + "s";
      clock.classList.toggle("low", rem < 10500);
    } else clock.hidden = true;
    if (st.phase === "game_end") {
      $("go-auto").textContent =
        `lobby in ${Math.ceil(Math.max(0, st.deadline - G.conn.now()) / 1000)}s`;
    }
  }
  requestAnimationFrame(raf);

  /* wiring */
  $("ready-btn").onclick = () => {
    SFX.unlock(); SFX.click();
    const me = G.st?.you;
    G.send({ t: "ready", ready: !(me && me.ready) });
  };
  $("go-btn").onclick = () => { SFX.unlock(); G.send({ t: "start" }); };
  $("rematch-btn").onclick = () => G.send({ t: "again" });
  $("act-resign").onclick = () => {
    if (confirm("Resign this game?")) G.send({ t: "resign" });
  };
  $("act-draw").onclick = () => { G.send({ t: "draw_offer" }); Hub.toast("draw offered"); };
  $("act-takeback").onclick = () => { G.send({ t: "takeback_offer" }); Hub.toast("takeback asked"); };
  $("mute-btn").onclick = () => {
    G.muted = !G.muted;
    localStorage.setItem("wc-muted", G.muted ? "1" : "0");
    $("mute-btn").textContent = G.muted ? "🔇" : "🔊";
  };
  $("mute-btn").textContent = G.muted ? "🔇" : "🔊";

  let avatarPick = Hub.identity.avatar
    || Hub.AVATARS[(Math.random() * Hub.AVATARS.length) | 0];
  Hub.buildAvatarGrid($("avatar-grid"), avatarPick, (a) => { avatarPick = a; });
  Hub.wirePfpButton($("pfp-btn"), () => G.conn);
  Hub.wirePfpButton($("pfp-btn2"), () => G.conn);
  $("name-input").value = Hub.identity.name;
  const boot = () => {
    G.joined = true;
    G.conn = Hub.connect(cfg.wsPath, {
      onWelcome: (m) => { G.pid = m.pid; },
      onState, onFx,
    });
    show("scr-lobby");
  };
  $("join-btn").onclick = () => {
    SFX.unlock();
    Hub.identity.name = $("name-input").value.trim() || "PLAYER";
    Hub.identity.avatar = avatarPick;
    boot();
  };
  $("name-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("join-btn").click();
  });
  if (Hub.identity.name) boot();
  else show("scr-join");

  return G;
}
