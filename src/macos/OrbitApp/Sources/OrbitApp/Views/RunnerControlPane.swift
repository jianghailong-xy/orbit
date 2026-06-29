import SwiftUI
import OrbitKit

/// Content of the runner-manager `Window` (opened from the menu-bar tray). Binds to the app's
/// shared `RunnerControl`; before sign-in there's no instance, so it prompts to sign in.
struct RunnerManagerWindow: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let control = model.runnerControl {
            RunnerControlPane(control: control)
        } else {
            ContentUnavailableView("Sign in to manage the runner",
                                   systemImage: "desktopcomputer")
                .frame(minWidth: 540, minHeight: 480)
        }
    }
}

/// The local-runner pane (Phase 4): detect → status + Start/Stop/Restart + live log, or enroll
/// this Mac if no runner is configured here. Shown in the runner-manager window, opened from the
/// menu-bar tray; drives the shared `RunnerControl` so its state stays in sync with the tray.
struct RunnerControlPane: View {
    let control: RunnerControl
    @State private var enrollName = Host.current().localizedName ?? "My Mac"
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if control.hasLocalRunner { detected(control) } else { notDetected(control) }
            }
            .navigationTitle("Local runner")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .frame(minWidth: 540, minHeight: 480)
        .task { await control.refresh() }
    }

    @ViewBuilder
    private func detected(_ c: RunnerControl) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 10) {
                    Circle().fill(c.status.running ? .green : .secondary).frame(width: 10, height: 10)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(c.config?.name ?? "runner").font(.headline)
                        Text(c.config?.serverUrl ?? "").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text(LocalRunnerStatus.line(hasConfig: c.hasLocalRunner, status: c.status))
                        .font(.callout).foregroundStyle(.secondary)
                }

                if let r = c.serverRunner {
                    HStack(spacing: 16) {
                        Label(r.online == true ? "Online" : "Offline",
                              systemImage: "dot.radiowaves.left.and.right")
                        if let v = r.version { Text("v\(v)").foregroundStyle(.secondary) }
                        if let mc = r.maxConcurrent { Text("\(mc) slots").foregroundStyle(.secondary) }
                    }
                    .font(.caption)
                }

                HStack {
                    Button { Task { await c.start() } } label: { Label("Start", systemImage: "play.fill") }
                        .disabled(c.status.running)
                    Button { Task { await c.stop() } } label: { Label("Stop", systemImage: "stop.fill") }
                        .disabled(!c.status.running)
                    Button { Task { await c.restart() } } label: { Label("Restart", systemImage: "arrow.clockwise") }
                    Spacer()
                    Button { Task { await c.refresh() } } label: { Image(systemName: "arrow.clockwise.circle") }
                        .help("Refresh")
                }

                Divider()
                Text("Log").font(.headline)
                ScrollView {
                    Text(c.logLines.isEmpty ? "(no log yet)" : c.logLines.joined(separator: "\n"))
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(6)
                }
                .frame(maxHeight: 220)
                .background(.gray.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))

                if let m = c.message { Text(m).font(.caption).foregroundStyle(.secondary) }
            }
            .padding()
        }
    }

    @ViewBuilder
    private func notDetected(_ c: RunnerControl) -> some View {
        VStack(spacing: 14) {
            Image(systemName: "desktopcomputer").font(.system(size: 40)).foregroundStyle(.secondary)
            Text("No runner on this Mac").font(.headline)
            Text("Enroll this Mac to run agents here. Enrollment fetches a credential and writes "
                 + "~/.orbit/config.json; install the runner service with orbit register / install.sh to start it.")
                .font(.callout).foregroundStyle(.secondary)
                .multilineTextAlignment(.center).frame(maxWidth: 400)
            TextField("Runner name", text: $enrollName).textFieldStyle(.roundedBorder).frame(width: 240)
            if let code = c.enrollUserCode {
                Text("Approval code: \(code)").font(.callout.monospaced())
            }
            Button { Task { await c.enroll(name: enrollName) } } label: {
                Text(c.enrolling ? "Enrolling…" : "Enroll this Mac").frame(width: 180)
            }
            .buttonStyle(.borderedProminent)
            .disabled(c.enrolling || enrollName.isEmpty)
            if let m = c.message {
                Text(m).font(.caption).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center).frame(maxWidth: 400)
            }
        }
        .padding(30)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
