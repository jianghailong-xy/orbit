// Scenarios that spend real prompts (Auto model only; every prompt is charged to the ledger first).
// Prompts are written so each step is observable on its own: a file the step creates, a marker an
// MCP call records, a permission request it raises. Checks state what the CLI did, given what the
// model attempted; a step the model never attempted fails its check rather than passing silently.
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, readdirSync, statSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sleep, textOf, toolCalls, AUTO_MODEL } from '../lib/harness.mjs';
import { buildFixtureRepo, plantSlotConfigs, CODEWORDS } from '../lib/fixture.mjs';
import { mcpServer, parseStrace, readUsage } from './zero-b.mjs';
import { cursorEnv, P0_ROOT } from '../lib/env.mjs';

const readLines = f => existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const readJson = f => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const README = '# probe repo\nThe secret word in this README is TANGERINE.\n';

// pids whose command line contains `needle` (to see whether a tool's process outlived a cancel or crash)
function pidsMatching(needle) {
  const out = [];
  if (process.platform === 'linux') {
    for (const d of readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try { const c = readFileSync(`/proc/${d}/cmdline`, 'utf8').replace(/\0/g, ' '); if (c.includes(needle) && !c.includes('pidsMatching')) out.push(Number(d)); } catch {}
    }
  } else {
    // darwin: no /proc; `ps -axo pid=,command=` covers the harness user's processes.
    const r = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
    for (const line of (r.stdout ?? '').split('\n')) {
      const i = line.indexOf(' ');
      if (i <= 0) continue;
      const pid = Number(line.slice(0, i).trim());
      const cmd = line.slice(i + 1);
      if (Number.isInteger(pid) && cmd.includes(needle) && !cmd.includes('pidsMatching')) out.push(pid);
    }
  }
  return out;
}
const killAll = pids => { for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} } };

// A strace wrap on Linux (macOS has no strace); returns undefined there.
const straceWrap = file => process.platform === 'linux' ? ['/usr/bin/strace', '-f', '-qq', '-e', 'trace=execve', '-o', file] : undefined;

// `env | sort` output: names, plus the few values that matter here (paths are redacted later).
function envDump(file) {
  if (!existsSync(file)) return null;
  const vars = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) { const i = line.indexOf('='); if (i > 0) vars[line.slice(0, i)] = line.slice(i + 1); }
  const pick = ['HOME', 'XDG_CONFIG_HOME', 'CURSOR_CONFIG_DIR', 'CURSOR_DATA_DIR', 'AGENT_CLI_CREDENTIAL_STORE', 'CURSOR_AGENT', 'ORBIT_P0_CANARY', 'SHELL', 'PAGER', 'TERM', 'NO_COLOR'];
  return { names: Object.keys(vars).sort(), values: Object.fromEntries(pick.filter(k => k in vars).map(k => [k, vars[k]])),
    hasApiKey: 'CURSOR_API_KEY' in vars, hasAuthToken: 'CURSOR_AUTH_TOKEN' in vars };
}

function orbitMcp() {
  const e = process.env;
  if (!e.ORBIT_SESSION_ID) return null;
  const orbitBin = process.platform === 'darwin' ? '/Users/long/.orbit/bin/orbit' : '/usr/local/bin/orbit';
  const pairs = [['ORBIT_SESSION_ID', e.ORBIT_SESSION_ID], ['ORBIT_AGENT_ID', e.ORBIT_AGENT_ID], ['ORBIT_TASK_ID', e.ORBIT_TASK_ID], ['ORBIT_HOME', e.ORBIT_HOME ?? '/root/.orbit'],
    ['ORBIT_MCP_PERMISSION_PROMPT', '0'], ['ORBIT_ALLOW_ORCHESTRATION', '0'], ['ORBIT_WATCHES', 'off'], ['ORBIT_WIKI', 'off'], ['ORBIT_RUNNER_CHILD', '1']];
  return { name: 'orbit', command: orbitBin, args: ['mcp'], env: pairs.filter(([, v]) => v).map(([name, value]) => ({ name, value })) };
}

// Records every permission request with the answer given; `choose(msg)` returns an optionId.
function recordingPolicy(asked, choose, extra = {}) {
  return msg => {
    if (msg.method === 'session/request_permission') {
      const tc = msg.params.toolCall ?? {};
      const choice = choose(msg);
      asked.push({ sessionId: msg.params.sessionId, title: tc.title, kind: tc.kind, toolCallId: tc.toolCallId, options: (msg.params.options ?? []).map(o => o.optionId), content: tc.content, answer: choice });
      if (choice === null) return undefined;
      return { result: { outcome: choice === 'cancelled' ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: choice } } };
    }
    if (extra[msg.method]) return extra[msg.method](msg);
    return { error: { code: -32601, message: 'not supported by the P0 client' } };
  };
}

const stepsPrompt = (prefix, marker) => `This is an automated protocol probe. Use your tools for these steps, in order, one tool call per step, and keep going even if a step fails or is rejected: ` +
  `1) Create the file ${prefix}-write.txt containing the single word written. 2) Run the shell command \`touch ${prefix}-shell.txt\`. ` +
  `3) Call the MCP tool \`record\` of the p0probe server with marker "${marker}". 4) Fetch https://example.com/ and note its page title. ` +
  `Finally answer in one line, per step: ok, rejected, or not allowed.`;

export const real = [
  {
    name: 'multi-turn-tools-default', real: 2,
    async run(ctx) {
      const slot = ctx.slot('a');
      const work = ctx.repo('work', { 'README.md': README });
      const mcpLog = join(ctx.dir, 'mcp.log'), effects = join(ctx.dir, 'mcp-effects.log');
      const proxy = await ctx.proxy();
      const env = ctx.env(slot, { store: 'memory', extra: { HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url, NO_PROXY: '127.0.0.1,localhost', NODE_USE_ENV_PROXY: '1' } });
      const orbit = orbitMcp();
      for (const k of ['ORBIT_SESSION_ID', 'ORBIT_AGENT_ID', 'ORBIT_TASK_ID']) if (process.env[k]) ctx.red.secret(process.env[k], k);
      const servers = [mcpServer('p0probe', mcpLog, effects), ...(orbit ? [orbit] : [])];
      const asked = [];
      let phase = 1;
      const policy = recordingPolicy(asked, msg => {
        const t = msg.params.toolCall?.title ?? '';
        if (/echo shell-ok/.test(t)) return 'allow-always';
        if (phase === 1 && msg.params.toolCall?.kind === 'other' && /record/i.test(t)) return 'reject-once';
        return 'allow-once';
      });
      const straceFile = join(ctx.dir, 'turns.strace');
      const p = ctx.acp({ slot, cwd: work, env, label: 'turns', onRequest: policy, wrap: straceWrap(straceFile) });
      await ctx.initialize(p);
      const n = await ctx.newSession(p, work, servers);
      if (!ctx.check('session opens with the p0probe and orbit MCP servers injected', !!n.result?.sessionId, n.error)) return;
      const sid = n.result.sessionId;
      const t1 = await ctx.promptAndWait(p, sid,
        'This is an automated protocol probe. Use your tools for these steps, in order, one tool call per step, and keep going even if a step fails or is rejected: ' +
        '1) Read the file README.md. 2) Run the shell command `ls -la`. 3) Create the file probe-write.txt containing the single word written. ' +
        '4) Run the shell command `echo shell-ok > probe-shell.txt`. 5) Run the shell command `env | sort > env-dump.txt`. ' +
        '6) Call the MCP tool `record` of the p0probe server with marker "turn1". 7) Fetch https://example.com/ and note its page title. ' +
        'Finally answer in one line: the secret word from README.md and, per step, ok or rejected.', 'turn 1: read/ls/write/echo(allow-always)/env/mcp(reject)/fetch');
      const tools1 = toolCalls(t1.updates);
      ctx.note('turn 1', { stopReason: t1.response.result?.stopReason, ms: t1.ms, updateKinds: countKinds(t1.updates), tools: tools1, permissionRequests: asked.filter(a => true), answer: textOf(t1.updates, 'agent_message_chunk').slice(-600) });
      ctx.check('turn 1 ends with stopReason end_turn and carries nothing else', t1.response.result?.stopReason === 'end_turn' && Object.keys(t1.response.result).length === 1, t1.response);
      ctx.check('session_info_update gives the chat a title during the first turn', t1.updates.some(u => u.sessionUpdate === 'session_info_update' && u.title));
      ctx.check('text streams as many agent_message_chunk updates (token-level, no messageId)', t1.updates.filter(u => u.sessionUpdate === 'agent_message_chunk').length > 3 && !t1.updates.some(u => u.messageId));
      ctx.check('thinking streams as agent_thought_chunk', t1.updates.some(u => u.sessionUpdate === 'agent_thought_chunk'));
      const k = kind => tools1.filter(t => t.kind === kind);
      ctx.check('tool kinds read, execute, edit, fetch and other (MCP) all appear', ['read', 'execute', 'edit', 'fetch', 'other'].every(x => k(x).length > 0), [...new Set(tools1.map(t => t.kind))]);
      ctx.check('reading README.md raised no permission request', k('read').length > 0 && !asked.some(a => a.kind === 'read'));
      ctx.check('`ls -la` (default allowlist Shell(ls)) raised no permission request', tools1.some(t => /`ls -la`/.test(t.title ?? '')) && !asked.some(a => /ls -la/.test(a.title ?? '')));
      ctx.check('writing a new file inside the workspace raised no permission request', existsSync(join(work, 'probe-write.txt')) && !asked.some(a => a.kind === 'edit'));
      ctx.check('`echo … > file` raised a permission request with allow-once / allow-always / reject-once', asked.some(a => /echo shell-ok/.test(a.title ?? '') && JSON.stringify(a.options) === '["allow-once","allow-always","reject-once"]'));
      const perms = readJson(join(slot.config, 'cli-config.json'))?.permissions;
      ctx.check('allow-always on `echo` let it run and wrote Shell(echo) into the user cli-config permissions.allow', existsSync(join(work, 'probe-shell.txt')) && perms?.allow?.includes('Shell(echo)'), perms);
      const mcpAsk = asked.find(a => a.kind === 'other' && /record/i.test(a.title ?? ''));
      ctx.check('the MCP call raised a permission request; reject-once kept it from running', !!mcpAsk && !readLines(effects).some(e => e.marker === 'turn1'), mcpAsk);
      const mcpTool = tools1.find(t => t.kind === 'other' && /record/.test(t.title ?? ''));
      ctx.note('rejected MCP tool, as the client sees it', mcpTool);
      const fetchAsk = asked.find(a => a.kind === 'fetch');
      ctx.check('web fetch raised a permission request whose toolCallId is not the tool card id', !!fetchAsk && !tools1.some(t => t.toolCallId === fetchAsk.toolCallId), fetchAsk);
      const env1 = envDump(join(work, 'env-dump.txt'));
      ctx.note('environment the agent\'s shell commands see', env1);
      ctx.check('agent shell commands inherit the CLI environment: HOME, XDG_CONFIG_HOME, CURSOR_CONFIG_DIR, the canary, and CURSOR_API_KEY', !!env1 && env1.values.ORBIT_P0_CANARY === 'inherited' && env1.hasApiKey && 'CURSOR_CONFIG_DIR' in env1.values && env1.values.HOME === slot.home);
      ctx.check('…plus CURSOR_AGENT=1 and per-command conversation/request ids', !!env1 && env1.values.CURSOR_AGENT === '1' && env1.names.includes('CURSOR_CONVERSATION_ID') && env1.names.includes('CURSOR_REQUEST_ID'));
      phase = 2;
      const asked1 = asked.length;
      const t2 = await ctx.promptAndWait(p, sid,
        'Second turn of the same probe, same rules: 1) Run the shell command `echo again > again.txt`. 2) Call the MCP tool `record` of the p0probe server with marker "turn2". ' +
        (orbit ? '3) Call the `task_get` tool of the orbit MCP server with no arguments and note the task title it returns. ' : '') +
        'Finally answer in one line: the secret word you read in the first turn, and per step ok or rejected.', 'turn 2: echo after allow-always, mcp allow-once, orbit mcp task_get, recall');
      const tools2 = toolCalls(t2.updates);
      const asked2 = asked.slice(asked1);
      const answer2 = textOf(t2.updates, 'agent_message_chunk');
      ctx.note('turn 2', { stopReason: t2.response.result?.stopReason, ms: t2.ms, tools: tools2, permissionRequests: asked2, answer: answer2.slice(-600) });
      ctx.check('second turn remembers the first (secret word)', /TANGERINE/.test(answer2));
      ctx.check('after allow-always, `echo again` runs without a permission request', existsSync(join(work, 'again.txt')) && !asked2.some(a => /echo again/.test(a.title ?? '')));
      ctx.check('MCP record with allow-once ran exactly once', readLines(effects).filter(e => e.marker === 'turn2').length === 1);
      const mcpLaunch = readLines(mcpLog).find(l => l.event === 'launch');
      ctx.check('the injected MCP server saw only HOME, PATH and its declared env', mcpLaunch && !('CURSOR_API_KEY' in mcpLaunch.env) && !('ORBIT_P0_CANARY' in mcpLaunch.env));
      if (orbit) {
        const orbitTool = tools2.find(t => /orbit/i.test(t.title ?? '') && /task_get/.test(t.title ?? ''));
        ctx.note('orbit MCP tool call', orbitTool);
        // ACP shows an MCP result only as rawOutput {success:true}; the content itself is not on the wire.
        ctx.check('`orbit mcp` injected as an ACP stdio server: task_get asks permission, then completes', !!orbitTool && orbitTool.statuses.includes('completed') && orbitTool.rawOutput?.success === true && asked2.some(a => /task_get/.test(a.title ?? '')));
        ctx.note('did the model repeat the task title from the orbit result', /P0a/.test(answer2));
      }
      ctx.note('hosts contacted during the two turns', proxy.summary());
      const st = parseStrace(straceFile);
      ctx.note('programs executed by the CLI process tree during the two turns', [...new Set(st.execs.map(e => `${e.path.replace(/.*\//, '')} ${e.argv.slice(1, 4).join(' ')}`.trim()))]);
      ctx.fixture(p, 'turns');
      await p.dispose();
      // A fresh process loads the session: history comes back as session/update notifications first.
      const q = ctx.acp({ slot, cwd: work, label: 'load', envOpts: { store: 'memory' } });
      await ctx.initialize(q);
      const from = q.updates.length;
      const ld = await ctx.loadSession(q, sid, work, servers.filter(s => s.name !== 'orbit'));
      await sleep(3000);
      const replay = q.updates.slice(from).map(u => u.update);
      ctx.note('load replay', { kinds: countKinds(replay), toolCallIds: [...new Set(replay.filter(u => u.toolCallId).map(u => u.toolCallId))].slice(0, 6), resultKeys: Object.keys(ld.result ?? {}) });
      ctx.check('session/load replays both turns (two user_message_chunk) before answering', replay.filter(u => u.sessionUpdate === 'user_message_chunk').length === 2 && !!ld.result);
      ctx.check('replayed tool calls use replay-<turn>-<step> ids, not the live ids', replay.some(u => /^replay-\d+-\d+$/.test(u.toolCallId ?? '')) && !replay.some(u => tools1.some(t => t.toolCallId === u.toolCallId)));
      const lst = await q.request('session/list', {});
      ctx.check('session/list shows the generated title', !!lst.result?.sessions?.find(s => s.sessionId === sid)?.title, lst.result);
      ctx.fixture(q, 'load');
      ctx.note('slot files after two turns', ctx.tree(slot.root));
    },
  },
  {
    name: 'cancel-mid-tool', real: 1,
    async run(ctx) {
      const slot = ctx.slot('a');
      const work = ctx.repo('work');
      const asked = [];
      const p = ctx.acp({ slot, cwd: work, label: 'cancel', onRequest: recordingPolicy(asked, () => 'allow-once'), envOpts: { store: 'memory' } });
      await ctx.initialize(p);
      const n = await ctx.newSession(p, work);
      const sid = n.result.sessionId;
      const { promise, from } = await ctx.prompt(p, sid, 'Run the shell command `sleep 47 && echo finished > slept.txt` and wait for it to finish, then reply DONE.', 'cancel while sleep 47 runs');
      const started = await p.waitFor(() => asked.some(a => /sleep 47/.test(a.title ?? '')), 180000);
      await sleep(4000);
      const before = pidsMatching('sleep 47');
      const tCancel = Date.now();
      p.notify('session/cancel', { sessionId: sid });
      const resp = await promise;
      const msToResult = Date.now() - tCancel;
      await sleep(3000);
      const after = pidsMatching('sleep 47');
      killAll(after);
      const updates = p.updates.slice(from).filter(u => u.sessionId === sid).map(u => u.update);
      const tool = toolCalls(updates).find(t => /sleep 47/.test(t.title ?? ''));
      ctx.note('cancel', { permissionAnswered: started, sleepPidsBeforeCancel: before.length, sleepPidsAfterCancel: after.length, msToResult, response: resp, tool, updatesAfterCancel: countKinds(updates) });
      ctx.check('the sleep ran (permission granted) before the cancel', started && before.length > 0);
      ctx.check('session/cancel answers the prompt with stopReason cancelled', resp.result?.stopReason === 'cancelled', resp);
      ctx.check('…within 5 s', msToResult < 5000, msToResult);
      ctx.check('the cancelled shell command is killed (no sleep left behind, slept.txt never written)', after.length === 0 && !existsSync(join(work, 'slept.txt')));
      ctx.note('the cancelled tool card never reaches a failed status (ACP has no failed status here)', tool?.statuses);
      ctx.fixture(p, 'cancel');
    },
  },
  {
    name: 'prompt-while-busy', real: 2,
    async run(ctx) {
      const slot = ctx.slot('a');
      const work = ctx.repo('work');
      const asked = [];
      const p = ctx.acp({ slot, cwd: work, label: 'busy', onRequest: recordingPolicy(asked, () => 'allow-once'), envOpts: { store: 'memory' } });
      await ctx.initialize(p);
      const n = await ctx.newSession(p, work);
      const sid = n.result.sessionId;
      const a = await ctx.prompt(p, sid, 'Run the shell command `sleep 43 && echo a-finished > a.txt`, wait for it to finish, then reply A-DONE.', 'prompt A, interrupted by prompt B');
      let aAt = null;
      a.promise.then(() => { aAt = Date.now(); });
      const started = await p.waitFor(() => asked.some(x => /sleep 43/.test(x.title ?? '')), 180000);
      await sleep(4000);
      const sleepBefore = pidsMatching('sleep 43');
      const b = await ctx.prompt(p, sid, 'Reply with exactly the word BANANA and nothing else.', 'prompt B sent while A runs');
      const bSent = Date.now();
      const [ra, rb] = await Promise.all([a.promise, b.promise]);
      const bAt = Date.now();
      await sleep(2000);
      const sleepAfter = pidsMatching('sleep 43');
      killAll(sleepAfter);
      const bText = textOf(p.updates.slice(b.from).filter(u => u.sessionId === sid).map(u => u.update), 'agent_message_chunk');
      ctx.note('prompt while busy', { started, responseA: ra, responseB: rb, aAnsweredMsAfterB: aAt ? aAt - bSent : null, bAnsweredMsAfterB: bAt - bSent, sleepBefore: sleepBefore.length, sleepAfter: sleepAfter.length, bText: bText.slice(0, 200) });
      ctx.check('a second session/prompt while one runs cancels the first: A answers stopReason cancelled', ra.result?.stopReason === 'cancelled', ra);
      ctx.check('…promptly (A answers within 5 s of B being sent)', aAt !== null && aAt - bSent < 5000);
      ctx.check('B runs to end_turn and is answered', rb.result?.stopReason === 'end_turn' && /BANANA/.test(bText), { rb, bText: bText.slice(0, 80) });
      ctx.check('A\'s shell command was killed (no sleep 43 left, a.txt absent)', sleepAfter.length === 0 && !existsSync(join(work, 'a.txt')));
      ctx.fixture(p, 'busy');
    },
  },
  {
    name: 'crash-recover-and-move', real: 1,
    async run(ctx) {
      const work = ctx.repo('work');
      const slotA = ctx.slot('a');
      const asked = [];
      const p = ctx.acp({ slot: slotA, cwd: work, label: 'crash', onRequest: recordingPolicy(asked, () => 'allow-once'), envOpts: { store: 'memory' } });
      await ctx.initialize(p);
      const n = await ctx.newSession(p, work);
      const sid = n.result.sessionId;
      const t = await ctx.prompt(p, sid, 'Run the shell command `sleep 31 && echo crash-finished > crash.txt`, wait for it to finish, then reply CRASH-DONE.', 'turn interrupted by stdin EOF then SIGKILL');
      const started = await p.waitFor(() => asked.some(x => /sleep 31/.test(x.title ?? '')), 180000);
      await sleep(3000);
      p.closeStdin();
      await sleep(8000);
      const aliveAfterEof = p.exit === null;
      const updatesAfterEof = p.updates.slice(t.from).length;
      p.signal('SIGKILL');
      const ex = await p.waitExit(10000);
      const orphans = pidsMatching('sleep 31');
      const resp = await t.promise;
      ctx.note('crash', { started, aliveAfterEof, updatesAfterEof, exit: ex, promptResponse: resp, orphanSleepPids: orphans.length });
      ctx.check('8 s after stdin EOF in mid-turn the process is still running the turn', aliveAfterEof);
      ctx.check('SIGKILL mid-turn: no prompt response ever arrives', resp.transportClosed === true);
      ctx.check('after SIGKILL of the CLI alone, its shell command keeps running (orphaned) until the runner kills it', orphans.length > 0, orphans.length);
      killAll(orphans);
      ctx.check('the interrupted turn is on disk (store.db exists)', existsSync(join(slotA.config, 'acp-sessions', sid, 'store.db')));
      ctx.fixture(p, 'crash');
      // Move the session to another config dir / HOME and load it there.
      const slotB = ctx.slot('b');
      cpSync(join(slotA.config, 'acp-sessions', sid), join(slotB.config, 'acp-sessions', sid), { recursive: true });
      const q = ctx.acp({ slot: slotB, cwd: work, label: 'moved', envOpts: { store: 'memory' } });
      await ctx.initialize(q);
      const from = q.updates.length;
      const ld = await ctx.loadSession(q, sid, work);
      await sleep(2000);
      const replay = q.updates.slice(from).map(u => u.update);
      ctx.note('replay of the crashed turn after moving acp-sessions/<id> to another config dir', { ok: !!ld.result, error: ld.error, kinds: countKinds(replay), tools: toolCalls(replay), replay });
      ctx.check('a copied acp-sessions/<id> directory loads from another CURSOR_CONFIG_DIR/HOME', !!ld.result);
      ctx.check('the replay contains the interrupted user message', replay.some(u => u.sessionUpdate === 'user_message_chunk' && /sleep 31/.test(u.content?.text ?? '')));
      ctx.check('the interrupted tool call is not replayed', !replay.some(u => u.sessionUpdate === 'tool_call'));
      await q.dispose();
      const store = ctx.storeBlobs(slotB.config, sid);
      ctx.note('message roles in the store right after load (the interrupted call gets its error result only when the next prompt is sent; see crash-continue)', store?.blobs?.map(b => b.json.role));
      ctx.fixture(q, 'moved');
      ctx.shared.crashStore = { sid, dir: join(slotA.config, 'acp-sessions', sid), work, runId: ctx.runId };
    },
  },
  {
    name: 'crash-continue', real: 1,
    async run(ctx) {
      const crash = ctx.shared.crashStore ?? latestStore('crash-recover-and-move', 'a');
      if (!ctx.check('a crashed session from crash-recover-and-move is available (this run or the latest earlier one)', !!crash)) return;
      ctx.note('crashed session used', { fromThisRun: !!ctx.shared.crashStore, runId: crash.runId });
      ctx.red.path(crash.work, '<CRASH_WORK>');
      const slot = ctx.slot('c');
      cpSync(crash.dir, join(slot.config, 'acp-sessions', crash.sid), { recursive: true });
      const p = ctx.acp({ slot, cwd: crash.work, label: 'continue', onRequest: recordingPolicy([], () => 'allow-once'), envOpts: { store: 'memory' } });
      await ctx.initialize(p);
      const ld = await ctx.loadSession(p, crash.sid, crash.work);
      if (!ctx.check('the crashed session loads in a third config dir', !!ld.result, ld.error)) return;
      const t1 = await ctx.promptAndWait(p, crash.sid, 'What was the exact shell command you ran in the previous turn of this conversation? Reply with the command in backticks only.', 'continue after crash + move: recall');
      const a1 = textOf(t1.updates, 'agent_message_chunk');
      ctx.note('recall after crash', { stopReason: t1.response.result?.stopReason, answer: a1.slice(-300) });
      ctx.check('after crash + move the conversation continues with its context (names `sleep 31`)', /sleep 31/.test(a1), a1.slice(-200));
      await p.dispose();
      const synthesized = ctx.storeBlobs(slot.config, crash.sid)?.blobs?.find(b => b.json.role === 'tool')?.json?.content?.[0]?.result;
      ctx.check('the first prompt after the crash gives the interrupted shell call an error result', /interrupted/i.test(synthesized ?? ''), synthesized);
      ctx.fixture(p, 'continue');
      ctx.shared.continuedStore = { sid: crash.sid, dir: join(slot.config, 'acp-sessions', crash.sid), work: crash.work, runId: ctx.runId };
    },
  },
  {
    name: 'shell-wrapper-env', real: 1,
    async run(ctx) {
      // D4 approach A as P3 ships it (src/runner-go/cursor_launch.go: writeCursorShellWrapper, prepareCursorLaunch):
      // the CLI runs on an account HOME, and SHELL is orbit-bash, which puts the runner user's HOME back and
      // unsets the CLI's own variables before it execs bash. The CLI only takes a $SHELL whose path names bash.
      const slot = ctx.slot('a');
      const work = ctx.repo('work');
      // The runner user's HOME, stood in for by a directory of the run's: what lands in it is visible here,
      // and the real one is never touched. Each HOME has a login profile that says whose it is.
      const realHome = join(ctx.dir, 'real-home');
      mkdirSync(realHome, { recursive: true });
      writeFileSync(join(realHome, '.bash_profile'), 'export ORBIT_P0_PROFILE_HOME=real\n');
      writeFileSync(join(slot.home, '.bash_profile'), 'export ORBIT_P0_PROFILE_HOME=account\n');
      const wrapper = join(ctx.dir, 'bin', 'orbit-bash');
      mkdirSync(join(ctx.dir, 'bin'), { recursive: true });
      // The wrapper logs its own invocations (P0b): macOS has no strace, so the "which shell ran the
      // commands, with -c or -ilc" checks read this log there.
      const wrapperRan = join(ctx.dir, 'wrapper-ran.log');
      writeFileSync(wrapper, '#!/bin/sh\n' +
        '# Orbit: the shell Cursor CLI runs an agent\'s commands in. The CLI itself runs with a HOME of\n' +
        '# the session\'s own; its commands get the real one back, without the CLI\'s own variables.\n' +
        `printf '%s\n' "$*" >> '${wrapperRan}'\n` +
        `HOME='${realHome.replace(/'/g, `'"'"'`)}'\n` +
        'export HOME\n' +
        'unset CURSOR_API_KEY CURSOR_AUTH_TOKEN XDG_CONFIG_HOME CURSOR_CONFIG_DIR CURSOR_DATA_DIR\n' +
        'exec \'/bin/bash\' "$@"\n');
      chmodSync(wrapper, 0o700);
      // An account session carries a token (CURSOR_AUTH_TOKEN), a key session the key: this one carries both,
      // the token exchanged from the key with no prompt, so one turn shows what becomes of each.
      const ex = ctx.slot('exchange');
      const q = ctx.acp({ slot: ex, cwd: work, label: 'exchange', envOpts: { store: 'file' } });
      await ctx.initialize(q);
      const qn = await ctx.newSession(q, work);
      await q.dispose();
      const authFile = process.platform === 'darwin' ? join(ex.home, '.cursor', 'auth.json') : join(ex.xdgConfig, 'cursor', 'auth.json');
      if (!ctx.check('a token is exchanged from the key without a prompt (file store, session/new)', !!qn.result && existsSync(authFile))) return;
      const token = JSON.parse(readFileSync(authFile, 'utf8')).accessToken;
      ctx.red.secret(token, 'ACCESS_TOKEN');
      rmSync(authFile);
      // P3's fixed layer (§16.3): no XDG_* variables, credentials in memory, no browser, direnv or debug log.
      const user = process.env.USER ?? 'root';
      const env = cursorEnv(slot, { layout: 'config-data', apiKey: ctx.key, store: 'memory', extra: { SHELL: wrapper, CURSOR_AUTH_TOKEN: token,
        DIRENV_DISABLE: '1', CURSOR_AGENT_DISABLE_DEBUG_LOG: '1', USER: user, LOGNAME: user } });
      const asked = [];
      const straceFile = join(ctx.dir, 'turn.strace');
      const p = ctx.acp({ slot, cwd: work, env, label: 'wrapper', onRequest: recordingPolicy(asked, () => 'allow-once'),
        wrap: straceWrap(straceFile) });
      await ctx.initialize(p);
      const n = await ctx.newSession(p, work);
      if (!ctx.check('session/new succeeds with both CURSOR_API_KEY and CURSOR_AUTH_TOKEN set', !!n.result?.sessionId, n.error)) return;
      const t = await ctx.promptAndWait(p, n.result.sessionId,
        'Run these two shell commands exactly as written, one tool call each, then reply DONE: ' +
        '`printf \'%s\\n\' "HOME=$HOME" "SHELL=$SHELL" "PROFILE=$ORBIT_P0_PROFILE_HOME" "CANARY=$ORBIT_P0_CANARY" "PATH=$PATH" > probe.txt` and ' +
        '`env | cut -d= -f1 | sort > env-names.txt`.', 'D4 A: P3 orbit-bash as SHELL; HOME, profile and variable names agent commands see');
      const probe = Object.fromEntries((existsSync(join(work, 'probe.txt')) ? readFileSync(join(work, 'probe.txt'), 'utf8').trim().split('\n') : [])
        .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
      const names = existsSync(join(work, 'env-names.txt')) ? readFileSync(join(work, 'env-names.txt'), 'utf8').trim().split('\n') : [];
      const st = parseStrace(straceFile);
      const shells = st.execs.filter(e => e.ok && (/bash/.test(e.path) || e.path === '/bin/sh' || e.path === '/usr/bin/sh'))
        .map(e => `${e.path.replace(ctx.dir, '<RUN>')} ${e.argv.slice(1, 4).join(' ')}`.trim());
      // On macOS (no strace) the wrapper's own log stands in for the execve trace.
      const wrapperInvocations = existsSync(wrapperRan) ? readFileSync(wrapperRan, 'utf8').trim().split('\n').filter(Boolean) : [];
      const ranWrapper = process.platform === 'darwin' ? wrapperInvocations.length > 0 : shells.some(x => x.includes('orbit-bash'));
      const ranSnapshotAndCommand = process.platform === 'darwin'
        ? wrapperInvocations.some(x => /\s-(il|li)c\b/.test(x)) && wrapperInvocations.some(x => /\s-c\b/.test(x))
        : shells.some(x => x.includes('orbit-bash') && /\s-(il|li)c\b/.test(x)) && shells.some(x => x.includes('orbit-bash') && /\s-c\b/.test(x));
      const removed = ['CURSOR_API_KEY', 'CURSOR_AUTH_TOKEN', 'XDG_CONFIG_HOME', 'CURSOR_CONFIG_DIR', 'CURSOR_DATA_DIR'];
      const cliVars = names.filter(x => /CURSOR|AGENT|XDG|DIRENV|NO_OPEN_BROWSER|SHELL|ORBIT/.test(x));
      ctx.note('agent command environment under SHELL=<RUN>/bin/orbit-bash', { stopReason: t.response.result?.stopReason, probe, names, cursorAndOrbitNames: cliVars,
        shellsExecuted: [...new Set(shells)], wrapperInvocations, permissionRequests: asked.map(a => a.title), answer: textOf(t.updates, 'agent_message_chunk').slice(-200) });
      ctx.note('variables the CLI process had that the commands do not see', Object.keys(env).filter(k => !names.includes(k)).sort());
      ctx.note('files in the stand-in for the runner user\'s HOME after the turn', ctx.tree(realHome));
      ctx.check('both commands ran', Object.keys(probe).length > 0 && names.length > 0, { probe: Object.keys(probe), names: names.length });
      ctx.check('the CLI starts orbit-bash (a #!/bin/sh script whose path names bash) for the agent\'s commands', ranWrapper, [...new Set(shells)]);
      ctx.check('…for the login-shell snapshot (-ilc) as well as for each command (-c)', ranSnapshotAndCommand,
        process.platform === 'darwin' ? wrapperInvocations : [...new Set(shells)]);
      ctx.check('agent commands see the runner user\'s HOME (the wrapper\'s), not the CLI\'s account HOME', probe.HOME === realHome, probe.HOME);
      ctx.check('…and its login profile, not the account HOME\'s', probe.PROFILE === 'real', probe.PROFILE);
      ctx.check('…and none of CURSOR_API_KEY, CURSOR_AUTH_TOKEN, XDG_CONFIG_HOME, CURSOR_CONFIG_DIR, CURSOR_DATA_DIR', names.length > 0 && !names.some(x => removed.includes(x)), names.filter(x => removed.includes(x)));
      ctx.check('a workspace variable still reaches them (the canary)', probe.CANARY === 'inherited' && names.includes('ORBIT_P0_CANARY'));
      ctx.check('the CLI itself still runs on the account HOME: its state file is there, nothing of Cursor\'s in the commands\' HOME',
        existsSync(join(slot.home, '.cursor', 'agent-cli-state.json')) && !existsSync(join(realHome, '.cursor')) && !existsSync(join(realHome, '.config', 'cursor')));
      ctx.fixture(p, 'wrapper');
    },
  },
  {
    name: 'permission-force', real: 1,
    async run(ctx) {
      const slot = ctx.slot('a');
      const work = ctx.repo('work');
      const mcpLog = join(ctx.dir, 'mcp.log'), effects = join(ctx.dir, 'mcp-effects.log');
      const asked = [];
      const p = ctx.acp({ slot, cwd: work, label: 'force', args: ['--force'], onRequest: recordingPolicy(asked, () => 'allow-once'), envOpts: { store: 'memory' } });
      await ctx.initialize(p);
      const n = await ctx.newSession(p, work, [mcpServer('p0probe', mcpLog, effects)]);
      const sid = n.result.sessionId;
      const t = await ctx.promptAndWait(p, sid, stepsPrompt('force', 'force-mode'), '--force: write/shell/mcp/fetch');
      await p.dispose();
      const store = ctx.storeBlobs(slot.config, sid);
      ctx.note('force', { stopReason: t.response.result?.stopReason, tools: toolCalls(t.updates).map(x => ({ title: x.title, kind: x.kind, statuses: x.statuses })), permissionRequests: asked, storeMeta: store?.meta?.map(m => ({ ...m, value: m.value && { ...m.value, blobEncryptionKey: m.value.blobEncryptionKey ? '<present>' : undefined } })) });
      ctx.check('--force: no permission request at all', asked.length === 0, asked);
      ctx.check('--force: write, shell and MCP effects all happened', existsSync(join(work, 'force-write.txt')) && existsSync(join(work, 'force-shell.txt')) && readLines(effects).some(e => e.marker === 'force-mode'));
      ctx.check('--force: the fetch ran', toolCalls(t.updates).some(x => x.kind === 'fetch' && x.statuses.includes('completed')));
      ctx.check('the session store records isRunEverything: true', store?.meta?.some(m => m.value?.isRunEverything === true));
      ctx.fixture(p, 'force');
    },
  },
  {
    name: 'permission-auto-review', real: 1,
    async run(ctx) {
      const slot = ctx.slot('a');
      const work = ctx.repo('work');
      const mcpLog = join(ctx.dir, 'mcp.log'), effects = join(ctx.dir, 'mcp-effects.log');
      const asked = [];
      const p = ctx.acp({ slot, cwd: work, label: 'auto-review', args: ['--auto-review'], onRequest: recordingPolicy(asked, () => 'allow-once'), envOpts: { store: 'memory' } });
      await ctx.initialize(p);
      const n = await ctx.newSession(p, work, [mcpServer('p0probe', mcpLog, effects)]);
      const sid = n.result.sessionId;
      const t = await ctx.promptAndWait(p, sid, stepsPrompt('auto', 'auto-review'), '--auto-review: write/shell/mcp/fetch');
      await p.dispose();
      const store = ctx.storeBlobs(slot.config, sid);
      ctx.note('auto-review', { stopReason: t.response.result?.stopReason, tools: toolCalls(t.updates).map(x => ({ title: x.title, kind: x.kind, statuses: x.statuses })), permissionRequests: asked, storeMode: store?.meta?.map(m => m.value?.mode) });
      ctx.check('--auto-review on the ACP path behaves like the default allowlist: `touch` and the MCP call still ask', asked.some(a => /touch/.test(a.title ?? '')) && asked.some(a => a.kind === 'other'), asked.map(a => a.title));
      ctx.check('…and the workspace write does not ask', existsSync(join(work, 'auto-write.txt')) && !asked.some(a => a.kind === 'edit'));
      ctx.fixture(p, 'auto-review');
    },
  },
  {
    name: 'plan-and-ask-modes-concurrent', real: 2,
    async run(ctx) {
      const slot = ctx.slot('a');
      const work = ctx.repo('work', { 'README.md': README });
      const mcpLog = join(ctx.dir, 'mcp.log'), effects = join(ctx.dir, 'mcp-effects.log');
      const asked = [], plans = [], questions = [];
      const p = ctx.acp({ slot, cwd: work, label: 'modes', envOpts: { store: 'memory' }, onRequest: recordingPolicy(asked, () => 'allow-once', {
        'cursor/create_plan': msg => { plans.push(msg.params); return { result: { outcome: { outcome: 'accepted' } } }; },
        'cursor/ask_question': msg => { questions.push(msg.params); return { result: { outcome: { outcome: 'skipped', reason: 'P0 probe does not answer questions here' } } }; },
      }) });
      await ctx.initialize(p);
      const s1 = (await ctx.newSession(p, work, [mcpServer('p0probe', mcpLog, effects)])).result.sessionId;
      const s2 = (await ctx.newSession(p, work, [mcpServer('p0probe', mcpLog, effects)])).result.sessionId;
      const m1 = await p.request('session/set_mode', { sessionId: s1, modeId: 'plan' });
      const m2 = await p.request('session/set_config_option', { sessionId: s2, configId: 'mode', value: 'ask' });
      await sleep(1000);
      ctx.check('session/set_mode emits current_mode_update', p.updatesFor(s1).some(u => u.sessionUpdate === 'current_mode_update' && u.currentModeId === 'plan'), p.updatesFor(s1).map(u => u.sessionUpdate));
      ctx.note('mode switch replies', { setMode: m1, setConfigOption: m2.result?.configOptions?.map(o => `${o.id}=${o.currentValue}`) });
      const ask = mode => `Attempt these actions now and report for each whether it was allowed: 1) create the file ${mode}-write.txt containing x; 2) run the shell command \`touch ${mode}-shell.txt\`; 3) call the MCP tool \`record\` of the p0probe server with marker "${mode}-mode". ` +
        (mode === 'plan' ? 'Then give a two-line plan for adding a CONTRIBUTING.md file.' : 'Then say in one sentence what README.md says.');
      const a = await ctx.prompt(p, s1, ask('plan'), 'plan mode (concurrent with ask)');
      const b = await ctx.prompt(p, s2, ask('ask'), 'ask mode (concurrent with plan)');
      const [ra, rb] = await Promise.all([a.promise, b.promise]);
      const u1 = p.updates.slice(a.from).filter(u => u.sessionId === s1).map(u => u.update);
      const u2 = p.updates.slice(b.from).filter(u => u.sessionId === s2).map(u => u.update);
      ctx.note('plan session', { stopReason: ra.result?.stopReason, tools: toolCalls(u1).map(x => ({ title: x.title, kind: x.kind, statuses: x.statuses, rawOutput: x.rawOutput })), kinds: countKinds(u1), answer: textOf(u1, 'agent_message_chunk').slice(-500), createPlan: plans });
      ctx.note('ask session', { stopReason: rb.result?.stopReason, tools: toolCalls(u2).map(x => ({ title: x.title, kind: x.kind, statuses: x.statuses, rawOutput: x.rawOutput })), kinds: countKinds(u2), answer: textOf(u2, 'agent_message_chunk').slice(-500) });
      ctx.note('permission requests in plan/ask', asked);
      ctx.check('two sessions of one process ran prompts concurrently, each to end_turn', ra.result?.stopReason === 'end_turn' && rb.result?.stopReason === 'end_turn');
      // Measured 2026-10-16: neither mode is read-only on the ACP path (see analysis/plan-and-ask-modes-concurrent.json).
      const markers = readLines(effects).map(e => e.marker);
      ctx.check('plan mode: the workspace write is blocked', !existsSync(join(work, 'plan-write.txt')));
      ctx.check('ask mode: the workspace write happens, without a permission request', existsSync(join(work, 'ask-write.txt')) && !asked.some(a => a.sessionId === s2 && a.kind === 'edit'));
      ctx.check('plan and ask mode: `touch` asks permission and, once allowed, runs', existsSync(join(work, 'plan-shell.txt')) && existsSync(join(work, 'ask-shell.txt')) && asked.filter(a => /touch/.test(a.title ?? '')).length === 2);
      ctx.check('plan and ask mode: the MCP call asks permission and, once allowed, runs', markers.includes('plan-mode') && markers.includes('ask-mode'));
      ctx.check('plan mode: a plan update and a cursor/create_plan request arrive', u1.some(u => u.sessionUpdate === 'plan') && plans.length > 0);
      ctx.fixture(p, 'modes');
    },
  },
  // In agent mode (the default) and, run only if agent mode raises no question, in plan mode.
  ...[['ask-question', 'agent'], ['ask-question-plan-mode', 'plan']].map(([name, mode]) => ({
    name, real: 1,
    async run(ctx) {
      const slot = ctx.slot('a');
      const work = ctx.repo('work');
      const asked = [], questions = [], plans = [];
      let first = true;
      const p = ctx.acp({ slot, cwd: work, label: 'ask', envOpts: { store: 'memory' }, onRequest: recordingPolicy(asked, msg => {
        // The fallback path turns a question into a permission request whose options are the answers.
        const opts = msg.params.options ?? [];
        const answers = opts.filter(o => o.optionId !== '__ask_question_skip__');
        return answers.length ? answers[answers.length - 1].optionId : 'allow-once';
      }, {
        'cursor/ask_question': async msg => {
          const entry = { at: Date.now(), params: msg.params };
          questions.push(entry);
          if (first) {
            first = false;
            // Leave the first question unanswered for 30 s, then refuse the extension: the CLI falls back.
            await sleep(30000);
            entry.answeredAfterMs = Date.now() - entry.at;
            entry.reply = 'error -32601';
            return { error: { code: -32601, message: 'Method not found' } };
          }
          entry.reply = 'answered';
          return { result: { outcome: { outcome: 'answered', answers: (msg.params.questions ?? []).map(q => ({ questionId: q.id, selectedOptionIds: [q.options[q.options.length - 1].id] })) } } };
        },
        'cursor/create_plan': msg => { plans.push(msg.params); return { result: { outcome: { outcome: 'accepted' } } }; },
      }) });
      await ctx.initialize(p);
      const n = await ctx.newSession(p, work);
      const sid = n.result.sessionId;
      if (mode !== 'agent') {
        const m = await p.request('session/set_mode', { sessionId: sid, modeId: mode });
        if (!ctx.check(`session/set_mode ${mode}`, !!m.result, m.error)) return;
      }
      const t = await ctx.promptAndWait(p, sid,
        'Use your ask-question tool twice, one question per tool call, and wait for each answer: first ask "Pick a fruit" with the options apple and banana; ' +
        'after that answer arrives, ask "Pick a color" with the options red and blue. Then reply with exactly: fruit=<answer>, color=<answer>.', `cursor/ask_question (${mode} mode): unanswered 30 s then error (fallback), then answered`);
      const answer = textOf(t.updates, 'agent_message_chunk');
      // Which tools the turn's stored context offered: the dynamic-tool namespaces (§6), AskQuestion among them or not.
      const store = ctx.storeBlobs(slot.config, sid);
      const contextText = (store?.blobs ?? []).filter(b => ['system', 'user'].includes(b.json.role)).map(b => JSON.stringify(b.json.content)).join('\n').replace(/\\"/g, '"');
      const namespaces = Object.fromEntries([...contextText.matchAll(/<namespace name="([^"]+)" tools="([^"]*)"/g)].map(m => [m[1], m[2].split(/,\s*/)]));
      ctx.note('questions', { mode, questions, fallbackPermissionRequests: asked, createPlan: plans, stopReason: t.response.result?.stopReason, answer: answer.slice(-300),
        tools: toolCalls(t.updates).map(x => ({ title: x.title, kind: x.kind, statuses: x.statuses })) });
      ctx.note('tools offered in the stored context (dynamic-tool namespaces)', { namespaces, mentionsAskQuestion: /AskQuestion|ask_question/i.test(contextText) });
      if (questions.length === 0) {
        // Measured 2026-10-16 (Free plan, agent mode): the server offered no AskQuestion tool.
        ctx.check(`no cursor/ask_question in ${mode} mode: the model says it has no such tool and asks in plain text`, /AskQuestion isn.t available|ask conversationally|not available|don.t have|do not have|no .*tool/i.test(answer), answer.slice(-200));
        ctx.fixture(p, 'ask');
        return;
      }
      ctx.check('cursor/ask_question arrives as a JSON-RPC request with toolCallId, title and questions[{id,prompt,options,allowMultiple}]', questions.length > 0 && Array.isArray(questions[0].params.questions) && 'allowMultiple' in (questions[0].params.questions[0] ?? {}));
      ctx.check('nothing times out while a question waits unanswered for 30 s (turn still open)', questions[0]?.answeredAfterMs >= 30000 && !t.updates.some(u => /timed? ?out/i.test(u.content?.text ?? '')));
      ctx.check('an error reply makes the CLI fall back to session/request_permission with the answers as options plus __ask_question_skip__', asked.some(a => a.options.includes('__ask_question_skip__')));
      ctx.check('an "answered" reply reaches the model (second answer used)', /color\s*=\s*blue/i.test(answer), answer.slice(-120));
      ctx.check('…and so does the fallback selection (first answer used)', /fruit\s*=\s*banana/i.test(answer), answer.slice(-120));
      ctx.fixture(p, 'ask');
    },
  })),
  {
    name: 'subagent-and-todos', real: 1,
    async run(ctx) {
      const slot = ctx.slot('a');
      const work = ctx.repo('work', { 'README.md': README });
      const asked = [], ext = [];
      const p = ctx.acp({ slot, cwd: work, label: 'subagent', envOpts: { store: 'memory' }, onRequest: recordingPolicy(asked, () => 'allow-once', {
        'cursor/update_todos': msg => { ext.push({ method: msg.method, params: msg.params }); return { result: {} }; },
        'cursor/task': msg => { ext.push({ method: msg.method, params: msg.params }); return { result: {} }; },
        'cursor/create_plan': msg => { ext.push({ method: msg.method, params: msg.params }); return { result: { outcome: { outcome: 'accepted' } } }; },
      }) });
      const init = await ctx.initialize(p, { _meta: { subagents: true } });
      const n = await ctx.newSession(p, work);
      const sid = n.result.sessionId;
      const t = await ctx.promptAndWait(p, sid,
        'Do two things. 1) Use your TodoWrite tool to create a todo list with the items "read README" and "report first line", and mark each completed as you finish it. ' +
        '2) Use your Task tool to start exactly one subagent that reads README.md and returns its first line. Then reply with that first line only.', 'TodoWrite + Task subagent');
      await sleep(3000);
      const all = p.updates.slice(0).map(u => ({ sessionId: u.sessionId, kind: u.update.sessionUpdate, meta: u.update._meta, update: u.update }));
      const child = all.filter(u => u.sessionId !== sid);
      ctx.note('subagent', { negotiated: init.result?.agentCapabilities?.sessionCapabilities, stopReason: t.response.result?.stopReason, extensionRequests: ext, kinds: countKinds(t.updates),
        subagentUpdates: all.filter(u => /subagent/.test(u.kind)).map(u => u.update), childSessionUpdates: countKinds(child.map(u => u.update)), childSessionIds: [...new Set(child.map(u => u.sessionId))], tools: toolCalls(t.updates).map(x => ({ title: x.title, kind: x.kind, statuses: x.statuses })), answer: textOf(t.updates, 'agent_message_chunk').slice(-200) });
      ctx.check('cursor/update_todos arrives as a request carrying the todo list', ext.some(e => e.method === 'cursor/update_todos' && Array.isArray(e.params.todos) && e.params.todos.length >= 2));
      ctx.check('cursor/task arrives when the Task tool finishes', ext.some(e => e.method === 'cursor/task'));
      ctx.check('subagent_spawned / subagent_state_update session updates arrive (subagents negotiated)', all.some(u => u.kind === 'subagent_spawned') && all.some(u => u.kind === 'subagent_state_update'));
      ctx.check('the subagent\'s own updates arrive under a different sessionId', child.length > 0);
      ctx.check('the answer carries the README\'s first line', /# probe repo/.test(textOf(t.updates, 'agent_message_chunk')));
      ctx.fixture(p, 'subagent');
    },
  },
  {
    name: 'background-shell-and-commit', real: 1,
    async run(ctx) {
      const slot = ctx.slot('a');
      const work = ctx.repo('work', { 'README.md': README });
      const asked = [];
      const p = ctx.acp({ slot, cwd: work, label: 'background', onRequest: recordingPolicy(asked, () => 'allow-once'), envOpts: { store: 'memory' } });
      await ctx.initialize(p);
      const n = await ctx.newSession(p, work);
      const sid = n.result.sessionId;
      const t0 = Date.now();
      const t = await ctx.promptAndWait(p, sid,
        'Three steps: 1) Append the line "attribution probe" to README.md. 2) Commit that change with git using the commit message "p0 attribution probe" (git user.name and user.email may be set with -c for this one command if needed). ' +
        '3) Start the shell command `sleep 20 && echo bg-done > bg.txt` in the background so that you do not wait for it, and end your turn right after starting it.', 'commit attribution + background shell');
      const resultAt = Date.now();
      const after = p.updates.length;
      await sleep(40000);
      const bgFile = join(work, 'bg.txt');
      const bgAt = existsSync(bgFile) ? statSync(bgFile).mtimeMs : null;
      const unsolicited = p.updates.slice(after).map(u => u.update.sessionUpdate);
      const reqAfter = p.serverRequests.filter(r => r.method && true).length;
      const log = spawnSync('git', ['log', '-1', '--format=%an <%ae>%n%cn <%ce>%n%B'], { cwd: work, encoding: 'utf8' }).stdout;
      ctx.note('background + commit', { stopReason: t.response.result?.stopReason, turnMs: resultAt - t0, bgFileWrittenMsAfterResult: bgAt ? Math.round(bgAt - resultAt) : null, updatesAfterResult: unsolicited, permissionRequests: asked,
        tools: toolCalls(t.updates).map(x => ({ title: x.title, kind: x.kind, statuses: x.statuses, rawInput: x.rawInput })), lastCommit: log });
      ctx.check('the commit was made', /p0 attribution probe/.test(log), log);
      ctx.note('commit attribution (attributeCommitsToAgent default true): trailer lines in the message', log.split('\n').filter(l => /cursor|made with|co-authored/i.test(l)));
      // session_info_update / available_commands_update may land after the reply (not awaited); a new turn would bring text or tools.
      ctx.check('no unsolicited turn after end_turn: no text, thought or tool update in the 40 s after the prompt answered', !unsolicited.some(k => /chunk|tool_call/.test(k)), unsolicited);
      ctx.note('whether the prompt waited for the background command', bgAt === null ? 'bg.txt not written' : bgAt <= resultAt ? 'prompt answered after bg.txt was written' : 'prompt answered before bg.txt was written');
      ctx.fixture(p, 'background');
    },
  },
  // with-flags is the run the contract asked for; the single-flag variants separate the two flags' effects
  // on the stored context if with-flags leaves that open.
  ...[['baseline', []], ['with-flags', ['--disable-project-configs', '--exclude-workspace-context']],
    ['disable-project-configs', ['--disable-project-configs']], ['exclude-workspace-context', ['--exclude-workspace-context']]].map(([variant, args]) => ({
    name: `repo-config-${variant}`, real: 1,
    async run(ctx) {
      const repo = join(ctx.dir, 'repo');
      mkdirSync(repo, { recursive: true });
      const paths = { markerLog: join(ctx.dir, 'markers.log'), mcpLog: join(ctx.dir, 'mcp.log'), toolsDir: join(ctx.dir, 'tools') };
      const fx = buildFixtureRepo(repo, paths);
      const slot = ctx.slot('a');
      plantSlotConfigs(slot, repo, { mark: fx.mark, mcpLog: paths.mcpLog });
      const asked = [];
      // The flags act on different things (cli.json vs. the context sent upstream), so one run with
      // both still tells their effects apart: permission prompts vs. codewords in the stored context.
      const disableProjectConfigs = args.includes('--disable-project-configs');
      const straceFile = join(ctx.dir, 'turn.strace');
      const p = ctx.acp({ slot, cwd: repo, label: 'repo', args, onRequest: recordingPolicy(asked, () => 'allow-once'), envOpts: { store: 'memory' },
        wrap: straceWrap(straceFile) });
      await ctx.initialize(p);
      const n = await ctx.newSession(p, repo);
      if (!ctx.check(`session/new succeeds with ${args.join(' ') || 'no flags'}`, !!n.result?.sessionId, n.error ?? { exit: p.exit, stderr: p.stderr.slice(-300) })) return;
      const sid = n.result.sessionId;
      const markersBefore = readLines(paths.markerLog).length;
      const t = await ctx.promptAndWait(p, sid,
        'Five steps, one tool call each: 1) Run the shell command `touch hooked.txt`. 2) Run the shell command `mkdir made-dir`. 3) Append the line "# probe" to app.py. ' +
        '4) Read the file sub/note.txt. 5) Reply with every codeword (strings that start with P0-) that appears anywhere in your instructions, rules or skills, comma-separated, or "none".', `repo configs (${variant})`);
      await sleep(5000);
      const commands = [...p.updatesFor(sid)].reverse().find(u => u.sessionUpdate === 'available_commands_update')?.availableCommands?.map(c => c.name) ?? [];
      await p.dispose();
      const markerLines = readLines(paths.markerLog);
      const markers = markerLines.map(m => `${m.source}:${m.event}`);
      const store = ctx.storeBlobs(slot.config, sid);
      const context = JSON.stringify(store?.blobs?.filter(b => ['system', 'user'].includes(b.json.role)).map(b => b.json.content) ?? []);
      const inContext = Object.fromEntries(Object.entries(CODEWORDS).map(([k, w]) => [k, context.includes(w)]));
      const answer = textOf(t.updates, 'agent_message_chunk');
      const st = parseStrace(straceFile);
      const programs = [...new Set(st.execs.map(e => `${e.path.replace(/.*\//, '')} ${e.argv.slice(1, 4).join(' ')}`.trim()))];
      const bySource = {};
      for (const m of markerLines) (bySource[m.source] ??= []).includes(m.event) || bySource[m.source].push(m.event);
      ctx.note('repo configuration', { variant, args, stopReason: t.response.result?.stopReason, markersAtStartup: markersBefore, hookEventsBySource: bySource, markers, permissionRequests: asked,
        codewordsInStoredContext: inContext, codewordsInAnswer: Object.fromEntries(Object.entries(CODEWORDS).map(([k, w]) => [k, answer.includes(w)])), answer: answer.slice(-500),
        mcpServersStarted: [...new Set(readLines(paths.mcpLog).filter(l => l.event === 'launch').map(l => l.server))], availableCommands: commands, programs,
        hookEnvironment: markerLines.slice(0, 1).map(m => ({ home: m.home, xdgConfig: m.xdgConfig, cursorConfigDir: m.cursorConfigDir, canary: m.canary })),
        tools: toolCalls(t.updates).map(x => ({ title: x.title, kind: x.kind, statuses: x.statuses })) });
      ctx.check('the turn ran', t.response.result?.stopReason === 'end_turn' && existsSync(join(repo, 'hooked.txt')));
      const touchAsked = asked.some(a => /touch hooked/.test(a.title ?? ''));
      const mkdirAsked = asked.some(a => /mkdir made-dir/.test(a.title ?? ''));
      if (disableProjectConfigs) ctx.check('--disable-project-configs: the repo\'s cli.json allow entry is ignored (`touch` asks)', touchAsked);
      else ctx.check('the repo\'s .cursor/cli.json widens the allowlist: `touch` runs without a permission request', !touchAsked && existsSync(join(repo, 'hooked.txt')));
      ctx.check('the repo\'s .claude/settings.json permissions are not read on the ACP path (`mkdir`, allowed only there, asks)', mkdirAsked, asked.map(a => a.title));
      ctx.check('repo .cursor/hooks.json never runs in ACP', !markers.some(m => m.startsWith('repo-cursor-hooks')));
      ctx.check('repo .cursor/worktrees.json, environment.json and .envrc never run', !markers.some(m => /repo-(worktrees|environment|envrc)/.test(m)));
      ctx.check('the repo\'s .cursor/mcp.json server does not start (never approved)', !readLines(paths.mcpLog).some(l => l.event === 'launch' && l.server === 'repo-mcp'));
      ctx.note('hook sources that did run', Object.keys(bySource));
      ctx.note('codewords present in the stored model context', inContext);
      if (args.includes('--exclude-workspace-context')) ctx.note('--exclude-workspace-context: workspace rules still in the stored context?', inContext.agents || inContext.ruleAlways);
      ctx.fixture(p, 'repo');
    },
  })),
  {
    name: 'network-drop-mid-turn', real: 1,
    async run(ctx) {
      const slot = ctx.slot('a');
      const work = ctx.repo('work');
      const proxy = await ctx.proxy();
      // The CLI's own debug log (§8.1) goes to the run's TMPDIR, for what it says about the failure.
      const tmp = join(ctx.dir, 'tmp');
      mkdirSync(tmp, { recursive: true });
      const env = ctx.env(slot, { store: 'memory', extra: { HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url, NO_PROXY: '127.0.0.1,localhost', NODE_USE_ENV_PROXY: '1', TMPDIR: tmp } });
      const p = ctx.acp({ slot, cwd: work, env, label: 'netdrop' });
      await ctx.initialize(p);
      const n = await ctx.newSession(p, work);
      const sid = n.result.sessionId;
      const t = await ctx.prompt(p, sid, 'Without using any tools, write a 300-word story about a lighthouse keeper, in plain text.', 'network cut after the first text chunk');
      const streaming = await p.waitFor(() => p.updates.slice(t.from).some(u => u.update.sessionUpdate === 'agent_message_chunk'), 180000);
      const cutAt = Date.now();
      const before = p.updates.length;
      proxy.cut();
      // Phase A: network gone for up to 120 s. Phase B: network back for up to 180 s (does it resume?).
      let resp = await Promise.race([t.promise, sleep(120000).then(() => null)]);
      const phaseA = { answered: !!resp, ms: Date.now() - cutAt, updates: countKinds(p.updates.slice(before).map(u => u.update)), deniedTunnels: proxy.tunnels.filter(x => x.denied).length };
      proxy.restore();
      const restoredAt = Date.now();
      const beforeB = p.updates.length;
      if (!resp) resp = await Promise.race([t.promise, sleep(180000).then(() => ({ localTimeout: true }))]);
      const phaseB = { ms: Date.now() - restoredAt, updates: countKinds(p.updates.slice(beforeB).map(u => u.update)) };
      const after = p.updates.slice(t.from).map(u => u.update);
      // Every message chunk after the cut as sent, and the last one: the shape P5b classifies (§12, §16.6).
      const chunksAfterCut = p.updates.slice(before).filter(u => u.update.sessionUpdate === 'agent_message_chunk').map(u => u.update.content?.text ?? '');
      const lastChunk = [...after].reverse().find(u => u.sessionUpdate === 'agent_message_chunk')?.content?.text ?? null;
      ctx.note('network drop', { streamingBeforeCut: streaming, response: resp, phaseA, phaseB, kinds: countKinds(after), tail: textOf(after, 'agent_message_chunk').slice(-400),
        chunksAfterCut: chunksAfterCut.length > 40 ? [...chunksAfterCut.slice(0, 20), `… ${chunksAfterCut.length} in all`, ...chunksAfterCut.slice(-20)] : chunksAfterCut, lastChunk, stderrTail: p.stderr.slice(-600) });
      const logDir = join(tmp, `cursor-agent-logs-${process.getuid()}`);
      const logLines = existsSync(logDir) ? readdirSync(logDir).filter(f => f.includes(`-${p.pid}-`)).flatMap(f => readFileSync(join(logDir, f), 'utf8').split('\n')) : [];
      const failureLines = logLines.filter(l => /error|retr(y|ies)|ECONN|socket|network|timed? ?out|abort|unavailable|deadline|reconnect/i.test(l));
      ctx.note('CLI debug log lines about the failure (first 40 and last 40)', { lines: logLines.length, matching: failureLines.length,
        excerpt: (failureLines.length > 80 ? [...failureLines.slice(0, 40), '…', ...failureLines.slice(-40)] : failureLines).map(l => l.slice(0, 400)) });
      ctx.check('a network loss mid-stream ends the prompt within 120 s or the turn resumes once the network is back (no endless hang)', !resp.localTimeout && !resp.timeout, { phaseA, phaseB, resp });
      ctx.note('error surface: JSON-RPC error vs stopReason + text', resp.error ? 'json-rpc error' : resp.result?.stopReason);
      const l = await p.request('session/list', {});
      ctx.check('the process survives and answers again once the network is back', Array.isArray(l.result?.sessions));
      ctx.fixture(p, 'netdrop');
    },
  },
  {
    name: 'login-account', real: 1,
    async run(ctx) {
      const acct = join(P0_ROOT, 'accounts', 'slots', 'login-1');
      const authFile = join(acct, 'xdg-config', 'cursor', 'auth.json');
      if (!ctx.check('the owner completed the remote login (accounts/login-1 holds auth.json)', existsSync(authFile))) return;
      const slot = { root: acct, home: join(acct, 'home'), config: join(acct, 'cursor-config'), data: join(acct, 'cursor-data'), xdgConfig: join(acct, 'xdg-config'), xdgCache: join(acct, 'xdg-cache'), xdgData: join(acct, 'xdg-data') };
      ctx.red.path(acct, '<LOGIN_ACCOUNT>');
      const auth = JSON.parse(readFileSync(authFile, 'utf8'));
      ctx.red.secret(auth.accessToken, 'LOGIN_ACCESS_TOKEN').secret(auth.refreshToken, 'LOGIN_REFRESH_TOKEN');
      ctx.check('a browser login stores accessToken and refreshToken, no apiKey', JSON.stringify(Object.keys(auth).sort()) === '["accessToken","refreshToken"]', Object.keys(auth));
      const claims = tok => { const c = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()); return { lifetimeDays: c.exp && c.iat ? Math.round((c.exp - c.iat) / 8640) / 10 : null, expiresAt: c.exp ? new Date(c.exp * 1000).toISOString() : null, claimKeys: Object.keys(c).sort() }; };
      ctx.note('login token claims (no values)', { access: claims(auth.accessToken), refresh: claims(auth.refreshToken) });
      const loginEnv = cursorEnv(slot, { store: 'file' });
      for (const args of [['status', '--format', 'json'], ['about', '--format', 'json'], ['team', 'list', '--format', 'json'], ['models']]) {
        const r = ctx.cli(slot, args, { env: loginEnv, cwd: ctx.dir });
        ctx.note(`login: agent ${args.join(' ')}`, { exit: r.exit, stdout: args[0] === 'models' ? r.stdout.split('\n').length + ' lines' : scrubIdentity(r.stdout), stderr: r.stderr.trim().slice(0, 300) });
        if (args[0] === 'status') ctx.check('status/whoami reports the login as authenticated', JSON.parse(r.stdout || '{}').isAuthenticated === true);
      }
      const usage = await readUsage(auth.accessToken, ctx.key);
      ctx.note('usage with the login token', { GetCurrentPeriodUsage: usage.GetCurrentPeriodUsage, GetPlanInfo: usage.GetPlanInfo });
      const crash = ctx.shared.continuedStore ?? latestStore('crash-continue', 'c');
      if (!ctx.check('a session created with the API key is available (crash-continue, this run or the latest earlier one)', !!crash)) return;
      ctx.note('API-key session used', { fromThisRun: !!ctx.shared.continuedStore, runId: crash.runId });
      ctx.red.path(crash.work, '<SESSION_WORK>');
      cpSync(crash.dir, join(slot.config, 'acp-sessions', crash.sid), { recursive: true });
      const p = ctx.acp({ slot, cwd: crash.work, env: loginEnv, label: 'login', onRequest: recordingPolicy([], () => 'allow-once') });
      await ctx.initialize(p);
      const ld = await ctx.loadSession(p, crash.sid, crash.work);
      ctx.check('an API-key session loads under the browser-login credential', !!ld.result, ld.error);
      if (ld.result) {
        const t = await ctx.promptAndWait(p, crash.sid, 'What was the exact shell command you ran in the first turn of this conversation? Reply with it in backticks only.', 'continue an API-key session under the login credential');
        const answer = textOf(t.updates, 'agent_message_chunk');
        ctx.note('continued under login', { stopReason: t.response.result?.stopReason, answer: answer.slice(-200) });
        ctx.check('the conversation continues under the login credential with its context', /sleep 31/.test(answer));
      }
      ctx.fixture(p, 'login');
      await p.dispose();
      const lo = ctx.cli(slot, ['logout'], { env: loginEnv, cwd: ctx.dir });
      ctx.note('logout', { exit: lo.exit, stdout: lo.stdout.trim(), stderr: lo.stderr.trim() });
      ctx.check('`agent logout` removes the stored login', lo.exit === 0 && !existsSync(authFile));
    },
  },
];

// The newest session store a scenario left in one of its slots, with that scenario's workspace.
function latestStore(scenario, slotName) {
  const runs = join(P0_ROOT, 'runs');
  if (!existsSync(runs)) return null;
  for (const runId of readdirSync(runs).sort().reverse()) {
    const base = join(runs, runId, scenario);
    const sessions = join(base, 'slots', slotName, 'cursor-config', 'acp-sessions');
    if (!existsSync(sessions)) continue;
    for (const sid of readdirSync(sessions)) {
      if (!existsSync(join(sessions, sid, 'store.db'))) continue;
      const work = scenario === 'crash-continue' ? join(runs, runId, 'crash-recover-and-move', 'work') : join(base, 'work');
      return { sid, dir: join(sessions, sid), work: existsSync(work) ? work : join(base, 'work'), runId };
    }
  }
  return null;
}

function countKinds(updates) {
  const c = {};
  for (const u of updates) c[u.sessionUpdate] = (c[u.sessionUpdate] ?? 0) + 1;
  return c;
}

// Identity in CLI output (email, names, ids) is reduced to the field names.
function scrubIdentity(text) {
  try {
    const j = JSON.parse(text);
    const walk = v => Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /email|name|id$|Id$|userId|authId/i.test(k) && typeof x !== 'object' ? '<redacted>' : walk(x)])) : v;
    return walk(j);
  } catch {
    return text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<EMAIL>').slice(0, 600);
  }
}
