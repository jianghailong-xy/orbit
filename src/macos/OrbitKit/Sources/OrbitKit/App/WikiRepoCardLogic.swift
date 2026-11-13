import Foundation

/// The Settings maintenance card's repository part, and the settings' probe under the workspace picker
/// (docs/wiki-repo-tiers-design.md §7.3, mock 44 ⑤) — the web's `lib/wikiRepoCard.ts`, held to the same
/// `src/shared/src/wiki-repo-card.fixture.json` by `WikiRepoCardParityTests`.
public enum WikiRepoCardCopy {
    public static let checkAndRun = "Check again and run now"                  // WIKI_CHECK_AND_RUN
    public static let changeWorkspace = "Change workspace…"                    // WIKI_CHANGE_WORKSPACE
    public static let useFolder = "Use this folder"                            // WIKI_USE_FOLDER
    public static let dailyLimit = "Daily limit reached"                       // WIKI_DAILY_LIMIT_HIT
    public static let runUnderWay = "A run is under way"                       // WIKI_RUN_UNDER_WAY
    public static let lastRunFailed = "Last run failed"                        // WIKI_LAST_RUN_FAILED
    public static let lastRunFailedLine = "The last run failed"                // WIKI_LAST_RUN_FAILED_LINE
    public static let useFolderTitle = "Use this folder?"                      // WIKI_USE_FOLDER_TITLE
    public static let useFolderNote =                                          // WIKI_USE_FOLDER_NOTE
        "The next run keeps this folder's snapshot even though it shares few files with the last one, and later runs compare with it."
    public static let runStarted = "Maintenance run started"                   // WIKI_RUN_STARTED
    public static let runRefused = "Couldn't start the run"                    // WIKI_RUN_REFUSED
    public static let probeChecking = "Checking the folder…"                   // WIKI_PROBE_CHECKING
    public static let probeFailed = "Could not check the folder"               // WIKI_PROBE_FAILED
    public static let folderReading = "Folder, not git · commit anchors off"   // WIKI_FOLDER_READING
}

/// What the card says of the last run's read, and what may be pressed.
public struct WikiRepoCard: Equatable, Sendable {
    public enum Tone: String, Sendable { case muted, warn, error }

    public let tag: String
    public let tone: Tone
    /// What was read and when: `~/work/app was not found on MacBook · checked 2h ago`.
    public let line: String
    /// Check again and run now may be pressed; when it may not, `blocked` says why.
    public let canRun: Bool
    public let blocked: String?
    /// Use this folder is offered: the last read was refused for path_overlap.
    public let useFolder: Bool

    public init(tag: String, tone: Tone, line: String, canRun: Bool, blocked: String?, useFolder: Bool) {
        self.tag = tag
        self.tone = tone
        self.line = line
        self.canRun = canRun
        self.blocked = blocked
        self.useFolder = useFolder
    }
}

public enum WikiRepoCardLogic {
    /// The web's `wikiRepoCard`: nil while maintenance is off, or the last run read git and did not fail.
    public static func card(_ health: WikiSpaceHealth, now: Date) -> WikiRepoCard? {
        let maintenance = health.maintenance
        guard maintenance.enabled else { return nil }
        let repo = health.repo
        let tier = repo?.tier == .unknown ? nil : repo?.tier
        let failed = maintenance.lastRun?.outcome == "failed"
        if (tier == nil || tier == .git) && !failed { return nil }
        let tag: String
        let tone: WikiRepoCard.Tone
        switch tier {
        case .folder?: (tag, tone) = (WikiHealthCopy.repoFolderShort, .muted)
        case .sessions?: (tag, tone) = (WikiHealthCopy.repoPaused, repo?.reason == "fetch_refused" ? .error : .warn)
        case .wrongRepository?: (tag, tone) = (WikiHealthCopy.repoWrongShort, .error)
        default: (tag, tone) = (WikiRepoCardCopy.lastRunFailed, .error)
        }
        let said: String
        switch tier {
        case .folder?: said = WikiRepoCardCopy.folderReading
        case .sessions?, .wrongRepository?: said = repo?.detail ?? tag
        default: said = WikiRepoCardCopy.lastRunFailedLine
        }
        let when = repo?.checkedAt ?? maintenance.lastRun?.endedAt
        let line = when.map { "\(said) · checked \(WikiHealthLogic.ago($0, now: now))" } ?? said
        let blocked = maintenance.running != nil ? WikiRepoCardCopy.runUnderWay
            : maintenance.dailyLimitReached ? WikiRepoCardCopy.dailyLimit : nil
        return WikiRepoCard(tag: tag, tone: tone, line: line, canRun: blocked == nil, blocked: blocked,
                            useFolder: repo?.reason == "path_overlap")
    }
}

/// `POST /wiki/spaces/:id/maintenance/probe`: which tier the chosen workspace's folder would be read on, in the words
/// the server says it (contract `maintenance.probe`). `tone` is ok, folder, paused, wrong or unchecked.
public struct WikiRepoProbeAnswer: Codable, Equatable, Sendable {
    public let workspaceId: String
    public let tier: String?
    public let reason: String?
    public let origin: String?
    public let tone: String
    public let title: String
    public let note: String?
    public let canTurnOn: Bool
    public let checkedAt: String

    public init(workspaceId: String, tier: String?, reason: String?, origin: String?, tone: String, title: String,
                note: String?, canTurnOn: Bool, checkedAt: String) {
        self.workspaceId = workspaceId
        self.tier = tier
        self.reason = reason
        self.origin = origin
        self.tone = tone
        self.title = title
        self.note = note
        self.canTurnOn = canTurnOn
        self.checkedAt = checkedAt
    }
}

/// What Check again and run now sends: `acceptFolder` true for Use this folder, left out otherwise.
public struct WikiMaintenanceRunRequest: Encodable, Sendable {
    public let acceptFolder: Bool?

    public init(acceptFolder: Bool?) { self.acceptFolder = acceptFolder }
}

/// `POST /wiki/spaces/:id/maintenance/run`: the run made.
public struct WikiMaintenanceRunNow: Codable, Equatable, Sendable {
    public let jobId: String
    public let runId: String
}
