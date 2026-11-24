import Foundation

/// Owner requests: what a session asked the account owner to do, as a card in the conversation that
/// asked, and behind a push's actions. Every word and rule the views draw is here, pure and tested;
/// the web says the same things (`lib/ownerRequests.ts`, `components/OwnerRequestCard.tsx`).
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
        case .wikiCreate: return "WIKI"
        case .settingsChange: return "SETTINGS"
        case .browserSignIn: return "SIGN IN"
        case .change: return ChangeCopy.tag
        case .projectReopen: return "REOPEN"
        }
    }

    /// The card's primary button.
    public static func primaryLabel(_ kind: OwnerRequestKind) -> String {
        switch kind {
        case .decision:   return "Send answer"
        case .secret:     return "Provide key"
        case .manualStep: return "Mark done"
        case .confirm:    return "Confirm"
        case .wikiCreate: return "Create wiki"
        case .settingsChange: return SettingsChangeCopy.save
        case .browserSignIn: return BrowserSignInCopy.openBrowser
        case .change: return ChangeCopy.primary
        case .projectReopen: return ProjectReopenCopy.reopen
        }
    }

    /// The way out of doing it, which always asks why.
    public static func declineLabel(_ kind: OwnerRequestKind) -> String {
        kind == .manualStep ? "Can’t do this…" : "Decline…"
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

    // MARK: Chat about this

    /// A request talked about rather than answered: the next send is an ordinary turn to the session
    /// that asked, with the request named in front of the typed words. Nothing is resolved. The web's
    /// `OWNER_REQUEST_CHAT_PREFIX`, `OWNER_REQUEST_CHAT_PLACEHOLDER` and `ownerRequestChatContext`.
    public static let chatPrefix = "About your request: "
    public static let chatPlaceholder = "Ask about this request…"

    /// What rides in front of the owner's words: which request, and that it is still open.
    public static func chatContext(_ request: OwnerRequest) -> String {
        "The owner pressed Chat about this on your request “\(request.title)” (owner request \(request.id)). "
            + "It is still open: not marked done and not declined. Their message:"
    }

    // MARK: How a resolution turn reads

    /// Orbit's mark on the turn it queues when a request ends (`ownerRequestResolutionTurn` on the server).
    static let resolutionMark = "This turn was queued by Orbit when the request ended, not typed by a person."
    private static let resolutionHead =
        try? NSRegularExpression(pattern: #"^Orbit owner request \S+ \([A-Z_]+\) ended (DONE|DECLINED|EXPIRED|WITHDRAWN)[:.] "#)
    private static let resolutionLabels: [String: String] = [
        "DONE": "Owner action resolved",
        "DECLINED": "Owner declined the request",
        "EXPIRED": "Owner request expired",
        "WITHDRAWN": "Owner request withdrawn",
    ]

    /// The divider drawn for the turn Orbit starts when a request ends, or nil for any other turn
    /// (web parity: `resolutionTurnLabel`). Nobody typed it, so it is not the owner's bubble.
    public static func resolutionTurnLabel(_ text: String) -> String? {
        guard text.contains(resolutionMark), let head = resolutionHead,
              let match = head.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let range = Range(match.range(at: 1), in: text),
              let label = resolutionLabels[String(text[range])] else { return nil }
        return "\(label) · turn started automatically"
    }

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
        case .manualStep, .confirm, .wikiCreate, .settingsChange, .browserSignIn, .change, .projectReopen: return true
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
        if request.kind == .projectReopen { return ProjectReopenCopy.outcomeLine(request) }
        if request.kind == .browserSignIn, request.state == .declined { return BrowserSignInCopy.notNow }
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
        if request.kind == .wikiCreate { return WikiStartCopy.created(request.answer?.name) }
        if request.kind == .settingsChange {
            return SettingsChangeCopy.changed(SettingsFromConversation.entries(request.payload).count)
        }
        if request.kind == .change, let spec = request.changeSpec {
            return ChangeCopy.applied(runner: runner, from: request.answer?.actualBefore ?? spec.before,
                                      to: request.answer?.applied ?? spec.requested, requested: spec.requested)
        }
        if request.kind == .browserSignIn { return request.browserSite.map(BrowserSignInCopy.signedIn) ?? "Signed in" }
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

    // MARK: the account's reads

    /// One session's requests, oldest first: the order they were asked in its conversation.
    public static func forSession(_ requests: [OwnerRequest], sessionID: String) -> [OwnerRequest] {
        let key = PublicID.storageKey(sessionID)
        return requests
            .filter { PublicID.storageKey($0.askedBySessionId) == key }
            .sorted { (RelativeTime.parse($0.createdAt) ?? .distantPast) < (RelativeTime.parse($1.createdAt) ?? .distantPast) }
    }

    /// The request a press on a session's needs-you notice opens: the oldest one it asked that is still
    /// pending, or nil when this device holds none of them yet.
    public static func oldestPending(_ requests: [OwnerRequest], sessionID: String) -> OwnerRequest? {
        forSession(requests, sessionID: sessionID).first { $0.state == .pending }
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
/// reminder belongs to this device, as the web's belongs to its browser: it folds the card until it
/// comes back, and changes nothing about the request itself.
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

/// `orbit://owner-request/<id>`: the conversation that asked, landed on that request's card — where
/// a push's "Provide key", "Answer" or "Mark done" leads. It names the request only; the app reads
/// it for `askedBySessionId`. It rides beside `Route` rather than in it, as `SessionRecordLink`
/// does: this names no page of its own.
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
}

/// The BROWSER_SIGN_IN card's words (web `BROWSER_SIGN_IN_COPY`). Signed in is answered from the runner's browser tab
/// on the web, not from the card: the card only opens that tab, or says Not now.
public enum BrowserSignInCopy {
    public static let eyebrow = "Sign in needed · Orbit Cloud browser"
    public static func fromSession(_ title: String) -> String { "From session \(title)" }
    public static let note = "You sign in yourself; Orbit never sees your password. The login stays on this runner, and every agent on it can use it."
    public static let openBrowser = "Open browser"
    public static let notNow = "Not now"
    public static func signedIn(_ site: String) -> String { "Signed in to \(site)" }
    /// The push's first action.
    public static let action = "Sign in"

    /// The "From session …" line, or nil when the server named no session title.
    public static func fromSessionLine(_ request: OwnerRequest) -> String? {
        guard let title = request.askedBySessionTitle?.trimmingCharacters(in: .whitespacesAndNewlines),
              !title.isEmpty else { return nil }
        return fromSession(title)
    }

    /// The runner's browser tab, which only the web draws: `<baseURL>/runners/<id>/browser?control=1`. Nil without a
    /// runner to open it on.
    public static func browserURL(baseURL: URL, runnerId: String?) -> URL? {
        guard let runnerId, !runnerId.isEmpty else { return nil }
        var base = baseURL.absoluteString
        while base.hasSuffix("/") { base.removeLast() }
        return URL(string: "\(base)/runners/\(PublicID.toPublic(runnerId))/browser?control=1")
    }
}

/// The CHANGE card's words: the web's `CHANGE_COPY` (lib/ownerRequests.ts), said the same way.
public enum ChangeCopy {
    public static let tag = "SETTING"
    public static let primary = "Apply"
    public static let numberLabel = "Max Concurrent"
    public static func setting(_ runner: String) -> String { "\(runner) · Max Concurrent" }
    public static func runningNow(_ n: Int) -> String { "\(n) running now" }
    public static func wasWhenAsked(_ before: Int) -> String { "Was \(before) when asked." }
    public static func lowering(_ n: Int) -> String { "Nothing running stops. New sessions wait until fewer than \(n) run." }
    public static func raising(_ n: Int) -> String { "Up to \(n) sessions can run at once on this machine." }
    public static func applied(runner: String, from: Int, to: Int, requested: Int) -> String {
        "Applied: \(runner) Max Concurrent \(from) → \(to)\(to != requested ? " (asked for \(requested))" : "")"
    }

    /// The line under the number: what it would do against the live value (nil when equal).
    public static func effect(value: Int, live: Int) -> String? {
        value < live ? lowering(value) : value > live ? raising(value) : nil
    }
}
