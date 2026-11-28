import Foundation

/// One durable mode change from the session detail, oldest first. `seq` is the order it was recorded in
/// (migration 1810): two changes can share `at`, never a seq. Nil from a server older than that, which pages none.
public struct SessionPermissionModeChange: Codable, Equatable, Sendable {
    public let fromMode: String?
    public let toMode: String
    public let cause: String
    public let client: String?
    public let at: String
    public var seq: Int? = nil
    /// For a CLAIM that handed another mode than the session asked for: the mode asked for, and why
    /// (`ROOT_RUNNER`, `SCHEDULED_RUN`). Nil otherwise, and from a server that does not say.
    public var requestedMode: String? = nil
    public var reason: String? = nil

    /// By its seq where the server numbers it, so repeated transitions at one moment are rows apart.
    var rowID: String {
        if let seq { return "permission-mode-seq-\(seq)" }
        return "permission-mode-\(at)-\(fromMode ?? "")-\(toMode)-\(cause)-\(client ?? "")"
    }

    public var line: String {
        let mode = Self.label(toMode)
        switch cause {
        case "CLAIM":
            // The server's own word on why the claim handed another mode than the one asked for.
            let start = fromMode == nil ? "Started in" : "Resumed in"
            switch reason {
            case "SCHEDULED_RUN":
                return "\(start) \(mode) — scheduled runs always use Auto"
            case "ROOT_RUNNER":
                let asked = Self.label(requestedMode ?? PermissionMode.bypass.rawValue)
                return "\(start) \(mode), not \(asked) — \(asked) can't run on a root runner"
            default:
                break
            }
            if let fromMode { return "Claimed in \(mode) — previously \(Self.label(fromMode))" }
            return "Started in \(mode) — assigned at claim"
        case "OWNER_PICK":
            let source: String
            switch client {
            case "ios": source = " on iOS"
            case "macos": source = " on Mac"
            case "web": source = " on the web"
            case "android": source = " on Android"
            case "terminal": source = " in the terminal"
            default: source = ""
            }
            return "Mode set to \(mode) by you\(source)"
        case "ENGINE_REPORT":
            return "Engine reported \(mode)"
        case "RUNNER_CORRECTION":
            if let fromMode {
                return "Mode set back to \(mode) by the runner — the engine had been in \(Self.label(fromMode))"
            }
            return "Mode set to \(mode) by the runner"
        case "RESPAWN":
            return "Engine restarted in \(mode)"
        case "ORBIT_CHANGE":
            return "Mode set to \(mode) by Orbit"
        default:
            return "Mode changed to \(mode)"
        }
    }

    static func label(_ raw: String) -> String {
        PermissionMode(rawValue: raw).map(AgentDefaults.label) ?? raw
    }
}

/// The session detail's word on the newest correction Claude refused (`permissionModeCorrectionRefusal`, migration 1821):
/// carried while it still answers the newest change, whether or not its event is among those loaded.
public struct SessionPermissionModeCorrectionRefusal: Codable, Equatable, Sendable {
    public let mode: String
    public let requestedMode: String
    public let reason: String
    public let at: String

    public init(mode: String, requestedMode: String, reason: String, at: String) {
        self.mode = mode
        self.requestedMode = requestedMode
        self.reason = reason
        self.at = at
    }
}

/// The runner's report that Claude would not take the Auto it asked for (`permission_mode_correction_failed`,
/// runner-go claude_mode_correction.go): `mode` is the mode it stays in, `reason` the CLI's own words. It is a
/// system event of the conversation, not a mode change, so it is read off the events loaded; the session detail
/// carries the one that still stands (`init(detail:)`).
public struct PermissionModeRefusal: Equatable, Hashable, Sendable {
    public let seq: Int
    public let at: String
    public let mode: String
    public let requested: String
    public let reason: String

    public static let eventSubtype = "permission_mode_correction_failed"

    public init(seq: Int, at: String, mode: String, requested: String, reason: String) {
        self.seq = seq
        self.at = at
        self.mode = mode
        self.requested = requested
        self.reason = reason
    }

    /// The seq of a refusal read off the session detail, which names no event: it is never a transcript row.
    public static let detailSeq = -1

    /// The refusal the session detail carries.
    public init(detail: SessionPermissionModeCorrectionRefusal) {
        self.init(seq: Self.detailSeq, at: detail.at, mode: detail.mode, requested: detail.requestedMode,
                  reason: detail.reason.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// The refusal that is the gap now, if one is: the newest loaded event's when it stands, so its transcript line is
    /// the gap's; else the detail's, which stands whether or not its event is loaded (paged out of a long session).
    public static func standing(loaded: [PermissionModeRefusal], detail: SessionPermissionModeCorrectionRefusal?,
                                latest: SessionPermissionModeChange?, actual: String?) -> PermissionModeRefusal? {
        if let event = loaded.last, event.stands(latest: latest, actual: actual) { return event }
        guard let detail else { return nil }
        let refusal = PermissionModeRefusal(detail: detail)
        return refusal.stands(latest: latest, actual: actual) ? refusal : nil
    }

    /// The refusal `event` reports, or nil for any other event.
    public init?(event: RunEvent) {
        guard event.type == .system,
              event.payload["subtype"]?.stringValue == Self.eventSubtype,
              let mode = event.payload["mode"]?.stringValue else { return nil }
        self.init(seq: event.seq, at: event.ts ?? "", mode: mode,
                  requested: event.payload["requested"]?.stringValue ?? PermissionMode.auto.rawValue,
                  reason: (event.payload["reason"]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines))
    }

    var rowID: String { "permission-mode-refused-\(seq)" }

    /// Its transcript line: the runner could not switch Claude, and why.
    public var line: String {
        let stays = "Claude stays in \(SessionPermissionModeChange.label(mode)) — the runner couldn't switch it to \(SessionPermissionModeChange.label(requested))"
        return reason.isEmpty ? stays : "\(stays): \(reason)"
    }

    /// How far the runner's clock may run behind the server's: the refusal is stamped by the runner, the report of
    /// the lower mode it answers by the server.
    static let clockSlack: TimeInterval = 60

    /// Whether this refusal answers the change the engine runs under now: Claude's report of the mode it settled on
    /// (or came back from a re-spawn in), which the runner then failed to correct. Any later change ends it.
    public func stands(latest: SessionPermissionModeChange?, actual: String?) -> Bool {
        guard let latest, let actual, latest.cause == "ENGINE_REPORT" || latest.cause == "RESPAWN",
              latest.toMode == actual, mode == actual else { return false }
        guard let refusedAt = Self.instant(at), let reportedAt = Self.instant(latest.at) else { return true }
        return refusedAt >= reportedAt.addingTimeInterval(-Self.clockSlack)
    }

    /// The index of the change this refusal answers in `changes`: the newest report of the mode it stays in, from before
    /// it. Its line goes with the refusal's: the server stamps a change when it took the runner's batch, after the runner's
    /// own stamp on the refusal, so placed by time alone the report would land below its answer.
    public func answeredChange(in changes: [SessionPermissionModeChange]) -> Int? {
        let refusedAt = Self.instant(at)
        return changes.indices.last { i in
            let change = changes[i]
            guard change.cause == "ENGINE_REPORT" || change.cause == "RESPAWN", change.toMode == mode else { return false }
            guard let refusedAt, let reportedAt = Self.instant(change.at) else { return true }
            return reportedAt <= refusedAt.addingTimeInterval(Self.clockSlack)
        }
    }

    static func instant(_ iso: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }
}

/// A page of a session's older mode changes (`GET /sessions/:id/permission-mode-changes?before=<seq>`): oldest first, and
/// whether older ones remain.
public struct SessionPermissionModeChangePage: Codable, Equatable, Sendable {
    public let changes: [SessionPermissionModeChange]
    public let hasMore: Bool

    public init(changes: [SessionPermissionModeChange], hasMore: Bool) {
        self.changes = changes
        self.hasMore = hasMore
    }
}

/// Every mode change a transcript holds, not only the detail's newest fifty (web `permissionModeChangeHistory`, Android
/// `ModeChangeHistory`): the detail's, and the older pages read as the transcript pages back, until the oldest held is
/// older than the oldest row loaded or, once the transcript reaches the session's start, until none are left. Each change
/// once, by its seq, in the order it was recorded. A change that falls out of the detail's fifty stays; a detail that no
/// longer reaches what is held (more than a page recorded since the last read) starts it again, so none in between is missed.
public struct ModeChangeHistory: Equatable, Sendable {
    public private(set) var changes: [SessionPermissionModeChange]
    /// Whether older changes than `changes.first` are recorded.
    public private(set) var hasMore: Bool

    public init(changes: [SessionPermissionModeChange] = [], hasMore: Bool = false) {
        self.changes = changes
        self.hasMore = hasMore
    }

    /// With the detail's read taken in. A change with no seq (an older server) is held as the detail says, alone.
    public func adopt(_ detail: [SessionPermissionModeChange], hasMore detailHasMore: Bool) -> ModeChangeHistory {
        if detail.contains(where: { $0.seq == nil }) { return ModeChangeHistory(changes: detail, hasMore: false) }
        if changes.isEmpty { return ModeChangeHistory(changes: detail, hasMore: detailHasMore) }
        guard let first = detail.first else { return self }
        let known = Set(changes.compactMap(\.seq))
        if detailHasMore, let seq = first.seq, !known.contains(seq) { return ModeChangeHistory(changes: detail, hasMore: true) }
        if detail.allSatisfy({ $0.seq.map(known.contains) ?? false }), detailHasMore || !hasMore { return self }
        return ModeChangeHistory(changes: Self.joined(changes, detail), hasMore: detailHasMore && hasMore)
    }

    /// With a page read for `before`, while that is still the oldest held: another start since makes it not this one's.
    public func withOlder(before: Int, _ page: SessionPermissionModeChangePage) -> ModeChangeHistory {
        guard changes.first?.seq == before else { return self }
        return ModeChangeHistory(changes: Self.joined(page.changes, changes), hasMore: page.hasMore)
    }

    /// Whether to read the page before the oldest held for a transcript whose oldest loaded row is stamped
    /// `oldestRowAt` (none loaded: not yet), and which reaches the session's start when `reachesStart`.
    public func needsOlder(oldestRowAt: String?, reachesStart: Bool) -> Bool {
        guard hasMore, let oldest = changes.first, oldest.seq != nil, let oldestRowAt else { return false }
        if reachesStart { return true }
        guard let at = ThinkingSummary.date(oldest.at), let row = ThinkingSummary.date(oldestRowAt) else { return false }
        // A change at the same moment as the oldest row may have older ones beside it.
        return !(at < row)
    }

    /// The same, for the transcript `state` holds: its oldest row with a clock, and whether it has paged back to the start.
    public func needsOlder(in state: TranscriptState) -> Bool {
        needsOlder(oldestRowAt: state.items.lazy.compactMap(\.clock).first,
                   reachesStart: state.maxSeq > 0 && !state.hasMoreOlder)
    }

    private static func joined(_ older: [SessionPermissionModeChange],
                               _ newer: [SessionPermissionModeChange]) -> [SessionPermissionModeChange] {
        var bySeq: [Int: SessionPermissionModeChange] = [:]
        for change in older + newer { if let seq = change.seq { bySeq[seq] = change } }
        return bySeq.values.sorted { ($0.seq ?? 0) < ($1.seq ?? 0) }
    }
}

public struct SessionModeDisplay: Equatable, Sendable {
    public let label: String
    public let reason: String?
    public let isCorrecting: Bool

    public init(intent: PermissionMode, actual: String?, beforeStart: Bool,
                latestChange: SessionPermissionModeChange? = nil,
                runsAsRoot: Bool = false, autoStartsInDefault: Bool = false,
                refusal: PermissionModeRefusal? = nil) {
        let requested = AgentDefaults.label(intent)
        guard let actual else {
            label = beforeStart ? requested : "Mode unconfirmed"
            reason = nil
            isCorrecting = false
            return
        }
        let running = SessionPermissionModeChange.label(actual)
        guard actual != intent.rawValue else {
            label = running
            reason = nil
            isCorrecting = false
            return
        }
        // The runner asked Claude for Auto and Claude said no: a gap that lasts (the board's "Default" with its
        // amber), nothing under way, and the CLI's own words for why.
        if let refusal, refusal.stands(latest: latestChange, actual: actual) {
            label = running
            isCorrecting = false
            let asked = SessionPermissionModeChange.label(refusal.requested)
            let words = refusal.reason.isEmpty ? ""
                : ": " + refusal.reason + (refusal.reason.hasSuffix(".") ? "" : ".")
            reason = "Running in \(running). You asked for \(asked), but the runner couldn't switch Claude to it"
                + (words.isEmpty ? "." : words)
            return
        }
        label = "\(running) → \(requested)"
        isCorrecting = intent == .auto && actual == PermissionMode.default.rawValue
            && latestChange?.toMode == actual && latestChange?.cause == "ENGINE_REPORT"
            && !autoStartsInDefault
        if isCorrecting {
            reason = "Running in \(running). The engine started below the Auto you asked for. The runner is switching it to Auto."
        } else if intent == .bypass && runsAsRoot && latestChange?.cause == "CLAIM" {
            reason = "Running in \(running). Bypass can't run on a root runner."
        } else if intent == .auto && autoStartsInDefault && actual == PermissionMode.default.rawValue {
            reason = "Running in Default. Auto starts in Default on this model."
        } else {
            let summary = "Running in \(running). You asked for \(requested)."
            reason = latestChange.flatMap { $0.toMode == actual ? "\(summary) \($0.line)." : nil } ?? summary
        }
    }

    /// This hint does not affect the selected mode. A missing Auto on a known-capable
    /// model can be a transient runner probe result.
    public static func autoStartHint(model: String, engine: String, provider: String,
                                     configured: [ConfiguredProvider], catalog: RunnerModelCatalog?) -> String? {
        guard !AgentDefaults.autoCapableModels.contains(model),
              !AgentDefaults.supportsAuto(model, engine: engine, provider: provider,
                                          configured: configured, catalog: catalog) else { return nil }
        return "starts in Default"
    }
}
