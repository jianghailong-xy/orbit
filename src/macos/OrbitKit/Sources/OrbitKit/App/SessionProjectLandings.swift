import Foundation

/// The Landings group of a project's sessions page (owner 2026-10-19, board v4 04 c1; contract §2.9
/// LS6): the landings waiting on a decision and the ones that settled in the last day, under the
/// coordinator and above the page's own timeline.
///
/// Each row wears the merged line's head — a mark that says how it ended, the title, how long it has
/// waited or how long ago it settled, and one line under them saying the outcome and who holds it —
/// and opens the landing session itself. A landing still in flight is not here (it is on the Landing
/// card), and neither is a round of merging that merged (the timeline already has its own row).
/// Everything older folds into one line that opens.
///
/// A direct port of `src/web/src/lib/sessionProjects.ts`'s `landingGroup`; the words live once, in
/// `SessionLandingsCopy`, held to the web's `SESSION_LANDINGS_COPY` by the copy-parity suite.
public enum SessionLandingsCopy {
    public static let title = "Landings"
    public static let earlier = "Earlier"
    public static let landed = "landed"
    public static let nothingToLand = "nothing to land"
    public static let withYou = "with you"
    public static let withCoordinator = "with the coordinator"
    public static let waiting = "Waiting for a decision"

    // The derived label on a source work session (board v4 06 e), the web's
    // `SESSION_SOURCE_LANDING_COPY`.
    public static let landing = "Landing"
    public static let on = "On"
    /// The source label's own spelling, capitalized because it stands alone on the chip — the
    /// group's fold says the same fact in lower case (`nothingToLand`).
    public static let sourceNothingToLand = "Nothing to land"
    public static let checksFailed = "checks failed"
    public static let conflict = "conflict"
    public static let error = "error"
    public static let queued = "queued"
    public static let running = "running"
}

/// How far back a settled landing is still listed in the group: 24 hours (owner 2026-10-19).
public let landingsSettledWindow: TimeInterval = 24 * 60 * 60

/// The mark a landing group row's head carries: ✕ stopped, ✓ landed, ⇢ merged, ◌ nothing to land.
public enum LandingGroupTone: String, Equatable, Sendable {
    case fail, ok, merge, quiet
}

public struct LandingGroupRow: Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    /// The right-hand slot: how long it has waited, or how long ago it settled.
    public let time: String
    public let detail: String
    public let tone: LandingGroupTone

    public init(id: String, title: String, time: String, detail: String, tone: LandingGroupTone) {
        self.id = id
        self.title = title
        self.time = time
        self.detail = detail
        self.tone = tone
    }
}

/// The fold's two counts: how many of the older landings landed, and how many had nothing to land.
public struct LandingEarlier: Equatable, Sendable {
    public let landed: Int
    public let nothing: Int

    public init(landed: Int, nothing: Int) {
        self.landed = landed
        self.nothing = nothing
    }
}

public struct LandingGroup: Equatable, Sendable {
    public let waiting: [LandingGroupRow]
    public let settled: [LandingGroupRow]
    /// Everything older than the window, folded into one row; nil when none of it landed or had
    /// nothing to land (both counts 0).
    public let earlier: LandingEarlier?
    /// Those same older landings, newest first — what the fold opens to. Empty exactly when
    /// `earlier` is nil.
    public let older: [LandingGroupRow]

    public init(waiting: [LandingGroupRow] = [], settled: [LandingGroupRow] = [],
                earlier: LandingEarlier? = nil, older: [LandingGroupRow] = []) {
        self.waiting = waiting
        self.settled = settled
        self.earlier = earlier
        self.older = older
    }

    /// The group draws nothing at all when it has nothing to list.
    public var isEmpty: Bool {
        waiting.isEmpty && settled.isEmpty && older.isEmpty
    }
}

/// What the row a landing is waiting on says: its kind's outcome, and whose it is.
public struct LandingHolder: Equatable, Sendable {
    public let reason: String?
    /// `OWNER` or `COORDINATOR`.
    public let assignee: String?

    public init(reason: String? = nil, assignee: String? = nil) {
        self.reason = reason
        self.assignee = assignee
    }
}

public enum SessionProjectLandings {
    /// The group of a project's landing rows, or nil when it has nothing to list.
    ///
    /// `holders` is what the project's open items say about a landing that is waiting (§4.7): its
    /// kind's outcome and which side is holding it. A landing with no item still says it is waiting,
    /// because the server's AWAITING_DECISION is the fact that put it there.
    public static func group(_ rows: [Session], now: Date = Date(),
                             holders: [String: LandingHolder] = [:]) -> LandingGroup? {
        var waiting: [(row: LandingGroupRow, at: TimeInterval)] = []
        var settled: [(row: LandingGroupRow, at: TimeInterval)] = []
        var before: [(row: LandingGroupRow, at: TimeInterval)] = []
        var landed = 0
        var nothing = 0
        for session in rows {
            guard let landing = session.landing else { continue }
            if landing.state == "IN_FLIGHT" { continue }
            let title = (session.title?.isEmpty == false) ? session.title! : SessionLandingsCopy.title
            if landing.state == "AWAITING_DECISION" {
                let holder = holders[session.id]
                let outcome = holder?.reason ?? SessionLandingsCopy.waiting
                let who = holder?.assignee == "OWNER" ? SessionLandingsCopy.withYou
                    : holder?.assignee == "COORDINATOR" ? SessionLandingsCopy.withCoordinator : nil
                waiting.append((
                    LandingGroupRow(
                        id: session.id, title: title,
                        time: ProjectAttention.elapsedLabel(session.createdAt, now: now) ?? "",
                        detail: [outcome, who].compactMap { $0 }.joined(separator: " · "),
                        // An item names what stopped it, and that is the red mark; a waiting landing
                        // with no item yet says only that it is waiting.
                        tone: holder?.reason != nil ? .fail : .quiet),
                    instant(session.createdAt)))
                continue
            }
            // A round of merging that merged is the timeline's own row, not this group's.
            if landing.subject == "PROMOTION" && landing.settledAs == "MERGED" { continue }
            let at = instant(landing.settledAt)
            let word = settledWord(landing.settledAs)
            if !at.isFinite || now.timeIntervalSince1970 - at > landingsSettledWindow {
                if landing.settledAs == "LANDED" || landing.settledAs == "ALREADY_LANDED" { landed += 1 }
                if landing.settledAs == "NOTHING_TO_LAND" { nothing += 1 }
                before.append((
                    LandingGroupRow(
                        id: session.id, title: title,
                        time: ProjectAttention.elapsedLabel(landing.settledAt, now: now) ?? "",
                        detail: word.text, tone: word.tone),
                    at.isFinite ? at : -.infinity))
                continue
            }
            settled.append((
                LandingGroupRow(
                    id: session.id, title: title,
                    time: ProjectAttention.elapsedLabel(landing.settledAt, now: now) ?? "",
                    detail: word.text, tone: word.tone),
                at))
        }
        if waiting.isEmpty && settled.isEmpty && landed + nothing == 0 { return nil }
        // The waiting ones first, longest wait first: the page answers "what is stuck, and on whom".
        waiting.sort { $0.at < $1.at }
        settled.sort { $0.at > $1.at }
        before.sort { $0.at > $1.at }
        // The fold counts only what landed and what had nothing to land: with both at 0 there is no
        // fold, and the older rows it would open to go with it.
        let earlier = landed + nothing > 0 ? LandingEarlier(landed: landed, nothing: nothing) : nil
        return LandingGroup(
            waiting: waiting.map(\.row),
            settled: settled.map(\.row),
            earlier: earlier,
            older: earlier == nil ? [] : before.map(\.row))
    }

    /// How a settled subject ended, in the group's own words.
    static func settledWord(_ settledAs: String?) -> (text: String, tone: LandingGroupTone) {
        switch settledAs {
        case "LANDED": return (LandingPageCopy.landed, .ok)
        case "ALREADY_LANDED": return (LandingPageCopy.alreadyLanded, .ok)
        case "MERGED": return ("Merged into main", .merge)
        case "NOTHING_TO_LAND": return (LandingPageCopy.nothingToLand, .quiet)
        case "HANDLED": return (LandingPageCopy.handled, .quiet)
        case "DECLINED": return (LandingPageCopy.declined, .quiet)
        case "CANCELLED": return (LandingPageCopy.cancelled, .quiet)
        case "DELETED": return (LandingPageCopy.deleted, .quiet)
        default: return (settledAs ?? "Settled", .quiet)
        }
    }

    /// What an open item about a landing is about, in the group's words; nil for a kind that is not
    /// a landing's outcome.
    public static func itemReason(_ kind: ProjectOpenItemKind) -> String? {
        switch kind {
        case .integrationConflict: return "Merge conflict"
        case .integrationCheckFailed: return "Checks failed"
        case .integrationError: return "Integration error"
        case .taskFailed: return "Task failed"
        case .deliveryReview: return "Delivery review"
        case .landingLeaseExpired: return "No report from the runner"
        default: return nil
        }
    }

    /// `Earlier · 31 landed · 3 nothing to land` — the fold's one line. A segment whose count is 0
    /// is left out: `Earlier · 2 landed`.
    public static func earlierLine(landed: Int, nothing: Int) -> String {
        var parts = [SessionLandingsCopy.earlier]
        if landed > 0 { parts.append("\(landed) \(SessionLandingsCopy.landed)") }
        if nothing > 0 { parts.append("\(nothing) \(SessionLandingsCopy.nothingToLand)") }
        return parts.joined(separator: " · ")
    }

    /// The derived label on a source work session (board v4 06 e): three facts, three inks. A
    /// settled subject says where the work went; an open one says what the platform is doing — the
    /// attempt's own step where the server names it, else its state.
    public static func sourceLabel(_ landing: SessionSourceLanding?,
                                   main: String = "main") -> SourceLandingLabel? {
        guard let landing else { return nil }
        let branch = branchOf(landing.targetRef).isEmpty
            ? branchOf(main) : branchOf(landing.targetRef)
        switch landing.settledAs {
        case "LANDED", "ALREADY_LANDED":
            return SourceLandingLabel(text: "\(SessionLandingsCopy.on) \(branch) ✓", tone: "landed")
        case "MERGED":
            return SourceLandingLabel(text: "\(SessionLandingsCopy.on) \(RunSettings.mainBranchName(main)) ✓",
                                      tone: "landed")
        case "NOTHING_TO_LAND":
            return SourceLandingLabel(text: SessionLandingsCopy.sourceNothingToLand, tone: "quiet")
        case "HANDLED", "DECLINED", "CANCELLED", "DELETED":
            return SourceLandingLabel(
                text: "\(SessionLandingsCopy.landing) · "
                    + ((landing.settledAs ?? "").lowercased()),
                tone: "quiet")
        default:
            break
        }
        let stopped: String?
        switch landing.state {
        case "CHECK_FAILED": stopped = SessionLandingsCopy.checksFailed
        case "CONFLICT": stopped = SessionLandingsCopy.conflict
        case "ERROR": stopped = SessionLandingsCopy.error
        default: stopped = nil
        }
        if let stopped {
            return SourceLandingLabel(text: "\(SessionLandingsCopy.landing) · \(stopped)", tone: "failed")
        }
        let step: String
        if landing.state == "RUNNING" {
            step = landing.phase.flatMap { ProjectPage.integrationPhaseWords(main)[$0] }
                ?? SessionLandingsCopy.running
        } else if landing.state == "QUEUED" {
            step = SessionLandingsCopy.queued
        } else {
            step = landing.state.lowercased()
        }
        return SourceLandingLabel(text: "\(SessionLandingsCopy.landing) · \(step)", tone: "run")
    }

    private static func branchOf(_ ref: String?) -> String {
        (ref ?? "").replacingOccurrences(of: "refs/heads/", with: "")
    }

    private static func instant(_ iso: String?) -> TimeInterval {
        guard let iso, let date = RelativeTime.parse(iso) else { return -.infinity }
        return date.timeIntervalSince1970
    }
}

/// The source session's derived landing label: its words and the ink they wear.
public struct SourceLandingLabel: Equatable, Sendable {
    public let text: String
    /// `run`, `landed`, `failed` or `quiet`.
    public let tone: String

    public init(text: String, tone: String) {
        self.text = text
        self.tone = tone
    }
}
