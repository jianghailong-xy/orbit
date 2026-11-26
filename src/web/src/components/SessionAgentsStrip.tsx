import { useState } from "react";
import {
  CheckCircleFilled,
  CloseCircleFilled,
  DesktopOutlined,
  LoadingOutlined,
  RightOutlined,
} from "@ant-design/icons";
import type { SubagentRunView } from "@orbit/shared";
import {
  agentModelLabel,
  agentRunIsOwn,
  agentShortName,
  subagentDuration,
  subagentRunFailed,
  subagentSessionSummary,
  type AgentMachineCount,
  type AgentParent,
  type SubagentSessionSummary,
} from "../lib/subagentRuns";
import { Tooltip, TEXT_TOOLTIP_DELAY_MS } from "./ui/Tooltip";

/** The `delegate` block a run was started from, where it is on the page (ToolView marks it). */
const delegateBlockOf = (toolUseId: string): HTMLElement | null =>
  typeof document === "undefined"
    ? null
    : (Array.from(
        document.querySelectorAll<HTMLElement>("[data-delegate-call]"),
      ).find((block) => block.dataset.delegateCall === toolUseId) ?? null);

/**
 * The composer band's line for the session's Agents (`mcp__orbit__delegate`), between the Tasks card and the
 * branch bar: Apple's `AgentsBandRow` and `AgentsSheet` (docs/mocks/agents-band-models; no cost, as the Apple
 * clients dropped it). Folded, it says what the running one is doing and where it runs: its machine and its
 * model, when either is not the session's own. With none running it says where the work went: how many
 * machines, then each model with how many runs took it. A failed run is not counted on the line: the reader
 * can do nothing about it (the agent that started it was told); its row in the list keeps its red ✕. Always
 * one line: narrower, the models after the first fold into "+n", then the words give way to the marks. It
 * opens in place, as Background processes does, to every run, the running ones first, in one list with no
 * headings. A row folds the list, scrolls the conversation to the run's block and opens it. Absent until the
 * session has started one. Drawn in the Background processes tray's shell (`.bg-tray`) and rows (`.bg-shell`).
 */
export function SessionAgentsStrip({
  runs,
  parent,
}: {
  runs: ReadonlyMap<string, SubagentRunView>;
  /** The session's own engine and model: a run on both, on this machine, adds no chip. */
  parent?: AgentParent;
}) {
  const [open, setOpen] = useState(false);
  const summary = subagentSessionSummary(runs.values(), parent);
  if (!summary) return null;
  const toggle = () => setOpen((o) => !o);
  const reveal = (toolUseId: string) => {
    setOpen(false);
    const block = delegateBlockOf(toolUseId);
    if (!block) return;
    // Opened the way the reader opens it: its own row's toggle.
    if (!block.classList.contains("is-open"))
      block.querySelector<HTMLElement>(".chat-tool-row")?.click();
    block.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  const row = (run: SubagentRunView) => {
    const facts = <RowFacts run={run} />;
    return (
      <div key={run.toolUseId} className="bg-shell ag-row">
        <div
          className="bg-shell-head"
          role="button"
          onClick={() => reveal(run.toolUseId)}
        >
          <RunGlyph
            running={run.status === "RUNNING"}
            failed={subagentRunFailed(run)}
            stopped={run.status === "STOPPED"}
          />
          <span
            className="bg-shell-cmd ag-title"
            title={run.description ?? run.type}
          >
            {run.description ?? run.type}
          </span>
          {facts}
          <span className="bg-shell-caret">
            <RightOutlined />
          </span>
        </div>
      </div>
    );
  };

  return (
    <div className={`bg-tray ag-tray${open ? " bg-open" : ""}`}>
      <div
        className="bg-tray-row ag-line"
        onClick={toggle}
        aria-label={spokenLine(summary)}
      >
        <span className="bg-tray-ico chat-subagent-icon ag-mark">✦</span>
        <span className="bg-tray-title ag-head">Agents</span>
        <span className="bg-tray-count ag-band" title={summary.band}>
          {summary.band}
        </span>
        <Spread summary={summary} parent={parent} />
        <span className="wt-spacer" />
        {summary.running > 0 && <RunGlyph running failed={false} />}
        <button
          type="button"
          className="wt-expand"
          onClick={(e) => {
            e.stopPropagation();
            toggle();
          }}
          aria-label={open ? "Hide agents" : "Show agents"}
        >
          {open ? "▾" : "▸"}
        </button>
      </div>
      {open && (
        <div className="bg-tray-list">
          {summary.rows.map(row)}
        </div>
      )}
    </div>
  );
}

/** Running, failed, stopped or done, in the tool cards' own marks. */
function RunGlyph({ running, failed, stopped = false }: { running: boolean; failed: boolean; stopped?: boolean }) {
  if (running)
    return <LoadingOutlined spin className="chat-tool-status running" />;
  if (failed) return <CloseCircleFilled className="chat-tool-status err" />;
  if (stopped) return <span className="chat-tool-status stopped" role="img" aria-label="stopped" />;
  return <CheckCircleFilled className="chat-tool-status ok" />;
}

/** Where the folded line says the work went: the running run's machine and model, or every machine and model. */
function Spread({
  summary,
  parent,
}: {
  summary: SubagentSessionSummary;
  parent?: AgentParent;
}) {
  const current = summary.current;
  if (summary.running > 0) {
    if (!current) return null;
    const label = agentModelLabel(current);
    return (
      <>
        {current.workspaceName && <MachineFact text={current.workspaceName} />}
        {label && !agentRunIsOwn(current, parent) && (
          <AgentChip engine={current.engine ?? parent?.engine ?? null} label={label} />
        )}
      </>
    );
  }
  if (!summary.spread) return null;
  const [first, ...rest] = summary.models;
  return (
    <>
      {summary.elsewhere && (
        <MachineFact
          text={`${summary.machines.length}`}
          word=" machines"
          title={machinesTitle(summary.machines)}
        />
      )}
      {first && <AgentChip engine={first.engine} label={first.label} count={first.count} />}
      {rest.map((m) => (
        <AgentChip
          key={`${m.engine}:${m.label}`}
          engine={m.engine}
          label={m.label}
          count={m.count}
          extra
        />
      ))}
      {rest.length > 0 && <span className="ag-more">+{rest.length}</span>}
    </>
  );
}

/** `[C] Opus 5.5 ×9`: the coding agent's letter mark in its colour, the model, and how many runs took it. */
function AgentChip({
  engine,
  label,
  count,
  extra,
}: {
  engine: string | null;
  label: string;
  count?: number;
  /** Not the most-used model: folded into "+n" when the line is narrow. */
  extra?: boolean;
}) {
  const name = engine ? agentShortName(engine) : null;
  return (
    <Tooltip content={name && !label.startsWith(name) ? `${name} · ${label}` : label} delay={TEXT_TOOLTIP_DELAY_MS}>
      <span
        className={`ag-chip${extra ? " ag-chip-extra" : ""}`}
        data-engine={engine ?? undefined}
      >
        {name && <i className="ag-chip-mark">{name.charAt(0)}</i>}
        <span className="ag-chip-name">{label}</span>
        {count !== undefined && <span className="ag-chip-n">×{count}</span>}
      </span>
    </Tooltip>
  );
}

/** `🖥 orbit-op`, or `🖥 4 machines` whose word gives way when the line is narrow. */
function MachineFact({
  text,
  word,
  title,
}: {
  text: string;
  word?: string;
  title?: string;
}) {
  return (
    <Tooltip content={title} delay={TEXT_TOOLTIP_DELAY_MS}>
      <span className="ag-fact">
        <DesktopOutlined />
        {text}
        {word && <span className="ag-word">{word}</span>}
      </span>
    </Tooltip>
  );
}

/** What hovering the machine count lists: every place, with how many runs ran there. */
const machinesTitle = (machines: AgentMachineCount[]): string =>
  [
    "Ran on",
    ...machines.map((m) => `${m.name ?? "This machine"} · ${m.count}`),
  ].join("\n");

/** A row's facts: its machine, its model, then read-only, a writer's file count and its time. */
function RowFacts({ run }: { run: SubagentRunView }) {
  const label = agentModelLabel(run);
  const files =
    run.status === "DONE" && !run.readonly && run.changedFiles.length > 0
      ? run.changedFiles.length === 1
        ? "1 file"
        : `${run.changedFiles.length} files`
      : null;
  const duration = subagentDuration(run);
  return (
    <span className="bg-shell-age ag-facts">
      {run.workspaceName && <MachineFact text={run.workspaceName} />}
      {label && <AgentChip engine={run.engine} label={label} />}
      {run.readonly && <span className="ag-fact">Read-only</span>}
      {files && <span>{files}</span>}
      {duration && <span className="ag-dur">{duration}</span>}
    </span>
  );
}

/** What a screen reader hears for the folded line: `Agents: 12, 4 machines, Opus 5.5 9 runs`. */
function spokenLine(summary: SubagentSessionSummary): string {
  const parts = [`Agents: ${summary.band}`];
  const current = summary.current;
  if (summary.running > 0) {
    if (current?.workspaceName) parts.push(`on ${current.workspaceName}`);
  } else {
    if (summary.spread) {
      if (summary.elsewhere) parts.push(`${summary.machines.length} machines`);
      for (const m of summary.models)
        parts.push(`${m.label} ${m.count === 1 ? "1 run" : `${m.count} runs`}`);
    }
  }
  return parts.join(", ");
}
