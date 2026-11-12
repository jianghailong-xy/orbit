import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../README.md): the iPhone app's own CompactShell with its Settings sheet, as
// OrbitiOSApp's RootView puts it, pointed at stub.py with `-orbit.instance`.
@main
struct TmProbeApp: App {
    @State private var model: AppModel

    init() {
        ProbeArgs.wipeIfFresh()
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            ProbeRoot(model: model)
                .environment(model)
                .preferredColorScheme(ProbeArgs.dark ? .dark : .light)
                .task { await ProbeArgs.land(model) }
        }
    }
}

private struct ProbeRoot: View {
    let model: AppModel
    var body: some View { CompactShell().settingsSheet(model) }
}
