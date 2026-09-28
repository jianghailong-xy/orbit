import Foundation
import XCTest
@testable import OrbitKit

/// Holds OrbitKit's article vocabulary to `contracts/wiki.contract.json` `articles` (criterion 9): the
/// six categories in the directory's order and in the words every client shows, the three kinds, the
/// user door's routes the reads are on — and that what the server answers decodes, with a value this
/// build has never heard of read as `.unknown` rather than failing the page.
final class WikiArticlesContractTests: XCTestCase {
    private struct ContractMissing: Error, CustomStringConvertible {
        let searchedFrom: String
        var description: String {
            "contracts/wiki.contract.json was not found above \(searchedFrom). If the contract moved, "
                + "point this check at its new home — don't delete the check."
        }
    }

    /// Found by walking up from this file. Never a skip.
    private func articles() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("contracts/wiki.contract.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                let data = try Data(contentsOf: candidate)
                let contract = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
                return try XCTUnwrap(contract["articles"] as? [String: Any], "the contract has no articles section")
            }
            dir.deleteLastPathComponent()
        }
        throw ContractMissing(searchedFrom: #filePath)
    }

    private func userRoutes() throws -> Set<String> {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("contracts/wiki.contract.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                let contract = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: candidate)) as? [String: Any])
                let surface = try XCTUnwrap(contract["agentSurface"] as? [String: Any])
                let user = try XCTUnwrap((surface["doors"] as? [String: Any])?["user"] as? [String: Any])
                return Set(try XCTUnwrap(user["routes"] as? [String]))
            }
            dir.deleteLastPathComponent()
        }
        throw ContractMissing(searchedFrom: #filePath)
    }

    /// The six categories, in order, named as the contract names them.
    func testCategoriesAreTheContractsInItsOrderAndWords() throws {
        let categories = try XCTUnwrap(articles()["categories"] as? [[String: String]])
        let known = WikiArticleCategory.allCases.filter { $0 != .unknown }
        XCTAssertEqual(categories.map { $0["key"] ?? "" }, known.map(\.rawValue))
        for category in known {
            let declared = categories.first { $0["key"] == category.rawValue }
            XCTAssertEqual(declared?["title"], category.title, category.rawValue)
        }
    }

    func testKindsAreTheContracts() throws {
        let kinds = try XCTUnwrap(articles()["kinds"] as? [String: Any])
        XCTAssertEqual(Set(kinds.keys), Set(WikiArticleKind.allCases.filter { $0 != .unknown }.map(\.rawValue)))
    }

    /// The three reads are the user door's routes, and the door has no route that writes an article.
    func testTheReadsAreOnTheUserDoor() throws {
        let routes = try XCTUnwrap(articles()["routes"] as? [String: String])
        let user = try userRoutes()
        for name in ["directory", "article", "part", "index"] {
            let route = try XCTUnwrap(routes[name], name)
            XCTAssertTrue(route.hasPrefix("GET /api/wiki/spaces/:id/"), route)
            XCTAssertTrue(user.contains(route), "\(route) is not a route the user door declares")
        }
        XCTAssertFalse(user.contains { $0.hasPrefix("POST") && $0.contains("/articles") })
    }

    /// An article as the server answers it: blocks of footnoted sentences, and footnotes resolved.
    func testAnArticleDecodes() throws {
        let json = #"""
        {"spaceId":"34WSpace","topic":{"slug":"database","title":"数据库与 Prisma","category":"data","categoryTitle":"Data & backend"},
         "part":0,"kind":"article","title":"数据库写入治理",
         "blocks":[{"heading":null,"sentences":[{"text":"写入清单登记每一处 Prisma 写入。","notes":[1]},{"text":"事务冲突时整段重跑。","notes":[1,2]}]},
                   {"heading":"迁移","sentences":[{"text":"迁移按号排列。","notes":[2]}]}],
         "footnotes":[{"n":1,"entryId":"34WEntryA","revision":1,"entry":{"id":"34WEntryA","kind":"pitfall","title":"会话写入前要登记写入清单","summary":"要在 db-write-inventory 里登记。","status":"active","trust":"owner","currentRevision":1}},
                      {"n":2,"entryId":"34WEntryB","revision":2,"entry":null}],
         "entryCount":2,"chars":34,"generatedAt":"2026-09-28T02:00:00.000Z","ref":"0123456789abcdef0123456789abcdef01234567",
         "model":"qwen3.8-27b-fp8","overview":null,"parts":[]}
        """#
        let article = try JSONDecoder().decode(WikiArticle.self, from: Data(json.utf8))
        XCTAssertEqual(article.kind, .article)
        XCTAssertEqual(article.topic.category, .data)
        XCTAssertEqual(article.blocks.count, 2)
        XCTAssertEqual(article.blocks[0].sentences[1].notes, [1, 2])
        XCTAssertEqual(article.blocks[1].heading, "迁移")
        XCTAssertEqual(article.footnotes.map(\.n), [1, 2])
        XCTAssertEqual(article.footnotes[0].entry?.kind, .pitfall)
        XCTAssertNil(article.footnotes[1].entry, "an entry that no longer exists is a footnote with no entry")
        // A kind and a category a later server adds read as `.unknown`, and the page still decodes.
        let later = json.replacingOccurrences(of: #""kind":"article""#, with: #""kind":"digest""#)
            .replacingOccurrences(of: #""category":"data""#, with: #""category":"economics""#)
        let decoded = try JSONDecoder().decode(WikiArticle.self, from: Data(later.utf8))
        XCTAssertEqual(decoded.kind, .unknown)
        XCTAssertEqual(decoded.topic.category, .unknown)
    }

    func testTheDirectoryAndTheIndexDecode() throws {
        let directory = #"""
        {"spaceId":"34WSpace","categories":[{"key":"platform","title":"Platform core","topics":[
          {"slug":"wiki","title":"Wiki","description":"The Orbit wiki itself.","category":"platform",
           "article":{"part":0,"kind":"overview","title":"Wiki 模块","entryCount":3,"generatedAt":"2026-09-28T02:00:00.000Z"},
           "parts":[{"part":1,"kind":"subtopic","title":"Articles and dossiers","entryCount":2}]},
          {"slug":"sessions","title":"会话","description":null,"category":"platform","article":null,"parts":[]}]}],
         "uncategorized":[]}
        """#
        let decoded = try JSONDecoder().decode(WikiArticleDirectory.self, from: Data(directory.utf8))
        let platform = try XCTUnwrap(decoded.categories?.first)
        XCTAssertEqual(platform.key, .platform)
        XCTAssertEqual(platform.topics?.first?.article?.kind, .overview)
        XCTAssertEqual(platform.topics?.first?.parts?.first?.part, 1)
        XCTAssertNil(platform.topics?.last?.article)

        let index = #"""
        {"spaceId":"34WSpace","items":[
          {"part":1,"kind":"subtopic","title":"Articles and dossiers","entryCount":2,"initial":"A","topic":{"slug":"wiki","title":"Wiki"}},
          {"part":0,"kind":"article","title":"数据库写入治理","entryCount":2,"initial":"#","topic":{"slug":"database","title":"数据库与 Prisma"}}]}
        """#
        let items = try JSONDecoder().decode(WikiArticleIndex.self, from: Data(index.utf8)).items
        XCTAssertEqual(items.map(\.initial), ["A", "#"])
        XCTAssertEqual(items.map(\.topic.slug), ["wiki", "database"])
    }
}
