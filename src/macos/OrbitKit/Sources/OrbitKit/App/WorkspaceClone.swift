import Foundation

/// A GitHub workspace's clone (docs/github-workspace-design.md §5.4, §8): the port of web's `lib/workspaceClone.ts`.
/// The state is the workspace's own column, read with the session detail; git's percentage is relayed by the realtime
/// stream (`agent.changed` with `clone`) and stored nowhere, so it lives in `CloneLedger`, for as long as the app runs.
public enum CloneState: String, Codable, Equatable, Sendable {
    case pending = "PENDING"
    case cloning = "CLONING"
    case ready = "READY"
    case failed = "FAILED"
}

/// A clone as the app last heard it.
public struct CloneHeard: Equatable, Sendable {
    public let state: CloneState
    public let progress: Int?
    /// When it was heard, to weigh it against a detail read since.
    public let at: Date?

    public init(state: CloneState, progress: Int? = nil, at: Date? = nil) {
        self.state = state
        self.progress = progress
        self.at = at
    }
}

/// Why a clone failed, said as the person can act on it (board 01, P5 frames).
public enum CloneFailure: Equatable, Sendable {
    case folderTaken, appRemoved, signInExpired, other
}

public enum WorkspaceClone {
    /// A relay's `clone` payload, or nil for anything else. The percentage is held to 0…100, whole.
    public static func cloneOf(_ value: JSONValue?) -> CloneHeard? {
        guard case .object(let fields)? = value, case .string(let raw)? = fields["state"],
              let state = CloneState(rawValue: raw) else { return nil }
        let progress: Int?
        switch fields["progress"] {
        case .int(let n)?: progress = max(0, min(100, n))
        case .double(let d)? where d.isFinite: progress = max(0, min(100, Int(d.rounded())))
        default: progress = nil
        }
        return CloneHeard(state: state, progress: progress)
    }

    /// The workspace and clone a realtime frame reports, or nil for any other frame. The server's `agent.changed` names
    /// the workspace as `agentId` (its older name); `id` is read for a frame that says so, and the envelope's own
    /// `agentId` last.
    public static func event(type: String, data: JSONValue?, envelopeAgentID: String? = nil)
        -> (workspaceID: String, clone: CloneHeard)? {
        guard type == "agent.changed" || type.hasPrefix("workspace."), case .object(let fields)? = data else { return nil }
        var id = ""
        if case .string(let agentID)? = fields["agentId"], !agentID.isEmpty { id = agentID }
        else if case .string(let plain)? = fields["id"], !plain.isEmpty { id = plain }
        else if let envelopeAgentID { id = envelopeAgentID }
        guard !id.isEmpty, let clone = cloneOf(fields["clone"]) else { return nil }
        return (id, clone)
    }

    /// Whether two spellings of a workspace id name the same workspace.
    public static func sameWorkspace(_ a: String?, _ b: String?) -> Bool {
        guard let a, let b, !a.isEmpty, !b.isEmpty else { return false }
        return PublicID.storageKey(a) == PublicID.storageKey(b)
    }

    /// Where a clone stands, from what the server stored (the detail's `cloneState`, read at `storedAt`) and what the
    /// stream said. Agreeing, the stream adds git's percentage. Disagreeing, the newer one wins: the stream is ahead of
    /// a detail read before it (a Retry's PENDING, a clone that just ended), and a detail read after it is ahead of the
    /// stream (a frame the app missed). A stored READY is an end nothing walks back.
    public static func now(stored: String?, live: CloneHeard?, storedAt: Date? = nil) -> CloneHeard? {
        guard let stored, let state = CloneState(rawValue: stored) else { return live }
        let fromStore = CloneHeard(state: state)
        guard let live, state != .ready else { return fromStore }
        if live.state == state { return live }
        if let storedAt, (live.at ?? .distantPast) <= storedAt { return fromStore }
        return live
    }

    /// `https://github.com/<owner>/<name>.git` → `owner/name`; nil for anything else.
    public static func repositoryOf(_ repoUrl: String?) -> String? {
        guard let repoUrl,
              let re = try? NSRegularExpression(pattern: #"^https://github\.com/([^/]+/[^/]+?)(?:\.git)?/?$"#),
              let match = re.firstMatch(in: repoUrl, range: NSRange(repoUrl.startIndex..., in: repoUrl)),
              let range = Range(match.range(at: 1), in: repoUrl) else { return nil }
        return String(repoUrl[range])
    }

    /// The three failures v1 names (board 01 note 14), read by pattern from the runner's or the server's English
    /// words; anything else is git's own words, shown as they are.
    public static func failureOf(_ error: String?) -> CloneFailure {
        let said = (error ?? "").lowercased()
        if said.contains("already exists on ") { return .folderTaken }
        if said.contains("github app is no longer installed") { return .appRemoved }
        if said.contains("connect github in settings") { return .signInExpired }
        return .other
    }

    /// A failure's reason as the line ends it: trimmed, with one full stop. Empty while the reason hasn't been read.
    public static func reason(_ error: String?) -> String {
        let said = (error ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !said.isEmpty else { return "" }
        return said.hasSuffix(".") ? said : said + "."
    }
}

/// What the stream said about each workspace's clone, keyed in one spelling of its id.
public struct CloneLedger: Equatable, Sendable {
    private var heard: [String: CloneHeard] = [:]

    public init() {}

    /// Record what the stream said. Answers whether its STATE moved (as opposed to its percentage alone), which is when
    /// what the server stores — the detail's cloneState — has to be read again. A percentage with no state change
    /// keeps the last one heard when it names none.
    @discardableResult
    public mutating func hear(_ workspaceID: String, _ clone: CloneHeard, at: Date = Date()) -> Bool {
        let key = PublicID.storageKey(workspaceID)
        let before = heard[key]
        let progress = clone.progress ?? (before?.state == clone.state ? before?.progress : nil)
        heard[key] = CloneHeard(state: clone.state, progress: progress, at: at)
        return before?.state != clone.state
    }

    public func heard(_ workspaceID: String?) -> CloneHeard? {
        guard let workspaceID, !workspaceID.isEmpty else { return nil }
        return heard[PublicID.storageKey(workspaceID)]
    }
}
