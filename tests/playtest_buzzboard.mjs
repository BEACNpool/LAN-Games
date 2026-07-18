// BUZZ BOARD: one TV + three isolated phone controllers play a complete quick
// board through HOT CLUE, POWER SURGE, LAST CALL, podium, and brag card.
// Usage: node tests/playtest_buzzboard.mjs [baseURL] [shotdir]
import { createRequire } from "module";
import os from "os";
import fs from "fs";

const require = createRequire("/home/ubuntudesktop/projects/webdev-toolkit/x.js");
const puppeteer = require("puppeteer-core");
const BASE = process.argv[2] || "http://127.0.0.1:8797";
const OUT = process.argv[3] || os.homedir() + "/tmp/buzzboard-shots";
fs.mkdirSync(OUT, { recursive: true });

const TV = { width: 1440, height: 810, deviceScaleFactor: 1 };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const SMALL = { width: 360, height: 740, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString().slice(11,19)}] ${m}`);
const errors = [];
let bad = 0;
const fail = (m) => { console.error("FAIL: " + m); bad++; };

const browser = await puppeteer.launch({
  executablePath: "/snap/bin/chromium", headless: "new",
  userDataDir: os.homedir() + "/tmp/ghshot-buzzboard",
  args: ["--no-sandbox", "--disable-gpu"],
});
const newCtx = () => browser.createBrowserContext
  ? browser.createBrowserContext() : browser.createIncognitoBrowserContext();
const shown = (pg, sel) => pg.$eval(sel, (e) => !e.hidden && getComputedStyle(e).display !== "none").catch(() => false);
function watch(pg, label) {
  pg.on("console", (m) => { if (m.type() === "error") errors.push(`${label}: ${m.text()}`); });
  pg.on("pageerror", (e) => errors.push(`${label} pageerror: ${e.message}`));
}
async function phone(name, avatarIndex, viewport=PHONE) {
  const ctx=await newCtx(), pg=await ctx.newPage(); await pg.setViewport(viewport); watch(pg,name);
  await pg.goto(`${BASE}/games/buzzboard/`,{waitUntil:"networkidle2"});
  await pg.waitForSelector("#scr-join:not([hidden])",{timeout:6000});
  await pg.type("#name-input",name);
  await pg.evaluate((i)=>document.querySelectorAll("#avatar-grid .avatar-cell")[i].click(),avatarIndex);
  await pg.click("#join-btn"); await pg.waitForSelector("#scr-lobby:not([hidden])",{timeout:5000});
  return pg;
}
async function safeClick(pg, sel) { try { await pg.click(sel); return true; } catch(e) { return false; } }

try {
  const hub=await (await newCtx()).newPage(); await hub.setViewport({width:1280,height:800,deviceScaleFactor:1}); watch(hub,"hub");
  await hub.goto(`${BASE}/`,{waitUntil:"networkidle2"}); await hub.waitForSelector(".rail",{timeout:6000});
  const railTitles=await hub.$$eval(".rail-title",(els)=>els.map((e)=>e.textContent.trim()));
  if(!railTitles.includes("BIG SCREEN"))fail("BIG SCREEN hub rail missing");
  const hubTitles=await hub.$$eval(".tile-title",(els)=>els.map((e)=>e.textContent.trim()));
  if(!hubTitles.includes("BUZZ BOARD"))fail("BUZZ BOARD hub tile missing");
  const badges=await hub.$$eval(".tile-tv-badge",(els)=>els.length); if(badges<4)fail(`expected four TV badges, saw ${badges}`);

  const tv=await (await newCtx()).newPage(); await tv.setViewport(TV); watch(tv,"TV");
  await tv.goto(`${BASE}/games/buzzboard/tv.html`,{waitUntil:"networkidle2"});
  await tv.waitForSelector("#tv-curtain"); await tv.click("#tv-start");
  const qr=await tv.$eval("#tv-qr",(e)=>!!e.querySelector("svg,canvas,img")).catch(()=>false);
  if(!qr)fail("TV QR did not render");

  const phones=[await phone("Ava",0),await phone("Ben",5,SMALL),await phone("Cy",9)];
  await sleep(500); await tv.screenshot({path:`${OUT}/01-tv-lobby.png`});
  await phones[0].screenshot({path:`${OUT}/02-phone-lobby.png`}); log("lobby + QR");

  // Default is QUICK/HALF; exercise the setting controls anyway.
  await phones[0].evaluate(()=>[...document.querySelectorAll("#opt-length button")].find((b)=>b.textContent.includes("QUICK"))?.click());
  await phones[0].evaluate(()=>[...document.querySelectorAll("#opt-penalty button")].find((b)=>b.textContent==="HALF")?.click());
  for(const pg of phones){await pg.click("#ready-btn");await sleep(120);}
  await phones[0].waitForSelector("#go-btn:not([hidden])",{timeout:5000}); await phones[0].click("#go-btn");
  await Promise.all(phones.map((p)=>p.waitForSelector("#scr-game:not([hidden])",{timeout:10000})));
  await tv.waitForSelector(".bb-board",{timeout:7000});
  await tv.screenshot({path:`${OUT}/03-tv-board.png`});
  for(const p of phones){
    const over=await p.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth);
    if(!over)fail("phone has horizontal overflow");
  }
  log("game started");

  let sawPick=false,sawBuzz=false,sawAnswer=false,sawRegularAnswer=false,sawHot=false,sawPower=false,sawFinal=false,testedDraft=false,done=false;
  const started=Date.now(); let actionCount=0;
  while(Date.now()-started<220000){
    for(const pg of phones){
      if(await shown(pg,"#bb-pick-board")){
        if(!sawPick){sawPick=true;await pg.screenshot({path:`${OUT}/04-phone-selector.png`});}
        if(await pg.$eval("#bb-power",(e)=>e.classList.contains("on")).catch(()=>false)){
          const fits=await pg.$$eval("#bb-pick-board button",(els)=>els.every((e)=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}));
          if(!fits)fail("post-surge selector grid clips on a phone");
        }
        const clicked=await pg.evaluate(()=>{const b=document.querySelector("#bb-pick-board button:not(:disabled)");if(b){b.click();return true}return false});
        if(clicked){actionCount++;await sleep(120);}
      }
    }

    const tvText=await tv.$eval("#tv-stage",(e)=>e.textContent).catch(()=>"");
    if(!sawHot&&tvText.includes("HOT CLUE")){sawHot=true;if(tvText.includes("PLAYER MAKES")||tvText.includes("PLAYER GOES"))fail("HOT CLUE lost the selector name");await tv.screenshot({path:`${OUT}/05-tv-hot-clue.png`});log("HOT CLUE");}
    if(!sawFinal&&tvText.includes("LAST CALL")){sawFinal=true;await tv.screenshot({path:`${OUT}/09-tv-last-call.png`});log("LAST CALL");}

    if(sawFinal&&!testedDraft&&await shown(phones[0],"#bb-wager")&&await shown(phones[1],"#bb-wager")){
      await phones[0].$eval("#bb-wager-range",(e)=>{e.value=Math.min(100,+e.max);e.dispatchEvent(new Event("input",{bubbles:true}));});
      const draft=await phones[0].$eval("#bb-wager-range",(e)=>e.value);
      await phones[1].evaluate(()=>[...document.querySelectorAll("#bb-wager-presets button")].find((x)=>x.textContent==="HALF")?.click());
      await safeClick(phones[1],"#bb-lock-wager"); await sleep(350);
      const after=await phones[0].$eval("#bb-wager-range",(e)=>e.value).catch(()=>null);
      if(after!==draft)fail(`LAST CALL wager draft reset from ${draft} to ${after}`);
      testedDraft=true;
    }

    for(const pg of phones){
      if(await shown(pg,"#bb-wager")){
        if(sawHot)await pg.screenshot({path:`${OUT}/06-phone-wager.png`}).catch(()=>{});
        await pg.evaluate(()=>{const b=[...document.querySelectorAll("#bb-wager-presets button")].find((x)=>x.textContent==="HALF");b?.click();});
        await safeClick(pg,"#bb-lock-wager"); actionCount++; await sleep(100);
      }
    }
    for(const pg of phones){
      if(await shown(pg,"#bb-buzzer")){
        if(!sawBuzz){sawBuzz=true;await pg.screenshot({path:`${OUT}/07-phone-buzzer.png`});await tv.screenshot({path:`${OUT}/08-tv-buzz-open.png`});}
        const disabled=await pg.evaluate(()=>{const b=document.querySelector("#bb-buzzer");b?.click();return !!b?.disabled;});
        if(!disabled)fail("buzzer did not disable after tap"); actionCount++; await sleep(80); break;
      }
    }
    for(let i=0;i<phones.length;i++){
      const pg=phones[i];
      if(await shown(pg,"#bb-choices")){
        if(!sawAnswer){sawAnswer=true;await pg.screenshot({path:`${OUT}/08-phone-answer.png`});}
        const status=await pg.$eval("#bb-status",(e)=>e.textContent).catch(()=>"");
        if(status.includes("WON THE BUZZER"))sawRegularAnswer=true;
        await pg.evaluate((n)=>{const bs=[...document.querySelectorAll("#bb-choices .bb-answer:not(:disabled)")];if(bs.length)bs[n%bs.length].click();},(actionCount+i)%4);
        actionCount++; await sleep(100);
      }
    }
    if(!sawPower){
      for(const pg of phones)if(await pg.$eval("#bb-power",(e)=>e.classList.contains("on")).catch(()=>false)){
        sawPower=true;await tv.screenshot({path:`${OUT}/08-tv-power-board.png`});log("POWER SURGE");break;
      }
    }
    done=await shown(phones[0],"#gameover"); if(done)break;
    await sleep(180);
  }
  if(!done)fail("game did not reach the final podium");
  for(const [ok,label] of [[sawPick,"selector"],[sawBuzz,"buzzer"],[sawAnswer,"answers"],[sawRegularAnswer,"a regular buzzer winner answering"],[sawHot,"HOT CLUE"],[sawPower,"POWER SURGE"],[sawFinal,"LAST CALL"],[testedDraft,"a preserved LAST CALL wager draft"]])if(!ok)fail(`never observed ${label}`);
  if(done){await sleep(500);await phones[0].screenshot({path:`${OUT}/10-phone-podium.png`});await tv.screenshot({path:`${OUT}/11-tv-final.png`});
    await phones[0].click("#brag-slot button");await phones[0].waitForSelector("#brag-modal:not([hidden])",{timeout:8000});await phones[0].screenshot({path:`${OUT}/12-brag-card.png`});}
  const rows=await tv.$$(".bb-final-row"); if(!rows.length)fail("TV final wager rows missing");
  log(`complete show: ${actionCount} controller actions`);
  log(errors.length?"CONSOLE ERRORS:\n"+errors.join("\n"):"zero console errors"); if(errors.length)bad++;
  console.log(bad?"BUZZ BOARD PLAYTEST FAIL":"BUZZ BOARD PLAYTEST PASS");
} catch(e){fail(e.stack||e.message);console.log("BUZZ BOARD PLAYTEST FAIL");}
finally{await browser.close();}
process.exit(bad?1:0);
