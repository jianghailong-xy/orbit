const theme = process.env.THEME ?? 'light';
const ids = await (await fetch('http://127.0.0.1:3995/api/__ids')).json();
const t = (n) => `${n}-${theme}`;
export default { theme, steps: [
  { api: '/api/__reset' },
  { go: `/workspaces/${ids['ws:orbit']}`, ms: 3500 }, { click: 'New session', exact: true, ms: 2500 },
  { realClick: '.composer-pill > .ant-select', ms: 1500 }, { shot: t('web-2-mode-menu') }, { dump: t('web-2-mode-menu') },
  { key: 'Escape', sel: 'body', ms: 800 },
  { realClick: '.composer-model-chip', ms: 1500 },
  { evalOut: t('dbg-menu'), js: `[...document.querySelectorAll('.composer-model-menu li')].map(e => e.className + ' :: ' + e.textContent).join('\\n')` },
  { realClick: '.composer-model-menu .ant-dropdown-menu-submenu:last-of-type .ant-dropdown-menu-submenu-title', ms: 1500 },
  { shot: t('web-2c-effort-menu') }, { dump: t('web-2c-effort-menu') },
  { go: `/sessions/${ids.S4}`, ms: 13000 }, { shot: t('web-8d-old-runner-queued') }, { dump: t('web-8d-old-runner-queued') },
] };
