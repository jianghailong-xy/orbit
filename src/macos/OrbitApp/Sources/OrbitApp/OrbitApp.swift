import SwiftUI

@main
struct OrbitApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .frame(minWidth: 820, minHeight: 520)
                .onOpenURL { url in
                    if let route = DeepLink.parse(url) { model.route(to: route) }
                }
                .task { model.bootstrap() }
        }
        .defaultSize(width: 1100, height: 720)

        // Always-present menu-bar item: glanceable summary + quick jump into "needs you".
        MenuBarExtra {
            MenuBarContent().environment(model)
        } label: {
            if let badge = model.menuSummary.badge {
                Label(badge, systemImage: "circle.hexagongrid.fill")
            } else {
                Image(systemName: "circle.hexagongrid")
            }
        }
        .menuBarExtraStyle(.window)
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
