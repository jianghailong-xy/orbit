import Foundation
import XCTest

/// A translation folded into a stored reply is written to disk (web b1b4b3784e): the registry asks
/// `TranscriptSaveLedger` rather than comparing `maxSeq`. `ConsoleRegistry.swift` compiles only in
/// the macOS and iOS jobs, so the wire is asserted over its source; the rule is tested in
/// `TranscriptSaveLedgerTests`.
final class TranscriptSaveLedgerWiringTests: XCTestCase {
    private struct SourceMissing: Error, CustomStringConvertible {
        let what: String
        var description: String {
            "\(what) wasn't found above this test. If it moved, point this check at its new home — "
                + "don't delete the check."
        }
    }

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir.deleteLastPathComponent()
        }
        throw SourceMissing(what: relative)
    }

    private func app(_ file: String) throws -> String {
        try source("src/macos/OrbitApp/Sources/OrbitApp/" + file)
    }

    /// From `start` up to the next `end`, its code lines only (trimmed, joined by spaces): a call
    /// commented out still contains its own words.
    private func code(_ text: String, from start: String, to end: String) throws -> String {
        guard let lower = text.range(of: start),
              let upper = text.range(of: end, range: lower.upperBound..<text.endIndex) else {
            throw SourceMissing(what: "`\(start)` … `\(end)`")
        }
        return text[lower.lowerBound..<upper.lowerBound]
            .split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("//") }
            .joined(separator: " ")
    }


    func testTheRegistryWritesWhateverTheDiskCopyLacksNotOnlyANewMaxSeq() throws {
        let registry = try app("ConsoleRegistry.swift")
        XCTAssertFalse(registry.contains("savedSeq"), "maxSeq alone cannot say a folded translation is unsaved")
        let persist = try code(registry, from: "private func persist(_ sessionID: String, _ model: ConsoleModel, synchronously: Bool = true) {",
                               to: "private func evict(")
        XCTAssertTrue(persist.contains("guard saved.claim(sessionID, reducer) else { return }"),
                      "the ledger decides, and claims the write")
        XCTAssertTrue(persist.contains("store.save(sessionID: sessionID, reducer: reducer)"))
        let make = try code(registry, from: "private func makeModel(", to: "let model = ConsoleModel(")
        XCTAssertTrue(make.contains("if let restored { saved.restored(sessionID, restored) }"),
                      "a restored console starts level with its disk copy")
        let all = try code(registry, from: "func persistAll() {", to: "func reconnectAll() {")
        XCTAssertTrue(all.contains("for (id, model) in models { persist(id, model) }"),
                      "backgrounding and sign-out write through the same rule")
    }
}
