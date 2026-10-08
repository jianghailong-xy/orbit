import Foundation

// The server's runs on Activity (design §2.2, mock 35 ④⑤; contract `jobs.read`, P9) — a port of the web's
// `src/web/src/lib/wikiRuns.ts`, word for word: the Runs band's rows — what kind of run, where it stands, how far it
// got and where it waits — and a run's call log, one model call a row. Both are held to
// `src/shared/src/wiki-server-execution.fixture.json` (`WikiServerExecutionCopyParityTests` here,
// `lib/wikiRuns.test.ts` there), and every constant below is looked up by its declaration in the web's file.
//
// Pure, with no SwiftUI, so it is tested on Linux like the rest of this directory.

/// Every word the Runs band, a run's page and the System model's state say. The web constant each mirrors is beside it.
public enum WikiRunsCopy {
    public static let runs = "Runs"                                                // WIKI_RUNS
    public static let none = "Nothing has run on the server yet."                  // WIKI_RUNS_NONE

    /// What a kind of run is called (`WIKI_RUN_KINDS`).
    public static func kind(_ kind: WikiJobKind) -> String {
        switch kind {
        case .verify:     return "Verification"
        case .articles:   return "Articles"
        case .import:     return "Import"
        case .planDraft:  return "Plan draft"
        case .planRevise: return "Plan revision"
        case .docsBuild:  return "Documents"
        case .maintain:   return "Maintenance"
        case .smoke:      return "Model check"
        case .unknown:    return ""
        }
    }

    public static let queued = "Queued"                                            // WIKI_RUN_QUEUED
    public static let running = "Running"                                          // WIKI_RUN_RUNNING
    public static let waitingRunner = "Waiting for the runner"                     // WIKI_RUN_WAITING_RUNNER
    public static let waitingModel = "Waiting for the System model"                // WIKI_RUN_WAITING_MODEL
    public static let done = "Done"                                                // WIKI_RUN_DONE
    public static let failed = "Failed"                                            // WIKI_RUN_FAILED
    public static let cancelled = "Cancelled"                                      // WIKI_RUN_CANCELLED
    public static let nextInLine = "next in line"                                  // WIKI_RUN_NEXT_IN_LINE
    public static let starting = "starting"                                        // WIKI_RUN_STARTING
    public static let noResult = "It ended without a result"                       // WIKI_RUN_NO_RESULT
    public static func runsAhead(_ count: Int) -> String { count == 1 ? "1 run ahead" : "\(count) runs ahead" }   // wikiRunsAhead
    public static func waited(_ duration: String) -> String { "waited \(duration)" }                              // wikiWaited
    public static func retryingIn(_ duration: String) -> String { "retrying in \(duration)" }                     // wikiRetryingIn
    public static func callsEnded(_ ended: Int, of total: Int) -> String { "\(ended) of \(total) calls ended" }    // wikiCallsEnded
    public static func nextCall(_ ahead: Int, waited duration: String) -> String {                                 // wikiNextCall
        ahead == 0 ? "next call first in line, waited \(duration)" : "next call \(ahead) ahead, waited \(duration)"
    }
    public static func calls(_ count: Int) -> String { count == 1 ? "1 call" : "\(WikiArticleCopy.count(count)) calls" }  // wikiCalls
    public static func tokens(_ count: Int) -> String { "\(WikiArticleCopy.count(count)) tokens" }                // wikiTokens
    public static func took(_ duration: String) -> String { "took \(duration)" }                                  // wikiTook
    public static func started(_ ago: String) -> String { "started \(ago)" }                                      // wikiStarted

    // MARK: the call log

    /// The log itself: the web table's name, and the section a run's page lists its calls under.
    public static let callsTitle = "Calls"                                         // WIKI_CALLS
    public static let call = "Call"                                                // WIKI_CALL
    public static let callState = "State"                                          // WIKI_CALL_STATE
    public static let callWaited = "Waited"                                        // WIKI_CALL_WAITED
    public static let callRan = "Ran"                                              // WIKI_CALL_RAN
    public static let callTokens = "Tokens"                                        // WIKI_CALL_TOKENS
    public static let callQueued = "Queued"                                        // WIKI_CALL_QUEUED
    public static let callRunning = "Running"                                      // WIKI_CALL_RUNNING
    public static let callDone = "Done"                                            // WIKI_CALL_DONE
    public static let callFailed = "Failed"                                        // WIKI_CALL_FAILED
    public static let callCancelled = "Cancelled"                                  // WIKI_CALL_CANCELLED
    public static let noValue = "—"                                                // WIKI_NO_VALUE
    public static func callAhead(_ ahead: Int) -> String { ahead == 0 ? "Queued · next" : "Queued · \(ahead) ahead" }   // wikiCallAhead
    public static func retries(_ count: Int) -> String { count == 1 ? "1 retry" : "\(count) retries" }            // wikiRetries
    public static func callTokens(_ input: Int, _ output: Int) -> String {                                         // wikiCallTokens
        "\(WikiArticleCopy.count(input)) → \(WikiArticleCopy.count(output))"
    }
    public static func ran(_ duration: String) -> String { "ran \(duration)" }                                    // wikiRan
    public static func foot(_ calls: Int, input: Int, output: Int) -> String {                                     // wikiRunFoot
        "\(WikiRunsCopy.calls(calls)) · \(WikiArticleCopy.count(input)) tokens in, \(WikiArticleCopy.count(output)) out"
    }
    public static let soFar = "so far"                                             // WIKI_RUN_SO_FAR
    public static func showingLast(_ shown: Int) -> String { "showing the last \(shown)" }                        // wikiShowingLast

    // MARK: the System model's state (mock 35 ③)

    /// A state as the settings page, Set up and the Runs band say it (`WIKI_MODEL_STATE_WORDS`).
    public static func modelState(_ state: WikiSystemModelState) -> String {
        switch state {
        case .up:               return "Up"
        case .down:             return "Unreachable"
        case .authFailed:       return "Key refused"
        case .unconfigured:     return "Not configured"
        case .workerNotRunning: return "wiki worker not running"
        case .unknown:          return ""
        }
    }

    public static let systemModel = "System model"                                 // WIKI_SYSTEM_MODEL
    /// `System model · qwen3.8-27b-fp8`, or the bare words while no model is named (`wikiSystemModelLabel`).
    public static func systemModelLabel(_ model: String?) -> String {
        guard let model, !model.isEmpty else { return systemModel }
        return "\(systemModel) · \(model)"
    }
}

/// One run's row on the Runs band (the web's `WikiRunRow`).
public struct WikiRunRow: Equatable, Sendable {
    /// ok: a green dot; warn: amber, it waits; error: red, it broke; spin: it runs; none: grey.
    public enum Mark: String, Sendable { case ok, warn, error, spin, none }
    /// plain: the state in the label colour; warn: amber; error: red; muted: grey.
    public enum Tone: String, Sendable { case plain, warn, error, muted }

    public let kind: String
    public let mark: Mark
    public let tone: Tone
    public let state: String
    /// What follows the state, ` · ` between its parts; empty when there is nothing to add.
    public let text: String
    public let when: String

    public init(kind: String, mark: Mark, tone: Tone, state: String, text: String, when: String) {
        self.kind = kind
        self.mark = mark
        self.tone = tone
        self.state = state
        self.text = text
        self.when = when
    }
}

/// One row of a run's call log (the web's `WikiCallRow`).
public struct WikiCallRow: Equatable, Sendable {
    /// ok: green; warn: amber; error: red; run: blue; muted: grey.
    public enum Tone: String, Sendable { case ok, warn, error, run, muted }

    public let call: String
    public let state: String
    public let retries: String?
    public let tone: Tone
    public let waited: String
    public let ran: String
    public let tokens: String
    /// The phone's second line: `waited 1s · ran 14s · 1,204 → 296 tokens`.
    public let line: String
    public let error: String?

    public init(call: String, state: String, retries: String?, tone: Tone, waited: String, ran: String, tokens: String,
                line: String, error: String?) {
        self.call = call
        self.state = state
        self.retries = retries
        self.tone = tone
        self.waited = waited
        self.ran = ran
        self.tokens = tokens
        self.line = line
        self.error = error
    }
}

public enum WikiRunsLogic {
    /// How a model's state is coloured: up green; down amber — it comes back by itself; the rest red (`wikiModelTone`).
    public enum ModelTone: String, Sendable { case up, warn, error }

    public static func modelTone(_ state: WikiSystemModelState) -> ModelTone {
        switch state {
        case .up:   return .up
        case .down: return .warn
        default:    return .error
        }
    }

    /// `41s`, `1m 12s`, `6m`, `1h 3m`, `2d 4h` — the web's `wikiDuration`.
    public static func duration(_ seconds: Double) -> String {
        let s = max(0, Int(seconds.isFinite ? seconds.rounded(.down) : 0))
        if s < 60 { return "\(s)s" }
        if s < 3600 { return s % 60 == 0 ? "\(s / 60)m" : "\(s / 60)m \(s % 60)s" }
        if s < 86_400 {
            let minutes = (s % 3600) / 60
            return minutes == 0 ? "\(s / 3600)h" : "\(s / 3600)h \(minutes)m"
        }
        let hours = (s % 86_400) / 3600
        return hours == 0 ? "\(s / 86_400)d" : "\(s / 86_400)d \(hours)h"
    }

    /// Seconds from `from` to `to` (an ISO time), or nil when either is not one.
    private static func between(_ from: String?, _ to: String?) -> Double? {
        guard let from, let to, let start = RelativeTime.parse(from), let end = RelativeTime.parse(to) else { return nil }
        return max(0, end.timeIntervalSince(start))
    }

    private static func between(_ from: String?, _ now: Date) -> Double? {
        guard let from, let start = RelativeTime.parse(from) else { return nil }
        return max(0, now.timeIntervalSince(start))
    }

    private static func join(_ parts: [String?]) -> String {
        parts.compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// A failure's first line: what a row has room for.
    private static func firstLine(_ text: String?) -> String? {
        let line = (text ?? "").split(separator: "\n", omittingEmptySubsequences: false).first.map(String.init)?
            .trimmingCharacters(in: .whitespaces) ?? ""
        return line.isEmpty ? nil : line
    }

    /// The run's row (mock 35 ④) — the web's `wikiRunRow`.
    public static func row(_ job: WikiJob, now: Date) -> WikiRunRow {
        let kind = WikiRunsCopy.kind(job.kind)
        let ago = { (iso: String) in WikiHealthLogic.ago(iso, now: now) }
        switch job.state {
        case .queued:
            var place: String?
            if job.attempts > 0, let next = job.nextAttemptAt, let start = RelativeTime.parse(next), start.timeIntervalSince(now) > 0 {
                place = WikiRunsCopy.retryingIn(duration(start.timeIntervalSince(now)))
            } else if let ahead = job.ahead {
                place = ahead == 0 ? WikiRunsCopy.nextInLine : WikiRunsCopy.runsAhead(ahead)
            }
            return WikiRunRow(kind: kind, mark: .warn, tone: .warn, state: WikiRunsCopy.queued,
                              text: join([place, WikiRunsCopy.waited(duration(between(job.createdAt, now) ?? 0))]),
                              when: ago(job.createdAt))
        case .running:
            let progress: String
            if let counted = job.progress, let done = counted.done, let total = counted.total {
                progress = "\(counted.step.map { "\($0) " } ?? "")\(done) of \(total)"
            } else if job.calls.total > 0 {
                progress = WikiRunsCopy.callsEnded(job.calls.succeeded + job.calls.failed + job.calls.cancelled, of: job.calls.total)
            } else {
                progress = WikiRunsCopy.starting
            }
            let next = job.nextCall.map { WikiRunsCopy.nextCall($0.ahead, waited: duration(between($0.enqueuedAt, now) ?? 0)) }
            return WikiRunRow(kind: kind, mark: .spin, tone: .plain, state: WikiRunsCopy.running, text: join([progress, next]),
                              when: WikiRunsCopy.started(ago(job.startedAt ?? job.createdAt)))
        case .waiting:
            return WikiRunRow(kind: kind, mark: .warn, tone: .warn,
                              state: job.waitingFor == "model" ? WikiRunsCopy.waitingModel : WikiRunsCopy.waitingRunner,
                              text: duration(between(job.updatedAt, now) ?? 0),
                              when: WikiRunsCopy.started(ago(job.startedAt ?? job.createdAt)))
        case .succeeded:
            let tokens = job.calls.inputTokens + job.calls.outputTokens
            let took = between(job.startedAt ?? job.createdAt, job.endedAt)
            return WikiRunRow(kind: kind, mark: .ok, tone: .plain, state: WikiRunsCopy.done,
                              text: join([WikiRunsCopy.calls(job.calls.total), tokens > 0 ? WikiRunsCopy.tokens(tokens) : nil,
                                          took.map { WikiRunsCopy.took(duration($0)) }]),
                              when: ago(job.endedAt ?? job.updatedAt))
        case .failed:
            return WikiRunRow(kind: kind, mark: .error, tone: .error, state: WikiRunsCopy.failed,
                              text: join([firstLine(job.error) ?? WikiRunsCopy.noResult, job.calls.total > 0 ? WikiRunsCopy.calls(job.calls.total) : nil]),
                              when: ago(job.endedAt ?? job.updatedAt))
        case .cancelled, .unknown:
            return WikiRunRow(kind: kind, mark: .none, tone: .muted, state: WikiRunsCopy.cancelled, text: "",
                              when: ago(job.endedAt ?? job.updatedAt))
        }
    }

    /// The line under a run's call log — the web's `wikiRunFootText`.
    public static func foot(_ job: WikiJob) -> String {
        let over = job.state == .succeeded || job.state == .failed || job.state == .cancelled
        var text = WikiRunsCopy.foot(job.calls.total, input: job.calls.inputTokens, output: job.calls.outputTokens)
        if !over { text += " \(WikiRunsCopy.soFar)" }
        if !job.requests.isEmpty, job.requests.count < job.calls.total { text += " · \(WikiRunsCopy.showingLast(job.requests.count))" }
        return text
    }

    /// A unit as the log names it: a uuid cut to its first eight characters (`wikiCallUnit`).
    public static func unit(_ unit: String) -> String {
        let uuid = #"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"#
        return unit.range(of: uuid, options: .regularExpression) != nil ? String(unit.prefix(8)) : unit
    }

    /// One row of a run's call log — the web's `wikiCallRow`.
    public static func callRow(_ call: WikiJobCall, now: Date) -> WikiCallRow {
        let waitedFor = call.state == .queued ? between(call.enqueuedAt, now) : between(call.enqueuedAt, call.startedAt)
        let ranFor: Double? = call.state == .running
            ? between(call.startedAt, now)
            : (call.startedAt != nil && call.endedAt != nil ? between(call.startedAt, call.endedAt) : nil)
        let waited = waitedFor.map { duration($0) } ?? WikiRunsCopy.noValue
        let ran = call.state == .queued || ranFor == nil ? WikiRunsCopy.noValue : duration(ranFor ?? 0)
        let tokens: String
        if let input = call.inputTokens, let output = call.outputTokens {
            tokens = WikiRunsCopy.callTokens(input, output)
        } else {
            tokens = WikiRunsCopy.noValue
        }
        let state: String
        let tone: WikiCallRow.Tone
        switch call.state {
        case .queued:
            state = call.ahead.map { WikiRunsCopy.callAhead($0) } ?? WikiRunsCopy.callQueued
            tone = .warn
        case .running:
            state = WikiRunsCopy.callRunning
            tone = .run
        case .succeeded:
            state = WikiRunsCopy.callDone
            tone = .ok
        case .failed:
            state = WikiRunsCopy.callFailed
            tone = .error
        case .cancelled, .unknown:
            state = WikiRunsCopy.callCancelled
            tone = .muted
        }
        let line = join([
            waited != WikiRunsCopy.noValue ? WikiRunsCopy.waited(waited) : nil,
            ran != WikiRunsCopy.noValue ? WikiRunsCopy.ran(ran) : nil,
            tokens != WikiRunsCopy.noValue ? "\(tokens) tokens" : nil,
        ])
        return WikiCallRow(call: "\(call.step) · \(unit(call.unit))", state: state,
                           retries: call.attempts > 0 ? WikiRunsCopy.retries(call.attempts) : nil, tone: tone,
                           waited: waited, ran: ran, tokens: tokens, line: line,
                           error: call.state == .succeeded || call.state == .cancelled ? nil : firstLine(call.error))
    }

    /// Whether Activity draws the Runs band: the server runs this account's wiki, or ran something for the space.
    public static func shown(serverExecutes: Bool, jobs: [WikiJob]?) -> Bool {
        serverExecutes || !(jobs ?? []).isEmpty
    }
}
