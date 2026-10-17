#!/usr/bin/env node
// Harness self-test only: a crude stand-in for `agent acp` that lets `reproduce.mjs --selftest`
// exercise the scenario control flow (cancel timing, a prompt sent mid-turn, crash and load,
// question fallbacks) without spending real prompts. It imitates the shapes recorded from the
// real CLI loosely and decides what to do from the prompt text. Nothing it produces is evidence.
import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('selftest-fake'); process.exit(0); }
const force = args.includes('--force');
const configDir = process.env.CURSOR_CONFIG_DIR ?? join(process.env.HOME ?? '/tmp', '.cursor');
const sessions = new Map();
let nextId = 1000;
const pending = new Map();
const send = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });
const request = (method, params) => new Promise(resolve => { const id = nextId++; pending.set(id, resolve); send({ id, method, params }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const configOptions = s => [
  { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: s.mode, options: ['agent', 'plan', 'ask'].map(v => ({ value: v, name: v })) },
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'default[]', options: [{ value: 'default[]', name: 'Auto' }] },
];
const store = s => { mkdirSync(join(configDir, 'acp-sessions', s.id), { recursive: true }); writeFileSync(join(configDir, 'acp-sessions', s.id, 'fake.json'), JSON.stringify({ cwd: s.cwd, prompts: s.prompts, mcp: s.mcp })); };

async function permission(s, toolCall) {
  const r = await request('session/request_permission', { sessionId: s.id, toolCall, options: [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' }, { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }] });
  return r.result?.outcome?.optionId ?? 'cancelled';
}

async function tool(s, turn, { title, kind, rawInput, ask, run }) {
  const id = `call-${randomUUID()}-${turn.step++}\nfc_${randomUUID()}_0`;
  update(s.id, { sessionUpdate: 'tool_call', toolCallId: id, title, kind, status: 'pending', rawInput });
  update(s.id, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'in_progress' });
  let choice = 'allow-once';
  if (ask && !force) choice = await permission(s, { toolCallId: kind === 'fetch' ? `web_fetch_${turn.step}` : id, title: ask, kind, status: 'pending' });
  if (turn.cancelled) return;
  if (choice === 'allow-always') s.always.add(title.split(' ')[0]);
  if (choice.startsWith('reject') || choice === 'cancelled') return update(s.id, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', rawOutput: { rejected: true } });
  const out = await run();
  if (!turn.cancelled) update(s.id, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', rawOutput: out ?? { success: true } });
}

async function hold(turn, seconds) {
  for (let i = 0; i < seconds * 10 && !turn.cancelled; i++) await sleep(100);
}

async function runTurn(s, text, turn) {
  if (s.prompts.length === 1) update(s.id, { sessionUpdate: 'session_info_update', title: 'Fake probe' });
  for (const t of ['Thinking ', 'about it.']) update(s.id, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: t } });
  const readOnly = s.mode !== 'agent';
  let reply = 'Done.';
  if (/Read the file README\.md/.test(text)) await tool(s, turn, { title: 'Read README.md', kind: 'read', rawInput: { path: join(s.cwd, 'README.md') }, run: async () => ({ content: existsSync(join(s.cwd, 'README.md')) ? readFileSync(join(s.cwd, 'README.md'), 'utf8') : '' }) });
  for (const m of text.matchAll(/Create the file (\S+) containing/gi)) if (!readOnly) await tool(s, turn, { title: `Edit \`${join(s.cwd, m[1])}\``, kind: 'edit', rawInput: { path: join(s.cwd, m[1]) }, run: async () => writeFileSync(join(s.cwd, m[1]), 'written\n') });
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    const cmd = m[1];
    if (readOnly || turn.cancelled || !/^(ls|echo|env|touch|sleep|git)/.test(cmd)) continue;
    const needs = !/^ls/.test(cmd) && !s.always.has(cmd.split(' ')[0]) && !/^touch/.test(cmd);
    await tool(s, turn, { title: `\`${cmd}\``, kind: 'execute', rawInput: { command: cmd }, ask: needs ? `\`${cmd}\`` : null, run: async () => {
      const sl = cmd.match(/sleep (\d+)/);
      if (sl) await hold(turn, Number(sl[1]));
      if (turn.cancelled) return;
      const f = cmd.match(/(?:>|touch)\s+(\S+)$/);
      if (f) writeFileSync(join(s.cwd, f[1]), /env/.test(cmd) ? Object.entries(process.env).map(([k, v]) => `${k}=${v}`).sort().join('\n') + '\n' : 'x\n');
      return { exitCode: 0, stdout: '', stderr: '' };
    } });
  }
  const marker = text.match(/record` of the p0probe server with marker "([^"]+)"/);
  if (marker && !readOnly) await tool(s, turn, { title: 'p0probe: record', kind: 'other', rawInput: { providerIdentifier: 'p0probe', toolName: 'record', args: { marker: marker[1] } }, ask: 'p0probe-record: record', run: async () => {
    const eff = s.mcp.find(x => x.name === 'p0probe')?.env?.find(e => e.name === 'P0_MCP_EFFECTS')?.value;
    if (eff) appendFileSync(eff, JSON.stringify({ server: 'p0probe', marker: marker[1] }) + '\n');
  } });
  if (/task_get/.test(text)) await tool(s, turn, { title: 'orbit: task_get', kind: 'other', rawInput: {}, ask: 'orbit-task_get: task_get' , run: async () => {} });
  if (/Fetch https/.test(text) && !readOnly) await tool(s, turn, { title: 'Web Fetch: https://example.com/', kind: 'fetch', rawInput: { url: 'https://example.com/' }, ask: 'Fetch https://example.com/', run: async () => {} });
  if (/ask-question tool/.test(text)) {
    const answers = [];
    for (const [qid, prompt, opts] of [['fruit', 'Pick a fruit', ['apple', 'banana']], ['color', 'Pick a color', ['red', 'blue']]]) {
      const r = await request('cursor/ask_question', { toolCallId: `ask-${qid}`, title: prompt, questions: [{ id: qid, prompt, options: opts.map(o => ({ id: o, label: o })), allowMultiple: false }] });
      if (r.result?.outcome?.outcome === 'answered') answers.push(r.result.outcome.answers[0].selectedOptionIds[0]);
      else {
        const p = await request('session/request_permission', { sessionId: s.id, toolCall: { toolCallId: `ask-${qid}_q0`, title: prompt, kind: 'other', status: 'pending' },
          options: [...opts.map(o => ({ optionId: o, name: o, kind: 'allow_once' })), { optionId: '__ask_question_skip__', name: 'Skip', kind: 'reject_once' }] });
        answers.push(p.result?.outcome?.optionId);
      }
    }
    reply = `fruit=${answers[0]}, color=${answers[1]}`;
  }
  if (/TodoWrite/.test(text)) request('cursor/update_todos', { toolCallId: 'todo-1', todos: [{ id: '1', content: 'read README', status: 'completed' }, { id: '2', content: 'report first line', status: 'completed' }], merge: false });
  if (/Task tool/.test(text)) {
    const agentId = randomUUID();
    update(s.id, { sessionUpdate: 'subagent_spawned', _meta: { cursor: { toolCallId: 'task-1', agentId } } });
    update(agentId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '# probe repo' } });
    update(s.id, { sessionUpdate: 'subagent_state_update', state: 'completed', _meta: { cursor: { toolCallId: 'task-1', agentId } } });
    request('cursor/task', { toolCallId: 'task-1', description: 'read README', prompt: 'read', agentId });
    reply = '# probe repo';
  }
  if (/BANANA/.test(text)) reply = 'BANANA';
  if (/secret word you read/.test(text)) reply = 'TANGERINE; steps ok';
  if (/previous turn|first turn/.test(text)) reply = 'You ran `' + (s.prompts.map(p => p.match(/`(sleep[^`]+)`/)?.[1]).find(Boolean) ?? 'nothing') + '`';
  if (/codeword/.test(text)) reply = 'none';
  if (/story/.test(text)) { for (let i = 0; i < 40 && !turn.cancelled; i++) { update(s.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'word ' } }); await sleep(150); } }
  if (turn.cancelled) return;
  for (const piece of reply.match(/.{1,6}/g) ?? []) update(s.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: piece } });
}

createInterface({ input: process.stdin }).on('line', async line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && msg.method === undefined) { const r = pending.get(msg.id); if (r) { pending.delete(msg.id); r(msg); } return; }
  const { id, method, params = {} } = msg;
  const reply = result => send({ id, result });
  const fail = (code, message) => send({ id, error: { code, message, data: { message } } });
  switch (method) {
    case 'initialize': return reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: true }, promptCapabilities: { audio: false, embeddedContext: false, image: true }, sessionCapabilities: { list: {}, ...(params.clientCapabilities?._meta?.subagents ? { subagents: {} } : {}) } }, authMethods: [{ id: 'cursor_login', name: 'Cursor Login' }] });
    case 'session/new': {
      if (!isAbsolute(params.cwd ?? '')) return fail(-32602, 'cwd');
      const s = { id: randomUUID(), cwd: params.cwd, mode: 'agent', prompts: [], mcp: params.mcpServers ?? [], always: new Set(), turn: null };
      sessions.set(s.id, s); store(s);
      return reply({ sessionId: s.id, modes: { currentModeId: 'agent', availableModes: [] }, models: { currentModelId: 'default[]', availableModels: [] }, configOptions: configOptions(s) });
    }
    case 'session/load': {
      const f = join(configDir, 'acp-sessions', params.sessionId ?? '', 'fake.json');
      if (!existsSync(f)) return fail(-32602, `Session "${params.sessionId}" not found`);
      const saved = JSON.parse(readFileSync(f, 'utf8'));
      const s = { id: params.sessionId, cwd: params.cwd, mode: 'agent', prompts: saved.prompts, mcp: params.mcpServers ?? [], always: new Set(), turn: null };
      sessions.set(s.id, s);
      saved.prompts.forEach((p, i) => { update(s.id, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: p } }); update(s.id, { sessionUpdate: 'tool_call', toolCallId: `replay-${i}-1`, title: 'x', kind: 'execute', status: 'pending' }); });
      return reply({ modes: {}, models: {}, configOptions: configOptions(s) });
    }
    case 'session/list': return reply({ sessions: [...sessions.values()].map(s => ({ sessionId: s.id, cwd: s.cwd, title: 'Fake probe' })) });
    case 'session/set_mode': { const s = sessions.get(params.sessionId); s.mode = params.modeId; update(s.id, { sessionUpdate: 'current_mode_update', currentModeId: s.mode }); return reply({}); }
    case 'session/set_config_option': { const s = sessions.get(params.sessionId); if (params.configId === 'mode') s.mode = params.value; return reply({ configOptions: configOptions(s) }); }
    case 'session/prompt': {
      const s = sessions.get(params.sessionId);
      if (!s) return fail(-32603, 'Session not found');
      if (s.turn) { s.turn.cancelled = true; s.turn.resolve('cancelled'); }
      const text = params.prompt.map(p => p.text).join('');
      s.prompts.push(text); store(s);
      const turn = { cancelled: false, step: 0 };
      s.turn = turn;
      const done = new Promise(r => { turn.resolve = r; });
      runTurn(s, text, turn).then(() => turn.resolve('end_turn'));
      const stopReason = await done;
      if (s.turn === turn) s.turn = null;
      return reply({ stopReason });
    }
    case 'session/cancel': { const s = sessions.get(params.sessionId); if (s?.turn) { s.turn.cancelled = true; s.turn.resolve('cancelled'); } return; }
    default: if (id !== undefined) return send({ id, error: { code: -32601, message: `"Method not found": ${method}` } });
  }
});
process.on('SIGTERM', () => process.exit(143));
process.on('SIGINT', () => process.exit(130));
