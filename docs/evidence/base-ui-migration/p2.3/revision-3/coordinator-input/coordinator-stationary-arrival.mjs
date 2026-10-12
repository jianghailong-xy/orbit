import { chromium, webkit } from '@playwright/test';
import fs from 'node:fs';
const results=[];
for(const [name,engine] of Object.entries({chromium,webkit})) {
 const browser=await engine.launch({headless:true});
 try {
  for(const [variant,url] of [['revision2','http://127.0.0.1:14383'],['reference','http://127.0.0.1:14384']]) {
   const context=await browser.newContext({viewport:{width:1280,height:900},deviceScaleFactor:1,locale:'en-US',timezoneId:'UTC',colorScheme:'light',reducedMotion:'reduce'});
   const page=await context.newPage();await page.goto(url+'/ui-migration/toasts.html');await page.evaluate(()=>document.fonts.ready);
   const post=page.getByRole('button',{name:'Complete session',exact:true});
   await post.click();const undo=page.locator('button[aria-label="Undo completing Fix login redirect"]');await undo.waitFor();
   const rect=await undo.boundingBox();await page.mouse.move(0,0);
   await page.getByRole('button',{name:'Clear notifications',exact:true}).focus();await page.keyboard.press('Enter');
   await page.locator('.toast-viewport').waitFor({state:'detached'});
   await page.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2);
   await page.evaluate(()=>{window.hoverEvents=[];for(const type of ['mousemove','mouseover','mouseout'])document.addEventListener(type,e=>window.hoverEvents.push({type,target:e.target.className,time:performance.now()}),true)});
   await post.focus();await page.keyboard.press('Enter');await undo.waitFor();
   const began=Date.now();await page.waitForTimeout(6500);
   results.push({browser:name,variant,elapsedMs:Date.now()-began,remaining:await page.locator('.toast-viewport').count(),events:await page.evaluate(()=>window.hoverEvents)});
   await context.close();
  }
 } finally {await browser.close()}
}
fs.writeFileSync(new URL('./coordinator-stationary-arrival.json',import.meta.url),JSON.stringify(results,null,2));console.log(JSON.stringify(results));
