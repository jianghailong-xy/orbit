import OrbitKit
import SwiftUI

/* Contract revision 42 part two, drawn as the owner ruled on docs/mocks/landing-measured (2026-11-20):
   the landing check's three values and who set it (03, D3/D4/D9), the coordinator's changes with the
   owner's Revert (05, D6/D7), and a task's exemption (04, D5). The words are OrbitKit's
   `LandingProvenanceCopy`; what each row says is derived there and tested there. */

/// Who set a value, as the board's capsule: You on black, Coordinator on amber, Approved on a card
/// on blue, Set at start on violet.
struct ProvenanceBadge: View {
    let kind: String
    let label: String
    /// The badge's accessibility identifier. The "Who can set it" key passes its own, so a badge in that
    /// legend is never taken for the one that says who set the value.
    var identifier: String? = nil

    var body: some View {
        Text(label)
            .font(.orbitMeta.weight(.semibold))
            .foregroundStyle(ink)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(fill, in: Capsule())
            .accessibilityIdentifier(identifier ?? "provenance-\(kind)")
    }

    /// The board's amber ink, lifted in dark mode where the light one would not read on its fill.
    static let amberInk = Color(light: Color(red: 0.6, green: 0.38, blue: 0.0),
                                dark: Color(red: 1.0, green: 0.76, blue: 0.4))

    private var ink: Color {
        switch kind {
        case "you": return Color(light: .white, dark: .black)
        case "coordinator": return ProvenanceBadge.amberInk
        case "card": return .blue
        default: return .purple
        }
    }

    private var fill: Color {
        switch kind {
        case "you": return Color.primary
        case "coordinator": return Color.orange.opacity(0.2)
        case "card": return Color.blue.opacity(0.14)
        default: return Color.purple.opacity(0.14)
        }
    }
}

/// How it runs' Landing check on a project branch (board 03 b, c): Merge check · Command · No check,
/// the command, who set it and when, and what the value means.
struct LandingCheckSettingRow: View {
    let view: ProjectIntegrationView
    let busy: Bool
    /// Opens the command's editor.
    let onEditCommand: () -> Void
    /// Writes Merge check or No check.
    let onChoose: (LandingCheckSetting.Mode) -> Void

    var body: some View {
        let setting = LandingCheckSetting.of(view)
        VStack(alignment: .leading, spacing: 8) {
            Text(LandingCheckCopy.label)
            Picker(LandingCheckCopy.label, selection: Binding(
                get: { setting.mode },
                set: { mode in
                    guard mode != setting.mode else { return }
                    if mode == .command { onEditCommand() } else { onChoose(mode) }
                })) {
                ForEach(LandingCheckSetting.Mode.allCases, id: \.self) { mode in
                    Text(mode.label).tag(mode)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .disabled(busy)
            .accessibilityIdentifier("landing-check-mode")
            switch setting.mode {
            case .command:
                Button(action: onEditCommand) {
                    Text(setting.command ?? "")
                        .font(.orbitMono)
                        .foregroundStyle(.primary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 8).padding(.vertical, 6)
                        .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 6))
                }
                .buttonStyle(.plain)
                .disabled(busy)
            case .mergeCheck:
                Text(LandingCheckCopy.inheritedCommand(view.mergeCheckCommand))
                    .font(.orbitLabel).foregroundStyle(.secondary)
            case .none:
                (Text(LandingProvenanceCopy.noneLead).fontWeight(.semibold)
                    + Text(" ")
                    + Text(LandingProvenanceCopy.noneBody).foregroundStyle(.secondary))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("landing-check-none")
            }
            if let origin = setting.origin {
                HStack(spacing: 6) {
                    ProvenanceBadge(kind: origin.kind, label: origin.label)
                    if let when = origin.when {
                        Text(when).font(.orbitMeta).foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)
            }
            if setting.mode == .none {
                // Who can set it, under the value's own origin (web's LANDING_CHECK_ORIGIN_NOTES, under No check).
                VStack(alignment: .leading, spacing: 6) {
                    Text(LandingProvenanceCopy.whoCanSet).font(.orbitLabel.weight(.semibold))
                    ForEach(LandingProvenanceCopy.originNotes) { entry in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            ProvenanceBadge(kind: entry.kind, label: entry.label, identifier: "who-can-set-\(entry.kind)")
                            Text(entry.note).font(.orbitLabel).foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("landing-check-who-can-set")
            }
            if setting.mode != .none {
                Text(setting.origin?.kind == "coordinator" ? LandingProvenanceCopy.coordinatorHint : LandingCheckCopy.hint)
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The Settings entry into the change list (board 03 b): "Coordinator’s changes · 3 changes ›".
struct CoordinatorChangesEntryRow: View {
    let count: Int
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(LandingProvenanceCopy.changesTitle)
                        .font(.orbitLabel).foregroundStyle(.secondary)
                    Text(count == 0 ? LandingProvenanceCopy.noChanges : LandingProvenanceCopy.changesCount(count))
                        .foregroundStyle(.primary)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right").font(.orbitMeta).foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("coordinator-changes-entry")
    }
}

/// Coordinator’s changes (board 05 b–d): every change, newest first, each with the old value struck
/// through, the new one, why, who, when — and Revert on a coordinator change that still stands,
/// after a confirmation that says what follows.
struct CoordinatorChangesPage: View {
    let projectTitle: String
    let changes: [ProjectSettingChange]
    let taskTitles: [String: String]
    /// The owner's revert; throws what the door answered.
    let revert: (String) async throws -> Void
    /// Opens the task an exemption row is about.
    var openTask: ((String) -> Void)? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var confirming: ProjectSettingChange?
    @State private var reverting = false
    @State private var refused: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(LandingProvenanceCopy.changesIntro)
                        .font(.orbitLabel).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .listRowBackground(Color.clear)
                }
                if let refused {
                    Section { Text(refused).font(.orbitLabel).foregroundStyle(.red) }
                }
                Section {
                    let rows = CoordinatorChanges.rows(changes, taskTitles: taskTitles)
                    if rows.isEmpty {
                        Text(LandingProvenanceCopy.noChanges).foregroundStyle(.secondary)
                    }
                    ForEach(rows) { row in
                        changeRow(row)
                    }
                }
            }
            .navigationTitle(LandingProvenanceCopy.changesTitle)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 0) {
                        Text(LandingProvenanceCopy.changesTitle).font(.headline)
                        Text(projectTitle).font(.orbitMeta).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            }
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .sheet(item: $confirming) { change in
                revertConfirmation(change)
                    #if os(iOS)
                    .presentationDetents([.height(300)])
                    .presentationDragIndicator(.visible)
                    #endif
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("coordinator-changes-page")
    }

    @ViewBuilder private func changeRow(_ row: SettingChangeRow) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(row.title).fontWeight(.semibold).lineLimit(1)
                Spacer(minLength: 8)
                if let when = row.when {
                    Text(when).font(.orbitMeta).foregroundStyle(.secondary)
                }
            }
            HStack(spacing: 6) {
                value(row.old, code: row.oldIsCode).strikethrough().foregroundStyle(.secondary)
                Image(systemName: "arrow.right").font(.orbitMeta).foregroundStyle(.secondary)
                value(row.new, code: row.newIsCode).fontWeight(row.newIsCode ? .regular : .semibold)
            }
            .lineLimit(1)
            if let reason = row.reason {
                Text(reason).font(.orbitSubtext)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let taskID = row.taskID, let openTask {
                Button(LandingProvenanceCopy.openTask) { openTask(taskID) }
                    .font(.orbitLabel)
                    .buttonStyle(.borderless)
                    .accessibilityIdentifier("open-task-\(row.id)")
            }
            HStack(spacing: 8) {
                ProvenanceBadge(kind: row.originKind, label: row.originLabel)
                if row.revertible {
                    Button(LandingProvenanceCopy.revert) {
                        refused = nil
                        confirming = changes.first { $0.id == row.id }
                    }
                    .font(.orbitLabel.weight(.semibold))
                    .foregroundStyle(.red)
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .tint(.red)
                    .controlSize(.small)
                    .accessibilityIdentifier("revert-\(row.id)")
                } else if let note = row.note {
                    Text(note).font(.orbitMeta).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .opacity(row.reverted ? 0.6 : 1)
        .padding(.vertical, 4)
        // `.contain`: an identifier on a plain container is handed down to every element in it,
        // which would hide the badge's and Revert's own.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("change-\(row.id)")
    }

    private func value(_ text: String, code: Bool) -> some View {
        Text(text)
            .font(code ? .orbitMono : .orbitSubtext)
            .padding(.horizontal, code ? 4 : 0)
            .background(code ? Color.secondary.opacity(0.1) : Color.clear, in: RoundedRectangle(cornerRadius: 4))
    }

    /// Board 05 c: what goes back, and that the field then needs a card.
    private func revertConfirmation(_ change: ProjectSettingChange) -> some View {
        let parts = CoordinatorChanges.revertSentence(change, taskTitles: taskTitles)
        return VStack(alignment: .leading, spacing: 12) {
            Text(LandingProvenanceCopy.revertTitle)
                .font(.headline)
                .frame(maxWidth: .infinity)
            (Text("\(parts.subject) goes back from ")
                + Text(parts.from).fontWeight(.semibold)
                + Text(" to ")
                + Text(parts.to).font(.orbitMono)
                + Text("."))
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel(CoordinatorChanges.revertText(change, taskTitles: taskTitles))
            Text(LandingProvenanceCopy.revertAfter)
                .font(.orbitLabel).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 10) {
                Button {
                    Task { await doRevert(change) }
                } label: {
                    Text(LandingProvenanceCopy.revert).frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .tint(.red)
                .disabled(reverting)
                .accessibilityIdentifier("revert-confirm")
                Button {
                    confirming = nil
                } label: {
                    Text(LandingProvenanceCopy.cancel).frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .tint(.secondary)
            }
            .buttonBorderShape(.capsule)
            .controlSize(.large)
        }
        .padding(20)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("revert-confirmation")
    }

    private func doRevert(_ change: ProjectSettingChange) async {
        reverting = true
        defer { reverting = false }
        do {
            try await revert(change.id)
            confirming = nil
        } catch {
            confirming = nil
            refused = APIClient.failureReason(error)
        }
    }
}

/// A task's exemption, in its Landing section (board 04 b): the check, Exempt, the reason, who
/// marked it and when, and the owner's Remove exemption.
struct TaskExemptionRow: View {
    let exemption: TaskLandingCheckExemption
    let busy: Bool
    let onRemove: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(LandingCheckCopy.label).fontWeight(.semibold)
                Spacer(minLength: 8)
                Text(LandingProvenanceCopy.exempt)
                    .font(.orbitMeta.weight(.semibold))
                    .foregroundStyle(ProvenanceBadge.amberInk)
                    .padding(.horizontal, 7).padding(.vertical, 2)
                    .background(Color.yellow.opacity(0.25), in: Capsule())
            }
            if !exemption.reason.isEmpty {
                Text(exemption.reason)
                    .font(.orbitSubtext.weight(.medium))
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 6) {
                ProvenanceBadge(kind: exemption.originKind, label: exemption.originLabel)
                if let when = exemption.when {
                    Text(when).font(.orbitMeta).foregroundStyle(.secondary)
                }
            }
            Button(LandingProvenanceCopy.removeExemption, action: onRemove)
                .font(.orbitLabel.weight(.semibold))
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .controlSize(.small)
                .disabled(busy)
                .accessibilityIdentifier("remove-exemption")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("task-landing-exemption")
    }
}
