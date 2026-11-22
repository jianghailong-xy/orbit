import SwiftUI
import OrbitKit

/// The coordinator's changes to the landing check (revision 42 part two, board 05, rulings D6 and
/// D7) — web's `CoordinatorChanges`, opened from How it runs' "Coordinator’s changes" row. Every
/// part of a row is a field of `project_get.settingChanges`; whether Revert is offered is the
/// server's `revertible`, and a Revert asks first.
struct LandingChangesSheet: View {
    let store: ProjectDetailModel
    /// A task exemption's task, opened over the page — which takes this sheet down first.
    let openTask: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    /// The change a Revert press is asking about.
    @State private var confirming: ProjectSettingChange?
    /// Why a Revert did not go through.
    @State private var failure: String?
    @State private var reverting = false

    var body: some View {
        let changes = store.document?.settingChanges ?? []
        NavigationStack {
            List {
                Section {
                    if changes.isEmpty {
                        Text(LandingChangesCopy.empty).font(.orbitLabel).foregroundStyle(.secondary)
                    } else {
                        ForEach(changes) { change in
                            row(change)
                        }
                    }
                } footer: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(LandingChangesCopy.intro)
                        if let failure {
                            Text(failure).foregroundStyle(Color.red)
                        }
                    }
                }
            }
            .navigationTitle(LandingChangesCopy.title)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .alert(LandingChangesCopy.confirmTitle,
               isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
               presenting: confirming) { change in
            Button(LandingChangesCopy.cancel, role: .cancel) { confirming = nil }
            Button(LandingChangesCopy.revert, role: .destructive) { revert(change) }
        } message: { change in
            Text("\(LandingChanges.confirmBody(change))\n\(LandingChangesCopy.confirmConsequence)")
        }
        #if os(iOS)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        #else
        .frame(minWidth: 460, idealWidth: 560, minHeight: 420, idealHeight: 560)
        #endif
    }

    private func value(_ value: ProjectSettingChangeValue) -> Text {
        let read = LandingChanges.valueText(value)
        return read.code ? Text(read.text).font(.orbitMono) : Text(read.text)
    }

    private func row(_ change: ProjectSettingChange) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(LandingChanges.what(change)).font(.orbitProse)
                if change.field == .taskLandingCheckExempt, let taskID = change.taskId {
                    Text(verbatim: "·").foregroundStyle(.secondary)
                    Button(LandingChangesCopy.openTask) {
                        dismiss()
                        openTask(taskID)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.blue)
                }
            }
            (value(change.oldValue).strikethrough().foregroundStyle(.secondary)
                + Text(verbatim: " → ").foregroundStyle(.secondary)
                + value(change.newValue).bold())
                .font(.orbitSubtext)
            if let reason = change.reason, !reason.isEmpty {
                Text(reason).font(.orbitLabel).foregroundStyle(.secondary)
            }
            HStack(spacing: 6) {
                Text(LandingChanges.origin(change))
                    .font(.orbitMeta.weight(.semibold))
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Color.secondary.opacity(0.15), in: Capsule())
                if let ago = RelativeTime.format(change.createdAt) {
                    Text(ago).font(.orbitLabel).foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                switch LandingChanges.action(change) {
                case .revert:
                    Button(LandingChangesCopy.revert, role: .destructive) {
                        failure = nil
                        confirming = change
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(reverting)
                case .note(let note):
                    Text(note).font(.orbitLabel).foregroundStyle(.secondary)
                case .nothing:
                    EmptyView()
                }
            }
            if let revertedAt = change.revertedAt {
                Text(LandingChangesCopy.revertedLine(RelativeTime.format(revertedAt) ?? revertedAt))
                    .font(.orbitLabel).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
        .opacity(change.revertedAt == nil ? 1 : 0.7)
    }

    private func revert(_ change: ProjectSettingChange) {
        confirming = nil
        reverting = true
        Task {
            defer { reverting = false }
            do {
                try await store.revertSettingChange(change.id)
            } catch {
                failure = "\(LandingChangesCopy.revert) — \(APIClient.failureReason(error))."
            }
        }
    }
}
