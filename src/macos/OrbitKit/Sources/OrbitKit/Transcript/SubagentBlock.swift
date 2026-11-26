import Foundation

/// Orbit's own Agent — a `mcp__orbit__delegate` call (docs/subagent-design.md §6.4; the design calls it a
/// SubAgent, the product says Agent) — as the transcript's block draws it. UI-free so the words stay
/// unit-testable and both native clients draw them the same (board docs/mocks/subagent-ios-highlight).
///
/// The folded block has three lines. The first is the row: `Agent`, the call's description, the status.
/// The second says who did the work and where: the engine and model it ran on — led by the parent's
/// engine and an arrow when Orbit moved the work to another one — then the tier and the type
/// (`Background` in the type's place), `Read-only`, and `on <workspace>` for a run on another machine.
/// The third says what came of it: how many files it changed, or the first line it handed back, with
/// how long it took (no cost); while it runs, the view draws what it is on instead.
public struct SubagentBlock: Equatable, Sendable {
    public static let toolName = "mcp__orbit__delegate"
    /// What the block's row calls it.
    public static let label = "Agent"

    /// `explore`, `general`, or a definition file's name; `general` when the call named none.
    public let type: String
    public let background: Bool
    /// The engine the run is on (`codex`), for the chip's colour; nil until the run is read, and from a
    /// server before it sent one.
    public let engine: String?
    /// The chip's words: the engine's short name and the model (`Codex gpt-6.1-sol`), either alone when
    /// the other is unknown. Nil when neither is known yet.
    public let engineName: String?
    public let model: String?
    /// The model's own name already says the engine (`DeepSeek Chat` on DeepSeek): the chip then shows
    /// the engine's mark and the model, not the name twice.
    public let modelNamesEngine: Bool
    /// The parent's engine, by its short name, when the run is on another one: the chip's `Claude →`.
    public let fromEngine: String?
    /// The tier and the type, grey after the chip: `S · explore`, `M · Background`, or the type alone.
    public let meta: String
    public let readonly: Bool
    /// `on orbit-macos` for a run on another workspace.
    public let workspace: String?
    /// The third line once the run has ended: `3 files changed`, the first line it handed back, or how
    /// it ended (`Failed`) — nil while it runs and when it handed back nothing.
    public let outcome: String?
    /// The outcome is the files it changed, drawn in the primary weight.
    public let outcomeIsFiles: Bool
    /// The run did not finish (failed or interrupted; a stop is no failure): the outcome is how it
    /// ended, drawn in red.
    public let outcomeIsFailure: Bool
    /// `41s`, once the run has ended. The run's cost is left out.
    public let numbers: String?
    /// The opened block's Why line: the server's one-line Why, or, from a server or a row from before
    /// it was kept, the router's reasons in order, joined. A run on another workspace leads with how
    /// that workspace was chosen. Nil when there is neither (web parity: `subagentWhy`).
    public let why: String?
    /// What the Why line's Details open to: every reason the router gave (none when the Why line is
    /// already those reasons), then every candidate it removed as `Removed · <provider>: <reason>`
    /// (web parity: `subagentWhyDetails` and its list). Empty when there is nothing more to show.
    public let details: [String]
    /// The paths the run wrote, for the opened block's Changed files; empty for a read-only run.
    public let changedFiles: [String]
    /// Whether the run is still going (a background call answers at once, so its card's status is
    /// already `ok` while the work goes on).
    public let running: Bool
    /// When the run started, for the running line's clock.
    public let startedAt: Date?

    /// `result` is what the opened block ends with (`SubagentResult.text`), whose first line the third
    /// line shows; `parentEngine` is the session's own engine.
    public static func describe(input: JSONValue, run: SubagentRunView?, status: ToolStatus,
                                parentEngine: String? = nil, result: String? = nil) -> SubagentBlock {
        let callType = nonEmpty(input["type"]?.stringValue) ?? "general"
        let type = nonEmpty(run?.type) ?? callType
        let background = run?.background ?? (input["background"]?.boolValue == true)
        let running = run?.isRunning ?? (status == .running)
        let readonly = run?.readonly ?? false
        let engine = nonEmpty(run?.engine)
        let model = nonEmpty(run?.modelLabel) ?? nonEmpty(run?.model)
        let fromEngine: String? = {
            guard let engine, let parent = nonEmpty(parentEngine), parent != engine else { return nil }
            return shortName(parent)
        }()
        let meta = ([nonEmpty(run?.level), background ? "Background" : type] as [String?])
            .compactMap { $0 }.joined(separator: " · ")
        let files = readonly ? [] : (run?.changedFiles ?? [])

        var outcome: String?
        var isFiles = false
        var isFailure = false
        if let run, !running {
            switch run.status {
            case "DONE":
                if !files.isEmpty {
                    outcome = files.count == 1 ? "1 file changed" : "\(files.count) files changed"
                    isFiles = true
                } else {
                    outcome = firstLine(result)
                }
            case "FAILED": outcome = "Failed"; isFailure = true
            case "INTERRUPTED": outcome = "Interrupted"; isFailure = true
            // Stopped on purpose: grey, and no failure (board docs/mocks/subagent-card-and-end-line D1).
            case "STOPPED": outcome = "Stopped"
            default: outcome = firstLine(result)
            }
        }
        let numbers = duration(run) ?? ""

        return SubagentBlock(
            type: type,
            background: background,
            engine: engine,
            engineName: engine.map(shortName),
            model: model,
            modelNamesEngine: {
                guard let engine, let model else { return false }
                return model.lowercased().hasPrefix(shortName(engine).lowercased())
            }(),
            fromEngine: fromEngine,
            meta: meta,
            readonly: readonly,
            workspace: nonEmpty(run?.workspaceName).map { "on \($0)" },
            outcome: outcome,
            outcomeIsFiles: isFiles,
            outcomeIsFailure: isFailure,
            numbers: numbers.isEmpty ? nil : numbers,
            why: why(run),
            details: details(run),
            changedFiles: files,
            running: running,
            startedAt: run.flatMap { RelativeTime.parse($0.createdAt) },
        )
    }

    /// The engine as the chip says it: short, since the model follows it.
    public static func shortName(_ engine: String) -> String {
        switch engine {
        case "claude": return "Claude"
        case "codex": return "Codex"
        case "kimi": return "Kimi"
        case "antigravity": return "Antigravity"
        case "opencode": return "OpenCode"
        case "dsh": return "DeepSeek"
        case "cursor": return "Cursor"
        default: return ProviderEngines.cliName(engine)
        }
    }

    /// The running line's numbers: how long it has run and how many steps it has taken (`1m 12s · 9 steps`).
    public static func runningNumbers(elapsed: TimeInterval?, steps: Int) -> String? {
        var parts: [String] = []
        if let elapsed { parts.append(WikiRunsLogic.duration(elapsed)) }
        if steps > 0 { parts.append(steps == 1 ? "1 step" : "\(steps) steps") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// The steps an Agent has taken: the calls in its own transcript.
    public static func steps(_ items: [TranscriptItem]) -> Int {
        items.reduce(0) { n, item in
            if case .toolCall = item { return n + 1 }
            return n
        }
    }

    private static func firstLine(_ text: String?) -> String? {
        guard let text else { return nil }
        for line in text.split(whereSeparator: \.isNewline) {
            var clean = line.trimmingCharacters(in: .whitespaces)
            while let first = clean.first, "#>*-".contains(first) {
                clean = String(clean.dropFirst()).trimmingCharacters(in: .whitespaces)
            }
            // `{`, `]`, a code fence: the shape of what came back, not a word of it.
            if !clean.isEmpty, !isStructural(clean) { return clean }
        }
        return nil
    }

    private static func isStructural(_ line: String) -> Bool {
        line.hasPrefix("```") || line.allSatisfy { "{}[](),:".contains($0) }
    }

    private static func why(_ run: SubagentRunView?) -> String? {
        guard let run else { return nil }
        let reasons = run.reasons.filter { !$0.isEmpty }
        guard let why = nonEmpty(run.why) ?? (reasons.isEmpty ? nil : reasons.joined(separator: " · ")) else {
            return nil
        }
        // A run on another workspace leads with how that workspace was chosen: its first reason.
        if nonEmpty(run.workspaceName) != nil, let chosen = nonEmpty(run.reasons.first), !why.hasPrefix(chosen) {
            return "\(chosen) · \(why)"
        }
        return why
    }

    private static func details(_ run: SubagentRunView?) -> [String] {
        guard let run else { return [] }
        let reasons = nonEmpty(run.why) == nil ? [] : run.reasons.filter { !$0.isEmpty }
        let removed = (run.removed ?? []).map { c -> String in
            var line = c.provider
            if let engine = nonEmpty(c.engine), engine != c.provider { line += " (" + engine + ")" }
            if let model = nonEmpty(c.model) {
                line += ", " + model
                if let effort = nonEmpty(c.effort) { line += " · " + effort }
            }
            return "Removed · " + line + ": " + c.reason
        }
        return reasons + removed
    }

    /// How long the run took, once it has ended. A run still going has no duration to show yet.
    public static func duration(_ run: SubagentRunView?) -> String? {
        guard let run, !run.isRunning, let endedAt = run.endedAt,
              let start = RelativeTime.parse(run.createdAt), let end = RelativeTime.parse(endedAt) else {
            return nil
        }
        return WikiRunsLogic.duration(end.timeIntervalSince(start))
    }
}

/// What a SubAgent handed back: a foreground call's result is `{ runId, status, result, … }`; a
/// background call's is only its receipt, so its result comes from the run once that has ended.
public enum SubagentResult {
    /// The text the opened block ends with, or nil while there is nothing to show (a background
    /// call's receipt says only that the work started). Anything unrecognised is shown as it came.
    public static func text(callResult: String?, run: SubagentRunView?) -> String? {
        guard let text = callResult?.trimmingCharacters(in: .whitespacesAndNewlines),
              !text.isEmpty else {
            return endedSummary(run)
        }
        guard let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            // The call's JSON clipped to a preview (the server trims a long result): the run's own
            // text, never the receipt's opening brace.
            if text.hasPrefix("{") { return endedSummary(run) }
            return text
        }
        if let handedBack = object["result"] as? String, !handedBack.isEmpty { return handedBack }
        if let summary = endedSummary(run) { return summary }
        // A launch receipt (`{ runId, status: "running" }`): the work is drawn, not this.
        if object["runId"] != nil { return nil }
        return text
    }

    private static func endedSummary(_ run: SubagentRunView?) -> String? {
        guard let run, !run.isRunning else { return nil }
        return nonEmpty(run.resultSummary)
    }
}

/// What moves a session's SubAgent runs: each top-level `delegate` call and its result, and the
/// terminal `background_task` a background run ends with. Empty when the transcript holds no delegate
/// call, so a session that never delegated reads nothing (web parity: `delegateRunsSignature`).
public enum SubagentRuns {
    public static func signature(items: [TranscriptItem], background: [BackgroundProc]) -> String {
        var parts: [String] = []
        var calls: Set<String> = []
        for item in items {
            guard case .toolCall(let card) = item, card.name == SubagentBlock.toolName else { continue }
            calls.insert(card.id)
            parts.append("\(card.id):\(card.status.rawValue):\(card.resultSeq.map(String.init) ?? "-")")
        }
        for row in background where calls.contains(row.id) {
            parts.append("\(row.id):\(row.status)")
        }
        return parts.joined(separator: ",")
    }
}

private func nonEmpty(_ value: String?) -> String? {
    guard let value, !value.isEmpty else { return nil }
    return value
}

/// Agents started together — two or more `delegate` calls one after another, with nothing said between
/// them — drawn as one group: a head that adds them up, then a two-line row for each (board 02).
public struct SubagentGroup: Equatable, Sendable {
    /// `3 Agents`.
    public let title: String
    /// `2 of 3 done`, or `All done` / `1 failed` once none is running.
    public let progress: String
    /// The engines the work moved to, led by the parent's (`Claude → Codex, DeepSeek`); nil when all of
    /// them ran on the parent's own engine.
    public let engines: String?
    /// `2 machines` when some ran on another workspace.
    public let machines: String?
    /// How many ended well, how many failed, how many still run: the head's bar.
    public let done: Int
    public let failed: Int
    public let running: Int

    public static func describe(_ blocks: [SubagentBlock], runs: [SubagentRunView?],
                                parentEngine: String?) -> SubagentGroup {
        let running = blocks.filter(\.running).count
        let failed = blocks.filter(\.outcomeIsFailure).count
        let done = blocks.count - running - failed
        let progress: String
        if running > 0 {
            progress = "\(done + failed) of \(blocks.count) done"
        } else if failed > 0 {
            progress = failed == 1 ? "1 failed" : "\(failed) failed"
        } else {
            progress = "All done"
        }
        var moved: [String] = []
        for block in blocks {
            guard let engine = block.engine, engine != parentEngine else { continue }
            let name = SubagentBlock.shortName(engine)
            if !moved.contains(name) { moved.append(name) }
        }
        let engines = moved.isEmpty ? nil
            : (parentEngine.map { "\(SubagentBlock.shortName($0)) → " } ?? "") + moved.joined(separator: ", ")
        let places = Set(runs.map { $0?.workspaceName ?? "" })
        let machines = places.count > 1 ? "\(places.count) machines" : nil
        return SubagentGroup(title: "\(blocks.count) Agents", progress: progress, engines: engines,
                             machines: machines, done: done, failed: failed, running: running)
    }
}

/// Every Agent a session started, as the console's capsule counts them and its sheet lists them (board 03),
/// and where their work went (docs/mocks/agents-band-models): the web's `subagentSessionSummary`.
/// It carries no cost: the owner does not want what the Agents spent shown on the band or in the sheet.
public struct SubagentSessionSummary: Equatable, Sendable {
    public let count: Int
    public let running: Int
    /// `4`: the capsule's words after its mark.
    public let capsule: String
    /// The runs, the running ones first, then the rest newest first.
    public let rows: [SubagentRunView]
    /// The models the runs took, most runs first.
    public let models: [ModelCount]
    /// Every place the runs ran, most runs first; the session's own machine is `name: nil`.
    public let machines: [MachineCount]
    /// Whether any run went to another workspace.
    public let elsewhere: Bool
    /// Whether any run went to another workspace or another model than the session's: the band shows
    /// where the work went only then, so a session whose Agents all ran on its own model and machine
    /// stays quiet.
    public let spread: Bool
    /// Whether the newest running run took the session's own engine and model (true while none runs):
    /// otherwise the band names its model when it ran on this machine.
    public let currentIsOwnModel: Bool

    public struct ModelCount: Equatable, Sendable {
        public let label: String
        /// Gives the chip its mark; nil when neither the run nor the session says.
        public let engine: String?
        public let count: Int
    }

    public struct MachineCount: Equatable, Sendable {
        public let name: String?
        public let count: Int
    }

    /// The newest running run, which the band names while one runs; nil while none does.
    public var current: SubagentRunView? { rows.first(where: \.isRunning) }

    /// The composer band's words after "Agents". While one runs it says what that one is doing, by
    /// its `delegate` description ("Deploy dacad7403 to production"); several running lead with how
    /// many ("2 running · Deploy …"), naming the newest. A running run with no description keeps the
    /// counts ("2 · 1 running"). With none running it is the count alone: the models and machines say
    /// what was done, and each run's title is on its row in the sheet. The session list's row says the
    /// same thing in its own words (`SessionLine.subagentRunningLine`).
    public var band: String {
        guard running > 0 else { return "\(count)" }
        let newest = Self.described(current)
        if newest.isEmpty { return "\(count) · \(running) running" }
        return running > 1 ? "\(running) running · \(newest)" : newest
    }

    /// What VoiceOver says for the band: "Agents: 12, 4 machines, Opus 5.5 9 runs".
    public var spoken: String {
        var parts = ["Agents: \(band)"]
        if running > 0 {
            if let place = current?.workspaceName, !place.isEmpty { parts.append("on \(place)") }
        } else {
            if spread {
                if elsewhere { parts.append("\(machines.count) machines") }
                parts += models.map { "\($0.label) \($0.count == 1 ? "1 run" : "\($0.count) runs")" }
            }
        }
        return parts.joined(separator: ", ")
    }

    /// The model a run took, as its chip names it: the catalogue's label, the id, else its engine's name.
    public static func modelLabel(_ run: SubagentRunView) -> String? {
        nonEmpty(run.modelLabel) ?? nonEmpty(run.model) ?? nonEmpty(run.engine).map(SubagentBlock.shortName)
    }

    /// The model as the Agents sheet's row names it: the label without a trailing build number
    /// (`DeepSeek V4.1 Flash 1017` → `DeepSeek V4.1 Flash`). The block in the conversation keeps it.
    public static func sheetModelLabel(_ run: SubagentRunView) -> String? {
        guard let label = modelLabel(run) else { return nil }
        var words = label.split(separator: " ")
        if words.count > 1, let last = words.last, last.count >= 4, last.allSatisfy(\.isNumber) {
            words.removeLast()
        }
        return words.joined(separator: " ")
    }

    /// Whether a run took the session's own model: a shadow row (no engine of its own) runs on the
    /// parent's, and a run on the parent's engine with the parent's model is no different from it.
    static func ownModel(_ run: SubagentRunView, parentEngine: String?, parentModel: String?) -> Bool {
        guard let engine = nonEmpty(run.engine) else { return true }
        return engine == parentEngine && nonEmpty(run.model) == nonEmpty(parentModel)
    }

    private static func described(_ run: SubagentRunView?) -> String {
        run?.description?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        return value
    }

    /// Nil when the session started no Agent: the capsule then has no place for one. `parentEngine` and
    /// `parentModel` are the session's own: a run on both, on this machine, adds nothing to the band.
    public static func make(_ runs: [SubagentRunView], parentEngine: String? = nil,
                            parentModel: String? = nil) -> SubagentSessionSummary? {
        guard !runs.isEmpty else { return nil }
        let running = runs.filter(\.isRunning).count
        let rows = runs.filter(\.isRunning).sorted { $0.createdAt > $1.createdAt }
            + runs.filter { !$0.isRunning }.sorted { $0.createdAt > $1.createdAt }
        var models: [ModelCount] = []
        var machines: [MachineCount] = []
        // Oldest first, so a tie keeps the order the runs were started in.
        for run in rows.reversed() {
            if let label = modelLabel(run) {
                let engine = nonEmpty(run.engine) ?? parentEngine
                if let i = models.firstIndex(where: { $0.label == label && $0.engine == engine }) {
                    models[i] = ModelCount(label: label, engine: engine, count: models[i].count + 1)
                } else {
                    models.append(ModelCount(label: label, engine: engine, count: 1))
                }
            }
            let name = nonEmpty(run.workspaceName)
            if let i = machines.firstIndex(where: { $0.name == name }) {
                machines[i] = MachineCount(name: name, count: machines[i].count + 1)
            } else {
                machines.append(MachineCount(name: name, count: 1))
            }
        }
        let own = { (run: SubagentRunView) in ownModel(run, parentEngine: parentEngine, parentModel: parentModel) }
        let current = rows.first(where: \.isRunning)
        return SubagentSessionSummary(
            count: runs.count, running: running, capsule: "\(runs.count)", rows: rows,
            models: stableByCount(models), machines: stableByCount(machines),
            elsewhere: runs.contains { nonEmpty($0.workspaceName) != nil },
            spread: runs.contains { nonEmpty($0.workspaceName) != nil || !own($0) },
            currentIsOwnModel: current.map(own) ?? true)
    }

    /// Most first; a tie keeps its order (Swift's `sorted` is not guaranteed stable).
    private static func stableByCount<T>(_ list: [T]) -> [T] where T: HasCount {
        list.enumerated().sorted { a, b in
            a.element.count != b.element.count ? a.element.count > b.element.count : a.offset < b.offset
        }.map(\.element)
    }
}

protocol HasCount { var count: Int { get } }
extension SubagentSessionSummary.ModelCount: HasCount {}
extension SubagentSessionSummary.MachineCount: HasCount {}
