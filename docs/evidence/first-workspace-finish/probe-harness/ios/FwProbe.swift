import SwiftUI
import UIKit
import OrbitKit

// Evidence probe (see ../README.md): the app's own iPhone and iPad shells, pointed at stub.py with
// `-orbit.instance`, as OrbitiOSApp picks between them by the width it has.
@main
struct FwProbeApp: App {
    @State private var model: AppModel

    init() {
        ProbeArgs.wipeIfFresh()
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if UIDevice.current.userInterfaceIdiom == .pad {
                    MainView()
                } else {
                    CompactShell()
                }
            }
            .settingsSheet(model)
            .preferredColorScheme(ProbeArgs.scheme)
            .environment(model)
            .task { await ProbeArgs.land(model) }
        }
    }
}
