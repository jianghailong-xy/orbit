import Foundation
import XCTest
@testable import OrbitKit

/// Settings › Translation says the same words on every client (project instructions: "Keep the copy
/// strings identical across clients"). `TranslationCopy` and `TranslationLanguage` carry the web's
/// words to iOS and macOS, and nothing in either build notices a word changed at one end only — so
/// each one is looked up in the web source it came from: the conversation's words in
/// `TRANSLATION_COPY` (src/web/src/lib/translation.ts), the Settings section's on the General page
/// (pages/settings/GeneralPage.tsx, its rows' titles and descriptions in src/shared/src/settingsIndex.ts), and the
/// languages in @orbit/shared translation.ts. A missing counterpart is a FAILURE, never an
/// `XCTSkip`.
final class TranslationCopyParityTests: XCTestCase {

    private static let lib = "src/web/src/lib/translation.ts"
    private static let settings = "src/web/src/pages/settings/GeneralPage.tsx"
    private static let settingsIndex = "src/shared/src/settingsIndex.ts"
    private static let shared = "src/shared/src/translation.ts"

    private enum ParityError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            "\(missingFile) was not found above this test file. Translation on iOS/macOS is one half of a "
                + "pair; if the web half moved, move this check with it rather than deleting it."
        }
        private var missingFile: String { if case .missing(let f) = self { return f } else { return "" } }
    }

    /// The source, with every run of whitespace made one space: where a long sentence or a JSX text
    /// node breaks its line is layout, the words are the contract.
    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
                    .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw ParityError.missing(relative)
    }

    private func assertContains(_ haystack: String, _ needle: String, in file: String,
                                line: UInt = #line) {
        XCTAssertTrue(haystack.contains(needle), "\(file) no longer says: \(needle)", line: line)
    }

    /// A JS string literal as the web writes it: single quotes, or double quotes when the words hold
    /// an apostrophe.
    private func literal(_ words: String) -> String {
        words.contains("'") ? "\"\(words)\"" : "'\(words)'"
    }

    func testTheConversationsWordsAreTheWebs() throws {
        let web = try source(Self.lib)
        let pairs: [(String, String)] = [
            ("translated", TranslationCopy.translated),
            ("showOriginal", TranslationCopy.showOriginal),
            ("hideOriginal", TranslationCopy.hideOriginal),
            ("showBoth", TranslationCopy.showBoth),
            ("showTranslation", TranslationCopy.showTranslation),
            ("original", TranslationCopy.original),
            ("translating", TranslationCopy.translating),
            ("sendFailed", TranslationCopy.sendFailed),
            ("retry", TranslationCopy.retry),
            ("sendAsWritten", TranslationCopy.sendAsWritten),
            ("cancel", TranslationCopy.cancel),
            ("replyPending", TranslationCopy.replyPending),
            ("replyFailed", TranslationCopy.replyFailed),
            ("sentToAgent", TranslationCopy.sentToAgent),
            ("show", TranslationCopy.show),
            ("lines", TranslationCopy.lines),
        ]
        for (key, words) in pairs {
            assertContains(web, "\(key): \(literal(words)),", in: Self.lib)
        }
    }

    func testTheSettingsCardsWordsAreTheWebs() throws {
        let web = try source(Self.settings)
        assertContains(web, #"<SettingsSection title="\#(TranslationCopy.title)">"#, in: Self.settings)
        // The page draws each row's title and description from settingsIndex.ts, which says their words.
        let index = try source(Self.settingsIndex)
        // The switch's line names the agent language: built by `translationEnabledDescription`, which
        // the row is drawn with, and the index's own entry is its English default.
        let hint = TranslationCopy.translateConversationsHint(.en)
        let template = "`" + hint.replacingOccurrences(of: "English", with: "${agentLanguage}") + "`"
        assertContains(index, "translationEnabledDescription(agentLanguage: string): string { return \(template); }",
                       in: Self.settingsIndex)
        assertContains(index, "'translationEnabled', '/settings/general', \(literal(TranslationCopy.translateConversations)), translationEnabledDescription('English'), ",
                       in: Self.settingsIndex)
        assertContains(web, "description={translationEnabledDescription(TRANSLATION_LANGUAGE_NAMES[agentLanguageOf(me)])}",
                       in: Self.settings)
        for (anchor, title, hint) in [
            ("translationLanguage", TranslationCopy.yourLanguage, TranslationCopy.yourLanguageHint),
            ("agentLanguage", TranslationCopy.agentsWorkIn, TranslationCopy.agentsWorkInHint),
        ] {
            assertContains(web, "title={S.\(anchor).title} description={S.\(anchor).description}", in: Self.settings)
            assertContains(index, "'\(anchor)', '/settings/general', \(literal(title)), \(literal(hint))", in: Self.settingsIndex)
        }
        // Both pickers over the one list.
        assertContains(web, "aria-label=\"\(TranslationCopy.agentsWorkIn)\"", in: Self.settings)
        XCTAssertEqual(web.components(separatedBy: "options={TRANSLATION_LANGUAGE_OPTIONS}").count - 1, 2,
                       "\(Self.settings): both pickers offer TRANSLATION_LANGUAGE_OPTIONS")
        assertContains(web, TranslationCopy.footnote, in: Self.settings)
        // Show both languages (02-bilingual.png): its row has a title only, and the footer's sentence.
        assertContains(web, "title={S.translationBilingual.title}", in: Self.settings)
        assertContains(index, "'translationBilingual', '/settings/general', \(literal(TranslationCopy.showBothLanguages)))",
                       in: Self.settingsIndex)
        assertContains(web, #"aria-label="\#(TranslationCopy.showBothLanguages)""#, in: Self.settings)
        assertContains(web, TranslationCopy.bilingualFootnote, in: Self.settings)
        // The notice names the variable in <code> on the web; the words around it are the same.
        let notice = TranslationCopy.unavailable
            .replacingOccurrences(of: "DEEPSEEK_API_KEY", with: "<code>DEEPSEEK_API_KEY</code>")
        assertContains(web, notice, in: Self.settings)
    }

    func testTheLanguagesAreSharedsInItsOrder() throws {
        let shared = try source(Self.shared)
        let codes = TranslationLanguage.allCases.map { "'\($0.rawValue)'" }.joined(separator: ", ")
        // One code a line, with a trailing comma: collapsed, "[ 'en', …, 'bn', ] as const".
        assertContains(shared, "TRANSLATION_LANGUAGES = [ \(codes), ] as const", in: Self.shared)
        for lang in TranslationLanguage.allCases {
            let key = lang.rawValue.contains("-") ? "'\(lang.rawValue)'" : lang.rawValue
            assertContains(shared, "\(key): '\(lang.name)',", in: Self.shared)
        }
        assertContains(shared, "DEFAULT_TRANSLATION_LANGUAGE: TranslationLanguage = '\(TranslationLanguage.default.rawValue)'",
                       in: Self.shared)
        assertContains(shared, "DEFAULT_AGENT_LANGUAGE = '\(TranslationLanguage.agentDefault.rawValue)' satisfies TranslationLanguage",
                       in: Self.shared)
    }

    /// "Show English · N lines" and "Sent to the agent in English" are built as the web builds them,
    /// naming the agent language, and the collapse rule's numbers are shared's.
    func testTheCollapsedEnglishIsCountedAsTheWebCountsIt() throws {
        let web = try source(Self.lib)
        assertContains(web, "`${TRANSLATION_COPY.show} ${TRANSLATION_LANGUAGE_NAMES[agentLang]} · ${lines} ${TRANSLATION_COPY.lines}`", in: Self.lib)
        assertContains(web, "`${TRANSLATION_COPY.sentToAgent} ${TRANSLATION_LANGUAGE_NAMES[agentLang]}`", in: Self.lib)
        XCTAssertEqual(TranslationCopy.showEnglishLabel(lines: 9), "Show English · 9 lines")
        XCTAssertEqual(TranslationCopy.showEnglishLabel(lines: 9, .ja), "Show Japanese · 9 lines")
        XCTAssertEqual(TranslationCopy.sentToAgentLabel(.en), "Sent to the agent in English")
        XCTAssertEqual(TranslationCopy.sentToAgentLabel(.ru), "Sent to the agent in Russian")
        let shared = try source(Self.shared)
        assertContains(shared, "BILINGUAL_COLLAPSE_LINES = \(BilingualEnglish.collapseLines);", in: Self.shared)
        assertContains(shared, "BILINGUAL_LINE_CHARS = \(BilingualEnglish.lineChars);", in: Self.shared)
    }

    /// A held message's failed line ends in the web's order: Retry, Send as written, then Cancel
    /// where the message can be withdrawn.
    func testTheHeldMessagesFailedLineIsTheWebs() throws {
        let web = try source(Self.parts)
        assertContains(web, "<FootAction label={COPY.sendAsWritten} "
            + "onPress={actions && turnId ? () => actions.sendAsWritten(turnId) : undefined} /> "
            + "{cancelTurn && turnId && actions?.canCancelTurn?.(turnId) && ( <> <Sep /> "
            + "<FootAction label={COPY.cancel} onPress={() => cancelTurn(turnId)} /> </> )}", in: Self.parts)
        let held = TurnTranslation(state: .failed, from: .zhHans, original: "x")
        let presses = SessionTranslation.userFoot(held, flipped: false, cancellable: true).compactMap { part -> String? in
            if case .action(let label, _) = part { return label }
            return nil
        }
        XCTAssertEqual(presses, ["Retry", "Send as written", "Cancel"])
    }

    /// The owner cards (board 04-owner-cards.html) draw two lines: the whole-card flip and an answer
    /// the server refused untranslated. iOS/macOS builds each as parts its foot view joins with "·";
    /// the web writes them in TranslationParts.tsx with a `<Sep />` between. Same words, same order.
    func testTheOwnerCardLinesAreTheWebs() throws {
        func line(_ parts: [SessionTranslation.FootPart]) -> String {
            parts.map { part -> String in
                switch part {
                case .text(let w), .chip(let w), .action(let w, _): return w
                }
            }.joined(separator: " · ")
        }
        XCTAssertEqual(line(OwnerCardTranslations.foot(translates: true, showOriginal: false)), "Translated · Show original")
        XCTAssertEqual(line(OwnerCardTranslations.foot(translates: true, showOriginal: true)), "Original · Show translation")
        XCTAssertEqual(line(OwnerCardTranslations.refusedFoot), "Couldn't translate, so it wasn't sent · Retry · Send as written")
        XCTAssertTrue(OwnerCardTranslations.foot(translates: false, showOriginal: false).isEmpty)

        let web = try source(Self.parts)
        assertContains(web, #"const Sep = () => <span className="chat-translate-sep">·</span>;"#, in: Self.parts)
        assertContains(web, "<span>{flipped ? COPY.original : COPY.translated}</span> <Sep /> "
            + #"<button type="button" className="chat-translate-action" onClick={onFlip}> "#
            + "{flipped ? COPY.showTranslation : COPY.showOriginal} </button>", in: Self.parts)
        // The first sentence names why (failure policy B, frame 5); with no reason it is the generic line above,
        // which translationFailureLines.spec.ts and TranslationFailureLinesParityTests hold to the same fixture.
        assertContains(web, "<span>{translationFailureSentence('answer', failureReason, httpStatus)}</span> <Sep /> "
            + "<FootAction label={COPY.retry} onPress={onRetry} /> "
            + "<Sep /> <FootAction label={COPY.sendAsWritten} onPress={onSendAsWritten} />", in: Self.parts)
        // Every web owner card draws the flip from useOwnerCardTranslation/useOwnerCardFlip, and the
        // ones whose answer can be refused draw it with RefusedAnswerFoot/RefusedSendBack.
        for (card, refuses) in Self.webOwnerCards {
            let text = try source(card)
            XCTAssertTrue(text.contains("useOwnerCardTranslation(") || text.contains("useOwnerCardFlip("),
                          "\(card) draws its flip from useOwnerCardTranslation or useOwnerCardFlip")
            if refuses {
                XCTAssertTrue(text.contains("<RefusedAnswerFoot") || text.contains("<RefusedSendBack"),
                              "\(card) draws a refused answer with RefusedAnswerFoot or RefusedSendBack")
            }
        }
    }

    private static let parts = "src/web/src/components/TranslationParts.tsx"
    private static let webOwnerCards: [(String, Bool)] = [
        ("src/web/src/components/CoordinatorQuestionCard.tsx", true),
        ("src/web/src/components/OwnerRequestCard.tsx", true),
        ("src/web/src/components/ProjectSettlementCard.tsx", true),
        ("src/web/src/components/OwnerConfirmationCard.tsx", true),
        ("src/web/src/components/EvidenceDecisionCard.tsx", false),
        ("src/web/src/components/CriteriaDecisionCard.tsx", false),
        ("src/web/src/components/CrossingDecisionCard.tsx", false),
        ("src/web/src/components/StartProjectCard.tsx", false),
    ]

    /// The composer tag is built, not written: the web drops each name's parenthesis and joins the
    /// two with " → " as `TranslationLanguage.tag(to:)` does.
    func testTheComposerTagIsBuiltAsTheWebBuildsIt() throws {
        let web = try source(Self.lib)
        assertContains(web, #"TRANSLATION_LANGUAGE_NAMES[lang].replace(/\s*\(.*\)$/, '')"#, in: Self.lib)
        assertContains(web, "`${shortLanguageName(lang)} → ${shortLanguageName(agentLang)}`", in: Self.lib)
    }
}
