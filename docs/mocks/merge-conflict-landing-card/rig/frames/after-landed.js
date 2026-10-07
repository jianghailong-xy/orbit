freeze();
const today = [...$$('.session-col-list > section')].find((s) => s.querySelector('.session-section-head')?.textContent === 'Today');
const row = landedRow();
today.querySelector('.session-section-head').after(row);
const [, a2, a4, a6] = msgs();
a2.after(line('', G.warn, 'P3.2 couldn’t land — conflict fixed in round 2', { action: 'Details' }));
a4.after(line('', G.back, 'Coordinator sent P3.2 back to fix it · round 2 started', { action: 'Open' }));
const l3 = line('is-landed', G.check, 'P3.2 landed on the project branch · after 1 conflict', { action: 'Receipt' });
a6.after(l3);
await sleep(300);
if (window.MARKS !== false) { mark(row, 1, { pad: 2 }); mark(l3.firstElementChild, 2, { pad: 4 }); }
return { ok: true };
