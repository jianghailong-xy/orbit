import test from 'node:test';
import assert from 'node:assert/strict';
import { RunEventType } from '@orbit/shared';
import { isNoiseSystemEvent } from '../common/system-noise';
import { latestAgentToolsReport } from './agent-tools-report';

/**
 * The session's Agent Tools report (docs/orbit-agent-contract.md §2.7, migration 0770): the runner sends it as a
 * `system` event with subtype `agent_tools`, and the ingest keeps the newest one of a batch whole, as
 * Session.agentTools. Nothing else in the batch touches it.
 */

const report = (status: string) => ({
  v: 1,
  at: '2026-11-14T13:00:00Z',
  engine: 'claude',
  engineVersion: '2.1.325',
  versions: { contract: '1.8.0', catalog: '1.7.0', primer: '1.2.0', guide: '1.1.0', playbooks: '1.0.0' },
  mcp: { status, tools: status === 'connected' ? 102 : 0 },
  families: [{ id: 'tasks', served: 21, total: 21 }],
  switches: { orchestration: true, watches: true, wiki: true },
  instructions: { carrier: 'append_system_prompt' },
  skill: { name: 'orbit:playbooks', offered: true, loaded: true },
});

const event = (seq: number, payload: unknown, type: string = RunEventType.SYSTEM) => ({ seq, type, payload });

test('the newest agent_tools report of a batch is the session’s, kept whole', () => {
  const kept = latestAgentToolsReport([
    event(4, { subtype: 'agent_tools', agentTools: report('starting') }),
    event(5, { subtype: 'init', model: 'claude-opus-5-5', sessionId: 's' }),
    event(7, { subtype: 'agent_tools', agentTools: report('connected') }),
    event(6, { subtype: 'agent_tools', agentTools: report('failed') }),
  ]);
  assert.deepEqual(kept, report('connected'));
});

test('a batch without a well-formed report leaves the stored one alone', () => {
  assert.equal(latestAgentToolsReport([]), null);
  assert.equal(
    latestAgentToolsReport([
      event(1, { subtype: 'init' }),
      event(2, { subtype: 'agent_tools' }),
      event(3, { subtype: 'agent_tools', agentTools: 'connected' }),
      event(4, { subtype: 'agent_tools', agentTools: [report('connected')] }),
      event(5, { subtype: 'agent_tools', agentTools: report('connected') }, RunEventType.ASSISTANT),
      event(6, null),
    ]),
    null,
  );
});

test('the report is an event the control plane stores, not a noise ping', () => {
  assert.equal(isNoiseSystemEvent({ type: RunEventType.SYSTEM, payload: { subtype: 'agent_tools', agentTools: report('connected') } }), false);
});
