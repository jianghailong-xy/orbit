import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (task 34vZvzdK0NZaSo0JNQ2ES): the iPhone app's own CompactShell (or the workspace
// settings form), pointed at stub.py with `-orbit.instance`.
@main
struct McProbeApp: App {
    @State private var model: AppModel

    init() {
        ProbeArgs.wipeIfFresh()
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if ProbeArgs.form { ProbeForm() } else { CompactShell() }
            }
            .environment(model)
            .preferredColorScheme(.light)
            .task { await ProbeArgs.land(model) }
        }
    }
}
