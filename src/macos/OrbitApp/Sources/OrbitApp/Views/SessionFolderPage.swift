#if os(iOS)
import SwiftUI
import OrbitKit

// The folders, as the session list draws them (docs/session-folders-move-design.md §3.3–3.4, mock
// 02): a row per folder at the very top of a workspace's Open and Completed list, and — one tap
// deeper — a folder's own page, whose title is the folder's name over its workspace's.
//
// A folder's row reports for the sessions it hides: they are drawn behind it and nowhere else, so
// it carries the one live state they have between them, by the drawer Workspace row's rule, plus
// how many of the list's sessions are filed in it (`SessionFolderGrouping` computes both — this
// file only draws them). Left as they are, they take the number of sessions in the list, so an
// empty folder still reads 0 and a folder the Completed list has nothing in is not drawn at all.
//
// The page a row opens is an ordinary session list — Pinned, then the recency sections, the same
// rows with the same swipes and long-press menus — over `SessionFolderGrouping.sessions` for the
// scope the list it was opened from was showing (§3.3). Its ✎ opens the draft whose created session
// lands in the folder (the `folderId` on the create request rides the frame), and its ⋯ (or a long
// press on the row) offers Rename… and Delete Folder….

/// A folder's row at the top of a workspace's session list (§3.3): the folder glyph, its name, and
/// the one state it reports for the sessions inside it plus how many there are.
struct SessionFolderRowView: View {
    let row: SessionFolderRow

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "folder")
                .font(.orbitGlyph)
                .foregroundStyle(Color.accentColor)
                .frame(width: 24)
                .accessibilityHidden(true)
            Text(row.folder.name)
                .lineLimit(1)
                .foregroundStyle(.primary)
                .layoutPriority(2)
            Spacer(minLength: 6)
            // The same three marks, in the same order and the same words, as the drawer's Workspace
            // row (`WorkspaceNavigationRow`): the folder stands in for the sessions it hides, so it
            // has to say what they would have said.
            switch row.status {
            case .needsYou(let count):
                NeedsYouCountCapsule(count: count)
            case .running:
                SpinnerGlyph(color: .secondary)
                    .accessibilityLabel("Session running")
            case .jobs:
                BreathingGlyph(systemImage: "terminal")
                    .accessibilityLabel("Background job running")
            case .idle:
                EmptyView()
            }
            Text("\(row.sessionCount)")
                .font(.orbitMeta)
                .monospacedDigit()
                .foregroundStyle(.secondary)
            Image(systemName: "chevron.right")
                .font(.orbitMeta.weight(.semibold))
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityValue(folderStatusWords)
    }

    /// What VoiceOver reads for the state the trailing slot draws — the same words the session rows
    /// use for the same facts.
    private var folderStatusWords: String {
        switch row.status {
        case .needsYou(let count): return "\(count) waiting for you"
        case .running:             return "Session running"
        case .jobs:                return "Background job running"
        case .idle:                return "\(row.sessionCount) sessions"
        }
    }
}

/// A folder about to be deleted, and how many of the list's sessions are in it — the number the
/// confirmation names (design §3.4). Held by whichever surface raised the question.
struct SessionFolderDeletion: Equatable {
    let folder: SessionFolder
    let sessionCount: Int
}

/// One folder's page (§3.3, mock 02's middle phone): the sessions filed in it, under its name and
/// its workspace's. Both shells render this same page — the compact shell pushes it onto the
/// Agents stack (system back and the left-edge swipe come with it), and a three-column shell draws
/// it in the session column, where `rowNavigation == .selection` adds the column's own back button.
struct SessionFolderPage: View {
    @Environment(AppModel.self) private var app
    /// Which folder, whose workspace, and the scope of the list it was opened from — carried by the
    /// frame that shows it.
    let address: SessionFolderAddress
    /// How this page's rows navigate: the container's fact, exactly as it is for the workspace
    /// list, and the same one read — the column has no system back button, so it gets one here.
    var rowNavigation: SessionRowNavigation = .push
    /// The session search field's text, where the container has one: a wide shell's session column
    /// keeps its search drawer over this page, so the field goes on working here — hits stand in for
    /// the sections, as they do over the workspace's list. A phone's pushed page has no field, and
    /// passes nil.
    var searchQuery: Binding<String>? = nil

    @State private var rowSwipe = RowSwipeState()
    /// The row whose action was tapped — the sheets below are held by the page, as the workspace
    /// list holds its own, so they present reliably from a row's swipe or long-press menu.
    @State private var taggingSession: Session?
    @State private var sharingSession: Session?
    @State private var movingSession: Session?
    /// Rename… / Delete Folder… (the ⋯ menu, or a long press on the folder row outside), presented
    /// by the shared `sessionFolderManagement`.
    @State private var renamingFolder: SessionFolder?
    @State private var deletingFolder: SessionFolderDeletion?
    /// What came back for the search field's text — the same in-place search the workspace list runs.
    @State private var hits: [SessionSearchHit] = []
    @State private var hitsQuery = ""
    @State private var contentSearched = true
    @State private var searching = false
    /// The Pinned section's fold, shared with the workspace list's by its storage key: folding it on
    /// one list folds it on both, which is what "the same list" means here.
    @AppStorage("sessionList.pinnedCollapsed") private var pinnedCollapsed = false

    private var agent: Agent? { app.agents?.agent(address.agentID) }
    private var folder: SessionFolder? { app.sessionFolders.first { $0.id == address.folderID } }
    /// The folder's sessions, in the list's order — the page's own list, and what the Move panel
    /// counts its folders over.
    private var sessions: [Session] {
        guard let agents = app.agents else { return [] }
        return SessionFolderGrouping.sessions(agents.agentSessions, inFolder: address.folderID,
                                              view: address.view)
    }
    private var timeSections: [SessionTimeSection] {
        SessionTimeGrouping.sections(sessions, pinnedFirst: address.view == .open)
    }
    private var query: String {
        searchQuery?.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }
    private var isSearching: Bool { !query.isEmpty }

    var body: some View {
        Group {
            if let agent {
                list(agent: agent)
            } else {
                // The workspace itself is gone (or the list it belongs to hasn't loaded): there is
                // nothing to draw the page over, so say so rather than show an empty list.
                ContentUnavailableView("Folder unavailable", systemImage: "folder")
            }
        }
        .toolbar {
            // The phone's back button is the stack's; the wide shell's column has no stack, so the
            // page brings its own (§3.3).
            if rowNavigation == .selection {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        app.leaveFolder(address.folderID)
                    } label: {
                        Label("Back", systemImage: "chevron.backward")
                    }
                    .accessibilityLabel("Back to the workspace's sessions")
                }
            }
            ToolbarItem(placement: .principal) { title }
            ToolbarItem(placement: .topBarTrailing) { folderMenu }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    app.startComposingSession(inFolder: address.folderID, of: address.agentID)
                } label: {
                    Label("New session", systemImage: "square.and.pencil")
                }
                .accessibilityLabel("Start a new session in \(titleText)")
            }
        }
        // The two management asks, in the same words the row's long-press menu asks them in.
        .sessionFolderManagement(renaming: $renamingFolder, deleting: $deletingFolder)
        .sheet(item: $taggingSession) { s in
            SessionTagSheet(session: s).environment(app)
        }
        .sheet(item: $sharingSession) { s in
            if let baseURL = app.baseURL {
                ShareSheet(kind: .session, rootID: s.id, baseURL: baseURL, tokenStore: app.tokenStore)
            }
        }
        .sheet(item: $movingSession) { s in
            if let agent {
                SessionMoveSheet(session: s, workspace: agent, listed: sessions).environment(app)
            }
        }
        // Keep the page's rows fresh while it is the page on screen: pushing it cancels the list
        // beneath (`AgentPanes`' own task), and in a wide shell it replaces that list outright.
        // Completed keeps its poll; Open is served by the app's shared snapshot, so one read is
        // enough there.
        .task(id: "\(address.agentID)|\(address.view.rawValue)") {
            await app.agents?.loadSessions(agentID: address.agentID, view: address.view)
            guard address.view != .open else { return }
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                if Task.isCancelled { break }
                await app.agents?.loadSessions(agentID: address.agentID, view: address.view)
            }
        }
        .task(id: query) { await runSearch() }
    }

    /// The page's list: an ordinary session list — the recency sections with their Pinned fold, the
    /// rows as every other list draws them (see `sessionRow`), and the same pull-to-refresh.
    private func list(agent: Agent) -> some View {
        @Bindable var app = app
        return List(selection: rowNavigation == .selection ? $app.selectedAgentSessionID : nil) {
            if isSearching {
                searchResults
            } else {
                ForEach(Array(timeSections.enumerated()), id: \.element.id) { index, section in
                    if index == 0, section.title == "Today" {
                        // The leading "Today" keeps no title, exactly as the workspace list draws it
                        // (the first row drops its top separator with the title).
                        ForEach(section.sessions) { session in
                            if session.id == section.sessions.first?.id {
                                sessionRow(session).listRowSeparator(.hidden, edges: .top)
                            } else {
                                sessionRow(session)
                            }
                        }
                    } else if section.title == "Pinned" {
                        Section {
                            if !pinnedCollapsed {
                                ForEach(section.sessions) { sessionRow($0) }
                            }
                        } header: {
                            pinnedSectionHeader(section.title)
                        }
                    } else {
                        Section {
                            ForEach(section.sessions) { sessionRow($0) }
                        } header: {
                            Text(section.title).textCase(nil)
                        }
                    }
                }
            }
        }
        .listStyle(.plain)
        .rowSwipeList(rowSwipe)
        .refreshable {
            await app.agents?.loadSessions(agentID: address.agentID, view: address.view)
        }
        .overlay {
            if isSearching {
                if hits.isEmpty && !searching && !hitsQuery.isEmpty {
                    ContentUnavailableView("No matches", systemImage: "magnifyingglass",
                                           description: Text("Nothing matches \u{201C}\(hitsQuery)\u{201D}."))
                }
            } else if sessions.isEmpty && !(app.agents?.sessionsLoading ?? false) {
                ContentUnavailableView("Nothing in this folder", systemImage: "folder")
            }
        }
    }

    /// Move, over the folder's name, and the workspace it belongs to under it in grey — the page's
    /// own title, as the folder page in the mock carries it.
    private var title: some View {
        VStack(spacing: 1) {
            Text(titleText)
                .font(.headline)
            if let agent {
                Text(agent.name)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: 240)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    private var titleText: String { folder?.name ?? "Folder" }

    /// ⋯ — Rename… and Delete Folder…, the same two the row's long-press menu offers (§3.4).
    private var folderMenu: some View {
        Menu {
            Button {
                renamingFolder = folder
            } label: {
                Label(SessionFolderCopy.rename, systemImage: "pencil")
            }
            Button(role: .destructive) {
                deletingFolder = folder.map { SessionFolderDeletion(folder: $0, sessionCount: sessions.count) }
            } label: {
                Label(SessionFolderCopy.delete, systemImage: "trash")
            }
            .disabled(folder == nil)
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel("Folder actions")
    }

    /// One row, wrapped for the container it is in — the workspace list's own arrangement, repeated
    /// here so a folder's page and the list outside behave identically (see `AgentPanes.sessionRow`).
    @ViewBuilder private func sessionRow(_ s: Session) -> some View {
        let row = AgentSessionRow(session: s, deleted: address.view == .trash, showsPin: address.view == .open)
        switch rowNavigation {
        case .selection:
            row.sessionRowActions(s, scope: address.view, onTag: { taggingSession = s },
                                  onShare: { sharingSession = s }, onMove: { movingSession = s })
                .tag(s.id)
        case .push:
            Button { app.push(.console(sessionID: s.id, origin: .list)) } label: {
                row.foregroundStyle(.primary)
            }
            .sessionRowActions(s, scope: address.view, onTag: { taggingSession = s },
                               onShare: { sharingSession = s }, onMove: { movingSession = s })
        }
    }

    /// The Pinned section's header: its title, and a chevron that points down while the rows show
    /// and right once they are folded away, the whole band being the button.
    private func pinnedSectionHeader(_ title: String) -> some View {
        Button {
            withAnimation { pinnedCollapsed.toggle() }
        } label: {
            HStack {
                Text(title).textCase(nil)
                Spacer()
                Image(systemName: "chevron.right")
                    .rotationEffect(.degrees(pinnedCollapsed ? 0 : 90))
                    .accessibilityHidden(true)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(.isHeader)
        .accessibilityHint(pinnedCollapsed ? "Shows the pinned sessions" : "Hides the pinned sessions")
    }

    /// Search hits, standing in for the sections while the field has text — the workspace list's
    /// own rows and words, since the field is the app's search wherever it is typed.
    @ViewBuilder private var searchResults: some View {
        Section {
            ForEach(hits) { hit in
                Button { app.route(to: .session(hit.id)) } label: {
                    SessionSearchRow(hit: hit, query: hitsQuery)
                }
                .buttonStyle(.plain)
            }
        } header: {
            Text(contentSearched
                 ? "All sessions"
                 : "Matching names only — type more to search message text.")
                .textCase(nil)
        }
    }

    /// Debounced server-side search behind the field. `.task(id:)` cancels the previous run on each
    /// keystroke, so the sleep *is* the debounce — a cancelled run never reaches the request.
    private func runSearch() async {
        let q = query
        guard !q.isEmpty else {
            hits = []
            hitsQuery = ""
            return
        }
        try? await Task.sleep(for: sessionSearchDebounce)
        if Task.isCancelled { return }
        searching = true
        defer { searching = false }
        guard let res = await app.searchSessions(q), !Task.isCancelled else { return }
        hits = res.hits
        contentSearched = res.contentSearched
        hitsQuery = res.q
    }
}

/// Rename… and Delete Folder… — the two management acts (§3.4) — presented from whichever surface
/// offered them: a folder row's long-press menu, or a folder page's ⋯. One modifier, so the two ask
/// the same question in the same words, and rename's refusal and delete's failure land the same way
/// wherever they were raised.
private struct SessionFolderManagement: ViewModifier {
    @Environment(AppModel.self) private var app
    @Binding var renaming: SessionFolder?
    @Binding var deleting: SessionFolderDeletion?
    /// The rename prompt's draft, seeded from the folder's current name when the prompt opens and
    /// kept through a refusal, so another try starts from what was typed.
    @State private var draft = ""
    /// Why the last rename / delete didn't go through, shown as an alert.
    @State private var failure: Failure?

    private struct Failure: Identifiable {
        let id = UUID()
        let title: String
        let message: String
    }

    func body(content: Content) -> some View {
        content
            .alert(SessionFolderCopy.renameTitle, isPresented: renamingPresented) {
                TextField(SessionFolderCopy.namePlaceholder, text: $draft)
                // Default action, so Return in the field saves, as it creates in the Move panel.
                Button(SessionFolderCopy.save) { rename() }
                    .keyboardShortcut(.defaultAction)
                Button(SessionFolderCopy.cancel, role: .cancel) {}
            }
            .onChange(of: renaming) { _, folder in
                if let folder { draft = folder.name }
            }
            .confirmationDialog(deleteTitle, isPresented: deletingPresented, titleVisibility: .visible) {
                Button(SessionFolderCopy.deleteConfirm, role: .destructive) { delete() }
                Button(SessionFolderCopy.cancel, role: .cancel) {}
            } message: {
                Text(SessionFolderCopy.deleteMessage(sessionCount: deleting?.sessionCount ?? 0))
            }
            .alert(failure?.title ?? "", isPresented: failurePresented) {
                Button(SessionFolderCopy.ok, role: .cancel) {}
            } message: {
                Text(failure?.message ?? "")
            }
    }

    private var renamingPresented: Binding<Bool> {
        Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })
    }

    private var deleteTitle: String {
        deleting.map { SessionFolderCopy.deleteTitle($0.folder.name) } ?? ""
    }

    private var deletingPresented: Binding<Bool> {
        Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })
    }

    private var failurePresented: Binding<Bool> {
        Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })
    }

    /// Save: the name without the space around it, ignored when that leaves nothing (the same rule
    /// the Move panel's New Folder… follows), then the server's answer.
    private func rename() {
        guard let folder = renaming,
              let name = SessionMoveLogic.folderName(draft) else { return }
        renaming = nil
        guard name != folder.name else { return }
        Task { @MainActor in
            if let refused = await app.renameSessionFolder(folder.id, to: name) {
                failure = Failure(title: SessionFolderCopy.couldNotRename, message: refused)
            }
        }
    }

    private func delete() {
        guard let deletion = deleting else { return }
        deleting = nil
        Task { @MainActor in
            if let refused = await app.deleteSessionFolder(deletion.folder.id) {
                failure = Failure(title: SessionFolderCopy.couldNotDelete, message: refused)
            }
        }
    }
}

extension View {
    /// Rename… and Delete Folder… for the folder a surface offered them on — see
    /// `SessionFolderManagement`.
    func sessionFolderManagement(renaming: Binding<SessionFolder?>,
                                 deleting: Binding<SessionFolderDeletion?>) -> some View {
        modifier(SessionFolderManagement(renaming: renaming, deleting: deleting))
    }
}
#endif
