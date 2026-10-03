import Foundation

// The turn the control plane opens for a background job, or for a wakeup coming due.
//
// A job started with `bg_run` can ask to wake its session when it exits or when it has written
// something new, and `schedule_wakeup` asks the control plane to hold a wakeup until it is due
// (apiserver `runner-api/background-job-wake.ts`, `runner-api/scheduled-wakeup.ts`). Either way the
// turn carries nobody's words: the block IS the turn — the turn's own content is empty — and it is
// stored beside the echo as the control plane's note, which is where this reads it from
// (`splitRecordedNote`). Drawn as a bubble it reads as a message the account owner typed: an empty
// one, with the whole block folded behind a grey strip calling it "context", because its tag is in
// no label table.
//
// The web reads the same note with `parseBackgroundWake` (src/web/src/lib/backgroundWake.ts) and
// draws it as `BackgroundWakeCard.tsx`. This is that rule for iOS and macOS, which share OrbitKit.
// Neither end compiles the other, so `BackgroundWakeCopyParityTests` is what holds the two to each
// other.
//
// Both blocks were written in Chinese until 2026-09-15 and the 73 turns already in the record are
// not migrated, so every field is read off what the two wordings share and never translated: the
// tag names, the `bgj_` prefix, the full-width `｜` between fields, the indent each line sits at,
// and the status and kill-reason values themselves. A wording this does not recognise parses as
// nothing at all rather than half a card — the note then stays the entry it has always been.

/// One job's wake, as the block spells it out.
public struct BackgroundWakeJob: Equatable, Sendable {
    public let id: String
    public let kind: String
    public let command: String
    public let description: String?
    /// `completed` | `failed` | `killed` | `running` — never translated, in either wording.
    public let status: String
    /// False for a wake the job's new output opened rather than its exit.
    public let ended: Bool
    public let exitCode: Int?
    /// Why a runner killed it (`runner_shutdown`, `session_cancelled`), without its gloss.
    public let killReason: String?
    public let outputPath: String?
    /// The byte range of the output this turn covered, or nil where the block named none.
    public let outputFrom: Int?
    public let outputTo: Int?
    /// The tail of the output the agent was shown; empty where the block said there was none.
    public let outputTail: String

    public init(id: String, kind: String, command: String, description: String?, status: String,
                ended: Bool, exitCode: Int?, killReason: String?, outputPath: String?,
                outputFrom: Int?, outputTo: Int?, outputTail: String) {
        self.id = id
        self.kind = kind
        self.command = command
        self.description = description
        self.status = status
        self.ended = ended
        self.exitCode = exitCode
        self.killReason = killReason
        self.outputPath = outputPath
        self.outputFrom = outputFrom
        self.outputTo = outputTo
        self.outputTail = outputTail
    }
}

/// One wakeup that came due on this turn.
public struct ScheduledWakeup: Equatable, Sendable {
    /// When it was asked for, and how far out it was asked to land.
    public let askedAt: String?
    public let delaySeconds: Int?
    public let dueAt: String?
    public let reason: String?
    /// What the agent left for this turn to read; empty where it left nothing.
    public let prompt: String

    public init(askedAt: String?, delaySeconds: Int?, dueAt: String?, reason: String?, prompt: String) {
        self.askedAt = askedAt
        self.delaySeconds = delaySeconds
        self.dueAt = dueAt
        self.reason = reason
        self.prompt = prompt
    }
}

/// A turn the control plane opened, as its card draws it.
public struct BackgroundWake: Equatable, Sendable {
    public let jobs: [BackgroundWakeJob]
    public let wakeups: [ScheduledWakeup]
    /// The wake blocks themselves, exactly as the agent received them.
    public let text: String
    /// Whatever else the same note carried — a returning engine's continuation nudge, a
    /// coordinator's standing role. Not the card's to draw: it stays the folded entry under it.
    public let rest: String
}

/// Reading the wake blocks in a control plane note, and nothing else.
///
/// Every pattern here is the one the browser reads the same note with, character for character;
/// `BackgroundWakeCopyParityTests` compares them to their declarations in `backgroundWake.ts`.
public enum BackgroundWakeText {
    /// A whole block, tag to matching tag.
    static let blockPattern = "<(background-job-wake|scheduled-wakeup)>\\n([\\s\\S]*?)\\n<\\/\\1>"
    /// The line a job's fields open on, at the indent the block puts it at.
    static let jobHeadPattern = "^ {4}bgj_[^｜\\s]*｜"
    /// `ended｜…` / `已结束｜…`, and the same for a wake new output opened.
    static let triggerPattern = "^ {6}(ended|已结束|new output|有新输出)(?:｜(.*))?$"
    static let exitCodePattern = "^(?:exit code|退出码)\\s*(-?\\d+)$"
    static let killReasonPattern = "^(?:reason|原因)\\s*(.+)$"
    /// The gloss the block appends to a known kill reason, in either wording's brackets.
    static let reasonGlossPattern = "\\s*[(（].*[)）]\\s*$"
    static let outputLinePattern =
        "^ {6}(?:output|输出) (.+?)｜(?:this covers bytes|这次说到的是第) (\\d+)[–-](\\d+)(?: 字节)?$"
    static let outputTailPattern = "^ {6}(?:output tail:|输出末尾：)$"
    /// The line a wakeup's timing sits on: when it was asked for, how far out, when it came due.
    static let wakeupTimingPattern =
        "^ {4}(\\S+) (?:scheduled (\\d+) seconds out, due (\\S+)|约在 (\\d+) 秒后，(\\S+) 到点)$"
    static let wakeupReasonPattern = "^ {4}(?:reason: |理由：)(.*)$"
    static let wakeupPromptPattern = "^ {4}(?:what you left for this turn:|你留给这一轮的话：)$"

    private static let block = try? NSRegularExpression(pattern: blockPattern)
    private static let jobHead = Pattern(jobHeadPattern)
    private static let trigger = Pattern(triggerPattern)
    private static let exitCode = Pattern(exitCodePattern)
    private static let killReason = Pattern(killReasonPattern)
    private static let outputLine = Pattern(outputLinePattern)
    private static let outputTail = Pattern(outputTailPattern)
    private static let wakeupTiming = Pattern(wakeupTimingPattern)
    private static let wakeupReason = Pattern(wakeupReasonPattern)
    private static let wakeupPrompt = Pattern(wakeupPromptPattern)

    /// Whether a note carries a wake the transcript draws as a line — `parse(note) != nil`, answered
    /// once per distinct note. The sticky bar asks it of every turn above the fold, on every publish
    /// and every step of a scroll (`StickySummary.isAnchor`), and a full reading costs the better part
    /// of a millisecond a note; a recorded note never changes, so the answer is kept.
    public static func carriesWake(_ note: String?) -> Bool {
        // No block can open without its tag, so every other note is answered without a reading.
        guard let note, note.contains("<background-job-wake>") || note.contains("<scheduled-wakeup>") else {
            return false
        }
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

    /// The wake blocks in a control plane note, or nil for a note carrying none.
    ///
    /// `rest` hands back everything else the note held, so a note that carries a wake and something
    /// else (a continuation nudge, a coordinator's role) keeps that part where it has always been.
    public static func parse(_ note: String?) -> BackgroundWake? {
        guard let note, let block else { return nil }
        var jobs: [BackgroundWakeJob] = []
        var wakeups: [ScheduledWakeup] = []
        var blocks: [String] = []
        var rest = ""
        var end = note.startIndex
        for match in block.matches(in: note, range: NSRange(note.startIndex..., in: note)) {
            guard let whole = Range(match.range, in: note),
                  let tag = slice(match, 1, in: note), let body = slice(match, 2, in: note) else { continue }
            rest += note[end..<whole.lowerBound]
            end = whole.upperBound
            blocks.append(String(note[whole]))
            if tag == "background-job-wake" { jobs += parseJobs(body) } else { wakeups += parseWakeups(body) }
        }
        // A block whose every field is unreadable is not a card: better the note as it always read.
        if jobs.isEmpty && wakeups.isEmpty { return nil }
        let trailing = (rest + note[end...])
            .replacingOccurrences(of: "\\n{3,}", with: "\n\n", options: .regularExpression)
        return BackgroundWake(jobs: jobs, wakeups: wakeups, text: blocks.joined(separator: "\n\n"),
                              rest: trailing.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// Each job in a block, split where the next one's fields open.
    private static func parseJobs(_ body: String) -> [BackgroundWakeJob] {
        let lines = body.components(separatedBy: "\n")
        let heads = lines.indices.filter { jobHead.matches(lines[$0]) }
        return heads.enumerated().map { n, from in
            parseJob(Array(lines[from..<(n + 1 < heads.count ? heads[n + 1] : lines.count)]))
        }
    }

    private static func parseJob(_ lines: [String]) -> BackgroundWakeJob {
        // The command can run to several lines of its own (a `while` loop, a heredoc), so the fields
        // end where the trigger line starts rather than at the first newline.
        let at = lines.indices.first { $0 > 0 && trigger.matches(lines[$0]) }
        let head = lines[0..<(at ?? lines.count)].joined(separator: "\n")
            .replacingOccurrences(of: "^ {4}", with: "", options: .regularExpression)
        // id｜kind｜command[｜description]. A `｜` inside the command would be indistinguishable from
        // a field break to the writer too, so the ends are trusted and the middle is the command.
        let fields = head.components(separatedBy: "｜")
        let triggered = at.flatMap { trigger.groups(lines[$0]) }
        let facts = (group(triggered, 2) ?? "").components(separatedBy: "｜")
        let kill = killReason.groups(field(facts, 1) ?? "")
        let output = first(lines, outputLine)
        let word = group(triggered, 1)
        return BackgroundWakeJob(
            id: field(fields, 0) ?? "",
            kind: field(fields, 1) ?? "",
            command: fields.count > 3
                ? fields[2..<(fields.count - 1)].joined(separator: "｜")
                : (field(fields, 2) ?? ""),
            description: fields.count > 3 ? fields[fields.count - 1] : nil,
            status: triggered != nil ? (field(facts, 0) ?? "") : "",
            ended: word == "ended" || word == "已结束",
            exitCode: number(group(exitCode.groups(field(facts, 1) ?? ""), 1)),
            killReason: group(kill, 1).map {
                $0.replacingOccurrences(of: reasonGlossPattern, with: "", options: .regularExpression)
            },
            outputPath: group(output, 1),
            outputFrom: number(group(output, 2)),
            outputTo: number(group(output, 3)),
            outputTail: parseTail(lines))
    }

    /// The output tail as the agent read it, back at column zero.
    private static func parseTail(_ lines: [String]) -> String {
        guard let at = lines.indices.first(where: { outputTail.matches(lines[$0]) }) else { return "" }
        var tail: [String] = []
        for line in lines[(at + 1)...] {
            // The narration closing the block sits at a shallower indent; the excerpt's own blank
            // lines survive as whitespace, and stopping on them would cut the tail in half.
            if !line.hasPrefix("        ")
                && !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { break }
            tail.append(String(line.dropFirst(8)))
        }
        return withoutTrailingWhitespace(tail.joined(separator: "\n"))
    }

    private static func parseWakeups(_ body: String) -> [ScheduledWakeup] {
        let lines = body.components(separatedBy: "\n")
        let heads = lines.indices.filter { wakeupTiming.matches(lines[$0]) }
        return heads.enumerated().map { n, from in
            parseWakeup(Array(lines[from..<(n + 1 < heads.count ? heads[n + 1] : lines.count)]))
        }
    }

    private static func parseWakeup(_ lines: [String]) -> ScheduledWakeup {
        let timing = wakeupTiming.groups(lines[0])
        let at = lines.indices.first { wakeupPrompt.matches(lines[$0]) }
        let prompt = at.map { from in
            lines[(from + 1)...].compactMap { $0.hasPrefix("      ") ? String($0.dropFirst(6)) : nil }
        } ?? []
        return ScheduledWakeup(
            askedAt: group(timing, 1),
            delaySeconds: number(group(timing, 2) ?? group(timing, 4)),
            dueAt: group(timing, 3) ?? group(timing, 5),
            reason: group(first(lines, wakeupReason), 1),
            prompt: withoutTrailingWhitespace(prompt.joined(separator: "\n")))
    }

    private static func first(_ lines: [String], _ pattern: Pattern) -> [String?]? {
        for line in lines { if let groups = pattern.groups(line) { return groups } }
        return nil
    }
}

/// What the wake reads as on screen: web's `BackgroundWakeCard.tsx`, in the same words and the same
/// order — one line in the agent's stream saying what happened, which job, how it came out and when,
/// and folded under it a row per job or wakeup, who queued the turn, and the text the agent actually
/// received.
public enum BackgroundWakeCard {
    /// How much of a scheduled wakeup's prompt is shown before folding the rest away.
    public static let tailLines = 8

    /// A job the line draws in its error tone.
    public static func isFailed(_ job: BackgroundWakeJob) -> Bool {
        job.status == "failed" || job.status == "killed"
    }

    /// Whether the line's mark is the clock: a wakeup, or a job that has only written something —
    /// nothing has come out either way yet.
    public static func isPending(_ wake: BackgroundWake) -> Bool {
        !wake.jobs.contains(where: isFailed) && (wake.jobs.isEmpty || wake.jobs.contains { !$0.ended })
    }

    /// What happened, at a glance.
    public static func title(_ wake: BackgroundWake) -> String {
        guard let only = wake.jobs.first else { return "Scheduled wakeup" }
        if wake.jobs.count > 1 { return "\(wake.jobs.count) background jobs finished" }
        if !only.ended { return "Background job has new output" }
        return isFailed(only) ? "Background job failed" : "Background job finished"
    }

    /// How one job came out, as the word its row closes on — nil while it has only written something.
    public static func status(_ job: BackgroundWakeJob) -> String? {
        if job.status == "killed" {
            guard let reason = job.killReason, !reason.isEmpty else { return "killed" }
            return "killed: \(reason)"
        }
        if let code = job.exitCode { return "exit \(code)" }
        return job.ended ? job.status : nil
    }

    /// What the line names after its title: the one job, or why the wakeup was asked for. Several
    /// jobs are counted by the title and named in the fold.
    public static func lineName(_ wake: BackgroundWake) -> String? {
        if wake.jobs.count == 1, let only = wake.jobs.first { return name(only) }
        guard wake.jobs.isEmpty, let reason = wake.wakeups.first?.reason, !reason.isEmpty else { return nil }
        return reason
    }

    /// The word the line closes on: the one job's, or how many of several failed.
    public static func lineStatus(_ wake: BackgroundWake) -> String? {
        if wake.jobs.count == 1, let only = wake.jobs.first { return status(only) }
        let failed = wake.jobs.filter(isFailed)
        return failed.isEmpty ? nil : "\(failed.count) of \(wake.jobs.count) failed"
    }

    /// What a job's row is called: what it was for, or the command itself where it was started
    /// without a description.
    public static func name(_ job: BackgroundWakeJob) -> String {
        job.description.flatMap { $0.isEmpty ? nil : $0 } ?? job.command
    }

    /// "bgj_13c53745a88a · 16.2 KB of output".
    public static func jobMeta(_ job: BackgroundWakeJob) -> String {
        guard let to = job.outputTo else { return job.id }
        return "\(job.id) · \(to == 0 ? "no output" : "\(formatBytes(to)) of output")"
    }

    /// How much output a job wrote, as the card says it.
    public static func formatBytes(_ n: Int) -> String {
        if n < 1024 { return "\(n) B" }
        if n < 1024 * 1024 { return String(format: "%.1f KB", Double(n) / 1024) }
        return String(format: "%.1f MB", Double(n) / (1024 * 1024))
    }

    /// "Asked for 1h out · came due 4m ago".
    ///
    /// The span is `WatchProjection.duration`, which is the browser's `formatSpan` at every span,
    /// not only over the [60, 3600] seconds the control plane clamps a delay to
    /// (`SCHEDULED_WAKEUP_MIN_DELAY_SECONDS`, `..._MAX_...`) — which is all of it this row reaches.
    public static func wakeupMeta(_ wakeup: ScheduledWakeup, now: Date = Date()) -> String {
        var parts: [String] = []
        if let delay = wakeup.delaySeconds {
            parts.append("Asked for \(WatchProjection.duration(TimeInterval(delay))) out")
        }
        if let dueAt = wakeup.dueAt, let relative = RelativeTime.format(dueAt, now: now) {
            parts.append("came due \(relative)")
        }
        return parts.joined(separator: " · ")
    }

    /// "Queued by a background job, not typed by you" — who queued the turn, said in the fold. When is
    /// on the line itself.
    public static func meta(_ wake: BackgroundWake) -> String {
        wake.jobs.isEmpty
            ? "Queued by a scheduled wakeup, not typed by you"
            : "Queued by a background job, not typed by you"
    }

    /// The runner never confirmed the engine received the turn.
    public static let undelivered = "The session has not confirmed it received this."

    /// How far a wake written into the running turn has got, in a steer's own words
    /// (`SteerDelivery.state`) — "Sending…" while it waits for the runner, then "Delivering…" and
    /// "Sent into this turn". A job that ends while a turn runs is filed as a steer aimed at that turn
    /// (apiserver `background-job-wake.ts`), so its line sits inside the running turn and this is the
    /// only account of it there is. Nil for every other wake, and for one that never arrived, which
    /// `undelivered` already says. Web parity: `Transcript.tsx` hands the line
    /// `node.steer && !undelivered ? steerDeliveryState(node.delivery).label : undefined`.
    public static func steerState(steer: Bool, delivery: String?, undelivered: Bool) -> String? {
        guard steer, !undelivered, delivery != "failed", delivery != "unconfirmed" else { return nil }
        return SteerDelivery.state(delivery).label
    }

    /// The fold the original text stays behind.
    public static let rawSummary = "What the agent received"

    /// Whether the turn this line draws is also somebody's message.
    ///
    /// A wake turn's own content is empty — the block IS the turn — so anything else the same note
    /// carried (the inventory a returning engine is handed, a coordinator's standing role) used to
    /// be handed back to a user bubble, which drew a bubble with no words in it under the card,
    /// signed with the reader's own name. The leftover is the line's fold's now (`attached`), and a
    /// bubble is drawn only where somebody actually typed something. Web parity: `Transcript.tsx` draws the
    /// bubble on `node.text.trim() !== ''` alone.
    public static func drawsBubble(text: String) -> Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

/// A compiled pattern, handing back the groups of its first match the way the TypeScript's `exec`
/// does: nil for a group that did not take part. Shared with the reading of the inventory block
/// (`BackgroundJobsText`), which reads the same lines with the same kind of pattern.
struct Pattern {
    private let re: NSRegularExpression?

    init(_ pattern: String) { re = try? NSRegularExpression(pattern: pattern) }

    func groups(_ text: String) -> [String?]? {
        guard let re,
              let match = re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else {
            return nil
        }
        return (0..<match.numberOfRanges).map { slice(match, $0, in: text) }
    }

    func matches(_ text: String) -> Bool { groups(text) != nil }
}

private func slice(_ match: NSTextCheckingResult, _ index: Int, in text: String) -> String? {
    guard index < match.numberOfRanges, let range = Range(match.range(at: index), in: text) else {
        return nil
    }
    return String(text[range])
}

/// A capture group by number, and an element of a split line by position: both are absent rather
/// than out of range, the way the other end reads an `undefined` off either.
private func group(_ groups: [String?]?, _ index: Int) -> String? {
    guard let groups, index < groups.count else { return nil }
    return groups[index]
}

private func field(_ fields: [String], _ index: Int) -> String? {
    index < fields.count ? fields[index] : nil
}

private func number(_ text: String?) -> Int? {
    text.flatMap(Int.init)
}

private func withoutTrailingWhitespace(_ text: String) -> String {
    var out = text
    while let last = out.last, last.isWhitespace { out.removeLast() }
    return out
}
