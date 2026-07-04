import SwiftUI
import AppKit
import OrbitKit

@main
struct OrbitApp: App {
    /// Window id for the runner-manager window, opened from the menu-bar tray's "Manage…".
    static let runnerWindowID = "runner-manager"

    @State private var model = AppModel()
    @StateObject private var updater = UpdaterModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .environmentObject(updater)
                .frame(minWidth: 820, minHeight: 520)
                .hidesTitlebarSeparator()   // seamless, ChatGPT-style floating top (no hard rule)
                .onOpenURL { url in
                    if let route = DeepLink.parse(url) { model.route(to: route) }
                }
                .onChange(of: scenePhase) { _, phase in
                    // Checkpoint open transcripts when the app leaves the foreground.
                    if phase != .active { model.consoleRegistry?.persistAll() }
                }
                .task {
                    model.bootstrap()
                    HotKeyManager.register { HotKeyManager.summonApp() }   // ⌥Space summons Orbit
                }
        }
        .defaultSize(width: 1100, height: 720)
        .commands {
            // ⌘N → New Session for the current agent. Replaces SwiftUI's default File ▸ New Window
            // (Orbit is single-window), so the standard "New" slot now starts a session instead.
            CommandGroup(replacing: .newItem) {
                Button("New Session") { model.newSessionInCurrentAgent() }
                    .keyboardShortcut("n", modifiers: .command)
                    .disabled(!model.signedIn || model.orderedAgents.isEmpty)
            }
            // ⌘D → complete (archive) the open session, the keyboard twin of the web's ✓ on a
            // session row. Disabled unless a session's console is actually showing.
            CommandGroup(after: .newItem) {
                Button("Complete Session") { model.completeCurrentSession() }
                    .keyboardShortcut("d", modifiers: .command)
                    .disabled(!model.signedIn || model.currentSessionID == nil)
            }
            // Standard "Check for Updates…" in the app menu (right after "About Orbit").
            CommandGroup(after: .appInfo) {
                Button("Check for Updates…") { updater.checkForUpdates() }
                    .disabled(!updater.canCheckForUpdates)
            }
            // ⌘⇧F → toggle the main window in/out of full screen. macOS's built-in "Enter Full
            // Screen" lives in the View menu under ⌃⌘F; this adds the ⌘⇧F combo as well and keeps
            // it next to the system item.
            CommandGroup(after: .sidebar) {
                Button("Toggle Full Screen") {
                    (NSApp.keyWindow ?? NSApp.mainWindow)?.toggleFullScreen(nil)
                }
                .keyboardShortcut("f", modifiers: [.command, .shift])
            }
            // ⌘1…⌘9 → jump to the Nth agent in sidebar order. Registered as menu commands so the
            // shortcuts fire from any view (not just the sidebar) and are discoverable in the menu
            // bar. The list past nine agents is reachable from the sidebar only.
            CommandMenu("Go") {
                ForEach(Array(model.orderedAgents.prefix(9).enumerated()), id: \.element.id) { pair in
                    Button("\(pair.offset + 1)  \(pair.element.name)") {
                        model.selectAgent(at: pair.offset)
                    }
                    .keyboardShortcut(KeyEquivalent(Character("\(pair.offset + 1)")), modifiers: .command)
                }
            }
        }

        // Standard macOS Settings window — adds "Settings…" (⌘,) to the app menu. Reuses the same
        // SettingsView as the in-app Settings section so both stay in sync.
        Settings {
            SettingsView()
                .environment(model)
                .environmentObject(updater)
                .frame(width: 480, height: 560)
        }

        // The local-runner manager (log + enroll + Start/Stop). A dedicated window — not a sheet —
        // so the menu-bar tray's "Manage…" can open it whether or not the main window is around.
        Window("Local runner", id: Self.runnerWindowID) {
            RunnerManagerWindow().environment(model)
        }

        // Always-present menu-bar item: glanceable summary + quick jump into "needs you".
        MenuBarExtra {
            MenuBarContent().environment(model)
        } label: {
            if let badge = model.menuSummary.badge {
                Label(badge, systemImage: "circle.hexagongrid.fill")
            } else {
                Image(systemName: "circle.hexagongrid")
            }
        }
        .menuBarExtraStyle(.window)
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        if model.signedIn {
            MainView()
        } else {
            LoginView()
        }
    }
}
