import Foundation
#if canImport(CoreGraphics)
import CoreGraphics   // CGSize/CGRect's Swift members on Apple platforms; Foundation has them on Linux
#endif
import XCTest
@testable import OrbitKit

/// Settings' list on iOS — what it holds and what each row says (`SettingsHome`), and the logic of
/// the pages it opens that is not a view: Shared links (`SharedLinksList`) and Machines & models' pools
/// (`ProvidersOverview`; the rest of that page is `MachinesAndModelsTests`').
final class SettingsHomeTests: XCTestCase {

    // MARK: - The list

    /// The web Settings nav's groups and rows, in its order (`settingsIndex.ts`, `SettingsLayout.tsx`):
    /// Personal, then Integrations, then Machines, then Providers — the pages the app has no page for left out.
    func testTheGroupsReadAsTheWebsNavDoes() {
        // Machines and Providers have no header: each one row says that name.
        XCTAssertEqual(SettingsHome.Group.allCases.map(SettingsHome.header), ["Personal", "Integrations", nil, nil])
        XCTAssertEqual(SettingsHome.rows(.personal),
                       [.general, .notifications, .appearance, .profile, .sharedLinks, .accessTokens])
        // Integrations, as the web's settings nav groups it: GitHub's page (docs/github-workspace-design.md §8).
        XCTAssertEqual(SettingsHome.rows(.integrations), [.github])
        XCTAssertEqual(SettingsHome.page(.github), .github)
        XCTAssertEqual(SettingsHome.githubValue(nil), nil)
        XCTAssertEqual(SettingsHome.githubValue(GithubIntegration(available: true, connected: true, login: "ada")), "@ada")
        XCTAssertEqual(SettingsHome.githubValue(GithubIntegration(available: true, connected: false)), nil)
        XCTAssertEqual(SettingsHome.rows(.machines), [.machines])
        XCTAssertEqual(SettingsHome.rows(.providers), [.providers])
    }

    /// Every row is in exactly one group, so the list can't drop one or draw one twice.
    func testEveryRowIsInExactlyOneGroup() {
        let listed = SettingsHome.Group.allCases.flatMap { SettingsHome.rows($0) }
        XCTAssertEqual(listed.count, Set(listed).count, "a row is listed twice")
        XCTAssertEqual(Set(listed), Set(SettingsHome.Row.allCases), "a row is in no group")
    }

    /// Each row has a name and a glyph of its own: the web nav's labels.
    func testEveryRowHasItsOwnNameAndGlyph() {
        let rows = SettingsHome.Row.allCases
        XCTAssertEqual(Set(rows.map(SettingsHome.title)).count, rows.count, "two rows share a name")
        XCTAssertEqual(Set(rows.map(SettingsHome.systemImage)).count, rows.count, "two rows share a glyph")
        XCTAssertEqual(rows.map(SettingsHome.title),
                       ["General", "Notifications", "Appearance", "Profile", "Shared links", "Access tokens",
                        "GitHub", "Machines", "Providers"])
        XCTAssertEqual(SettingsHome.systemImage(.machines), AppSection.runners.systemImage)
    }

    /// The rows that open a page open their own, titled as the row is; Appearance's menu opens nothing,
    /// and Change password is Profile's page, not the list's.
    func testTheRowsThatOpenAPageOpenTheirOwn() {
        let opening = SettingsHome.Row.allCases.compactMap(SettingsHome.page)
        XCTAssertEqual(Set(opening), Set(SettingsPage.allCases).subtracting([.changePassword]),
                       "a page no row opens, or a row opening two")
        XCTAssertEqual(opening.count, SettingsPage.allCases.count - 1)
        for row in SettingsHome.Row.allCases {
            if let page = SettingsHome.page(row) {
                XCTAssertEqual(page.title, SettingsHome.title(row), "the page is called what its row is")
            }
        }
        XCTAssertNil(SettingsHome.page(.appearance))
        XCTAssertEqual(SettingsPage.changePassword.title, "Change password")
    }

    /// Sessions, the page Preferences' first row opens: the web's Session defaults and Session
    /// orchestration cards, a setting a row in the order the list had them, each with the web's hint
    /// as its footer (docs/mocks/ios-settings-order, 2A). Optimize For sits directly under Smart
    /// model selection (board docs/mocks/routing-mode-account, approved 2026-11-19).
    func testTheSessionsPageHoldsTheSixSettingsWithTheWebsHints() {
        XCTAssertEqual(SessionSettings.Row.allCases,
                       [.defaultPermission, .orchestration, .modelRouting, .optimizeFor, .promptSuggestions, .recaps])
        XCTAssertEqual(SessionSettings.Row.allCases.map(SessionSettings.title),
                       ["Default permission", "Session orchestration", "Route by tier", "Optimize For",
                        "Suggested replies", "Session recaps"])
        XCTAssertEqual(SessionSettings.footer(.defaultPermission), SettingsCopy.defaultPermissionHint)
        XCTAssertEqual(SessionSettings.footer(.orchestration), SettingsCopy.letSessionsOrchestrateHint)
        XCTAssertEqual(SessionSettings.footer(.modelRouting), SettingsCopy.smartModelSelectionHint)
        XCTAssertEqual(SessionSettings.footer(.optimizeFor), SettingsCopy.optimizeForHint)
        XCTAssertEqual(SessionSettings.footer(.promptSuggestions), SettingsCopy.suggestedRepliesHint)
        XCTAssertEqual(SessionSettings.footer(.recaps), SettingsCopy.sessionRecapsHint)
        let footers = SessionSettings.Row.allCases.map(SessionSettings.footer)
        XCTAssertEqual(Set(footers).count, footers.count, "two rows share a footer")
    }

    /// Translation is the page's second group: right after Default permission and before Session
    /// orchestration, as on Android and the web (docs/mocks/session-translation, frame 7); the rows
    /// keep their order around it.
    func testTheSessionsPagePutsTranslationAfterDefaultPermission() {
        XCTAssertEqual(SessionSettings.groups,
                       [.row(.defaultPermission), .translation, .row(.orchestration), .row(.modelRouting),
                        .row(.optimizeFor), .row(.promptSuggestions), .promptOptimizer, .row(.recaps)])
    }

    /// Optimize For is drawn only while smart model selection is on, the one thing that reads it
    /// (owner, 2026-11-20); every other row always is.
    func testOptimizeForShowsOnlyWhileSmartModelSelectionIsOn() {
        XCTAssertTrue(SessionSettings.shows(.optimizeFor, smartModelSelection: true))
        XCTAssertFalse(SessionSettings.shows(.optimizeFor, smartModelSelection: false))
        for row in SessionSettings.Row.allCases where row != .optimizeFor {
            XCTAssertTrue(SessionSettings.shows(row, smartModelSelection: false), row.rawValue)
        }
    }

    // MARK: - What a row says

    private func runner(_ id: String, online: Bool) throws -> Runner {
        let json = #"{"id":"\#(id)","name":"\#(id)","online":\#(online)}"#
        return try JSONDecoder().decode(Runner.self, from: Data(json.utf8))
    }

    func testRunnersSayHowManyCanTakeWork() throws {
        let fleet = try [runner("a", online: true), runner("b", online: true),
                         runner("c", online: true), runner("d", online: false)]
        XCTAssertEqual(SettingsHome.runnersValue(fleet), "3 of 4 online")
        XCTAssertEqual(SettingsHome.runnersValue([]), "None")
    }

    /// Machines & models' row says how many lines its page's Needs you holds (03-ios.png: "1 needs you");
    /// with none, how many machines can take work.
    func testMachinesAndModelsSaysHowManyThingsNeedYou() throws {
        let fleet = try [runner("a", online: true), runner("b", online: false)]
        XCTAssertEqual(SettingsHome.machinesAndModelsValue(needsYou: 1, runners: fleet), "1 needs you")
        XCTAssertEqual(SettingsHome.machinesAndModelsValue(needsYou: 3, runners: fleet), "3 need you")
        XCTAssertEqual(SettingsHome.machinesAndModelsValue(needsYou: 0, runners: fleet), "1 of 2 online")
        XCTAssertEqual(SettingsHome.machinesAndModelsValue(needsYou: 0, runners: []), "None")

        // The count is the page's own list: the machine offline is one line of it.
        let lines = MachinesAndModels.attention(runners: fleet, workspaces: [], memberPools: [], ownPools: [])
        XCTAssertEqual(SettingsHome.machinesAndModelsValue(needsYou: lines.count, runners: fleet), "1 needs you")
    }

    /// Settings' Machines row counts the machines' lines and its Providers row the pools': a pool no
    /// session can start on is the Providers page's, and the Providers row says nothing without one.
    func testMachineAndPoolLinesSplitBetweenTheTwoRows() throws {
        let fleet = try [runner("a", online: false)]
        let lines = MachinesAndModels.attention(runners: fleet, workspaces: [], memberPools: [], ownPools: [])
        XCTAssertEqual(lines.map(\.isMachine), [true])
        let pool = MachinesAndModels.Attention(kind: .poolUnavailable(poolID: "p", own: true),
                                               line: "", names: [], detail: "")
        XCTAssertFalse(pool.isMachine)
        XCTAssertEqual(SettingsHome.needsYouValue(1), "1 needs you")
        XCTAssertEqual(SettingsHome.needsYouValue(2), "2 need you")
        XCTAssertNil(SettingsHome.needsYouValue(0))
    }

    /// A machine online where no coding CLI is signed in, and no workspace runs on a key, is one line of
    /// it too, as the web's Settings row counts it (docs/mocks/first-workspace-in-conversation 02, rule 10
    /// of 04): orbit@austin on 2026-10-31, Claude Code and Codex installed and neither signed in.
    func testAMachineWithNoCodingCLISignedInNeedsYou() throws {
        let austin = try JSONDecoder().decode(Runner.self, from: Data(#"""
        {"id":"austin","name":"orbit@austin","online":true,"engines":[
          {"engine":"claude","installed":true,"auth":"no"},{"engine":"codex","installed":true,"auth":"no"}]}
        """#.utf8))
        func workspace(_ provider: String?, on runner: String = "austin") throws -> Agent {
            let last = provider.map { #","lastProvider":"\#($0)""# } ?? ""
            return try JSONDecoder().decode(Agent.self, from: Data(
                #"{"id":"w-\#(runner)","name":"app","runnerId":"\#(runner)"\#(last)}"#.utf8))
        }
        func value(_ runners: [Runner], _ workspaces: [Agent]) -> String {
            let lines = MachinesAndModels.attention(runners: runners, workspaces: workspaces, memberPools: [], ownPools: [])
            return SettingsHome.machinesAndModelsValue(needsYou: lines.count, runners: runners)
        }
        XCTAssertEqual(value([austin], []), "1 needs you")
        XCTAssertEqual(value([austin], [try workspace("claude")]), "1 needs you")
        XCTAssertEqual(value([austin], [try workspace(nil)]), "1 needs you")
        // A workspace there on a DeepSeek key runs with nothing signed in.
        XCTAssertEqual(value([austin], [try workspace("deepseek")]), "1 of 1 online")
        // Another machine's key does nothing for this one; offline, it is counted once, as offline.
        XCTAssertEqual(value([austin], [try workspace("deepseek", on: "hpc")]), "1 needs you")
        let away = try runner("b", online: false)
        XCTAssertEqual(value([austin, away], []), "2 need you")
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

    // MARK: - Copy that is composed

    func testTheComposedLinesReadAsTheWebsDo() {
        // Names neither the server nor the account: the question is asked over the screen that
        // already shows both.
        XCTAssertEqual(SettingsCopy.signOutTitle, "Sign out?")
        XCTAssertEqual(SettingsCopy.deviceHeader("iPhone"), "This iPhone")
    }

    /// Every kind of alert the server sends is either one of the two switches or named as always
    /// sent — six kinds in `push.service.ts`, two of them gated.
    func testEveryAlertKindIsASwitchOrNamedAsAlwaysSent() {
        XCTAssertEqual(SettingsCopy.alwaysSent.count + 2, 6)
        XCTAssertEqual(Set(SettingsCopy.alwaysSent).count, SettingsCopy.alwaysSent.count)
    }

    // MARK: - Edit profile

    /// Save is live only for a name that is there and is new: an unchanged name, or one that is
    /// only spaces, has nothing to save — and spaces around a name are not a new name.
    func testSaveIsLiveForANewNameOnly() {
        XCTAssertFalse(ProfileEdit.canSave("jianghailong.rd", saved: "jianghailong.rd"))
        XCTAssertFalse(ProfileEdit.canSave("  jianghailong.rd \n", saved: "jianghailong.rd"))
        XCTAssertFalse(ProfileEdit.canSave("", saved: "jianghailong.rd"))
        XCTAssertFalse(ProfileEdit.canSave(" \t ", saved: "jianghailong.rd"))
        XCTAssertTrue(ProfileEdit.canSave("Hailong Jiang", saved: "jianghailong.rd"))
        XCTAssertTrue(ProfileEdit.canSave("江海", saved: nil), "an account with no name yet can be given one")
        XCTAssertFalse(ProfileEdit.canSave("  ", saved: nil))
    }

    /// What is sent is the name without the spaces around it — the spaces inside stay.
    func testTheNameIsSentTrimmed() {
        XCTAssertEqual(ProfileEdit.name("  Hailong  Jiang \n"), "Hailong  Jiang")
    }

    /// A new photo, or taking the photo away, is a change on its own — but never with the name blank.
    func testAPhotoIsAChangeToSave() {
        let jpeg = Data([0xFF, 0xD8, 0xFF])
        XCTAssertTrue(ProfileEdit.canSave("jianghailong.rd", saved: "jianghailong.rd", photo: .replaced(jpeg)))
        XCTAssertTrue(ProfileEdit.canSave("jianghailong.rd", saved: "jianghailong.rd", photo: .removed))
        XCTAssertFalse(ProfileEdit.canSave("jianghailong.rd", saved: "jianghailong.rd", photo: .unchanged))
        XCTAssertFalse(ProfileEdit.canSave("  ", saved: "jianghailong.rd", photo: .replaced(jpeg)),
                       "a photo does not carry a blank name through")
    }

    /// Save writes the photo first, then the name, and only what changed.
    func testSaveWritesThePhotoThenTheNameAndOnlyWhatChanged() {
        let jpeg = Data([0xFF, 0xD8, 0xFF])
        XCTAssertEqual(ProfileEdit.steps(" Hailong Jiang ", saved: "jianghailong.rd", photo: .replaced(jpeg)),
                       [.setPhoto(jpeg), .rename("Hailong Jiang")])
        XCTAssertEqual(ProfileEdit.steps("jianghailong.rd", saved: "jianghailong.rd", photo: .removed),
                       [.removePhoto])
        XCTAssertEqual(ProfileEdit.steps("Hailong Jiang", saved: "jianghailong.rd", photo: .unchanged),
                       [.rename("Hailong Jiang")])
        XCTAssertEqual(ProfileEdit.steps("jianghailong.rd", saved: "jianghailong.rd", photo: .unchanged), [])
        XCTAssertEqual(ProfileEdit.steps("", saved: "jianghailong.rd", photo: .removed), [])
    }

    /// The crop screen starts with the photo just covering the circle, and never lets it uncover.
    func testTheCropStartsCoveringTheCircleAndKeepsItCovered() {
        XCTAssertEqual(AvatarCrop.fitted(CGSize(width: 4000, height: 3000), circle: 300), CGSize(width: 400, height: 300))
        XCTAssertEqual(AvatarCrop.fitted(CGSize(width: 3000, height: 4000), circle: 300), CGSize(width: 300, height: 400))
        XCTAssertEqual(AvatarCrop.clampedZoom(0.5), 1)
        XCTAssertEqual(AvatarCrop.clampedZoom(2), 2)
        XCTAssertEqual(AvatarCrop.clampedZoom(9), AvatarCrop.maxZoom)
        let fitted = CGSize(width: 400, height: 300)
        XCTAssertEqual(AvatarCrop.clampedOffset(CGSize(width: 80, height: 30), fitted: fitted, circle: 300, zoom: 1),
                       CGSize(width: 50, height: 0), "a landscape photo slides sideways only, and only 50pt")
        XCTAssertEqual(AvatarCrop.clampedOffset(CGSize(width: -80, height: -30), fitted: fitted, circle: 300, zoom: 1),
                       CGSize(width: -50, height: 0))
        XCTAssertEqual(AvatarCrop.clampedOffset(CGSize(width: 200, height: -100), fitted: fitted, circle: 300, zoom: 2),
                       CGSize(width: 200, height: -100), "zoomed in, there is room to move both ways")
    }

    /// What is kept is the square the circle covers, in the photo's own points.
    func testTheCropKeepsTheSquareTheCircleCovers() {
        let photo = CGSize(width: 4000, height: 3000)
        XCTAssertEqual(AvatarCrop.cropRect(image: photo, circle: 300, zoom: 1, offset: .zero),
                       CGRect(x: 500, y: 0, width: 3000, height: 3000), "the middle square")
        XCTAssertEqual(AvatarCrop.cropRect(image: photo, circle: 300, zoom: 1, offset: CGSize(width: 50, height: 0)),
                       CGRect(x: 0, y: 0, width: 3000, height: 3000), "photo moved right: its left edge")
        XCTAssertEqual(AvatarCrop.cropRect(image: photo, circle: 300, zoom: 1, offset: CGSize(width: -50, height: 0)),
                       CGRect(x: 1000, y: 0, width: 3000, height: 3000), "photo moved left: its right edge")
        XCTAssertEqual(AvatarCrop.cropRect(image: photo, circle: 300, zoom: 2, offset: .zero),
                       CGRect(x: 1250, y: 750, width: 1500, height: 1500), "zoomed in twice: half the side, same centre")
    }

    func testAFailedSaveSaysWhy() {
        XCTAssertEqual(SettingsCopy.nameNotSaved("the connection dropped"),
                       "Couldn't save your name — the connection dropped.")
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

    /// Board 13: only an active link's row opens its Share panel, and its ⋯ is named after it.
    func testOnlyAnActiveLinksRowOpensAndItsMoreNamesIt() {
        XCTAssertTrue(SharedLinksList.opens(link(.active)))
        XCTAssertFalse(SharedLinksList.opens(link(.paused)), "a session in the Trash has no panel to change")
        XCTAssertFalse(SharedLinksList.opens(link(.ended)))
        XCTAssertEqual(SharedLinksList.moreLabel(link(.active)), "More for Root")
        XCTAssertEqual(SharedLinksList.moreLabel(link(.active, kind: .wiki, root: ShareRootSummary(id: "w"))), "More for Wiki")
        XCTAssertEqual([SharedLinksList.settings, SharedLinksList.turnOffMenu], ["Settings…", "Turn off…"])
    }

    func testTurningOffSaysHowManyWent() {
        XCTAssertEqual(SharedLinksList.turnedOff(1), "Link turned off")
        XCTAssertEqual(SharedLinksList.turnedOff(3), "3 links turned off")
    }

    func testThePublicAddressIsTheTokenUnderS() {
        let url = SharedLinksList.publicURL(link(.active), base: URL(string: "https://orbitd.io")!)
        XCTAssertEqual(url.absoluteString, "https://orbitd.io/s/tok")
    }

    // MARK: - Machines & models' pools

    func testAPoolsValueSaysWhyItCantRunOrHowManyOfItsAccountsCan() {
        XCTAssertEqual(ProvidersOverview.poolSummary(ProviderPool(id: "p", slug: "p", label: "P",
                                                                  unavailable: "No accounts")),
                       "No accounts")
        XCTAssertEqual(ProvidersOverview.poolSummary(ProviderPool(id: "p", slug: "p", label: "P")), "0 of 0 available")
        let members = [PoolMemberState.running, .available, .noQuota, .spent, .refused, .disabled, .unknown]
            .enumerated().map { PoolMember(id: "m\($0.offset)", slug: "m\($0.offset)", label: "M", state: $0.element) }
        XCTAssertEqual(ProvidersOverview.poolSummary(ProviderPool(id: "p", slug: "p", label: "P", members: members)),
                       "3 of 7 available", "running, available and no-quota members can take a session")
    }
}
