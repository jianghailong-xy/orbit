freeze();
const card = landingCard('triage');
$('.session-project-page-card').after(card);
await sleep(200);
return { clip: colClip(card) };
