import { RunEventType } from '@orbit/shared';

/**
 * The newest Agent Tools report among a batch's events (docs/orbit-agent-contract.md §2.7): a `system` event with
 * subtype `agent_tools` whose `agentTools` is an object. The runner sends one when its engine says something new
 * about Orbit's tools, so the newest is the session's; null when the batch carries none.
 */
export function latestAgentToolsReport(
  events: ReadonlyArray<{ type: string; seq: number; payload?: unknown }>,
): Record<string, unknown> | null {
  let latest: { seq: number; report: Record<string, unknown> } | null = null;
  for (const e of events) {
    if (e.type !== RunEventType.SYSTEM) continue;
    const payload = e.payload as { subtype?: unknown; agentTools?: unknown } | null | undefined;
    if (payload?.subtype !== 'agent_tools') continue;
    const report = payload.agentTools;
    if (report === null || typeof report !== 'object' || Array.isArray(report)) continue;
    if (latest && e.seq <= latest.seq) continue;
    latest = { seq: e.seq, report: report as Record<string, unknown> };
  }
  return latest?.report ?? null;
}
