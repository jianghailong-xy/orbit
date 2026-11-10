import Foundation

/// Owner requests: what a session asked the account owner to do, as a card in the conversation that
/// asked, in the "Waiting on you" inbox, and behind a push's actions. Every word and rule the views
/// draw is here, pure and tested; the web says the same things (`lib/ownerRequests.ts`,
/// `components/OwnerRequestCard.tsx`, `pages/WaitingOnYouPage.tsx`).
public enum OwnerRequests {
    public static let waitingOnYou = "Waiting on you"

    // MARK: per kind

    /// The tag beside the title.
    public static func kindTag(_ kind: OwnerRequestKind) -> String {
        switch kind {
        case .decision:   return "DECISION"
        case .secret:     return "SECRET"
        case .manualStep: return "STEPS"
        case .confirm:    return "CONFIRM"
        }
    }

    /// The card's primary button.
    public static func primaryLabel(_ kind: OwnerRequestKind) -> String {
        switch kind {
        case .decision:   return "Send answer"
        case .secret:     return "Provide key"
        case .manualStep: return "Mark done"
        case .confirm:    return "Confirm"
        }
    }

    /// The way out of doing it, which always asks why.
    public static func declineLabel(_ kind: OwnerRequestKind) -> String {
        kind == .manualStep ? "Can’t do this…" : "Decline…"
    }

    /// The button on an inbox row, which opens the card under it.
    public static func inboxAction(_ kind: OwnerRequestKind) -> String {
        switch kind {
        case .decision:   return "Answer"
        case .secret:     return "Provide"
        case .manualStep: return "Open steps"
        case .confirm:    return "Review"
        }
    }

    /// An inbox row's SF Symbol.
    public static func symbol(_ kind: OwnerRequestKind) -> String {
        switch kind {
        case .decision:   return "questionmark"
        case .secret:     return "key.fill"
        case .manualStep: return "list.number"
        case .confirm:    return "checkmark.shield"
        }
    }

    // MARK: the pending card

    /// A pending request whose deadline has passed. The door refuses it; the sweep writes EXPIRED.
    public static func pastDeadline(_ request: OwnerRequest, now: Date = Date()) -> Bool {
        guard let at = request.expiresAt.flatMap(RelativeTime.parse) else { return false }
        return at <= now
    }

    /// "expires in 3d", "expired", or nil when there is no deadline.
    public static func expiryText(_ request: OwnerRequest, now: Date = Date()) -> String? {
        guard let at = request.expiresAt.flatMap(RelativeTime.parse) else { return nil }
        let left = at.timeIntervalSince(now)
        return left <= 0 ? "expired" : "expires in \(RelativeTime.span(left))"
    }

    /// The header's right half: "Asked 2m ago · expires in 3d".
    public static func askedLine(_ request: OwnerRequest, now: Date = Date()) -> String {
        let asked = "Asked \(RelativeTime.ago(request.createdAt, now: now) ?? "just now")"
        return expiryText(request, now: now).map { "\(asked) · \($0)" } ?? asked
    }

    /// "When the task ends, or after 7 days" — what ends a delivered key (design §6.1).
    public static func removedText(_ request: OwnerRequest) -> String {
        request.secretScope == "SESSION" ? "When the session ends, or after 7 days"
            : "When the task ends, or after 7 days"
    }

    /// "Runner HPC as DEEPSEEK_API_KEY", or "… at ~/.config/key" for a file.
    public static func destination(_ spec: OwnerRequestSecretSpec, runner: String) -> String {
        "Runner \(runner) \(spec.filePath != nil ? "at" : "as") \(spec.filePath ?? spec.envVar ?? spec.name)"
    }

    /// The line under the key's field, in the secrets design's wording (§7.3), not the mockup's.
    public static func secretNotice(_ spec: OwnerRequestSecretSpec, runner: String) -> String {
        let where_ = spec.filePath != nil
            ? "Goes straight to \(runner) as a file. Orbit keeps it out of this conversation, but any program running as the runner’s user on \(runner) can read the file until it is removed."
            : "Goes straight to \(runner). Orbit keeps it out of this conversation and away from the agent; only commands the agent runs with it can use it."
        return "\(where_) Use a key you can revoke."
    }

    public static let keyPlaceholder = "Paste the key"
    public static let saveToAccount = "Save to my account secrets for later runs"
    public static let saveAsPlaceholder = "Name to save it under"
    public static let enterKeyInstead = "Enter a key instead"
    public static let declinePrompt = "Why? The session that asked reads this."
    public static let declineButton = "Decline"
    public static let keepIt = "Keep it"
    public static let remindLater = "Remind me later"
    public static let ifNobodyAnswers = "If nobody answers:"
    public static let notRecorded = "That was not recorded"
    public static let holdingUp = "Holding up"
    public static let deliveredTo = "Delivered to"
    public static let removed = "Removed"
    public static let revoke = "Revoke"
    public static let cancel = "Cancel"
    public static let showNow = "Show now"
    public static let yourAnswer = "Your answer"
    public static let addNote = "Add a note (optional)"
    public static let ownAnswer = "Or type your own answer…"

    public static func usingSaved(_ label: String) -> String { "Using saved “\(label)”" }
    public static func useSaved(_ label: String) -> String { "Use saved “\(label)”" }
    public static func verifyHint(_ hint: String) -> String { "How to check: \(hint)" }
    public static func onItsWay(_ runner: String) -> String { "Key is on its way to \(runner)." }
    public static func runnerOffline(_ runner: String) -> String {
        "\(runner) is offline. Orbit will deliver this when it comes back."
    }
    public static func reenterAfterRemoval(_ runner: String) -> String {
        "You can enter a key again once \(runner) confirms the earlier one is gone."
    }
    public static func deliveryFailed(_ runner: String) -> String { "The key did not reach \(runner)" }

    /// The secret the owner is typing: held by the card's own state only, never stored, never in a
    /// URL, and emptied the moment it is handed to the request (design §7.2).
    public struct SecretDraft: Equatable, Sendable {
        public var value: String = ""
        public var save: Bool = false
        public var saveAs: String
        public var savedID: String?
        public init(spec: OwnerRequestSecretSpec?) { saveAs = spec?.name ?? "" }

        /// The body a press sends, or nil while there is nothing to send.
        public var body: OwnerRequestSecretBody? {
            if let savedID { return .saved(id: savedID) }
            guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            let label = saveAs.trimmingCharacters(in: .whitespacesAndNewlines)
            if save && label.isEmpty { return nil }
            return .value(value, saveAs: save ? label : nil)
        }
    }

    /// Whether the primary button may be pressed: a secret needs a key (or a saved one), a decision
    /// an option or words; the rest only need to be pending and inside their deadline.
    public static func canSubmit(_ request: OwnerRequest, draft: SecretDraft, option: Int?, text: String,
                                 now: Date = Date()) -> Bool {
        guard request.state == .pending, !pastDeadline(request, now: now) else { return false }
        switch request.kind {
        case .secret:   return draft.body != nil
        case .decision: return option != nil || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .manualStep, .confirm: return true
        }
    }

    /// The done door's body for a decision, or an empty one for the kinds that only say "done".
    public static func doneBody(_ request: OwnerRequest, option: Int?, text: String) -> OwnerRequestDoneBody {
        guard request.kind == .decision else { return OwnerRequestDoneBody() }
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return OwnerRequestDoneBody(option: option, text: words.isEmpty ? nil : words)
    }

    /// A step's link the card may open: only a web page, because the address is an agent's words.
    public static func openableLink(_ link: String) -> URL? {
        guard let url = URL(string: link), let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else { return nil }
        return url
    }

    // MARK: the resolved line

    /// What came of it: the summary's second line.
    public static func outcomeLine(_ request: OwnerRequest, runner: String) -> String {
        let note = request.resolutionNote?.trimmingCharacters(in: .whitespacesAndNewlines)
        switch request.state {
        case .declined:  return note.map { $0.isEmpty ? "Declined" : "Declined: “\($0)”" } ?? "Declined"
        case .expired:   return "Expired before anyone answered"
        case .withdrawn: return note.map { $0.isEmpty ? "Withdrawn" : "Withdrawn: “\($0)”" } ?? "Withdrawn"
        case .pending, .done: break
        }
        if request.kind == .secret, let spec = request.secretSpec {
            return "Delivered to \(runner) \(spec.filePath != nil ? "at" : "as") \(spec.filePath ?? spec.envVar ?? spec.name)"
        }
        if request.kind == .decision {
            let label = request.answer?.option.flatMap { index in
                request.options.flatMap { $0.indices.contains(index) ? $0[index].label : nil }
            }
            let said = request.answer?.text?.trimmingCharacters(in: .whitespacesAndNewlines)
            let words = (said?.isEmpty == false) ? said : nil
            if let label { return words.map { "\(label): “\($0)”" } ?? label }
            return words.map { "“\($0)”" } ?? "Answered"
        }
        return request.kind == .confirm ? "Confirmed" : "Marked done"
    }

    /// "by you · 10:58" — who ended it and when; an expiry names nobody.
    public static func byLine(_ request: OwnerRequest, now: Date = Date()) -> String {
        let who: String? = request.state == .expired ? nil
            : (request.resolvedByUserId != nil ? "by you" : "by the session that asked")
        let when = request.resolvedAt.map { EvidenceDecisions.receiptTime($0, now: now) }
        return [who, when].compactMap { $0 }.joined(separator: " · ")
    }

    /// "via iPhone": the device a request was ended from, when the server said.
    public static func deviceLabel(_ client: String?) -> String? {
        switch client {
        case "web": return "via Web"
        case "ios": return "via iPhone"
        case "macos": return "via Mac"
        case "android": return "via Android"
        default: return nil
        }
    }

    /// A removal the card must state on any request, not only a DONE one (design §6.1, §6.3, §6.4).
    public static func removalToTell(_ grant: OwnerRequestSecretGrant?) -> Bool {
        guard let grant else { return false }
        if grant.state == .removing { return true }
        guard grant.state == .removed, grant.endReason != "DELIVERY_FAILED" else { return false }
        return grant.endReason == "RUNNER_DELETED"
            || !(grant.removalNote?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
    }

    private static let grantEndings: [String: String] = [
        "TASK_ENDED": "Removed when the task ended",
        "SESSION_ENDED": "Removed when the session ended",
        "EXPIRED": "Removed when it expired",
        "WITHDRAWN": "Removed: the agent released it",
        "REVOKED": "Removed: you revoked it",
        "MOVED": "Removed when the session moved to another runner",
        "RUNNER_DELETED": "The runner was deleted; removal unconfirmed",
        "KEY_UNREADABLE": "Removed: the stored key could not be read",
        "DELIVERY_FAILED": "Delivery failed",
    ]

    /// Where a delivered key stands now (design §6): in, being removed, or gone and why.
    public static func grantLine(_ grant: OwnerRequestSecretGrant, runner: String, now: Date = Date()) -> String? {
        let at = { (iso: String) in EvidenceDecisions.receiptTime(iso, now: now) }
        switch grant.state {
        case .active:
            return "Key is in · expires \(at(grant.expiresAt))"
        case .removing:
            if !grant.runnerOnline, let seen = grant.runnerLastSeenAt {
                return "Removal pending: \(runner) has not been online since \(at(seen))"
            }
            return "Removal pending: waiting for \(runner) to confirm"
        case .removed:
            if let note = grant.removalNote, note.hasPrefix("Removal unconfirmed") { return note }
            let why = grant.endReason.flatMap { grantEndings[$0] } ?? "Removed"
            return grant.removalNote.map { "\(why). \($0)" } ?? why
        case .pendingDelivery:
            return nil
        }
    }

    /// The grant a resolved line shows: the whole story on a DONE secret, else only a removal to tell.
    public static func resolvedGrant(_ request: OwnerRequest) -> OwnerRequestSecretGrant? {
        guard request.kind == .secret, let grant = request.secretGrant else { return nil }
        return request.state == .done || removalToTell(grant) ? grant : nil
    }

    // MARK: the inbox

    public enum InboxTab: String, CaseIterable, Sendable, Identifiable {
        case open, done, declined
        public var id: String { rawValue }
        public var label: String {
            switch self {
            case .open: return "Open"
            case .done: return "Done"
            case .declined: return "Declined"
            }
        }
        public var empty: String {
            switch self {
            case .open: return "Nothing is waiting on you."
            case .done: return "Nothing has been done yet."
            case .declined: return "Nothing has been declined."
            }
        }
        /// The list door's `state`.
        public var filter: String { rawValue }
    }

    /// "3 steps", "decision · recommended: auth", "confirmation" — the row's first detail.
    public static func inboxDetail(_ request: OwnerRequest) -> String? {
        switch request.kind {
        case .manualStep:
            let steps = request.steps?.count ?? 0
            return "\(steps) \(steps == 1 ? "step" : "steps")"
        case .decision:
            let label = request.recommendedOption.flatMap { index in
                request.options.flatMap { $0.indices.contains(index) ? $0[index].label : nil }
            }
            return label.map { "decision · recommended: \($0)" } ?? "decision"
        case .confirm:
            return "confirmation"
        case .secret:
            return nil
        }
    }

    /// "holds 2 tasks", and for how long once that has passed a day: the part of the row that is overdue.
    public static func holdsText(_ request: OwnerRequest, now: Date = Date()) -> String? {
        let count = request.blocksTaskIds.count
        guard count > 0 else { return nil }
        let base = "holds \(count) \(count == 1 ? "task" : "tasks")"
        guard let asked = RelativeTime.parse(request.createdAt) else { return base }
        let waited = now.timeIntervalSince(asked)
        return waited >= 86_400 ? "\(base) for \(RelativeTime.span(waited))" : base
    }

    /// One session's requests, oldest first: the order they were asked in its conversation.
    public static func forSession(_ requests: [OwnerRequest], sessionID: String) -> [OwnerRequest] {
        let key = PublicID.storageKey(sessionID)
        return requests
            .filter { PublicID.storageKey($0.askedBySessionId) == key }
            .sorted { (RelativeTime.parse($0.createdAt) ?? .distantPast) < (RelativeTime.parse($1.createdAt) ?? .distantPast) }
    }

    /// Two reads (open, and every state) as one list by id, the newer read of a request winning.
    public static func merged(_ lists: [OwnerRequest]...) -> [OwnerRequest] {
        var byID: [String: OwnerRequest] = [:]
        var order: [String] = []
        for list in lists {
            for request in list {
                let key = PublicID.storageKey(request.id)
                if byID[key] == nil { order.append(key) }
                byID[key] = request
            }
        }
        return order.compactMap { byID[$0] }
    }

    /// The request with this id, in either spelling (a push names the UUID).
    public static func find(_ id: String, in requests: [OwnerRequest]) -> OwnerRequest? {
        let key = PublicID.storageKey(id)
        return requests.first { PublicID.storageKey($0.id) == key }
    }

    /// The count beside "Waiting on you": open requests, less those put off until later.
    public static func waitingCount(_ open: [OwnerRequest], snoozes: [String: Date], now: Date = Date()) -> Int {
        open.filter { $0.state == .pending && !isSnoozed($0.id, snoozes: snoozes, now: now) }.count
    }

    public static func isSnoozed(_ id: String, snoozes: [String: Date], now: Date = Date()) -> Bool {
        (snoozes[PublicID.storageKey(id)] ?? .distantPast) > now
    }

    /// "Remind me later" choices that come back before the deadline.
    public struct SnoozeChoice: Equatable, Sendable, Identifiable {
        public let id: String
        public let label: String
        public let seconds: TimeInterval
    }

    public static let snoozeChoices: [SnoozeChoice] = [
        SnoozeChoice(id: "1h", label: "In 1 hour", seconds: 3_600),
        SnoozeChoice(id: "4h", label: "In 4 hours", seconds: 4 * 3_600),
        SnoozeChoice(id: "1d", label: "Tomorrow", seconds: 86_400),
    ]

    public static func snoozeChoices(_ request: OwnerRequest, now: Date = Date()) -> [SnoozeChoice] {
        let deadline = request.expiresAt.flatMap(RelativeTime.parse) ?? .distantFuture
        return snoozeChoices.filter { now.addingTimeInterval($0.seconds) < deadline }
    }

    /// A push's Later: an hour, as the card's first choice.
    public static let laterSeconds: TimeInterval = 3_600

    /// "Reminder 11:58" on a folded card.
    public static func reminderLine(_ until: Date, now: Date = Date()) -> String {
        "Reminder \(EvidenceDecisions.receiptTime(ISO8601DateFormatter().string(from: until), now: now))"
    }
}

/// Reminders the owner set with "Remind me later" or a push's Later. The server has no snooze, so a
/// reminder belongs to this device, as the web's belongs to its browser: it folds the card and takes
/// the request out of the count, and changes nothing about the request itself.
public struct OwnerRequestSnoozes: Sendable {
    public static let defaultsKey = "orbit.ownerRequestSnoozes"
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    /// Live reminders only; an elapsed one is forgotten on the next write.
    public func all(now: Date = Date()) -> [String: Date] {
        let raw = defaults.dictionary(forKey: Self.defaultsKey) as? [String: Double] ?? [:]
        return raw.compactMapValues { $0 > now.timeIntervalSince1970 ? Date(timeIntervalSince1970: $0) : nil }
    }

    public func snooze(_ id: String, until: Date, now: Date = Date()) {
        var next = all(now: now).mapValues(\.timeIntervalSince1970)
        next[PublicID.storageKey(id)] = until.timeIntervalSince1970
        defaults.set(next, forKey: Self.defaultsKey)
    }

    public func wake(_ id: String, now: Date = Date()) {
        var next = all(now: now).mapValues(\.timeIntervalSince1970)
        next[PublicID.storageKey(id)] = nil
        defaults.set(next, forKey: Self.defaultsKey)
    }
}

/// `orbit://owner-request/<id>`: the "Waiting on you" inbox with that request's card open and its
/// input focused — where a push's "Provide key", "Answer" or "Mark done" lands. It rides beside
/// `Route` rather than in it, as `SessionRecordLink` does: `Route` is switched over exhaustively in
/// the app shells, and this names no page of its own.
public enum OwnerRequestLink {
    public static let host = "owner-request"

    public static func url(_ id: String) -> URL {
        URL(string: "\(DeepLink.scheme)://\(host)/\(PublicID.toPublic(id))")!
    }

    /// The request a link names, in its public spelling, or nil for any other link.
    public static func parse(_ url: URL) -> String? {
        guard url.scheme?.lowercased() == DeepLink.scheme, url.host?.lowercased() == host,
              let id = url.pathComponents.first(where: { $0 != "/" && !$0.isEmpty }),
              PublicID.toUUID(id) != nil else { return nil }
        return PublicID.toPublic(id)
    }

    /// What the card puts the cursor on when a link opens it: the key, the answer, or the button.
    public enum Focus: Equatable, Sendable { case secret, answer, primary }

    public static func focus(_ kind: OwnerRequestKind) -> Focus {
        switch kind {
        case .secret: return .secret
        case .decision: return .answer
        case .manualStep, .confirm: return .primary
        }
    }
}

// MARK: one inbox — owner requests and the coordinators' questions

/// An open question a project's coordinator put to the owner (`ask_owner`, a COORDINATOR_QUESTION open
/// item). It stays on its own table, but to the owner it is one more thing waiting, listed and counted
/// beside the owner requests (owner decision: one "Waiting on you" inbox; web `WaitingOnYouPage`).
public struct OwnerInboxQuestion: Equatable, Sendable, Identifiable {
    public let projectID: String
    public let projectTitle: String
    /// The conversation the question's card is drawn in, which Answer opens. Nil while unknown.
    public let coordinatorSessionID: String?
    public let coordinatorWorkspaceID: String?
    public let row: ProjectOpenItemRow
    public var id: String { row.itemId }

    public init(projectID: String, projectTitle: String, coordinatorSessionID: String? = nil,
                coordinatorWorkspaceID: String? = nil, row: ProjectOpenItemRow) {
        self.projectID = projectID
        self.projectTitle = projectTitle
        self.coordinatorSessionID = coordinatorSessionID
        self.coordinatorWorkspaceID = coordinatorWorkspaceID
        self.row = row
    }
}

/// One row of the inbox's Open tab.
public enum OwnerInboxEntry: Equatable, Sendable, Identifiable {
    case request(OwnerRequest)
    case question(OwnerInboxQuestion)

    public var id: String {
        switch self {
        case .request(let request): return "request-\(PublicID.storageKey(request.id))"
        case .question(let question): return "question-\(question.row.itemId)"
        }
    }

    /// When it started waiting: a request's `createdAt`, a question's `waitingSince`.
    public var at: String {
        switch self {
        case .request(let request): return request.createdAt
        case .question(let question): return question.row.waitingSince
        }
    }
}

public extension OwnerRequests {
    /// The open projects whose coordinator has a question waiting on the owner: the only ones whose
    /// open items are read, as the web reads them (`projectsWithQuestions`).
    static func projectsAsking(_ projects: [ProjectSummary]) -> [ProjectSummary] {
        projects.filter { project in
            project.status == .open
                && (project.attention?.ownerItems ?? []).contains { $0.kind == .coordinatorQuestion && $0.count > 0 }
        }
    }

    /// One project's open questions, from its open-items read.
    static func questions(project: ProjectSummary, items: ProjectOpenItemsView?, coordinatorSessionID: String?,
                          coordinatorWorkspaceID: String?) -> [OwnerInboxQuestion] {
        CoordinatorQuestions.open(items).map {
            OwnerInboxQuestion(projectID: project.id, projectTitle: project.title,
                               coordinatorSessionID: coordinatorSessionID,
                               coordinatorWorkspaceID: coordinatorWorkspaceID, row: $0)
        }
    }

    /// The Open tab: pending requests and open questions, newest first.
    static func openEntries(_ requests: [OwnerRequest], questions: [OwnerInboxQuestion]) -> [OwnerInboxEntry] {
        let entries = requests.filter { $0.state == .pending }.map(OwnerInboxEntry.request)
            + questions.map(OwnerInboxEntry.question)
        return entries.enumerated().sorted { a, b in
            let x = RelativeTime.parse(a.element.at) ?? .distantPast
            let y = RelativeTime.parse(b.element.at) ?? .distantPast
            return x != y ? x > y : a.offset < b.offset
        }.map(\.element)
    }

    /// The one count: requests not put off until later, plus every open coordinator question.
    static func waitingCount(_ open: [OwnerRequest], questions: [OwnerInboxQuestion], snoozes: [String: Date],
                             now: Date = Date()) -> Int {
        waitingCount(open, snoozes: snoozes, now: now) + questions.count
    }

    /// A question row's title: its opening as plain text.
    static func questionTitle(_ question: OwnerInboxQuestion) -> String {
        question.row.question.map(CoordinatorQuestions.lead) ?? question.row.title
    }

    /// "Payments · decision · recommended: auth" — the web row's detail, word for word.
    static func questionDetail(_ question: OwnerInboxQuestion) -> String {
        let asked = question.row.question
        let label = asked?.recommendedOption.flatMap { index in
            asked.flatMap { $0.options.indices.contains(index) ? $0.options[index].label : nil }
        }
        return "\(question.projectTitle) · \(label.map { "decision · recommended: \($0)" } ?? "decision")"
    }

    static let answer = "Answer"
}
