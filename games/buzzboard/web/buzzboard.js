/* BUZZ BOARD phone controller — selector, buzzer, answers, and wagers. */
"use strict";

const $ = (id) => document.getElementById(id);
const S = { st: null, pid: null, conn: null, joined: !!Hub.identity.name,
  stage: "", wagerKind: "", wagerKey: "", wagerDraft: 0,
  timerDeadline: 0, timerTotal: 1, gameoverKey: "" };
let avatar = Hub.identity.avatar || Hub.AVATARS[0];

const SFX = (() => {
  let ctx = null;
  const tone = (f, type="sine", dur=.1, vol=.045, delay=0) => {
    try {
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === "suspended") ctx.resume();
      const o=ctx.createOscillator(), g=ctx.createGain(), at=ctx.currentTime+delay;
      o.type=type; o.frequency.setValueAtTime(f,at); g.gain.setValueAtTime(.0001,at);
      g.gain.exponentialRampToValueAtTime(vol,at+.012); g.gain.exponentialRampToValueAtTime(.0001,at+dur);
      o.connect(g); g.connect(ctx.destination); o.start(at); o.stop(at+dur+.03);
    } catch (e) {}
  };
  return {
    unlock(){ try { if (!ctx) ctx=new (window.AudioContext||window.webkitAudioContext)(); ctx.resume(); } catch(e){} },
    tap(){ tone(620,"square",.045,.025); },
    buzz(){ tone(155,"sawtooth",.12,.055); tone(310,"square",.08,.03,.06); },
    right(){ [523,659,784].forEach((f,i)=>tone(f,"sine",.17,.05,i*.07)); },
    wrong(){ tone(145,"sawtooth",.18,.045); },
    final(){ [220,330,440].forEach((f,i)=>tone(f,"triangle",.28,.035,i*.12)); },
  };
})();

function show(id) {
  for (const sid of ["scr-join","scr-lobby","scr-game"]) $(sid).hidden = sid !== id;
}
const money = (n) => (n < 0 ? "−$" + Math.abs(n).toLocaleString() : "$" + n.toLocaleString());
const nameOf = (pid) => S.st?.players?.find((p)=>p.pid===pid)?.name || "PLAYER";
const meRow = (g) => g?.roster?.find((r)=>r.pid===S.pid) || null;

/* join */
Hub.buildAvatarGrid($("avatar-grid"), avatar, (a)=>{ avatar=a; });
$("name-input").value = Hub.identity.name || "";
$("join-btn").onclick = () => {
  SFX.unlock();
  Hub.identity.name = ($("name-input").value || "").trim() || "PLAYER";
  Hub.identity.avatar = avatar; S.joined = true;
  S.conn.send({t:"profile",name:Hub.identity.name,avatar});
  show(S.st && !["lobby","countdown"].includes(S.st.phase) ? "scr-game" : "scr-lobby");
  render(S.st);
};
Hub.wirePfpButton($("pfp-btn"), ()=>S.conn, ()=>{});
Hub.wirePfpButton($("pfp-btn2"), ()=>S.conn, ()=>{});

/* lobby */
const SEGS = [
  {host:"opt-length",key:"length",opts:[["quick","QUICK 4×3"],["show","THE SHOW 5×5"]]},
  {host:"opt-penalty",key:"penalty",opts:[["none","NO LOSS"],["half","HALF"],["classic","FULL"]]},
];
for (const seg of SEGS) for (const [value,label] of seg.opts) {
  const b=document.createElement("button"); b.type="button"; b.textContent=label; b._value=value;
  b.onclick=()=>{ SFX.tap(); S.conn.send({t:"settings",patch:{[seg.key]:value}}); };
  $(seg.host).appendChild(b);
}
function renderLobby(st) {
  for (const seg of SEGS) for (const b of $(seg.host).children)
    b.classList.toggle("sel", b._value === st.settings[seg.key]);
  $("setup-note").textContent = st.settings.length === "quick"
    ? "12 clues · 1 hidden HOT CLUE · a mid-board POWER SURGE · LAST CALL. About 12 minutes."
    : "25 clues · 2 hidden HOT CLUES · maximum game-show drama. About 25 minutes.";
  const ready=st.players.filter((p)=>p.ready&&p.connected).length;
  $("ready-count").textContent=`${ready}/${Math.max(2,st.players.length)} READY`;
  const grid=$("player-grid"); grid.textContent="";
  for (const p of st.players) {
    const row=document.createElement("div"); row.className="bb-player"+(p.ready?" ready":"")+(p.connected?"":" away");
    const av=document.createElement("span"); av.className="bb-player-av"; Hub.fillAvatar(av,p);
    const nm=document.createElement("span"); nm.className="bb-player-name"; nm.textContent=p.name+(p.pid===S.pid?" · YOU":"");
    const flag=document.createElement("span"); flag.className="bb-player-state"; flag.textContent=p.ready?"READY":"…";
    row.append(av,nm,flag); grid.appendChild(row);
  }
  const readyMe=!!st.you?.ready, canGo=readyMe&&ready>=st.min_players&&st.phase==="lobby";
  $("ready-btn").textContent=readyMe?"READY ✓":"READY UP";
  $("ready-btn").classList.toggle("is-ready",readyMe); $("ready-btn").hidden=canGo;
  $("go-btn").hidden=!canGo;
  $("lobby-hint").textContent=st.phase==="countdown"?"LIGHTS UP — THE SHOW IS STARTING…"
    :canGo?"you can start the show":ready<2?"two ready players needed":"waiting for someone to start";
}
$("ready-btn").onclick=()=>{SFX.unlock();S.conn.send({t:"ready",ready:!S.st?.you?.ready});};
$("go-btn").onclick=()=>{SFX.unlock();S.conn.send({t:"start"});};

function clearControls() {
  $("bb-pick-board").hidden=true; $("bb-buzzer").hidden=true; $("bb-choices").hidden=true;
  $("bb-wager").hidden=true; $("bb-look").hidden=true;
}
function look(icon="👀", title="LOOK AT THE BIG SCREEN", sub="the show is happening up there") {
  const box=$("bb-look"); box.hidden=false; box.querySelector("span").textContent=icon;
  box.querySelector("b").textContent=title; box.querySelector("small").textContent=sub;
}
function renderPickBoard(g) {
  const host=$("bb-pick-board"); host.textContent=""; host.hidden=false;
  for (const cat of g.board) {
    const wrap=document.createElement("section"); wrap.className="bb-pick-cat";
    const h=document.createElement("h3"); h.textContent=cat.icon+" "+cat.title.toUpperCase();
    const vals=document.createElement("div"); vals.className="bb-pick-values";
    for (const cell of cat.cells) {
      const b=document.createElement("button"); b.type="button"; b.dataset.cell=cell.id;
      b.textContent=money(cell.value); b.disabled=cell.used;
      b.onclick=()=>{ b.disabled=true; SFX.tap(); S.conn.send({t:"select",cell:cell.id}); };
      vals.appendChild(b);
    }
    wrap.append(h,vals); host.appendChild(wrap);
  }
}
function renderChoices(g, action) {
  const host=$("bb-choices"); host.textContent=""; host.hidden=false;
  const choices=g.me?.choices||[];
  choices.forEach((label,i)=>{
    const b=document.createElement("button"); b.type="button"; b.className="bb-answer";
    const key=document.createElement("b"); key.textContent=String.fromCharCode(65+i);
    b.append(key,document.createTextNode(label));
    b.onclick=()=>{ for(const x of host.children)x.disabled=true; SFX.tap(); S.conn.send({t:action,choice:i}); };
    host.appendChild(b);
  });
}
function renderWager(g, kind, maximum) {
  const box=$("bb-wager"), range=$("bb-wager-range"); box.hidden=false; S.wagerKind=kind;
  maximum=Math.max(0,maximum||0); range.max=maximum; range.step=maximum<100?1:100;
  const existing=kind==="hot_wager"?g.me?.hot_wager:g.me?.final_wager;
  const key=kind+":"+g.used;
  if(S.wagerKey!==key){S.wagerKey=key;S.wagerDraft=existing==null?Math.min(maximum,Math.max(0,Math.round(maximum/2/100)*100)):existing;}
  range.value=Math.min(maximum,S.wagerDraft);
  const sync=()=>{S.wagerDraft=+range.value;$("bb-wager-value").textContent=money(S.wagerDraft);}; range.oninput=sync; sync();
  const presets=$("bb-wager-presets"); presets.textContent="";
  for(const [label,value] of [["ZERO",0],["HALF",Math.round(maximum/2/100)*100],["ALL IN",maximum]]){
    const b=document.createElement("button"); b.type="button"; b.textContent=label;
    b.onclick=()=>{range.value=Math.min(maximum,value);sync();}; presets.appendChild(b);
  }
  $("bb-lock-wager").onclick=()=>{ $("bb-lock-wager").disabled=true; SFX.final(); S.conn.send({t:kind,value:+range.value}); };
  $("bb-lock-wager").disabled=false;
}

function renderGame(st) {
  const g=st.game; if(!g)return; clearControls();
  const mine=meRow(g), score=mine?.score||0;
  $("bb-score").textContent=money(score); $("bb-score").classList.toggle("negative",score<0);
  $("bb-progress").textContent=`${g.used}/${g.total}`;
  $("bb-power").textContent=g.surged?"⚡ POWER SURGE":"ROUND ONE"; $("bb-power").classList.toggle("on",g.surged);
  const stage=g.stage, cur=g.current, me=g.me||{};
  $("bb-status").textContent="BUZZ BOARD"; $("bb-title").textContent="LOOK UP"; $("bb-sub").textContent="";

  if(stage==="board"){
    if(me.selector){ $("bb-status").textContent="YOU CONTROL THE BOARD"; $("bb-title").textContent="PICK A SQUARE"; $("bb-sub").textContent="Choose the category and value on your phone."; renderPickBoard(g); }
    else { $("bb-status").textContent="BOARD CONTROL"; $("bb-title").textContent="WAIT FOR THE PICK"; look("🎯","EYES ON THE BOARD","the selector is choosing the next clue"); }
  } else if(stage==="clue"){
    $("bb-status").textContent=`${cur?.category||"CLUE"} · ${money(cur?.value||0)}`; $("bb-title").textContent="READ THE CLUE"; look("🤫","BUZZER LOCKED","read now — buzz when the screen flashes");
  } else if(stage==="buzz"){
    $("bb-status").textContent=`${cur?.category||"CLUE"} · ${money(cur?.value||0)}`;
    if(me.can_buzz){ $("bb-title").textContent="YOU KNOW IT?"; $("bb-sub").textContent="Hit it before somebody else does."; $("bb-buzzer").hidden=false; $("bb-buzzer").disabled=false; $("bb-buzzer").classList.remove("locked"); }
    else { $("bb-title").textContent=me.locked?"LOCKED OUT":"BUZZERS OPEN"; look(me.locked?"🔒":"⚡",me.locked?"THIS CLUE IS OVER FOR YOU":"WATCH THE BUZZER","next square is a fresh start"); }
  } else if(stage==="answer"){
    if(me.choices){ $("bb-status").textContent="YOU WON THE BUZZER"; $("bb-title").textContent="PICK YOUR ANSWER"; $("bb-sub").textContent=cur?.clue||""; renderChoices(g,"answer"); }
    else { $("bb-status").textContent="ANSWER IN PROGRESS"; $("bb-title").textContent="SOMEONE BEAT YOU"; look("🎤","THEY HAVE THE FLOOR","get ready in case they miss"); }
  } else if(stage==="hot_wager"){
    $("bb-status").textContent="🔥 HOT CLUE"; $("bb-title").textContent=me.selector?"MAKE YOUR WAGER":"THE SELECTOR GOES SOLO";
    if(me.selector){ $("bb-sub").textContent="No buzzing. Bet from $0 to "+money(me.hot_max||0)+"."; renderWager(g,"hot_wager",me.hot_max); }
    else look("🔥","SECRET WAGER IN PROGRESS","the clue appears after the wager locks");
  } else if(stage==="hot_answer"){
    $("bb-status").textContent=`🔥 HOT CLUE · ${money(g.me?.hot_wager||0)}`;
    if(me.choices){ $("bb-title").textContent="THIS ONE IS YOURS"; $("bb-sub").textContent=cur?.clue||""; renderChoices(g,"hot_answer"); }
    else { $("bb-title").textContent="SOLO SHOT"; look("🔥","THE SELECTOR IS ANSWERING","no steals on a HOT CLUE"); }
  } else if(stage==="reveal"){
    $("bb-status").textContent="CORRECT RESPONSE"; $("bb-title").textContent=cur?.answer||"REVEAL";
    const won=g.reveal?.winner===S.pid; $("bb-sub").textContent=won?"You take "+money(g.reveal?.delta||0)+" and control the board.":"Scores are locked. Next square coming up.";
    look(won?"✅":"💡",won?"THAT'S YOURS":"ANSWER REVEALED",won?"you control the board next":"eyes up for the next pick");
  } else if(stage==="final_wager"){
    $("bb-status").textContent="LAST CALL · "+(g.final?.category||""); $("bb-title").textContent="SECRET WAGER";
    if(me.final_wager==null){ $("bb-sub").textContent="Everyone gets one last swing. How brave are you?"; renderWager(g,"final_wager",me.final_max); }
    else look("🔐","WAGER LOCKED","nobody sees it until the reveal");
  } else if(stage==="final_answer"){
    $("bb-status").textContent="LAST CALL · "+(g.final?.category||"");
    if(me.final_pick==null&&me.choices){ $("bb-title").textContent="ONE LAST ANSWER"; $("bb-sub").textContent=g.final?.clue||""; renderChoices(g,"final_answer"); }
    else { $("bb-title").textContent="ANSWER LOCKED"; look("🔐","NO CHANGING IT NOW","watch every wager turn over"); }
  } else if(stage==="final_reveal"){
    $("bb-status").textContent="LAST CALL REVEAL"; $("bb-title").textContent=g.final?.answer||"THE ANSWER"; look("🎬","WATCH THE FINAL SCORES","every wager changes the board");
  } else if(st.phase==="game_end") {
    renderGameOver(st,g); look("🏆","WHAT A FINISH","the final scoreboard is in");
  }
}

function renderGameOver(st,g){
  const result=g.result||[]; if(!result.length)return; const key=JSON.stringify(result); $("gameover").hidden=false;
  const top=result[0].score, winners=result.filter((r)=>r.score===top); $("go-title").textContent=winners.map((r)=>nameOf(r.pid)).join(" & ")+(winners.length===1?" WINS!":" WIN!");
  const host=$("go-rows"); host.textContent="";
  result.forEach((r,i)=>{const p=st.players.find((x)=>x.pid===r.pid)||{};const row=document.createElement("div");row.className="bb-go-row"+(r.score===top?" first":"");const av=document.createElement("span");Hub.fillAvatar(av,p);const nm=document.createElement("b");nm.textContent=(i+1)+" · "+(p.name||r.pid);const sc=document.createElement("i");sc.textContent=money(r.score);row.append(av,nm,sc);host.appendChild(row);});
  if(S.gameoverKey!==key&&winners.some((r)=>r.pid===S.pid)){S.gameoverKey=key;Hub.confettiBurst(220);SFX.right();}
}
$("rematch-btn").onclick=()=>{S.conn.send({t:"again"});$("gameover").hidden=true;};

if(window.Brag){const b=Brag.button(()=>{const st=S.st,g=st?.game,res=g?.result||[];if(!res.length)return null;const top=res[0],p=st.players.find((x)=>x.pid===top.pid)||{};return{title:"BUZZ BOARD",icon:"🔔",winner:p,headline:money(top.score)+" · LAST CALL CHAMPION",beaten:res.slice(1).map((r)=>({name:nameOf(r.pid),score:money(r.score)})),sub:"Picked the board. Owned the buzzer."};},"🏆 MAKE BRAG CARD");$("brag-slot").appendChild(b);}

function render(st){
  if(!st)return; S.st=st; $("countdown-overlay").hidden=st.phase!=="countdown";
  if(st.deadline&&st.deadline!==S.timerDeadline){S.timerDeadline=st.deadline;S.timerTotal=Math.max(250,st.deadline-(S.conn?S.conn.now():Date.now()));}
  if(!S.joined){show("scr-join");return;}
  if(st.phase==="lobby"||st.phase==="countdown"){show("scr-lobby");$("gameover").hidden=true;renderLobby(st);return;}
  show("scr-game");renderGame(st);S.stage=st.game?.stage||st.phase;
}
S.conn=Hub.connect("/games/buzzboard/ws",{
  onWelcome:(m)=>{S.pid=m.pid;if(!S.joined&&Hub.identity.name)S.joined=true;render(S.st);},
  onFx:(fx)=>{
    if(fx.kind==="toast")Hub.toast((fx.icon?fx.icon+" ":"")+(fx.msg||""));
    if(fx.kind==="invalid")Hub.toast(fx.msg||"Not now","err");
    if(fx.kind==="too_late")SFX.wrong();
    if(fx.kind==="buzz"){try{navigator.vibrate?.(fx.pid===S.pid?[70,35,90]:35);}catch(e){}SFX.buzz();}
    if(fx.kind==="wrong")SFX.wrong(); if(fx.kind==="reveal"&&fx.winner===S.pid)SFX.right();
    if(fx.kind==="last_call"||fx.kind==="power_surge")SFX.final();
  },
  onState:render,
});

function animateTimer(){
  const st=S.st,el=$("bb-timer-fill"); if(st?.deadline){const rem=Math.max(0,st.deadline-S.conn.now());el.style.transform=`scaleX(${Math.min(1,rem/S.timerTotal)})`;}else el.style.transform="scaleX(0)";
  requestAnimationFrame(animateTimer);
}
$("bb-buzzer").onclick=()=>{$("bb-buzzer").disabled=true;S.conn.send({t:"buzz"});};
animateTimer(); show(S.joined?"scr-lobby":"scr-join");
