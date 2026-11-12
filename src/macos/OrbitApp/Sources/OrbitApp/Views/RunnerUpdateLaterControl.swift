import SwiftUI
import OrbitKit

/// Later ▾ (docs/runner-update-drain-design.md §2): put the update a runner drains for off for an
/// hour, until tonight 02:00 or until tomorrow 09:00. The Mac draws the web's menu (board 3 ⑦); iOS
/// draws board 5's action sheet. `change` is the postponed card's Change ▾. The runner ends its drain
/// at once; the runners are read again so the card and what waited move on.
struct RunnerUpdateLaterControl: View {
    @Environment(AppModel.self) private var app
    let runnerID: String
    var version: String?
    var machine: String?
    var change = false
    @State private var sheet = false
    @State private var busy = false
    @State private var failure: String?

    private var title: String { change ? RunnerPageCopy.RUNNER_UPDATE_CHANGE : RunnerPageCopy.RUNNER_UPDATE_LATER }

    var body: some View {
        control
            .disabled(busy)
            .alert(RunnerPageCopy.RUNNER_UPDATE_POSTPONE_FAILED, isPresented: Binding(
                get: { failure != nil }, set: { if !$0 { failure = nil } })) {
                Button("OK", role: .cancel) { failure = nil }
            } message: {
                Text(failure ?? "")
            }
            .accessibilityIdentifier("runner-update-later")
    }

    #if os(iOS)
    @ViewBuilder private var control: some View {
        Button { sheet = true } label: { Text(title + "…").frame(maxWidth: .infinity) }
            .buttonStyle(.bordered)
            .confirmationDialog(RunnerUpdateLater.sheetMessage(version: version, machine: machine),
                                isPresented: $sheet, titleVisibility: .visible) {
                ForEach(RunnerUpdateLater.sheetRows(now: Date()), id: \.choice) { row in
                    Button(row.label) { postpone(row.until) }
                }
                Button("Cancel", role: .cancel) {}
            }
    }
    #else
    @ViewBuilder private var control: some View {
        Menu {
            ForEach(RunnerUpdateLater.menuRows(now: Date()), id: \.choice) { row in
                Button { postpone(row.until) } label: {
                    Text("\(row.label)\t\(row.detail ?? "")")
                }
            }
        } label: {
            Text(title)
        }
        .menuStyle(.button)
        .fixedSize()
    }
    #endif

    private func postpone(_ until: Date) {
        busy = true
        Task {
            failure = await app.runners?.postponeUpdate(runnerID, until: until)
            busy = false
        }
    }
}
