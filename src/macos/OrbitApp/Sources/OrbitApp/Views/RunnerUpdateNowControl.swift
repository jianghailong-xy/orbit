import SwiftUI
import OrbitKit

/// Update Now… (docs/runner-update-drain-design.md §2, D4): install the waiting release now,
/// interrupting the reader's turns in flight, which continue once the runner is back. The one button
/// that interrupts work, so it asks first through `orbitConfirmation` (an alert on a phone, the panel
/// on a tablet and a Mac): `Update studio-mac now?`, what it does, each turn and how long it has run,
/// the jobs note, and the cost on the red button (`Interrupt 2 Turns and Update`). Drawn only for a
/// runner that declares `self-update-now/v1` with a release waiting (`RunnerUpdateNow.offered`); the
/// runner page keeps Update Runner Now for one that does not. The runners are read again when it is
/// pressed, so the turns it names are as of the press.
struct RunnerUpdateNowControl: View {
    @Environment(AppModel.self) private var app
    let runnerID: String
    /// The name the reader knows the runner by; the runner's own when nil.
    var machine: String?
    /// Told `Restarting into 0.1.254…` once the server took it; nil draws it under the button.
    var onNotice: ((String) -> Void)? = nil
    @State private var asking: RunnerUpdateNow.Confirmation?
    @State private var busy = false
    @State private var failure: String?
    @State private var done: String?

    private var runner: Runner? { app.runners?.runner(runnerID) }

    var body: some View {
        VStack(spacing: 4) {
            if let runner, RunnerUpdateNow.offered(runner) {
                button
            }
            // Once taken the runner restarts and the button goes; what it is doing stays said.
            if let done {
                Text(done).font(.footnote).foregroundStyle(.secondary)
            }
        }
        // A session page can open before any runners page read the list: read it once for this one.
        .task(id: runnerID) {
            if app.runners?.runner(runnerID) == nil { await app.runners?.load() }
        }
    }

    private var button: some View {
        Button { ask() } label: {
            #if os(iOS)
            Text(RunnerPageCopy.RUNNER_UPDATE_NOW).frame(maxWidth: .infinity)
            #else
            Text(RunnerPageCopy.RUNNER_UPDATE_NOW)
            #endif
        }
        .buttonStyle(.bordered)
        .disabled(busy)
        .accessibilityIdentifier("runner-update-now")
        .orbitConfirmation({ $0.title }, isPresented: askingShown, presenting: asking) { confirmation in
            Button(confirmation.confirm, role: .destructive) { update(confirmation) }
            Button("Cancel", role: .cancel) {}
        } message: { confirmation in
            Text(confirmation.message)
        }
        .alert(RunnerPageCopy.RUNNER_UPDATE_NOW_FAILED, isPresented: Binding(
            get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("OK", role: .cancel) { failure = nil }
        } message: {
            Text(failure ?? "")
        }
    }

    private var askingShown: Binding<Bool> {
        Binding(get: { asking != nil }, set: { if !$0 { asking = nil } })
    }

    /// Read the runner again, then ask about the turns running now.
    private func ask() {
        busy = true
        Task {
            await app.runners?.load()
            busy = false
            guard let runner else { return }
            asking = RunnerUpdateNow.confirmation(runner, machine: machine ?? RunnerPageFormat.displayName(runner),
                                                  now: Date())
        }
    }

    private func update(_ confirmation: RunnerUpdateNow.Confirmation) {
        busy = true
        Task {
            if let reason = await app.runners?.updateNow(runnerID) {
                failure = reason
            } else {
                let toast = RunnerPageCopy.runnerUpdateNowToast(version: confirmation.version)
                if let onNotice { onNotice(toast) } else { done = toast }
            }
            busy = false
        }
    }
}
