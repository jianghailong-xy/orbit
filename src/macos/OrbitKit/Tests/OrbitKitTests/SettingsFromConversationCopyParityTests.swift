import Foundation
import XCTest
@testable import OrbitKit

/// Settings from a conversation says on the Apple clients what the web says (docs/settings-from-conversation-design.md
/// §8): the card, its folded lines, the Open in Settings row, the line under a changed Settings row, and the titles,
/// pages and value names they use. Every native string is looked up in the web source it came from; a missing
/// counterpart is a FAILURE, never a skip.
final class SettingsFromConversationCopyParityTests: XCTestCase {
    private static let copy = "src/web/src/lib/settingsChange.ts"
    private static let card = "src/web/src/components/SettingsChangeCard.tsx"
    private static let line = "src/web/src/components/settings/SettingChangedLine.tsx"
    private static let index = "src/shared/src/settingsIndex.ts"
    private static let tiers = "src/shared/src/settingsTiers.ts"
    private static let pages = "src/web/src/pages/settings/settingsIndex.ts"
    private static let translation = "src/shared/src/translation.ts"
    private static let nativeKit = "src/macos/OrbitKit/Sources/OrbitKit/App/SettingsFromConversation.swift"

    private func read(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
                    .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            }
            dir = dir.deletingLastPathComponent()
        }
        XCTFail("\(relative) was not found above this test file; if the web half moved, move this check with it")
        throw CocoaError(.fileNoSuchFile)
    }

    private func assertSays(_ source: String, _ literal: String, in file: String, line: UInt = #line) {
        XCTAssertTrue(source.contains(literal), "\(file) no longer says \(literal)", line: line)
    }

    func testTheCardAndItsFoldedLinesSayWhatTheWebSays() throws {
        let web = try read(Self.copy)
        assertSays(web, "heading: (count: number) => `⚙️ Confirm: change ${count} setting${count === 1 ? '' : 's'}?`", in: Self.copy)
        assertSays(web, "changed: (count: number) => `✓ Changed ${count} setting${count === 1 ? '' : 's'}`", in: Self.copy)
        assertSays(web, "agentSays: (why: string) => `The agent says: ${why}`", in: Self.copy)
        for (native, key) in [
            (SettingsChangeCopy.newSessionsOnly, "newSessionsOnly"), (SettingsChangeCopy.foot, "foot"),
            (SettingsChangeCopy.save, "save"), (SettingsChangeCopy.chat, "chat"),
            (SettingsChangeCopy.declinePlaceholder, "declinePlaceholder"), (SettingsChangeCopy.decline, "decline"),
            (SettingsChangeCopy.keep, "keep"), (SettingsChangeCopy.undo, "undo"), (SettingsChangeCopy.undone, "undone"),
            (SettingsChangeCopy.declined, "declined"), (SettingsChangeCopy.stale, "stale"),
            (SettingsChangeCopy.openInSettings, "openInSettings"), (SettingsChangeCopy.turnedOn, "turnedOn"),
            (SettingsChangeCopy.turnedOff, "turnedOff"), (SettingsChangeCopy.setFrom, "setFrom"),
            (SettingsChangeCopy.aConversation, "aConversation"),
        ] {
            assertSays(web, "\(key): '\(native)'", in: Self.copy)
        }
        assertSays(try read(Self.line), "'Untitled conversation'", in: Self.line)
        // The headline the card is drawn under in the Waiting-on-you list is the server's, not a client word.
        XCTAssertEqual(SettingsChangeCopy.heading(2), "⚙️ Confirm: change 2 settings?")
    }

    /// The third fold: a 409 SETTINGS_STALE keeps the card PENDING, says the stale line and offers Decline, which sends
    /// that same line as the reason. Both clients are read, so neither can drop the fold alone.
    func testTheStaleFoldIsTheSameOnBothClients() throws {
        let web = try read(Self.card)
        assertSays(web, "{COPY.stale}", in: Self.card)
        assertSays(web, "decline.mutate(COPY.stale)", in: Self.card)
        assertSays(web, "=== 'SETTINGS_STALE'", in: Self.card)
        let native = try read("src/macos/OrbitApp/Sources/OrbitApp/Views/SettingsChangeViews.swift")
        assertSays(native, "Text(SettingsChangeCopy.stale)", in: "SettingsChangeViews.swift")
        assertSays(native, "decline(SettingsChangeCopy.stale)", in: "SettingsChangeViews.swift")
        assertSays(native, "SettingsFromConversation.isStale(error)", in: "SettingsChangeViews.swift")
        XCTAssertEqual(SettingsChangeCopy.stale, "This setting changed since it was proposed.")
    }

    func testTheCardHasNoAlwaysAllowAndTheSameTwoButtons() throws {
        let web = try read(Self.card)
        assertSays(web, "{COPY.save}", in: Self.card)
        assertSays(web, "{COPY.chat}", in: Self.card)
        // The card's own comment says there is no Always allow; the words it draws are what this checks.
        let drawn = web
            .replacingOccurrences(of: "(?s)/\\*.*?\\*/", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "//[^\n]*", with: "", options: .regularExpression)
        XCTAssertFalse(drawn.contains("Always allow"), "the web card grew an Always allow; the native card has none (design §2, Q3)")
    }

    func testEveryRowTitlePageAndSectionIsTheWebs() throws {
        let index = try read(Self.index)
        let tiers = try read(Self.tiers)
        let pages = try read(Self.pages)
        let card = try read("src/web/src/lib/settingsChange.ts")
        for key in ["theme", "translationEnabled", "translationLanguage", "translationAgentLanguage", "translationBilingual",
                    "notifySessionFinished", "notifyAgentMessage", "recaps", "promptSuggestions", "promptOptimizer",
                    // modelRouting and optimizeFor left out: the web moved them to Providers → Model routing, and this
                    // client still draws them in General › New sessions until its Settings follows.
                    "defaultPermissionMode", "enableOrchestration", "cardFreeTaskCreates"] {
            let place = try XCTUnwrap(SettingsFromConversation.place(key), key)
            assertSays(index, "'\(place.title)'", in: Self.index)
            assertSays(pages, "label: '\(place.webPage)'", in: Self.pages)
            if let section = place.section {
                assertSays(card, "\(key == "translationAgentLanguage" ? "agentLanguage" : key): '\(section)'", in: Self.copy)
            }
        }
        for key in ["defaultModel", "defaultModels", "defaultEffort", "subagentBlockedProviders"] {
            assertSays(tiers, "'\(SettingsFromConversation.title(key))'", in: Self.tiers)
        }
    }

    func testValueNamesAreTheWebs() throws {
        let web = try read(Self.copy)
        for (native, literal) in [("System", "system: 'System'"), ("Light", "light: 'Light'"), ("Dark", "dark: 'Dark'"),
                                  ("Cost", "cost: 'Cost'"), ("Balance", "balance: 'Balance'"),
                                  ("Intelligence", "intelligence: 'Intelligence'")] {
            assertSays(web, literal, in: Self.copy)
            XCTAssertTrue([SettingsFromConversation.valueLabel("theme", .string(native.lowercased())),
                           SettingsFromConversation.valueLabel("optimizeFor", .string(native.lowercased()))].contains(native), native)
        }
        for literal in ["'Engine default'", "'None'", "'Default'", "'On'", "'Off'"] { assertSays(web, literal, in: Self.copy) }
        let languages = try read(Self.translation)
        for language in TranslationLanguage.allCases {
            assertSays(languages, "'\(language.name)'", in: Self.translation)
        }
        let modes = try read("src/web/src/lib/workspaceDefaults.ts")
        for mode in AgentDefaults.permissionModes {
            assertSays(modes, "label: \(AgentDefaults.label(mode).contains("'") ? "\"\(AgentDefaults.label(mode))\"" : "'\(AgentDefaults.label(mode))'")",
                       in: "workspaceDefaults.ts")
        }
    }

    func testTheNativeLogicFileIsTheOneThisParityReads() throws {
        // Pinned so a moved logic file does not leave the parity above reading words nobody draws.
        _ = try read(Self.nativeKit)
    }
}
