// injected helpers (run in page)
window.__tb = {
  section(cardsHtml, n) {
    const head = document.querySelector('.machine-head');
    const s = document.createElement('section');
    s.className = 'settings-section machine-section-terminal-requests';
    s.id = 'terminal-requests';
    s.innerHTML = `<div class="settings-section-head"><h2 class="settings-section-title">Terminals to approve</h2><div class="settings-section-action"><span class="machine-section-note">A request lasts 10 minutes</span></div></div><div class="b-tr-cards" style="display:flex;flex-direction:column;gap:12px">${cardsHtml}</div>`;
    head.after(s);
    for (const d of document.querySelectorAll('.settings-nav .settings-dot, nav .settings-dot')) { d.className = 'settings-dot settings-dot--attention'; d.setAttribute('aria-label', 'Needs you'); }
  },
  banner(title, sub, time) {
    const first = document.querySelector('.workspace-sessions .session-section-head').closest('section');
    const wrap = document.createElement('section');
    wrap.className = 'session-project-landings b-terminal-requests';
    wrap.innerHTML = `<div class="session-section-head">Needs you</div>
<button type="button" class="session-row session-project-merge-row session-project-landing-row">
<span class="session-project-landing-mark" style="background:var(--warning-bg);color:var(--warning-solid)" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7.5 10l2.5 2-2.5 2M12.5 14.5h4"/></svg></span>
<span class="session-project-merge-row-body"><span class="session-project-merge-row-head"><span class="session-project-merge-row-title">${title}</span><span class="session-time">${time}</span></span>
<span class="session-project-merge-row-detail session-preview tone-approval">${sub}</span></span></button>`;
    first.before(wrap);
    return 'ok';
  },
  dropInbox() {
    for (const a of document.querySelectorAll('a, [role="link"], li, .nav-item')) {
      if (a.textContent.trim().startsWith('Waiting on you') && a.closest('aside, nav, .sidebar, .tasks-side-panel')) { (a.closest('a') || a).remove(); }
    }
  },
};
