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

    /// The drawer's amber count said in words, and the home page's banner (`wikiProposalsToReview`).
    public static func proposalsToReview(_ count: Int) -> String { "\(count) proposals to review" }
    /// The same count under Review's own title (`wikiProposalsFrom`).
    public static func proposalsFrom(_ count: Int, sessions: Int) -> String {
        "\(count) proposal\(count == 1 ? "" : "s") from \(sessions) session\(sessions == 1 ? "" : "s")"
    }
    public static func oldest(_ when: String) -> String { "oldest \(when)" }             // wikiOldest

    // The bands of the home page, in the order both clients draw them.
    public static let principles = "Principles"                         // WIKI_PRINCIPLES
    public static let topics = "Topics"                                 // WIKI_TOPICS
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
    public static let superseded = "Superseded"
    public static let retired = "Retired"
    public static let refused = "The server refused it"
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
    public static let rejected = "Rejected"
    public static let decided = "Decided"
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

    /// Empty states.
    public static let noEntries = "Nothing has been recorded in this space yet."   // WIKI_NO_ENTRIES
    public static let noReview = "Nothing is waiting for you."                     // WIKI_NO_REVIEW
    public static let noChanges = "Nothing has changed yet."                       // WIKI_NO_CHANGES
    public static let noDecisions = "No decision has been recorded yet."           // WIKI_NO_DECISIONS
    public static let noTopics = "No entry has been filed under a topic yet."      // WIKI_NO_TOPICS
    public static let noAgentsYet = "No session has used this wiki yet."           // WIKI_NO_AGENTS_YET
    public static let noEntrySelected = "That entry is no longer in this space."   // WIKI_NO_ENTRY_SELECTED

    /// A trust's word (`WIKI_TRUST_LABELS`).
    public static func trustLabel(_ trust: WikiTrust) -> String {
        switch trust {
        case .owner:     return "Owner"
        case .confirmed: return "Confirmed"
        case .proposed:  return "Proposed"
        case .external:  return "Web-derived"
        case .unknown:   return ""
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

    /// The home page's bands, top to bottom — the order the web's phone page draws them in (mock 07,
    /// `WikiHome.tsx`), and the order `WikiView` lays its sections out in. `WikiCopyParityTests` holds
    /// both to it.
    public enum HomeBand: String, CaseIterable, Sendable {
        case search, reviewBanner, principles, topics, recentDecisions, recentlyChanged, agentsUsed

        /// The band's heading, for the five that have one.
        public var title: String? {
            switch self {
            case .search, .reviewBanner: return nil
            case .principles:      return WikiCopy.principles
            case .topics:          return WikiCopy.topics
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

    // MARK: the drawer's amber number

    /// The proposals waiting for the owner, summed over every space — the drawer row's amber number,
    /// counted exactly as the web sidebar counts it (`space.pendingOps`, summed). A space an older
    /// server sent no count for adds nothing.
    public static func proposalsToReview(_ spaces: [WikiSpace]) -> Int {
        spaces.reduce(0) { $0 + max(0, $1.pendingOps ?? 0) }
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
        case .owner:     return .owner
        case .confirmed: return .blue
        case .proposed:  return .muted
        case .external:  return .amber
        case .unknown:   return .muted
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

    /// The rows the Details section draws for one entry (`wikiFieldRows`): the kind's schema, in the
    /// schema's order, with the values it actually carries. A kind this build has no schema for is
    /// drawn from whatever it carries, keys in order, rather than not at all.
    public static func fieldRows(kind: WikiEntryKind?, fields: JSONValue?) -> [WikiFieldRow] {
        let object: [String: JSONValue]
        if case .object(let values)? = fields { object = values } else { object = [:] }
        let keys = kind.flatMap { kindFields[$0] } ?? object.keys.sorted()
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
    /// An object's keys go in the registry's order when it has one for them, and sorted otherwise.
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
            let keys = known.filter { values[$0] != nil } + values.keys.filter { !known.contains($0) }.sorted()
            return keys.flatMap { key in
                scalarLines(values[key]!, parent: key).map { "\(fieldLabel(key)): \($0)" }
            }
        case .bool, .null:
            return []
        }
    }

    /// What an amendment would change, as the red and green lines Review draws (`wikiChangesDiff`):
    /// every line of the old value removed and every line of the new one added. A key the op does not
    /// name carries over from the base revision, so it is not drawn at all.
    public static func changesDiff(before: JSONValue?, changes: JSONValue?) -> [WikiDiffHunk] {
        guard case .object(let changed)? = changes else { return [] }
        let old: [String: JSONValue]
        if case .object(let values)? = before { old = values } else { old = [:] }
        let order = ["title", "summary", "fields", "topics", "aliases", "anchors"]
        let keys = order.filter { changed[$0] != nil } + changed.keys.filter { !order.contains($0) }.sorted()
        return keys.compactMap { key in
            let after = scalarLines(changed[key]!, parent: key)
            let was = old[key].map { scalarLines($0, parent: key) } ?? []
            guard !(after.isEmpty && was.isEmpty) else { return nil }
            return WikiDiffHunk(label: fieldLabel(key),
                                lines: was.map { .init(sign: .removed, text: $0) }
                                    + after.map { .init(sign: .added, text: $0) })
        }
    }

    // MARK: the home page's reads

    /// An entry's topic slugs, deduplicated and in the order it lists them.
    public static func topics(of entry: WikiEntry) -> [String] {
        var seen = Set<String>()
        return (entry.topics ?? []).filter { seen.insert($0).inserted }
    }

    /// One topic the space's entries use: how many carry it, and the most recently changed of them.
    public struct TopicSummary: Equatable, Sendable, Identifiable {
        public let slug: String
        public let count: Int
        public let latest: WikiEntry?
        public var id: String { slug }
    }

    /// The topics a space's entries actually use (`wikiTopicSummaries`): derived from the entries,
    /// because phase 1 writes no topic row — an entry names its topics by slug, so the slugs in use
    /// ARE the topics. Most entries first, then by slug, so two runs over one list agree.
    public static func topicSummaries(_ entries: [WikiEntry]) -> [TopicSummary] {
        var bySlug: [String: [WikiEntry]] = [:]
        for entry in entries {
            for slug in topics(of: entry) { bySlug[slug, default: []].append(entry) }
        }
        return bySlug.map { slug, held in
            TopicSummary(slug: slug, count: held.count, latest: held.sorted(by: changedFirst).first)
        }
        .sorted { $0.count != $1.count ? $0.count > $1.count : $0.slug < $1.slug }
    }

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

    /// A topic's name, read out of its slug the way the server reads it (`topicTitle`):
    /// `tasks-dispatch` → `Tasks dispatch`.
    public static func topicTitle(_ slug: String) -> String {
        let words = slug.split(separator: "-").map(String.init)
        guard let first = words.first else { return slug }
        return ([first.prefix(1).uppercased() + first.dropFirst()] + words.dropFirst()).joined(separator: " ")
    }

    /// The verb a topic row leads with: what its newest entry is, and who made it so
    /// (`wikiChangeVerbOfEntry`).
    public static func entryVerb(_ entry: WikiEntry, loaded: Set<String>) -> String {
        if entry.status == .superseded { return "Superseded" }
        if entry.status == .retired { return "Retired" }
        if entry.trust == .owner { return "Added by you" }
        if let successor = entry.supersededById, loaded.contains(successor) { return "Superseded" }
        return "Confirmed"
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
        case .add?:       return item.origin == .owner ? "Added by you" : "Proposed"
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

    /// What a card is about, as Review's card says it: the title the proposal carries (an add's or a
    /// supersede's draft, or an amend's new title), else the title of the entry it names, else the
    /// word `entry`.
    public static func cardTitle(_ card: ReviewCard, entry: WikiEntry?) -> String {
        let draft = card.op.payload?["entry"] ?? card.op.payload?["changes"]
        if let title = draft?["title"]?.stringValue { return title }
        if let title = entry?.title, !title.isEmpty { return title }
        return WikiCopy.entryWord
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

// MARK: - the home page, as its bands draw it

/// One space's home page: the reads it is drawn from, and each band's rows derived from them the way
/// the web's `WikiHome.tsx` derives its own — so the two clients show the same rows in the same
/// order, whatever either one's layout does with them.
public struct WikiHomeContent: Equatable, Sendable {
    /// The space on screen, with its usage window.
    public let space: WikiSpace
    /// Every space, for the picker.
    public let spaces: [WikiSpace]
    public let entries: [WikiEntry]
    public let timeline: [WikiTimelineItem]
    /// Proposals waiting in every space — the banner's number, which is the drawer's.
    public let proposals: Int

    public init(space: WikiSpace, spaces: [WikiSpace], entries: [WikiEntry],
                timeline: [WikiTimelineItem], proposals: Int) {
        self.space = space
        self.spaces = spaces
        self.entries = entries
        self.timeline = timeline
        self.proposals = proposals
    }

    /// Every principle, of any status, oldest recorded first — the web's order for the owner's own
    /// rules, which do not reshuffle as the space fills up.
    public var principles: [WikiEntry] {
        entries.filter { $0.kind == .principle }.sorted {
            (RelativeTime.parse($0.recordedAt ?? "") ?? .distantPast)
                < (RelativeTime.parse($1.recordedAt ?? "") ?? .distantPast)
        }
    }

    /// Whether every principle is the owner's own — then the band says so once, in its header,
    /// instead of on every row (mock 07 ①).
    public var principlesAllOwner: Bool {
        let rows = principles
        return !rows.isEmpty && rows.allSatisfy { $0.trust == .owner }
    }

    public var topics: [WikiLogic.TopicSummary] { WikiLogic.topicSummaries(entries) }

    /// The four newest decisions, of any status.
    public var recentDecisions: [WikiEntry] { Array(WikiLogic.entries(entries, ofKind: .decision).prefix(4)) }

    /// The five newest changes.
    public var recentlyChanged: [WikiTimelineItem] { Array(timeline.prefix(5)) }

    /// The three most used entries this week.
    public var mostUsed: [WikiUsageEntry] {
        Array((space.usage?.entries ?? []).filter { ($0.total ?? 0) > 0 }.prefix(3))
    }

    /// Whether any session used the wiki in the window — the band says so rather than drawing zeros.
    public var usedThisWeek: Bool { (space.usage?.entries ?? []).contains { ($0.total ?? 0) > 0 } }

    /// The ids in hand, for the verbs that ask whether an entry's successor is one of them.
    public var loadedIDs: Set<String> { Set(entries.map(\.id)) }

    /// The line under the title: how many entries, and the commit the anchors were last verified at.
    /// The count waiting for review is left out — the banner right below says it (mock 07 ①).
    public var statusLine: String {
        var parts = ["\(entries.count) \(WikiCopy.entryNoun(entries.count))"]
        if let sha = space.rootCommitSha, !sha.isEmpty {
            parts.append(WikiCopy.anchorsVerified(ref: String(sha.prefix(7)), ago: ""))
        }
        return parts.joined(separator: " · ")
    }
}
