import SwiftUI
import OrbitKit

/// A held task on a list or project row (contract §3; web `TaskAccountHoldLine`): ONE quiet line under the
/// title, never a chip that takes the title's room. `Held · <provider's words> · Next try <time>` truncates;
/// Open account stays pressable at its end, and the whole sentence is the line's accessible name.
struct TaskAccountHoldLine: View {
    @Environment(AppModel.self) private var app
    let hold: TaskAccountHold

    var body: some View {
        HStack(spacing: 4) {
            Text(TaskAccountHoldCopy.line(hold))
                .lineLimit(1)
                .truncationMode(.tail)
                .foregroundStyle(.secondary)
            Button(TaskAccountHoldCopy.openAccount) { app.openAccounts() }
                .buttonStyle(.borderless)
                .foregroundStyle(Color.accentColor)
                .fixedSize()
        }
        .font(.orbitRowNote)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(TaskAccountHoldCopy.accessibilityLine(hold))
        .accessibilityIdentifier("task-account-hold-line")
        .help(TaskAccountHoldCopy.accessibilityLine(hold))
    }
}

/// The fuller hold on the task view (web `TaskAccountHoldNote`): Held, the server's sentence, Open account,
/// and for a pinned task held with relaxation off, Run elsewhere (Model routing on the web).
struct TaskAccountHoldNote: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL
    let hold: TaskAccountHold

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(TaskAccountHoldCopy.held)
                    .font(.orbitMeta.weight(.semibold))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .foregroundStyle(Color.orange)
                    .background(Color.orange.opacity(0.13), in: Capsule())
                Text(hold.reason)
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 14) {
                Button(TaskAccountHoldCopy.openAccount) { app.openAccounts() }
                if hold.setting != nil, let base = app.baseURL {
                    Button(TaskAccountHoldCopy.runElsewhere) { openURL(TaskAccountHoldCopy.relaxPinsURL(base: base)) }
                }
            }
            .buttonStyle(.borderless)
            .font(.orbitLabel)
        }
        .accessibilityIdentifier("task-account-hold")
    }
}

/// A pinned run that went elsewhere: which pin, where it ran and why, in the server's sentence, under the run's row.
struct RelaxedRunNote: View {
    let sentence: String

    var body: some View {
        Text(sentence)
            .font(.orbitMeta)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("relaxed-run")
    }
}
