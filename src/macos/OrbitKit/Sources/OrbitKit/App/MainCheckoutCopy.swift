import Foundation

/// Main checkout Git on macOS and iOS: every word the card, the bar, the review sheet, the result lines
/// and the worktree isolation dialogs show, and every rule deciding what they show. A port of
/// src/shared/src/mainCheckoutGit.ts (docs/main-checkout-git-contract.md, boards
/// docs/mocks/main-checkout-git/01–04); MainCheckoutTests holds it to the shared fixture's exact lines.
/// The views only lay these out.
public enum MainCheckoutCopy {
    public static let fileLimit = 200
    public static let cardVisibleFiles = 8

    public static let label = "Main checkout"
    public static let moveToThisWorktree = "Move to this worktree"
    public static let moveToAWorktree = "Move to a worktree"
    public static let saveAndClean = "Save to a rescue branch and clean"
    public static let saveAndCleanHint =
        "Keeps everything on orbit/rescue-…, then returns the main checkout to its last commit. Ignored files are left alone."
    public static let askAgent = "Ask the agent about it"
    public static let askAgentHint = "Puts a prompt in the composer; nothing changes until you send it."
    public static let leaveAsIs = "Leave as is"
    public static let review = "Review"
    public static let reviewAndCommitShort = "Review and commit…"
    public static let reviewMainCheckout = "Review main checkout"
    public static let commitMessagePlaceholder = "Commit message"
    public static let notShown = "Not shown: files your .gitignore ignores. Untracked files are included."
    public static let targetOpenedFrom = "The session you opened this from"
    public static let targetBusy = "Working now — available when this turn ends"
    public static let cleanUpCheckout = "Clean up checkout"
    /// The sheet's own words, which the board leaves to the client.
    public static let loading = "Reading the main checkout…"
    public static let readFailed = "Couldn't read the main checkout"
    public static let binaryFile = "Binary file — no diff to show."
    public static let patchCut = "The diff is cut off here."
    public static let noFiles = "No uncommitted files."
    public static let sending = "Sent — waiting for the runner…"
    public static let actionFailed = "Couldn't send that to the runner"
    public static let noTargets = "No other worktree session in this workspace"

    // MARK: counting words

    public static func filesCount(_ n: Int) -> String { "\(n) \(n == 1 ? "file" : "files")" }

    static func uncommittedFiles(_ n: Int, other: Bool = false) -> String {
        "\(n) \(other ? "other " : "")uncommitted \(n == 1 ? "file" : "files")"
    }

    static func commitsCount(_ n: Int) -> String { "\(n) \(n == 1 ? "commit" : "commits")" }

    public static func shortSha(_ sha: String?) -> String { String((sha ?? "").prefix(7)) }

    /// "a", "a and b", "a, b and c", "a, b, c and 4 more".
    public static func namePaths(_ paths: [String]) -> String {
        if paths.count <= 1 { return paths.first ?? "" }
        if paths.count <= 3 { return paths.dropLast().joined(separator: ", ") + " and " + paths[paths.count - 1] }
        return paths.prefix(3).joined(separator: ", ") + " and \(paths.count - 3) more"
    }

    // MARK: board 01 — the card

    public static func cardTitle(fileCount: Int, truncated: Bool) -> String {
        truncated
            ? "At least \(filesCount(fileCount)) changed in the main checkout during this turn"
            : "\(filesCount(fileCount)) changed in the main checkout during this turn"
    }

    public static func cardSubtitle(root: String, branch: String?) -> String {
        let at = branch.map { "\(root) on \($0)" } ?? root
        return "\(at), outside this session's worktree. Orbit saw them appear; it can't tell who wrote them."
    }

    public static func moreFiles(_ hidden: Int) -> String { "and \(hidden) more" }

    public static func truncatedNote(limit: Int = fileLimit) -> String { "Orbit stopped counting at \(limit) files." }

    public static func reviewAndCommit(branch: String) -> String { "Review and commit to \(branch)…" }

    public static func moveHint(sessionBranch: String) -> String {
        "Copies them onto \(sessionBranch), then clears them from the main checkout. A recovery branch is saved first."
    }

    // MARK: board 02 — the review sheet

    public static func chooseFiles(chosen: Int, total: Int) -> String { "Choose files to commit · \(chosen) of \(total)" }

    public static func commitButton(chosen: Int, branch: String) -> String { "Commit \(filesCount(chosen)) to \(branch)" }

    public static func uncommitted(_ n: Int) -> String { "\(n) uncommitted" }

    /// "3 uncommitted files", "Clean · 1 commit not pushed", or both.
    public static func barStatus(fileCount: Int, ahead: Int) -> String {
        var parts = [fileCount > 0 ? uncommittedFiles(fileCount) : "Clean"]
        if ahead > 0 { parts.append("\(commitsCount(ahead)) not pushed") }
        return parts.joined(separator: " · ")
    }

    public static func pushLabel(upstream: String) -> String { "Push to \(upstream)" }

    /// Before Commit and Push when the branch is one a project lands on. It informs; it never blocks.
    public static func managedBranchWarning(projectTitle: String) -> String {
        "This skips project \(projectTitle)'s landing check."
    }

    // MARK: board 03 — result lines

    public enum Tone: String, Equatable, Sendable { case ok, refused, waiting }

    /// What a line's link does (`MAIN_CHECKOUT_LINK_ACTIONS`).
    public enum LinkAction: String, Equatable, Sendable, CaseIterable {
        case viewChanges = "view-changes"
        case push
        case openInNewSession = "open-in-new-session"
        case reviewAgain = "review-again"
        case askAgentCombine = "ask-agent-combine"
        case askAgentRebasePush = "ask-agent-rebase-push"
        case cleanUpCheckout = "clean-up-checkout"
        case cancel
    }

    public struct Link: Equatable, Sendable {
        public let action: LinkAction
        public let label: String
    }

    public struct ResultLine: Equatable, Sendable {
        public let tone: Tone
        /// The bold opening of `text`.
        public let lead: String
        /// The whole sentence, lead included.
        public let text: String
        public let link: Link?

        /// `text` past the lead.
        public var rest: String { String(text.dropFirst(lead.count)) }
    }

    /// Who reads the line: the session it is written into.
    public struct LineView: Equatable, Sendable {
        public var sessionId: String?
        /// A move into another session: its title.
        public var targetTitle: String?
        /// false in a Shared session, which has no branch of its own to mention.
        public var isolated: Bool

        public init(sessionId: String? = nil, targetTitle: String? = nil, isolated: Bool = true) {
            self.sessionId = sessionId
            self.targetTitle = targetTitle
            self.isolated = isolated
        }
    }

    private static func nothing(_ kind: MainCheckoutActionKind) -> String {
        switch kind {
        case .move: return "Nothing moved"
        case .commit: return "Nothing committed"
        case .push: return "Nothing pushed"
        case .rescue: return "Nothing saved"
        }
    }

    private static func gitVerb(_ kind: MainCheckoutActionKind) -> String {
        kind == .rescue ? "save" : kind.rawValue
    }

    private static func cant(_ kind: MainCheckoutActionKind) -> String { "Can't \(gitVerb(kind)) right now" }

    private static func blockedState(_ state: String?) -> String {
        switch state {
        case "unmerged": return "has unresolved conflicts"
        case "merge", "rebase", "revert", "cherry-pick": return "is in the middle of a \(state!)"
        default: return "is in the middle of an unfinished operation"
        }
    }

    private static func quoted(_ gitMessage: String?) -> String {
        guard let gitMessage, !gitMessage.isEmpty else { return "" }
        return " (“\(gitMessage)”)"
    }

    private static func remoteOf(_ upstream: String?) -> String {
        let first = upstream?.split(separator: "/", omittingEmptySubsequences: false).first.map(String.init) ?? ""
        return first.isEmpty ? "origin" : first
    }

    private static func line(_ tone: Tone, _ lead: String, _ rest: String, _ link: Link? = nil) -> ResultLine {
        ResultLine(tone: tone, lead: lead, text: lead + rest, link: link)
    }

    /// The one line an action's outcome writes into the session (board 03).
    public static func resultLine(_ r: MainCheckoutActionResult, view: LineView = LineView()) -> ResultLine {
        let branch = r.branch ?? "HEAD"
        let upstream = r.upstream ?? "origin/\(branch)"
        let none = nothing(r.kind)
        let n = filesCount(r.fileCount ?? 0)
        let paths = r.paths ?? []

        if r.status == "done" {
            switch r.kind {
            case .move:
                let into: String
                if let title = view.targetTitle, let target = r.targetSessionId, target != view.sessionId {
                    into = "into the worktree of “\(title)”"
                } else {
                    into = "into this worktree"
                }
                let after = (r.remaining ?? 0) > 0
                    ? " The main checkout still has \(uncommittedFiles(r.remaining ?? 0, other: true))."
                    : " The main checkout is clean again."
                return line(.ok, "Moved \(n) \(into).", "\(after) A copy of what it held is on \(r.rescueBranch ?? "").",
                            Link(action: .viewChanges, label: "View changes"))
            case .commit:
                let tail = view.isolated ? " This session's branch is unchanged." : ""
                return line(.ok, "Committed \(n) to \(branch)",
                            " in the main checkout as \(shortSha(r.head)) “\(r.subject ?? "")”. Not pushed yet.\(tail)",
                            Link(action: .push, label: pushLabel(upstream: upstream)))
            case .push:
                let remote = remoteOf(upstream)
                if let before = r.remoteBefore, !before.isEmpty {
                    return line(.ok, "Pushed \(branch) to \(remote)", " (\(shortSha(before))..\(shortSha(r.remoteAfter))).")
                }
                return line(.ok, "Pushed \(branch) to \(remote)", " as a new branch (\(shortSha(r.remoteAfter))).")
            case .rescue:
                return line(.ok, "Saved \(n) to \(r.rescueBranch ?? "")",
                            " and returned the main checkout to \(shortSha(r.head)). Ignored files were left alone.",
                            Link(action: .openInNewSession, label: "Open in a new session"))
            }
        }

        let reviewAgain = Link(action: .reviewAgain, label: "Review again")
        switch r.code {
        case "FINGERPRINT_STALE":
            return line(.refused, "\(none):",
                        " the main checkout changed since you looked\(paths.isEmpty ? "" : " (\(namePaths(paths)))").",
                        reviewAgain)
        case "HEAD_MOVED":
            return line(.refused, "\(none):", " \(branch) moved to \(shortSha(r.head)) since you looked.", reviewAgain)
        case "MOVE_CONFLICT":
            let one = paths.count == 1
            return line(.refused, "\(none):",
                        " \(namePaths(paths)) \(one ? "is" : "are") also changed in this worktree, in the same lines. "
                            + "Commit \(one ? "it" : "them") to \(branch) or save \(one ? "it" : "them") to a rescue branch instead, "
                            + "or ask the agent to combine them.",
                        Link(action: .askAgentCombine, label: "ask the agent to combine them"))
        case "MOVE_SOURCE_CHANGED":
            return line(.refused, "Copied \(n) into this worktree but left them in the main checkout:",
                        " \(namePaths(paths)) changed while they were moving. A copy of what it held is on \(r.rescueBranch ?? "").",
                        Link(action: .reviewAgain, label: reviewMainCheckout))
        case "TARGET_BUSY":
            return line(.refused, "\(none):", " that session is working on a turn. Move the files when it ends.")
        case "CHECKOUT_BLOCKED":
            return line(.refused, "\(cant(r.kind)):", " the main checkout \(blockedState(r.state)).",
                        Link(action: .cleanUpCheckout, label: cleanUpCheckout))
        case "DETACHED":
            return line(.refused, "\(cant(r.kind)):", " the main checkout isn't on a branch (detached HEAD).")
        case "NO_HEAD":
            return line(.refused, "\(cant(r.kind)):", " the main checkout has no commits yet.")
        case "NOTHING_TO_PUSH":
            return line(.refused, "Nothing to push:", " \(branch) is already on \(upstream).")
        case "NO_REMOTE":
            return line(.refused, "\(none):", " \(branch) has no upstream and the main checkout has no remote named origin.")
        case "PUSH_REJECTED":
            let has = (r.behind ?? 0) > 0 ? "has \(commitsCount(r.behind ?? 0))" : "has commits"
            return line(.refused, "Push rejected:",
                        " \(upstream) \(has) the main checkout doesn't. Nothing was changed, and Orbit never force-pushes.",
                        Link(action: .askAgentRebasePush, label: "Ask the agent to rebase and push"))
        case "PUSH_AUTH_FAILED":
            return line(.refused, "Push failed:",
                        " the runner's git couldn't authenticate to \(remoteOf(upstream))\(quoted(r.gitMessage)). Your commit is still in the main checkout.")
        case "PUSH_FAILED":
            return line(.refused, "Push failed:",
                        " git couldn't push to \(remoteOf(upstream))\(quoted(r.gitMessage)). Your commit is still in the main checkout.")
        case "RESCUE_FAILED":
            return line(.refused, "\(none):",
                        " Orbit couldn't save the main checkout to a rescue branch first\(quoted(r.gitMessage)). The main checkout was left as it was.")
        case "ACTION_FAILED":
            return line(.refused, "\(none):",
                        " git couldn't \(gitVerb(r.kind))\(quoted(r.gitMessage)). The main checkout was left as it was.")
        case "ACTION_IN_FLIGHT":
            return line(.refused, "\(none):", " another action on this main checkout is still running. Try again when it finishes.")
        case "RUNNER_OFFLINE":
            return line(.waiting, "Waiting for the runner",
                        " — \(r.runnerName ?? "the runner") hasn't checked in for \(r.minutes ?? 0) min. "
                            + "Nothing has been changed; this runs when it's back, or you can cancel.",
                        Link(action: .cancel, label: "Cancel"))
        case "TIMEOUT":
            return line(.refused, "Timed out:",
                        " \(r.runnerName ?? "the runner") didn't answer within \(r.minutes ?? 0) min, so Orbit stopped waiting. "
                            + "If it ran the action anyway, its result will appear here.")
        case "CANCELLED":
            return line(.refused, "Cancelled:", " nothing was changed.")
        default:
            return line(.refused, "\(none).", "")
        }
    }

    // MARK: "Ask the agent …" prompts (the contract leaves their words to the client)

    public static func askAboutChangesPrompt(root: String, paths: [String]) -> String {
        "These files changed in the main checkout \(root) during your last turn, outside this session's worktree: "
            + "\(namePaths(paths)). Look at them and tell me whether they belong to this session's work. "
            + "Don't change anything in the main checkout yet."
    }

    public static func combinePrompt(root: String, paths: [String]) -> String {
        "\(namePaths(paths)) changed both in the main checkout \(root) and in this worktree, in the same lines. "
            + "Bring the main checkout's changes to them into this worktree, combined with yours, "
            + "and tell me what you kept from each side. Leave the main checkout as it is."
    }

    public static func rebasePushPrompt(root: String, branch: String, upstream: String) -> String {
        "Pushing \(branch) from the main checkout \(root) was rejected: \(upstream) has commits it doesn't. "
            + "In \(root), rebase \(branch) onto \(upstream), resolve any conflicts, and push it without force. "
            + "Ask me before you change anything you're unsure of."
    }

    public static func rescuePrompt(rescueBranch: String) -> String {
        "The main checkout's uncommitted changes were saved to \(rescueBranch). "
            + "Look at what that branch holds compared with its parent and tell me what it contains."
    }
}

// MARK: - rules

/// What the Main checkout bar shows above the composer (boards 01⑤ and 02④), read from the
/// workspace's heartbeat counts. Nil: no bar.
public struct MainCheckoutBar: Equatable, Sendable {
    public let branch: String?
    public let status: String
    /// The status a phone-width row falls back to before it truncates: "3 uncommitted", "1 not pushed".
    public let shortStatus: String
    public let fileCount: Int
    public let ahead: Int
    /// The Review button's label; nil when there's nothing to review or no actions.
    public let reviewLabel: String?
    /// "Push to origin/main"; nil when nothing is ahead or no actions.
    public let pushLabel: String?
    /// The dot's tone: amber while the checkout holds uncommitted files.
    public let dirty: Bool

    /// The rules:
    /// - a session with no git (`shared-nogit`) has its own notice instead, and no main checkout;
    /// - an older runner reports no counts: unknown, so no bar (never a guessed "clean");
    /// - a clean checkout with nothing to push draws nothing — dirty isn't broken, it's only shown;
    /// - Shared and Worktree sessions alike: both work in or fork from this one checkout;
    /// - without the runner's capability the bar still says what it sees, with no buttons.
    public static func make(health: RunnerRepoHealth?, isolationStatus: String?, isolated: Bool,
                            actionsSupported: Bool) -> MainCheckoutBar? {
        guard isolationStatus != "shared-nogit", let health else { return nil }
        guard health.fileCount != nil || health.ahead != nil else { return nil }
        let files = health.fileCount ?? 0
        let ahead = health.ahead ?? 0
        guard files > 0 || ahead > 0 else { return nil }
        let branch = health.branch
        let upstream = health.upstream ?? branch.map { "origin/\($0)" }
        return MainCheckoutBar(
            branch: branch,
            status: MainCheckoutCopy.barStatus(fileCount: files, ahead: ahead),
            shortStatus: files > 0 ? MainCheckoutCopy.uncommitted(files) : "\(ahead) not pushed",
            fileCount: files,
            ahead: ahead,
            reviewLabel: actionsSupported && files > 0
                ? (isolated ? MainCheckoutCopy.review : MainCheckoutCopy.reviewAndCommitShort) : nil,
            pushLabel: actionsSupported && ahead > 0 && files == 0
                ? upstream.map(MainCheckoutCopy.pushLabel(upstream:)) : nil,
            dirty: files > 0)
    }
}

/// The `main-checkout-changed` card's layout (board 01 B).
public struct MainCheckoutCard: Equatable, Sendable {
    public let title: String
    public let subtitle: String
    public let visibleFiles: [MainCheckoutFile]
    /// "and N more", or nil.
    public let moreFiles: String?
    /// "Orbit stopped counting at 200 files.", or nil.
    public let truncatedNote: String?

    public init(_ notice: MainCheckoutChangedNotice) {
        title = MainCheckoutCopy.cardTitle(fileCount: notice.fileCount, truncated: notice.truncated)
        subtitle = MainCheckoutCopy.cardSubtitle(root: notice.root, branch: notice.branch)
        visibleFiles = Array(notice.files.prefix(MainCheckoutCopy.cardVisibleFiles))
        let hidden = notice.fileCount - visibleFiles.count
        moreFiles = hidden > 0 ? MainCheckoutCopy.moreFiles(hidden) : nil
        truncatedNote = notice.truncated ? MainCheckoutCopy.truncatedNote() : nil
    }

    /// Whether the card's buttons are drawn: the runner can act, the person hasn't chosen Leave as is,
    /// and the checkout still holds uncommitted files as far as the heartbeat knows (an older count
    /// of nil is unknown, so the buttons stay; a 0 means someone already dealt with them).
    public static func showsActions(actionsSupported: Bool, dismissed: Bool, health: RunnerRepoHealth?) -> Bool {
        guard actionsSupported, !dismissed else { return false }
        if let count = health?.fileCount, count == 0 { return false }
        return true
    }
}

/// The review sheet's file selection (board 02): every file chosen when it opens.
public struct MainCheckoutSelection: Equatable, Sendable {
    public private(set) var chosen: Set<String>
    public let all: [String]

    public init(files: [MainCheckoutFile]) {
        all = files.map(\.path)
        chosen = Set(all)
    }

    public mutating func toggle(_ path: String) {
        if chosen.contains(path) { chosen.remove(path) } else { chosen.insert(path) }
    }

    /// The chosen paths in the snapshot's order (what the request sends).
    public var paths: [String] { all.filter(chosen.contains) }

    /// Commit needs a file and a non-blank message; Move needs a file.
    public func canCommit(message: String) -> Bool {
        !chosen.isEmpty && !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public var canMove: Bool { !chosen.isEmpty }
}

/// Board 04: what turning worktree isolation on or off asks first, if anything. The switch itself
/// never touches the checkout and is never blocked; the dialog only says what follows.
public enum WorktreeIsolationDialog: Equatable, Sendable {
    /// On, with uncommitted files: New sessions won't see them. Review files / Cancel / Turn on.
    case turnOnDirty(body: String)
    /// On, with the checkout stuck mid-operation: Clean up checkout / Cancel / Turn on.
    case turnOnStuck(body: String)
    /// On or off, with nothing reported: Orbit can't see the checkout.
    case unseen(turningOn: Bool)
    /// Off, with sessions still on worktrees: they keep them.
    case turnOff(body: String)

    public static let turnOnTitle = "Turn on worktree isolation?"
    public static let turnOffTitle = "Turn off worktree isolation?"
    public static let unchanged =
        "Nothing in the checkout is changed. Sessions already running keep working in the main checkout until they end."
    public static let unseenBody = "Orbit can't see this checkout right now."
    public static let reviewFiles = "Review files"
    public static let cancel = "Cancel"
    public static let turnOn = "Turn on"
    public static let turnOff = "Turn off"
    public static let cleanUpCheckout = "Clean up checkout"
    /// The switch's own row, in web's words.
    public static let switchLabel = "Worktree isolation"
    public static let switchDetail =
        "Each session runs in its own git worktree. Off → sessions run directly in the working directory, sharing it."

    public var title: String {
        switch self {
        case .turnOnDirty, .turnOnStuck: return Self.turnOnTitle
        case .unseen(let on): return on ? Self.turnOnTitle : Self.turnOffTitle
        case .turnOff: return Self.turnOffTitle
        }
    }

    /// The paragraphs under the title.
    public var message: String {
        switch self {
        case .turnOnDirty(let body), .turnOnStuck(let body): return body + "\n\n" + Self.unchanged
        case .unseen: return Self.unseenBody
        case .turnOff(let body): return body
        }
    }

    public var confirm: String {
        switch self {
        case .turnOnDirty, .turnOnStuck: return Self.turnOn
        case .unseen(let on): return on ? Self.turnOn : Self.turnOff
        case .turnOff: return Self.turnOff
        }
    }

    public static func dirtyBody(root: String, fileCount: Int, branch: String, head: String) -> String {
        "The main checkout \(root) has \(MainCheckoutCopy.uncommittedFiles(fileCount)). "
            + "New sessions start from the last commit on \(branch) (\(MainCheckoutCopy.shortSha(head))), so they won't see those files."
    }

    public static func stuckBody(root: String, state: String) -> String {
        let what = state == "unmerged" ? "has unresolved conflicts" : "is stuck in a \(state)"
        return "The main checkout \(root) \(what) — new sessions can be created, but merges stay blocked until it's cleaned up."
    }

    public static func offBody(root: String, unmergedSessions: Int) -> String {
        let keep = unmergedSessions == 1
            ? "The 1 session with an unmerged worktree keeps it — merge or discard it from the session as before."
            : "The \(unmergedSessions) sessions with unmerged worktrees keep them — merge or discard them from each session as before."
        return "New sessions will work directly in \(root). \(keep)"
    }

    /// Board 04's rules. Nil: switch at once, as today (a clean checkout, or turning off with no
    /// session on a worktree).
    /// - `health`: the workspace's heartbeat report; nil when its runner is offline or reported none.
    /// - `unmergedSessions`: sessions of this workspace still on a worktree.
    public static func make(turningOn: Bool, health: RunnerRepoHealth?, workDir: String?,
                            unmergedSessions: Int) -> WorktreeIsolationDialog? {
        guard let health, let state = health.state else {
            // Turning off with no worktree session left says nothing either way.
            if !turningOn && unmergedSessions == 0 { return nil }
            return .unseen(turningOn: turningOn)
        }
        let root = health.root.flatMap { $0.isEmpty ? nil : $0 } ?? workDir ?? ""
        if turningOn {
            if ["unmerged", "merge", "rebase", "cherry-pick", "revert"].contains(state) {
                return .turnOnStuck(body: stuckBody(root: root, state: state))
            }
            let files = health.fileCount ?? (state == "dirty" ? health.paths?.count ?? 0 : 0)
            guard files > 0 else { return nil }
            return .turnOnDirty(body: dirtyBody(root: root, fileCount: files, branch: health.branch ?? "HEAD",
                                                head: health.head ?? ""))
        }
        return unmergedSessions > 0 ? .turnOff(body: offBody(root: root, unmergedSessions: unmergedSessions)) : nil
    }
}
