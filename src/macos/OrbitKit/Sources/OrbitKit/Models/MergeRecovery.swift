import Foundation

public struct MergeRecoveryCommit: Codable, Equatable, Sendable {
    public let sha: String
    public let subject: String
    public let author: String
    public let date: String
    /// Two or more parents. Absent from runners that predate it.
    public let merge: Bool?
    /// In an ALREADY_LANDED check's `landedCommits`: the session's own commit this origin commit
    /// carries — itself, or a copy with the same patch-id. Absent everywhere else.
    public let sourceSha: String?
}

/// Where a commit the push adds comes from (web's `mergeRecoveryCommitOrigin`).
public enum MergeRecoveryCommitOrigin: Equatable, Sendable {
    case localOnly, merge, session

    public var label: String {
        switch self {
        case .localOnly: return "Local-only"
        case .merge: return "Merge commit"
        case .session: return "This session"
        }
    }
}

/// One button of the merge-recovery review sheet.
public struct MergeRecoveryButton: Equatable, Sendable, Identifiable {
    public enum Action: Equatable, Sendable {
        /// Fetch and preview the candidate again (runner `preview`).
        case preview
        /// Push the reviewed candidate (runner `apply`).
        case apply
        /// Bring this machine's checkout up to the target that landed (runner `sync-local`).
        case syncLocal
        /// Start a repair session — to resolve the recovery, or to prepare a PR candidate. The server
        /// hands it to the repair session already on it when there is one that can go on.
        case repair(preparePR: Bool)
        /// Open the repair session at work on the recovery.
        case openRepair
        /// Done on an ALREADY_LANDED check: the server records the session merged and clears the
        /// recovery (`confirm-landed`). Nothing is pushed.
        case confirmLanded
    }
    public let title: String
    public let action: Action
    /// A state rather than a step — "Checking…" — drawn with a spinner and never pressable.
    public let waiting: Bool
    public var id: String { title }
    public init(title: String, action: Action, waiting: Bool = false) {
        self.title = title
        self.action = action
        self.waiting = waiting
    }
}

/// What the review sheet offers in a state: the step the state asks for (prominent, pinned at the
/// sheet's foot), the other steps pinned under it, and checking again as the header's link
/// whenever checking isn't the step itself — with one sentence under them when what happens next
/// needs no step at all.
public struct MergeRecoveryButtons: Equatable, Sendable {
    public let primary: MergeRecoveryButton?
    public let secondary: [MergeRecoveryButton]
    public let headerCheck: MergeRecoveryButton?
    public let note: String?
    public init(primary: MergeRecoveryButton?, secondary: [MergeRecoveryButton], headerCheck: MergeRecoveryButton?,
                note: String? = nil) {
        self.primary = primary
        self.secondary = secondary
        self.headerCheck = headerCheck
        self.note = note
    }
}

public struct MergeRecovery: Codable, Equatable, Sendable {
    public struct Check: Codable, Equatable, Sendable {
        public let status: String
        public let output: String?
        public let command: String?
        public let timeoutSeconds: Int?
    }
    public let code: String
    public let targetBranch: String
    public let repoRoot: String?
    public let previewId: String?
    public let sourceSha: String?
    public let localSha: String?
    public let remoteSha: String?
    public let candidateSha: String?
    public let candidateTreeSha: String?
    public let rebaseBaseSha: String?
    public let repairBranch: String?
    public let repairWorktree: String?
    public let phase: String?
    public let conflicts: [String]?
    public let localCommits: [MergeRecoveryCommit]?
    public let remoteCommits: [MergeRecoveryCommit]?
    /// Exactly what the push adds to origin/<target>, newest first. Absent from older runners and
    /// past the runner's commit cap; the sheet then lists the local-only commits alone.
    public let pushCommits: [MergeRecoveryCommit]?
    /// ALREADY_LANDED: the commit on origin/<target> carrying each of this session's commits (its
    /// `sourceSha`), newest first, dated when it reached origin. Absent from older runners.
    public let landedCommits: [MergeRecoveryCommit]?
    public let patch: String?
    public let addsMergeCommit: Bool?
    public let checkedAt: String?
    public let check: Check?

    public var ready: Bool {
        let shas = [sourceSha, localSha, remoteSha, candidateSha, candidateTreeSha].compactMap { $0 }
        return code == "READY" && !(previewId ?? "").isEmpty && patch != nil && ["passed", "unconfigured"].contains(check?.status ?? "")
            && shas.count == 5 && shas.allSatisfy(Self.isFullSha)
    }

    /// Whether Done may close this recovery (web's `mergeRecoveryConfirmable`): a check that found
    /// every one of the session's commits already on origin, naming the source it checked and the
    /// previewId it was stored under.
    public var confirmable: Bool {
        code == "ALREADY_LANDED" && !(previewId ?? "").isEmpty && sourceSha.map(Self.isFullSha) == true
    }

    private static func isFullSha(_ sha: String) -> Bool {
        sha.count == 40 && sha.unicodeScalars.allSatisfy { CharacterSet(charactersIn: "0123456789abcdef").contains($0) }
    }

    public var title: String {
        if code == "LOCAL_SYNC_PENDING" { return "Merged into origin/\(targetBranch); local sync pending" }
        if ready { return "Review synchronization into \(targetBranch)" }
        if code == "CONFLICT" {
            return phase == "TARGET_SYNC" ? "\(targetBranch) synchronization has conflicts"
                : "Your changes conflict with the synchronized target"
        }
        if code == "REPAIR_IN_PROGRESS" { return "The repair isn’t finished" }
        if code == "ALREADY_LANDED" { return "Already on origin/\(targetBranch)" }
        if code == "PREVIEW_CHANGED" { return "Branches changed — check again" }
        if code == "FETCH_FAILED" { return "Could not check the remote" }
        if ["PUSH_FAILED", "REMOTE_NOT_VERIFIED"].contains(code) { return "Could not confirm the target push" }
        return "\(targetBranch) needs synchronization"
    }

    /// Local-only first: an unpublished local merge is still unpublished.
    public func origin(of commit: MergeRecoveryCommit) -> MergeRecoveryCommitOrigin {
        if localCommits?.contains(where: { $0.sha == commit.sha }) == true { return .localOnly }
        return commit.merge == true ? .merge : .session
    }

    /// The push's commits the sheet lists inline: every local-only and merge commit — what the review
    /// is for — and this session's first few; the rest wait behind one row. Git log's order.
    public func inlinePushCommits(sessionLimit: Int = 5) -> (shown: [MergeRecoveryCommit], hidden: Int) {
        var sessions = 0
        let all = pushCommits ?? []
        let shown = all.filter { commit in
            guard origin(of: commit) == .session else { return true }
            sessions += 1
            return sessions <= sessionLimit
        }
        return (shown, all.count - shown.count)
    }

    /// Local target against origin/target, once a check has listed both sides (web's
    /// `mergeRecoveryTargetRelation`). The runner leaves an empty list out, so two absent lists only
    /// mean "same" when the tips agree; otherwise they went unread.
    public var targetRelation: String? {
        guard let localSha, let remoteSha,
              localSha == remoteSha || localCommits != nil || remoteCommits != nil else { return nil }
        let t = targetBranch
        let ahead = localSha == remoteSha ? 0 : localCommits?.count ?? 0
        let behind = localSha == remoteSha ? 0 : remoteCommits?.count ?? 0
        switch (ahead, behind) {
        case (0, 0): return "Local \(t) matches origin/\(t)"
        case (_, 0): return "Local \(t) is \(ahead) ahead of origin/\(t)"
        case (0, _): return "Local \(t) is \(behind) behind origin/\(t)"
        default: return "Local \(t): \(ahead) ahead, \(behind) behind origin/\(t)"
        }
    }

    /// How the push lands, under the commits it adds.
    public var landingNote: String {
        let t = targetBranch
        let local = localCommits?.count ?? 0
        return (addsMergeCommit == true ? "A merge commit joins both histories; nothing already on origin/\(t) is rewritten."
                : "Fast-forward push: nothing already on origin/\(t) is rewritten.")
            + (local == 0 ? "" : " Includes \(local) local-only \(local == 1 ? "commit that was" : "commits that were") never pushed.")
    }

    /// The sheet's closing note: what the check proved and, for a ready candidate, the way to a PR.
    /// It speaks of local-only commits only when some go out and no push list has said so already.
    public var reviewNote: String? {
        var parts: [String] = []
        if let check {
            parts.append(check.status == "unconfigured" ? "Git preview only; no merge check is configured."
                         : check.status == "passed" ? "Configured merge check passed." : "Configured merge check failed.")
        }
        if ready {
            if (pushCommits ?? []).isEmpty, localCommits?.isEmpty == false {
                parts.append("The local-only commits above will be pushed with this session’s changes.")
            }
            parts.append("For linear history or required PRs, prepare a PR candidate instead.")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }

    /// The heading over `conflicts`: an unfinished repair lists the files it left unresolved.
    public var conflictsTitle: String { code == "REPAIR_IN_PROGRESS" ? "Still unresolved" : "Conflicts" }

    /// Under the conflicts of a check that carried a finished repair onto targets that moved since. A
    /// carried repair keeps the branch an earlier check named after its own previewId; a target
    /// synchronization conflict on it can only come from the new commits. On SOURCE_REPLAY it can be a
    /// fresh conflict with nothing moved, so it says nothing there.
    public var targetMovedNote: String? {
        guard code == "CONFLICT", phase == "TARGET_SYNC", repairBranch != "orbit/recovery/\(previewId ?? "")" else {
            return nil
        }
        return "origin/\(targetBranch) moved after the repair. The repair was kept; only "
            + ((conflicts?.count ?? 0) > 1 ? "these files conflict" : "this file conflicts") + " with the new commits."
    }

    // MARK: ALREADY_LANDED

    /// What ALREADY_LANDED says under its title: the day the last of this session's changes reached
    /// origin (web's panel says the same).
    public func landedSummary(now: Date = Date(), timeZone: TimeZone = .current) -> String {
        let newest = (landedCommits ?? []).compactMap { c in RelativeTime.parse(c.date).map { (c, $0) } }
            .max { $0.1 < $1.1 }?.0
        guard let day = newest.flatMap({ RunnerPageFormat.day($0.date, now: now, timeZone: timeZone) }) else {
            return "Nothing is left to merge."
        }
        return "This session’s changes reached origin/\(targetBranch) on \(day). Nothing is left to merge."
    }

    /// A landed commit's line leads with the day it reached origin: "Merged Oct 11".
    public static func mergedDay(_ commit: MergeRecoveryCommit, now: Date = Date(),
                                 timeZone: TimeZone = .current) -> String {
        "Merged \(RunnerPageFormat.day(commit.date, now: now, timeZone: timeZone) ?? commit.date)"
    }

    /// Under the landed commits when they are copies, not the session's own commits: matched by
    /// patch-id because the branch was rewritten after they merged.
    public var landedByContentNote: String? {
        let landed = landedCommits ?? []
        guard landed.contains(where: { $0.sourceSha != nil && $0.sourceSha != $0.sha }) else { return nil }
        return "Matched by content — this branch was rewritten after \(landed.count == 1 ? "it" : "these") merged."
    }

    /// Under the branches when the local target has commits of its own: Done leaves them where they are.
    public var landedLocalNote: String? {
        let n = localCommits?.count ?? 0
        guard n > 0 else { return nil }
        return n == 1 ? "Local \(targetBranch)’s own 1 commit isn’t part of this session."
            : "Local \(targetBranch)’s own \(n) commits aren’t part of this session."
    }

    /// The review sheet's buttons — the same steps, titles and gates the inline card had (and web's
    /// `MergeRecoveryPanel` has), arranged around the one the state asks for. An older runner can't
    /// recover, so it gets none. With a repair session on the recovery, it leads: while it works, the
    /// step is to look at it; while the server checks what it did, there is none; after, the step the
    /// check asks for goes back to that session when it can go on (a failed one is replaced).
    public func buttons(supported: Bool, repair: MergeRepairRow? = nil) -> MergeRecoveryButtons {
        guard supported else { return MergeRecoveryButtons(primary: nil, secondary: [], headerCheck: nil) }
        if code == "LOCAL_SYNC_PENDING" {
            return MergeRecoveryButtons(primary: MergeRecoveryButton(title: "Sync local checkout", action: .syncLocal),
                                        secondary: [], headerCheck: nil)
        }
        if repair?.state == .running {
            return MergeRecoveryButtons(primary: MergeRecoveryButton(title: "Open repair session", action: .openRepair),
                                        secondary: [], headerCheck: nil, note: "Orbit checks again when the repair stops.")
        }
        if repair?.checking == true {
            return MergeRecoveryButtons(primary: MergeRecoveryButton(title: "Checking…", action: .preview, waiting: true),
                                        secondary: [], headerCheck: nil)
        }
        if confirmable {
            return MergeRecoveryButtons(primary: MergeRecoveryButton(title: "Done", action: .confirmLanded),
                                        secondary: [], headerCheck: nil)
        }
        let check = MergeRecoveryButton(title: previewId == nil ? "Check and repair" : "Check again", action: .preview)
        let resolve = MergeRecoveryButton(title: "Resolve in repair session", action: .repair(preparePR: false))
        let preparePR = MergeRecoveryButton(title: "Prepare PR candidate", action: .repair(preparePR: true))
        let repairs = repairWorktree == nil ? [] : ready ? [preparePR] : [resolve, preparePR]
        if ready {
            return MergeRecoveryButtons(primary: MergeRecoveryButton(title: "Sync \(targetBranch) and merge", action: .apply),
                                        secondary: repairs, headerCheck: check)
        }
        if ["PUSH_FAILED", "REMOTE_NOT_VERIFIED"].contains(code) {
            return MergeRecoveryButtons(
                primary: MergeRecoveryButton(title: "Check result / retry reviewed candidate", action: .apply),
                secondary: repairs, headerCheck: check)
        }
        let continues = repair?.continues == true
        if code == "CONFLICT", repairWorktree != nil {
            return MergeRecoveryButtons(
                primary: continues ? MergeRecoveryButton(title: "Continue repair", action: .repair(preparePR: false)) : resolve,
                secondary: [preparePR], headerCheck: check)
        }
        if code == "REPAIR_IN_PROGRESS", repair != nil {
            return MergeRecoveryButtons(
                primary: continues ? MergeRecoveryButton(title: "Reply in repair session", action: .repair(preparePR: false)) : resolve,
                secondary: [], headerCheck: check)
        }
        return MergeRecoveryButtons(primary: check, secondary: repairs, headerCheck: nil)
    }
}

/// The repair session's row on the review sheet — the design board's six states (docs/mocks/
/// merge-recovery-repair-loop-ios.html): what the repair is doing, or what the check of its last round
/// found. The server checks the recovery again whenever a repair round ends (S1); this only reads it.
/// Web's `MergeRecoveryPanel` derives the same states.
public struct MergeRepairRow: Equatable, Sendable {
    public enum State: Equatable, Sendable {
        case running
        /// Its round is over and the server's check of it is under way or owed.
        case checking
        case ready(checkedAt: String)
        case conflicts(Int, checkedAt: String)
        /// It stopped with the repair unfinished (REPAIR_IN_PROGRESS): what it last said, and when.
        case needsReply(said: String?, at: String?)
        case failed(String?)
        /// Over, and no check has seen its last round: a server that does not check by itself, or a
        /// check it did not queue. Checking again is the owner's (the header's link).
        case unchecked
        /// Over and checked, with an answer the sheet's title gives (diverged targets, a failed fetch…).
        case finished(checkedAt: String?)
    }

    public let id: String
    public let title: String?
    public let state: State
    /// The server is checking the recovery (a preview in flight), or owes it a check once this
    /// session's own turn ends (`mergeRepairTurnEndedAt`). The sheet waits on it.
    public let checking: Bool

    /// Nil without a repair session or a recovery, and once the session is found already on origin:
    /// nothing is left to repair then.
    public init?(detail d: SessionDetail) {
        guard let repair = d.mergeRepairSession, let r = d.mergeRecovery, r.code != "ALREADY_LANDED" else { return nil }
        id = repair.id
        title = repair.title
        checking = (d.mergeStatus == "pending" && d.mergeRecoveryAction == "preview") || d.mergeRepairTurnEndedAt != nil
        let run = repair.effectiveRunState
        if run == .queued || run == .running { state = .running; return }
        if run == .failed { state = .failed(repair.error); return }
        if checking { state = .checking; return }
        guard Self.checkedSince(repair, r) else { state = .unchecked; return }
        if r.code == "REPAIR_IN_PROGRESS" {
            state = .needsReply(said: repair.lastAssistantText, at: Self.roundEnded(repair))
        } else if r.ready, let at = r.checkedAt {
            state = .ready(checkedAt: at)
        } else if r.code == "CONFLICT", let n = r.conflicts?.count, n > 0, let at = r.checkedAt {
            state = .conflicts(n, checkedAt: at)
        } else {
            state = .finished(checkedAt: r.checkedAt)
        }
    }

    /// Whether the session can take the recovery's next step itself: any but a failed one, which the
    /// server replaces with a new repair session (S2).
    public var continues: Bool {
        if case .failed = state { return false }
        return true
    }

    /// When the repair's last round ended: its last turn, or its finish.
    private static func roundEnded(_ repair: MergeRepairSession) -> String? { repair.lastTurnAt ?? repair.finishedAt }

    /// Whether the recovery was checked after the repair's last round ended. A server that predates
    /// `lastTurnAt` can't say, which reads as no. The runner stamps `checkedAt` in whole seconds, so the
    /// round's end is compared at that grain.
    private static func checkedSince(_ repair: MergeRepairSession, _ r: MergeRecovery) -> Bool {
        guard let ended = roundEnded(repair).flatMap(RelativeTime.parse),
              let checked = r.checkedAt.flatMap(RelativeTime.parse) else { return false }
        return checked.timeIntervalSince1970 >= ended.timeIntervalSince1970.rounded(.down)
    }

    /// Whether the session's detail should keep being read for the check of a repair round: while
    /// one is under way or owed, and for a minute after a round no check has seen yet ended — the
    /// server queues its check as the round ends, a moment a read can fall between (web's
    /// `mergeRepairLoopLive`).
    public static func awaitsCheck(_ d: SessionDetail, now: Date = Date()) -> Bool {
        guard let row = MergeRepairRow(detail: d) else { return false }
        if row.checking { return true }
        guard row.state == .unchecked, let repair = d.mergeRepairSession,
              let ended = roundEnded(repair).flatMap(RelativeTime.parse) else { return false }
        return now.timeIntervalSince(ended) < 60
    }

    public var headline: String {
        switch state {
        case .running: return "Repair session running"
        case .needsReply: return "Repair session needs your reply"
        case .failed: return "Repair session failed"
        default: return "Repair session finished"
        }
    }

    /// The row's last line: what it is doing, what the check found, what it asked or why it failed.
    public func status(now: Date = Date()) -> String? {
        func ago(_ iso: String) -> String { RelativeTime.format(iso, now: now) ?? iso }
        switch state {
        case .running: return "Tap to open the running session"
        case .checking: return "Checking its result…"
        case .ready(let at): return "Checked \(ago(at)) — ready to merge"
        case .conflicts(let n, let at): return "Checked \(ago(at)) — \(n) \(n == 1 ? "conflict" : "conflicts") left"
        case .needsReply(let said, let at):
            let words = (said ?? "").split(whereSeparator: \.isWhitespace).joined(separator: " ")
            guard !words.isEmpty else { return nil }
            return "“\(words)”" + (at.map { " · \(ago($0))" } ?? "")
        case .failed(let error):
            let why = error?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return why.isEmpty ? nil : why
        case .unchecked: return nil
        case .finished(let at): return at.map { "Checked \(ago($0))" }
        }
    }
}
