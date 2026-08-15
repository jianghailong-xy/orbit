import Foundation
import UserNotifications
import OrbitKit

/// Thin macOS shell over `UserNotifications`. The *what/whether/text* of every notification and
/// the interpretation of a tapped action are decided by OrbitKit's `Notifications` (unit-tested);
/// this only does delivery: auth, category registration, posting, and forwarding responses.
@MainActor
final class NotificationManager: NSObject, UNUserNotificationCenterDelegate {
    /// Fired (on the main actor) when the user acts on a notification.
    var onIntent: ((AppIntent) -> Void)?

    /// Fired (on the main actor) for an approval that lands while Orbit is the foreground app on
    /// iOS, where it is re-stated as the app's own card instead of a system banner (see
    /// `willPresent`). Carries the session and the push's own line, "Needs your reply · Bash".
    var onForegroundApproval: ((String, String) -> Void)?

    /// The session whose console is on screen, kept current by `AppModel.syncConsoleFocus`. The
    /// notification *logic* already skips this session (`SessionDelta.diff`'s `focusedSessionID`) —
    /// but the server's APNs approval push can't know what you are looking at, so on iOS an approval
    /// for the open session arrived as a full-width banner and a sound over the very screen already
    /// showing its card. `willPresent` consults this to keep those quiet.
    var focusedSessionID: String?

    // UNUserNotificationCenter requires a real .app bundle (a bundle identifier). Under
    // `swift run` the binary is unbundled and even *touching* the center throws — so every call
    // is gated on a bundle being present. The app runs fine for dev without it (no banners);
    // notifications light up once it's packaged as a signed .app (Phase 5).
    private var available: Bool { Bundle.main.bundleIdentifier != nil }
    private var center: UNUserNotificationCenter? { available ? .current() : nil }

    func configure() {
        guard let center else { return }
        center.delegate = self
        let allow = UNNotificationAction(identifier: Notifications.actionAllow, title: "Allow",
                                         options: [.authenticationRequired])
        let deny = UNNotificationAction(identifier: Notifications.actionDeny, title: "Deny",
                                        options: [.destructive])
        let reply = UNTextInputNotificationAction(identifier: Notifications.actionReply, title: "Reply",
                                                  options: [], textInputButtonTitle: "Send",
                                                  textInputPlaceholder: "Message")
        let approval = UNNotificationCategory(identifier: Notifications.approvalCategory,
                                              actions: [allow, deny, reply], intentIdentifiers: [], options: [])
        let session = UNNotificationCategory(identifier: Notifications.sessionCategory,
                                             actions: [reply], intentIdentifiers: [], options: [])
        center.setNotificationCategories([approval, session])
        center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    func post(_ content: NotificationContent) {
        guard let center else { return }
        let c = UNMutableNotificationContent()
        c.title = content.title
        c.body = content.body
        c.categoryIdentifier = content.categoryIdentifier
        c.threadIdentifier = content.threadIdentifier
        c.userInfo = content.userInfo
        c.sound = .default
        // Stable identifier → re-posting the same kind for a session replaces, never stacks.
        center.add(UNNotificationRequest(identifier: content.identifier, content: c, trigger: nil))
    }

    func clear(identifier: String) {
        center?.removeDeliveredNotifications(withIdentifiers: [identifier])
    }

    /// Remove delivered *approval* banners whose session (thread id) matches `predicate`, so an
    /// approval handled on another device also leaves Notification Center. The silent badge-sync
    /// push passes the resolved sessions; the foreground reconcile passes "no longer needs you".
    /// `nonisolated` so the background push delegate can call it directly. See
    /// docs/cross-platform-badge-sync.md.
    nonisolated static func removeDeliveredApprovals(where predicate: @escaping @Sendable (String) -> Bool) {
        guard Bundle.main.bundleIdentifier != nil else { return }
        UNUserNotificationCenter.current().getDeliveredNotifications { notes in
            let ids = notes
                .filter { $0.request.content.categoryIdentifier == Notifications.approvalCategory
                          && predicate($0.request.content.threadIdentifier) }
                .map(\.request.identifier)
            if !ids.isEmpty {
                UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ids)
            }
        }
    }

    // MARK: UNUserNotificationCenterDelegate

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            didReceive response: UNNotificationResponse) async {
        let userInfo = response.notification.request.content.userInfo
        let strings = Dictionary(uniqueKeysWithValues: userInfo.compactMap { key, value -> (String, String)? in
            guard let k = key as? String, let v = value as? String else { return nil }
            return (k, v)
        })
        let text = (response as? UNTextInputNotificationResponse)?.userText
        guard let intent = Notifications.intent(actionId: response.actionIdentifier,
                                                userInfo: strings, responseText: text) else { return }
        await MainActor.run { self.onIntent?(intent) }
    }

    /// What an alert does while Orbit is the app you're looking at.
    ///
    /// **iOS: never a banner.** A pushed approval landing over the app drew a full-width system
    /// banner in the very strip the in-app toast occupies — two differently shaped cards competing
    /// for one place on screen, and, since the toast learned to be flicked away, giving the same
    /// upward swipe opposite meanings (a banner tucks itself into Notification Center; a toast is
    /// gone for good). So the foreground speaks one language. The alert is still *delivered* —
    /// `.list` keeps it in Notification Center and the badge still counts it — and an approval,
    /// the one kind that's blocking somebody, comes back as the app's own card via
    /// `onForegroundApproval`. A settled run gets no card: in the foreground that outcome is
    /// already on screen in the list, the row's status and the transcript itself.
    ///
    /// **macOS keeps the banner.** Its notifications land in a screen corner rather than over the
    /// window, so nothing competes there, and the app can be frontmost with every window closed
    /// (the menu-bar tray) — where an in-app card would have nowhere to appear at all.
    ///
    /// Either way the session already filling the screen is left alone: its console shows the
    /// approval card itself, so restating it is noise on top of the thing it announces.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification) async
        -> UNNotificationPresentationOptions {
        let content = notification.request.content
        let session = content.userInfo[Notifications.keySession] as? String
        let focused = await MainActor.run { self.focusedSessionID }
        #if os(iOS)
        if let session, session != focused,
           content.categoryIdentifier == Notifications.approvalCategory {
            let line = content.body
            await MainActor.run { self.onForegroundApproval?(session, line) }
            // The sound stays, alone of the banner's parts: it's the one that still reaches you
            // with the app open on a desk you aren't looking at, and being audio it can't collide
            // with anything on screen. Nothing else is loud enough to warrant it — a settled run
            // is not blocking anybody.
            return [.list, .sound]
        }
        return [.list]
        #else
        if let session, session == focused { return [.list] }
        return [.banner, .sound, .list]
        #endif
    }
}
