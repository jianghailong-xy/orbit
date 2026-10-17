import Foundation
import XCTest
@testable import OrbitKit

/// A document's page, the directory, Browse and the A–Z index by document say the web's words, count what
/// the web counts, and draw their blocks in the web phone's order (criterion 10 revised 2026-09-28, mocks 24,
/// 26, 28).
///
/// Three halves, each a failure — never an `XCTSkip` — when its counterpart goes missing:
/// - the `docs` cases of `src/shared/src/wiki-docs.fixture.json`, which the web's `lib/wikiDocs.test.ts` reads
///   too: a document's head, its marks and why, every kind of footnote — its place, the way to its original
///   and what went wrong — its entries; the directory's groups, Browse's lines, the index's letters and rows;
/// - every `WikiDocCopy` constant looked up as a declaration in the web source it mirrors;
/// - the order of a document page's blocks and a footnote card's parts, read out of the web page and the
///   native one alike, and the pages wired to the Wiki section's stack.
final class WikiDocsCopyParityTests: XCTestCase {

    private static let lib = "src/web/src/lib/wikiDocs.ts"
    private static let docPage = "src/web/src/components/WikiDocPage.tsx"
    private static let directory = "src/web/src/components/WikiDirectory.tsx"
    private static let browsePage = "src/web/src/components/WikiBrowsePage.tsx"
    private static let indexPage = "src/web/src/components/WikiIndexPage.tsx"
    private static let fixturePath = "src/shared/src/wiki-docs.fixture.json"
    private static let app = "src/macos/OrbitApp/Sources/OrbitApp/"

    private struct Missing: Error, CustomStringConvertible {
        let file: String
        var description: String {
            "\(file) was not found above this test file. The document pages are one half of a pair; if the other "
                + "half moved, move this check with it rather than deleting it."
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
        XCTAssertTrue(text.contains(single), "\(name) drifted: \(file) no longer declares it as \(value.debugDescription)", line: line)
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
        struct Docs: Decodable {
            struct Words: Decodable {
                let plan, question, writtenFor, covers, notCovered, scopeFolded, noSource, notVerified, withdrawn: String
                let rewritePending, needsReview, nextMarked, notWritten, sectionNotWritten, footnotes, viaEntry: String
                let noQuoteGiven, entries, openTheEntry, notWrittenShort: String
                let sectionKinds, footnoteKinds, verdictCard, verdictList: [String: String]
                let excerptLinesPhone, footnotesShown, groupShownPhone, browseSectionsShownPhone: Int
            }

            struct Orders: Decodable {
                let docSections: [String]
                let footnoteCard: [String]
            }

            struct Directory: Decodable {
                struct Group: Decodable {
                    struct Doc: Decodable {
                        struct Section: Decodable {
                            let key: String
                            let number: Int
                            let title: String
                            let written: Bool
                            let stale: Bool
                        }

                        let slug, number, title: String
                        let written, needsReview: Bool
                        let sections: [Section]
                    }

                    let key: String
                    let number: Int
                    let title: String
                    let docs: [Doc]
                }

                let read: WikiDocsDirectory
                let readsByDocs: Bool
                let groups: [Group]
            }

            struct Browse: Decodable {
                struct Category: Decodable {
                    struct Doc: Decodable {
                        struct State: Decodable {
                            let text: String
                            let tone: String
                        }

                        let slug: String
                        let sections: String
                        let state: State?
                    }

                    let key: String
                    let line: String
                    let docs: [Doc]
                }

                let summary: [String]
                let shownPhone: Int
                let categories: [Category]
            }

            struct Doc: Decodable {
                struct Legend: Decodable {
                    let mark: String
                    let label: String
                    let count: Int
                }

                struct Marked: Decodable {
                    struct Note: Decodable {
                        let title: String
                        let text: String
                        let see: Int?
                        let entryId: String?
                    }

                    let section: String
                    let block: Int
                    let sentence: Int
                    let mark: String
                    let label: String
                    let note: Note
                }

                struct Footnote: Decodable {
                    struct Open: Decodable {
                        struct To: Decodable {
                            let kind: String
                            let url: String?
                            let session: String?
                            let record: String?
                            let id: String?
                        }

                        let label: String
                        let to: To
                    }

                    struct Excerpt: Decodable {
                        struct Line: Decodable {
                            let n: Int
                            let text: String
                            let quoted: Bool
                        }

                        let lines: [Line]
                        let more: Int
                    }

                    let n: Int
                    let kindLabel: String
                    let sub: String?
                    let isRepo: Bool
                    let verdictCard, verdictList, `where`, place: String
                    let open: Open?
                    let problem: String?
                    let quote: String?
                    let listQuote: String
                    let excerpt: Excerpt?
                    let via: String?
                    let viaStatus: String?
                }

                struct Group: Decodable {
                    let title: String
                    let note: String
                    let ids: [String]
                }

                struct ViaNote: Decodable {
                    let id: String
                    let note: String?
                    let status: String?
                }

                let read: WikiDoc
                let tags, updated: [String]
                let warn: String?
                let needsReview: String
                let legend: [Legend]
                let rewrite: String?
                let scopeCounts: String
                let scopeTargets: [String]
                let marks: [Marked]
                let footnotes: [Footnote]
                let summary, entriesHint: String
                let entryGroups: [Group]
                let viaNotes: [ViaNote]
            }

            struct Fine: Decodable {
                let warn: String?
                let updated: [String]
            }

            struct NotWritten: Decodable {
                struct Note: Decodable {
                    struct Counts: Decodable {
                        let written: Int
                        let total: Int
                    }

                    let docs: Counts?
                    let says: String
                }

                let read: WikiDoc
                let updated: [String]
                let notes: [Note]
            }

            struct Index: Decodable {
                struct Group: Decodable {
                    struct Row: Decodable {
                        let title: String
                        let kind: String
                        let meta: String
                    }

                    let letter: String
                    let rows: [Row]
                }

                let items: [WikiDocsIndex.Item]
                let summary: String
                let groups: [Group]
            }

            struct Counts: Decodable {
                struct SectionList: Decodable {
                    let numbers: [Int]
                    let says: String
                }

                struct LineRange: Decodable {
                    let start: Int
                    let end: Int?
                    let says: String
                }

                struct Github: Decodable {
                    let repo: String?
                    let says: String?
                }

                struct MonthDayTime: Decodable {
                    let iso: String
                    let says: String?
                }

                let moreLines, moreSections, entriesHint, seeFootnote: [Says]
                let sectionLists: [SectionList]
                let lineRanges: [LineRange]
                let github: [Github]
                let monthDayTime: [MonthDayTime]
            }

            let words: Words
            let orders: Orders
            let directory: Directory
            let browse: Browse
            let doc: Doc
            let fine: Fine
            let notWritten: NotWritten
            let index: Index
            let counts: Counts
        }

        let timeZone: String
        let docs: Docs
    }

    private func fixture() throws -> Fixture {
        try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: find(Self.fixturePath)))
    }

    /// The fixture's document with some of its fields replaced, as the web spreads one over another.
    private func doc(overlaying fields: [String: Any]) throws -> WikiDoc {
        let data = try Data(contentsOf: find(Self.fixturePath))
        let root = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let docs = try XCTUnwrap(root["docs"] as? [String: Any])
        var read = try XCTUnwrap((docs["doc"] as? [String: Any])?["read"] as? [String: Any])
        for (key, value) in fields { read[key] = value }
        return try JSONDecoder().decode(WikiDoc.self, from: JSONSerialization.data(withJSONObject: read))
    }

    private func zone(_ shared: Fixture) throws -> TimeZone {
        try XCTUnwrap(TimeZone(identifier: shared.timeZone))
    }

    // MARK: the words

    func testTheWordsAreTheFixtures() throws {
        let words = try fixture().docs.words
        XCTAssertEqual([WikiDocCopy.plan, WikiDocCopy.question, WikiDocCopy.writtenFor, WikiDocCopy.covers, WikiDocCopy.notCovered,
                        WikiDocCopy.scopeFolded, WikiDocCopy.noSource, WikiDocCopy.notVerified, WikiDocCopy.withdrawn,
                        WikiDocCopy.rewritePending, WikiDocCopy.needsReview, WikiDocCopy.nextMarked, WikiDocCopy.notWritten,
                        WikiDocCopy.sectionNotWritten, WikiDocCopy.footnotes, WikiDocCopy.viaEntry, WikiDocCopy.noQuoteGiven,
                        WikiDocCopy.entries, WikiDocCopy.openTheEntry, WikiDocCopy.notWrittenShort],
                       [words.plan, words.question, words.writtenFor, words.covers, words.notCovered, words.scopeFolded,
                        words.noSource, words.notVerified, words.withdrawn, words.rewritePending, words.needsReview,
                        words.nextMarked, words.notWritten, words.sectionNotWritten, words.footnotes, words.viaEntry,
                        words.noQuoteGiven, words.entries, words.openTheEntry, words.notWrittenShort])
        for kind in WikiPlanSectionKind.allCases where kind != .unknown {
            XCTAssertEqual(WikiDocCopy.sectionKind(kind), words.sectionKinds[kind.rawValue], kind.rawValue)
        }
        for kind in WikiDocFootnoteKind.allCases where kind != .unknown {
            XCTAssertEqual(WikiDocCopy.footnoteKind(kind), words.footnoteKinds[kind.rawValue], kind.rawValue)
        }
        for verdict in WikiDocVerdict.allCases where verdict != .unknown {
            XCTAssertEqual(WikiDocCopy.verdictCard(verdict), words.verdictCard[verdict.rawValue], verdict.rawValue)
            XCTAssertEqual(WikiDocCopy.verdictList(verdict), words.verdictList[verdict.rawValue], verdict.rawValue)
        }
        XCTAssertEqual([WikiDocCopy.excerptLinesPhone, WikiDocCopy.footnotesShown, WikiDocCopy.groupShownPhone,
                        WikiDocCopy.browseSectionsShownPhone],
                       [words.excerptLinesPhone, words.footnotesShown, words.groupShownPhone, words.browseSectionsShownPhone])
    }

    func testTheCountsAreTheFixtures() throws {
        let shared = try fixture()
        let counts = shared.docs.counts
        for row in counts.moreLines { XCTAssertEqual(WikiDocCopy.moreLines(row.n), row.says) }
        for row in counts.moreSections { XCTAssertEqual(WikiDocCopy.moreSections(row.n), row.says) }
        for row in counts.entriesHint { XCTAssertEqual(WikiDocCopy.entriesHint(row.n), row.says) }
        for row in counts.seeFootnote { XCTAssertEqual(WikiDocCopy.seeFootnote(row.n), row.says) }
        for row in counts.sectionLists { XCTAssertEqual(WikiDocCopy.sectionList(row.numbers), row.says) }
        for row in counts.lineRanges { XCTAssertEqual(WikiDocLogic.lineRange(row.start, row.end), row.says) }
        for row in counts.github { XCTAssertEqual(WikiDocLogic.githubRepo(row.repo), row.says, row.repo ?? "nil") }
        for row in counts.monthDayTime { XCTAssertEqual(WikiDocCopy.monthDayTime(row.iso, timeZone: try zone(shared)), row.says) }
    }

    /// Every constant, as the web source declares it — a sentence reworded at one end would otherwise simply
    /// never appear at the other.
    func testEveryWordIsDeclaredOnTheWeb() throws {
        let lib = try web(Self.lib)
        for (name, value) in [("WIKI_DIRECTORY_PLAN", WikiDocCopy.plan), ("WIKI_DOC_QUESTION", WikiDocCopy.question),
                              ("WIKI_DOC_WRITTEN_FOR", WikiDocCopy.writtenFor), ("WIKI_DOC_COVERS", WikiDocCopy.covers),
                              ("WIKI_DOC_NOT_COVERED", WikiDocCopy.notCovered), ("WIKI_MARK_NO_SOURCE", WikiDocCopy.noSource),
                              ("WIKI_MARK_NOT_VERIFIED", WikiDocCopy.notVerified), ("WIKI_MARK_WITHDRAWN", WikiDocCopy.withdrawn),
                              ("WIKI_REWRITE_PENDING", WikiDocCopy.rewritePending), ("WIKI_DOC_NEEDS_REVIEW", WikiDocCopy.needsReview),
                              ("WIKI_NEXT_MARKED", WikiDocCopy.nextMarked), ("WIKI_DOC_NOT_WRITTEN", WikiDocCopy.notWritten),
                              ("WIKI_DOC_SECTION_NOT_WRITTEN", WikiDocCopy.sectionNotWritten),
                              ("WIKI_DOC_FOOTNOTES", WikiDocCopy.footnotes), ("WIKI_VIA_ENTRY", WikiDocCopy.viaEntry),
                              ("WIKI_NO_QUOTE_GIVEN", WikiDocCopy.noQuoteGiven), ("WIKI_DOC_ENTRIES", WikiDocCopy.entries),
                              ("WIKI_OPEN_THE_ENTRY", WikiDocCopy.openTheEntry)] {
            assertDeclares(lib, name, value, in: Self.lib)
        }
        assertSays(lib, "WIKI_DOC_SCOPE_FOLDED = `${WIKI_DOC_WRITTEN_FOR} · ${WIKI_DOC_COVERS} · ${WIKI_DOC_NOT_COVERED}`", in: Self.lib)
        assertSays(lib, "WIKI_EXCERPT_LINES_PHONE = \(WikiDocCopy.excerptLinesPhone);", in: Self.lib)
        assertSays(lib, "WIKI_FOOTNOTES_SHOWN = \(WikiDocCopy.footnotesShown);", in: Self.lib)
        assertSays(lib, "WIKI_DOC_GROUP_SHOWN_PHONE = \(WikiDocCopy.groupShownPhone);", in: Self.lib)
        assertSays(lib, "WIKI_BROWSE_SECTIONS_SHOWN_PHONE = \(WikiDocCopy.browseSectionsShownPhone);", in: Self.lib)
        // The labels' tables, key by key.
        let kinds = try slice(lib, from: "export const WIKI_SECTION_KIND_LABELS", to: "};")
        for kind in WikiPlanSectionKind.allCases where kind != .unknown {
            assertSays(kinds, "\(kind.rawValue): '\(WikiDocCopy.sectionKind(kind))'", in: Self.lib)
        }
        let footnotes = try slice(lib, from: "export const WIKI_FOOTNOTE_KIND_LABELS", to: "};")
        for kind in WikiDocFootnoteKind.allCases where kind != .unknown {
            assertSays(footnotes, "\(kind.rawValue): '\(WikiDocCopy.footnoteKind(kind))'", in: Self.lib)
        }
        let card = try slice(lib, from: "export const WIKI_VERDICT_CARD", to: "};")
        let list = try slice(lib, from: "export const WIKI_VERDICT_LIST", to: "};")
        for verdict in WikiDocVerdict.allCases where verdict != .unknown {
            assertSays(card, "\(verdict.rawValue): '\(WikiDocCopy.verdictCard(verdict))'", in: Self.lib)
            assertSays(list, "\(verdict.rawValue): '\(WikiDocCopy.verdictList(verdict))'", in: Self.lib)
        }
        // The sentences built around a value, each the same expression at both ends.
        assertSays(lib, "wikiMoreLines = (count: number): string => `… ${plural(count, 'more line', 'more lines')}`", in: Self.lib)
        assertSays(lib, "`the ${wikiCount(count)} this document’s quotes came through, by kind`", in: Self.lib)
        assertSays(lib, "wikiSeeFootnote = (n: number): string => `See footnote [${n}]`", in: Self.lib)
        assertSays(lib, "`${wikiSectionList(stale)} rewritten at the next run`", in: Self.lib)
        assertSays(lib, "`Wiki maintenance writes it on its next run${count}. What it will cover is below.`", in: Self.lib)
        assertSays(lib, "label: `Open on GitHub at ${shortSha(note.sha)} ↗`", in: Self.lib)
        for label in ["Open at this turn", "Open at this event", "Open at this tool call", "Open the task", "Open the comment",
                      "Open the session", "Open the project"] {
            assertSays(lib, "label: '\(label)'", in: Self.lib)
        }
        // The home's (design §12.3.1): what the space holds under the head, the folded rows, a new space's card.
        assertDeclares(lib, "WIKI_NO_DOCUMENTS_NOTE", WikiDocCopy.noDocumentsNote, in: Self.lib)
        assertSays(lib, "wikiDocsWritten = (total: number, written: number): string => "
                   + "`${plural(total, 'document', 'documents')} · ${wikiCount(written)} written`;", in: Self.lib)
        assertSays(lib, "wikiNotWrittenYet = (count: number): string => `+${wikiCount(count)} not written yet`;", in: Self.lib)
        assertSays(lib, "wikiDocsNotWrittenYet = (count: number): string => "
                   + "`${plural(count, 'document', 'documents')} · ${WIKI_DOC_NOT_WRITTEN_SHORT}`;", in: Self.lib)
    }

    // MARK: the readings

    func testADocumentsHeadIsTheFixtures() throws {
        let shared = try fixture()
        let expected = shared.docs.doc
        let doc = expected.read
        let tz = try zone(shared)
        XCTAssertEqual(WikiDocLogic.tags(doc), expected.tags)
        XCTAssertEqual(WikiDocLogic.updatedParts(doc, timeZone: tz), expected.updated)
        XCTAssertEqual(WikiDocLogic.updatedWarn(doc), expected.warn)
        XCTAssertEqual(WikiDocLogic.needsReviewText(doc), expected.needsReview)
        XCTAssertEqual(WikiDocLogic.legend(doc).map { "\($0.mark.rawValue):\($0.label):\($0.count)" },
                       expected.legend.map { "\($0.mark):\($0.label):\($0.count)" })
        XCTAssertEqual(WikiDocLogic.rewriteNote(doc.sections ?? []), expected.rewrite)
        XCTAssertEqual(WikiDocLogic.scopeCounts(doc), expected.scopeCounts)
        XCTAssertEqual((doc.scopeOut ?? []).flatMap { ($0.docs ?? []).map(WikiDocLogic.scopeTarget) }, expected.scopeTargets)
        XCTAssertEqual(WikiDocLogic.footnotesSummary(doc.footnotes ?? []), expected.summary)
        XCTAssertEqual(WikiDocCopy.entriesHint((doc.entries ?? []).count), expected.entriesHint)

        // A document under the threshold, and one no run has written.
        let fine = try self.doc(overlaying: ["written": true, "status": "ok",
                                             "counts": ["sentences": 40, "sourced": 36, "transition": 2, "unsourced": 1, "unverified": 1, "withdrawn": 0]])
        XCTAssertEqual(WikiDocLogic.updatedWarn(fine), shared.docs.fine.warn)
        XCTAssertEqual(WikiDocLogic.updatedParts(fine, timeZone: tz), shared.docs.fine.updated)
        XCTAssertEqual(WikiDocLogic.updatedParts(shared.docs.notWritten.read, timeZone: tz), shared.docs.notWritten.updated)
        for row in shared.docs.notWritten.notes {
            XCTAssertEqual(WikiDocLogic.notWrittenNote(written: row.docs?.written, total: row.docs?.total), row.says)
        }
    }

    func testEveryMarkedSentenceSaysWhyInTheWebsWords() throws {
        let shared = try fixture()
        let doc = shared.docs.doc.read
        var marked: [String] = []
        for section in doc.sections ?? [] {
            for (b, block) in (section.blocks ?? []).enumerated() {
                for (s, sentence) in (block.sentences ?? []).enumerated() {
                    guard let mark = WikiDocLogic.mark(sentence) else { continue }
                    let note = try XCTUnwrap(WikiDocLogic.markNote(sentence, section: section, doc: doc, timeZone: try zone(shared)))
                    marked.append("\(section.key).\(b).\(s) \(mark.rawValue) \(mark.label) | \(note.title) \(note.text) | \(note.see.map(String.init) ?? "-") | \(note.entryId ?? "-")")
                }
            }
        }
        XCTAssertEqual(marked, shared.docs.doc.marks.map {
            "\($0.section).\($0.block).\($0.sentence) \($0.mark) \($0.label) | \($0.note.title) \($0.note.text) | \($0.note.see.map(String.init) ?? "-") | \($0.note.entryId ?? "-")"
        })
    }

    func testEveryFootnoteReadsAsTheFixtureReadsIt() throws {
        let shared = try fixture()
        let doc = shared.docs.doc.read
        let tz = try zone(shared)
        let github = WikiDocLogic.githubRepo("github.com/jianghailong-xy/orbit")
        let entries = doc.entries ?? []
        for expected in shared.docs.doc.footnotes {
            let note = try XCTUnwrap(doc.footnotes?.first { $0.n == expected.n })
            let at = "[\(note.n)]"
            XCTAssertEqual(WikiDocCopy.footnoteKind(note.kind), expected.kindLabel, at)
            XCTAssertEqual(WikiDocLogic.subLabel(note), expected.sub, at)
            XCTAssertEqual(WikiDocLogic.isRepo(note), expected.isRepo, at)
            XCTAssertEqual(WikiDocCopy.verdictCard(note.verdict), expected.verdictCard, at)
            XCTAssertEqual(WikiDocCopy.verdictList(note.verdict), expected.verdictList, at)
            XCTAssertEqual(WikiDocLogic.footnoteWhere(note, timeZone: tz), expected.where, at)
            XCTAssertEqual(WikiDocLogic.footnotePlace(note, timeZone: tz), expected.place, at)
            XCTAssertEqual(WikiDocLogic.footnoteProblem(note), expected.problem, at)
            XCTAssertEqual(note.quote.map(WikiDocLogic.quoted), expected.quote, at)
            XCTAssertEqual(note.quote.map(WikiDocLogic.quoted) ?? WikiDocCopy.noQuoteGiven, expected.listQuote, at)
            let entry = note.viaEntryId.flatMap { id in entries.first { $0.id == id } }
            XCTAssertEqual(entry?.title, expected.via, at)
            XCTAssertEqual(entry.flatMap(WikiDocLogic.viaEntryStatus), expected.viaStatus, at)

            let open = WikiDocLogic.footnoteOpen(note, github: github)
            XCTAssertEqual(open?.label, expected.open?.label, at)
            switch (open?.target, expected.open?.to) {
            case (nil, nil): break
            case (.external(let url)?, let to?): XCTAssertEqual([to.kind, url.absoluteString], ["external", to.url ?? ""], at)
            case (.sessionRecord(let session, let record)?, let to?):
                XCTAssertEqual([to.kind, session, record], ["sessionRecord", to.session ?? "", to.record ?? ""], at)
                XCTAssertEqual(note.sessionRecordURL, SessionRecordLink.url(session: session, record: record), at)
            case (.task(let id)?, let to?): XCTAssertEqual([to.kind, id], ["task", to.id ?? ""], at)
            case (.session(let id)?, let to?): XCTAssertEqual([to.kind, id], ["session", to.id ?? ""], at)
            case (.project(let id)?, let to?): XCTAssertEqual([to.kind, id], ["project", to.id ?? ""], at)
            default: XCTFail("\(at) opens \(String(describing: open?.target)), the fixture \(String(describing: expected.open?.to.kind))")
            }

            let excerpt = note.kind != .designDoc && WikiDocLogic.isRepo(note) && note.excerpt != nil
                ? WikiDocLogic.excerptLines(note, shown: WikiDocCopy.excerptLinesPhone) : nil
            XCTAssertEqual(excerpt?.lines.map { "\($0.n) \($0.quoted) \($0.text)" }, expected.excerpt?.lines.map { "\($0.n) \($0.quoted) \($0.text)" }, at)
            XCTAssertEqual(excerpt?.more, expected.excerpt?.more, at)
        }
        // Every footnote the fixture reads is one of the document's, and every kind the page has a word for is among them.
        XCTAssertEqual(shared.docs.doc.footnotes.map(\.n), (doc.footnotes ?? []).map(\.n))
    }

    func testTheEntriesUnderTheDocumentAreTheFixtures() throws {
        let shared = try fixture()
        let doc = shared.docs.doc.read
        let groups = WikiDocLogic.entryGroups(doc.entries ?? [])
        XCTAssertEqual(groups.map(\.title), shared.docs.doc.entryGroups.map(\.title))
        XCTAssertEqual(groups.map(\.note), shared.docs.doc.entryGroups.map(\.note))
        XCTAssertEqual(groups.map { $0.entries.map(\.id) }, shared.docs.doc.entryGroups.map(\.ids))
        for expected in shared.docs.doc.viaNotes {
            let entry = try XCTUnwrap(doc.entries?.first { $0.id == expected.id })
            XCTAssertEqual(WikiDocLogic.viaEntryNote(entry, doc: doc), expected.note, expected.id)
            XCTAssertEqual(WikiDocLogic.viaEntryStatus(entry), expected.status, expected.id)
        }
    }

    func testTheDirectoryBrowseAndIndexAreTheFixtures() throws {
        let shared = try fixture()
        let read = shared.docs.directory.read
        XCTAssertEqual(WikiDocLogic.readsByDocs(read), shared.docs.directory.readsByDocs)
        XCTAssertFalse(WikiDocLogic.readsByDocs(nil))
        let groups = WikiDocLogic.directoryGroups(read)
        XCTAssertEqual(groups.map(\.key), shared.docs.directory.groups.map(\.key))
        XCTAssertEqual(groups.map(\.number), shared.docs.directory.groups.map(\.number))
        XCTAssertEqual(groups.map(\.title), shared.docs.directory.groups.map(\.title))
        for (group, expected) in zip(groups, shared.docs.directory.groups) {
            XCTAssertEqual(group.docs.map { "\($0.slug) \($0.number) \($0.title) \($0.written) \($0.needsReview)" },
                           expected.docs.map { "\($0.slug) \($0.number) \($0.title) \($0.written) \($0.needsReview)" })
            XCTAssertEqual(group.docs.map { $0.sections.map { "\($0.key) \($0.number) \($0.title) \($0.written) \($0.stale)" } },
                           expected.docs.map { $0.sections.map { "\($0.key) \($0.number) \($0.title) \($0.written) \($0.stale)" } })
        }

        XCTAssertEqual(WikiDocLogic.browseSummary(read), shared.docs.browse.summary)
        let categories = read.categories.filter { !($0.docs ?? []).isEmpty }
        XCTAssertEqual(categories.map(\.key), shared.docs.browse.categories.map(\.key))
        for (category, expected) in zip(categories, shared.docs.browse.categories) {
            XCTAssertEqual(WikiDocLogic.categoryLine(category), expected.line)
            XCTAssertEqual((category.docs ?? []).map { doc -> String in
                let line = WikiDocLogic.docLine(doc)
                return "\(doc.slug) \(line.sections) \(line.state.map { "\($0.text)/\($0.tone)" } ?? "-")"
            }, expected.docs.map { "\($0.slug) \($0.sections) \($0.state.map { "\($0.text)/\($0.tone)" } ?? "-")" })
        }
        XCTAssertEqual(WikiDocCopy.browseSectionsShownPhone, shared.docs.browse.shownPhone)

        XCTAssertEqual(WikiDocLogic.indexSummary(shared.docs.index.items), shared.docs.index.summary)
        let index = WikiDocLogic.indexGroups(shared.docs.index.items)
        XCTAssertEqual(index.map(\.letter), shared.docs.index.groups.map(\.letter))
        for (group, expected) in zip(index, shared.docs.index.groups) {
            XCTAssertEqual(group.items.map { "\($0.title) | \($0.kind) | \(WikiDocLogic.indexMeta($0))" },
                           expected.rows.map { "\($0.title) | \($0.kind) | \($0.meta)" }, group.letter)
        }
    }

    /// The fixture's read with each written document given a lead, as a server that writes them answers —
    /// and, with `planned` false, no plan confirmed — the web test's own spreads over the same read.
    private func homeRead(_ read: WikiDocsDirectory, leads: Bool, planned: Bool = true) throws -> WikiDocsDirectory {
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(read)) as? [String: Any])
        if !planned { object["plan"] = NSNull() }
        if leads {
            object["categories"] = (object["categories"] as? [[String: Any]] ?? []).map { category -> [String: Any] in
                var category = category
                category["docs"] = (category["docs"] as? [[String: Any]] ?? []).map { doc -> [String: Any] in
                    var doc = doc
                    if doc["written"] as? Bool == true { doc["lead"] = "\(doc["title"] as? String ?? "") 的头两句。" }
                    return doc
                }
                return category
            }
        }
        return try JSONDecoder().decode(WikiDocsDirectory.self, from: JSONSerialization.data(withJSONObject: object))
    }

    /// The home by the confirmed plan (design §12.3.1, mocks 30 ③, 31 ①) over the fixture's directory read, case
    /// for case as the web's `lib/wikiDocs.test.ts` reads it: the line under the head, the folded rows, each
    /// category's written documents with their leads and the rest after them, and what is new to the reader.
    func testTheHomeByTheConfirmedPlanIsTheFixtures() throws {
        let read = try fixture().docs.directory.read
        let led = try homeRead(read, leads: true)
        XCTAssertEqual(WikiDocLogic.homeLine(read, articles: 0), "5 documents · 3 written")
        XCTAssertEqual(WikiDocCopy.docsWritten(total: 35, written: 5), "35 documents · 5 written")
        XCTAssertEqual(WikiDocCopy.docsWritten(total: 1, written: 0), "1 document · 0 written")
        XCTAssertEqual(WikiDocCopy.docsWritten(total: 1200, written: 1000), "1,200 documents · 1,000 written")
        let unplanned = try homeRead(read, leads: false, planned: false)
        XCTAssertEqual(WikiDocLogic.homeLine(unplanned, articles: 12), "12 articles")
        XCTAssertEqual(WikiDocLogic.homeLine(unplanned, articles: 1), "1 article")
        XCTAssertEqual(WikiDocLogic.homeLine(nil, articles: 0), WikiCopy.noDocuments)
        XCTAssertEqual(WikiDocCopy.notWrittenYet(3), "+3 not written yet")
        XCTAssertEqual(WikiDocCopy.docsNotWrittenYet(3), "3 documents · \(WikiDocCopy.notWrittenShort)")
        XCTAssertEqual(WikiDocCopy.docsNotWrittenYet(1), "1 document · Not written yet")

        let seen = try XCTUnwrap(RelativeTime.parse("2026-09-28T11:00:00.000Z")).timeIntervalSince1970
        let categories = WikiDocLogic.homeCategories(led, seen: seen)
        XCTAssertEqual(categories.map(\.number), [1, 3, 4], "a category with no document is left out")
        XCTAssertEqual(categories.map { $0.written.map { "\($0.number) \($0.title)\($0.fresh ? " •" : "")" } },
                       [["1.1 产品定位与使用场景"], ["3.1 会话运行模型与长连接 •", "3.2 会话状态生命周期 •"], []])
        XCTAssertEqual(categories.map(WikiDocLogic.notWrittenRow), [nil, "+1 not written yet", "1 document · Not written yet"])
        XCTAssertEqual(categories.map { $0.notWritten.map(\.number) }, [[], ["3.3"], ["4.1"]])
        XCTAssertEqual(categories[1].written[0].lead, "会话运行模型与长连接 的头两句。")
        // A read from before the lead, or a document whose first section says nothing yet: no line under the title.
        XCTAssertNil(WikiDocLogic.homeCategories(read, seen: seen)[1].written[0].lead)

        // Every written document is new to a reader who has not looked before; none to one who looked since;
        // and none before the stamp is read at all.
        let fresh = { (seen: Double?) in WikiDocLogic.homeCategories(led, seen: seen).flatMap { $0.written.map(\.fresh) } }
        XCTAssertEqual(fresh(0), [true, true, true])
        XCTAssertEqual(fresh(try XCTUnwrap(RelativeTime.parse("2026-09-29T00:00:00.000Z")).timeIntervalSince1970),
                       [false, false, false])
        XCTAssertEqual(fresh(nil), [false, false, false])

        // The web's readings, line for line.
        let lib = try web(Self.lib)
        assertSays(lib, "if (directory && wikiReadsByDocs(directory)) return wikiDocsWritten(directory.docs.total, directory.docs.written);",
                   in: Self.lib)
        assertSays(lib, "return articles > 0 ? wikiArticleCount(articles) : WIKI_NO_DOCUMENTS;", in: Self.lib)
        assertSays(lib, "fresh: seen <= 0 || (doc.updatedAt !== null && Date.parse(doc.updatedAt) > seen),", in: Self.lib)
        assertSays(lib, "return category.written.length > 0 ? wikiNotWrittenYet(category.notWritten.length) : "
                   + "wikiDocsNotWrittenYet(category.notWritten.length);", in: Self.lib)
    }

    // MARK: the orders

    func testTheOrdersAreTheFixtures() throws {
        let shared = try fixture()
        XCTAssertEqual(WikiDocLogic.Section.allCases.map(\.rawValue), shared.docs.orders.docSections)
        XCTAssertEqual(WikiDocLogic.CardPart.allCases.map(\.rawValue), shared.docs.orders.footnoteCard)
        let lib = try web(Self.lib)
        assertSays(lib, "WIKI_DOC_SECTIONS = ['crumb', 'title', 'tags', 'updated', 'review', 'scope', 'body', 'footnotes', 'entries'] as const",
                   in: Self.lib)
        assertSays(lib, "WIKI_FOOTNOTE_CARD_PARTS = ['head', 'quote', 'problem', 'place', 'via', 'open'] as const", in: Self.lib)
    }
    // MARK: the pages, block for block

    /// A document's page: crumb, title, tags, when it was written, the banner, the reader and scope, the text,
    /// the footnotes, the entries — the web page's order, the fixture's, and the native page's arms.
    func testADocumentPageIsTheWebPhonesInItsOrder() throws {
        let page = try web(Self.docPage)
        let webDoc = try slice(page, from: "export function WikiDocPage(", to: "function WikiDocReviewBanner(")
        assertOrder(webDoc, ["<div className=\"wk-art-crumbrow\">", "<h1 className=\"t-title wk-art-title\">{doc.title}</h1>",
                             "<div className=\"wk-tags\">", "{updated.join(' · ')}", "<WikiDocReviewBanner doc={doc} />", "<WikiDocScope",
                             "<WikiDocSectionText", "<WikiDocFootnoteList", "<WikiDocEntries"], "the web document's blocks")
        let view = try native("Views/WikiDocView.swift")
        let nativePage = try slice(view, from: "struct WikiDocPage: View {", to: "struct WikiDocMarkLabel: View {")
        assertSays(nativePage, "ForEach(WikiDocLogic.Section.allCases, id: \\.self) { section in", in: "WikiDocView.swift")
        let arms = try slice(nativePage, from: "switch section {", to: "private var updated: some View {")
        assertOrder(arms, ["case .crumb:", "case .title:", "case .tags:", "case .updated:", "case .review:", "case .scope:", "case .body:",
                           "case .footnotes:", "case .entries:"], "the native document's blocks")
        // The same words at both ends: the head, the banner, the scope folded on a phone, the section marks.
        assertSays(webDoc, "wikiDocTags(doc)", in: Self.docPage)
        assertSays(nativePage, "WikiDocLogic.tags(doc)", in: "WikiDocView.swift")
        assertSays(page, "{WIKI_DOC_NEEDS_REVIEW}</b> · {wikiDocNeedsReviewText(doc)}", in: Self.docPage)
        assertSays(nativePage, "Text(WikiDocCopy.needsReview).bold().foregroundColor(.orange) + Text(\" · \") + Text(WikiDocLogic.needsReviewText(doc))",
                   in: "WikiDocView.swift")
        assertSays(page, "<span>{WIKI_DOC_SCOPE_FOLDED}</span>", in: Self.docPage)
        assertSays(nativePage, "Text(WikiDocCopy.scopeFolded)", in: "WikiDocView.swift")
        assertSays(page, "{WIKI_REWRITE_PENDING}", in: Self.docPage)
        assertSays(nativePage, "Label(WikiDocCopy.rewritePending", in: "WikiDocView.swift")
        assertSays(page, "{WIKI_MARK_LABELS[mark]}", in: Self.docPage)
        assertSays(nativePage, "AttributedString(\" \\(mark.label) \")", in: "WikiDocView.swift")
        assertSays(page, "{wikiFootnotesSummary(doc.footnotes)}", in: Self.docPage)
        assertSays(nativePage, "header(WikiDocCopy.footnotes, hint: WikiDocLogic.footnotesSummary(footnotes))", in: "WikiDocView.swift")
        assertSays(page, "{WIKI_DOC_ENTRIES} <small>{wikiDocEntriesHint(doc.entries.length)}</small>", in: Self.docPage)
        assertSays(nativePage, "header(WikiDocCopy.entries, hint: WikiDocCopy.entriesHint(entries.count))", in: "WikiDocView.swift")
        // A footnote on a phone is a sheet from the bottom, at both ends.
        assertSays(page, "<Drawer placement=\"bottom\"", in: Self.docPage)
        assertSays(nativePage, ".presentationDetents([.medium, .large])", in: "WikiDocView.swift")
    }

    /// A footnote's card: its head, the words or the lines, what went wrong, where, the entry it came
    /// through as one row, and the one button that opens the original (owner's call 2026-09-29).
    func testTheFootnoteCardIsTheWebsInItsOrder() throws {
        let page = try web(Self.docPage)
        let card = try slice(page, from: "export function WikiDocFootnoteCard(", to: "function WikiDocFootnoteList(")
        assertOrder(card, ["<span className=\"num\">[{note.n}]</span>", "{WIKI_FOOTNOTE_KIND_LABELS[note.kind]}", "{WIKI_VERDICT_CARD[note.verdict]}",
                           "{wikiQuoted(note.quote)}", "<div className=\"xnote\">{problem}</div>", "{wikiFootnotePlace(note)}", "{WIKI_VIA_ENTRY}",
                           "{open.label}"], "the web's footnote card")
        let view = try native("Views/WikiDocView.swift")
        let sheet = try slice(view, from: "struct WikiDocFootnoteSheet: View {", to: "static func glyph(")
        assertSays(sheet, "ForEach(WikiDocLogic.CardPart.allCases, id: \\.self) { part in", in: "WikiDocView.swift")
        assertOrder(sheet, ["case .head:", "WikiDocCopy.footnoteKind(footnote.kind)", "WikiDocCopy.verdictCard(footnote.verdict)", "case .quote:",
                            "WikiDocLogic.quoted(quote)", "case .problem:", "WikiDocLogic.footnoteProblem(footnote)", "case .place:",
                            "WikiDocLogic.footnotePlace(footnote)", "case .via:", "Text(WikiDocCopy.viaEntry)", "case .open:", "Text(open.label)"],
                    "the native footnote sheet")
        // The button opens the original, never the entry: the entry is the Via entry row above it.
        assertSays(sheet, "Button { openSource(open.target) } label: {", in: "WikiDocView.swift")
        let screens = try native("Views/WikiDocScreens.swift")
        assertSays(screens, "model.openOrbitLink(SessionRecordLink.url(session: session, record: record))", in: "WikiDocScreens.swift")
        assertSays(screens, "case .external(let url): model.openExternal(url)", in: "WikiDocScreens.swift")
    }

    /// The Contents sheet: Home, Browse, the A–Z index and the Plan with its count, then the plan's
    /// categories and documents — the web column and drawer, the native sheet.
    func testTheContentsListThePlanAndItsDocuments() throws {
        let directory = try web(Self.directory)
        assertOrder(directory, ["{WIKI_DIRECTORY_HOME}", "{WIKI_BROWSE}", "{WIKI_AZ_INDEX}", "{WIKI_DIRECTORY_PLAN}", "<WikiDocGroupRows"],
                    "the web directory")
        assertSays(directory, "wikiPlanPending(plan.data, maintenance.runnerOnline)", in: Self.directory)
        let view = try native("Views/WikiArticleView.swift")
        let sheet = try slice(view, from: "struct WikiContentsSheet: View {", to: "struct WikiArticleActions {")
        assertOrder(sheet, ["row(WikiArticleCopy.home", "row(WikiArticleCopy.browse", "row(WikiArticleCopy.azIndex", "planRow",
                            "WikiDocContentsRows(groups: docGroups"], "the native Contents sheet")
        assertSays(sheet, "Text(WikiDocCopy.plan)", in: "WikiArticleView.swift")
        let screens = try native("Views/WikiScreens.swift")
        assertSays(screens, "planPending: wiki.plan.map { WikiPlanLogic.pending($0, runnerOnline: model.wikiMaintenanceRunnerOnline) } ?? 0",
                   in: "WikiScreens.swift")
        let rows = try slice(try native("Views/WikiDocView.swift"), from: "struct WikiDocContentsRows: View {", to: "struct WikiDocsBrowsePage: View {")
        assertOrder(rows, ["Text(group.title)", "Text(doc.number)", "Text(doc.title)", "if doc.needsReview {"], "the native document rows")
    }

    /// Browse and the index by document: title, the line under it, then the categories or the letters.
    func testBrowseAndTheIndexByDocumentAreTheWebsInTheirOrder() throws {
        let browse = try web(Self.browsePage)
        let webBrowse = try slice(browse, from: "function WikiDocsBrowse(", to: "function BrowseDoc(")
        assertOrder(webBrowse, ["<div className=\"wk-art-crumbrow\">", "<h1 className=\"t-title\">{WIKI_BROWSE}</h1>",
                                "wikiDocsBrowseSummary(directory)", "wikiDocsCategoryLine(category)", "<BrowseDoc"], "the web's Browse")
        let webDoc = try slice(browse, from: "function BrowseDoc(", to: "wikiMoreSections(hidden)")
        assertOrder(webDoc, ["{doc.number}", "{doc.title}", "{line.sections}", "{doc.question}", "wikiSectionKindLabel(section.kind)"],
                    "the web's Browse document")
        let index = try web(Self.indexPage)
        let webIndex = try slice(index, from: "function WikiDocsIndexPage(", to: "wikiDocsIndexMeta(item)")
        assertOrder(webIndex, ["{WIKI_AZ_INDEX}</h1>", "wikiDocsIndexSummary(items)", "<nav className=\"wk-az-bar\"", "<section className=\"wk-az-g\""],
                    "the web's index")
        let view = try native("Views/WikiDocView.swift")
        let nativeBrowse = try slice(view, from: "struct WikiDocsBrowsePage: View {", to: "struct WikiDocsIndexPage: View {")
        assertOrder(nativeBrowse, ["Text(WikiArticleCopy.browse)", "WikiDocLogic.browseSummary(directory)", "WikiDocLogic.categoryLine(category)",
                                   "Text(doc.number ?? \"\")", "Text(doc.title)", "Text(line.sections)", "if let question = doc.question",
                                   "WikiDocCopy.moreSections("], "the native Browse")
        let nativeIndex = try slice(view, from: "struct WikiDocsIndexPage: View {", to: "private struct WikiDocIndexLetter")
        assertOrder(nativeIndex, ["Text(WikiArticleCopy.azIndex)", "WikiDocLogic.indexSummary(items)", "ForEach(groups) { group in",
                                  "Text(group.letter)", "WikiDocLogic.indexMeta(item)"], "the native index")
        assertSays(view, "content.sectionIndexLabel(Text(letter))", in: "WikiDocView.swift")
        // A space with a confirmed plan reads by its documents; before one, by its topic articles — at both ends.
        assertSays(browse, "if (docs.data && wikiReadsByDocs(docs.data)) return <WikiDocsBrowse", in: Self.browsePage)
        assertSays(index, "if (docIndex.data?.plan) return <WikiDocsIndexPage", in: Self.indexPage)
        let screens = try native("Views/WikiScreens.swift")
        assertSays(screens, "if let directory = wiki.docsDirectory, WikiDocLogic.readsByDocs(directory) {", in: "WikiScreens.swift")
        assertSays(screens, "if let index = wiki.docIndex, index.plan != nil {", in: "WikiScreens.swift")
    }

    /// The document pages on the phone's stack and in the wide shells' detail pane, and every press through
    /// the section's own stack.
    func testTheDocumentPagesAreWiredToTheStack() throws {
        let screens = try native("Views/WikiScreens.swift")
        assertSays(screens, "case .doc(let slug, let section):   open(.wikiDoc(slug: slug, section: section))", in: "WikiScreens.swift")
        assertSays(screens, "case .doc(let slug, let section):   model.push(.wikiDoc(slug: slug, section: section))", in: "WikiScreens.swift")
        assertSays(screens, "case .plan:                         model.push(.wikiPlan(version: nil))", in: "WikiScreens.swift")
        let pane = try slice(screens, from: "struct WikiDetailPane: View {", to: "struct WikiContentsScreen: View {")
        assertOrder(pane, ["model.nav.wikiIndexOnTop", "model.nav.selectedWikiDoc", "WikiDocScreen(address: doc).id(doc)",
                           "model.nav.selectedWikiPlan", "WikiPlanScreen(address: plan).id(plan)"], "the wide shells' detail pane")
        let shell = try native("Views/CompactShell.swift")
        let stack = try slice(shell, from: "case .wiki:\n            NavigationStack(path: $model.nav.path) {",
                              to: "default:                      EmptyView()")
        for arm in ["case .wikiDoc(let slug, let section):", "WikiDocScreen(address: WikiDocAddress(slug: slug, section: section))",
                    "case .wikiPlan(let version):", "WikiPlanScreen(address: WikiPlanAddress(version: version))",
                    "case .wikiPlanDoc(let slug, let version):", "WikiPlanScreen(address: WikiPlanAddress(version: version, doc: slug))",
                    "case .wikiPlanSection(let slug, let index, let version):",
                    "WikiPlanScreen(address: WikiPlanAddress(version: version, doc: slug, section: index))"] {
            assertSays(stack, arm, in: "CompactShell.swift")
        }
        // The stack's own projections, not a second copy of it.
        var nav = NavState(section: .wiki)
        nav.push(.wikiDoc(slug: "session-runtime", section: "s3"))
        XCTAssertEqual(nav.selectedWikiDoc, WikiDocAddress(slug: "session-runtime", section: "s3"))
        XCTAssertNil(nav.selectedWikiPlan)
        nav.push(.wikiPlan(version: 2))
        XCTAssertEqual(nav.selectedWikiPlan, WikiPlanAddress(version: 2))
        XCTAssertNil(nav.selectedWikiDoc)
        nav.push(.wikiPlanSection(slug: "session-runtime", index: 2, version: nil))
        XCTAssertEqual(nav.selectedWikiPlan, WikiPlanAddress(version: nil, doc: "session-runtime", section: 2))
    }
}
