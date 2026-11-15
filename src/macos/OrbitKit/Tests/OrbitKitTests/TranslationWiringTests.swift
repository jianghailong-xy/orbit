import Foundation
import XCTest

/// SwiftUI does not exist on this platform, so the views that draw Settings › Translation are held to
/// it over their source (as `PromptSuggestionTests` holds the composer): each one reads what OrbitKit
/// decides — `SessionTranslation.userFoot` / `replyFoot`, `PendingApproval.shownInput`, the composer tag, and
/// the Settings rows on iOS and macOS.
final class TranslationWiringTests: XCTestCase {

    private let app = "src/macos/OrbitApp/Sources/OrbitApp/"

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw NSError(domain: "TranslationWiringTests", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "\(relative) not found"])
    }

    func testTheBubblesDrawTheFootAndTheToggle() throws {
        let bubbles = try source(app + "Views/Console/MessageBubbles.swift")
        XCTAssertTrue(bubbles.contains("SessionTranslation.shownUserText(bubble.text, bubble.translation, flipped: flipped)"))
        XCTAssertTrue(bubbles.contains("SessionTranslation.userFoot(bubble.translation, flipped: flipped)"))
        XCTAssertTrue(bubbles.contains("PlatformPasteboard.copyString(words)"), "copy hands back the words on screen")
        XCTAssertTrue(bubbles.contains("SessionTranslation.shownReplyText(bubble.displayText, bubble.translation,"))
        XCTAssertTrue(bubbles.contains("SessionTranslation.replyFoot(bubble.translation, pending: awaiting, flipped: flipped)"))
        XCTAssertTrue(bubbles.contains("case .retryTurn: if let id = bubble.turnId { translationActions?.retryTurn(id) }"))
        XCTAssertTrue(bubbles.contains("case .sendAsWritten: if let id = bubble.turnId { translationActions?.sendAsWritten(id) }"))
        XCTAssertTrue(bubbles.contains("case .retryReply: if let seq = bubble.seq { translationActions?.retryReply(seq) }"))
    }

    func testTheTrayDrawsAHeldMessagesFoot() throws {
        let tray = try source(app + "Views/Console/PendingTrayView.swift")
        XCTAssertTrue(tray.contains("TranslationFootView(parts: SessionTranslation.userFoot(row.bubble.translation, flipped: false))"))
        XCTAssertTrue(tray.contains("case .retryTurn: translationActions?.retryTurn(id)"))
        XCTAssertTrue(tray.contains("case .sendAsWritten: translationActions?.sendAsWritten(id)"))
    }

    func testTheConsoleHandsTheBubblesItsDoors() throws {
        let console = try source(app + "Views/Console/ConsoleView.swift")
        XCTAssertTrue(console.contains(".environment(\\.translationActions, TranslationActions("))
        XCTAssertTrue(console.contains("on: SessionTranslation.isOn(appModel.user),"))
        // The sticky question quotes what the owner wrote, as the bubble under it does.
        XCTAssertTrue(console.contains("let shown = SessionTranslation.shownUserText(bubble.text, bubble.translation, flipped: false)"))
        XCTAssertTrue(console.contains("questionCapsule(shown)") && console.contains("Text(shown)"))
        let model = try source(app + "ConsoleModel.swift")
        XCTAssertTrue(model.contains("api.retryTurnTranslation(sessionID: sessionID, turnId: turnId)"))
        XCTAssertTrue(model.contains("api.sendTurnAsWritten(sessionID: sessionID, turnId: turnId)"))
        XCTAssertTrue(model.contains("api.retryReplyTranslation(sessionID: sessionID, seq: seq)"))
        XCTAssertTrue(model.contains("translation: accepted.turnTranslation)"), "the send answer's chip")
        XCTAssertTrue(model.contains("catch where SessionTranslation.refusedUntranslated(error) {"))
    }

    func testCardsAndTheComposerShowTheTranslation() throws {
        let cards = try source(app + "Views/ApprovalCards.swift")
        XCTAssertTrue(cards.contains("approval.shownInput.map { Approvals.parseQuestions(from: $0) }"))
        XCTAssertTrue(cards.contains("approval.shownInput?[\"plan\"]"))
        XCTAssertTrue(cards.contains("UntranslatedDecisionRow(console: console, approval: approval)"))
        let composer = try source(app + "Views/ComposerView.swift")
        XCTAssertTrue(composer.contains("ComposerTranslationTag(language: SessionTranslation.language(app.user?.preferences),"))
        XCTAssertTrue(composer.contains("app.nav.openSettings(at: .sessions)"))
    }

    func testSettingsHasTheRowsOnBothPlatforms() throws {
        let ios = try source(app + "Views/SettingsSheet.swift")
        XCTAssertTrue(ios.contains("Toggle(TranslationCopy.translateConversations, isOn: $translation)"))
        XCTAssertTrue(ios.contains("TranslationLanguagePicker()"), "Your language is a pushed list")
        XCTAssertTrue(ios.contains("LabeledContent(TranslationCopy.agentsWorkIn, value: TranslationCopy.english)"))
        XCTAssertTrue(ios.contains("Text(TranslationCopy.unavailable)"))
        XCTAssertTrue(ios.contains(".disabled(unavailable)"))
        let mac = try source(app + "Views/SettingsAdminView.swift")
        XCTAssertTrue(mac.contains("Section(TranslationCopy.title) {"))
        XCTAssertTrue(mac.contains("Toggle(TranslationCopy.translateConversations, isOn: $translation)"))
        XCTAssertTrue(mac.contains("Picker(TranslationCopy.yourLanguage, selection: $translationLanguage)"))
        XCTAssertTrue(mac.contains("LabeledContent(TranslationCopy.agentsWorkIn, value: TranslationCopy.english)"))
        XCTAssertTrue(mac.contains(".disabled(SessionTranslation.unavailable(model.user))"))
        // A Mac Form's switch has no label of its own: UI tests find these two by identifier.
        XCTAssertTrue(mac.contains(".accessibilityIdentifier(TranslationCopy.toggleIdentifier)"))
        XCTAssertTrue(mac.contains(".accessibilityIdentifier(TranslationCopy.languageIdentifier)"))
        XCTAssertTrue(ios.contains(".accessibilityIdentifier(TranslationCopy.toggleIdentifier)"))
    }
}
