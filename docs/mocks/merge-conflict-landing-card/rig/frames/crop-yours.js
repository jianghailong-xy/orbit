freeze();
const card = landingCard('yours');
$('.session-project-page-card').after(card);
await sleep(200);
return { clip: colClip(card) };
