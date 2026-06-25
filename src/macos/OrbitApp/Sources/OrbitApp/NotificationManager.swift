import Foundation
import UserNotifications
import OrbitKit

/// Thin macOS shell over `UserNotifications`. The *what/whether/text* of every notification and
/// the interpretation of a tapped action are decided by OrbitKit's `Notifications` (unit-tested);
/// this only does delivery: auth, category registration, posting, and forwarding responses.
@MainActor
final class NotificationManager: NSObject, UNUserNotificationCenterDelegate {
    private let center = UNUserNotificationCenter.current()
    /// Fired (on the main actor) when the user acts on a notification.
    var onIntent: ((AppIntent) -> Void)?

    func configure() {
        center.delegate = self
        registerCategories()
        center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    private func registerCategories() {
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
    }

    func post(_ content: NotificationContent) {
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
        center.removeDeliveredNotifications(withIdentifiers: [identifier])
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
