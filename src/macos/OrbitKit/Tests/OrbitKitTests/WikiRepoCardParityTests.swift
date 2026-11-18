import Foundation
import XCTest
@testable import OrbitKit

/// The Settings maintenance card's repository part says the web's words for every case of
/// `src/shared/src/wiki-repo-card.fixture.json` (docs/wiki-repo-tiers-design.md §7.3, mock 44 ⑤), which the web's
/// `lib/wikiRepoCard.test.ts` and Android's `WikiRepoCardTest` read too; and every `WikiRepoCardCopy` word is a
/// declaration of `src/web/src/lib/wikiRepoCard.ts`. A missing counterpart is a failure, never a skip.
final class WikiRepoCardParityTests: XCTestCase {

    private static let fixturePath = "src/shared/src/wiki-repo-card.fixture.json"
    private static let lib = "src/web/src/lib/wikiRepoCard.ts"

    private struct Missing: Error, CustomStringConvertible {
        let file: String
        var description: String { "\(file) was not found above this test file: the card is one half of a pair." }
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

    private struct Fixture: Decodable {
        struct Card: Decodable {
            struct Tag: Decodable { let text: String; let tone: String }
            let tag: Tag
            let line: String
            let canRun: Bool
            let blocked: String?
            let useFolder: Bool
        }
        struct Case: Decodable {
            let name: String
            let health: WikiSpaceHealth
            let card: Card?
        }
        let now: String
        let copy: [String: String]
        let cases: [Case]
    }

    private func fixture() throws -> Fixture {
        try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: find(Self.fixturePath)))
    }

    func testEveryCaseSaysTheFixturesCard() throws {
        let shared = try fixture()
        let now = try XCTUnwrap(RelativeTime.parse(shared.now))
        XCTAssertGreaterThanOrEqual(shared.cases.count, 10)
        for one in shared.cases {
            let card = WikiRepoCardLogic.card(one.health, now: now)
            guard let want = one.card else {
                XCTAssertNil(card, one.name)
                continue
            }
            let got = try XCTUnwrap(card, one.name)
            XCTAssertEqual(got.tag, want.tag.text, one.name)
            XCTAssertEqual(got.tone.rawValue, want.tag.tone, one.name)
            XCTAssertEqual(got.line, want.line, one.name)
            XCTAssertEqual(got.canRun, want.canRun, one.name)
            XCTAssertEqual(got.blocked, want.blocked, one.name)
            XCTAssertEqual(got.useFolder, want.useFolder, one.name)
        }
    }

    func testTheButtonsAndTheConfirmationAreTheFixturesWords() throws {
        let copy = try fixture().copy
        XCTAssertEqual(copy["checkAndRun"], WikiRepoCardCopy.checkAndRun)
        XCTAssertEqual(copy["changeWorkspace"], WikiRepoCardCopy.changeWorkspace)
        XCTAssertEqual(copy["useFolder"], WikiRepoCardCopy.useFolder)
        XCTAssertEqual(copy["useFolderTitle"], WikiRepoCardCopy.useFolderTitle)
        XCTAssertEqual(copy["useFolderNote"], WikiRepoCardCopy.useFolderNote)
        XCTAssertEqual(copy["dailyLimit"], WikiRepoCardCopy.dailyLimit)
        XCTAssertEqual(copy["runUnderWay"], WikiRepoCardCopy.runUnderWay)
        XCTAssertEqual(copy["runStarted"], WikiRepoCardCopy.runStarted)
        XCTAssertEqual(copy["runRefused"], WikiRepoCardCopy.runRefused)
        XCTAssertEqual(copy["probeChecking"], WikiRepoCardCopy.probeChecking)
        XCTAssertEqual(copy["probeFailed"], WikiRepoCardCopy.probeFailed)
    }

    /// Each word is declared in the web's lib under the name its comment gives.
    func testEveryWordIsTheWebsDeclaration() throws {
        let web = try String(contentsOf: find(Self.lib), encoding: .utf8)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        let words: [(String, String)] = [
            ("WIKI_CHECK_AND_RUN", WikiRepoCardCopy.checkAndRun),
            ("WIKI_CHANGE_WORKSPACE", WikiRepoCardCopy.changeWorkspace),
            ("WIKI_USE_FOLDER", WikiRepoCardCopy.useFolder),
            ("WIKI_DAILY_LIMIT_HIT", WikiRepoCardCopy.dailyLimit),
            ("WIKI_RUN_UNDER_WAY", WikiRepoCardCopy.runUnderWay),
            ("WIKI_LAST_RUN_FAILED", WikiRepoCardCopy.lastRunFailed),
            ("WIKI_LAST_RUN_FAILED_LINE", WikiRepoCardCopy.lastRunFailedLine),
            ("WIKI_USE_FOLDER_TITLE", WikiRepoCardCopy.useFolderTitle),
            ("WIKI_RUN_STARTED", WikiRepoCardCopy.runStarted),
            ("WIKI_PROBE_CHECKING", WikiRepoCardCopy.probeChecking),
            ("WIKI_PROBE_FAILED", WikiRepoCardCopy.probeFailed),
            ("WIKI_FOLDER_READING", WikiRepoCardCopy.folderReading),
        ]
        for (name, word) in words {
            XCTAssertTrue(web.contains("export const \(name) = '\(word)'"), "\(name) is not '\(word)' in \(Self.lib)")
        }
        XCTAssertTrue(web.contains("export const WIKI_RUN_REFUSED = \"\(WikiRepoCardCopy.runRefused)\""))
    }

    /// The probe's answer decodes as the server writes it (`wikiRepoProbeAnswer`).
    func testTheProbeAnswerDecodes() throws {
        let json = #"{"workspaceId":"w","tier":null,"reason":"runner_offline","origin":null,"tone":"unchecked","title":"Could not check: MacBook is offline","note":null,"canTurnOn":true,"checkedAt":"2026-11-11T00:00:00.000Z"}"#
        let answer = try JSONDecoder().decode(WikiRepoProbeAnswer.self, from: Data(json.utf8))
        XCTAssertEqual(answer.tone, "unchecked")
        XCTAssertTrue(answer.canTurnOn)
        XCTAssertNil(answer.tier)
    }
}
