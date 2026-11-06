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

/// See changes, open on one section of one card's rewrite: the version that rewrite kept, compared with the text
/// that replaced it (contract `docs.versions.compare`).
struct WikiChatSeeChanges: Identifiable, Equatable {
    let spaceID: String
    let docSlug: String
    let sectionKey: String
    /// "3.1 §3".
    let place: String
    /// The version the rewrite kept; nil opens the newest.
    let versionID: String?
    /// The card it was opened from, which the opening marks seen.
    let draftID: String?
    var id: String { "\(docSlug):\(sectionKey):\(versionID ?? "-")" }
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
    /// A new chat's words, kept while it has no session to hold them.
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
    /// What a refused press or send said, shown once.
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
        guard let read = try? await api.wikiChatDraft(id) else { return }
        store(read)
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
        guard let read = try? await api.wikiDocSectionVersions(spaceID: spaceID, slug: slug, key: key) else { return }
        let cacheKey = Self.versionsKey(spaceID: spaceID, slug: slug, key: key)
        if versions[cacheKey] != read { versions[cacheKey] = read }
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

    /// Make the chat with the owner's first words, word for word, and show it. False when it was refused.
    func create(spaceID: String, text: String) async -> Bool {
        guard !creating, case .chosen(let workspace, _, _)? = runsIn(spaceID) else { return false }
        creating = true
        defer { creating = false }
        do {
            let made = try await api.createWikiChat(spaceID: spaceID, WikiChatCreateRequest(
                workspaceId: workspace.id, content: text, clientTurnId: UUID().uuidString.lowercased(), wikiContext: context))
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

    /// Apply, Discard, Undo, Try again or seen. A refusal is said once; the card is read again either way.
    func press(_ card: WikiChatDraftView, _ press: WikiChatPress) async {
        let key = PublicID.storageKey(card.id)
        guard !pressing.contains(key) else { return }
        pressing.insert(key)
        defer { pressing.remove(key) }
        do {
            store(try await api.pressWikiChatDraft(card.id, press).draft)
        } catch {
            if press != .seen { refusal = Self.refusalText(error) }
            await loadCard(card.id)
        }
        if let space = spaceID { await load(spaceID: space) }
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
            return Self.refusalText(error)
        }
    }

    /// The opened result of a settled rewrite is seen (contract `chat.presses.seen`): once.
    func markSeen(_ card: WikiChatDraftView) {
        guard let rewrite = card.rewrite, !rewrite.seen,
              [.updated, .same, .failed].contains(rewrite.result) else { return }
        Task { await press(card, .seen) }
    }

    /// The server's own words for a refused press, else the plain sentence.
    static func refusalText(_ error: Error) -> String {
        if case APIError.http(_, let body?) = error, let data = body.data(using: .utf8),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let message = object["message"] as? String, !message.isEmpty {
            return message
        }
        return WikiCopy.decideFailed
    }
}
