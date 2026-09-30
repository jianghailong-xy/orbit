import SwiftUI

// TEMPORARY evidence probe (see ../../README.md): the iPhone app is the probe's root and nothing else.
@main
struct StartProbeApp: App {
    var body: some Scene {
        WindowGroup { ProbeRoot() }
    }
}
