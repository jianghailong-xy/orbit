// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunView } from "@orbit/shared";
import { subagentSessionSummary } from "../lib/subagentRuns";
import { SessionAgentsStrip } from "./SessionAgentsStrip";
import { hoverTooltip } from "../test/tooltipHover";

/**
 * The composer band's Agents line, as Apple's `AgentsBandRow` draws it (docs/mocks/agents-band-models): the
 * band's words, where the work went, a failure at its right edge, and the list it opens to, whose rows scroll
 * to the run's block.
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
    expect(s.current?.toolUseId).toBe("a");
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

  it("at rest, says the count alone", () => {
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
    expect(s.band).toBe("2");
    expect(s.current).toBeNull();
  });

  it("counts the models most runs first and the machines, the session's own as null", () => {
    const s = subagentSessionSummary(
      [
        run({ toolUseId: "a", workspaceName: "orbit-op", engine: "claude", model: "deepseek-v4.1-flash", modelLabel: "DeepSeek V4.1 Flash" }),
        run({ toolUseId: "b" }),
        run({ toolUseId: "c", workspaceName: "orbit-prod" }),
        run({ toolUseId: "d", workspaceName: "orbit-prod" }),
      ],
      { engine: "claude", model: "claude-opus-5-5" },
    )!;
    expect(s.models).toEqual([
      { label: "Opus 5.5", engine: "claude", count: 3 },
      { label: "DeepSeek V4.1 Flash", engine: "claude", count: 1 },
    ]);
    expect(s.machines).toEqual([
      { name: "orbit-prod", count: 2 },
      { name: null, count: 1 },
      { name: "orbit-op", count: 1 },
    ]);
    expect(s.elsewhere).toBe(true);
    expect(s.spread).toBe(true);
  });

  it("is quiet when every run took the session's own model on its own machine", () => {
    const parent = { engine: "claude", model: "claude-opus-5-5" };
    const own = subagentSessionSummary([run({ toolUseId: "a" }), run({ toolUseId: "b", engine: null, model: null, modelLabel: null })], parent)!;
    expect(own.spread).toBe(false);
    expect(own.elsewhere).toBe(false);
    // Another model, still here, is spread.
    const other = subagentSessionSummary([run({ toolUseId: "a", model: "claude-haiku-5-5", modelLabel: "Haiku 5.5" })], parent)!;
    expect(other.spread).toBe(true);
    expect(other.elsewhere).toBe(false);
    // A run with no model counts under its engine's name.
    const kimi = subagentSessionSummary([run({ toolUseId: "a", engine: "kimi", model: null, modelLabel: null })], parent)!;
    expect(kimi.models).toEqual([{ label: "Kimi", engine: "kimi", count: 1 }]);
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
          parent={{ engine: "claude", model: "claude-opus-5-5" }}
        />,
      ),
    );
  const openList = async () => {
    await act(async () =>
      (host.querySelector(".bg-tray-row") as HTMLElement).click(),
    );
  };

  // A stopped run was stopped on purpose: grey on the card and in the list, never in the red count
  // (docs/mocks/subagent-card-and-end-line D1).
  it("greys a stopped run and marks a lost one red in the list", async () => {
    draw([
      run({ toolUseId: "stopped", status: "STOPPED", description: "Sweep stale worktrees" }),
      run({ toolUseId: "lost", status: "INTERRUPTED", description: "Port the retry" }),
    ]);
    await openList();
    const rows = [...host.querySelectorAll<HTMLElement>(".ag-row")];
    const rowOf = (name: string) => rows.find((r) => r.textContent?.includes(name))!;
    expect(rowOf("Sweep stale worktrees").querySelector(".chat-tool-status.stopped")).not.toBeNull();
    expect(rowOf("Sweep stale worktrees").querySelector(".chat-tool-status.err")).toBeNull();
    expect(rowOf("Port the retry").querySelector(".chat-tool-status.err")).not.toBeNull();
  });

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
    // The running run is on this machine on the session's model: no fact, no chip.
    expect(line.querySelector(".ag-fact")).toBeNull();
    expect(line.querySelector(".ag-chip")).toBeNull();
    await openList();
    // Opened in place, as Background processes is: no dialog, no figures, no cost.
    const dialog = host.querySelector(".bg-tray-list")!;
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(dialog.textContent).not.toContain("$");
    expect(dialog.textContent).not.toContain("engine");
    // One list, the running ones first: no Running / Done headings.
    expect(dialog.querySelector(".ag-section")).toBeNull();
    expect(dialog.textContent).not.toContain("Running");
    const rows = [...dialog.querySelectorAll(".ag-row")];
    expect(rows.map((r) => r.querySelector(".ag-title")!.textContent)).toEqual([
      "Build the Mac app",
      "Deploy to production",
      "Audit open landings",
    ]);
    const facts = (i: number) =>
      [...rows[i].querySelector(".ag-facts")!.children].map((c) => c.textContent);
    expect(facts(1)).toEqual(["orbit-macos", "COpus 5.5", "2 files", "50s"]);
    expect(facts(2)).toEqual(["COpus 5.5", "Read-only", "50s"]);
  });

  const deepseek = { model: "deepseek-v4.1-flash", modelLabel: "DeepSeek V4.1 Flash 1017" };

  it("at rest, says how many machines and each model with its runs, and no check when all succeeded", async () => {
    draw([
      run({ toolUseId: "a", workspaceName: "orbit-prod-fcm" }),
      run({ toolUseId: "b", workspaceName: "orbit-prod-fcm" }),
      run({ toolUseId: "c", workspaceName: "orbit-op", ...deepseek }),
      run({ toolUseId: "d", workspaceName: "orbit-macos", ...deepseek, createdAt: "2026-11-18T11:00:00.000Z" }),
      run({ toolUseId: "e", workspaceName: "orbit-macos", ...deepseek }),
    ]);
    const line = host.querySelector(".bg-tray-row")!;
    expect(line.querySelector(".ag-band")!.textContent).toBe("5");
    expect(line.textContent).not.toContain("Deploy to production");
    expect(line.querySelector(".ag-fact")!.textContent).toBe("3 machines");
    expect(await hoverTooltip(line.querySelector(".ag-fact")!)).toBe(
      "Ran on\norbit-macos · 2\norbit-prod-fcm · 2\norbit-op · 1",
    );
    expect([...line.querySelectorAll(".ag-chip")].map((c) => c.textContent)).toEqual([
      "CDeepSeek V4.1 Flash 1017×3",
      "COpus 5.5×2",
    ]);
    expect(line.querySelector(".ag-chip-extra")!.textContent).toBe("COpus 5.5×2");
    expect(line.querySelector(".ag-more")!.textContent).toBe("+1");
    expect(line.querySelector(".chat-tool-status")).toBeNull();
    expect(line.getAttribute("aria-label")).toBe(
      "Agents: 5, 3 machines, DeepSeek V4.1 Flash 1017 3 runs, Opus 5.5 2 runs",
    );
  });

  // The reader can do nothing about a failed run: the line does not count it, folded or spoken.
  it("never counts failures on the line", () => {
    draw([run({ toolUseId: "a" }), run({ toolUseId: "b", status: "FAILED" })]);
    let line = host.querySelector(".bg-tray-row")!;
    expect(line.textContent).not.toContain("failed");
    expect(line.querySelector(".chat-tool-status")).toBeNull();
    expect(line.getAttribute("aria-label")).toBe("Agents: 2");

    draw([
      run({ toolUseId: "a", status: "FAILED" }),
      run({ toolUseId: "b", status: "RUNNING", endedAt: null, description: "Deploy df0fe42fb", createdAt: "2026-11-18T11:00:00.000Z" }),
    ]);
    line = host.querySelector(".bg-tray-row")!;
    expect(line.textContent).not.toContain("failed");
    expect(line.querySelector(".chat-tool-status.running")).not.toBeNull();
    expect(line.getAttribute("aria-label")).toBe("Agents: Deploy df0fe42fb");
  });

  it("running elsewhere, names its machine and its model", () => {
    draw([
      run({ toolUseId: "a" }),
      run({ toolUseId: "b", status: "RUNNING", endedAt: null, workspaceName: "orbit-op", ...deepseek, description: "Deploy df0fe42fb" }),
    ]);
    const line = host.querySelector(".bg-tray-row")!;
    expect(line.querySelector(".ag-band")!.textContent).toBe("Deploy df0fe42fb");
    expect(line.querySelector(".ag-fact")!.textContent).toBe("orbit-op");
    expect(line.querySelector(".ag-chip")!.textContent).toBe("CDeepSeek V4.1 Flash 1017");
    expect(line.querySelector(".chat-tool-status.running")).not.toBeNull();
  });

  it("an agent with another engine shows its own mark", () => {
    draw([run({ toolUseId: "a", engine: "kimi", model: "kimi-k3", modelLabel: "Kimi K3" })]);
    const chip = host.querySelector(".ag-chip")!;
    expect(chip.getAttribute("data-engine")).toBe("kimi");
    expect(chip.querySelector(".ag-chip-mark")!.textContent).toBe("K");
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
