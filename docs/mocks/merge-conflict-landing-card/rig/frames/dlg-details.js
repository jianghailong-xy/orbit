freeze();
$('.session-project-page-card').after(landingCard('fixing'));
const [, a2, a4] = msgs();
a2.after(line('is-blocked', G.warn, 'P3.2 couldn’t land — conflict in AccountSelect.tsx', { action: 'Details' }));
a4.after(line('', G.back, 'Coordinator sent P3.2 back to fix it · round 2 started', { action: 'Open' }));
const step = (time, ico, cls, body, sub = '', next = false) => `<li class="lc-step${next ? ' is-next' : ''}"><span class="lc-step-time">${time}</span><span class="lc-step-ico ${cls}">${ico}</span><span class="lc-step-body">${body}${sub ? `<span class="lc-step-sub">${sub}</span>` : ''}</span></li>`;
const d = dialog({
  title: 'P3.2 can’t land yet', width: 660, top: 40,
  body: `
    <div class="lc-sum">${spin}<div class="lc-sum-text"><b>Round 2 is fixing it</b> — step 3 of 5, re-verifying on the merged tree · active 1m ago
      <div class="lc-sum-sub">Lands again by itself once round 2 is accepted. Nothing for you to do.</div></div>
      <button class="lc-btn" type="button">Open round 2</button></div>
    <div><div class="lc-h">What happened</div><ol class="lc-steps">
      ${step('21:33', G.check, 'ok', 'Coordinator accepted the delivery — Orbit started landing P3.2', 'onto project/34ZZeq0e… · generation 1')}
      ${step('21:34', G.x, 'bad', 'Stopped at a conflict — nothing landed', 'the project branch is still at da13423')}
      ${step('21:37', G.back, 'back', 'Coordinator sent P3.2 back: merge main, resolve the conflict, re-verify what it touched', 'its delivered work is kept · round 2 started')}
      ${step('now', spin, 'now', 'Round 2 · step 3 of 5 — re-verify on the merged tree', 'main merged in as 3c1b24f, no conflict left')}
      ${step('next', G.dot, '', 'Round 2 accepted → Orbit lands P3.2 again → this card closes', '', true)}
    </ol></div>
    <div><div class="lc-h">The conflict</div><dl class="lc-kv">
      <dt>File</dt><dd class="lc-mono">src/web/src/components/AccountSelect.tsx</dd>
      <dt>main</dt><dd>712d324a8 feat(antigravity): keep several Google accounts per runner</dd>
      <dt>P3.2</dt><dd>swaps AntD Select for the Orbit Select · orbit/p3-2-2b837b @ b242090</dd>
      <dt>Waiting on it</dt><dd>P3.3 检查试点保真度与迁移收益 · 登记 P3.2 已接受的 P0 迁移差异</dd>
    </dl></div>
    <details class="lc-raw"><summary>What the coordinator was told</summary></details>`,
  foot: `<div class="lc-dlg-foot"><button class="lc-btn" type="button">Chat about this</button><span class="lc-grow"></span>
    <button class="lc-qlink" type="button">Mark as handled</button><button class="lc-qlink is-danger" type="button">Cancel P3.2…</button></div>`,
});
await sleep(300);
return { ok: true };
