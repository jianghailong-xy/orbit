import Foundation

// A turn Orbit wrote to tell a session about a committed fact, as the control plane recorded it beside
// the turn's echo (`coordinatorDelivery`, apiserver `projects/coordinator-delivery-card.ts`): a fact a
// project's coordinator is told (every notification `buildCoordinatorDeliveryMessage` writes), or the
// answer to a session's criteria proposal (`criteria-decision-reply.ts`).
//
// The turn's words are written for the AGENT — `From Orbit · project “…” has a revision of completion
// evidence for you to decide`, then paragraphs of protocol — and they stay exactly that. Until the card
// existed they were all the record held, so this client drew the turn as the owner's own bubble: a
// screen of words the owner never wrote, and, undelivered, an offer to put them back in the composer.
//
// The web reads the same payload with `parseCoordinatorDelivery` (src/web/src/lib/coordinatorDelivery.ts)
// and draws it as `CoordinatorDeliveryLine.tsx`. This is that rule for iOS and macOS: a card is one of
// the closed kinds, a moment that reads as one, and exactly the fields its sentence names; a payload that
// is not one parses as NOTHING rather than as half of one, which leaves every turn stored before this
// existed drawn exactly as it was. Neither end compiles the other, so `CoordinatorDeliveryCopyParityTests`
// is what holds the two to each other. Nothing is read out of the words.

/// One fact told to a session, as the control plane recorded it beside the turn.
///
/// Mirrors `@orbit/shared`'s `CoordinatorDeliveryCard`, field for field and in its order.
public struct CoordinatorDelivery: Sendable, Equatable, Codable {
    /// What the line says: one value per sentence it can read (`COORDINATOR_DELIVERY_KINDS`, in order).
    public enum Kind: String, Sendable, Equatable, Codable, CaseIterable {
        case evidenceSubmitted = "EVIDENCE_SUBMITTED"
        case evidenceMovedIn = "EVIDENCE_MOVED_IN"
        case dependentReady = "DEPENDENT_READY"
        case taskDispatchRefused = "TASK_DISPATCH_REFUSED"
        case projectBlockerRaised = "PROJECT_BLOCKER_RAISED"
        case taskRunStopped = "TASK_RUN_STOPPED"
        case criterionUnlanded = "CRITERION_UNLANDED"
        case acceptanceLanded = "ACCEPTANCE_LANDED"
        case acceptanceLandedHeld = "ACCEPTANCE_LANDED_HELD"
        case acceptanceLandedDone = "ACCEPTANCE_LANDED_DONE"
        case looksFinished = "LOOKS_FINISHED"
        case settledUnmerged = "SETTLED_UNMERGED"
        case criteriaApproved = "CRITERIA_APPROVED"
        case criteriaRejected = "CRITERIA_REJECTED"
    }

    /// The task a fact names, by the title the coordinator was told.
    public struct TaskRef: Sendable, Equatable, Codable {
        public let id: String
        public let title: String

        public init(id: String, title: String) {
            self.id = id
            self.title = title
        }
    }

    public let kind: Kind
    /// The task the fact is about, for the five facts that name one (evidence, a task that can start,
    /// a refused start, a blocker, a stopped run). Nil for the rest.
    public let task: TaskRef?
    /// The evidence revision the sentence names. Nil for every kind but the two evidence ones.
    public let revision: Int?
    /// What the sentence counts: tasks, criteria or commits. Nil for every kind that counts nothing.
    public let count: Int?
    /// When this conversation was handed it (ISO-8601): the delivery's bind, or the reply turn's own.
    public let deliveredAt: String
    /// Whether this conversation is the project's coordinator, by the project's own pointer: true for every
    /// fact a coordinator is told, false for the owner's answer to a criteria proposal a task's run — any
    /// conversation but the coordinator — filed. The line then says it was sent to this session.
    public let toCoordinator: Bool

    public init(kind: Kind, task: TaskRef? = nil, revision: Int? = nil, count: Int? = nil, deliveredAt: String,
                toCoordinator: Bool = true) {
        self.kind = kind
        self.task = task
        self.revision = revision
        self.count = count
        self.deliveredAt = deliveredAt
        self.toCoordinator = toCoordinator
    }

    private enum CodingKeys: String, CodingKey {
        case kind, task, revision, count, deliveredAt, toCoordinator
    }

    /// A transcript cached before `toCoordinator` existed holds no such key: its card was drawn as the
    /// coordinator's, and reads back as it was rather than as no card at all.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decode(Kind.self, forKey: .kind)
        task = try c.decodeIfPresent(TaskRef.self, forKey: .task)
        revision = try c.decodeIfPresent(Int.self, forKey: .revision)
        count = try c.decodeIfPresent(Int.self, forKey: .count)
        deliveredAt = try c.decode(String.self, forKey: .deliveredAt)
        toCoordinator = try c.decodeIfPresent(Bool.self, forKey: .toCoordinator) ?? true
    }

    /// The card a `user` event's payload carries, or nil for the ordinary case: a turn that is no such
    /// fact (and every delivery stored before the payload existed) keeps its old reading.
    public static func parse(_ payload: JSONValue) -> CoordinatorDelivery? {
        parseCard(payload["coordinatorDelivery"])
    }

    /// The same reading for the card itself rather than a payload that carries it: the queued-turn
    /// projection (`QueuedTurnInfo.coordinatorDelivery`) hands over the object the echo would have put
    /// under that key, and one function reads both, so the line drawn while the turn waits is the line
    /// its echo is drawn as.
    ///
    /// The web's rule, step for step: a kind it knows, a moment that reads as one, and each field the
    /// kind's sentence names (`CoordinatorDeliveryCard.sentence(for:)`) present and valid — a task with
    /// an id and a title that is not blank, a revision or count that is a positive whole number. A field
    /// the sentence does not name is left out, whatever the payload held. Only the server's own `false`
    /// says this conversation is not the coordinator: a card stored before `toCoordinator` existed was
    /// drawn as the coordinator's, and reads as it was.
    public static func parseCard(_ value: JSONValue?) -> CoordinatorDelivery? {
        guard case .object(let card)? = value,
              let kind = card["kind"]?.stringValue.flatMap(Kind.init(rawValue:)),
              let deliveredAt = card["deliveredAt"]?.stringValue,
              ThinkingSummary.date(deliveredAt) != nil else { return nil }
        let sentence = CoordinatorDeliveryCard.sentence(for: kind)
        var task: TaskRef?
        if case .object(let named)? = card["task"],
           let id = named["id"]?.stringValue, !id.isEmpty,
           let title = named["title"]?.stringValue,
           !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            task = TaskRef(id: id, title: title)
        }
        let revision = positive(card["revision"])
        let count = positive(card["count"])
        // Each field the sentence names is required, and one it does not name is left out.
        if sentence.contains("{task}") && task == nil { return nil }
        if sentence.contains("{revision}") && revision == nil { return nil }
        if sentence.contains("{count}") && count == nil { return nil }
        return CoordinatorDelivery(
            kind: kind,
            task: sentence.contains("{task}") ? task : nil,
            revision: sentence.contains("{revision}") ? revision : nil,
            count: sentence.contains("{count}") ? count : nil,
            deliveredAt: deliveredAt,
            toCoordinator: card["toCoordinator"] != .bool(false))
    }

    /// A positive whole number no larger than the browser can hold exactly (`Number.isSafeInteger`):
    /// what the web's `positive` accepts, and nothing else — not a string of digits, not a fraction.
    private static func positive(_ value: JSONValue?) -> Int? {
        let largest = 9_007_199_254_740_991
        switch value {
        case .int(let n)?:
            return n > 0 && n <= largest ? n : nil
        case .double(let d)?:
            return d > 0 && d.rounded() == d && d <= Double(largest) ? Int(d) : nil
        default:
            return nil
        }
    }
}

/// What the line says, in the web's own words (`lib/coordinatorDelivery.ts`, `CoordinatorDeliveryLine.tsx`),
/// which `CoordinatorDeliveryCopyParityTests` holds this end to entry by entry.
public enum CoordinatorDeliveryCard {
    /// The link at the foot of the opened line, to the task the fact names (web `COORDINATOR_DELIVERY_ITS_TASK`).
    public static let itsTask = "Its task ↗"
    /// The heading over the words the session was handed, once the line is opened: the owner's answer's.
    public static let told = OwnerAnswerCard.told
    /// Where the line says it was sent when this conversation is not the project's coordinator — the
    /// owner's answer to a criteria proposal a task's run filed (web `COORDINATOR_DELIVERY_SENT_TO_SESSION`).
    public static let sentToThisSession = "Sent to this session"
    /// And the heading its words open under (web `COORDINATOR_DELIVERY_SESSION_TOLD`).
    public static let toldThisSession = "What this session was told"
    /// What the line says when the session has not confirmed it received the turn.
    public static let undelivered = OwnerAnswerCard.undelivered

    /// How a count is said: `one` when there is one, `many` — with `{n}` — otherwise.
    public struct CountWords: Sendable, Equatable {
        public let one: String
        public let many: String
    }

    private static let tasks = CountWords(one: "1 task", many: "{n} tasks")
    private static let criteria = CountWords(one: "The only criterion", many: "All {n} criteria")
    private static let commits = CountWords(one: "1 commit", many: "{n} commits")

    /// What each line says, by kind (web `COORDINATOR_DELIVERY_SENTENCES`): `{task}` is the title of the
    /// task the fact names, `{revision}` the evidence revision, and `{count}` what the fact counts, said
    /// as `countWords(for:)` says it. A kind needs exactly the fields its sentence names.
    public static func sentence(for kind: CoordinatorDelivery.Kind) -> String {
        switch kind {
        case .evidenceSubmitted: return "Evidence revision {revision} submitted: {task}"
        case .evidenceMovedIn: return "Evidence revision {revision} moved in: {task}"
        case .dependentReady: return "Can start now: {task}"
        case .taskDispatchRefused: return "Could not start: {task}"
        case .projectBlockerRaised: return "Blocker raised: {task}"
        case .taskRunStopped: return "Run stopped: {task}"
        case .criterionUnlanded: return "Work not on main yet: {count}"
        case .acceptanceLanded: return "{count} landed"
        case .acceptanceLandedHeld: return "{count} landed, Done held back"
        case .acceptanceLandedDone: return "{count} landed, recorded Done"
        case .looksFinished: return "Looks finished, not recorded Done"
        case .settledUnmerged: return "Settled with work not on main: {count}"
        case .criteriaApproved: return "Criteria proposal approved"
        case .criteriaRejected: return "Criteria proposal rejected"
        }
    }

    /// How `{count}` is said for each kind that counts something (web `COORDINATOR_DELIVERY_COUNTS`).
    public static func countWords(for kind: CoordinatorDelivery.Kind) -> CountWords? {
        switch kind {
        case .criterionUnlanded: return tasks
        case .acceptanceLanded, .acceptanceLandedHeld, .acceptanceLandedDone: return criteria
        case .settledUnmerged: return commits
        default: return nil
        }
    }

    /// The sentence the line says, before `Sent to the coordinator · 07:30 PM` — rendered as the web
    /// renders it: the revision, then the count, then the title, each replacing its first placeholder,
    /// so a title is the owner's words and never a pattern.
    public static func sentence(_ card: CoordinatorDelivery) -> String {
        var count = ""
        if let words = countWords(for: card.kind), let n = card.count {
            count = replacingFirst("{n}", in: n == 1 ? words.one : words.many, with: String(n))
        }
        var line = sentence(for: card.kind)
        line = replacingFirst("{revision}", in: line, with: card.revision.map(String.init) ?? "")
        line = replacingFirst("{count}", in: line, with: count)
        line = replacingFirst("{task}", in: line, with: card.task?.title ?? "")
        return line
    }

    /// "Sent to the coordinator · 07:30 PM": what a version handed to its coordinator says, in the same
    /// words and on the same clock (`EvidenceDecisions.sentLine`) — or "Sent to this session · 07:30 PM"
    /// where this conversation is not the project's coordinator. Never truncated on the line.
    public static func sent(_ card: CoordinatorDelivery, now: Date = Date()) -> String {
        card.toCoordinator
            ? EvidenceDecisions.sentLine(card.deliveredAt, now: now)
            : "\(sentToThisSession) · \(EvidenceDecisions.receiptTime(card.deliveredAt, now: now))"
    }

    /// The heading over the words, once the line is opened: what the coordinator was told, or — where this
    /// conversation is not the project's coordinator — what this session was told.
    public static func heading(_ card: CoordinatorDelivery) -> String {
        card.toCoordinator ? told : toldThisSession
    }

    /// What pressing the line does, as the accessibility hint says it: "Opens what the coordinator was told",
    /// or "Opens what this session was told" — the heading it opens to, in a sentence.
    public static func openHint(_ card: CoordinatorDelivery) -> String {
        card.toCoordinator ? "Opens what the coordinator was told" : "Opens what this session was told"
    }

    /// The whole line as one sentence, where it is read rather than laid out: the sheet's head, the
    /// accessibility label.
    public static func line(_ card: CoordinatorDelivery, now: Date = Date()) -> String {
        "\(sentence(card)) · \(sent(card, now: now))"
    }

    /// The task the fact names, as the app's own `orbit-task:` door — nil when it names none, or when
    /// the id cannot name one.
    public static func taskLink(_ card: CoordinatorDelivery) -> URL? {
        guard let id = card.task?.id, PublicID.toUUID(id) != nil else { return nil }
        return URL(string: "orbit-task:\(id)")
    }

    private static func replacingFirst(_ placeholder: String, in text: String, with value: String) -> String {
        guard let range = text.range(of: placeholder) else { return text }
        return text.replacingCharacters(in: range, with: value)
    }
}
