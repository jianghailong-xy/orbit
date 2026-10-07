freeze();
const merge = el(`<div class="session-project-merge is-blocked" data-shape="blocked">
  <div class="session-project-merge-head"><span class="session-project-merge-tile"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 7l4-4 4 4"/><path d="M12 3v8"/><path d="M12 11c0 3.5-5 4.5-5 9.5"/><path d="M12 11c0 3.5 5 4.5 5 9.5"/></svg></span><span class="session-project-merge-title">Can’t merge into main yet</span></div>
  <div class="lc-cause">Conflicts with main in <code>TaskDetailPanel.tsx</code></div>
  <div class="lc-other">main moved after your Merge to main</div>
  <button class="lc-status" type="button">${spin}<span class="lc-status-text">Sync task is fixing it · step 2 of 4<span class="lc-status-sub">filed 12m ago · active 1m ago</span></span><span class="lc-chev">›</span></button>
  <div class="lc-note"><b>Your Merge to main still stands</b> — it merges by itself once the fix passes the check.</div>
  <div class="session-project-merge-foot"><button type="button" class="session-project-merge-link" style="white-space:nowrap">Details ›</button><button type="button" style="white-space:nowrap">Cancel merge</button></div>
</div>`);
$('.session-project-page-card').after(merge);
await sleep(200);
return { clip: colClip(merge) };
