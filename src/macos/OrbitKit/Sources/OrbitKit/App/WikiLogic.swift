import Foundation

// The Wiki's words and its derivations, for the native pages — the Swift half of the web's
// `src/web/src/lib/wiki.ts`.
//
// ONE PLACE FOR THE WORDS, because the design's rule is that a word means one thing everywhere
// (`docs/wiki-design.md` §12.1): `Changed` is the anchor's word and never a change's, `Amend` covers an
// amend and a supersede, `Superseded` is a decision's normal ending rather than a failure. Every
// sentence here is a public constant, not a literal inside a view, because `WikiCopyParityTests`
// looks each one up in the web source it was ported from: the two clients share no compiler, so a
// sentence reworded at one end would otherwise simply never appear at the other.
//
// Pure, with no SwiftUI, so it is tested on Linux like the rest of this directory.

/// Every sentence the Wiki pages say. The web's constant each one mirrors is named beside it.
public enum WikiCopy {
    public static let title = "Wiki"                                    // WIKI_TITLE
    public static let searchPlaceholder = "Search the wiki"              // WIKI_SEARCH_PLACEHOLDER
    public static let reviewTitle = "Review"                             // WIKI_REVIEW_TITLE

    /// The proposals waiting in Review: Activity's first banner (`wikiProposalsToReview`).
    public static func proposalsToReview(_ count: Int) -> String {
        "\(count) proposal\(count == 1 ? "" : "s") to review"
    }
    /// The same count under Review's own title (`wikiProposalsFrom`).
    public static func proposalsFrom(_ count: Int, sessions: Int) -> String {
        "\(count) proposal\(count == 1 ? "" : "s") from \(sessions) session\(sessions == 1 ? "" : "s")"
    }
    public static func oldest(_ when: String) -> String { "oldest \(when)" }             // wikiOldest

    /// The Activity page and the number waiting on the owner (design §12.3.2–§12.3.4, §12.3.7). The
    /// number is every space's proposals and the things each plan waits on the owner for
    /// (`WikiSpaceLogic.waiting`); the drawer's Wiki row and the bar's Activity badge show it, and say it
    /// the way the Projects row says its own.
    public static let activity = "Activity"                                             // WIKI_ACTIVITY
    public static func waitingOnYou(_ count: Int) -> String { "\(count) waiting on you" }   // wikiWaitingOnYou
    /// Beside Recently changed: how many of its rows came after the reader last looked.
    public static func newSinceLastLooked(_ count: Int) -> String {                     // wikiNewSinceLastLooked
        "\(count) new since you last looked"
    }
    /// The share of Activity's first banner that is another space's: `3 proposals to review · 2 in wikova`.
    public static func countInSpace(_ count: Int, _ space: String) -> String { "· \(count) in \(space)" }   // wikiCountInSpace
    /// After another space's plan banner, which space it is: `Plan draft ready to confirm · in wikova`.
    public static func inSpace(_ space: String) -> String { "· in \(space)" }           // wikiInSpace
    /// After a space's name in the picker, what waits on the owner in it: `wikova · 2 waiting`.
    public static func spaceWaiting(_ count: Int) -> String { "· \(count) waiting" }    // wikiSpaceWaiting
    /// The native picker's words (design §12.3.4, mock 31 ④): the way into Wiki settings under the spaces,
    /// and each space's documents under its repository.
    public static let manageSpaces = "Manage spaces"                                    // WIKI_MANAGE_SPACES
    public static func documentCount(_ count: Int) -> String {                          // wikiDocumentCount
        "\(WikiArticleCopy.count(count)) \(count == 1 ? "document" : "documents")"
    }
    public static let noDocuments = "No documents yet"                                  // WIKI_NO_DOCUMENTS

    // The home's one band with a heading, and Activity's three.
    public static let principles = "Principles"                         // WIKI_PRINCIPLES
    /// After the home's first three principles, the way to all of them: `All 6 ›` (`wikiAllPrinciples`).
    public static func allPrinciples(_ count: Int) -> String { "All \(count) ›" }
    public static let recentDecisions = "Recent decisions"              // WIKI_RECENT_DECISIONS
    public static let recentlyChanged = "Recently changed"              // WIKI_RECENTLY_CHANGED
    public static let agentsUsed = "Agents used the wiki"               // WIKI_AGENTS_USED
    public static let agentsUsedHint = "this week"                      // WIKI_AGENTS_USED_HINT

    /// The status line under the title: what the space holds, and how fresh its anchors are.
    public static func entryNoun(_ count: Int) -> String { count == 1 ? "entry" : "entries" }
    public static func anchorsVerified(ref: String, ago: String) -> String {   // wikiAnchorsVerified
        ago.isEmpty ? "Anchors verified at \(ref)" : "Anchors verified at \(ref) \(ago)"
    }

    public static let noSpaces = "No wiki space yet. A space is a codebase, and the first one is made when a session proposes into it."
    /// What the Wiki section says to an account the server has not switched the wiki on for.
    public static let disabledNote = "The wiki is not switched on for this account."   // WIKI_DISABLED_NOTE
    public static let spacePickerHint = "The codebase this wiki describes"   // WIKI_SPACE_PICKER_HINT

    /// The two numbers of the usage block.
    public static let sessionsReceived = "sessions received wiki context"   // WIKI_SESSIONS_RECEIVED
    public static let searches = "searches"                                 // WIKI_SEARCHES

    public static let noLongerPushed = "no longer sent to agents"           // WIKI_NO_LONGER_PUSHED

    /// The entry page's sections, in the order both clients draw them.
    public static let details = "Details"                                   // WIKI_SECTION_DETAILS
    public static let sources = "Sources"                                   // WIKI_SECTION_SOURCES
    public static let anchors = "Anchors"                                   // WIKI_SECTION_ANCHORS
    public static let whereUsed = "Where it's used"                         // WIKI_SECTION_USED
    public static let history = "History"                                   // WIKI_SECTION_HISTORY
    public static let anchorsNote = "Checked again after every commit to main. If the anchored code changes, agents stop getting this entry until someone re-checks it."
    public static func pushedTo(sessions: Int, fetched: Int) -> String {    // wikiPushedTo
        "Pushed to \(sessions) session\(sessions == 1 ? "" : "s") this week · fetched \(fetched)×"
    }
    public static let noUseYet = "No session has been shown this entry yet."   // WIKI_NO_USE_YET

    /// The entry page's actions. Retire is the one that takes an entry away from agents.
    public static let edit = "Edit"                                         // WIKI_ACTION_EDIT
    public static let supersede = "Supersede…"                              // WIKI_ACTION_SUPERSEDE
    public static let retire = "Retire…"                                    // WIKI_ACTION_RETIRE
    public static let copyLink = "Copy link"                                // WIKI_ACTION_COPY_LINK
    public static let linkCopied = "Copied"                                 // WIKI_LINK_COPIED

    /// The entry page's header chips beside the trust and the anchor.
    public static let pinned = "Pinned"

    /// The three forms the entry page's actions open (`EntryEditor`), and what each says when done.
    public static let editNote = "Only the title and the one-line summary change here."
    public static let supersedeNote = "The replacement keeps this entry’s kind, fields and anchor, and this entry points at it."
    public static let retireNote = "Agents stop getting this entry. It stays in History, struck through, and the reason goes on the record."
    public static let titlePlaceholder = "Title"
    public static let summaryPlaceholder = "One line"
    public static let reasonPlaceholder = "Why it no longer holds"
    public static let save = "Save"
    public static let supersedeConfirm = "Supersede"
    public static let retireConfirm = "Retire"
    public static let saved = "Saved"
    /// The space's settings, once written (`WIKI_SETTINGS_SAVED`).
    public static let settingsSaved = "Wiki settings saved"
    public static let superseded = "Superseded"
    public static let retired = "Retired"
    /// Failed writes name the action; the server's reason stays on the line below.
    public static let entrySaveFailed = "Couldn't save the entry"
    public static let entrySupersedeFailed = "Couldn't supersede the entry"
    public static let entryRetireFailed = "Couldn't retire the entry"
    public static let entryConfirmFailed = "Couldn't confirm the entry"
    public static let entryRejectFailed = "Couldn't reject the entry"
    public static let settingsSaveFailed = "Couldn't save the wiki settings"
    public static let runRevertFailed = "Couldn't revert the run"
    public static let planDraftFailed = "Couldn't draft the plan"
    public static let planRedraftFailed = "Couldn't redraft the plan"
    public static let planConfirmFailed = "Couldn't confirm the plan"
    public static let changeAcceptFailed = "Couldn't accept the change"
    public static let changeEditFailed = "Couldn't edit the change"
    public static let changeRejectFailed = "Couldn't reject the change"
    /// The rationale an owner's write is recorded with, in the web's words.
    public static func editedRationale(_ title: String) -> String { "the owner edited “\(title)”" }
    public static func replacedRationale(_ title: String) -> String { "the owner replaced “\(title)”" }
    public static func retiredRationale(_ title: String) -> String { "the owner retired “\(title)”" }

    /// The entry page's empty sections.
    public static let noSources = "A quote is what makes a claim checkable. This entry cites none."
    public static let noAnchors = "No anchor: nothing in the repository has to stay true for this to hold."
    public static let noHistory = "No revision has been recorded."
    /// A row of Where it's used: how the session was shown the entry.
    public static let pushedAtStart = "in its Wiki context at start"
    public static let pushedBadge = "Pushed"
    public static let fetchedBadge = "Fetched"

    /// A source's quote, checked or not.
    public static let quoteVerified = "quote verified ✓"                    // WIKI_QUOTE_VERIFIED
    public static let quoteUnverified = "quote not checked"                 // WIKI_QUOTE_UNVERIFIED

    /// The history feed's words, by who wrote the revision.
    public static let historyProposedBy = "Proposed by a session"           // WIKI_HISTORY_PROPOSED_BY
    public static let historyConfirmedBy = "Confirmed by you"               // WIKI_HISTORY_CONFIRMED_BY
    public static let historyMaintenance = "Wiki maintenance"               // WIKI_HISTORY_MAINTENANCE
    public static let historySystem = "Recorded by the server"              // WIKI_HISTORY_SYSTEM
    public static func revision(_ number: Int) -> String { "r\(number)" }   // wikiRevision
    public static func compareWith(_ number: Int) -> String { "Compare with r\(number)" }   // wikiCompareWith

    // Review.
    public static let proposedBy = "Proposed by"
    /// What a card says when it knows neither the kind nor the title yet (`WIKI_ENTRY_WORD`).
    public static let entryWord = "entry"
    public static let reasonLabel = "Reason"
    public static let evidenceLabel = "Evidence"
    public static let afterLabel = "After"
    /// What the toast says once a Review answer lands (`WIKI_DECIDED_*`, see `WikiLogic.decidedToast`):
    /// the outcome in the words of the answer and the card it was given on, with the entry's title on
    /// the line under it. A bare "Decided" said neither what was decided nor about what.
    public static let decidedAccepted = "Accepted"                          // WIKI_DECIDED_ACCEPTED
    public static let decidedEdited = "Accepted with your edits"            // WIKI_DECIDED_EDITED
    public static let rejected = "Rejected"                                 // WIKI_DECIDED_REJECTED
    public static let decidedKept = "Kept"                                  // WIKI_DECIDED_KEPT
    public static let decidedReconfirmed = "Re-confirmed"                   // WIKI_DECIDED_RECONFIRMED
    public static let decidedAmended = "Amended"                            // WIKI_DECIDED_AMENDED
    /// A Review answer the server refused: what failed, with its reason under it.
    public static let decideFailed = "Couldn't record your answer"          // WIKI_DECIDE_FAILED
    public static let accept = "Accept"                                     // WIKI_REVIEW_ACCEPT
    public static let reviewEdit = "Edit"                                   // WIKI_REVIEW_EDIT
    public static let reject = "Reject"                                     // WIKI_REVIEW_REJECT
    public static let keep = "Keep"                                         // WIKI_REVIEW_KEEP
    public static let reviewRetire = "Retire"                               // WIKI_REVIEW_RETIRE
    public static let acceptNote = "Accepting makes it Confirmed"           // WIKI_ACCEPT_NOTE
    public static let webDerivedNote = "Web-derived is never auto-accepted" // WIKI_WEB_DERIVED_NOTE
    public static let rejectReasonFoot = "The reason goes back to the session that proposed it."
    public static let similarNone = "None"                                  // WIKI_SIMILAR_NONE
    public static let similarEntries = "Similar entries"                    // WIKI_SIMILAR_ENTRIES
    public static let afterRetire = "Agents stop getting this entry. It stays in History, struck through, and points to the entry that replaced it."
    public static let webDerived = "Web-derived"                            // WIKI_WEB_DERIVED
    public static let webDerivedWarning = "this session read web pages before proposing. Accepting shows it to agents."
    public static let autoAccept = "Auto-accept"                            // WIKI_AUTO_ACCEPT
    public static let autoAcceptHint = "These apply without asking you, and still show in Recently changed."
    public static let reinforce = "Reinforce"                               // WIKI_REINFORCE
    public static let reinforceNote = "Adds a source to an existing entry"  // WIKI_REINFORCE_NOTE
    public static let challenge = "Challenge"                               // WIKI_CHALLENGE
    public static let challengeNote = "Flags an entry for re-check; changes nothing"
    public static let alwaysAsks = "Always asks you"                        // WIKI_ALWAYS_ASKS
    public static let alwaysAsksNote = "Add, Amend and Retire, and anything a session proposed after reading the web."

    /// The phone's card pager: one card at a time, with its position and two plain buttons.
    public static let previous = "Previous"                                 // WIKI_PREVIOUS
    public static let next = "Next"                                         // WIKI_NEXT
    public static func ofCount(_ at: Int, _ total: Int) -> String { "\(at) of \(total)" }   // wikiOfCount

    /// Review's tabs. `Amend` covers an amend and a supersede; `Change` stays the anchor's word.
    public static let tabAll = "All"                                        // WIKI_TAB_ALL
    public static let tabAdd = "Add"                                        // WIKI_TAB_ADD
    public static let tabAmend = "Amend"                                    // WIKI_TAB_AMEND
    public static let tabRetire = "Retire"                                  // WIKI_TAB_RETIRE

    /// Empty states. The home's principles have none: with no principle the band is not drawn at all.
    public static let noReview = "Nothing is waiting for you."                     // WIKI_NO_REVIEW
    public static let noChanges = "Nothing has changed yet."                       // WIKI_NO_CHANGES
    public static let noDecisions = "No decision has been recorded yet."           // WIKI_NO_DECISIONS
    public static let noAgentsYet = "No session has used this wiki yet."           // WIKI_NO_AGENTS_YET
    public static let noEntrySelected = "That entry is no longer in this space."   // WIKI_NO_ENTRY_SELECTED

    /// A trust's word (`WIKI_TRUST_LABELS`).
    public static func trustLabel(_ trust: WikiTrust) -> String {
        switch trust {
        case .owner:      return "Owner"
        case .confirmed:  return "Confirmed"
        case .auto:       return "Auto"
        case .unreviewed: return "Unreviewed"
        case .proposed:   return "Proposed"
        case .external:   return "Web-derived"
        case .unknown:    return ""
        }
    }

    /// A kind's own word (`WIKI_KIND_LABELS`). Empty for a kind this build does not know, which the
    /// callers leave out rather than print a word the server never said.
    public static func kindLabel(_ kind: WikiEntryKind) -> String {
        switch kind {
        case .principle:  return "Principle"
        case .convention: return "Convention"
        case .decision:   return "Decision"
        case .pitfall:    return "Pitfall"
        case .recipe:     return "Recipe"
        case .concept:    return "Concept"
        case .assumption: return "Assumption"
        case .unknown:    return ""
        }
    }

    /// The op words Review's chips are built from (`WIKI_OP_LABELS`).
    public static func opLabel(_ op: WikiOpKind) -> String {
        switch op {
        case .add:       return "ADD"
        case .amend:     return "AMEND"
        case .supersede: return "SUPERSEDE"
        case .retire:    return "RETIRE"
        case .reinforce: return "REINFORCE"
        case .challenge: return "CHALLENGE"
        case .unknown:   return ""
        }
    }

    /// A status word, where an entry's own status is the thing being said (`WIKI_STATUS_LABELS`).
    public static func statusLabel(_ status: WikiEntryStatus) -> String {
        switch status {
        case .active:     return "Active"
        case .proposed:   return "Proposed"
        case .superseded: return "Superseded"
        case .retired:    return "Retired"
        case .rejected:   return "Rejected"
        case .unknown:    return ""
        }
    }

    /// The four rejection reasons' words, in the order Review's menu lists them
    /// (`WIKI_REJECT_REASON_LABELS`, in `@orbit/shared`).
    public static func rejectReasonLabel(_ reason: WikiRejectReason) -> String {
        switch reason {
        case .notTrue:     return "Not true"
        case .notUseful:   return "Not useful"
        case .duplicate:   return "Duplicate"
        case .tooSpecific: return "Too specific"
        }
    }
}

// MARK: - marks

/// The tones the Wiki's marks are drawn in (`WikiTone`). What each is as a colour is the view's.
public enum WikiTone: String, Equatable, Sendable {
    case owner, blue, muted, green, amber, red
}

/// An anchor's state as the lists say it: the word, and the tone it carries (`WikiAnchorMark`).
public struct WikiAnchorMark: Equatable, Sendable {
    public let word: String
    public let tone: WikiTone

    public init(word: String, tone: WikiTone) {
        self.word = word
        self.tone = tone
    }
}

/// One labelled row of an entry's Details: a sentence, or the lines of a list (`WikiFieldRow`).
public struct WikiFieldRow: Equatable, Sendable {
    public let label: String
    public let lines: [String]

    public init(label: String, lines: [String]) {
        self.label = label
        self.lines = lines
    }
}

/// One field's before-and-after in a pending amendment: every old line removed, every new one added.
public struct WikiDiffHunk: Equatable, Sendable {
    public struct Line: Equatable, Sendable {
        public enum Sign: String, Sendable { case removed = "-", added = "+" }
        public let sign: Sign
        public let text: String

        public init(sign: Sign, text: String) {
            self.sign = sign
            self.text = text
        }
    }

    public let label: String
    public let lines: [Line]

    public init(label: String, lines: [Line]) {
        self.label = label
        self.lines = lines
    }
}

// MARK: - derivations

public enum WikiLogic {
    // MARK: the home page's bands

    /// The home's bands under its head (the title and the space), top to bottom (design §12.3.1, mocks 30 ③,
    /// 31 ① ③): the line that says what the space holds, the search, the principles — only when there are
    /// any — the documents by category, then Browse by category · A–Z index. The web phone's order:
    /// `WikiPage.tsx`'s head, `WikiHome.tsx` and the phone rules in index.css, which `WikiCopyParityTests`
    /// holds to this, and the order `WikiHomePage` lays its sections out in. Nothing here says how the wiki is
    /// kept: that is Activity's (`ActivityBand`).
    public enum HomeBand: String, CaseIterable, Sendable {
        case state, search, principles, documents, more

        /// The band's heading, for the one that has one.
        public var title: String? { self == .principles ? WikiCopy.principles : nil }
    }

    /// How many principles the home reads: the most one read answers, far above any space's own rules
    /// (`PRINCIPLES_READ`).
    public static let principlesRead = 200
    /// The principles the home lists before `All N ›` (`PRINCIPLES_SHOWN`, mock 31 ③).
    public static let principlesShown = 3

    /// The home's principles, from their own read (`?kind=principle`): every one, of any status, oldest
    /// recorded first — the owner's rules do not reshuffle as the space fills up, and a new one appends to the
    /// bottom; its blue dot says it is new. Never picked out of the newest 200 entries of every kind: a space
    /// holds thousands, and its principles are among the oldest of them.
    public static func principles(_ entries: [WikiEntry]) -> [WikiEntry] {
        entries.filter { $0.kind == .principle }.enumerated().sorted { a, b in
            let at = RelativeTime.parse(a.element.recordedAt ?? "") ?? .distantPast
            let bt = RelativeTime.parse(b.element.recordedAt ?? "") ?? .distantPast
            return at != bt ? at < bt : a.offset < b.offset
        }.map(\.element)
    }

    /// A principle's day at the end of its row: `9/6`, in the reader's zone (`wikiShortDay`).
    public static func shortDay(_ iso: String?, timeZone: TimeZone = .current) -> String? {
        guard let iso, let date = RelativeTime.parse(iso) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.month, .day], from: date)
        guard let month = parts.month, let day = parts.day else { return nil }
        return "\(month)/\(day)"
    }

    /// What the home's documents band draws (`WikiHome.tsx`'s branches; design §12.3.1).
    public enum HomeDocuments: Equatable, Sendable {
        /// The first read is out: grey bars in the rows' shape (mock 31 ⑦).
        case loading
        /// The confirmed plan's documents, a category a group (mock 30 ③).
        case categories([WikiDocLogic.HomeCategory])
        /// Before a plan is confirmed: the topic articles, as the directory groups them, a title a row.
        case topics([WikiArticleLogic.DirectoryGroup])
        /// Neither, and maintenance not set up: the one card that says how a space comes to have documents
        /// (mock 31 ⑥).
        case newSpace
        /// Neither, with maintenance set up: nothing, the line under the head saying `No documents yet`.
        case nothing

        /// Whether the home ends on Browse by category · A–Z index: once its first read is in, with
        /// something listed.
        public var listed: Bool {
            switch self {
            case .categories, .topics: return true
            case .loading, .newSpace, .nothing: return false
            }
        }
    }

    /// The home's documents: the confirmed plan's, by category; before one, the topic articles; else a new
    /// space's card, or nothing once maintenance is set up. `loading` is the first read alone — a read the
    /// page already has stays drawn while it is read again.
    public static func homeDocuments(docs: WikiDocsDirectory?, articles: WikiArticleDirectory?, loading: Bool,
                                     maintenance: Bool, seen: Double?) -> HomeDocuments {
        if loading { return .loading }
        if let docs, WikiDocLogic.readsByDocs(docs) { return .categories(WikiDocLogic.homeCategories(docs, seen: seen)) }
        let groups = articles.map(WikiArticleLogic.directoryGroups) ?? []
        if groups.contains(where: { !$0.topics.isEmpty }) { return .topics(groups) }
        return maintenance ? .nothing : .newSpace
    }

    /// The line under the home's head (`WikiHomeState`): what `WikiDocLogic.homeLine` says of the reads the
    /// documents band lists — the topics before a plan — or nil, a grey bar, while the first read is out.
    public static func homeLine(docs: WikiDocsDirectory?, articles: WikiArticleDirectory?, loading: Bool) -> String? {
        guard !loading else { return nil }
        let topics = (articles.map(WikiArticleLogic.directoryGroups) ?? []).reduce(0) { $0 + $1.topics.count }
        return WikiDocLogic.homeLine(WikiDocLogic.readsByDocs(docs) ? docs : nil, articles: topics)
    }

    /// Activity's blocks, top to bottom (design §12.3.2, mock 31 ②) — the home's management blocks, moved
    /// in their order, as the web's `WikiActivityPage.tsx` draws them: the status line, the proposals'
    /// banner, the space's plan banners, then the other spaces' plan banners that wait on the owner,
    /// Recent decisions, Recently changed and Agents used the wiki. `WikiActivityPage` lays its sections out
    /// in this order and `WikiCopyParityTests` holds the web page to it.
    public enum ActivityBand: String, CaseIterable, Sendable {
        case status, reviewBanner, planBanners, otherPlanBanners, recentDecisions, recentlyChanged, agentsUsed

        /// The band's heading, for the three that have one.
        public var title: String? {
            switch self {
            case .status, .reviewBanner, .planBanners, .otherPlanBanners: return nil
            case .recentDecisions: return WikiCopy.recentDecisions
            case .recentlyChanged: return WikiCopy.recentlyChanged
            case .agentsUsed:      return WikiCopy.agentsUsed
            }
        }
    }

    /// The entry page's sections, in the order both clients draw them (`WikiEntryDrawer.tsx`), and
    /// the order `WikiView` lays them out in.
    public enum EntrySection: String, CaseIterable, Sendable {
        case details, sources, anchors, whereUsed, history

        public var title: String {
            switch self {
            case .details:   return WikiCopy.details
            case .sources:   return WikiCopy.sources
            case .anchors:   return WikiCopy.anchors
            case .whereUsed: return WikiCopy.whereUsed
            case .history:   return WikiCopy.history
            }
        }
    }

    public static var entrySections: [String] { EntrySection.allCases.map(\.title) }

    // MARK: whether the account has the wiki

    /// The refusal every wiki route answers an account the server has not switched the wiki on for —
    /// the apiserver's ORBIT_WIKI (`WIKI_DISABLED`).
    public static let disabledCode = "WIKI_DISABLED"

    /// Whether an error is that answer: a 404 carrying WIKI_DISABLED, which says the wiki is off, not
    /// that a read failed (`isWikiDisabled`).
    public static func isDisabled(_ error: Error) -> Bool {
        guard case APIError.http(let status, _) = error, status == 404 else { return false }
        return APIClient.refusalCode(error) == disabledCode
    }

    /// Whether the wiki's entry points are drawn — the drawer's Wiki row, which is the iPad sidebar's
    /// too (`wikiShown`): once the spaces read has answered anything but WIKI_DISABLED, and when it
    /// failed for any other reason, since a read that failed is not the server saying there is no wiki.
    /// Not while it is on its way, so an account the wiki is off for is never offered a row to press.
    public static func shown(_ spaces: ListLoadState, disabled: Bool) -> Bool {
        spaces.hasLoaded ? !disabled : spaces.lastLoadFailed
    }

    // MARK: marks

    /// A 40-character sha as its short form; any other ref as it is.
    public static func shortSha(_ ref: String) -> String {
        let hex = ref.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
        return ref.count == 40 && hex ? String(ref.prefix(7)) : ref
    }

    /// What the anchor column says for one entry (`wikiAnchorMark`): the ref a verified anchor was
    /// checked at (`4db4f9f`), or the warning word. Nil for an entry nothing has re-checked yet —
    /// that has not "changed", and dressing it up as a warning would put every new entry in amber.
    public static func anchorMark(state: WikiAnchorState?, checkedRef: String?) -> WikiAnchorMark? {
        switch state {
        case .verified?:
            return WikiAnchorMark(word: checkedRef.map(shortSha) ?? "Checked", tone: .green)
        case .changed?:
            return WikiAnchorMark(word: "Changed", tone: .amber)
        case .missing?:
            return WikiAnchorMark(word: "Missing", tone: .red)
        default:
            return nil
        }
    }

    /// One anchor's own state, in the same words (`wikiAnchorStateOf`). Never nil: an anchor row
    /// always says something, and a new one says `Unchecked`.
    public static func anchorStateMark(_ anchor: WikiAnchor) -> WikiAnchorMark {
        switch anchor.check?.state {
        case .verified?: return WikiAnchorMark(word: anchor.check?.ref.map(shortSha) ?? "Checked", tone: .green)
        case .changed?:  return WikiAnchorMark(word: "Changed", tone: .amber)
        case .missing?:  return WikiAnchorMark(word: "Missing", tone: .red)
        default:         return WikiAnchorMark(word: "Unchecked", tone: .muted)
        }
    }

    /// One anchor's own line (`wikiAnchorLabel`): the path, with its symbol when it has one, or the
    /// commit it names, or the command, or the record.
    public static func anchorLabel(_ anchor: WikiAnchor) -> String {
        if let path = anchor.path {
            return anchor.symbol.map { "\(path) · \($0)" } ?? path
        }
        if let sha = anchor.sha { return shortSha(sha) }
        if let command = anchor.command { return command }
        if let ref = anchor.ref { return ref }
        return "—"
    }

    /// A trust's tone (`WIKI_TRUST_TONE`).
    public static func trustTone(_ trust: WikiTrust) -> WikiTone {
        switch trust {
        case .owner:      return .owner
        case .confirmed:  return .blue
        case .auto:       return .green
        case .unreviewed: return .muted
        case .proposed:   return .muted
        case .external:   return .amber
        case .unknown:    return .muted
        }
    }

    // MARK: an entry's fields

    /// Each phase-1 kind's fields, in `KIND_SPECS`'s own order — the order the Details section draws
    /// them in. Held to the contract's `kinds.<kind>.fields` by `WikiContractTests` and to the shared
    /// registry's order by `WikiCopyParityTests`.
    public static let kindFields: [WikiEntryKind: [String]] = [
        .principle: ["statement", "rationale"],
        .convention: ["rule", "scope", "exceptions"],
        .decision: ["context", "decision", "alternatives", "consequences", "decidedAt"],
        .pitfall: ["trigger", "symptom", "cause", "fix", "detector"],
        .recipe: ["steps", "verify"],
        .concept: ["definition", "boundaries", "notToConfuseWith"],
    ]

    /// The fields inside an object field, in the registry's order.
    public static let nestedFields: [String: [String]] = [
        "trigger": ["paths", "commands", "errorSignature"],
        "verify": ["command", "expectedExit"],
        "alternatives": ["option", "whyRejected"],
    ]

    /// The labels the design writes itself rather than deriving from the key (`FIELD_LABELS`).
    private static let fieldLabels: [String: String] = [
        "whyRejected": "Rejected",
        "alternatives": "Rejected",
        "decidedAt": "Decided",
        "notToConfuseWith": "Not to be confused with",
        "expectedExit": "Expected exit code",
        "errorSignature": "Error signature",
    ]

    /// `errorSignature` → `Error signature`: the key's first letter up, and a space before every
    /// later capital, which is lowered (`labelOf`).
    public static func fieldLabel(_ key: String) -> String {
        if let label = fieldLabels[key] { return label }
        guard let first = key.first else { return key }
        var out = String(first).uppercased()
        for character in key.dropFirst() {
            if character.isUppercase {
                out += " " + character.lowercased()
            } else {
                out.append(character)
            }
        }
        return out
    }

    /// The order an object's keys arrive in from the server, which is the order the web walks them in
    /// (`Object.entries`): Postgres stores `jsonb` keys shortest first, then bytewise.
    public static func jsonbOrder<S: Sequence>(_ keys: S) -> [String] where S.Element == String {
        keys.sorted { a, b in
            a.utf8.count != b.utf8.count ? a.utf8.count < b.utf8.count : Array(a.utf8).lexicographicallyPrecedes(b.utf8)
        }
    }

    /// The rows the Details section draws for one entry (`wikiFieldRows`): the kind's schema, in the
    /// schema's order, with the values it actually carries. A kind this build has no schema for is
    /// drawn from whatever it carries, in the order it arrives, rather than not at all.
    public static func fieldRows(kind: WikiEntryKind?, fields: JSONValue?) -> [WikiFieldRow] {
        let object: [String: JSONValue]
        if case .object(let values)? = fields { object = values } else { object = [:] }
        let keys = kind.flatMap { kindFields[$0] } ?? jsonbOrder(object.keys)
        return keys.flatMap { rows(key: $0, value: object[$0]) }
    }

    private static func rows(key: String, value: JSONValue?) -> [WikiFieldRow] {
        let label = fieldLabel(key)
        // A decision's alternatives read as the design writes them — the option and why it lost, one
        // line each — rather than as a pair of key–value lines per alternative.
        if key == "alternatives", case .array(let items)? = value {
            let lines = items.compactMap { item -> String? in
                let option = item["option"]?.stringValue
                let why = item["whyRejected"]?.stringValue
                if let option, let why { return "\(option) — \(why)" }
                return option ?? why
            }
            return lines.isEmpty ? [] : [WikiFieldRow(label: label, lines: lines)]
        }
        switch value {
        case nil, .null?:
            return []
        case .string(let text)?:
            return text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? [] : [WikiFieldRow(label: label, lines: [text])]
        case .int?, .double?:
            return [WikiFieldRow(label: label, lines: scalarLines(value!))]
        case .array?, .object?:
            let lines = scalarLines(value!, parent: key)
            return lines.isEmpty ? [] : [WikiFieldRow(label: label, lines: lines)]
        case .bool?:
            return []
        }
    }

    /// Every scalar inside a value, one line each, an object's as `Label: value` (`scalarLines`).
    /// An object's keys go in the registry's order when it has one for them (which is also the order
    /// they arrive in, for every phase-1 kind), and in the order they arrive otherwise.
    private static func scalarLines(_ value: JSONValue, parent: String? = nil) -> [String] {
        switch value {
        case .string(let text):
            return text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? [] : [text]
        case .int(let number):
            return [String(number)]
        case .double(let number):
            return [number == number.rounded() && abs(number) < 1e15 ? String(Int(number)) : String(number)]
        case .array(let items):
            return items.flatMap { scalarLines($0, parent: parent) }
        case .object(let values):
            let known = parent.flatMap { nestedFields[$0] } ?? []
            let keys = known.filter { values[$0] != nil } + jsonbOrder(values.keys.filter { !known.contains($0) })
            return keys.flatMap { key in
                scalarLines(values[key]!, parent: key).map { "\(fieldLabel(key)): \($0)" }
            }
        case .bool, .null:
            return []
        }
    }

    /// What an amendment would change, as the red and green lines Review draws (`wikiChangesDiff`):
    /// every line of the old value removed and every line of the new one added. A key the op does not
    /// name carries over from the base revision, so it is not drawn at all. The hunks go in the order
    /// the changes arrive, as the web's do.
    public static func changesDiff(before: JSONValue?, changes: JSONValue?) -> [WikiDiffHunk] {
        guard case .object(let changed)? = changes else { return [] }
        let old: [String: JSONValue]
        if case .object(let values)? = before { old = values } else { old = [:] }
        return jsonbOrder(changed.keys).compactMap { key in
            let after = scalarLines(changed[key]!, parent: key)
            let was = old[key].map { scalarLines($0, parent: key) } ?? []
            guard !(after.isEmpty && was.isEmpty) else { return nil }
            return WikiDiffHunk(label: fieldLabel(key),
                                lines: was.map { .init(sign: .removed, text: $0) }
                                    + after.map { .init(sign: .added, text: $0) })
        }
    }

    // MARK: the home page's reads

    /// The entries of one kind, newest change first (`wikiEntriesOfKind`).
    public static func entries(_ entries: [WikiEntry], ofKind kind: WikiEntryKind) -> [WikiEntry] {
        entries.filter { $0.kind == kind }.sorted(by: changedFirst)
    }

    /// Newest change first: when what an entry says became true (`byChangedAtDesc`).
    public static func changedFirst(_ a: WikiEntry, _ b: WikiEntry) -> Bool {
        let at = RelativeTime.parse(a.validFrom ?? "") ?? .distantPast
        let bt = RelativeTime.parse(b.validFrom ?? "") ?? .distantPast
        return at != bt ? at > bt : a.id > b.id
    }

    /// The word a timeline row leads with, from what happened to the op (`wikiChangeVerb`).
    public static func changeVerb(_ item: WikiTimelineItem) -> String {
        if item.decision == .accepted { return WikiCopy.historyConfirmedBy }
        if item.decision == .edited { return "Edited by you" }
        switch item.op {
        case .retire?:    return "Retired"
        case .supersede?: return "Superseded"
        case .reinforce?: return "Reinforced"
        case .challenge?: return "Challenged"
        // What a review mode applied is in the wiki already — `Added`, and its mark says by whom.
        case .add?:       return item.origin == .owner ? "Added by you" : (item.appliedByMode != nil ? "Added" : "Proposed")
        default:          return item.origin == .owner ? "Amended by you" : "Amended"
        }
    }

    /// The note under a timeline row: why it was retired, or what the amend replaced (`wikiChangeNote`).
    public static func changeNote(_ item: WikiTimelineItem) -> String? {
        if item.op == .retire {
            if let title = item.supersededByTitle { return "replaced by “\(title)”" }
            return item.reason
        }
        if item.op == .supersede, let title = item.supersededByTitle { return "replaces “\(title)”" }
        return nil
    }

    /// A source's record, in a word (`wikiSourceWord`): the kind's own name, or the raw kind for one
    /// this build has no word for.
    public static func sourceWord(_ kind: WikiSourceKind?) -> String {
        switch kind {
        case .turn?:          return "Turn"
        case .event?:         return "Event"
        case .toolCall?:      return "Tool call"
        case .task?:          return "Task"
        case .taskComment?:   return "Task comment"
        case .approval?:      return "Approval"
        case .evidence?:      return "Evidence"
        case .ownerDecision?: return "Your decision"
        case .mergeReceipt?:  return "Merge receipt"
        case .criterion?:     return "Criterion"
        case .commit?:        return "Commit"
        case .note?:          return "Note"
        case .url?:           return "url"
        default:              return ""
        }
    }

    /// The mono hint under a source's line: the path or URL its locator names, or the record's id
    /// (a commit's short sha) — `wikiSourceRefText`.
    public static func sourceRef(_ source: WikiSource) -> String {
        if let path = source.locator?["path"]?.stringValue { return path }
        if let url = source.locator?["url"]?.stringValue { return url }
        return shortSha(source.ref ?? "")
    }

    // MARK: Review

    /// Review's tabs, in order.
    public enum ReviewTab: String, CaseIterable, Sendable {
        case all, add, amend, retire

        public var title: String {
            switch self {
            case .all:    return WikiCopy.tabAll
            case .add:    return WikiCopy.tabAdd
            case .amend:  return WikiCopy.tabAmend
            case .retire: return WikiCopy.tabRetire
            }
        }

        /// Whether an op falls under this tab (`wikiTabOf`): an amend and a supersede are both Amend.
        public func holds(_ op: WikiOpKind?) -> Bool {
            switch self {
            case .all:    return true
            case .add:    return op == .add
            case .amend:  return op == .amend || op == .supersede
            case .retire: return op == .retire
            }
        }
    }

    /// One pending op, with the changeset it arrived in — what one Review card draws.
    public struct ReviewCard: Equatable, Sendable, Identifiable {
        public let changeset: WikiChangeset
        public let op: WikiChangesetOp
        public var id: String { "\(changeset.id):\(op.seq ?? 0)" }
    }

    /// Every op still waiting for the owner, in the order the server answered the changesets (newest
    /// first) and each changeset's ops in their own order — the queue Review pages through one card
    /// at a time, as the web's phone pager does. Decided ops ride along in a changeset and are left out.
    public static func reviewCards(_ changesets: [WikiChangeset]) -> [ReviewCard] {
        changesets.flatMap { changeset in
            (changeset.ops ?? [])
                .filter { $0.decision == .pending }
                .sorted { ($0.seq ?? 0) < ($1.seq ?? 0) }
                .map { ReviewCard(changeset: changeset, op: $0) }
        }
    }

    /// When the oldest waiting proposal was written — Review's `oldest 2h ago`.
    public static func oldestProposal(_ cards: [ReviewCard]) -> String? {
        cards.compactMap { card in card.changeset.createdAt.flatMap { at in RelativeTime.parse(at).map { (at, $0) } } }
            .min { $0.1 < $1.1 }?.0
    }

    /// The toast for a Review answer once it lands (web `wikiDecidedToast`). Keep on a retire card is a
    /// rejection on the wire, but the owner kept the entry, so it says Kept; Retire there is an accept.
    public static func decidedToast(op: WikiOpKind?, action: WikiDecideAction) -> String {
        switch action {
        case .edit:      return WikiCopy.decidedEdited
        case .reconfirm: return WikiCopy.decidedReconfirmed
        case .amend:     return WikiCopy.decidedAmended
        case .retire:    return WikiCopy.retired
        case .reject:    return op == .retire ? WikiCopy.decidedKept : WikiCopy.rejected
        case .accept:    return op == .retire ? WikiCopy.retired : WikiCopy.decidedAccepted
        }
    }

    /// What a card is about, as Review's card says it: the title an add's or a supersede's draft
    /// carries, else the title of the entry the op names (an amend's new title is its diff's to say),
    /// else the word `entry`.
    public static func cardTitle(_ card: ReviewCard, entry: WikiEntry?) -> String {
        knownTitle(card, entry: entry) ?? WikiCopy.entryWord
    }

    /// The card's title when one is known — the draft's, else the named entry's: as its own read has it,
    /// or until that read lands, as Review's read carries it (`entryTitle`). Nil rather than the
    /// placeholder word, for a line that is better left out than filled with "entry".
    public static func knownTitle(_ card: ReviewCard, entry: WikiEntry?) -> String? {
        if let title = card.op.payload?["entry"]?["title"]?.stringValue { return title }
        if let title = entry?.title, !title.isEmpty { return title }
        if let title = card.op.entryTitle, !title.isEmpty { return title }
        return nil
    }

    /// The anchor lines a card lists (`anchorsOf`): the draft's own, or the ones the named entry
    /// already has — a path with its symbol, a commit's whole sha, a command, a record.
    public static func reviewAnchorLines(draft: JSONValue?, fallback: [WikiAnchor]?) -> [String] {
        func line(path: String?, symbol: String?, sha: String?, command: String?, ref: String?) -> String? {
            if let path { return symbol.map { "\(path) · \($0)" } ?? path }
            return sha ?? command ?? ref
        }
        if case .array(let anchors)? = draft?["anchors"] {
            return anchors.compactMap {
                line(path: $0["path"]?.stringValue, symbol: $0["symbol"]?.stringValue, sha: $0["sha"]?.stringValue,
                     command: $0["command"]?.stringValue, ref: $0["ref"]?.stringValue)
            }
        }
        return (fallback ?? []).compactMap {
            line(path: $0.path, symbol: $0.symbol, sha: $0.sha, command: $0.command, ref: $0.ref)
        }
    }

    /// The keys an anchor is written with (contract `anchorTypes.<type>.fields`, and `type`). What the
    /// server sends back carries more — its last check, the public-id twin beside a criterion's id —
    /// and a key no anchor type names is refused, so an anchor goes back with these and no others.
    public static let anchorInputKeys: Set<String> = ["type", "path", "symbol", "regionSha256", "sha",
                                                      "criterionId", "semanticHash", "contentHash",
                                                      "command", "expectedExit", "ref"]

    /// An anchor as a proposer writes it, from one the server sent.
    public static func anchorInput(_ anchor: JSONValue) -> JSONValue {
        guard case .object(let values) = anchor else { return anchor }
        return .object(values.filter { anchorInputKeys.contains($0.key) })
    }

    /// The entry a card's content is drawn from: the proposal's own draft for an add or a supersede,
    /// and the named entry otherwise.
    public static func cardKind(_ card: ReviewCard, entry: WikiEntry?) -> WikiEntryKind? {
        if let raw = card.op.payload?["entry"]?["kind"]?.stringValue { return WikiEntryKind(rawValue: raw) ?? .unknown }
        return entry?.kind
    }

    /// The op's chip on a card: a supersede is an Amend on Review, as on its tabs.
    public static func cardChip(_ op: WikiOpKind?) -> String {
        switch op {
        case .supersede?: return WikiCopy.opLabel(.amend)
        case let op?:     return WikiCopy.opLabel(op)
        case nil:         return ""
        }
    }

    /// Who a card's proposal came from: the proposer's own sentence for a session's proposal, cut to
    /// a line (`shortRationale`), else the session, you, or the maintenance run.
    public static func proposedBy(_ changeset: WikiChangeset) -> String {
        if changeset.sessionId != nil {
            guard let rationale = changeset.rationale?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !rationale.isEmpty else { return "a session" }
            return rationale.count > 48 ? String(rationale.prefix(47)) + "…" : rationale
        }
        return changeset.origin == .owner ? "you" : WikiCopy.historyMaintenance
    }

    /// How many sessions the waiting proposals came from — Review's subtitle. Counted as the web
    /// counts it: distinct sessions, so a maintenance run or a headless proposal (no session) adds
    /// a proposal and no session.
    public static func proposingSessions(_ cards: [ReviewCard]) -> Int {
        Set(cards.compactMap(\.changeset.sessionId)).count
    }

    /// The tab's cards, and the count its label carries (`All 3`, `Add 1`).
    public static func cards(_ cards: [ReviewCard], in tab: ReviewTab) -> [ReviewCard] {
        cards.filter { tab.holds($0.op.op) }
    }

    public static func tabLabel(_ tab: ReviewTab, cards all: [ReviewCard]) -> String {
        "\(tab.title) \(cards(all, in: tab).count)"
    }

    /// Where the pager stands once the queue moved under it — a card decided here or elsewhere: the
    /// same position, or the last card when the queue got shorter, or nothing when it is empty.
    public static func clampedIndex(_ index: Int, count: Int) -> Int? {
        guard count > 0 else { return nil }
        return min(max(0, index), count - 1)
    }
}

// MARK: - Activity, as its bands draw it

/// What one space's Activity is drawn from (design §12.3.2): the home's management blocks as they stood until
/// 2026-10-06 — the status line, Recent decisions, Recently changed, Agents used the wiki — and each band's rows
/// derived from them the way the web's `WikiActivityPage.tsx` derives its own (from the blocks it still takes
/// out of `WikiHome.tsx`), so the two clients show the same rows in the same order. The home itself is content
/// (`WikiLogic.HomeBand`).
public struct WikiHomeContent: Equatable, Sendable {
    /// The space on screen, with its usage window.
    public let space: WikiSpace
    /// Every space, for the picker.
    public let spaces: [WikiSpace]
    /// The newest entries of every kind, as many as one read answers (200): what the status line counts
    /// until the health read is in. Never the bands' rows — a space holds thousands of entries, and its
    /// decisions are among the oldest of them.
    public let entries: [WikiEntry]
    /// The space's newest decisions, read on their own (`?kind=decision`, `recentDecisionCount` of them).
    public let decisionEntries: [WikiEntry]
    public let timeline: [WikiTimelineItem]
    /// The runs Recently changed folds, each as its own read answers it (`GET /wiki/changesets/:id`):
    /// what their rows count and whether they offer Revert run….
    public let runs: [WikiChangesetView]
    /// The space's health (`GET /wiki/spaces/:id/health`, criterion 5): every active entry it holds, and
    /// where its maintenance run stands — what the status line says. Nil when that read failed.
    public let health: WikiSpaceHealth?

    /// The decision log's rows: the newest four.
    public static let recentDecisionCount = 4

    public init(space: WikiSpace, spaces: [WikiSpace], entries: [WikiEntry],
                decisions: [WikiEntry] = [], timeline: [WikiTimelineItem],
                runs: [WikiChangesetView] = [], health: WikiSpaceHealth? = nil) {
        self.space = space
        self.spaces = spaces
        self.entries = entries
        self.decisionEntries = decisions
        self.timeline = timeline
        self.runs = runs
        self.health = health
    }

    /// The four newest decisions, of any status, from their own read.
    public var recentDecisions: [WikiEntry] {
        Array(WikiLogic.entries(decisionEntries, ofKind: .decision).prefix(Self.recentDecisionCount))
    }

    /// The five newest changes.
    public var recentlyChanged: [WikiTimelineItem] { Array(timeline.prefix(5)) }

    /// The five newest rows of Recently changed, every run folded into one row by the changeset its
    /// items name (`wikiRecentRows(...).slice(0, 5)` on the web).
    public var recentRows: [WikiModeLogic.RecentRow] {
        Array(WikiModeLogic.recentRows(timeline).prefix(5))
    }

    /// When one of those rows happened: the change's own time, or the newest of a run's.
    public static func time(of row: WikiModeLogic.RecentRow) -> String? {
        switch row {
        case .op(let item):          return item.at
        case .run(_, _, let at, _):  return at
        }
    }

    /// How many of those rows came after the reader last looked (`seen`, `WikiSeenLog`): what Activity
    /// says beside Recently changed (`N new since you last looked`), the rows that wear its blue dot.
    public func newRows(seen: Double) -> Int {
        recentRows.filter { WikiSeenLog.isNew(Self.time(of: $0), seen: seen) }.count
    }

    /// The runs those rows fold, by their changesets' ids — what the home reads for each one.
    public var recentRunIDs: [String] {
        recentRows.compactMap { row in
            if case .run(let changesetId, _, _, _) = row { return changesetId }
            return nil
        }
    }

    /// One run the home read, by either spelling of its id.
    public func run(_ id: String) -> WikiChangesetView? {
        let key = PublicID.storageKey(id)
        return runs.first { PublicID.storageKey($0.id) == key }
    }

    /// The three most used entries this week.
    public var mostUsed: [WikiUsageEntry] {
        Array((space.usage?.entries ?? []).filter { ($0.total ?? 0) > 0 }.prefix(3))
    }

    /// Whether any session used the wiki in the window — the band says so rather than drawing zeros.
    public var usedThisWeek: Bool { (space.usage?.entries ?? []).contains { ($0.total ?? 0) > 0 } }

    /// The line under the title, part by part: how many entries — every active one the health read
    /// counts, else the entries read here — the commit the anchors were last verified at, and where the
    /// maintenance run stands (mock 12 ④), as the web's status row carries them. The count waiting for
    /// review is left out — the banner right below says it (mock 12 ①).
    public func statusParts(now: Date) -> [WikiStatusPart] {
        let count = health?.entries ?? entries.count
        var parts = [WikiStatusPart("\(WikiArticleCopy.count(count)) \(WikiCopy.entryNoun(count))")]
        if let sha = space.rootCommitSha, !sha.isEmpty {
            parts.append(WikiStatusPart(WikiCopy.anchorsVerified(ref: String(sha.prefix(7)), ago: "")))
        }
        if let health { parts += WikiHealthLogic.parts(health.maintenance, now: now) }
        return parts
    }

    /// The same line as one text (`WikiHealthLogic.text`): what VoiceOver reads.
    public func statusLine(now: Date) -> String { WikiHealthLogic.text(statusParts(now: now)) }

    public var statusLine: String { statusLine(now: Date()) }
}
