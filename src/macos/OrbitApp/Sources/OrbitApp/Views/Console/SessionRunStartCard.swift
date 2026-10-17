import SwiftUI
import OrbitKit

/// The card a session page draws when no engine ever ran on it.
///
/// A thin renderer: every word and every decision is `SessionRunStart`'s (OrbitKit), which is
/// where the tests are. The shell is the app's existing repair card — same icon, same warning
/// tint, same button styles as `AntigravityRepairCardView` and `DshRepairCardView` beside it, so
/// this is not a new card style, only a new reason.
struct SessionRunStartCardView: View {
    let console: ConsoleModel
    let card: SessionRunStart.Card
    @Environment(AppModel.self) private var appModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(SessionRunStart.title, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange).font(.orbitProse.bold())
            VStack(alignment: .leading, spacing: 4) {
                Text(card.why).font(.orbitLabel.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                Text(card.body).font(.orbitLabel).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            // The machine facts: the refusal's code and ref, the runner's own words. Monospaced
            // and selectable, because the thing a reader does with a git error is copy it.
            if !card.lines.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(card.lines, id: \.self) { line in
                        Text(line).font(.orbitMeta.monospaced()).foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }
            }
            HStack {
                ForEach(card.actions, id: \.kind) { action in
                    if action.primary {
                        Button(action.label) { press(action) }
                            .buttonStyle(.borderedProminent)
                            .disabled(busy(action))
                    } else {
                        Button(action.label) { press(action) }
                            .buttonStyle(.bordered)
                            .disabled(busy(action))
                    }
                }
            }
            .font(.orbitLabel)
            if let footer = card.footer {
                Text(footer).font(.orbitMeta).foregroundStyle(.secondary)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
        .accessibilityIdentifier("session-run-start")
    }

    private func press(_ action: SessionRunStart.Action) {
        PlatformHaptics.tap()
        switch action.kind {
        case .startItAgain: Task { await console.startRefusedRunAgain() }
        case .sendItAgain: Task { await console.retryLastMessage() }
        case .chatAboutThis: console.chatAboutRunStart()
        case .openRunner:
            if let runnerID = console.runnerID { appModel.route(to: .runner(runnerID)) }
        }
    }

    private func busy(_ action: SessionRunStart.Action) -> Bool {
        switch action.kind {
        case .startItAgain: return console.startingRun || console.taskID == nil
        case .sendItAgain: return console.sending || console.retryInFlight
        case .openRunner: return console.runnerID == nil
        case .chatAboutThis: return false
        }
    }
}
