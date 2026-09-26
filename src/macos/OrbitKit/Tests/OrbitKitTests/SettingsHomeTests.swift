import Foundation
import XCTest
@testable import OrbitKit

/// Settings' list on iOS — what it holds and what each row says (`SettingsHome`), and the logic of
/// the pages it opens that is not a view: Shared links (`SharedLinksList`) and Providers
/// (`ProvidersOverview`).
final class SettingsHomeTests: XCTestCase {

    // MARK: - The list

    /// The order the owner picked from the mockups: how sessions start, the machines and models they
    /// run on, the app's own preferences, then the account.
    func testTheGroupsReadInTheOrderTheyWerePicked() {
        XCTAssertEqual(SettingsHome.Group.allCases.map(SettingsHome.header),
                       ["Sessions", "Machines & models", "Preferences", "Account"])
        XCTAssertEqual(SettingsHome.rows(.sessions, isAdmin: false), [.defaultPermission, .orchestration])
        XCTAssertEqual(SettingsHome.rows(.machines, isAdmin: false), [.runners, .providers])
        XCTAssertEqual(SettingsHome.rows(.preferences, isAdmin: false), [.notifications, .appearance])
        XCTAssertEqual(SettingsHome.rows(.account, isAdmin: false),
                       [.email, .instance, .sharedLinks, .changePassword])
    }

    /// Admin is role-gated here as everywhere else, and comes last in Account.
    func testAdminIsOnlyAnAdminsRow() {
        XCTAssertEqual(SettingsHome.rows(.account, isAdmin: true).last, .admin)
        for group in SettingsHome.Group.allCases {
            XCTAssertFalse(SettingsHome.rows(group, isAdmin: false).contains(.admin), "\(group)")
        }
    }

    /// Every row is in exactly one group, so the list can't drop one or draw one twice.
    func testEveryRowIsInExactlyOneGroup() {
        let listed = SettingsHome.Group.allCases.flatMap { SettingsHome.rows($0, isAdmin: true) }
        XCTAssertEqual(listed.count, Set(listed).count, "a row is listed twice")
        XCTAssertEqual(Set(listed), Set(SettingsHome.Row.allCases), "a row is in no group")
    }

    /// Each row has a name and a glyph of its own; Runners and Admin keep their sections'.
    func testEveryRowHasItsOwnNameAndGlyph() {
        let rows = SettingsHome.Row.allCases
        XCTAssertEqual(Set(rows.map(SettingsHome.title)).count, rows.count, "two rows share a name")
        XCTAssertEqual(Set(rows.map(SettingsHome.systemImage)).count, rows.count, "two rows share a glyph")
        XCTAssertEqual(SettingsHome.title(.runners), AppSection.runners.title)
        XCTAssertEqual(SettingsHome.systemImage(.runners), AppSection.runners.systemImage)
        XCTAssertEqual(SettingsHome.title(.admin), AppSection.admin.title)
        XCTAssertEqual(SettingsHome.systemImage(.admin), AppSection.admin.systemImage)
    }

    /// The rows that open a page open their own, titled as the row is; the pickers, the orchestration
    /// switch and the two lines that only say something open nothing; Runners pushes its older frame
    /// of its own.
    func testTheRowsThatOpenAPageOpenTheirOwn() {
        let opening = SettingsHome.Row.allCases.compactMap(SettingsHome.page)
        XCTAssertEqual(Set(opening), Set(SettingsPage.allCases), "a page no row opens, or a row opening two")
        XCTAssertEqual(opening.count, SettingsPage.allCases.count)
        for row in SettingsHome.Row.allCases {
            if let page = SettingsHome.page(row) {
                XCTAssertEqual(page.title, SettingsHome.title(row), "the page is called what its row is")
            }
        }
        for row in [SettingsHome.Row.defaultPermission, .appearance, .email, .instance, .runners] {
            XCTAssertNil(SettingsHome.page(row), "\(row) opens no SettingsPage")
        }
    }

    // MARK: - What a row says

    private func runner(_ id: String, online: Bool, engines: String? = nil) throws -> Runner {
        let enginesJSON = engines.map { #","engines":\#($0)"# } ?? ""
        let json = #"{"id":"\#(id)","name":"\#(id)","online":\#(online)\#(enginesJSON)}"#
        return try JSONDecoder().decode(Runner.self, from: Data(json.utf8))
    }

    func testRunnersSayHowManyCanTakeWork() throws {
        let fleet = try [runner("a", online: true), runner("b", online: true),
                         runner("c", online: true), runner("d", online: false)]
        XCTAssertEqual(SettingsHome.runnersValue(fleet), "3 of 4 online")
        XCTAssertEqual(SettingsHome.runnersValue([]), "None")
    }

    /// One switch for the whole account, so the row is the switch: nothing to count per workspace,
    /// and no page behind it.
    func testOrchestrationIsAnsweredOnItsRow() {
        XCTAssertNil(SettingsHome.page(.orchestration))
    }

    func testSharedLinksCountWhatIsOpenForAnyone() {
        XCTAssertEqual(SettingsHome.sharedLinksValue(active: 25), "25 active")
        XCTAssertEqual(SettingsHome.sharedLinksValue(active: 0), "None")
    }

    /// Notifications says what this device allows — the switch every other one sits behind.
    func testNotificationsSayWhatThisDeviceAllows() {
        XCTAssertEqual(SettingsHome.notificationsValue(allowed: true), "On")
        XCTAssertEqual(SettingsHome.notificationsValue(allowed: false), "Off")
        XCTAssertNil(SettingsHome.notificationsValue(allowed: nil), "not asked yet is not Off")
    }

    /// The instance as the sign-in screen asked for it: the host, and a port only when there is one.
    func testTheInstanceIsTheHostYouSignedInTo() {
        XCTAssertEqual(SettingsHome.instanceName(URL(string: "https://orbitd.io")), "orbitd.io")
        XCTAssertEqual(SettingsHome.instanceName(URL(string: "https://orbitd.io/")), "orbitd.io")
        XCTAssertEqual(SettingsHome.instanceName(URL(string: "http://10.0.0.5:3000")), "10.0.0.5:3000")
        XCTAssertNil(SettingsHome.instanceName(nil))
    }

    func testTheBuildLineNamesVersionAndBuild() {
        XCTAssertEqual(SettingsHome.versionLine(version: "0.1.2", build: "3581"), "Orbit 0.1.2 (3581)")
        XCTAssertEqual(SettingsHome.versionLine(version: "0.1.2", build: nil), "Orbit 0.1.2")
        XCTAssertNil(SettingsHome.versionLine(version: nil, build: "3581"))
    }

    // MARK: - Copy that is composed

    func testTheComposedLinesReadAsTheWebsDo() {
        XCTAssertEqual(SettingsCopy.signOutTitle(instance: "orbitd.io"), "Sign out of orbitd.io?")
        XCTAssertEqual(SettingsCopy.signOutTitle(instance: nil), "Sign out?")
        XCTAssertEqual(SettingsCopy.deviceHeader("iPhone"), "This iPhone")
    }

    /// Every kind of alert the server sends is either one of the two switches or named as always
    /// sent — six kinds in `push.service.ts`, two of them gated.
    func testEveryAlertKindIsASwitchOrNamedAsAlwaysSent() {
        XCTAssertEqual(SettingsCopy.alwaysSent.count + 2, 6)
        XCTAssertEqual(Set(SettingsCopy.alwaysSent).count, SettingsCopy.alwaysSent.count)
    }

    // MARK: - Shared links

    private func link(_ state: ShareLinkState, kind: ShareRootKind = .session, reason: String? = nil,
                      revokedAt: String? = nil, expiresAt: String? = nil,
                      root: ShareRootSummary = ShareRootSummary(id: "r1", title: "Root")) -> ShareLink {
        ShareLink(id: "L-\(state.rawValue)-\(kind.rawValue)", kind: kind, token: "tok", expiresAt: expiresAt,
                  revokedAt: revokedAt, state: state, stateReason: reason, root: root)
    }

    func testTheTabsFileEachLinkByWhereItStands() {
        let all = [link(.active), link(.paused), link(.ended), link(.active, kind: .task)]
        XCTAssertEqual(SharedLinksList.Tab.allCases.map(\.label), ["Active", "Paused", "Ended"])
        XCTAssertEqual(SharedLinksList.links(all, in: .active).count, 2)
        XCTAssertEqual(SharedLinksList.links(all, in: .paused).count, 1)
        XCTAssertEqual(SharedLinksList.links(all, in: .ended).count, 1)
        XCTAssertTrue(SharedLinksList.canTurnOff(link(.active)))
        XCTAssertTrue(SharedLinksList.canTurnOff(link(.paused)), "a paused link still exists to end")
        XCTAssertFalse(SharedLinksList.canTurnOff(link(.ended)), "an ended one has nothing left to end")
    }

    /// The line under a link's title, in the web page's words for each state and kind.
    func testTheWhereLineSaysWhatTheLinkIsAndWhereItStands() {
        XCTAssertEqual(SharedLinksList.whereLine(link(.active, kind: .task,
                                                      root: ShareRootSummary(id: "t", title: "T", status: "DONE"))),
                       "Task · Done")
        XCTAssertEqual(SharedLinksList.whereLine(link(.active, kind: .project,
                                                      root: ShareRootSummary(id: "p", title: "P", status: "DONE"))),
                       "Project · Completed")
        XCTAssertEqual(SharedLinksList.whereLine(link(.active, root: ShareRootSummary(id: "s", title: "S",
                                                                                         lifecycleState: "OPEN"))),
                       "Session · Open")
        let completed = SharedLinksList.whereLine(link(.active, root: ShareRootSummary(
            id: "s", title: "S", lifecycleState: "COMPLETED", completedAt: "2026-09-22T10:00:00.000Z")))
        XCTAssertEqual(completed, "Session · Completed Sep 22")
        XCTAssertEqual(SharedLinksList.whereLine(link(.paused)),
                       "Paused · in Trash — restoring the session turns this link back on")
        XCTAssertEqual(SharedLinksList.whereLine(link(.ended, reason: "TURNED_OFF",
                                                      revokedAt: "2026-09-24T10:00:00.000Z")),
                       "Session · Turned off Sep 24")
        XCTAssertEqual(SharedLinksList.whereLine(link(.ended, kind: .project, reason: "EXPIRED",
                                                      expiresAt: "2026-09-20T10:00:00.000Z")),
                       "Project · Expired Sep 20")
    }

    func testTurningOffSaysHowManyWent() {
        XCTAssertEqual(SharedLinksList.turnedOff(1), "Link turned off")
        XCTAssertEqual(SharedLinksList.turnedOff(3), "3 links turned off")
    }

    func testThePublicAddressIsTheTokenUnderS() {
        let url = SharedLinksList.publicURL(link(.active), base: URL(string: "https://orbitd.io")!)
        XCTAssertEqual(url.absoluteString, "https://orbitd.io/s/tok")
    }

    // MARK: - Providers

    func testARunnersLineCountsItsSignedInEngines() throws {
        let all = #"[{"engine":"claude","installed":true,"auth":"yes"},{"engine":"codex","installed":true,"auth":"yes"},{"engine":"kimi","installed":true,"auth":"yes"}]"#
        let some = #"[{"engine":"claude","installed":true,"auth":"yes"},{"engine":"codex","installed":true,"auth":"unknown"},{"engine":"opencode","installed":true,"auth":"yes"}]"#
        XCTAssertEqual(ProvidersOverview.runnerSummary(try runner("a", online: true, engines: all)), "All signed in")
        XCTAssertEqual(ProvidersOverview.runnerSummary(try runner("b", online: true, engines: some)),
                       "1 of 3 signed in", "an engine that wouldn't say is not signed in, and OpenCode isn't listed")
        XCTAssertEqual(ProvidersOverview.runnerSummary(try runner("c", online: false, engines: all)),
                       "Offline · All signed in")
        XCTAssertEqual(ProvidersOverview.runnerSummary(try runner("d", online: true)), "Engines not reported")
    }

    func testAPoolsLineSaysWhyItCantRunOrHowManyAccountsItHolds() {
        XCTAssertEqual(ProvidersOverview.poolSummary(ProviderPool(id: "p", slug: "p", label: "P",
                                                                  unavailable: "No accounts")),
                       "No accounts")
        XCTAssertEqual(ProvidersOverview.poolSummary(ProviderPool(id: "p", slug: "p", label: "P")), "0 accounts")
    }
}
