import Foundation
import XCTest
@testable import OrbitKit

/// The Claude region check's attention item (docs/claude-region-check-contract.md): its words are the
/// web's `claudeRegionCopy.ts`, and what the case file cannot carry — the detail, the params and the
/// action — is what the web spec asserts (`runnerAttention.test.ts`, "a machine blocked for the Claude
/// region").
final class ClaudeRegionCopyParityTests: XCTestCase {

    private static let webCopy = "src/web/src/lib/claudeRegionCopy.ts"
    private static let caseFile = "src/web/src/lib/runnerAttention.cases.json"

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

    func testTheAttentionWordsAreTheWebs() throws {
        let web = try source(Self.webCopy)
        XCTAssertTrue(web.contains("export const CLAUDE_REGION_ATTENTION = '\(ClaudeRegionCopy.CLAUDE_REGION_ATTENTION)';"),
                      "claudeRegionCopy.ts no longer says \(ClaudeRegionCopy.CLAUDE_REGION_ATTENTION)")
        let detail = ClaudeRegionCopy.claudeRegionAttentionDetail(region: "${region}")
        XCTAssertTrue(web.contains("export const claudeRegionAttentionDetail = (region: string): string => `\(detail)`;"),
                      "claudeRegionCopy.ts no longer says \(detail)")
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
