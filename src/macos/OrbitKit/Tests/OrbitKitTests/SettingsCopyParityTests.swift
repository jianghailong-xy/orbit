import Foundation
import XCTest
@testable import OrbitKit

/// Settings on iOS says what the web's Settings, Profile, Shared links and Providers pages say.
/// `SettingsCopy`, `SharedLinksList` and `ProvidersOverview` carry those pages' words over to the
/// phone, and nothing in either build notices a word changed at one end only — so each one is looked
/// up in the web source it came from. A missing counterpart is a FAILURE, never an `XCTSkip`.
///
/// Deliberately not compared: the group headers of Settings' list (Sessions, Machines & models,
/// Preferences, Account), which regroup the web's cards for a phone; "Default permission", the
/// web's "Default permission mode" shortened to leave its row room for a value; and the words only a
/// phone has to say — this device's own switch, the alerts that are always sent, the card shown
/// while alerts are off, and the sign-out confirmation.
final class SettingsCopyParityTests: XCTestCase {

    private static let settings = "src/web/src/pages/SettingsPage.tsx"
    private static let profile = "src/web/src/pages/ProfilePage.tsx"
    private static let sharedLinks = "src/web/src/pages/SharedLinksPage.tsx"
    private static let providers = "src/web/src/pages/ProvidersPage.tsx"
    private static let engines = "src/web/src/components/RunnerEngines.tsx"
    private static let pools = "src/web/src/components/AccountPools.tsx"

    private enum ParityError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let file):
                return "\(file) was not found above this test file. Settings on iOS is one half of a pair; "
                    + "if the web half moved, move this check with it rather than deleting it."
            }
        }
    }

    /// The web file, with its string concatenations joined and every run of whitespace made one
    /// space: where a long sentence or a JSX text node breaks its line is layout, the words are the
    /// contract.
    private func web(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
                    .replacingOccurrences(of: "'\\s*\\+\\s*'", with: "", options: .regularExpression)
                    .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw ParityError.missing(relative)
    }

    private func assertSays(_ source: String, _ literal: String, in file: String,
                            file testFile: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(source.contains(literal), "\(file) no longer says \(literal)", file: testFile, line: line)
    }

    /// The rows named after a web card or field carry its name.
    func testTheRowsCarryTheWebPagesNames() throws {
        let page = try web(Self.settings)
        for card in [SettingsHome.title(.notifications), SettingsHome.title(.appearance),
                     SettingsHome.title(.orchestration)] {
            assertSays(page, "title=\"\(card)\"", in: Self.settings)
        }
        assertSays(page, "label=\"\(SettingsHome.title(.sharedLinks))\"", in: Self.settings)
        assertSays(try web(Self.profile), "<Card title=\"\(SettingsHome.title(.changePassword))\">",
                   in: Self.profile)
    }

    /// The account's two alert switches, with the web's labels and its hints as their footers.
    func testTheAlertSwitchesSayWhatTheWebPageSays() throws {
        let page = try web(Self.settings)
        assertSays(page, "label=\"\(SettingsCopy.sessionFinished)\"", in: Self.settings)
        assertSays(page, "hint=\"\(SettingsCopy.sessionFinishedHint)\"", in: Self.settings)
        assertSays(page, "label=\"\(SettingsCopy.agentMessage)\"", in: Self.settings)
        assertSays(page, "hint=\"\(SettingsCopy.agentMessageHint)\"", in: Self.settings)
    }

    /// Session orchestration: the web card, as a page.
    func testOrchestrationSaysWhatTheWebPageSays() throws {
        let page = try web(Self.settings)
        assertSays(page, "label=\"\(SettingsCopy.grantToNew)\"", in: Self.settings)
        assertSays(page, "hint=\"\(SettingsCopy.grantToNewHint)\"", in: Self.settings)
        assertSays(page, "label=\"\(SettingsCopy.applyToExisting)\"", in: Self.settings)
        assertSays(page, "okText=\"\(SettingsCopy.turnOnForAll)\"", in: Self.settings)
        assertSays(page, "> \(SettingsCopy.turnOffForAll) </Button>", in: Self.settings)
        assertSays(page, "'\(SettingsCopy.loadingAgents)'", in: Self.settings)
        assertSays(page, "of ${agents.length} \(SettingsCopy.grantedTail)", in: Self.settings)
        assertSays(page, "description=\"\(SettingsCopy.confirmAllDetail)\"", in: Self.settings)
        let title = SettingsCopy.confirmAllTitle(total: 23).replacingOccurrences(of: "23", with: "${agents.length}")
        assertSays(page, "`\(title)`", in: Self.settings)
    }

    /// Change password: the web Profile page's form.
    func testThePasswordFormSaysWhatTheProfilePageSays() throws {
        let page = try web(Self.profile)
        for label in [SettingsCopy.currentPassword, SettingsCopy.newPassword, SettingsCopy.confirmPassword] {
            assertSays(page, "label=\"\(label)\"", in: Self.profile)
        }
        assertSays(page, "message: '\(SettingsCopy.passwordRule)'", in: Self.profile)
        assertSays(page, "new Error('\(SettingsCopy.passwordsDoNotMatch)')", in: Self.profile)
        assertSays(page, "message.success('\(SettingsCopy.passwordChanged)')", in: Self.profile)
        assertSays(page, "> \(SettingsCopy.changePassword) </Button>", in: Self.profile)
    }

    /// Shared links: the web page's tabs, lines and words.
    func testSharedLinksSayWhatTheWebPageSays() throws {
        let page = try web(Self.sharedLinks)
        for tab in SharedLinksList.Tab.allCases {
            assertSays(page, "label: '\(tab.label)'", in: Self.sharedLinks)
            assertSays(page, "empty: '\(tab.empty)'", in: Self.sharedLinks)
        }
        assertSays(page, "<h1 className=\"page-title\">\(SharedLinksList.title)</h1>", in: Self.sharedLinks)
        assertSays(page, "> \(SharedLinksList.subtitle) </p>", in: Self.sharedLinks)
        assertSays(page, "\(SharedLinksList.couldNotLoad) {linksQ.error.message}", in: Self.sharedLinks)
        assertSays(page, "{ SESSION: '\(SharedLinksList.kindWord(.session))', TASK: '\(SharedLinksList.kindWord(.task))', PROJECT: '\(SharedLinksList.kindWord(.project))' }",
                   in: Self.sharedLinks)
        // The paused line is one sentence on the phone; the web sets its first words apart in a span.
        let paused = SharedLinksList.whereLine(ShareLink(id: "l", kind: .session, token: "t", state: .paused,
                                                         root: ShareRootSummary(id: "r")))
        assertSays(page, paused.replacingOccurrences(of: "Paused · in Trash", with: "Paused · in Trash</span>"),
                   in: Self.sharedLinks)
        assertSays(page, "'EXPIRED' ? 'Expired' : 'Turned off'", in: Self.sharedLinks)
        assertSays(page, "count === 1 ? '\(SharedLinksList.turnedOff(1))' : `${count} links turned off`",
                   in: Self.sharedLinks)
        XCTAssertEqual(SharedLinksList.turnedOff(7), "7 links turned off")
    }

    /// Providers: the web page's three groups, their lines, and a runner card's summary.
    func testProvidersSayWhatTheWebPageSays() throws {
        let engines = try web(Self.engines)
        assertSays(engines, "<h3>\(ProvidersOverview.onYourRunners)</h3>", in: Self.engines)
        assertSays(engines, "re-sec-sub\"> \(ProvidersOverview.onYourRunnersDetail)", in: Self.engines)
        assertSays(engines, "return '\(ProvidersOverview.runnerSummary(try runner(engines: nil)))'", in: Self.engines)
        assertSays(engines, "'All signed in' : `${ready} of ${ENGINES.length} signed in`", in: Self.engines)

        let pools = try web(Self.pools)
        assertSays(pools, "<h3>\(ProvidersOverview.accountPools)</h3>", in: Self.pools)
        assertSays(pools, "re-sec-sub\"> \(ProvidersOverview.accountPoolsDetail)", in: Self.pools)

        let page = try web(Self.providers)
        assertSays(page, "<h3>\(ProvidersOverview.apiKeys)</h3>", in: Self.providers)
        assertSays(page, "re-sec-sub\"> \(ProvidersOverview.apiKeysDetail)", in: Self.providers)
        assertSays(page, "<h3>\(ProvidersOverview.noKeys)</h3>", in: Self.providers)
    }

    private func runner(engines: String?) throws -> Runner {
        let json = engines.map { #"{"id":"r","name":"r","online":true,"engines":\#($0)}"# }
            ?? #"{"id":"r","name":"r","online":true}"#
        return try JSONDecoder().decode(Runner.self, from: Data(json.utf8))
    }
}
