freeze();
const split = $('.workspace-split');
split.classList.remove('show-conversation');
const card = landingCard('yours');
$('.session-project-page-card').after(card);
await sleep(300);
if (window.MARKS !== false) mark(card, 1);
return { ok: true, cls: split.className };
