import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

/**
 * Agents see the session-state fields (docs/session-three-state-plan.md §8 step 5.5). The agent contract
 * is published from the Go descriptors, so this reads them: `session_get` and `session_list` name
 * phase, released, lastTurnOutcome and waitingOn, the seven-value status filter is untouched, and the
 * contract version moved.
 */

const ROOT = path.resolve(__dirname, '../../../..');
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), 'utf8');

const CATALOG = read('src/runner-go/operation_catalog.go');
const FIELDS = ['phase', 'released', 'lastTurnOutcome', 'waitingOn'];

test('the shared note names the four fields, and both session tools carry it', () => {
  const note = CATALOG.match(/const sessionStateFieldsNote = "(.*)"\n/u);
  assert.ok(note, 'sessionStateFieldsNote is declared');
  for (const field of FIELDS) assert.ok(note[1].includes(field), `the note names ${field}`);
  for (const tool of ['session_list', 'session_get']) {
    const start = CATALOG.indexOf(`"name":        "${tool}"`);
    assert.ok(start > 0, `${tool} is declared`);
    const description = CATALOG.slice(start, CATALOG.indexOf('"inputSchema"', start));
    assert.ok(description.includes('sessionStateFieldsNote'), `${tool}'s description carries the note`);
  }
});

test('the seven-value status filter is unchanged on the tool and the CLI', () => {
  const seven = ['PENDING', 'RUNNING', 'AWAITING_INPUT', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED'];
  assert.ok(CATALOG.includes(`"enum": []string{${seven.map((s) => `"${s}"`).join(', ')}}`));
  assert.ok(CATALOG.includes(`--status <${seven.join('|')}>`));
});

test('the contract version moved to 1.12.0 or later, and every place that states it agrees', () => {
  // The fields arrived in 1.12.0; later versions (1.13.0, the Drive rename) keep them, so this
  // pins the floor and the agreement rather than one release.
  const json = JSON.parse(read('contracts/orbit-agent.contract.json')) as { contractVersion: string };
  const version = json.contractVersion;
  const [major, minor] = version.split('.').map(Number);
  assert.ok(major > 1 || (major === 1 && minor >= 12), `contract version ${version} is 1.12.0 or later`);
  const quoted = version.replace(/\./gu, '\\.');
  assert.match(read('src/runner-go/agent_primer.go'), new RegExp(`agentContractVersion = "${quoted}"`, 'u'));
  assert.match(read('docs/orbit-agent-contract.md'), new RegExp(`frozen at v${quoted}`, 'u'));
  const guide = read('docs/agent-tools-guide.md');
  assert.match(guide, new RegExp(`Agent Contract ${quoted}`, 'u'));
  for (const field of FIELDS) assert.ok(guide.includes(field), `docs/agent-tools-guide.md names ${field}`);
});
