import Foundation
import XCTest

/// The composer band's cards over the transcript (the owner, 2026-10-16). Where the band floats over
/// the list on iOS 26 (`ConsoleView.transcriptAndBand`), the rows pass behind every card in it, so a
/// faint wash would let them read straight through: the cards that come and go — a run that never
/// started, an engine to repair, a hand-off, the managed runner's state — wash through
/// `composerBandWash`, which turns to tinted glass only where the band says it floats. Their other
/// homes (the Runners and Tasks pages, an error row in the transcript) keep the wash.
final class ComposerBandGlassWiringTests: XCTestCase {
    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw NSError(domain: "ComposerBandGlassWiringTests", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "\(relative) not found"])
    }

    private let views = "src/macos/OrbitApp/Sources/OrbitApp/Views/"

    func testTheFloatingBandSaysItFloats() throws {
        let console = try source(views + "Console/ConsoleView.swift")
        XCTAssertTrue(console.contains("composerBand(console).environment(\\.floatsOverTranscript, true)"),
                      "the band floating over the transcript tells its cards so")
        let composer = try source(views + "ComposerView.swift")
        XCTAssertTrue(composer.contains("if #available(iOS 26.0, *), floats {"),
                      "and the wash is glass only there")
    }

    func testTheCardsThatComeAndGoWashThroughTheBand() throws {
        let washes: [(String, String)] = [
            ("ManagedRunnerBanner.swift", ".composerBandWash(attention ? .orange : .accentColor, opacity: 0.09)"),
            ("Console/SessionRunStartCard.swift", ".composerBandWash(.orange, opacity: 0.08)"),
            ("TaskRunHandoffCard.swift", ".composerBandWash(tint, opacity: 0.09)"),
            ("TaskRunHandoffCard.swift", ".composerBandWash(.green, opacity: 0.09)"),
        ]
        for (file, wash) in washes {
            XCTAssertTrue(try source(views + file).contains(wash), "\(file) washes through the band: \(wash)")
        }
        let repairs = try source(views + "RunnerSignInView.swift")
        XCTAssertEqual(repairs.components(separatedBy: ".composerBandWash(.orange, opacity: 0.08)").count - 1, 2,
                       "both engine-repair cards wash through the band")
    }

    /// The fold that hides the session's cards while a phone types (`TypingFold`) cuts them to the
    /// stack's frame only on its way down. Open, a cut there sheared the glass's rim and shadow off the
    /// tray and the git bar, and left the tray's shadow in the gap as a slab with square ends.
    func testTheTypingFoldLeavesTheGlassWholeWhileOpen() throws {
        let console = try source(views + "Console/ConsoleView.swift")
        guard let start = console.range(of: "private struct TypingFold: ViewModifier {"),
              let end = console.range(of: "struct TranscriptView: View {", range: start.upperBound..<console.endIndex)
        else { return XCTFail("TypingFold not found") }
        let fold = String(console[start.lowerBound..<end.lowerBound])
        XCTAssertFalse(fold.contains(".clipped()"), "no cut at the stack's own frame while it is open")
        XCTAssertTrue(fold.contains(".clipShape(Rectangle().inset(by: folded ? 0 : -Self.glassBleed))"),
                      "the cut stands clear of the cards' glass until the stack folds")
    }
}
