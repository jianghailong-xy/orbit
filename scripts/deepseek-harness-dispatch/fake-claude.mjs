// D3's stand-in for the `claude` CLI an Orbit runner launches: just enough of stream-json for one
// task run to settle, so the Claude EXECUTABLE path can be exercised next to the Harness one with no
// account, key or model. Every spawn is appended to <log> (tab-separated: engine, ORBIT_SESSION_ID, argv);
// every user frame gets one assistant text answer and a `result`; every control_request gets a success.
//   fake-claude.mjs <log> [claude args…]
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const [log, ...argv] = process.argv.slice(2);
if (argv.length === 1 && argv[0] === '--version') {
  process.stdout.write('2.1.200 (Claude Code)\n');
  process.exit(0);
}
appendFileSync(log, `claude\t${process.env.ORBIT_SESSION_ID ?? ''}\t${argv.join(' ')}\n`);
if (!argv.includes('stream-json')) {
  process.stderr.write('fake claude: only stream-json sessions are scripted here\n');
  process.exit(97);
}
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : '';
};
const sessionId = flag('--session-id') || flag('--resume') || randomUUID();
const write = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
let initialized = false;
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  let frame;
  try { frame = JSON.parse(line); } catch { return; }
  if (frame.type === 'control_request') {
    write({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } });
    return;
  }
  if (frame.type !== 'user') return;
  if (!initialized) {
    initialized = true;
    write({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-fake', tools: [], mcp_servers: [],
      permissionMode: 'default', claude_code_version: '2.1.200' });
  }
  const text = 'D3 fake Claude: the task is done.';
  write({ type: 'assistant', session_id: sessionId, parent_tool_use_id: null,
    message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: 'claude-fake',
      content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } } });
  write({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: text, session_id: sessionId,
    total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 5 } });
});
lines.on('close', () => process.exit(0));
