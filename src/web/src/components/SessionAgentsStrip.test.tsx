// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunView } from "@orbit/shared";
import { subagentSessionSummary } from "../lib/subagentRuns";
import { SessionAgentsStrip } from "./SessionAgentsStrip";

/**
 * The composer band's Agents line, as Apple's `AgentsBandRow` draws it: the band's words, the newest run's end
 * at its right edge, and the list it opens to, whose rows scroll to the run's block.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function run(over: Partial<SubagentRunView>): SubagentRunView {
  return {
    toolUseId: "toolu_1",
    type: "general",
    background: true,
    status: "DONE",
    level: "M",
    model: "claude-opus-5-5",
    modelLabel: "Opus 5.5",
    effort: null,
    reasons: [],
    why: null,
    removed: [],
    costUsd: 1.25,
    resultSummary: null,
    workspaceName: null,
    description: "Deploy to production",
    engine: "claude",
    readonly: false,
    changedFiles: [],
    createdAt: "2026-11-18T10:00:00.000Z",
    endedAt: "2026-11-18T10:00:50.000Z",
    ...over,
  };
}

describe("subagentSessionSummary (OrbitKit SubagentSessionSummary)", () => {
  it("is nothing until the session starts an Agent", () => {
    expect(subagentSessionSummary([])).toBeNull();
  });

  it("names the one running run by its description", () => {
    const s = subagentSessionSummary([
      run({
        toolUseId: "a",
        status: "RUNNING",
        endedAt: null,
        description: "Build the Mac app",
      }),
      run({ toolUseId: "b" }),
    ])!;
    expect(s.band).toBe("Build the Mac app");
    expect(s.last).toBeNull();
    expect(s.rows.map((r) => r.toolUseId)).toEqual(["a", "b"]);
  });

  it("leads with how many when several run, naming the newest", () => {
    const s = subagentSessionSummary([
      run({
        toolUseId: "a",
        status: "RUNNING",
        endedAt: null,
        description: "Older",
      }),
      run({
        toolUseId: "b",
        status: "RUNNING",
        endedAt: null,
        description: "Newer",
        createdAt: "2026-11-18T11:00:00.000Z",
      }),
    ])!;
    expect(s.band).toBe("2 running · Newer");
  });

  it("keeps the counts for a running run with no description", () => {
    const s = subagentSessionSummary([
      run({
        toolUseId: "a",
        status: "RUNNING",
        endedAt: null,
        description: null,
      }),
      run({ toolUseId: "b" }),
    ])!;
    expect(s.band).toBe("2 · 1 running");
  });

  it("at rest, says the count and the newest run, and how that one ended", () => {
    const s = subagentSessionSummary([
      run({ toolUseId: "a" }),
      run({
        toolUseId: "b",
        status: "FAILED",
        description: "Ship it",
        createdAt: "2026-11-18T11:00:00.000Z",
        endedAt: "2026-11-18T11:04:12.000Z",
      }),
    ])!;
    expect(s.band).toBe("2 · Ship it");
    expect(s.last).toEqual({ failed: true, duration: "4m 12s" });
  });
});

describe("SessionAgentsStrip", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
  });

  const draw = (runs: SubagentRunView[]) =>
    act(() =>
      root.render(
        <SessionAgentsStrip
          runs={new Map(runs.map((r) => [r.toolUseId, r]))}
        />,
      ),
    );
  const openList = async () => {
    await act(async () =>
      (host.querySelector(".bg-tray-row") as HTMLElement).click(),
    );
  };

  it("draws nothing for a session with no Agent", () => {
    draw([]);
    expect(host.innerHTML).toBe("");
  });

  it("folds to one line with no cost, and opens in place to the runs, running first", async () => {
    draw([
      run({
        toolUseId: "done",
        changedFiles: ["a.ts", "b.ts"],
        workspaceName: "orbit-macos",
      }),
      run({
        toolUseId: "audit",
        readonly: true,
        description: "Audit open landings",
        createdAt: "2026-11-18T08:00:00.000Z",
        endedAt: "2026-11-18T08:00:50.000Z",
      }),
      run({
        toolUseId: "live",
        status: "RUNNING",
        endedAt: null,
        description: "Build the Mac app",
        createdAt: "2026-11-18T09:00:00.000Z",
      }),
    ]);
    const line = host.querySelector(".bg-tray-row")!;
    expect(line.textContent).toContain("Agents");
    expect(line.textContent).toContain("Build the Mac app");
    await openList();
    // Opened in place, as Background processes is: no dialog, no figures, no cost.
    const dialog = host.querySelector(".bg-tray-list")!;
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(dialog.textContent).not.toContain("$");
    expect(dialog.textContent).not.toContain("engine");
    expect(
      [...dialog.querySelectorAll(".ag-section")].map((s) => s.textContent),
    ).toEqual(["Running", "Done"]);
    const rows = [...dialog.querySelectorAll(".ag-row")];
    expect(rows.map((r) => r.querySelector(".ag-title")!.textContent)).toEqual([
      "Build the Mac app",
      "Deploy to production",
      "Audit open landings",
    ]);
    expect(rows[1].querySelector(".ag-facts")!.textContent).toBe(
      "Opus 5.5 · on orbit-macos · 2 files · 50s",
    );
    expect(rows[2].querySelector(".ag-facts")!.textContent).toBe(
      "Opus 5.5 · Read-only · 50s",
    );
  });

  it("a row folds the list, then scrolls to its run's block and opens it", async () => {
    const block = document.createElement("div");
    block.dataset.delegateCall = "done";
    const toggle = document.createElement("div");
    toggle.className = "chat-tool-row";
    const opened = vi.fn(() => block.classList.add("is-open"));
    toggle.addEventListener("click", opened);
    block.appendChild(toggle);
    const scroll = vi.fn();
    block.scrollIntoView = scroll;
    document.body.appendChild(block);
    draw([run({ toolUseId: "done" })]);
    await openList();
    await act(async () =>
      (host.querySelector(".ag-row .bg-shell-head") as HTMLElement).click(),
    );
    expect(opened).toHaveBeenCalledTimes(1);
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".bg-tray-list")).toBeNull();
    // An open block is left open.
    await openList();
    await act(async () =>
      (host.querySelector(".ag-row .bg-shell-head") as HTMLElement).click(),
    );
    expect(opened).toHaveBeenCalledTimes(1);
  });
});
