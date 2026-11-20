import Foundation

/// An Orbit workflow — a top-level `mcp__orbit__workflow` call whose `agent()` calls arrive as `delegate`
/// calls nested under it (docs/subagent-workflow-design.md §3.3) — as iOS and macOS draw it (board
/// docs/mocks/subagent-workflow part 4). UI-free so the words stay unit-testable and both clients draw
/// the same ones. The numbers come from the server (`WorkflowRunView` and its calls' `SubagentRunView`s),
/// never from the transcript's text; the transcript only says which calls the script has made so far.
///
/// Folded it has three lines: `Workflow` and the description with a spinner or how it ended; then, grey,
/// `<phase> · <done> of <started> · $<cost>` (`$x of $y` only when the call set a limit); then, italic and
/// only while it runs, how many calls are running and queued. Tapped, it opens a page of its calls by
/// phase, each opening the existing SubAgent detail.
public struct WorkflowBlock: Equatable, Sendable {
    public static let toolName = "mcp__orbit__workflow"
    /// What the block's row calls it.
    public static let label = "Workflow"

    public enum State: String, Equatable, Sendable {
        case running, done, failed, stopped
    }

    public enum CallState: String, Equatable, Sendable {
        /// Made by the script, its SubAgent not started yet (calls share the SubAgent concurrency limit).
        case queued
        case running, done, failed
    }

    /// One `agent()` call: a row of the calls page.
    public struct Call: Equatable, Sendable, Identifiable {
        /// The nested `delegate` call's tool_use id, `<workflow call>#<callIndex>`.
        public let id: String
        /// The script's label for it, else its type.
        public let label: String
        /// The first line it handed back, or how it ended; nil while it has not ended.
        public let result: String?
        public let state: CallState
        public let phase: String?
        /// The nested call itself, which the existing SubAgent detail draws.
        public let card: ToolCard
    }

    /// The calls of one phase, in the order the script made them.
    public struct Section: Equatable, Sendable, Identifiable {
        public var id: String { title ?? "" }
        /// The phase's title; nil for calls the script gave no phase.
        public let title: String?
        /// `Verify · 3 done · 3 running · 2 queued` — done counts every call that ended, a failed one
        /// included (its row's ✕ says which).
        public let header: String
        public let calls: [Call]
        /// How many rows to show before `more`; `calls.count` when nothing is folded.
        public let shown: Int
        /// `2 more`: an ended phase of a workflow still running shows its first rows only.
        public let more: String?
    }

    /// The row's words after `Workflow`: the call's description, else the script's name.
    public let title: String
    public let state: State
    /// The grey second line: `Verify · 7 of 12 · $0.84`.
    public let progress: String
    /// The italic third line while it runs: `3 running, 2 queued`; nil once it has ended or while
    /// neither is true.
    public let live: String?
    /// Why it did not finish, for one that ended any other way than DONE.
    public let error: String?
    public let sections: [Section]

    public var running: Bool { state == .running }
    public var calls: [Call] { sections.flatMap(\.calls) }

    /// `nested` is what the transcript keeps under the workflow call (`TranscriptState.subagentItems`);
    /// `run` reads a call's SubAgent run by its tool_use id. `backgroundRunning` is the transcript's own
    /// word that the work goes on, used only before the server's view is read.
    public static func describe(card: ToolCard, workflow: WorkflowRunView?, nested: [TranscriptItem],
                                run: (String) -> SubagentRunView?, backgroundRunning: Bool = false) -> WorkflowBlock {
        let state = self.state(card: card, workflow: workflow, backgroundRunning: backgroundRunning)
        var calls: [Call] = []
        for item in nested {
            guard case .toolCall(let child) = item, child.name == SubagentBlock.toolName else { continue }
            calls.append(call(child, run: run(child.id), workflowEnded: state != .running))
        }
        let ended = calls.filter { $0.state == .done || $0.state == .failed }.count
        let runningCalls = calls.filter { $0.state == .running }.count
        let queuedCalls = calls.filter { $0.state == .queued }.count
        // Once it has ended, the runner's report counts every call, those older than the transcript's window too.
        let doneCount = workflow.map { $0.isRunning ? max(ended, $0.callsDone + $0.callsFailed) : $0.callsDone + $0.callsFailed } ?? ended
        let started = max(calls.count, doneCount)
        // What the ended calls reported, as the server counts it while the workflow runs.
        let cost = workflow?.costUsd ?? calls.reduce(0) { sum, call in
            guard let r = run(call.id), !r.isRunning else { return sum }
            return sum + r.costUsd
        }

        var parts: [String] = []
        if state == .running, let phase = currentPhase(calls) { parts.append(phase) }
        parts.append("\(doneCount) of \(started)")
        parts.append(money(cost, limit: workflow?.maxCostUsd))

        var live: [String] = []
        if state == .running {
            if runningCalls > 0 { live.append("\(runningCalls) running") }
            if queuedCalls > 0 { live.append("\(queuedCalls) queued") }
        }

        let error = state == .running || state == .done ? nil : nonEmpty(workflow?.error)
        return WorkflowBlock(
            title: nonEmpty(card.input["description"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines))
                ?? nonEmpty(workflow?.description) ?? nonEmpty(workflow?.name)
                ?? scriptName(card.input["script"]?.stringValue) ?? "",
            state: state,
            progress: parts.joined(separator: " · "),
            live: live.isEmpty ? nil : live.joined(separator: ", "),
            error: error,
            sections: sections(calls, phases: workflow?.phases ?? [], workflowRunning: state == .running))
    }

    /// `$0.84`, or `$0.84 of $5.00` when the call set a limit.
    public static func money(_ cost: Double, limit: Double?) -> String {
        let spent = String(format: "$%.2f", cost)
        guard let limit else { return spent }
        return spent + " of " + String(format: "$%.2f", limit)
    }

    private static func state(card: ToolCard, workflow: WorkflowRunView?, backgroundRunning: Bool) -> State {
        if let workflow {
            switch workflow.status {
            case "RUNNING": return .running
            case "DONE": return .done
            case "FAILED": return .failed
            default: return .stopped
            }
        }
        // Before the server's view is read: the call refused, or its work still going.
        if card.status == .error { return .failed }
        if card.status == .running || backgroundRunning { return .running }
        return .done
    }

    private static func call(_ card: ToolCard, run: SubagentRunView?, workflowEnded: Bool) -> Call {
        let state: CallState
        if let run {
            state = run.isRunning ? .running : run.status == "DONE" ? .done : .failed
        } else if card.status == .running {
            // A call whose run never opened, of a workflow that ended, did not run at all.
            state = workflowEnded ? .failed : .queued
        } else {
            state = card.status == .error ? .failed : .done
        }
        var result: String?
        if state == .done || state == .failed {
            let block = SubagentBlock.describe(input: card.input, run: run, status: card.status,
                                               result: SubagentResult.text(callResult: card.result, run: run))
            result = block.outcomeIsFiles || state == .done ? block.outcome : nil
        }
        return Call(
            id: card.id,
            label: nonEmpty(run?.label) ?? nonEmpty(card.input["description"]?.stringValue)
                ?? nonEmpty(run?.type) ?? nonEmpty(card.input["type"]?.stringValue) ?? "agent",
            result: result,
            state: state,
            phase: nonEmpty(run?.phase) ?? nonEmpty(card.input["workflow_phase"]?.stringValue),
            card: card)
    }

    /// The phase the work is in: the newest call still running or queued, else the newest call's.
    private static func currentPhase(_ calls: [Call]) -> String? {
        calls.last(where: { $0.state == .running || $0.state == .queued })?.phase ?? calls.last?.phase
    }

    /// The calls by phase: the script's phases in the order its meta lists them, then any other phase in
    /// the order its first call came, then the calls with none.
    private static func sections(_ calls: [Call], phases: [String], workflowRunning: Bool) -> [Section] {
        var order: [String?] = []
        for phase in phases where calls.contains(where: { $0.phase == phase }) { order.append(phase) }
        for call in calls where !order.contains(call.phase) { order.append(call.phase) }
        if order.count > 1, let none = order.firstIndex(where: { $0 == nil }) { order.append(order.remove(at: none)) }
        let last = order.last
        return order.map { phase in
            let members = calls.filter { $0.phase == phase }
            let ended = members.filter { $0.state == .done || $0.state == .failed }.count
            let running = members.filter { $0.state == .running }.count
            let queued = members.filter { $0.state == .queued }.count
            var counts: [String] = []
            if ended > 0 || (running == 0 && queued == 0) { counts.append("\(ended) done") }
            if running > 0 { counts.append("\(running) running") }
            if queued > 0 { counts.append("\(queued) queued") }
            // A phase that is over, while the work goes on in a later one, gives its room to the live one.
            let folds = workflowRunning && phase != last && running == 0 && queued == 0 && members.count > 3
            let shown = folds ? 2 : members.count
            return Section(title: phase, header: ([phase].compactMap { $0 } + counts).joined(separator: " · "),
                           calls: members, shown: shown,
                           more: folds ? "\(members.count - shown) more" : nil)
        }
    }

    /// The `name` of the script's leading `export const meta = { name: '…' }`, when it is a plain string.
    static func scriptName(_ script: String?) -> String? {
        guard let script,
              let re = try? NSRegularExpression(pattern: #"meta\s*=\s*\{[^}]*?\bname\s*:\s*(['"`])([^'"`]+)\1"#),
              let m = re.firstMatch(in: script, range: NSRange(script.startIndex..., in: script)),
              let r = Range(m.range(at: 2), in: script) else { return nil }
        return String(script[r])
    }
}

/// What moves a session's workflows: each workflow call and its result, each call the script made under
/// it and the call's result, and the first event of each call's SubAgent (its run opened). Empty when the
/// transcript holds no workflow, so a session that never ran one reads nothing (web parity:
/// `workflowRunsSignature`).
public enum WorkflowRuns {
    public static func signature(items: [TranscriptItem], nested: [String: [TranscriptItem]],
                                 background: [BackgroundProc]) -> String {
        var parts: [String] = []
        for item in items {
            guard case .toolCall(let card) = item, card.name == WorkflowBlock.toolName else { continue }
            parts.append("\(card.id):\(card.status.rawValue)")
            for row in background where row.id == card.id { parts.append("\(row.id):\(row.status)") }
            for case .toolCall(let call) in nested[card.id] ?? [] where call.name == SubagentBlock.toolName {
                let opened = (nested[call.id]?.isEmpty == false) ? "o" : "-"
                parts.append("\(call.id):\(call.status.rawValue):\(opened)")
            }
        }
        return parts.joined(separator: ",")
    }
}

// MARK: - the finished strip

/// One workflow's end, as the `<orbit-workflow-finished>` block the control plane opens a turn with spells
/// it (apiserver `buildWorkflowFinishedBlock`, runner-api/background-job-wake.ts):
///
///     <orbit-workflow-finished>
///       Workflow <name>[ — <description>] (run <id>) finished: <STATUS>
///       [why an interrupted one stopped]
///         Calls done: <n>, failed: <m>. Cost: $<x>.
///         [Error: …] [Result: …]
///       <one sentence for the agent>
///     </orbit-workflow-finished>
public struct WorkflowFinishedRun: Equatable, Sendable {
    public let runId: String
    public let name: String
    public let description: String?
    /// `DONE` | `FAILED` | `STOPPED` | `INTERRUPTED`.
    public let status: String
    public let callsDone: Int?
    public let callsFailed: Int?
    public let costUsd: Double?
}

public struct WorkflowFinished: Equatable, Sendable {
    public let runs: [WorkflowFinishedRun]
    /// The block itself, exactly as the agent received it.
    public let text: String
    /// Whatever else the same note carried, for the lines that draw it.
    public let rest: String
}

public enum WorkflowFinishedText {
    private static let block = try? NSRegularExpression(
        pattern: "<orbit-workflow-finished>\\n([\\s\\S]*?)\\n</orbit-workflow-finished>")
    private static let head = try? NSRegularExpression(
        pattern: "^ {2}Workflow (.+?)(?: — (.+))? \\(run (\\S+)\\) finished: (DONE|FAILED|STOPPED|INTERRUPTED)$",
        options: [.anchorsMatchLines])
    private static let stats = try? NSRegularExpression(
        pattern: "^ {4}Calls done: (\\d+), failed: (\\d+)\\. Cost: \\$([0-9.]+)\\.$", options: [.anchorsMatchLines])

    /// The workflow blocks in a control plane note, or nil for a note carrying none it can read.
    public static func parse(_ note: String?) -> WorkflowFinished? {
        guard let note, note.contains("<orbit-workflow-finished>"), let block, let head, let stats else { return nil }
        var runs: [WorkflowFinishedRun] = []
        var blocks: [String] = []
        var rest = ""
        var end = note.startIndex
        for match in block.matches(in: note, range: NSRange(note.startIndex..., in: note)) {
            guard let whole = Range(match.range, in: note), let bodyRange = Range(match.range(at: 1), in: note) else {
                return nil
            }
            let body = String(note[bodyRange])
            let ns = NSRange(body.startIndex..., in: body)
            let heads = head.matches(in: body, range: ns)
            // A block with no head it can read is a note it cannot read: never a strip that drops a run.
            guard !heads.isEmpty else { return nil }
            for (i, h) in heads.enumerated() {
                func group(_ n: Int) -> String? { Range(h.range(at: n), in: body).map { String(body[$0]) } }
                // This run's lines reach to the next run's head.
                let upper = i + 1 < heads.count ? heads[i + 1].range.location : ns.length
                let span = NSRange(location: h.range.location, length: upper - h.range.location)
                let s = stats.firstMatch(in: body, range: span)
                func stat(_ n: Int) -> String? { s.flatMap { Range($0.range(at: n), in: body) }.map { String(body[$0]) } }
                runs.append(WorkflowFinishedRun(
                    runId: group(3) ?? "", name: group(1) ?? "", description: group(2), status: group(4) ?? "",
                    callsDone: stat(1).flatMap(Int.init), callsFailed: stat(2).flatMap(Int.init),
                    costUsd: stat(3).flatMap(Double.init)))
            }
            rest += note[end..<whole.lowerBound]
            end = whole.upperBound
            blocks.append(String(note[whole]))
        }
        if runs.isEmpty { return nil }
        return WorkflowFinished(runs: runs, text: blocks.joined(separator: "\n\n"),
                                rest: (rest + note[end...]).trimmingCharacters(in: .whitespacesAndNewlines))
    }
}

/// The finished strip (board part 4 ②): a pale purple strip, the parent's answer under it.
public struct WorkflowFinishedStrip: Equatable, Sendable {
    /// `Workflow finished`, or how it ended otherwise.
    public let title: String
    /// `12 calls · 1 failed · 6m 40s · $1.37`.
    public let line: String
    public let failed: Bool

    /// `workflow` is the server's view of the same run, when read: its numbers and its time win over
    /// the block's.
    public static func describe(_ run: WorkflowFinishedRun, workflow: WorkflowRunView?) -> WorkflowFinishedStrip {
        let title: String
        switch run.status {
        case "DONE": title = "Workflow finished"
        case "FAILED": title = "Workflow failed"
        case "INTERRUPTED": title = "Workflow interrupted"
        default: title = "Workflow stopped"
        }
        let done = workflow?.callsDone ?? run.callsDone ?? 0
        let failed = workflow?.callsFailed ?? run.callsFailed ?? 0
        var parts = [done + failed == 1 ? "1 call" : "\(done + failed) calls"]
        if failed > 0 { parts.append("\(failed) failed") }
        if let workflow, let endedAt = workflow.endedAt,
           let start = RelativeTime.parse(workflow.createdAt), let end = RelativeTime.parse(endedAt) {
            parts.append(WikiRunsLogic.duration(end.timeIntervalSince(start)))
        }
        if let cost = workflow?.costUsd ?? run.costUsd { parts.append(WorkflowBlock.money(cost, limit: workflow?.maxCostUsd)) }
        return WorkflowFinishedStrip(title: title, line: parts.joined(separator: " · "), failed: run.status != "DONE")
    }

    /// The server's view of the run a block names, whichever way each spells its id.
    public static func workflow(for run: WorkflowFinishedRun, in workflows: [WorkflowRunView]) -> WorkflowRunView? {
        let key = PublicID.storageKey(run.runId)
        return workflows.first { PublicID.storageKey($0.id) == key }
    }
}

private func nonEmpty(_ value: String?) -> String? {
    guard let value, !value.isEmpty else { return nil }
    return value
}
