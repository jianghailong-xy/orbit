import Foundation

// The inventory a returning engine is handed: what is still running, what ended while it was gone.
//
// The `<background-jobs>` block delivery appends the first time a new engine takes a turn (apiserver
// `runner-api/background-jobs-context.ts`). Unlike a wake it rides along with whatever the person
// typed, so it stays the folded entry under their words (`splitRecordedNote`, `describeNote`) — this
// only turns its job lines into rows. What it replaces there is a line that runs four lines wide: an
// id, a kind, a shell command, an outcome and an absolute path, all divided by a `｜` the reader has
// to count.
//
// The block was written in Chinese until 2026-09-15 and the rows already in the record are not
// migrated — 85 of this deployment's 106 carry the older wording — so both are read, and neither is
// ever translated: the section headings, the field prefixes, the `no end reported` outcome, and the
// status values, which were already English in both.
//
// Web reads the same block with `parseBackgroundJobs` (src/web/src/lib/backgroundJobs.ts) and draws
// it as `BackgroundJobsNote.tsx`. This is that rule for iOS and macOS, which share OrbitKit. Neither
// end compiles the other, so `BackgroundJobsCopyParityTests` is what holds the two to each other.

/// One line of the block's two job sections.
public struct BackgroundJobRow: Equatable, Sendable {
    public let id: String
    /// `service` | `job` | `watch` — the three a `bg_run` can be (runner-go `background_job.go`).
    public let kind: String
    public let command: String
    /// `completed` | `failed` | `killed` | `stopped`, or empty for a job that is still running.
    public let status: String
    public let exitCode: Int?
    /// Why it ended the way it did: a runner's kill reason, or that no end was ever reported.
    public let reason: String?
    public let outputPath: String?

    public init(id: String, kind: String, command: String, status: String, exitCode: Int?,
                reason: String?, outputPath: String?) {
        self.id = id
        self.kind = kind
        self.command = command
        self.status = status
        self.exitCode = exitCode
        self.reason = reason
        self.outputPath = outputPath
    }
}

public struct BackgroundJobs: Equatable, Sendable {
    public let running: [BackgroundJobRow]
    public let ended: [BackgroundJobRow]
    /// The block itself, exactly as the agent received it.
    public let text: String
    /// Whatever else the same note carried — another block's rows are not this one's to draw.
    public let rest: String

    public init(running: [BackgroundJobRow], ended: [BackgroundJobRow], text: String, rest: String) {
        self.running = running
        self.ended = ended
        self.text = text
        self.rest = rest
    }
}

/// Reading the inventory block in a control plane note, and nothing else.
///
/// Every pattern here is the one the browser reads the same block with, character for character;
/// `BackgroundJobsCopyParityTests` compares them to their declarations in `backgroundJobs.ts`.
public enum BackgroundJobsText {
    /// The whole block, tag to tag.
    static let blockPattern = "<background-jobs>\\n([\\s\\S]*?)\\n<\\/background-jobs>"
    /// The two sections whose lines become rows, in both wordings.
    static let runningPattern = "^ {2}(?:Still running|仍在运行)"
    static let endedPattern = "^ {2}(?:Ended while you were away|你不在的时候结束了)"
    /// Every line the block itself writes at section indent, which is how a section's list ends.
    ///
    /// Named one by one rather than taken as "any line at this indent": a command runs to several
    /// lines of its own (a `while` loop, a heredoc) and those lines are indented however the person
    /// wrote them — an `  fi` two spaces in would otherwise cut the command, and the job, in half.
    static let narrationPattern =
        "^ {2}(?:Still running|Ended while you were away|Monitors that stopped|If you are still waiting|The control plane recorded|Read output with|仍在运行|你不在的时候结束了|随上一个 engine|还要等的事|这是控制面替你记下的|用 mcp__orbit__bg_output)"
    /// Where one job's fields open, which is also where the previous job's command ends.
    static let jobHeadPattern = "^ {4}\\S+｜"
    static let exitCodePattern = "^(?:exit code|退出码) (-?\\d+)$"
    static let reasonPattern = "^(?:reason|原因) "
    static let outputPattern = "^(?:output|输出) "
    /// A job whose runner process died without reporting an end, as the block spells it out.
    static let noEndPattern = "^(?:no end reported|没有结束报告)$"

    static let terminal: Set<String> = ["completed", "failed", "killed", "stopped"]

    private static let block = try? NSRegularExpression(pattern: blockPattern)
    private static let running = Pattern(runningPattern)
    private static let ended = Pattern(endedPattern)
    private static let narration = Pattern(narrationPattern)
    private static let jobHead = Pattern(jobHeadPattern)
    private static let exitCode = Pattern(exitCodePattern)
    private static let noEnd = Pattern(noEndPattern)

    /// The block's jobs, or nil for a note that carries none.
    ///
    /// Nil is also the answer for a block whose sections are all unreadable — better the note as it
    /// has always read than half a card.
    public static func parse(_ note: String?) -> BackgroundJobs? {
        guard let note, let block,
              let match = block.firstMatch(in: note, range: NSRange(note.startIndex..., in: note)),
              let whole = Range(match.range, in: note),
              let body = Range(match.range(at: 1), in: note) else { return nil }
        let lines = note[body].components(separatedBy: "\n")
        let stillRunning = section(lines, running)
        let hasEnded = section(lines, ended)
        if stillRunning.isEmpty && hasEnded.isEmpty { return nil }
        let rest = (note[note.startIndex..<whole.lowerBound] + note[whole.upperBound...])
            .replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
        return BackgroundJobs(running: stillRunning, ended: hasEnded, text: String(note[whole]),
                              rest: rest.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// The lines listed under one heading, each folded into a row.
    private static func section(_ lines: [String], _ heading: Pattern) -> [BackgroundJobRow] {
        guard let from = lines.indices.first(where: { heading.matches(lines[$0]) }) else { return [] }
        var listed: [String] = []
        for line in lines[(from + 1)...] {
            if narration.matches(line) { break }
            listed.append(line)
        }
        let heads = listed.indices.filter { jobHead.matches(listed[$0]) }
        return heads.enumerated().map { n, at in
            parseJob(Array(listed[at..<(n + 1 < heads.count ? heads[n + 1] : listed.count)]))
        }
    }

    private static func parseJob(_ lines: [String]) -> BackgroundJobRow {
        // `id｜kind｜command[｜status[｜exit code N][｜reason R]][｜output PATH]`. A `｜` inside the
        // command would be indistinguishable from a field break to the writer too, so the ends are
        // read first and whatever is left in the middle is the command.
        let fields = lines.joined(separator: "\n")
            .replacingOccurrences(of: "^ {4}", with: "", options: .regularExpression)
            .components(separatedBy: "｜")
        var rest = Array(fields.dropFirst(2))
        let outputPath = takeSuffix(&rest, outputPattern)
        var reason = takeSuffix(&rest, reasonPattern)
        let exit = exitCode.groups(rest.last ?? "")
        if exit != nil { rest.removeLast() }
        var status = terminal.contains(rest.last ?? "") ? rest.removeLast() : ""
        // `no end reported｜<why that is all anyone can say>`: two fields, one outcome. The gloss is
        // for the agent, so the row keeps the outcome's own words and the gloss stays in the
        // verbatim fold.
        if rest.count > 1, noEnd.matches(rest[rest.count - 2]) {
            rest.removeLast()
            reason = rest.removeLast()
            status = "stopped"
        }
        return BackgroundJobRow(
            id: fields.first ?? "",
            kind: fields.count > 1 ? fields[1] : "",
            command: rest.joined(separator: "｜"),
            status: status,
            exitCode: exit.flatMap { $0.count > 1 ? $0[1].flatMap(Int.init) : nil },
            reason: reason,
            outputPath: outputPath)
    }

    /// The last field when it is the one this prefix names, taken off the end without it.
    private static func takeSuffix(_ fields: inout [String], _ prefix: String) -> String? {
        guard let last = fields.last,
              let head = last.range(of: prefix, options: .regularExpression) else { return nil }
        fields.removeLast()
        return String(last[head.upperBound...])
    }
}

/// What the block reads as on screen: web's `BackgroundJobsNote.tsx`, in the same words and the same
/// order — the outcome first, the command as the row, the ids last, and the block itself folded away
/// rather than dropped.
public enum BackgroundJobsNote {
    /// The two headings the rows are listed under, in this client's own language: the block's own
    /// wording is whichever one it was written in, and these name the sections on screen.
    public static let runningTitle = "Still running"
    public static let endedTitle = "Ended while you were away"

    /// The fold the block itself stays behind.
    ///
    /// "The block" rather than "what the agent received", which is what a wake's own fold says
    /// (`BackgroundWakeCard.rawSummary`): on a wake turn this entry sits inside that card, and two
    /// folds with one name read as a bug.
    public static let rawSummary = "The block, verbatim"

    /// The glyph a row opens on, which is also its tone.
    public enum Mark: Equatable, Sendable {
        case running, ok, failed
    }

    public static func mark(_ job: BackgroundJobRow) -> Mark {
        if job.status.isEmpty { return .running }
        return job.status == "completed" ? .ok : .failed
    }

    /// What a job's row is called: the command, since a job carries no description here and three
    /// rows headed by their kind would all read "job".
    public static func name(_ job: BackgroundJobRow) -> String {
        job.command.isEmpty ? job.id : job.command
    }

    /// "bgj_0f012a1b9d50 · job" — the ids, under the row they belong to.
    public static func meta(_ job: BackgroundJobRow) -> String {
        "\(job.id) · \(job.kind)"
    }

    /// How it came out, in the block's own words: an exit code, or the status and why. Empty for a
    /// job that is still running, which the glyph has already said.
    public static func outcome(_ job: BackgroundJobRow) -> String {
        if let code = job.exitCode { return "exit \(code)" }
        if job.status.isEmpty { return "" }
        guard let reason = job.reason else { return job.status }
        return "\(job.status) · \(reason)"
    }

    /// "2 running, 1 failed" — what the block holds, on the line that names it folded.
    ///
    /// The count is the whole point of the line: "background jobs" alone never said whether opening
    /// it was worth it. A lone job that ended says how, because that one number is what its reader
    /// came for.
    public static func summary(_ jobs: BackgroundJobs) -> String {
        if jobs.running.isEmpty, jobs.ended.count == 1, let only = jobs.ended.first {
            if let code = only.exitCode { return "1 ended, exit \(code)" }
            return "1 \(only.status.isEmpty ? "ended" : only.status)"
        }
        let failed = jobs.ended.filter { $0.status == "failed" || $0.status == "killed" }
        var parts: [String] = []
        if !jobs.running.isEmpty { parts.append("\(jobs.running.count) running") }
        if jobs.ended.count > failed.count { parts.append("\(jobs.ended.count - failed.count) ended") }
        if !failed.isEmpty { parts.append("\(failed.count) failed") }
        return parts.joined(separator: ", ")
    }
}
