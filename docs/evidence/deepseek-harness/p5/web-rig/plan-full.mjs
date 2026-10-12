const theme = process.env.THEME ?? 'light';
const ids = await (await fetch('http://127.0.0.1:3995/api/__ids')).json();
const t = (n) => `${n}-${theme}`;
const MODE = '.composer-pill:not(.composer-pill-workspace):not(.composer-model-pill):not(.composer-usage) > .ant-select';
const newSession = (ws) => [{ go: `/workspaces/${ws}`, ms: 3500 }, { click: 'New session', exact: true, ms: 2500 }];
export default { theme, steps: [
  { api: '/api/__reset' },
  ...newSession(ids['ws:orbit']),
  { shot: t('web-1-compose') },
  { clickSel: '.np-card', ms: 1200 }, { shot: t('web-1b-provider-picker') }, { dump: t('web-1b-provider-picker') },
  { clickSel: '.np-card', ms: 800 },
  { clickSel: MODE, ms: 1200 }, { shot: t('web-2-mode-menu') }, { dump: t('web-2-mode-menu') },
  { key: 'Escape', sel: 'body', ms: 600 },
  { clickSel: '.composer-model-pill .ant-dropdown-trigger, .composer-model-pill button, .composer-model-pill span', ms: 1200 },
  { shot: t('web-2b-model-menu') }, { dump: t('web-2b-model-menu') },
  { hover: 'Effort', within: '.composer-model-menu', ms: 1500 }, { shot: t('web-2c-effort-menu') }, { dump: t('web-2c-effort-menu') },
  { key: 'Escape', sel: 'body', ms: 600 },
  // Default: Harness's files are read-only and a write asks once (P4) — the approval below is what
  // that mode does. Auto would write inside the workspace without asking.
  { realClick: MODE, ms: 1200 }, { realClickText: 'Default', within: '.ant-select-dropdown', ms: 1200 },
  { evalOut: t('chain-mode'), js: `document.querySelector('${MODE}')?.textContent ?? ''` },
  { type: '列出仓库根目录，并加一个 NOTES.md 记下你看到了什么', sel: 'textarea' },
  { clickSel: 'button[aria-label="Send"]', ms: 3000 },
  { wait: '我先列一下', ms: 15000 }, { shot: t('web-3-running') },
  { wait: 'NOTES.md', ms: 5000 }, { sleep: 1500 }, { shot: t('web-4-approval') }, { dump: t('web-4-approval') },
  { clickSel: '.approval-actions button', ms: 2000 },
  { wait: 'Wrote NOTES.md' }, { sleep: 1500 }, { shot: t('web-5-approved-running') },
  { clickSel: 'button[aria-label="Stop"]', ms: 2000 },
  { wait: 'Interrupted' }, { sleep: 1500 }, { shot: t('web-6-stopped') }, { dump: t('web-6-stopped') },
  { type: '继续：把 NOTES.md 再补一行测试命令', sel: 'textarea' },
  { clickSel: 'button[aria-label="Send"]', ms: 3000 },
  { wait: '已在 NOTES.md' }, { sleep: 1500 }, { shot: t('web-7-resumed') }, { dump: t('web-7-resumed') },
  { go: `/sessions/${ids.S3}`, ms: 3500 }, { shot: t('web-8-invalid-key') },
  { go: `/sessions/${ids.S6}`, ms: 3500 }, { shot: t('web-8b-no-key') },
  { go: `/sessions/${ids.S5}`, ms: 3500 }, { shot: t('web-8c-not-installed') },
  { go: `/sessions/${ids.S4}`, ms: 9000 }, { shot: t('web-8d-old-runner-queued') }, { dump: t('web-8d-old-runner-queued') },
  ...newSession(ids['ws:legacy']), { clickSel: '.np-card', ms: 1200 }, { shot: t('web-9-picker-old-runner') },
  ...newSession(ids['ws:builds']), { clickSel: '.np-card', ms: 1200 }, { shot: t('web-9b-picker-not-installed') },
  { api: '/api/__set?keys=none' },
  ...newSession(ids['ws:orbit']), { clickSel: '.np-card', ms: 1200 }, { shot: t('web-9c-picker-no-key') }, { dump: t('web-9c-picker-no-key') },
  { api: '/api/__reset' },
  { go: '/providers', ms: 4000 }, { shot: t('web-10-providers') }, { dump: t('web-10-providers') },
  { go: '/providers/new/deepseek-harness', ms: 3500 }, { shot: t('web-10b-connect-harness') }, { dump: t('web-10b-connect-harness') },
  { go: `/runners/${ids.R3}`, ms: 4000 }, { shot: t('web-11-runner-not-installed') }, { dump: t('web-11-runner-not-installed') },
] };
