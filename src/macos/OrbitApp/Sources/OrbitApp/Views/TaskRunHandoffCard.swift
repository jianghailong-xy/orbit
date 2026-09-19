import SwiftUI
import OrbitKit

/// The card a task-run refusal is read as, in place of the sentence the server wrote for a program.
///
/// Every decision — which situation this is, what it says, what it offers — is `TaskRunHandoff`,
/// unit-tested on Linux and held to the browser's wording by `TaskRunHandoffCopyParityTests`. This
/// only renders it, and owns the one thing no logic can: where each action goes on this platform.
/// Web parity: `TaskRunHandoffNotice.tsx`.
struct TaskRunHandoffCard: View {
    let conflict: TaskRunHandoff.Conflict
    /// What each way out does here. A card in the console answers its own question; one over a task
    /// list only ever opens a run. Left nil, an action is simply not drawn — a button with nothing
    /// behind it is worse than the one that is missing.
    var onOpenRun: ((String) -> Void)?
    var onClearPin: (() -> Void)?
    var onStopAndContinue: (() -> Void)?
    var onKeepRunning: (() -> Void)?
    var onDismiss: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Image(systemName: icon).foregroundStyle(tint)
                Text(conflict.title).font(.orbitProse.bold())
                Spacer(minLength: 8)
                if let onDismiss {
                    Button(action: onDismiss) { Image(systemName: "xmark") }
                        .buttonStyle(.plain).foregroundStyle(.secondary)
                        .accessibilityLabel("Dismiss")
                }
            }
            Text(conflict.body).font(.orbitLabel).foregroundStyle(.secondary)
            // A run that is letting go frees the task by itself; saying so is the whole content of
            // the wait, and it is what keeps the reader from pressing anything.
            if conflict.resendAfter != nil {
                Label("Re-sending as soon as it lets go", systemImage: "arrow.clockwise")
                    .font(.orbitMeta).foregroundStyle(.secondary)
            }
            let buttons = conflict.actions.compactMap(button)
            if !buttons.isEmpty {
                HStack(spacing: 8) { ForEach(buttons.indices, id: \.self) { buttons[$0] } }
                    .padding(.top, 2)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint.opacity(0.09), in: RoundedRectangle(cornerRadius: 10))
    }

    /// Green is not decoration here: the ENDING case is the one refusal nobody has to act on, and
    /// the question that stops a run is the one that should not look like a status.
    private var tint: Color {
        switch conflict.kind {
        case .ending:        return .secondary
        case .confirmSwitch: return .accentColor
        case .held, .pin:    return .orange
        }
    }

    private var icon: String {
        switch conflict.kind {
        case .ending:        return "clock.fill"
        case .confirmSwitch: return "questionmark.circle.fill"
        case .held, .pin:    return "exclamationmark.triangle.fill"
        }
    }

    /// One action as a button, or nothing — a plain function rather than a `@ViewBuilder`, because
    /// "this caller does not offer that way out" has to be an absence and a builder would have to
    /// make it an empty view in a row that had already reserved space for it.
    private func button(_ action: TaskRunHandoff.Action) -> AnyView? {
        switch action.kind {
        case .openRun:
            // Drawn only when the answer named a run AND this caller can go there. The label is the
            // shared constant either way, so the one place it could drift is the parity test's.
            guard let id = action.sessionID, let onOpenRun else { return nil }
            return AnyView(Button(action.label) { onOpenRun(id) }.buttonStyle(.borderedProminent))
        case .clearPin:
            guard let onClearPin else { return nil }
            return AnyView(Button(action.label, action: onClearPin).buttonStyle(.bordered))
        case .stopAndContinue:
            // The destructive role is the second half of the confirmation: this is the press that
            // ends somebody's work, and it should not read like the ordinary one.
            guard let onStopAndContinue else { return nil }
            return AnyView(Button(action.label, role: .destructive, action: onStopAndContinue)
                .buttonStyle(.bordered))
        case .keepRunning:
            guard let onKeepRunning else { return nil }
            return AnyView(Button(action.label, action: onKeepRunning).buttonStyle(.bordered))
        }
    }
}

/// The other half of §2.1, and the only one of these that is good news: the message was delivered,
/// to the run that has the task rather than the one it was sent in.
///
/// Deliberately not a `TaskRunHandoff.Conflict` — nothing was refused, so a card shaped like a
/// refusal would be the wrong thing on screen. The words are the same pair of constants the web end
/// shows for the same answer.
struct TaskRunHandedOverCard: View {
    let sessionID: String
    var onOpenRun: (String) -> Void
    var onDismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                Text(TaskRunHandoff.handedOverTitle).font(.orbitProse.bold())
                Spacer(minLength: 8)
                Button(action: onDismiss) { Image(systemName: "xmark") }
                    .buttonStyle(.plain).foregroundStyle(.secondary)
                    .accessibilityLabel("Dismiss")
            }
            Text(TaskRunHandoff.handedOverBody).font(.orbitLabel).foregroundStyle(.secondary)
            Button(TaskRunHandoff.openTheRun) { onOpenRun(sessionID) }
                .buttonStyle(.borderedProminent)
                .padding(.top, 2)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.green.opacity(0.09), in: RoundedRectangle(cornerRadius: 10))
    }
}
