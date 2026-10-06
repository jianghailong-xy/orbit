import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../README.md): the iPhone app's own LoginView and AppModel behind its
// sign-in gate, pointed at stub.py with `-orbit.instance`.
@main
struct A1ProbeApp: App {
    @State private var model: AppModel

    init() {
        ProbeArgs.signOut()
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
