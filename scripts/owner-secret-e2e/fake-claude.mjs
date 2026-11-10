// The owner-secret E2E's stand-in for the `claude` CLI an Orbit runner launches: enough of stream-json for a session to
// run shell commands the way an agent's Bash tool does, with no account, key or model.
//
//   fake-claude.mjs <log> [claude args…]
//
// A user turn whose text contains a line `RUN: <command>` runs that command with this process's own environment (the
// engine's, which is what an agent's shell inherits) and answers with an assistant tool_use (Bash) and a user
// tool_result carrying the command's combined output — exactly the frames whose contents become the session's
// transcript and the tool result the model would read. Any other turn (an Orbit resolution turn) gets a text answer.
// Every spawn and every command is appended to <log>.
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const [log, ...argv] = process.argv.slice(2);
if (argv.length === 1 && argv[0] === '--version') {
  process.stdout.write('2.1.200 (Claude Code)\n');
  process.exit(0);
}
// The runner asks whether the CLI is signed in before it starts a session; the fake always is.
if (argv[0] === 'auth' && argv[1] === 'status') {
  process.stdout.write(`${JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })}\n`);
  process.exit(0);
}
appendFileSync(log, `spawn\t${process.env.ORBIT_SESSION_ID ?? ''}\t${argv.join(' ')}\n`);
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
const assistant = (content) => write({
  type: 'assistant', session_id: sessionId, parent_tool_use_id: null,
  message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: 'claude-fake', content,
    stop_reason: content.some((c) => c.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } },
});

/** The text of a user frame, however its content is shaped. */
const textOf = (frame) => {
  const content = frame.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c.text ?? '')).join('\n');
  return '';
};

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
    write({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-fake', tools: ['Bash'], mcp_servers: [],
      permissionMode: 'bypassPermissions', claude_code_version: '2.1.200' });
  }
  const text = textOf(frame);
  const run = /^(RUN|SAY): (.+)$/m.exec(text);
  let answer = 'fake Claude: nothing to run.';
  if (run) {
    const command = run[2];
    const id = `toolu_${randomUUID().replaceAll('-', '')}`;
    assistant([{ type: 'tool_use', id, name: 'Bash', input: { command } }]);
    const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', env: process.env, timeout: 120_000 });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}[exit ${result.status ?? result.signal}]`;
    appendFileSync(log, `run\t${command}\texit=${result.status}\n`);
    write({ type: 'user', session_id: sessionId, parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output, is_error: result.status !== 0 }] } });
    answer = run[1] === 'SAY' ? `fake Claude: it printed ${output}` : 'fake Claude: ran it.';
  }
  assistant([{ type: 'text', text: answer }]);
  write({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: answer, session_id: sessionId,
    total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 5 } });
});
lines.on('close', () => process.exit(0));
