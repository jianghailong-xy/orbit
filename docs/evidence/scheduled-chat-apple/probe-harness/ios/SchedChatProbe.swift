import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../README.md): the iOS app's own shells, picked as OrbitiOSApp's RootView picks them —
// CompactShell on an iPhone, MainView's split on an iPad at a regular width — pointed at stub.py with
// `-orbit.instance`, opened on Scheduled.
@main
struct SchedChatProbeApp: App {
    @State private var model: AppModel

    init() {
        ProbeArgs.wipeIfFresh()
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            ProbeRoot()
                .environment(model)
                .preferredColorScheme(ProbeArgs.dark ? .dark : .light)
                .task { await ProbeArgs.land(model) }
        }
    }
}

private struct ProbeRoot: View {
    @Environment(\.horizontalSizeClass) private var hSize

    var body: some View {
        if hSize == .compact { CompactShell() } else { MainView() }
    }
}
