import {test,expect} from '@playwright/test';
const fixture='/ui-migration/choices.html';
const button=(parent,name)=>parent.getByRole('button',{name,exact:true});
for(const kind of ['attachment','expiry','search','popover','tooltip']) test(`normal motion is retained for ${kind}`,async({page},info)=>{
  await page.emulateMedia({reducedMotion:'no-preference'});
  const states={};
  for(const system of ['antd','orbit']){
    await page.goto(`${fixture}?sample=${kind}&system=${system}`);
    await page.evaluate(()=>document.fonts.ready);
    await page.mouse.move(0,0);
    await page.getByTestId('neutral').focus();
    await page.evaluate(()=>{
      window.choiceMotion=[];window.choiceMotionDone=false;
      const seen=new Set();const start=performance.now();
      const frame=()=>{
        for(const a of document.getAnimations()){
          const el=a.effect?.target;
          if(!el || ![el,...el.querySelectorAll('.sample-surface')].some(n=>n.matches('.sample-surface')) && !el.closest('.sample-surface')) continue;
          if(seen.has(a)) continue;seen.add(a);
          window.choiceMotion.push({name:a.animationName??a.transitionProperty,type:a.constructor.name,duration:a.effect.getTiming().duration,frames:a.effect.getKeyframes(),tag:el.tagName,classes:el.className});
        }
        if(performance.now()-start<700) requestAnimationFrame(frame);else window.choiceMotionDone=true;
      };requestAnimationFrame(frame);
    });
    const region=page.getByRole('region',{name:'Appearance sample'});
    if(kind==='expiry'||kind==='search') await region.getByRole('combobox').click();
    else if(kind==='tooltip') await region.getByRole('button').hover();
    else await region.getByRole('button').click();
    await expect(page.locator('.sample-surface:visible')).toBeVisible();
    await page.waitForFunction(()=>window.choiceMotionDone);
    states[system]=await page.evaluate(()=>window.choiceMotion);
  }
  await info.attach('normal-motion',{body:JSON.stringify(states),contentType:'application/json'});
  const old=states.antd.filter(a=>a.type==='CSSAnimation' && a.duration>0);
  if(old.length) expect(states.orbit.filter(a=>a.duration>0),'existing popup entrance motion is retained').not.toHaveLength(0);
});
test('Dialog Popover Select escape restores one layer at a time',async({page},info)=>{
  await page.goto(fixture);await page.evaluate(()=>document.fonts.ready);
  const trigger=button(page,'Open Dialog');await trigger.click();
  const parent=page.getByRole('dialog',{name:'Share workspace',exact:true});
  const context=button(parent,'Open context');await context.focus();await page.keyboard.press('Enter');
  const child=page.getByRole('dialog',{name:'Context',exact:true});await expect(child).toBeVisible();
  const select=child.getByRole('combobox',{name:'Context expiry',exact:true});await select.focus();await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.keyboard.press('Escape');await expect(page.getByRole('listbox')).not.toBeVisible();await expect(child).toBeVisible();await expect(parent).toBeVisible();await expect(select).toBeFocused();
  await page.keyboard.press('Escape');await expect(child).not.toBeVisible();await expect(parent).toBeVisible();await expect(context).toBeFocused();
  await page.keyboard.press('Escape');await expect(parent).not.toBeVisible();await expect(trigger).toBeFocused();
});
