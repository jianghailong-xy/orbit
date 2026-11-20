import SwiftUI
import OrbitKit

// Settings from a conversation (docs/settings-from-conversation-design.md §8): the SETTINGS_CHANGE card and its folded
// lines, the Open in Settings row an `orbit-settings:` link becomes, and the grey line under a Settings row that was
// changed from a conversation. Every word is `SettingsChangeCopy` / `SettingsFromConversation` in OrbitKit; web parity:
// `components/SettingsChangeCard.tsx`, `SettingsLinkCard.tsx`, `settings/SettingChangedLine.tsx`.

/// A SETTINGS_CHANGE request: pending, the whole card (board 1 frame ②); answered, one line.
struct SettingsChangeCardView: View {
    @Environment(AppModel.self) private var appModel
    let model: OwnerRequestsModel
    let request: OwnerRequest

    @State private var stale = false
    @State private var declining = false
    @State private var reason = ""
    @State private var busy = false
    @State private var failure: String?

    private var entries: [SettingsChangeEntry] { SettingsFromConversation.entries(request.payload) }

    var body: some View {
        Group {
            if request.state == .declined {
                folded(SettingsChangeCopy.declined, symbol: "xmark.circle.fill", tint: .red)
            } else if request.state == .done {
                SettingsChangeDoneLine(request: request)
            } else if stale {
                staleLine
            } else {
                card
            }
        }
        .accessibilityIdentifier("owner-request-\(request.id)")
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(SettingsChangeCopy.heading(entries.count)).font(.headline)
            ForEach(Array(SettingsFromConversation.groups(entries).enumerated()), id: \.offset) { _, group in
                VStack(alignment: .leading, spacing: 8) {
                    if let path = group.path { Text(path).font(.orbitLabel).foregroundStyle(.secondary) }
                    ForEach(group.entries, id: \.key) { entry in changeRow(entry) }
                }
            }
            if !request.why.isEmpty {
                Text(SettingsChangeCopy.agentSays(request.why))
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text(SettingsChangeCopy.foot).font(.orbitLabel).foregroundStyle(.secondary)
            if let failure {
                Label { Text("\(OwnerRequests.notRecorded): \(failure)") } icon: {
                    Image(systemName: "exclamationmark.triangle.fill")
                }
                .font(.orbitLabel).foregroundStyle(.red)
            }
            if declining { declineForm } else { actions }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.03), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.orange.opacity(0.45)))
    }

    private func changeRow(_ entry: SettingsChangeEntry) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(SettingsFromConversation.title(entry.key)).font(.orbitControl)
                Spacer(minLength: 8)
                Text(SettingsFromConversation.valueLabel(entry.key, entry.from))
                    .strikethrough().foregroundStyle(.secondary)
                Text("→").foregroundStyle(.secondary)
                Text(SettingsFromConversation.valueLabel(entry.key, entry.to)).bold()
            }
            .font(.orbitSubtext)
            if entry.tier == 2 {
                Text(SettingsChangeCopy.newSessionsOnly).font(.orbitLabel).foregroundStyle(.secondary)
            }
        }
        .accessibilityIdentifier("settings-change-row-\(entry.key)")
    }

    private var actions: some View {
        ApprovalActions {
            Button { save() } label: {
                Text(SettingsChangeCopy.save).bold().approvalActionLabel()
            }
            .buttonStyle(.borderedProminent)
            .keyboardShortcut(.defaultAction)
            .disabled(busy)
            .accessibilityIdentifier("settings-change-save")
            Button { declining = true } label: {
                Text(SettingsChangeCopy.chat).approvalActionLabel()
            }
            .buttonStyle(.bordered)
            .disabled(busy)
            .accessibilityIdentifier("settings-change-chat")
        }
        .lineLimit(1)
    }

    private var declineForm: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField(SettingsChangeCopy.declinePlaceholder, text: $reason, axis: .vertical)
                .lineLimit(2...6)
                .textFieldStyle(.roundedBorder)
            HStack(spacing: 12) {
                Button(SettingsChangeCopy.decline) { decline(reason.trimmingCharacters(in: .whitespacesAndNewlines)) }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy || reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Button(SettingsChangeCopy.keep) { declining = false }.buttonStyle(.borderless)
            }
        }
    }

    private var staleLine: some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            Text(SettingsChangeCopy.stale)
            Text("·").foregroundStyle(.secondary)
            Button(SettingsChangeCopy.decline) { decline(SettingsChangeCopy.stale) }
                .buttonStyle(.borderless).disabled(busy)
        }
        .font(.orbitSubtext)
        .padding(.vertical, 8)
    }

    private func folded(_ text: String, symbol: String, tint: Color) -> some View {
        Label { Text(text) } icon: { Image(systemName: symbol).foregroundStyle(tint) }
            .font(.orbitSubtext)
            .padding(.vertical, 8)
    }

    private func save() {
        busy = true
        failure = nil
        Task { @MainActor in
            do {
                try await model.applySettings(request)
                await appModel.reloadUser()
            } catch {
                if SettingsFromConversation.isStale(error) { stale = true } else { failure = error.localizedDescription }
            }
            busy = false
        }
    }

    private func decline(_ why: String) {
        busy = true
        failure = nil
        Task { @MainActor in
            do { try await model.decline(request, reason: why) } catch { failure = error.localizedDescription }
            busy = false
        }
    }
}

/// `✓ Changed 2 settings · Undo` (§8.1). Undo is the owner's own PATCH with each `from`, for the keys this card still
/// marks: a setting changed since is the owner's, and is left alone.
struct SettingsChangeDoneLine: View {
    @Environment(AppModel.self) private var appModel
    let request: OwnerRequest
    @State private var busy = false
    @State private var undone = false
    @State private var failure: String?

    var body: some View {
        let undoBody = SettingsFromConversation.undoBody(request: request, user: appModel.user)
        HStack(spacing: 6) {
            Text(SettingsChangeCopy.changed(SettingsFromConversation.entries(request.payload).count))
            if undone {
                Text("·").foregroundStyle(.secondary)
                Text(SettingsChangeCopy.undone).foregroundStyle(.secondary)
            } else if !undoBody.isEmpty {
                Text("·").foregroundStyle(.secondary)
                Button(SettingsChangeCopy.undo) {
                    busy = true
                    Task { @MainActor in
                        do {
                            try await appModel.undoSettingsChange(undoBody)
                            undone = true
                        } catch { failure = error.localizedDescription }
                        busy = false
                    }
                }
                .buttonStyle(.borderless).disabled(busy)
                .accessibilityIdentifier("settings-change-undo")
            }
            if let failure { Text(failure).font(.orbitLabel).foregroundStyle(.red) }
        }
        .font(.orbitSubtext)
        .padding(.vertical, 8)
    }
}

/// An `orbit-settings:<key>` link on a line of its own, drawn as the Open in Settings row (board 2 frame ③): the
/// setting's title, where it is, and a button that opens Settings at that row.
struct SettingsLinkCardView: View {
    @Environment(AppModel.self) private var appModel
    let place: SettingPlace

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(place.title).font(.orbitProse.weight(.semibold))
                Text(SettingsFromConversation.pathLabel(place)).font(.orbitLabel).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Button(SettingsChangeCopy.openInSettings) { appModel.openSettings(at: place) }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("settings-link-open")
        }
        .padding(.vertical, 9).padding(.horizontal, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.editorSurface, in: RoundedRectangle(cornerRadius: 10))
        .overlay { RoundedRectangle(cornerRadius: 10).strokeBorder(Color.secondary.opacity(0.25), lineWidth: 1) }
    }
}

/// The grey line a Settings row draws under itself when its setting was last changed from a conversation (§8.2):
/// `Turned on from <conversation> · 2m ago · Undo`, in the description's grey. The row is also what an
/// `orbit-settings:` link scrolls to and flashes (`settingRow`).
struct SettingChangedLineView: View {
    @Environment(AppModel.self) private var appModel
    let key: String
    @State private var busy = false

    var body: some View {
        if let mark = appModel.user?.changedBy?[key] {
            HStack(alignment: .lastTextBaseline, spacing: 0) {
                Text(SettingsFromConversation.changedLine(mark))
                Button(SettingsChangeCopy.undo) {
                    busy = true
                    Task { @MainActor in
                        try? await appModel.undoSettingsChange([key: mark.from ?? .null])
                        busy = false
                    }
                }
                .buttonStyle(.borderless).disabled(busy)
                .accessibilityIdentifier("setting-changed-undo-\(key)")
            }
            .font(.orbitLabel)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("setting-changed-\(key)")
        }
    }
}

extension View {
    /// A Settings row the `orbit-settings:` link can scroll to: named by its key, tinted while it is the one asked for.
    func settingRow(_ key: String) -> some View { modifier(SettingRowFlash(key: key)) }

    /// Scrolls to the row `AppModel.settingsAnchor` names, then lets the flash go.
    func settingsAnchorScroll() -> some View { modifier(SettingsAnchorScroll()) }
}

private struct SettingRowFlash: ViewModifier {
    @Environment(AppModel.self) private var appModel
    let key: String

    func body(content: Content) -> some View {
        content
            .id(key)
            .background(appModel.settingsAnchor == key ? Color.accentColor.opacity(0.18) : Color.clear)
            .animation(.easeOut(duration: 0.4), value: appModel.settingsAnchor)
    }
}

private struct SettingsAnchorScroll: ViewModifier {
    @Environment(AppModel.self) private var appModel

    func body(content: Content) -> some View {
        ScrollViewReader { proxy in
            content
                .task(id: appModel.settingsAnchor) {
                    guard let key = appModel.settingsAnchor else { return }
                    // Let the page land before it scrolls, and leave the flash on long enough to be seen.
                    try? await Task.sleep(nanoseconds: 350_000_000)
                    withAnimation { proxy.scrollTo(key, anchor: .center) }
                    try? await Task.sleep(nanoseconds: 1_800_000_000)
                    if appModel.settingsAnchor == key { appModel.settingsAnchor = nil }
                }
        }
    }
}
