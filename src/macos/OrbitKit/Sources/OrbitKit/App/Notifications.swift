import Foundation

// Notification *logic* — what to notify, the text/category/actions, and how to interpret a
// tapped action. All pure + tested. The macOS delivery (UNUserNotificationCenter: requesting
// auth, registering categories, scheduling, handling responses) is the app's glue layer.

/// A notification-worthy transition derived from polling the Open list.
public enum NotificationEvent: Equatable, Sendable {
    /// A session's pending-approval count went 0 → >0 — the agent is blocked on you.
    case needsApproval(sessionID: String, title: String, count: Int)
    /// A previously-live session reached a terminal state (status nil = it simply left the
    /// Open list, so the exact terminal status is unknown).
    case finished(sessionID: String, title: String, status: RunStatus?)
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
            let before = prevByID[s.id]?.pendingApprovals ?? 0
            let after = s.pendingApprovals ?? 0
            if before == 0 && after > 0 {
                events.append(.needsApproval(sessionID: s.id, title: s.title ?? "Session", count: after))
            }
            if let prev = prevByID[s.id], prev.effectiveRunStatus.isLive,
               isTerminal(s.effectiveRunStatus) {
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

    private static func isTerminal(_ s: RunStatus) -> Bool {
        switch s {
        case .succeeded, .failed, .cancelled: return true
        default: return false
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
}

public enum Notifications {
    // Category + action identifiers registered with UNUserNotificationCenter.
    public static let approvalCategory = "ORBIT_APPROVAL"
    public static let sessionCategory = "ORBIT_SESSION"
    public static let actionAllow = "ALLOW"
    public static let actionDeny = "DENY"
    public static let actionReply = "REPLY"

    /// `userInfo` key naming the session an alert is about — set by both the locally posted
    /// notifications below and the server's APNs payload, so the delivery layer can tell which
    /// session a push (from either source) belongs to.
    public static let keySession = "sessionID"
    static let keyKind = "kind"

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
        }
    }

    /// Resolve a notification response (or menu tap) into an app action. `actionId` is
    /// `UNNotificationDefaultActionIdentifier` (→ open) or one of the action constants above.
    public static func intent(actionId: String, userInfo: [String: String],
                              responseText: String? = nil) -> AppIntent? {
        guard let sid = userInfo[keySession] else { return nil }
        switch actionId {
        case actionAllow: return .approve(sessionID: sid, behavior: .allow)
        case actionDeny:  return .approve(sessionID: sid, behavior: .deny)
        case actionReply:
            let text = (responseText ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? nil : .reply(sessionID: sid, text: text)
        default:          return .open(.session(sid))   // default tap
        }
    }
}
