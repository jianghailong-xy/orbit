// Scenarios that send no prompt: install and version, handshake and auth states, session
// management, model options, credential stores and directory variables, failure shapes.
import { existsSync, readFileSync, writeFileSync, statSync, readdirSync, realpathSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { AUTO_MODEL, currentModel, sleep } from '../lib/harness.mjs';
import { VERSION, ACTIVE_TARBALL_SHA256, CLI_DIR, AGENT, P0_ROOT } from '../lib/env.mjs';

const sha256File = f => createHash('sha256').update(readFileSync(f)).digest('hex');
// Processes whose command line names a path under `dir`.
function processesUnder(dir) {
  const out = [];
  if (process.platform === 'linux') {
    for (const d of readdirSync('/proc')) {
      if (!/^\d+$/.test(d) || Number(d) === process.pid) continue;
      try { const c = readFileSync(`/proc/${d}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); if (c.includes(dir)) out.push({ pid: Number(d), cmdline: c }); } catch {}
    }
  } else {
    // darwin: no /proc; `ps -axo pid=,command=` covers the harness user's processes.
    const r = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
    for (const line of (r.stdout ?? '').split('\n')) {
      const i = line.indexOf(' ');
      if (i <= 0) continue;
      const pid = Number(line.slice(0, i).trim());
      const cmd = line.slice(i + 1);
      if (Number.isInteger(pid) && pid !== process.pid && cmd.includes(dir)) out.push({ pid, cmdline: cmd });
    }
  }
  return out;
}
const errOf = r => r.error ? { code: r.error.code, message: r.error.message, data: r.error.data } : null;
const LOGIN_URL = /^https:\/\/cursor\.com\/loginDeepControl\?challenge=[^&]+&uuid=[^&]+&mode=login&redirectTarget=cli&supportsSelectedTeamLogin=true$/;

export const zeroA = [
  {
    name: 'install-and-version', real: 0, needsKey: false,
    async run(ctx) {
      const tarball = join(P0_ROOT, 'dl', VERSION, 'agent-cli-package.tar.gz');
      ctx.check('the tarball of the build under test has the expected sha256', existsSync(tarball) && sha256File(tarball) === ACTIVE_TARBALL_SHA256, { bytes: existsSync(tarball) ? statSync(tarball).size : null });
      const files = [];
      const walk = d => { for (const n of readdirSync(d)) { const f = join(d, n); const st = statSync(f); st.isDirectory() ? walk(f) : files.push(st.size); } };
      walk(CLI_DIR);
      ctx.note('unpacked', { files: files.length, bytes: files.reduce((a, b) => a + b, 0), indexJsSha256: sha256File(join(CLI_DIR, 'index.js')), launcherSha256: sha256File(join(CLI_DIR, 'cursor-agent')), nodeSha256: sha256File(join(CLI_DIR, 'node')) });
      const slot = ctx.slot('a');
      const v = ctx.cli(slot, ['--version'], { envOpts: { apiKey: false } });
      ctx.check('--version is the build under test', v.exit === 0 && v.stdout.trim() === VERSION, v.stdout.trim());
      for (const args of [['acp', '--help'], ['install', '--help'], ['update', '--help'], ['status', '--help'], ['about', '--help']]) {
        const r = ctx.cli(slot, args, { envOpts: { apiKey: false } });
        ctx.note(`help:${args[0]}`, r.stdout.trim());
      }
      const about = ctx.cli(slot, ['about', '--format', 'json'], { envOpts: { store: 'memory' } });
      const aboutJson = JSON.parse(about.stdout || '{}');
      ctx.note('about', aboutJson);
      // A newer official build is the normal course of things, not a failure: only recorded.
      ctx.check('about reports the build under test as cliVersion', aboutJson.cliVersion === VERSION, aboutJson.cliVersion);
      ctx.note('update channel: latest build and status (recorded, not asserted)', { latestVersion: aboutJson.latestVersion, latestStatus: aboutJson.latestStatus, isLatest: aboutJson.latestVersion === VERSION });
      // The CLI's own installer, into an isolated HOME. Its default URL prefix is the anysphere-binaries
      // S3 bucket (slow from here); the prefix argument points it at the installer script's CDN instead.
      const inst = ctx.slot('installer');
      const r = ctx.cli(inst, ['install', VERSION, `https://downloads.cursor.com/lab/${VERSION}`], { envOpts: { apiKey: false }, timeoutMs: 1200000 });
      ctx.note('install', { exit: r.exit, stdout: r.stdout.trim().slice(-800), stderr: r.stderr.trim().slice(-800), ms: r.ms });
      // The installer leaves a detached `cleanup-install-versions` child running long after it exits (§1.1).
      await sleep(3000);
      const leftBehind = processesUnder(inst.home);
      ctx.note('processes the installer left running (ended by the scenario)', leftBehind.map(p => p.cmdline));
      for (const p of leftBehind) { try { process.kill(p.pid, 'SIGTERM'); } catch {} }
      const versionDir = join(inst.home, '.local', 'share', 'cursor-agent', 'versions', VERSION);
      const link = join(inst.home, '.local', 'bin', 'agent');
      ctx.check('install <version> unpacks into ~/.local/share/cursor-agent/versions/<version>', existsSync(join(versionDir, 'cursor-agent')));
      ctx.check('installed index.js is byte-identical to the tarball under test', existsSync(join(versionDir, 'index.js')) && sha256File(join(versionDir, 'index.js')) === sha256File(join(CLI_DIR, 'index.js')));
      ctx.check('~/.local/bin/agent points at the installed version', existsSync(link) && realpathSync(link) === realpathSync(join(versionDir, 'cursor-agent')));
      ctx.note('installer-home-tree', ctx.tree(inst.home).filter(l => !l.includes('/versions/' + VERSION + '/') || l.split('/').length < 8).slice(0, 60));
    },
  },
  {
    name: 'signed-out-handshake', real: 0, needsKey: false,
    async run(ctx) {
      const slot = ctx.slot('a');
      const work = ctx.repo('work');
      const p = ctx.acp({ slot, cwd: work, label: 'acp', envOpts: { apiKey: false, store: 'memory' } });
      const init = await ctx.initialize(p);
      ctx.note('initialize', init.result);
      ctx.check('initialize works signed out', init.result?.protocolVersion === 1);
      ctx.check('capabilities: loadSession, MCP http+sse, image, session list', init.result?.agentCapabilities?.loadSession === true && init.result.agentCapabilities.mcpCapabilities?.http === true && init.result.agentCapabilities.mcpCapabilities?.sse === true && init.result.agentCapabilities.promptCapabilities?.image === true && !!init.result.agentCapabilities.sessionCapabilities?.list);
      ctx.check('only auth method is cursor_login', JSON.stringify(init.result?.authMethods?.map(m => m.id)) === '["cursor_login"]');
      ctx.check('no agentInfo in initialize', init.result && !('agentInfo' in init.result));
      const n = await ctx.newSession(p, work);
      ctx.check('session/new signed out -> -32000 Authentication required', n.error?.code === -32000, errOf(n));
      const l = await p.request('session/list', {});
      ctx.check('session/list signed out -> -32000', l.error?.code === -32000, errOf(l));
      const a = await p.request('authenticate', { methodId: 'cursor_login' }, 60000);
      const url = String(a.error?.data?.message ?? '').replace(/^.*Please visit: /, '');
      ctx.check('authenticate(cursor_login) with NO_OPEN_BROWSER -> -32602 carrying the login URL, returned at once', a.error?.code === -32602 && LOGIN_URL.test(url), errOf(a));
      const b = await p.request('authenticate', { methodId: 'bogus' }, 30000);
      ctx.check('authenticate(unknown method) -> -32602', b.error?.code === -32602, errOf(b));
      const status = ctx.cli(slot, ['status', '--format', 'json'], { envOpts: { apiKey: false, store: 'memory' } });
      ctx.note('status', JSON.parse(status.stdout || 'null'));
      // stdin EOF does not end the server; SIGTERM does, with exit code 143.
      p.closeStdin();
      const early = await p.waitExit(20000);
      ctx.check('stdin EOF does not end `agent acp` (still running 20 s later)', early === null);
      p.signal('SIGTERM');
      const ex = await p.waitExit(20000);
      ctx.check('SIGTERM exits with code 143', ex?.code === 143, ex);
      ctx.check('stdout carried only JSON-RPC lines', p.nonProtocol.length === 0);
      ctx.fixture(p, 'acp');
    },
  },
  {
    name: 'api-key-session-management', real: 0,
    async run(ctx) {
      const slot = ctx.slot('a');
      const work = ctx.repo('work');
      const p = ctx.acp({ slot, cwd: work, label: 'acp', envOpts: { store: 'memory' } });
      await ctx.initialize(p);
      const t0 = Date.now();
      const a = await ctx.newSession(p, work);
      ctx.note('session/new ms', Date.now() - t0);
      ctx.check('CURSOR_API_KEY alone opens a session (no authenticate call)', !!a.result?.sessionId, errOf(a));
      const r = a.result;
      ctx.note('session/new result (model list truncated)', { ...r, models: { currentModelId: r.models.currentModelId, count: r.models.availableModels.length, first: r.models.availableModels.slice(0, 4) },
        configOptions: r.configOptions.map(o => ({ ...o, options: o.options.length > 6 ? [...o.options.slice(0, 4), `… ${o.options.length} total`] : o.options })) });
      ctx.check('configOptions are exactly [mode, model]', JSON.stringify(r.configOptions.map(o => o.id)) === '["mode","model"]');
      ctx.check('default model is Auto = "default[]"', currentModel(r) === AUTO_MODEL && r.models.availableModels[0]?.name === 'Auto');
      ctx.check('modes agent/plan/ask, current agent', JSON.stringify(r.modes.availableModes.map(m => m.id)) === '["agent","plan","ask"]' && r.modes.currentModeId === 'agent');
      const sid = r.sessionId;
      const models = r.configOptions.find(o => o.id === 'model').options.map(o => o.value);
      const listed = models.find(v => v.startsWith('gpt-5.5[')) ?? models[1];
      const set1 = await p.request('session/set_config_option', { sessionId: sid, configId: 'model', value: listed });
      ctx.check('set_config_option(model, listed variant) returns configOptions', currentModel(set1.result ?? {}) === listed, set1.result ? undefined : errOf(set1));
      for (const [label, value] of [['unlisted variant', listed.replace(/\[.*\]/, '[context=1m]')], ['the alias "auto"', 'auto'], ['an unknown model', 'no-such-model[]']]) {
        const e = await p.request('session/set_config_option', { sessionId: sid, configId: 'model', value });
        ctx.check(`set_config_option(model, ${label}) -> -32602 Invalid model value`, e.error?.code === -32602 && /Invalid model value/.test(e.error?.data?.message ?? ''), errOf(e));
      }
      const e2 = await p.request('session/set_config_option', { sessionId: sid, configId: 'effort', value: 'high' });
      ctx.check('unknown configId -> -32602 Unknown config option', e2.error?.code === -32602, errOf(e2));
      const m1 = await p.request('session/set_config_option', { sessionId: sid, configId: 'mode', value: 'plan' });
      ctx.check('set_config_option(mode, plan) works', m1.result?.configOptions?.find(o => o.id === 'mode')?.currentValue === 'plan');
      const m2 = await p.request('session/set_mode', { sessionId: sid, modeId: 'ask' });
      ctx.check('session/set_mode returns {}', JSON.stringify(m2.result) === '{}', errOf(m2));
      const m3 = await p.request('session/set_mode', { sessionId: sid, modeId: 'yolo' });
      ctx.check('set_mode with an unknown mode -> -32603 (plain error)', m3.error?.code === -32603, errOf(m3));
      const m4 = await p.request('session/set_model', { sessionId: sid, modelId: AUTO_MODEL });
      ctx.check('session/set_model returns {}', JSON.stringify(m4.result) === '{}', errOf(m4));
      // Model choice is process-global: a second session sees the first one's selection.
      const b = await ctx.newSession(p, work);
      const pick = models.find(v => v.startsWith('claude-sonnet-4-6')) ?? models[2];
      await p.request('session/set_config_option', { sessionId: sid, configId: 'model', value: pick });
      const bView = await p.request('session/set_config_option', { sessionId: b.result.sessionId, configId: 'mode', value: 'agent' });
      ctx.check('a model chosen in session A shows up as session B\'s model (process-global)', currentModel(bView.result) === pick, currentModel(bView.result ?? {}));
      const c = await ctx.newSession(p, work);
      ctx.check('a later session/new starts on that model too', currentModel(c.result) === pick);
      await p.request('session/set_config_option', { sessionId: sid, configId: 'model', value: AUTO_MODEL });
      ctx.check('two or more sessions can live in one process', !!b.result?.sessionId && !!c.result?.sessionId && new Set([sid, b.result.sessionId, c.result.sessionId]).size === 3);
      const l1 = await p.request('session/list', { cwd: work });
      ctx.check('session/list {cwd} lists the sessions (even never-prompted ones)', (l1.result?.sessions ?? []).filter(s => [sid, b.result.sessionId, c.result.sessionId].includes(s.sessionId)).length === 3, l1.result?.sessions?.length);
      ctx.note('session/list entry', l1.result?.sessions?.[0]);
      const l2 = await p.request('session/list', { cwd: '/nonexistent-p0-dir' });
      ctx.check('session/list filters by cwd', JSON.stringify(l2.result) === '{"sessions":[]}');
      const l3 = await p.request('session/list', { cwd: 'relative/dir' });
      ctx.check('session/list relative cwd -> -32602', l3.error?.code === -32602, errOf(l3));
      const l4 = await p.request('session/list', { cursor: 'x' });
      ctx.check('session/list pagination cursor -> -32602 (unsupported)', l4.error?.code === -32602, errOf(l4));
      const ld = await ctx.loadSession(p, sid, work);
      ctx.check('session/load of a never-prompted session -> -32602 not found (no store.db yet)', ld.error?.code === -32602, errOf(ld));
      ctx.check('a never-prompted session has meta.json but no store.db', existsSync(join(slot.config, 'acp-sessions', sid, 'meta.json')) && !existsSync(join(slot.config, 'acp-sessions', sid, 'store.db')));
      const ld2 = await ctx.loadSession(p, '00000000-0000-4000-8000-000000000000', work);
      ctx.check('session/load unknown id -> -32602', ld2.error?.code === -32602, errOf(ld2));
      for (const method of ['session/close', 'session/resume', 'session/fork']) {
        const x = await p.request(method, { sessionId: sid, cwd: work, mcpServers: [] });
        ctx.check(`${method} -> -32601 Method not found`, x.error?.code === -32601, errOf(x));
      }
      const up = await p.request('session/prompt', { sessionId: '11111111-1111-4111-8111-111111111111', prompt: [{ type: 'text', text: 'x' }] });
      ctx.check('session/prompt for an unknown session -> -32603 (rejected locally; never reaches a model)', up.error?.code === -32603, errOf(up));
      const nm = await p.request('session/new', { cwd: work });
      ctx.check('session/new without mcpServers -> -32603 with zod issues', nm.error?.code === -32603, errOf(nm));
      p.notify('session/cancel', { sessionId: '22222222-2222-4222-8222-222222222222' });
      await sleep(500);
      ctx.check('session/cancel for an unknown session is ignored (no reply, process alive)', p.exit === null);
      await sleep(4000);
      ctx.note('updates without any prompt', p.updates.map(u => u.update.sessionUpdate));
      ctx.check('available_commands_update arrives without a prompt', p.updates.some(u => u.update.sessionUpdate === 'available_commands_update'));
      ctx.check('stdout carried only JSON-RPC lines', p.nonProtocol.length === 0);
      ctx.fixture(p, 'acp');
    },
  },
  {
    name: 'parameterized-model-picker', real: 0,
    async run(ctx) {
      const slot = ctx.slot('a');
      const work = ctx.repo('work');
      const p = ctx.acp({ slot, cwd: work, label: 'acp', envOpts: { store: 'memory' } });
      const init = await ctx.initialize(p, { _meta: { parameterizedModelPicker: true, subagents: true } });
      ctx.check('clientCapabilities._meta.subagents adds sessionCapabilities.subagents', !!init.result?.agentCapabilities?.sessionCapabilities?.subagents);
      const n = await ctx.newSession(p, work);
      const model = n.result.configOptions.find(o => o.id === 'model');
      ctx.check('with parameterizedModelPicker, model values are bare names and Auto is "default"', model.currentValue === 'default' && model.options.every(o => !o.value.includes('[')));
      const target = model.options.find(o => o.value === 'claude-opus-5-5') ?? model.options[1];
      const s = await p.request('session/set_config_option', { sessionId: n.result.sessionId, configId: 'model', value: target.value });
      const extra = (s.result?.configOptions ?? []).filter(o => !['mode', 'model'].includes(o.id));
      ctx.note(`config options after choosing ${target.value}`, extra.map(o => ({ id: o.id, category: o.category, current: o.currentValue, options: o.options.map(x => `${x.value} (${x.name})`) })));
      ctx.check('choosing a model adds its variant parameters as separate select options (thought_level / model_config)', extra.length > 0 && extra.every(o => ['thought_level', 'model_config'].includes(o.category)));
      if (extra[0]) {
        const alt = extra[0].options.find(o => o.value !== extra[0].currentValue);
        const s2 = await p.request('session/set_config_option', { sessionId: n.result.sessionId, configId: extra[0].id, value: alt.value });
        ctx.check(`setting ${extra[0].id} works`, s2.result?.configOptions?.find(o => o.id === extra[0].id)?.currentValue === alt.value);
        const s3 = await p.request('session/set_config_option', { sessionId: n.result.sessionId, configId: extra[0].id, value: 'not-a-value' });
        ctx.check('an invalid parameter value -> -32602 Invalid value for <id>', s3.error?.code === -32602, errOf(s3));
      }
      await p.request('session/set_config_option', { sessionId: n.result.sessionId, configId: 'model', value: 'default' });
      const lm = await p.request('cursor/list_available_models', {}, 60000);
      ctx.check('extension method cursor/list_available_models lists models with their configOptions', Array.isArray(lm.result?.models) && lm.result.models.length > 0, errOf(lm));
      ctx.note('cursor/list_available_models', { count: lm.result?.models?.length, sample: lm.result?.models?.slice(0, 3) });
      ctx.fixture(p, 'acp');
    },
  },
  {
    name: 'credential-stores', real: 0,
    async run(ctx) {
      const work = ctx.repo('work');
      const authFields = f => existsSync(f) ? { mode: (statSync(f).mode & 0o777).toString(8), fields: Object.keys(JSON.parse(readFileSync(f, 'utf8'))) } : null;
      // Where store=file writes auth.json: $XDG_CONFIG_HOME/cursor on Linux, $HOME/.cursor on macOS (the
      // darwin branch of cli-credentials/dist/index.js; XDG_CONFIG_HOME is ignored on macOS).
      const authPathOf = slot => process.platform === 'darwin' ? join(slot.home, '.cursor', 'auth.json') : join(slot.xdgConfig, 'cursor', 'auth.json');
      const results = {};
      for (const store of ['file', 'memory', null]) {
        const label = store ?? 'unset';
        const slot = ctx.slot(`store-${label}`);
        const p = ctx.acp({ slot, cwd: work, label: `acp-${label}`, envOpts: { store } });
        await ctx.initialize(p);
        const n = await ctx.newSession(p, work);
        await p.dispose();
        results[label] = { newOk: !!n.result, auth: authFields(authPathOf(slot)), status: JSON.parse(ctx.cli(slot, ['status', '--format', 'json'], { envOpts: { store } }).stdout || 'null') };
      }
      ctx.note('stores', results);
      ctx.check(`file store persists accessToken, refreshToken AND the API key in ${process.platform === 'darwin' ? '$HOME/.cursor/auth.json' : '$XDG_CONFIG_HOME/cursor/auth.json'} (0600)`, results.file.auth?.mode === '600' && JSON.stringify(results.file.auth.fields) === '["accessToken","refreshToken","apiKey"]');
      ctx.check('memory store writes no auth.json', results.memory.newOk && results.memory.auth === null);
      if (process.platform === 'darwin') {
        ctx.check('unset store is the macOS Keychain: no auth.json is written', results.unset.auth === null);
        // Keychain entry names are asserted in the darwin-only `macos-keychain-store` scenario.
      } else {
        ctx.check('unset store behaves like file on Linux', results.unset.auth?.mode === '600');
      }
      ctx.check('`status` reports the persisted exchange tokens (file) but not an env-only key (memory)', results.file.status?.isAuthenticated === true && results.memory.status?.isAuthenticated === false, { file: results.file.status?.status, memory: results.memory.status?.status });
      // Token lifetimes (claims only) and injection of a token instead of the key.
      const auth = JSON.parse(readFileSync(authPathOf(ctx.slot('store-file')), 'utf8'));
      ctx.red.secret(auth.accessToken, 'ACCESS_TOKEN').secret(auth.refreshToken, 'REFRESH_TOKEN');
      // Cursor's JWTs carry `time` (issue time, seconds) instead of `iat`.
      const claims = t => { const c = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()); const iat = c.iat ?? Number(c.time); return { claimKeys: Object.keys(c).sort(), type: c.type, scope: c.scope, lifetimeHours: c.exp && iat ? Math.round((c.exp - iat) / 360) / 10 : null }; };
      ctx.note('exchanged token claims (no values)', { access: claims(auth.accessToken), refresh: claims(auth.refreshToken), accessEqualsRefresh: auth.accessToken === auth.refreshToken });
      const tokSlot = ctx.slot('auth-token-env');
      const p1 = ctx.acp({ slot: tokSlot, cwd: work, label: 'acp-auth-token-env', envOpts: { apiKey: false, store: 'memory', extra: { CURSOR_AUTH_TOKEN: auth.accessToken } } });
      await ctx.initialize(p1);
      const n1 = await ctx.newSession(p1, work);
      ctx.check('CURSOR_AUTH_TOKEN (memory store, no API key) opens a session', !!n1.result?.sessionId, errOf(n1));
      await p1.dispose();
      ctx.check('CURSOR_AUTH_TOKEN with memory store persists nothing', !existsSync(authPathOf(tokSlot)));
      const flagSlot = ctx.slot('auth-token-flag');
      const p2 = ctx.acp({ slot: flagSlot, cwd: work, label: 'acp-auth-token-flag', args: ['--auth-token', auth.accessToken], envOpts: { apiKey: false, store: 'memory' } });
      await ctx.initialize(p2);
      const n2 = await ctx.newSession(p2, work);
      ctx.check('--auth-token (argv) opens a session too', !!n2.result?.sessionId, errOf(n2));
      await p2.dispose();
      const keySlot = ctx.slot('api-key-flag');
      const p3 = ctx.acp({ slot: keySlot, cwd: work, label: 'acp-api-key-flag', args: ['--api-key', ctx.key], envOpts: { apiKey: false, store: 'memory' } });
      await ctx.initialize(p3);
      const n3 = await ctx.newSession(p3, work);
      ctx.check('--api-key (argv) opens a session', !!n3.result?.sessionId, errOf(n3));
      await p3.dispose();
      // logout only clears local state
      const fileSlot = join(ctx.dir, 'slots', 'store-file');
      const fileSlotObj = { home: join(fileSlot, 'home'), config: join(fileSlot, 'cursor-config'), data: join(fileSlot, 'cursor-data'), xdgConfig: join(fileSlot, 'xdg-config'), xdgCache: join(fileSlot, 'xdg-cache'), xdgData: join(fileSlot, 'xdg-data') };
      const lo = ctx.cli(fileSlotObj, ['logout'], { envOpts: { apiKey: false, store: 'file' } });
      ctx.note('logout', { exit: lo.exit, stdout: lo.stdout.trim(), stderr: lo.stderr.trim() });
      ctx.check('`agent logout` deletes auth.json', lo.exit === 0 && !existsSync(authPathOf(fileSlotObj)));
    },
  },
  {
    name: 'directory-variables', real: 0,
    async run(ctx) {
      const work = ctx.repo('work');
      const layouts = {
        'home-only': s => ({ layout: 'home' }),
        'home+CURSOR_CONFIG_DIR': s => ({ layout: 'home', extra: { CURSOR_CONFIG_DIR: s.config } }),
        'home+CURSOR_DATA_DIR': s => ({ layout: 'home', extra: { CURSOR_DATA_DIR: s.data } }),
        'home+XDG_CONFIG_HOME': s => ({ layout: 'home', extra: { XDG_CONFIG_HOME: s.xdgConfig } }),
        'home+XDG_DATA_HOME+XDG_CACHE_HOME': s => ({ layout: 'home', extra: { XDG_DATA_HOME: s.xdgData, XDG_CACHE_HOME: s.xdgCache } }),
        'all-variables': s => ({ layout: 'full' }),
      };
      const trees = {};
      const darwin = process.platform === 'darwin';
      for (const [label, f] of Object.entries(layouts)) {
        const slot = ctx.slot(label.replace(/[^a-zA-Z0-9]+/g, '_'));
        const p = ctx.acp({ slot, cwd: work, label, envOpts: { store: 'file', ...f(slot) } });
        await ctx.initialize(p);
        await ctx.newSession(p, work);
        await sleep(3000);
        await p.dispose();
        trees[label] = ctx.tree(slot.root);
        // ctx.tree elides the compile cache and synced skills; their homes are asserted by existence instead.
        trees[label + ':exists'] = { compileCacheHome: existsSync(join(slot.home, 'Library', 'Caches', 'cursor-compile-cache')), compileCacheXdg: existsSync(join(slot.xdgCache, 'cursor-compile-cache')), skillsInHome: existsSync(join(slot.home, '.cursor', 'skills-cursor')), xdgCacheEmpty: !existsSync(slot.xdgCache) || readdirSync(slot.xdgCache).length === 0 };
      }
      ctx.note('files per layout (after initialize + session/new)', trees);
      const has = (label, re) => trees[label].some(l => re.test(l));
      const ex = (label, k) => trees[label + ':exists'][k];
      if (darwin) {
        ctx.check('HOME only: config under ~/.cursor, auth under ~/.cursor/auth.json (macOS ignores XDG for auth)', has('home-only', /^home\/\.cursor\/cli-config\.json/) && has('home-only', /^home\/\.cursor\/auth\.json/));
        ctx.check('CURSOR_CONFIG_DIR moves cli-config, statsig cache and acp-sessions, not auth.json', has('home+CURSOR_CONFIG_DIR', /^cursor-config\/cli-config\.json/) && has('home+CURSOR_CONFIG_DIR', /^cursor-config\/acp-sessions\//) && has('home+CURSOR_CONFIG_DIR', /^home\/\.cursor\/auth\.json/));
        ctx.check('XDG_CONFIG_HOME moves the config dir but auth.json stays in $HOME/.cursor', has('home+XDG_CONFIG_HOME', /^xdg-config\/cursor\/cli-config\.json/) && has('home+XDG_CONFIG_HOME', /^home\/\.cursor\/auth\.json/));
        ctx.check('agent-cli-state.json stays in $HOME/.cursor under every layout', Object.keys(trees).filter(l => !l.endsWith(':exists')).every(l => has(l, /^home\/\.cursor\/agent-cli-state\.json/)));
        ctx.check('built-in skills are synced into $HOME/.cursor/skills-cursor under every layout', Object.keys(trees).filter(l => !l.endsWith(':exists')).every(l => ex(l, 'skillsInHome')));
        ctx.check('the Node compile cache goes to $HOME/Library/Caches on macOS, not XDG_CACHE_HOME', Object.keys(trees).filter(l => !l.endsWith(':exists')).every(l => ex(l, 'compileCacheHome') && !ex(l, 'compileCacheXdg')));
        ctx.check('XDG_DATA_HOME gets nothing the CLI writes at startup', !trees['home+XDG_DATA_HOME+XDG_CACHE_HOME'].some(l => /^xdg-(data|cache)\/./.test(l)));
      } else {
        ctx.check('HOME only: config under ~/.cursor, auth under ~/.config/cursor', has('home-only', /^home\/\.cursor\/cli-config\.json/) && has('home-only', /^home\/\.config\/cursor\/auth\.json/));
        ctx.check('CURSOR_CONFIG_DIR moves cli-config, statsig cache and acp-sessions, not auth.json', has('home+CURSOR_CONFIG_DIR', /^cursor-config\/cli-config\.json/) && has('home+CURSOR_CONFIG_DIR', /^cursor-config\/acp-sessions\//) && has('home+CURSOR_CONFIG_DIR', /^home\/\.config\/cursor\/auth\.json/));
        ctx.check('XDG_CONFIG_HOME (without CURSOR_CONFIG_DIR) moves both config and auth.json to $XDG_CONFIG_HOME/cursor', has('home+XDG_CONFIG_HOME', /^xdg-config\/cursor\/cli-config\.json/) && has('home+XDG_CONFIG_HOME', /^xdg-config\/cursor\/auth\.json/));
        ctx.check('agent-cli-state.json stays in $HOME/.cursor under every layout', Object.keys(trees).filter(l => !l.endsWith(':exists')).every(l => has(l, /^home\/\.cursor\/agent-cli-state\.json/)));
        ctx.check('built-in skills are synced into $HOME/.cursor/skills-cursor under every layout', Object.keys(trees).filter(l => !l.endsWith(':exists')).every(l => ex(l, 'skillsInHome')));
        ctx.check('XDG_DATA_HOME / XDG_CACHE_HOME move nothing the CLI writes at startup', !trees['home+XDG_DATA_HOME+XDG_CACHE_HOME'].some(l => /^xdg-(data|cache)\/./.test(l)));
      }
      ctx.check('CURSOR_DATA_DIR gets nothing at startup (projects/<slug>/ appears only when something creates it, e.g. `agent mcp enable`)', !trees['home+CURSOR_DATA_DIR'].some(l => /^cursor-data\/./.test(l)));
    },
  },
  {
    name: 'failure-shapes-without-prompt', real: 0, needsKey: false,
    async run(ctx) {
      const work = ctx.repo('work');
      const bogus = 'crsr_' + '0'.repeat(64);
      // invalid key
      for (const store of ['memory', 'file']) {
        const slot = ctx.slot(`bogus-${store}`);
        const p = ctx.acp({ slot, cwd: work, label: `acp-bogus-key-${store}`, envOpts: { apiKey: bogus, store } });
        await ctx.initialize(p);
        const n = await ctx.newSession(p, work);
        ctx.check(`invalid API key (${store} store): session/new -> -32603 "Failed to initialize session services"`, n.error?.code === -32603 && n.error?.data?.message === 'Failed to initialize session services', errOf(n));
        const l = await p.request('session/list', {});
        ctx.check(`invalid API key (${store} store): session/list still answers (no auth check with a key present)`, Array.isArray(l.result?.sessions), l.result ?? errOf(l));
        ctx.fixture(p, `bogus-key-${store}`);
        await p.dispose();
      }
      const bs = ctx.slot('bogus-cli');
      const m1 = ctx.cli(bs, ['models'], { envOpts: { apiKey: bogus, store: 'memory' } });
      ctx.check('invalid key: `agent models` exits 1 with "The provided API key is invalid"', m1.exit === 1 && /API key is invalid/.test(m1.stderr), m1.stderr.trim());
      const m2 = ctx.cli(bs, ['--api-key', bogus, 'models'], { envOpts: { apiKey: false, store: 'memory' } });
      ctx.check('invalid key via --api-key: same message, exit 1', m2.exit === 1 && /API key is invalid/.test(m2.stderr));
      if (ctx.key) {
        const good = ctx.cli(ctx.slot('good-cli'), ['models'], { envOpts: { store: 'memory' } });
        ctx.check('valid key: `agent models` exits 0 and lists auto first', good.exit === 0 && /auto - Auto/.test(good.stdout));
        ctx.note('models (first lines)', good.stdout.split('\n').slice(0, 8));
      } else {
        ctx.check('valid key: `agent models` exits 0 and lists auto first', true, 'skipped: no key file', true);
      }
      // offline: no network namespace at all (linux/unshare only)
      if (process.platform === 'linux') {
        const os = ctx.slot('offline');
        const p = ctx.acp({ slot: os, cwd: work, label: 'acp-offline', wrap: ['/usr/bin/unshare', '-n'], envOpts: { store: 'memory' } });
        const i = await ctx.initialize(p);
        const n = await ctx.newSession(p, work);
        ctx.check('offline: initialize still works', i.result?.protocolVersion === 1);
        ctx.check('offline: session/new -> the same -32603 "Failed to initialize session services" as an invalid key', n.error?.code === -32603 && n.error?.data?.message === 'Failed to initialize session services', errOf(n));
        ctx.fixture(p, 'offline');
        await p.dispose();
        const om = spawnSync('/usr/bin/unshare', ['-n', AGENT, 'models'], { env: ctx.env(os, { store: 'memory' }), encoding: 'utf8', timeout: 60000, cwd: work });
        ctx.check('offline: `agent models` exits 1 with "Failed to reach the Cursor API"', om.status === 1 && /Failed to reach the Cursor API/.test(om.stderr), ctx.red.text(om.stderr.trim()));
      } else {
        ctx.check('offline: initialize still works', true, 'skipped: unshare -n is linux-only', true);
        ctx.check('offline: session/new -> the same -32603 "Failed to initialize session services" as an invalid key', true, 'skipped: unshare -n is linux-only', true);
        ctx.check('offline: `agent models` exits 1 with "Failed to reach the Cursor API"', true, 'skipped: unshare -n is linux-only', true);
      }
      // unknown --model at start: with a valid key the process exits during session/new (needs the key
      // to reach model validation; without credentials session/new fails on auth first).
      if (ctx.key) {
        const ms = ctx.slot('model-flag');
        const q = ctx.acp({ slot: ms, cwd: work, label: 'acp-model-flag-unknown', args: ['--model', 'no-such-model'], envOpts: { store: 'memory' } });
        await ctx.initialize(q);
        const qn = await ctx.newSession(q, work);
        await q.waitExit(10000);
        ctx.check('acp --model <unknown>: no session/new reply, process exits 1, stderr lists valid models', qn.transportClosed === true && q.exit?.code === 1 && /Cannot use this model|Available|gpt-/.test(q.stderr), { exit: q.exit, stderrTail: q.stderr.slice(-200) });
        const q2 = ctx.acp({ slot: ms, cwd: work, label: 'acp-model-flag-slug', args: ['--model', 'gpt-5.5'], envOpts: { store: 'memory' } });
        await ctx.initialize(q2);
        const q2n = await ctx.newSession(q2, work);
        ctx.check('acp --model <legacy slug> resolves to the bracket variant', /^gpt-5\.5\[/.test(currentModel(q2n.result ?? {}) ?? ''), currentModel(q2n.result ?? {}));
        await q2.dispose();
      } else {
        ctx.check('acp --model <unknown>: no session/new reply, process exits 1, stderr lists valid models', true, 'skipped: needs the owner key', true);
        ctx.check('acp --model <legacy slug> resolves to the bracket variant', true, 'skipped: needs the owner key', true);
      }
      // invalid project .cursor/cli.json kills the process at start
      const bad = ctx.repo('bad-cli-json', { '.cursor/cli.json': JSON.stringify({ permissions: { allow: ['Shell(*)'] }, unknownKey: 1 }) });
      const r = ctx.acp({ slot: ctx.slot('bad-cli'), cwd: bad, label: 'acp-invalid-cli-json', envOpts: { store: 'memory' } });
      const ri = await ctx.initialize(r);
      await r.waitExit(10000);
      ctx.check('an invalid project .cursor/cli.json makes `agent acp` exit 1 before answering initialize', ri.transportClosed === true && r.exit?.code === 1 && /schema validation failed/.test(r.stderr), { exit: r.exit });
      // The same repository with project configs off: the file is never read.
      const r2 = ctx.acp({ slot: ctx.slot('bad-cli-disabled'), cwd: bad, label: 'acp-invalid-cli-json-disabled', args: ['--disable-project-configs'], envOpts: { store: 'memory' } });
      const r2i = await ctx.initialize(r2);
      ctx.check('with --disable-project-configs the same invalid .cursor/cli.json no longer stops `agent acp` (initialize answers)', r2i.result?.protocolVersion === 1, { exit: r2.exit, stderr: r2.stderr.slice(-200) });
      if (ctx.key) {
        const r2n = r2i.result ? await ctx.newSession(r2, bad) : null;
        ctx.check('…and session/new succeeds with the key', !!r2n?.result?.sessionId, { newError: r2n?.error });
      } else {
        ctx.check('…and session/new succeeds with the key', true, 'skipped: needs the owner key', true);
      }
      await r2.dispose();
      // hidden local mode is not available in this build
      const al = ctx.cli(ctx.slot('authless'), ['acp', '--authless'], { envOpts: { apiKey: false, store: 'memory' } });
      ctx.check('`agent acp --authless` refuses: only for agent-cli-local (exit 2)', al.exit === 2 && /only be used with agent-cli-local/.test(al.stderr + al.stdout), (al.stderr + al.stdout).trim());
      const al2 = ctx.acp({ slot: ctx.slot('authless-env'), cwd: work, label: 'acp-authless-env', envOpts: { apiKey: false, store: 'memory', extra: { CURSOR_ENABLE_AUTHLESS: '1', CURSOR_AGENT_CLI_AUTHLESS_MODE: 'true', CURSOR_LOCAL_AGENT_BASE_URL: 'http://127.0.0.1:9/v1' } } });
      await ctx.initialize(al2);
      const al2n = await ctx.newSession(al2, work);
      ctx.check('authless environment variables do not lift the auth requirement in ACP', al2n.error?.code === -32000, errOf(al2n));
      await al2.dispose();
    },
  },
  {
    name: 'team-pin', real: 0,
    async run(ctx) {
      const work = ctx.repo('work');
      const slot = ctx.slot('a');
      const p = ctx.acp({ slot, cwd: work, label: 'acp', envOpts: { store: 'memory' } });
      await ctx.initialize(p);
      const a = await ctx.newSession(p, work);
      ctx.check('first session opens', !!a.result?.sessionId);
      // Another process (e.g. `agent team switch`) changing the active team in the same config dir.
      const cfgFile = join(slot.config, 'cli-config.json');
      const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
      cfg.authInfo = { ...(cfg.authInfo ?? {}), activeTeamId: 424242, teamId: 424242, teamName: 'P0 Probe Team' };
      writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
      const b = await ctx.newSession(p, work);
      await p.waitExit(10000);
      ctx.check('after the config dir\'s active team changes, session/new -> -32603 "Your team has switched…"', b.error?.code === -32603 && /team has switched/i.test(JSON.stringify(b.error)), errOf(b));
      ctx.check('…and the ACP process then exits with code 0', p.exit?.code === 0, p.exit);
      ctx.fixture(p, 'acp');
    },
  },
];
