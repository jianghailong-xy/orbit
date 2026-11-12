import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (never merged): the iPhone app's own CompactShell, pointed at stub.py with
// `-orbit.instance`, opened on a session held by its runner's update (or on the session list).
@main
struct RupProbeApp: App {
    @State private var model: AppModel

    init() {
        ProbeArgs.wipeIfFresh()
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            ProbeRoot(model: model)
                .environment(model)
                .dismissesKeyboardOnBackgroundTap()
                .task { await ProbeArgs.land(model) }
        }
    }
}

/// The signed-in root the real app draws (`RootView` in OrbitiOSApp.swift, which the probe replaces).
private struct ProbeRoot: View {
    let model: AppModel

    var body: some View {
        CompactShell().settingsSheet(model)
    }
}
