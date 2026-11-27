import Foundation
import Observation
import OrbitKit

/// The paragraph an Ask was pressed on (docs/wiki-comment-to-session-design.md §5): its sentences, which the Ask sheet
/// lists for a tap each, and where it is.
struct WikiChatAskRequest: Identifiable, Equatable {
    let docSlug: String
    /// "3.1 §3".
    let place: String
    let sentences: [WikiChatLogic.AskSentence]
    var id: String { "\(docSlug):\(sentences.first?.id ?? place)" }
}

/// See changes (contract `docs.versions.compare`, the web's `WikiSeeChanges`): each section a card's rewrite wrote, or
/// the one section a page's Updated names — the version the write kept, compared with the text that replaced it.
struct WikiChatSeeChanges: Identifiable, Equatable {
    struct Section: Equatable {
        let docSlug: String
        let sectionKey: String
        /// "3.1 §3".
        let place: String
        /// The version the write kept; nil opens the newest.
        let versionID: String?
        /// A write that left the section as it was and kept no version (a card's `same` section): nothing to read.
        var unchanged = false
    }

    let spaceID: String
    let sections: [Section]
    /// The card it was opened from, which the opening marks seen.
    let draftID: String?
    var id: String { sections.map { "\($0.docSlug):\($0.sectionKey):\($0.versionID ?? "-")" }.joined(separator: "|") }
}

extension WikiChatSeeChanges {
    /// See changes for a card's rewrite: each section it wrote, or read the same (the web's card opens these).
    static func of(_ card: WikiChatDraftView, spaceID: String) -> WikiChatSeeChanges? {
        guard let rewrite = card.rewrite else { return nil }
        let sections = WikiChatLogic.seeChangesSections(rewrite).compactMap { section -> Section? in
            guard let doc = section.doc, let key = section.key else { return nil }
            return Section(docSlug: doc, sectionKey: key, place: section.place, versionID: section.versionId,
                           unchanged: section.result == .same)
        }
        return sections.isEmpty ? nil : WikiChatSeeChanges(spaceID: spaceID, sections: sections, draftID: card.id)
    }
}

/// Where a chat is docked, which decides its words, where its chats are read and made, what a message carries beside
/// the words and which cards it draws (the web's `ChatOrigin`, board drive-chat 02): the Wiki, whose scope is a space,
/// Drive, which has one scope (`DriveChatLogic.scope`), or the Scheduled page, which has one too
/// (`ScheduledChatLogic.scope`, board scheduled-chat 01 part 4). The panel, the composer and the history are the same.
enum ChatOrigin: Equatable {
    case wiki
    case drive
    case scheduled

    /// The words that differ by origin.
    struct Copy {
        let history: String
        let noHistory: String
        let emptyHint: String
        let emptyNote: String
        let placeholder: String
        let chooseWorkspace: String
        /// Nothing to run a new chat in.
        let noWorkspace: String
        /// Under a new chat's empty state while its box is empty.
        let examples: [String]
        /// After the examples: what applies at once and what needs Allow (the Scheduled chat's opening, §4.1).
        var closing: String = ""
    }

    var copy: Copy {
        switch self {
        case .wiki:
            return Copy(history: WikiChatCopy.history, noHistory: WikiChatCopy.noHistory, emptyHint: WikiChatCopy.emptyHint,
                        emptyNote: WikiChatCopy.emptyNote, placeholder: WikiChatCopy.placeholder,
                        chooseWorkspace: WikiChatCopy.chooseWorkspace, noWorkspace: WikiChatCopy.noWorktree, examples: [])
        case .drive:
            return Copy(history: DriveChatCopy.history, noHistory: DriveChatCopy.noHistory, emptyHint: DriveChatCopy.emptyHint,
                        emptyNote: DriveChatCopy.emptyNote, placeholder: DriveChatCopy.placeholder,
                        chooseWorkspace: DriveChatCopy.chooseWorkspace, noWorkspace: DriveChatCopy.noWorkspace,
                        examples: DriveChatCopy.examples)
        case .scheduled:
            // The opening's own words come from the server (`WikiChatModel.copy`); these stand until it is read.
            return Copy(history: ScheduledChatCopy.history, noHistory: ScheduledChatCopy.noHistory, emptyHint: "",
                        emptyNote: "", placeholder: ScheduledChatCopy.placeholder,
                        chooseWorkspace: ScheduledChatCopy.chooseWorkspace, noWorkspace: ScheduledChatCopy.noWorkspace,
                        examples: [])
        }
    }
}

/// The wiki chat on iOS and macOS (docs/wiki-chat-design.md §9, board 42 ⑤): the space's chats and the round button's
/// counts, the chat the panel shows and its attachments, the cards a chat's transcript draws, and the owner's presses
/// on them. Owned by `AppModel` beside `WikiModel`. Refetched rather than patched: `wiki.changed` names a space and
/// nothing else (contract `chat.realtime`), so a nudge re-reads what is loaded.
///
/// What the server says is never stored here a second time: the button's look, a card's state and what it offers are
/// read off the server's reads (`WikiChatLogic`). What is the reader's own is: which chat the panel shows, whether it
/// is open, and the composer's attachments.
@MainActor
@Observable
final class WikiChatModel {
    /// The chats read of each space, by its id.
    private(set) var lists: [String: WikiChatList] = [:]
    /// Every card read, by the storage key of its id.
    private(set) var cards: [String: WikiChatDraftView] = [:]
    /// Each chat's cards, oldest first, by the storage key of its session id.
    private(set) var chatCards: [String: [String]] = [:]
    /// A section's versions, by `versionsKey`.
    private(set) var versions: [String: WikiDocSectionVersions] = [:]

    /// Whether the panel is open: the two-height sheet on a phone, the third column on an iPad or a Mac.
    var presented = false
    /// Whether the panel, open or not, is a sheet here (a compact width): the page folds it before a sheet of its own.
    var asSheet = false
    /// The chat the panel shows: a session id, or `WikiChatLogic.newChat`.
    private(set) var chat: String = WikiChatLogic.newChat
    /// The space whose chat the panel shows: a chat belongs to one (design §4.1).
    private(set) var spaceID: String?
    /// The composer's attachments: the page, following the reader, and the quote an Ask put there (design §4.2).
    private(set) var attachments = WikiChatLogic.Attachments()
    /// A new chat's words, kept while it has no session to hold them: its draft console's, across the panel folding.
    var draftText = ""
    /// The Ask sheet, open in the panel over its chat.
    var asking: WikiChatAskRequest?
    /// See changes, open over the page or the panel.
    var seeChanges: WikiChatSeeChanges?
    /// The card the panel scrolls to as it opens from the button (design §3: straight to the card to look at).
    var focusCard: String?
    /// The workspace picked in Runs in for a new chat (design §5.1), until the chat is made.
    var pickedWorkspace: String?
    /// The cards a press is on now, so their buttons don't take a second press.
    private(set) var pressing: Set<String> = []
    /// What a card's last press that did not go said, by the card's storage key: drawn in the card (`wikiChatPressError`).
    private(set) var pressFailures: [String: String] = [:]
    /// The cards whose read failed, by storage key: the call stands, its card cannot be read now.
    private(set) var unreadCards: Set<String> = []
    /// The sections whose versions could not be read, by `versionsKey`.
    private(set) var failedVersions: Set<String> = []
    /// What a refused send said, shown once.
    var refusal: String?
    /// A new chat being made.
    private(set) var creating = false
    /// The panel was shown by the page opening (board 45), not by a press: a phone-width window folds it away and a
    /// wide one brings it back, where a panel the owner opened stays a sheet.
    private(set) var openedByDefault = false
    /// The history the title opens over the whole panel (board 45 ④), nil while the chat shows.
    var history: WikiChatHistory?

    /// Where this chat is docked: the Wiki's spaces, or Drive.
    let origin: ChatOrigin

    // Drive's own (board drive-chat 02): its chats read as the server answered, where a new chat may run, each chat's
    // change groups and overwrite questions, the green check, and the account the device keeps ✕ and the seen marks for.
    /// `GET /drive/chats`, as answered.
    private(set) var driveRead: DriveChatList?
    /// The owner's workspaces, which Runs in offers beside the server's default (the host lists them).
    private(set) var workspaceChoices: [WikiChatWorkspace] = []
    /// A chat's change groups, by the storage key of its session id.
    private(set) var driveGroups: [String: [DriveChatChangeGroup]] = [:]
    /// A chat's overwrite questions, by the storage key of its session id.
    private(set) var driveQuestions: [String: [DriveChatQuestion]] = [:]
    /// A chat's work finished while the panel was closed: the button's green check until it is pressed.
    private(set) var driveUpdated = false
    /// The signed-in account: ✕ and the seen marks are kept per account on this device.
    var account: String?
    /// The mark keys the owner opened (`DriveChatLogic.remember`), read from this device.
    private(set) var seenMarks: [String] = []
    /// The window's width where the panel is a Mac's column: at 1760 or wider a file's details stand beside the chat,
    /// narrower they overlay the list (board drive-chat 02 ③).
    var windowWidth: CGFloat = 0

    // Scheduled's own (board scheduled-chat 01 part 4, docs/scheduled-chat-design.md §3-§5): the opening and the
    // account's open chat as `GET /schedules/chat` answered, the page chats of the Open list, the cards waiting in them,
    // and the page's workspace filter, which a message carries and Runs in starts on.
    /// `GET /schedules/chat`, as answered.
    private(set) var scheduledRead: SchedulePageChatResponse?
    /// The Open list's page chats (`chatOrigin == SCHEDULE_CHAT`), as the host hands them over.
    private(set) var scheduledSessions: [Session] = []
    /// The schedule cards waiting on the owner in each open page chat, by the storage key of its session id.
    private(set) var scheduledWaiting: [String: Int] = [:]
    /// The Scheduled page's workspace filter.
    private(set) var scheduledFilter: String?
    /// On a Mac under 1200 points the chat slides over the inspector instead of standing beside it (design §6).
    var scheduledOverlay = false

    private let api: APIClient
    @ObservationIgnored private var nudgeTask: Task<Void, Never>?
    /// The cards on screen, by how many views show each: what a nudge re-reads beyond the open chat's.
    @ObservationIgnored private var cardsOnScreen: [String: Int] = [:]

    init(baseURL: URL, tokenStore: TokenStore, origin: ChatOrigin = .wiki) {
        api = APIClient(baseURL: baseURL, tokenStore: tokenStore)
        self.origin = origin
    }

    /// The words this chat says where they differ by origin.
    var copy: ChatOrigin.Copy {
        guard origin == .scheduled, let opening = scheduledRead?.opening else { return origin.copy }
        // Orbit's opening (§4.1): the counts and the next run, then the examples, then what applies at once.
        let base = origin.copy
        return ChatOrigin.Copy(history: base.history, noHistory: base.noHistory,
                               emptyHint: [opening.summary, opening.nextText].compactMap { $0 }.joined(separator: " "),
                               emptyNote: opening.examplesLead, placeholder: base.placeholder,
                               chooseWorkspace: base.chooseWorkspace, noWorkspace: base.noWorkspace,
                               examples: opening.examples, closing: opening.closing)
    }

    // MARK: what is read off the server

    /// The session whose transcript streams while the panel shows it: `AppModel.focusedConsoleSessionID`'s fallback.
    var focusedSessionID: String? {
        presented && chat != WikiChatLogic.newChat ? chat : nil
    }

    func list(_ spaceID: String?) -> WikiChatList? {
        spaceID.flatMap { lists[$0] }
    }

    /// The round button's look, from the space's chats read; at rest before it is read. Drive's counts the held groups
    /// and the open questions beside the approvals, and its check is the drive's (`driveChatFab`).
    func fab(_ spaceID: String?) -> WikiChatLogic.FabLook {
        guard origin == .drive else { return WikiChatLogic.fab(list(spaceID)?.fab) }
        guard let read = driveRead else { return DriveChatLogic.fab(nil) }
        let waiting = DriveChatLogic.needYou(groups: driveGroups.values.flatMap { $0 }, questions: driveQuestions.values.flatMap { $0 })
        return DriveChatLogic.fab(WikiChatFabCounts(needsYou: read.fab.needsYou + waiting, working: read.fab.working,
                                                    updated: driveUpdated ? 1 : 0))
    }

    func card(_ id: String) -> WikiChatDraftView? {
        cards[PublicID.storageKey(id)]
    }

    /// The panel's chat's cards, oldest first.
    var openChatCards: [WikiChatDraftView] {
        guard chat != WikiChatLogic.newChat else { return [] }
        return (chatCards[PublicID.storageKey(chat)] ?? []).compactMap { cards[$0] }
    }

    /// The row of the panel's chat in its space's list.
    var openChatRow: WikiChatRow? {
        list(spaceID)?.chats.first { PublicID.storageKey($0.sessionId) == PublicID.storageKey(chat) }
    }

    /// The newest applied card whose rewrite came out updated and is not seen yet, among the cards read: what floats
    /// over the page once the chat is folded away (board 42 ⑤, third phone).
    var updatedCard: WikiChatDraftView? {
        cards.values
            .filter { ($0.state == .applied || $0.state == .rewritten) && $0.rewrite?.result == .updated && $0.rewrite?.seen == false }
            .max { ($0.rewrite?.settledAt ?? "") < ($1.rewrite?.settledAt ?? "") }
    }

    /// `<doc>#<key>` of each section an open card of the panel's chat would rewrite, marked on the page beside it
    /// (board 42 ②).
    var wouldRewrite: Set<String> {
        presented ? WikiChatLogic.wouldRewrite(openChatCards) : []
    }

    /// The composer's placeholder: a chat with an open card is asked what to change in it (board 42 ②).
    var placeholder: String {
        guard origin == .wiki else { return copy.placeholder }
        return openChatCards.contains { $0.state == .draft || $0.state == .changed }
            ? WikiChatCopy.placeholderDraft : WikiChatCopy.placeholder
    }

    // MARK: reads

    /// The space's chats, the button's counts and where a new chat runs. A server without chats (404) leaves the
    /// button at rest.
    func load(spaceID: String) async {
        if origin == .drive { return await loadDrive() }
        if origin == .scheduled { return await loadScheduled() }
        guard let read = try? await api.wikiChats(spaceID: spaceID) else { return }
        if lists[spaceID] != read { lists[spaceID] = read }
        // The button says a rewrite came out updated: read the chats that hold cards until the card is found.
        if read.fab.updated > 0 && updatedCard == nil {
            for row in read.chats.prefix(5) where row.drafts > 0 && chatCards[PublicID.storageKey(row.sessionId)] == nil {
                await loadCards(chat: row.sessionId)
                if updatedCard != nil { break }
            }
        }
    }

    /// Every card of a chat.
    func loadCards(chat sessionID: String) async {
        if origin == .drive { return await loadDriveCards(chat: sessionID) }
        // A page chat's cards and change lines are its console's own (`ConsoleModel.refreshScheduleCards`).
        if origin == .scheduled { return }
        guard sessionID != WikiChatLogic.newChat,
              let read = try? await api.wikiChatDrafts(sessionID: sessionID) else { return }
        var ids: [String] = []
        for card in read.drafts {
            let key = PublicID.storageKey(card.id)
            if cards[key] != card { cards[key] = card }
            ids.append(key)
        }
        let chatKey = PublicID.storageKey(sessionID)
        if chatCards[chatKey] != ids { chatCards[chatKey] = ids }
    }

    /// One card, read on its own: the transcript of the full session page draws it too.
    func loadCard(_ id: String) async {
        let key = PublicID.storageKey(id)
        guard let read = try? await api.wikiChatDraft(id) else {
            if cards[key] == nil { unreadCards.insert(key) }
            return
        }
        unreadCards.remove(key)
        store(read)
    }

    /// The card's read failed and nothing of it is held: the slot says so.
    func isUnread(_ id: String) -> Bool {
        unreadCards.contains(PublicID.storageKey(id))
    }

    /// A card the transcript shows came on screen, or left it: what a nudge re-reads.
    func cardAppeared(_ id: String) {
        cardsOnScreen[PublicID.storageKey(id), default: 0] += 1
    }

    func cardDisappeared(_ id: String) {
        let key = PublicID.storageKey(id)
        guard let count = cardsOnScreen[key] else { return }
        cardsOnScreen[key] = count > 1 ? count - 1 : nil
    }

    static func versionsKey(spaceID: String, slug: String, key: String) -> String {
        "\(PublicID.storageKey(spaceID))|\(slug)|\(key)"
    }

    /// A section's versions: See changes, and the new sentences of a section marked Updated.
    func loadVersions(spaceID: String, slug: String, key: String) async {
        let cacheKey = Self.versionsKey(spaceID: spaceID, slug: slug, key: key)
        guard let read = try? await api.wikiDocSectionVersions(spaceID: spaceID, slug: slug, key: key) else {
            failedVersions.insert(cacheKey)
            return
        }
        failedVersions.remove(cacheKey)
        if versions[cacheKey] != read { versions[cacheKey] = read }
    }

    func versionsFailed(spaceID: String, slug: String, key: String) -> Bool {
        failedVersions.contains(Self.versionsKey(spaceID: spaceID, slug: slug, key: key))
    }

    func versions(spaceID: String, slug: String, key: String) -> WikiDocSectionVersions? {
        versions[Self.versionsKey(spaceID: spaceID, slug: slug, key: key)]
    }

    /// `wiki.changed` arrived, or a press landed: re-read what is loaded, once for a burst.
    func nudge() {
        guard nudgeTask == nil else { return }
        nudgeTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 400_000_000)
            guard let self else { return }
            self.nudgeTask = nil
            // Hidden since it was asked: owed, one read when the app is shown (§4 R3).
            if origin == .scheduled {
                VisibilityGate.app.read("scheduled-chat.loaded") { [weak self] in
                    Task { await self?.reloadLoaded() }
                }
                return
            }
            VisibilityGate.app.read(origin == .drive ? "drive-chat.loaded" : "wiki-chat.loaded") { [weak self] in
                Task { await self?.reloadLoaded() }
            }
        }
    }

    /// What is loaded, read again — what the control plane's reconnect asks for too.
    func reloadLoaded() async {
        for space in Array(lists.keys) { await load(spaceID: space) }
        // Kept by storage key; the door takes the public id.
        for chat in Array(chatCards.keys) { await loadCards(chat: PublicID.toPublic(chat)) }
        let inChats = Set(chatCards.values.flatMap { $0 })
        for key in Array(cardsOnScreen.keys) where !inChats.contains(key) { await loadCard(PublicID.toPublic(key)) }
    }

    private func store(_ card: WikiChatDraftView) {
        let key = PublicID.storageKey(card.id)
        if cards[key] != card { cards[key] = card }
        let chatKey = PublicID.storageKey(card.sessionId)
        if var ids = chatCards[chatKey], !ids.contains(key) {
            ids.append(key)
            chatCards[chatKey] = ids
        }
    }

    // MARK: the panel

    /// The round button (design §3): the space's chat that needs the owner, else its newest open one, else a new one —
    /// and, once its cards are read, straight to the first card that needs the owner.
    func openFromButton(spaceID: String) {
        // The button undoes ✕ (Q1 A): pages open with the panel shown again.
        setHiddenByOwner(spaceID, false)
        openedByDefault = false
        enter(spaceID: spaceID)
        chat = toOpen(list(spaceID)?.chats)
        focusCard = nil
        presented = true
        // The button has seen what finished while the panel was closed.
        driveUpdated = false
        Task { await focusFirstCardThatNeedsYou() }
    }

    /// Which chat the panel opens on: Drive's leaves a completed chat be (`driveChatToOpen`).
    private func toOpen(_ chats: [WikiChatRow]?) -> String {
        if origin == .scheduled { return ScheduledChatLogic.toOpen(chats, openID: scheduledRead?.sessionId) }
        return origin == .drive ? DriveChatLogic.toOpen(chats) : WikiChatLogic.toOpen(chats)
    }

    /// Open the panel on the chat holding `card` — the floating line's press, Activity's banner.
    func open(chat sessionID: String, spaceID: String, card: String? = nil) {
        enter(spaceID: spaceID)
        chat = sessionID
        focusCard = card.map(PublicID.storageKey)
        presented = true
        Task { await loadCards(chat: sessionID) }
    }

    /// Fold the panel away; the chat goes on (design §3).
    func close() {
        presented = false
        asking = nil
        history = nil
    }

    // MARK: open by default (board 45 ①②, owner 11-11)

    /// The spaces whose panel the owner hid with ✕, kept on this device until the button opens it again (Q1 A).
    private static let hiddenKey = "orbit.wikiChat.hidden"

    func hiddenByOwner(_ spaceID: String) -> Bool {
        // Drive's ✕ is kept per account on this device (board drive-chat 02 ① note 5).
        if origin == .drive { return account.map { UserDefaults.standard.bool(forKey: DriveChatLogic.closedKey(account: $0)) } ?? false }
        // Scheduled keeps the opposite: whether it was left open, never open the first time (D3 A).
        if origin == .scheduled { return !scheduledRemembered }
        return (UserDefaults.standard.dictionary(forKey: Self.hiddenKey)?[PublicID.storageKey(spaceID)] as? Bool) == true
    }

    private func setHiddenByOwner(_ spaceID: String, _ hidden: Bool) {
        if origin == .drive {
            guard let account else { return }
            if hidden { UserDefaults.standard.set(true, forKey: DriveChatLogic.closedKey(account: account)) }
            else { UserDefaults.standard.removeObject(forKey: DriveChatLogic.closedKey(account: account)) }
            return
        }
        if origin == .scheduled {
            guard let account else { return }
            if hidden { UserDefaults.standard.removeObject(forKey: ScheduledChatLogic.shownKey(account: account)) }
            else { UserDefaults.standard.set(true, forKey: ScheduledChatLogic.shownKey(account: account)) }
            return
        }
        var all = UserDefaults.standard.dictionary(forKey: Self.hiddenKey) ?? [:]
        if hidden { all[PublicID.storageKey(spaceID)] = true } else { all.removeValue(forKey: PublicID.storageKey(spaceID)) }
        UserDefaults.standard.set(all, forKey: Self.hiddenKey)
    }

    /// ✕, or the column dismissed: the owner saying no. Kept until the button opens the panel again (Q1 A).
    func closeByOwner() {
        if let spaceID { setHiddenByOwner(spaceID, true) }
        openedByDefault = false
        close()
    }

    /// A Wiki page of `spaceID` shows the panel where it is the third column, on the chat the button would open,
    /// unless the owner hid it (`WikiChatLogic.opensByDefault`). Called once the chats are read and whenever the
    /// width or the page changes; a panel already open is left as it is.
    func openByDefault(spaceID: String, settingsOnTop: Bool) {
        // The Scheduled page never opens the chat by itself: it only shows it again where it was left open.
        if origin == .scheduled { return restoreScheduled() }
        let fits = WikiChatLogic.opensByDefault(sheet: asSheet, settingsOnTop: settingsOnTop, hiddenByOwner: hiddenByOwner(spaceID))
        if presented {
            // Narrowed to a phone's width, or turned to Settings: a panel the page opened folds away with it.
            if openedByDefault && !fits { presented = false }
            return
        }
        guard fits, let read = list(spaceID) else { return }
        // Widened again after a narrow window folded it: the same chat comes back. Otherwise the button's choice.
        let returning = openedByDefault && self.spaceID == spaceID
        enter(spaceID: spaceID)
        if !returning { chat = toOpen(read.chats) }
        focusCard = nil
        openedByDefault = true
        presented = true
        Task { await focusFirstCardThatNeedsYou() }
    }

    /// Before the page opens a sheet of its own: a phone's chat sheet folds away first, since one sheet shows at a
    /// time. True when there was one to fold, so the page waits for it to go.
    func foldForSheet() -> Bool {
        guard presented, asSheet else { return false }
        close()
        return true
    }

    /// The chat the history picked.
    func pick(chat sessionID: String) {
        history = nil
        chat = sessionID
        focusCard = nil
        Task { await loadCards(chat: sessionID) }
    }

    /// `+`: a new chat in the same space.
    func newChat() {
        history = nil
        chat = WikiChatLogic.newChat
        focusCard = nil
        pickedWorkspace = nil
    }

    private func enter(spaceID: String) {
        guard self.spaceID != spaceID else { return }
        // Another space: its chats, not this one's — and nothing attached from the page left behind.
        self.spaceID = spaceID
        chat = WikiChatLogic.newChat
        attachments = WikiChatLogic.Attachments()
        draftText = ""
        pickedWorkspace = nil
        asking = nil
    }

    private func focusFirstCardThatNeedsYou() async {
        guard chat != WikiChatLogic.newChat else { return }
        await loadCards(chat: chat)
        if origin == .drive {
            focusCard = driveCards(chat).first { $0.needsYou }?.id
            return
        }
        if origin == .scheduled { return }
        focusCard = openChatCards.first { WikiChatLogic.cardNeedsYou($0.card) }.map { PublicID.storageKey($0.id) }
    }

    // MARK: the history (board 45 ④, owner 11-11: Q3 A, Q4 A)

    /// The title pressed: the history over the whole panel, or back to the chat.
    func toggleHistory() {
        if history != nil { history = nil; return }
        history = WikiChatHistory()
        Task { await loadHistory() }
    }

    /// The history's first page for its words (`?q=`), read again from the top.
    func searchHistory(_ words: String) {
        guard history != nil else { return }
        history?.query = words
        Task { await loadHistory() }
    }

    /// The next page (`Show more`).
    func moreHistory() {
        guard let read = history, read.more, !read.loading else { return }
        Task { await loadHistory(offset: read.rows.count) }
    }

    func loadHistory(offset: Int = 0) async {
        guard let spaceID, let asked = history?.query else { return }
        history?.loading = true
        let read: WikiChatList?
        if origin == .scheduled {
            // Open from the list the host keeps, Completed one page of the session list's (design §3).
            let open = scheduledSessions
            let fab = lists[spaceID]?.fab ?? WikiChatFabCounts()
            read = (try? await api.listSessions(view: .completed)).map { completed in
                WikiChatList(spaceId: spaceID, fab: fab,
                             chats: ScheduledChatLogic.history(open: open, completed: completed, query: asked))
            }
        } else if origin == .drive {
            let choices = workspaceChoices
            read = (try? await api.driveChats(q: asked, offset: offset)).map { DriveChatLogic.hostList($0, choices: choices) }
        } else {
            read = try? await api.wikiChats(spaceID: spaceID, q: asked, offset: offset)
        }
        // A newer search, or the history closed, while this was read: drop it.
        guard history?.query == asked else { return }
        history?.loading = false
        guard let read else { history?.failed = offset == 0; return }
        history?.failed = false
        let seen = offset == 0 ? [] : Set((history?.rows ?? []).map { PublicID.storageKey($0.sessionId) })
        let fresh = read.chats.filter { !seen.contains(PublicID.storageKey($0.sessionId)) }
        history?.rows = (offset == 0 ? [] : history?.rows ?? []) + fresh
        history?.more = read.more
        history?.loaded = true
        if offset == 0, lists[spaceID] != nil, read.fab != lists[spaceID]?.fab { await load(spaceID: spaceID) }
    }

    /// A row's ⋯ (the session list's own doors): Rename…, Complete, Move to Trash, and Undo's way back to Open. Each
    /// reads the history and the space's chats again; the error, when a door refused, is the caller's to say.
    func renameChat(_ sessionID: String, title: String) async -> Error? {
        await act { try await self.api.renameSession(sessionID, title: title) }
    }

    func completeChat(_ sessionID: String) async -> Error? {
        await act { try await self.api.completeSession(sessionID) }
    }

    func trashChat(_ sessionID: String) async -> Error? {
        let error = await act { try await self.api.deleteSession(sessionID) }
        // The chat shown went to Trash: the panel turns to a new chat, the history stays.
        if error == nil, PublicID.storageKey(sessionID) == PublicID.storageKey(chat) {
            chat = WikiChatLogic.newChat
            focusCard = nil
        }
        return error
    }

    func restoreChat(_ sessionID: String) async -> Error? {
        await act { try await self.api.restoreSession(sessionID) }
    }

    private func act(_ door: @escaping () async throws -> Void) async -> Error? {
        do { try await door() } catch { return error }
        if let spaceID { await load(spaceID: spaceID) }
        if history != nil { await loadHistory() }
        return nil
    }

    // MARK: the attachments

    /// The reader moved: the page chip follows them until the message goes (design §4.2) — into another space too,
    /// whose chats the panel then shows, since a chat belongs to one space (design §4.1).
    func follow(spaceID: String, page: WikiChatLogic.Page?) {
        enter(spaceID: spaceID)
        attachments = WikiChatLogic.attach(attachments, .follow(page))
    }

    func crossPage() {
        attachments = WikiChatLogic.attach(attachments, .crossPage)
    }

    func crossQuote() {
        attachments = WikiChatLogic.attach(attachments, .crossQuote)
    }

    /// Ask on a paragraph (design §9): the panel opens over the page, with the paragraph's sentences to tap.
    func ask(_ request: WikiChatAskRequest, spaceID: String) {
        enter(spaceID: spaceID)
        if !presented {
            if chat == WikiChatLogic.newChat { chat = toOpen(list(spaceID)?.chats) }
            presented = true
        }
        asking = request
    }

    /// The Ask sheet's sentences went into the composer: the quote replaces any before it.
    func quote(_ quote: WikiChatLogic.Quote) {
        attachments = WikiChatLogic.attach(attachments, .quote(quote))
        asking = nil
    }

    /// An example pressed (board drive-chat 02 ①): it fills the new chat's box and sends nothing.
    func fillDraft(_ text: String) {
        draftText = text
    }

    /// The message went: what it carried stays with it, and the next starts with the page and no quote.
    func sent() {
        attachments = WikiChatLogic.attach(attachments, .sent)
    }

    /// What the message about to go carries (contract `chat.notes.wikiContext`).
    var context: WikiChatContext? {
        origin == .wiki ? WikiChatLogic.context(attachments) : nil
    }

    /// What a Drive chat's message carries: the folder and the files its chips show (`driveChatContext`).
    var driveContext: DriveChatContext? {
        origin == .drive ? DriveChatLogic.context(attachments) : nil
    }

    /// What a Scheduled page chat's message carries: the page's workspace filter and the schedule chip
    /// (`scheduledChatContext`).
    var scheduleContext: SchedulePageChatContext? {
        origin == .scheduled ? ScheduledChatLogic.context(filter: scheduledFilter, attachments: attachments) : nil
    }

    /// Drive: the files the chip names beside the folder (the selection, or the file open).
    func files(_ files: WikiChatLogic.Files?) {
        attachments = WikiChatLogic.attach(attachments, .files(files))
    }

    func crossFiles() {
        attachments = WikiChatLogic.attach(attachments, .crossFiles)
    }

    // MARK: a new chat (contract `chat.create`)

    /// Where the panel says a new chat will run, from the space's chats read.
    func runsIn(_ spaceID: String) -> WikiChatLogic.RunsIn? {
        list(spaceID).map { WikiChatLogic.runsIn($0, picked: pickedWorkspace) }
    }

    /// Make the chat in `workspaceID` with the composer's first message — the owner's words, the page and the
    /// selection, the files and the toolbar's picks (`WikiChatLogic.createRequest`) — and show it. False when it was
    /// refused, which the panel says.
    func create(spaceID: String, workspaceID: String, _ first: WikiChatLogic.FirstMessage) async -> Bool {
        guard !creating else { return false }
        let turn = UUID().uuidString.lowercased()
        let made: String
        creating = true
        defer { creating = false }
        do {
            if origin == .scheduled {
                // The door takes the words and the workspace alone: the chat starts as any new session there (§4.3).
                let words = first.words.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !words.isEmpty else { return false }
                made = try await api.openScheduledChat(workspaceID: workspaceID, text: words).sessionId
            } else if origin == .drive {
                // What is not shown is not sent: no chip shown goes as `noFolder` (`createDriveChat`).
                guard let request = DriveChatLogic.createRequest(first, workspaceId: workspaceID, context: driveContext,
                                                                 clientTurnId: turn) else { return false }
                made = try await api.createDriveChat(request).sessionId
            } else {
                guard let request = WikiChatLogic.createRequest(first, workspaceId: workspaceID, context: context,
                                                                clientTurnId: turn) else { return false }
                made = try await api.createWikiChat(spaceID: spaceID, request).sessionId
            }
            sent()
            draftText = ""
            pickedWorkspace = nil
            chat = made
            await load(spaceID: spaceID)
            return true
        } catch {
            refusal = WikiChatCopy.sendFailed
            return false
        }
    }

    // MARK: the presses (contract `chat.presses`)

    /// Apply, Discard, Undo, Try again or seen. What a press that did not go says stays in its card, until the next
    /// press; the card is read again either way.
    func press(_ card: WikiChatDraftView, _ press: WikiChatPress) async {
        let key = PublicID.storageKey(card.id)
        guard !pressing.contains(key) else { return }
        pressing.insert(key)
        defer { pressing.remove(key) }
        if press != .seen { pressFailures[key] = nil }
        do {
            store(try await api.pressWikiChatDraft(card.id, press).draft)
        } catch {
            // A plan card's change the plan's gate refused says every error under the reason (C12).
            if press != .seen { pressFailures[key] = WikiChatLogic.pressRefusal(error) }
            await loadCard(card.id)
        }
        if let space = spaceID { await load(spaceID: space) }
    }

    func pressFailed(_ card: WikiChatDraftView) -> String? {
        pressFailures[PublicID.storageKey(card.id)]
    }

    /// Edit: the owner's version of each op, applied as Review's Edit.
    func edit(_ card: WikiChatDraftView, ops: [WikiChatEditRequest.Op]) async -> String? {
        let key = PublicID.storageKey(card.id)
        pressing.insert(key)
        defer { pressing.remove(key) }
        do {
            store(try await api.editWikiChatDraft(card.id, WikiChatEditRequest(ops: ops)).draft)
            if let space = spaceID { await load(spaceID: space) }
            return nil
        } catch {
            return WikiChatLogic.pressError(error)
        }
    }

    /// The opened result of a settled rewrite is seen (contract `chat.presses.seen`): once — the card on screen in the
    /// panel, or See changes.
    func markSeen(_ card: WikiChatDraftView) {
        guard WikiChatLogic.needsSeen(card) else { return }
        Task { await press(card, .seen) }
    }
}

// MARK: - Drive (board drive-chat 02; the web's driveChat.ts, driveChanges.ts, useDriveChanges.ts)

extension WikiChatModel {
    /// Where a new chat may run besides the server's default: the owner's workspaces, as the host lists them.
    func setWorkspaceChoices(_ choices: [WikiChatWorkspace]) {
        guard origin != .wiki, choices != workspaceChoices else { return }
        workspaceChoices = choices
        if origin == .scheduled { return storeScheduled() }
        if let read = driveRead { storeDrive(read) }
    }

    private func storeDrive(_ read: DriveChatList) {
        if driveRead != read { driveRead = read }
        let host = DriveChatLogic.hostList(read, choices: workspaceChoices)
        if lists[DriveChatLogic.scope] != host { lists[DriveChatLogic.scope] = host }
    }

    /// `GET /drive/chats`, then the changes and questions of the open chats (the button's count and the marks). Work that
    /// finished while the panel was closed lights the check.
    fileprivate func loadDrive() async {
        guard let read = try? await api.driveChats() else { return }
        let wasWorking = driveRead?.fab.working ?? false
        storeDrive(read)
        if presented { driveUpdated = false } else if wasWorking && !read.fab.working { driveUpdated = true }
        for row in read.chats.filter(\.open).prefix(DriveChatLogic.chatsRead) {
            await loadDriveCards(chat: row.sessionId)
        }
    }

    /// A chat's change groups and questions.
    fileprivate func loadDriveCards(chat sessionID: String) async {
        guard sessionID != WikiChatLogic.newChat else { return }
        let key = PublicID.storageKey(sessionID)
        if let groups = try? await api.driveChatGroups(sessionID: sessionID), driveGroups[key] != groups { driveGroups[key] = groups }
        if let questions = try? await api.driveChatQuestions(sessionID: sessionID), driveQuestions[key] != questions {
            driveQuestions[key] = questions
        }
    }

    /// A chat's cards, oldest first, each with its turn.
    func driveCards(_ sessionID: String) -> [DriveChatLogic.Card] {
        let key = PublicID.storageKey(sessionID)
        return DriveChatLogic.cards(groups: driveGroups[key] ?? [], questions: driveQuestions[key] ?? [])
    }

    func driveCard(_ id: String) -> DriveChatLogic.Card? {
        driveCards(chat).first { $0.id == id }
    }

    /// Undo or Apply on a change card. What a press that did not go says stays in its card until the next press.
    func press(_ group: DriveChatChangeGroup, apply: Bool) async {
        let key = "group:\(group.id)"
        guard !pressing.contains(key) else { return }
        pressing.insert(key)
        defer { pressing.remove(key) }
        pressFailures[key] = nil
        do {
            let answer = try await api.pressDriveChatGroup(sessionID: group.sessionId, groupID: group.id, apply: apply)
            let chatKey = PublicID.storageKey(group.sessionId)
            driveGroups[chatKey] = (driveGroups[chatKey] ?? []).map { $0.id == answer.id ? answer : $0 }
        } catch {
            pressFailures[key] = WikiChatLogic.pressError(error)
        }
        await loadDrive()
    }

    /// Keep both or Replace on an overwrite card.
    func answer(_ question: DriveChatQuestion, _ choice: DriveChatQuestion.Choice) async {
        let key = "question:\(question.id)"
        guard !pressing.contains(key) else { return }
        pressing.insert(key)
        defer { pressing.remove(key) }
        pressFailures[key] = nil
        do {
            let answer = try await api.answerDriveChatQuestion(sessionID: question.sessionId, questionID: question.id, choice)
            let chatKey = PublicID.storageKey(question.sessionId)
            driveQuestions[chatKey] = (driveQuestions[chatKey] ?? []).map { $0.id == answer.id ? answer : $0 }
        } catch {
            pressFailures[key] = WikiChatLogic.pressError(error)
        }
        await loadDrive()
    }

    func pressFailed(card id: String) -> String? { pressFailures[id] }

    // MARK: the marks (board ② ⑤)

    /// The mark a row carries until it is opened: what the open chats' made groups did to it.
    func mark(_ entryID: String) -> DriveChatLogic.Mark? {
        guard let found = marks[PublicID.storageKey(entryID)], !seenMarks.contains(found.key) else { return nil }
        return found.mark
    }

    private var marks: [String: (mark: DriveChatLogic.Mark, key: String)] {
        DriveChatLogic.marks(driveGroups.values.flatMap { $0 })
    }

    /// A marked row was opened: its mark is seen, on this device, for this account.
    func opened(_ entryID: String) {
        guard let found = marks[PublicID.storageKey(entryID)], !seenMarks.contains(found.key) else { return }
        seenMarks = DriveChatLogic.remember(found.key, in: seenMarks)
        if let account { UserDefaults.standard.set(seenMarks, forKey: DriveChatLogic.seenKey(account: account)) }
    }

    /// The account signed in: its ✕ and its seen marks.
    func signedIn(_ account: String?) {
        guard origin != .wiki, account != self.account else { return }
        self.account = account
        seenMarks = account.flatMap { UserDefaults.standard.stringArray(forKey: DriveChatLogic.seenKey(account: $0)) } ?? []
    }
}

// MARK: - Scheduled (board scheduled-chat 01 part 4; the web's scheduledChat.ts and ScheduledChatPanel.tsx)

extension WikiChatModel {
    /// Whether the page chat was left open on this device for the signed-in account (D3 A: never the first time).
    var scheduledRemembered: Bool {
        account.map { UserDefaults.standard.bool(forKey: ScheduledChatLogic.shownKey(account: $0)) } ?? false
    }

    /// What the Scheduled page hands over: its Open list's sessions and its workspace filter.
    func setScheduledPage(sessions: [Session], filter: String?) {
        guard origin == .scheduled else { return }
        let chats = sessions.filter(ScheduledChatLogic.isScheduledChat)
        if chats != scheduledSessions { scheduledSessions = chats }
        if filter != scheduledFilter { scheduledFilter = filter }
        storeScheduled()
    }

    fileprivate func storeScheduled() {
        let workspace = ScheduledChatLogic.defaultWorkspace(filter: scheduledFilter, choices: workspaceChoices)
        let host = ScheduledChatLogic.hostList(sessions: scheduledSessions, workspace: workspace, choices: workspaceChoices,
                                               waitingCards: scheduledWaiting.values.reduce(0, +))
        if lists[ScheduledChatLogic.scope] != host { lists[ScheduledChatLogic.scope] = host }
    }

    /// `GET /schedules/chat` (the opening and the account's open chat), then the cards waiting in each open chat:
    /// the button's amber count, read from the chats and never stored (design §3).
    fileprivate func loadScheduled() async {
        if let read = try? await api.scheduledChat(timezone: TimeZone.current.identifier), scheduledRead != read {
            scheduledRead = read
        }
        var waiting: [String: Int] = [:]
        for row in (lists[ScheduledChatLogic.scope]?.chats ?? []).prefix(DriveChatLogic.chatsRead) {
            guard let cards = try? await api.sessionScheduleCards(sessionID: row.sessionId) else { continue }
            waiting[PublicID.storageKey(row.sessionId)] = cards.cards.filter { $0.state == "PENDING" }.count
        }
        if waiting != scheduledWaiting { scheduledWaiting = waiting }
        storeScheduled()
    }

    /// Where the chat is a column, the page shows it again if it was left open there; a sheet never opens by itself.
    fileprivate func restoreScheduled() {
        let scope = ScheduledChatLogic.scope
        guard !presented, ScheduledChatLogic.opensOnPage(sheet: asSheet, remembered: scheduledRemembered) else { return }
        if spaceID != scope { follow(spaceID: scope, page: nil) }
        chat = toOpenScheduled()
        focusCard = nil
        presented = true
    }

    private func toOpenScheduled() -> String {
        ScheduledChatLogic.toOpen(list(ScheduledChatLogic.scope)?.chats, openID: scheduledRead?.sessionId)
    }

    /// The toolbar's Chat button (board 4 ①): opens the chat — the one with a card waiting, else the open one, else a
    /// new one — or, pressed while it is open, closes it. Open or closed is kept on this device.
    func toggleScheduled() {
        if presented { closeByOwner() } else { openFromButton(spaceID: ScheduledChatLogic.scope) }
    }

    /// The row selected in the list follows into the composer as its chip, until another is selected (§2.4).
    func followSchedule(_ schedule: (id: String, title: String)?) {
        follow(spaceID: ScheduledChatLogic.scope, page: nil)
        files(schedule.map { ScheduledChatLogic.chip(scheduleID: $0.id, title: $0.title) })
    }

    /// ‹ Chat: the chat sheet comes back on the chat it showed.
    func reopenScheduled() {
        presented = true
    }
}

/// The history over the panel (board 45 ④): its words, the pages read so far, and whether more match.
struct WikiChatHistory: Equatable {
    var query = ""
    var rows: [WikiChatRow] = []
    var more = false
    var loading = false
    var loaded = false
    var failed = false
}
