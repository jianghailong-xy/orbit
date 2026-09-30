import SwiftUI
import OrbitKit

// A runner's name, one push from About This Runner › Name (ios-detail.png ⑥) — a page of its own, as a
// device's name is in Settings, in place of the text field and Rename button the record used to
// carry. What is typed is saved on Return and on the way back; left empty, the runner goes back to
// its machine's own name (the web's Rename dialog, in its words).

/// The name page for the runner `runnerID` — the frame `NavNode.runnerName` names.
struct RunnerNamePage: View {
    @Environment(AppModel.self) private var model
    let runnerID: String

    var body: some View {
        if let runners = model.runners, let runner = runners.runner(runnerID) {
            RunnerNameForm(runners: runners, runner: runner)
        } else {
            ContentUnavailableView(RunnerPageCopy.RUNNER_ABOUT_NAME, systemImage: "desktopcomputer",
                                   description: Text("This runner is no longer on your account."))
        }
    }
}

private struct RunnerNameForm: View {
    let runners: RunnersModel
    let runner: Runner
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var seeded = false
    /// Saved once, whether by Return or by leaving.
    @State private var saved = false
    @FocusState private var focused: Bool

    var body: some View {
        Form {
            Section {
                TextField(runner.name, text: $name)
                    .focused($focused)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .onSubmit {
                        save()
                        dismiss()
                    }
            } footer: {
                Text("Leave empty to use the machine name (\(runner.name)).")
            }
        }
        .formStyle(.grouped)
        .orbitRevealSurface()   // macOS: reveal the unified `orbitSurface` behind the grouped form
        .navigationTitle(RunnerPageCopy.RUNNER_ABOUT_NAME)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .onAppear {
            guard !seeded else { return }
            seeded = true
            name = RunnerPageFormat.displayName(runner)
            focused = true
        }
        .onDisappear(perform: save)
    }

    /// Only a name that changed is sent; an empty one clears the alias.
    private func save() {
        let typed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard seeded, !saved, typed != RunnerPageFormat.displayName(runner) else { return }
        saved = true
        let id = runner.id
        Task { await runners.rename(id, typed) }
    }
}
