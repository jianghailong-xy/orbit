import SwiftUI
import OrbitKit

// Evidence probe (see ../README.md): the iPhone app's own CompactShell — or, for `-probe.scene
// drawer`, its own NavigationDrawer as the phone draws it open — pointed at stub.py.
@main
struct GuestProbeApp: App {
    @State private var model: AppModel

    init() {
        ProbeArgs.wipeIfFresh()
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if ProbeArgs.scene == "drawer" {
                    NavigationDrawer(close: {}, live: true)
                } else {
                    CompactShell()
                }
            }
            .environment(model)
            .task { await ProbeArgs.land(model) }
        }
    }
}
