freeze();
const today = [...$$('.session-col-list > section')].find((s) => s.querySelector('.session-section-head')?.textContent === 'Today');
const row = landedRow();
today.querySelector('.session-section-head').after(row);
await sleep(200);
return { clip: colClip(row, 120) };
