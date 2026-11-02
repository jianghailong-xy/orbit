import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (the recap card's ⋯, never merged): the iPhone app's own CompactShell, pointed at stub.py
// with `-orbit.instance`, opened on one conversation per launch: `-probe.session <id>`.
@main
struct RcpProbeApp: App {
    @State private var model: AppModel

    init() {
        ProbeArgs.wipeIfFresh()
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            if let kind = ProbeArgs.value("-probe.sweep") {
                RcpSweep(kind: kind)
                    .environment(model)
                    .preferredColorScheme(.light)
            } else {
                CompactShell()
                    .environment(model)
                    .preferredColorScheme(ProbeArgs.dark ? .dark : .light)
                    .task { await ProbeArgs.land(model) }
            }
        }
    }
}
