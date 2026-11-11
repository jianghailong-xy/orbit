// Fake Anthropic endpoint: records every request, answers from a per-scenario script.
// Base URL: http://127.0.0.1:PORT/s/<scenario>   (the CLI appends /v1/messages?beta=true)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.PORT || 18555);
const OUT = process.env.OUT || path.resolve('rec');
const seq = {};
const state = {};

function sse(res, ev, data) {
  res.write(`event: ${ev}\ndata: ${JSON.stringify({ type: ev, ...data })}\n\n`);
}

function streamMessage(res, model, blocks, stopReason = 'end_turn', usage = { input_tokens: 100, output_tokens: 20 }) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_fake' });
  const id = 'msg_fake_' + Math.random().toString(36).slice(2, 10);
  sse(res, 'message_start', { message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input_tokens, output_tokens: 1 } } });
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      sse(res, 'content_block_start', { index, content_block: { type: 'text', text: '' } });
      sse(res, 'content_block_delta', { index, delta: { type: 'text_delta', text: b.text } });
    } else if (b.type === 'thinking') {
      sse(res, 'content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      sse(res, 'content_block_delta', { index, delta: { type: 'thinking_delta', thinking: b.thinking } });
      sse(res, 'content_block_delta', { index, delta: { type: 'signature_delta', signature: b.signature } });
    } else if (b.type === 'tool_use') {
      sse(res, 'content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      sse(res, 'content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    sse(res, 'content_block_stop', { index });
  });
  sse(res, 'message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
  sse(res, 'message_stop', {});
  res.end();
}

function jsonMessage(res, model, blocks, stopReason = 'end_turn') {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'msg_fake_ns', type: 'message', role: 'assistant', model, content: blocks, stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 } }));
}

function errorJson(res, status, type, message) {
  res.writeHead(status, { 'content-type': 'application/json', 'request-id': 'req_fake_err' });
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}

const toolNames = (b) => (b.tools || []).map((t) => t.name);
const lastUser = (b) => {
  const m = [...(b.messages || [])].reverse().find((x) => x.role === 'user');
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  return m.content.map((c) => (c.type === 'text' ? c.text : c.type === 'tool_result' ? '[tool_result ' + c.tool_use_id + ']' : '[' + c.type + ']')).join(' ');
};
const hasToolResult = (b, id) => (b.messages || []).some((m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'tool_result' && c.tool_use_id === id));
const sysText = (b) => (typeof b.system === 'string' ? b.system : (b.system || []).map((s) => s.text).join('\n'));
const isMain = (b) => toolNames(b).includes('Bash') && /interactive (CLI|agent)|Claude Code/i.test(sysText(b)) && !isSub(b);
const firstUser = (b) => JSON.stringify((b.messages || []).find((x) => x.role === 'user') || '');
const isSub = (b) => firstUser(b).includes('Reply with the word subagent-hi');
const isCompaction = (b) => /summar/i.test(lastUser(b)) && /conversation/i.test(lastUser(b)) && !(b.tools || []).length || /CRITICAL: Respond with TEXT ONLY|create a detailed summary of the conversation/i.test(lastUser(b));

// Scenario scripts: return [kind, ...] for main-loop requests; background requests get plain text.
const SIG = 'orbit1.' + Buffer.from(JSON.stringify({ id: 'rs_test123', encrypted_content: 'gAAAAB_fake_encrypted_blob' })).toString('base64url');
const scripts = {
  basic(b, st) { return { blocks: [{ type: 'text', text: 'Hello from the recorder.' }] }; },
  effort(b, st) { return { blocks: [{ type: 'text', text: 'ok' }] }; },
  thinking(b, st) {
    if (!hasToolResult(b, 'toolu_think1')) return { blocks: [{ type: 'thinking', thinking: 'I should run echo.', signature: SIG }, { type: 'tool_use', id: 'toolu_think1', name: 'Bash', input: { command: 'echo think-ok', description: 'Echo' } }], stop: 'tool_use' };
    return { blocks: [{ type: 'thinking', thinking: 'Done now.', signature: SIG + 'x' }, { type: 'text', text: 'echo said think-ok' }] };
  },
  parallel(b, st) {
    if (!hasToolResult(b, 'toolu_par1')) return { blocks: [{ type: 'text', text: 'Running two.' }, { type: 'tool_use', id: 'toolu_par1', name: 'Bash', input: { command: 'echo one', description: 'One' } }, { type: 'tool_use', id: 'toolu_par2', name: 'Bash', input: { command: 'exit 3', description: 'Two' } }], stop: 'tool_use' };
    return { blocks: [{ type: 'text', text: 'both done' }] };
  },
  image(b, st) {
    if (!hasToolResult(b, 'toolu_img1')) return { blocks: [{ type: 'tool_use', id: 'toolu_img1', name: 'Read', input: { file_path: path.join(process.env.WORK || path.resolve('work'), 'red.png') } }], stop: 'tool_use' };
    return { blocks: [{ type: 'text', text: 'I see a red square.' }] };
  },
  subagent(b, st) {
    const agentTool = toolNames(b).includes('Agent') ? 'Agent' : 'Task';
    if (!hasToolResult(b, 'toolu_sub1')) return { blocks: [{ type: 'tool_use', id: 'toolu_sub1', name: agentTool, input: { description: 'Say hi', prompt: 'Reply with the word subagent-hi and nothing else.', subagent_type: 'general-purpose' } }], stop: 'tool_use' };
    return { blocks: [{ type: 'text', text: 'The subagent answered.' }] };
  },
  thinkturns(b, st) {
    st.t = (st.t || 0) + 1;
    return { blocks: [{ type: 'thinking', thinking: 'Turn ' + st.t + ' thoughts.', signature: 'orbit1.' + Buffer.from(JSON.stringify({ id: 'rs_turn' + st.t, encrypted_content: 'enc-turn-' + st.t })).toString('base64url') }, { type: 'text', text: 'turn ' + st.t }] };
  },
  toolsearch(b, st) {
    if (!hasToolResult(b, 'toolu_ts1')) return { blocks: [{ type: 'tool_use', id: 'toolu_ts1', name: 'ToolSearch', input: { query: 'select:WebFetch', max_results: 1 } }], stop: 'tool_use' };
    if (!hasToolResult(b, 'toolu_wf1')) return { blocks: [{ type: 'tool_use', id: 'toolu_wf1', name: 'WebFetch', input: { url: 'https://example.com/', prompt: 'What is the title?' } }], stop: 'tool_use' };
    return { blocks: [{ type: 'text', text: 'fetched' }] };
  },
  toolong(b, st) {
    st.n = (st.n || 0) + 1;
    if (st.n === 2) return { error: [400, 'invalid_request_error', (st.name === 'toolong-openai' ? 'Your input exceeds the context window of this model. Please adjust your input and try again.' : 'prompt is too long: 250000 tokens > 200000 maximum')] };
    return { blocks: [{ type: 'text', text: 'after compaction' }] };
  },
};

http.createServer((req, res) => {
  let chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const m = req.url.match(/^\/s\/([^/]+)(\/.*)$/);
    const scenario = m ? m[1] : '_';
    const p = m ? m[2] : req.url;
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = { _raw: raw.slice(0, 2000) }; }
    seq[scenario] = (seq[scenario] || 0) + 1;
    const n = String(seq[scenario]).padStart(3, '0');
    const dir = path.join(OUT, scenario);
    fs.mkdirSync(dir, { recursive: true });
    const pathOnly = p.split('?')[0];
    let role = 'other';
    let answer = null;
    const st = (state[scenario] ||= { name: scenario });
    const scriptName = scenario.replace(/-.*/, '');
    if (pathOnly === '/v1/messages' && body) {
      if (isCompaction(body)) role = 'compaction';
      else if (isSub(body)) role = 'subagent';
      else if (isMain(body)) role = 'main';
      else role = 'background';
      if (role === 'main' && scripts[scriptName]) answer = scripts[scriptName](body, st);
      else if (role === 'subagent') answer = { blocks: [{ type: 'text', text: 'subagent-hi' }] };
      else if (role === 'compaction') answer = { blocks: [{ type: 'text', text: '<summary>The user asked for a test. Nothing else happened.</summary>' }] };
      else answer = { blocks: [{ type: 'text', text: '{"title":"Recorder test","isNewTopic":true}' }] };
    }
    fs.writeFileSync(path.join(dir, `${n}-${role}.json`), JSON.stringify({ method: req.method, url: req.url.replace(/^\/s\/[^/]+/, ''), headers: req.headers, body }, null, 2));
    process.stdout.write(`${scenario} ${n} ${req.method} ${p} role=${role} model=${body?.model} stream=${body?.stream}\n`);
    if (p === '/page' || req.url === '/page') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html><head><title>Recorder page</title></head><body><h1>Recorder page</h1><p>Some text.</p></body></html>'); }
    if (pathOnly === '/v1/messages/count_tokens') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ input_tokens: 1234 })); }
    if (pathOnly !== '/v1/messages') { return errorJson(res, 404, 'not_found_error', 'Not found: ' + pathOnly); }
    if (answer.error) return errorJson(res, ...answer.error);
    if (body.stream) streamMessage(res, body.model, answer.blocks, answer.stop || 'end_turn');
    else jsonMessage(res, body.model, answer.blocks, answer.stop || 'end_turn');
  });
}).listen(PORT, '127.0.0.1', () => console.log('recorder on', PORT));
