import Foundation

// An exception item's DELIVERY to the coordinator, as the control plane recorded it beside the
// turn's echo (`openItemDelivery`, apiserver `runner-api/control-plane-note.ts`).
//
// The delivery itself is a paragraph of prose written for the AGENT: it names the tools to call and
// the ids to call them with, and it says out loud that the platform will not retry. Until the
// payload existed that paragraph was all the record held — the fields the item was opened with (its
// kind, its title, the files a merge conflicted on, the doors that exist) were rendered into the
// words and dropped — so a client had nothing to draw it from but the words, and drew the whole
// delivery as a message the reader had typed.
//
// The web reads the same payload with `parseOpenItemDelivery` (src/web/src/lib/openItemDelivery.ts)
// and draws it as `OpenItemDeliveryCard.tsx`. This is that rule for iOS and macOS, which share
// OrbitKit: the same fields, the same defaults, the same three keys that make a payload a card at
// all — and a payload that is not a card parses as NOTHING rather than as half a card, which is
// what leaves a delivery with no payload (every event stored before this existed) drawn exactly as
// it was before. Neither end compiles the other, so `OpenItemDeliveryCopyParityTests` is what holds
// the two to each other.
//
// Nothing here is derived from the prose. Nothing on this client identifies a delivery by the shape
// of its text — the web walked that road and came back (lib/deliveredMessage.ts), and a reader that
// half-recognised a paragraph would draw half a card.

/// Where the work an item is about has landed, as merge receipts answer it — the three-valued fold
/// of §2.7.
public enum OpenItemDeliveryLanding: String, Sendable, Equatable, Codable, CaseIterable {
    case onUpstream = "ON_UPSTREAM"
    case onIntegrationLine = "ON_INTEGRATION_LINE"
    /// No receipt is no EVIDENCE, never a denial: work lands by paths that leave no row behind.
    case notKnown = "NOT_KNOWN"
}

/// The task an item is about, and the attempt that opened it. Absent for a promotion's item, which
/// is about no task at all.
public struct OpenItemDeliveryTask: Sendable, Equatable, Codable {
    public let id: String
    public let title: String
    public let sessionId: String?

    public init(id: String, title: String, sessionId: String? = nil) {
        self.id = id
        self.title = title
        self.sessionId = sessionId
    }
}

/// The check that disagreed on the combined tree (`INTEGRATION_CHECK_FAILED`).
public struct OpenItemDeliveryCheck: Sendable, Equatable, Codable {
    public let name: String
    public let exitCode: Int?
    public let expectedExitCode: Int?

    public init(name: String, exitCode: Int? = nil, expectedExitCode: Int? = nil) {
        self.name = name
        self.exitCode = exitCode
        self.expectedExitCode = expectedExitCode
    }
}

/// Why an attempt failed, and where its chain stands (`TASK_FAILED`).
public struct OpenItemDeliveryFailure: Sendable, Equatable, Codable {
    public let how: String?
    public let exitCode: Int?
    public let expectedExitCode: Int?
    public let attempt: Int
    public let limit: Int

    public init(how: String? = nil, exitCode: Int? = nil, expectedExitCode: Int? = nil,
                attempt: Int, limit: Int) {
        self.how = how
        self.exitCode = exitCode
        self.expectedExitCode = expectedExitCode
        self.attempt = attempt
        self.limit = limit
    }
}

/// What the platform knew about the landing when it handed the item over.
public struct OpenItemDeliveryLandingFacts: Sendable, Equatable, Codable {
    /// Merge receipts the task has, of any result. Zero is "no evidence", never "not landed".
    public let receipts: Int
    public let state: OpenItemDeliveryLanding
    /// The branch "on main" means for this project, and the line its tasks land on (§1.4).
    public let upstream: String
    public let integration: String

    public init(receipts: Int, state: OpenItemDeliveryLanding, upstream: String, integration: String) {
        self.receipts = receipts
        self.state = state
        self.upstream = upstream
        self.integration = integration
    }
}

/// One exception item's delivery, as the control plane recorded it — a SNAPSHOT of what the platform
/// knew when it handed the item over, and every field either a column of the item's row or `landing`,
/// read once from the merge receipts of the task it is about.
///
/// Mirrors `@orbit/shared`'s `OpenItemDeliveryCard`, the one declaration both clients read (§7.0).
public struct OpenItemDelivery: Sendable, Equatable, Codable {
    /// The item, in the uuid spelling every other read of one uses.
    public let itemId: String
    public let kind: ProjectOpenItemKind
    public let title: String
    public let task: OpenItemDeliveryTask?
    /// The files a conflicting merge reported. Empty for every other kind.
    public let files: [String]
    /// The branch an integration was moving work into, when the item recorded one.
    public let targetRef: String?
    public let check: OpenItemDeliveryCheck?
    /// The code an integration job ended with (`INTEGRATION_ERROR`).
    public let errorCode: String?
    public let failure: OpenItemDeliveryFailure?
    /// The doors that exist for this item, as the server decides them (§4.8) — the raw
    /// `OpenItemAction` values, read the way the web reads them: a value this build does not know is
    /// kept and simply has no label to draw (`OpenItemDeliveryCard.actionLabels`).
    public let actions: [String]
    public let landing: OpenItemDeliveryLandingFacts?

    public init(itemId: String, kind: ProjectOpenItemKind, title: String,
                task: OpenItemDeliveryTask? = nil, files: [String] = [], targetRef: String? = nil,
                check: OpenItemDeliveryCheck? = nil, errorCode: String? = nil,
                failure: OpenItemDeliveryFailure? = nil, actions: [String] = [],
                landing: OpenItemDeliveryLandingFacts? = nil) {
        self.itemId = itemId
        self.kind = kind
        self.title = title
        self.task = task
        self.files = files
        self.targetRef = targetRef
        self.check = check
        self.errorCode = errorCode
        self.failure = failure
        self.actions = actions
        self.landing = landing
    }

    /// The card a `user` event's payload carries, or nil for the ordinary case: a turn that is
    /// nobody's delivery (and every delivery stored before the payload existed) keeps its old
    /// reading, drawn as the message it has always been.
    ///
    /// A card names the item it is about, what kind it is and what it is called: those three are what
    /// makes it one, and a payload missing any of them is not drawn at all — never half a card. Every
    /// other field is optional and defaults, exactly as the web's reader defaults it.
    public static func parse(_ payload: JSONValue) -> OpenItemDelivery? {
        guard case .object(let card)? = payload["openItemDelivery"],
              let itemId = nonEmptyString(card["itemId"]),
              let kind = card["kind"]?.stringValue,
              let title = nonEmptyString(card["title"]) else { return nil }
        return OpenItemDelivery(
            itemId: itemId,
            // A kind this build does not know is drawn under the card's generic header rather than
            // failing the read that carried it — the same way the web's label table degrades.
            kind: ProjectOpenItemKind(rawValue: kind) ?? .unknown,
            title: title,
            task: task(card["task"]),
            files: strings(card["files"]),
            targetRef: nonEmptyString(card["targetRef"]),
            check: check(card["check"]),
            errorCode: nonEmptyString(card["errorCode"]),
            failure: failure(card["failure"]),
            actions: strings(card["actions"]),
            landing: landing(card["landing"]))
    }

    private static func nonEmptyString(_ value: JSONValue?) -> String? {
        guard let text = value?.stringValue, !text.isEmpty else { return nil }
        return text
    }

    private static func strings(_ value: JSONValue?) -> [String] {
        guard case .array(let elements)? = value else { return [] }
        return elements.compactMap { $0.stringValue }
    }

    private static func task(_ value: JSONValue?) -> OpenItemDeliveryTask? {
        guard case .object(let fields)? = value,
              let id = nonEmptyString(fields["id"]),
              // The title is required to BE a string; an empty one is a title the item did not have.
              let title = fields["title"]?.stringValue else { return nil }
        return OpenItemDeliveryTask(id: id, title: title,
                                    sessionId: nonEmptyString(fields["sessionId"]))
    }

    private static func check(_ value: JSONValue?) -> OpenItemDeliveryCheck? {
        guard case .object(let fields)? = value, let name = nonEmptyString(fields["name"]) else {
            return nil
        }
        return OpenItemDeliveryCheck(name: name, exitCode: fields["exitCode"]?.intValue,
                                     expectedExitCode: fields["expectedExitCode"]?.intValue)
    }

    private static func failure(_ value: JSONValue?) -> OpenItemDeliveryFailure? {
        guard case .object(let fields)? = value,
              let attempt = fields["attempt"]?.intValue,
              let limit = fields["limit"]?.intValue else { return nil }
        return OpenItemDeliveryFailure(how: nonEmptyString(fields["how"]),
                                       exitCode: fields["exitCode"]?.intValue,
                                       expectedExitCode: fields["expectedExitCode"]?.intValue,
                                       attempt: attempt, limit: limit)
    }

    private static func landing(_ value: JSONValue?) -> OpenItemDeliveryLandingFacts? {
        guard case .object(let fields)? = value,
              let receipts = fields["receipts"]?.intValue,
              let raw = fields["state"]?.stringValue,
              let state = OpenItemDeliveryLanding(rawValue: raw) else { return nil }
        // A branch the payload left out means "main", which is what the fold means by an upstream
        // nobody named — the web's reader defaults them the same way.
        return OpenItemDeliveryLandingFacts(
            receipts: receipts, state: state,
            upstream: fields["upstream"]?.stringValue ?? "main",
            integration: fields["integration"]?.stringValue ?? "main")
    }
}

/// What the card says, in the web's own words: `OpenItemDeliveryCard.tsx`, which
/// `OpenItemDeliveryCopyParityTests` holds the other end to. Nothing here is derived from the prose.
public enum OpenItemDeliveryCard {
    /// How many conflicting files the card lists before folding the rest away.
    public static let filesShown = 3

    /// The header every delivery is drawn under — what the turn is, before what it is about.
    public static let header = "Exception item"

    /// What opened the item, named the way the rest of the product names it.
    public static func kindLabel(_ kind: ProjectOpenItemKind) -> String {
        switch kind {
        case .integrationConflict:    return "Merge conflict"
        case .integrationCheckFailed: return "Checks failed"
        case .integrationError:       return "Integration error"
        case .taskFailed:             return "Task failed"
        case .promotionApproval:      return "Merge approval"
        case .coordinatorQuestion:    return "Question"
        case .fusePaused:             return "Project paused"
        case .unknown:                return header
        }
    }

    /// Why an attempt failed, in the words a reader acts on.
    public static func how(_ how: String?) -> String {
        switch how {
        case "ACCEPTANCE_EXIT_MISMATCH":
            return "The acceptance command disagreed with what the task declared"
        case "RUN_FAILED":
            return "A turn of the run failed"
        case "RUNNER_FINALIZED_FAILED":
            return "The runner finished the run as failed"
        case "REAPED_API_ERROR":
            return "The run stopped on an API or sign-in error and was reaped"
        case "ATTEMPT_LOST_RUNNER_OFFLINE":
            return "Its runner went offline and the attempt was taken back"
        case "ATTEMPT_LOST_RUNTIME_NOT_INITIALIZED":
            return "Its runtime never started and the attempt was taken back"
        case "REPORTED_FAILED":
            return "Somebody filed it as failed"
        default:
            return "The task failed"
        }
    }

    /// The one line that says what happened, out of the kind's own fields. Nil for a kind whose
    /// fields say nothing more than the title already did.
    public static func headline(_ card: OpenItemDelivery) -> String? {
        let target = card.targetRef.map { " into \($0)" } ?? ""
        if card.kind == .taskFailed, let failure = card.failure {
            let exit = failure.exitCode.map { " — exit \($0), expected \(failure.expectedExitCode ?? 0)" } ?? ""
            return "\(how(failure.how))\(exit) · attempt \(failure.attempt) of "
                + "\(failure.limit) in this chain."
        }
        if card.kind == .integrationConflict {
            return "git refused the merge\(target); the target branch did not move. "
                + "The platform will not retry it by itself."
        }
        if card.kind == .integrationCheckFailed, let check = card.check {
            return "Check \(check.name) exited \(check.exitCode.map(String.init) ?? "?") where "
                + "\(check.expectedExitCode.map(String.init) ?? "?") was declared; the target branch "
                + "did not move."
        }
        if card.kind == .integrationError {
            return "The integration job ended with \(card.errorCode ?? "an error")\(target); the "
                + "target branch did not move."
        }
        return nil
    }

    /// What the platform already knew about the work when it handed the item over — the fact that
    /// used to cost the coordinator a re-check of the merge receipts every time an item came round.
    ///
    /// `NOT_KNOWN` is said as what it is: no receipt is no EVIDENCE, never "it did not land", because
    /// work lands by paths that leave no row behind and a card that denied one would send a reader
    /// looking for a merge that already happened.
    public static func landingLine(_ card: OpenItemDelivery) -> (text: String, landed: Bool)? {
        guard let landing = card.landing else { return nil }
        switch landing.state {
        case .onUpstream:
            return ("Already on \(landing.upstream) — a merge receipt records this work there.", true)
        case .onIntegrationLine:
            return ("On \(landing.integration), not yet on \(landing.upstream) — a merge receipt "
                + "records it on the project branch.", true)
        case .notKnown:
            let receipts = landing.receipts
            let text = receipts == 0
                ? "No merge receipt for this work — Orbit cannot tell whether it has landed."
                : "\(receipts) merge receipt\(receipts == 1 ? "" : "s"), none naming "
                    + "\(landing.upstream) — Orbit cannot tell whether this work has landed."
            return (text, false)
        }
    }

    /// What each door is called on the card. `OPEN_COORDINATOR` and `OPEN_TASK_SESSION` are absent on
    /// purpose: the first is the conversation this card is drawn in — the reader is already there —
    /// and the second is drawn below as the session link.
    public static func actionLabels(_ actions: [String]) -> [String] {
        actions.compactMap { action in
            switch action {
            case "RETRY":                 return "Retry the task"
            case "CANCEL_TASK":           return "Cancel the task"
            case "ASK_COORDINATOR_AGAIN": return "Ask the coordinator again"
            case "REVIEW":                return "Review the merge"
            case "ANSWER":                return "Answer the question"
            case "RESUME":                return "Resume the project"
            default:                      return nil
            }
        }
    }

    /// The row's name on the card's head. A kind the payload did not put a state under still has a
    /// title, so the header alone names the turn.
    public static let doorsLead = "The coordinator can:"
    public static let openTask = "Open the task ↗"
    public static let openSession = "Open the failed session ↗"
    /// The foot line: what this is, and that it asks nothing of the reader yet.
    public static let notification = "a notification, not an interruption"
    public static let undelivered = "The session has not confirmed it received this."
    /// The fold the paragraph the agent read stays behind.
    public static let rawSummary = "What the coordinator was told"

    /// "Show 2 more files" / "Show fewer files". Nil when every file the item named is already on
    /// screen, which is also what keeps the button off a card that conflicted on none.
    public static func filesToggle(total: Int, expanded: Bool) -> String? {
        guard total > filesShown else { return nil }
        return expanded ? "Show fewer files" : "Show \(total - filesShown) more files"
    }

    /// "Item 34ShSQc0zVFxWSokxZive · a notification, not an interruption · 3m ago".
    ///
    /// The id is drawn in the public spelling the web draws it in, and is kept as it arrived when it
    /// is in neither spelling — this line is the card's footnote, not a link.
    public static func meta(_ card: OpenItemDelivery, ts: String? = nil, now: Date = Date()) -> String {
        var line = "Item \(PublicID.toPublic(card.itemId)) · \(notification)"
        if let ts, let relative = RelativeTime.format(ts, now: now) { line += " · \(relative)" }
        return line
    }

    /// What the bar pinned to the top of a console says about this turn: the card's own two words,
    /// so the bar can never name the turn something the card under it does not (see `StickySummary`).
    /// Web parity: the `data-sticky-label` / `data-sticky-text` the card's root carries.
    public static func sticky(_ card: OpenItemDelivery) -> (label: String, text: String) {
        (header, "\(kindLabel(card.kind)): \(card.title)")
    }

    /// The task this item is about, as the app's own `orbit-task:` door — nil when the item is about
    /// no task (a promotion's), or when the id cannot name one.
    public static func taskLink(_ card: OpenItemDelivery) -> URL? {
        link(card.task?.id, scheme: "orbit-task")
    }

    /// The session that opened the item, for the reader who wants the run itself.
    public static func sessionLink(_ card: OpenItemDelivery) -> URL? {
        link(card.task?.sessionId, scheme: "orbit-session")
    }

    private static func link(_ id: String?, scheme: String) -> URL? {
        guard let id, PublicID.toUUID(id) != nil else { return nil }
        return URL(string: "\(scheme):\(id)")
    }
}
