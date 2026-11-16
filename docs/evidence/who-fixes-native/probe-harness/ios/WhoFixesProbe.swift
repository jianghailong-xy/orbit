import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (never merged): the iPhone app's AppModel, pointed at stub.py with
// `-orbit.instance`, drawing nothing but the real owner exception card at the phone's width.
// ios-shot.sh photographs the simulator's screen (`simctl io … screenshot`).
@main
struct WhoFixesProbeApp: App {
    @State private var model: AppModel

    init() {
        ProbeArgs.wipeIfFresh()
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            ProbeCardPage(width: nil)
                .environment(model)
        }
    }
}
