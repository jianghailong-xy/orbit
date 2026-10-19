import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../README.md): the iPhone app's own CompactShell, pointed at stub.py
// with `-orbit.instance`, opened on the project page whose Work overview carries the Landing card.
@main
struct LandingLivenessProbeApp: App {
    @State private var model: AppModel

    init() {
        ProbeArgs.wipeIfFresh()
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            CompactShell()
                .environment(model)
                .task {
                    // This probe only ever photographs the project page's landing card.
                    await ProbeArgs.landOnProject(model)
                }
        }
    }
}
