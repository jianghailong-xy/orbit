#if os(iOS)
import UIKit
import OrbitKit

/// Bridges UIKit's remote-notification registration (an app-delegate callback) to the sign-in-scoped
/// reporter that POSTs the APNs token to the server. The delegate is created by SwiftUI before the
/// app model exists and the token can arrive before sign-in, so the token is buffered here and
/// flushed once `AppModel.enablePush()` installs the reporter.
@MainActor
final class PushRegistrar {
    static let shared = PushRegistrar()
    private init() {}

    private var pendingToken: Data?
    private var report: ((Data) async -> Void)?

    /// The APNs environment this build's `aps-environment` entitlement targets. Distribution
    /// (Release/TestFlight) builds are `production`; a debug build would be `sandbox`.
    static var environment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    /// Ask iOS for the device's APNs token (arrives via `PushDelegate`). Authorization for *alerts*
    /// is requested separately by `NotificationManager.configure()`; the token itself is granted
    /// regardless, so this just kicks off registration.
    func start() {
        UIApplication.shared.registerForRemoteNotifications()
    }

    /// Install the reporter (once signed in) and flush any token that arrived before sign-in.
    func setReporter(_ reporter: @escaping (Data) async -> Void) {
        report = reporter
        if let pendingToken { Task { await reporter(pendingToken) } }
    }

    /// Called by the app delegate when APNs returns the token.
    func deliver(_ token: Data) {
        pendingToken = token
        if let report { Task { await report(token) } }
    }
}

/// Minimal app delegate: the only reliable way to receive the APNs device token in a SwiftUI app.
/// Notification *taps* still route through `NotificationManager` (the UNUserNotificationCenter
/// delegate), so this only forwards the token.
final class PushDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in PushRegistrar.shared.deliver(deviceToken) }
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // No token this launch (e.g. no network / not provisioned). Registration retries next launch.
    }

    /// Silent badge-sync push (content-available): iOS already applied `aps.badge` on delivery. If
    /// it named sessions whose approval was handled elsewhere, drop their now-stale delivered
    /// banners too so Notification Center matches the badge. See docs/cross-platform-badge-sync.md.
    func application(_ application: UIApplication,
                     didReceiveRemoteNotification userInfo: [AnyHashable: Any],
                     fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        guard let ids = userInfo["clearSessions"] as? [String], !ids.isEmpty else {
            completionHandler(.noData)
            return
        }
        let sessions = Set(ids)
        NotificationManager.removeDeliveredApprovals(where: { sessions.contains($0) })
        completionHandler(.newData)
    }
}

extension AppModel {
    /// Register this device for "needs your reply" pushes. Call once the user is signed in: builds an
    /// API client from the current instance and reports the APNs token (hex) the delegate captures.
    /// Reads `baseURL`/`tokenStore` (both module-visible) so it doesn't need `AppModel`'s private api.
    func enablePush() {
        guard let baseURL else { return }
        let api = APIClient(baseURL: baseURL, tokenStore: tokenStore)
        let bundleId = Bundle.main.bundleIdentifier ?? "io.orbitd.app"
        PushRegistrar.shared.setReporter { tokenData in
            let hex = tokenData.map { String(format: "%02x", $0) }.joined()
            try? await api.registerDeviceToken(
                DeviceTokenRequest(token: hex, environment: PushRegistrar.environment, bundleId: bundleId))
        }
        PushRegistrar.shared.start()
    }
}
#endif
