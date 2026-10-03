import SwiftUI
import OrbitKit

#if os(iOS)
/// A workspace opened from the Move panel's second group (docs/session-folders-move-design.md §4,
/// §5.3; mock 03 ①): pushed in the panel's own stack, the workspace's name over the session's title,
/// Done at the top right. One group, the folders the session can be filed in there — No Folder, each
/// folder with its count, New Folder… — and under it a sentence saying which runner the session goes
/// to and how the conversation carries over.
///
/// A tap asks first, always, since the session leaves its workspace (`Move to <workspace>?`, its body
/// put together from the server's answer). The button is Move, or End and Move for a session that is
/// idle but not ended — which the app ends, waits on, then moves (`AppModel.moveSession(_:to:…)`),
/// the panel saying which step it is on. Moved, the panel closes on the app's toast; refused, an alert
/// says why and the panel reads the server's answer again.
struct SessionMoveTargetPage: View {
    @Environment(AppModel.self) private var app
    let session: Session
    /// The workspace the session is in now, which keeps its changes.
    let workspace: Agent
    /// The workspace the row was opened for, as the panel had it then.
    let target: SessionMoveTarget
    /// The panel's latest answer: what the confirmation says and whether it ends the session first.
    let answer: SessionMoveTargets
    /// Closes the panel: Done, and a move that went through.
    let close: () -> Void
    /// Asks the panel to read the server's answer again.
    let reload: () async -> Void

    /// The folder a tap picked — nil inside for No Folder — while its confirmation is up.
    @State private var picked: Pick?
    /// The step a confirmed move is on; nil when none is under way.
    @State private var phase: SessionWorkspaceMove.Phase?
    /// Why the last move didn't go through, shown as an alert.
    @State private var failure: String?
    /// New Folder…'s name prompt, its draft, the wait on the server, and a refusal.
    @State private var naming = false
    @State private var draft = ""
    @State private var creating = false
    @State private var createFailure: String?
    /// Folders made from this page, until the server's answer lists them.
    @State private var made: [SessionMoveFolder] = []

    private struct Pick: Equatable {
        let folder: SessionMoveFolder?
    }

    var body: some View {
        List {
            Section {
                Button { picked = Pick(folder: nil) } label: { row(nil) }
                    .buttonStyle(.plain)
                ForEach(SessionWorkspaceMoveLogic.folders(of: current, adding: made)) { folder in
                    Button { picked = Pick(folder: folder) } label: { row(folder) }
                        .buttonStyle(.plain)
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
                Text(SessionMoveCopy.folderGroup(workspace: current.name))
            } footer: {
                Text(blocked ?? SessionMoveCopy.targetFooter(current))
            }
            .disabled(blocked != nil)
        }
        .disabled(creating || phase != nil)
        .safeAreaInset(edge: .bottom) {
            if let phase {
                HStack(spacing: 10) {
                    ProgressView()
                    Text(SessionMoveCopy.progress(phase))
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 12)
                .background(.regularMaterial, in: Capsule())
                .padding(.bottom, 8)
            }
        }
        .navigationTitle(current.name)
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(phase != nil)
        .interactiveDismissDisabled(phase != nil)
        .toolbar {
            ToolbarItem(placement: .principal) { title }
            ToolbarItem(placement: .topBarTrailing) {
                Button(SessionMoveCopy.done) { close() }
                    .disabled(phase != nil)
            }
        }
        .alert(SessionMoveCopy.confirmTitle(current), isPresented: confirming, presenting: picked) { pick in
            Button(SessionMoveCopy.cancel, role: .cancel) {}
            Button(SessionMoveCopy.confirmAction(answer)) { move(pick) }
                .keyboardShortcut(.defaultAction)
        } message: { _ in
            Text(SessionMoveCopy.confirmMessage(answer, to: current, from: workspace.name))
        }
        .alert(SessionMoveCopy.couldNotMove, isPresented: failed) {
            Button(SessionMoveCopy.ok, role: .cancel) {}
        } message: {
            Text(failure ?? "")
        }
        .alert(SessionMoveCopy.newFolderTitle, isPresented: $naming) {
            TextField(SessionMoveCopy.folderNamePlaceholder, text: $draft)
            Button(SessionMoveCopy.create) { create() }
                .keyboardShortcut(.defaultAction)
            Button(SessionMoveCopy.cancel, role: .cancel) {}
        } message: {
            Text(SessionMoveCopy.newFolderMessage)
        }
        .alert(SessionMoveCopy.couldNotCreate, isPresented: createFailed) {
            Button(SessionMoveCopy.ok, role: .cancel) {}
        } message: {
            Text(createFailure ?? "")
        }
    }

    /// The workspace as the panel's latest answer has it — the page outlives the answer it was opened
    /// from, which a move that didn't go through reads again.
    private var current: SessionMoveTarget {
        answer.targets.first { $0.workspaceId == target.workspaceId } ?? target
    }

    /// Why the session can't go here now — it can't leave at all, or not to this workspace — after an
    /// answer read since the page opened. Its folders are greyed and this is said under them.
    private var blocked: String? {
        answer.reason ?? current.reason
    }

    /// The workspace's name over the session's title, as the panel's own title is drawn.
    private var title: some View {
        VStack(spacing: 1) {
            Text(current.name)
                .font(.headline)
                .lineLimit(1)
            Text(SessionHeader.title(for: session, fallbackAgent: workspace.name))
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .frame(maxWidth: 240)
        .accessibilityElement(children: .combine)
    }

    /// A place there to file the session: No Folder, or a folder with its count. Nothing is ticked —
    /// the session isn't in this workspace yet.
    private func row(_ folder: SessionMoveFolder?) -> some View {
        HStack(spacing: 12) {
            Image(systemName: folder == nil ? "tray" : "folder")
                .foregroundStyle(folder == nil ? Color.secondary : Color.indigo)
                .frame(width: 24)
                .accessibilityHidden(true)
            Text(folder?.name ?? SessionMoveCopy.noFolder)
                .foregroundStyle(.primary)
                .lineLimit(1)
            Spacer(minLength: 8)
            if let folder {
                Text("\(folder.sessionCount)")
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
        }
        .contentShape(Rectangle())
    }

    /// The confirmed move: the panel says which step it is on, closes once the session is there, and
    /// otherwise says why it isn't and reads the server's answer again.
    private func move(_ pick: Pick) {
        phase = answer.needsEnd ? .ending : .moving
        Task {
            let refused = await app.moveSession(session.id, to: current, folder: pick.folder?.id,
                                                endingFirst: answer.needsEnd) { phase = $0 }
            phase = nil
            if let refused {
                failure = refused
                await reload()
            } else {
                close()
            }
        }
    }

    /// Create: the folder in this workspace, then the confirmation to move the session into it. A
    /// name the server refuses keeps the page with the reason, and the draft for another try.
    private func create() {
        guard let name = SessionMoveLogic.folderName(draft) else { return }
        creating = true
        Task {
            do {
                let folder = try await app.createTargetFolder(named: name, inWorkspace: current.workspaceId)
                let filed = SessionMoveFolder(id: folder.id, name: folder.name)
                made.append(filed)
                draft = ""
                creating = false
                picked = Pick(folder: filed)
            } catch {
                creating = false
                createFailure = SessionMoveCopy.createFailure(error, name: name, workspace: current.name)
            }
        }
    }

    private var confirming: Binding<Bool> {
        Binding(get: { picked != nil }, set: { if !$0 { picked = nil } })
    }

    private var failed: Binding<Bool> {
        Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })
    }

    private var createFailed: Binding<Bool> {
        Binding(get: { createFailure != nil }, set: { if !$0 { createFailure = nil } })
    }
}
#endif
