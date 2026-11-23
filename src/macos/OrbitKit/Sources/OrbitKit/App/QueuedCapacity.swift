import Foundation

/// A session queued behind a full runner, run or batch (queuedReason `runner_at_capacity`,
/// `tree_at_capacity`, `batch_at_capacity`) — the native port of web `queuedCapacity.ts`
/// (docs/mocks/queued-card-runner-full, approved as recommended): the list's and header's word, the
/// foot-row tag `Queued · runner full` on each turn still waiting for its own turn (drawn where
/// `Queued · runner updating` is drawn), and the popover that counts how the slots are taken. A runner
/// counts a session against its maxConcurrent while it runs a turn OR while a background job of its
/// own still runs, so it can be full with fewer turns than slots: the server reports those slots apart
/// as `queuedHeldByJobs`. Every sentence is the web's, and `QueuedCapacityCopyParityTests` reads
/// `queuedCapacity.ts` back to keep it so.
public enum QueuedCapacity {
    public static let reasons: Set<String> = ["runner_at_capacity", "tree_at_capacity", "batch_at_capacity"]
    /// Web `RUNNER_FULL_TITLE` and the rest: the list chip, the header word and the popover's title.
    public static let RUNNER_FULL_TITLE = "Runner full"
    public static let RUNNER_FULL_TAG = "runner full"
    public static let RUN_FULL_TITLE = "Run full"
    public static let RUN_FULL_TAG = "run full"
    public static let BATCH_FULL_TITLE = "Batch full"
    public static let BATCH_FULL_TAG = "batch full"
    /// Web `CAPACITY_HELD_LINE`: the session list's line for any of the three (board
    /// session-row-runner-full, the owner's pick C). The row's own time already counts the wait, so
    /// the line adds no clock; which gate is full is the row's tooltip (`rowHint`) on the Mac.
    public static let CAPACITY_HELD_LINE = "Waiting for a free slot"

    /// Whether a full runner, run or batch holds this session: queued, and the server named that gate.
    public static func holds(_ s: Session) -> Bool {
        s.effectiveRunState == .queued && s.queuedReason.map(reasons.contains) == true
    }

    /// `Runner full`, `Run full` or `Batch full`. Web `capacityHeldTitle`.
    public static func title(_ s: Session) -> String {
        switch s.queuedReason {
        case "tree_at_capacity": return RUN_FULL_TITLE
        case "batch_at_capacity": return BATCH_FULL_TITLE
        default: return RUNNER_FULL_TITLE
        }
    }

    /// The foot-row tag's words: `runner full`, `run full` or `batch full`. Web `capacityHeldTag`.
    public static func tag(_ s: Session) -> String { tag(reason: s.queuedReason) }

    public static func tag(reason: String?) -> String {
        switch reason {
        case "tree_at_capacity": return RUN_FULL_TAG
        case "batch_at_capacity": return BATCH_FULL_TAG
        default: return RUNNER_FULL_TAG
        }
    }

    private static func counted(active: Int?, limit: Int?) -> String {
        guard let active, let limit else { return "" }
        return " (\(active)/\(limit))"
    }

    /// What the tag opens (board ③ and ⑤). Web `capacityHeldMessageText`.
    public static func messageText(_ s: Session, machine: String?) -> String {
        messageText(reason: s.queuedReason, active: s.queuedActive, limit: s.queuedLimit,
                    heldByJobs: s.queuedHeldByJobs, machine: machine)
    }

    public static func messageText(reason: String?, active: Int?, limit: Int?, heldByJobs: Int?,
                                   machine: String?) -> String {
        if reason == "tree_at_capacity" {
            return "This run is already using all its slots\(counted(active: active, limit: limit)). This message is sent as soon as one of its sessions finishes."
        }
        if reason == "batch_at_capacity" {
            return "This batch is running its maximum\(counted(active: active, limit: limit)). This message is sent as soon as one of its sessions finishes."
        }
        let m = machine?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let who = m.isEmpty ? "The runner" : m
        guard let active, let limit else {
            return "\(who) is using all its slots. This message is sent as soon as one frees up."
        }
        let held = heldByJobs ?? 0
        if held > 0 {
            let turns = max(0, active - held)
            let running = turns == 1 ? "1 session is running a turn" : "\(turns) sessions are running a turn"
            return "\(who) is using all \(limit) slots: \(running) and \(held) \(held == 1 ? "holds" : "hold") a slot with a background job. This message is sent as soon as one frees up."
        }
        let sessions = limit == 1 ? "1 session" : "\(limit) sessions"
        return "\(who) is running \(active) of \(sessions). This message is sent as soon as one finishes."
    }

    /// The same sentence said of a scheduled run waiting for its first turn. Web `capacityHeldRunText`.
    public static func runText(_ gate: ScheduleRunQueueGate, machine: String?) -> String {
        messageText(reason: gate.queuedReason, active: gate.queuedActive, limit: gate.queuedLimit,
                    heldByJobs: gate.queuedHeldByJobs, machine: machine)
            .replacingOccurrences(of: "This message is sent", with: "The run starts")
    }

    /// The list row's tooltip: the popover's title, sentence and wait, one per line; nil for a row no
    /// full runner, run or batch holds. Web `capacityHeldHint`.
    public static func rowHint(_ s: Session, machine: String?, now: Date) -> String? {
        guard holds(s) else { return nil }
        return [title(s), messageText(s, machine: machine), waited(s, now: now)].compactMap { $0 }.joined(separator: "\n")
    }

    /// `Waiting 15 min`, from when the session went PENDING; nil with no clock to read. Web
    /// `capacityHeldWaited`.
    public static func waited(_ s: Session, now: Date) -> String? { waited(since: s.lastTurnAt, now: now) }

    public static func waited(since: String?, now: Date) -> String? {
        guard let since, let at = RelativeTime.parse(since), at <= now else { return nil }
        let minutes = Int(now.timeIntervalSince(at) / 60)
        if minutes < 1 { return "Waiting less than a minute" }
        if minutes < 60 { return "Waiting \(minutes) min" }
        let rest = minutes % 60
        return "Waiting \(minutes / 60) h" + (rest > 0 ? " \(rest) min" : "")
    }
}
