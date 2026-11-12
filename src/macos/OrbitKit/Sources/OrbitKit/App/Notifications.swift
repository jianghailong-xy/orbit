import Foundation

// Notification *logic* — what to notify, the text/category/actions, and how to interpret a
// tapped action. All pure + tested. The macOS delivery (UNUserNotificationCenter: requesting
// auth, registering categories, scheduling, handling responses) is the app's glue layer.

/// A notification-worthy transition derived from polling the Open list.
public enum NotificationEvent: Equatable, Sendable {
    /// A session's pending-approval count went 0 → >0 — the agent is blocked on you. A project ready
    /// to start is not counted (see `SessionDelta.diff`).
    case needsApproval(sessionID: String, title: String, count: Int)
    /// A previously-live session reached a terminal state (status nil = it simply left the
    /// Open list, so the exact terminal status is unknown).
    case finished(sessionID: String, title: String, status: RunStatus?)
    /// A NOTIFY_USER watch matched: a condition you asked to be told about held. The generation is
    /// what, with the watch's id, names that one Match.
    case watchMatched(watchID: String, generation: Int, condition: String)
}

public enum SessionDelta {
    /// Diff two Open-list snapshots into notification events. Skips the `focusedSessionID`
    /// (the user is already looking at it) and anything in `filed` — a session that left the Open
    /// list because somebody completed or trashed it, here or on another device, which is not a run
    /// finishing and reports the user's own action back to them. The caller should prime the first
    /// snapshot WITHOUT notifying (otherwise every pre-existing pending session would ping on
    /// launch).
    public static func diff(previous: [Session], current: [Session],
                            focusedSessionID: String? = nil,
                            filed: Set<String> = []) -> [NotificationEvent] {
        let prevByID = Dictionary(previous.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let curByID = Dictionary(current.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let silent = filed.union([focusedSessionID].compactMap { $0 })
        var events: [NotificationEvent] = []

        for s in current where !silent.contains(s.id) {
            // A row whose only wait is its project ready to start is read as nothing here, as the
            // needs-you bar reads it: the start request arriving is no alert, and a blocked tool
            // call landing beside it still is.
            let before = prevByID[s.id].map(announcedCount) ?? 0
            let after = announcedCount(s)
            if before == 0 && after > 0 {
                events.append(.needsApproval(sessionID: s.id, title: s.title ?? "Session", count: after))
            }
            // Settling, not merely reaching a terminal status: a failure the server has armed a
            // retry for is an interruption it is about to undo by itself. `prev.retryAt` is what
            // carries the give-up, which moves no status at all — the row stays FAILED and only the
            // armed retry clearing turns it into the outcome worth announcing.
            if let prev = prevByID[s.id], prev.effectiveRunStatus.isLive || prev.retryAt != nil,
               isSettled(s) {
                events.append(.finished(sessionID: s.id, title: s.title ?? "Session",
                                        status: s.effectiveRunStatus))
            }
        }
        // Sessions that were live and dropped out of Open → finished (status unknown).
        for p in previous where p.effectiveRunStatus.isLive && curByID[p.id] == nil && !silent.contains(p.id) {
            events.append(.finished(sessionID: p.id, title: p.title ?? "Session", status: nil))
        }
        return events
    }

    /// The count an approval alert is raised on: `pendingApprovals`, or nothing for a row whose only
    /// wait is a project ready to start (`SessionGrouping.countsOnlyAStart`).
    private static func announcedCount(_ s: Session) -> Int {
        SessionGrouping.countsOnlyAStart(s) ? 0 : (s.pendingApprovals ?? 0)
    }

    /// Whether a `session.ended` control event is worth announcing. That event fires whenever a row
    /// leaves Open, and only the reaper's `task_done` — a task that ran to success, which the server
    /// files for you — is the run finishing on its own. Everything else is somebody completing or
    /// trashing the session by hand, on this device or another.
    ///
    /// An unrecognised reason (or none) counts as filed too, because the field is only trustworthy
    /// in this direction: completing a session that had already ended forwards whatever `endReason`
    /// it was carrying rather than `completed` (see `transitionEnd` in sessions.service.ts), so
    /// "not task_done" is the only read of it that holds.
    public static func announcesFinish(endReason: String?) -> Bool { endReason == "task_done" }

    /// The run is over AND nothing is going to restart it — the only reading of a row that is an
    /// outcome. A quota-killed or 529'd turn settles as FAILED with `retryAt` armed, and the server
    /// re-sends the same message when the provider is back (`AutoRetryService`), so announcing that
    /// reports a failure the user never had. An older server sends no `retryAt` at all, which reads
    /// as "nothing armed" and keeps the pre-retry behaviour.
    private static func isSettled(_ s: Session) -> Bool {
        s.effectiveRunStatus.isTerminal && s.retryAt == nil
    }
}

public enum WatchDelta {
    /// The NOTIFY_USER watches that matched between two fetched lists — how a client with no APNs
    /// path (macOS) tells you. The watch has to have been seen live first: the first fetch only
    /// primes, and a Match from before this client ever saw the watch is history, not news.
    ///
    /// What is read is the Match itself, which is the `generation` (contract §4: a Match is written
    /// with the generation that names it), not the state the watch is left in. A ONE_SHOT watch is
    /// MATCHED by its only Match and raises the generation to 1 in the same write, so it reads the
    /// same as before; a CONTINUOUS watch stays ACTIVE and raises the generation once per coalesced
    /// window, and reading the state alone announced none of those — while the same account's iPhone
    /// heard every one of them, because `PushService.notifyWatchMatched` pushes per Match whatever the
    /// mode. The alert's own identifier is already `watch-<id>-<generation>`, the key the server
    /// collapses its push under, so a device that gets both still shows one alert per Match.
    public static func matched(previous: [Watch], current: [Watch]) -> [NotificationEvent] {
        let before = Dictionary(previous.map { (PublicID.storageKey($0.id), $0) },
                                uniquingKeysWith: { a, _ in a })
        return current.compactMap { watch in
            guard watch.action == .notifyUser,
                  let was = before[PublicID.storageKey(watch.id)],
                  WatchStateMachine.isLive(was.state),
                  watch.generation > was.generation
            else { return nil }
            let condition = WatchProjection.condition(watch.predicate,
                                                      targetCount: WatchProgress(watch.targets).live)
            return .watchMatched(watchID: watch.id, generation: watch.generation, condition: condition)
        }
    }
}

/// Built notification payload — stable identifier (so re-notifying replaces, not stacks),
/// text, category (which action buttons), thread (grouping), and the tap route.
public struct NotificationContent: Equatable, Sendable {
    public let identifier: String
    public let title: String
    public let body: String
    public let categoryIdentifier: String
    public let threadIdentifier: String
    public let route: Route
    public let userInfo: [String: String]
}

/// A user action resolved from a notification response (or a menu/deep-link tap).
public enum AppIntent: Equatable, Sendable {
    case open(Route)
    case approve(sessionID: String, behavior: ApprovalBehavior)   // app resolves which pending approval(s)
    case reply(sessionID: String, text: String)
    /// A derived completion opens its project without needing a coordinator session.
    case openProject(projectID: String)
    /// A merge into main waiting on the owner: answered on the project's sessions page, where its
    /// card is (owner decision 2026-10-06). A client without that page opens the coordinator
    /// conversation, which draws the merge as its line.
    case openProjectMerge(projectID: String, sessionID: String)
    /// An owner request's push action — "Provide key", "Answer", "Mark done", "Review" — and the
    /// plain tap on its alert or its Later reminder: the conversation that asked, landed on that
    /// request's card (`OwnerRequestLink`). It never answers the request: a secret has no reply path
    /// outside its card (secrets design §7.2).
    case openOwnerRequest(requestID: String)
    /// An owner request's "Later": put off for `OwnerRequests.laterSeconds`, on this device only.
    case snoozeOwnerRequest(requestID: String)
}

public enum Notifications {
    // Category + action identifiers registered with UNUserNotificationCenter.
    public static let approvalCategory = "ORBIT_APPROVAL"
    public static let sessionCategory = "ORBIT_SESSION"
    public static let actionAllow = "ALLOW"
    public static let actionDeny = "DENY"
    public static let actionReply = "REPLY"
    /// An owner request's two actions, under its kind's category (`ownerRequestCategory`).
    public static let actionOwnerRequestOpen = "OWNER_REQUEST_OPEN"
    public static let actionOwnerRequestLater = "OWNER_REQUEST_LATER"
    /// `userInfo` key naming the owner request an alert is about (apiserver `PushService.notifyOwnerRequest`).
    public static let keyOwnerRequest = "ownerRequestID"

    /// The category the server files an owner request's alert under, one per kind
    /// (apiserver `ownerRequestPushCategory`), so each kind's first action can say what it opens.
    public static func ownerRequestCategory(_ kind: OwnerRequestKind) -> String {
        "ORBIT_OWNER_REQUEST_\(kind.rawValue)"
    }

    /// The first action's title on an owner request's alert. Each opens the card on its input.
    public static func ownerRequestActionTitle(_ kind: OwnerRequestKind) -> String {
        switch kind {
        case .secret:     return "Provide key"
        case .decision:   return "Answer"
        case .manualStep: return "Mark done"
        case .confirm:    return "Review"
        }
    }

    public static let ownerRequestLaterTitle = "Later"

    /// The reminder a push's Later brings back an hour on: the request's own words, its card one tap away.
    public static func ownerRequestReminder(requestID: String, kind: OwnerRequestKind, title: String,
                                            sessionID: String) -> NotificationContent {
        let key = PublicID.storageKey(requestID)
        return NotificationContent(
            identifier: "owner-request-\(key)",
            title: "\(OwnerRequests.waitingOnYou): \(title)",
            body: "You asked to be reminded.",
            categoryIdentifier: ownerRequestCategory(kind),
            threadIdentifier: "owner-request-\(sessionID)",
            route: .session(sessionID),
            userInfo: [keySession: sessionID, keyKind: "owner-request", keyOwnerRequest: requestID,
                       "ownerRequestKind": kind.rawValue])
    }

    /// `userInfo` key naming the session an alert is about — set by both the locally posted
    /// notifications below and the server's APNs payload, so the delivery layer can tell which
    /// session a push (from either source) belongs to.
    public static let keySession = "sessionID"
    /// `userInfo` key naming the watch a match alert is about — the server's APNs payload
    /// (apiserver `PushService.notifyWatchMatched`) and the local alert below both set it.
    public static let keyWatch = "watchID"
    static let keyKind = "kind"
    /// `userInfo` key naming the project an owner-item alert is about (apiserver
    /// `PushService.notifyOwnerItem`).
    public static let keyProject = "projectID"
    /// The owner-item alert kind of a merge into main waiting on the owner (`OWNER_ITEM_PUSH_KINDS`).
    static let approveMergeKind = "approve-merge-to-main"

    public static func content(for event: NotificationEvent) -> NotificationContent {
        switch event {
        case let .needsApproval(sid, title, count):
            return NotificationContent(
                identifier: "approval-\(sid)",
                title: "Needs your approval",
                body: count > 1 ? "\(title) — \(count) pending" : title,
                categoryIdentifier: approvalCategory,
                threadIdentifier: sid,
                route: .session(sid),
                userInfo: [keySession: sid, keyKind: "approval"])
        case let .finished(sid, title, status):
            let failed = status == .failed
            return NotificationContent(
                identifier: "finished-\(sid)",
                title: failed ? "Session failed" : "Session finished",
                body: title,
                categoryIdentifier: sessionCategory,
                threadIdentifier: sid,
                route: .session(sid),
                userInfo: [keySession: sid, keyKind: failed ? "failed" : "finished"])
        case let .watchMatched(wid, generation, condition):
            // Keyed the way the server collapses its push (`watch-<uuid>-<generation>`), so one Match
            // can't stack two alerts on a device that got both. No category: its only action is a tap.
            let key = PublicID.storageKey(wid)
            return NotificationContent(
                identifier: "watch-\(key)-\(generation)",
                title: "Watch matched",
                body: condition,
                categoryIdentifier: "",
                threadIdentifier: "watch-\(key)",
                route: .watch(wid),
                userInfo: [keyWatch: wid, keyKind: "watch-matched"])
        }
    }

    /// Resolve a notification response (or menu tap) into an app action. `actionId` is
    /// `UNNotificationDefaultActionIdentifier` (→ open) or one of the action constants above.
    public static func intent(actionId: String, userInfo: [String: String],
                              responseText: String? = nil) -> AppIntent? {
        if userInfo[keyKind] == "project-done", let project = userInfo[keyProject] {
            return .openProject(projectID: project)
        }
        // An owner request's actions open its card or put it off; a plain tap — the alert itself or
        // its Later reminder — opens the conversation that asked, on the same card. Everything it
        // needs is the request's own id, which the app resolves to `askedBySessionId`.
        if let request = userInfo[keyOwnerRequest] {
            if actionId == actionOwnerRequestLater { return .snoozeOwnerRequest(requestID: request) }
            return .openOwnerRequest(requestID: request)
        }
        guard let sid = userInfo[keySession] else {
            // A watch's alert names no session and carries no actions: tapping it opens the watch.
            return userInfo[keyWatch].map { .open(.watch($0)) }
        }
        switch actionId {
        case actionAllow: return .approve(sessionID: sid, behavior: .allow)
        case actionDeny:  return .approve(sessionID: sid, behavior: .deny)
        case actionReply:
            let text = (responseText ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? nil : .reply(sessionID: sid, text: text)
        default:
            // The merge's alert opens the project's page, where the merge is answered.
            if userInfo[keyKind] == approveMergeKind, let project = userInfo[keyProject] {
                return .openProjectMerge(projectID: project, sessionID: sid)
            }
            return .open(.session(sid))   // default tap
        }
    }
}
