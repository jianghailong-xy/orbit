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
}

/// One part of the status line: its words, how it is coloured and marked, and where it leads when it is a
/// link (the web's `WikiStatusPart`).
public struct WikiStatusPart: Equatable, Sendable {
    /// muted: grey; warn: amber, a run that waits; error: red, a run that broke.
    public enum Tone: String, Sendable { case plain, muted, warn, error }
    /// check: a green ✓ after it; dot: a coloured dot before it; spin: a spinner before it on a wide screen.
    public enum Mark: String, Sendable { case none, check, dot, spin }
    /// settings: the space's Wiki settings; run: the session of the run that ended last.
    public enum Link: String, Sendable { case none, settings, run }

    public let text: String
    public let tone: Tone
    public let mark: Mark
    public let link: Link
    public let strong: Bool

    public init(_ text: String, tone: Tone = .plain, mark: Mark = .none, link: Link = .none, strong: Bool = false) {
        self.text = text
        self.tone = tone
        self.mark = mark
        self.link = link
        self.strong = strong
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
            if health.lastRun?.sessionId != nil { parts.append(WikiStatusPart(WikiModeCopy.viewRun, link: .run)) }
            return parts
        case .ok:
            let lead = health.lastOkAt.map { WikiStatusPart(WikiHealthCopy.maintained(ago($0, now: now)), mark: .check) }
                ?? WikiStatusPart(WikiHealthCopy.maintenanceOn)
            return [lead, catchUp]
        case .unknown:
            return []
        }
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
