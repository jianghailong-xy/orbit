import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../README.md): the iPhone app's own CompactShell, pointed at stub.py
// with `-orbit.instance`, opened on a session the stub says never started.
@main
struct RunStartProbeApp: App {
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
                    let args = ProcessInfo.processInfo.arguments
                    if args.contains("-probe.project") { await ProbeArgs.landOnProject(model) }
                    else { await ProbeArgs.land(model, session: probeSession) }
                }
        }
    }

    private var probeSession: String {
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "-probe.session"), args.count > i + 1 { return args[i + 1] }
        return "S1"
    }
}
