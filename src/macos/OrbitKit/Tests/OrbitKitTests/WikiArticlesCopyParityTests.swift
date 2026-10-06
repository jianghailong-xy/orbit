import Foundation
import XCTest
@testable import OrbitKit

/// The articles say the web's words, count what the web counts, file the A–Z index the web's way and
/// draw their blocks in the web phone's order (criterion 10, mocks 11–16).
///
/// Three halves, each a failure — never an `XCTSkip` — when its counterpart goes missing:
/// - the cases in `src/shared/src/wiki-articles.fixture.json`, which the web's `lib/wikiArticles.test.ts`
///   reads too: the directory's groups, Browse's lines, the index's letters and order (Chinese titles by
///   pinyin), an article's head line, its sentences' runs, its kind tags and its entry groups;
/// - every `WikiArticleCopy` constant looked up as a declaration in the web source it mirrors;
/// - the order of an article page's sections, the footnote card's parts, the directory's first rows
///   and Browse's and the index's blocks, read out of the web pages and the native ones alike.
final class WikiArticlesCopyParityTests: XCTestCase {

    private static let lib = "src/web/src/lib/wikiArticles.ts"
    private static let wikiLib = "src/web/src/lib/wiki.ts"
    private static let articlePage = "src/web/src/components/WikiArticlePage.tsx"
    private static let directory = "src/web/src/components/WikiDirectory.tsx"
    private static let browsePage = "src/web/src/components/WikiBrowsePage.tsx"
    private static let indexPage = "src/web/src/components/WikiIndexPage.tsx"
    private static let fixturePath = "src/shared/src/wiki-articles.fixture.json"
    private static let app = "src/macos/OrbitApp/Sources/OrbitApp/"

    private struct Missing: Error, CustomStringConvertible {
        let file: String
        var description: String {
            "\(file) was not found above this test file. The articles' pages are one half of a pair; if the "
                + "other half moved, move this check with it rather than deleting it."
        }
    }

    private func find(_ relative: String) throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            dir = dir.deletingLastPathComponent()
        }
        throw Missing(file: relative)
    }

    /// A web source with string concatenations joined and every run of whitespace as one space.
    private func web(_ relative: String) throws -> String {
        try String(contentsOf: find(relative), encoding: .utf8)
            .replacingOccurrences(of: "['`]\\s*\\+\\s*['`]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "&apos;", with: "'")
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
    }

    /// A native page's source without its comment lines, whitespace kept.
    private func native(_ file: String) throws -> String {
        try String(contentsOf: find(Self.app + file), encoding: .utf8)
            .split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
    }

    private func assertSays(_ text: String, _ literal: String, in file: String, line: UInt = #line) {
        XCTAssertTrue(text.contains(literal), "\(file) no longer says \(literal)", line: line)
    }

    /// A named constant of the web's, anchored on its declaration.
    private func assertDeclares(_ text: String, _ name: String, _ value: String, in file: String, line: UInt = #line) {
        let single = "\(name) = '\(value.replacingOccurrences(of: "'", with: "\\'"))'"
        XCTAssertTrue(text.contains(single), "\(name) drifted: \(file) no longer declares it as \(value.debugDescription)",
                      line: line)
    }

    private func assertOrder(_ text: String, _ literals: [String], _ what: String, line: UInt = #line) {
        let positions = literals.map { text.range(of: $0)?.lowerBound }
        XCTAssertFalse(positions.contains(nil), "\(what): lost \(literals.filter { text.range(of: $0) == nil })", line: line)
        let found = positions.compactMap { $0 }
        XCTAssertEqual(found, found.sorted(), "\(what) is no longer in the order \(literals)", line: line)
    }

    /// From the first `start` through the next `end` after it.
    private func slice(_ text: String, from start: String, to end: String) throws -> String {
        let lower = try XCTUnwrap(text.range(of: start), "no `\(start)`")
        let upper = try XCTUnwrap(text.range(of: end, range: lower.upperBound..<text.endIndex), "no `\(end)` after `\(start)`")
        return String(text[lower.lowerBound..<upper.upperBound])
    }

    // MARK: the fixture

    private struct Says: Decodable {
        let n: Int
        let says: String
    }

    private struct Fixture: Decodable {
        struct Words: Decodable {
            let contents, home, browse, azIndex, other, footnotes, entries, footnoteGone: String
            let openEntry, topicOverview, noArticleYet, noArticles: String
            let moreArticles: [Says]
        }

        struct Orders: Decodable {
            let homeBands: [String]
            let homeBandTitles: [String?]
            let articleSections: [String]
            let directoryHead: [String]
            let browseSections: [String]
            let indexSections: [String]
            let indexLetters: [String]
        }

        struct Directory: Decodable {
            struct Group: Decodable {
                struct Topic: Decodable {
                    let slug: String
                    let title: String
                    let count: Int?
                    let parts: [String]
                }

                let title: String
                let topics: [Topic]
            }

            let read: WikiArticleDirectory
            let groups: [Group]
        }

        struct Browse: Decodable {
            struct Category: Decodable {
                struct Topic: Decodable {
                    let slug: String
                    let title: String
                    let line: String?
                    let parts: Int
                }

                let title: String
                let summary: String
                let topics: [Topic]
            }

            let summary: String
            let shown: Int
            let shownPhone: Int
            let categories: [Category]
        }

        struct Index: Decodable {
            struct Group: Decodable {
                struct Row: Decodable {
                    let title: String
                    let meta: String
                }

                let letter: String
                let rows: [Row]
            }

            let items: [WikiArticleIndex.Item]
            let summary: String
            let groups: [Group]
        }

        struct Initial: Decodable {
            let title: String
            let says: String
        }

        struct Updated: Decodable {
            struct Article: Decodable {
                let generatedAt: String
                let ref: String?
                let entryCount: Int
            }

            let article: Article
            let says: String
        }

        struct SourcesLine: Decodable {
            let sources: Int
            let sessions: Int
            let says: String
        }

        struct Segments: Decodable {
            struct Run: Decodable {
                let kind: String
                let text: String
            }

            let text: String
            let says: [Run]
        }

        struct KindTags: Decodable {
            let kinds: [String]
            let says: [String]
        }

        struct ArticleGroups: Decodable {
            struct Row: Decodable {
                let id: String
                let kind: String
                let validFrom: String
            }

            struct Group: Decodable {
                let title: String
                let ids: [String]
            }

            let entries: [Row]
            let cited: [String]
            let groups: [Group]
        }

        let timeZone: String
        let words: Words
        let orders: Orders
        let directory: Directory
        let browse: Browse
        let index: Index
        let initials: [Initial]
        let counts: [Says]
        let updated: [Updated]
        let entriesCited: [Says]
        let entriesHints: [Says]
        let sourcesLines: [SourcesLine]
        let segments: [Segments]
        let noteLabels: [Says]
        let kindTags: [KindTags]
        let articleGroups: ArticleGroups
    }

    private func fixture() throws -> Fixture {
        try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: find(Self.fixturePath)))
    }

    // MARK: the words

    func testTheWordsAreTheFixtures() throws {
        let shared = try fixture()
        let words = shared.words
        XCTAssertEqual(WikiArticleCopy.contents, words.contents)
        XCTAssertEqual(WikiArticleCopy.home, words.home)
        XCTAssertEqual(WikiArticleCopy.browse, words.browse)
        XCTAssertEqual(WikiArticleCopy.azIndex, words.azIndex)
        XCTAssertEqual(WikiArticleCopy.other, words.other)
        XCTAssertEqual(WikiArticleCopy.footnotes, words.footnotes)
        XCTAssertEqual(WikiArticleCopy.entries, words.entries)
        XCTAssertEqual(WikiArticleCopy.footnoteGone, words.footnoteGone)
        XCTAssertEqual(WikiArticleCopy.openEntry, words.openEntry)
        XCTAssertEqual(WikiArticleCopy.topicOverview, words.topicOverview)
        XCTAssertEqual(WikiArticleCopy.noArticleYet, words.noArticleYet)
        XCTAssertEqual(WikiArticleCopy.noArticles, words.noArticles)
        for row in words.moreArticles { XCTAssertEqual(WikiArticleCopy.moreArticles(row.n), row.says) }
        for row in shared.counts { XCTAssertEqual(WikiArticleCopy.count(row.n), row.says) }
        for row in shared.entriesCited { XCTAssertEqual(WikiArticleCopy.entriesCited(row.n), row.says) }
        for row in shared.entriesHints { XCTAssertEqual(WikiArticleCopy.entriesHint(row.n), row.says) }
        for row in shared.sourcesLines {
            XCTAssertEqual(WikiArticleCopy.sourcesLine(sources: row.sources, sessions: row.sessions), row.says)
        }
        for row in shared.noteLabels { XCTAssertEqual(WikiArticleCopy.noteLabel(row.n), row.says) }
        let zone = try XCTUnwrap(TimeZone(identifier: shared.timeZone))
        for row in shared.updated {
            XCTAssertEqual(WikiArticleCopy.updated(generatedAt: row.article.generatedAt, ref: row.article.ref,
                                                   entryCount: row.article.entryCount, timeZone: zone), row.says)
        }
    }

    /// Every constant, as the web source declares it — a sentence reworded at one end would otherwise
    /// simply never appear at the other.
    func testEveryWordIsDeclaredOnTheWeb() throws {
        let lib = try web(Self.lib)
        for (name, value) in [("WIKI_CONTENTS", WikiArticleCopy.contents), ("WIKI_DIRECTORY_HOME", WikiArticleCopy.home),
                              ("WIKI_BROWSE", WikiArticleCopy.browse), ("WIKI_AZ_INDEX", WikiArticleCopy.azIndex),
                              ("WIKI_OTHER_TOPICS", WikiArticleCopy.other), ("WIKI_FOOTNOTES", WikiArticleCopy.footnotes),
                              ("WIKI_ARTICLE_ENTRIES", WikiArticleCopy.entries),
                              ("WIKI_FOOTNOTE_GONE", WikiArticleCopy.footnoteGone),
                              ("WIKI_NO_ARTICLE_YET", WikiArticleCopy.noArticleYet),
                              ("WIKI_NO_ARTICLES", WikiArticleCopy.noArticles),
                              ("WIKI_TOPIC_OVERVIEW", WikiArticleCopy.topicOverview)] {
            assertDeclares(lib, name, value, in: Self.lib)
        }
        assertSays(lib, "`the ${wikiCount(count)} this article is written from, by kind`", in: Self.lib)
        let wiki = try web(Self.wikiLib)
        for (name, value) in [("WIKI_ACTION_OPEN", WikiArticleCopy.openEntry),
                              ("WIKI_GROUP_PRINCIPLES", WikiArticleCopy.groupPrinciples),
                              ("WIKI_GROUP_DECISIONS", WikiArticleCopy.groupDecisions),
                              ("WIKI_GROUP_PITFALLS", WikiArticleCopy.groupPitfalls),
                              ("WIKI_GROUP_RECIPES", WikiArticleCopy.groupRecipes),
                              ("WIKI_GROUP_CONCEPTS", WikiArticleCopy.groupConcepts),
                              ("WIKI_SHOW_LESS", WikiArticleCopy.showLess),
                              ("WIKI_TOPIC_MISSING", WikiArticleCopy.noTopicEntries)] {
            assertDeclares(wiki, name, value, in: Self.wikiLib)
        }
        let notes = try slice(wiki, from: "export const WIKI_GROUP_NOTES", to: "};")
        for (kind, note) in [("principle", WikiArticleCopy.notePrinciples), ("decision", WikiArticleCopy.noteDecisions),
                             ("pitfall", WikiArticleCopy.notePitfalls), ("recipe", WikiArticleCopy.noteRecipes),
                             ("concept", WikiArticleCopy.noteConcepts)] {
            assertSays(notes, "\(kind): '\(note)'", in: Self.wikiLib)
        }
        assertSays(wiki, "wikiShowMore = (count: number): string => `Show ${count} more`", in: Self.wikiLib)
        XCTAssertEqual(WikiArticleCopy.showMore(16), "Show 16 more")
        // The web's groups are the native's, in their order and with their kinds.
        let groups = try slice(wiki, from: "export const WIKI_TOPIC_GROUPS", to: "note: WIKI_GROUP_NOTES.concept }")
        assertOrder(groups, ["kinds: ['principle', 'convention'], title: WIKI_GROUP_PRINCIPLES",
                             "kinds: ['decision'], title: WIKI_GROUP_DECISIONS", "kinds: ['pitfall'], title: WIKI_GROUP_PITFALLS",
                             "kinds: ['recipe'], title: WIKI_GROUP_RECIPES", "kinds: ['concept'], title: WIKI_GROUP_CONCEPTS"],
                    "the topic groups")
        XCTAssertEqual(WikiArticleLogic.entryGroupKinds.map(\.kinds),
                       [[.principle, .convention], [.decision], [.pitfall], [.recipe], [.concept]])
        // The sentences built around a value, each the same expression at both ends.
        assertSays(lib, "wikiNoteLabel = (n: number): string => `[${n}]`", in: Self.lib)
        assertSays(lib, "wikiMoreArticles = (count: number): string => `${count} more`", in: Self.lib)
        assertSays(lib, "`${wikiArticleCount(count)} by title · Chinese titles by pinyin`", in: Self.lib)
        assertSays(lib, "return `Updated ${day}${at} · written by ${WIKI_HISTORY_MAINTENANCE} from ${wikiCount(article.entryCount)} ${",
                   in: Self.lib)
        assertSays(lib, "WIKI_BROWSE_SHOWN_PHONE = \(WikiArticleLogic.browseShown);", in: Self.lib)
    }

    // MARK: the readings

    func testTheDirectoryAndBrowseAreTheFixtures() throws {
        let shared = try fixture()
        let groups = WikiArticleLogic.directoryGroups(shared.directory.read)
        XCTAssertEqual(groups.map(\.title), shared.directory.groups.map(\.title))
        for (group, expected) in zip(groups, shared.directory.groups) {
            XCTAssertEqual(group.topics.map(\.slug), expected.topics.map(\.slug))
            XCTAssertEqual(group.topics.map(\.title), expected.topics.map(\.title))
            XCTAssertEqual(group.topics.map(\.count), expected.topics.map(\.count))
            XCTAssertEqual(group.topics.map { $0.parts.map(\.title) }, expected.topics.map(\.parts))
        }

        let categories = WikiArticleLogic.browseCategories(shared.directory.read)
        let totals = WikiArticleLogic.browseTotals(categories)
        XCTAssertEqual(WikiArticleCopy.browseSummary(articles: totals.articles, topics: totals.topics, entries: totals.entries),
                       shared.browse.summary)
        XCTAssertEqual(categories.map(\.title), shared.browse.categories.map(\.title))
        for (category, expected) in zip(categories, shared.browse.categories) {
            XCTAssertEqual(WikiArticleCopy.categorySummary(topics: category.topics, articles: category.articles,
                                                           entries: category.entries), expected.summary)
            XCTAssertEqual(category.rows.map(\.slug), expected.topics.map(\.slug))
            XCTAssertEqual(category.rows.map(\.title), expected.topics.map(\.title))
            XCTAssertEqual(category.rows.map { $0.hasArticle ? WikiArticleCopy.browseTopicLine(entries: $0.entries, articles: $0.articles) : nil },
                           expected.topics.map(\.line))
            XCTAssertEqual(category.rows.map(\.parts.count), expected.topics.map(\.parts))
        }
        XCTAssertEqual(WikiArticleLogic.browseShown, shared.browse.shownPhone)
    }

    /// The index files every title under the web's letter — Chinese by pinyin, the characters the old
    /// boundary string misfiled among the fixture's — in the web's order.
    func testTheIndexIsTheFixtures() throws {
        let shared = try fixture()
        for row in shared.initials {
            XCTAssertEqual(WikiArticleLogic.indexInitial(row.title), row.says, row.title)
        }
        XCTAssertEqual(WikiArticleCopy.indexSummary(shared.index.items.count), shared.index.summary)
        let groups = WikiArticleLogic.indexGroups(shared.index.items)
        XCTAssertEqual(groups.map(\.letter), shared.index.groups.map(\.letter))
        for (group, expected) in zip(groups, shared.index.groups) {
            XCTAssertEqual(group.items.map { $0.title ?? "" }, expected.rows.map(\.title), group.letter)
            XCTAssertEqual(group.items.map(WikiArticleLogic.indexMeta), expected.rows.map(\.meta), group.letter)
        }
        XCTAssertEqual(WikiArticleLogic.indexLetters, shared.orders.indexLetters)
    }

    /// The web derives a Chinese title's letter from where it falls in the pinyin collation; its
    /// boundary characters are pinned here, and each one reads as its own letter through
    /// `mandarinToLatin`, which is what the native index files by.
    func testTheWebsPinyinBoundariesAreTheNativeInitials() throws {
        let lib = try web(Self.lib)
        let letters = "ABCDEFGHJKLMNOPQRSTWXYZ"
        let boundaries = "阿丷嚓咑妸发旮哈丌咔垃呣拏喔妑七呥仨他屲夕丫帀"
        assertSays(lib, "const PINYIN_LETTERS = '\(letters)';", in: Self.lib)
        assertSays(lib, "const PINYIN_BOUNDARIES = '\(boundaries)';", in: Self.lib)
        for (letter, boundary) in zip(letters, boundaries) {
            XCTAssertEqual(WikiArticleLogic.indexInitial(String(boundary)), String(letter), String(boundary))
        }
        assertSays(lib, "new Intl.Collator('zh-u-co-pinyin')", in: Self.lib)
        // The same CJK blocks at both ends decide what is a Chinese title at all.
        assertSays(lib, "const HAN = /^[\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\u{20000}-\\u{2FFFF}]$/u;", in: Self.lib)
        XCTAssertTrue(WikiArticleLogic.isHan("会"))
        XCTAssertFalse(WikiArticleLogic.isHan("「"))
        XCTAssertFalse(WikiArticleLogic.isHan("A"))
    }

    func testAnArticlesReadingsAreTheFixtures() throws {
        let shared = try fixture()
        for row in shared.segments {
            XCTAssertEqual(WikiArticleLogic.segments(row.text).map { "\($0.kind.rawValue):\($0.text)" },
                           row.says.map { "\($0.kind):\($0.text)" }, row.text)
        }
        for row in shared.kindTags {
            XCTAssertEqual(WikiArticleLogic.kindTags(row.kinds.map { WikiEntryKind(rawValue: $0) }), row.says)
        }
        let entries = shared.articleGroups.entries.map {
            WikiEntry(id: $0.id, kind: WikiEntryKind(rawValue: $0.kind), status: .active, trust: .auto, title: $0.id,
                      validFrom: $0.validFrom)
        }
        let groups = WikiArticleLogic.entryGroups(entries, cited: shared.articleGroups.cited)
        XCTAssertEqual(groups.map(\.title), shared.articleGroups.groups.map(\.title))
        XCTAssertEqual(groups.map { $0.entries.map(\.id) }, shared.articleGroups.groups.map(\.ids))
        let sources = [
            WikiSource(id: "a", kind: .turn, ref: "s1", locator: .object(["turnId": .string("t1")]), quote: nil, quoteVerified: nil,
                       state: .live, tainted: nil, createdAt: nil),
            WikiSource(id: "b", kind: .turn, ref: "s1", locator: .object(["turnId": .string("t2")]), quote: nil, quoteVerified: nil,
                       state: .live, tainted: nil, createdAt: nil),
            WikiSource(id: "c", kind: .turn, ref: "t9", locator: nil, quote: nil, quoteVerified: nil, state: .live,
                       tainted: nil, createdAt: nil),
            WikiSource(id: "d", kind: .commit, ref: "abc", locator: nil, quote: nil, quoteVerified: nil, state: .live,
                       tainted: nil, createdAt: nil),
        ]
        let counts = WikiArticleLogic.sourceCounts(sources)
        XCTAssertEqual([counts.sources, counts.sessions], [4, 1])
    }

    // MARK: the orders

    /// An article's page: crumb, title, tags, when it was written, the text, the footnotes, the
    /// entries — the web page's order, the fixture's, and the native page's arms.
    func testAnArticlePageIsTheWebPhonesInItsOrder() throws {
        let shared = try fixture()
        XCTAssertEqual(WikiArticleLogic.Section.allCases.map(\.rawValue), shared.orders.articleSections)
        let lib = try web(Self.lib)
        assertSays(lib, "WIKI_ARTICLE_SECTIONS = ['crumb', 'title', 'tags', 'updated', 'body', 'footnotes', 'entries'] as const",
                   in: Self.lib)
        let page = try web(Self.articlePage)
        let article = try slice(page, from: "export function WikiArticlePage(", to: "function WikiArticleText(")
        assertOrder(article, ["<div className=\"wk-art-crumbrow\">", "<h1 className=\"t-title wk-art-title\">",
                              "<div className=\"wk-tags\">", "<div className=\"t-meta wk-art-updated\">", "<WikiArticleText",
                              "<section className=\"wk-fnlist\">", "<section className=\"wk-art-entries\">"],
                    "the web article's sections")
        let view = try native("Views/WikiArticleView.swift")
        let nativePage = try slice(view, from: "struct WikiArticlePage: View {", to: "struct WikiFootnoteCard: View {")
        assertSays(nativePage, "ForEach(WikiArticleLogic.Section.allCases, id: \\.self) { section in", in: "WikiArticleView.swift")
        let arms = try slice(nativePage, from: "switch section {", to: "private var crumb: some View {")
        assertOrder(arms, ["case .crumb:", "case .title:", "case .tags:", "case .updated:", "case .body:", "case .footnotes:",
                           "case .entries:"], "the native article's sections")
        // The footnote list's rows and the entries' heading say the same words at both ends.
        assertSays(article, "{WIKI_FOOTNOTES} <small>{wikiEntriesCited(article.footnotes.length)}</small>", in: Self.articlePage)
        assertSays(nativePage, "header(WikiArticleCopy.footnotes, hint: WikiArticleCopy.entriesCited(article.footnotes.count))",
                   in: "WikiArticleView.swift")
        // The entries it was written from, counted by what its read names (`entryIds`), at both ends.
        assertSays(article, "<small>{wikiArticleEntriesHint(article.entryIds.length)}</small>", in: Self.articlePage)
        assertSays(nativePage, "header(WikiArticleCopy.entries, hint: WikiArticleCopy.entriesHint(article.entryIds?.count ?? held.count))",
                   in: "WikiArticleView.swift")
        assertSays(article, "const entries = article.entries;", in: Self.articlePage)
        let screens = try native("Views/WikiScreens.swift")
        assertSays(screens, "WikiArticlePage(article: article, entries: article.entries ?? wiki.topicEntries[address.topic],",
                   in: "WikiScreens.swift")
        assertSays(article, "wikiArticleGroups(entries, cited)", in: Self.articlePage)
        assertSays(nativePage, "WikiArticleLogic.entryGroups(held, cited: article.footnotes.map(\\.entryId))", in: "WikiArticleView.swift")
        // A footnote opens a card: a popover on a desktop, a sheet on a phone — and on iOS.
        assertSays(page, "<Drawer placement=\"bottom\"", in: Self.articlePage)
        assertSays(nativePage, ".presentationDetents([.medium])", in: "WikiArticleView.swift")
    }

    /// The footnote card: number, kind and mark, title, summary, what backs it, Open entry.
    func testTheFootnoteCardIsTheWebsInItsOrder() throws {
        let page = try web(Self.articlePage)
        let card = try slice(page, from: "export function WikiFootnoteCard(", to: "WIKI_FOOTNOTE_GONE}</div>")
        assertOrder(card, ["<span className=\"num\">{wikiNoteLabel(note.n)}</span>", "<WikiKindMark",
                           "WIKI_KIND_LABELS[entry.kind as WikiEntryKind]", "<WikiTrustBadge", "<div className=\"t\">{entry.title}</div>",
                           "<div className=\"d\">{entry.summary}</div>", "wikiSourcesLine(counts.sources, counts.sessions)",
                           "{WIKI_ACTION_OPEN}"], "the web's footnote card")
        let view = try native("Views/WikiArticleView.swift")
        let nativeCard = try slice(view, from: "struct WikiFootnoteCard: View {", to: "struct WikiTag: Hashable {")
        assertOrder(nativeCard, ["Text(WikiArticleCopy.noteLabel(footnote.n))", "Image(systemName: WikiGlyph.kind(entry.kind))",
                                 "Text(WikiCopy.kindLabel(entry.kind ?? .unknown))", "WikiBadge(text: WikiCopy.trustLabel(trust)",
                                 "Text(entry.title ?? entry.id)", "Text(summary)", "footLine", "Text(WikiArticleCopy.openEntry)",
                                 "WikiArticleCopy.sourcesLine(sources: counts.sources, sessions: counts.sessions)"],
                    "the native footnote card")
    }

    /// The directory's first rows, then the categories — the web column and drawer, the native sheet.
    func testTheDirectoryIsTheWebsInItsOrder() throws {
        let shared = try fixture()
        XCTAssertEqual([WikiArticleCopy.home, WikiArticleCopy.browse, WikiArticleCopy.azIndex], shared.orders.directoryHead)
        let directory = try web(Self.directory)
        assertOrder(directory, ["{WIKI_DIRECTORY_HOME}", "{WIKI_BROWSE}", "{WIKI_AZ_INDEX}", "<div className=\"wk-toc-cat\">{group.title}</div>"],
                    "the web directory")
        let view = try native("Views/WikiArticleView.swift")
        let sheet = try slice(view, from: "struct WikiContentsSheet: View {", to: "struct WikiArticleActions {")
        assertOrder(sheet, ["row(WikiArticleCopy.home", "row(WikiArticleCopy.browse", "row(WikiArticleCopy.azIndex",
                            "ForEach(groups) { group in", "Text(group.title)"], "the native Contents sheet")
        assertSays(sheet, ".navigationTitle(WikiArticleCopy.contents)", in: "WikiArticleView.swift")
        assertSays(directory, "<b>{WIKI_CONTENTS}</b>", in: Self.directory)
    }

    /// Browse and the index: title, the line under it, then the categories or the letters' groups.
    /// The web's crumb row is the native bar's back button.
    func testBrowseAndTheIndexAreTheWebsInTheirOrder() throws {
        let shared = try fixture()
        XCTAssertEqual(shared.orders.browseSections, ["crumb", "title", "summary", "categories"])
        XCTAssertEqual(shared.orders.indexSections, ["crumb", "title", "summary", "letters", "groups"])
        let browse = try web(Self.browsePage)
        assertOrder(browse, ["<div className=\"wk-art-crumbrow\">", "<h1 className=\"t-title\">{WIKI_BROWSE}</h1>",
                             "wikiBrowseSummary(totals.articles, totals.topics, totals.entries)", "<section className=\"wk-browse-cat\"",
                             "wikiCategorySummary(category.topics, category.articles, category.entries)",
                             "wikiBrowseTopicLine(row.entries, row.articles)", "wikiMoreArticles(hidden)"], "the web's Browse")
        let index = try web(Self.indexPage)
        assertOrder(index, ["<div className=\"wk-art-crumbrow\">", "<h1 className=\"t-title\">{WIKI_AZ_INDEX}</h1>",
                            "wikiIndexSummary(items.length)", "<nav className=\"wk-az-bar\"", "<section className=\"wk-az-g\"",
                            "wikiIndexMeta(item)"], "the web's index")
        let view = try native("Views/WikiArticleView.swift")
        let nativeBrowse = try slice(view, from: "struct WikiBrowsePage: View {", to: "struct WikiIndexPage: View {")
        assertOrder(nativeBrowse, ["Text(WikiArticleCopy.browse)", "WikiArticleCopy.browseSummary(", "ForEach(categories) { category in",
                                   "WikiArticleCopy.categorySummary(", "WikiArticleCopy.browseTopicLine(", "WikiArticleCopy.moreArticles("],
                    "the native Browse")
        let nativeIndex = try slice(view, from: "struct WikiIndexPage: View {", to: "private struct WikiSectionIndexLabel")
        assertOrder(nativeIndex, ["Text(WikiArticleCopy.azIndex)", "WikiArticleCopy.indexSummary(count)", "ForEach(groups) { group in",
                                  "Text(group.letter)", "WikiArticleLogic.indexMeta(item)"], "the native index")
        // The system's section index stands where the web's letter bar is.
        assertSays(view, "content.sectionIndexLabel(Text(letter))", in: "WikiArticleView.swift")
        assertSays(view, "content.listSectionIndexVisibility(.visible)", in: "WikiArticleView.swift")
    }

    /// The home's bands on a phone, under its head (design §12.3.1): the line that says what the space holds,
    /// the search, the principles, the documents, then Browse · A–Z.
    func testTheHomeBandsAreTheFixtures() throws {
        let shared = try fixture()
        XCTAssertEqual(WikiLogic.HomeBand.allCases.map(\.rawValue), shared.orders.homeBands)
        XCTAssertEqual(WikiLogic.HomeBand.allCases.map(\.title), shared.orders.homeBandTitles)
    }

    // MARK: the wiring

    /// The Contents sheet from the home's bar, the three pages on the phone's stack and in the wide
    /// shells' detail pane, and every press through the section's own stack.
    func testThePagesAreWiredToTheStack() throws {
        let home = try native("Views/WikiView.swift")
        let page = try slice(home, from: "struct WikiHomePage: View {", to: "private struct WikiRowLabel: View {")
        let toolbar = try slice(page, from: ".toolbar {", to: ".task(id: query) {")
        assertOrder(toolbar, ["Button(action: actions.openContents)", "Image(systemName: \"list.bullet\")",
                              ".accessibilityLabel(WikiArticleCopy.contents)", "Button(action: actions.openSettings)"],
                    "the home's bar: Contents, then Settings")
        let screens = try native("Views/WikiScreens.swift")
        assertSays(screens, "openContents: { contentsShown = true })", in: "WikiScreens.swift")
        assertSays(screens, "WikiContentsScreen(at: .home) { pick in go(pick) }", in: "WikiScreens.swift")
        assertSays(screens, "case .article(let topic, let part): open(.wikiArticle(topic: topic, part: part))", in: "WikiScreens.swift")
        assertSays(screens, "case .article(let topic, let part): model.push(.wikiArticle(topic: topic, part: part))",
                   in: "WikiScreens.swift")
        let pane = try slice(screens, from: "struct WikiDetailPane: View {", to: "struct WikiContentsScreen: View {")
        assertOrder(pane, ["model.nav.selectedWikiArticle", "WikiArticleScreen(address: article).id(article)",
                           "model.nav.wikiBrowseOnTop", "WikiBrowseScreen()", "model.nav.wikiIndexOnTop", "WikiIndexScreen()"],
                    "the wide shells' detail pane")
        let shell = try native("Views/CompactShell.swift")
        let stack = try slice(shell, from: "case .wiki:\n            NavigationStack(path: $model.nav.path) {",
                              to: "default:                      EmptyView()")
        for arm in ["case .wikiArticle(let topic, let part):", "WikiArticleScreen(address: WikiArticleAddress(topic: topic, part: part))",
                    "case .wikiBrowse:             WikiBrowseScreen()", "case .wikiIndex:              WikiIndexScreen()"] {
            assertSays(stack, arm, in: "CompactShell.swift")
        }
        // The stack's own projections, not a second copy of it.
        var nav = NavState(section: .wiki)
        nav.push(.wikiArticle(topic: "ui-design", part: 1))
        XCTAssertEqual(nav.selectedWikiArticle, WikiArticleAddress(topic: "ui-design", part: 1))
        nav.push(.wikiBrowse)
        XCTAssertTrue(nav.wikiBrowseOnTop)
        XCTAssertNil(nav.selectedWikiArticle)
        nav.push(.wikiIndex)
        XCTAssertTrue(nav.wikiIndexOnTop)
        XCTAssertFalse(nav.wikiBrowseOnTop)
    }
}
