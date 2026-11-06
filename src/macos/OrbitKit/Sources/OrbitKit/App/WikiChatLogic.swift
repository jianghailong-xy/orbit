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

    /// The card's status line: `Draft · <label>` while it is open, its state after (`wikiChatCardTitle`) — an applied
    /// card still waiting in Review (`appliedInReview`) says so rather than that it is confirmed.
    public static func cardTitle(_ state: WikiChatDraftState, label: String, inReview: Bool = false) -> String {
        switch state {
        case .draft:      return fill(WikiChatCopy.cardDraft, ["label": label])
        case .replaced:   return WikiChatCopy.cardReplaced
        case .changed:    return WikiChatCopy.cardChanged
        case .applied:    return inReview ? WikiChatCopy.cardAppliedInReview : WikiChatCopy.cardApplied
        case .discarded:  return WikiChatCopy.cardDiscarded
        case .notApplied: return WikiChatCopy.cardNotApplied
        case .undone:     return WikiChatCopy.cardUndone
        case .unknown:    return label
        }
    }

    /// Whether an applied card still waits in Review (contract `chat.drafts.states.applied`, `wikiChatAppliedInReview`):
    /// it holds a challenge whose decision is pending. Its press raised the flag on the entry, which the owner answers
    /// in Review — re-confirms, amends or retires the entry — so nothing of it is confirmed yet.
    public static func appliedInReview(_ state: WikiChatDraftState, ops: [WikiChatDraftOp]) -> Bool {
        state == .applied && ops.contains { $0.op == .challenge && $0.decision == "pending" }
    }

    public static func appliedInReview(_ card: WikiChatDraftView) -> Bool {
        appliedInReview(card.state, ops: card.ops.map { WikiChatDraftOp(op: $0.op, decision: $0.decision) })
    }

    /// The challenge an In Review card's note opens in Review (`wikiChatInReviewOp`).
    public static func inReviewOp(_ card: WikiChatDraftView) -> WikiChatDraftOpView? {
        guard appliedInReview(card) else { return nil }
        return card.ops.first { $0.op == .challenge && $0.decision == "pending" }
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

    // MARK: what a card draws (board 42 ② ③ ④ ⑤, `wikiChatCardLook`, `wikiChatCardFace`)

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

    /// How a card looks (design §7.3, `wikiChatCardLook`): its status line, its tone, its note and its buttons.
    public struct CardLook: Equatable, Sendable {
        /// `Draft · Add decision`, `Applied · Confirmed by you`, `Applied · In Review` …
        public let title: String
        public let tone: Tone
        /// A settled card is drawn flat (board 42 ③ ④'s quiet cards).
        public let quiet: Bool
        /// The line under the title a state carries: `A newer draft took over.`, or the In Review note.
        public let note: String?
        /// Applied with a challenge still waiting in Review: its note opens that item.
        public let inReview: Bool
        /// The card's own buttons, in the contract's order.
        public let actions: [WikiChatAction]
        /// The buttons of the line under an applied card: Settings, Try again, See changes.
        public let rewriteActions: [WikiChatAction]
    }

    /// The buttons the line under an applied card carries (board 42 ④'s lower row); the card carries the rest.
    static let rewriteLineActions: Set<WikiChatAction> = [.settings, .tryAgain, .seeChanges]

    public static func cardLook(_ card: WikiChatDraftView) -> CardLook {
        let inReview = appliedInReview(card)
        let all = cardActions(card.card)
        return CardLook(
            title: cardTitle(card.state, label: card.label, inReview: inReview),
            tone: inReview ? .amber : tone(card.state),
            quiet: card.state != .draft && card.state != .changed,
            note: inReview ? WikiChatCopy.cardAppliedInReviewNote
                : card.state == .replaced ? WikiChatCopy.cardReplacedNote : nil,
            inReview: inReview,
            actions: all.filter { !rewriteLineActions.contains($0) },
            rewriteActions: all.filter { rewriteLineActions.contains($0) })
    }

    /// The tone of the line under an applied card (`wikiChatResultLook`).
    public enum ResultTone: String, Equatable, Sendable {
        case run, ok, amber, error, grey
    }

    /// The line under an applied card (design §8.3), its tone, and whether it counts in the Wiki's waiting count.
    public struct ResultLook: Equatable, Sendable {
        public let line: String
        public let tone: ResultTone
        /// It waits on the owner (`rewriteWaits`): held up, or read the same or failed and not seen.
        public let waits: Bool
    }

    public static func resultLook(_ card: WikiChatDraftView) -> ResultLook? {
        guard card.state == .applied, let rewrite = card.rewrite else { return nil }
        let tone: ResultTone
        switch rewrite.result {
        case .rewriting:       tone = .run
        case .waiting, .same:  tone = .amber
        case .updated:         tone = .ok
        case .failed:          tone = .error
        case .gone, .unknown:  tone = .grey
        }
        return ResultLook(line: resultLine(rewrite.card), tone: tone, waits: rewriteWaits(card.card))
    }

    /// The press a settled rewrite the owner has opened makes, once (contract `chat.presses.seen`, `wikiChatNeedsSeen`).
    public static func needsSeen(_ card: WikiChatDraftView) -> Bool {
        guard card.state == .applied, let rewrite = card.rewrite, !rewrite.seen else { return false }
        return rewrite.result == .updated || rewrite.result == .same || rewrite.result == .failed
    }

    /// A card's sentences on its face (board 42 ②, `wikiChatCardFace`): what its op says, and the agent's why.
    public struct CardFace: Equatable, Sendable {
        public struct Row: Equatable, Sendable {
            public let label: String
            public let value: String
        }

        /// One of an amend's lines: what the entry said, struck red, and what it will say, green (board 42 ④ ①).
        public struct DiffLine: Equatable, Sendable {
            public let added: Bool
            public let text: String
        }

        /// The entry's title, or the sections a rewrite card names.
        public let heading: String?
        public let rows: [Row]
        public let diff: [DiffLine]
        public let sources: [String]
    }

    /// The field a kind's card shows first (board 42 ②: a decision's Decision).
    static let faceField: [String: String] = [
        "principle": "statement", "convention": "rule", "decision": "decision",
        "pitfall": "symptom", "recipe": "steps", "concept": "definition",
    ]

    /// A value's words: a string trimmed, or a list's strings joined with ` · `; nil when there are none.
    static func faceText(_ value: JSONValue?) -> String? {
        switch value {
        case .string(let text)?:
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        case .array(let items)?:
            let words = items.compactMap { item -> String? in
                guard case .string(let text) = item, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
                return text
            }
            return words.isEmpty ? nil : words.joined(separator: " · ")
        default:
            return nil
        }
    }

    /// A field's key as its row's label: `statement` → `Statement`, `whyNot` → `Why not`.
    static func faceLabel(_ key: String) -> String {
        guard let first = key.first else { return key }
        var rest = ""
        for character in key.dropFirst() {
            if character.isASCII && character.isUppercase { rest += " " }
            rest.append(character)
        }
        return first.uppercased() + rest.lowercased()
    }

    public static func cardFace(_ card: WikiChatDraftView) -> CardFace {
        var rows: [CardFace.Row] = []
        var diff: [CardFace.DiffLine] = []
        var sources: [String] = []
        var heading: String?
        func titleOf(_ op: WikiChatDraftOpView) -> String? {
            faceText(op.payload?["entry"]?["title"]) ?? faceText(op.payload?["changes"]?["title"]) ?? faceText(op.entry?["title"])
        }
        if card.kind == .rewrite {
            let named = card.rewrites.map { section in section.title.map { "\(section.place) \($0)" } ?? section.place }
            heading = named.isEmpty ? nil : named.joined(separator: " · ")
        } else if card.ops.count == 1, let op = card.ops.first {
            heading = titleOf(op)
            let draft = op.payload?["entry"]
            let face = draft?["kind"]?.stringValue.flatMap { faceField[$0] }
            let first = face.flatMap { faceText(draft?["fields"]?[$0]) }
            if op.op == .add || op.op == .supersede {
                if let face, let first {
                    rows.append(.init(label: faceLabel(face), value: first))
                } else if let summary = faceText(draft?["summary"]) {
                    rows.append(.init(label: WikiChatCopy.faceSummary, value: summary))
                }
            }
            if op.op == .amend {
                for key in ["title", "summary"] {
                    guard let after = faceText(op.payload?["changes"]?[key]) else { continue }
                    if let was = faceText(op.entry?[key]), was != after { diff.append(.init(added: false, text: was)) }
                    diff.append(.init(added: true, text: after))
                }
            }
        } else {
            for op in card.ops { rows.append(.init(label: faceLabel(op.op.rawValue), value: titleOf(op) ?? "—")) }
        }
        if let why = card.rationale?.trimmingCharacters(in: .whitespacesAndNewlines), !why.isEmpty {
            rows.append(.init(label: WikiChatCopy.faceWhy, value: why))
        }
        for op in card.ops {
            guard case .array(let list)? = op.payload?["sources"] else { continue }
            for source in list {
                guard case .object = source else { continue }
                let line = sourceLine(source, chat: card.sessionId)
                if !sources.contains(line) { sources.append(line) }
            }
        }
        return CardFace(heading: heading, rows: rows, diff: diff, sources: sources)
    }

    /// A source as the card's Sources row names it: the chat's own words first-hand, else its kind and where it points
    /// (`src/apiserver/src/runners/runner-presence.ts L30-31 · 99cd3c4`).
    static func sourceLine(_ source: JSONValue, chat: String) -> String {
        let kind = source["kind"]?.stringValue ?? "source"
        if kind == "turn" {
            let session = source["session"]
            let named = session?.stringValue
            if session == nil || named == "self" || named.map({ PublicID.storageKey($0) == PublicID.storageKey(chat) }) == true {
                return WikiChatCopy.cardYourMessage
            }
        }
        let locator = source["locator"]
        let path = locator?["path"]?.stringValue
        var lines = ""
        if let range = locator?["lines"]?.stringValue {
            lines = " L\(range)"
        } else if case .int(let line)? = locator?["line"] {
            lines = " L\(line)"
        } else if case .double(let line)? = locator?["line"] {
            lines = line == line.rounded() ? " L\(Int(line))" : " L\(line)"
        }
        let ref = source["ref"]?.stringValue
        let commit = { (ref: String) in ref.utf8.count == 40 && ref.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) } }
        let shortRef = ref.map { commit($0) ? String($0.prefix(7)) : $0 }
        if let path { return "\(path)\(lines)\(shortRef.map { " · \($0)" } ?? "")" }
        return shortRef.map { "\(kind) \($0)" } ?? kind
    }

    /// `<doc>#<key>` of every section an open card would rewrite, marked on the page beside the chat before the press
    /// (board 42 ②, the web's `wouldRewrite`).
    public static func wouldRewrite(_ cards: [WikiChatDraftView]) -> Set<String> {
        Set(cards.filter { $0.state == .draft }.flatMap { card in card.rewrites.map { sectionID(doc: $0.doc, key: $0.key) } })
    }

    public static func sectionID(doc: String, key: String) -> String { "\(doc)#\(key)" }

    // MARK: a press that did not go (`wikiChatPressError`)

    /// A press refused or lost, said truthfully: the server's reason, a failure of the server, or no connection.
    public static func pressError(_ error: Error) -> String {
        switch error {
        case APIError.http(let status, let body):
            if status >= 500 { return WikiChatCopy.pressServerFailed(status) }
            let reason = ComposerLogic.serverMessage(body)?.trimmingCharacters(in: .whitespacesAndNewlines)
            return WikiChatCopy.pressRefused(reason.flatMap { $0.isEmpty ? nil : $0 } ?? "HTTP \(status)")
        case APIError.unauthorized:
            return WikiChatCopy.pressRefused("HTTP 401")
        default:
            return WikiChatCopy.pressUnsent
        }
    }

    // MARK: Edit (design §7.2, the web's `WikiDraftEditor`)

    /// The two lines an op leaves its entry with, as Edit opens on them: an add's own draft, or an amend's over its entry.
    public struct EditWords: Equatable, Sendable {
        public var title: String
        public var summary: String

        public init(title: String, summary: String) {
            self.title = title
            self.summary = summary
        }
    }

    /// The ops Edit offers: each add, supersede and amend the card holds.
    public static func editable(_ card: WikiChatDraftView) -> [WikiChatDraftOpView] {
        card.ops.filter { $0.op == .add || $0.op == .supersede || $0.op == .amend }
    }

    public static func editWords(_ op: WikiChatDraftOpView) -> EditWords {
        let over = op.payload?["entry"].flatMap { $0 == .null ? nil : $0 } ?? op.payload?["changes"]
        func pick(_ key: String) -> String { over?[key]?.stringValue ?? op.entry?[key]?.stringValue ?? "" }
        return EditWords(title: pick("title"), summary: pick("summary"))
    }

    /// Edit's body: for each op, only what the owner changed, trimmed; an op left as it opened is not sent. Empty
    /// while nothing changed — that would be Apply.
    public static func editOps(_ card: WikiChatDraftView, words: [Int: EditWords]) -> [WikiChatEditRequest.Op] {
        editable(card).compactMap { op in
            let was = editWords(op)
            guard let now = words[op.seq] else { return nil }
            let trim = { (text: String) in text.trimmingCharacters(in: .whitespacesAndNewlines) }
            let title = trim(now.title) != trim(was.title) ? trim(now.title) : nil
            let summary = trim(now.summary) != trim(was.summary) ? trim(now.summary) : nil
            guard title != nil || summary != nil else { return nil }
            return WikiChatEditRequest.Op(seq: op.seq, changes: WikiEntryChanges(title: title, summary: summary))
        }
    }

    // MARK: See changes (design §8.4, board 42 ③, the web's `WikiSeeChanges`)

    /// The versions See changes shows after the one it opens on (comment design §12.2: at most four more).
    public static let earlierShown = 4

    /// What See changes shows for one section.
    public enum SeeChangesRead: Equatable, Sendable {
        /// A write that left the section as it was and kept no version (a card's `same` section): nothing to read.
        case same
        case failed
        case loading
        /// No version of the section is kept, or not the one asked for.
        case none
        case shown(current: WikiDocSectionVersion, earlier: [WikiDocSectionVersion])
    }

    /// `versionID` opens on the write a card's rewrite kept; without one it opens on the newest.
    public static func seeChanges(versions: [WikiDocSectionVersion]?, failed: Bool, versionID: String?,
                                  unchanged: Bool) -> SeeChangesRead {
        if unchanged && versionID == nil { return .same }
        if failed { return .failed }
        guard let versions else { return .loading }
        let at: Int?
        if let versionID { at = versions.firstIndex { $0.id == versionID } } else { at = versions.isEmpty ? nil : 0 }
        guard let at else { return .none }
        return .shown(current: versions[at], earlier: Array(versions[(at + 1)...].prefix(earlierShown)))
    }

    /// The line over one write: why, how many sentences it changed, and when (`After chat … · 1 sentence changed · Nov 6, 10:47`).
    public static func seeChangesCause(_ version: WikiDocSectionVersion, timeZone: TimeZone = .current) -> String {
        [version.reason.map(versionHeading), changed(version.changed), WikiDocCopy.monthDayTime(version.at, timeZone: timeZone)]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// The sections See changes opens for a card's rewrite: each it wrote, or read the same.
    public static func seeChangesSections(_ rewrite: WikiChatDraftRewrite) -> [WikiChatDraftRewrite.Section] {
        rewrite.sections.filter { $0.result == .updated || $0.result == .same }
    }

    /// The rows a write changed — removed, then added, in the comparison's order — the ones it kept left out.
    public static func changedRows(_ rows: [WikiDocSentenceRow]) -> [WikiDocSentenceRow] {
        rows.filter { $0.op != .same }
    }

    // MARK: a chat that takes no more messages (C8 review)

    /// The composer's line once its chat takes no more messages, nil while it takes them: in Trash, or no longer live
    /// (queued, running, waiting for input or interrupted) and not about to be retried by the server.
    public static func endedLine(trashed: Bool, status: RunStatus, retryPending: Bool) -> String? {
        if trashed { return WikiChatCopy.trashed }
        let live = status.isLive || status == .pending
        return live || retryPending ? nil : WikiChatCopy.ended
    }

    // MARK: the card a drafting call names (contract `chat.drafts.toolResult`, `wikiChatDraftIdOf`)

    /// The tools a chat drafts with (contract `agentSurface.chat`): each answers with the card it made.
    static let draftingTools: Set<String> = ["wiki_propose", "wiki_draft", "wiki_note"]

    /// Whether a tool call is one of a chat's drafting calls (`wikiChatDraftingCall`): by the name any engine reports an
    /// Orbit MCP tool under (`mcp__orbit__wiki_draft`), or the CLI door the same tools have (`orbit wiki draft …` in a
    /// shell, read off the call's command).
    public static func isDraftingCall(_ name: String, command: String? = nil) -> Bool {
        if let tool = firstMatch(#"^mcp__[^_].*?__(wiki_\w+)$"#, in: name) { return draftingTools.contains(tool) }
        guard let command else { return false }
        return firstMatch(#"(?:^|[\s;&|(])orbit\s+wiki\s+(propose|draft|note)\b"#, in: command) != nil
    }

    /// The card a drafting call made: its answer's `draftId` — the structured answer an engine passes through, or the
    /// JSON text Claude Code records it as — else the id the runner's own sentence names ("Drafted card <id>", which
    /// Orbit writes for an engine that hands the agent text alone). A dry run, a refused request and any other answer
    /// name none, and the call draws as any call. Either spelling of the id names the card: the public one comes back.
    public static func draftID(toolName: String, command: String? = nil, result: String?) -> String? {
        guard isDraftingCall(toolName, command: command), let result else { return nil }
        let trimmed = result.trimmingCharacters(in: .whitespacesAndNewlines)
        // The answer as the transcript holds it: JSON text (an object, or an MCP answer's content blocks), else words.
        if trimmed.hasPrefix("{") || trimmed.hasPrefix("["),
           let value = try? JSONDecoder().decode(JSONValue.self, from: Data(trimmed.utf8)),
           let id = draftID(in: value, depth: 0) {
            return PublicID.toPublic(id)
        }
        let said = #"\b(?:Drafted card|already made card|the flag is card)\s+([0-9A-Za-z]{10,40}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b"#
        return firstMatch(said, in: result).map(PublicID.toPublic)
    }

    /// The id a drafting call's answer names, read from the answer's own fields wherever an engine put them.
    private static func draftID(in value: JSONValue, depth: Int) -> String? {
        guard depth <= 5 else { return nil }
        switch value {
        case .string(let text):
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard trimmed.hasPrefix("{"), let parsed = try? JSONDecoder().decode(JSONValue.self, from: Data(trimmed.utf8)) else {
                return nil
            }
            return draftID(in: parsed, depth: depth + 1)
        case .array(let items):
            for item in items {
                if let id = draftID(in: item, depth: depth + 1) { return id }
            }
            return nil
        case .object:
            if value["status"]?.stringValue == "draft", let id = value["draftId"]?.stringValue, !id.isEmpty { return id }
            for key in ["structuredContent", "challenged", "result", "output", "content", "text"] {
                if let inner = value[key], let id = draftID(in: inner, depth: depth + 1) { return id }
            }
            return nil
        default:
            return nil
        }
    }

    /// The first capture group of a pattern's first match, or nil.
    private static func firstMatch(_ pattern: String, in text: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              match.numberOfRanges > 1, let range = Range(match.range(at: 1), in: text) else { return nil }
        return String(text[range])
    }
}
