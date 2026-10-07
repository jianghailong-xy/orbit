for (const n of document.querySelectorAll('.workspace-view *')) { if (n.scrollHeight > n.clientHeight + 4 && getComputedStyle(n).overflowY !== 'visible') n.scrollTop = n.scrollHeight; }
await sleep(400);
freeze();
const prog = $('.session-project-page-card');
const card = $('.project-open-item-card');
const head = $('.project-open-item-head', card);
const after = [...$$('.project-open-item-fact', card)].find((n) => n.textContent.includes('After a fix'));
const actions = $('.project-open-item-actions', card);
const oic = $('.oic');
mark(prog, 1, { pad: 3 });
mark(head, 2, { pad: 0 });
mark(after, 3, { pad: 2 });
mark(actions, 4, { pad: 4 });
mark(oic, 5, { pad: 2, dy: 0 });
return { ok: true };
