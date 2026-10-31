import Foundation
import XCTest

/// The app's half of a recoverable diagnostic's row: `TranscriptReducer` makes it a `.diagnostic`, and
/// OrbitApp draws it as web draws `.chat-notice.chat-diagnostic`, grey with only its mark in the
/// warning tone, while a deliberate notice keeps the warning tone on the whole line. OrbitApp does not
/// compile on Linux, so the view is read as source, each check on its own stretch of the file.
final class DiagnosticRowWiringTests: XCTestCase {

    private enum WiringError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let what):
                return "\(what) was not found. If it was renamed, rename it here too — that is what "
                    + "this check is for."
            }
        }
    }

    private static let console = "src/macos/OrbitApp/Sources/OrbitApp/Views/Console/ConsoleView.swift"

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw WiringError.missing(relative)
    }

    private func section(_ source: String, from: String, to: String) throws -> String {
        guard let start = source.range(of: from),
              let end = source.range(of: to, range: start.upperBound..<source.endIndex) else {
            throw WiringError.missing("\(from) … \(to)")
        }
        return String(source[start.lowerBound..<end.lowerBound])
    }

    /// The transcript draws the two kinds apart: a notice is the warning-toned line it always was, a
    /// diagnostic is a row of its own.
    func testTheTranscriptDrawsANoticeAndADiagnosticApart() throws {
        let item = try section(try source(Self.console), from: "struct TranscriptItemView: View {",
                               to: "private func steerControls(")
        let notice = try section(item, from: "case .notice(_, let message):", to: "case .diagnostic(let notice):")
        XCTAssertTrue(notice.contains(#"Label(message, systemImage: "exclamationmark.triangle.fill")"#)
                      && notice.contains(".font(.orbitLabel).foregroundStyle(.orange)"),
                      "a notice keeps the warning tone on its whole line")
        XCTAssertTrue(item.contains("case .diagnostic(let notice):\n            DiagnosticNoticeRow(notice: notice)"),
                      "a diagnostic is drawn by its own row")
    }

    /// Only the mark keeps the warning tone; the label is dim, the engine's words grey, the count dimmed.
    func testADiagnosticRowIsGreyWithOnlyItsMarkInTheWarningTone() throws {
        let row = try section(try source(Self.console), from: "struct DiagnosticNoticeRow: View {",
                              to: "/// What `TranscriptView` watches")
        XCTAssertTrue(row.contains(#"Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)"#),
                      "the mark keeps the warning tone")
        XCTAssertTrue(row.contains("Text(notice.label).font(.orbitMeta).monospacedDigit().foregroundStyle(.tertiary)"),
                      "the label is dim")
        XCTAssertTrue(row.contains("Text(notice.text).foregroundStyle(.secondary)"), "the engine's words are grey")
        XCTAssertTrue(row.contains(#"Text("×\(notice.repeats)")"#)
                      && row.contains(".foregroundStyle(Color.orange.opacity(0.7))"), "the count is the dimmed mark's tone")
        XCTAssertTrue(row.contains(".help(notice.message)"), "the whole logged line is its help, as web's tooltip")
        XCTAssertFalse(row.contains(".font(.orbitLabel).foregroundStyle(.orange)"), "the row is not a notice's line")
    }
}
