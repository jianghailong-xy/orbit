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

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .onOpenURL { url in
                    if let route = DeepLink.parse(url) { model.route(to: route) }
                }
                .onChange(of: scenePhase) { _, phase in
                    // iOS can suspend/terminate at will, so checkpoint the moment we leave the
                    // foreground rather than relying on a clean quit.
                    if phase != .active { model.consoleRegistry?.persistAll() }
                }
                .task { model.bootstrap() }
        }
    }
}

/// Sign-in gate. Defined here (not shared) because the macOS `RootView` lives in the excluded
/// `OrbitApp.swift`; both are the same two lines over the shared `MainView` / `LoginView`.
private struct RootView: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        if model.signedIn { MainView() } else { LoginView() }
    }
}
