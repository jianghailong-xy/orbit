import Foundation

/// The Landings row on a project's sessions page and the project's Landings window (owner
/// 2026-10-27, docs/mocks/landings-one-window; contract §2.9 LS6, revision 28): the row's count
/// sentence, the window's day sections and its `Now`, and the read-only footer.
///
/// A direct port of `src/web/src/lib/sessionProjects.ts`'s `landingsWindow` and
/// `landingsRowSummary`; the words live once, in `SessionLandingsCopy`, held to the web's
/// `SESSION_LANDINGS_COPY` by the copy-parity suite.
public enum SessionLandingsCopy {
    public static let title = "Landings"
    public static let waiting = "waiting for a decision"
    public static let inFlight = "in flight"
    public static let landed = "landed"
    public static let mergedInto = "merged into"
    public static let today = "today"
    public static let nothingLandedToday = "Nothing landed today"
    public static let now = "Now"
    public static let orbitRunsTheseLandings = "Orbit runs these landings — nothing to type here."
    /// A merge round's row when its record is past the read's 20: the round merged into main.
    public static let mergedIntoMain = "Merged into main"

    // The derived label on a source work session (board v4 06 e), the web's
    // `SESSION_SOURCE_LANDING_COPY`.
    public static let landing = "Landing"
    public static let on = "On"
    /// The source label's own spelling, capitalized because it stands alone on the chip.
    public static let sourceNothingToLand = "Nothing to land"
    public static let checksFailed = "checks failed"
    public static let conflict = "conflict"
    public static let error = "error"
    public static let queued = "queued"
    public static let running = "running"
}

/// The mark a settled row's head carries: ✓ landed, ⇢ merged into main, ◌ nothing to land and every
/// other quiet ending.
public enum LandingsWindowTone: String, Equatable, Sendable {
    case ok, merge, quiet
}

/// One settled landing in the window, drawn with the merged line's head: the mark that says how it
/// ended, the task's name, the moment it settled, and one line under them.
public struct LandingsWindowRow: Equatable, Sendable, Identifiable {
    /// The row's own key: the landing session's id, or `merge:<promotionId>` for a merge into main
    /// that has no landing session (it predates them).
    public let key: String
    /// The LANDING session the row opens in place; nil for a merge that has none, whose receipt is
    /// all there is to open.
    public let sessionId: String?
    /// `TASK` or `PROMOTION`.
    public let subject: String
    public let title: String
    public let detail: String
    public let tone: LandingsWindowTone
    /// The clock time it settled at, `17:42`.
    public let time: String
    public let at: TimeInterval
    /// The round's merged record (`promotions/merged`), joined by `landingSessionId`; nil on a
    /// task's row and on a round older than the read's 20 records.
    public let promotion: ProjectPromotionView?

    /// What the window opens, scrolls to and outlines: the session where there is one.
    public var id: String { sessionId ?? key }

    public init(key: String, sessionId: String?, subject: String, title: String, detail: String,
                tone: LandingsWindowTone, time: String, at: TimeInterval,
                promotion: ProjectPromotionView? = nil) {
        self.key = key
        self.sessionId = sessionId
        self.subject = subject
        self.title = title
        self.detail = detail
        self.tone = tone
        self.time = time
        self.at = at
        self.promotion = promotion
    }
}

/// One landing that has not settled: a card at the bottom of the window.
public struct LandingsWindowCard: Equatable, Sendable, Identifiable {
    public let sessionId: String
    /// `TASK` or `PROMOTION`.
    public let subject: String
    /// `IN_FLIGHT` or `AWAITING_DECISION`.
    public let state: String
    /// The task's name (a round's own title), the line the card adds under its head.
    public let title: String
    public let at: TimeInterval

    public var id: String { sessionId }

    public init(sessionId: String, subject: String, state: String, title: String, at: TimeInterval) {
        self.sessionId = sessionId
        self.subject = subject
        self.state = state
        self.title = title
        self.at = at
    }
}

/// One of the session list's day sections, holding the landings that settled in it.
public struct LandingsWindowDay: Equatable, Sendable, Identifiable {
    public let title: String
    public let rows: [LandingsWindowRow]
    public var id: String { title }

    public init(title: String, rows: [LandingsWindowRow]) {
        self.title = title
        self.rows = rows
    }
}

public struct LandingsWindow: Equatable, Sendable {
    /// The settled landings by the session list's own day sections, oldest first and oldest row
    /// first: the window reads like a conversation, the newest at the bottom.
    public let days: [LandingsWindowDay]
    /// The landings still in hand, in the order they started — the window's last group.
    public let now: [LandingsWindowCard]

    public init(days: [LandingsWindowDay] = [], now: [LandingsWindowCard] = []) {
        self.days = days
        self.now = now
    }
}

/// The Landings row's mark: ✕ something waits for a decision, the blue ring something is in flight,
/// ✓ all settled.
public enum LandingsRowMark: String, Equatable, Sendable {
    case fail, running, ok
}

/// The Landings row's three facts: the mark of the most urgent landing, how long it has waited (or
/// how long ago the last one settled), and the counts under them.
public struct LandingsRowSummary: Equatable, Sendable {
    public let mark: LandingsRowMark
    public let time: String
    public let line: String

    public init(mark: LandingsRowMark, time: String, line: String) {
        self.mark = mark
        self.time = time
        self.line = line
    }
}

public enum SessionProjectLandings {
    /// A task segment's title is the server's `Land · <task>`: the window names the task alone.
    public static func taskName(_ title: String?) -> String {
        let name = title ?? ""
        let prefix = "\(LandingPageCopy.land) · "
        return name.hasPrefix(prefix) ? String(name.dropFirst(prefix.count)) : name
    }

    /// The project's Landings window: every landing the project has had, from the two reads its
    /// sessions page already makes — the LANDING sessions (`includeLanding=1`, open and completed)
    /// and the merges into main (`promotions/merged`).
    ///
    /// A settled landing is one row in the day it settled, in the session list's own day sections,
    /// all of them kept. A round of merging that merged is one row with its record, joined by
    /// `landingSessionId`; a merge older than landing sessions has a row of its own that opens to its
    /// receipt alone, and a round past the read's last 20 records keeps its session's row. A landing
    /// still in hand — in flight, or waiting for a decision — is a card under `Now`, in the order it
    /// started.
    public static func window(_ rows: [Session], merges: [ProjectPromotionView], now: Date = Date(),
                              calendar: Calendar = .current) -> LandingsWindow {
        let records = merges.filter { $0.merged != nil }
        // A record's `landingSessionId` is not a field the server's id codec rewrites, so it arrives as
        // a UUID while every session's `id` is the base62 public id: both are keyed by
        // `PublicID.storageKey` before they meet, or no round would find its session and each merge
        // drew twice.
        var bySession: [String: ProjectPromotionView] = [:]
        for record in records {
            guard let id = record.landingSessionId, !id.isEmpty else { continue }
            let key = PublicID.storageKey(id)
            if bySession[key] == nil { bySession[key] = record }
        }
        var joined = Set<String>()
        var settled: [(row: LandingsWindowRow, at: String?)] = []
        var cards: [LandingsWindowCard] = []
        for session in rows {
            guard let landing = session.landing else { continue }
            let state = landing.state ?? (landing.settledAt != nil ? "SETTLED" : "IN_FLIGHT")
            let name = landing.subject == "TASK" ? taskName(session.title) : (session.title ?? "")
            if state != "SETTLED" {
                cards.append(LandingsWindowCard(sessionId: session.id, subject: landing.subject, state: state,
                                                title: name, at: instant(session.createdAt)))
                continue
            }
            if landing.subject == "PROMOTION" && landing.settledAs == "MERGED" {
                let record = bySession[PublicID.storageKey(session.id)]
                if let record { joined.insert(record.promotionId) }
                let at = record?.merged?.at ?? landing.settledAt
                settled.append((LandingsWindowRow(
                    key: session.id, sessionId: session.id, subject: "PROMOTION",
                    title: record.map(PromotionCards.timelineTitle) ?? SessionLandingsCopy.mergedIntoMain,
                    detail: record.map(PromotionCards.timelineDetail) ?? name,
                    tone: .merge, time: clock(at), at: instant(at), promotion: record), at))
                continue
            }
            let word = settledWord(landing.settledAs)
            settled.append((LandingsWindowRow(
                key: session.id, sessionId: session.id, subject: landing.subject, title: name,
                detail: word.text, tone: word.tone, time: clock(landing.settledAt),
                at: instant(landing.settledAt)), landing.settledAt))
        }
        // A merge whose round has no session in the read: older than landing sessions, or a session
        // the read did not list. It is still a merge into main, at its own instant.
        for record in records where !joined.contains(record.promotionId) {
            let at = record.merged?.at
            let session = record.landingSessionId.flatMap { $0.isEmpty ? nil : PublicID.toPublic($0) }
            settled.append((LandingsWindowRow(
                key: session ?? "merge:\(record.promotionId)", sessionId: session, subject: "PROMOTION",
                title: PromotionCards.timelineTitle(record), detail: PromotionCards.timelineDetail(record),
                tone: .merge, time: clock(at), at: instant(at), promotion: record), at))
        }
        // Oldest first, in the session list's day sections (the local calendar day): the window
        // reads down to today, and `Now` under it.
        let titles = SessionTimeGrouping.bucketTitles
        let today = calendar.startOfDay(for: now)
        var buckets: [[LandingsWindowRow]] = Array(repeating: [], count: titles.count)
        let ordered = settled.sorted {
            $0.row.at != $1.row.at ? $0.row.at < $1.row.at : $0.row.key > $1.row.key
        }
        for entry in ordered {
            buckets[SessionTimeGrouping.bucketIndex(at: entry.at, today: today, calendar: calendar)]
                .append(entry.row)
        }
        let days = buckets.enumerated().reversed().compactMap { index, rows in
            rows.isEmpty ? nil : LandingsWindowDay(title: titles[index], rows: rows)
        }
        cards.sort { $0.at != $1.at ? $0.at < $1.at : $0.sessionId < $1.sessionId }
        return LandingsWindow(days: days, now: cards)
    }

    /// `1 waiting for a decision · 1 in flight · 3 landed · 1 merged into main today` — a count of 0
    /// is left out, today's two share one `today` at the end, and with all four at 0 the line is
    /// `Nothing landed today`.
    public static func countLine(waiting: Int, inFlight: Int, landed: Int, merged: Int,
                                 main: String = "main") -> String {
        let today = [
            landed > 0 ? "\(landed) \(SessionLandingsCopy.landed)" : nil,
            merged > 0 ? "\(merged) \(SessionLandingsCopy.mergedInto) \(main)" : nil,
        ].compactMap { $0 }.joined(separator: " · ")
        let parts = [
            waiting > 0 ? "\(waiting) \(SessionLandingsCopy.waiting)" : nil,
            inFlight > 0 ? "\(inFlight) \(SessionLandingsCopy.inFlight)" : nil,
            today.isEmpty ? nil : "\(today) \(SessionLandingsCopy.today)",
        ].compactMap { $0 }
        return parts.isEmpty ? SessionLandingsCopy.nothingLandedToday : parts.joined(separator: " · ")
    }

    /// The project sessions page's one Landings row (owner 2026-10-27, board 01 b), in the place the
    /// Landings group had: under the coordinator, above the page's own timeline. It opens the
    /// project's Landings window. Nil for a project that has never had a landing, which draws no row.
    ///
    /// The mark follows the most urgent landing: one waiting for a decision is the red ✕ and the right
    /// slot says how long the longest of them has waited; else one in flight is the blue ring; else ✓.
    /// Without a waiting one the right slot says how long ago the last one settled. Today's counts are
    /// the window's own `Today` section, so the row and the window never disagree about a day.
    public static func rowSummary(_ rows: [Session], merges: [ProjectPromotionView], now: Date = Date(),
                                  calendar: Calendar = .current, main: String = "main") -> LandingsRowSummary? {
        let landings = rows.filter { $0.landing != nil }
        if landings.isEmpty && !merges.contains(where: { $0.merged != nil }) { return nil }
        let window = window(landings, merges: merges, now: now, calendar: calendar)
        let waiting = window.now.filter { $0.state == "AWAITING_DECISION" }
        let inFlight = window.now.filter { $0.state == "IN_FLIGHT" }
        let today = window.days.first { $0.title == SessionTimeGrouping.bucketTitles[0] }?.rows ?? []
        let lastSettled = window.days.flatMap(\.rows).map(\.at).max() ?? -.infinity
        let time: String?
        if let longest = waiting.map(\.at).min() {
            time = elapsed(longest, now: now)
        } else {
            time = lastSettled.isFinite ? elapsed(lastSettled, now: now) : nil
        }
        return LandingsRowSummary(
            mark: !waiting.isEmpty ? .fail : !inFlight.isEmpty ? .running : .ok,
            time: time ?? "",
            line: countLine(waiting: waiting.count, inFlight: inFlight.count,
                            landed: today.filter { $0.tone == .ok }.count,
                            merged: today.filter { $0.tone == .merge }.count, main: main))
    }

    /// How a settled subject ended, in the row's own words.
    static func settledWord(_ settledAs: String?) -> (text: String, tone: LandingsWindowTone) {
        switch settledAs {
        case "LANDED": return (LandingPageCopy.landed, .ok)
        case "ALREADY_LANDED": return (LandingPageCopy.alreadyLanded, .ok)
        case "NOTHING_TO_LAND": return (LandingPageCopy.nothingToLand, .quiet)
        case "HANDLED": return (LandingPageCopy.handled, .quiet)
        case "DECLINED": return (LandingPageCopy.declined, .quiet)
        case "CANCELLED": return (LandingPageCopy.cancelled, .quiet)
        case "DELETED": return (LandingPageCopy.deleted, .quiet)
        default: return (settledAs ?? "Settled", .quiet)
        }
    }

    private static func clock(_ iso: String?) -> String {
        iso.flatMap(RelativeTime.parse).map { ProjectPage.landingClockTime($0) } ?? ""
    }

    /// `20m`, `2h`, `3d` — the waiting chips' own scale, for an instant the window already parsed.
    private static func elapsed(_ at: TimeInterval, now: Date) -> String? {
        ProjectAttention.elapsedLabel(isoFormatter.string(from: Date(timeIntervalSince1970: at)), now: now)
    }

    private static let isoFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

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
