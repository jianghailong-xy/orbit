import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (never merged): the iPhone app's own CompactShell, pointed at stub.py with
// `-orbit.instance` and opened on session S1's console, whose last turn left a suggestion in the empty
// composer; `-dark` for dark.
@main
struct DTapProbeApp: App {
    @State private var model: AppModel

    init() {
        ProbeArgs.wipeIfFresh()
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            CompactShell()
                .settingsSheet(model)
                .preferredColorScheme(ProbeArgs.dark ? .dark : .light)
                .environment(model)
                .task { await ProbeArgs.land(model) }
        }
    }
}
