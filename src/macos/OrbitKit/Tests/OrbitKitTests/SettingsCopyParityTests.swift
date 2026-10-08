import Foundation
import XCTest
@testable import OrbitKit

/// Settings on iOS says what the web's Settings, Profile, Shared links, Access tokens and Providers
/// pages say. `SettingsCopy`, `SharedLinksList`, `AccessTokensList` and `ProvidersOverview` carry
/// those pages' words over to the phone (and Access tokens' to the Mac's form too), and nothing in
/// either build notices a word changed at one end only — so each one is looked up in the web source
/// it came from. A missing counterpart is a FAILURE, never an `XCTSkip`.
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
    private static let accessTokens = "src/web/src/pages/AccessTokensPage.tsx"
    private static let accessTokenTable = "src/web/src/components/AccessTokenTable.tsx"
    private static let accessTokenWords = "src/web/src/lib/accessTokens.ts"
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
        assertSays(page, "<Card title=\"\(SettingsHome.title(.accessTokens))\"", in: Self.settings)
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

    /// Session orchestration: the web card's one switch, with its label and hint.
    func testOrchestrationSaysWhatTheWebPageSays() throws {
        let page = try web(Self.settings)
        assertSays(page, "label=\"\(SettingsCopy.letSessionsOrchestrate)\"", in: Self.settings)
        assertSays(page, "hint=\"\(SettingsCopy.letSessionsOrchestrateHint)\"", in: Self.settings)
    }

    /// Smart model selection: the Session defaults card's switch, with its label and hint.
    func testSmartModelSelectionSaysWhatTheWebPageSays() throws {
        let page = try web(Self.settings)
        assertSays(page, "label=\"\(SettingsCopy.smartModelSelection)\"", in: Self.settings)
        assertSays(page, "hint=\"\(SettingsCopy.smartModelSelectionHint)\"", in: Self.settings)
        assertSays(page, "checked={prefs.modelRouting === true}", in: Self.settings)
        assertSays(page, "save.mutate({ modelRouting: v })", in: Self.settings)
        XCTAssertEqual(SettingsHome.title(.modelRouting), SettingsCopy.smartModelSelection)
    }

    /// The edit-profile card's field is called what the web Profile page calls the same value.
    func testTheNameFieldSaysWhatTheProfilePageSays() throws {
        assertSays(try web(Self.profile), ">\(SettingsCopy.nameLabel)</div>", in: Self.profile)
    }

    /// The photo's two actions and the line under the name read the same on the web Profile page.
    func testThePhotoAndTheCaptionSayWhatTheProfilePageSays() throws {
        let page = try web(Self.profile)
        assertSays(page, "export const CHOOSE_PHOTO = '\(SettingsCopy.choosePhoto)';", in: Self.profile)
        assertSays(page, "export const REMOVE_PHOTO = '\(SettingsCopy.removePhoto)';", in: Self.profile)
        assertSays(page, "export const NAME_CAPTION = '\(SettingsCopy.nameCaption)';", in: Self.profile)
    }

    /// Change password: the web Profile page's form.
    func testThePasswordFormSaysWhatTheProfilePageSays() throws {
        let page = try web(Self.profile)
        for label in [SettingsCopy.currentPassword, SettingsCopy.newPassword, SettingsCopy.confirmPassword] {
            assertSays(page, "label=\"\(label)\"", in: Self.profile)
        }
        assertSays(page, "? null : '\(SettingsCopy.passwordRule)'", in: Self.profile)
        assertSays(page, "? null : '\(SettingsCopy.passwordsDoNotMatch)'", in: Self.profile)
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
        assertSays(page, "{ SESSION: '\(SharedLinksList.kindWord(.session))', TASK: '\(SharedLinksList.kindWord(.task))', PROJECT: '\(SharedLinksList.kindWord(.project))', WIKI: '\(SharedLinksList.kindWord(.wiki))' }",
                   in: Self.sharedLinks)
        // A wiki has no status: its line is the kind alone, as the web's `rootWhere` says it.
        assertSays(page, "if (link.kind === 'WIKI') return kind;", in: Self.sharedLinks)
        XCTAssertEqual(SharedLinksList.whereLine(ShareLink(id: "l", kind: .wiki, token: "t",
                                                           root: ShareRootSummary(id: "w", title: "orbit", slug: "orbit"))),
                       SharedLinksList.kindWord(.wiki))
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

    /// Access tokens: the web page's tabs and words, the table's lines, and how `lib/accessTokens.ts`
    /// sums a token's scopes and says when it stops. The apps' one sentence of their own is where to
    /// issue a token, since only the web does (docs/personal-access-token-design.md §9).
    func testAccessTokensSayWhatTheWebPageSays() throws {
        let page = try web(Self.accessTokens)
        assertSays(page, "<h1 className=\"page-title\">\(AccessTokensList.title)</h1>", in: Self.accessTokens)
        assertSays(page, "> \(AccessTokensList.subtitle) </p>", in: Self.accessTokens)
        assertSays(page, "['active', '\(AccessTokensList.Tab.active.label)', active.length]", in: Self.accessTokens)
        assertSays(page, "['ended', '\(AccessTokensList.Tab.ended.label)', ended.length]", in: Self.accessTokens)
        assertSays(page, "? '\(AccessTokensList.Tab.active.empty)'", in: Self.accessTokens)
        assertSays(page, ": '\(AccessTokensList.Tab.ended.empty)'", in: Self.accessTokens)
        assertSays(page, "\(AccessTokensList.couldNotLoad) {tokensQ.error.message}", in: Self.accessTokens)
        assertSays(page, "message.success('\(AccessTokensList.revoked)'", in: Self.accessTokens)
        assertSays(page, "message.error(\"\(AccessTokensList.couldNotRevoke)\", e.message)", in: Self.accessTokens)

        let table = try web(Self.accessTokenTable)
        let token = AccessToken(id: "t", name: "NAME", tokenHint: "HINT")
        assertSays(table, "title={`\(AccessTokensList.revokeTitle(token).replacingOccurrences(of: "NAME", with: "${token.name}"))`}",
                   in: Self.accessTokenTable)
        assertSays(table, "description=\"\(AccessTokensList.revokeDetail)\"", in: Self.accessTokenTable)
        assertSays(table, "confirmText=\"\(AccessTokensList.revoke)\"", in: Self.accessTokenTable)
        assertSays(table, AccessTokensList.hint(token).replacingOccurrences(of: "HINT", with: "{token.tokenHint}"),
                   in: Self.accessTokenTable)
        assertSays(table, "return '\(AccessTokensList.workspacesLine(token))'", in: Self.accessTokenTable)
        assertSays(table, "gone === 1 ? 'a deleted workspace' : `${gone} deleted workspaces`", in: Self.accessTokenTable)
        assertSays(table, ">\(AccessTokensList.neverUsed)</span>", in: Self.accessTokenTable)
        assertSays(table, "?? '\(AccessTokensList.addressUnknown)'", in: Self.accessTokenTable)
        assertSays(table, "title: 'Last used'", in: Self.accessTokenTable)

        let words = try web(Self.accessTokenWords)
        for group in AccessTokensList.scopeGroups {
            let write = group.write.map { ", write: '\($0)'" } ?? ""
            assertSays(words, "{ resource: '\(group.resource)', read: '\(group.read)'\(write) }", in: Self.accessTokenWords)
        }
        assertSays(words, "return '\(AccessTokensList.scopeSummary(AccessTokensList.allScopes))';", in: Self.accessTokenWords)
        assertSays(words, "return '\(AccessTokensList.scopeSummary(AccessTokensList.readScopes))';", in: Self.accessTokenWords)
        assertSays(words, "[`${group.resource}: read & write`]", in: Self.accessTokenWords)
        assertSays(words, "}).join(' · ');", in: Self.accessTokenWords)
        assertSays(words, "export const NEVER_EXPIRES = '\(AccessTokensList.neverExpires)';", in: Self.accessTokenWords)
        assertSays(words, "return 'in less than an hour';", in: Self.accessTokenWords)
        assertSays(words, "hours === 1 ? 'in 1 hour' : `in ${hours} hours`", in: Self.accessTokenWords)
        assertSays(words, "days === 1 ? 'in 1 day' : `in ${days} days`", in: Self.accessTokenWords)
        assertSays(words, "at ? `Expired ${fullDate(at)}` : 'Expired'", in: Self.accessTokenWords)
        assertSays(words, "return `Revoked by an administrator${at}`;", in: Self.accessTokenWords)
        assertSays(words, "return `Revoked with a password change${at}`;", in: Self.accessTokenWords)
        assertSays(words, "toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })",
                   in: Self.accessTokenWords)
    }

    /// Providers: the web page's three groups, their lines, and a runner card's summary.
    func testProvidersSayWhatTheWebPageSays() throws {
        let engines = try web(Self.engines)
        assertSays(engines, "<h3>\(ProvidersOverview.onYourRunners)</h3>", in: Self.engines)
        assertSays(engines, "re-sec-sub\"> \(ProvidersOverview.onYourRunnersDetail)", in: Self.engines)
        assertSays(engines, "return '\(ProvidersOverview.runnerSummary(try runner(engines: nil)))'", in: Self.engines)
        assertSays(engines, "'All signed in' : `${ready} of ${engines.length} signed in`", in: Self.engines)

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
