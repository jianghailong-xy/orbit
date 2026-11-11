import SwiftUI
import OrbitKit

// The wiki chat on iOS and macOS (docs/wiki-chat-design.md §3, §4 and §9; board 42 ⑤): the round button at the bottom
// right of every wiki page but Settings, with its four looks; the panel it opens — on a phone a sheet of two heights
// whose half height leaves the page behind it readable and scrollable, on an iPad or a Mac the third column beside the
// page (docs/wiki-design.md §12.3.5); the conversation, which is the session page's own transcript; the short composer
// with the page and the quote as chips; the Ask sheet over a paragraph's sentences; the cards an agent drafts, pressed
// only here; See changes; and the line that floats over the page once a rewrite came out.
//
// Every word is `WikiChatCopy`'s and every rule `WikiChatLogic`'s (OrbitKit), held there to the web and the contract.

// MARK: - the transcript, here

extension TranscriptView {
    /// The session page's transcript in a wiki chat's panel (design §9): the same rows, cards and approvals, with the
    /// sticky question kept out of a navigation bar the panel does not have.
    init(wikiChat console: ConsoleModel) {
        self.console = console
        self.hidesStickyQuestion = true
    }
}

private struct WikiChatPanelKey: EnvironmentKey {
    static let defaultValue = false
}

private struct WikiChatBannerKey: EnvironmentKey {
    static let defaultValue: String? = nil
}

extension EnvironmentValues {
    /// Whether the view is inside a wiki chat's panel: a card's way to another page folds a phone's sheet first.
    var inWikiChatPanel: Bool {
        get { self[WikiChatPanelKey.self] }
        set { self[WikiChatPanelKey.self] = newValue }
    }

    /// Activity's line for W's chat part (`WikiChatLogic.waitingBanner`), nil while no rewrite waits on the owner.
    var wikiChatBanner: String? {
        get { self[WikiChatBannerKey.self] }
        set { self[WikiChatBannerKey.self] = newValue }
    }
}

// MARK: - the round button (design §3)

/// The round button: an icon alone in the brand's blue — a ring going round while a turn runs or a section is being
/// rewritten, an amber number while something needs the owner, a green check once a rewrite came out. Its words are
/// the web's hover, as its accessibility label.
struct WikiChatFab: View {
    let look: WikiChatLogic.FabLook
    let diameter: CGFloat
    let action: () -> Void

    @State private var turning = false

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .fill(Color.accentColor)
                    .shadow(color: .black.opacity(0.22), radius: 9, x: 0, y: 4)
                Image(systemName: "ellipsis.bubble")
                    .font(.orbitFabGlyph(diameter))
                    .foregroundStyle(.white)
                if look.state == .working {
                    Circle()
                        .trim(from: 0, to: 0.3)
                        .stroke(Color.accentColor, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                        .padding(-5)
                        .rotationEffect(.degrees(turning ? 360 : 0))
                        .animation(.linear(duration: 1.2).repeatForever(autoreverses: false), value: turning)
                        .onAppear { turning = true }
                        .onDisappear { turning = false }
                }
            }
            .frame(width: diameter, height: diameter)
            .overlay(alignment: .topTrailing) { badge }
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(look.label)
        .accessibilityIdentifier("wiki-chat-fab")
        .help(look.label)
    }

    @ViewBuilder
    private var badge: some View {
        switch look.state {
        case .needsYou:
            Text("\(look.count)")
                .font(.orbitFabBadge.monospacedDigit())
                .foregroundStyle(.white)
                .padding(.horizontal, 5)
                .frame(minWidth: 20, minHeight: 20)
                .background(Color.orange, in: Capsule())
                .overlay(Capsule().strokeBorder(Color.white, lineWidth: 1.5))
                .offset(x: 4, y: -4)
        case .updated:
            Image(systemName: "checkmark")
                .font(.orbitFabBadge)
                .foregroundStyle(.white)
                .frame(width: 20, height: 20)
                .background(Color.green, in: Circle())
                .overlay(Circle().strokeBorder(Color.white, lineWidth: 1.5))
                .offset(x: 4, y: -4)
        case .idle, .working:
            EmptyView()
        }
    }
}

// MARK: - where the chat lives on a page

/// Puts the chat on a wiki page: the round button at the bottom right while the panel is folded away, the line a
/// settled rewrite floats at the bottom left, and the panel itself — a two-height sheet on a phone, the third column on
/// an iPad or a Mac. Hung on the iPhone's Wiki stack and on the wide shells' Wiki detail pane, so every page of the
/// Wiki section has it and Settings, which the rule leaves out, does not show it.
struct WikiChatHost: ViewModifier {
    @Environment(AppModel.self) private var model
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var hSize
    #endif
    @State private var detent: PresentationDetent = .medium
    /// The width the Wiki has, the column included: what the column's width is a share of (owner 11-11).
    @State private var available: CGFloat = 1440

    private var compact: Bool {
        #if os(iOS)
        return hSize == .compact
        #else
        return false
        #endif
    }

    func body(content: Content) -> some View {
        if let chat = model.wikiChat, let space = model.wiki?.currentSpace {
            hosted(content, chat: chat, space: space)
        } else {
            content
        }
    }

    private func hosted(_ content: Content, chat: WikiChatModel, space: WikiSpace) -> some View {
        let shown = WikiChatLogic.fabShown(settingsOnTop: model.nav.wikiSettingsOnTop, hasSpace: true)
        let inset = CGFloat(compact ? WikiChatLogic.Fab.phoneInset : WikiChatLogic.Fab.wideInset)
        // Every page's foot keeps 88 clear for the button (design §3, the web's `.wk-page` padding), so its last line
        // scrolls above it. A safe-area inset on the pages inside, not on the button's own overlay, which stays where it is.
        let clear = content.safeAreaInset(edge: .bottom, spacing: 0) {
            Color.clear.frame(height: shown ? CGFloat(WikiChatLogic.Fab.footClearance) : 0)
        }
        return presented(clear, chat: chat, space: space)
            .overlay(alignment: .bottomTrailing) {
                if shown && !chat.presented {
                    WikiChatFab(look: chat.fab(space.id),
                                diameter: CGFloat(compact ? WikiChatLogic.Fab.phoneDiameter : WikiChatLogic.Fab.wideDiameter)) {
                        detent = .medium
                        chat.openFromButton(spaceID: space.id)
                    }
                    .padding(.trailing, inset)
                    .padding(.bottom, inset)
                    .transition(.scale.combined(with: .opacity))
                }
            }
            .overlay(alignment: .bottomLeading) {
                if shown && !chat.presented, let card = chat.updatedCard {
                    WikiChatUpdatedPill(card: card, chat: chat, space: space)
                        .padding(.leading, inset)
                        .padding(.trailing, inset + CGFloat(compact ? WikiChatLogic.Fab.phoneDiameter : WikiChatLogic.Fab.wideDiameter) + 12)
                        .padding(.bottom, inset + 2)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .animation(.snappy(duration: 0.25), value: chat.presented)
            .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { width in available = width }
            .task(id: space.id) {
                await chat.load(spaceID: space.id)
                // Board 45: where the panel is the third column, a Wiki page opens with it shown.
                chat.openByDefault(spaceID: space.id, settingsOnTop: model.nav.wikiSettingsOnTop)
            }
            .onChange(of: model.nav.wikiSettingsOnTop) { _, onTop in chat.openByDefault(spaceID: space.id, settingsOnTop: onTop) }
            // The panel's chat streams while it is open on the Wiki (`AppModel.syncConsoleFocus`).
            .onChange(of: chat.focusedSessionID) { _, _ in model.syncConsoleFocus() }
            .onAppear { model.syncConsoleFocus() }
            .onDisappear { model.syncConsoleFocus() }
            .onChange(of: compact, initial: true) { _, sheet in
                chat.asSheet = sheet
                // A panel the page opened folds away at a phone's width and comes back at a wide one.
                chat.openByDefault(spaceID: space.id, settingsOnTop: model.nav.wikiSettingsOnTop)
            }
            // The page chip follows the reader (design §4.2): an entry, a plan's document — a document's page
            // follows its own sections — and nothing on the Wiki's other pages.
            .onChange(of: model.nav.path.last, initial: true) { _, node in follow(node, chat: chat, space: space) }
            .onChange(of: chat.asking) { _, asking in
                // The paragraph's sentences want the room; once picked, the page comes back up beside the chat.
                detent = asking != nil ? .large : .medium
            }
            .sheet(item: Binding(get: { chat.presented ? nil : chat.seeChanges }, set: { chat.seeChanges = $0 })) { target in
                WikiSeeChangesSheet(target: target, chat: chat)
            }
            .alert(chat.refusal ?? "", isPresented: Binding(get: { chat.refusal != nil && !chat.presented },
                                                            set: { if !$0 { chat.refusal = nil } })) {
                Button("OK", role: .cancel) { chat.refusal = nil }
            }
    }

    private func follow(_ node: NavNode?, chat: WikiChatModel, space: WikiSpace) {
        switch node {
        case .wikiDoc?:
            return
        case .wikiEntry(let id)?:
            let title = model.wiki?.detail(id)?.entry.title
            chat.follow(spaceID: space.id, page: .entry(entryId: id, label: title ?? WikiCopy.entryWord))
        case .wikiPlanDoc(let slug, _)?:
            let number = model.wiki?.docsDirectory?.categories.flatMap { $0.docs ?? [] }.first { $0.slug == slug }?.number
            chat.follow(spaceID: space.id, page: .plan(docSlug: slug, label: number ?? slug))
        case .wikiPlanSection(let slug, let index, _)?:
            // At one of the document's sections the page attaches that section too (C12).
            let number = model.wiki?.docsDirectory?.categories.flatMap { $0.docs ?? [] }.first { $0.slug == slug }?.number
            chat.follow(spaceID: space.id, page: WikiChatLogic.planPage(slug: slug, index: index, number: number, plan: model.wiki?.plan))
        default:
            chat.follow(spaceID: space.id, page: nil)
        }
    }

    /// The panel: a sheet whose half height leaves the page behind it scrollable on a phone (`presentationDetents`,
    /// `presentationBackgroundInteraction`, design §9), the trailing column beside the page elsewhere.
    @ViewBuilder
    private func presented<Page: View>(_ content: Page, chat: WikiChatModel, space: WikiSpace) -> some View {
        let panel = WikiChatPanel(chat: chat, space: space, compact: compact)
        #if os(iOS)
        if compact {
            content
                .sheet(isPresented: Binding(get: { chat.presented }, set: { if !$0 { chat.close() } })) {
                    panel
                        .presentationDetents([.medium, .large], selection: $detent)
                        .presentationBackgroundInteraction(.enabled(upThrough: .medium))
                        .presentationContentInteraction(.scrolls)
                        .presentationDragIndicator(.visible)
                }
        } else {
            content
                .inspector(isPresented: Binding(get: { chat.presented }, set: { if !$0 { chat.closeByOwner() } })) {
                    panel.inspectorColumnWidth(min: CGFloat(WikiChatLogic.Column.min), ideal: CGFloat(WikiChatLogic.Column.ideal(Double(available))),
                                           max: CGFloat(WikiChatLogic.Column.max(Double(available))))
                }
        }
        #else
        content
            .inspector(isPresented: Binding(get: { chat.presented }, set: { if !$0 { chat.closeByOwner() } })) {
                panel.inspectorColumnWidth(min: CGFloat(WikiChatLogic.Column.min), ideal: CGFloat(WikiChatLogic.Column.ideal(Double(available))),
                                           max: CGFloat(WikiChatLogic.Column.max(Double(available))))
            }
        #endif
    }
}

extension View {
    /// The wiki chat on this page: its button, its panel, and the line a rewrite floats (`WikiChatHost`).
    func wikiChatHost() -> some View { modifier(WikiChatHost()) }
}

// MARK: - the line a rewrite floats (board 42 ⑤, third phone)

/// `✓ Wiki updated · 3.1 §3  See changes`: once the chat is folded away and a rewrite came out updated. The line opens
/// the chat at its card; See changes opens the comparison, which marks the card seen.
struct WikiChatUpdatedPill: View {
    let card: WikiChatDraftView
    let chat: WikiChatModel
    let space: WikiSpace

    var body: some View {
        if let rewrite = card.rewrite, let line = WikiChatLogic.updatedPill(rewrite.card) {
            HStack(spacing: 10) {
                Button {
                    chat.open(chat: card.sessionId, spaceID: space.id, card: card.id)
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                        Text(line)
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .foregroundStyle(Color.primary)
                    }
                }
                .buttonStyle(.plain)
                if let target = WikiChatSeeChanges.of(card, spaceID: space.id) {
                    Button(WikiChatCopy.actionSeeChanges) {
                        chat.seeChanges = target
                    }
                    .buttonStyle(.plain)
                    .font(.orbitSubtext.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
                    .fixedSize()
                }
            }
            .font(.orbitSubtext)
            .padding(.horizontal, 14)
            .frame(minHeight: 48)
            .background(.regularMaterial, in: Capsule())
            .shadow(color: .black.opacity(0.16), radius: 10, x: 0, y: 4)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("wiki-chat-updated")
        }
    }
}

// MARK: - the panel (design §4.1, board 42 ⑤)

/// The panel the button opens: its head — the chat's title, which opens the space's chats, `↗` the full session page,
/// `✕` fold it away (and on a wide window `+` a new chat) — a new chat's Runs in, the conversation or the Ask sheet
/// over it, and the session page's composer (board 43).
struct WikiChatPanel: View {
    @Environment(AppModel.self) private var model
    let chat: WikiChatModel
    let space: WikiSpace
    /// A phone's sheet: the board's head and no line under it.
    let compact: Bool

    var body: some View {
        VStack(spacing: 0) {
            head
            Divider()
            if chat.history != nil {
                WikiChatHistoryList(chat: chat, space: space)
            } else if let asking = chat.asking {
                WikiChatAskSheet(request: asking, chat: chat)
            } else if chat.chat == WikiChatLogic.newChat {
                WikiChatNewBody(chat: chat, space: space)
            } else {
                WikiChatRunningBody(chat: chat, space: space, sessionID: chat.chat)
                    .id(chat.chat)
            }
        }
        .environment(\.inWikiChatPanel, true)
        .sheet(item: Binding(get: { chat.presented ? chat.seeChanges : nil }, set: { chat.seeChanges = $0 })) { target in
            WikiSeeChangesSheet(target: target, chat: chat)
        }
        .alert(chat.refusal ?? "", isPresented: Binding(get: { chat.refusal != nil && chat.presented },
                                                        set: { if !$0 { chat.refusal = nil } })) {
            Button("OK", role: .cancel) { chat.refusal = nil }
        }
    }

    private var title: String {
        if chat.history != nil { return WikiChatCopy.historyTitle }
        guard chat.chat != WikiChatLogic.newChat else { return WikiChatCopy.newChat }
        let row = chat.openChatRow?.title
        let session = model.session(id: chat.chat)?.title
        return [session, row].compactMap { $0 }.first { !$0.isEmpty } ?? WikiChatCopy.newChat
    }

    private var head: some View {
        HStack(spacing: 10) {
            if compact { historyMenu } else { historyTitle }
            Spacer(minLength: 8)
            if !compact {
                headButton("plus", WikiChatCopy.newChat) { chat.newChat() }
            }
            headButton("arrow.right", WikiChatCopy.openSession,
                       disabled: chat.chat == WikiChatLogic.newChat || chat.history != nil) {
                // The full session page, where #-references, model switching and slash commands are (design §4.1).
                let session = chat.chat
                let folded = chat.foldForSheet()
                if !folded { chat.close() }
                Task { @MainActor in
                    if folded { try? await Task.sleep(nanoseconds: 350_000_000) }
                    model.route(to: .session(session))
                }
            }
            // ✕ is the owner saying no: the page no longer opens with the panel until the button opens it (board 45).
            headButton("xmark", WikiChatCopy.close) { chat.closeByOwner() }
        }
        .padding(.horizontal, 16)
        .padding(.top, compact ? 18 : 12)
        .padding(.bottom, 10)
    }

    /// The third column's title (board 45 ④, Q3 A): pressed, the space's chats over the whole panel, and back.
    private var historyTitle: some View {
        Button {
            chat.toggleHistory()
        } label: {
            HStack(spacing: 4) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)
                Image(systemName: chat.history != nil ? "chevron.up" : "chevron.down")
                    .font(.orbitMeta.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .keyboardShortcut(chat.history != nil ? .cancelAction : nil)
        .accessibilityLabel(title)
        .accessibilityHint(WikiChatCopy.history)
    }

    /// A phone's sheet keeps the title's menu of chats.
    private var historyMenu: some View {
            Menu {
                Button {
                    chat.newChat()
                } label: {
                    Label(WikiChatCopy.newChat, systemImage: "plus")
                }
                let rows = chat.list(space.id)?.chats ?? []
                Section(WikiChatCopy.history) {
                    if rows.isEmpty {
                        Text(WikiChatCopy.noHistory)
                    }
                    ForEach(rows) { row in
                        Button {
                            chat.pick(chat: row.sessionId)
                        } label: {
                            Text(row.needsYou > 0 ? "\(row.title.isEmpty ? WikiChatCopy.newChat : row.title)  ·  \(row.needsYou)"
                                                  : (row.title.isEmpty ? WikiChatCopy.newChat : row.title))
                        }
                    }
                }
            } label: {
                HStack(spacing: 4) {
                    Text(title)
                        .font(.headline)
                        .foregroundStyle(Color.primary)
                        .lineLimit(1)
                    if !compact {
                        Image(systemName: "chevron.down")
                            .font(.orbitMeta.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .accessibilityLabel(title)
            .accessibilityHint(WikiChatCopy.history)
    }

    private func headButton(_ symbol: String, _ label: String, disabled: Bool = false,
                            action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.orbitBarGlyph)
                .foregroundStyle(disabled ? Color.secondary.opacity(0.5) : Color.secondary)
                .frame(width: 30, height: 30)
                .background(Color.secondary.opacity(0.12), in: Circle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .accessibilityLabel(label)
        .help(label)
    }
}

/// The space's chats over the whole third column (board 45 ④, owner 11-11: Q3 A, Q4 A; the web's `WikiChatHistory`):
/// a search over titles, Open — what needs the owner, then the working, then the one last spoken in first — and
/// Completed, folded; each row's second line its needs-you, Working… or how long ago. A row's ⋯ (and its context menu)
/// holds the session list's Rename…, Open as a full session, Complete and Move to Trash, through the same doors, with
/// Undo; Trash itself stays the session list's.
struct WikiChatHistoryList: View {
    @Environment(AppModel.self) private var model
    let chat: WikiChatModel
    let space: WikiSpace

    @State private var words = ""
    @State private var completedOpen = false
    @State private var renaming: WikiChatRow?
    @State private var newTitle = ""

    var body: some View {
        let read = chat.history ?? WikiChatHistory()
        let groups = WikiChatLogic.historyGroups(read.rows)
        let searching = !words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField(WikiChatCopy.search, text: $words)
                    .textFieldStyle(.plain)
                    .accessibilityLabel(WikiChatCopy.search)
                    .onChange(of: words) { _, value in chat.searchHistory(value) }
            }
            .padding(.horizontal, 10)
            .frame(height: 32)
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.secondary.opacity(0.3)))
            .padding(.horizontal, 12)
            .padding(.top, 10)
            .padding(.bottom, 4)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if read.loaded && read.rows.isEmpty {
                        Text(searching ? WikiChatCopy.noMatch : WikiChatCopy.noHistory)
                            .font(.orbitListSubtitle)
                            .foregroundStyle(.secondary)
                            .padding(8)
                    }
                    if !groups.open.isEmpty {
                        groupHeader(WikiChatCopy.groupOpen, count: groups.open.count)
                        ForEach(groups.open) { row in rowView(row) }
                    }
                    if !groups.completed.isEmpty {
                        let shown = completedOpen || searching
                        Button {
                            completedOpen.toggle()
                        } label: {
                            HStack {
                                groupHeader(WikiChatCopy.groupCompleted, count: groups.completed.count)
                                Spacer()
                                Image(systemName: shown ? "chevron.down" : "chevron.right")
                                    .font(.orbitMeta.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                    .padding(.trailing, 8)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(.isHeader)
                        .accessibilityValue(shown ? "expanded" : "collapsed")
                        if shown {
                            ForEach(groups.completed) { row in rowView(row) }
                        }
                    }
                    if read.more {
                        Button(WikiChatCopy.showMore) { chat.moreHistory() }
                            .buttonStyle(.plain)
                            .font(.orbitListSubtitle)
                            .foregroundStyle(Color.accentColor)
                            .disabled(read.loading)
                            .padding(.horizontal, 8)
                            .padding(.top, 8)
                    }
                    Text(WikiChatCopy.trashNote)
                        .font(.orbitMeta)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 8)
                        .padding(.top, 14)
                        .padding(.bottom, 12)
                }
                .padding(.horizontal, 8)
            }
        }
        .alert(WikiChatCopy.rename, isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField(WikiChatCopy.renameField, text: $newTitle)
            Button(WikiChatCopy.cancel, role: .cancel) { renaming = nil }
            Button("Save") {
                if let row = renaming { rename(row, to: newTitle) }
                renaming = nil
            }
        }
    }

    private func groupHeader(_ name: String, count: Int) -> some View {
        HStack(spacing: 6) {
            Text(name).fontWeight(.semibold)
            Text("\(count)")
        }
        .font(.orbitMeta)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 8)
        .padding(.top, 10)
        .padding(.bottom, 4)
        .accessibilityElement(children: .combine)
    }

    private func rowView(_ row: WikiChatRow) -> some View {
        let current = PublicID.storageKey(row.sessionId) == PublicID.storageKey(chat.chat)
        let line = WikiChatLogic.historyLine(row, now: Date())
        let name = row.title.isEmpty ? WikiChatCopy.newChat : row.title
        return HStack(spacing: 6) {
            Button {
                chat.pick(chat: row.sessionId)
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(name)
                        .font(.body.weight(current ? .semibold : .regular))
                        .foregroundStyle(current ? Color.accentColor : Color.primary)
                        .lineLimit(1)
                    HStack(spacing: 5) {
                        if line.tone == .working {
                            ProgressView().controlSize(.small).scaleEffect(0.6).frame(width: 12, height: 12)
                        }
                        Text(line.text)
                    }
                    .font(.orbitListSubtitle.weight(line.tone == .needsYou ? .semibold : .regular))
                    .foregroundStyle(line.tone == .needsYou ? Color.orange : line.tone == .working ? Color.accentColor : Color.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(current ? .isSelected : [])
            Menu {
                actions(row)
            } label: {
                Image(systemName: "ellipsis")
                    .font(.orbitBarGlyph)
                    .foregroundStyle(.secondary)
                    .frame(width: 26, height: 26)
                    .contentShape(Rectangle())
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .accessibilityLabel("\(WikiChatCopy.rowActions): \(name)")
        }
        .padding(.leading, 8)
        .padding(.trailing, 4)
        .padding(.vertical, 6)
        .background(current ? Color.accentColor.opacity(0.12) : Color.clear, in: RoundedRectangle(cornerRadius: 8))
        .contextMenu { actions(row) }
    }

    @ViewBuilder
    private func actions(_ row: WikiChatRow) -> some View {
        Button(WikiChatCopy.rename) {
            newTitle = row.title
            renaming = row
        }
        Button(WikiChatCopy.openSession) {
            chat.close()
            model.route(to: .session(row.sessionId))
        }
        if !row.completed {
            Button(WikiChatCopy.complete) { complete(row) }
        }
        Divider()
        Button(WikiChatCopy.moveToTrash, role: .destructive) { trash(row) }
    }

    private func rename(_ row: WikiChatRow, to title: String) {
        let words = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty, words != row.title else { return }
        Task { @MainActor in
            if let error = await chat.renameChat(row.sessionId, title: words) { failed(error) }
        }
    }

    private func complete(_ row: WikiChatRow) {
        Task { @MainActor in
            if let error = await chat.completeChat(row.sessionId) { failed(error); return }
            model.showToast("Session completed", sessionID: row.sessionId, sessionTitle: row.title,
                            undo: { restore(row) })
        }
    }

    private func trash(_ row: WikiChatRow) {
        Task { @MainActor in
            if let error = await chat.trashChat(row.sessionId) { failed(error); return }
            model.showToast("Moved to Trash", sessionID: row.sessionId, sessionTitle: row.title,
                            tone: .neutral, icon: "trash", undo: { restore(row) })
        }
    }

    private func restore(_ row: WikiChatRow) {
        Task { @MainActor in
            if let error = await chat.restoreChat(row.sessionId) { failed(error) }
        }
    }

    private func failed(_ error: Error) {
        model.showToast(WikiChatCopy.actionFailed, detail: error.localizedDescription, tone: .error)
    }
}

/// A chat not started yet: Runs in, the workspace alone — chosen once per space, then remembered (design §5.1), and
/// gone once the first message makes the chat (board 43 ②) — the empty panel's two sentences, and the composer whose
/// first message makes the chat.
private struct WikiChatNewBody: View {
    let chat: WikiChatModel
    let space: WikiSpace

    var body: some View {
        let runsIn = chat.runsIn(space.id)
        VStack(spacing: 0) {
            switch runsIn {
            case .chosen(let workspace, _, let choices)?:
                runsInLine(workspace, choices: choices)
                if !workspace.online, let machine = workspace.runner {
                    note(WikiChatCopy.offline(machine))
                }
            default:
                EmptyView()
            }
            ScrollView {
                VStack(spacing: 16) {
                    switch runsIn {
                    case .noWorktree?:
                        Text(WikiChatCopy.noWorktree)
                            .multilineTextAlignment(.center)
                            .foregroundStyle(.secondary)
                    case .choose(let choices, _)?:
                        choose(choices)
                    case .chosen?, nil:
                        (Text(WikiChatCopy.emptyHint) + Text("\n") + Text(WikiChatCopy.emptyNote))
                            .multilineTextAlignment(.center)
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("wiki-chat-empty")
                    }
                }
                .font(.orbitSubtext)
                .lineSpacing(3)
                .padding(.horizontal, 24)
                .padding(.vertical, 22)
                .frame(maxWidth: .infinity)
            }
            if case .chosen(let workspace, _, _)? = runsIn {
                WikiChatNewComposer(chat: chat, spaceID: space.id, workspaceID: workspace.id)
                    .id(workspace.id)
            }
        }
    }

    /// `Runs in  orbit-develop · HPC ▾`: the remembered workspace, or the one picked here.
    private func runsInLine(_ workspace: WikiChatWorkspace, choices: [WikiChatWorkspace]) -> some View {
        HStack(spacing: 8) {
            Text(WikiChatCopy.runsIn)
                .foregroundStyle(.secondary)
            Menu {
                ForEach(choices) { choice in
                    Button(WikiChatLogic.workspaceName(choice)) { chat.pickedWorkspace = choice.id }
                }
            } label: {
                HStack(spacing: 4) {
                    Text(WikiChatLogic.workspaceName(workspace))
                        .foregroundStyle(Color.primary)
                        .lineLimit(1)
                    Image(systemName: "chevron.down")
                        .font(.orbitMeta.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .accessibilityLabel(WikiChatCopy.workspace)
            Spacer(minLength: 0)
        }
        .font(.orbitLabel)
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    private func choose(_ choices: [WikiChatWorkspace]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(WikiChatCopy.chooseWorkspace)
                .font(.orbitSubtext.weight(.semibold))
            ForEach(choices) { choice in
                Button {
                    chat.pickedWorkspace = choice.id
                } label: {
                    HStack {
                        Text(choice.name).foregroundStyle(Color.primary)
                        Spacer(minLength: 8)
                        if let runner = choice.runner {
                            Text(runner).foregroundStyle(.secondary)
                        }
                    }
                    .padding(12)
                    .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .buttonStyle(.plain)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .font(.orbitLabel)
            .foregroundStyle(.orange)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.bottom, 6)
    }
}

/// A chat that runs: its conversation — the session page's transcript, the cards in it — and the session page's
/// composer over the session's own console. No workspace is shown, as on the session page (board 43 ④ ⑤).
private struct WikiChatRunningBody: View {
    @Environment(AppModel.self) private var model
    let chat: WikiChatModel
    let space: WikiSpace
    let sessionID: String

    var body: some View {
        let console = model.consoleRegistry?.peek(sessionID)
        VStack(spacing: 0) {
            if let machine = offlineMachine {
                Text(WikiChatCopy.offline(machine))
                    .font(.orbitLabel)
                    .foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 6)
            }
            if let console {
                WikiChatConversation(console: console, registry: model.consoleRegistry)
                if let ended = endedLine(console) {
                    WikiChatEndedLine(text: ended) { chat.newChat() }
                } else {
                    WikiChatComposer(chat: chat, console: console)
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        // The console the registry streams while this chat is focused (`AppModel.focusedConsoleSessionID`).
        .task(id: sessionID) {
            _ = model.consoleRegistry?.model(for: sessionID, agentID: model.agentID(for: sessionID))
            await chat.loadCards(chat: sessionID)
        }
    }

    private var session: Session? { model.session(id: sessionID) }

    /// Why the chat takes no more messages, once it does not (C8 review): in Trash, or ended and not about to be
    /// retried. Nil until its record is read.
    private func endedLine(_ console: ConsoleModel) -> String? {
        let trashed = session?.deletedAt != nil || console.worktree.detail?.lifecycleState == .trash
        guard let session else { return trashed ? WikiChatCopy.trashed : nil }
        return WikiChatLogic.endedLine(trashed: trashed, status: session.effectiveRunStatus, retryPending: session.retryPending())
    }

    /// A runner's entry in one of the workspaces' runner maps, whichever spelling of its id the map keeps.
    private func runner<T>(_ map: [String: T]?, _ id: String?) -> T? {
        guard let id, let map else { return nil }
        return map[id] ?? map.first { PublicID.storageKey($0.key) == PublicID.storageKey(id) }?.value
    }

    /// The machine the chat runs on, when it is offline: said, and the chat waits for it (design §5.1).
    private var offlineMachine: String? {
        guard runner(model.agents?.runnerOnline, session?.assignedRunnerId) == false else { return nil }
        return runner(model.agents?.runnerNames, session?.assignedRunnerId)
    }
}

/// The composer's place once its chat takes no more messages: why, and a new chat.
private struct WikiChatEndedLine: View {
    let text: String
    let newChat: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(text)
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Button(action: newChat) {
                Label(WikiChatCopy.newChat, systemImage: "plus")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .fixedSize()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("wiki-chat-ended")
    }
}

/// The chat's conversation: the session page's own transcript, with what its rows ask the page around them for — the
/// attachment images, the tasks the session made, and the approval sheet its cards open.
private struct WikiChatConversation: View {
    let console: ConsoleModel
    let registry: ConsoleRegistry?
    @State private var approvalReview: ApprovalReviewTarget?
    @State private var approvalReviewDrafts = ApprovalReviewDrafts()

    var body: some View {
        if let registry {
            TranscriptView(wikiChat: console)
                .environment(registry.attachments)
                .environment(console.createdTasks)
                .environment(approvalReviewDrafts)
                .environment(\.openApprovalReview, { target in approvalReview = target })
                .sheet(item: $approvalReview) { target in
                    ApprovalReviewSheet(console: console, target: target)
                        .environment(approvalReviewDrafts)
                }
        }
    }
}

// MARK: - the composer (board 43: the session page's, in the panel)

/// The panel's composer is the session page's own (`ComposerView`, board 43 ② ④ ⑤), over the chat's console — a new
/// chat's draft, or its session's — so pictures and files, the slash menu, the mode, the model with its effort and
/// speed, the gauges, Send, Stop and a message sent into a running turn or queued for the next all behave as there.
/// The page and the selection lead its attachment row, each with its cross: what they show is what the message sends,
/// beside the words (`ConsoleModel.wikiChat`), and they go once the server took it.
struct WikiChatComposer: View {
    let chat: WikiChatModel
    let console: ConsoleModel
    /// A new chat's: the space and the workspace its first message makes the chat in (contract `chat.create`).
    var creates: (spaceID: String, workspaceID: String)? = nil

    var body: some View {
        let shown = WikiChatLogic.shown(chat.attachments)
        ComposerBand {
            if let message = console.statusMessage {
                HStack {
                    Text(message).font(.orbitLabel).foregroundStyle(.secondary).lineLimit(2)
                    Spacer()
                    Button { console.statusMessage = nil } label: { Image(systemName: "xmark") }
                        .buttonStyle(.plain).foregroundStyle(.secondary)
                }
                .padding(.bottom, .composerBandGap)
            }
            ComposerView(console: console,
                         emptyPlaceholder: creates == nil ? chat.placeholder : WikiChatCopy.placeholder,
                         leadingAttachments: shown.page == nil && shown.quote == nil
                             ? nil : AnyView(WikiChatChips(chat: chat)))
        }
        .onAppear { console.wikiChat = composing }
        .onDisappear { console.wikiChat = nil }
    }

    private var composing: WikiChatComposing {
        let chat = chat
        var composing = WikiChatComposing(context: { chat.context }, accepted: { chat.sent() })
        if let creates {
            composing.create = { first in
                await chat.create(spaceID: creates.spaceID, workspaceID: creates.workspaceID, first)
            }
        }
        return composing
    }
}

/// A new chat's composer: a draft console for the workspace Runs in names, made once it is known, holding the words
/// typed so far (`WikiChatModel.draftText`) across the panel folding away.
private struct WikiChatNewComposer: View {
    @Environment(AppModel.self) private var model
    let chat: WikiChatModel
    let spaceID: String
    let workspaceID: String
    @State private var draft: ConsoleModel?

    private var agent: Agent? {
        model.agents?.items.first { PublicID.storageKey($0.id) == PublicID.storageKey(workspaceID) }
    }

    var body: some View {
        // A view that is there before the draft is: a task on an empty group never runs.
        ZStack {
            if let draft {
                WikiChatComposer(chat: chat, console: draft, creates: (spaceID, workspaceID))
            } else {
                Color.clear.frame(height: 1)
            }
        }
        .task(id: agent?.id) {
            guard draft == nil, let agent, let registry = model.consoleRegistry, let agents = model.agents else { return }
            let made = registry.draftModel(
                for: agent, defaultModel: agents.effectiveDefaultModel(for: agent),
                configuredProviders: agents.configuredProviders,
                configuredProvidersLoaded: agents.configuredProvidersLoaded,
                providerPools: agents.providerPools, sharedPools: agents.sharedPools,
                modelCatalog: agents.modelCatalog(for: agent.runnerId),
                accountDefaultEffort: model.user?.preferences?.defaultEffort) { _ in }
            made.composerText = chat.draftText
            draft = made
            await made.prepareDraft()
        }
        .onChange(of: draft?.composerText) { _, text in
            if let text { chat.draftText = text }
        }
    }
}

/// The page and the selection, the first chips of the composer's attachment row (board 43 ②: drawn as its file chips
/// are), each with its cross.
private struct WikiChatChips: View {
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var hSize
    #endif
    let chat: WikiChatModel

    /// A compact column's chip — a phone's sheet, an iPad's third column, each about 380 points wide — says how many
    /// sentences alone (board 42 ⑤); a Mac's adds the sources, as the web's docked panel does.
    private var narrow: Bool {
        #if os(iOS)
        return hSize == .compact
        #else
        return false
        #endif
    }

    var body: some View {
        let shown = WikiChatLogic.shown(chat.attachments)
        HStack(spacing: 8) {
            if let page = shown.page { pageChip(page) }
            if let quote = shown.quote { quoteChip(quote) }
        }
    }

    private func pageChip(_ page: WikiChatLogic.Page) -> some View {
        chip(remove: WikiChatCopy.remove(page.label), cross: { chat.crossPage() }) {
            HStack(spacing: 4) {
                Image(systemName: "book")
                    .font(.orbitMeta)
                Text(page.label)
                    .lineLimit(1)
            }
        }
        .accessibilityIdentifier("wiki-chat-page-chip")
    }

    private func quoteChip(_ quote: WikiChatLogic.Quote) -> some View {
        chip(remove: WikiChatCopy.remove(quote.first), cross: { chat.crossQuote() }) {
            HStack(spacing: 5) {
                Rectangle()
                    .fill(Color.orange)
                    .frame(width: 2, height: 14)
                Text(quote.first)
                    .lineLimit(1)
                    .frame(maxWidth: 120, alignment: .leading)
                Text(WikiChatLogic.quoteCounts(sentences: quote.sentenceIds.count, sources: narrow ? 0 : quote.sources))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .fixedSize()
            }
        }
        .help(quote.selected > quote.sentenceIds.count ? WikiChatCopy.capped(quote.selected) : "")
        .accessibilityIdentifier("wiki-chat-quote-chip")
    }

    private func chip<Label: View>(remove: String, cross: @escaping () -> Void, @ViewBuilder label: () -> Label) -> some View {
        HStack(spacing: 4) {
            label()
            Button(action: cross) {
                Image(systemName: "xmark")
                    .font(.orbitMeta.weight(.bold))
                    .foregroundStyle(.secondary)
                    .frame(width: 16, height: 16)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(remove)
        }
        .font(.orbitLabel)
        .padding(.leading, 8)
        .padding(.trailing, 4)
        .padding(.vertical, 4)
        .background(.gray.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
    }
}

// MARK: - Ask (docs/wiki-comment-to-session-design.md §5)

/// Ask on a paragraph: its sentences, one row each, a tap picking or unpicking it — at least one — and Ask, which puts
/// them into the composer as the quote. Drawn in the panel, over its chat, so the phone's one sheet stays the chat's.
struct WikiChatAskSheet: View {
    let request: WikiChatAskRequest
    let chat: WikiChatModel

    @State private var picked: Set<String> = []

    private var quote: WikiChatLogic.Quote? {
        WikiChatLogic.quote(docSlug: request.docSlug, order: request.sentences, picked: picked)
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button("Cancel") { chat.asking = nil }
                Spacer()
                Text(WikiChatCopy.ask)
                    .font(.headline)
                Spacer()
                Button(WikiChatCopy.ask) {
                    if let quote { chat.quote(quote) }
                }
                .fontWeight(.semibold)
                .disabled(quote == nil)
                .accessibilityIdentifier("wiki-chat-ask-done")
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            List {
                Section {
                    ForEach(request.sentences) { sentence in
                        row(sentence)
                    }
                } header: {
                    Text("\(request.place) · \(WikiChatCopy.pickSentences)")
                } footer: {
                    if let quote {
                        Text(WikiChatLogic.quoteCounts(sentences: quote.sentenceIds.count, sources: quote.sources))
                    }
                }
            }
            #if os(iOS)
            .listStyle(.insetGrouped)
            #endif
        }
        .onAppear { picked = [] }
    }

    private func row(_ sentence: WikiChatLogic.AskSentence) -> some View {
        let on = picked.contains(sentence.id)
        return Button {
            if on { picked.remove(sentence.id) } else { picked.insert(sentence.id) }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Image(systemName: on ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(on ? Color.accentColor : Color.secondary)
                    .font(.orbitDiscGlyph)
                (Text(sentence.text)
                    + Text(sentence.notes.map(WikiDocCopy.noteLabel).joined())
                        .font(.orbitMeta)
                        .foregroundColor(.accentColor))
                    .foregroundStyle(on ? Color.primary : Color.secondary)
                    .font(.orbitProse)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

// MARK: - the cards (design §7, board 42 ② ③ ⑤)

/// Where a card's presses go, decided by the page around it: the panel folds a phone's sheet before another page.
struct WikiDraftCardSlot: View {
    @Environment(AppModel.self) private var model
    @Environment(\.inWikiChatPanel) private var inPanel
    let draftID: String

    @State private var editing: WikiChatDraftView?

    /// Drawn by any transcript that shows the drafting call (`ToolCardView`): the panel's and the session page's.
    init(draftID: String) {
        self.draftID = draftID
    }

    var body: some View {
        Group {
            if let chat = model.wikiChat, let card = chat.card(draftID) {
                WikiDraftCardView(card: card, busy: chat.pressing.contains(PublicID.storageKey(card.id)),
                                  focused: chat.focusCard == PublicID.storageKey(card.id), failed: chat.pressFailed(card),
                                  act: { action in act(action, card: card, chat: chat) },
                                  open: { target in open(target) })
                .onAppear { if inPanel && chat.presented { chat.markSeen(card) } }
                .onChange(of: card.rewrite?.result) { _, _ in if inPanel && chat.presented { chat.markSeen(card) } }
            } else if model.wikiChat?.isUnread(draftID) == true {
                // The call stands; its card cannot be read now.
                Text(WikiChatCopy.cardUnread)
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.primary.opacity(0.03), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .accessibilityIdentifier("wiki-chat-card-unread")
            } else {
                ProgressView()
                    .controlSize(.small)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .task(id: draftID) {
            if model.wikiChat?.card(draftID) == nil { await model.wikiChat?.loadCard(draftID) }
        }
        .onAppear { model.wikiChat?.cardAppeared(draftID) }
        .onDisappear { model.wikiChat?.cardDisappeared(draftID) }
        .sheet(item: $editing) { card in
            WikiDraftEditForm(card: card) { ops in
                await model.wikiChat?.edit(card, ops: ops)
            }
        }
    }

    private func act(_ action: WikiChatAction, card: WikiChatDraftView, chat: WikiChatModel) {
        switch action {
        case .apply, .rewrite, .applyRebuild:
            Task { await chat.press(card, .apply) }
        case .discard:
            Task { await chat.press(card, .discard) }
        case .undo:
            Task { await chat.press(card, .undo) }
        case .tryAgain:
            Task { await chat.press(card, .retry) }
        case .edit:
            editing = card
        case .redo:
            // The owner's next message, as the design writes it: the agent drafts again (design §7.3).
            if let console = model.consoleRegistry?.peek(card.sessionId) {
                Task { await console.send(overrideText: WikiChatCopy.cardRedoMessage, queueForNextTurn: true) }
            }
        case .seeChanges:
            // Each section the rewrite wrote or read the same; opening it marks the rewrite seen.
            guard let space = chat.spaceID ?? model.wiki?.currentSpace?.id,
                  let target = WikiChatSeeChanges.of(card, spaceID: space) else { return }
            chat.seeChanges = target
            chat.markSeen(card)
        case .openEntry:
            guard let entry = card.ops.compactMap({ $0.entryId ?? $0.entry?["id"]?.stringValue }).first else { return }
            leave { go(.wikiEntry(entryID: entry)) }
        case .openInPlan:
            // A plan card opens its first document on the plan page (C12, C17); a card that names none, the plan.
            let node: NavNode = card.change?.docs.first.map { .wikiPlanDoc(slug: $0.slug, version: nil) } ?? .wikiPlan(version: nil)
            leave { go(node) }
        case .settings:
            leave { go(.wikiSettings) }
        }
    }

    /// A section the press rewrites, an entry it may duplicate, or Review for an In Review card.
    private func open(_ target: WikiDraftCardTarget) {
        switch target {
        case .section(let doc, let key): leave { go(.wikiDoc(slug: doc, section: key)) }
        case .entry(let id):             leave { go(.wikiEntry(entryID: id)) }
        case .review:                    leave { go(.wikiReview) }
        }
    }

    /// Beside the chat in the panel — the page under it moves on; from a session page, the Wiki at that page.
    private func go(_ node: NavNode) {
        if inPanel {
            model.push(node)
        } else {
            model.selectedSection = .wiki
            model.nav.path = [node]
        }
    }

    /// Another page: a phone's sheet folds first, so the page is not opened under it.
    private func leave(_ go: @escaping () -> Void) {
        if inPanel, let chat = model.wikiChat, chat.foldForSheet() {
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 350_000_000)
                go()
            }
            return
        }
        go()
    }
}

/// Where a card's links go: a section its press rewrites, an entry it may duplicate, or Review for an In Review card.
enum WikiDraftCardTarget: Equatable {
    case section(doc: String, key: String)
    case entry(String)
    case review
}

/// One card (board 42 ⑤, second phone; the web's `WikiDraftCard`): its state's line and note, what it is about, and —
/// while it is open — an amend's red and green lines, the entry's first field and the why, its sources, the sections
/// it rewrites and the entries it may duplicate; then its buttons, a draft's own press full width on top; what a press
/// that did not go said; and, once applied, the line its rewrite reads with Settings, Try again or See changes.
struct WikiDraftCardView: View {
    let card: WikiChatDraftView
    var busy = false
    var focused = false
    /// What its last press that did not go said (`wikiChatPressError`).
    var failed: String?
    let act: (WikiChatAction) -> Void
    var open: (WikiDraftCardTarget) -> Void = { _ in }

    private var isOpen: Bool { card.state == .draft || card.state == .changed }

    var body: some View {
        let look = WikiChatLogic.cardLook(card)
        let face = WikiChatLogic.cardFace(card)
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 8) {
                stateLine(look)
                if let note = look.note {
                    if look.inReview {
                        // Its press raised a flag the owner answers in Review: the note opens it there.
                        Button(note) { open(.review) }
                            .buttonStyle(.plain)
                            .font(.orbitLabel)
                            .foregroundStyle(Color.accentColor)
                            .accessibilityIdentifier("wiki-chat-card-in-review")
                    } else {
                        Text(note)
                            .font(.orbitLabel)
                            .foregroundStyle(.secondary)
                    }
                }
                if card.tainted {
                    (Text(WikiChatCopy.cardWeb).bold() + Text(" · " + WikiChatCopy.cardWebNote))
                        .font(.orbitLabel)
                        .foregroundStyle(Color.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let heading = face.heading {
                    Text(heading)
                        .font(.orbitProse.weight(.semibold))
                        .foregroundStyle(isOpen ? Color.primary : Color.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if isOpen {
                    fields(face)
                }
                if !look.actions.isEmpty {
                    buttons(look)
                }
                if let failed {
                    Text(failed)
                        .font(.orbitLabel)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("wiki-chat-card-failed")
                }
            }
            .padding(12)
            .background(Color.primary.opacity(look.quiet ? 0.03 : 0.0), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(focused ? Color.accentColor : Color.secondary.opacity(0.28), lineWidth: focused ? 1.5 : 1)
            }
            if let result = WikiChatLogic.resultLook(card) {
                resultLine(result, actions: look.rewriteActions)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("wiki-chat-card")
    }

    private func stateLine(_ look: WikiChatLogic.CardLook) -> some View {
        let color: Color = look.tone == .accent ? .accentColor : look.tone == .amber ? .orange : look.tone == .green ? .green : .secondary
        return HStack(spacing: 4) {
            if card.state == .applied && !look.inReview {
                Image(systemName: "checkmark")
                    .font(.orbitMeta.weight(.bold))
            }
            Text(look.title.uppercased())
                .font(.orbitSectionLabel.weight(.semibold))
                .tracking(0.4)
        }
        .foregroundStyle(color)
    }

    /// Board 42 ②: an amend's lines, then the face's rows, Sources, Rewrites and — while a draft — Similar.
    @ViewBuilder
    private func fields(_ face: WikiChatLogic.CardFace) -> some View {
        if !face.diff.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(face.diff.enumerated()), id: \.offset) { _, line in
                    Text(line.text)
                        .strikethrough(!line.added, color: .red)
                        .foregroundStyle(line.added ? Color.primary : Color.red.opacity(0.85))
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(line.added ? Color.green.opacity(0.12) : Color.red.opacity(0.08),
                                    in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                }
            }
            .font(.orbitLabel)
        }
        let similar = card.state == .draft ? Array(card.similar.prefix(3)) : []
        if !face.rows.isEmpty || !face.sources.isEmpty || !card.rewrites.isEmpty || !similar.isEmpty {
            Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 12, verticalSpacing: 6) {
                ForEach(Array(face.rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        label(row.label)
                        Text(row.value)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                if !face.sources.isEmpty {
                    GridRow {
                        label(WikiChatCopy.cardSources)
                        VStack(alignment: .leading, spacing: 2) {
                            ForEach(face.sources, id: \.self) { line in
                                HStack(alignment: .firstTextBaseline, spacing: 4) {
                                    Image(systemName: "checkmark")
                                        .font(.orbitMeta.weight(.bold))
                                        .foregroundStyle(.green)
                                    Text(line)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                if !card.rewrites.isEmpty {
                    GridRow {
                        label(WikiChatCopy.cardRewrites)
                        // A link each section; a plan card's rebuild over several documents, a link each document (C17).
                        links(WikiChatLogic.rewriteLinks(kind: card.kind, rewrites: card.rewrites)
                            .map { ($0.label, WikiDraftCardTarget.section(doc: $0.doc, key: $0.key)) })
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                if !similar.isEmpty {
                    GridRow {
                        label(WikiChatCopy.similar)
                        links(similar.map { ($0.title ?? $0.id, WikiDraftCardTarget.entry($0.id)) })
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .font(.orbitLabel)
        }
    }

    /// A row's label at its own width: the value beside it takes the rest of the row (board 42's `64px 1fr` grid), so
    /// it does not wrap at half the card.
    private func label(_ text: String) -> some View {
        Text(text)
            .foregroundStyle(.secondary)
            .fixedSize()
    }

    /// Sections or entries, each opening where it is: on one line when they fit, else one under another.
    private func links(_ items: [(String, WikiDraftCardTarget)]) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 0) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    if index > 0 { Text(" · ").foregroundStyle(.secondary) }
                    link(item.0, item.1).lineLimit(1)
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    link(item.0, item.1).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func link(_ title: String, _ target: WikiDraftCardTarget) -> some View {
        Button(title) { open(target) }
            .buttonStyle(.plain)
            .foregroundStyle(Color.accentColor)
    }

    /// A draft's own press is full width, on top; the rest share the row under it (board ⑤).
    @ViewBuilder
    private func buttons(_ look: WikiChatLogic.CardLook) -> some View {
        let primary: WikiChatAction? = card.state == .draft ? look.actions.first : nil
        let rest: [WikiChatAction] = primary == nil ? look.actions : Array(look.actions.dropFirst())
        VStack(spacing: 8) {
            if let primary {
                Button { act(primary) } label: {
                    Text(WikiChatCopy.action(primary))
                        .frame(maxWidth: .infinity, minHeight: 30)
                }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("wiki-chat-card-\(primary.rawValue)")
            }
            if !rest.isEmpty {
                HStack(spacing: 8) {
                    ForEach(rest, id: \.self) { action in
                        Button { act(action) } label: {
                            Text(WikiChatCopy.action(action))
                                .lineLimit(1)
                                .frame(maxWidth: .infinity, minHeight: 30)
                        }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("wiki-chat-card-\(action.rawValue)")
                    }
                }
            }
        }
        .padding(.top, 4)
        .disabled(busy)
    }

    /// The line an applied card's rewrite reads (design §8.3), with its own buttons: See changes as a link.
    private func resultLine(_ result: WikiChatLogic.ResultLook, actions: [WikiChatAction]) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            resultMark(result.tone)
            Text(result.line)
                .foregroundStyle(result.tone == .run ? Color.secondary : Color.primary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            ForEach(actions, id: \.self) { action in
                if action == .seeChanges {
                    Button(WikiChatCopy.action(action)) { act(action) }
                        .buttonStyle(.plain)
                        .font(.orbitLabel.weight(.semibold))
                        .foregroundStyle(Color.accentColor)
                        .fixedSize()
                        .accessibilityIdentifier("wiki-chat-card-\(action.rawValue)")
                } else {
                    Button(WikiChatCopy.action(action)) { act(action) }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .fixedSize()
                        .accessibilityIdentifier("wiki-chat-card-\(action.rawValue)")
                }
            }
        }
        .font(.orbitLabel)
        .padding(.horizontal, 4)
        .disabled(busy)
        .accessibilityIdentifier("wiki-chat-result")
    }

    @ViewBuilder
    private func resultMark(_ tone: WikiChatLogic.ResultTone) -> some View {
        switch tone {
        case .run:   ProgressView().controlSize(.mini)
        case .ok:    Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case .amber: Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.orange)
        case .error: Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
        case .grey:  Image(systemName: "clock").foregroundStyle(.secondary)
        }
    }
}

/// Edit (contract `chat.presses.edit`, the web's `WikiDraftEditor`): the owner's title and one line for each add,
/// supersede and amend the card holds, applied as Review's Edit in one press. Only what changed is sent; with nothing
/// changed Apply waits, since that would be Apply. A refusal stays here, with the text it is about.
struct WikiDraftEditForm: View {
    let card: WikiChatDraftView
    /// The answer: nil once it landed and the form can close, else the refusal, which stays here.
    let submit: ([WikiChatEditRequest.Op]) async -> String?

    @Environment(\.dismiss) private var dismiss
    @State private var words: [Int: WikiChatLogic.EditWords] = [:]
    @State private var saving = false
    @State private var refusal: String?

    private var editable: [WikiChatDraftOpView] { WikiChatLogic.editable(card) }
    private var edits: [WikiChatEditRequest.Op] { WikiChatLogic.editOps(card, words: words) }
    private var blank: Bool { words.values.contains { $0.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(WikiChatCopy.editNote)
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                }
                ForEach(editable) { op in
                    Section {
                        TextField(WikiChatCopy.editTitleField, text: binding(op.seq, \.title))
                        TextField(WikiChatCopy.editLine, text: binding(op.seq, \.summary), axis: .vertical)
                            .lineLimit(2...5)
                    }
                }
                if let refusal {
                    Section { Text(refusal).foregroundStyle(.red) }
                }
            }
            .navigationTitle(WikiChatCopy.editTitle)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(WikiChatCopy.cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(WikiChatCopy.actionApply) {
                        saving = true
                        let ops = edits
                        Task {
                            refusal = await submit(ops)
                            saving = false
                            if refusal == nil { dismiss() }
                        }
                    }
                    .disabled(saving || edits.isEmpty || blank)
                }
            }
        }
        .onAppear {
            guard words.isEmpty else { return }
            for op in editable { words[op.seq] = WikiChatLogic.editWords(op) }
        }
    }

    private func binding(_ seq: Int, _ field: WritableKeyPath<WikiChatLogic.EditWords, String>) -> Binding<String> {
        Binding(get: { words[seq]?[keyPath: field] ?? "" }, set: { words[seq]?[keyPath: field] = $0 })
    }
}

// MARK: - See changes (contract `docs.versions.compare`, the web's `WikiSeeChanges`)

/// Each section's write, sentence by sentence: a sentence it removed struck through, one it added shaded, the ones it
/// kept left out — under the line that says why the section was written, how many sentences that changed and when —
/// with up to four versions before it folded under Earlier changes. The comparison is the server's. Opening it marks
/// the card's rewrite seen.
struct WikiSeeChangesSheet: View {
    let target: WikiChatSeeChanges
    let chat: WikiChatModel

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    ForEach(Array(target.sections.enumerated()), id: \.offset) { _, section in
                        WikiSeeChangesSection(spaceID: target.spaceID, section: section, chat: chat,
                                              titled: target.sections.count > 1)
                    }
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle(target.sections.count == 1
                             ? WikiChatCopy.seeChangesTitle(target.sections[0].place) : WikiChatCopy.actionSeeChanges)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .task(id: target.id) {
            if let id = target.draftID, let card = chat.card(id) { chat.markSeen(card) }
        }
    }
}

/// One section of See changes: the write it opens on, or why there is nothing to read.
private struct WikiSeeChangesSection: View {
    let spaceID: String
    let section: WikiChatSeeChanges.Section
    let chat: WikiChatModel
    /// `See changes · 3.1 §3` over it, when the sheet shows more than one section.
    let titled: Bool

    @State private var older = false

    private var read: WikiChatLogic.SeeChangesRead {
        WikiChatLogic.seeChanges(
            versions: chat.versions(spaceID: spaceID, slug: section.docSlug, key: section.sectionKey)?.versions,
            failed: chat.versionsFailed(spaceID: spaceID, slug: section.docSlug, key: section.sectionKey),
            versionID: section.versionID, unchanged: section.unchanged)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if titled {
                Text(WikiChatCopy.seeChangesTitle(section.place))
                    .font(.orbitSubtext.weight(.semibold))
            }
            switch read {
            case .same:
                nothing(WikiChatCopy.seeChangesSame)
            case .failed:
                nothing(WikiChatCopy.seeChangesFailed)
            case .loading:
                ProgressView().frame(maxWidth: .infinity)
            case .none:
                nothing(WikiChatCopy.seeChangesNone)
            case .shown(let current, let earlier):
                WikiSeeChangesVersion(version: current)
                if !earlier.isEmpty {
                    Button { older.toggle() } label: {
                        Label(WikiChatCopy.earlierChanges(earlier.count), systemImage: older ? "chevron.down" : "chevron.right")
                    }
                    .buttonStyle(.plain)
                    .font(.orbitLabel)
                    .foregroundStyle(Color.accentColor)
                    if older {
                        ForEach(earlier) { version in WikiSeeChangesVersion(version: version, earlier: true) }
                    }
                }
            }
        }
        .task(id: "\(section.docSlug)#\(section.sectionKey)") {
            guard !(section.unchanged && section.versionID == nil) else { return }
            await chat.loadVersions(spaceID: spaceID, slug: section.docSlug, key: section.sectionKey)
        }
    }

    private func nothing(_ text: String) -> some View {
        Text(text)
            .font(.orbitLabel)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// One kept write: why, how many sentences and when, then the rows it changed.
private struct WikiSeeChangesVersion: View {
    let version: WikiDocSectionVersion
    var earlier = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(WikiChatLogic.seeChangesCause(version))
                .font(.orbitLabel.weight(.semibold))
                .foregroundStyle(earlier ? Color.secondary : Color.primary)
                .fixedSize(horizontal: false, vertical: true)
            let rows = WikiChatLogic.changedRows(version.rows)
            if rows.isEmpty {
                Text(WikiChatCopy.seeChangesSame)
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    sentence(row)
                }
            }
        }
    }

    @ViewBuilder
    private func sentence(_ row: WikiDocSentenceRow) -> some View {
        if row.op == .removed {
            Text(row.text)
                .strikethrough(true, color: .red)
                .foregroundStyle(Color.red.opacity(0.85))
                .fixedSize(horizontal: false, vertical: true)
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        } else {
            Text(row.text)
                .fixedSize(horizontal: false, vertical: true)
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.green.opacity(0.12), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(alignment: .leading) { Rectangle().fill(Color.green).frame(width: 3) }
        }
    }
}
