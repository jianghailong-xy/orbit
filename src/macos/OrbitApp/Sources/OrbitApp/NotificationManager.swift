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

    /// Show banners even when Orbit is the foreground app.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification) async
        -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}
