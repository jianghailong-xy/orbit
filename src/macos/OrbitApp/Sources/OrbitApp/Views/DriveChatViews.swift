import SwiftUI
import OrbitKit

// The Drive chat on iOS and macOS (board docs/mocks/drive-chat/02-native, owner-approved 2026-11-26): the Wiki chat's
// model, panel, composer, history and round button (`WikiChatModel` with `ChatOrigin.drive`, `WikiChatPanel`,
// `WikiChatFab`), docked on Drive. On an iPad at a regular width and on a Mac the panel is the third column, open by
// default until ✕, which this device keeps per account (frames 1-4); on an iPhone it is a two-height sheet the round
// button opens (frames 5-8). The folder open is the composer's first chip, the file open (or the Mac's selection) the
// next; a chat's change groups and overwrite questions are cards after their turn; the rows a chat made, moved or
// renamed carry a mark until opened. Trash and Storage have no chat.
//
// Every word is `DriveChatCopy`'s and every rule `DriveChatLogic`'s (OrbitKit), held there to the web.

// MARK: - what every Drive host does

/// Reads the Drive chats and keeps them fresh, follows the folder and the file into the composer's chips, offers the
/// owner's workspaces to Runs in, and opens the panel by default where it is a column. Hung on whichever view hosts the
/// panel: the iPad's and the Mac's detail column, the iPhone's Drive stack.
private struct DriveChatLive: ViewModifier {
    @Environment(AppModel.self) private var app
    let chat: WikiChatModel
    /// The panel is a sheet here (a compact width): it never opens on its own.
    let sheet: Bool
    /// Whether the page wears the chat: the drive's files, not Trash or Storage.
    let shown: Bool

    func body(content: Content) -> some View {
        content
            .task(id: app.user?.id) {
                chat.signedIn(app.user?.id)
                chat.setWorkspaceChoices(choices)
                await chat.load(spaceID: DriveChatLogic.scope)
                chat.openByDefault(spaceID: DriveChatLogic.scope, settingsOnTop: !shown)
            }
            // Read again while a turn runs (the web's 10 s; the cards' 5 s), and now and then at rest.
            .task(id: chat.presented) {
                while !Task.isCancelled {
                    let working = chat.driveRead?.fab.working ?? false
                    try? await Task.sleep(nanoseconds: (working || chat.presented ? 5 : 20) * 1_000_000_000)
                    guard !Task.isCancelled else { return }
                    await chat.load(spaceID: DriveChatLogic.scope)
                }
            }
            .onChange(of: choices) { _, choices in chat.setWorkspaceChoices(choices) }
            .onChange(of: sheet, initial: true) { _, sheet in
                chat.asSheet = sheet
                // A panel the page opened folds away at a phone's width and comes back at a wide one.
                chat.openByDefault(spaceID: DriveChatLogic.scope, settingsOnTop: !shown)
            }
            .onChange(of: shown) { _, shown in chat.openByDefault(spaceID: DriveChatLogic.scope, settingsOnTop: !shown) }
            .onChange(of: followKey, initial: true) { _, _ in follow() }
            // The panel's chat streams while it is open on Drive (`AppModel.syncConsoleFocus`).
            .onChange(of: chat.focusedSessionID) { _, _ in app.syncConsoleFocus() }
            .onAppear { app.syncConsoleFocus() }
            .onDisappear { app.syncConsoleFocus() }
    }

    /// The owner's workspaces, as Runs in lists them (`driveChatWorkspace`).
    private var choices: [WikiChatWorkspace] {
        guard let agents = app.agents else { return [] }
        return agents.items.map { agent in
            WikiChatWorkspace(id: agent.id, name: agent.name, runner: agent.runnerId.flatMap { agents.runnerNames[$0] },
                              online: agent.runnerId.flatMap { agents.runnerOnline[$0] } ?? false)
        }
    }

    /// What the chips follow, as one value to watch.
    private var followKey: String {
        let page = current
        return [page.folderID ?? "/", page.folderName, page.fileIDs.joined(separator: ","), page.fileNames.joined(separator: ",")]
            .joined(separator: "|")
    }

    /// The folder open and the files beside it: on a Mac the list's folder and its selection; elsewhere the Drive stack's
    /// last folder and the file page on top of it.
    private var current: (folderID: String?, folderName: String, fileIDs: [String], fileNames: [String]) {
        guard let drive = app.drive else { return (nil, DriveLogic.title, [], []) }
        #if os(macOS)
        let rows = drive.rows.filter { drive.selection.contains($0.id) }
        return (drive.folderID, drive.folderID == nil ? DriveLogic.title : drive.folderTitle, rows.map(\.id), rows.map(\.name))
        #else
        var folder: (String?, String) = (nil, DriveLogic.title)
        for node in app.nav.path {
            if case .driveFolder(let id, let name) = node { folder = (id, drive.known[id]?.name ?? name) }
        }
        if case .driveFile(let id)? = app.nav.path.last, let entry = drive.known[id] {
            return (folder.0, folder.1, [entry.id], [entry.name])
        }
        return (folder.0, folder.1, [], [])
        #endif
    }

    private func follow() {
        let page = current
        chat.follow(spaceID: DriveChatLogic.scope,
                    page: .folder(folderId: page.folderID, label: DriveChatCopy.folderLabel(page.folderName)))
        chat.files(page.fileIDs.isEmpty ? nil : WikiChatLogic.Files(ids: page.fileIDs, names: page.fileNames))
    }
}

extension View {
    fileprivate func driveChatLive(_ chat: WikiChatModel, sheet: Bool, shown: Bool) -> some View {
        modifier(DriveChatLive(chat: chat, sheet: sheet, shown: shown))
    }
}

/// The round button for Drive: the Wiki's, its words the drive's, at the bottom right of the column it is in.
private struct DriveChatButton: View {
    let chat: WikiChatModel
    let compact: Bool

    var body: some View {
        let inset = CGFloat(compact ? WikiChatLogic.Fab.phoneInset : WikiChatLogic.Fab.wideInset)
        WikiChatFab(look: chat.fab(DriveChatLogic.scope),
                    diameter: CGFloat(compact ? WikiChatLogic.Fab.phoneDiameter : WikiChatLogic.Fab.wideDiameter),
                    identifier: "drive-chat-fab") {
            chat.openFromButton(spaceID: DriveChatLogic.scope)
        }
        .padding(.trailing, inset)
        .padding(.bottom, inset)
        .transition(.scale.combined(with: .opacity))
    }
}

// MARK: - the third column (iPad regular width, Mac; frames 1-4)

/// Drive's detail column: the chat while it is open, else what the column showed before — the Mac's inspector (or
/// Trash's summary, Storage's rankings), the iPad's empty Drive — with the round button at its bottom right. On a Mac
/// at 1760 or wider, a selected file's details stand beside the chat (four columns); narrower, they overlay the list.
struct DriveChatColumn: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        if let chat = app.driveChat, let drive = app.drive {
            let shown = shown(drive)
            Group {
                if shown && chat.presented {
                    #if os(macOS)
                    if !DriveChatLogic.detailsOverlay(chatOpen: true, windowWidth: Double(chat.windowWidth)), drive.selection.count == 1 {
                        HStack(spacing: 0) {
                            DriveDetailColumn().frame(width: 280)
                            Divider()
                            panel(chat)
                        }
                    } else {
                        panel(chat)
                    }
                    #else
                    panel(chat)
                    #endif
                } else {
                    // The whole column, so the button sits at its bottom right whatever the column draws (board ④).
                    base
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .overlay(alignment: .bottomTrailing) {
                            if shown { DriveChatButton(chat: chat, compact: false) }
                        }
                }
            }
            .animation(.snappy(duration: 0.25), value: chat.presented)
            #if os(macOS)
            // The detail column's right edge is the window's: what decides whether details stand beside the chat.
            .onGeometryChange(for: CGFloat.self, of: { $0.frame(in: .global).maxX }) { chat.windowWidth = $0 }
            #endif
            .driveChatLive(chat, sheet: false, shown: shown)
        } else {
            base
        }
    }

    private func panel(_ chat: WikiChatModel) -> some View {
        WikiChatPanel(chat: chat, scope: DriveChatLogic.scope, compact: false)
            .accessibilityIdentifier("drive-chat-panel")
    }

    private func shown(_ drive: DriveModel) -> Bool {
        #if os(macOS)
        return DriveChatLogic.shown(drive.place)
        #else
        switch app.nav.path.last {
        case .driveTrash?, .driveStorage?: return false
        default: return true
        }
        #endif
    }

    @ViewBuilder
    private var base: some View {
        #if os(macOS)
        DriveDetailColumn()
        #else
        ContentUnavailableView(DriveLogic.title, systemImage: AppSection.drive.systemImage)
        #endif
    }
}

// MARK: - the sheet (iPhone, iPad compact; frames 5-8)

#if os(iOS)
/// The iPhone's Drive stack with its chat: the round button at the bottom right of every Drive page but Trash and
/// Storage, and the two-height sheet it opens, whose half height leaves the list behind it scrollable. Never open on
/// its own.
private struct DriveChatSheetHost: ViewModifier {
    @Environment(AppModel.self) private var app
    @State private var detent: PresentationDetent = .medium

    func body(content: Content) -> some View {
        if let chat = app.driveChat {
            let shown: Bool = {
                switch app.nav.path.last {
                case .driveTrash?, .driveStorage?: return false
                default: return true
                }
            }()
            content
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    Color.clear.frame(height: shown ? CGFloat(WikiChatLogic.Fab.footClearance) : 0)
                }
                .overlay(alignment: .bottomTrailing) {
                    if shown && !chat.presented { DriveChatButton(chat: chat, compact: true) }
                }
                .animation(.snappy(duration: 0.25), value: chat.presented)
                .sheet(isPresented: Binding(get: { chat.presented }, set: { if !$0 { chat.close() } })) {
                    WikiChatPanel(chat: chat, scope: DriveChatLogic.scope, compact: true)
                        .presentationDetents([.medium, .large], selection: $detent)
                        .presentationBackgroundInteraction(.enabled(upThrough: .medium))
                        .presentationContentInteraction(.scrolls)
                        .presentationDragIndicator(.visible)
                        .accessibilityIdentifier("drive-chat-panel")
                }
                .onChange(of: chat.presented) { _, open in if open && chat.focusCard == nil { detent = .medium } }
                .driveChatLive(chat, sheet: true, shown: shown)
        } else {
            content
        }
    }
}

extension View {
    /// The Drive chat on the iPhone's Drive stack (`DriveChatSheetHost`).
    func driveChatSheetHost() -> some View { modifier(DriveChatSheetHost()) }
}
#endif

// MARK: - the cards (frames 2, 3, 7, 8)

/// A Drive chat's card in its conversation, by its id: a change group or an overwrite question.
struct DriveChatCardSlot: View {
    let chat: WikiChatModel
    let id: String

    var body: some View {
        switch chat.driveCard(id) {
        case .changes(let group)?:
            DriveChangesCard(chat: chat, group: group)
        case .question(let question)?:
            DriveReplaceCard(chat: chat, question: question)
        case nil:
            EmptyView()
        }
    }
}

/// The frame every Drive card shares: a tinted head with its title and state, its body, its buttons.
private struct DriveCardFrame<Body: View, Actions: View>: View {
    let title: String
    let state: String?
    let tone: DriveChatLogic.CardTone
    @ViewBuilder let content: () -> Body
    @ViewBuilder let actions: () -> Actions
    var hasActions = true

    private var tint: Color {
        switch tone {
        case .done: return .green
        case .needsYou: return .orange
        case .quiet: return .secondary
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(title).font(.orbitSubtext.weight(.semibold))
                Spacer(minLength: 8)
                if let state {
                    Text(state)
                        .font(.orbitLabel.weight(.medium))
                        .foregroundStyle(tone == .quiet ? Color.secondary : tint)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(tint.opacity(tone == .quiet ? 0.08 : 0.12))
            VStack(alignment: .leading, spacing: 4) {
                content()
            }
            .font(.orbitSubtext)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            if hasActions {
                Divider()
                actions()
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
            }
        }
        .background(Color.driveCardBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.secondary.opacity(0.22)))
        .accessibilityElement(children: .contain)
    }
}

/// A card's button: small and outlined in a column; on a phone a filled bar sharing the width (frames 7-8).
private struct DriveCardButton: View {
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var hSize
    #endif
    let title: String
    var primary = false
    var disabled = false
    let action: () -> Void

    private var fill: Bool {
        #if os(iOS)
        return hSize == .compact
        #else
        return false
        #endif
    }

    var body: some View {
        if fill {
            Button(action: action) {
                Text(title)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(primary ? Color.white : Color.accentColor)
                    .frame(maxWidth: .infinity, minHeight: 40)
                    .background(primary ? Color.accentColor : Color.secondary.opacity(0.12),
                                in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(disabled)
            .opacity(disabled ? 0.5 : 1)
        } else if primary {
            Button(title, action: action)
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(disabled)
        } else {
            Button(title, action: action)
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(disabled)
        }
    }
}

/// One turn's changes (frames 2, 7): the result first, the first four items, `and N more`, Show all, Undo — or, held
/// past 200, `N changes waiting for Apply` and Apply; once undone, what Undo left as it was.
struct DriveChangesCard: View {
    let chat: WikiChatModel
    let group: DriveChatChangeGroup
    @State private var all = false

    var body: some View {
        let look = DriveChatLogic.changesLook(group, all: all, pressing: chat.pressing.contains("group:\(group.id)"))
        let hasActions = look.toggle != nil || look.undo || look.apply
        DriveCardFrame(title: DriveChatCopy.changesTitle, state: look.state, tone: look.tone, content: {
            if let pending = look.pending { Text(pending) }
            ForEach(look.lines) { line in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(line.kind)
                        .font(.orbitLabel.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 76, alignment: .leading)
                    Text(line.detail)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            if let more = look.more { Text(more).font(.orbitLabel).foregroundStyle(.secondary).padding(.top, 2) }
            if let skipped = look.skipped { Text(skipped) }
            if let failed = chat.pressFailed(card: "group:\(group.id)") {
                Text(failed).font(.orbitLabel).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            }
        }, actions: {
            HStack(spacing: 8) {
                if let toggle = look.toggle { DriveCardButton(title: toggle) { all.toggle() } }
                if look.apply {
                    DriveCardButton(title: DriveChatCopy.apply, primary: true, disabled: look.busy) {
                        Task { await chat.press(group, apply: true) }
                    }
                }
                if look.undo {
                    DriveCardButton(title: DriveChatCopy.undo, disabled: look.busy) {
                        Task { await chat.press(group, apply: false) }
                    }
                }
            }
        }, hasActions: hasActions)
        .accessibilityIdentifier("drive-changes-card")
    }
}

/// An overwrite the chat would not make on its own (frames 3, 8): both files — path, size, who wrote it, when — and
/// Keep both above Replace; once answered, what it did.
struct DriveReplaceCard: View {
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var hSize
    #endif
    let chat: WikiChatModel
    let question: DriveChatQuestion

    private var stacked: Bool {
        #if os(iOS)
        return hSize == .compact
        #else
        return false
        #endif
    }

    var body: some View {
        let open = DriveChatLogic.needsYou(question)
        let busy = chat.pressing.contains("question:\(question.id)") || question.status == .answering
        DriveCardFrame(title: DriveChatCopy.replaceTitle, state: open ? DriveChatCopy.needsYou : nil,
                       tone: open ? .needsYou : .quiet, content: {
            file(DriveChatCopy.alreadyThere, question.existing)
            file(DriveChatCopy.incoming, question.moving)
            if let note = DriveChatLogic.questionNote(question) {
                Text(note).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if let failed = chat.pressFailed(card: "question:\(question.id)") {
                Text(failed).font(.orbitLabel).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            }
        }, actions: {
            let keep = DriveCardButton(title: DriveChatCopy.keepBoth, primary: true, disabled: busy) {
                Task { await chat.answer(question, .keepBoth) }
            }
            let replace = DriveCardButton(title: DriveChatCopy.replace, disabled: busy) {
                Task { await chat.answer(question, .replace) }
            }
            if stacked {
                VStack(spacing: 8) { keep; replace }
            } else {
                HStack(spacing: 8) { keep; replace }
            }
        }, hasActions: open)
        .accessibilityIdentifier("drive-replace-card")
    }

    private func file(_ label: String, _ file: DriveChatQuestionFile) -> some View {
        let facts = DriveChatLogic.facts(file)
        return VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.orbitLabel.weight(.semibold)).foregroundStyle(.secondary)
            Text(facts.path).fixedSize(horizontal: false, vertical: true)
            Text(facts.line).font(.orbitLabel).foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }
}

// MARK: - the marks (frames 2, 5)

/// `New`, `Moved` or `Renamed` after a row's name, until the row is opened.
struct DriveMarkPill: View {
    let mark: DriveChatLogic.Mark

    var body: some View {
        let tint: Color = mark == .new ? .green : .blue
        Text(mark.rawValue)
            .font(.orbitRowNote.weight(.semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 7)
            .padding(.vertical, 1)
            .background(tint.opacity(0.16), in: Capsule())
            .fixedSize()
            .accessibilityLabel(mark.rawValue)
    }
}

extension Color {
    /// A card's ground: white in light mode, the system's raised ground in dark.
    static var driveCardBackground: Color {
        #if os(iOS)
        Color(uiColor: .systemBackground)
        #else
        Color(nsColor: .textBackgroundColor)
        #endif
    }

    /// The light green a marked row's background takes (board ②: `#eefaf1`).
    static let driveMarkedRow = Color.green.opacity(0.09)
}
