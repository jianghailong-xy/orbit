import Foundation
import XCTest
@testable import OrbitKit

/// A DeepSeek key's balance says on the phone what it says on the web, wherever the two say the same
/// thing: `DeepSeekBalance`'s words are looked up in the web source they came from. A missing
/// counterpart is a FAILURE, never an `XCTSkip`.
///
/// Deliberately not compared: the footnote under the balance, which the phone shortens for its width,
/// and the words only a phone has to say — that its key is changed on the web, that the top-up opens
/// in Safari, the rows a phone lays the balance out in (Updated, Last tried, Balance: Unknown), the
/// row's "Unavailable", where the web's list has room for the reason, and the key page's "Runs on",
/// one row holding the engines the web lists under Works with.
final class DeepSeekBalanceCopyParityTests: XCTestCase {
    private static let component = "src/web/src/components/DeepSeekBalance.tsx"
    private static let lib = "src/web/src/lib/deepseekBalance.ts"
    private static let keys = "src/web/src/pages/InfrastructurePage.tsx"
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

    /// A key's line is every engine it runs on, as the server lists them (`engines`, default first): a
    /// key made from the retired DeepSeek Harness preset runs on Claude Code and OpenCode too.
    func testAHarnessKeysLineIsWhereItRunsAsTheWebSaysIt() throws {
        // Infrastructure's API keys: each engine by its CLI's name, a dot between (web's `KeyEngines`).
        let keys = try web(Self.keys)
        assertSays(keys, "{row.engines.map((engine, index) => (", in: Self.keys)
        assertSays(keys, "{index > 0 && <> <span className=\"prov-engine-sep\">·</span> </>}", in: Self.keys)
        assertSays(keys, "<EngineTile engine={engine} size={12} /> {ENGINE_CLI_NAMES[engine]}", in: Self.keys)
        XCTAssertEqual(ProvidersOverview.keyLine(ConfiguredProvider(slug: "h", label: "H", runtime: "dsh",
                                                                    engines: ["dsh", "claude", "opencode"])),
                       "DeepSeek Harness · Claude Code · OpenCode")
        // A Claude subscription token: Anthropic's protocol on Claude Code alone, and said to be one.
        assertSays(keys, "keyDialect(row.runtime) === 'anthropic' && row.engines.length === 1 && row.engines[0] === AgentProvider.CLAUDE",
                   in: Self.keys)
        assertSays(keys, "<span>\(ProvidersOverview.subscriptionToken), Claude Code only</span>", in: Self.keys)
        XCTAssertEqual(ProvidersOverview.keyLine(ConfiguredProvider(slug: "max", label: "Claude Max", runtime: "claude",
                                                                    engines: ["claude"])),
                       "Claude Code · subscription token")
        // From a server that doesn't list them yet, the engine its runtime names.
        XCTAssertEqual(DeepSeekBalance.engine(of: ConfiguredProvider(slug: "h", label: "H", runtime: "dsh")), "DeepSeek Harness")
        // The key's page lists the same engines under Works with, a row each (web's `WorksWith`).
        let page = try web(Self.editPage)
        assertSays(page, "<div className=\"provider-works-head\"> \(DeepSeekBalance.worksWith) <small>", in: Self.editPage)
        assertSays(page, "<EngineTile engine={engine} size={18} /> {ENGINE_CLI_NAMES[engine]}", in: Self.editPage)
        XCTAssertEqual(DeepSeekBalance.engines(of: ConfiguredProvider(slug: "d", label: "D", runtime: "claude",
                                                                      engines: ["claude", "opencode", "dsh"])),
                       ["Claude Code", "OpenCode", "DeepSeek Harness"])
    }
}
