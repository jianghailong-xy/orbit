import Foundation

/// A failed landing fixed by the task's own session (contract revision 42, §12.5 W4–W8, §12.7), as the
/// owner ruled it on docs/mocks/landing-fix-own-session (2026-11-22, iPhone frames 02 a–d, "Approve as
/// drawn"): the card the failure arrives as in the task's own session (b), the landing window's Fixing
/// state and its two new rows (c), the hand-back to the coordinator with the session's last words (d),
/// the project page's "Being fixed by its session" group and the task row's `Landing · fixing`.
///
/// Every fact is the server's: the landing-fix turn's own words (`landing-fix:v1:<jobId>`, written from
/// immutable rows, W6), the landing view's todos (`workSessionId`) and timeline (`HANDED_TO_SESSION`,
/// `FIXED_BY_SESSION`, `RETURNED_TO_COORDINATOR`), open items' `workSession` and the task row's `FIXING`.
/// The words around them are this file's, in English.
public enum LandingFixCopy {
    // ② b — the card in the task's own session.
    public static let provenance = "FROM ORBIT · LANDING"
    public static let conflict = "Conflict"
    public static let checkFailed = "Check failed"
    public static let theProjectBranch = "the project branch"
    public static func heading(_ target: String) -> String { "Orbit could not land your work on \(target)" }
    public static let nothingWasPushed = "Nothing was pushed."
    public static func step1(_ into: String) -> String {
        "Merge \(into) into your branch and resolve what conflicts."
    }
    public static let step2 = "Run what failed until it passes."
    public static let step3 = "Commit, then end your turn."
    public static func footer(_ target: String) -> String {
        "Orbit lands the new commit and runs the checks again. Do not push \(target). "
            + "Not yours to fix? End your turn without committing and say why."
    }
    /// ② b ③: the one line the session gains once its fix is queued to land.
    public static func landingAgain(_ sha: String?) -> String {
        sha.map { "Landing \($0) again" } ?? "Landing again"
    }

    // ② c — the landing window's Fixing state.
    public static let fixing = "Fixing"
    public static let itsOwnSessionIsOnIt = "its own session is on it"
    public static let theTasksSession = "The task's session"
    public static let isFixingIt = "is fixing it"
    public static let openSession = "Open Session"
    public static func round(_ round: Int, of max: Int = OpenItemWorkSession.maxRounds) -> String {
        "round \(round) of \(max)"
    }
    /// The read-only footer's who-decides, since revision 42 (② c ③).
    public static let decisionsTheTasksSessionFirst = "Decisions: the task's own session first, then the coordinator"
    /// The footer's whole sentence while a landing is with its task's own session (② c ③), shown as
    /// text over two lines; today's one-line footer otherwise.
    public static var footerSessionFirst: String {
        "\(SessionLandingsCopy.orbitRunsTheseLandings) \(decisionsTheTasksSessionFirst)"
    }
    /// The hand-off row's second line (② c ②).
    public static let itWroteThisWork = "It wrote this work"

    // ② d — handed back to the coordinator.
    public static let coordinator = "Coordinator"
    public static let hasIt = "has it"
    /// What the task's session did, as the hand-back block's lead says it, per §12.4 reason.
    public static let handBackLeads: [String: String] = [
        "NO_NEW_COMMIT": "The task's session ended its turn without a new commit",
        "TURN_FAILED": "The task's session could not finish its fix turn",
        "SESSION_ENDED": "The task's session was ended before it could fix this",
        "ROUNDS_EXHAUSTED": "The task's session used its rounds of fixes, and this one failed again",
        "TASK_MOVED_ON": "The task moved on",
    ]

    // The project page (web board 06 d, e).
    public static let beingFixedByItsSession = "Being fixed by its session"
    public static let isOnIt = "is on it"
    public static let nothingWasPushedClause = "nothing was pushed"
    public static let openSessionLink = "Open session"
    /// The task row's integration segment while its session has the failure.
    public static let landingFixing = "Landing · fixing"
}

/// The landing-fix turn read back into the card it is (② b): the failure, the branch it was going to,
/// and the landing it belongs to. Parsed from the turn's own words, which the server writes from rows
/// that never change (`landing-fix-turn.ts#landingFixMessage`), so a reload draws the same card.
public struct LandingFixCard: Equatable, Sendable {
    public enum Failure: String, Equatable, Sendable { case conflict, checkFailed }

    public let failure: Failure
    public let taskTitle: String
    /// The branch the landing writes, as the turn names it (`project/<id>`, or `main`).
    public let target: String
    /// The line's upstream, when the first step names one beside the target.
    public let upstream: String?
    /// How the conflict happened: `rebasing onto`, `merging into`, `syncing main into`.
    public let verb: String?
    /// The commit the target was at (a conflict) or the tree that was tested (a failed check).
    public let sha: String?
    /// The files a conflict was in.
    public let files: [String]
    /// A failed check's name as the turn says it (`landing check`) and how it ended (`exit 1`).
    public let checkName: String?
    public let exit: String?
    /// The failure lines the runner found in the check's output.
    public let failureLines: [String]
    /// The landing session the turn names, as the turn spells it (its public id).
    public let landingSessionId: String?

    public init(failure: Failure, taskTitle: String, target: String, upstream: String? = nil,
                verb: String? = nil, sha: String? = nil, files: [String] = [], checkName: String? = nil,
                exit: String? = nil, failureLines: [String] = [], landingSessionId: String? = nil) {
        self.failure = failure
        self.taskTitle = taskTitle
        self.target = target
        self.upstream = upstream
        self.verb = verb
        self.sha = sha
        self.files = files
        self.checkName = checkName
        self.exit = exit
        self.failureLines = failureLines
        self.landingSessionId = landingSessionId
    }

    /// The target as the card speaks of it: `the project branch`, or `main` by its name.
    public var targetWords: String {
        target.hasPrefix("project/") ? LandingFixCopy.theProjectBranch : target
    }

    public var badge: String { failure == .conflict ? LandingFixCopy.conflict : LandingFixCopy.checkFailed }

    public var heading: String { LandingFixCopy.heading(LandingFix.shortBranch(target)) }

    /// The sentence before the commit: `Conflict while rebasing onto the project branch at`, or
    /// `The check "landing check" failed on the combined tree at` — the commit follows as code when
    /// there is one, then `Nothing was pushed.`
    public var lead: String {
        switch failure {
        case .conflict:
            let how = [verb, targetWords].compactMap { $0 }.joined(separator: " ")
            return "Conflict while \(how)" + (sha == nil ? "." : " at")
        case .checkFailed:
            let name = checkName.map { "The check \"\($0)\"" } ?? "A check"
            let tail = exit.map { ", \($0)" } ?? ""
            return sha == nil ? "\(name) failed on the combined tree\(tail)."
                : "\(name) failed on the combined tree\(tail), at"
        }
    }

    /// The monospaced box: the conflicted files, each path shortened in its middle, or the failure lines.
    public var boxLines: [String] {
        failure == .conflict ? files.map(LandingFix.shortPath) : failureLines
    }

    public var steps: [String] {
        let into = upstream.map { "\(targetWords) and \($0)" } ?? targetWords
        return [LandingFixCopy.step1(into), LandingFixCopy.step2, LandingFixCopy.step3]
    }

    public var footer: String { LandingFixCopy.footer(targetWords) }
}

/// One of the rows revision 42 adds to a landing's record (② c ②, d ②), drawn apart from the steps.
public struct LandingFixRow: Equatable, Sendable, Identifiable {
    public enum Kind: String, Equatable, Sendable { case handed, fixed, returned }

    public let kind: Kind
    public let at: String
    /// The bold head: `Handed to the task's session`, `Fixed in`, `Returned to the coordinator`.
    public let head: String
    /// What follows the head on its line: the commit (code) and `· landing again`, or `· no new commit`.
    public let sha: String?
    public let rest: String?
    /// The second line: `It wrote this work · round 1 of 2`.
    public let detail: String?
    /// The session the row is about, which pressing it opens.
    public let sessionId: String?

    public var id: String { "\(kind.rawValue)|\(at)|\(head)" }

    public init(kind: Kind, at: String, head: String, sha: String? = nil, rest: String? = nil,
                detail: String? = nil, sessionId: String? = nil) {
        self.kind = kind
        self.at = at
        self.head = head
        self.sha = sha
        self.rest = rest
        self.detail = detail
        self.sessionId = sessionId
    }
}

/// The hand-back as the landing window's card says it (② d ①): what the session did, and its last words.
public struct LandingFixHandBack: Equatable, Sendable {
    public let reason: String?
    public let lead: String
    public let lastMessage: String?
    public let returnedAt: String
    public let sessionId: String?

    public init(reason: String?, lead: String, lastMessage: String?, returnedAt: String, sessionId: String?) {
        self.reason = reason
        self.lead = lead
        self.lastMessage = lastMessage
        self.returnedAt = returnedAt
        self.sessionId = sessionId
    }

    /// The lead as the block's first line: a colon when the quote follows, a full stop when it does not.
    public var leadLine: String { lead + (lastMessage == nil ? "." : ":") }
}

public enum LandingFix {
    /// The landing-fix turn's key namespace (`landing-fix-turn-key.ts`).
    public static let turnPrefix = "landing-fix:v1:"
    static let opening = "Orbit could not land your work for \""

    /// The three timeline kinds revision 42 adds.
    public static let rowKinds: Set<String> = ["HANDED_TO_SESSION", "FIXED_BY_SESSION", "RETURNED_TO_COORDINATOR"]

    // MARK: - ② b, the card

    /// Whether a turn is the landing-fix turn: by its key, or by the words' head when an echo comes
    /// without one (as the coordinator's handoff turn is read).
    public static func isTurn(clientTurnId: String?, text: String) -> Bool {
        clientTurnId?.hasPrefix(turnPrefix) == true || text.hasPrefix(opening)
    }

    /// The card a landing-fix turn draws; nil for any other turn, and for words this build cannot read.
    public static func parse(clientTurnId: String?, text: String) -> LandingFixCard? {
        guard isTurn(clientTurnId: clientTurnId, text: text) else { return nil }
        let lines = text.components(separatedBy: "\n")
        guard let first = lines.first, first.hasPrefix(opening), first.hasSuffix("."),
              let on = first.range(of: "\" on ", options: .backwards) else { return nil }
        let title = String(first[first.index(first.startIndex, offsetBy: opening.count)..<on.lowerBound])
        let target = String(first[on.upperBound...].dropLast())
        guard !target.isEmpty else { return nil }
        let body = Array(lines.dropFirst())
        guard let at = body.firstIndex(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty }) else { return nil }
        let line = body[at]
        // The block under the failure's line, up to the blank line that ends it.
        let block = body[(at + 1)...].prefix { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        var upstream: String?
        if let merge = lines.first(where: { $0.hasPrefix("1. Merge \(target) and ") }) {
            let rest = merge.dropFirst("1. Merge \(target) and ".count)
            if let into = rest.range(of: " into your branch") { upstream = String(rest[..<into.lowerBound]) }
        }
        var landing: String?
        if let record = lines.last(where: { $0.hasPrefix("The full record: landing ") }) {
            let id = String(record.dropFirst("The full record: landing ".count)).trimmingCharacters(in: CharacterSet(charactersIn: "."))
            landing = id.isEmpty || id == "not recorded" ? nil : id
        }
        if line.hasPrefix("Conflict while "), line.hasSuffix(":") {
            var rest = String(line.dropFirst("Conflict while ".count).dropLast())
            var sha: String?
            if let atSha = rest.range(of: " at ", options: .backwards), rest[..<atSha.lowerBound].hasSuffix(target) {
                sha = String(rest[atSha.upperBound...])
                rest = String(rest[..<atSha.lowerBound])
            }
            guard rest.hasSuffix(" \(target)") else { return nil }
            let verb = String(rest.dropLast(target.count + 1))
            let files = (block.first ?? "").hasPrefix("(") ? []
                : (block.first ?? "").components(separatedBy: ", ").filter { !$0.isEmpty }
            return LandingFixCard(failure: .conflict, taskTitle: title, target: target, upstream: upstream,
                                  verb: verb, sha: sha.map(shortSha), files: files, landingSessionId: landing)
        }
        if line.hasPrefix("The check \""), line.hasSuffix(":") {
            let afterName = line.dropFirst("The check \"".count)
            guard let close = afterName.firstIndex(of: "\"") else { return nil }
            let name = String(afterName[..<close])
            var sha: String?
            if let tree = line.range(of: "failed on the combined tree ("),
               let end = line[tree.upperBound...].firstIndex(of: ")") {
                sha = String(line[tree.upperBound..<end])
            }
            var exit: String?
            if let comma = line.range(of: ", ", options: .backwards) {
                exit = String(line[comma.upperBound...].dropLast())
            }
            let failureLines = block.filter { !$0.hasPrefix("(no failure lines") }
            return LandingFixCard(failure: .checkFailed, taskTitle: title, target: target, upstream: upstream,
                                  sha: sha.map(shortSha), checkName: name, exit: exit,
                                  failureLines: Array(failureLines), landingSessionId: landing)
        }
        return nil
    }

    // MARK: - ② c, d — the landing window

    /// The task's own work session that holds the landing's failure now, read off its todos; nil when
    /// nobody's session does (the landing is the coordinator's, or settled).
    public static func workSessionId(_ landing: SessionLandingView?) -> String? {
        guard let landing, landing.settledAt == nil else { return nil }
        return landing.todos.first { ($0.workSessionId ?? "").isEmpty == false }?.workSessionId
    }

    /// Whether the landing is in its Fixing state: its failure is in the task's own session's hands.
    public static func isFixing(_ landing: SessionLandingView?) -> Bool { workSessionId(landing) != nil }

    /// Every hand-off on the landing's record, oldest first.
    static func handOffs(_ landing: SessionLandingView) -> [IntegrationTimelineEntry] {
        (landing.timeline?.sections ?? []).flatMap { $0.entries }.filter { $0.kind == "HANDED_TO_SESSION" }
    }

    /// Which round the session is on: its hand-offs so far, capped at W8's two.
    public static func round(_ landing: SessionLandingView) -> Int {
        min(max(1, handOffs(landing).count), OpenItemWorkSession.maxRounds)
    }

    /// The Fixing card's two words under the head: `conflict · its own session is on it`.
    public static func fixingDetail(_ landing: SessionLandingView) -> String {
        let what = landing.currentAttempt?.state == "CHECK_FAILED" ? SessionLandingsCopy.checksFailed
            : landing.currentAttempt?.state == "ERROR" ? SessionLandingsCopy.error : SessionLandingsCopy.conflict
        return "\(what) · \(LandingFixCopy.itsOwnSessionIsOnIt)"
    }

    /// The Fixing card's who-line after `The task's session`: `is fixing it · 4m · round 1 of 2`.
    public static func fixingWho(_ landing: SessionLandingView, now: Date) -> String {
        let since = handOffs(landing).last?.at
            ?? landing.todos.first { $0.workSessionId != nil }?.waitingSince ?? ""
        let elapsed = RelativeTime.elapsed(since, now: now)
        return [LandingFixCopy.isFixingIt, elapsed, LandingFixCopy.round(round(landing))]
            .compactMap { $0 }.joined(separator: " · ")
    }

    /// The hand-back the landing is waiting on the coordinator after (② d): the newest
    /// `RETURNED_TO_COORDINATOR` of the current attempt's section, while the landing is open and no
    /// session holds it. `data.lastMessage` carries the session's last words where the server serves them.
    public static func handBack(_ landing: SessionLandingView?) -> LandingFixHandBack? {
        guard let landing, landing.settledAt == nil, !isFixing(landing),
              let jobId = landing.currentAttempt?.jobId,
              let section = landing.timeline?.sections.first(where: { $0.jobId == jobId }),
              let entry = section.entries.last(where: { $0.kind == "RETURNED_TO_COORDINATOR" }) else { return nil }
        let reason = entry.data?["returnReason"]?.stringValue ?? entry.reason
        let words = entry.data?["lastMessage"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
        return LandingFixHandBack(
            reason: reason,
            lead: reason.flatMap { LandingFixCopy.handBackLeads[$0] } ?? "The task's session could not land it",
            lastMessage: words?.isEmpty == false ? words : nil,
            returnedAt: entry.at,
            sessionId: entry.data?["sessionId"]?.stringValue)
    }

    /// The failure line under the Fixing and hand-back cards' subtitle, as the board words it (② c ①, d ①):
    /// `Conflict in 2 files while rebasing onto project/34ZZn...CsCFp · nothing was pushed`. The count is the
    /// failure item's own files (`OpenItemFacts.files`); without them the sentence says the rest. A failed
    /// check: `Landing check failed on the combined tree · nothing was pushed`. Nil for any other attempt.
    public static func failureLine(_ landing: SessionLandingView?, files: [String]?) -> String? {
        guard let attempt = landing?.currentAttempt else { return nil }
        let branch = shortBranch(TaskLandingLogic.branch(attempt.targetRef))
        switch attempt.state {
        case "CONFLICT":
            let count = (files?.isEmpty == false ? files?.count : nil)
                .map { " in \($0) \($0 == 1 ? "file" : "files")" } ?? ""
            return "Conflict\(count) while \(how(attempt.phase)) \(branch) · \(LandingFixCopy.nothingWasPushedClause)"
        case "CHECK_FAILED":
            let failed = landing?.checks.first { !$0.passed }
            let name = failed.map { LandingPageCopy.checkLabel($0.name) } ?? "A check"
            return "\(name) failed on the combined tree · \(LandingFixCopy.nothingWasPushedClause)"
        default:
            return nil
        }
    }

    /// The hand-back card's subtitle (② d ①): what stopped and where, `conflict · rebasing onto the project branch`.
    public static func handBackDetail(_ landing: SessionLandingView) -> String {
        guard let attempt = landing.currentAttempt else { return "" }
        let ref = TaskLandingLogic.branch(attempt.targetRef)
        let target = ref.hasPrefix("project/") ? LandingFixCopy.theProjectBranch : ref
        switch attempt.state {
        case "CHECK_FAILED": return "\(SessionLandingsCopy.checksFailed) · on the combined tree"
        case "ERROR": return SessionLandingsCopy.error
        default: return "\(SessionLandingsCopy.conflict) · \(how(attempt.phase)) \(target)"
        }
    }

    /// How a landing met the target: `rebasing onto`, `syncing main into`, `merging into`.
    static func how(_ phase: String?) -> String {
        switch phase {
        case "REBASE": return "rebasing onto"
        case "MAIN_SYNC": return "syncing main into"
        default: return "merging into"
        }
    }

    /// The files the landing's failure item names: the open item behind one of its todos, in any group.
    public static func failedFiles(_ landing: SessionLandingView?, in items: ProjectOpenItemsView?) -> [String]? {
        guard let landing, let items else { return nil }
        let ids = Set(landing.todos.map { PublicID.storageKey($0.id) })
        let rows = items.withWorkSession + items.withCoordinator + items.needsYou
        guard let row = rows.first(where: { ids.contains(PublicID.storageKey($0.itemId)) }),
              let files = row.facts?.files, !files.isEmpty else { return nil }
        return files
    }

    /// Whether the window's footer names the task's session first: a landing in hand is with its session.
    public static func sessionFirst(_ window: LandingsWindow, details: [String: SessionLandingView]) -> Bool {
        window.now.contains { $0.state == "FIXING" || isFixing(details[$0.sessionId]) }
    }

    /// `has it · just now` after `Coordinator`, from the moment it came back.
    public static func coordinatorHasIt(_ handBack: LandingFixHandBack, now: Date) -> String {
        let ago = RelativeTime.parse(handBack.returnedAt).map { now.timeIntervalSince($0) < 60 ? "just now"
            : RelativeTime.elapsed(handBack.returnedAt, now: now) ?? "" } ?? ""
        return [LandingFixCopy.hasIt, ago].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// A section's lines without revision 42's rows, which the window draws apart (`rows`).
    public static func stepEntries(_ entries: [IntegrationTimelineEntry]) -> [IntegrationTimelineEntry] {
        entries.filter { !rowKinds.contains($0.kind) }
    }

    /// The rows drawn under one section of the record (② c ②, d ②): its own hand-off and hand-back,
    /// and the fix the next section lands — said where the failure it fixes is, as the board draws it.
    public static func rows(after index: Int, in sections: [IntegrationTimelineSection]) -> [LandingFixRow] {
        guard sections.indices.contains(index) else { return [] }
        let all = sections.flatMap { $0.entries }
        var rows: [LandingFixRow] = []
        for entry in sections[index].entries {
            switch entry.kind {
            case "HANDED_TO_SESSION":
                let ordinal = all.filter { $0.kind == "HANDED_TO_SESSION" && $0.at <= entry.at }.count
                rows.append(LandingFixRow(
                    kind: .handed, at: entry.at, head: entry.text,
                    detail: "\(LandingFixCopy.itWroteThisWork) · \(LandingFixCopy.round(min(max(1, ordinal), OpenItemWorkSession.maxRounds)))",
                    sessionId: entry.data?["sessionId"]?.stringValue))
            case "RETURNED_TO_COORDINATOR":
                let parts = entry.text.components(separatedBy: ": ")
                rows.append(LandingFixRow(
                    kind: .returned, at: entry.at, head: parts[0],
                    rest: parts.count > 1 ? parts.dropFirst().joined(separator: ": ") : nil,
                    sessionId: entry.data?["sessionId"]?.stringValue))
            default:
                break
            }
        }
        if sections.indices.contains(index + 1) {
            for entry in sections[index + 1].entries where entry.kind == "FIXED_BY_SESSION" {
                rows.append(fixedRow(entry))
            }
        }
        return rows.sorted { $0.at < $1.at }
    }

    /// `Fixed in` · the commit · `landing again`, split off the server's sentence around its commit.
    static func fixedRow(_ entry: IntegrationTimelineEntry) -> LandingFixRow {
        let sha = entry.data?["sourceSha"]?.stringValue.map(shortSha)
        var head = entry.text
        var rest: String?
        if let sha, let range = entry.text.range(of: " \(sha)") {
            head = String(entry.text[..<range.lowerBound])
            let after = entry.text[range.upperBound...].trimmingCharacters(in: .whitespaces)
            rest = after.hasPrefix("· ") ? String(after.dropFirst(2)) : (after.isEmpty ? nil : after)
        }
        return LandingFixRow(kind: .fixed, at: entry.at, head: head, sha: rest == nil ? nil : sha, rest: rest,
                             sessionId: entry.data?["sessionId"]?.stringValue)
    }

    /// The session's one line once its fix is queued to land (② b ③), `Landing 4be19c2 again`, the commit
    /// read off the landing's record; nil before any fix of its was queued.
    /// With `by`, only a fix that session asked for: the line is that session's own.
    public static func againLine(_ landing: SessionLandingView?, by sessionID: String? = nil) -> String? {
        guard let landing else { return nil }
        let fixed = (landing.timeline?.sections ?? []).flatMap { $0.entries }
            .last { entry in
                guard entry.kind == "FIXED_BY_SESSION" else { return false }
                guard let sessionID else { return true }
                return entry.data?["sessionId"]?.stringValue.map {
                    PublicID.storageKey($0) == PublicID.storageKey(sessionID)
                } ?? false
            }
        guard let fixed else { return nil }
        return LandingFixCopy.landingAgain(fixed.data?["sourceSha"]?.stringValue.map(shortSha))
    }

    // MARK: - the project page

    /// The Open items row's head for an item its session is fixing: `Landing conflict · <task>`.
    public static func itemHead(_ row: ProjectOpenItemRow, taskTitle: String?) -> String {
        let what: String
        switch row.kind {
        case .integrationCheckFailed: what = TaskLandingCopy.labels["CHECK_FAILED"]!
        case .integrationError: what = TaskLandingCopy.labels["ERROR"]!
        default: what = TaskLandingCopy.labels["CONFLICT"]!
        }
        let task = (taskTitle?.isEmpty == false ? taskTitle : nil) ?? row.title
        return "\(what) · \(task)"
    }

    /// Its second line: `The task's session is on it · 4m · round 1 of 2 · nothing was pushed`.
    public static func itemDetail(_ row: ProjectOpenItemRow, now: Date) -> String {
        guard let held = row.workSession else { return "" }
        return [
            "\(LandingFixCopy.theTasksSession) \(LandingFixCopy.isOnIt)",
            RelativeTime.elapsed(held.offeredAt, now: now),
            LandingFixCopy.round(held.round),
            LandingFixCopy.nothingWasPushedClause,
        ].compactMap { $0 }.joined(separator: " · ")
    }

    // MARK: - words

    /// `project/34ZZnLsPqC2jVd8CsCFp` as the board shortens it, `project/34ZZn...CsCFp`; any other
    /// branch as it is.
    public static func shortBranch(_ branch: String) -> String {
        let prefix = "project/"
        guard branch.hasPrefix(prefix) else { return branch }
        let id = branch.dropFirst(prefix.count)
        guard id.count >= 20, id.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) else { return branch }
        return "\(prefix)\(id.prefix(5))...\(id.suffix(5))"
    }

    /// `app/src/main/kotlin/io/orbitd/notify/ColdStartRouter.kt` as the card's box shows it,
    /// `app/…/notify/ColdStartRouter.kt`: the first folder and the last two parts.
    public static func shortPath(_ path: String) -> String {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count > 3 else { return path }
        return "\(parts[0])/…/\(parts[parts.count - 2])/\(parts[parts.count - 1])"
    }

    static func shortSha(_ sha: String) -> String { String(sha.prefix(7)) }
}
