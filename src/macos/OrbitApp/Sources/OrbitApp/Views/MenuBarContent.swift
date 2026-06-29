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
                if let control = model.runnerControl {
                    Divider()
                    RunnerTraySection(control: control)
                }
                Divider()
                Button("Open Orbit") { activate() }
            }
            Divider()
            Button("Quit Orbit") { NSApp.terminate(nil) }
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
                Text(LocalRunnerStatus.line(hasConfig: control.hasLocalRunner, status: control.status))
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
