import SwiftUI
import UIKit
import OrbitKit

// TEMPORARY evidence probe (see ../README.md): the iPhone app's own CompactShell (and the iPad's MainView),
// pointed at stub.py with `-orbit.instance`, as OrbitiOSApp picks between them by the width it has.
@main
struct NwProbeApp: App {
    @State private var model: AppModel

    init() {
        ProbeArgs.wipe()
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
