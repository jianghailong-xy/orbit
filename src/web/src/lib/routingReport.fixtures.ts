import type { SubagentReportGroup, SubagentRoutingReport, WorkflowReportGroup } from '@orbit/shared';

/**
 * The routing report board's figures (docs/mocks/subagent-workflow/08-report.html), as the server answers them: rows in
 * its order (tier, then runs; workflows by runs, then cost) and its names (a built-in engine by its CLI's name).
 */
const group = (fields: Partial<SubagentReportGroup> & Pick<SubagentReportGroup, 'tier' | 'runs'>): SubagentReportGroup => ({
  provider: 'claude', providerLabel: 'Claude Code', model: null, modelLabel: null, workflowCalls: 0,
  ended: fields.runs, done: fields.runs, costUsd: 0, movedOn: 0, noSize: 0, ...fields,
});

export const BOARD_SUBAGENTS: SubagentReportGroup[] = [
  group({ tier: 'S', provider: 'deepseek', providerLabel: 'DeepSeek', model: 'deepseek-v4-flash', modelLabel: 'DeepSeek V4 Flash',
    runs: 64, workflowCalls: 30, done: 63, costUsd: 11.4, noSize: 9 }),
  group({ tier: 'S', model: 'claude-haiku-5-5', modelLabel: 'Claude Haiku 5.5', runs: 12, workflowCalls: 8, done: 11, costUsd: 1.2,
    movedOn: 1, noSize: 2 }),
  group({ tier: 'S', provider: 'codex', providerLabel: 'Codex', model: 'gpt-6.1-sol', modelLabel: 'GPT-6.1 Sol', runs: 9, workflowCalls: 6 }),
  group({ tier: 'M', model: 'claude-sonnet-5-5', modelLabel: 'Claude Sonnet 5.5', runs: 22, workflowCalls: 12, done: 15, costUsd: 9.86,
    noSize: 8 }),
  group({ tier: 'M', provider: 'codex', providerLabel: 'Codex', model: 'gpt-6.1-sol', modelLabel: 'GPT-6.1 Sol', runs: 19, workflowCalls: 9,
    done: 17, movedOn: 2, noSize: 7 }),
  group({ tier: 'M', provider: 'kimi', providerLabel: 'Kimi Code', model: 'kimi-code/k3', modelLabel: 'Kimi K3', runs: 10, workflowCalls: 6 }),
  group({ tier: 'L', provider: 'codex', providerLabel: 'Codex', model: 'gpt-6.2-sol', modelLabel: 'GPT-6.2 Sol', runs: 18, done: 17 }),
  group({ tier: 'L', model: 'claude-opus-5-5', modelLabel: 'Claude Opus 5.5', runs: 5, costUsd: 4.31 }),
  group({ tier: 'XL', model: 'claude-fable-5-2', modelLabel: 'Claude Fable 5.2', runs: 2, costUsd: 6.8 }),
  group({ tier: 'named', provider: 'deepseek', providerLabel: 'DeepSeek', model: 'deepseek-flash', modelLabel: 'DeepSeek Flash',
    runs: 171, done: 160, costUsd: 81.3 }),
  group({ tier: 'not-routed', provider: 'deepseek', providerLabel: 'DeepSeek', model: 'deepseek-flash', modelLabel: 'DeepSeek Flash',
    runs: 395, ended: 394, done: 352, costUsd: 172.34 }),
];

export const BOARD_WORKFLOWS: WorkflowReportGroup[] = [
  { name: 'review-changes', description: 'Review the diff by dimension, verify each finding', runs: 4, running: 1, calls: 48,
    failedCalls: 3, costUsd: 5.48, durationP50Ms: 400_000 },
  { name: 'triage-flakes', description: 'Rerun each flaky spec and sort it by cause', runs: 3, running: 0, calls: 15, failedCalls: 1,
    costUsd: 1.3, durationP50Ms: 130_000 },
  { name: 'workflow-smoke', description: 'Smoke test', runs: 1, running: 0, calls: 3, failedCalls: 0, costUsd: 0.24, durationP50Ms: 25_000 },
  { name: 'wf-p1-smoke', description: 'Phase 1 smoke test', runs: 1, running: 0, calls: 5, failedCalls: 0, costUsd: 0, durationP50Ms: 127_000 },
];

export const BOARD_REPORT: SubagentRoutingReport = { subagents: BOARD_SUBAGENTS, workflows: BOARD_WORKFLOWS };
