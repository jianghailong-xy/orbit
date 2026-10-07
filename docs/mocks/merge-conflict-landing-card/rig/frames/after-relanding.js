freeze();
const landing = patchRelanding();
const [, a2, a4, a6] = msgs();
const l1 = line('', G.warn, 'P3.2 couldn’t land — conflict fixed in round 2', { action: 'Details' });
a2.after(l1);
a4.after(line('', G.back, 'Coordinator sent P3.2 back to fix it · round 2 started', { action: 'Open' }));
const l3 = line('is-working', spin, 'Landing P3.2 again · checking', { action: 'Watch' });
a6.after(l3);
await sleep(300);
if (window.MARKS !== false) { mark(landing, 1, { pad: 2 }); mark(l1.firstElementChild, 2, { pad: 4 }); mark(l3.firstElementChild, 3, { pad: 4 }); }
return { ok: true };
