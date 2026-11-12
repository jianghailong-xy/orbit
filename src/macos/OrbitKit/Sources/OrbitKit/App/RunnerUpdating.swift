import Foundation

/// The server's account of a runner draining for a self-update, beside `queuedReason`
/// `runner_updating` (docs/runner-update-drain-design.md): the release it installs next, when the
/// wait began, and the reader's own turns the drain waits for, oldest first. Web: `QueuedRunnerUpdate`.
public struct QueuedRunnerUpdate: Codable, Equatable, Sendable {
    public struct Turn: Codable, Equatable, Sendable {
        public let id: String
        public let title: String?
        public init(id: String, title: String?) {
            self.id = id
            self.title = title
        }
    }

    /// The release it installs next; nil from a runner that does not report it.
    public let targetVersion: String?
    /// When the wait began: the drain's start, or this session's own wait where the runner names none.
    public let since: String?
    public let turns: [Turn]

    public init(targetVersion: String?, since: String?, turns: [Turn]) {
        self.targetVersion = targetVersion
        self.since = since
        self.turns = turns
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        targetVersion = try? c.decodeIfPresent(String.self, forKey: .targetVersion)
        since = try? c.decodeIfPresent(String.self, forKey: .since)
        turns = (try? c.decodeIfPresent([Turn].self, forKey: .turns)) ?? []
    }
}

/// A session queued on a runner that is draining for its self-update — the native port of the
/// `runner_updating` half of web `runnerSlots.ts` (board 5 of docs/mocks/runner-update-drain, first
/// phone): the list's and header's word, the queued page's explanation and wait, and the foot-row tag
/// under the message it holds. Every sentence is the web's, and `RunnerUpdatingCopyParityTests` reads
/// `runnerSlots.ts` back to keep it so. Later and Update Now… come with the tasks that make them work.
public enum RunnerUpdating {
    public static let reason = "runner_updating"
    /// The list chip, the header word and the queued page's title. Web `RUNNER_UPDATING_TITLE`.
    public static let RUNNER_UPDATING_TITLE = "Runner updating"
    /// The foot-row tag under a message the drain holds: `Queued · ` then this. Web `RUNNER_UPDATING_TAG`.
    public static let RUNNER_UPDATING_TAG = "runner updating"
    /// The word before the tag, the queued message's own.
    public static let queuedWord = "Queued"

    /// A run of the explanation: words, or a turn the reader can open.
    public enum Part: Equatable, Sendable {
        case text(String)
        case turn(id: String, title: String)
    }

    /// Whether this session is held by its runner's update: queued, and the server named that gate.
    public static func holds(_ s: Session) -> Bool {
        s.effectiveRunState == .queued && s.queuedReason == reason
    }

    private static func turnTitle(_ title: String?) -> String {
        let t = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return t.isEmpty ? "Untitled session" : t
    }

    /// "2 turns finish" — the count is every turn in flight on the runner, the reader's or not.
    private static func turnsFinish(_ count: Int) -> String {
        count == 1 ? "1 turn finishes" : "\(count) turns finish"
    }

    private static func turnCount(_ s: Session) -> Int {
        s.queuedActive ?? s.queuedRunnerUpdate?.turns.count ?? 0
    }

    private static func who(_ machine: String?) -> String {
        let m = machine?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return m.isEmpty ? "The runner" : m
    }

    /// The turns, named, joined as a sentence lists them: "A", "A and B", "A, B and C", with
    /// "N more" for the turns that are not the reader's to name.
    private static func namedTurns(_ s: Session) -> [Part] {
        let named = s.queuedRunnerUpdate?.turns ?? []
        let count = s.queuedActive ?? named.count
        var items: [Part] = named.map { .turn(id: $0.id, title: turnTitle($0.title)) }
        if count > named.count { items.append(.text("\(count - named.count) more")) }
        var parts: [Part] = []
        for (i, item) in items.enumerated() {
            if i > 0 { parts.append(.text(i == items.count - 1 ? " and " : ", ")) }
            parts.append(item)
        }
        return parts
    }

    /// The queued page's explanation: `studio-mac is updating to 0.1.254. It starts no new work until
    /// 2 turns finish: A and B. This session starts right after.` Web `runnerUpdatingDescription`.
    public static func description(_ s: Session, machine: String?) -> [Part] {
        let name = who(machine)
        var parts: [Part] = [.text(s.queuedRunnerUpdate?.targetVersion.map { "\(name) is updating to \($0). " }
                                   ?? "\(name) is updating. ")]
        let count = turnCount(s)
        if count > 0 {
            parts.append(.text("It starts no new work until \(turnsFinish(count)): "))
            parts.append(contentsOf: namedTurns(s))
            parts.append(.text(". "))
        }
        parts.append(.text("This session starts right after."))
        return parts
    }

    /// The parts as one plain line. Web `runnerUpdatingPlain`.
    public static func plain(_ parts: [Part]) -> String {
        parts.map { part -> String in
            switch part {
            case .text(let t): return t
            case .turn(_, let title): return title
            }
        }.joined()
    }

    /// What the foot-row tag opens: `studio-mac starts no new turns until 2 turns finish, then updates
    /// to 0.1.254. This message is sent right after.` Web `runnerUpdatingMessageText`.
    public static func messageText(_ s: Session, machine: String?) -> String {
        let name = who(machine)
        let update = s.queuedRunnerUpdate?.targetVersion.map { "updates to \($0)" } ?? "updates"
        let count = turnCount(s)
        let first = count > 0
            ? "\(name) starts no new turns until \(turnsFinish(count)), then \(update)."
            : "\(name) \(update) now."
        return "\(first) This message is sent right after."
    }

    /// The message whose foot row carries `Queued · runner updating`: the reader's last one in the
    /// transcript (web `queuedFoot`). Nil where the transcript has none, and then the queued page says
    /// it instead — the two are never drawn together.
    public static func footBubbleID(_ items: [TranscriptItem]) -> String? {
        for item in items.reversed() {
            if case .user(let bubble) = item { return bubble.id }
        }
        return nil
    }

    /// `Waiting 38 min`, from the gate's clock; nil when the server sent none it can be read from.
    /// Web `runnerUpdatingWaited`.
    public static func waited(_ s: Session, now: Date) -> String? {
        guard let since = s.queuedRunnerUpdate?.since, let at = RelativeTime.parse(since), at <= now
        else { return nil }
        let minutes = Int(now.timeIntervalSince(at) / 60)
        if minutes < 1 { return "Waiting less than a minute" }
        if minutes < 60 { return "Waiting \(minutes) min" }
        let rest = minutes % 60
        return "Waiting \(minutes / 60) h" + (rest > 0 ? " \(rest) min" : "")
    }
}
