// What the Agent tools drawer says, worked out from two sources (docs/orbit-agent-contract.md §2.7):
//
//   - the session's Agent Tools report (Session.agentTools), which the runner sends from the engine's own word —
//     Claude Code's system/init frame, Codex's mcpServer/startupStatus/updated — and the control plane keeps;
//   - the Agent Tools guide (agentToolsGuide.generated.json), generated from the runner's operation catalogue and
//     route guide (src/runner-go/agent_tools_guide.go) and held to it by that package's tests, so the words here are
//     the ones docs/agent-tools-guide.md and the agents' playbooks skill say.
//
// Nothing here is a setting: the drawer explains, and the switches stay where they are.
import guideJSON from './agentToolsGuide.generated.json';

export type AgentToolsMCPStatus = 'connected' | 'starting' | 'failed' | 'needs_auth' | 'cancelled' | 'not_configured';

/** The runner's report, as Session.agentTools carries it (agent_tools_report.go, version 1). */
export interface AgentToolsReport {
  v: number;
  at: string;
  engine: string;
  engineVersion?: string;
  runnerVersion?: string;
  versions: { contract: string; catalog: string; primer: string; guide: string; playbooks: string };
  mcp: { status: AgentToolsMCPStatus | string; detail?: string; tools: number };
  families: { id: string; served: number; total: number; reason?: string }[];
  switches: { orchestration: boolean; watches: boolean; wiki: boolean };
  permissionMode?: string;
  instructions: { carrier: string; base?: boolean; workspace?: boolean; workspaceChars?: number };
  skill: { name: string; offered: boolean; loaded?: boolean; reason?: string };
}

export interface AgentToolsSection {
  id: string;
  title: string;
  lead: string;
  points: string[];
  asks?: string[];
}

export interface AgentToolsTrouble {
  id: string;
  symptom: string;
  cause: string;
  fix: string;
  code?: string;
}

export interface AgentToolsExample {
  id: string;
  title: string;
  ask: string;
  does: string;
  mcp: { tool: string; arguments: Record<string, unknown> }[];
  cli: string[][];
  script?: string;
  proof: string;
  scenario: string;
  playbook?: string;
}

export interface AgentToolsLayer {
  id: string;
  title: string;
  role: string;
  roleLabel: string;
  detail: string;
  source: string;
  when?: string[];
}

export interface AgentToolsGuide {
  guideVersion: string;
  sections: AgentToolsSection[];
  troubleshooting: AgentToolsTrouble[];
  examples: AgentToolsExample[];
  families: { id: string; label: string; tools?: string[] }[];
  instructions: Record<string, AgentToolsLayer[]>;
  instructionsNote: string;
  permissionModes: { mode: string; label: string; orbit: string }[];
  orchestration: { on: string; off: string };
  status: Record<string, string>;
  skill: { claude: string; codex: string; purpose: string };
  switchReasons: Record<string, string>;
  engineNames: Record<string, string>;
}

export const AGENT_TOOLS_GUIDE = guideJSON as unknown as AgentToolsGuide;

/** The engines whose instructions Orbit measured and lays out (agentToolsLayers). */
export const AGENT_TOOLS_ENGINES = ['claude', 'codex'] as const;
export type AgentToolsEngine = (typeof AGENT_TOOLS_ENGINES)[number];

/** How a person reads an engine's name. */
export function engineName(engine: string | null | undefined): string {
  if (!engine) return 'This engine';
  return AGENT_TOOLS_GUIDE.engineNames[engine] ?? engine.charAt(0).toUpperCase() + engine.slice(1);
}

export type AgentToolsTone = 'ok' | 'bad' | 'quiet';

/** The status line at the top of the drawer, and the dot the session menu shows. */
export interface AgentToolsStatusView {
  word: string;
  tone: AgentToolsTone;
  line: string;
  /** The engine's own words, when it gave a reason. */
  detail?: string;
  /** What still works when the server is not connected. */
  fallback?: string;
}

/** The session's report read for a person; `engine` is the session's, for a session with no report. */
export function agentToolsStatus(report: AgentToolsReport | null | undefined, engine: string | null | undefined): AgentToolsStatusView {
  const text = AGENT_TOOLS_GUIDE.status;
  if (!report) {
    const measured = (AGENT_TOOLS_ENGINES as readonly string[]).includes(engine ?? '');
    return {
      word: 'Not reported',
      tone: 'quiet',
      line: measured
        ? `${engineName(engine)} has not reported its connection yet: the runner sends it when the engine starts, and a runner older than this feature never does.`
        : text.not_reported,
    };
  }
  const who = [engineName(report.engine), report.engineVersion].filter(Boolean).join(' ');
  const fill = (template: string | undefined) =>
    (template ?? '').replace('{engine}', who).replace('{tools}', String(report.mcp.tools));
  const status = report.mcp.status;
  if (status === 'connected') return { word: 'Connected', tone: 'ok', line: fill(text.connected) };
  if (status === 'starting') return { word: 'Starting', tone: 'quiet', line: fill(text.starting) };
  return {
    word: 'Not connected',
    tone: 'bad',
    line: fill(text[status] ?? text.failed),
    detail: report.mcp.detail || undefined,
    fallback: text.fallback,
  };
}

/** One family as the drawer lists it: its label, how many of its tools the session has, and why not all. */
export interface AgentToolsFamilyRow {
  id: string;
  label: string;
  served: number;
  total: number;
  tone: AgentToolsTone;
  reason?: string;
}

export function agentToolsFamilyRows(report: AgentToolsReport): AgentToolsFamilyRow[] {
  const labels = new Map(AGENT_TOOLS_GUIDE.families.map((f) => [f.id, f.label]));
  return report.families.map((f) => {
    const notConnected = f.reason === 'not_connected';
    const tone: AgentToolsTone = f.served > 0 ? 'ok' : notConnected ? 'bad' : 'quiet';
    return { id: f.id, label: labels.get(f.id) ?? f.id, served: f.served, total: f.total, tone, reason: f.reason };
  });
}

/** Why families are short, each reason once, in the person's words. */
export function agentToolsWithheldReasons(report: AgentToolsReport): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of report.families) {
    if (!f.reason || seen.has(f.reason)) continue;
    seen.add(f.reason);
    if (f.reason === 'orchestration') {
      out.push(AGENT_TOOLS_GUIDE.orchestration.off);
    } else if (f.reason === 'not_connected') {
      out.push('Not connected: none of these reach the agent while the MCP server is down.');
    } else {
      const text = AGENT_TOOLS_GUIDE.switchReasons[f.reason];
      if (text) out.push(text);
    }
  }
  return out;
}

/** What one permission mode means for Orbit's calls; null for a mode the guide does not know. */
export function agentToolsMode(mode: string | null | undefined): { label: string; orbit: string } | null {
  return AGENT_TOOLS_GUIDE.permissionModes.find((m) => m.mode === mode) ?? null;
}

/** The facts a layer's conditions are read against. */
export interface AgentToolsLayerFacts {
  base: boolean;
  workspace: boolean;
  carrier: string;
}

/**
 * The layers an engine's model reads, in the order it reads them, kept to the ones this session or workspace has:
 * a layer is there when every condition it names holds (agentToolsLayer.When in the runner).
 */
export function agentToolsLayers(engine: string, facts: AgentToolsLayerFacts): AgentToolsLayer[] {
  const layers = AGENT_TOOLS_GUIDE.instructions[engine] ?? [];
  const holds = (c: string) => {
    switch (c) {
      case 'base':
        return facts.base;
      case 'no_base':
        return !facts.base;
      case 'workspace':
        return facts.workspace;
      default:
        return c === facts.carrier;
    }
  };
  return layers.filter((layer) => (layer.when ?? []).every(holds));
}

/** The carrier an engine's runtime instructions travel by when nothing else is known: today's engines. */
export function defaultCarrier(engine: string): string {
  return engine === 'codex' ? 'additional_context' : 'append_system_prompt';
}

/** The sections of "How agents use Orbit", in order. */
export function agentToolsSections(): AgentToolsSection[] {
  return AGENT_TOOLS_GUIDE.sections;
}
