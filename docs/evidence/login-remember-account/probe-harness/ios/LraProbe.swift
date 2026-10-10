import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../README.md): the iPhone app's LoginView behind its sign-in gate,
// pointed at stub.py with `-orbit.instance`, seeded per launch (ProbeArgs.seed); `-dark 1` for dark.
@main
struct LraProbeApp: App {
    @State private var model: AppModel

    init() {
        ProbeArgs.seed()
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            ProbeRoot()
                .environment(model)
                .preferredColorScheme(ProbeArgs.dark ? .dark : .light)
        }
    }
}
