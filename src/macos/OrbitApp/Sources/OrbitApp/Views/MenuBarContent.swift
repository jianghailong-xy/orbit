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
                    .buttonStyle(MenuRowButtonStyle())
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
                                // `.opacity` (not `.secondary`) so the subtitle tracks the row's
                                // foreground and dims to white-on-accent when the row highlights.
                                Text(item.subtitle).font(.caption).opacity(0.6)
                            }
                        }
                        .buttonStyle(MenuRowButtonStyle())
                    }
                }
                if let control = model.runnerControl {
                    Divider()
                    RunnerTraySection(control: control)
                }
            }
            Divider()
            // Native menu-item-style Quit row (à la OrbStack): full-width row with the ⌘Q hint
            // trailing and an accent hover highlight. ⌘Q itself is already wired by SwiftUI's
            // standard app menu. The ⌘Q opacity (not `.secondary`) lets it track the row's
            // foreground so it turns white-dim when the row highlights.
            Button { NSApp.terminate(nil) } label: {
                HStack(spacing: 8) {
                    Text("Quit Orbit")
                    Spacer(minLength: 12)
                    Text("⌘Q").opacity(0.55)
                }
            }
            .buttonStyle(MenuRowButtonStyle())
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

/// A native-menu-style row: transparent at rest, accent highlight + white text on hover, like a
/// real `NSMenuItem`. The `.window`-style `MenuBarExtra` (which we need for the runner controls)
/// doesn't get AppKit's free menu hover highlight, so `.buttonStyle(.plain)` rows feel dead —
/// this restores it. Nested `Row` carries the hover `@State`, since a ButtonStyle struct can't.
struct MenuRowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Row(configuration: configuration)
    }

    private struct Row: View {
        let configuration: Configuration
        @State private var hovering = false

        var body: some View {
            configuration.label
                .padding(.horizontal, 6)
                .padding(.vertical, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .foregroundStyle(hovering ? AnyShapeStyle(.white) : AnyShapeStyle(.primary))
                .background(
                    RoundedRectangle(cornerRadius: 5)
                        .fill(hovering ? Color.accentColor : .clear)
                )
                .contentShape(Rectangle())
                .opacity(configuration.isPressed ? 0.7 : 1)
                .onHover { hovering = $0 }
        }
    }
}

/// The local-runner status block in the menu-bar dropdown — the runner's home now that it's off the
/// window toolbar. Glanceable state + Start/Stop/Restart for the runner on this Mac, plus "Manage…"
/// for the detailed window (log + enroll). Refreshes its launchd/server state each time the menu
/// opens. Hidden entirely when this Mac hosts no runner config (only "Set up…" remains).
private struct RunnerTraySection: View {
    let control: RunnerControl
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Runner").font(.caption).foregroundStyle(.secondary)
            HStack(spacing: 8) {
                Circle().fill(control.status.running ? .green : .secondary).frame(width: 8, height: 8)
                Text(control.hasLocalRunner ? (control.config?.name ?? "Runner") : "No runner on this Mac")
                    .fontWeight(.medium).lineLimit(1)
                Spacer(minLength: 4)
                Text(LocalRunnerStatus.line(hasConfig: control.hasLocalRunner, installed: control.serviceInstalled, status: control.status))
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            if control.hasLocalRunner {
                HStack(spacing: 6) {
                    Button("Start") { Task { await control.start() } }.disabled(control.status.running)
                    Button("Stop") { Task { await control.stop() } }.disabled(!control.status.running)
                    Button("Restart") { Task { await control.restart() } }.disabled(!control.status.running)
                    Spacer(minLength: 0)
                    Button("Manage…") { openManager() }
                }
                .controlSize(.small)
            } else {
                Button("Set up runner…") { openManager() }
                    .controlSize(.small)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task { await control.refresh() }
    }

    private func openManager() {
        openWindow(id: OrbitApp.runnerWindowID)
        NSApp.activate(ignoringOtherApps: true)
    }
}
