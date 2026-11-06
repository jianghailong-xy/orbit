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
            .task(id: space.id) { await chat.load(spaceID: space.id) }
            // The panel's chat streams while it is open on the Wiki (`AppModel.syncConsoleFocus`).
            .onChange(of: chat.focusedSessionID) { _, _ in model.syncConsoleFocus() }
            .onAppear { model.syncConsoleFocus() }
            .onDisappear { model.syncConsoleFocus() }
            .onChange(of: compact, initial: true) { _, sheet in chat.asSheet = sheet }
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
            .alert(WikiCopy.decideFailed, isPresented: Binding(get: { chat.refusal != nil && !chat.presented },
                                                               set: { if !$0 { chat.refusal = nil } })) {
                Button("OK", role: .cancel) { chat.refusal = nil }
            } message: {
                Text(chat.refusal ?? "")
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
                .inspector(isPresented: Binding(get: { chat.presented }, set: { if !$0 { chat.close() } })) {
                    panel.inspectorColumnWidth(min: 320, ideal: 400, max: 560)
                }
        }
        #else
        content
            .inspector(isPresented: Binding(get: { chat.presented }, set: { if !$0 { chat.close() } })) {
                panel.inspectorColumnWidth(min: 320, ideal: 400, max: 560)
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
                if let section = rewrite.sections.first(where: { $0.result == .updated }), let doc = section.doc, let key = section.key {
                    Button(WikiChatCopy.actionSeeChanges) {
                        chat.seeChanges = WikiChatSeeChanges(spaceID: space.id, docSlug: doc, sectionKey: key, place: section.place,
                                                             versionID: section.versionId, draftID: card.id)
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
/// `✕` fold it away (and on a wide window `+` a new chat) — where it runs, the conversation or the Ask sheet over it,
/// and the short composer.
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
            if let asking = chat.asking {
                WikiChatAskSheet(request: asking, chat: chat)
            } else if chat.chat == WikiChatLogic.newChat {
                WikiChatNewBody(chat: chat, space: space, compact: compact)
            } else {
                WikiChatRunningBody(chat: chat, space: space, sessionID: chat.chat, compact: compact)
                    .id(chat.chat)
            }
        }
        .environment(\.inWikiChatPanel, true)
        .sheet(item: Binding(get: { chat.presented ? chat.seeChanges : nil }, set: { chat.seeChanges = $0 })) { target in
            WikiSeeChangesSheet(target: target, chat: chat)
        }
        .alert(WikiCopy.decideFailed, isPresented: Binding(get: { chat.refusal != nil && chat.presented },
                                                           set: { if !$0 { chat.refusal = nil } })) {
            Button("OK", role: .cancel) { chat.refusal = nil }
        } message: {
            Text(chat.refusal ?? "")
        }
    }

    private var title: String {
        guard chat.chat != WikiChatLogic.newChat else { return WikiChatCopy.newChat }
        let row = chat.openChatRow?.title
        let session = model.session(id: chat.chat)?.title
        return [session, row].compactMap { $0 }.first { !$0.isEmpty } ?? WikiChatCopy.newChat
    }

    private var head: some View {
        HStack(spacing: 10) {
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
            Spacer(minLength: 8)
            if !compact {
                headButton("plus", WikiChatCopy.newChat) { chat.newChat() }
            }
            headButton("arrow.right", WikiChatCopy.openSession, disabled: chat.chat == WikiChatLogic.newChat) {
                // The full session page, where #-references, model switching and slash commands are (design §4.1).
                let session = chat.chat
                let folded = chat.foldForSheet()
                if !folded { chat.close() }
                Task { @MainActor in
                    if folded { try? await Task.sleep(nanoseconds: 350_000_000) }
                    model.route(to: .session(session))
                }
            }
            headButton("xmark", WikiChatCopy.close) { chat.close() }
        }
        .padding(.horizontal, 16)
        .padding(.top, compact ? 18 : 12)
        .padding(.bottom, 10)
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

/// A chat not started yet: where it will run — chosen once per space, then remembered (design §5.1) — the empty
/// panel's two sentences, and the composer that makes the chat.
private struct WikiChatNewBody: View {
    let chat: WikiChatModel
    let space: WikiSpace
    let compact: Bool

    var body: some View {
        let runsIn = chat.runsIn(space.id)
        VStack(spacing: 0) {
            switch runsIn {
            case .chosen(let workspace, let remembered, let choices)?:
                if !remembered || !compact {
                    runsInLine(workspace, choices: choices)
                }
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
            if case .chosen? = runsIn {
                WikiChatComposer(chat: chat, space: space, console: nil)
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

/// A chat that runs: where (on a wide window), its conversation — the session page's transcript, the cards in it —
/// and the composer, which sends through the session's own console.
private struct WikiChatRunningBody: View {
    @Environment(AppModel.self) private var model
    let chat: WikiChatModel
    let space: WikiSpace
    let sessionID: String
    let compact: Bool

    var body: some View {
        let console = model.consoleRegistry?.peek(sessionID)
        VStack(spacing: 0) {
            if !compact, let line = runLine, !line.isEmpty {
                Text(line)
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 6)
            }
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
                WikiChatComposer(chat: chat, space: space, console: console)
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

    /// A runner's entry in one of the workspaces' runner maps, whichever spelling of its id the map keeps.
    private func runner<T>(_ map: [String: T]?, _ id: String?) -> T? {
        guard let id, let map else { return nil }
        return map[id] ?? map.first { PublicID.storageKey($0.key) == PublicID.storageKey(id) }?.value
    }

    /// `orbit-develop · HPC · Claude Opus 5.5 · Default` (design §4.1).
    private var runLine: String? {
        guard let session else { return nil }
        let mode = session.permissionMode.flatMap(PermissionMode.init(rawValue:)).map(AgentDefaults.label)
        return WikiChatLogic.runLine([session.agent?.name, runner(model.agents?.runnerNames, session.assignedRunnerId),
                                      session.model, mode])
    }

    /// The machine the chat runs on, when it is offline: said, and the chat waits for it (design §5.1).
    private var offlineMachine: String? {
        guard runner(model.agents?.runnerOnline, session?.assignedRunnerId) == false else { return nil }
        return runner(model.agents?.runnerNames, session?.assignedRunnerId)
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

// MARK: - the composer (design §4.1–§4.2)

/// The short composer: the page and the quote as chips, each with its cross — what they show is what the message
/// sends — the words, Send, and Stop while a turn runs. A running chat's words are its console's draft, sent through
/// its console (so a message waits behind a running turn, and revives an ended chat, as on the session page); a new
/// chat's are made into the chat itself.
struct WikiChatComposer: View {
    @Environment(AppModel.self) private var model
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var hSize
    #endif
    let chat: WikiChatModel
    let space: WikiSpace
    let console: ConsoleModel?

    /// A phone's chip says how many sentences alone (board 42 ⑤); a wider one adds the sources, as the web's does.
    private var narrow: Bool {
        #if os(iOS)
        return hSize == .compact
        #else
        return false
        #endif
    }

    @FocusState private var focused: Bool

    private var text: Binding<String> {
        if let console {
            return Binding(get: { console.composerText }, set: { console.composerText = $0 })
        }
        return Binding(get: { chat.draftText }, set: { chat.draftText = $0 })
    }

    private var busy: Bool {
        guard let console else { return false }
        return (model.session(id: console.sessionID)?.effectiveRunStatus ?? console.state.status) == .running
    }

    private var canSend: Bool {
        let words = text.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if let console { return !words.isEmpty && !console.sending }
        return !words.isEmpty && !chat.creating
    }

    var body: some View {
        let shown = WikiChatLogic.shown(chat.attachments)
        VStack(alignment: .leading, spacing: 6) {
            if shown.page != nil || shown.quote != nil {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        if let page = shown.page { pageChip(page) }
                        if let quote = shown.quote { quoteChip(quote) }
                    }
                }
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField(console == nil ? WikiChatCopy.placeholder : chat.placeholder, text: text, axis: .vertical)
                    .lineLimit(1...6)
                    .textFieldStyle(.plain)
                    .focused($focused)
                    .font(.orbitProse)
                    .padding(.vertical, 6)
                    .accessibilityIdentifier("wiki-chat-input")
                    .onSubmit { send() }
                if busy, let console {
                    Button {
                        Task { await console.interrupt() }
                    } label: {
                        Image(systemName: "stop.fill")
                            .font(.orbitBarGlyph)
                            .foregroundStyle(.white)
                            .frame(width: 30, height: 30)
                            .background(Color.primary.opacity(0.75), in: Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(WikiChatCopy.stop)
                }
                Button(action: send) {
                    Image(systemName: "arrow.up")
                        .font(.orbitBarGlyph)
                        .foregroundStyle(.white)
                        .frame(width: 30, height: 30)
                        .background(canSend ? Color.accentColor : Color.accentColor.opacity(0.35), in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
                .accessibilityLabel(WikiChatCopy.send)
                .accessibilityIdentifier("wiki-chat-send")
            }
        }
        .padding(.leading, 14)
        .padding(.trailing, 8)
        .padding(.vertical, 8)
        .background(Color.primary.opacity(0.001))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Color.secondary.opacity(0.35)))
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 10)
    }

    private func send() {
        let words = text.wrappedValue
        guard canSend else { return }
        if let console {
            let context = chat.context
            Task {
                await console.send(queueForNextTurn: true, wikiContext: context, accepted: { chat.sent() })
            }
        } else {
            Task {
                if await chat.create(spaceID: space.id, text: words) { focused = false }
            }
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
        .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
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
                                  focused: chat.focusCard == PublicID.storageKey(card.id)) { action in
                    act(action, card: card, chat: chat)
                }
                .onAppear { if inPanel && chat.presented { chat.markSeen(card) } }
                .onChange(of: card.rewrite?.result) { _, _ in if inPanel && chat.presented { chat.markSeen(card) } }
            } else {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(WikiChatCopy.cardDraft.replacingOccurrences(of: " · {label}", with: ""))
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                }
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
            guard let rewrite = card.rewrite,
                  let section = rewrite.sections.first(where: { $0.result == .updated }) ?? rewrite.sections.first,
                  let doc = section.doc, let key = section.key, let space = model.wiki?.currentSpace else { return }
            chat.seeChanges = WikiChatSeeChanges(spaceID: space.id, docSlug: doc, sectionKey: key, place: section.place,
                                                 versionID: section.versionId, draftID: card.id)
        case .openEntry:
            guard let entry = card.ops.compactMap({ $0.entryId ?? $0.entry?["id"]?.stringValue }).first else { return }
            leave { model.openWikiEntry(entry) }
        case .openInPlan:
            leave { model.selectedSection = .wiki; model.nav.path = [.wikiPlan(version: nil)] }
        case .settings:
            leave { model.selectedSection = .wiki; model.nav.path = [.wikiSettings] }
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

/// One card (board 42 ⑤, second phone): its state's line, what it is about, its fields, its sources and the sections it
/// rewrites — then its buttons, full width with the first on top — and, once applied, the line its rewrite reads.
struct WikiDraftCardView: View {
    let card: WikiChatDraftView
    var busy = false
    var focused = false
    let act: (WikiChatAction) -> Void

    private var actions: [WikiChatAction] { WikiChatLogic.cardActions(card.card) }
    private var quiet: Bool { card.state != .draft && card.state != .applied && card.state != .changed }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 8) {
                stateLine
                if card.tainted {
                    (Text(WikiChatCopy.cardWeb).bold() + Text(" · " + WikiChatCopy.cardWebNote))
                        .font(.orbitLabel)
                        .foregroundStyle(Color.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Text(WikiChatLogic.cardHeadline(card))
                    .font(.orbitProse.weight(.semibold))
                    .foregroundStyle(quiet ? Color.secondary : Color.primary)
                    .fixedSize(horizontal: false, vertical: true)
                if card.state == .replaced {
                    Text(WikiChatCopy.cardReplacedNote)
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                }
                if card.state == .draft || card.state == .changed {
                    fields
                }
                if !actions.isEmpty {
                    buttons
                }
            }
            .padding(12)
            .background(Color.primary.opacity(quiet ? 0.03 : 0.0), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(focused ? Color.accentColor : Color.secondary.opacity(0.28), lineWidth: focused ? 1.5 : 1)
            }
            if card.state == .applied, let rewrite = card.rewrite {
                resultLine(rewrite)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("wiki-chat-card")
    }

    private var stateLine: some View {
        let tone = WikiChatLogic.tone(card.state)
        let color: Color = tone == .accent ? .accentColor : tone == .amber ? .orange : tone == .green ? .green : .secondary
        return HStack(spacing: 4) {
            if card.state == .applied {
                Image(systemName: "checkmark")
                    .font(.orbitMeta.weight(.bold))
            }
            Text(WikiChatLogic.cardTitle(card.state, label: card.label).uppercased())
                .font(.orbitSectionLabel.weight(.semibold))
                .tracking(0.4)
        }
        .foregroundStyle(color)
    }

    /// Board 42 ②: the entry's fields as it would be written, then Sources and Rewrites.
    private var fields: some View {
        let op = card.ops.first
        let draft = op?.payload?["entry"] ?? op?.payload?["changes"]
        let kind = draft?["kind"]?.stringValue.flatMap(WikiEntryKind.init(rawValue:)) ?? op?.entry?["kind"]?.stringValue.flatMap(WikiEntryKind.init(rawValue:))
        let rows = WikiLogic.fieldRows(kind: kind, fields: draft?["fields"])
        let sources = WikiChatLogic.sourceLines(card)
        let rewrites = card.kind == .rewrite && !card.sections.isEmpty ? card.sections : card.rewrites
        return Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 12, verticalSpacing: 6) {
            if card.kind != .entry, let rationale = card.rationale, !rationale.isEmpty {
                GridRow {
                    Text(rationale)
                        .gridCellColumns(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                GridRow {
                    Text(row.label).foregroundStyle(.secondary)
                    Text(row.lines.joined(separator: "\n"))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if !sources.isEmpty {
                GridRow {
                    Text(WikiChatCopy.cardSources).foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(sources, id: \.self) { line in
                            HStack(alignment: .firstTextBaseline, spacing: 4) {
                                Image(systemName: "checkmark")
                                    .font(.orbitMeta.weight(.bold))
                                    .foregroundStyle(.green)
                                Text(line)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
            }
            if !rewrites.isEmpty {
                GridRow {
                    Text(WikiChatCopy.cardRewrites).foregroundStyle(.secondary)
                    Text(rewrites.map(\.place).joined(separator: " · "))
                        .foregroundStyle(Color.accentColor)
                }
            }
            if !card.similar.isEmpty {
                GridRow {
                    Text(WikiCopy.similarEntries).foregroundStyle(.secondary)
                    Text(card.similar.map { $0.title ?? $0.id }.joined(separator: " · "))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .font(.orbitLabel)
    }

    /// The first button is the card's own press — full width, on top; the rest share the row under it (board ⑤).
    @ViewBuilder
    private var buttons: some View {
        let presses: [WikiChatAction] = [.apply, .rewrite, .applyRebuild, .redo]
        let primary: WikiChatAction? = actions.first.flatMap { presses.contains($0) ? $0 : nil }
        let rest: [WikiChatAction] = primary == nil ? actions : Array(actions.dropFirst())
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

    private func resultLine(_ rewrite: WikiChatDraftRewrite) -> some View {
        let tone: Color = rewrite.result == .updated ? .green
            : rewrite.result == .rewriting ? .secondary
            : rewrite.result == .failed ? .red : .orange
        return HStack(alignment: .firstTextBaseline, spacing: 6) {
            if rewrite.result == .rewriting {
                ProgressView().controlSize(.mini)
            } else {
                Image(systemName: rewrite.result == .updated ? "checkmark.circle.fill" : "exclamationmark.circle")
                    .foregroundStyle(tone)
            }
            Text(WikiChatLogic.resultLine(rewrite.card))
                .foregroundStyle(rewrite.result == .rewriting ? Color.secondary : Color.primary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.orbitLabel)
        .padding(.horizontal, 4)
        .accessibilityIdentifier("wiki-chat-result")
    }
}

/// Edit (contract `chat.presses.edit`): the owner's title and one line for each op that writes an entry, applied as
/// Review's Edit — the revisions are the owner's.
struct WikiDraftEditForm: View {
    let card: WikiChatDraftView
    /// The answer: nil once it landed and the form can close, else the refusal, which stays here.
    let submit: ([WikiChatEditRequest.Op]) async -> String?

    @Environment(\.dismiss) private var dismiss
    @State private var titles: [Int: String] = [:]
    @State private var summaries: [Int: String] = [:]
    @State private var saving = false
    @State private var refusal: String?

    private var editable: [WikiChatDraftOpView] {
        card.ops.filter { [.add, .amend, .supersede].contains($0.op) }
    }

    var body: some View {
        NavigationStack {
            Form {
                ForEach(editable) { op in
                    Section {
                        TextField(WikiCopy.titlePlaceholder, text: Binding(get: { titles[op.seq] ?? "" }, set: { titles[op.seq] = $0 }))
                        TextField(WikiCopy.summaryPlaceholder, text: Binding(get: { summaries[op.seq] ?? "" }, set: { summaries[op.seq] = $0 }),
                                  axis: .vertical)
                            .lineLimit(2...5)
                    }
                }
                if let refusal {
                    Section { Text(refusal).foregroundStyle(.red) }
                }
            }
            .navigationTitle(WikiChatCopy.actionEdit)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(WikiChatCopy.actionApply) {
                        saving = true
                        let ops = editable.map { op in
                            WikiChatEditRequest.Op(seq: op.seq, changes: WikiEntryChanges(
                                title: (titles[op.seq] ?? "").trimmingCharacters(in: .whitespacesAndNewlines),
                                summary: (summaries[op.seq] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)))
                        }
                        Task {
                            refusal = await submit(ops)
                            saving = false
                            if refusal == nil { dismiss() }
                        }
                    }
                    .disabled(saving || editable.contains { (titles[$0.seq] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })
                }
            }
        }
        .onAppear {
            for op in editable {
                let draft = op.payload?["entry"] ?? op.payload?["changes"]
                titles[op.seq] = draft?["title"]?.stringValue ?? op.entry?["title"]?.stringValue ?? ""
                summaries[op.seq] = draft?["summary"]?.stringValue ?? op.entry?["summary"]?.stringValue ?? ""
            }
        }
    }
}

// MARK: - See changes (contract `docs.versions.compare`)

/// A section's sentences before and after the rewrite, sentence by sentence: what it said, struck through in red, and
/// what it says now, in green — headed by why it was written again. Opening it marks the card's rewrite seen.
struct WikiSeeChangesSheet: View {
    let target: WikiChatSeeChanges
    let chat: WikiChatModel

    @Environment(\.dismiss) private var dismiss

    private var version: WikiDocSectionVersion? {
        let read = chat.versions(spaceID: target.spaceID, slug: target.docSlug, key: target.sectionKey)
        return read?.versions.first { $0.id == target.versionID } ?? read?.versions.first
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if let version {
                        HStack(spacing: 6) {
                            Text(version.reason.map(WikiChatLogic.versionHeading) ?? target.place)
                                .font(.orbitSubtext.weight(.semibold))
                            Text("· " + WikiChatLogic.changed(version.changed))
                                .font(.orbitLabel)
                                .foregroundStyle(.secondary)
                        }
                        ForEach(Array(version.rows.enumerated()), id: \.offset) { _, row in
                            sentence(row)
                        }
                    } else {
                        ProgressView().frame(maxWidth: .infinity)
                    }
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle("\(WikiChatCopy.actionSeeChanges) · \(target.place)")
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
            await chat.loadVersions(spaceID: target.spaceID, slug: target.docSlug, key: target.sectionKey)
            if let id = target.draftID, let card = chat.card(id) { chat.markSeen(card) }
        }
    }

    @ViewBuilder
    private func sentence(_ row: WikiDocSentenceRow) -> some View {
        switch row.op {
        case .removed:
            Text(row.text)
                .strikethrough(true, color: .red)
                .foregroundStyle(Color.red.opacity(0.85))
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        case .added:
            Text(row.text)
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.green.opacity(0.12), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(alignment: .leading) { Rectangle().fill(Color.green).frame(width: 3) }
        default:
            Text(row.text)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 8)
        }
    }
}
