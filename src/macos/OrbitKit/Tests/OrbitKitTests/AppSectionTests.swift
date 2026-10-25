import XCTest
@testable import OrbitKit

final class AppSectionTests: XCTestCase {

    func testVisibleGatesAdminByRole() {
        XCTAssertFalse(AppSection.visible(isAdmin: false).contains(.admin))
        XCTAssertTrue(AppSection.visible(isAdmin: true).contains(.admin))
    }

    func testSkillsHiddenFromNav() {
        // Skills is intentionally not a top-level nav destination for either role.
        XCTAssertFalse(AppSection.visible(isAdmin: false).contains(.skills))
        XCTAssertFalse(AppSection.visible(isAdmin: true).contains(.skills))
    }

    func testNavOrder() {
        // Infrastructure first, then Agents, then Projects just before the Tasks they are for (where
        // Skills used to sit), then the Wiki — what the work learned — then Following (watches), then
        // Settings; Admin last for admins.
        XCTAssertEqual(AppSection.visible(isAdmin: false),
                       [.runners, .agents, .projects, .tasks, .wiki, .following, .settings])
        XCTAssertEqual(AppSection.visible(isAdmin: true),
                       [.runners, .agents, .projects, .tasks, .wiki, .following, .settings, .admin])
    }

    /// macOS's source list draws no Wiki row for an account the server has the wiki off for
    /// (WIKI_DISABLED), as the drawer and the web sidebar draw none; the rest keep their places.
    func testTheWikiRowFollowsWhetherTheAccountHasTheWiki() {
        XCTAssertEqual(AppSection.visible(isAdmin: false, wiki: false),
                       [.runners, .agents, .projects, .tasks, .following, .settings])
        XCTAssertEqual(AppSection.visible(isAdmin: true, wiki: false),
                       [.runners, .agents, .projects, .tasks, .following, .settings, .admin])
        XCTAssertEqual(AppSection.visible(isAdmin: true, wiki: true), AppSection.visible(isAdmin: true))
    }

    /// The drawer — on iPhone, and as the iPad's sidebar — leads with the work — projects and
    /// tasks — and the Wiki, set apart from, and above, the Workspaces. Following is not work you
    /// open: it has no drawer row.
    func testWorkSectionsLead() {
        XCTAssertEqual(AppSection.workSections, [.projects, .tasks, .wiki])
    }

    /// The Wiki's row says the web sidebar's word and draws SF Symbols' book, the glyph AntD's
    /// `BookOutlined` stands for on the web (mock 06).
    func testTheWikiSectionsTitleAndGlyph() {
        XCTAssertEqual(AppSection.wiki.title, "Wiki")
        XCTAssertEqual(AppSection.wiki.systemImage, "book.closed")
        XCTAssertFalse(AppSection.wiki.adminOnly)
    }

    /// The machines, the account pools and the API keys are one page, as the web's /infrastructure is
    /// since its Runners and Providers merged: macOS's sidebar row says so, and so does Settings' row on
    /// a phone, which opens the same page.
    func testTheRunnersSectionIsInfrastructure() {
        XCTAssertEqual(AppSection.runners.title, "Infrastructure")
        XCTAssertEqual(AppSection.runners.systemImage, "desktopcomputer")
        XCTAssertEqual(SettingsHome.title(.infrastructure), AppSection.runners.title)
        XCTAssertFalse(AppSection.allCases.map(\.title).contains("Runners"))
        XCTAssertFalse(AppSection.allCases.map(\.title).contains("Providers"))
    }

    func testEverySectionHasTitleAndIcon() {
        for s in AppSection.allCases {
            XCTAssertFalse(s.title.isEmpty, "\(s) missing title")
            XCTAssertFalse(s.systemImage.isEmpty, "\(s) missing icon")
        }
    }

    /// Routing/notifications must land in the right section so the shell follows a deep link. There's
    /// no aggregate Active view anymore — home and an individual session both land in Agents.
    func testRouteMapsToSection() {
        XCTAssertEqual(AppSection.forRoute(.active), .agents)
        XCTAssertEqual(AppSection.forRoute(.session("s1")), .agents)
        XCTAssertEqual(AppSection.forRoute(.task("t1")), .tasks)
        XCTAssertEqual(AppSection.forRoute(.runner("r1")), .runners)
    }
}
