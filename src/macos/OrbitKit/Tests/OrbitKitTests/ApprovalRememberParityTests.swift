import Foundation
import XCTest
@testable import OrbitKit

/// "Allow & remember" on this client against "Always allow" on the web: what it remembers from a
/// command, and the request that carries it.
///
/// The two had come apart in both halves. The rules: this port remembered only a line's leading
/// prefix, split on a `;` inside quotes, and missed a shell wrapper behind `&&`, so one card offered
/// one grant on the phone and another, or none, in the browser. The request: it sent a single
/// `rememberRule`, which the control plane stopped reading in June 2026, so every press since was a
/// plain Allow. `src/shared/src/bash-rules.fixture.json` is now the contract for the first half —
/// `@orbit/shared` walks it through `bashCommandRules` (`bashRules.spec.ts`) and this walks it
/// through `Approvals.bashCommandRules` — and the second half is checked against `dto.ts` itself.
///
/// Both files are looked up by walking up from this one, and a missing file is a FAILURE, never an
/// `XCTSkip`: a check that quietly opts out reports green on exactly the day the thing it watches
/// goes missing.
final class ApprovalRememberParityTests: XCTestCase {

    private static let fixturePath = "src/shared/src/bash-rules.fixture.json"
    private static let dtoPath = "src/shared/src/dto.ts"

    private struct Missing: Error, CustomStringConvertible {
        let path: String
        var description: String {
            "\(path) was not found above this test file. It is what this client's remember action is "
                + "proved against — if it moved, point this check at its new home rather than deleting it."
        }
    }

    private struct Fixture: Decodable { let cases: [Case] }
    private struct Case: Decodable { let name: String; let command: String; let rules: [String] }

    private func repoFile(_ path: String) throws -> Data {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(path)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try Data(contentsOf: candidate)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw Missing(path: path)
    }

    private func cases() throws -> [Case] {
        try JSONDecoder().decode(Fixture.self, from: repoFile(Self.fixturePath)).cases
    }

    // MARK: what is remembered

    func testEverySharedCaseRemembersWhatTheWebRemembers() throws {
        let all = try cases()
        XCTAssertFalse(all.isEmpty, "the shared fixture has no cases in it")
        for c in all {
            XCTAssertEqual(Approvals.ruleNames(Approvals.bashCommandRules(c.command)), c.rules, c.name)
        }
    }

    func testTheFixtureKeepsTheCasesThisWasFixedFor() throws {
        let names = try cases().map(\.name)
        XCTAssertEqual(Set(names).count, names.count, "a case name appears twice")
        for required in ["Codex's shell wrapper is never remembered",
                         "the card from 2026-10-02",
                         "a wrapper anywhere in a compound line refuses the whole line",
                         "every sub-command of a compound line, not just the leading cd",
                         "a quoted separator does not split a sub-command"] {
            XCTAssertTrue(names.contains { $0.hasPrefix(required) },
                          "the fixture no longer covers \"\(required)\": \(names)")
        }
    }

    func testEachRuleIsACommandPrefixUnderBash() {
        XCTAssertEqual(Approvals.bashCommandRules("cd /x && git add -A"), [
            PermissionRule(toolName: "Bash", ruleContent: "cd:*"),
            PermissionRule(toolName: "Bash", ruleContent: "git add:*"),
        ])
        // What the card itself asks for: the approval's input, through the same rules.
        XCTAssertEqual(Approvals.rememberRules(toolName: "Bash",
                                               input: .object(["command": .string("cd /x && git add -A")])),
                       Approvals.bashCommandRules("cd /x && git add -A"))
    }

    /// Web's `rememberLabel`: every name up to four, then a count of the rest.
    func testTheButtonNamesUpToFourPrefixesAndCountsTheRest() {
        XCTAssertEqual(Approvals.rememberLabel(Approvals.bashCommandRules("cd /x && git add -A")),
                       "cd, git add")
        XCTAssertEqual(Approvals.rememberLabel(Approvals.bashCommandRules("a; b; c; d")), "a, b, c, d")
        XCTAssertEqual(Approvals.rememberLabel(Approvals.bashCommandRules("a; b; c; d; e; f")),
                       "a, b, c, d +2")
    }

    // MARK: the request that carries it

    /// Every key this client sends is one the control plane's `ApprovalDecisionRequest` declares —
    /// read from `dto.ts`, so a rename at either end turns this red instead of turning the remember
    /// action into a plain Allow again.
    func testTheDecisionSendsOnlyKeysTheServerReads() throws {
        let dto = String(decoding: try repoFile(Self.dtoPath), as: UTF8.self)
        let start = try XCTUnwrap(dto.range(of: "export interface ApprovalDecisionRequest {"),
                                  "dto.ts no longer declares ApprovalDecisionRequest")
        let end = try XCTUnwrap(dto.range(of: "\n}", range: start.upperBound..<dto.endIndex))
        let declared = Set(dto[start.upperBound..<end.lowerBound]
            .split(separator: "\n")
            .compactMap { line -> String? in
                let field = line.trimmingCharacters(in: .whitespaces)
                guard let colon = field.firstIndex(of: ":") else { return nil }
                let key = field[..<colon].replacingOccurrences(of: "?", with: "")
                return key.allSatisfy({ $0.isLetter || $0.isNumber }) && !key.isEmpty ? key : nil
            })
        XCTAssertTrue(declared.contains("rememberRules"), "declared: \(declared.sorted())")

        let req = ApprovalDecisionRequest(behavior: .allow, message: "m", answers: ["q": ["a"]],
                                          rememberRules: [PermissionRule(toolName: "Bash",
                                                                         ruleContent: "git add:*")])
        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(req))
                                     as? [String: Any])
        XCTAssertEqual(Set(sent.keys).subtracting(declared), [],
                       "this client sends keys the server does not read")
        let rules = try XCTUnwrap(sent["rememberRules"] as? [[String: Any]])
        XCTAssertEqual(rules.count, 1)
        XCTAssertEqual(rules.first?["toolName"] as? String, "Bash")
        XCTAssertEqual(rules.first?["ruleContent"] as? String, "git add:*")
    }
}
