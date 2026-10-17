import { test, expect } from '@playwright/test';
test('original confirmation closes by unmounting without an exit animation', async ({ page }, info) => {
 await page.emulateMedia({ reducedMotion: 'no-preference' });
 await page.goto('/ui-migration/toasts.html');
 await page.getByRole('button', { name: 'Confirm save', exact: true }).click();
 await expect(page.getByRole('alertdialog', { name: 'Save schedule?', exact: true })).toBeVisible();
 const opening = await page.evaluate(async()=>{
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const popup=document.querySelector('.orbit-confirm'), s=getComputedStyle(popup);
  return {count:popup.getAnimations().length, opacity:s.opacity, scale:s.scale, translate:s.translate};
 });
 await info.attach('original-confirmation-open', {body:JSON.stringify(opening),contentType:'application/json'});
 expect(opening).toEqual({count:0, opacity:'1', scale:'none', translate:'none'});
 await page.keyboard.press('Escape');
 const state = await page.evaluate(()=>({confirmCount:document.querySelectorAll('.orbit-confirm').length, confirmationAnimations:document.getAnimations().filter(a=>a.effect?.target?.closest?.('.orbit-confirm')).length}));
 await info.attach('original-confirmation-close', {body:JSON.stringify(state),contentType:'application/json'});
 expect(state).toEqual({confirmCount:0,confirmationAnimations:0});
});
