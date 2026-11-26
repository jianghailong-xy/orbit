import Foundation

// A run's session when the run did not get under way in it (board docs/mocks/scheduled-run-not-started ②③④).
// The words are the shared SCHEDULE_RUN_STATUS_COPY (src/shared/src/schedule.ts), held to contracts/schedule.contract.json
// `runStatusCopy` and to this file by ScheduleRunStatusTests; the rules are the shared `scheduleRunStatusKind` and the
// text functions beside it. Change the contract, then this file, never this file alone.

public enum ScheduleRunStatusCopy {
    public static let strip = "Scheduled run · planned {planned} · access {access}"
    public enum DidntRun {
        public static let title = "Didn't run"
        public static let notPickedUp = "{runner} didn't pick it up on any of {tries} tries, so the run never started."
        public static let notPickedUpOnce = "{runner} didn't pick it up, so the run never started."
        public static let full = "{runner} was full the whole time, so the run never started."
        public static let engineFailed = "{runner} couldn't start the engine on any of {tries} tries, so the run never started."
        public static let engineFailedOnce = "{runner} couldn't start the engine, so the run never started."
        public static let quota = "The engine's usage limit was reached, so the run never started."
        public static let cancelled = "You cancelled the run before it started."
        public static let nothingChanged = "Nothing was changed."
        public static let gaveUp = "gave up {time}"
        public static let nextRun = "Next run: {when}"
    }
    public enum Queued {
        public static let title = "Queued · {tag}"
        public static let waited = "{waited} · gives up at {deadline}"
        public static let givesUp = "Gives up at {deadline}"
    }
    public enum StartedOn {
        public static let title = "Started on try {try}"
        public static let body = "This try stopped before its engine started ({why}). Try {try} started at {time}."
        public static let engineExited = "{engine} exited"
        public static let notPickedUp = "{runner} didn't pick it up"
    }
    public enum Actions {
        public static let runNow = "Run now"
        public static let openSchedule = "Open schedule"
        public static let cancelRun = "Cancel run"
        public static let openRun = "Open the run →"
    }

    /// Every sentence by its path in the contract's `runStatusCopy`.
    public static let contract: [String: String] = [
        "strip": strip,
        "didntRun.title": DidntRun.title,
        "didntRun.notPickedUp": DidntRun.notPickedUp,
        "didntRun.notPickedUpOnce": DidntRun.notPickedUpOnce,
        "didntRun.full": DidntRun.full,
        "didntRun.engineFailed": DidntRun.engineFailed,
        "didntRun.engineFailedOnce": DidntRun.engineFailedOnce,
        "didntRun.quota": DidntRun.quota,
        "didntRun.cancelled": DidntRun.cancelled,
        "didntRun.nothingChanged": DidntRun.nothingChanged,
        "didntRun.gaveUp": DidntRun.gaveUp,
        "didntRun.nextRun": DidntRun.nextRun,
        "queued.title": Queued.title,
        "queued.waited": Queued.waited,
        "queued.givesUp": Queued.givesUp,
        "startedOn.title": StartedOn.title,
        "startedOn.body": StartedOn.body,
        "startedOn.engineExited": StartedOn.engineExited,
        "startedOn.notPickedUp": StartedOn.notPickedUp,
        "actions.runNow": Actions.runNow,
        "actions.openSchedule": Actions.openSchedule,
        "actions.cancelRun": Actions.cancelRun,
        "actions.openRun": Actions.openRun,
    ]
}

public enum ScheduleRunStatus {
    private typealias C = ScheduleRunStatusCopy
    private static func fill(_ t: String, _ v: [String: String]) -> String { ScheduleDisplay.fill(t, v) }

    /// Which card a run's session shows, if any: ② didn't run, ③ queued behind a full runner, ④ started on a later try.
    public enum Kind: String, Sendable, Equatable { case didntRun, queuedFull, startedOn }

    private static let gaveUpStates: Set<String> = ["MISSED", "CANCELLED", "SKIPPED"]

    /// The card for this session of the run, or nil when its run reached its engine here (its report and composer are
    /// the session's own then), or is between tries with nothing to say yet. Web `scheduleRunStatusKind`.
    public static func kind(run: ScheduleRunView, status: ScheduleRunSessionStatus?) -> Kind? {
        guard let status, let thisTry = status.thisTry, thisTry >= 1, thisTry <= status.tries.count else { return nil }
        let mine = status.tries[thisTry - 1]
        if mine.reachedEngine { return nil }
        if status.gaveUpAt != nil, gaveUpStates.contains(run.state) { return .didntRun }
        if status.queue != nil, run.state == "RUNNING" { return .queuedFull }
        let current = run.sessionId.flatMap { id in status.tries.first { $0.sessionId == id } }
        if let current, current.sessionId != mine.sessionId, current.reachedEngine { return .startedOn }
        return nil
    }

    /// "Scheduled run · planned 03:32 · access Edit and land on main".
    public static func stripText(plannedAt: String, accessLevel: String, timezone: String) -> String {
        fill(C.strip, [
            "planned": ScheduleDisplay.parse(plannedAt).map { ScheduleDisplay.localParts($0, timezone: timezone).time } ?? "",
            "access": ScheduleDisplay.accessCopy(accessLevel).label,
        ])
    }

    private static func time(_ iso: String, _ timezone: String) -> String {
        ScheduleDisplay.parse(iso).map { ScheduleDisplay.localParts($0, timezone: timezone).time } ?? ""
    }

    private static func lowerDay(_ text: String) -> String {
        let pairs = [(ScheduleCopy.Dates.today, ScheduleCopy.Dates.todayLower),
                     (ScheduleCopy.Dates.tomorrow, ScheduleCopy.Dates.tomorrowLower)]
        for (day, lower) in pairs where text.hasPrefix(day) { return lower + text.dropFirst(day.count) }
        return text
    }

    /// ② The reason a run did not run, as one sentence, then "Nothing was changed.".
    public static func didntRunReason(failureReason: String?, tries: Int, runner: String) -> String {
        let n = ["runner": runner, "tries": String(tries)]
        let reason: String
        switch failureReason {
        case "RUNNER_FULL": reason = fill(C.DidntRun.full, n)
        case "CANCELLED_BY_OWNER": reason = C.DidntRun.cancelled
        case "QUOTA": reason = C.DidntRun.quota
        case "ENGINE_CRASHED_BEFORE_START":
            reason = fill(tries > 1 ? C.DidntRun.engineFailed : C.DidntRun.engineFailedOnce, n)
        default: reason = fill(tries > 1 ? C.DidntRun.notPickedUp : C.DidntRun.notPickedUpOnce, n)
        }
        return "\(reason) \(C.DidntRun.nothingChanged)"
    }

    public struct DidntRunText: Equatable, Sendable {
        public let title: String
        public let reason: String
        public let tries: [String]
        public let gaveUp: String?
        public let next: String?
    }

    /// ② The card's words: its title, reason, each try's time, when it gave up and the next run.
    public static func didntRunText(run: ScheduleRunView, status: ScheduleRunSessionStatus, runner: String,
                                    now: Date, timezone: String) -> DidntRunText {
        DidntRunText(
            title: C.DidntRun.title,
            reason: didntRunReason(failureReason: run.failureReason, tries: status.tries.count, runner: runner),
            tries: status.tries.map { time($0.startedAt, timezone) },
            gaveUp: status.gaveUpAt.map { fill(C.DidntRun.gaveUp, ["time": time($0, timezone)]) },
            next: status.nextDueAt.flatMap(ScheduleDisplay.parse).map {
                fill(C.DidntRun.nextRun, ["when": lowerDay(ScheduleDisplay.whenText($0, now: now, timezone: timezone))])
            })
    }

    public struct QueuedText: Equatable, Sendable {
        public let title: String
        /// The queue's own sentence, said of the run.
        public let body: String
        /// "Waiting 1 h 12 min · gives up at 03:32 tomorrow".
        public let waited: String
    }

    /// ③ "Queued · runner full", the queue's sentence, and the wait with the deadline.
    public static func queuedText(gate: ScheduleRunQueueGate, machine: String?, now: Date, timezone: String) -> QueuedText {
        let waited = QueuedCapacity.waited(since: gate.since, now: now)
        let deadline: String = ScheduleDisplay.parse(gate.deadline).map { at in
            let t = ScheduleDisplay.localParts(at, timezone: timezone).time
            let day = ScheduleDisplay.dayText(at, now: now, timezone: timezone)
            return day == ScheduleCopy.Dates.today ? t : "\(t) \(lowerDay(day))"
        } ?? ""
        return QueuedText(
            title: fill(C.Queued.title, ["tag": QueuedCapacity.tag(reason: gate.queuedReason)]),
            body: QueuedCapacity.runText(gate, machine: machine),
            waited: fill(waited == nil ? C.Queued.givesUp : C.Queued.waited,
                         ["waited": waited ?? "", "deadline": deadline]))
    }

    /// ④ "Started on try 3", and why this try stopped.
    public static func startedOnText(run: ScheduleRunView, status: ScheduleRunSessionStatus, engine: String,
                                     runner: String, timezone: String) -> (title: String, body: String)? {
        guard let index = status.tries.firstIndex(where: { $0.sessionId == run.sessionId }),
              let thisTry = status.thisTry, thisTry >= 1, thisTry <= status.tries.count else { return nil }
        let mine = status.tries[thisTry - 1]
        let n = String(index + 1)
        let why = mine.claimed ? fill(C.StartedOn.engineExited, ["engine": engine])
                               : fill(C.StartedOn.notPickedUp, ["runner": runner])
        return (fill(C.StartedOn.title, ["try": n]),
                fill(C.StartedOn.body, ["why": why, "try": n, "time": time(status.tries[index].startedAt, timezone)]))
    }
}
