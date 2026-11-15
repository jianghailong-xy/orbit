import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const document = readFileSync(new URL('../docs/recovery-contract.md', import.meta.url), 'utf8');
const chain = document.slice(document.indexOf('## 9.'), document.indexOf('### Agent interaction regression'));

// No real Orbit tools are exposed to the process. The candidate chooses a tool in JSON, then the
// evaluator executes it against its fixture and returns the result on the next model step.
export function createAgent() {
  return async ({ call, ...observation }) => {
    const steps = [];
    for (let step = 0; step < 8; step++) {
      const prompt = 'Act as the Orbit Agent in this conversation. Follow the production contract below.\n'
        + chain + '\nCLI uses the same server permission gate and cannot bypass it. Follow structured '
        + 'recovery reasons: WAIT means wait for state change; STOP means stop without another attempt; '
        + 'HUMAN belongs to the named user/owner. Session orchestration is in Settings -> Session orchestration.\n'
        + 'Return only JSON: {"tool": "project_get" or "session_create" or "session_send", "input": {...}} '
        + 'to call a listed tool, or {"text": "your actual reply to the user"} to end this turn. '
        + 'Do not include both. Tool schemas: project_get {projectId}; session_create {prompt}; session_send {sessionId,message}.\n'
        + JSON.stringify({ observation, steps });
      const { stdout } = await exec(process.env.AGENT_EVAL_CLAUDE ?? 'claude', [
        '-p', '--tools', '', '--no-session-persistence', '--output-format', 'json', prompt,
      ], { cwd: process.env.AGENT_EVAL_CWD, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
      const envelope = JSON.parse(stdout);
      assert.ok(!envelope.is_error, 'candidate engine returned an error');
      const action = JSON.parse(envelope.result.replace(/^```(?:json)?\s*|\s*```$/g, ''));
      if ('text' in action) return action.text;
      assert.equal(typeof action.tool, 'string', 'candidate returned neither reply nor tool');
      const result = await call(action.tool, action.input);
      steps.push({ action, result });
    }
    assert.fail('candidate exceeded eight tool steps without a reply');
  };
}
