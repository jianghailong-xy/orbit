import SwiftUI
import OrbitKit

/// The iOS app shell. It mirrors the macOS `OrbitApp` entry's lifecycle — bootstrap the model,
/// route `orbit://` deep links, and checkpoint open transcripts when backgrounded — but drops
/// every macOS-only scene: there is no menu-bar tray, no `Settings`/`Window` scene, no ⌥Space
/// global hotkey, no Sparkle updater, and no local-runner control (the iOS sandbox forbids
/// controlling a launchd service, so the iOS client is a pure remote console).
///
/// The adaptive iPhone/iPad navigation is Phase C. For now `RootView` reuses the shared
/// `MainView` (a `NavigationSplitView`) — already usable on iPad and collapsed-but-functional on
/// iPhone — so Phase B stands the app up end to end before the navigation is polished.
@main
struct OrbitiOSApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase
    // The only reliable way to receive the APNs device token in a SwiftUI app (see Push.swift).
    @UIApplicationDelegateAdaptor(PushDelegate.self) private var pushDelegate

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                // Honor the saved Theme preference (System/Light/Dark) app-wide. Without this the
                // dynamic color tokens follow the device appearance only, so the picker did nothing.
                .preferredColorScheme(model.preferredColorScheme)
                // The type ramp (Views/Typography.swift) tracks Dynamic Type; cap it at the first
                // accessibility sizes so a dense console layout (tool cards, diffs, the composer
                // footer) degrades gracefully instead of exploding at AX5. Larger needs are better
                // served by system zoom until the layout is audited per-surface.
                .dynamicTypeSize(...DynamicTypeSize.accessibility2)
                // Tap anywhere outside a text field to lower the keyboard (installed once on the
                // window). The transcript's `List` swallows a SwiftUI tap gesture, so this is done
                // with a window-level UIKit recognizer instead.
                .dismissesKeyboardOnBackgroundTap()
                .onOpenURL { url in
                    if let route = DeepLink.parse(url) { model.route(to: route) }
                }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active {
                        // Returning to the foreground: a stream socket suspended in the background may
                        // be dead but not yet erroring, so kick the open consoles to reconnect promptly
                        // instead of waiting out URLSession's long read timeout.
                        model.consoleRegistry?.reconnectAll()
                        // Same for the user-level control-plane stream that keeps the lists fresh.
                        model.kickControlPlane()
                    } else {
                        // iOS can suspend/terminate at will, so checkpoint the moment we leave the
                        // foreground rather than relying on a clean quit.
                        model.consoleRegistry?.persistAll()
                    }
                }
                .task { model.bootstrap() }
        }
    }
}

/// Sign-in gate. Defined here (not shared) because the macOS `RootView` lives in the excluded
/// `OrbitApp.swift`. Once signed in, the shell adapts to width: iPhone (compact) gets a left-drawer
/// shell (`CompactShell`), iPad (regular) keeps `MainView`'s three-column split.
private struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.horizontalSizeClass) private var hSize
    var body: some View {
        if model.signedIn {
            Group {
                if hSize == .compact { CompactShell() } else { MainView() }
            }
            // Register for "needs your reply" pushes once signed in (idempotent).
            .task { model.enablePush() }
            .sessionSearchSheet(model)
        } else {
            LoginView()
        }
    }
}
