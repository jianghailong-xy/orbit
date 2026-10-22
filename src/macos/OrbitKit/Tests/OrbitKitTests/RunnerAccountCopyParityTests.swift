import Foundation
import XCTest
@testable import OrbitKit

/// Removing a runner's Default from Orbit, and bringing it back, in the web's words: `RunnerAccountCopy`
/// is a hand-copy of `src/web/src/lib/runnerAccountCopy.ts`, the sentences the web settled for that and
/// which iOS and macOS say verbatim. That file keeps runnerCopy.ts's shape so this can read it as text
/// (its own spec holds it to it): one `export const X = '…'` per fixed sentence, and one
/// `export function` per sentence with values in it, whose body is a single template literal. So this
/// puts each `'…' + '…'` wrap back together, holds every Swift constant to the web declaration of the
/// same name, and renders every Swift template with the web's own `${…}` as its values to compare the
/// whole sentence.
///
/// Names correspond one to one, as in `RunnerPageCopyParityTests`: a sentence added at one end and not
/// the other fails here too — but for the web's that this end has nowhere to say (`notOnThisEnd`),
/// each named with why. A missing counterpart is a failure, never an `XCTSkip`.
final class RunnerAccountCopyParityTests: XCTestCase {

    private static let webCopy = "src/web/src/lib/runnerAccountCopy.ts"
    private static let swiftCopy = "src/macos/OrbitKit/Sources/OrbitKit/App/RunnerAccountCopy.swift"

    private enum ParityError: Error, CustomStringConvertible {
        case noRepo
        var description: String {
            "\(RunnerAccountCopyParityTests.webCopy) was not found above this test file. OrbitKit's "
                + "RunnerAccountCopy is one half of a pair; if the web half moved, move this check with "
                + "it rather than deleting it."
        }
    }

    /// The repo root, found by walking up from this file until the web copy is under foot.
    private func repoRoot() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent(Self.webCopy).path) {
                return dir
            }
            dir = dir.deletingLastPathComponent()
        }
        throw ParityError.noRepo
    }

    private func source(_ relative: String) throws -> String {
        try String(contentsOf: try repoRoot().appendingPathComponent(relative), encoding: .utf8)
    }

    /// runnerAccountCopy.ts with its string literals put back together: where a `'…' + '…'` wrap falls
    /// is a formatting decision, while the words are the contract.
    private func flatWebCopy() throws -> String {
        try source(Self.webCopy)
            .replacingOccurrences(of: "'\\s*\\+\\s*'", with: "", options: .regularExpression)
            .replacingOccurrences(of: "=\\s*\\n\\s*'", with: "= '", options: .regularExpression)
    }

    /// Every match of `pattern`, as its capture groups, in source order.
    private func captures(_ source: String, _ pattern: String) throws -> [[String]] {
        let re = try NSRegularExpression(pattern: pattern, options: [.anchorsMatchLines])
        return re.matches(in: source, range: NSRange(source.startIndex..., in: source)).map { match in
            (1..<match.numberOfRanges).map { index in
                Range(match.range(at: index), in: source).map { String(source[$0]) } ?? ""
            }
        }
    }

    private func webConstants() throws -> [String: String] {
        let found = try captures(try flatWebCopy(), "^export const ([A-Z0-9_]+) = '([^'\\n]*)';$")
        return Dictionary(found.map { ($0[0], $0[1]) }, uniquingKeysWith: { first, _ in first })
    }

    private func webTemplates() throws -> [String: String] {
        let found = try captures(try flatWebCopy(),
                                 "^export function (\\w+)\\([^)]*\\): string \\{\\n  return `([^`]*)`;\\n\\}$")
        return Dictionary(found.map { ($0[0], $0[1]) }, uniquingKeysWith: { first, _ in first })
    }

    // MARK: this end

    private static let constants: [(name: String, value: String)] = [
        ("RUNNER_DEFAULT_USE_AGAIN", RunnerAccountCopy.RUNNER_DEFAULT_USE_AGAIN),
    ]

    /// This end's templates, each handed the web's own interpolations as its values.
    private static let templates: [(name: String, rendered: String)] = [
        ("runnerAccountRemoveTitle", RunnerAccountCopy.runnerAccountRemoveTitle(name: "${name}")),
        ("runnerDefaultRemoveDetail", RunnerAccountCopy.runnerDefaultRemoveDetail(runner: "${runner}", cli: "${cli}")),
        ("runnerAccountRemoveDetailAutomatic", RunnerAccountCopy.runnerAccountRemoveDetailAutomatic(runner: "${runner}")),
        ("runnerAccountRemoveDetailLast", RunnerAccountCopy.runnerAccountRemoveDetailLast(runner: "${runner}",
                                                                                          name: "${name}")),
        ("runnerDefaultRemovedLine", RunnerAccountCopy.runnerDefaultRemovedLine(name: "${name}", dir: "${dir}")),
        ("runnerDefaultUseAgainFailed", RunnerAccountCopy.runnerDefaultUseAgainFailed(name: "${name}")),
    ]

    /// The web's declarations this end has nowhere to say, and why.
    private static let notOnThisEnd: [String: String] = [
        "ACCOUNT_SELECT_DEFAULT_REMOVED": "the web workspace form's account field; iOS and macOS have none",
        "ACCOUNT_SELECT_GONE_AUTOMATIC": "the web workspace form's account field; iOS and macOS have none",
    ]

    // MARK: the words

    func testEveryConstantIsTheWebDeclarationOfTheSameName() throws {
        let web = try webConstants()
        for (name, value) in Self.constants {
            XCTAssertEqual(web[name], value, "\(name) drifted from runnerAccountCopy.ts")
        }
    }

    func testEveryTemplateIsTheWebTemplateWordForWord() throws {
        let web = try webTemplates()
        for (name, rendered) in Self.templates {
            XCTAssertEqual(web[name], rendered, "\(name) drifted from runnerAccountCopy.ts's template")
        }
    }

    // MARK: the names

    /// Every sentence at either end has its counterpart under the same name, or is named above as one
    /// this end has nowhere to say. A declaration this check cannot read is named too.
    func testBothEndsDeclareTheSameSentencesUnderTheSameNames() throws {
        let raw = try source(Self.webCopy)
        let webConstants = try webConstants()
        let webTemplates = try webTemplates()
        XCTAssertEqual(webConstants.count, try captures(raw, "^export const (\\w+)").count,
                       "runnerAccountCopy.ts declares a constant this check cannot read — keep each fixed "
                           + "sentence one single-quoted `export const`")
        XCTAssertEqual(webTemplates.count, try captures(raw, "^export function (\\w+)").count,
                       "runnerAccountCopy.ts declares a function this check cannot read — keep each one a "
                           + "single `return` of one template literal")

        let swift = try source(Self.swiftCopy)
        let swiftConstants = Set(try captures(swift, "static let (\\w+)").map { $0[0] })
        let swiftTemplates = Set(try captures(swift, "static func (\\w+)").map { $0[0] })
        let web = Set(webConstants.keys).union(webTemplates.keys)

        for name in Self.notOnThisEnd.keys.sorted() where !web.contains(name) {
            XCTFail("\(name) is listed as the web's alone, but runnerAccountCopy.ts no longer declares it")
        }
        for name in Set(webConstants.keys).subtracting(swiftConstants).subtracting(Self.notOnThisEnd.keys).sorted() {
            XCTFail("runnerAccountCopy.ts declares \(name), which RunnerAccountCopy does not")
        }
        for name in Set(webTemplates.keys).subtracting(swiftTemplates).subtracting(Self.notOnThisEnd.keys).sorted() {
            XCTFail("runnerAccountCopy.ts writes \(name)(…), which RunnerAccountCopy does not")
        }
        for name in swiftConstants.union(swiftTemplates).subtracting(web).sorted() {
            XCTFail("RunnerAccountCopy declares \(name), which runnerAccountCopy.ts does not")
        }
        XCTAssertEqual(Set(Self.constants.map(\.name)), swiftConstants, "list every RunnerAccountCopy constant above")
        XCTAssertEqual(Set(Self.templates.map(\.name)), swiftTemplates, "list every RunnerAccountCopy template above")
    }
}
