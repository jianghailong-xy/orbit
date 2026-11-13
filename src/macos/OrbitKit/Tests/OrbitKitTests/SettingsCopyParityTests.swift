import Foundation
import XCTest
@testable import OrbitKit

/// Settings on iOS says what the web's Settings, Profile, Shared links, Access tokens and Infrastructure
/// pages say. `SettingsCopy`, `SharedLinksList`, `AccessTokensList`, `ProvidersOverview` and
/// `MachinesAndModels` carry those pages' words over to the phone (and Access tokens' and
/// Machines & models' to the Mac too), and nothing in either build notices a word changed at one end
/// only — so each one is looked up in the web source it came from. A missing counterpart is a
/// FAILURE, never an `XCTSkip`. A word no web page says any more (the Settings redesign removed the
/// Infrastructure page and split the Settings page) is pinned to iOS's own value instead, and its
/// test says so.
///
/// Deliberately not compared: the group headers of Settings' list (Preferences, Account) and its
/// Sessions row, which regroup the web's cards for a phone; "Default permission", the
/// web's "Default permission mode" shortened to leave its row room for a value; and the words only a
/// phone has to say — this device's own switch, the alerts that are always sent, the card shown
/// while alerts are off, the sign-out confirmation, and Machines & models' "Needs you" heading and its
/// row's "1 needs you" (03-ios.png's own; the web draws Needs attention with no heading).
final class SettingsCopyParityTests: XCTestCase {

    private static let general = "src/web/src/pages/settings/GeneralPage.tsx"
    private static let notifications = "src/web/src/pages/settings/NotificationsPage.tsx"
    private static let appearance = "src/web/src/pages/settings/AppearancePage.tsx"
    private static let profile = "src/web/src/pages/ProfilePage.tsx"
    private static let sharedLinks = "src/web/src/pages/SharedLinksPage.tsx"
    private static let accessTokens = "src/web/src/pages/AccessTokensPage.tsx"
    private static let accessTokenTable = "src/web/src/components/AccessTokenTable.tsx"
    private static let accessTokenWords = "src/web/src/lib/accessTokens.ts"
    private static let settingsNav = "src/web/src/components/settings/SettingsLayout.tsx"
    /// Since Settings search (s6), the Personal pages' nav labels and every row's title and description
    /// live here; the pages and the nav draw them from it (`S.<anchor>.title`, `PERSONAL_PAGES`).
    private static let settingsIndex = "src/web/src/pages/settings/settingsIndex.ts"
    private static let keyCards = "src/web/src/components/ProviderKeyCards.tsx"
    private static let pools = "src/web/src/components/AccountPools.tsx"
    private static let engineNames = "src/shared/src/providerEngines.ts"

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

    /// The rows named after a web page, nav row or field carry its name. Since the Settings redesign
    /// split the one web Settings page (SettingsPage.tsx, now gone) into a page per nav row, each name is
    /// looked up on its own page or in the nav. Session orchestration is iOS's own: the web's General
    /// page calls its section just "Orchestration", so iOS's value is pinned here instead.
    func testTheRowsCarryTheWebPagesNames() throws {
        assertSays(try web(Self.notifications), "<SettingsHeader title=\"\(SettingsHome.title(.notifications))\"",
                   in: Self.notifications)
        assertSays(try web(Self.appearance), "<SettingsHeader title=\"\(SettingsHome.title(.appearance))\"",
                   in: Self.appearance)
        XCTAssertEqual(SessionSettings.title(.orchestration), "Session orchestration")
        // The nav draws the Personal rows from PERSONAL_PAGES, which names them.
        assertSays(try web(Self.settingsNav), "{PERSONAL_PAGES.map((page) => (", in: Self.settingsNav)
        let index = try web(Self.settingsIndex)
        assertSays(index, "{ path: '/settings/shared-links', label: '\(SettingsHome.title(.sharedLinks))' },",
                   in: Self.settingsIndex)
        assertSays(index, "{ path: '/settings/access-tokens', label: '\(SettingsHome.title(.accessTokens))' },",
                   in: Self.settingsIndex)
        assertSays(try web(Self.profile), "<Card title=\"\(SettingsHome.title(.changePassword))\">",
                   in: Self.profile)
    }

    /// The account's two alert switches, with the web Notifications page's titles and its
    /// descriptions as their footers.
    func testTheAlertSwitchesSayWhatTheWebPageSays() throws {
        // The page draws both rows from settingsIndex.ts, which says their words.
        let page = try web(Self.notifications)
        for anchor in ["notifySessionFinished", "notifyAgentMessage"] {
            assertSays(page, "title={S.\(anchor).title} description={S.\(anchor).description}", in: Self.notifications)
        }
        let index = try web(Self.settingsIndex)
        assertSays(index, "'notifySessionFinished', '/settings/notifications', '\(SettingsCopy.sessionFinished)', '\(SettingsCopy.sessionFinishedHint)',",
                   in: Self.settingsIndex)
        assertSays(index, "'notifyAgentMessage', '/settings/notifications', '\(SettingsCopy.agentMessage)', '\(SettingsCopy.agentMessageHint)',",
                   in: Self.settingsIndex)
    }

    /// Default permission: the web General page's mode, whose full hint (the row's tooltip there; the
    /// row shows a shortened one) is its row's footer on the Sessions page.
    func testDefaultPermissionSaysWhatTheWebPageSays() throws {
        assertSays(try web(Self.general), "full: '\(SettingsCopy.defaultPermissionHint)',", in: Self.general)
    }

    /// Session orchestration: the web General page's Orchestration switch, with its title and full hint.
    func testOrchestrationSaysWhatTheWebPageSays() throws {
        let page = try web(Self.general)
        // The title is settingsIndex.ts's, which the page draws; the full hint stays on the page.
        assertSays(page, "title={S.enableOrchestration.title}", in: Self.general)
        assertSays(try web(Self.settingsIndex), "'enableOrchestration', '/settings/general', '\(SettingsCopy.letSessionsOrchestrate)',", in: Self.settingsIndex)
        assertSays(page, "full: '\(SettingsCopy.letSessionsOrchestrateHint)',", in: Self.general)
    }

    /// Smart model selection: the web General page's switch, with its title and full hint.
    func testSmartModelSelectionSaysWhatTheWebPageSays() throws {
        let page = try web(Self.general)
        // The title is settingsIndex.ts's, which the page draws; the full hint stays on the page.
        assertSays(page, "title={S.modelRouting.title}", in: Self.general)
        assertSays(try web(Self.settingsIndex), "'modelRouting', '/settings/general', '\(SettingsCopy.smartModelSelection)',", in: Self.settingsIndex)
        assertSays(page, "full: \"\(SettingsCopy.smartModelSelectionHint)\",", in: Self.general)
        assertSays(page, "checked={prefs.modelRouting === true}", in: Self.general)
        assertSays(page, "save.mutate({ modelRouting: v })", in: Self.general)
        XCTAssertEqual(SessionSettings.title(.modelRouting), SettingsCopy.smartModelSelection)
    }

    /// Session recaps (0418): the web General page's switch, with its title and full hint — the same
    /// three words on the web page, the phone and (via `SettingsCopyParityTest`) the Android list.
    func testSessionRecapsSaysWhatTheWebPageSays() throws {
        let page = try web(Self.general)
        // The title is settingsIndex.ts's, which the page draws; the full hint stays on the page.
        assertSays(page, "title={S.recaps.title}", in: Self.general)
        assertSays(try web(Self.settingsIndex), "'recaps', '/settings/general', '\(SettingsCopy.sessionRecaps)',", in: Self.settingsIndex)
        assertSays(page, "full: '\(SettingsCopy.sessionRecapsHint)',", in: Self.general)
        assertSays(page, "checked={prefs.recaps ?? true}", in: Self.general)
        assertSays(page, "save.mutate({ recaps: v })", in: Self.general)
        XCTAssertEqual(SessionSettings.title(.recaps), SettingsCopy.sessionRecaps)
    }

    /// The edit-profile card's field is called what the web Profile page calls the same value.
    func testTheNameFieldSaysWhatTheProfilePageSays() throws {
        // The row's title is settingsIndex.ts's; its caption stays NAME_CAPTION on the Profile page.
        assertSays(try web(Self.profile), "title={S.name.title} description={NAME_CAPTION}", in: Self.profile)
        assertSays(try web(Self.settingsIndex), "name: setting('name', '/settings/profile', '\(SettingsCopy.nameLabel)'),",
                   in: Self.settingsIndex)
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
        assertSays(page, "<SettingsHeader title=\"\(SharedLinksList.title)\" description=\"\(SharedLinksList.subtitle)\"",
                   in: Self.sharedLinks)
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
        assertSays(page, "<SettingsHeader title=\"\(AccessTokensList.title)\" description=\"\(AccessTokensList.subtitle)\"",
                   in: Self.accessTokens)
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

    /// Machines & models: what the web's Infrastructure page said — Machines & models' footer here — its
    /// Machines, API keys and Account pools sections, their lines, and a key switched off.
    /// InfrastructurePage.tsx is gone since the Settings redesign (docs/mocks/settings-redesign): Machines
    /// is now a group of the web's Settings nav and is looked up there. The other words no web page says
    /// any more, so they are pinned to iOS's own value instead: the page's line under its title has no
    /// web counterpart; each machine's page now says "…spent only by sessions on this machine."; a
    /// vendor's page says "API keys on your account, usable from every machine and billed per token."
    /// under a "Keys" section and "No <vendor> keys" when it has none; the machine count and busy-slots
    /// line went with the page.
    func testMachinesAndModelssSectionsSayWhatTheWebPageSays() throws {
        XCTAssertEqual(MachinesAndModels.subtitle, "Where your agents run, and whose model quota they spend.")
        XCTAssertEqual(SettingsHome.footer(.machines), MachinesAndModels.subtitle)
        assertSays(try web(Self.settingsNav), "<NavGroup title=\"\(MachinesAndModels.machines)\"", in: Self.settingsNav)
        XCTAssertEqual(MachinesAndModels.machinesDetail,
                       "Subscriptions signed in here are spent only by sessions on that machine.")
        XCTAssertEqual(ProvidersOverview.apiKeys, "API keys")
        XCTAssertEqual(ProvidersOverview.apiKeysDetail,
                       "On your account and usable from every machine — billed per token.")
        XCTAssertEqual(ProvidersOverview.noKeys, "No keys yet")
        // A key's row is on its vendor's page, a switched-off one badged, since the Settings redesign.
        assertSays(try web(Self.keyCards), "<Badge>\(MachinesAndModels.disabled)</Badge>", in: Self.keyCards)

        let pools = try web(Self.pools)
        assertSays(pools, "<h3>\(ProvidersOverview.accountPools)</h3>", in: Self.pools)
        assertSays(pools, "re-sec-sub\"> \(ProvidersOverview.accountPoolsDetail)", in: Self.pools)
    }

    /// A machine's line: the slots and the summary the web's machine card gave on its head (`summaryOf`),
    /// word for word. The web no longer draws that card: since the Settings redesign each machine is a row
    /// of the Settings nav and a page of its own (/settings/machines/:id), and the card list, `summaryOf`
    /// with it, is gone from RunnerEngines.tsx. iOS's row still sums every machine up in one line, All
    /// signed in included, in the words the card last used.
    func testAMachinesLineSaysWhatTheWebCardSays() throws {
        XCTAssertEqual(MachinesAndModels.running(active: 2, max: 4), "2 / 4 running")
        XCTAssertEqual(MachinesAndModels.summary(try runner(nil)), "Engines not reported")
        let all = #"[{"engine":"claude","installed":true,"auth":"yes"},{"engine":"codex","installed":true,"auth":"yes"},{"engine":"kimi","installed":true,"auth":"yes"}]"#
        XCTAssertEqual(MachinesAndModels.summary(try runner(all)), "All signed in")
    }

    /// Needs you: each line and what it means. The web drew the same lines in `NeedsAttention` until
    /// docs/mocks/infrastructure-focus (2026-10-25), which left an offline machine and an unavailable pool
    /// to their own cards; iOS keeps the block for those until its own page is redrawn, and since
    /// 2026-10-29 lists no engine signed out, as the web's machine card drew it nothing.
    func testNeedsYouSaysWhatTheWebSays() throws {
        XCTAssertEqual(MachinesAndModels.offlineLine(machine: "ThinkPad"), "ThinkPad is offline")
        XCTAssertEqual(MachinesAndModels.offlineDetail(lastHeartbeatAt: nil, nowMs: 0),
                       "Never checked in · its subscriptions are unavailable until it’s back")
        XCTAssertEqual(MachinesAndModels.poolLine(pool: "Claude keys"), "Claude keys is unavailable")
        XCTAssertEqual(MachinesAndModels.poolDetail(reason: "No account can run"),
                       "No account can run · no session can start on it")
    }

    /// The engines, as the web names them: every engine a session can run on, in the pickers' order and by
    /// its CLI's name, and a machine's sign-in naming them the same.
    func testTheEnginesAreNamedAsTheWebNamesThem() throws {
        // Every engine a session can run on, in the pickers' order, by its CLI's name — the shared table
        // every list on the web names them by.
        let shared = try web(Self.engineNames)
        assertSays(shared, "export const ALL_ENGINES: readonly AgentProvider[] = [ "
                       + ProviderEngines.names.map { "AgentProvider.\($0.engine.uppercased())," }.joined(separator: " "),
                   in: Self.engineNames)
        assertSays(shared, ProviderEngines.names.map { "[AgentProvider.\($0.engine.uppercased())]: '\($0.name)'," }
                       .joined(separator: " "),
                   in: Self.engineNames)
        // A machine's sign-in names the engines it signs in as the web's sign-in does — Cursor CLI by the
        // shared table's name, which the web reads from it rather than writing it out.
        let names = LoginEngine.allCases.filter { $0 != .cursor }.map { "\($0.rawValue): '\($0.displayName)'" }
            .joined(separator: ", ") + ", cursor: ENGINE_CLI_NAMES[AgentProvider.CURSOR],"
        assertSays(try web("src/web/src/components/RunnerSignIn.tsx"), names, in: "src/web/src/components/RunnerSignIn.tsx")
        XCTAssertEqual(LoginEngine.cursor.displayName, ProviderEngines.cliName("cursor"))
        // A key keeps the name its owner gave it, a Gemini key's too.
        XCTAssertEqual(MachinesAndModels.keyLabel("Gemini", presetSlug: "gemini"), "Gemini")
    }

    private func runner(_ engines: String?) throws -> Runner {
        let json = engines.map { #"{"id":"r","name":"r","online":true,"engines":\#($0)}"# }
            ?? #"{"id":"r","name":"r","online":true}"#
        return try JSONDecoder().decode(Runner.self, from: Data(json.utf8))
    }
}
