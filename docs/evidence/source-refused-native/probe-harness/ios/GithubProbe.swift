import SwiftUI
import OrbitKit

// TEMPORARY evidence probe: the iPhone app's own CompactShell, pointed at stub.py with `-orbit.instance`.
@main
struct GithubProbeApp: App {
    @State private var model: AppModel

    init() {
        ProbeArgs.wipeIfFresh()
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            CompactShell()
                .settingsSheet(model)
                .environment(model)
                .task { await ProbeArgs.land(model) }
        }
    }
}
