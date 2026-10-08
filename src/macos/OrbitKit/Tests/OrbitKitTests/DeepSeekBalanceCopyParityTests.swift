import Foundation
import XCTest
@testable import OrbitKit

/// A DeepSeek key's balance says on the phone what it says on the web, wherever the two say the same
/// thing: `DeepSeekBalance`'s words are looked up in the web source they came from. A missing
/// counterpart is a FAILURE, never an `XCTSkip`.
///
/// Deliberately not compared: the footnote under the balance, which the phone shortens for its width,
/// and the words only a phone has to say — that its key is changed on the web, that the top-up opens
/// in Safari, the rows a phone lays the balance out in (Updated, Last tried, Balance: Unknown), and the
/// row's "Unavailable", where the web's list has room for the reason.
final class DeepSeekBalanceCopyParityTests: XCTestCase {
    private static let component = "src/web/src/components/DeepSeekBalance.tsx"
    private static let lib = "src/web/src/lib/deepseekBalance.ts"
    private static let runtimes = "src/web/src/lib/sessionProviderChoices.ts"
    private static let editPage = "src/web/src/pages/ProviderConnectPage.tsx"

    private struct Missing: Error, CustomStringConvertible {
        let path: String
        var description: String {
            "\(path) was not found above this test file. The balance on iOS is one half of a pair; "
                + "if the web half moved, move this check with it rather than deleting it."
        }
    }

    /// The web file with every run of whitespace made one space: where JSX breaks a sentence's line
    /// is layout, the words are the contract.
    private func web(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
                    .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw Missing(path: relative)
    }

    private func assertSays(_ source: String, _ literal: String, in file: String,
                            file testFile: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(source.contains(literal), "\(file) no longer says \(literal)", file: testFile, line: line)
    }

    func testTheSectionSaysWhatTheEditPageSays() throws {
        let page = try web(Self.component)
        assertSays(page, ">DeepSeek account balance</span>", in: Self.component)
        XCTAssertEqual(DeepSeekBalance.title, "DeepSeek account balance")
        for words in [DeepSeekBalance.topUp, DeepSeekBalance.failedTitle, DeepSeekBalance.lowTitle, DeepSeekBalance.lowDetail,
                      DeepSeekBalance.multiCurrency, DeepSeekBalance.checking] {
            assertSays(page, words, in: Self.component)
        }
        assertSays(page, "<div className=\"dsb-cap\">\(DeepSeekBalance.total)</div>", in: Self.component)
        assertSays(page, "\(DeepSeekBalance.granted)<b>", in: Self.component)
        assertSays(page, "\(DeepSeekBalance.toppedUp)<b>", in: Self.component)
        assertSays(page, "label=\"\(DeepSeekBalance.refresh)\"", in: Self.component)
        assertSays(page, "label=\"\(DeepSeekBalance.retry)\"", in: Self.component)
        assertSays(page, "Same DeepSeek account as", in: Self.component)
        assertSays(page, "'both' : 'all'} show this balance.", in: Self.component)
    }

    func testAKeyThatWentSaysWhatTheEditPageSays() throws {
        assertSays(try web(Self.editPage), ">\(ProvidersOverview.keyGone)</div>", in: Self.editPage)
    }

    func testTheTopUpGoesWhereTheWebSendsIt() throws {
        assertSays(try web(Self.lib), "'\(DeepSeekBalance.topUpURL.absoluteString)'", in: Self.lib)
    }

    func testAHarnessKeysLineIsWhereItRunsAsTheWebSaysIt() throws {
        assertSays(try web(Self.runtimes), "'\(ProvidersOverview.keyLine(ConfiguredProvider(slug: "h", label: "H", runtime: "dsh"))!)'",
                   in: Self.runtimes)
        XCTAssertEqual(DeepSeekBalance.engine(of: ConfiguredProvider(slug: "h", label: "H", runtime: "dsh")), "DeepSeek Harness")
        assertSays(try web(Self.runtimes), "'\(DeepSeekBalance.runsOn) \(DeepSeekBalance.engine(of: ConfiguredProvider(slug: "d", label: "D", runtime: "claude")))'",
                   in: Self.runtimes)
    }
}
