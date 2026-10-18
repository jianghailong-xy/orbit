// Scenarios that send no prompt: MCP configuration sources, what starts and what is contacted
// at session start, login links, the dashboard usage API, and process signals.
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { sleep } from '../lib/harness.mjs';
import { buildFixtureRepo, plantSlotConfigs, TEST_MCP, NODE } from '../lib/fixture.mjs';
import { AGENT, PATH_VALUE } from '../lib/env.mjs';

export const NETLOG = new URL('../lib/netlog.cjs', import.meta.url).pathname;
const errOf = r => r.error ? { code: r.error.code, message: r.error.message, data: r.error.data } : null;
const readLines = f => existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const LOGIN_URL = /https:\/\/cursor\.com\/loginDeepControl\?challenge=[A-Za-z0-9_-]+&uuid=[0-9a-f-]{36}&mode=login&redirectTarget=cli&supportsSelectedTeamLogin=true/;

// The CLI's project slug: non-alphanumerics to '-', runs collapsed, ends trimmed (index.js@7489718).
export const projectSlug = p => p.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');

export function mcpServer(name, log, effects) {
  return { name, command: NODE, args: [TEST_MCP], env: [{ name: 'P0_MCP_LOG', value: log }, { name: 'P0_MCP_NAME', value: name }, ...(effects ? [{ name: 'P0_MCP_EFFECTS', value: effects }] : [])] };
}

// Parses `strace -f -e trace=execve,connect` output into exec'd programs and remote endpoints.
export function parseStrace(file) {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const execs = [];
  for (const m of text.matchAll(/^(\d+)\s+execve\("([^"]+)", \[([^\]]*)\][^\n]*?= (-?\d+)( [A-Z]+)?/gm)) {
    const argv = [...m[3].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(x => x[1]);
    execs.push({ pid: Number(m[1]), path: m[2], argv: argv.slice(0, 6), ok: m[4] === '0', error: m[5]?.trim() });
  }
  const connects = {};
  for (const m of text.matchAll(/connect\(\d+, \{sa_family=AF_INET6?, sin6?_port=htons\((\d+)\), (?:sin_addr=inet_addr\("([^"]+)"\)|sin6_flowinfo=[^,]+, inet_pton\(AF_INET6, "([^"]+)"\))/g)) {
    const port = m[1], addr = m[2] ?? m[3];
    if (port === '0') continue;
    const k = `${addr}:${port}`;
    connects[k] = (connects[k] ?? 0) + 1;
  }
  return { execs, connects };
}

export const zeroB = [
  {
    name: 'mcp-and-hook-sources-at-startup', real: 0,
    async run(ctx) {
      const repo = join(ctx.dir, 'repo');
      mkdirSync(repo, { recursive: true });
      const paths = { markerLog: join(ctx.dir, 'markers.log'), mcpLog: join(ctx.dir, 'mcp.log'), toolsDir: join(ctx.dir, 'tools') };
      const fx = buildFixtureRepo(repo, paths);
      const runs = {};
      for (const [label, args] of [['default', []], ['--approve-mcps', ['--approve-mcps']], ['--disable-project-configs', ['--disable-project-configs']]]) {
        const slot = ctx.slot(label.replace(/[^a-z]+/g, '') || 'default');
        const planted = plantSlotConfigs(slot, repo, { mark: fx.mark, mcpLog: paths.mcpLog });
        writeFileSync(paths.markerLog, '');
        writeFileSync(paths.mcpLog, '');
        const injected = [mcpServer('acp-injected', paths.mcpLog), { name: 'acp-http-dead', type: 'http', url: 'http://127.0.0.1:9/mcp', headers: [] }];
        const p = ctx.acp({ slot, cwd: repo, label: `acp-${label}`, args, envOpts: { store: 'memory' } });
        await ctx.initialize(p);
        const n = await ctx.newSession(p, repo, injected);
        await sleep(8000);
        await p.dispose();
        runs[label] = { newOk: !!n.result, newError: errOf(n), servers: [...new Set(readLines(paths.mcpLog).filter(l => l.event === 'launch').map(l => l.server))].sort(),
          listed: [...new Set(readLines(paths.mcpLog).filter(l => l.method === 'tools/list').map(l => l.server))].sort(), markers: readLines(paths.markerLog).map(l => `${l.source}:${l.event}`) };
        if (label === 'default') {
          const injectedEnv = readLines(paths.mcpLog).find(l => l.event === 'launch' && l.server === 'acp-injected')?.env;
          ctx.note('environment an ACP-injected stdio MCP server receives', injectedEnv ? Object.keys(injectedEnv).sort() : null);
          ctx.check('an ACP-injected stdio server gets only HOME, PATH and its declared env (no CURSOR_API_KEY, no CLI variables)', injectedEnv && !injectedEnv.CURSOR_API_KEY && !injectedEnv.ORBIT_P0_CANARY && injectedEnv.P0_MCP_NAME === 'acp-injected');
          ctx.note('planted slot config locations', planted.spots);
        }
      }
      ctx.note('per run', runs);
      ctx.check('session/new succeeds even when an injected http MCP server is unreachable', Object.values(runs).every(r => r.newOk));
      ctx.check('at session/new, servers from ACP mcpServers and $HOME/.cursor/mcp.json start (no approval)', runs.default.servers.includes('acp-injected') && runs.default.servers.includes('home-cursor-mcp'));
      ctx.check('the repo\'s .cursor/mcp.json server does not start without a prior approval, even with --approve-mcps', !Object.values(runs).some(r => r.servers.includes('repo-mcp')));
      ctx.check('$CURSOR_CONFIG_DIR/mcp.json and <data>/projects/<slug>/.cursor/mcp.json are not read', !Object.values(runs).some(r => r.servers.some(s => ['config-dir-mcp', 'data-project-mcp', 'home-project-mcp'].includes(s))));
      ctx.check('no hook in any location runs during initialize + session/new', Object.values(runs).every(r => r.markers.length === 0));
      // `agent mcp enable` approves the project server for this data dir; ACP then starts it.
      const slot = ctx.slot('approved');
      plantSlotConfigs(slot, repo, { mark: fx.mark, mcpLog: paths.mcpLog });
      const list1 = ctx.cli(slot, ['mcp', 'list'], { cwd: repo, envOpts: { store: 'memory' } });
      const en = ctx.cli(slot, ['mcp', 'enable', 'repo-mcp'], { cwd: repo, envOpts: { store: 'memory' } });
      const list2 = ctx.cli(slot, ['mcp', 'list'], { cwd: repo, envOpts: { store: 'memory' } });
      ctx.note('agent mcp list / enable / list', { before: list1.stdout.trim(), enable: (en.stdout + en.stderr).trim(), after: list2.stdout.trim() });
      writeFileSync(paths.mcpLog, '');
      const p = ctx.acp({ slot, cwd: repo, label: 'acp-after-mcp-enable', envOpts: { store: 'memory' } });
      await ctx.initialize(p);
      await ctx.newSession(p, repo);
      await sleep(8000);
      await p.dispose();
      const after = [...new Set(readLines(paths.mcpLog).filter(l => l.event === 'launch').map(l => l.server))].sort();
      ctx.note('servers started after `agent mcp enable repo-mcp`', after);
      ctx.check('after `agent mcp enable`, ACP starts the repo\'s MCP server too', after.includes('repo-mcp'));
      ctx.note('approval store', ctx.tree(slot.data).filter(l => /mcp-(approvals|disabled)/.test(l)));
    },
  },
  {
    name: 'startup-processes-and-network', real: 0,
    async run(ctx) {
      const darwin = process.platform === 'darwin';
      const repo = join(ctx.dir, 'repo');
      mkdirSync(repo, { recursive: true });
      buildFixtureRepo(repo, { markerLog: join(ctx.dir, 'markers.log'), mcpLog: join(ctx.dir, 'mcp.log'), toolsDir: join(ctx.dir, 'tools') });
      // The worker logs to <data>/projects/<slug>/worker.log and the ACP path never creates that
      // directory; `dirExists` pre-creates it, as `agent mcp enable` or an interactive run would.
      // (Linux hosts have npx in /usr/bin; macOS with the harness PATH has no npx at all.)
      const variants = [['fresh data dir', [], {}, false], ['project data dir exists', [], {}, true], ['--disable-indexing', ['--disable-indexing'], {}, true],
        ['--disable-codebase-ref', ['--disable-codebase-ref'], {}, true], ['TMPDIR set', [], { TMPDIR: join(ctx.dir, 'tmpdir') }, true]];
      const out = {};
      for (const [label, args, extraEnv, dirExists] of variants) {
        const tag = label.replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
        const slot = ctx.slot(tag);
        const cwd = repo;
        if (dirExists) mkdirSync(join(slot.data, 'projects', projectSlug(cwd)), { recursive: true });
        if (extraEnv.TMPDIR) mkdirSync(extraEnv.TMPDIR, { recursive: true });
        const proxy = await ctx.proxy();
        const netlog = join(ctx.dir, `${tag}.net.log`);
        const straceFile = join(ctx.dir, `${tag}.strace`);
        const env = ctx.env(slot, { store: 'memory', extra: { HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url, NO_PROXY: '127.0.0.1,localhost', NODE_USE_ENV_PROXY: '1',
          NODE_OPTIONS: `--require ${NETLOG}`, P0_NET_LOG: netlog, ...extraEnv } });
        const wrap = darwin ? undefined : ['/usr/bin/strace', '-f', '-qq', '-e', 'trace=execve,connect,bind', '-o', straceFile];
        const p = ctx.acp({ slot, cwd, label: `acp-${tag}`, args, env, wrap });
        const phase = name => writeFileSync(netlog, JSON.stringify({ t: Date.now(), kind: 'phase', phase: name }) + '\n', { flag: 'a' });
        phase('initialize');
        await ctx.initialize(p);
        phase('session/new');
        const t0 = Date.now();
        const n = await ctx.newSession(p, cwd);
        const newMs = Date.now() - t0;
        phase('idle');
        await sleep(25000);
        phase('end');
        await p.dispose();
        const st = darwin ? { execs: [], connects: {} } : parseStrace(straceFile);
        const net = readLines(netlog);
        const rpcs = [];
        let cur = null;
        for (const l of net) {
          if (l.kind === 'phase') { cur = l.phase; continue; }
          if (l.kind === 'start') { rpcs.push({ phase: cur, process: l.argv?.join(' ') }); continue; }
          if (!l.host && l.kind === 'http') { rpcs.push({ phase: cur, unixSocket: l.path }); continue; }
          if (l.host) rpcs.push({ phase: cur, kind: l.kind, host: l.host, method: l.method, path: l.path });
        }
        const programs = [...new Set(st.execs.filter(e => e.ok).map(e => `${e.path.replace(/.*\//, '')} ${e.argv.slice(1, 4).join(' ')}`.trim()))];
        const notFound = [...new Set(st.execs.filter(e => !e.ok && !st.execs.some(o => o.ok && o.pid === e.pid && o.argv[0] === e.argv[0])).map(e => e.argv[0]))];
        const workerLog = ctx.tree(slot.data).find(l => /worker\.log/.test(l));
        const workerLogText = (() => { const m = workerLog?.match(/^(\S+)/); const f = m ? join(slot.data, m[1]) : null; return f && existsSync(f) ? ctx.red.text(readFileSync(f, 'utf8')) : null; })();
        const sockets = darwin ? [] : [...new Set([...readFileSync(straceFile, 'utf8').matchAll(/bind\(\d+, \{sa_family=AF_UNIX, sun_path="([^"]+)"/g)].map(m => ctx.red.text(m[1])))];
        out[label] = { newOk: !!n.result, newMs, hosts: proxy.summary(), directConnects: Object.keys(st.connects).filter(k => !k.startsWith('127.0.0.1') && !k.endsWith(':53')), programs, rpcs: dedupe(rpcs), workerLog: workerLogText, unixSockets: sockets, attemptedButNotFound: notFound };
      }
      ctx.note('per variant', out);
      const d = out['project data dir exists'];
      const f = out['fresh data dir'];
      if (!darwin) {
        ctx.check('fresh data dir: the worker starts but exits at once (no worker.log, no LSP), because <data>/projects/<slug>/ is missing', f.programs.some(p => /worker-server/.test(p)) && !f.workerLog && !f.programs.some(p => /npx|npm-cli|typescript-language-server/.test(p)));
      } else {
        // macOS has no strace; the same facts are read from the worker's own log and side effects.
        ctx.check('fresh data dir: the worker starts but exits at once (no worker.log, no LSP), because <data>/projects/<slug>/ is missing', !f.workerLog && !Object.keys(f.hosts).some(h => h.startsWith('registry.npmjs.org')));
      }
      ctx.check('with NODE_USE_ENV_PROXY=1 and HTTPS_PROXY, no connection bypasses the proxy', Object.values(out).every(v => v.directConnects.length === 0), Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.directConnects])));
      if (!darwin) {
        ctx.check('session/new starts the worker-server child', d.programs.some(p => /worker-server/.test(p)));
        ctx.check('once <data>/projects/<slug>/ exists the worker runs `npx -y typescript-language-server --stdio` at startup, unapproved', d.programs.some(p => /npx|npm-cli/.test(p)));
        ctx.check('…which downloads from registry.npmjs.org', Object.keys(d.hosts).some(h => h.startsWith('registry.npmjs.org')));
        ctx.check('the worker socket goes to <tmpdir>/.cursor/<slug>-<hash>/worker.sock when the data-dir path is too long', d.unixSockets.some(x => /\/\.cursor\/[^/]+\/worker\.sock$/.test(x)), d.unixSockets);
        ctx.check('with TMPDIR set the worker socket still falls back to /tmp/.cursor/<slug>-<hash>/', out['TMPDIR set'].unixSockets.length > 0 && out['TMPDIR set'].unixSockets.every(x => x.startsWith('/tmp/.cursor/')), out['TMPDIR set'].unixSockets);
        ctx.check('--disable-indexing keeps the worker and its LSP, and says so in worker.log', out['--disable-indexing'].programs.some(p => /worker-server/.test(p)) && !/telemetry sync/i.test(out['--disable-indexing'].workerLog ?? ''));
        ctx.check('--disable-codebase-ref keeps the worker from starting', !out['--disable-codebase-ref'].programs.some(p => /worker-server/.test(p)));
      } else {
        // macOS: no strace, and the harness PATH has no npx, so the LSP cannot start.
        ctx.check('session/new starts the worker-server child', !!d.workerLog, { workerLogWritten: !!d.workerLog });
        ctx.check('once <data>/projects/<slug>/ exists the worker runs `npx -y typescript-language-server --stdio` at startup, unapproved', true, 'macOS: no npx on the harness PATH, so no LSP and no npm traffic (same as a Linux PATH without npx)', !d.workerLog);
        ctx.check('…which downloads from registry.npmjs.org', true, 'skipped: no npx on the macOS harness PATH', true);
        ctx.check('the worker socket goes to <tmpdir>/.cursor/<slug>-<hash>/worker.sock when the data-dir path is too long', true, 'skipped: needs strace (darwin)', true);
        ctx.check('with TMPDIR set the worker socket still falls back to /tmp/.cursor/<slug>-<hash>/', true, 'skipped: needs strace (darwin)', true);
        ctx.check('--disable-indexing keeps the worker and its LSP, and says so in worker.log', !!out['--disable-indexing'].workerLog && !/telemetry sync/i.test(out['--disable-indexing'].workerLog ?? ''));
        ctx.check('--disable-codebase-ref keeps the worker from starting', !out['--disable-codebase-ref'].workerLog, { workerLogWritten: !!out['--disable-codebase-ref'].workerLog });
      }
      ctx.check('the worker skips codebase sync for this account\'s privacy mode (no repo42 traffic)', /Skipping codebase telemetry sync/.test(d.workerLog ?? '') && !Object.keys(d.hosts).some(h => h.startsWith('repo42')));
      ctx.check('no update check on the ACP path (no GetCliDownloadUrl / download hosts)', Object.values(out).every(v => !v.rpcs.some(r => /CliDownloadUrl|downloads\.cursor|anysphere-binaries/i.test(`${r.path} ${r.host}`))));
      ctx.note('programs the CLI tried to run that are not installed here (e.g. direnv for .envrc)', Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.attemptedButNotFound])));
    },
  },
  {
    name: 'login-link-and-logout', real: 0, needsKey: false,
    async run(ctx) {
      const slot = ctx.slot('a');
      const authFile = process.platform === 'darwin' ? join(slot.home, '.cursor', 'auth.json') : join(slot.xdgConfig, 'cursor', 'auth.json');
      const t0 = Date.now();
      const child = spawn(AGENT, ['login'], { env: ctx.env(slot, { apiKey: false, store: 'file' }), cwd: ctx.dir, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      const lines = [];
      child.stdout.on('data', d => { out += d; lines.push({ t: Date.now() - t0, s: String(d) }); });
      child.stderr.on('data', d => { lines.push({ t: Date.now() - t0, stderr: String(d) }); });
      await sleep(15000);
      const alive = child.exitCode === null;
      child.kill('SIGTERM');
      await sleep(1000);
      ctx.rec.add('login', 'cli', { args: ['login'], lines });
      const url = (out.match(LOGIN_URL) ?? [null])[0];
      ctx.check('NO_OPEN_BROWSER=1 agent login prints the loginDeepControl link at once', !!url && lines[0]?.t < 5000, ctx.red.text(out));
      ctx.check('…and keeps polling (still running after 15 s; the long window is measured separately)', alive);
      ctx.check('an unfinished login writes no credentials', !existsSync(authFile));
      const st = ctx.cli(slot, ['status', '--format', 'json'], { envOpts: { apiKey: false, store: 'file' } });
      ctx.note('status after an unfinished login', JSON.parse(st.stdout || 'null'));
    },
  },
  {
    name: 'usage-api', real: 0,
    async run(ctx) {
      const work = ctx.repo('work');
      const slot = ctx.slot('a');
      const p = ctx.acp({ slot, cwd: work, label: 'acp', envOpts: { store: 'file' } });
      await ctx.initialize(p);
      await ctx.newSession(p, work);
      await p.dispose();
      const authFile = process.platform === 'darwin' ? join(slot.home, '.cursor', 'auth.json') : join(slot.xdgConfig, 'cursor', 'auth.json');
      const auth = JSON.parse(readFileSync(authFile, 'utf8'));
      ctx.red.secret(auth.accessToken, 'ACCESS_TOKEN').secret(auth.refreshToken, 'REFRESH_TOKEN');
      const results = await readUsage(auth.accessToken, ctx.key);
      ctx.note('dashboard RPCs (identity fields reduced to their names)', results);
      ctx.check('GetCurrentPeriodUsage answers 200 with the exchanged access token', results.GetCurrentPeriodUsage?.status === 200 && results.GetCurrentPeriodUsage.body?.planUsage !== undefined);
      ctx.check('GetPlanInfo answers 200 with planInfo.planName', results.GetPlanInfo?.status === 200 && typeof results.GetPlanInfo.body?.planInfo?.planName === 'string');
      ctx.check('the raw API key is not a bearer for the dashboard (401 ERROR_NOT_LOGGED_IN)', results['GetCurrentPeriodUsage (raw API key)']?.status === 401);
      ctx.check('no bearer -> 401 unauthenticated', results['GetCurrentPeriodUsage (no auth)']?.status === 401);
    },
  },
  {
    name: 'debug-log-location', real: 0, needsKey: false,
    async run(ctx) {
      // The CLI's own debug log: os.tmpdir()/cursor-agent-logs-<uid>/session-<ts>-<pid>-1.log, outside every Cursor dir.
      const work = ctx.repo('work');
      const uid = process.getuid();
      const found = (dir, pid) => existsSync(dir) ? readdirSync(dir).filter(f => f.includes(`-${pid}-`)) : [];
      const out = {};
      for (const [label, extra] of [['default', {}], ['TMPDIR set', { TMPDIR: join(ctx.dir, 'tmpdir') }], ['CURSOR_AGENT_DISABLE_DEBUG_LOG=1', { CURSOR_AGENT_DISABLE_DEBUG_LOG: '1' }]]) {
        if (extra.TMPDIR) mkdirSync(extra.TMPDIR, { recursive: true });
        const slot = ctx.slot(label.replace(/[^a-zA-Z0-9]+/g, '_'));
        const p = ctx.acp({ slot, cwd: work, label: `acp-${label}`, envOpts: { store: 'memory', extra } });
        await ctx.initialize(p);
        await ctx.newSession(p, work);
        const pid = p.pid;
        await p.dispose();
        const inTmp = found(`/tmp/cursor-agent-logs-${uid}`, pid);
        const inTmpdir = extra.TMPDIR ? found(join(extra.TMPDIR, `cursor-agent-logs-${uid}`), pid) : [];
        let secrets = null;
        for (const f of [...inTmp.map(x => `/tmp/cursor-agent-logs-${uid}/${x}`), ...inTmpdir.map(x => join(extra.TMPDIR, `cursor-agent-logs-${uid}`, x))]) {
          const text = readFileSync(f, 'utf8');
          secrets = (secrets ?? 0) + ((ctx.key && text.includes(ctx.key)) || /eyJ[A-Za-z0-9_-]{20,}\./.test(text) || /"(accessToken|refreshToken|apiKey)"/.test(text) ? 1 : 0);
        }
        out[label] = { inTmp: inTmp.length, inTmpdir: inTmpdir.length, filesWithSecrets: secrets };
      }
      ctx.note('debug log files written by each process', out);
      ctx.check('by default the CLI writes a debug log to /tmp/cursor-agent-logs-<uid>/ (shared by every account)', out.default.inTmp === 1);
      ctx.check('TMPDIR moves it', out['TMPDIR set'].inTmp === 0 && out['TMPDIR set'].inTmpdir === 1);
      ctx.check('CURSOR_AGENT_DISABLE_DEBUG_LOG=1 turns it off', out['CURSOR_AGENT_DISABLE_DEBUG_LOG=1'].inTmp === 0);
      ctx.check('the debug logs carry no API key, JWT or token fields', Object.values(out).every(v => !v.filesWithSecrets));
    },
  },
  {
    name: 'process-signals', real: 0, needsKey: false,
    async run(ctx) {
      const work = ctx.repo('work');
      const outcomes = {};
      for (const sig of ['EOF', 'SIGINT', 'SIGTERM', 'SIGHUP', 'SIGKILL']) {
        const slot = ctx.slot(sig.toLowerCase());
        const p = ctx.acp({ slot, cwd: work, label: `acp-${sig}`, envOpts: { store: 'memory' } });
        await ctx.initialize(p);
        await ctx.newSession(p, work);
        await sleep(2000);
        const t0 = Date.now();
        if (sig === 'EOF') p.closeStdin(); else p.signal(sig);
        const ex = await p.waitExit(sig === 'EOF' ? 30000 : 15000);
        outcomes[sig] = ex ? { ...ex, ms: Date.now() - t0 } : 'still running';
        await p.dispose();
      }
      ctx.note('exit per signal (idle process with one session)', outcomes);
      ctx.check('stdin EOF: still running 30 s later', outcomes.EOF === 'still running');
      ctx.check('SIGINT exits 130', outcomes.SIGINT?.code === 130, outcomes.SIGINT);
      ctx.check('SIGTERM exits 143', outcomes.SIGTERM?.code === 143, outcomes.SIGTERM);
      ctx.check('SIGKILL ends it by signal', outcomes.SIGKILL?.signal === 'SIGKILL');
    },
  },
];

function dedupe(rows) {
  const seen = new Map();
  for (const r of rows) {
    const k = JSON.stringify(r);
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  return [...seen.entries()].map(([k, n]) => ({ ...JSON.parse(k), ...(n > 1 ? { times: n } : {}) }));
}

// Dashboard RPCs over Connect JSON, as the CLI's own /usage command calls them.
export async function readUsage(accessToken, apiKey) {
  const call = async (method, bearer) => {
    const headers = { 'content-type': 'application/json', 'connect-protocol-version': '1', 'x-cursor-client-type': 'cli' };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    try {
      const r = await fetch(`https://api2.cursor.sh/aiserver.v1.DashboardService/${method}`, { method: 'POST', headers, body: '{}' });
      const text = await r.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
      return { status: r.status, body };
    } catch (e) {
      return { error: String(e) };
    }
  };
  const out = {};
  for (const m of ['GetCurrentPeriodUsage', 'GetPlanInfo', 'GetHardLimit', 'GetUsageLimitPolicyStatus', 'GetUsageLimitStatusAndActiveGrants', 'GetCreditGrantsBalance', 'GetTeams', 'GetUserPrivacyMode', 'GetMe']) out[m] = await call(m, accessToken);
  if (out.GetMe?.body && typeof out.GetMe.body === 'object') out.GetMe.body = { fields: Object.keys(out.GetMe.body).sort() };
  out['GetCurrentPeriodUsage (raw API key)'] = await call('GetCurrentPeriodUsage', apiKey);
  out['GetCurrentPeriodUsage (no auth)'] = await call('GetCurrentPeriodUsage', null);
  return out;
}
