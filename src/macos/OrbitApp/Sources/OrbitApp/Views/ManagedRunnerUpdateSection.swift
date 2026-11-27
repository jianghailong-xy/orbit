import SwiftUI
import OrbitKit

/// Orbit Cloud's Update card (docs/managed-runner-update-now-design.md, board 5): a newer build is available,
/// restarting into it, or updated. Update Now… asks the server first; a busy runner answers with the turns and
/// background jobs it would stop, which the confirmation names before the red button interrupts them.
/// Driven by the managed status's `update`; no card for a runner on the current build.
struct ManagedRunnerUpdateSection: View {
    let managedRunner: ManagedRunnerModel
    /// Told `Restarting…` once the server took it.
    var onNotice: ((String) -> Void)? = nil
    @State private var asking: ManagedRunnerUpdateLogic.Confirmation?
    @State private var failure: String?

    var body: some View {
        if let card = ManagedRunnerUpdateLogic.card(status: managedRunner.status, updated: managedRunner.updated,
                                                      pendingTurns: managedRunner.pending?.interruptedTurns) {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(card.title).fontWeight(.semibold)
                        Spacer(minLength: 8)
                        Text(card.tag)
                            .font(.orbitLabel)
                            .foregroundStyle(card.warn ? RunnerInk.amber : Color.secondary)
                            .lineLimit(1)
                    }
                    if !card.body.isEmpty {
                        Text(card.body).foregroundStyle(Color.secondary)
                    }
                }
                .padding(.vertical, 4)
                .listRowBackground(card.warn ? Color.orange.opacity(0.08) : nil)
                if card.canUpdateNow {
                    Button { press(card) } label: {
                        #if os(iOS)
                        Text(RunnerPageCopy.RUNNER_UPDATE_NOW).frame(maxWidth: .infinity)
                        #else
                        Text(RunnerPageCopy.RUNNER_UPDATE_NOW)
                        #endif
                    }
                    .buttonStyle(.bordered)
                    .disabled(managedRunner.acting)
                    .accessibilityIdentifier("runner-update-now")
                    .orbitConfirmation({ $0.title }, isPresented: askingShown, presenting: asking) { confirmation in
                        Button(confirmation.confirm, role: .destructive) { interrupt(turns: confirmation.turns.count, build: confirmation.build) }
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
            }
        }
    }

    private var askingShown: Binding<Bool> {
        Binding(get: { asking != nil }, set: { if !$0 { asking = nil } })
    }

    /// Ask without interrupting: an idle runner restarts at once, a busy one answers with what it would stop.
    private func press(_ card: ManagedRunnerUpdateLogic.Card) {
        Task {
            switch await managedRunner.updateNow(interruptTurns: false, turns: 0, to: card.build) {
            case .started:
                onNotice?(RunnerPageCopy.managedUpdateRestartingTitle(build: ManagedRunnerUpdateLogic.buildName(card.build)))
            case .busy(let busy):
                asking = ManagedRunnerUpdateLogic.confirmation(busy, build: card.build, now: Date())
            case .failed(let reason):
                failure = reason
            }
        }
    }

    private func interrupt(turns: Int, build: ManagedRunnerBuild) {
        Task {
            switch await managedRunner.updateNow(interruptTurns: true, turns: turns, to: build) {
            case .started:
                break
            case .busy, .failed:
                failure = RunnerPageCopy.RUNNER_UPDATE_NOW_FAILED
            }
        }
    }
}
