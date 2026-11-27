import Foundation

/// A `bg_run` job, as its one card in the transcript (the owner's job-card board, file
/// 350t1lTONlrPMjilBdXx7, choices A1 B1 C1 D1 E1 F1 and rulings R1-R4 of 2026-11-21): a `bg_run` call
/// draws one card that carries its job from start to end, as a background SubAgent's does
/// (`SubagentCardEnd`). What the card says is joined by the job's id (`bgj_…`) from four sources: the
/// call's own receipt, the job's runner reports (the Background list's `BackgroundProc`), the wake turns
/// the control plane opened for it (`BackgroundWakeText`), and the tail read route.
///
/// Web parity: `src/web/src/lib/bgJobCard.ts` and `components/JobCard.tsx`, whose words
/// `BgJobCardCopyParityTests` holds these to.
public enum BgJobCard {
    /// Orbit's background-job tool, as every engine's MCP name for it reaches the transcript.
    public static let toolName = "mcp__orbit__bg_run"

    // MARK: the call and its receipt

    private static let jobIdField = Pattern("\"jobId\"\\s*:\\s*\"(bgj_[^\"\\s]+)\"")
    private static let jobIdAny = Pattern("\\b(bgj_[0-9a-zA-Z]+)\\b")
    private static let startedAtField = Pattern("\"startedAt\"\\s*:\\s*\"([^\"]+)\"")

    /// What a bg_run call's receipt names: the job's id and when its runner started it. Nil before it answers.
    public static func receipt(_ result: String?) -> (jobId: String, startedAt: String?)? {
        guard let text = result,
              let id = (jobIdField.groups(text) ?? jobIdAny.groups(text))?[1] ?? nil else { return nil }
        let started = startedAtField.groups(text)?[1] ?? nil
        return (id, started)
    }

    /// Whether a call draws as its job's card: a bg_run call before its answer, or one whose answer
    /// names its job. One refused, or whose answer names none, stays an ordinary call.
    public static func drawsCard(_ card: ToolCard) -> Bool {
        guard card.name == toolName, card.status != .error else { return false }
        return card.status == .running && card.result == nil || receipt(card.result) != nil
    }

    /// The launch pair the runner writes for every bg_run job (runner-go background_job.go `launchJob`): a
    /// `Bash` call with run_in_background, whose id is the job's own. It exists for the Background list;
    /// the job's card is the bg_run call, so the transcript draws nothing for it.
    public static func isRunnerJobLaunch(_ card: ToolCard) -> Bool {
        card.name == "Bash" && card.id.hasPrefix("bgj_") && card.input["run_in_background"]?.boolValue == true
    }

    /// The bg_run call that started a job, by the job its receipt names, among a transcript's items:
    /// where the Background list's job row scrolls to.
    public static func card(forJob jobId: String, in items: [TranscriptItem]) -> String? {
        for case .toolCall(let card) in items where card.name == toolName {
            if receipt(card.result)?.jobId == jobId { return card.id }
        }
        return nil
    }

    // MARK: the wake turns

    /// One time the job woke its agent: the job as that wake's block spelled it out, and the turn that carried it.
    public struct WakeSeen: Equatable, Sendable {
        public let job: BackgroundWakeJob
        /// The wake blocks, exactly as the agent read them.
        public let text: String
        /// When the wake turn was written.
        public let ts: String?
        /// When the agent read it; nil while it was never confirmed delivered.
        public let readAt: String?

        public init(job: BackgroundWakeJob, text: String, ts: String?, readAt: String?) {
            self.job = job
            self.text = text
            self.ts = ts
            self.readAt = readAt
        }
    }

    /// The background-job wake blocks a turn's note carries, beside a SubAgent's or a workflow's end or alone.
    public static func jobWake(_ note: String?) -> BackgroundWake? {
        guard let note else { return nil }
        let workflow = WorkflowFinishedText.parse(note)
        let subagent = SubagentFinishedText.parse(workflow?.rest ?? note)
        return BackgroundWakeText.parse(subagent?.rest ?? workflow?.rest ?? note)
    }

    /// What of a wake the transcript still draws as a line: only its scheduled wakeups. A job's end, new
    /// output or stall draws nothing there (board C1): its card says it. Nil when nothing is left to draw.
    public static func wakeupsOnly(_ wake: BackgroundWake?) -> BackgroundWake? {
        guard let wake, !wake.wakeups.isEmpty else { return nil }
        if wake.jobs.isEmpty { return wake }
        return BackgroundWake(jobs: [], wakeups: wake.wakeups, text: wake.text, rest: wake.rest)
    }

    /// The wake turns among a transcript's items, by job id, oldest first. Web: `jobWakesOf`.
    public static func wakes(_ items: [TranscriptItem]) -> [String: [WakeSeen]] {
        var out: [String: [WakeSeen]] = [:]
        for case .user(let b) in items {
            // No job's block can open without its tag: every other turn is passed over without a reading.
            guard let note = b.note, note.contains("<background-job-"), let wake = jobWake(note) else { continue }
            let read = !b.undelivered && b.delivery != "failed" && b.delivery != "unconfirmed"
            for job in wake.jobs {
                out[job.id, default: []].append(WakeSeen(job: job, text: wake.text, ts: b.ts, readAt: read ? b.ts : nil))
            }
        }
        return out
    }

    /// The job ids a queued turn wakes, or nil for any other turn. `alone` when nothing else in it draws:
    /// no wakeup coming due, no SubAgent's or workflow's end. Web: `queuedJobWake`.
    public static func queuedWake(_ bubble: UserBubble) -> (jobIds: [String], alone: Bool)? {
        guard bubble.sessionMessage == nil, let wake = jobWake(bubble.text), !wake.jobs.isEmpty else { return nil }
        let others = SubagentFinishedText.parse(bubble.text) != nil || WorkflowFinishedText.parse(bubble.text) != nil
        return (wake.jobs.map(\.id), wake.wakeups.isEmpty && !others)
    }

    /// Whether a turn is a background job's news and nothing else, so it draws nothing: no line, no
    /// bubble. Read off the note once delivered, off its words while queued. A wakeup coming due beside
    /// it keeps its line; a SubAgent's or workflow's end keeps its own rule; words somebody typed keep
    /// their bubble.
    public static func drawsNothing(_ b: UserBubble, queued: Bool) -> Bool {
        if b.sessionMessage != nil || !b.attachments.isEmpty { return false }
        if queued { return queuedWake(b)?.alone == true }
        guard let note = b.note, WorkflowFinishedText.parse(note) == nil, SubagentFinishedText.parse(note) == nil,
              let wake = BackgroundWakeText.parse(note) else { return false }
        return !wake.jobs.isEmpty && wakeupsOnly(wake) == nil && !BackgroundWakeCard.drawsBubble(text: b.text)
    }

    // MARK: how the job stands

    /// Who stopped a killed job, in one line: the wording the wake glosses use for each reason (apiserver
    /// runner-api/background-job-wake.ts `KILLED_BECAUSE`), cut to its first clause, and the board's own
    /// line for the agent's bg_kill. Nil for a reason none of them names.
    public static func killedBy(_ reason: String?) -> String? {
        switch reason {
        case "requested": return "Killed by the agent."
        case "stopped_by_owner", "stop": return "The person who owns this session stopped it from the app."
        case "runner_shutdown":
            return "The runner process hosting it stopped — a restart or a self-update — and the job was killed with it."
        case "session_cancelled":
            return "The session was cancelled, or handed to another runner process, and the job was killed with it."
        case "not_allowed":
            return "It never ran: this session's permission mode asked the owner first, and they did not allow it."
        default: return nil
        }
    }

    public enum Phase: String, Equatable, Sendable { case running, done, failed, killed, unknown }

    public struct State: Equatable, Sendable {
        public let phase: Phase
        public let exitCode: Int?
        /// Why a killed job was killed, as the runner names it.
        public let reason: String?
        /// How long a running job had been quiet when its newest wake said so; nil when it has not gone quiet.
        public let quietMs: Int?
        /// When it ended, where something said.
        public let endedAt: String?
    }

    /// The runner's terminal word for a status, in the card's: nil while it still runs or nothing says.
    private static func terminal(_ status: String?) -> Phase? {
        switch status {
        case "completed", "done": return .done
        case "failed": return .failed
        case "killed", "stopped": return .killed
        default: return nil
        }
    }

    /// How the job stands. Its runner's terminal report wins (the Background list), then its end's wake,
    /// then the tail read's own status. A job nothing says ended is running while its session is live; on
    /// a session that is over, it can no longer be, and nothing said how it ended. Web: `jobState`.
    public static func state(proc: BackgroundProc?, wakes: [WakeSeen], tail: BackgroundJobTail? = nil,
                             live: Bool) -> State {
        let endWake = wakes.last { $0.job.ended }
        let end = endWake?.job
        let tailEnded = tail.flatMap { $0.status == "running" ? nil : $0 }
        let procTerminal = terminal(proc?.status)
        let exitCode = (procTerminal != nil ? proc?.exitCode : nil) ?? end?.exitCode ?? tailEnded?.exitCode
        let reason = (procTerminal != nil ? proc?.reason : nil) ?? end?.killReason
        let endedAt = (procTerminal != nil ? proc?.endedAt : nil) ?? endWake?.ts
        let ended = procTerminal
            ?? end.map { $0.status == "killed" ? .killed : $0.status == "failed" ? .failed : .done }
            ?? tailEnded.map { $0.status == "killed" ? .killed : $0.status == "failed" ? .failed : .done }
        if let ended {
            let phase: Phase = ended == .killed ? .killed : ended == .failed || (exitCode ?? 0) != 0 ? .failed : .done
            return State(phase: phase, exitCode: phase == .killed ? nil : exitCode,
                         reason: phase == .killed ? reason : nil, quietMs: nil, endedAt: endedAt)
        }
        let newest = wakes.last?.job
        let quietMs = newest?.stall.map { $0.quietForMs ?? 0 }
        return State(phase: live || proc?.status == "running" ? .running : .unknown,
                     exitCode: nil, reason: nil, quietMs: quietMs, endedAt: nil)
    }

    /// The output the card shows. Running: what the tail read answered just now, else what the newest
    /// wake carried. Ended: what its end's wake carried (R2), else the tail read's last answer, else the
    /// runner's end report. Web: `jobOutput`.
    public static func output(phase: Phase, proc: BackgroundProc?, wakes: [WakeSeen], tail: BackgroundJobTail?) -> String {
        let polled = tail.map { $0.lines.joined(separator: "\n") } ?? ""
        let newestTail = wakes.last { !$0.job.outputTail.isEmpty }?.job.outputTail ?? ""
        let shown: String
        if phase == .running || phase == .unknown {
            shown = polled.isEmpty ? newestTail : polled
        } else {
            let endTail = wakes.last { $0.job.ended }?.job.outputTail ?? ""
            shown = [endTail, polled, proc?.outputTail ?? "", newestTail].first { !$0.isEmpty } ?? ""
        }
        return stripAnsi(shown)
    }

    /// `12m 40s` / `3m 10s` / `40m` from twenty minutes on / `1h 5m` / `45s`: how long the job has run.
    public static func elapsed(_ seconds: TimeInterval) -> String {
        var s = max(0, Int(seconds))
        let hours = s / 3600
        s -= hours * 3600
        let minutes = s / 60
        s -= minutes * 60
        if hours > 0 { return "\(hours)h \(minutes)m" }
        if minutes >= 20 { return "\(minutes)m" }
        if minutes > 0 { return "\(minutes)m \(String(format: "%02d", s))s" }
        return "\(s)s"
    }

    /// The output's lines, its trailing blank lines dropped.
    public static func lines(_ text: String) -> [String] {
        let trimmed = withoutTrailingWhitespace(text)
        return trimmed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? [] : trimmed.components(separatedBy: "\n")
    }

    /// The last `n` lines of some output.
    public static func lastLines(_ text: String, _ n: Int) -> [String] {
        Array(lines(text).suffix(n))
    }

    /// Terminal colour codes, which a monospace block would show as `[41m` garbage. Web: `stripAnsi`.
    public static func stripAnsi(_ text: String) -> String {
        guard text.contains("\u{1b}") else { return text }
        return text.replacingOccurrences(of: "\u{1b}\\[[0-9;?]*[ -/]*[@-~]", with: "", options: .regularExpression)
    }

    // MARK: the card, as drawn

    /// What sits under a folded card's row.
    public enum Folded: Equatable, Sendable {
        case none
        /// Running: its newest output line, live (R2).
        case live(String)
        /// Ended with an exit: its last two lines, grey for exit 0 and red for a failure, and Show full output.
        case ending(lines: [String], failed: Bool)
        /// Killed: who stopped it (R3).
        case killedBy(String)
    }

    /// Everything the card draws, worked out from its sources; the views only lay it out.
    public struct Look: Equatable, Sendable {
        public let title: String
        public let command: String
        public let kind: String
        public let phase: Phase
        /// `12m 40s`, ticking while it runs; nil where nothing says when it started.
        public let elapsed: String?
        /// `quiet 10m` in amber while it runs (B1).
        public let quietChip: String?
        /// `exit 1` in red, `killed` in grey.
        public let endChip: String?
        public let folded: Folded
        /// The output's lines, for the opened card (its last `openLines`, then Show all).
        public let lines: [String]
        /// Why it was killed, in one line; the opened card says it too.
        public let killedBy: String?
        /// A Stop control is offered: it runs, and its runner can stop it (R3).
        public let stoppable: Bool
        /// The opened card's metadata line.
        public let meta: String
    }

    /// The card for one bg_run call. `canStop` is whether there is a session to ask (a console, not an export).
    public static func look(input: JSONValue, jobId: String?, startedAt: String?, proc: BackgroundProc?,
                            wakes: [WakeSeen], tail: BackgroundJobTail?, live: Bool, canStop: Bool,
                            where place: String?, now: Date = Date()) -> Look {
        let state = state(proc: proc, wakes: wakes, tail: tail, live: live)
        let phase = state.phase
        let running = phase == .running
        let text = output(phase: phase, proc: proc, wakes: wakes, tail: tail)
        let start = startedAt.flatMap(RelativeTime.parse) ?? proc?.startedAt.flatMap(RelativeTime.parse)
        let end = running ? now : state.endedAt.flatMap(RelativeTime.parse)
        let elapsed = start.flatMap { start in end.map { BgJobCard.elapsed($0.timeIntervalSince(start)) } }
        let killedBy = phase == .killed ? BgJobCard.killedBy(state.reason) : nil
        let ended = phase == .done || phase == .failed || phase == .killed
        let foldedLines = lastLines(text, running ? 1 : 2)
        let folded: Folded
        if running, let line = foldedLines.first {
            folded = .live(line)
        } else if phase == .killed {
            folded = killedBy.map(Folded.killedBy) ?? .none
        } else if ended, !foldedLines.isEmpty {
            folded = .ending(lines: foldedLines, failed: phase == .failed)
        } else {
            folded = .none
        }
        let kind = kind(input: input)
        return Look(
            title: title(input: input),
            command: input["command"]?.stringValue ?? "",
            kind: kind,
            phase: phase,
            elapsed: elapsed,
            quietChip: running ? state.quietMs.map(quiet) : nil,
            endChip: phase == .failed ? state.exitCode.map(exit) : phase == .killed ? killed : nil,
            folded: folded,
            lines: lines(text),
            killedBy: killedBy,
            stoppable: running && canStop && proc?.stoppable == true && jobId != nil,
            meta: meta(jobId: jobId, kind: kind, startedAt: start, ranFor: ended ? elapsed : nil, where: place))
    }

    /// What the tail read does next (the route's documented pace, R2): read again in 5 s while the job
    /// runs, 30 s after the runner was away (503/504 or no answer), never again once the job ended or
    /// the output cannot be read (404/409: a runner too old to read it, or output that is gone).
    public enum TailNext: Equatable, Sendable { case after(TimeInterval), ended, gone }

    public static func tailNext(answer: BackgroundJobTail?, httpStatus: Int?) -> TailNext {
        if let answer { return answer.status == "running" ? .after(tailPaceSeconds) : .ended }
        if httpStatus == 404 || httpStatus == 409 { return .gone }
        return .after(tailRetrySeconds)
    }

    /// Whether the card reads its tail now: only while the job runs, the card is on screen and the app is
    /// in front, and the output has not proved unreadable.
    public static func pollsTail(running: Bool, onScreen: Bool, appActive: Bool, gone: Bool, canRead: Bool) -> Bool {
        running && onScreen && appActive && !gone && canRead
    }

    // MARK: the words

    /// What the card is called: its description, else its command.
    public static func title(input: JSONValue) -> String {
        let description = input["description"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return description.isEmpty ? (input["command"]?.stringValue ?? "") : description
    }

    /// The kind chip: `job`, `watch` or `service`, as bg_run was told.
    public static func kind(input: JSONValue) -> String {
        let kind = input["kind"]?.stringValue ?? ""
        return kind.isEmpty ? "job" : kind
    }

    /// How many of the output's lines an opened card shows before the reader asks for the rest.
    public static let openLines = 40
    /// The pace the tail route documents (sessions.controller `backgroundJobTail`): every 5 s, 30 s after a 503/504.
    public static let tailPaceSeconds: TimeInterval = 5
    public static let tailRetrySeconds: TimeInterval = 30

    public static let showFullOutput = "Show full output"
    public static func showAll(_ n: Int) -> String { "Show all \(n) lines" }
    public static func quiet(_ ms: Int) -> String { "quiet \(WatchProjection.duration(TimeInterval(ms) / 1000))" }
    public static func exit(_ code: Int) -> String { "exit \(code)" }
    public static let killed = "killed"
    public static let stop = "Stop"
    public static let stopConfirm = "Stop this job?"
    public static let rawSummary = "What the agent read"
    public static func wokeHead(_ n: Int) -> String { "Woke the agent \(n) \(n == 1 ? "time" : "times")" }

    /// The opened card's metadata line: `bgj_9f3a · watch · started 10:20 · ran 12m 40s · on workstation`.
    public static func meta(jobId: String?, kind: String, startedAt: Date?, ranFor: String?, where place: String?) -> String {
        let started = startedAt.map { "started \(clock($0))" }
        let parts: [String?] = [jobId, kind, started, ranFor.map { "ran \($0)" },
                                place.flatMap { $0.isEmpty ? nil : "on \($0)" }]
        return parts.compactMap { $0 }.joined(separator: " · ")
    }

    /// One time the job woke the agent: `10:32 · exit 1 · read by the agent at 10:32`.
    public static func wakeLine(_ wake: WakeSeen) -> String {
        let job = wake.job
        let what: String
        if let stall = job.stall {
            what = quiet(stall.quietForMs ?? 0)
        } else if !job.ended {
            what = "new output"
        } else if job.status == "killed" {
            what = killed
        } else if let code = job.exitCode {
            what = exit(code)
        } else {
            what = job.status
        }
        let parts: [String?] = [wake.ts.flatMap(SubagentCardEnd.clock), what,
                                wake.readAt.flatMap(SubagentCardEnd.clock).map { "read by the agent at \($0)" }]
        return parts.compactMap { $0 }.joined(separator: " · ")
    }

    /// The local 24-hour clock, as the opened card says when it started.
    public static func clock(_ date: Date) -> String {
        let format = DateFormatter()
        format.locale = Locale(identifier: "en_GB")
        format.dateFormat = "HH:mm"
        return format.string(from: date)
    }

    private static func withoutTrailingWhitespace(_ text: String) -> String {
        var out = text
        while let last = out.last, last.isWhitespace { out.removeLast() }
        return out
    }
}

/// The answer of GET /sessions/:id/background/jobs/:jobId/tail: the newest lines of a bg_run job's
/// output, as the runner hosting it read them just now. Mirrors `BackgroundJobTailResponse` in @orbit/shared.
public struct BackgroundJobTail: Decodable, Equatable, Sendable {
    public let jobId: String
    /// `running`, `completed`, `failed` or `killed`.
    public let status: String
    public let exitCode: Int?
    /// The output's last lines, oldest first, without terminal colour codes (at most 40).
    public let lines: [String]
    public let truncated: Bool?
    public let outputBytes: Int?
    public let readAt: String?

    public init(jobId: String, status: String, exitCode: Int?, lines: [String], truncated: Bool? = nil,
                outputBytes: Int? = nil, readAt: String? = nil) {
        self.jobId = jobId
        self.status = status
        self.exitCode = exitCode
        self.lines = lines
        self.truncated = truncated
        self.outputBytes = outputBytes
        self.readAt = readAt
    }
}

/// The answer of POST /sessions/:id/background/jobs/:jobId/stop.
public struct BackgroundJobStop: Decodable, Equatable, Sendable {
    public let jobId: String
    /// `stopping` or `killed`.
    public let status: String
}
