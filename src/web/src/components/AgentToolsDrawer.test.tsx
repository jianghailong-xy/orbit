// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentToolsDrawer, agentToolsMenuStatus, type AgentToolsDrawerProps } from './AgentToolsDrawer';
import { AGENT_TOOLS_GUIDE, type AgentToolsReport } from '../lib/agentTools';
import { meQuery } from '../lib/queries';

/**
 * The Agent tools drawer (docs/mocks/agent-tools/01-board.png): read-only, a session's real connection from its
 * report, and a workspace's instructions by engine; both with "How agents use Orbit" and the four examples.
 */

const NOW = Date.parse('2026-11-14T13:03:00Z');

const connected: AgentToolsReport = {
  v: 1,
  at: '2026-11-14T13:00:00Z',
  engine: 'claude',
  engineVersion: '2.1.325',
  versions: { contract: '1.8.0', catalog: '1.7.0', primer: '1.2.0', guide: '1.1.0', playbooks: '1.0.0' },
  mcp: { status: 'connected', tools: 102 },
  families: AGENT_TOOLS_GUIDE.families.map((f) => ({ id: f.id, served: f.tools?.length ?? 1, total: f.tools?.length ?? 1 })),
  switches: { orchestration: true, watches: true, wiki: true },
  permissionMode: 'default',
  instructions: { carrier: 'append_system_prompt', workspace: true, workspaceChars: 412 },
  skill: { name: 'orbit:playbooks', offered: true, loaded: true },
};

const failed: AgentToolsReport = {
  ...connected,
  engine: 'codex',
  engineVersion: '0.167.2',
  mcp: {
    status: 'failed',
    detail: 'MCP client for `orbit` failed to start: handshaking with MCP server failed: connection closed',
    tools: 0,
  },
  families: AGENT_TOOLS_GUIDE.families.map((f) => ({
    id: f.id,
    served: 0,
    total: f.tools?.length ?? 1,
    reason: f.id === 'orchestration' ? 'orchestration' : 'not_connected',
  })),
  switches: { orchestration: false, watches: true, wiki: true },
  instructions: { carrier: 'additional_context' },
  skill: { name: 'orbit-playbooks', offered: true },
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function render(props: AgentToolsDrawerProps, orchestration = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(meQuery().queryKey, {
    id: 'u', email: 'me@example.com', name: 'Me', createdAt: '2026-01-01T00:00:00Z',
    preferences: { enableOrchestration: orchestration },
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={qc}>
        <AgentToolsDrawer {...props} />
      </QueryClientProvider>,
    );
    await new Promise((r) => setTimeout(r, 0));
  });
  return document.body;
}

const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('AgentToolsDrawer on a session', () => {
  it("shows the engine's own report: connected, the versions, every family, the layers in the order it reads them", async () => {
    const body = await render({ mode: 'session', open: true, onClose: vi.fn(), report: connected, engine: 'claude', permissionMode: 'default', now: NOW });
    const status = body.querySelector('.agent-tools-status');
    expect(status?.className).toContain('is-ok');
    expect(text(status)).toContain('Connected');
    expect(text(status)).toContain('Reported 3m ago');
    expect(text(status)).toContain("Claude Code 2.1.325 started Orbit's MCP server and lists 102 Orbit tools.");
    expect(text(status)).toContain('Agent Contract 1.8.0 · Operation catalogue 1.7.0 · Primer 1.2.0 · Guide 1.1.0');
    const families = Array.from(body.querySelectorAll('.agent-tools-family-label')).map(text);
    expect(families).toEqual(AGENT_TOOLS_GUIDE.families.map((f) => f.label));
    expect(text(body.querySelector('.agent-tools-why'))).toBe(AGENT_TOOLS_GUIDE.orchestration.on);
    const layers = Array.from(body.querySelectorAll('.agent-tools-layer-title')).map((el) => el.firstChild?.textContent?.trim());
    expect(layers).toEqual([
      "Claude Code's system prompt",
      "This workspace's runtime instructions",
      "Orbit's runtime instructions",
      'CLAUDE.md files',
      'Your messages',
      'Orbit MCP server instructions',
      'Orbit playbooks · orbit:playbooks',
    ]);
    expect(text(body.querySelector('.agent-tools-layers'))).toContain('412 characters.');
    expect(text(body.querySelector('.agent-tools-layers'))).toContain('Loaded.');
    // Read-only: nothing in it can be switched or typed into.
    expect(body.querySelectorAll('.agent-tools input, .agent-tools textarea, .agent-tools [role="switch"]')).toHaveLength(0);
    // The guide is there, folded: the six sections and the four examples.
    const folds = Array.from(body.querySelectorAll('.agent-tools-fold > summary')).map(text);
    expect(folds).toEqual([
      'MCP first, the CLI by exception',
      "Your record and the agent's private plan",
      'Which object a request belongs to',
      'Creating is not starting',
      'When the CLI is the right tool',
      `When something is missing${AGENT_TOOLS_GUIDE.troubleshooting.length} symptoms`,
      'Try asking4 examples',
    ]);
    expect(body.querySelectorAll('.agent-tools-example')).toHaveLength(4);
  });

  it("says why it is not connected in the engine's words, what still works, and why each family is short", async () => {
    const body = await render(
      { mode: 'session', open: true, onClose: vi.fn(), report: failed, engine: 'codex', permissionMode: 'plan', now: NOW },
      false,
    );
    const status = body.querySelector('.agent-tools-status');
    expect(status?.className).toContain('is-bad');
    expect(text(status)).toContain("Codex 0.167.2 could not start Orbit's MCP server.");
    expect(text(body.querySelector('.agent-tools-quote'))).toBe(failed.mcp.detail);
    expect(text(status)).toContain(AGENT_TOOLS_GUIDE.status.fallback);
    const why = text(body.querySelector('.agent-tools-why'));
    expect(why).toContain('Not connected: none of these reach the agent while the MCP server is down.');
    expect(why).toContain(AGENT_TOOLS_GUIDE.orchestration.off);
    expect(text(body.querySelector('.agent-tools'))).toContain('SESSION_IN_PLAN_MODE');
    const roles = Array.from(body.querySelectorAll('.agent-tools-role')).map(text);
    expect(roles).toEqual(['Developer', 'On demand', 'Project context', 'Developer', 'User', 'With the tools']);
  });

  it('says a session with no report has none yet, and still explains the switch', async () => {
    const body = await render({ mode: 'session', open: true, onClose: vi.fn(), report: null, engine: 'kimi', permissionMode: 'auto', now: NOW });
    expect(text(body.querySelector('.agent-tools-status'))).toContain('Not reported');
    expect(text(body.querySelector('.agent-tools'))).toContain('Shown once this session');
    expect(text(body.querySelector('.agent-tools'))).toContain('the order is laid out here for Claude Code and Codex');
  });
});

describe('AgentToolsDrawer on a workspace', () => {
  it('lays out each engine, opens the instructions editor, and shows the four examples', async () => {
    const onEdit = vi.fn();
    const body = await render({
      mode: 'workspace', open: true, onClose: vi.fn(), workspaceName: 'orbit-op',
      instructions: 'Use pnpm, never npm.', baseInstructions: false, onEditInstructions: onEdit,
    });
    expect(text(body.querySelector('[role="dialog"]'))).toContain('Agent tools · orbit-op');
    expect(body.querySelector('.agent-tools-status')).toBeNull();
    expect(Array.from(body.querySelectorAll('.agent-tools-engine [role="radio"]')).map(text)).toEqual(['Claude Code', 'Codex']);
    expect(text(body.querySelector('.agent-tools-layers'))).toContain('20 characters.');
    const edit = Array.from(body.querySelectorAll('button')).find((b) => b.textContent === 'Edit');
    act(() => edit?.click());
    expect(onEdit).toHaveBeenCalled();
    const asks = Array.from(body.querySelectorAll('.agent-tools-ask')).map(text);
    expect(asks).toEqual(AGENT_TOOLS_GUIDE.examples.map((e) => `“${e.ask}”`));
    expect(asks).toHaveLength(4);
  });
});

describe('agentToolsMenuStatus', () => {
  it("is the drawer's word and tone, for the session menu's row", () => {
    expect(agentToolsMenuStatus(connected, 'claude')).toEqual({ word: 'Connected', tone: 'ok' });
    expect(agentToolsMenuStatus(failed, 'codex')).toEqual({ word: 'Not connected', tone: 'bad' });
    expect(agentToolsMenuStatus(undefined, 'claude')).toEqual({ word: 'Not reported', tone: 'quiet' });
  });
});
