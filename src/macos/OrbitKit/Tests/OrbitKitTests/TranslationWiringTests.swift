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
        XCTAssertTrue(bubbles.contains("SessionTranslation.shownUserText(bubble.text, bubble.translation, flipped: flipped && !bilingual)"))
        XCTAssertTrue(bubbles.contains("SessionTranslation.userFoot(bubble.translation, flipped: flipped, bilingual: bilingual, agentLanguage: agentLanguage,"))
        XCTAssertTrue(bubbles.contains("PlatformPasteboard.copyString(words)"), "copy hands back the words on screen")
        XCTAssertTrue(bubbles.contains("SessionTranslation.shownReplyText(bubble.displayText, bubble.translation,"))
        XCTAssertTrue(bubbles.contains("SessionTranslation.replyFoot(bubble.translation, pending: awaiting, flipped: flipped,"))
        XCTAssertTrue(bubbles.contains("case .retryTurn: if let id = bubble.turnId { translationActions?.retryTurn(id) }"))
        XCTAssertTrue(bubbles.contains("case .sendAsWritten: if let id = bubble.turnId { translationActions?.sendAsWritten(id) }"))
        XCTAssertTrue(bubbles.contains("case .cancelTurn: translationActions?.cancelTurn(bubble)"))
        XCTAssertTrue(bubbles.contains("cancellable: translationActions != nil && SessionTranslation.offersCancel(bubble))"),
                      "no Cancel without a door, or under the opening prompt")
        XCTAssertTrue(bubbles.contains("case .retryReply: if let seq = bubble.seq { translationActions?.retryReply(seq) }"))
    }

    /// "Show both languages" (02-bilingual.png): both bubbles draw the English OrbitKit hands them, a
    /// reply's collapsible, and the console reads the account's switch.
    func testTheBubblesDrawBothLanguagesWhenTheAccountSaysSo() throws {
        let bubbles = try source(app + "Views/Console/MessageBubbles.swift")
        XCTAssertTrue(bubbles.contains("private var bilingual: Bool { translationActions?.bilingual == true }"))
        XCTAssertTrue(bubbles.contains("SessionTranslation.userEnglish(bubble.text, bubble.translation, bilingual: bilingual && !originalHidden)"))
        XCTAssertTrue(bubbles.contains("if let english { BilingualEnglishView(english: english, agentLanguage: agentLanguage) }"))
        XCTAssertTrue(bubbles.contains("SessionTranslation.replyEnglish(bubble.displayText, bubble.translation,"))
        // "Hide original" (docs/mocks/translation-hide-original): each bubble hides its own original.
        XCTAssertEqual(bubbles.components(separatedBy: "case .hideOriginal: originalHidden.toggle()").count - 1, 2)
        XCTAssertTrue(bubbles.contains("SessionTranslation.replyPairs(bubble.displayText, bubble.translation, bilingual: bilingual && !originalHidden)"))
        XCTAssertTrue(bubbles.contains("BilingualEnglishView(english: english, agentLanguage: agentLanguage, collapsible: true)"))
        // A reply whose blocks pair is drawn block by block, its originals under them (03-interleaved.png).
        XCTAssertTrue(bubbles.contains("if bubble.isFinalized, let pairs {"))
        XCTAssertTrue(bubbles.contains("InterleavedReplyView(pairs: pairs)"))
        let views = try source(app + "Views/Console/TranslationViews.swift")
        XCTAssertTrue(views.contains("struct InterleavedReplyView: View {"))
        XCTAssertTrue(views.contains("Text(BilingualEnglishView.inline(original))"))
        XCTAssertTrue(views.contains("let collapsed = collapsible && !open && lines > BilingualEnglish.collapseLines"))
        XCTAssertTrue(views.contains(".lineLimit(collapsed ? 2 : nil)"))
        XCTAssertTrue(views.contains("Text(TranslationCopy.showEnglishLabel(lines: lines, agentLanguage)).underline()"))
        // Inline code in the English is drawn as code, not as backticks.
        XCTAssertTrue(views.contains("Text(Self.inline(english))"))
        XCTAssertTrue(views.contains("interpretedSyntax: .inlineOnlyPreservingWhitespace"))
        let console = try source(app + "Views/Console/ConsoleView.swift")
        XCTAssertTrue(console.contains("bilingual: SessionTranslation.bilingual(appModel.user?.preferences),"))
        XCTAssertTrue(console.contains("agentLanguage: SessionTranslation.agentLanguage(appModel.user?.preferences),"))
    }

    /// A message held for its translation stays in the conversation with its foot and its doors (above),
    /// never in the tray, which only waits for the engine (2bb2eb62b, web `inPendingTray`): the tray
    /// draws no translation foot.
    func testTheTrayDrawsNoTranslationFoot() throws {
        let tray = try source(app + "Views/Console/PendingTrayView.swift")
        XCTAssertFalse(tray.contains("TranslationFootView"))
        XCTAssertFalse(tray.contains("translationActions"))
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
        XCTAssertTrue(console.contains("cancelTurn: { bubble in Task { await console.cancelUntranslated(bubble) } },"))
        let start = try XCTUnwrap(model.range(of: "func cancelUntranslated(_ bubble: UserBubble) async {"))
        let cancel = String(model[start.upperBound...].prefix(1600))
        // Files are read before the DELETE, which deletes them with the turn.
        let read = try XCTUnwrap(cancel.range(of: "attachments.data(for: ref.id)"))
        let withdraw = try XCTUnwrap(cancel.range(of: "try await api.withdrawTurn(sessionID: sessionID, turnId: turnId)"))
        XCTAssertLessThan(read.lowerBound, withdraw.lowerBound)
        XCTAssertTrue(cancel.contains("ToastRequest(message: \"Couldn't cancel the message\""))
        XCTAssertTrue(cancel.contains("reducer.removeWithdrawnSteer(turnId: turnId)"))
        XCTAssertTrue(cancel.contains("composerText = HeldCancel.composer(composerText, restoring: words)"))
        XCTAssertTrue(cancel.contains("attach(filename: ref.name"))
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
        XCTAssertTrue(composer.contains("agentLanguage: SessionTranslation.agentLanguage(app.user?.preferences),"))
        let tag = try source(app + "Views/Console/TranslationViews.swift")
        XCTAssertTrue(tag.contains("Text(language.tag(to: agentLanguage, unavailable: unavailable))"),
                      "the tag names the agent language, and says when messages will wait")
        // Frame 6 of docs/ux/translation-failure-policy.html: the tag reads the account's skip, redraws when it
        // passes, and the account is read again when the server announces a change.
        XCTAssertTrue(composer.contains("unavailableUntil: SessionTranslation.temporarilyUnavailableUntil(app.user),"))
        XCTAssertTrue(tag.contains("TimelineView(.explicit([until])) { context in"))
        let appModel = try source(app + "AppModel.swift")
        XCTAssertTrue(appModel.contains("case .account:\n            whenSeen(\"account\") { app in\n                Task { @MainActor [weak app] in\n"
                                        + "                    if let app, let me = try? await app.api?.me() { app.assignIfChanged(\\.user, me) }"))
        // A refused card answer draws the reason its 422 gave.
        XCTAssertTrue(cards.contains("if let refusedFoot = console.answersRefusedUntranslated[row.itemId] {"))
        XCTAssertTrue(tag.contains("TranslationFootView(parts: held.foot) { action in"))
        // A reason's sentence wraps under the bubble, its presses on the line below, instead of being cut off.
        XCTAssertTrue(tag.contains("ViewThatFits(in: .horizontal) {"))
        XCTAssertTrue(tag.contains(".fixedSize(horizontal: false, vertical: true)"))
        XCTAssertFalse(tag.contains(".minimumScaleFactor(0.85)"))
        // The project done card's "Not yet" refusal is a card answer too: it draws the reason its 422 gave.
        let done = try source(app + "Views/ProjectDoneCards.swift")
        XCTAssertTrue(done.contains("if let refusedFoot = notYetRefused, let onNotYet {"))
        XCTAssertTrue(done.contains("TranslationFootView(parts: refusedFoot) { action in"))
        for file in ["ConsoleModel.swift", "ProjectsModel.swift"] {
            XCTAssertTrue(try source(app + file).contains("? SessionTranslation.refusedAnswerFoot(after: error) : nil"), file)
        }
        XCTAssertTrue(composer.contains("app.nav.openSettings(at: .general)"))
    }

    func testSettingsHasTheRowsOnBothPlatforms() throws {
        let ios = try source(app + "Views/SettingsSheet.swift")
        XCTAssertTrue(ios.contains("Toggle(TranslationCopy.translateConversations, isOn: $translation)"))
        XCTAssertTrue(ios.contains("TranslationLanguagePicker(side: .owner)"), "Your language is a pushed list")
        XCTAssertTrue(ios.contains("TranslationLanguagePicker(side: .agent)"), "so is Agents work in")
        XCTAssertTrue(ios.contains("LabeledContent(TranslationCopy.agentsWorkIn, value: SessionTranslation.agentLanguage(prefs).name)"))
        XCTAssertTrue(ios.contains("ForEach(TranslationLanguage.allCases, id: \\.self) { lang in"), "both over the full list")
        XCTAssertTrue(ios.contains("UpdatePreferencesRequest(translationAgentLanguage: lang.rawValue)"))
        XCTAssertTrue(ios.contains("Text(TranslationCopy.translateConversationsHint(SessionTranslation.agentLanguage(prefs))"),
                      "the footer names the agent language")
        XCTAssertTrue(ios.contains("Text(TranslationCopy.unavailable)"))
        XCTAssertTrue(ios.contains(".disabled(unavailable)"))
        let mac = try source(app + "Views/SettingsAdminView.swift")
        XCTAssertTrue(mac.contains("Section(TranslationCopy.title) {"))
        XCTAssertTrue(mac.contains("Toggle(TranslationCopy.translateConversations, isOn: $translation)"))
        XCTAssertTrue(mac.contains("Picker(TranslationCopy.yourLanguage, selection: $translationLanguage)"))
        XCTAssertTrue(mac.contains("Picker(TranslationCopy.agentsWorkIn, selection: $translationAgentLanguage)"))
        XCTAssertEqual(mac.components(separatedBy: "ForEach(TranslationLanguage.allCases, id: \\.self) { Text($0.name).tag($0) }").count - 1, 2,
                       "both pickers over the full list")
        XCTAssertTrue(mac.contains("UpdatePreferencesRequest(translationAgentLanguage: translationAgentLanguage.rawValue)"))
        XCTAssertTrue(mac.contains("Text(TranslationCopy.translateConversationsHint(translationAgentLanguage))"))
        XCTAssertTrue(mac.contains("translationAgentLanguage = SessionTranslation.agentLanguage(p)"))
        XCTAssertFalse(mac.contains("TranslationCopy.english") || ios.contains("TranslationCopy.english"),
                       "no fixed English")
        XCTAssertTrue(mac.contains(".disabled(SessionTranslation.unavailable(model.user))"))
        // A Mac Form's switch has no label of its own: UI tests find these two by identifier.
        XCTAssertTrue(mac.contains(".accessibilityIdentifier(TranslationCopy.toggleIdentifier)"))
        XCTAssertTrue(mac.contains(".accessibilityIdentifier(TranslationCopy.languageIdentifier)"))
        XCTAssertTrue(mac.contains(".accessibilityIdentifier(TranslationCopy.agentLanguageIdentifier)"))
        XCTAssertTrue(ios.contains(".accessibilityIdentifier(TranslationCopy.toggleIdentifier)"))
        // Show both languages: only while translation is on, written the moment it flips, and the
        // footer's sentence on both.
        for src in [ios, mac] {
            XCTAssertTrue(src.contains("if translation {"))
            XCTAssertTrue(src.contains("Toggle(TranslationCopy.showBothLanguages, isOn: $bilingual)"))
            XCTAssertTrue(src.contains(".accessibilityIdentifier(TranslationCopy.bilingualIdentifier)"))
            XCTAssertTrue(src.contains("UpdatePreferencesRequest(translationBilingual:"))
            XCTAssertTrue(src.contains("TranslationCopy.bilingualFootnote"))
            XCTAssertTrue(src.contains("bilingual = p?.translationBilingual == true"))
        }
    }
}
