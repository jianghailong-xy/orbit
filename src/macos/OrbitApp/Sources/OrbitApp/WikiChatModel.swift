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

    private let api: APIClient
    @ObservationIgnored private var nudgeTask: Task<Void, Never>?
    /// The cards on screen, by how many views show each: what a nudge re-reads beyond the open chat's.
    @ObservationIgnored private var cardsOnScreen: [String: Int] = [:]

    init(baseURL: URL, tokenStore: TokenStore) {
        api = APIClient(baseURL: baseURL, tokenStore: tokenStore)
    }

    // MARK: what is read off the server

    /// The session whose transcript streams while the panel shows it: `AppModel.focusedConsoleSessionID`'s fallback.
    var focusedSessionID: String? {
        presented && chat != WikiChatLogic.newChat ? chat : nil
    }

    func list(_ spaceID: String?) -> WikiChatList? {
        spaceID.flatMap { lists[$0] }
    }

    /// The round button's look, from the space's chats read; at rest before it is read.
    func fab(_ spaceID: String?) -> WikiChatLogic.FabLook {
        WikiChatLogic.fab(list(spaceID)?.fab)
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
            .filter { $0.state == .applied && $0.rewrite?.result == .updated && $0.rewrite?.seen == false }
            .max { ($0.rewrite?.settledAt ?? "") < ($1.rewrite?.settledAt ?? "") }
    }

    /// `<doc>#<key>` of each section an open card of the panel's chat would rewrite, marked on the page beside it
    /// (board 42 ②).
    var wouldRewrite: Set<String> {
        presented ? WikiChatLogic.wouldRewrite(openChatCards) : []
    }

    /// The composer's placeholder: a chat with an open card is asked what to change in it (board 42 ②).
    var placeholder: String {
        openChatCards.contains { $0.state == .draft || $0.state == .changed }
            ? WikiChatCopy.placeholderDraft : WikiChatCopy.placeholder
    }

    // MARK: reads

    /// The space's chats, the button's counts and where a new chat runs. A server without chats (404) leaves the
    /// button at rest.
    func load(spaceID: String) async {
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
            await self.reloadLoaded()
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
        enter(spaceID: spaceID)
        chat = WikiChatLogic.toOpen(list(spaceID)?.chats)
        focusCard = nil
        presented = true
        Task { await focusFirstCardThatNeedsYou() }
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
    }

    /// Before the page opens a sheet of its own: a phone's chat sheet folds away first, since one sheet shows at a
    /// time. True when there was one to fold, so the page waits for it to go.
    func foldForSheet() -> Bool {
        guard presented, asSheet else { return false }
        close()
        return true
    }

    /// The chat the title's history menu picked.
    func pick(chat sessionID: String) {
        chat = sessionID
        focusCard = nil
        Task { await loadCards(chat: sessionID) }
    }

    /// `+`: a new chat in the same space.
    func newChat() {
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
        focusCard = openChatCards.first { WikiChatLogic.cardNeedsYou($0.card) }.map { PublicID.storageKey($0.id) }
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
            if chat == WikiChatLogic.newChat { chat = WikiChatLogic.toOpen(list(spaceID)?.chats) }
            presented = true
        }
        asking = request
    }

    /// The Ask sheet's sentences went into the composer: the quote replaces any before it.
    func quote(_ quote: WikiChatLogic.Quote) {
        attachments = WikiChatLogic.attach(attachments, .quote(quote))
        asking = nil
    }

    /// The message went: what it carried stays with it, and the next starts with the page and no quote.
    func sent() {
        attachments = WikiChatLogic.attach(attachments, .sent)
    }

    /// What the message about to go carries (contract `chat.notes.wikiContext`).
    var context: WikiChatContext? {
        WikiChatLogic.context(attachments)
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
        guard !creating, let request = WikiChatLogic.createRequest(
            first, workspaceId: workspaceID, context: context, clientTurnId: UUID().uuidString.lowercased()) else { return false }
        creating = true
        defer { creating = false }
        do {
            let made = try await api.createWikiChat(spaceID: spaceID, request)
            sent()
            draftText = ""
            pickedWorkspace = nil
            chat = made.sessionId
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
