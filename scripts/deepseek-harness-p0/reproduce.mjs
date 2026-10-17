// Fixed-version black-box ACP experiments. No node --test, SDK shim, or real API key.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync, readdirSync, lstatSync, unlinkSync, watch } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
assert.equal(process.platform, 'linux', 'P0 executable evidence covers Linux; other platforms remain unverified');
const binary = resolve(process.env.P0_DSH_BIN ?? join(here, 'node_modules/.bin/dsh'));
const output = resolve(process.argv[2] ?? '/tmp/orbit-dsh-p0-evidence');
const startedAt = new Date().toISOString();
mkdirSync(output, { recursive: true });
const root = mkdtempSync('/tmp/orbit-dsh-p0-run-');
const work = join(root, 'workspace');
mkdirSync(work);
writeFileSync(join(work, 'AGENTS.md'), 'P0_WORKSPACE_INSTRUCTION: keep all effects synthetic.\n');
const transcript = join(output, 'protocol.ndjson');
writeFileSync(transcript, '');
const results = [];
let scenario = 'boot';
let sequence = 0;
let nonProtocolLines = 0;
const replacements = new Map([[root, '<TEMP>'], [root.split('/').at(-1), '<TEMP_NAME>'],
  [dirname(dirname(binary)), '<INSTALL>'], [process.execPath, '<NODE>'], [here, '<SCRIPTS>']]);
const ids = new Map();
const clean = value => {
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const [from, to] of replacements) text = text.replaceAll(from, to);
  text = text.replace(/sk-p0-([a-z-]+)/g, '<SYNTHETIC_KEY:$1>');
  text = text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, id => {
    if (!ids.has(id)) ids.set(id, '<UUID_' + (ids.size + 1) + '>');
    return ids.get(id);
  });
  return typeof value === 'string' ? text : JSON.parse(text);
};
const record = (channel, value) => {
  if (channel === 'stdout/non-protocol') nonProtocolLines++;
  appendFileSync(transcript, JSON.stringify({ seq: ++sequence, scenario, channel, value: clean(value) }) + '\n');
};
const environment = home => ({
  PATH: process.env.PATH, HOME: process.env.HOME,
  DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', NO_PROXY: '127.0.0.1,localhost',
  DEEPSEEK_API_KEY: 'sk-p0-inherited',
});
const fingerprint = dir => {
  if (!existsSync(dir)) return null;
  const hash = createHash('sha256');
  const visit = path => {
    for (const name of readdirSync(path).sort()) {
      const p = join(path, name), stat = lstatSync(p);
      hash.update(p.slice(dir.length));
      hash.update(String(stat.mode));
      if (stat.isDirectory()) visit(p);
      else if (stat.isFile()) hash.update(readFileSync(p));
    }
  };
  visit(dir);
  return hash.digest('hex');
};
const realHomeBefore = fingerprint(join(process.env.HOME, '.dsh'));
const version = spawnSync(binary, ['--version'], { env: environment(join(root, 'version-home')), encoding: 'utf8' });
assert.equal(version.error, undefined, 'dsh --version must actually execute');
assert.equal(version.status, 0);
assert.equal(version.stdout.trim(), '0.2.0-rc.2', 'must use the fixed real dsh release');
const lock = JSON.parse(readFileSync(join(here, 'package-lock.json')));
const build = { version: version.stdout.trim(), node: process.version, platform: process.platform, arch: process.arch,
  cliSha256: createHash('sha256').update(readFileSync(binary)).digest('hex'),
  lockSha256: createHash('sha256').update(readFileSync(join(here, 'package-lock.json'))).digest('hex'),
  npmIntegrity: lock.packages['node_modules/@deepseek-ai/dsh'].integrity };
record('version', build);

// The real official API-key adapter uses Anthropic-compatible Messages SSE, not chat/completions.
const requests = [];
let waitingModel;
let activeResponse;
let plan = { kind: 'text', text: 'hello', thought: 'synthetic thought' };
let nextPlans = [];
const model = createServer((req, res) => {
  let raw = '';
  req.on('data', data => { raw += data; });
  req.on('end', () => {
    const body = JSON.parse(raw);
    const item = { url: req.url, apiKey: req.headers['x-api-key'], body };
    requests.push(item);
    record('model/request', item);
    if (plan.kind === 'error') {
      res.writeHead(plan.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: plan.type, message: 'synthetic-' + plan.status } }));
      return;
    }
    if (plan.kind === 'hold') {
      activeResponse = { res, body };
      waitingModel?.();
      return;
    }
    const next = plan;
    if (next.kind === 'tool') plan = nextPlans.shift() ?? { kind: 'text', text: 'after-tool' };
    finishModel(res, body, next);
  });
});
function finishModel(res, body, next) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const events = [{ type: 'message_start', message: { id: 'msg_p0', type: 'message', role: 'assistant', model: body.model,
      content: [], usage: { input_tokens: 32, output_tokens: 0 } } }];
    let index = 0;
    if (next.thought) {
      events.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: next.thought } },
        { type: 'content_block_stop', index });
      index++;
    }
    if (next.kind === 'tool') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: 'call_p0_' + requests.length, name: next.name, input: {} } },
        { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(next.args) } },
        { type: 'content_block_stop', index });
    } else {
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      for (const text of next.fragments ?? [next.text ?? 'hello'])
        events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
      events.push({ type: 'content_block_stop', index });
    }
    events.push({ type: 'message_delta', delta: { stop_reason: next.stop ?? (next.kind === 'tool' ? 'tool_use' : 'end_turn') }, usage: { output_tokens: 8 } },
      { type: 'message_stop' });
    for (const event of events) { record('model/sse', event); res.write('data: ' + JSON.stringify(event) + '\n\n'); }
    res.end();
}
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:' + model.address().port;
replacements.set(url, 'http://127.0.0.1:<MODEL_PORT>');

function createHome(name) {
  const home = join(root, name);
  mkdirSync(home);
  const overlay = join(home, 'orbit.patch.yml');
  writeFileSync(overlay, JSON.stringify([
    { id: 'llm-deepseek', config: { baseURL: url, retryPolicy: { mode: 'normal', maxRetries: 0 }, streamIdleTimeoutMs: 5000 } },
    { id: 'system-prompt', config: { personaPrefix: 'You are a coding agent powered by the {{model}} model.',
      personaSuffix: 'Your working directory is {{cwd}}.\nP0_ORBIT_APPEND: synthetic Orbit instruction.' } },
  ]));
  return { home, overlay };
}
function persistedFiles(home) {
  const files = [];
  const visit = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else files.push({ path: path.slice(home.length + 1), bytes: lstatSync(path).size, mode: lstatSync(path).mode & 0o777 });
    }
  };
  visit(home);
  return files;
}

class Acp {
  constructor(config, extraEnv = {}) {
    this.updates = [];
    this.pending = new Map();
    this.nextId = 1;
    this.permission = 'allow-once';
    this.child = spawn(binary, ['--profile', 'acp', '--patch', config.overlay], {
      cwd: work, env: { ...environment(config.home), ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    record('process/spawn', { argv: [binary, '--profile', 'acp', '--patch', config.overlay], home: config.home, cwd: work,
      realHomePreserved: true, inheritedEnvironment: ['PATH', 'HOME'], telemetryDisabled: true });
    // close also settles failed spawns and waits for the protocol pipes to drain.
    this.exit = new Promise(resolve => this.child.once('close', (code, signal) => {
      record('process/exit', { code, signal });
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error('process exited: ' + code + '/' + signal)); }
      this.pending.clear();
      resolve({ code, signal });
    }));
    this.child.on('error', error => {
      record('process/error', String(error));
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
      this.pending.clear();
    });
    this.child.stderr.on('data', data => record('stderr', data.toString()));
    createInterface({ input: this.child.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { record('stdout/non-protocol', line); this.protocolError = true; return; }
      if (message?.jsonrpc !== '2.0') { record('stdout/non-protocol', line); this.protocolError = true; return; }
      record('acp/out', message);
      if (message.method === 'session/update') this.updates.push(message.params);
      else if (message.method === 'session/request_permission') {
        this.lastPermission = message;
        this.permissionArrived?.(message);
        if (this.permission !== 'hold') this.send({ jsonrpc: '2.0', id: message.id,
          result: { outcome: this.permission === 'cancelled' ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: this.permission } } });
      } else if (message.id !== undefined) {
        const slot = this.pending.get(message.id);
        if (!slot) return;
        clearTimeout(slot.timer);
        this.pending.delete(message.id);
        slot.resolve(message);
      }
    });
  }
  send(message) { record('acp/in', message); this.child.stdin.write(JSON.stringify(message) + '\n'); }
  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('timeout: ' + method)); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  notify(method, params) { this.send({ jsonrpc: '2.0', method, params }); }
  async initialize() {
    const result = await this.call('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'orbit-p0', version: '1' } });
    assert.equal(result.result?.protocolVersion, 1, JSON.stringify(result));
    return result.result;
  }
  async newSession(mcpServers = []) {
    const reply = await this.call('session/new', { cwd: work, mcpServers });
    assert.ok(reply.result?.sessionId, JSON.stringify(reply));
    return reply.result;
  }
  prompt(id, text) { return this.call('session/prompt', { sessionId: id, prompt: [{ type: 'text', text }] }); }
  async shutdown() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return this.exit;
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 10000);
    const exit = await this.exit;
    clearTimeout(timer);
    assert.equal(this.protocolError, undefined, 'stdout must be pure JSON-RPC');
    return exit;
  }
}

let acp;
const peers = new Set();
const modelArrived = () => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('mock model did not receive a request')), 10000);
  waitingModel = () => { clearTimeout(timer); waitingModel = undefined; resolve(); };
});
const permissionArrived = peer => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('ACP permission request missing')), 10000);
  peer.permissionArrived = message => { clearTimeout(timer); peer.permissionArrived = undefined; resolve(message); };
});
async function check(name, run) {
  scenario = name;
  const begin = sequence + 1;
  try {
    const detail = await run();
    record('check/result', { name, passed: true, detail: detail ?? {} });
    results.push({ name, passed: true, seq: [begin, sequence], detail: clean(detail ?? {}) });
    console.log('PASS ' + name);
  } catch (error) {
    results.push({ name, passed: false, seq: [begin, sequence], error: clean(String(error)) });
    console.error('FAIL ' + name + ': ' + clean(String(error)));
    throw error;
  }
}

try {
  const config = createHome('primary-home');
  let session;
  await check('initialize-new-text-thought', async () => {
    acp = new Acp(config);
    const init = await acp.initialize();
    session = await acp.newSession();
    const reply = await acp.prompt(session.sessionId, 'P0 first turn');
    assert.equal(reply.result?.stopReason, 'end_turn', JSON.stringify(reply));
    assert.ok(acp.updates.some(x => x.update.sessionUpdate === 'agent_message_chunk'));
    assert.ok(acp.updates.some(x => x.update.sessionUpdate === 'agent_thought_chunk'));
    assert.ok(JSON.stringify(requests.at(-1).body).includes('P0_ORBIT_APPEND'));
    assert.ok(JSON.stringify(requests.at(-1).body).includes('P0_WORKSPACE_INSTRUCTION'));
    return { init, configOptions: session.configOptions, toolNames: requests.at(-1).body.tools.map(x => x.name) };
  });
  await check('second-turn', async () => {
    plan = { kind: 'text', text: 'second-turn' };
    const reply = await acp.prompt(session.sessionId, 'P0 second turn');
    assert.equal(reply.result?.stopReason, 'end_turn');
    assert.ok(JSON.stringify(requests.at(-1).body).includes('P0 first turn'));
  });
  await check('model-and-reasoning-options', async () => {
    const choices = session.configOptions.find(x => x.id === 'model').options.flatMap(x => x.options);
    const chosen = choices.find(x => x.name === 'DeepSeek-V4-Pro');
    const selected = await acp.call('session/set_config_option', { sessionId: session.sessionId, configId: 'model', value: chosen.value });
    assert.equal(selected.result.configOptions.find(x => x.id === 'model').currentValue, chosen.value);
    const wire = [];
    for (const value of ['off', 'low', 'high', 'max']) {
      const changed = await acp.call('session/set_config_option', { sessionId: session.sessionId, configId: 'reasoning_effort', value });
      assert.equal(changed.result.configOptions.find(x => x.id === 'reasoning_effort').currentValue, value);
      plan = { kind: 'text', text: 'effort-' + value };
      assert.equal((await acp.prompt(session.sessionId, 'effort-' + value)).result.stopReason, 'end_turn');
      const body = requests.at(-1).body;
      assert.equal(body.model, 'deepseek-v4-pro');
      if (value === 'off') assert.equal(body.thinking.type, 'disabled');
      else assert.equal(body.output_config.effort, value);
      wire.push({ value, thinking: body.thinking, output_config: body.output_config });
    }
    const bad = await acp.call('session/set_config_option', { sessionId: session.sessionId, configId: 'reasoning_effort', value: 'medium' });
    assert.equal(bad.error.code, -32602);
    return { wire, invalidValue: bad.error };
  });
  await check('native-write-read-and-tool-failure', async () => {
    const file = join(work, 'written.txt');
    plan = { kind: 'tool', name: 'write', args: { file_path: file, content: 'native-side-effect' } };
    let start = acp.updates.length;
    assert.equal((await acp.prompt(session.sessionId, 'write synthetic file')).result.stopReason, 'end_turn');
    assert.equal(readFileSync(file, 'utf8'), 'native-side-effect');
    const updates = acp.updates.slice(start).map(x => x.update);
    const call = updates.find(x => x.sessionUpdate === 'tool_call');
    assert.equal(call.title, 'write');
    assert.equal(call.rawInput.file_path, file);
    assert.ok(updates.some(x => x.sessionUpdate === 'tool_call_update' && x.toolCallId === call.toolCallId && x.status === 'completed'));
    plan = { kind: 'tool', name: 'read', args: { file_path: join(work, 'missing.txt') } };
    start = acp.updates.length;
    assert.equal((await acp.prompt(session.sessionId, 'read missing file')).result.stopReason, 'end_turn');
    assert.ok(acp.updates.slice(start).some(x => x.update.status === 'failed'));
    return { writeEffect: true, ordinaryToolFailureDoesNotFailPrompt: true };
  });
  await check('linux-bash-sandbox', async () => {
    plan = { kind: 'tool', name: 'bash', args: { command: 'printf p0-shell-ok', description: 'Check the synthetic sandbox shell' } };
    const start = acp.updates.length;
    const reply = await acp.prompt(session.sessionId, 'run synthetic shell');
    assert.equal(reply.result.stopReason, 'end_turn');
    const tool = acp.updates.slice(start).find(x => x.update.sessionUpdate === 'tool_call_update');
    assert.equal(tool.update.status, 'completed', JSON.stringify(tool));
    assert.ok(JSON.stringify(tool).includes('p0-shell-ok'), JSON.stringify(tool));
    return tool.update;
  });
  await check('mcp-stdio-injection', async () => {
    const mcpLog = join(root, 'mcp.ndjson');
    const mcp = await acp.newSession([{ name: 'orbit', command: process.execPath,
      args: [join(here, 'mock-mcp.mjs')], env: [
        { name: 'P0_MCP_LOG', value: mcpLog }, { name: 'ORBIT_SESSION_ID', value: 'p0-orbit-session' },
      ] }]);
    plan = { kind: 'tool', name: 'mcp__orbit__record', args: { value: 'mcp-side-effect' } };
    const permissions = acp.lastPermission;
    assert.equal((await acp.prompt(mcp.sessionId, 'call synthetic Orbit MCP')).result.stopReason, 'end_turn');
    const facts = readFileSync(mcpLog, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(facts.some(x => x.effect === 'mcp-side-effect' && x.session === 'p0-orbit-session'));
    assert.equal(acp.lastPermission, permissions, 'stock MCP annotation does not impose an approval gate');
    for (const fact of facts) record('mcp/stdio', fact);
    assert.ok((await acp.call('session/close', { sessionId: mcp.sessionId })).result);
    return { sideEffect: true, automaticApproval: false };
  });
  await check('cancel-concurrent-prompt-and-selection-snapshot', async () => {
    plan = { kind: 'hold' };
    const arrived = modelArrived();
    const pending = acp.prompt(session.sessionId, 'held model call');
    await arrived;
    const busy = await acp.prompt(session.sessionId, 'must not be queued by dsh');
    assert.ok(busy.error);
    const changed = await acp.call('session/set_config_option', { sessionId: session.sessionId, configId: 'reasoning_effort', value: 'low' });
    assert.ok(changed.result);
    assert.equal(requests.at(-1).body.output_config.effort, 'max');
    acp.notify('session/cancel', { sessionId: session.sessionId });
    const reply = await pending;
    assert.equal(reply.result.stopReason, 'cancelled');
    activeResponse.res.destroy();
    plan = { kind: 'text', text: 'after-cancel' };
    assert.equal((await acp.prompt(session.sessionId, 'next turn after cancellation')).result.stopReason, 'end_turn');
    assert.equal(requests.at(-1).body.output_config.effort, 'low');
    return { busyError: busy.error, stopReason: reply.result.stopReason };
  });
  await check('max-tokens-is-not-success', async () => {
    plan = { kind: 'text', text: 'truncated', stop: 'max_tokens' };
    const reply = await acp.prompt(session.sessionId, 'token ceiling');
    assert.equal(reply.result.stopReason, 'max_tokens');
    return reply;
  });
  await check('http-errors-and-next-turn-recovery', async () => {
    const observed = [];
    for (const [status, type] of [[401, 'authentication_error'], [429, 'rate_limit_error'], [500, 'api_error']]) {
      plan = { kind: 'error', status, type };
      const reply = await acp.prompt(session.sessionId, 'error-' + status);
      assert.equal(reply.error?.code, -32603, JSON.stringify(reply));
      assert.ok(JSON.stringify(reply).includes('synthetic-' + status));
      observed.push({ status, reply });
      plan = { kind: 'text', text: 'recovered-' + status };
      assert.equal((await acp.prompt(session.sessionId, 'recover-' + status)).result.stopReason, 'end_turn');
    }
    return observed;
  });
  await check('unsupported-and-invalid-requests', async () => {
    const replies = [];
    for (const method of ['session/load', 'session/set_mode', 'session/set_model']) {
      const reply = await acp.call(method, { sessionId: session.sessionId });
      assert.equal(reply.error.code, -32601);
      replies.push({ method, reply });
    }
    const invalid = await acp.call('session/new', { cwd: 'relative', mcpServers: [] });
    assert.equal(invalid.error.code, -32602);
    const sse = await acp.call('session/new', { cwd: work, mcpServers: [{ type: 'sse', name: 'unsupported', url }] });
    assert.ok(sse.result?.sessionId, 'release SDK drops unsupported SSE declarations before handler validation');
    plan = { kind: 'text', text: 'unsupported MCP was not mounted' };
    assert.equal((await acp.prompt(sse.result.sessionId, 'inspect unsupported MCP')).result.stopReason, 'end_turn');
    assert.ok(!requests.at(-1).body.tools.some(x => x.name.startsWith('mcp__unsupported__')));
    await acp.call('session/close', { sessionId: sse.result.sessionId });
    const relative = await acp.call('session/new', { cwd: work, mcpServers: [{ name: 'relative', command: 'node', args: [], env: [] }] });
    assert.equal(relative.error.code, -32602);
    const broken = await acp.call('session/new', { cwd: work, mcpServers: [{ name: 'broken', command: '/bin/false', args: [], env: [] }] });
    assert.ok(broken.error);
    return { replies, invalid, sse, relative, broken };
  });
  for (const decision of ['allow-once', 'reject-once', 'cancel', 'disconnect']) {
    await check('permission-' + decision, async () => {
      const cfg = createHome('permission-' + decision);
      const peer = new Acp(cfg, { DSH_PERMISSION_MODE: 'read-only' });
      peers.add(peer);
      await peer.initialize();
      const s = await peer.newSession();
      peer.permission = ['cancel', 'disconnect'].includes(decision) ? 'hold' : decision;
      const file = join(work, 'permission-' + decision + '.txt');
      plan = { kind: 'tool', name: 'write', args: { file_path: file, content: 'approved-side-effect' } };
      nextPlans = [{ kind: 'tool', name: 'write', args: { file_path: file, content: 'approved-side-effect',
        sandbox_permissions: 'workspace-write', justification: 'Allow this synthetic workspace file.' } }];
      const arrived = permissionArrived(peer);
      const pending = peer.prompt(s.sessionId, 'try write, then request escalation after denial')
        .then(reply => ({ reply }), error => ({ transportError: String(error) }));
      const permission = await arrived;
      assert.deepEqual(Object.keys(permission.params.toolCall), ['toolCallId']);
      const call = peer.updates.find(x => x.update.toolCallId === permission.params.toolCall.toolCallId && x.update.sessionUpdate === 'tool_call');
      assert.equal(call.update.title, 'write');
      if (decision === 'cancel') peer.notify('session/cancel', { sessionId: s.sessionId });
      if (decision === 'disconnect') peer.child.stdin.end();
      const { reply, transportError } = await pending;
      if (decision === 'cancel') assert.equal(reply.result?.stopReason, 'cancelled');
      else if (decision !== 'disconnect') assert.equal(reply.result?.stopReason, 'end_turn');
      else assert.ok(transportError?.includes('process exited: 0'));
      assert.equal(existsSync(file), decision === 'allow-once');
      if (decision === 'allow-once') assert.equal(readFileSync(file, 'utf8'), 'approved-side-effect');
      const exit = await peer.shutdown();
      peers.delete(peer);
      assert.equal(exit.code, 0);
      return { decision, sideEffect: existsSync(file), permission: permission.params, reply, transportError, exit };
    });
  }
  await check('close-eof-resume', async () => {
    const closed = await acp.call('session/close', { sessionId: session.sessionId });
    assert.ok(closed.result);
    const exit = await acp.shutdown();
    assert.equal(exit.code, 0);
    acp = new Acp(config);
    await acp.initialize();
    const resumed = await acp.call('session/resume', { sessionId: session.sessionId, cwd: work, mcpServers: [] });
    assert.ok(resumed.result?.configOptions, JSON.stringify(resumed));
    assert.equal(acp.updates.filter(x => x.update.sessionUpdate === 'agent_message_chunk').length, 0);
    plan = { kind: 'text', text: 'after-resume' };
    const reply = await acp.prompt(session.sessionId, 'P0 resumed turn');
    assert.equal(reply.result?.stopReason, 'end_turn');
    assert.ok(JSON.stringify(requests.at(-1).body).includes('P0 first turn'));
    return { exit, runtimeSessionId: session.sessionId };
  });
  await check('list-resume-workspace-validation-and-close-during-prompt', async () => {
    const list = await acp.call('session/list', { cwd: work });
    assert.ok(!list.result.sessions.some(x => x.sessionId === session.sessionId), 'list omits currently active sessions');
    plan = { kind: 'hold' };
    const arrived = modelArrived();
    const pending = acp.prompt(session.sessionId, 'close active model request');
    await arrived;
    const closed = await acp.call('session/close', { sessionId: session.sessionId });
    assert.ok(closed.result);
    const reply = await pending;
    assert.equal(reply.result.stopReason, 'cancelled');
    activeResponse.res.destroy();
    const inactiveList = await acp.call('session/list', { cwd: work });
    assert.ok(inactiveList.result.sessions.some(x => x.sessionId === session.sessionId));
    const wrong = await acp.call('session/resume', { sessionId: session.sessionId, cwd: root, mcpServers: [] });
    assert.ok(wrong.error.message.includes('cwd does not match'));
    const unknown = await acp.prompt(session.sessionId, 'closed id must fail');
    assert.ok(unknown.error);
    acp.notify('session/cancel', { sessionId: 'unknown-id' });
    return { wrong, closed, reply, unknown };
  });
  await check('sigkill-while-mcp-in-flight-and-durable-recovery', async () => {
    const log = join(root, 'crash-mcp.ndjson');
    writeFileSync(log, '');
    const servers = [{ name: 'crash', command: process.execPath, args: [join(here, 'mock-mcp.mjs')],
      env: [{ name: 'P0_MCP_LOG', value: log }, { name: 'ORBIT_SESSION_ID', value: 'p0-crash-session' }] }];
    const s = await acp.newSession(servers);
    plan = { kind: 'text', text: 'committed-before-crash' };
    assert.equal((await acp.prompt(s.sessionId, 'committed before crash')).result.stopReason, 'end_turn');
    const effect = new Promise((resolve, reject) => {
      const watcher = watch(log, () => {
        if (readFileSync(log, 'utf8').includes('"effect":"hold"')) { clearTimeout(timer); watcher.close(); resolve(); }
      });
      const timer = setTimeout(() => { watcher.close(); reject(new Error('MCP side effect missing')); }, 10000);
    });
    plan = { kind: 'tool', name: 'mcp__crash__record', args: { value: 'hold' } };
    const pending = acp.prompt(s.sessionId, 'inflight MCP crash turn').then(reply => ({ reply }), error => ({ error: String(error) }));
    await effect;
    assert.ok(acp.updates.some(x => x.sessionId === s.sessionId && x.update.title === 'mcp__crash__record' && x.update.status === 'in_progress'));
    acp.child.kill('SIGKILL');
    const exit = await acp.exit;
    assert.equal(exit.signal, 'SIGKILL');
    assert.ok((await pending).error);
    acp = new Acp(config);
    await acp.initialize();
    const resumed = await acp.call('session/resume', { sessionId: s.sessionId, cwd: work, mcpServers: servers });
    assert.ok(resumed.result, JSON.stringify(resumed));
    plan = { kind: 'text', text: 'after-crash' };
    assert.equal((await acp.prompt(s.sessionId, 'new explicit turn after crash')).result.stopReason, 'end_turn');
    assert.ok(JSON.stringify(requests.at(-1).body).includes('committed before crash'));
    const facts = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(facts.filter(x => x.effect === 'hold').length, 1, 'driver must not replay an ambiguous inflight call');
    for (const fact of facts) record('mcp/crash', fact);
    return { exit, runtimeSessionId: s.sessionId, sideEffects: 1,
      crashTurnInModelHistory: JSON.stringify(requests.at(-1).body).includes('inflight MCP crash turn') };
  });
  await check('credential-precedence-and-missing-key', async () => {
    const observed = [];
    writeFileSync(join(work, '.env'), 'DEEPSEEK_API_KEY=sk-p0-project\n');
    for (const tier of ['inherited', 'store', 'project', 'home', 'missing']) {
      const cfg = createHome('credentials-' + tier);
      if (tier !== 'missing') writeFileSync(join(cfg.home, '.env'), 'DEEPSEEK_API_KEY=sk-p0-home\n');
      if (tier === 'inherited' || tier === 'store') writeFileSync(join(cfg.home, '.credentials.yaml'),
        'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-p0-store\n', { mode: 0o600 });
      if (tier === 'home') unlinkSync(join(work, '.env'));
      const peer = new Acp(cfg, { DEEPSEEK_API_KEY: tier === 'inherited' ? 'sk-p0-inherited' : undefined });
      peers.add(peer);
      const init = await peer.initialize();
      const s = await peer.newSession();
      assert.ok(s.configOptions.length);
      const before = requests.length;
      plan = { kind: 'text', text: 'credential-' + tier };
      const reply = await peer.prompt(s.sessionId, 'credential-' + tier);
      if (tier === 'missing') {
        assert.equal(reply.error.code, -32603);
        assert.ok(reply.error.message.includes('no API key'));
        assert.equal(requests.length, before);
      } else {
        assert.equal(reply.result.stopReason, 'end_turn');
        assert.equal(requests.at(-1).apiKey, 'sk-p0-' + tier);
      }
      observed.push({ tier, configuredHandshake: init.protocolVersion === 1, modelCatalogReturned: true, reply });
      assert.equal((await peer.shutdown()).code, 0);
      peers.delete(peer);
    }
    return observed;
  });
  await check('configuration-layer-priority', async () => {
    const cfg = createHome('config-layers');
    const warm = new Acp(cfg);
    await warm.initialize();
    await warm.shutdown();
    const profilePatch = join(cfg.home, 'profiles/acp/cordis.patch.yml');
    const homePatch = join(cfg.home, 'cordis.patch.yml');
    const promptPatch = value => [{ id: 'system-prompt', config: { personaSuffix: value } }];
    writeFileSync(profilePatch, JSON.stringify(promptPatch('PROFILE_LAYER_MARKER')));
    writeFileSync(homePatch, JSON.stringify(promptPatch('HOME_LAYER_MARKER')));
    const layers = [];
    for (const expected of ['P0_ORBIT_APPEND', 'HOME_LAYER_MARKER', 'PROFILE_LAYER_MARKER']) {
      if (expected === 'HOME_LAYER_MARKER') {
        const patches = JSON.parse(readFileSync(cfg.overlay, 'utf8')).filter(x => x.id !== 'system-prompt');
        writeFileSync(cfg.overlay, JSON.stringify(patches));
      }
      if (expected === 'PROFILE_LAYER_MARKER') unlinkSync(homePatch);
      const peer = new Acp(cfg, { DEEPSEEK_BASE_URL: 'http://127.0.0.1:1' });
      peers.add(peer);
      await peer.initialize();
      const s = await peer.newSession();
      plan = { kind: 'text', text: 'layer-' + expected };
      assert.equal((await peer.prompt(s.sessionId, 'check layered config')).result.stopReason, 'end_turn');
      const body = JSON.stringify(requests.at(-1).body);
      assert.ok(body.includes(expected));
      for (const other of ['P0_ORBIT_APPEND', 'HOME_LAYER_MARKER', 'PROFILE_LAYER_MARKER'])
        if (other !== expected) assert.ok(!body.includes(other), 'row config replacement must not merge suffixes');
      layers.push(expected);
      await peer.shutdown();
      peers.delete(peer);
    }
    return { layers, explicitBaseURLWinsEnvironment: true, configIsWholeRowReplacement: true };
  });
  await check('literal-additive-system-prompt', async () => {
    const cfg = createHome('literal-system-prompt');
    const text = 'P0_LITERAL_APPEND {{this_must_remain_literal}}';
    const patches = JSON.parse(readFileSync(cfg.overlay, 'utf8'));
    patches.push({ insert: [{ id: 'orbit-append', name: new URL('file://' + join(here, 'append-prompt.mjs')).href,
      config: { text } }] });
    writeFileSync(cfg.overlay, JSON.stringify(patches));
    const peer = new Acp(cfg);
    peers.add(peer);
    await peer.initialize();
    const s = await peer.newSession();
    plan = { kind: 'text', text: 'literal prompt received' };
    assert.equal((await peer.prompt(s.sessionId, 'check literal system append')).result.stopReason, 'end_turn');
    assert.ok(requests.at(-1).body.system.includes(text));
    assert.ok(requests.at(-1).body.system.includes('You are an AI agent powered by DeepSeek Harness.'));
    assert.ok(requests.at(-1).body.system.includes('Check the [exit code: N] marker'));
    await peer.shutdown();
    peers.delete(peer);
    return { literal: text, harnessIdentityPreserved: true, firstPartyGuidancePreserved: true };
  });
  await check('two-process-homes-and-credentials-isolation', async () => {
    const first = createHome('isolated-one'), second = createHome('isolated-two');
    const a = new Acp(first, { DEEPSEEK_API_KEY: 'sk-p0-one' });
    const b = new Acp(second, { DEEPSEEK_API_KEY: 'sk-p0-two' });
    peers.add(a); peers.add(b);
    await Promise.all([a.initialize(), b.initialize()]);
    const [sa, sb] = await Promise.all([a.newSession(), b.newSession()]);
    plan = { kind: 'text', text: 'parallel-homes' };
    assert.equal((await a.prompt(sa.sessionId, 'isolated first')).result.stopReason, 'end_turn');
    assert.equal(requests.at(-1).apiKey, 'sk-p0-one');
    assert.equal((await b.prompt(sb.sessionId, 'isolated second')).result.stopReason, 'end_turn');
    assert.equal(requests.at(-1).apiKey, 'sk-p0-two');
    assert.ok(!JSON.stringify(requests.at(-1).body).includes('isolated first'));
    assert.ok((await a.call('session/close', { sessionId: sa.sessionId })).result);
    const wrongHome = await b.call('session/resume', { sessionId: sa.sessionId, cwd: work, mcpServers: [] });
    assert.ok(wrongHome.error.message.includes('not resumable'));
    await a.shutdown(); await b.shutdown();
    peers.delete(a); peers.delete(b);
    return { separateRuntimeIds: sa.sessionId !== sb.sessionId, wrongHome, homes: [persistedFiles(first.home), persistedFiles(second.home)] };
  });
  await check('jsonrpc-cancel-request-and-sigterm', async () => {
    const s = await acp.newSession();
    plan = { kind: 'hold' };
    const arrived = modelArrived();
    const id = acp.nextId;
    const pending = acp.prompt(s.sessionId, 'cancel through JSON-RPC request id');
    await arrived;
    acp.notify('$/cancel_request', { requestId: id });
    const reply = await pending;
    assert.equal(reply.result.stopReason, 'cancelled');
    activeResponse.res.destroy();
    acp.child.kill('SIGTERM');
    const exit = await acp.exit;
    assert.equal(exit.code, 0);
    return { reply, exit };
  });
  await check('committed-message-blocks-and-context-usage', async () => {
    acp = new Acp(config);
    await acp.initialize();
    const s = await acp.newSession();
    plan = { kind: 'text', thought: 'synthetic thinking', fragments: ['alpha', '-beta', '-gamma'] };
    const start = acp.updates.length;
    assert.equal((await acp.prompt(s.sessionId, 'commit multi-delta output')).result.stopReason, 'end_turn');
    const updates = acp.updates.slice(start).map(x => x.update);
    const texts = updates.filter(x => x.sessionUpdate === 'agent_message_chunk');
    assert.equal(texts.length, 1);
    assert.equal(texts[0].content.text, 'alpha-beta-gamma');
    const usage = updates.find(x => x.sessionUpdate === 'usage_update');
    assert.ok(usage.used > 0);
    assert.equal(usage.size, 1000000);
    assert.ok(!Object.hasOwn(usage, 'cost'));
    return updates;
  });
  await check('linux-installation-and-sandbox-prerequisites', async () => {
    const module = await import(join(dirname(dirname(binary)), '@deepseek-ai/node-addon-system/lib/index.js'));
    const bwrap = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-pid', '--', 'true'],
      { encoding: 'utf8', timeout: 5000 });
    return { kernel: spawnSync('uname', ['-srm'], { encoding: 'utf8' }).stdout.trim(),
      bwrap: { error: bwrap.error?.code, status: bwrap.status, stderr: bwrap.stderr },
      landlock: { launcher: module.launcherPath(), enforcement: module.probe() },
      files: persistedFiles(config.home) };
  });
} finally {
  for (const peer of peers) { peer.child.stdin.end(); await peer.shutdown(); }
  if (acp) await acp.shutdown();
  model.closeAllConnections();
  await new Promise(resolve => model.close(resolve));
  const realHomeAfter = fingerprint(join(process.env.HOME, '.dsh'));
  const summary = { startedAt, ...build, sourceTag: 'dsh-v0.2.0-rc.2', sourceCommit: '639ed015397290b3745d163aafe02ffee4aa3f84',
    realHomeHarnessExisted: realHomeBefore !== null, realHomeHarnessUnchanged: realHomeBefore === realHomeAfter,
    stdoutProtocolClean: nonProtocolLines === 0, results };
  writeFileSync(join(output, 'summary.json'), JSON.stringify(clean(summary), null, 2) + '\n');
  writeFileSync(join(output, 'manifest.json'), JSON.stringify({ root: '<TEMP>', transcriptSha256:
    createHash('sha256').update(readFileSync(transcript)).digest('hex') }, null, 2) + '\n');
  assert.equal(summary.realHomeHarnessUnchanged, true);
  assert.equal(summary.stdoutProtocolClean, true, 'all processes, including killed/disconnected ones, must keep stdout pure JSON-RPC');
}
assert.equal(results.length, 24, 'all required experiments must run; no skips');
