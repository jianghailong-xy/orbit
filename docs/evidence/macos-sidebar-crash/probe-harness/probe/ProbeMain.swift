import SwiftUI
import AppKit
import OrbitKit

// The real app's window over the real shared sources. `OrbitApp.swift` is replaced only so this
// probe can run a click driver inside the process: XCUITest's automation mode needs owner
// authentication on this Mac ("Timed out while enabling automation mode"), and a SwiftUI
// `WindowGroup` never receives a window under the runner's Aqua-session launch (`!cgsConnection`
// until the job is bootstrapped into `gui/$UID`, and after that no scene is ever instantiated). The
// window is therefore made by AppKit, hosting the same `MainView`/`LoginView` the real shell draws.
@main
struct SidebarProbeApp: App {
    @NSApplicationDelegateAdaptor(ProbeDelegate.self) private var delegate

    var body: some Scene {
        // Only a menu-bar-free app with no window scene: ProbeDelegate owns the window.
        Settings { EmptyView() }
    }
}

@MainActor
final class ProbeDelegate: NSObject, NSApplicationDelegate {
    private let model = AppModel()
    private let updater = UpdaterModel()
    private var window: NSWindow?
    private var host: NSHostingController<AnyView>?

    func applicationDidFinishLaunching(_ notification: Notification) {
        SidebarDriver.mark("didFinishLaunching policy=\(NSApp.activationPolicy().rawValue)")
        NSApp.setActivationPolicy(.regular)
        let host = NSHostingController(rootView: AnyView(ProbeRoot()
            .environment(model)
            .environmentObject(updater)
            .preferredColorScheme(model.preferredColorScheme)))
        host.sizingOptions = []
        let window = NSWindow(contentRect: NSRect(x: 40, y: 40, width: 1100, height: 720),
                              styleMask: [.titled, .closable, .resizable],
                              backing: .buffered, defer: false)
        window.title = "Orbit"
        window.contentViewController = host
        window.setContentSize(NSSize(width: 1100, height: 720))
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
        self.host = host
        // SwiftUI's hosting controller sizes itself to the view's fitting size on the first pass;
        // give the window its real size again once that pass has run.
        DispatchQueue.main.async {
            window.setFrame(NSRect(x: 40, y: 40, width: 1100, height: 720), display: true)
        }
        SidebarDriver.mark("window=\(window.frame) visible=\(window.isVisible) windows=\(NSApp.windows.count)")
        SidebarDriver.mark("viewtree: \(SidebarDriver.viewTree(window))")

        model.bootstrap()
        Task { @MainActor in
            await SidebarDriver.run(model, window: window)
        }
    }
}

/// The real shell's one decision, in a real `View` body so the read of `signedIn` is tracked and the
/// window swaps the login page for `MainView` when the driver signs in.
struct ProbeRoot: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            if model.signedIn {
                MainView()
            } else {
                LoginView()
            }
        }
        .frame(minWidth: 820, minHeight: 520)
    }
}
