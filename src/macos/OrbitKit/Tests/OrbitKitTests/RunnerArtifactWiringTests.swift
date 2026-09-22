import Foundation
import XCTest
@testable import OrbitKit

/// The wires between reading a path (`AttachmentLink.runnerArtifactPath`, proved in
/// `AttachmentLinkTests`) and the three places a reader can tap one.
///
/// SwiftUI does not exist on Linux and these files compile only in the macOS and iOS jobs, so what
/// the views do with the reading is asserted over the source, the way `ReferencedTaskWiringTests`
/// does — each assertion written so that CUTTING the wire turns it red.
///
/// What the wires are for: a reply that links a file by where the agent wrote it used to be a dead
/// end on every client — a paperclip chip whose tap did nothing — because the bytes are on the
/// runner. The session's own files can be fetched now (the artifact route, which the runner
/// answers), so the tap has to actually reach it: through the store, with the session id that
/// ConsoleView put in the environment.
///
/// What it cannot see is how any of it looks — that is what the beta and the screenshots are for.
final class RunnerArtifactWiringTests: XCTestCase {

    private enum WiringError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let what):
                return "\(what) was not found above this test. If it moved, move this check with "
                    + "it rather than deleting it: it is the only gate on Linux that sees whether "
                    + "a tap still reaches the runner."
            }
        }
    }

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

    /// One view's own stretch of the file, so a match 200 lines away cannot answer for it.
    private func section(_ source: String, from: String, to: String? = nil) throws -> String {
        guard let start = source.range(of: from) else { throw WiringError.missing(from) }
        guard let to else { return String(source[start.lowerBound...]) }
        guard let end = source.range(of: to, range: start.upperBound..<source.endIndex) else {
            throw WiringError.missing("\(from) … \(to)")
        }
        return String(source[start.lowerBound..<end.lowerBound])
    }

    private func expect(_ haystack: String, _ needle: String, _ said: String) {
        XCTAssertTrue(haystack.contains(needle), "\(said) — missing `\(needle)`")
    }

    /// A markdown image whose source is a path: the chip it falls back to asks the session's runner
    /// for the bytes, and opens what comes back instead of leaving the tap unanswered.
    func testAnUnreachableImageChipFetchesTheSessionsOwnFile() throws {
        let markdown = try source("src/macos/OrbitApp/Sources/OrbitApp/Views/MarkdownView.swift")
        let view = try section(markdown, from: "private struct MarkdownImageView: View",
                              to: "/// Inline-only Markdown")
        expect(view, "AttachmentLink.runnerArtifactPath(source: source, sessionID: sessionID)",
               "the chip no longer reads which paths the artifact route can serve")
        expect(view, "sessionPreview?.sessionID",
               "the chip no longer takes the session it would ask through")
        expect(view, "store.artifactData(sessionID:",
               "the chip no longer fetches through the attachment store")
        expect(view, "FileHandoff.deliver(",
               "a fetched file that is not an image is no longer handed to the platform")
    }

    /// A prose link to the same kind of file: it keeps its link (rather than being drawn as plain
    /// text) exactly when the artifact route can serve it, and the tap downloads it.
    func testAProseLinkToTheSessionsOwnFileIsDownloadable() throws {
        let text = try source("src/macos/OrbitApp/Sources/OrbitApp/Views/Console/SelectableText.swift")
        let append = try section(text, from: "private func append(_ seg: ProseSegment",
                                 to: "private func markerRun(for seg: ProseSegment")
        expect(append, "AttachmentLink.runnerArtifactPath(link, sessionID: sessionID)",
               "a file in the session's own directories no longer keeps its link")
        expect(append, "attrs[.link] = link",
               "the link attribute is no longer set for a servable path")
        let coordinator = try section(text, from: "@MainActor final class Coordinator",
                                      to: "/// A read-only `UITextView`")
        expect(coordinator, "AttachmentLink.runnerArtifactPath(url, sessionID: sessionID)",
               "a tapped path link no longer resolves to the artifact route")
        expect(coordinator, "attachments.artifactData(sessionID: sessionID, path: path)",
               "a tapped path link no longer fetches through the artifact route")
        let update = try section(text, from: "func updateUIView(_ tv: UITextView",
                                 to: "// iOS 16+: report the fitted size")
        expect(update, "context.coordinator.sessionID = sessionPreview?.sessionID",
               "the coordinator no longer learns which session to ask about a path")
    }

    /// Where the session id comes from: the console builds the value every transcript surface reads.
    func testTheConsoleNamesTheSessionForPathFetches() throws {
        let console = try source("src/macos/OrbitApp/Sources/OrbitApp/Views/Console/ConsoleView.swift")
        let builder = try section(console, from: "private func sessionImagePreview(_ console: ConsoleModel)",
                                  to: "/// Screenshot bytes that open tool cards fetched back")
        expect(builder, "sessionID: console.sessionID",
               "the console no longer tells the transcript which session its paths belong to")
    }

    /// The chip on a file the user attached — the other tap that used to do nothing.
    func testAFileChipOpensTheAttachment() throws {
        let attachments = try source(
            "src/macos/OrbitApp/Sources/OrbitApp/Views/Console/AttachmentViews.swift")
        let chip = try section(attachments, from: "struct ChatAttachmentFile: View",
                               to: "/// A user-turn image attachment rendered as a uniform square")
        expect(chip, "Button { fetch() }",
               "the file chip is drawn as a label again, with no tap")
        expect(chip, "store.data(for: attachment.id)",
               "the file chip no longer fetches the attachment's bytes")
        expect(chip, "FileHandoff.deliver(",
               "the file chip no longer hands the bytes to the platform")
    }
}
