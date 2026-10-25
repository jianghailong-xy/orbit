import SwiftUI
import OrbitKit

#if os(iOS)
/// The Move panel (docs/session-folders-move-design.md §4): where a session row's Move — swiped, or
/// Move… from its long-press menu — files the session. A native sheet in the style of the workspace
/// switcher (`AgentSwitchSheet`): Move over the session's title, Done, and the folders of the
/// session's workspace — No Folder, each folder with how many of the list's sessions are in it, and
/// New Folder…. The folder the session is in is ticked; a tap moves it there at once and closes the
/// panel, and the app's toast says where it went (`AppModel.moveSession`).
///
/// The second group, Move to Another Workspace (§4, §5.2), lists the owner's other workspaces as
/// `GET /sessions/:id/move-targets` answers: brand mark, name and `<provider> · <runner>`. One the
/// session can go to opens its page (`SessionMoveTargetPage`), where a folder there is picked and the
/// move confirmed; one it can't is greyed with the server's reason, and when the session itself can't
/// leave, the whole group is greyed with why under it. A server without move-targets shows no group.
struct SessionMoveSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let session: Session
    /// The workspace the session is in — the list's own.
    let workspace: Agent
    /// The list the row was moved from: what the folders' counts count, as the list's folder rows
    /// do, and where the row is read as it stands now.
    let listed: [Session]
    /// New Folder…'s name prompt and its draft, which a refused name keeps for the next try.
    @State private var naming = false
    @State private var draft = ""
    /// Set while New Folder… waits on the server, which holds the panel still.
    @State private var creating = false
    /// Why the last New Folder… didn't create a folder, shown as an alert.
    @State private var failure: String?
    /// The server's answer for the second group, once it has given one.
    @State private var targets: SessionMoveTargets?
    /// Why the second group couldn't be read, while there is no answer to show instead.
    @State private var targetsFailure: String?
    /// The server has no move-targets (it predates moving between workspaces): no second group.
    @State private var targetsUnsupported = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(options) { option in
                        Button { choose(option) } label: { row(option) }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(option.isCurrent ? .isSelected : [])
                    }
                    Button { naming = true } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "folder.badge.plus")
                                .frame(width: 24)
                                .accessibilityHidden(true)
                            Text(SessionMoveCopy.newFolder)
                            Spacer(minLength: 8)
                            if creating { ProgressView() }
                        }
                    }
                } header: {
                    Text(SessionMoveCopy.folderGroup(workspace: workspace.name))
                }
                workspaceGroup
            }
            .disabled(creating)
            .navigationDestination(for: SessionMoveTarget.self) { target in
                SessionMoveTargetPage(session: session, workspace: workspace, target: target,
                                      answer: targets ?? SessionMoveTargets(targets: [target]),
                                      close: { dismiss() }, reload: { await loadTargets() })
            }
            .task { await loadTargets() }
            .navigationTitle(SessionMoveCopy.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) { title }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(SessionMoveCopy.done) { dismiss() }
                }
            }
            .alert(SessionMoveCopy.newFolderTitle, isPresented: $naming) {
                TextField(SessionMoveCopy.folderNamePlaceholder, text: $draft)
                // Default action, so Return in the field creates, as it saves in the rename alert.
                Button(SessionMoveCopy.create) { create() }
                    .keyboardShortcut(.defaultAction)
                Button(SessionMoveCopy.cancel, role: .cancel) {}
            } message: {
                Text(SessionMoveCopy.newFolderMessage)
            }
            .alert(SessionMoveCopy.couldNotCreate, isPresented: failed) {
                Button(SessionMoveCopy.ok, role: .cancel) {}
            } message: {
                Text(failure ?? "")
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var options: [SessionMoveFolderOption] {
        SessionMoveLogic.folderOptions(for: session, workspaceID: workspace.id,
                                       folders: app.sessionFolders, listed: listed)
    }

    /// Move over the session's title, as a task's page puts its title over its state.
    private var title: some View {
        VStack(spacing: 1) {
            Text(SessionMoveCopy.title)
                .font(.headline)
            Text(SessionHeader.title(for: session, fallbackAgent: workspace.name))
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .frame(maxWidth: 240)
        .accessibilityElement(children: .combine)
    }

    /// A place to file the session: its glyph and name, the folder's count, and the tick where the
    /// session is now. VoiceOver reads the name and the count; the tick is the row's selected trait.
    private func row(_ option: SessionMoveFolderOption) -> some View {
        HStack(spacing: 12) {
            Image(systemName: option.folder == nil ? "tray" : "folder")
                .foregroundStyle(option.folder == nil ? Color.secondary : Color.indigo)
                .frame(width: 24)
                .accessibilityHidden(true)
            Text(option.folder?.name ?? SessionMoveCopy.noFolder)
                .foregroundStyle(.primary)
                .lineLimit(1)
            Spacer(minLength: 8)
            if let count = option.sessionCount {
                Text("\(count)")
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
            if option.isCurrent {
                Image(systemName: "checkmark")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
                    .accessibilityHidden(true)
            }
        }
        .contentShape(Rectangle())
    }

    /// Move to Another Workspace: a spinner while the server is asked, then a row per other
    /// workspace — or, when the answer couldn't be read, the group with why under it. No group when
    /// the owner has no other workspace, or the server can't say (`targetsUnsupported`).
    @ViewBuilder private var workspaceGroup: some View {
        if let targets {
            if !targets.targets.isEmpty {
                Section {
                    ForEach(SessionWorkspaceMoveLogic.rows(targets, providerName: providerName)) { row in
                        if row.isEnabled {
                            NavigationLink(value: row.target) { targetRow(row) }
                        } else {
                            targetRow(row)
                        }
                    }
                } header: {
                    Text(SessionMoveCopy.anotherWorkspaceGroup)
                } footer: {
                    if let reason = SessionWorkspaceMoveLogic.groupReason(targets) { Text(reason) }
                }
            }
        } else if let targetsFailure {
            Section {
            } header: {
                Text(SessionMoveCopy.anotherWorkspaceGroup)
            } footer: {
                Text(targetsFailure)
            }
        } else if !targetsUnsupported {
            Section {
                HStack(spacing: 12) {
                    ProgressView()
                    Text(SessionMoveCopy.loadingWorkspaces).foregroundStyle(.secondary)
                }
            } header: {
                Text(SessionMoveCopy.anotherWorkspaceGroup)
            }
        }
    }

    /// A workspace the session could go to, as the workspace switcher draws one: its brand mark, its
    /// name, and under it `<provider> · <runner>` — or `Runner offline`, or the server's reason it
    /// can't go there, the whole row greyed. The chevron is the navigation link's own.
    private func targetRow(_ row: SessionMoveTargetRow) -> some View {
        HStack(spacing: 12) {
            ProviderMark(provider: row.target.provider, size: 30)
                .opacity(row.isEnabled ? 1 : 0.45)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.target.name)
                    .foregroundStyle(row.isEnabled ? .primary : .secondary)
                    .lineLimit(1)
                Text(row.detail)
                    .font(.orbitListSubtitle)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 8)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    /// What a workspace's next session would start on, as its row names it (web `SessionMoveModal`): an
    /// engine's own sign-in by the engine's CLI, anything else by its label.
    private func providerName(_ slug: String) -> String {
        ProviderEngines.isEngine(slug) ? ProviderEngines.cliName(slug)
            : AgentDefaults.providerName(slug, configured: app.agents?.configuredProviders)
    }

    /// Ask the server for the second group — when the panel opens, when it comes back to it from a
    /// workspace's page, and after a move that didn't go through, whose reason may have changed.
    private func loadTargets() async {
        do {
            targets = try await app.sessionMoveTargets(session.id)
            targetsFailure = nil
        } catch APIError.http(let status, _) where status == 404 {
            targetsUnsupported = true
        } catch {
            // An answer already on screen stays; only an empty group says it couldn't be read.
            if targets == nil { targetsFailure = SessionMoveCopy.targetsFailed(error) }
        }
    }

    /// A tap files the session there and closes the panel; on the ticked row it only closes it.
    /// Dismiss first, then move, in `AgentSwitchSheet`'s order.
    private func choose(_ option: SessionMoveFolderOption) {
        dismiss()
        guard !option.isCurrent else { return }
        app.moveSession(session.id, toFolder: option.folder?.id)
    }

    /// Create: the folder in this workspace, then the session moved into it and the panel closed. A
    /// name the server refuses keeps the panel up with the reason, and the draft for another try.
    private func create() {
        guard let name = SessionMoveLogic.folderName(draft) else { return }
        creating = true
        Task {
            let refused = await app.createSessionFolder(named: name, in: workspace, moving: session.id)
            creating = false
            if let refused { failure = refused } else { dismiss() }
        }
    }

    private var failed: Binding<Bool> {
        Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })
    }
}
#endif
