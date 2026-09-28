import Foundation

// The Wiki's articles on the native pages (criterion 10, mocks 12, 14, 16) — the Swift half of the
// web's `src/web/src/lib/wikiArticles.ts`: the category directory, a topic's article with its
// footnotes and entries, Browse by category and the A–Z index.
//
// Every sentence is a constant here, not a literal in a view, because `WikiArticlesCopyParityTests`
// looks each one up in the web source; every reading is proved against the cases in
// `src/shared/src/wiki-articles.fixture.json`, which the web's `lib/wikiArticles.test.ts` reads too.
//
// Pure, with no SwiftUI, so it is tested on Linux like the rest of this directory.

/// Every sentence the article pages say. The web's constant each one mirrors is named beside it.
public enum WikiArticleCopy {
    public static let contents = "Contents"                              // WIKI_CONTENTS
    public static let home = "Home"                                      // WIKI_DIRECTORY_HOME
    public static let browse = "Browse by category"                      // WIKI_BROWSE
    public static let azIndex = "A–Z index"                              // WIKI_AZ_INDEX
    /// The heading over topics no category has been given.
    public static let other = "Other"                                    // WIKI_OTHER_TOPICS
    public static let footnotes = "Footnotes"                            // WIKI_FOOTNOTES
    public static let entries = "Entries"                                // WIKI_ARTICLE_ENTRIES
    /// What the list under an article is: the topic read's entries, not the article's own pool, which
    /// the article read does not name (see the web's `WIKI_ARTICLE_ENTRIES_HINT`).
    public static let entriesHint = "filed under this topic, by kind"    // WIKI_ARTICLE_ENTRIES_HINT
    public static let footnoteGone = "This entry is no longer in the wiki."   // WIKI_FOOTNOTE_GONE
    public static let openEntry = "Open entry"                           // WIKI_ACTION_OPEN
    public static let topicOverview = "Topic overview"                   // WIKI_TOPIC_OVERVIEW
    public static let noArticleYet = "No article yet. The maintenance run writes one once this topic has entries."
    public static let noArticles = "No article has been written yet. The maintenance run writes one for each topic that has entries."
    /// A topic nothing files itself under yet (`WIKI_TOPIC_MISSING`).
    public static let noTopicEntries = "No entry in this space carries that topic."

    /// The topic page's kind groups (`WIKI_TOPIC_GROUPS`), which an article's entries are drawn in.
    public static let groupPrinciples = "Principles & conventions"       // WIKI_GROUP_PRINCIPLES
    public static let groupDecisions = "Decisions"                       // WIKI_GROUP_DECISIONS
    public static let groupPitfalls = "Pitfalls"                         // WIKI_GROUP_PITFALLS
    public static let groupRecipes = "Recipes"                           // WIKI_GROUP_RECIPES
    public static let groupConcepts = "Concepts"                         // WIKI_GROUP_CONCEPTS
    public static let notePrinciples = "What every task in this topic starts from"
    public static let noteDecisions = "Active decisions, newest first"
    public static let notePitfalls = "Traps a run has actually hit, with the way out"
    public static let noteRecipes = "Steps that worked, with how to check them"
    public static let noteConcepts = "The words this topic uses, defined once"
    public static func showMore(_ count: Int) -> String { "Show \(count) more" }   // wikiShowMore
    public static let showLess = "Show less"                             // WIKI_SHOW_LESS

    /// A count as the pages print it: `11,689` (`wikiCount`).
    public static func count(_ value: Int) -> String {
        let digits = String(abs(value))
        var out = ""
        for (i, digit) in digits.enumerated() {
            if i > 0 && (digits.count - i) % 3 == 0 { out.append(",") }
            out.append(digit)
        }
        return value < 0 ? "-" + out : out
    }

    public static func entriesCited(_ count: Int) -> String { "\(count) \(count == 1 ? "entry" : "entries") cited" }
    public static func articleCount(_ n: Int) -> String { "\(count(n)) \(n == 1 ? "article" : "articles")" }
    public static func entryCount(_ n: Int) -> String { "\(count(n)) \(n == 1 ? "entry" : "entries")" }
    public static func topicCount(_ n: Int) -> String { "\(count(n)) \(n == 1 ? "topic" : "topics")" }

    /// The entry card's last line: what backs it (`wikiSourcesLine`).
    public static func sourcesLine(sources: Int, sessions: Int) -> String {
        var parts = ["\(sources) \(sources == 1 ? "source" : "sources")"]
        if sessions > 0 { parts.append("\(sessions) \(sessions == 1 ? "session" : "sessions")") }
        return parts.joined(separator: " · ")
    }

    /// A footnote marker as the text carries it: `[7]` (`wikiNoteLabel`).
    public static func noteLabel(_ n: Int) -> String { "[\(n)]" }

    /// Browse's lines (`wikiBrowseSummary`, `wikiCategorySummary`, `wikiBrowseTopicLine`, `wikiMoreArticles`).
    public static func browseSummary(articles: Int, topics: Int, entries: Int) -> String {
        "\(articleCount(articles)) · \(topicCount(topics)) · \(entryCount(entries))"
    }
    public static func categorySummary(topics: Int, articles: Int, entries: Int) -> String {
        "\(topicCount(topics)) · \(articleCount(articles)) · \(entryCount(entries))"
    }
    public static func browseTopicLine(entries: Int, articles: Int) -> String {
        "\(entryCount(entries)) · \(articleCount(articles))"
    }
    public static func moreArticles(_ n: Int) -> String { "\(n) more" }

    /// The index's line under its title (`wikiIndexSummary`).
    public static func indexSummary(_ n: Int) -> String { "\(articleCount(n)) by title · Chinese titles by pinyin" }

    /// An article's head line (`wikiArticleUpdated`): the day it was written, the ref it was written
    /// at, and how many entries it was written from.
    public static func updated(generatedAt: String?, ref: String?, entryCount n: Int, timeZone: TimeZone = .current) -> String {
        let day = generatedAt.flatMap { WikiModeLogic.monthDay($0, timeZone: timeZone) } ?? ""
        let at = ref.map { " at \(WikiLogic.shortSha($0))" } ?? ""
        return "Updated \(day)\(at) · written by \(WikiCopy.historyMaintenance) from \(count(n)) \(n == 1 ? "entry" : "entries")"
    }
}

public enum WikiArticleLogic {
    // MARK: orders

    /// An article page's sections, top to bottom — the web phone's order (`WIKI_ARTICLE_SECTIONS`),
    /// and the one the native page iterates.
    public enum Section: String, CaseIterable, Sendable {
        case crumb, title, tags, updated, body, footnotes, entries
    }

    /// The index letter bar: A to Z, then `#` (`WIKI_INDEX_LETTERS`).
    public static let indexLetters: [String] = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".map(String.init) + ["#"]

    /// The subtopic articles Browse shows of a topic before `N more`, on the phone (`WIKI_BROWSE_SHOWN_PHONE`).
    public static let browseShown = 5

    // MARK: the directory

    /// One topic as the directory lists it (`WikiDirectoryTopic`).
    public struct DirectoryTopic: Equatable, Sendable, Identifiable {
        public struct Part: Equatable, Sendable, Identifiable {
            public let part: Int
            public let title: String
            public var id: Int { part }
        }

        public let slug: String
        public let title: String
        /// The entries its article was written from; nil before it has one.
        public let count: Int?
        public let parts: [Part]
        public var id: String { slug }
    }

    public struct DirectoryGroup: Equatable, Sendable, Identifiable {
        public let key: String
        public let title: String
        public let topics: [DirectoryTopic]
        public var id: String { key }
    }

    /// The directory's groups (`wikiDirectoryGroups`): the categories in the contract's order with
    /// their topics, a category with no topic left out, and the uncategorized last under `Other`.
    public static func directoryGroups(_ directory: WikiArticleDirectory) -> [DirectoryGroup] {
        func row(_ topic: WikiArticleDirectory.Topic) -> DirectoryTopic {
            let title = topic.title.flatMap { $0.isEmpty ? nil : $0 } ?? topic.slug
            return DirectoryTopic(slug: topic.slug, title: title, count: topic.article.map { $0.entryCount ?? 0 },
                                  parts: (topic.parts ?? []).map { .init(part: $0.part, title: $0.title ?? "") })
        }
        var groups = (directory.categories ?? []).compactMap { category -> DirectoryGroup? in
            let topics = category.topics ?? []
            guard !topics.isEmpty else { return nil }
            return DirectoryGroup(key: category.key.rawValue, title: category.title ?? category.key.title, topics: topics.map(row))
        }
        let other = directory.uncategorized ?? []
        if !other.isEmpty {
            groups.append(DirectoryGroup(key: "other", title: WikiArticleCopy.other, topics: other.map(row)))
        }
        return groups
    }

    // MARK: Browse by category

    public struct BrowseTopic: Equatable, Sendable, Identifiable {
        public let slug: String
        public let title: String
        public let description: String?
        public let entries: Int
        public let articles: Int
        public let parts: [WikiArticlePartRef]
        public let hasArticle: Bool
        public var id: String { slug }
    }

    public struct BrowseCategory: Equatable, Sendable, Identifiable {
        public let key: String
        public let title: String
        public let topics: Int
        public let articles: Int
        public let entries: Int
        public let rows: [BrowseTopic]
        public var id: String { key }
    }

    /// Browse by category (`wikiBrowseCategories`): every group of the directory with its topics'
    /// counts summed — a topic's articles are its own and its subtopic parts.
    public static func browseCategories(_ directory: WikiArticleDirectory) -> [BrowseCategory] {
        let all = (directory.categories ?? []).flatMap { $0.topics ?? [] } + (directory.uncategorized ?? [])
        let bySlug = Dictionary(all.map { ($0.slug, $0) }, uniquingKeysWith: { first, _ in first })
        return directoryGroups(directory).map { group in
            let rows = group.topics.compactMap { row -> BrowseTopic? in
                guard let topic = bySlug[row.slug] else { return nil }
                let parts = topic.parts ?? []
                return BrowseTopic(slug: topic.slug, title: row.title, description: topic.description,
                                   entries: topic.article?.entryCount ?? 0,
                                   articles: (topic.article == nil ? 0 : 1) + parts.count,
                                   parts: parts, hasArticle: topic.article != nil)
            }
            return BrowseCategory(key: group.key, title: group.title, topics: rows.count,
                                  articles: rows.reduce(0) { $0 + $1.articles },
                                  entries: rows.reduce(0) { $0 + $1.entries }, rows: rows)
        }
    }

    /// The whole space's line under Browse's title (`wikiBrowseTotals`).
    public static func browseTotals(_ categories: [BrowseCategory]) -> (articles: Int, topics: Int, entries: Int) {
        (categories.reduce(0) { $0 + $1.articles }, categories.reduce(0) { $0 + $1.topics },
         categories.reduce(0) { $0 + $1.entries })
    }

    // MARK: the A–Z index

    /// Whether a character is a CJK ideograph — the same blocks the web's index reads (`HAN`).
    public static func isHan(_ character: Character) -> Bool {
        guard character.unicodeScalars.count == 1, let value = character.unicodeScalars.first?.value else { return false }
        return (0x3400...0x4DBF).contains(value) || (0x4E00...0x9FFF).contains(value)
            || (0xF900...0xFAFF).contains(value) || (0x20000...0x2FFFF).contains(value)
    }

    /// The index letter a title is filed under (`wikiIndexInitial`): its first letter, a Chinese first
    /// character's pinyin initial — the system's `mandarinToLatin`, which the web's collation
    /// boundaries were derived against — or `#`.
    public static func indexInitial(_ title: String) -> String {
        guard let first = title.trimmingCharacters(in: .whitespacesAndNewlines).first else { return "#" }
        if first.isASCII && first.isLetter { return first.uppercased() }
        guard isHan(first) else { return "#" }
        let latin = String(first).applyingTransform(.mandarinToLatin, reverse: false)?
            .applyingTransform(.stripDiacritics, reverse: false) ?? ""
        guard let letter = latin.first, letter.isASCII, letter.isLetter else { return "#" }
        return letter.uppercased()
    }

    /// The index's order: Chinese by pinyin, the Latin letters after the Chinese of the same letter —
    /// the zh pinyin collation the web's `Intl.Collator('zh-u-co-pinyin')` is.
    public static func pinyinOrder(_ a: String, _ b: String) -> ComparisonResult {
        a.compare(b, options: [], range: nil, locale: Locale(identifier: "zh@collation=pinyin"))
    }

    public struct IndexGroup: Equatable, Sendable, Identifiable {
        public let letter: String
        public let items: [WikiArticleIndex.Item]
        public var id: String { letter }
    }

    /// Every article under its letter (`wikiIndexGroups`), the letters in the bar's order, each group
    /// by pinyin, a tie by topic and then by part.
    public static func indexGroups(_ items: [WikiArticleIndex.Item]) -> [IndexGroup] {
        let sorted = items.sorted { a, b in
            switch pinyinOrder(a.title ?? "", b.title ?? "") {
            case .orderedAscending: return true
            case .orderedDescending: return false
            case .orderedSame: return a.topic.slug != b.topic.slug ? a.topic.slug < b.topic.slug : a.part < b.part
            }
        }
        var byLetter: [String: [WikiArticleIndex.Item]] = [:]
        for item in sorted { byLetter[indexInitial(item.title ?? ""), default: []].append(item) }
        return indexLetters.compactMap { letter in byLetter[letter].map { IndexGroup(letter: letter, items: $0) } }
    }

    /// An index row's second line (`wikiIndexMeta`): its topic and entries, or `Topic overview`.
    public static func indexMeta(_ item: WikiArticleIndex.Item) -> String {
        if item.part == 0 { return WikiArticleCopy.topicOverview }
        return "\(item.topic.title ?? item.topic.slug) · \(WikiArticleCopy.entryCount(item.entryCount ?? 0))"
    }

    // MARK: one article

    /// A run of a sentence: plain words, inline code, or strong words (`WikiSentenceSegment`).
    public struct Segment: Equatable, Sendable {
        public enum Kind: String, Sendable { case text, code, strong }
        public let kind: Kind
        public let text: String

        public init(kind: Kind, text: String) {
            self.kind = kind
            self.text = text
        }
    }

    /// A sentence's runs (`wikiSentenceSegments`): backticked code and `**strong**` words, nothing
    /// else, and an unpaired mark stays the character it is.
    public static func segments(_ text: String) -> [Segment] {
        var segments: [Segment] = []
        func push(_ kind: Segment.Kind, _ value: String) {
            guard !value.isEmpty else { return }
            if kind == .text, let last = segments.last, last.kind == .text {
                segments[segments.count - 1] = Segment(kind: .text, text: last.text + value)
            } else {
                segments.append(Segment(kind: kind, text: value))
            }
        }
        let characters = Array(text)
        func find(_ mark: [Character], from start: Int) -> Int? {
            guard start + mark.count <= characters.count else { return nil }
            for at in start...(characters.count - mark.count) where Array(characters[at..<(at + mark.count)]) == mark {
                return at
            }
            return nil
        }
        var at = 0
        while at < characters.count {
            if characters[at] == "`", let end = find(["`"], from: at + 1), end > at + 1 {
                push(.code, String(characters[(at + 1)..<end]))
                at = end + 1
                continue
            }
            if at + 1 < characters.count, characters[at] == "*", characters[at + 1] == "*",
               let end = find(["*", "*"], from: at + 2), end > at + 2 {
                push(.strong, String(characters[(at + 2)..<end]))
                at = end + 2
                continue
            }
            push(.text, String(characters[at]))
            at += 1
        }
        return segments
    }

    /// The kinds an article's tags count, in the registry's order (`wikiArticleKindTags`).
    private static let kindPlurals: [(WikiEntryKind, String, String)] = [
        (.principle, "principle", "principles"), (.convention, "convention", "conventions"),
        (.decision, "decision", "decisions"), (.pitfall, "pitfall", "pitfalls"),
        (.recipe, "recipe", "recipes"), (.concept, "concept", "concepts"),
        (.assumption, "assumption", "assumptions"),
    ]

    /// The tags after the category and the topic: how many entries of each kind the list holds.
    public static func kindTags(_ kinds: [WikiEntryKind?]) -> [String] {
        kindPlurals.compactMap { kind, one, many in
            let n = kinds.filter { $0 == kind }.count
            return n == 0 ? nil : "\(WikiArticleCopy.count(n)) \(n == 1 ? one : many)"
        }
    }

    /// One of the topic page's kind groups, with the entries it holds.
    public struct EntryGroup: Equatable, Sendable, Identifiable {
        public let title: String
        public let note: String
        public let entries: [WikiEntry]
        public var id: String { title }
    }

    /// The groups the entries under an article are drawn in (`WIKI_TOPIC_GROUPS`): principles and
    /// conventions together, then one kind each.
    public static let entryGroupKinds: [(title: String, note: String, kinds: [WikiEntryKind])] = [
        (WikiArticleCopy.groupPrinciples, WikiArticleCopy.notePrinciples, [.principle, .convention]),
        (WikiArticleCopy.groupDecisions, WikiArticleCopy.noteDecisions, [.decision]),
        (WikiArticleCopy.groupPitfalls, WikiArticleCopy.notePitfalls, [.pitfall]),
        (WikiArticleCopy.groupRecipes, WikiArticleCopy.noteRecipes, [.recipe]),
        (WikiArticleCopy.groupConcepts, WikiArticleCopy.noteConcepts, [.concept]),
    ]

    /// An article's entries by kind (`wikiArticleGroups`): each group leads with the entries the
    /// article cites, in footnote order, then the rest newest first; an empty group is left out.
    public static func entryGroups(_ entries: [WikiEntry], cited: [String]) -> [EntryGroup] {
        var rank: [String: Int] = [:]
        for (i, id) in cited.enumerated() where rank[PublicID.storageKey(id)] == nil { rank[PublicID.storageKey(id)] = i }
        return entryGroupKinds.compactMap { group in
            let held = entries.filter { $0.kind.map(group.kinds.contains) ?? false }
            let first = held.filter { rank[PublicID.storageKey($0.id)] != nil }
                .sorted { rank[PublicID.storageKey($0.id)]! < rank[PublicID.storageKey($1.id)]! }
            let rest = held.filter { rank[PublicID.storageKey($0.id)] == nil }.sorted(by: WikiLogic.changedFirst)
            let all = first + rest
            return all.isEmpty ? nil : EntryGroup(title: group.title, note: group.note, entries: all)
        }
    }

    /// How many sources back an entry, and how many sessions they are from (`wikiSourceCounts`): a
    /// turn cited from its session names that session.
    public static func sourceCounts(_ sources: [WikiSource]) -> (sources: Int, sessions: Int) {
        let sessions = Set(sources.filter { $0.kind == .turn && $0.locator?["turnId"]?.stringValue != nil }.compactMap(\.ref))
        return (sources.count, sessions.count)
    }
}
