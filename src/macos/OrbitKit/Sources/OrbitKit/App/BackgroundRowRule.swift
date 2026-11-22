import Foundation

/// The folded "Background" row of a session's composer band: what it draws, from the session's
/// background list, the cut-off time (`clearedAt`) and whether the session is live.
/// A port of `backgroundRow` in src/shared/src/backgroundRow.ts; `BackgroundRowRuleParityTests`
/// runs it over every case of `background-row.fixture.json`, which the web and Android read too.
///
/// Owner decisions (project 34yq7HVPsPDGBiMEm8sL2, 2026-11-17): an ended process stays until the
/// user's next message or the agent's next turn, whichever comes first, a wake's turn included
/// (D1, revised 2026-11-21; an item that ended mid-turn stays until the next turn starts); the visible label is "Background",
/// the screen reader keeps "Background processes" (D2); several running rotate their names, newest
/// started first, 3000 ms each with a 300 ms change (E1); a failure is neither counted nor pinned, as
/// the owner can do nothing about it (E2, revised 2026-11-21); nothing running names the last one to
/// end, failed or not (E3).
public enum BackgroundRowRule {
    /// The row's visible label.
    public static let label = "Background"
    /// The screen-reader label's start; the count or the one name follows.
    public static let accessibilityPrefix = "Background processes, "
    /// How long each name shows while the names rotate.
    public static let rotatePerNameMs = 3000
    /// How long the change from one name to the next takes.
    public static let rotateChangeMs = 300

    /// The fields of a background list entry the row reads, in the shared vocabulary
    /// (status running | done | failed | killed | unknown).
    public struct Input: Equatable, Sendable, Decodable {
        public var shellId: String
        public var command: String
        public var description: String?
        public var startedSeq: Int
        public var status: String
        public var endedAt: String?

        public init(shellId: String, command: String, description: String?, startedSeq: Int,
                    status: String, endedAt: String?) {
            self.shellId = shellId
            self.command = command
            self.description = description
            self.startedSeq = startedSeq
            self.status = status
            self.endedAt = endedAt
        }
    }

    /// The mark after a name: a spinner while running, then the list row's ✓ / ✕ / stop icon.
    public enum Mark: String, Equatable, Sendable { case running, done, failed, killed }

    /// Where a name gives way when it does not fit: a description loses its tail, a command its middle.
    public enum Truncate: String, Equatable, Sendable { case tail, middle }

    public struct Item: Equatable, Sendable, Identifiable {
        public var id: String
        public var name: String
        public var truncate: Truncate
        public var mark: Mark
    }

    public struct CountPart: Equatable, Sendable {
        /// `running`.
        public var kind: String
        public var text: String
    }

    public enum Name: Equatable, Sendable {
        /// One named item, still.
        case one(Item)
        /// The running items' names in turn, newest started first, looping.
        case rotate([Item], perNameMs: Int, changeMs: Int)
    }

    /// A shown row. A hidden one is `nil` from `row`.
    public struct Row: Equatable, Sendable {
        public var label: String
        public var name: Name
        /// The count's parts, zero parts left out; empty unless more than one item is shown.
        public var countParts: [CountPart]
        /// The parts joined by " · ", or nil when there are none.
        public var countLine: String?
        /// "Background processes, " + the count, or the one name. Never the rotating text.
        public var accessibilityLabel: String
    }

    /// A list entry's name: its description, falling back to its command (then its id).
    public static func itemName(_ s: Input) -> (name: String, truncate: Truncate) {
        if let d = s.description?.trimmingCharacters(in: .whitespacesAndNewlines), !d.isEmpty {
            return (d, .tail)
        }
        let command = s.command.trimmingCharacters(in: .whitespacesAndNewlines)
        return (command.isEmpty ? s.shellId : command, .middle)
    }

    private static func time(_ iso: String?) -> Date? { iso.flatMap(RelativeTime.parse) }

    /// The items the row shows: the running ones (only on a live session — a session that is not
    /// live has nothing running, whatever its list last said) and the ended ones that ended after
    /// `clearedAt` (all ended ones when it is nil).
    public static func shown(_ list: [Input], clearedAt: String?,
                             sessionLive: Bool) -> (running: [Input], ended: [Input]) {
        let since = time(clearedAt)
        let running = sessionLive ? list.filter { $0.status == "running" } : []
        let ended = list.filter { s in
            guard ["done", "failed", "killed"].contains(s.status), let end = time(s.endedAt) else { return false }
            return since.map { end > $0 } ?? true
        }
        return (running, ended)
    }

    /// What the folded row draws, or nil for no row.
    public static func row(_ list: [Input], clearedAt: String?, sessionLive: Bool) -> Row? {
        let (running, ended) = shown(list, clearedAt: clearedAt, sessionLive: sessionLive)
        let shown = running + ended
        guard !shown.isEmpty else { return nil }

        func item(_ s: Input) -> Item {
            let n = itemName(s)
            return Item(id: s.shellId, name: n.name, truncate: n.truncate, mark: Mark(rawValue: s.status) ?? .running)
        }
        // The last to end; the first of equal ends, as the shared rule's reduce keeps it.
        func lastEnded(_ xs: [Input]) -> Input {
            xs.dropFirst().reduce(xs[0]) { a, b in
                (time(b.endedAt) ?? .distantPast) > (time(a.endedAt) ?? .distantPast) ? b : a
            }
        }

        let name: Name
        if shown.count == 1 {
            name = .one(item(shown[0]))
        } else if running.count >= 2 {
            name = .rotate(running.sorted { $0.startedSeq > $1.startedSeq }.map(item),
                           perNameMs: rotatePerNameMs, changeMs: rotateChangeMs)
        } else if running.count == 1 {
            name = .one(item(running[0]))
        } else {
            name = .one(item(lastEnded(ended)))
        }

        // How many run; no failed count (E2).
        var parts: [CountPart] = []
        if shown.count > 1, !running.isEmpty {
            parts.append(CountPart(kind: "running", text: "\(running.count) running"))
        }
        let countLine = parts.isEmpty ? nil : parts.map(\.text).joined(separator: " · ")
        let spoken: String
        switch name {
        case .one(let i): spoken = countLine ?? i.name
        case .rotate(let items, _, _): spoken = countLine ?? items[0].name
        }
        return Row(label: label, name: name, countParts: parts, countLine: countLine,
                   accessibilityLabel: accessibilityPrefix + spoken)
    }

    /// The tray's processes in the rule's terms: the native `completed` is the shared `done` and a
    /// live `stopped` its `killed` (shared `terminalFromStatus`), and the launch order
    /// (`TranscriptReducer.seedBackground` keeps the list chronological) is `startedSeq`.
    public static func inputs(_ procs: [BackgroundProc]) -> [Input] {
        procs.enumerated().map { index, p in
            let status = p.status == "completed" ? "done" : p.status == "stopped" ? "killed" : p.status
            return Input(shellId: p.id, command: p.command ?? "", description: p.description, startedSeq: index,
                         status: status, endedAt: p.endedAt)
        }
    }

    /// The row for a session's tray, as `ConsoleModel` holds it.
    public static func row(_ procs: [BackgroundProc], items: [TranscriptItem],
                           lastAgentTurnStartedAt: String? = nil, sessionLive: Bool) -> Row? {
        row(inputs(procs), clearedAt: clearedAt(items: items, lastAgentTurnStartedAt: lastAgentTurnStartedAt),
            sessionLive: sessionLive)
    }

    /// The row's cut-off: the later of the person's last message and the agent's latest turn start
    /// (nil: neither). Port of `backgroundRowClearedAt`.
    public static func clearedAt(lastUserMessageAt: String?, lastAgentTurnStartedAt: String?) -> String? {
        guard let a = time(lastUserMessageAt) else { return time(lastAgentTurnStartedAt) == nil ? nil : lastAgentTurnStartedAt }
        guard let b = time(lastAgentTurnStartedAt) else { return lastUserMessageAt }
        return b > a ? lastAgentTurnStartedAt : lastUserMessageAt
    }

    /// The cut-off for a session's transcript: its last typed message against its latest agent turn.
    public static func clearedAt(items: [TranscriptItem], lastAgentTurnStartedAt: String?) -> String? {
        clearedAt(lastUserMessageAt: lastUserMessageAt(items), lastAgentTurnStartedAt: lastAgentTurnStartedAt)
    }

    /// When the person last sent a message: the newest user turn somebody typed. A turn Orbit opened
    /// (a wake, a job's news, a task's start, a card) is nobody's message and clears nothing; an
    /// optimistic bubble counts once its durable event gives it a time.
    public static func lastUserMessageAt(_ items: [TranscriptItem]) -> String? {
        for item in items.reversed() {
            guard case .user(let b) = item, let ts = b.ts, !b.authoredByOrbit, !StickySummary.isOrbits(b),
                  StickySummary.isAnchor(text: b.text, note: b.note, itemCard: b.itemCard, taskStart: b.taskStart,
                                         startedCard: b.startedCard, sessionMessage: b.sessionMessage,
                                         ownerAnswer: b.ownerAnswer, coordinatorDelivery: b.coordinatorDelivery,
                                         hasAttachments: !b.attachments.isEmpty)
            else { continue }
            return ts
        }
        return nil
    }
}
