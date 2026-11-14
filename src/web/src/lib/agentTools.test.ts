import { describe, expect, it } from 'vitest';
import {
  AGENT_TOOLS_GUIDE,
  agentToolsFamilyRows,
  agentToolsLayers,
  agentToolsMode,
  agentToolsStatus,
  agentToolsWithheldReasons,
  type AgentToolsReport,
} from './agentTools';

/**
 * What the Agent tools drawer says, read off the session's report and the generated guide
 * (src/runner-go/agent_tools_guide.go): the connection in the engine's own words, the families and why one is
 * short, and the instructions the engine reads in the order measured on Claude Code 2.1.325 and Codex 0.167.2.
 */

export function report(over: Partial<AgentToolsReport> = {}): AgentToolsReport {
  return {
    v: 1,
    at: '2026-11-14T13:00:00Z',
    engine: 'claude',
    engineVersion: '2.1.325',
    runnerVersion: '0.1.261',
    versions: { contract: '1.8.0', catalog: '1.7.0', primer: '1.2.0', guide: '1.1.0', playbooks: '1.0.0' },
    mcp: { status: 'connected', tools: 80 },
    families: [
      { id: 'tasks', served: 21, total: 21 },
      { id: 'wiki', served: 0, total: 5, reason: 'wiki' },
      { id: 'orchestration', served: 0, total: 22, reason: 'orchestration' },
    ],
    switches: { orchestration: false, watches: true, wiki: false },
    permissionMode: 'default',
    instructions: { carrier: 'append_system_prompt', workspace: true, workspaceChars: 412 },
    skill: { name: 'orbit:playbooks', offered: true, loaded: true },
    ...over,
  };
}

describe('agentToolsStatus', () => {
  it('says connected in the guide words, with the engine and its tool count', () => {
    const s = agentToolsStatus(report(), 'claude');
    expect(s.word).toBe('Connected');
    expect(s.tone).toBe('ok');
    expect(s.line).toBe("Claude Code 2.1.325 started Orbit's MCP server and lists 80 Orbit tools.");
    expect(s.fallback).toBeUndefined();
  });

  it("carries the engine's own reason when it could not start the server, and what still works", () => {
    const s = agentToolsStatus(
      report({ engine: 'codex', engineVersion: '0.167.2', mcp: { status: 'failed', detail: 'connection closed', tools: 0 } }),
      'codex',
    );
    expect(s.word).toBe('Not connected');
    expect(s.tone).toBe('bad');
    expect(s.line).toBe("Codex 0.167.2 could not start Orbit's MCP server.");
    expect(s.detail).toBe('connection closed');
    expect(s.fallback).toBe(AGENT_TOOLS_GUIDE.status.fallback);
  });

  it('says a session with no report has not reported, and why, by engine', () => {
    expect(agentToolsStatus(null, 'claude').line).toContain('has not reported its connection yet');
    expect(agentToolsStatus(undefined, 'kimi').line).toBe(AGENT_TOOLS_GUIDE.status.not_reported);
    expect(agentToolsStatus(null, 'kimi').tone).toBe('quiet');
  });

  it('reads every status the runner sends', () => {
    for (const status of ['connected', 'starting', 'failed', 'needs_auth', 'cancelled', 'not_configured']) {
      const s = agentToolsStatus(report({ mcp: { status, tools: 0 } }), 'claude');
      expect(s.line).not.toContain('{engine}');
      expect(s.line).not.toBe('');
    }
  });
});

describe('families', () => {
  it('labels each family and says why one is short, each reason once', () => {
    const rows = agentToolsFamilyRows(report());
    expect(rows.map((r) => [r.label, r.tone])).toEqual([
      ['Tasks', 'ok'],
      ['Wiki', 'quiet'],
      ['Sessions, agents and runners', 'quiet'],
    ]);
    expect(agentToolsWithheldReasons(report())).toEqual([
      AGENT_TOOLS_GUIDE.switchReasons.wiki,
      AGENT_TOOLS_GUIDE.orchestration.off,
    ]);
  });

  it('every family the guide declares has a label', () => {
    expect(AGENT_TOOLS_GUIDE.families.map((f) => f.id)).toEqual([
      'tasks', 'projects', 'task-lists', 'waits', 'files', 'background', 'owner', 'wiki', 'providers',
      'merge-receipts', 'guide', 'orchestration',
    ]);
  });
});

describe('instructions', () => {
  const ids = (engine: string, facts: Parameters<typeof agentToolsLayers>[1]) =>
    agentToolsLayers(engine, facts).map((l) => `${l.id}:${l.roleLabel}`);

  it('lays out Claude Code as measured: the appended system prompt, CLAUDE.md with the first message, then the MCP instructions', () => {
    expect(ids('claude', { base: false, workspace: true, carrier: 'append_system_prompt' })).toEqual([
      'engine:System',
      'workspace:System · appended',
      'orbit:System · appended',
      'repository:Project context',
      'person:User',
      'mcp:System message',
      'skill:On demand',
    ]);
    // Base instructions take the engine's place; no workspace instructions, no workspace layer.
    expect(ids('claude', { base: true, workspace: false, carrier: 'append_system_prompt' }).slice(0, 2)).toEqual([
      'workspace-base:System',
      'orbit:System · appended',
    ]);
  });

  it("lays out Codex by the carrier its version takes, with Developer for Orbit's runtime instructions", () => {
    expect(ids('codex', { base: false, workspace: true, carrier: 'additional_context' })).toEqual([
      'engine:Developer',
      'skill:On demand',
      'repository:Project context',
      'workspace:Developer',
      'orbit:Developer',
      'person:User',
      'mcp:With the tools',
    ]);
    expect(ids('codex', { base: false, workspace: false, carrier: 'turn_input' })).toContain('orbit:User · turn input');
    expect(ids('codex', { base: false, workspace: false, carrier: 'developer_message' })).toContain('orbit:Developer');
  });
});

describe('agentToolsMode', () => {
  it("says what each permission mode means for Orbit's calls", () => {
    expect(agentToolsMode('plan')?.orbit).toContain('SESSION_IN_PLAN_MODE');
    expect(agentToolsMode('default')?.label).toBe('Default');
    expect(agentToolsMode('bogus')).toBeNull();
  });
});
