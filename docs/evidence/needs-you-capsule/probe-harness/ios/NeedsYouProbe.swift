import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../README.md): the iPhone app's own CompactShell, pointed at stub.py
// with `-orbit.instance`, opened on the page `-probe.page` names — a conversation (the capsule
// pointing elsewhere), the project's coordinator conversation (the capsule pointing into it), or the
// session list. `-dark` draws it dark, as the account's theme would (`OrbitiOSApp`'s
// `.preferredColorScheme`).
@main
struct NeedsYouProbeApp: App {
    @State private var model: AppModel

    init() {
        ProbeArgs.wipeIfFresh()
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            CompactShell()
                .environment(model)
                .preferredColorScheme(ProcessInfo.processInfo.arguments.contains("-dark") ? .dark : .light)
                .task { await ProbeArgs.land(model) }
        }
    }
}
