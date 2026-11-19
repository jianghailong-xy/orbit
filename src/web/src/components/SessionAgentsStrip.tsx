import { useState } from "react";
import {
  CheckCircleFilled,
  CloseCircleFilled,
  LoadingOutlined,
  RightOutlined,
} from "@ant-design/icons";
import type { SubagentRunView } from "@orbit/shared";
import {
  subagentDuration,
  subagentRunFailed,
  subagentSessionSummary,
} from "../lib/subagentRuns";

/** The `delegate` block a run was started from, where it is on the page (ToolView marks it). */
const delegateBlockOf = (toolUseId: string): HTMLElement | null =>
  typeof document === "undefined"
    ? null
    : (Array.from(
        document.querySelectorAll<HTMLElement>("[data-delegate-call]"),
      ).find((block) => block.dataset.delegateCall === toolUseId) ?? null);

/**
 * The composer band's line for the session's Agents (`mcp__orbit__delegate`), between the Tasks card and the
 * branch bar: Apple's `AgentsBandRow` and `AgentsSheet` (docs/mocks/subagent-ios-highlight ③; no cost, as the
 * Apple clients dropped it). Folded, it says what the running one is doing, or names the newest one with how it
 * ended and its time. It opens in place, as Background processes does, to every run, the running ones first, in one list with no headings. A
 * row folds the list, scrolls the conversation to the run's block and opens it. Absent until the session has
 * started one. Drawn in the Background processes tray's shell (`.bg-tray`) and rows (`.bg-shell`).
 */
export function SessionAgentsStrip({
  runs,
}: {
  runs: ReadonlyMap<string, SubagentRunView>;
}) {
  const [open, setOpen] = useState(false);
  const summary = subagentSessionSummary(runs.values());
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
    const facts = rowFacts(run);
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
          />
          <span
            className="bg-shell-cmd ag-title"
            title={run.description ?? run.type}
          >
            {run.description ?? run.type}
          </span>
          {facts && <span className="bg-shell-age ag-facts">{facts}</span>}
          <span className="bg-shell-caret">
            <RightOutlined />
          </span>
        </div>
      </div>
    );
  };

  return (
    <div className={`bg-tray${open ? " bg-open" : ""}`}>
      <div
        className="bg-tray-row"
        onClick={toggle}
        aria-label={[
          `Agents: ${summary.band}`,
          summary.last && lastSpoken(summary.last),
        ]
          .filter(Boolean)
          .join(", ")}
      >
        <span className="bg-tray-ico chat-subagent-icon ag-mark">✦</span>
        <span className="bg-tray-title ag-head">Agents</span>
        <span className="bg-tray-count ag-band" title={summary.band}>
          {summary.band}
        </span>
        <span className="wt-spacer" />
        {summary.running > 0 ? (
          <RunGlyph running failed={false} />
        ) : (
          summary.last && (
            <>
              <RunGlyph running={false} failed={summary.last.failed} />
              {summary.last.duration && (
                <span className="bg-tray-count">{summary.last.duration}</span>
              )}
            </>
          )
        )}
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

/** Running, failed or done, in the tool cards' own marks. */
function RunGlyph({ running, failed }: { running: boolean; failed: boolean }) {
  if (running)
    return <LoadingOutlined spin className="chat-tool-status running" />;
  if (failed) return <CloseCircleFilled className="chat-tool-status err" />;
  return <CheckCircleFilled className="chat-tool-status ok" />;
}

/** A row's second line, the block's identity facts then a writer's file count and its time (`Opus 5.5 · on orbit-macos · 3 files · 2m 4s`). */
function rowFacts(run: SubagentRunView): string {
  const parts: string[] = [];
  const model = run.modelLabel ?? run.model;
  if (model) parts.push(model);
  if (run.workspaceName) parts.push(`on ${run.workspaceName}`);
  if (run.readonly) parts.push("Read-only");
  if (run.status === "DONE" && !run.readonly && run.changedFiles.length > 0) {
    parts.push(
      run.changedFiles.length === 1
        ? "1 file"
        : `${run.changedFiles.length} files`,
    );
  }
  const duration = subagentDuration(run);
  if (duration) parts.push(duration);
  return parts.join(" · ");
}

/** What a screen reader hears after the band's words: `done, 50s` / `failed, 4m 12s`. */
const lastSpoken = (last: {
  failed: boolean;
  duration: string | null;
}): string =>
  [last.failed ? "failed" : "done", last.duration].filter(Boolean).join(", ");
