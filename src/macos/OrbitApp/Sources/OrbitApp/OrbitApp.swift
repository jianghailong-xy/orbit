import SwiftUI

@main
struct OrbitApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .frame(minWidth: 820, minHeight: 520)
        }
        .defaultSize(width: 1100, height: 720)
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        if model.signedIn {
            MainView()
        } else {
            LoginView()
        }
    }
}
