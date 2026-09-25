import Foundation

/// The words the Share panel and the task and project ⋯ menus say about a public link — web's
/// `ShareModal`, `lib/shareLinks.ts` and those two ⋯ menus, word for word
/// (`SharePanelCopyParityTests` reads each one back out of the web source). A button or a menu item
/// takes the platform's title case where the contract spells it so for the apps
/// (docs/share-links-design.md §8: `Copy Link`, `Share Link…`); every other string is the web's,
/// byte for byte.
public enum SharePanelCopy {
    public static let access = "Access"
    public static let onlyYou = "Only you"
    public static let onlyYouDetail = "Turns the link off. Turning it on again makes a new link."
    public static let anyoneWithTheLink = "Anyone with the link"
    public static let anyoneWithTheLinkDetail = "No sign-in needed to view."
    /// Under Access while no public link is open.
    public static let privateDetail =
        "Only you can open it, signed in. Choose “Anyone with the link” to make a public link."

    /// Access → Only you asks first (§8): whoever has the link loses it at once.
    public static let turnOffTitle = "Turn off this link?"
    public static let turnOffDetail = "Anyone who has it loses access right away."
    public static let turnOff = "Turn off"
    public static let cancel = "Cancel"

    /// The public link's two presses. `Share Link…` hands it to the system share sheet, which only
    /// the apps have.
    public static let copyLink = "Copy Link"
    public static let copied = "Copied"
    public static let shareLink = "Share Link…"

    public static let includes = "Includes"
    /// The Conversations layer's risk, in the contract's fixed words (§8).
    public static let conversationsRisk = "Can include command output and file contents."
    /// The count beside the root's own content, which every link includes.
    public static let always = "Always"

    public static let updates = "Updates"
    /// Live is the only kind of link there is (§2), so it is said as a fact rather than offered.
    public static let live = "Live — viewers see changes as they happen"
    public static let expires = "Expires"
    public static let notOpenedYet = "Not opened yet"
    public static let done = "Done"
    /// Before the reason a read failed, and the press that asks again.
    public static let couldNotLoad = "Couldn’t load this link:"
    public static let retry = "Retry"

    // The ⋯ menus of a task and a project. Copy Link there is the signed-in address, for yourself;
    // Share… is the public link (§8).
    public static let share = "Share…"
    /// Beside Share… while the root has a public link open.
    public static let liveLink = "Live link"
    public static let copyAsMarkdown = "Copy as Markdown"
    public static let linkCopied = "Link copied"
    public static let markdownCopied = "Markdown copied"

    public static func title(_ kind: ShareRootKind) -> String {
        switch kind {
        case .session: return "Share session"
        case .task: return "Share task"
        case .project: return "Share project"
        }
    }

    /// Under "Anyone with the link": what a visitor can and cannot do.
    public static func publicDetail(_ kind: ShareRootKind) -> String {
        switch kind {
        case .session:
            return "Anyone with the link can view — no sign-in. They can’t reply or change anything."
        case .task, .project:
            return "Anyone with the link can view — no sign-in. They can’t change anything."
        }
    }

    /// "1 message", "77 messages".
    public static func countOf(_ n: Int, _ noun: String) -> String {
        "\(n) \(noun)\(n == 1 ? "" : "s")"
    }

    /// "Viewed 14 times · last 2h ago", or "Not opened yet". Only opening the root page counts.
    public static func viewsLine(viewCount: Int, lastViewedAt: String?, now: Date) -> String {
        if viewCount == 0 { return notOpenedYet }
        let times = viewCount == 1 ? "once" : "\(viewCount) times"
        guard let lastViewedAt else { return "Viewed \(times)" }
        return "Viewed \(times) · last \(RelativeTime.ago(lastViewedAt, now: now) ?? "unknown")"
    }

    /// "Oct 2", the way the panel names a day.
    public static func shortDate(_ iso: String) -> String? {
        RelativeTime.parse(iso).map { monthDay.string(from: $0) }
    }

    private static let monthDay: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "MMM d"
        return f
    }()
}

/// Expires: Never (the default) or a number of days from now; expiring ends the link.
public struct ShareExpiryChoice: Equatable, Sendable, Identifiable {
    public let value: String
    public let label: String
    public let days: Int?
    public var id: String { value }

    public static let all: [ShareExpiryChoice] = [
        ShareExpiryChoice(value: "never", label: "Never", days: nil),
        ShareExpiryChoice(value: "1", label: "1 day", days: 1),
        ShareExpiryChoice(value: "7", label: "7 days", days: 7),
        ShareExpiryChoice(value: "30", label: "30 days", days: 30),
    ]
}

/// One row of Includes, as the panel draws it.
public struct ShareLayerRow: Equatable, Sendable, Identifiable {
    /// Nil is the root's own content — a session's Messages, a task's or a project's Overview —
    /// which every link includes: its switch is on and cannot be turned off.
    public let layer: ShareLayer?
    public let name: String
    public let detail: String
    /// How much it holds ("29 comments", "Always"); nil until the counts are read.
    public let count: String?
    public let isOn: Bool
    /// Sits under another layer, indented beneath it.
    public let isNested: Bool
    /// Under a layer that is off it shares nothing, whatever its own switch says: greyed out.
    public let isIdle: Bool
    /// Its detail is a risk, said in amber once the layer is on.
    public let warns: Bool
    public var id: String { name }
    /// Whether its switch can be pressed (the panel also holds every switch while a save is out).
    public var isEditable: Bool { layer != nil && !isIdle }
}

/// The Share panel for one root — the native half of web's `ShareModal`, and one panel for a
/// session, a task and a project alike: Access (Only you / Anyone with the link), the public link,
/// the layers it includes with how much each holds, the Live line, Expires, and how often it was
/// opened. Every change is saved as it is made: the panel answers the request a press sends, and
/// takes the server's answer back. Turning a link off asks first, since whoever has it loses it at
/// once, and turning it on again makes a new one. docs/share-links-design.md §2, §3, §8;
/// docs/mocks/share-links/07-mobile ③.
public struct SharePanel: Equatable, Sendable {
    public enum Phase: Equatable, Sendable {
        case loading
        case failed(String)
        case ready
    }

    public enum Access: String, Equatable, Sendable, CaseIterable, Identifiable {
        case onlyYou
        case anyoneWithTheLink

        public var id: String { rawValue }
        public var label: String {
            self == .onlyYou ? SharePanelCopy.onlyYou : SharePanelCopy.anyoneWithTheLink
        }
        public var detail: String {
            self == .onlyYou ? SharePanelCopy.onlyYouDetail : SharePanelCopy.anyoneWithTheLinkDetail
        }
    }

    /// What choosing an Access asks for.
    public enum AccessStep: Equatable, Sendable {
        /// Open a link with the defaults.
        case open(PutShareLinkRequest)
        /// Ask "Turn off this link?" first; only a yes turns it off.
        case confirmTurnOff
        /// It already is that.
        case nothing
    }

    public let kind: ShareRootKind
    public private(set) var phase: Phase = .loading
    /// The open link, never an ended one: a link past its expiry that nobody has settled yet reads as
    /// the ended link it is.
    public private(set) var link: ShareLink?
    public private(set) var counts: ShareCounts?
    /// The Expires duration picked in this sitting, so it can say "7 days" rather than only the date.
    public private(set) var expiryChoice: String?
    /// Switches pressed and not answered yet: they show at once, until the server's answer — or a
    /// refusal — replaces them.
    public private(set) var pending = ShareInclude()

    public init(kind: ShareRootKind) {
        self.kind = kind
    }

    // MARK: what the server said

    public mutating func loaded(_ read: ShareLinkRead) {
        link = Self.open(read.link)
        counts = read.counts
        phase = .ready
    }

    public mutating func loadFailed(_ reason: String) {
        phase = .failed(reason)
    }

    /// A PUT's answer: the link as it now stands.
    public mutating func saved(_ link: ShareLink) {
        self.link = Self.open(link)
        pending = ShareInclude()
    }

    /// A save the server refused: the switches and Expires go back to what the link says.
    public mutating func saveFailed() {
        pending = ShareInclude()
        expiryChoice = nil
    }

    public mutating func turnedOff() {
        link = nil
        expiryChoice = nil
        pending = ShareInclude()
    }

    private static func open(_ link: ShareLink?) -> ShareLink? {
        link?.state == .ended ? nil : link
    }

    // MARK: what it draws, and what a press sends

    public var title: String { SharePanelCopy.title(kind) }

    public var access: Access { link == nil ? .onlyYou : .anyoneWithTheLink }

    /// The line under Access: what a visitor can do, or how to make a public link.
    public var accessDetail: String {
        link == nil ? SharePanelCopy.privateDetail : SharePanelCopy.publicDetail(kind)
    }

    public func step(to access: Access) -> AccessStep {
        switch (access, link) {
        case (.anyoneWithTheLink, nil): return .open(PutShareLinkRequest())
        case (.onlyYou, .some): return .confirmTurnOff
        default: return .nothing
        }
    }

    /// `<baseURL>/s/<token>` — the address a visitor opens, with no sign-in.
    public func publicURL(base: URL) -> URL? {
        link.map { base.appendingPathComponent("s").appendingPathComponent($0.token) }
    }

    public var layers: [ShareLayerRow] {
        var include = link?.include ?? ShareInclude()
        for layer in ShareLayer.allCases where pending[layer] != nil { include[layer] = pending[layer] }
        return Self.layerSpecs(kind).map { spec in
            let on = spec.layer.map { include[$0] != false } ?? true
            let idle = spec.under.map { include[$0] == false } ?? false
            return ShareLayerRow(layer: spec.layer, name: spec.name, detail: spec.detail(counts),
                                 count: counts.map(spec.count), isOn: on, isNested: spec.under != nil,
                                 isIdle: idle, warns: spec.warns && on && !idle)
        }
    }

    /// Press a layer's switch: it shows at once, and the save it needs is its own layer and nothing
    /// else.
    public mutating func toggle(_ layer: ShareLayer, on: Bool) -> PutShareLinkRequest {
        pending[layer] = on
        var include = ShareInclude()
        include[layer] = on
        return PutShareLinkRequest(include: include)
    }

    /// Which Expires option shows as chosen: one picked in this sitting, or — for a link reopened
    /// with an expiry, which has no duration any more — "until", the day it stops.
    public var expirySelection: String {
        expiryChoice ?? (link?.expiresAt != nil ? "until" : "never")
    }

    /// "Until Oct 2": the selection of a link reopened with an expiry.
    public var untilLabel: String? {
        link?.expiresAt.flatMap(SharePanelCopy.shortDate).map { "Until \($0)" }
    }

    /// What Expires offers: Never and the three durations, and while the selection is "until" that
    /// day as well, so the picker has an option to show as chosen.
    public var expiryOptions: [ShareExpiryChoice] {
        guard expirySelection == "until", let untilLabel else { return ShareExpiryChoice.all }
        return ShareExpiryChoice.all + [ShareExpiryChoice(value: "until", label: untilLabel, days: nil)]
    }

    /// Choose an Expires option: remembered for this sitting, and answered with the save it needs —
    /// Never clears the expiry, a duration counts from `now`. Nil for an option that is not one of
    /// the four (the "until" row only shows what is already saved).
    public mutating func chooseExpiry(_ value: String, now: Date) -> PutShareLinkRequest? {
        guard let choice = ShareExpiryChoice.all.first(where: { $0.value == value }) else { return nil }
        expiryChoice = value
        guard let days = choice.days else { return PutShareLinkRequest(expiresAt: .clear) }
        let at = now.addingTimeInterval(Double(days) * 86_400)
        return PutShareLinkRequest(expiresAt: .set(Self.isoOut.string(from: at)))
    }

    /// "Stops working Oct 2", under a duration picked in this sitting — which says how long, not
    /// until when.
    public var expiryHint: String? {
        guard let expiry = link?.expiresAt, expirySelection != "until",
              let day = SharePanelCopy.shortDate(expiry) else { return nil }
        return "Stops working \(day)"
    }

    /// How often the link was opened; nil with no link open.
    public func viewsLine(now: Date) -> String? {
        link.map { SharePanelCopy.viewsLine(viewCount: $0.viewCount, lastViewedAt: $0.lastViewedAt, now: now) }
    }

    /// What a ⋯ menu's Share… says under itself: "Live link" while the root has a public link open,
    /// "Only you" while it has none, and nothing before that has been read.
    public static func menuStatus(_ read: ShareLinkRead?) -> String? {
        guard let read else { return nil }
        return open(read.link) == nil ? SharePanelCopy.onlyYou : SharePanelCopy.liveLink
    }

    private static let isoOut: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    // MARK: the layers of each kind of root (contract §1)

    private struct LayerSpec {
        let layer: ShareLayer?
        let name: String
        let detail: (ShareCounts?) -> String
        let count: (ShareCounts) -> String
        var warns = false
        var under: ShareLayer?
    }

    private static func commentsAndFiles(_ counts: ShareCounts) -> String {
        let files = counts.files ?? 0
        return ([SharePanelCopy.countOf(counts.comments ?? 0, "comment")]
            + (files > 0 ? [SharePanelCopy.countOf(files, "file")] : [])).joined(separator: " · ")
    }

    private static func layerSpecs(_ kind: ShareRootKind) -> [LayerSpec] {
        let comments = LayerSpec(layer: .commentsAndFiles, name: "Comments & files",
                                 detail: { _ in "Written by agents and people" },
                                 count: commentsAndFiles)
        let transcripts: (ShareCounts) -> String = {
            SharePanelCopy.countOf($0.transcripts ?? 0, "transcript")
        }
        switch kind {
        case .session:
            return [
                LayerSpec(layer: nil, name: "Messages", detail: { _ in "What you and the agent wrote" },
                          count: { SharePanelCopy.countOf($0.messages ?? 0, "message") }),
                LayerSpec(layer: .toolOutput, name: "Tool calls and output",
                          detail: { _ in
                              "Commands, file reads and what they returned. Off shows only which tools ran."
                          },
                          count: { SharePanelCopy.countOf($0.toolCalls ?? 0, "call") }),
            ]
        case .task:
            return [
                LayerSpec(layer: nil, name: "Overview",
                          detail: { _ in "Description, acceptance, dependencies and runs" },
                          count: { _ in SharePanelCopy.always }),
                comments,
                LayerSpec(layer: .conversations, name: "Conversations",
                          detail: { _ in SharePanelCopy.conversationsRisk }, count: transcripts, warns: true),
            ]
        case .project:
            var nested = comments
            nested.under = .taskPages
            return [
                LayerSpec(layer: nil, name: "Overview",
                          detail: { _ in "Goal, work overview, acceptance criteria and task graph" },
                          count: { _ in SharePanelCopy.always }),
                LayerSpec(layer: .taskPages, name: "Task pages",
                          detail: { _ in "Description, acceptance and runs for each task" },
                          count: { SharePanelCopy.countOf($0.tasks ?? 0, "task") }),
                nested,
                // What the transcripts are, then the fixed risk sentence (§8).
                LayerSpec(layer: .conversations, name: "Conversations",
                          detail: { counts in
                              guard let counts else { return SharePanelCopy.conversationsRisk }
                              let runs = counts.runs ?? 0
                              let coordinator = (counts.transcripts ?? 0) > runs ? " and the coordinator" : ""
                              return "\(SharePanelCopy.countOf(runs, "run"))\(coordinator). "
                                  + SharePanelCopy.conversationsRisk
                          },
                          count: transcripts, warns: true, under: .taskPages),
            ]
        }
    }
}
