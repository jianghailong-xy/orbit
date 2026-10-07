freeze();
const card = landingCard('fixing');
$('.session-project-page-card').after(card);
const [, a2, a4] = msgs();
const l1 = line('is-blocked', G.warn, 'P3.2 couldn’t land — conflict in AccountSelect.tsx', { action: 'Details' });
a2.after(l1);
const l2 = line('', G.back, 'Coordinator sent P3.2 back to fix it · round 2 started', { action: 'Open' });
a4.after(l2);
await sleep(300);
if (window.MARKS !== false) { mark(card, 1); mark(l1.firstElementChild, 2, { pad: 4 }); mark(l2.firstElementChild, 3, { pad: 4 }); }
return { ok: true };
