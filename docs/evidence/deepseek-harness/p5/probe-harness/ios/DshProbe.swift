import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../README.md): the iPhone app's own CompactShell, pointed at stub.py
// with `-orbit.instance`, opened at one place per launch: `-probe.surface compose|console`,
// `-probe.agent <id>`, `-probe.session <id>`; `-dark` for dark.
@main
struct DshProbeApp: App {
    @State private var model: AppModel

    init() {
        ProbeArgs.wipeIfFresh()
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            CompactShell()
                .environment(model)
                .preferredColorScheme(ProbeArgs.dark ? .dark : .light)
                .task { await ProbeArgs.land(model) }
        }
    }
}
