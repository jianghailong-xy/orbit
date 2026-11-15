import Foundation

// The turn the control plane opens when a SubAgent ends.
//
// A turn nobody typed: a SubAgent (`delegate`) ended and the control plane opened a turn in its
// parent to hand over how it ended and what it said. Like a background job's wake (`BackgroundWake`)
// the turn's own content is empty and the block is the control plane's note, built by the apiserver's
// `buildSubagentFinishedBlock` (runner-api/background-job-wake.ts):
//
//     <orbit-subagent-finished>
//       SubAgent <description> (run <id>) finished: <STATUS>
//       <why it ended, for a run that did not finish>
//       Result:
//         <the result, four spaces in>          — or —   (no result)
//       … the next run …
//       <two sentences for the agent>
//     </orbit-subagent-finished>
//
// The web reads the same note with `parseSubagentFinished` (src/web/src/lib/subagentFinished.ts) and
// draws it as `SubagentFinishedCard.tsx`. This is that rule for iOS and macOS;
// `SubagentFinishedCopyParityTests` holds the two to each other. A wording this does not recognise
// parses as nothing at all rather than half a line: the note then stays the entry it has always been.

/// One run's end, as the block spells it out.
public struct SubagentFinishedRun: Equatable, Sendable {
    public let runId: String
    /// The `delegate` call's description (or what the block names a run without one by).
    public let description: String
    /// `DONE` | `FAILED` | `STOPPED` | `INTERRUPTED`.
    public let status: String
    /// Why a run that did not finish ended, as the control plane put it; nil for DONE.
    public let reason: String?
    /// What it handed back, back at column zero; empty where the block said there was none.
    public let result: String

    public init(runId: String, description: String, status: String, reason: String?, result: String) {
        self.runId = runId
        self.description = description
        self.status = status
        self.reason = reason
        self.result = result
    }
}

public struct SubagentFinished: Equatable, Sendable {
    public let runs: [SubagentFinishedRun]
    /// The block itself, exactly as the agent received it.
    public let text: String
    /// Whatever else the same note carried: not the line's to draw, it stays a folded entry.
    public let rest: String
}

/// Reading the SubAgent blocks in a control plane note, and nothing else. Every pattern is the
/// browser's, character for character (`SubagentFinishedCopyParityTests`).
public enum SubagentFinishedText {
    static let blockPattern = "<orbit-subagent-finished>\\n([\\s\\S]*?)\\n<\\/orbit-subagent-finished>"
    /// `SubAgent <description> (run <id>) finished: <STATUS>` — the description may hold brackets of its own.
    static let headPattern = "^ {2}SubAgent (.+) \\(run (\\S+)\\) finished: (DONE|FAILED|STOPPED|INTERRUPTED)$"
    /// A line at the block's own indent, not inside a result.
    static let sentencePattern = "^ {2}(?! )(.+)$"

    private static let block = try? NSRegularExpression(pattern: blockPattern)
    private static let head = try? NSRegularExpression(pattern: headPattern)
    private static let sentence = try? NSRegularExpression(pattern: sentencePattern)

    /// Whether a note carries a SubAgent's end the transcript draws as a line — `parse(note) != nil`,
    /// answered once per distinct note, for the sticky bar's every step (as `BackgroundWakeText.carriesWake`).
    public static func carriesWake(_ note: String?) -> Bool {
        guard let note, note.contains("<orbit-subagent-finished>") else { return false }
        let key = note as NSString
        if let known = readings.object(forKey: key) { return known.boolValue }
        let found = parse(note) != nil
        readings.setObject(NSNumber(value: found), forKey: key)
        return found
    }

    private static let readings: NSCache<NSString, NSNumber> = {
        let cache = NSCache<NSString, NSNumber>()
        cache.countLimit = 1024
        return cache
    }()

    /// The SubAgent block in a control plane note, or nil for a note carrying none it can read.
    public static func parse(_ note: String?) -> SubagentFinished? {
        guard let note, note.contains("<orbit-subagent-finished>"), let block else { return nil }
        var runs: [SubagentFinishedRun] = []
        var blocks: [String] = []
        var rest = ""
        var end = note.startIndex
        for match in block.matches(in: note, range: NSRange(note.startIndex..., in: note)) {
            guard let whole = Range(match.range, in: note), let body = Range(match.range(at: 1), in: note) else {
                return nil
            }
            // One block it cannot read is a note it cannot read: never a line that drops a run.
            guard let parsed = parseRuns(String(note[body])) else { return nil }
            rest += note[end..<whole.lowerBound]
            end = whole.upperBound
            blocks.append(String(note[whole]))
            runs += parsed
        }
        if runs.isEmpty { return nil }
        let trailing = (rest + note[end...])
            .replacingOccurrences(of: "\\n{3,}", with: "\n\n", options: .regularExpression)
        return SubagentFinished(runs: runs, text: blocks.joined(separator: "\n\n"),
                                rest: trailing.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private enum At { case start, head, result, ended, closing }

    /// Each run in a block, read line by line; nil on any line the shape has no place for.
    private static func parseRuns(_ body: String) -> [SubagentFinishedRun]? {
        var runs: [SubagentFinishedRun] = []
        // The run being read: its head's fields, its reason, its result lines.
        var current: (runId: String, description: String, status: String, reason: String?)?
        var result: [String] = []
        // Where the reading is: just past a run's head, inside its result, past its result, or in the
        // sentences closing the block (which are the agent's and never shown outside the raw block).
        var at = At.start
        func close() {
            if let run = current {
                runs.append(SubagentFinishedRun(runId: run.runId, description: run.description,
                                                status: run.status, reason: run.reason,
                                                result: trimmingTrailingWhitespace(result.joined(separator: "\n"))))
            }
            current = nil
            result = []
        }
        for line in body.components(separatedBy: "\n") {
            // A blank line of the result is four spaces, unless something on the way trimmed it.
            if at == .result && (line.hasPrefix("    ") || line.isEmpty) {
                result.append(String(line.dropFirst(4)))
                continue
            }
            if at == .closing {
                if !matches(sentence, line) { return nil }
                continue
            }
            if let fields = groups(head, line), at != .head {
                close()
                current = (runId: fields[1], description: fields[0], status: fields[2], reason: nil)
                at = .head
                continue
            }
            if at == .head, let run = current {
                if line == "  Result:" {
                    at = .result
                } else if line == "  (no result)" {
                    at = .ended
                } else if run.reason == nil && run.status != "DONE" && matches(sentence, line) {
                    current?.reason = String(line.dropFirst(2))
                } else {
                    return nil
                }
                continue
            }
            if (at == .result || at == .ended) && matches(sentence, line) {
                close()
                at = .closing
                continue
            }
            return nil
        }
        // A block cut off before a run said how its result reads is not one this knows.
        if at == .start || at == .head { return nil }
        close()
        return runs
    }

    /// The run a `delegate` call's result names — its launch receipt's or its end's — or nil before it
    /// has one. Web parity: `delegateRunId` (lib/subagentRuns.ts).
    public static func delegateRunId(_ result: String?) -> String? {
        guard let data = result?.trimmingCharacters(in: .whitespacesAndNewlines).data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let runId = object["runId"] as? String, !runId.isEmpty else { return nil }
        return runId
    }

    private static func groups(_ re: NSRegularExpression?, _ text: String) -> [String]? {
        guard let re, let match = re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else {
            return nil
        }
        return (1..<match.numberOfRanges).map { i in
            Range(match.range(at: i), in: text).map { String(text[$0]) } ?? ""
        }
    }

    private static func matches(_ re: NSRegularExpression?, _ text: String) -> Bool {
        guard let re else { return false }
        return re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }

    private static func trimmingTrailingWhitespace(_ text: String) -> String {
        var out = text
        while let last = out.last, last.isWhitespace { out.removeLast() }
        return out
    }
}

/// What the line says, in the browser's words (`SubagentFinishedCard.tsx`): one event line in the
/// agent's stream — purple ✦, what happened, which run, how it ended, when — the result's first three
/// lines under it, and a fold with the run, its card, who queued the turn and what the agent read.
public enum SubagentFinishedCard {
    /// Whether a run came to its end on its own.
    public static func isOk(_ run: SubagentFinishedRun) -> Bool { run.status == "DONE" }

    /// A lone run that did not finish: the whole line turns red.
    public static func isFailed(_ wake: SubagentFinished) -> Bool {
        wake.runs.count == 1 && !isOk(wake.runs[0])
    }

    /// What happened, at a glance: one run's end, or how many ended.
    public static func title(_ wake: SubagentFinished) -> String {
        if wake.runs.count > 1 { return "\(wake.runs.count) SubAgents finished" }
        return isOk(wake.runs[0]) ? "SubAgent finished" : "SubAgent did not finish"
    }

    /// The word chip the line closes on: the one run's end, or how many of several did not finish.
    public static func status(_ wake: SubagentFinished) -> String {
        if wake.runs.count == 1 { return runStatus(wake.runs[0]) }
        let failed = wake.runs.filter { !isOk($0) }.count
        return failed > 0 ? "\(failed) of \(wake.runs.count) failed" : "done"
    }

    /// One run's end, as its chip says it.
    public static func runStatus(_ run: SubagentFinishedRun) -> String { run.status.lowercased() }

    /// What a lone run's line names after its title; several are counted by the title instead.
    public static func lineName(_ wake: SubagentFinished) -> String? {
        wake.runs.count == 1 ? wake.runs[0].description : nil
    }

    /// One of several runs, in one line: the first line it handed back, else why it ended, else
    /// `No result`.
    public static func runLine(_ run: SubagentFinishedRun) -> String {
        let first = run.result.components(separatedBy: "\n")
            .first { !$0.trimmingCharacters(in: .whitespaces).isEmpty } ?? ""
        if !first.isEmpty { return first }
        return run.reason ?? noResult
    }

    /// What the turn folds to in the exchange fold (`OrbitExchangeFold`): the title, and the run's name
    /// where there is one run.
    public static func foldWhat(_ wake: SubagentFinished) -> String {
        lineName(wake).map { "\(title(wake)): \($0)" } ?? title(wake)
    }

    public static let noResult = "No result"
    public static let showFullResult = "Show full result"
    public static let showLess = "Show less"
    public static let details = "Details"
    public static let run = "Run"
    public static let cardLink = "↑ Its SubAgent card"
    public static let changes = "Changes left in the working tree, uncommitted"
    public static let queuedBy = "Queued by a SubAgent, not typed by you"
    /// The fold the block itself stays behind: the only place its sentences for the agent are shown.
    public static let rawSummary = "What the agent read"
    /// How many lines of a result show before `Show full result`.
    public static let previewLines = 3
}
