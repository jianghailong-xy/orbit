import { uuidToBase62 } from '@orbit/shared';
import { FIXED_NOW, FIXTURE_IDS } from './fixtures.mjs';
import { WORKSPACE } from './session-fixtures.mjs';

// P4.1 data: sign-in, first-run setup, the profile's photo and sign-in methods, Settings → Access
// tokens with its dialog and revoke question, the browser half of `orbit login`, and an
// administrator's view of a user's tokens. Registered on top of installFixtures (later routes win),
// so every path not modeled here still falls through to the P0 handler and its unhandled-request
// check. `state` is read on every request, so a test changes an answer before the step that asks.
// Synthetic, public test data only.
const id = (suffix) => uuidToBase62(`0196e000-0000-7000-8000-${suffix.padStart(12, '0')}`);
const DAY = 86_400_000;
const now = Date.parse(FIXED_NOW);
const at = (offset) => new Date(now + offset).toISOString();

export const CLI_CODE = 'WXYZ4-8K2QP';
export const P41_PATHS = {
  login: '/login', setup: '/setup', profile: '/settings/profile', settings: '/settings',
  tokens: '/settings/access-tokens', cli: `/cli-login?code=${CLI_CODE}`, admin: '/admin',
};
export const PASSWORD = 'correct horse battery';
export const ISSUED_TOKEN = 'orbit_pat_uiMigrationFixtureToken0123456789abcdefXYZ';
export const LOGIN_ERROR = 'Invalid email or password';
export const BOOTSTRAP_ERROR = 'Fixture: setup was already completed in another tab.';
export const TOKENS_ERROR = 'Fixture: the token list is unavailable.';
export const CLI_ERROR = 'login request not found or expired — run `orbit login` again';

// 96×96 JPEG (blue top with a white disc, amber bottom): the profile photo GET /users/me/avatar answers.
export const AVATAR_JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCABgAGADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDjKKKK/cD4UKKKKACiiigAooooAKKKKACiiigAooooAKKK7r4GeGIfFPxCtba7Eb2dkhvbiN8HzVRlATBBBBZlBBxld3OcVhia8cPSlVntFXNKVN1JqC3Z1Xwb+D3/AAkFnHr/AIpFxb6dJte0tUOx7lcg72PVYyOBjDNnIIGC3v8A4f8AD+h+H7fyNF0qzsEKIjmGIK0gUYXe3VyMnliTyfWtOivynMc2xGPm3N2j0XRf5+p9ZhsJTw8bRWvcqatpematbrbarp1nfwK4dY7mFZVDAEbgGBGcEjPua8P+K/wStoNOl1fwTDcGSL5pdNLmTcgA5iJ+YsMElSTuyduCAp97orPAZniMDNSpS07dH8iq+Fp142mvn1PgmivWP2m/DEOjeMYNatBGkGsozvGuBtmTaHbAAGGDI2ckli5PavJ6/V8Fi44uhGvDaS/4dfJnydek6NRwfQKKKK6jEKKKKACve/2Rf+Zn/wC3T/2tXglek/s6+JE0H4hRWdzJILXVk+xkB22iUsDExUA7ju+QdMeYTkDOfJz2hKvl9WEN7X+5p/odmAmoYiLf9X0Pq2iiivyU+uCiiigDyP8Aas/5J5Yf9haP/wBEzV8y17R+1P4kS98QWXhm2kk2achmugHYKZZACoK4wSqchsn/AFpHGDnxev1PhuhKll8Obrd/J7f5nymZTU8Q7dNAooor3TgPouiiiv4HP6MCiiigDufCfiyMxLZ6vNtdcCOdujDphj2PueMdfU9jG6SRrJGyujAFWU5BB6EGvFantby7tN32W6ng3Y3eXIVzjpnFfbZXxnWw1NUsRHnS631+ff8AD5nz2MyCnWk50nyt9On/AAD2SuX8TeLLa1gaDTJknum43r8yRjHXPRjz06evTB4S5v766jEdzeXE6A5CySswB9cE1XrTMuNqtam6eFhyX6t3fy7euvyJwnD8KcuatLm8unzHSO8kjSSMzuxJZmOSSepJptFFfDN3d2fRbBRRRSGFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAf/9k=', 'base64');
// 160×120 PNG the photo picker is given; the page cuts and re-encodes it before PUT /users/me/avatar.
export const UPLOAD_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAKAAAAB4CAIAAAD6wG44AAABL0lEQVR4nO3RAQkAIQDAwPdTG8c4xjKFCOMuwWBj7vXR9b8O4C6D4wyOMzjO4DiD4wyOMzjO4DiD4wyOMzjO4DiD4wyOMzjO4DiD4wyOMzjO4DiD4wyOMzjO4DiD4wyOMzjO4DiD4wyOMzjO4DiD4wyOMzjO4DiD4wyOMzjO4DiD4wyOMzjO4DiD4wyOMzjO4DiD4wyOMzjO4DiD4wyOMzjO4DiD4wyOMzjO4DiD4wyOMzjO4DiD4wyOMzjO4DiD4wyOMzjO4DiD4wyOMzjO4DiD4wyOMzjO4DiD4wyOMzjO4DiD4wyOMzjO4DiD4wyOMzjO4DiD4wyOMzjO4DiD4wyOMzjO4DiD4wyOMzjO4DiD4wyOMzjO4DiD4wyOMzjO4DiD4wyOMzjO4DiD4wyOO23PAtAY2PvTAAAAAElFTkSuQmCC', 'base64');

const READ = ['tasks:read', 'projects:read', 'sessions:read', 'workspaces:read', 'runners:read', 'wiki:read', 'events:read'];
const ALL = ['tasks:read', 'tasks:write', 'projects:read', 'projects:write', 'sessions:read', 'sessions:write',
  'workspaces:read', 'workspaces:write', 'runners:read', 'wiki:read', 'wiki:write', 'events:read'];
const token = (suffix, name, over) => ({
  id: id(suffix), name, tokenHint: `h${suffix}`, scopes: READ, workspaceIds: [], workspaces: [], expiresAt: at(30 * DAY),
  createdVia: 'WEB', lastUsedAt: null, lastUsedIp: null, lastUsedUserAgent: null, revokedAt: null, revokedReason: null,
  createdAt: at(-10 * DAY), state: 'ACTIVE', ...over,
});
export const TOKENS = [
  token('701', 'CI pipeline', { scopes: ALL, expiresAt: null, lastUsedAt: at(-3 * 3_600_000), lastUsedIp: '203.0.113.7', lastUsedUserAgent: 'orbit-cli/0.1.220' }),
  token('702', 'Laptop script', { scopes: ['tasks:read', 'tasks:write', 'wiki:read'], workspaceIds: [WORKSPACE.id], workspaces: [WORKSPACE], expiresAt: at(90 * DAY), createdVia: 'CLI_DEVICE' }),
  token('703', 'Old cron', { state: 'REVOKED', revokedAt: at(-2 * DAY), revokedReason: 'ADMIN' }),
  token('704', 'Demo', { state: 'EXPIRED', expiresAt: at(-5 * DAY) }),
];
export const ADMIN_USER = { id: id('41'), email: 'dev@example.test', name: 'Dev', role: 'MEMBER', createdAt: at(-30 * DAY), signInMethods: { password: true, google: null } };
const cliRequest = (over = {}) => ({
  userCode: CLI_CODE, name: 'orbit CLI on devbox', scopes: READ, expiresInDays: 90, hostname: 'devbox', status: 'PENDING',
  createdAt: at(-60_000), expiresAt: at(9 * 60_000), nameInUse: false, ...over,
});

/** A promise the test resolves to let a held answer through. */
function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

export async function installP41Fixtures(page, { theme = 'light', signedOut = false } = {}) {
  const state = {
    // The P0 account (fixtures.mjs), held here so a photo, a sign-in method or a saved preference
    // shows in every later read of it.
    account: { id: FIXTURE_IDS.user, name: 'Baseline Reviewer', email: 'reviewer@example.test', createdAt: '2026-09-27T10:00:00.000Z',
      avatarUpdatedAt: null, role: 'MEMBER', preferences: { theme, defaultPermissionMode: 'default', notifySessionFinished: true, notifyAgentMessage: true, enableOrchestration: true } },
    setupNeeded: false, bootstrapError: false, google: false,
    tokens: TOKENS.map((t) => structuredClone(t)), tokensError: false, holdTokens: null,
    cli: cliRequest(), cliError: false, holdCli: null, cliDecisionError: false,
    adminTokens: TOKENS.slice(0, 2).map((t) => structuredClone(t)), holdPreferences: null,
  };
  const requests = [];
  if (signedOut) {
    // After installFixtures' script, which signs the baseline account in on every load: signed out
    // until a test marks the tab signed in (a sign-in's own navigation then lands signed in).
    await page.addInitScript(() => { if (sessionStorage.getItem('p41-signed-in') !== '1') localStorage.removeItem('orbit_token'); });
  }
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const { pathname: path } = new URL(request.url());
    const method = request.method();
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    const body = () => { try { return request.postDataJSON(); } catch { return request.postData() ? '<multipart>' : null; } };
    const note = () => requests.push({ method, path, body: method === 'GET' ? undefined : body() });
    if (method === 'GET' && path === '/api/auth/setup-status' && state.setupNeeded) { note(); return json({ needsSetup: true }); }
    if (method === 'POST' && path === '/api/auth/bootstrap') {
      note();
      if (state.bootstrapError) return json({ message: BOOTSTRAP_ERROR }, 409);
      return json({ accessToken: `baseline.${Buffer.from(JSON.stringify({ sub: FIXTURE_IDS.user })).toString('base64')}.fixture`, refreshToken: 'fixture-refresh' });
    }
    if (method === 'POST' && path === '/api/auth/login') {
      note();
      const { password } = request.postDataJSON();
      if (password !== PASSWORD) return json({ message: LOGIN_ERROR }, 401);
      return json({ accessToken: `baseline.${Buffer.from(JSON.stringify({ sub: FIXTURE_IDS.user })).toString('base64')}.fixture`, refreshToken: 'fixture-refresh' });
    }
    if (method === 'GET' && path === '/api/auth/methods' && state.google) return json({ password: true, google: true, googleSignup: false });
    if (method === 'GET' && path === '/api/users/me') return json(state.account);
    if (method === 'PATCH' && (path === '/api/users/me' || path === '/api/users/me/preferences')) {
      note();
      if (state.holdPreferences) await state.holdPreferences.promise;
      if (path.endsWith('/preferences')) Object.assign(state.account.preferences, request.postDataJSON());
      else Object.assign(state.account, request.postDataJSON());
      return json(state.account);
    }
    if (method === 'GET' && path === '/api/users/me/avatar') return route.fulfill({ status: 200, contentType: 'image/jpeg', body: AVATAR_JPEG });
    if (method === 'PUT' && path === '/api/users/me/avatar') {
      note();
      state.account.avatarUpdatedAt = FIXED_NOW;
      return json(state.account);
    }
    if (method === 'DELETE' && path === '/api/users/me/avatar') {
      note();
      state.account.avatarUpdatedAt = null;
      return json(state.account);
    }
    if (method === 'POST' && path === '/api/auth/change-password') {
      note();
      return json({ success: true, revokedAccessTokens: request.postDataJSON().revokeAccessTokens ? 2 : 0 });
    }
    if (method === 'GET' && path === '/api/access-tokens') {
      if (state.holdTokens) await state.holdTokens.promise;
      if (state.tokensError) return json({ message: TOKENS_ERROR }, 503);
      return json({ tokens: state.tokens });
    }
    if (method === 'POST' && path === '/api/access-tokens') {
      note();
      const asked = request.postDataJSON();
      const issued = { id: id('709'), token: ISSUED_TOKEN, name: asked.name, tokenHint: ISSUED_TOKEN.slice(-4), scopes: asked.scopes,
        workspaceIds: asked.workspaceIds ?? [], expiresAt: asked.expiresInDays === null ? null : at(asked.expiresInDays * DAY), createdVia: 'WEB', createdAt: FIXED_NOW };
      const { token: _secret, ...row } = issued;
      state.tokens = [{ ...row, workspaces: [], lastUsedAt: null, lastUsedIp: null, lastUsedUserAgent: null, revokedAt: null, revokedReason: null, state: 'ACTIVE' }, ...state.tokens];
      return json(issued);
    }
    const revoke = path.match(/^\/api\/access-tokens\/([^/]+)$/);
    if (method === 'DELETE' && revoke) {
      note();
      state.tokens = state.tokens.map((t) => (t.id === revoke[1] ? { ...t, state: 'REVOKED', revokedAt: FIXED_NOW, revokedReason: 'USER' } : t));
      return json({ id: revoke[1], revokedAt: FIXED_NOW, revokedReason: 'USER' });
    }
    if (path === `/api/access-tokens/device/${CLI_CODE}`) {
      if (state.holdCli) await state.holdCli.promise;
      if (state.cliError) return json({ message: CLI_ERROR }, 404);
      return json(state.cli);
    }
    const decided = path.match(new RegExp(`^/api/access-tokens/device/${CLI_CODE}/(approve|deny)$`));
    if (method === 'POST' && decided) {
      note();
      if (state.cliDecisionError) return json({ message: 'You already have 50 access tokens — revoke one before issuing another' }, 409);
      state.cli = { ...state.cli, status: decided[1] === 'approve' ? 'APPROVED' : 'DENIED' };
      return json({ status: state.cli.status, name: state.cli.name });
    }
    if (method === 'GET' && path === '/api/admin/users') return json([ADMIN_USER]);
    if (method === 'GET' && path === `/api/admin/users/${ADMIN_USER.id}/access-tokens`) return json({ tokens: state.adminTokens });
    const adminRevoke = path.match(new RegExp(`^/api/admin/users/${ADMIN_USER.id}/access-tokens/([^/]+)$`));
    if (method === 'DELETE' && adminRevoke) {
      note();
      state.adminTokens = state.adminTokens.map((t) => (t.id === adminRevoke[1] ? { ...t, state: 'REVOKED', revokedAt: FIXED_NOW, revokedReason: 'ADMIN' } : t));
      return json({ id: adminRevoke[1], revokedAt: FIXED_NOW, revokedReason: 'ADMIN' });
    }
    if (method !== 'GET') note();
    return route.fallback();
  });
  return { state, requests, gate };
}

/** A stand-in document for where a sign-in or the first-run setup sends the browser. */
export async function stubLanding(page, path) {
  await page.route((url) => url.pathname === path.split('?')[0] && !url.pathname.startsWith('/api/'), (route) =>
    route.request().resourceType() === 'document'
      ? route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><title>Landed</title><p id="landed">Landed at ${path}</p>` })
      : route.fallback());
}
