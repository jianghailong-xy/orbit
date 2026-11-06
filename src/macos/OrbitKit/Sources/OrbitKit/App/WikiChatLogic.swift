import Foundation

/// The wiki chat's pure logic on iOS and macOS (docs/wiki-chat-design.md §3–§9, board 42 ⑤), on Linux-testable
/// values: what a card is and offers, what waits on the owner, the round button's look, the line under an applied
/// card, the attachment lines, the Docs rows — the client half of `@orbit/shared`'s `wikiChat.ts`, held to
/// `src/shared/src/wiki-chat.fixture.json` by `WikiChatContractTests` — and what the web's
/// `src/web/src/lib/wikiChat.ts` works out for its panel: which chat the button opens, where a new one runs, and the
/// composer's attachments. Nothing here is stored that the server already says (design §3: derived on read).
public enum WikiChatLogic {
    // MARK: the chat's numbers (contract `chat.rules`)

    /// The most sentences one selection attaches (design §4.2).
    public static let selectionSentencesMax = 20
    /// The most sections one card rewrites (design §8.2).
    public static let rewritesMax = 5
    /// The most chats one read of a space lists.
    public static let chatsListed = 50
    /// What stands for a chat not started yet where a chat's session id would (the web's `?chat=new`).
    public static let newChat = "new"

    /// The round button (design §3, contract `chat.fab.where`): 56 across and 16 from the edges plus the safe area
    /// on a phone, 52 and 24 on a wider window; the page's foot keeps 88 clear for it.
    public enum Fab {
        public static let phoneDiameter: Double = 56
        public static let phoneInset: Double = 16
        public static let wideDiameter: Double = 52
        public static let wideInset: Double = 24
        public static let footClearance: Double = 88
    }

    /// `{name}` filled from `values`; a name it has no value for stays as it was, as the shared `fill` leaves it.
    public static func fill(_ template: String, _ values: [String: String]) -> String {
        var out = ""
        var rest = Substring(template)
        while let open = rest.firstIndex(of: "{") {
            out += rest[..<open]
            let after = rest[rest.index(after: open)...]
            if let close = after.firstIndex(of: "}") {
                let name = String(after[..<close])
                let isName = !name.isEmpty && name.allSatisfy { $0.isLetter || $0.isNumber || $0 == "_" }
                if isName, let value = values[name] {
                    out += value
                } else {
                    out += rest[open...close]
                }
                rest = after[after.index(after: close)...]
            } else {
                out += rest[open...]
                rest = ""
            }
        }
        return out + rest
    }

    // MARK: cards (contract `chat.drafts`)

    /// Design §7.3, read top to bottom: the first that holds is the card's state (`wikiChatDraftState`).
    public static func draftState(_ facts: WikiChatDraftFacts) -> WikiChatDraftState {
        if facts.decision == .applied || facts.decision == .edited { return facts.undone ? .undone : .applied }
        if facts.decision == .discarded { return .discarded }
        if facts.replaced { return .replaced }
        if !facts.chatOpen { return .notApplied }
        if facts.baseMoved { return .changed }
        return .draft
    }

    /// The card's name after `Draft · ` (`wikiChatDraftLabel`).
    public static func draftLabel(_ kind: WikiChatDraftKind, ops: [WikiChatDraftOp] = []) -> String {
        if kind == .rewrite { return WikiChatCopy.cardRewrite }
        if kind == .plan { return WikiChatCopy.cardPlan }
        guard ops.count == 1, let only = ops.first else { return fill(WikiChatCopy.cardChanges, ["n": "\(ops.count)"]) }
        switch only.op {
        case .add:       return fill(WikiChatCopy.cardAddKind, ["kind": only.kind ?? "entry"])
        case .amend:     return WikiChatCopy.cardAmend
        case .supersede: return WikiChatCopy.cardSupersede
        case .retire:    return WikiChatCopy.cardRetire
        case .reinforce: return WikiChatCopy.cardReinforce
        case .challenge: return WikiChatCopy.cardChallenge
        case .unknown:   return fill(WikiChatCopy.cardChanges, ["n": "1"])
        }
    }

    /// The card's status line: `Draft · <label>` while it is open, its state after (`wikiChatCardTitle`).
    public static func cardTitle(_ state: WikiChatDraftState, label: String) -> String {
        switch state {
        case .draft:      return fill(WikiChatCopy.cardDraft, ["label": label])
        case .replaced:   return WikiChatCopy.cardReplaced
        case .changed:    return WikiChatCopy.cardChanged
        case .applied:    return WikiChatCopy.cardApplied
        case .discarded:  return WikiChatCopy.cardDiscarded
        case .notApplied: return WikiChatCopy.cardNotApplied
        case .undone:     return WikiChatCopy.cardUndone
        case .unknown:    return label
        }
    }

    /// The waiting reasons the owner fixes in Wiki settings, beside which a card offers Settings.
    public static let settingsReasons: Set<WikiDocsFollowWaiting> = [.noWorkspace, .runnerMissing]

    /// The buttons a card shows, in the order it shows them (`wikiChatCardActions`).
    public static func cardActions(_ card: WikiChatCard) -> [WikiChatAction] {
        switch card.state {
        case .draft:
            if card.kind == .rewrite { return [.rewrite, .discard] }
            if card.kind == .plan { return [.applyRebuild, .openInPlan, .discard] }
            return [.apply, .edit, .discard]
        case .changed:
            return [.redo, .discard]
        case .applied:
            var actions: [WikiChatAction] = []
            if card.undoable { actions.append(.undo) }
            if card.kind == .entry { actions.append(.openEntry) }
            if let rewrite = card.rewrite {
                if rewrite.result == .waiting, let reason = rewrite.reason, settingsReasons.contains(reason) { actions.append(.settings) }
                if rewrite.result == .failed { actions.append(.tryAgain) }
                if rewrite.result == .updated || rewrite.result == .same { actions.append(.seeChanges) }
            }
            return actions
        default:
            return []
        }
    }

    /// Whether an applied card's rewrite waits on the owner — what it adds to the Wiki's waiting count W (contract
    /// `chat.waiting`, `wikiChatRewriteWaits`): held up until it is not; read the same or failed until seen.
    public static func rewriteWaits(_ card: WikiChatCard) -> Bool {
        guard card.state == .applied, let rewrite = card.rewrite else { return false }
        if rewrite.result == .waiting { return true }
        return (rewrite.result == .same || rewrite.result == .failed) && !rewrite.seen
    }

    /// Whether the round button counts a card as needing the owner: an open draft, or a rewrite that waits.
    public static func cardNeedsYou(_ card: WikiChatCard) -> Bool {
        card.state == .draft || card.state == .changed || rewriteWaits(card)
    }

    /// A space's cards that add to W, one each (`wikiChatWaiting`, contract `space.list.chatWaiting`).
    public static func waiting(_ cards: [WikiChatCard]) -> Int {
        cards.filter(rewriteWaits).count
    }

    // MARK: the round button (contract `chat.fab`)

    /// The three counts over a space's chats (`wikiChatFabCounts`).
    public static func fabCounts(_ chats: [WikiChatFabChat]) -> WikiChatFabCounts {
        var counts = WikiChatFabCounts()
        for chat in chats {
            if chat.open {
                counts.needsYou += chat.approvals
                if chat.turnActive { counts.working = true }
            }
            for card in chat.cards {
                if cardNeedsYou(card) { counts.needsYou += 1 }
                guard card.state == .applied, let rewrite = card.rewrite else { continue }
                if rewrite.result == .rewriting { counts.working = true }
                if rewrite.result == .updated && !rewrite.seen { counts.updated += 1 }
            }
        }
        return counts
    }

    /// The button's look and its hover words (`wikiChatFabState`): needs you, then working, then updated, then idle.
    public static func fabState(_ counts: WikiChatFabCounts) -> (state: WikiChatFabState, label: String) {
        if counts.needsYou > 0 {
            return (.needsYou, counts.needsYou == 1 ? WikiChatCopy.fabNeedsYouOne
                        : fill(WikiChatCopy.fabNeedsYouMany, ["n": "\(counts.needsYou)"]))
        }
        if counts.working { return (.working, WikiChatCopy.fabWorking) }
        if counts.updated > 0 { return (.updated, WikiChatCopy.fabUpdated) }
        return (.idle, WikiChatCopy.fabIdle)
    }

    /// The button as it is drawn (the web's `wikiChatFab`): its look, its words, and the amber number it carries.
    public struct FabLook: Equatable, Sendable {
        public let state: WikiChatFabState
        public let label: String
        /// The amber number: the needs-you count while it needs the owner, else 0 (nothing drawn).
        public let count: Int
    }

    /// From the chats read's counts; none read yet, or a server without chats, is at rest.
    public static func fab(_ counts: WikiChatFabCounts?) -> FabLook {
        let read = counts ?? WikiChatFabCounts()
        let (state, label) = fabState(read)
        return FabLook(state: state, label: label, count: state == .needsYou ? read.needsYou : 0)
    }

    /// The pages of the Wiki that wear the button (design §3): every one but the space's Settings — a share link
    /// is not a page of this app — and only once a space is open, since a chat belongs to one.
    public static func fabShown(settingsOnTop: Bool, hasSpace: Bool) -> Bool {
        hasSpace && !settingsOnTop
    }

    /// Activity's one amber line for W's chat part (`wikiChatWaitingBanner`), nil with nothing waiting.
    public static func waitingBanner(_ n: Int) -> String? {
        guard n > 0 else { return nil }
        return n == 1 ? WikiChatCopy.waitingBannerOne : fill(WikiChatCopy.waitingBannerMany, ["n": "\(n)"])
    }

    // MARK: where, and the line under an applied card (contract `chat.drafts.results`)

    /// "3.1 §3": the document's number and the section's (`wikiChatWhere`).
    public static func place(doc: String, section: String) -> String {
        "\(doc) §\(section)"
    }

    /// "A", "A and B", "A, B and C".
    static func listed(_ items: [String]) -> String {
        guard items.count > 1, let last = items.last else { return items.joined() }
        return items.dropLast().joined(separator: ", ") + " and " + last
    }

    /// The line under an applied card (`wikiChatResultLine`, board 42 ③).
    public static func resultLine(_ rewrite: WikiChatCardRewrite) -> String {
        let place = listed(rewrite.sections.map(\.place))
        switch rewrite.result {
        case .rewriting:
            if let sha = rewrite.sha { return fill(WikiChatCopy.resultRewritingFrom, ["where": place, "sha": String(sha.prefix(7))]) }
            return fill(WikiChatCopy.resultRewriting, ["where": place])
        case .waiting:
            return fill(WikiChatCopy.resultWaiting, ["reason": rewrite.reason.map(WikiChatCopy.waitingReason) ?? ""])
        case .failed:
            return WikiChatCopy.resultFailed
        default:
            let parts = rewrite.sections.map { section -> String in
                switch section.result {
                case .updated?:
                    let n = section.changed ?? 0
                    return n == 1 ? fill(WikiChatCopy.resultSentenceOne, ["where": section.place])
                        : fill(WikiChatCopy.resultSentenceMany, ["where": section.place, "n": "\(n)"])
                case .gone?:
                    return fill(WikiChatCopy.resultGone, ["where": section.place])
                default:
                    return fill(WikiChatCopy.resultSame, ["where": section.place])
                }
            }
            let lead = rewrite.sections.contains { $0.result == .updated } ? [WikiChatCopy.resultUpdatedLead] : []
            return (lead + parts).joined(separator: " · ")
        }
    }

    /// The line that floats over the page once the chat is folded away and a rewrite came out updated (board 42 ⑤,
    /// third phone): `Wiki updated · 3.1 §3`, naming the sections whose sentences changed.
    public static func updatedPill(_ rewrite: WikiChatCardRewrite) -> String? {
        guard rewrite.result == .updated else { return nil }
        let changed = rewrite.sections.filter { $0.result == .updated }.map(\.place)
        guard !changed.isEmpty else { return nil }
        return ([WikiChatCopy.resultUpdatedLead] + changed).joined(separator: " · ")
    }

    // MARK: versions: See changes and the Docs rows (contract `docs.versions`)

    /// "after maintenance", "after <title> merged" … (`wikiDocVersionReason`).
    public static func versionReason(_ reason: WikiDocVersionReason) -> String {
        let template: String
        switch reason.kind {
        case .maintenance: template = WikiChatCopy.reasonMaintenance
        case .build:       template = WikiChatCopy.reasonBuild
        case .merge:       template = WikiChatCopy.reasonMerge
        case .landing:     template = WikiChatCopy.reasonLanding
        case .chat:        template = WikiChatCopy.reasonChat
        case .restore:     template = WikiChatCopy.reasonRestore
        case .unknown:     return ""
        }
        return fill(template, ["title": reason.title ?? "", "version": reason.planVersion.map(String.init) ?? ""])
    }

    /// See changes' heading: the reason with a capital, and the commit when there is one (`wikiDocVersionHeading`).
    public static func versionHeading(_ reason: WikiDocVersionReason) -> String {
        let phrase = versionReason(reason)
        let head = phrase.prefix(1).uppercased() + phrase.dropFirst()
        guard let sha = reason.sha else { return head }
        return "\(head) · \(sha.prefix(7))"
    }

    /// "1 sentence changed", "3 sentences changed", "reads the same" (`wikiDocChanged`).
    public static func changed(_ n: Int) -> String {
        if n == 0 { return WikiChatCopy.changedSame }
        return n == 1 ? WikiChatCopy.changedOne : fill(WikiChatCopy.changedMany, ["n": "\(n)"])
    }

    /// One Docs row of Activity's Recently changed (contract `docs.versions.reads.changes`).
    public enum DocChange: Equatable, Sendable {
        case section(place: String, reason: WikiDocVersionReason, changed: Int)
        case left(Int)
    }

    /// What a Docs row says (`wikiDocChangeLine`).
    public static func changeLine(_ change: DocChange) -> String {
        switch change {
        case .left(let n):
            return n == 1 ? WikiChatCopy.leftOne : fill(WikiChatCopy.leftMany, ["n": "\(n)"])
        case .section(let place, let reason, let n):
            if reason.kind == .restore { return fill(WikiChatCopy.changesRestored, ["where": place, "changed": changed(n)]) }
            return fill(WikiChatCopy.changesRewritten, ["where": place, "reason": versionReason(reason), "changed": changed(n)])
        }
    }

    // MARK: the attachment lines (contract `chat.notes`)

    /// A chat note's attributes, as its block's opening tag carries them.
    public enum Note: Equatable, Sendable {
        case chat
        case pageDoc(doc: String, section: String)
        case pageEntry(title: String)
        case pagePlan(doc: String)
        case selection(doc: String, section: String, toSection: String?, sentences: Int, sources: Int)
        case drafts(applied: Int, edited: Int, discarded: Int, undone: Int)
    }

    /// The four blocks a chat's delivery appends (contract `chat.notes.*.tag`).
    public static let noteTags: [String: String] = [
        "chat": "orbit_wiki_chat", "page": "orbit_wiki_page", "selection": "orbit_wiki_selection", "drafts": "orbit_wiki_drafts",
    ]

    /// What the "Orbit attached:" line names a chat note (`wikiChatNoteLabel`, board 42 ②).
    public static func noteLabel(_ note: Note) -> String {
        func count(_ n: Int, _ one: String, _ many: String) -> String { n == 1 ? one : fill(many, ["n": "\(n)"]) }
        switch note {
        case .chat:
            return WikiChatCopy.noteChat
        case .pageDoc(let doc, let section):
            return fill(WikiChatCopy.notePageDoc, ["where": place(doc: doc, section: section)])
        case .pageEntry(let title):
            return fill(WikiChatCopy.notePageEntry, ["title": title])
        case .pagePlan(let doc):
            return fill(WikiChatCopy.notePagePlan, ["doc": doc])
        case .selection(let doc, let section, let to, let sentences, let sources):
            let at = to.map { $0 != section ? "\(place(doc: doc, section: section))–§\($0)" : place(doc: doc, section: section) }
                ?? place(doc: doc, section: section)
            return fill(WikiChatCopy.noteSelection, [
                "where": at,
                "sentences": count(sentences, WikiChatCopy.noteSentenceOne, WikiChatCopy.noteSentenceMany),
                "sources": count(sources, WikiChatCopy.noteSourceOne, WikiChatCopy.noteSourceMany),
            ])
        case .drafts(let applied, let edited, let discarded, let undone):
            let counts = [(applied, WikiChatCopy.noteApplied), (edited, WikiChatCopy.noteEdited),
                          (discarded, WikiChatCopy.noteDiscarded), (undone, WikiChatCopy.noteUndone)]
                .filter { $0.0 > 0 }
                .map { fill($0.1, ["n": "\($0.0)"]) }
            return fill(WikiChatCopy.noteDrafts, ["counts": counts.joined(separator: ", ")])
        }
    }

    /// A chat note read back from its block's opening tag (`parseWikiChatNoteTag`): nil for any other block, or one
    /// whose tag lacks what its line needs — which a client then names as any block it does not know.
    public static func parseNoteTag(_ block: String) -> Note? {
        let text = block.drop { $0.isWhitespace }
        guard text.first == "<" else { return nil }
        let tag = String(text.dropFirst().prefix { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_") })
        guard tag.hasPrefix("orbit_wiki_"), let close = text.firstIndex(of: ">") else { return nil }
        let head = text[text.index(text.startIndex, offsetBy: 1 + tag.count)..<close]
        guard head.isEmpty || head.first?.isWhitespace == true else { return nil }
        let attributes = noteAttributes(String(head))
        guard let attributes else { return nil }
        func value(_ name: String) -> String? { attributes[name] }
        let doc = value("doc") ?? value("slug")
        let section = value("section") ?? value("key")
        func number(_ name: String) -> Int? {
            guard let raw = value(name), !raw.isEmpty, raw.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
            return Int(raw)
        }
        switch tag {
        case "orbit_wiki_chat":
            return .chat
        case "orbit_wiki_page":
            switch value("of") {
            case "doc":
                guard let doc, let section else { return nil }
                return .pageDoc(doc: doc, section: section)
            case "entry":
                guard let title = value("title") ?? value("entry") else { return nil }
                return .pageEntry(title: title)
            case "plan":
                guard let doc else { return nil }
                return .pagePlan(doc: doc)
            default:
                return nil
            }
        case "orbit_wiki_selection":
            guard let doc, let section, let sentences = number("sentences"), let sources = number("sources") else { return nil }
            let to = value("to").flatMap { $0.isEmpty ? nil : $0 }
            return .selection(doc: doc, section: section, toSection: to, sentences: sentences, sources: sources)
        case "orbit_wiki_drafts":
            return .drafts(applied: number("applied") ?? 0, edited: number("edited") ?? 0,
                           discarded: number("discarded") ?? 0, undone: number("undone") ?? 0)
        default:
            return nil
        }
    }

    /// `name="value"` pairs, each value's `&amp;` `&quot;` `&lt;` `&gt;` read back; nil when the head is not only that.
    private static func noteAttributes(_ head: String) -> [String: String]? {
        var out: [String: String] = [:]
        var rest = Substring(head)
        while true {
            rest = rest.drop { $0.isWhitespace }
            if rest.isEmpty { return out }
            let name = rest.prefix { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }
            guard !name.isEmpty else { return nil }
            rest = rest.dropFirst(name.count)
            guard rest.hasPrefix("=\"") else { return nil }
            rest = rest.dropFirst(2)
            guard let end = rest.firstIndex(of: "\"") else { return nil }
            out[String(name)] = unescape(String(rest[..<end]))
            rest = rest[rest.index(after: end)...]
        }
    }

    private static func unescape(_ value: String) -> String {
        value.replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&amp;", with: "&")
    }

    // MARK: the chats of a space (src/web/src/lib/wikiChat.ts)

    /// Which chat the button opens (`wikiChatToOpen`, contract `chat.list.chats`): the newest holding something that
    /// needs the owner, else the newest still open, else a new one (`newChat`).
    public static func toOpen(_ chats: [WikiChatRow]?) -> String {
        let rows = chats ?? []
        return rows.first { $0.needsYou > 0 }?.sessionId ?? rows.first { $0.open }?.sessionId ?? newChat
    }

    /// Where the panel says a new chat will run (`wikiChatRunsIn`, design §5.1).
    public enum RunsIn: Equatable, Sendable {
        /// No workspace of the space runs its sessions in worktrees: nothing to choose, and no composer (the web's
        /// `none`).
        case noWorktree
        /// Nothing remembered, or the remembered one no longer qualifies; `again` when one was remembered.
        case choose(choices: [WikiChatWorkspace], again: Bool)
        /// The owner's pick here, else the remembered one.
        case chosen(workspace: WikiChatWorkspace, remembered: Bool, choices: [WikiChatWorkspace])
    }

    public static func runsIn(_ list: WikiChatList, picked: String?) -> RunsIn {
        let choices = list.choices
        if let picked, let pick = choices.first(where: { $0.id == picked }) {
            return .chosen(workspace: pick, remembered: pick.id == list.workspace?.id, choices: choices)
        }
        if let remembered = list.workspace, remembered.eligible == true {
            let workspace = WikiChatWorkspace(id: remembered.id, name: remembered.name, runner: remembered.runner,
                                              online: remembered.online)
            return .chosen(workspace: workspace, remembered: true, choices: choices)
        }
        if choices.isEmpty { return .noWorktree }
        return .choose(choices: choices, again: list.workspace != nil)
    }

    /// The line under the panel's title once the chat runs: `orbit-develop · HPC · Claude Opus 5.5 · Default`.
    public static func runLine(_ parts: [String?]) -> String {
        parts.compactMap { part in
            guard let part, !part.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            return part
        }.joined(separator: " · ")
    }

    /// A workspace as Runs in names it: `orbit-develop · HPC`.
    public static func workspaceName(_ workspace: WikiChatWorkspace) -> String {
        runLine([workspace.name, workspace.runner])
    }

    /// The quote chip's counts, in the attachment line's words: `1 sentence · 2 sources` (`wikiChatQuoteCounts`).
    public static func quoteCounts(sentences: Int, sources: Int) -> String {
        func count(_ n: Int, _ one: String, _ many: String) -> String { n == 1 ? one : fill(many, ["n": "\(n)"]) }
        var parts = [count(sentences, WikiChatCopy.noteSentenceOne, WikiChatCopy.noteSentenceMany)]
        if sources > 0 { parts.append(count(sources, WikiChatCopy.noteSourceOne, WikiChatCopy.noteSourceMany)) }
        return parts.joined(separator: " · ")
    }

    // MARK: the composer's attachments (design §4.2)

    /// The page the reader is on, as the composer's page chip names it.
    public enum Page: Equatable, Sendable {
        case doc(docSlug: String, sectionKey: String, label: String)
        case entry(entryId: String, label: String)
        case plan(docSlug: String, label: String)

        public var label: String {
            switch self {
            case .doc(_, _, let label), .entry(_, let label), .plan(_, let label): return label
            }
        }
    }

    /// The sentences an Ask names, as the quote chip shows them and the message sends them.
    public struct Quote: Equatable, Sendable {
        public let docSlug: String
        /// The section the first sentence is in.
        public let sectionKey: String
        public let sentenceIds: [String]
        /// The first sentence's words, which the chip begins with.
        public let first: String
        /// Distinct footnotes across the sentences.
        public let sources: Int
        /// How many sentences were picked; more than `sentenceIds` when the cap cut them.
        public let selected: Int

        public init(docSlug: String, sectionKey: String, sentenceIds: [String], first: String, sources: Int, selected: Int) {
            self.docSlug = docSlug
            self.sectionKey = sectionKey
            self.sentenceIds = sentenceIds
            self.first = first
            self.sources = sources
            self.selected = selected
        }
    }

    /// The composer's attachments: the page, which follows the reader until the message goes, and the quote an Ask
    /// put there. Either can be crossed out; what is not shown is not sent.
    public struct Attachments: Equatable, Sendable {
        public var page: Page?
        public var pageCrossed: Bool
        public var quote: Quote?

        public init(page: Page? = nil, pageCrossed: Bool = false, quote: Quote? = nil) {
            self.page = page
            self.pageCrossed = pageCrossed
            self.quote = quote
        }
    }

    public enum AttachAction: Equatable, Sendable {
        case follow(Page?)
        case crossPage
        case quote(Quote)
        case crossQuote
        case sent
    }

    /// One change to the attachments (`wikiChatAttach`): the reader moved (a crossed-out page stays out until the
    /// message goes), an Ask (its quote replaces any before it), a cross, or the message sent — after which the next
    /// one starts with the page attached again and no quote.
    public static func attach(_ state: Attachments, _ action: AttachAction) -> Attachments {
        var next = state
        switch action {
        case .follow(let page):
            if page != state.page { next.page = page }
        case .crossPage:
            next.pageCrossed = true
        case .quote(let quote):
            next.quote = quote
        case .crossQuote:
            next.quote = nil
        case .sent:
            next = Attachments(page: state.page, pageCrossed: false, quote: nil)
        }
        return next
    }

    /// What the composer shows, which is exactly what the message sends (`wikiChatShown`).
    public static func shown(_ state: Attachments) -> (page: Page?, quote: Quote?) {
        (state.pageCrossed ? nil : state.page, state.quote)
    }

    /// The message's `wikiContext`, frozen from what the composer shows (`wikiChatContext`); nil when it shows neither.
    public static func context(_ state: Attachments) -> WikiChatContext? {
        let (page, quote) = shown(state)
        var context = WikiChatContext()
        switch page {
        case .doc(let slug, let key, _)?: context.page = .doc(docSlug: slug, sectionKey: key)
        case .entry(let id, _)?:          context.page = .entry(entryId: id)
        case .plan(let slug, _)?:         context.page = .plan(docSlug: slug)
        case nil:                         break
        }
        if let quote, !quote.sentenceIds.isEmpty {
            context.selection = WikiChatContext.Selection(docSlug: quote.docSlug, sectionKey: quote.sectionKey,
                                                          sentenceIds: quote.sentenceIds)
        }
        return context.page == nil && context.selection == nil ? nil : context
    }

    // MARK: Ask on a phone: the sentences of one paragraph, tapped (docs/wiki-comment-to-session-design.md §5)

    /// A sentence the Ask sheet lists: its id, its section, its words and its footnotes.
    public struct AskSentence: Equatable, Sendable, Identifiable {
        public let id: String
        public let section: String
        public let text: String
        public let notes: [Int]

        public init(id: String, section: String, text: String, notes: [Int] = []) {
            self.id = id
            self.section = section
            self.text = text
            self.notes = notes
        }
    }

    /// The quote the tapped sentences make, in reading order (`order`) whichever order they were tapped in: a
    /// sentence is picked by tapping it, any of them, at least one; the first `selectionSentencesMax` are taken.
    /// Nil with none picked. A sentence without an id — a server older than the chat — cannot be picked.
    public static func quote(docSlug: String, order: [AskSentence], picked: Set<String>) -> Quote? {
        let run = order.filter { picked.contains($0.id) && !$0.id.isEmpty }
        guard let first = run.first else { return nil }
        let taken = Array(run.prefix(selectionSentencesMax))
        let sources = Set(taken.flatMap(\.notes)).count
        return Quote(docSlug: docSlug, sectionKey: first.section, sentenceIds: taken.map(\.id), first: first.text,
                     sources: sources, selected: run.count)
    }

    // MARK: Updated beside a section (contract `docs.versions.reads.doc`)

    /// Whether a section was written since the reader last looked: its latest change is newer than `seen` (seconds
    /// since 1970) — the stamp the reader's previous visit left, or, on a first visit, when this one began, so a
    /// document read for the first time marks what is rewritten while it is open and not everything before.
    public static func sectionUpdated(_ change: WikiDocSectionChange?, seen: Double) -> Bool {
        guard let change, seen > 0, let at = RelativeTime.parse(change.at) else { return false }
        return at.timeIntervalSince1970 > seen
    }

    /// Where a document's own stamp is kept: when its reader last looked at it.
    public static func seenKey(space slug: String, doc: String) -> String {
        WikiSeenLog.key(space: slug, scope: "doc.\(doc)")
    }

    // MARK: what a card draws (board 42 ② ⑤)

    /// A card's status-line tone: blue while it is open, amber once its base moved, green once applied, grey after.
    public enum Tone: String, Equatable, Sendable {
        case accent, amber, green, grey
    }

    public static func tone(_ state: WikiChatDraftState) -> Tone {
        switch state {
        case .draft:   return .accent
        case .changed: return .amber
        case .applied: return .green
        default:       return .grey
        }
    }

    /// What a card is about: an op's new title, else the entry it names as it stands; a rewrite card's sections; the
    /// card's own label when nothing more is known.
    public static func cardHeadline(_ card: WikiChatDraftView) -> String {
        for op in card.ops {
            if let title = op.payload?["entry"]?["title"]?.stringValue, !title.isEmpty { return title }
            if let title = op.payload?["changes"]?["title"]?.stringValue, !title.isEmpty { return title }
            if let title = op.entry?["title"]?.stringValue, !title.isEmpty { return title }
        }
        if card.kind == .rewrite, !card.sections.isEmpty { return listed(card.sections.map(\.place)) }
        return card.label
    }

    /// One source line of a card (board 42 ②: `✓ Your message in this chat`): the chat's own turn is the owner's
    /// words in it; any other source is its kind and where it points.
    public static func sourceLines(_ card: WikiChatDraftView) -> [String] {
        var lines: [String] = []
        for op in card.ops {
            guard case .array(let sources)? = op.payload?["sources"] else { continue }
            for source in sources {
                let line = sourceLine(source, chat: card.sessionId)
                if !line.isEmpty && !lines.contains(line) { lines.append(line) }
            }
        }
        return lines
    }

    static func sourceLine(_ source: JSONValue, chat: String) -> String {
        let kind = source["kind"]?.stringValue
        let session = source["session"]?.stringValue ?? source["sessionId"]?.stringValue
        if kind == "turn", session == "self" || (session.map { PublicID.storageKey($0) == PublicID.storageKey(chat) } ?? false) {
            return WikiChatCopy.cardYourMessage
        }
        let word = WikiLogic.sourceWord(kind.flatMap(WikiSourceKind.init(rawValue:)))
        let locator = source["locator"]?["path"]?.stringValue ?? source["locator"]?["url"]?.stringValue
            ?? source["path"]?.stringValue ?? source["ref"]?.stringValue.map { String($0.prefix(12)) }
        return [word.isEmpty ? nil : word, locator].compactMap { $0 }.joined(separator: " · ")
    }

    /// A transcript's tool call that drafted a card (contract `chat.drafts.toolResult`): `wiki_propose` or `wiki_draft`,
    /// whichever engine's name for the orbit tool it carries.
    public static func isDraftTool(_ name: String) -> Bool {
        let base = name.split(whereSeparator: { $0 == "." || $0 == "/" }).last.map(String.init) ?? name
        let tool = base.components(separatedBy: "__").last ?? base
        return tool == "wiki_propose" || tool == "wiki_draft"
    }

    /// The card a drafting call's answer names: `{ status: "draft", draftId }` — read off the answer, never off the
    /// conversation's words. Nil for any other answer, a dry run (no id) and a refused call, which draw as any call.
    public static func draftID(toolName: String, result: String?) -> String? {
        guard isDraftTool(toolName), let result else { return nil }
        return draftID(fromJSON: result)
    }

    private static func draftID(fromJSON text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let data = trimmed.data(using: .utf8), let value = try? JSONDecoder().decode(JSONValue.self, from: data) else {
            return nil
        }
        switch value {
        case .object:
            guard value["status"]?.stringValue == "draft", let id = value["draftId"]?.stringValue, !id.isEmpty else { return nil }
            return id
        case .array(let blocks):
            // An MCP answer as its content blocks: the text block holds the JSON.
            for block in blocks {
                if let text = block["text"]?.stringValue, let id = draftID(fromJSON: text) { return id }
            }
            return nil
        default:
            return nil
        }
    }
}
