import SwiftUI
import AppKit
import OrbitKit

/// The dropdown shown from the menu-bar item: a glanceable summary + quick jump into the
/// sessions that need you. Content comes from `AppModel.menuSummary` (derived by OrbitKit's
/// `MenuBar.summary`).
struct MenuBarContent: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !model.signedIn {
                Text("Not signed in").foregroundStyle(.secondary)
                Button("Open Orbit") { activate() }
            } else {
                Text(headline).font(.headline)
                Divider()
                if model.menuSummary.items.isEmpty {
                    Text("No active sessions").foregroundStyle(.secondary).font(.callout)
                } else {
                    ForEach(model.menuSummary.items) { item in
                        Button { open(item.route) } label: {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(item.title).lineLimit(1)
                                Text(item.subtitle).font(.caption).foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
                Divider()
                Button("Open Orbit") { activate() }
                Button("Quit") { NSApp.terminate(nil) }
            }
        }
        .padding(12)
        .frame(width: 300)
    }

    private var headline: String {
        let s = model.menuSummary
        if s.needsYou > 0 { return "\(s.needsYou) need\(s.needsYou == 1 ? "s" : "") you · \(s.running) running" }
        return "\(s.running) running · \(s.queued) queued"
    }

    private func open(_ route: Route) {
        model.route(to: route)
        activate()
    }

    private func activate() {
        NSApp.activate(ignoringOtherApps: true)
    }
}
