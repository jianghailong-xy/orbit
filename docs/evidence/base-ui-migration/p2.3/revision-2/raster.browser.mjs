import { test } from '@playwright/test';
const variants = {
  original: '',
  cardWillChange: '.toast { will-change: transform; }',
  cardTransform: '.toast { transform: translateZ(0); }',
  viewportTransform: '.toast-viewport { transform: translateZ(0); }',
  hostWillChange: '.toast-layer { will-change: transform; }',
  backface: '.toast { backface-visibility: hidden; }',
  isolate: '.toast-viewport { isolation: isolate; }',
  opacityGroup: '.toast-layer { opacity: .999999; }',
};
for (const [name, css] of Object.entries(variants)) {
 test(name, async ({page},info)=>{
  await page.goto('/ui-migration/toasts.html');
  await page.evaluate(()=>document.fonts.ready);
  if(css) await page.addStyleTag({content:css});
  await page.getByRole('button',{name:'Error notice',exact:true}).click();
  await page.mouse.move(0,0);
  await page.evaluate(async()=>{
   await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
   await Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})));
  });
  await info.attach('notification',{body:await page.locator('.toast-viewport').screenshot({animations:'allow'}),contentType:'image/png'});
 });
}
