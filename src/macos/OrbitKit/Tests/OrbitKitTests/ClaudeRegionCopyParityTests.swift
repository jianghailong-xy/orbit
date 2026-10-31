import Foundation
import XCTest
@testable import OrbitKit

/// The Claude region check's words (docs/claude-region-check-contract.md, "Copy of record") are the
/// web's `claudeRegionCopy.ts`, and the sentences behind them the shared ones — the refusal and the
/// stopped sentence (`src/shared/src/claude-region-check.ts`), the code (`dto.ts`) and Anthropic's page
/// (`claude-regions.ts`). Swift cannot import any of them, so this reads the files as text and holds
/// every `ClaudeRegionCopy` declaration to the web declaration of the same name, rendering each Swift
/// template with sentinel values to compare the whole sentence. What the case file cannot carry about
/// the attention item — its detail, params and action — is asserted as the web spec asserts it
/// (`runnerAttention.test.ts`, "a machine blocked for the Claude region"). A missing counterpart is a
/// failure, never an `XCTSkip`.
final class ClaudeRegionCopyParityTests: XCTestCase {

    private static let webCopy = "src/web/src/lib/claudeRegionCopy.ts"
    private static let caseFile = "src/web/src/lib/runnerAttention.cases.json"
    private static let card = "src/web/src/components/RunNeverStartedCard.tsx"
    private static let sharedRules = "src/shared/src/claude-region-check.ts"
    private static let sharedList = "src/shared/src/claude-regions.ts"
    private static let dto = "src/shared/src/dto.ts"

    private enum ParityError: Error, CustomStringConvertible {
        case noRepo
        case noCase(String)
        var description: String {
            switch self {
            case .noRepo:
                return "\(ClaudeRegionCopyParityTests.webCopy) was not found above this test file. "
                    + "ClaudeRegionCopy is one half of a pair; if the web half moved, move this check with it."
            case .noCase(let name):
                return "\(ClaudeRegionCopyParityTests.caseFile) has no case named \(name.debugDescription)"
            }
        }
    }

    /// The repo root, found by walking up from this file. A failure, never an `XCTSkip`, when it is not.
    private func repoRoot() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent(Self.webCopy).path) { return dir }
            dir = dir.deletingLastPathComponent()
        }
        throw ParityError.noRepo
    }

    private func source(_ relative: String) throws -> String {
        try String(contentsOf: try repoRoot().appendingPathComponent(relative), encoding: .utf8)
    }

    /// The file with every run of whitespace read as one space: where a declaration wraps after its
    /// `=>` is a formatting decision, while the words are the contract.
    private func flat(_ relative: String) throws -> String {
        try source(relative).replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
    }

    private func assertSays(_ said: String, _ literal: String, in file: String, line: UInt = #line) {
        XCTAssertTrue(said.contains(literal), "\(file) no longer says \(literal)", line: line)
    }

    /// Every Swift constant, by its web name.
    private static let constants: [(name: String, value: String)] = [
        ("CLAUDE_REGION_SUPPORTED_REGIONS", ClaudeRegionCopy.CLAUDE_REGION_SUPPORTED_REGIONS),
        ("CLAUDE_REGION_USE_ANOTHER_PROVIDER", ClaudeRegionCopy.CLAUDE_REGION_USE_ANOTHER_PROVIDER),
        ("CLAUDE_REGION_MOVE_TO_ANOTHER_MACHINE", ClaudeRegionCopy.CLAUDE_REGION_MOVE_TO_ANOTHER_MACHINE),
        ("CLAUDE_REGION_CHECK_AGAIN", ClaudeRegionCopy.CLAUDE_REGION_CHECK_AGAIN),
        ("CLAUDE_REGION_ATTENTION", ClaudeRegionCopy.CLAUDE_REGION_ATTENTION),
        ("CLAUDE_REGION_NOT_SUPPORTED", ClaudeRegionCopy.CLAUDE_REGION_NOT_SUPPORTED),
        ("CLAUDE_REGION_DETAILS", ClaudeRegionCopy.CLAUDE_REGION_DETAILS),
        ("CLAUDE_REGION_CHECK_FAILED", ClaudeRegionCopy.CLAUDE_REGION_CHECK_FAILED),
    ]

    /// Every Swift template, rendered with sentinels, as the web's whole declaration reads.
    private static let templates: [String] = [
        "export const claudeRegionCantUseAnthropicOn = (machine: string): string => `"
            + ClaudeRegionCopy.claudeRegionCantUseAnthropicOn(machine: "${machine}") + "`;",
        "export const anthropicUnavailableOn = (machine: string): string => `"
            + ClaudeRegionCopy.anthropicUnavailableOn(machine: "${machine}") + "`;",
        "export const claudeRegionMachineNote = (region: string): string => `"
            + ClaudeRegionCopy.claudeRegionMachineNote(region: "${region}") + "`;",
        "export const claudeRegionAttentionDetail = (region: string): string => `"
            + ClaudeRegionCopy.claudeRegionAttentionDetail(region: "${region}") + "`;",
    ]

    /// The web's declarations this client has no surface for: a grouped Claude Code head counting its
    /// accounts — the phone's row says Region not supported and nothing else (board 03).
    private static let webOnly: Set<String> = ["claudeRegionAccounts"]

    func testEveryConstantIsTheWebs() throws {
        let web = try flat(Self.webCopy)
        for (name, value) in Self.constants {
            assertSays(web, "export const \(name) = '\(value)';", in: Self.webCopy)
        }
    }

    func testEveryTemplateIsTheWebsWholeSentence() throws {
        let web = try flat(Self.webCopy)
        for declaration in Self.templates { assertSays(web, declaration, in: Self.webCopy) }
    }

    /// The subject and the check line hold more than holes, so each piece is asserted as the web
    /// writes it, and the Swift sentence rebuilt from those pieces.
    func testTheSubjectAndTheCheckLineAreTheWebs() throws {
        let web = try flat(Self.webCopy)
        assertSays(web, "export const claudeRegionSubject = (code: string | null): string => "
                   + "code ? `${CLAUDE_REGION_UNSUPPORTED} · ${code}` : CLAUDE_REGION_UNSUPPORTED;", in: Self.webCopy)
        XCTAssertEqual(ClaudeRegionCopy.claudeRegionSubject(code: "CN"), "CLAUDE_REGION_UNSUPPORTED · CN")
        XCTAssertEqual(ClaudeRegionCopy.claudeRegionSubject(code: nil), "CLAUDE_REGION_UNSUPPORTED")

        assertSays(web, "export const claudeRegionChecked = (when: string, region: string, viaProxy: boolean): string => "
                   + "`Checked ${when} · Claude’s connection: ${region} (${viaProxy ? 'through a proxy' : 'no proxy'})`;",
                   in: Self.webCopy)
        for (viaProxy, words) in [(true, "through a proxy"), (false, "no proxy")] {
            XCTAssertEqual(ClaudeRegionCopy.claudeRegionChecked(when: "${when}", region: "${region}", viaProxy: viaProxy),
                           "Checked ${when} · Claude’s connection: ${region} (\(words))")
        }
    }

    /// The card's body is the refusal sentence behind its code: the web slices it off the shared
    /// writer, so the Swift sentence is held to that writer's template.
    func testTheBodyIsTheSharedRefusalWithoutItsCode() throws {
        let web = try flat(Self.webCopy)
        assertSays(web, "export const claudeRegionConnectionIsIn = (machine: string, region: string): string => "
                   + "claudeRegionRefusedError(machine, region).slice(`${CLAUDE_REGION_UNSUPPORTED}: `.length);",
                   in: Self.webCopy)
        let shared = try flat(Self.sharedRules)
        assertSays(shared, "return `${CLAUDE_REGION_UNSUPPORTED}: "
                   + ClaudeRegionCopy.claudeRegionConnectionIsIn(machine: "${machine}", region: "${region}") + "`;",
                   in: Self.sharedRules)
    }

    /// The transcript reads a stopped turn by the whole shape of the shared stopped sentence.
    func testTheStoppedSentenceIsTheSharedOne() throws {
        let shared = try flat(Self.sharedRules)
        let sentence = ClaudeRegion.stoppedLead + "${machine}" + ClaudeRegion.stoppedMiddle + "${region}"
            + ClaudeRegion.stoppedTail
        let code = ClaudeRegionCopy.CLAUDE_REGION_UNSUPPORTED
        assertSays(shared, "return `" + sentence.replacingOccurrences(of: code, with: "${\(code)}") + "`;",
                   in: Self.sharedRules)
    }

    /// The code, Anthropic's page and the Anthropic preset are the shared constants.
    func testTheCodeThePageAndThePresetAreTheShared() throws {
        assertSays(try flat(Self.dto), "export const CLAUDE_REGION_UNSUPPORTED = '\(ClaudeRegionCopy.CLAUDE_REGION_UNSUPPORTED)';",
                   in: Self.dto)
        assertSays(try flat(Self.webCopy), "export const CLAUDE_REGION_SUPPORTED_REGIONS_URL = CLAUDE_REGIONS_SOURCE_URL;",
                   in: Self.webCopy)
        assertSays(try flat(Self.sharedList),
                   "export const CLAUDE_REGIONS_SOURCE_URL = '\(ClaudeRegionCopy.CLAUDE_REGION_SUPPORTED_REGIONS_URL)';",
                   in: Self.sharedList)
        assertSays(try flat(Self.sharedRules), "const ANTHROPIC_PRESET = 'anthropic';", in: Self.sharedRules)
        XCTAssertTrue(ClaudeRegion.credentialIsAnthropicBound(.key(presetSlug: "anthropic")))
    }

    /// The card's feet are the web card's own.
    func testTheCardsFeetAreTheWebCards() throws {
        let card = try flat(Self.card)
        assertSays(card, "waitingFoot: '\(SessionRunStart.waitingFoot)',", in: Self.card)
        assertSays(card, "endedFoot: '\(SessionRunStart.endedFoot)',", in: Self.card)
    }

    /// A runner page's buttons are title case: its Check Again is the web's words, capitalized.
    func testTheRunnerPagesCheckAgainIsTheWebsInTitleCase() {
        XCTAssertEqual(ClaudeRegionCopy.CLAUDE_REGION_CHECK_AGAIN_TITLE, ClaudeRegionCopy.CLAUDE_REGION_CHECK_AGAIN.capitalized)
    }

    /// Every word the web file exports is either here or named as the web's alone: a sentence added at
    /// one end and not the other fails.
    func testEveryWebDeclarationIsPortedOrNamedWebOnly() throws {
        let web = try source(Self.webCopy)
        let re = try NSRegularExpression(pattern: "^export const (\\w+)", options: [.anchorsMatchLines])
        let names = re.matches(in: web, range: NSRange(web.startIndex..., in: web)).compactMap {
            Range($0.range(at: 1), in: web).map { String(web[$0]) }
        }
        let ported = Set(Self.constants.map(\.name)).union([
            "CLAUDE_REGION_SUPPORTED_REGIONS_URL", "claudeRegionCantUseAnthropicOn", "claudeRegionConnectionIsIn",
            "claudeRegionSubject", "claudeRegionChecked", "anthropicUnavailableOn", "claudeRegionMachineNote",
            "claudeRegionAttentionDetail",
        ])
        XCTAssertFalse(names.isEmpty, "no declarations read from \(Self.webCopy)")
        for name in names {
            XCTAssertTrue(ported.contains(name) || Self.webOnly.contains(name),
                          "\(Self.webCopy) declares \(name), which ClaudeRegionCopy neither ports nor names web-only")
        }
    }

    private func input(_ name: String) throws -> RunnerAttentionInput {
        let data = try Data(contentsOf: try repoRoot().appendingPathComponent(Self.caseFile))
        let all = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
        guard let found = all.first(where: { $0["name"] as? String == name }) else { throw ParityError.noCase(name) }
        let input = try XCTUnwrap(found["input"] as? [String: Any])
        return try JSONDecoder().decode(RunnerAttentionInput.self, from: JSONSerialization.data(withJSONObject: input))
    }

    func testABlockedMachineSaysWhereAndOffersCheckAgain() throws {
        let items = RunnerAttention.runnerAttention(
            try input("Claude region blocked: Claude Code can’t use Anthropic here, with Check again"))
        XCTAssertEqual(items.count, 1)
        let item = try XCTUnwrap(items.first)
        XCTAssertEqual(item.kind, .claudeRegionUnsupported)
        XCTAssertEqual(item.tone, .warn)
        XCTAssertEqual(item.short, "Claude Code can’t use Anthropic here")
        XCTAssertEqual(item.detail, "Anthropic doesn’t offer Claude in mainland China.")
        XCTAssertEqual(item.action, RunnerAttentionAction(kind: .checkRegion, engine: nil, workspaceId: nil, command: nil))
        XCTAssertEqual(item.params, [
            "country": .string("CN"),
            "regionCode": .null,
            "region": .string("mainland China"),
            "checkedAt": .string("2026-09-29T00:12:00Z"),
        ])
    }

    func testAMachineThatReadsNoRegionIsToldNothing() throws {
        let blocked = try input("Claude region blocked, Claude the only CLI and signed out: the region, not no CLI signed in")
        XCTAssertNil(RunnerAttention.noCliSignedIn(engines: blocked.runner.engines, workspaces: blocked.workspaces,
                                                   region: blocked.runner.region))
        // Without the region, the same machine is one with no CLI signed in, as before.
        XCTAssertEqual(RunnerAttention.noCliSignedIn(engines: blocked.runner.engines, workspaces: blocked.workspaces),
                       [.claude])
    }
}
