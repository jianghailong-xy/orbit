import Foundation

/// A landing's timeline read as the session chat reads a turn (owner 2026-11-11,
/// docs/mocks/landings-chat-tools-native): one attempt's lines gathered into a few steps — the
/// queue, the claim, the sync onto the line, each check, and the push (or the merge into main) — each
/// drawn as one of the chat's tool rows. Every line stays the server's own sentence; a step only groups
/// them, and its summary is one of its own lines.
///
/// A direct port of `src/web/src/lib/landingSteps.ts`: the grouping and the words are the web's, held to
/// it by `LandingStepsParityTests`.
public enum LandingStepCopy {
    public static let queue = "Queue"
    public static let claim = "Claim"
    public static let sync = "Sync"
    public static let push = "Push"
    public static let merge = "Merge"
    public static let result = "Result"
    /// The settled line's chip: `check 0m 16s`. Web: the window's `WINDOW_COPY.CHECK`.
    public static let check = "check"
    /// The line's own way to open what it carries. Web: `WINDOW_COPY.DETAILS`.
    public static let details = "Details"
    /// The head over a landing that runs. Web: `WINDOW_COPY.WORKING_FOR`.
    public static let workingFor = "Working for"
}

public struct LandingStep: Equatable, Sendable, Identifiable {
    /// `queue`, `claim`, `sync`, `check:TASK_ACCEPTANCE`, `check:MERGE_CHECK`, `push`.
    public let key: String
    /// `Queue`, `Claim`, `Sync`, `Merge check`, `Task acceptance`, `Push`, `Merge`, `Result`.
    public let name: String
    /// The step's lines, in the timeline's order, with their index in the section.
    public let entries: [(index: Int, entry: IntegrationTimelineEntry)]
    /// The line the folded row says: the step's verdict when it has one, else its first or last line.
    public let summary: IntegrationTimelineEntry
    /// When the step last moved: its newest line.
    public let at: String

    public var id: String { key }

    public static func == (lhs: LandingStep, rhs: LandingStep) -> Bool {
        lhs.key == rhs.key && lhs.name == rhs.name && lhs.summary == rhs.summary && lhs.at == rhs.at
            && lhs.entries.map { $0.index } == rhs.entries.map { $0.index }
    }
}

public enum LandingSteps {
    static let order = ["queue", "claim", "sync", "check:TASK_ACCEPTANCE", "check:LANDING_CHECK", "check:BASELINE", "check:MERGE_CHECK", "push"]

    /// The kinds a step's folded row prefers to say: how it ended.
    static let verdicts: Set<String> = [
        "CHECK_FINISHED", "SKIPPED_CHECK", "RESULT", "RESULT_FALLBACK", "PUSH_REFUSED",
        "CANCELLED", "TIMED_OUT", "ABANDONED", "STOP_REQUESTED", "HANDED_TO",
    ]

    /// Results that mean the push (or the merge into main) happened, or that nothing needed one.
    static let pushedStates: Set<String> = ["LANDED", "ALREADY_LANDED", "NOTHING_TO_LAND", "READY", "OBSERVED"]

    /// The lines that say a step stopped short: a stop, a refusal, a failed check or result.
    static let failures: Set<String> = ["STOP_REQUESTED", "CANCELLED", "ABANDONED", "TIMED_OUT", "PUSH_REFUSED"]

    static func checkKey(_ entry: IntegrationTimelineEntry) -> String {
        if entry.data?["scope"]?.stringValue == "BASELINE" { return "check:BASELINE" }
        if entry.check?.name == "LANDING_CHECK" { return "check:LANDING_CHECK" }
        return entry.check?.name == "TASK_ACCEPTANCE" ? "check:TASK_ACCEPTANCE" : "check:MERGE_CHECK"
    }

    /// Which step a line belongs to; `current` is the step the attempt was last in.
    static func step(of entry: IntegrationTimelineEntry, current: String?) -> String {
        switch entry.kind {
        case "ENQUEUED", "REQUEUED", "NEXT_GENERATION", "FIX_TASK", "RETRY", "AUTOMATIC_ATTEMPT",
             "CONFIRMATION", "HANDLING":
            return current ?? "queue"
        case "CLAIMED", "TAKEN_OVER", "RELEASED":
            return "claim"
        case "ROUND", "RECHECK_ON_MOVED_MAIN":
            return "sync"
        case "CHECK_STARTED", "CHECK_FINISHED":
            return checkKey(entry)
        case "SKIPPED_CHECK":
            return checkKey(entry)
        case "PUSH_REFUSED":
            return "push"
        case "RESULT", "RESULT_FALLBACK":
            // A result that landed or merged belongs to the push; one that stopped (a failed check, a
            // conflict, an error) to the step it stopped in, so no Push row says it failed to push.
            return pushedStates.contains(entry.data?["state"]?.stringValue ?? "") ? "push" : current ?? "push"
        case "STEP":
            switch entry.phase {
            case "FETCH", "MAIN_SYNC", "REBASE", "MERGE":
                return "sync"
            case "CHECK":
                if let current, current.hasPrefix("check:") { return current }
                return "check:MERGE_CHECK"
            case "VERIFY", "PUSH", "OBSERVE":
                return "push"
            default:
                return current ?? "claim"
            }
        default:
            // A stop, a cancel, a timeout, a hand-off: where the attempt was when it happened.
            return current ?? "queue"
        }
    }

    static func name(_ key: String, kind: String) -> String {
        switch key {
        case "queue": return LandingStepCopy.queue
        case "claim": return LandingStepCopy.claim
        case "sync": return LandingStepCopy.sync
        case "check:TASK_ACCEPTANCE": return LandingPageCopy.checkLabel("TASK_ACCEPTANCE")
        case "check:LANDING_CHECK", "check:BASELINE": return LandingCheckCopy.label
        case "check:MERGE_CHECK": return LandingPageCopy.checkLabel("MERGE_CHECK")
        default:
            return kind == "LAND_TASK" ? LandingStepCopy.push
                : kind == "LAND_PROMOTION" ? LandingStepCopy.merge : LandingStepCopy.result
        }
    }

    /// One attempt's lines as its steps, in the order a landing goes through them.
    public static func steps(_ entries: [IntegrationTimelineEntry], kind: String) -> [LandingStep] {
        var groups: [String: [(index: Int, entry: IntegrationTimelineEntry)]] = [:]
        var current: String?
        for (index, entry) in entries.enumerated() {
            let key = step(of: entry, current: current)
            current = key
            groups[key, default: []].append((index, entry))
        }
        return order.compactMap { key in
            guard let group = groups[key], let first = group.first, let last = group.last else { return nil }
            let verdict = group.reversed().first { verdicts.contains($0.entry.kind) }?.entry
            let summary = verdict ?? (key == "queue" || key == "claim" ? first.entry : last.entry)
            return LandingStep(key: key, name: name(key, kind: kind), entries: group, summary: summary,
                               at: last.entry.at)
        }
    }

    /// A step stopped short: one of its lines is a stop or a refusal, or a check or result that did
    /// not end well — the lines the timeline marks ✗.
    public static func failed(_ step: LandingStep, kind: String) -> Bool {
        step.entries.contains { item in
            let entry = item.entry
            if entry.data?["skipped"]?.stringValue == "PATHS_EXEMPT" { return false }
            if failures.contains(entry.kind) { return true }
            if ["CHECK_FINISHED", "RESULT", "RESULT_FALLBACK"].contains(entry.kind) {
                return !entry.succeeded(in: kind)
            }
            return false
        }
    }

    /// How long a landing's checks took together; nil when none recorded a duration.
    public static func checksDurationMs(_ durations: [Int?]) -> Int? {
        let total = durations.reduce(0) { $0 + ($1 ?? 0) }
        return total > 0 ? total : nil
    }
}
