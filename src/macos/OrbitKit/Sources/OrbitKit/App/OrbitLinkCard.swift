import Foundation

// What an Orbit link card says, from the preview the server sent for it.
//
// One skeleton, five contents: the type's icon and name, a title, then one or two lines of status.
// Every word here is one this app already says somewhere — the task pill is `ReferencedTaskNote`'s
// (the browser's TaskStatusPill), a session's status is `SessionStatusGlyph`'s own label, and the
// progress line is the Tasks page's `TaskProgressSummary`, and a wiki entry's words are the Wiki
// pages' own (`WikiCopy`) — so a card and the page it leads to cannot describe the same object in two
// vocabularies. The web client draws the same five cards;
// `OrbitLinkCopy` is the list of sentences it is checked against, which is why every one of them is
// a public constant rather than a literal in the middle of a builder.

/// Every sentence a card can say, in one place. The web client's copy is compared against these.
public enum OrbitLinkCopy {
    /// The two states a card can be in before (or instead of) showing an object.
    public static let notAvailable = "Not available"
    public static let unavailableReason = "Deleted, or not in this account."

    /// What parts two facts on one line.
    public static let separator = " · "

    /// A task's owner, when it has none — the list row's own word.
    public static let unassigned = "Unassigned"
    /// A task nothing has ever run.
    public static let neverRun = "never run"

    /// A wiki entry filed under nothing. Not a warning: plenty of notes are true everywhere.
    public static let noAnchor = "No anchor"

    /// The badge on a session that coordinates a project, and the head of a project card's foot.
    public static let coordinator = "Coordinator"

    /// The progress line's labels, the Tasks page's own (`TaskProgressSummary`).
    public static let doneLabel = "Done"
    public static let openLabel = "Open"
    public static let runningLabel = "Running"
    public static let queuedLabel = "Queued"
    public static let failedLabel = "Failed"

    /// The type name on the card's first row.
    public static func typeName(_ kind: OrbitLinkKind) -> String {
        switch kind {
        case .task:    return "Task"
        case .session: return "Session"
        case .project: return "Project"
        case .list:    return "Task list"
        case .wiki:    return "Wiki"
        }
    }

    /// The first row of a card that has been read: the type's name, and for a wiki entry the kind it
    /// is — "Wiki · Principle" rather than "Wiki" alone, because the kind is what the note IS (the
    /// push block's own lines open the same way, `[Principle] …`). The kind's word is the Wiki pages'
    /// (`WikiCopy.kindLabel`), so the card and those pages cannot name one kind two ways.
    public static func typeName(_ kind: OrbitLinkKind, wikiKind: WikiEntryKind?) -> String {
        guard kind == .wiki, let wikiKind else { return typeName(kind) }
        let entry = WikiCopy.kindLabel(wikiKind)
        return entry.isEmpty ? typeName(kind) : "\(typeName(kind))\(separator)\(entry)"
    }

    /// Groups thousands the way the app's other counts do (`27,468`), and the way the browser's
    /// `toLocaleString('en-US')` does — written out rather than taken from `FormatStyle`, whose
    /// output depends on the host's locale and would read differently on two machines.
    public static func number(_ value: Int) -> String {
        let digits = Array(String(value))
        guard digits.count > 3 else { return String(digits) }
        var out: [Character] = []
        for (index, digit) in digits.enumerated() {
            if index > 0, (digits.count - index) % 3 == 0 { out.append(",") }
            out.append(digit)
        }
        return String(out)
    }

    /// "Done 7 / 8 · Open 1 · Failed 1" — the Tasks page's progress line, the same parts in the same
    /// order and left out at the same counts (a Running or Failed nobody has is noise).
    public static func progressLine(done: Int, total: Int, open: Int,
                                    running: Int? = nil, queued: Int? = nil,
                                    failed: Int? = nil) -> String {
        var parts = ["\(doneLabel) \(number(done)) / \(number(total))",
                     "\(openLabel) \(number(open))"]
        if let running, running > 0 { parts.append("\(runningLabel) \(number(running))") }
        if let queued, queued > 0 { parts.append("\(queuedLabel) \(number(queued))") }
        if let failed, failed > 0 { parts.append("\(failedLabel) \(number(failed))") }
        return parts.joined(separator: separator)
    }

    /// Ready work exists and nothing is picking it up — the project page's `StalledBanner`, word for
    /// word (`1 task is ready, but nothing is running.`).
    public static func stalled(ready: Int) -> String {
        let noun = ready == 1 ? "task is" : "tasks are"
        return "\(number(ready)) \(noun) ready, but nothing is running."
    }

    /// "2 runs" — a task's runs, and `never run` for a task nothing has run (`ReferencedTaskNote`).
    public static func runs(_ count: Int) -> String {
        if count == 0 { return neverRun }
        return count == 1 ? "1 run" : "\(number(count)) runs"
    }

    /// "93 turns".
    public static func turns(_ count: Int) -> String {
        count == 1 ? "1 turn" : "\(number(count)) turns"
    }

    /// "last Succeeded, 93 turns" — how the newest run of a task came out, in the words its glyph
    /// already uses.
    public static func lastRun(_ word: String, turns count: Int) -> String {
        count > 0 ? "last \(word), \(turns(count))" : "last \(word)"
    }
}

/// A card, as the view needs to draw it. Pure: no SwiftUI, no formatting the view has to repeat.
public struct OrbitLinkCardContent: Equatable, Sendable {
    public enum State: Equatable, Sendable {
        /// The link is known, the object is not (yet) — draw the skeleton and the path.
        case loading
        case ready
        /// The server will not say anything about it: deleted, or not this account's.
        case unavailable
    }

    /// One bar of the progress meter. What each role's colour is is the view's business.
    public struct Segment: Equatable, Sendable {
        public enum Role: Equatable, Sendable { case done, ready, failed }
        public let role: Role
        public let fraction: Double
    }

    /// One secondary line.
    public struct Line: Equatable, Sendable {
        public enum Glyph: Equatable, Sendable {
            /// The project a task belongs to.
            case project
            /// The triangle a warning line wears.
            case warning
        }
        public let text: String
        public let glyph: Glyph?
        /// A chip in front of the text — the Coordinator badge, and nothing else so far.
        public let badge: String?
        /// Drawn in the warning tone rather than the secondary one.
        public let isWarning: Bool
        /// A wiki entry's anchor mark in front of the text — `✓ 4db4f9f` when a re-check found it,
        /// the warning word when it did not, nothing when nothing has checked it yet.
        public let anchorMark: WikiAnchorMark?

        public init(text: String, glyph: Glyph? = nil, badge: String? = nil, isWarning: Bool = false,
                    anchorMark: WikiAnchorMark? = nil) {
            self.text = text
            self.glyph = glyph
            self.badge = badge
            self.isWarning = isWarning
            self.anchorMark = anchorMark
        }
    }

    /// The line under a project card's rule: where the project is coordinated, and how long ago.
    public struct Foot: Equatable, Sendable {
        public let text: String
        public let time: String?
    }

    public let state: State
    public let kind: OrbitLinkKind
    public let title: String?
    /// A task's pill (the list row's, live overlays included).
    public let pill: TaskPill?
    /// A session's glyph — the view draws its shape and tone, so a card cannot invent a status
    /// vocabulary of its own.
    public let sessionGlyph: SessionStatusGlyph?
    public let meter: [Segment]
    public let lines: [Line]
    public let foot: Foot?
    /// The mono hint under a loading or unavailable card: `orbitd.io/tasks/<id>`, or a wiki entry's
    /// reference as it was written.
    public let path: String
    /// A wiki entry's kind, which the type name on the first row carries (`typeName(_:wikiKind:)`).
    public let wikiKind: WikiEntryKind?
    /// A wiki entry's trust, drawn as the badge the Wiki's own pages give it.
    public let wikiTrust: WikiTrust?

    public init(state: State, kind: OrbitLinkKind, title: String?, pill: TaskPill?,
                sessionGlyph: SessionStatusGlyph?, meter: [Segment], lines: [Line], foot: Foot?,
                path: String, wikiKind: WikiEntryKind? = nil, wikiTrust: WikiTrust? = nil) {
        self.state = state
        self.kind = kind
        self.title = title
        self.pill = pill
        self.sessionGlyph = sessionGlyph
        self.meter = meter
        self.lines = lines
        self.foot = foot
        self.path = path
        self.wikiKind = wikiKind
        self.wikiTrust = wikiTrust
    }

    /// The first row's words: the type, and a wiki entry's kind beside it.
    public var typeName: String { OrbitLinkCopy.typeName(kind, wikiKind: wikiKind) }

    // MARK: the three states

    /// Before the answer arrives. The path is all that is known, and it is what a reader waiting on
    /// a slow read would have seen on the link itself.
    public static func loading(_ ref: OrbitLinkRef, host: String) -> OrbitLinkCardContent {
        OrbitLinkCardContent(state: .loading, kind: ref.kind, title: nil, pill: nil, sessionGlyph: nil,
                             meter: [], lines: [], foot: nil, path: pathLabel(ref, host: host))
    }

    /// The server will not say: another account's object, a deleted one, or an id that names
    /// nothing — deliberately the same answer to all three.
    public static func unavailable(_ ref: OrbitLinkRef, host: String) -> OrbitLinkCardContent {
        OrbitLinkCardContent(state: .unavailable, kind: ref.kind, title: OrbitLinkCopy.notAvailable,
                             pill: nil, sessionGlyph: nil, meter: [], lines: [Line(text: OrbitLinkCopy.unavailableReason)],
                             foot: nil, path: pathLabel(ref, host: host))
    }

    /// The card for an answer. An `ok` answer missing the payload it promised is drawn as an
    /// unavailable one: a link whose card cannot be built is still a link that has to look like
    /// something, and a half-drawn card would claim an object the server did not describe.
    public static func preview(_ ref: OrbitLinkRef, _ preview: LinkPreview, host: String,
                               now: Date = Date()) -> OrbitLinkCardContent {
        guard preview.state == .ok else { return unavailable(ref, host: host) }
        switch ref.kind {
        case .task:
            guard let task = preview.task else { return unavailable(ref, host: host) }
            return taskCard(ref, task, host: host, now: now)
        case .session:
            guard let session = preview.session else { return unavailable(ref, host: host) }
            return sessionCard(ref, session, host: host, now: now)
        case .project:
            guard let project = preview.project else { return unavailable(ref, host: host) }
            return projectCard(ref, project, host: host, now: now)
        case .list:
            guard let list = preview.list else { return unavailable(ref, host: host) }
            return listCard(ref, list, host: host)
        case .wiki:
            guard let entry = preview.wiki else { return unavailable(ref, host: host) }
            return wikiCard(ref, entry, host: host)
        }
    }

    // MARK: the five contents

    /// Title, the project it is filed under, and how its newest run came out.
    private static func taskCard(_ ref: OrbitLinkRef, _ task: LinkPreviewTask, host: String,
                                 now: Date) -> OrbitLinkCardContent {
        let runs = task.runs ?? 0
        var parts = [task.assignee?.name ?? OrbitLinkCopy.unassigned, OrbitLinkCopy.runs(runs)]
        if let run = task.lastRun {
            parts.append(OrbitLinkCopy.lastRun(runWord(run), turns: run.numTurns ?? 0))
        }
        if let relative = task.lastActivityAt.flatMap({ RelativeTime.format($0, now: now) }) {
            parts.append(relative)
        }
        var lines: [Line] = []
        if let project = task.project?.title, !project.isEmpty {
            lines.append(Line(text: project, glyph: .project))
        }
        lines.append(Line(text: parts.joined(separator: OrbitLinkCopy.separator)))
        return OrbitLinkCardContent(
            state: .ready, kind: ref.kind, title: cardTitle(task.title, ref), pill: taskPill(task),
            sessionGlyph: nil, meter: [], lines: lines, foot: nil, path: pathLabel(ref, host: host))
    }

    /// The task's own pill rule, from `TaskListLogic`: a live run outranks the lifecycle — and the
    /// lifecycle words are the ones the browser draws (`ReferencedTaskNote.pill`).
    private static func taskPill(_ task: LinkPreviewTask) -> TaskPill {
        if let overlay = TaskListLogic.overlayPill(running: task.running == true,
                                                   queued: task.queued == true) {
            return overlay
        }
        return ReferencedTaskNote.pill(status: task.status ?? "")
    }

    /// How a task's newest run came out, in the words its own glyph would use.
    private static func runWord(_ run: LinkPreviewTaskRun) -> String {
        SessionStatusGlyph.make(runState: run.effectiveRunState).label
    }

    /// The status word, the Coordinator badge, and who ran it.
    private static func sessionCard(_ ref: OrbitLinkRef, _ session: LinkPreviewSession, host: String,
                                    now: Date) -> OrbitLinkCardContent {
        var parts = [session.workspace?.name ?? OrbitLinkCopy.unassigned]
        if let model = session.model, !model.isEmpty { parts.append(model) }
        if let turns = session.numTurns, turns > 0 { parts.append(OrbitLinkCopy.turns(turns)) }
        if let relative = session.lastActivityAt.flatMap({ RelativeTime.format($0, now: now) }) {
            parts.append(relative)
        }
        return OrbitLinkCardContent(
            state: .ready, kind: ref.kind, title: cardTitle(session.title, ref), pill: nil,
            sessionGlyph: statusWord(session, now: now), meter: [],
            lines: [Line(text: parts.joined(separator: OrbitLinkCopy.separator),
                         badge: session.projectId != nil ? OrbitLinkCopy.coordinator : nil)],
            foot: nil, path: pathLabel(ref, host: host))
    }

    private static func statusWord(_ session: LinkPreviewSession, now: Date) -> SessionStatusGlyph {
        SessionStatusGlyph.make(runState: session.effectiveRunState,
                                pendingApprovals: session.pendingApprovals,
                                runningBgCount: session.runningBgCount,
                                runningBgJobCount: session.runningBgJobCount,
                                engineTurnActive: session.engineTurnActive == true,
                                error: session.error,
                                retryPending: session.retryPending(now: now),
                                watchingLabel: session.watchingLabel,
                                waitingKind: session.waitingKind)
    }

    /// The lanes, the stalled line, and who coordinates it.
    private static func projectCard(_ ref: OrbitLinkRef, _ project: LinkPreviewProject, host: String,
                                    now: Date) -> OrbitLinkCardContent {
        let buckets = project.buckets
        let total = project.total ?? 0
        let done = buckets?.done ?? 0
        let running = buckets?.running ?? 0
        let ready = buckets?.ready ?? 0
        let failed = buckets?.failed ?? 0
        // Every lane that is not an outcome — the Tasks page's Open, which is the sum of the four it
        // keeps apart and the reason the lanes and the total agree.
        let open = running + ready + (buckets?.blocked ?? 0) + (buckets?.awaitingVerification ?? 0)

        var lines = [Line(text: OrbitLinkCopy.progressLine(done: done, total: total, open: open,
                                                          running: running, failed: failed))]
        if ready > 0 && running == 0 {
            lines.append(Line(text: OrbitLinkCopy.stalled(ready: ready), glyph: .warning, isWarning: true))
        }
        return OrbitLinkCardContent(
            state: .ready, kind: ref.kind, title: cardTitle(project.title, ref), pill: nil, sessionGlyph: nil,
            meter: segments(done: done, ready: ready, failed: failed, total: total), lines: lines,
            foot: foot(project, now: now), path: pathLabel(ref, host: host))
    }

    /// The task list's tallies, which are task statuses rather than lanes: Open counts the two
    /// lifecycle states the list is still working, exactly as the Tasks page counts them.
    private static func listCard(_ ref: OrbitLinkRef, _ list: LinkPreviewList,
                                 host: String) -> OrbitLinkCardContent {
        let counts = list.counts
        let total = counts?.total ?? 0
        let done = counts?.done ?? 0
        let failed = counts?.failed ?? 0
        return OrbitLinkCardContent(
            state: .ready, kind: ref.kind, title: cardTitle(list.title, ref), pill: nil, sessionGlyph: nil,
            meter: segments(done: done, ready: 0, failed: failed, total: total),
            lines: [Line(text: OrbitLinkCopy.progressLine(
                done: done, total: total, open: (counts?.open ?? 0) + (counts?.inProgress ?? 0),
                running: counts?.running, queued: counts?.queued, failed: failed))],
            foot: nil, path: pathLabel(ref, host: host))
    }

    /// The entry's trust as its badge, its one sentence, what it stands on and whether that still
    /// holds, and — for an entry agents are no longer handed — the line that says so. The words are
    /// the browser's card's (`OrbitLinkCard.tsx`), line for line.
    private static func wikiCard(_ ref: OrbitLinkRef, _ entry: LinkPreviewWiki,
                                 host: String) -> OrbitLinkCardContent {
        var lines: [Line] = []
        if let summary = entry.summary, !summary.isEmpty { lines.append(Line(text: summary)) }
        // An entry nothing has re-checked says nothing about its anchors rather than claiming they
        // are fine: `anchorMark` answers nil for exactly that, which is why the mark is not the text.
        let mark = WikiLogic.anchorMark(state: entry.anchorState, checkedRef: entry.anchorCheckedRef)
        let anchor = entry.anchor.map(WikiLogic.anchorLabel) ?? OrbitLinkCopy.noAnchor
        lines.append(Line(text: anchor, isWarning: mark?.tone == .amber || mark?.tone == .red,
                          anchorMark: mark))
        // A retired or superseded entry still reads, and a card that hid it would keep claiming a
        // note agents are no longer being handed.
        if let status = entry.status, status != .active {
            lines.append(Line(text: WikiCopy.noLongerPushed, glyph: .warning, isWarning: true))
        }
        return OrbitLinkCardContent(
            state: .ready, kind: ref.kind, title: cardTitle(entry.title, ref), pill: nil,
            sessionGlyph: nil, meter: [], lines: lines, foot: nil, path: pathLabel(ref, host: host),
            wikiKind: entry.kind, wikiTrust: entry.trust)
    }

    /// Done green, ready orange, failed red, over the whole — the project page's meter. A lane
    /// nothing is in draws no segment at all rather than a zero-width one.
    private static func segments(done: Int, ready: Int, failed: Int, total: Int) -> [Segment] {
        guard total > 0 else { return [] }
        return [(Segment.Role.done, done), (.ready, ready), (.failed, failed)]
            .filter { $0.1 > 0 }
            .map { Segment(role: $0.0, fraction: Double($0.1) / Double(total)) }
    }

    /// `Coordinator · Waiting for your reply` — the coordinator session's own word, and how long ago
    /// it was last touched. A project with no coordinator session draws no foot at all.
    private static func foot(_ project: LinkPreviewProject, now: Date) -> Foot? {
        guard let coordinator = project.coordinator else { return nil }
        let word = statusWord(coordinator, now: now).label
        return Foot(text: "\(OrbitLinkCopy.coordinator)\(OrbitLinkCopy.separator)\(word)",
                    time: coordinator.lastActivityAt.flatMap { RelativeTime.format($0, now: now) })
    }

    /// A card's title, or the id the link wrote when the server sent none: a card with a blank
    /// title row reads as broken, and the id is at least true.
    private static func cardTitle(_ sent: String?, _ ref: OrbitLinkRef) -> String {
        guard let sent, !sent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return ref.source.writtenID
        }
        return sent
    }

    /// `orbitd.io/tasks/34Mx0dQe8RkV2uLbNw7Ta` — the host without its scheme, the path this
    /// deployment serves for the kind, and the id as the link wrote it.
    ///
    /// A wiki entry has no page URL to imitate — the reference IS its address — so its hint is the
    /// reference as it was written.
    public static func pathLabel(_ ref: OrbitLinkRef, host: String) -> String {
        if ref.kind == .wiki {
            if case .reference(let written) = ref.source { return written }
            return ref.source.writtenID
        }
        var label = host.trimmingCharacters(in: .whitespacesAndNewlines)
        if let scheme = label.range(of: "://") { label = String(label[scheme.upperBound...]) }
        label = String(label.prefix { $0 != "/" && $0 != "?" && $0 != "#" })
        let written = ref.source.writtenID
        let id = written.isEmpty ? PublicID.toPublic(ref.id) : written
        return "\(label)/\(ref.kind.pathSegment)/\(id)"
    }
}
