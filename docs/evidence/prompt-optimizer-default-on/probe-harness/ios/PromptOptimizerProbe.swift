import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../README.md): the iPhone app's own CompactShell, pointed at stub.py
// with `-orbit.instance`, opened on the page `-probe.page` names: Settings, or conversation C1 with
// a draft in its composer (prompt optimizer, board docs/mocks/prompt-optimizer).
@main
struct PromptOptimizerProbeApp: App {
    @State private var model: AppModel

    init() {
        ProbeArgs.wipeIfFresh()
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            // As OrbitiOSApp's RootView: the Settings sheet inside, the model's environment outermost.
            CompactShell()
                .settingsSheet(model)
                .environment(model)
                .task { await ProbeArgs.land(model) }
        }
    }
}
