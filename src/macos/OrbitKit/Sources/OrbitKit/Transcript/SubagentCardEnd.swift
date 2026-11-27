import Foundation

/// How a background SubAgent's card ends (board docs/mocks/subagent-card-and-end-line, approved
/// 2026-11-20). Like Claude Code's built-in Agent, a SubAgent is one card from start to end: when its run
/// ends, the card's row turns into the end and the line under it into the ending. The turn the control
/// plane opened for the end (`<orbit-subagent-finished>`) draws nothing: the agent still reads that block
/// unchanged, and the card keeps it under `What the agent read`.
///
/// Web parity: `SubagentCardEnd.tsx`, whose words `SubagentFinishedCopyParityTests` holds these to.
public enum SubagentCardEnd {
    public enum Tone: Equatable, Sendable { case ok, failed, stopped }

    /// A run whose end the card draws: a background one that has ended. A foreground call is its own end.
    public static func ended(_ run: SubagentRunView?) -> SubagentRunView? {
        guard let run, run.background, !run.isRunning else { return nil }
        return run
    }

    /// Red for a run that did not finish; grey for one somebody stopped, which is no failure.
    public static func tone(_ status: String) -> Tone {
        status == "DONE" ? .ok : status == "STOPPED" ? .stopped : .failed
    }

    /// The word chip on the row: every end but DONE (`failed`, `interrupted`, `stopped`).
    public static func chip(_ status: String) -> String? {
        status == "DONE" ? nil : status.lowercased()
    }

    /// Why a run ended, said to the reader: the control plane says it to the agent in one fixed sentence
    /// per end (apiserver `ENDED_BECAUSE`), so the run's status is all the card needs. Nil for DONE.
    public static func because(_ status: String) -> String? {
        switch status {
        case "INTERRUPTED": return "The runner hosting it stopped (a restart, an update or a crash) before it finished."
        case "FAILED": return "It did not finish its work."
        case "STOPPED": return "Stopped by the agent."
        default: return nil
        }
    }

    /// `9 files left uncommitted`.
    public static func fileCount(_ n: Int) -> String {
        "\(n) \(n == 1 ? "file" : "files") left uncommitted"
    }

    public static let showFiles = "Show files"

    /// `model-routing.ts · task-route-decision.ts · +7`: the first two by name, then how many more.
    public static func fileNames(_ files: [String]) -> String {
        let first = files.prefix(2).map(basename)
        let more = files.count > first.count ? ["+\(files.count - first.count)"] : []
        return (first + more).joined(separator: " · ")
    }

    /// The folded card's two lines of what a run that finished handed back.
    public static let resultLines = 2

    /// While the end turn waits on the queue: the agent has not read it yet, and it can still be kept back.
    public static let waiting = "Waiting for the agent to read it"
    public static let dontSend = "Don't send"

    /// How many of the files an opened end lists before the reader asks for the rest.
    public static let filesShown = 3

    /// The opened card's end head: `Interrupted 10m ago: the runner hosting it stopped …`, `Stopped 2m ago
    /// by the agent.`; nil for DONE. `when` is the run's end, relative (`RelativeTime.format`).
    public static func endHead(_ status: String, when: String?) -> String? {
        let at = when.map { " \($0)" } ?? ""
        switch tone(status) {
        case .ok: return nil
        case .stopped: return "Stopped\(at) by the agent."
        case .failed:
            let reason = because(status) ?? ""
            return "\(status == "FAILED" ? "Failed" : "Interrupted")\(at): \(lowerFirst(reason))"
        }
    }

    /// `9 files left uncommitted in the working tree:`.
    public static func filesHead(_ n: Int) -> String { "\(fileCount(n)) in the working tree:" }

    /// `… 6 more`.
    public static func moreFiles(_ n: Int) -> String { "… \(n) more" }

    public static let rawSummary = "What the agent read"

    /// `Run 350QRI… · read by the agent at 14:02`; the time only once the agent read it.
    public static func runLine(_ runId: String, readAt: String?) -> String {
        "Run \(runId)" + (readAt.map { " · read by the agent at \($0)" } ?? "")
    }

    /// When the agent read the block, as the end's run line says it: the local 24-hour clock.
    public static func clock(_ iso: String) -> String? {
        guard let date = RelativeTime.parse(iso) else { return nil }
        let format = DateFormatter()
        format.locale = Locale(identifier: "en_GB")
        format.dateFormat = "HH:mm"
        return format.string(from: date)
    }

    /// What a SubAgent's end turn told the agent about one run, joined to its card by run id.
    public struct WakeSeen: Equatable, Sendable {
        /// The `<orbit-subagent-finished>` block, exactly as the agent read it.
        public let text: String
        /// When the agent read it; nil while it was never confirmed delivered.
        public let readAt: String?

        public init(text: String, readAt: String?) {
            self.text = text
            self.readAt = readAt
        }
    }

    /// The SubAgent end turns among a transcript's items, by run id: the block the agent read and, once
    /// delivered, when. Web: `subagentWakesOf`.
    public static func wakes(_ items: [TranscriptItem]) -> [String: WakeSeen] {
        var out: [String: WakeSeen] = [:]
        for case .user(let b) in items {
            guard let wake = SubagentFinishedText.parse(b.note) else { continue }
            let read = !b.undelivered && b.delivery != "failed" && b.delivery != "unconfirmed"
            for run in wake.runs { out[run.runId] = WakeSeen(text: wake.text, readAt: read ? b.ts : nil) }
        }
        return out
    }

    /// The SubAgent runs a queued turn tells the agent ended, or nil for any other turn. Each run's card
    /// says the turn is waiting and offers `Don't send`; the queue draws the turn only when it also
    /// carries a wakeup coming due, which is that line's to show (`alone` false). Web:
    /// `queuedSubagentWake` (lib/queuedTurnRestore.ts).
    public static func queuedWake(_ bubble: UserBubble) -> (runIds: [String], alone: Bool)? {
        guard bubble.sessionMessage == nil, let wake = SubagentFinishedText.parse(bubble.text) else { return nil }
        // A job's news beside it draws nothing in the tail either (`BgJobCard.queuedWake`); a wakeup coming due still does.
        return (wake.runs.map(\.runId), BgJobCard.wakeupsOnly(BackgroundWakeText.parse(wake.rest)) == nil)
    }

    /// Whether a turn is a SubAgent's end and nothing else, so it draws nothing: no line, no From Orbit
    /// line, no bubble. Its block is read off the note once delivered, off its words while queued. A
    /// background job's news written beside it keeps that line; words somebody typed keep their bubble.
    public static func drawsNothing(_ b: UserBubble, queued: Bool) -> Bool {
        if b.sessionMessage != nil || !b.attachments.isEmpty { return false }
        if queued { return queuedWake(b)?.alone == true }
        guard let wake = SubagentFinishedText.parse(b.note) else { return false }
        return BgJobCard.wakeupsOnly(BackgroundWakeText.parse(wake.rest)) == nil && !BackgroundWakeCard.drawsBubble(text: b.text)
    }

    private static func basename(_ path: String) -> String {
        guard let slash = path.lastIndex(of: "/") else { return path }
        let name = path[path.index(after: slash)...]
        return name.isEmpty ? path : String(name)
    }

    private static func lowerFirst(_ text: String) -> String {
        guard let first = text.first else { return text }
        return first.lowercased() + text.dropFirst()
    }
}
