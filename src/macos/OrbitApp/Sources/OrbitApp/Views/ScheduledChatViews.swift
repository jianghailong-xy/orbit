import SwiftUI
import OrbitKit

// The Scheduled page's chat on iOS and macOS (docs/scheduled-chat-design.md §3, §4.6, §6; board
// docs/mocks/scheduled-chat/01-board-4.png): the Wiki chat's model, panel, composer and history (`WikiChatModel` with
// `ChatOrigin.scheduled`, `WikiChatPanel`) opened by the page's toolbar Chat button. On a Mac and an iPad at a regular
// width it is a third column beside the inspector, left open or closed on this device and never opened by itself; on an
// iPhone (and a compact iPad) it is a sheet with medium and large detents. Its change lines carry Undo and name the
// schedule they changed: in a column the name opens the schedule beside it, in a sheet it folds the chat and opens the
// schedule's own sheet with ‹ Chat. An answer's Run now link is drawn as a button the person presses.
//
// Every word is `ScheduledChatCopy`'s and every rule `ScheduledChatLogic`'s (OrbitKit), held there to the web.

// MARK: - what the conversation draws

private struct ScheduledChatOpenScheduleKey: EnvironmentKey {
    static let defaultValue: ((String) -> Void)? = nil
}

private struct AssistantTextFilterKey: EnvironmentKey {
    static let defaultValue: ((AssistantBubble) -> AssistantBubble)? = nil
}

extension EnvironmentValues {
    /// Set inside a Scheduled chat: a change line's schedule name opens the schedule as the page does (board 4 ③).
    var scheduledChatOpenSchedule: ((String) -> Void)? {
        get { self[ScheduledChatOpenScheduleKey.self] }
        set { self[ScheduledChatOpenScheduleKey.self] = newValue }
    }

    /// Set inside a Scheduled chat: an answer as the transcript draws it, its Run now links taken out where their
    /// cards stand (`ScheduledChatLogic.withoutDrawnOffers`).
    var assistantTextFilter: ((AssistantBubble) -> AssistantBubble)? {
        get { self[AssistantTextFilterKey.self] }
        set { self[AssistantTextFilterKey.self] = newValue }
    }
}

/// A Scheduled chat's transcript (`runNow` set): each Run now card after its answer, in the place of the link it stands
/// for — the answer's words drop that link, so the offer reads once; a change line's name opens its schedule on the
/// page; and a Run now link no card stands for does nothing of its own. Any other chat's transcript is left as it is.
private struct ScheduledChatTranscript: ViewModifier {
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL
    let runNow: [ScheduledChatLogic.RunNowCard]?

    func body(content: Content) -> some View {
        if let runNow {
            let app = app
            let openURL = openURL
            let byID = Dictionary(runNow.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            let drawn = Self.drawn(runNow)
            content
                .environment(\.transcriptChatCards, TranscriptChatCards(
                    cards: runNow.map { TranscriptChatCard(id: $0.id, turnId: $0.turnID) },
                    render: { id in byID[id].map { AnyView(ScheduledRunNowOffer(card: $0)) } ?? AnyView(EmptyView()) }))
                .environment(\.assistantTextFilter, { bubble in
                    guard let ids = drawn[bubble.id] else { return bubble }
                    var shown = bubble
                    shown.text = ScheduledChatLogic.withoutDrawnOffers(bubble.text, drawn: ids)
                    shown.streamingText = ScheduledChatLogic.withoutDrawnOffers(bubble.streamingText, drawn: ids)
                    return shown
                })
                .environment(\.scheduledChatOpenSchedule, { id in app.openScheduleFromChat(id) })
                .environment(\.openURL, OpenURLAction { url in
                    if url.scheme != ScheduledChatLogic.runNowScheme { openURL(url) }
                    return .handled
                })
        } else {
            content
        }
    }
}

extension ScheduledChatTranscript {
    /// Each answer's schedules whose cards are drawn, by the answer's id.
    static func drawn(_ cards: [ScheduledChatLogic.RunNowCard]) -> [String: Set<String>] {
        var drawn: [String: Set<String>] = [:]
        for card in cards { drawn[card.messageID, default: []].insert(card.scheduleID) }
        return drawn
    }
}

extension View {
    func scheduledChatTranscript(_ runNow: [ScheduledChatLogic.RunNowCard]?) -> some View {
        modifier(ScheduledChatTranscript(runNow: runNow))
    }
}

/// The Run now button an answer offered (design §4.6, board 3 ③): the schedule's title from the page's list and ▶ Run
/// now, pressed through the owner's door (`POST /schedules/:id/run`), so it counts toward no budget; then Started ·
/// open run. Nothing is drawn for a schedule the list does not hold or one that has ended.
struct ScheduledRunNowOffer: View {
    @Environment(AppModel.self) private var app
    let card: ScheduledChatLogic.RunNowCard
    private var scheduleID: String { card.scheduleID }
    @State private var busy = false
    @State private var done = false
    @State private var run: String?
    @State private var said: String?

    var body: some View {
        // Read again on every draw: a schedule that ended since the answer draws nothing.
        let schedule = app.scheduled?.schedule(scheduleID)
        if ScheduledChatLogic.runNowShown(schedule), let schedule {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 10) {
                    Text(schedule.title)
                        .font(.orbitSubtext.weight(.semibold))
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    Button(action: press) {
                        Label(ScheduledChatCopy.runNow, systemImage: "play.fill")
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(busy || done)
                    .accessibilityIdentifier("scheduled-run-now-button")
                }
                if done {
                    HStack(spacing: 4) {
                        Image(systemName: "checkmark").foregroundStyle(.green)
                        Text("\(ScheduledChatCopy.started) · ")
                        Button(ScheduledChatCopy.openRun, action: openRun)
                            .buttonStyle(.plain)
                            .foregroundStyle(Color.accentColor)
                    }
                    .font(.orbitLabel)
                }
                if let said {
                    Text(said).font(.orbitLabel).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(Color.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("scheduled-run-now")
        }
    }

    private func press() {
        guard let scheduled = app.scheduled else { return }
        busy = true
        Task { @MainActor in
            let started = await scheduled.runNowSession(scheduleID)
            said = started.said
            done = started.said == nil
            run = started.sessionID
            busy = false
        }
    }

    /// The run's session, else the schedule; a phone's chat sheet folds first.
    private func openRun() {
        let folded = app.scheduledChat?.foldForSheet() ?? false
        let session = run
        let id = scheduleID
        Task { @MainActor in
            if folded { try? await Task.sleep(nanoseconds: 350_000_000) }
            if let session { app.openScheduleRun(sessionID: session) } else { app.openScheduleFromChat(id) }
        }
    }
}

// MARK: - the toolbar button (board 1 ①, 4 ①)

/// The page's Chat button: pressed while the chat is open, a spinner while a turn runs, an amber count while a card
/// waits — read from the chats, never stored. A phone's toolbar shows the glyph alone.
struct ScheduledChatButton: View {
    @Environment(AppModel.self) private var app
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var hSize
    #endif

    private var glyphOnly: Bool {
        #if os(iOS)
        return hSize == .compact
        #else
        return false
        #endif
    }

    var body: some View {
        if let chat = app.scheduledChat {
            let look = chat.fab(ScheduledChatLogic.scope)
            Button {
                chat.toggleScheduled()
            } label: {
                HStack(spacing: 5) {
                    if look.state == .working {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "bubble.left.and.bubble.right")
                    }
                    if !glyphOnly { Text(ScheduledChatCopy.button) }
                    if look.count > 0 {
                        Text(look.count > 99 ? "99+" : "\(look.count)")
                            .font(.orbitMeta.weight(.bold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Color.orange, in: Capsule())
                            .accessibilityLabel(ScheduledChatCopy.waiting(look.count))
                    }
                }
                .padding(.horizontal, glyphOnly ? 0 : 4)
                .foregroundStyle(chat.presented && !chat.asSheet ? Color.accentColor : Color.primary)
            }
            .help(ScheduledChatCopy.button)
            .accessibilityLabel(ScheduledChatCopy.button)
            .accessibilityAddTraits(chat.presented ? .isSelected : [])
            .accessibilityIdentifier("scheduled-chat-button")
        }
    }
}

// MARK: - what every host does

/// Reads the page chats and keeps them fresh, hands the page's Open list and workspace filter to the chat, offers the
/// owner's workspaces with a machine to Runs in, follows the selected schedule into the composer's chip, and shows a
/// column again where it was left open. Hung on whichever view hosts the panel.
private struct ScheduledChatLive: ViewModifier {
    @Environment(AppModel.self) private var app
    let chat: WikiChatModel
    /// The panel is a sheet here (a compact width): it never opens on its own.
    let sheet: Bool

    func body(content: Content) -> some View {
        let scope = ScheduledChatLogic.scope
        content
            .task(id: app.user?.id) {
                chat.asSheet = sheet
                chat.signedIn(app.user?.id)
                chat.setWorkspaceChoices(choices)
                chat.setScheduledPage(sessions: app.sessions, filter: app.scheduled?.workspaceFilter)
                await chat.load(spaceID: scope)
                // Shown again only where it is a column and was left open (D3 A); never the first time.
                chat.openByDefault(spaceID: scope, settingsOnTop: false)
            }
            // Read again while a turn runs or the chat is open, and now and then at rest (the web's 15 s).
            .task(id: chat.presented) {
                while !Task.isCancelled {
                    let working = chat.list(scope)?.fab.working ?? false
                    try? await Task.sleep(nanoseconds: (working || chat.presented ? 5 : 20) * 1_000_000_000)
                    guard !Task.isCancelled else { return }
                    await chat.load(spaceID: scope)
                }
            }
            .onChange(of: choices) { _, choices in chat.setWorkspaceChoices(choices) }
            .onChange(of: app.sessions) { _, sessions in
                chat.setScheduledPage(sessions: sessions, filter: app.scheduled?.workspaceFilter)
            }
            .onChange(of: app.scheduled?.workspaceFilter) { _, filter in
                chat.setScheduledPage(sessions: app.sessions, filter: filter)
            }
            .onChange(of: sheet) { _, sheet in chat.asSheet = sheet }
            .onChange(of: selectedKey, initial: true) { _, _ in chat.followSchedule(selected) }
            // The panel's chat streams while it is open on Scheduled (`AppModel.syncConsoleFocus`).
            .onChange(of: chat.focusedSessionID) { _, _ in app.syncConsoleFocus() }
            .onAppear { app.syncConsoleFocus() }
            .onDisappear { app.syncConsoleFocus() }
    }

    /// The owner's workspaces with a machine, in their own order, as Runs in lists them.
    private var choices: [WikiChatWorkspace] {
        guard let agents = app.agents else { return [] }
        return app.orderedAgents.compactMap { agent in
            guard let runner = agent.runnerId else { return nil }
            return WikiChatWorkspace(id: agent.id, name: agent.name, runner: agents.runnerNames[runner],
                                     online: agents.runnerOnline[runner] ?? false)
        }
    }

    /// The schedule selected on the page: the Mac's inspected row, an iPad's open schedule.
    private var selected: (id: String, title: String)? {
        guard let scheduled = app.scheduled, let id = scheduled.inspectedID, let s = scheduled.schedule(id) else { return nil }
        return (s.id, s.title)
    }

    private var selectedKey: String { selected.map { "\($0.id)|\($0.title)" } ?? "" }
}

extension View {
    fileprivate func scheduledChatLive(_ chat: WikiChatModel, sheet: Bool) -> some View {
        modifier(ScheduledChatLive(chat: chat, sheet: sheet))
    }
}

// MARK: - the third column (Mac, iPad at a regular width)

#if os(macOS)
/// The Mac's detail column wears the chat (design §6): from 1200 points a third column beside the inspector (400,
/// dragged to 480), the source list folding for it; narrower, the chat slides over the inspector from the right, so
/// the inspector keeps its own width (at least 320) instead of being squeezed between list and chat. Which one is the
/// window's width, read off the detail column's right edge (`ScheduledChatLogic.macLayout`).
private struct ScheduledChatColumn: ViewModifier {
    @Environment(AppModel.self) private var app

    func body(content: Content) -> some View {
        if let chat = app.scheduledChat {
            let overlay = ScheduledChatLogic.macLayout(windowWidth: Double(chat.windowWidth)) == .overlay
            content
                .frame(minWidth: CGFloat(ScheduledChatLogic.inspectorMin))
                .inspector(isPresented: Binding(get: { chat.presented && !overlay },
                                                set: { if !$0 && !chat.scheduledOverlay { chat.closeByOwner() } })) {
                    WikiChatPanel(chat: chat, scope: ScheduledChatLogic.scope, compact: false)
                        .inspectorColumnWidth(min: 400, ideal: 400, max: 480)
                        .accessibilityIdentifier("scheduled-chat-panel")
                }
                .overlay(alignment: .trailing) {
                    if chat.presented && overlay {
                        HStack(spacing: 0) {
                            Divider()
                            WikiChatPanel(chat: chat, scope: ScheduledChatLogic.scope, compact: false)
                                .accessibilityIdentifier("scheduled-chat-panel")
                        }
                        .frame(width: 400)
                        .frame(maxHeight: .infinity)
                        .background(Color.driveCardBackground)
                        .shadow(color: .black.opacity(0.18), radius: 12, x: -4, y: 0)
                        .transition(.move(edge: .trailing))
                    }
                }
                .animation(.snappy(duration: 0.25), value: chat.presented)
                // The detail column's right edge is the window's: what decides column or slide-over.
                .onGeometryChange(for: CGFloat.self, of: { $0.frame(in: .global).maxX }) { chat.windowWidth = $0 }
                .onChange(of: overlay, initial: true) { _, overlay in chat.scheduledOverlay = overlay }
                .scheduledChatLive(chat, sheet: false)
        } else {
            content
        }
    }
}

extension View {
    /// The Scheduled chat's third column beside the inspector (`ScheduledChatColumn`).
    func scheduledChatColumn() -> some View { modifier(ScheduledChatColumn()) }
}
#else
/// An iPad's detail column at a regular width: the chat while it is open, beside the page's list (whose schedule opens
/// as its sheet); else what the column showed before.
struct ScheduledChatDetail: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        if let chat = app.scheduledChat {
            Group {
                if chat.presented {
                    WikiChatPanel(chat: chat, scope: ScheduledChatLogic.scope, compact: false)
                        .accessibilityIdentifier("scheduled-chat-panel")
                } else {
                    placeholder
                }
            }
            .animation(.snappy(duration: 0.25), value: chat.presented)
            .scheduledChatLive(chat, sheet: false)
        } else {
            placeholder
        }
    }

    private var placeholder: some View {
        ContentUnavailableView(AppSection.scheduled.title, systemImage: AppSection.scheduled.systemImage)
    }
}

// MARK: - the sheet (iPhone, iPad compact)

/// The iPhone's Scheduled stack with its chat: the sheet the toolbar button opens, at half height first so the list
/// stays scrollable behind it, and dragged up to full. Never open on its own.
private struct ScheduledChatSheetHost: ViewModifier {
    @Environment(AppModel.self) private var app
    @State private var detent: PresentationDetent = .medium

    func body(content: Content) -> some View {
        if let chat = app.scheduledChat {
            content
                .sheet(isPresented: Binding(get: { chat.presented }, set: { if !$0 { chat.closeByOwner() } })) {
                    WikiChatPanel(chat: chat, scope: ScheduledChatLogic.scope, compact: true)
                        .presentationDetents([.medium, .large], selection: $detent)
                        .presentationBackgroundInteraction(.enabled(upThrough: .medium))
                        .presentationContentInteraction(.scrolls)
                        .presentationDragIndicator(.visible)
                        .accessibilityIdentifier("scheduled-chat-panel")
                }
                .onChange(of: chat.presented) { _, open in if open { detent = .medium } }
                .scheduledChatLive(chat, sheet: true)
        } else {
            content
        }
    }
}

extension View {
    /// The Scheduled chat on the iPhone's Scheduled stack (`ScheduledChatSheetHost`).
    func scheduledChatSheetHost() -> some View { modifier(ScheduledChatSheetHost()) }
}
#endif
