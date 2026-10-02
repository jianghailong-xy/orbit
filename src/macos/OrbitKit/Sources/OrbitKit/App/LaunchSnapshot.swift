import Foundation

// What a cold launch draws before the network has answered. Without it a relaunch had nothing to
// show until the workspace fetch — and the runner, provider and pool reads queued behind it — came
// back: a spinner, then "Select a workspace" over the empty pane, and only then the workspace you
// had been in, its sessions loading after that. The app writes this as it leaves the foreground and
// reads it back at launch, so the first frame is that workspace's session list as you left it; the
// launch's own fetches replace every piece of it as they land.

/// The server answers a cold launch draws from, as the previous run last held them.
public struct LaunchSnapshot: Codable, Equatable, Sendable {
    /// The account: its name, and the preferences the first frame already reads (the theme).
    public var user: User?
    /// The workspace list, and what its rows read beside it — runner names and the runner order.
    public var agents: [Agent]
    public var runnerNames: [String: String]
    public var runnerOrder: [String]
    /// The Open sessions (`GET /sessions?view=open`): the session list's rows, the needs-you banner
    /// and the workspace rows' badges.
    public var openSessions: [Session]

    public init(user: User?, agents: [Agent], runnerNames: [String: String], runnerOrder: [String],
                openSessions: [Session]) {
        self.user = user
        self.agents = agents
        self.runnerNames = runnerNames
        self.runnerOrder = runnerOrder
        self.openSessions = openSessions
    }

    /// The workspace a cold launch shows before its fetch answers: the remembered one while this
    /// snapshot still lists it, else its first in sidebar order — what
    /// `LoadFailureLogic.defaultLanding` picks from a fetched list. Nil when it lists none, which
    /// leaves the landing to the fetch.
    public func landingAgentID(lastAgentID: String?) -> String? {
        LoadFailureLogic.landingAgent(
            orderedAgentIDs: AgentListLogic.ordered(agents, runnerOrder: runnerOrder).map(\.id),
            lastAgentID: lastAgentID)
    }
}

/// One JSON file per instance, written atomically. Anything that can't be read back — no file yet,
/// a torn or foreign file, another `schemaVersion` — is no snapshot, and the launch waits for the
/// network as it always did.
public struct LaunchSnapshotStore: Sendable {
    public let file: URL
    /// Bump when a change to the snapshot, or to a model inside it, would read an older file wrongly.
    private static let schemaVersion = 1

    private struct Envelope: Codable { var version: Int; var snapshot: LaunchSnapshot }

    public init(file: URL) {
        self.file = file
    }

    /// Application Support/Orbit/Launch/<host>.json — scoped per instance, as the transcripts are
    /// (`ConsoleRegistry.defaultStore`), so two servers never share one.
    public static func defaultStore(for baseURL: URL) -> LaunchSnapshotStore {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let ok = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.")
        let host = String((baseURL.host ?? "default").map { ok.contains($0) ? $0 : "_" })
        return LaunchSnapshotStore(file: support.appendingPathComponent("Orbit/Launch/\(host).json"))
    }

    public func load() -> LaunchSnapshot? {
        guard let data = try? Data(contentsOf: file),
              let env = try? JSONDecoder().decode(Envelope.self, from: data),
              env.version == Self.schemaVersion else { return nil }
        return env.snapshot
    }

    public func save(_ snapshot: LaunchSnapshot) {
        guard let data = try? JSONEncoder().encode(Envelope(version: Self.schemaVersion, snapshot: snapshot))
        else { return }
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        // `.atomic` writes a temp file and renames it, so a write cut off as the app is suspended
        // leaves the previous snapshot rather than half of a new one.
        try? data.write(to: file, options: .atomic)
    }

    public func remove() {
        try? FileManager.default.removeItem(at: file)
    }
}
