import Foundation

/// One durable mode change from the session detail, oldest first. `seq` is the order it was recorded in
/// (migration 1780): two changes can share `at`, never a seq. Nil from a server older than that, which pages none.
public struct SessionPermissionModeChange: Codable, Equatable, Sendable {
    public let fromMode: String?
    public let toMode: String
    public let cause: String
    public let client: String?
    public let at: String
    public var seq: Int? = nil

    /// By its seq where the server numbers it, so repeated transitions at one moment are rows apart.
    var rowID: String {
        if let seq { return "permission-mode-seq-\(seq)" }
        return "permission-mode-\(at)-\(fromMode ?? "")-\(toMode)-\(cause)-\(client ?? "")"
    }

    public var line: String {
        let mode = Self.label(toMode)
        switch cause {
        case "CLAIM":
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
                runsAsRoot: Bool = false, autoStartsInDefault: Bool = false) {
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
