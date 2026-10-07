freeze();
const card = landingCard('yours');
$('.session-project-page-card').after(card);
const [, a2, a5] = msgs();
const l1 = line('is-blocked', G.warn, 'P3.2 couldn’t land — conflict in AccountSelect.tsx', { action: 'Details' });
a2.after(l1);
const l2 = line('is-yours', G.warn, 'Merge conflict on P3.2 is waiting for you', { action: 'Review' });
a5.after(l2);
const strip = el(`<div class="decision-strip" aria-label="Open questions"><button class="decision-strip-line" type="button"><span class="decision-strip-dot" aria-hidden="true"></span><span class="decision-strip-title">Merge conflict on P3.2 is waiting for you</span><span class="decision-strip-quiet">2m</span><span class="decision-strip-caret" aria-hidden="true">↓</span></button></div>`);
const wrap = $('.workspace-view .workspace-scroll-wrap');
wrap.before(strip);
await sleep(300);
if (window.MARKS !== false) { mark(card, 1); mark(l1.firstElementChild, 2, { pad: 4 }); mark(l2.firstElementChild, 3, { pad: 4 }); mark(strip, 4, { pad: 1 }); }
return { ok: true };
