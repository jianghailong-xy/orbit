import Foundation
import XCTest
@testable import OrbitKit

/// SwiftUI doesn't exist on Linux, so nothing here compiles the app shells. This holds every
/// confirmation in the app to the one place that chooses its shape by width
/// (`Views/ConfirmationStyle.swift`): a phone gets an alert — centred, screen dimmed, Cancel beside
/// the destructive press, as ChatGPT's own log out asks — and a tablet keeps the panel anchored to
/// whatever raised it.
///
/// A view that names `.confirmationDialog` itself asks the tablet's question on both, which is the
/// drift this checks for. Like the other wiring tests it reads the raw text, so the remedy for a
/// failure is to move that call onto `orbitConfirmation`, not to delete the check.
final class ConfirmationStyleWiringTests: XCTestCase {
    private struct SourceMissing: Error, CustomStringConvertible {
        let path: String
        var description: String {
            "\(path) wasn't found above this test. If it moved, point this check at its new home — "
                + "don't delete the check."
        }
    }

    /// Every Swift file of the app, unedited.
    private func appSources() throws -> [(path: String, text: String)] {
        let relative = "src/macos/OrbitApp/Sources/OrbitApp"
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let root = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: root.path) {
                let walk = try XCTUnwrap(FileManager.default.enumerator(at: root,
                                                                        includingPropertiesForKeys: nil))
                var files: [(path: String, text: String)] = []
                for case let url as URL in walk where url.pathExtension == "swift" {
                    files.append((url.path, try String(contentsOf: url, encoding: .utf8)))
                }
                XCTAssertFalse(files.isEmpty, "the app source tree listed no Swift files")
                return files
            }
            dir.deleteLastPathComponent()
        }
        throw SourceMissing(path: relative)
    }

    /// The text without its comment lines, which are free to talk about what the code must not do.
    private func code(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
    }

    func testEveryConfirmationAsksThroughTheWidthAwareStyle() throws {
        for (path, text) in try appSources() where !path.hasSuffix("ConfirmationStyle.swift") {
            XCTAssertFalse(code(text).contains(".confirmationDialog("),
                           "\(path) names a confirmationDialog itself — the phone would get the "
                               + "tablet's anchored panel. Use `.orbitConfirmation`.")
        }
    }

    /// Every confirmation offers a way out. The panel this replaced could be dismissed by tapping
    /// outside it; an alert cannot — it stays until one of its buttons is pressed — so a question
    /// without a Cancel is one the reader can only answer one way.
    func testEveryConfirmationOffersACancel() throws {
        for (path, text) in try appSources() where !path.hasSuffix("ConfirmationStyle.swift") {
            let lines = code(text).split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
            for (index, line) in lines.enumerated() where line.contains(".orbitConfirmation(") {
                // A generous window: the actions closure sits below the title and the binding.
                let window = lines[index..<min(index + 30, lines.count)].joined(separator: "\n")
                XCTAssertTrue(window.contains("role: .cancel"),
                              "\(path):\(index + 1) asks without a Cancel — an alert with no way out")
            }
        }
    }

    /// And the style itself asks both, so the rule it enforces is the rule it implements.
    func testTheStyleAsksAnAlertOnAPhoneAndAPanelOnATablet() throws {
        let style = code(try appSources().first { $0.path.hasSuffix("ConfirmationStyle.swift") }
            .map(\.text) ?? "")
        XCTAssertTrue(style.contains("if hSize == .compact"), "the width decides")
        XCTAssertTrue(style.contains(".alert("), "a phone gets an alert")
        XCTAssertTrue(style.contains(".confirmationDialog("), "a tablet keeps the anchored panel")
        XCTAssertTrue(style.contains("@Environment(\\.horizontalSizeClass)"), "read from the environment")
    }
}
