import Foundation

// The maintenance part of the Wiki home's status line (criterion 5, mock 12 ④) — a port of the web's
// `src/web/src/lib/wikiHealth.ts`, word for word. Both are held to `src/shared/src/wiki-health.fixture.json`
// (`WikiHealthCopyParityTests` here, `lib/wikiHealth.test.ts` there), and every constant below is looked up
// by its declaration in the web's file, so the two clients say one sentence for one read.

/// The status line's words (UI copy is English), each the web constant named beside it.
public enum WikiHealthCopy {
    public static let maintenanceOff = "Maintenance off"                  // WIKI_MAINTENANCE_OFF
    public static let setUp = "Set up"                                    // WIKI_MAINTENANCE_SET_UP
    public static let maintenanceOn = "Maintenance on"                    // WIKI_MAINTENANCE_ON
    public static let maintenanceBehind = "Maintenance behind"            // WIKI_MAINTENANCE_BEHIND
    public static let dailyLimitReached = "daily limit reached"           // WIKI_DAILY_LIMIT_REACHED
    public static let reviewQueueFull = "review queue full"               // WIKI_REVIEW_QUEUE_FULL
    public static func maintained(_ ago: String) -> String { "Maintained \(ago)" }                          // wikiMaintained
    public static func maintainingNow(_ ago: String) -> String { "Maintaining now · started \(ago)" }       // wikiMaintainingNow
    public static func toCatchUp(_ count: Int) -> String { "\(WikiArticleCopy.count(count)) to catch up" }  // wikiToCatchUp
    public static func behindBy(_ count: Int, lag: String) -> String {                                     // wikiBehindBy
        "\(WikiArticleCopy.count(count)) to catch up, oldest \(lag)"
    }
    public static func lastRun(_ ago: String) -> String { "last run \(ago)" }                               // wikiLastRun
    public static func lastSuccess(_ ago: String) -> String { "last success \(ago)" }                       // wikiLastSuccess
    public static func failed(_ count: Int) -> String {                                                    // wikiMaintenanceFailed
        count == 1 ? "Maintenance failed" : "Maintenance failed \(count) times"
    }

    // MARK: the server's reasons (mock 35 ⑥, P9)

    public static let reasonWorker = "wiki worker not running"                        // WIKI_REASON_WORKER
    public static let reasonUnconfigured = "System model not configured"              // WIKI_REASON_UNCONFIGURED
    public static let reasonKeyRefused = "System model refused the key"               // WIKI_REASON_KEY_REFUSED
    public static let reasonUnreachable = "System model unreachable"                  // WIKI_REASON_UNREACHABLE
    public static let reasonRunnerOffline = "Waiting for the runner to come online"   // WIKI_REASON_RUNNER_OFFLINE
    public static let reasonRunnerUpgrade = "Upgrade the runner to read the repository"   // WIKI_REASON_RUNNER_UPGRADE

    // MARK: the repository's part (docs/wiki-repo-tiers-design.md §7.2, mock 44 ⑤)

    public static let repoFolder = "Reading the folder, not git"                  // WIKI_REPO_FOLDER
    public static let repoFolderShort = "Reading the folder"                      // WIKI_REPO_FOLDER_SHORT
    public static let repoPaused = "Code checks paused"                           // WIKI_REPO_PAUSED
    public static let repoWrongShort = "Wrong folder"                             // WIKI_REPO_WRONG_SHORT
    public static let repoFix = "Fix in Settings"                                 // WIKI_REPO_FIX
    public static let repoCommitAnchors = "Commit anchors are not checked"        // WIKI_REPO_COMMIT_ANCHORS
    public static func repoPaused(_ detail: String) -> String { "\(repoPaused): \(detail)" }          // wikiRepoPaused
    public static func repoFolderHint(_ detail: String?) -> String {                                  // wikiRepoFolderHint
        if let detail, !detail.isEmpty { return "\(repoCommitAnchors): \(detail)." }
        return "\(repoCommitAnchors)."
    }
}

/// One part of the status line: its words, how it is coloured and marked, and where it leads when it is a
/// link (the web's `WikiStatusPart`).
public struct WikiStatusPart: Equatable, Sendable {
    /// muted: grey; warn: amber, a run that waits; error: red, a run that broke.
    public enum Tone: String, Sendable { case plain, muted, warn, error }
    /// check: a green ✓ after it; dot: a coloured dot before it; spin: a spinner before it on a wide screen.
    public enum Mark: String, Sendable { case none, check, dot, spin }
    /// settings: the space's Wiki settings; run: the run that ended last — its session, or its row on Activity.
    public enum Link: String, Sendable { case none, settings, run }

    public let text: String
    public let tone: Tone
    public let mark: Mark
    public let link: Link
    public let strong: Bool
    /// What a pointer resting on it is told (the folder tier's cost); nil when there is nothing more to say.
    public let hint: String?

    public init(_ text: String, tone: Tone = .plain, mark: Mark = .none, link: Link = .none, strong: Bool = false,
                hint: String? = nil) {
        self.text = text
        self.tone = tone
        self.mark = mark
        self.link = link
        self.strong = strong
        self.hint = hint
    }
}

public enum WikiHealthLogic {
    /// "just now", "4m ago", "2h ago", "1d ago", "3w ago" — the web's `wikiAgo`. A time that cannot be
    /// read, or one a little ahead of this clock, is no time ago at all.
    public static func ago(_ iso: String, now: Date) -> String {
        guard let date = RelativeTime.parse(iso) else { return "just now" }
        let diff = now.timeIntervalSince(date)
        let minute = 60.0, hour = 3600.0, day = 86_400.0
        if diff < minute { return "just now" }
        if diff < hour { return "\(Int(diff / minute))m ago" }
        if diff < day { return "\(Int(diff / hour))h ago" }
        if diff < 7 * day { return "\(Int(diff / day))d ago" }
        return "\(Int(diff / (7 * day)))w ago"
    }

    /// How old the oldest waiting fact is: hours up to three days, then days — the web's `wikiLag`.
    public static func lag(_ seconds: Int) -> String {
        let s = max(0, seconds)
        if s < 3600 { return "\(s / 60)m" }
        if s < 3 * 86_400 { return "\(s / 3600)h" }
        return "\(s / 86_400)d"
    }

    /// The maintenance part of the line in the space's look (contract `maintenance.health.look`) — the
    /// web's `wikiMaintenanceParts`. A look this build does not know draws nothing.
    public static func parts(_ health: WikiMaintenanceHealth, now: Date) -> [WikiStatusPart] {
        let catchUp = WikiStatusPart(WikiHealthCopy.toCatchUp(health.backlog))
        switch health.look {
        case .off:
            return [WikiStatusPart(WikiHealthCopy.maintenanceOff, tone: .muted),
                    WikiStatusPart(WikiHealthCopy.setUp, link: .settings)]
        case .running:
            return [WikiStatusPart(WikiHealthCopy.maintainingNow(ago(health.running?.startedAt ?? "", now: now)), mark: .spin),
                    catchUp]
        case .behind:
            var parts = [WikiStatusPart(WikiHealthCopy.maintenanceBehind, tone: .warn, mark: .dot, strong: true),
                         WikiStatusPart(WikiHealthCopy.behindBy(health.backlog, lag: lag(health.lagSeconds)), tone: .warn)]
            if let lastRunAt = health.lastRunAt { parts.append(WikiStatusPart(WikiHealthCopy.lastRun(ago(lastRunAt, now: now)))) }
            if health.dailyLimitReached {
                parts.append(WikiStatusPart(WikiHealthCopy.dailyLimitReached))
            } else if health.held?.reason == .reviewQueueFull {
                parts.append(WikiStatusPart(WikiHealthCopy.reviewQueueFull))
            }
            return parts
        case .failing:
            var parts = [WikiStatusPart(WikiHealthCopy.failed(health.consecutiveFailures), tone: .error, mark: .dot, strong: true)]
            if let lastOkAt = health.lastOkAt { parts.append(WikiStatusPart(WikiHealthCopy.lastSuccess(ago(lastOkAt, now: now)))) }
            parts.append(catchUp)
            if health.lastRun?.sessionId != nil || health.lastRun?.jobId != nil {
                parts.append(WikiStatusPart(WikiModeCopy.viewRun, link: .run))
            }
            return parts
        case .ok:
            let lead = health.lastOkAt.map { WikiStatusPart(WikiHealthCopy.maintained(ago($0, now: now)), mark: .check) }
                ?? WikiStatusPart(WikiHealthCopy.maintenanceOn)
            return [lead, catchUp]
        case .unknown:
            return []
        }
    }

    /// Why the server's runs do not move, while the server executes the account's wiki — the web's
    /// `wikiServerReason`: the first that holds of the worker, the model's configuration, its key and its
    /// reachability, then — while maintenance is on or a read of the repository waits — the runner.
    public static func serverReason(_ health: WikiSpaceHealth) -> WikiStatusPart? {
        guard health.serverExecutes else { return nil }
        let reason = { (text: String, tone: WikiStatusPart.Tone) in WikiStatusPart(text, tone: tone, mark: .dot, strong: true) }
        switch health.systemModel?.state {
        case .workerNotRunning?: return reason(WikiHealthCopy.reasonWorker, .error)
        case .unconfigured?:     return reason(WikiHealthCopy.reasonUnconfigured, .error)
        case .authFailed?:       return reason(WikiHealthCopy.reasonKeyRefused, .error)
        case .down?:             return reason(WikiHealthCopy.reasonUnreachable, .warn)
        default:                 break
        }
        guard let repo = health.repo, health.maintenance.enabled || repo.pending > 0 else { return nil }
        // The repository part says it already: the latest run read nothing for this very reason (`repoParts`).
        if !repoParts(health, narrow: false).isEmpty, repo.reason == repo.look.rawValue { return nil }
        switch repo.look {
        case .runnerOffline: return reason(WikiHealthCopy.reasonRunnerOffline, .warn)
        case .runnerUpgrade: return reason(WikiHealthCopy.reasonRunnerUpgrade, .warn)
        default:             return nil
        }
    }

    /// The repository's part of the line (see `WikiHealthCopy.repoFolder`) — the web's `wikiRepoParts`: its words
    /// first, and on a wide screen `Fix in Settings` after them when somebody has to act. Nothing while maintenance
    /// is off, on git, and from a read that names no tier.
    public static func repoParts(_ health: WikiSpaceHealth, narrow: Bool) -> [WikiStatusPart] {
        guard health.maintenance.enabled, let repo = health.repo, let tier = repo.tier,
              tier != .git, tier != .unknown else { return [] }
        if tier == .folder {
            return narrow
                ? [WikiStatusPart(WikiHealthCopy.repoFolderShort, tone: .muted, link: .settings)]
                : [WikiStatusPart(WikiHealthCopy.repoFolder, tone: .muted, link: .settings,
                                  hint: WikiHealthCopy.repoFolderHint(repo.detail))]
        }
        let wrong = tier == .wrongRepository
        let tone: WikiStatusPart.Tone = wrong || WikiRepoTier.reasonNeedsAttention(repo.reason) ? .error : .warn
        let detail = (repo.detail?.isEmpty == false) ? repo.detail : nil
        let said: String
        if narrow {
            said = wrong ? WikiHealthCopy.repoWrongShort : WikiHealthCopy.repoPaused
        } else if wrong {
            said = detail ?? WikiHealthCopy.repoWrongShort
        } else {
            said = detail.map { WikiHealthCopy.repoPaused($0) } ?? WikiHealthCopy.repoPaused
        }
        let words = WikiStatusPart(said, tone: tone, mark: .dot, strong: true)
        return narrow ? [words] : [words, WikiStatusPart(WikiHealthCopy.repoFix, link: .settings)]
    }

    /// The status line's whole maintenance part — the web's `wikiStatusParts`: the look's parts, then the server's
    /// reason and the repository's words before their links, and `Fix in Settings` last. `narrow` is a phone's line,
    /// which says the repository's short words.
    public static func parts(_ health: WikiSpaceHealth, now: Date, narrow: Bool = false) -> [WikiStatusPart] {
        let parts = parts(health.maintenance, now: now)
        let repo = repoParts(health, narrow: narrow)
        let said = (serverReason(health).map { [$0] } ?? [])
            + repo.filter { $0.link == .none || $0.text != WikiHealthCopy.repoFix }
        let fix = repo.filter { $0.text == WikiHealthCopy.repoFix }
        guard let link = parts.firstIndex(where: { $0.link != .none }) else { return parts + said + fix }
        return Array(parts[..<link]) + said + Array(parts[link...]) + fix
    }

    /// The parts as one line of text: `●` before a dot, `✓` after a check, ` · ` between — the web's
    /// `wikiStatusText`, and what VoiceOver reads.
    public static func text(_ parts: [WikiStatusPart]) -> String {
        parts.map { part in
            (part.mark == .dot ? "● " : "") + part.text + (part.mark == .check ? " ✓" : "")
        }
        .joined(separator: " · ")
    }
}
