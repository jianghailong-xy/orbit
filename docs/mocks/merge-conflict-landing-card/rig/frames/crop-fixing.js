freeze();
const card = landingCard('fixing');
$('.session-project-page-card').after(card);
await sleep(200);
return { clip: colClip(card) };
