freeze();
$('.session-project-page-card').after(landingCard('yours'));
const [, a2, a5] = msgs();
a2.after(line('is-blocked', G.warn, 'P3.2 couldn’t land — conflict in AccountSelect.tsx', { action: 'Details' }));
a5.after(line('is-yours', G.warn, 'Merge conflict on P3.2 is waiting for you', { action: 'Review' }));
dialog({
  title: 'Send P3.2 back to resolve the conflict', width: 600, top: 70,
  body: `
    <div class="orbit-overlay-description lc-quiet">P3.2 reopens with this note. The next round starts from its delivered branch, so nothing is redone.</div>
    <div class="lc-field-label">Note to the next round</div>
    <textarea class="lc-textarea">Merge the latest main into the delivered branch (orbit/p3-2-2b837b) and resolve the conflict in src/web/src/components/AccountSelect.tsx. Keep main’s change from 712d324a8 (Antigravity accounts) as it is, and keep this task’s Orbit Select. Then re-verify only what the merge touched.</textarea>
    <div class="lc-after"><span><b>Then</b> — the coordinator checks the new delivery, as before.</span><span><b>Once it’s accepted</b> — Orbit lands P3.2 again by itself, and this item closes.</span></div>`,
  foot: `<button class="lc-btn" type="button">Cancel</button><button class="lc-btn is-primary" type="button">Send back</button>`,
});
await sleep(300);
return { ok: true };
