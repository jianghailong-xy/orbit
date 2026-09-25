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
        // Runners first, then Agents, then Projects just before the Tasks they are for (where Skills
        // used to sit), then the Wiki — what the work learned — then Following (watches), then
        // Settings; Admin last for admins.
        XCTAssertEqual(AppSection.visible(isAdmin: false),
                       [.runners, .agents, .projects, .tasks, .wiki, .following, .settings])
        XCTAssertEqual(AppSection.visible(isAdmin: true),
                       [.runners, .agents, .projects, .tasks, .wiki, .following, .settings, .admin])
    }

    /// The drawer and the iPad sidebar lead with the work — projects and tasks — and the Wiki, set
    /// apart from, and above, the Workspaces; what is left is the Manage group, still role-gated.
    /// Following is not work you open: it has no drawer row, and on iPad it sits in Manage.
    func testWorkSectionsLeadAndManagementGroupKeepsTheRest() {
        XCTAssertEqual(AppSection.workSections, [.projects, .tasks, .wiki])
        XCTAssertEqual(AppSection.managementSections(isAdmin: false), [.runners, .following, .settings])
        XCTAssertEqual(AppSection.managementSections(isAdmin: true), [.runners, .following, .settings, .admin])
    }

    /// The Wiki's row says the web sidebar's word and draws SF Symbols' book, the glyph AntD's
    /// `BookOutlined` stands for on the web (mock 06).
    func testTheWikiSectionsTitleAndGlyph() {
        XCTAssertEqual(AppSection.wiki.title, "Wiki")
        XCTAssertEqual(AppSection.wiki.systemImage, "book.closed")
        XCTAssertFalse(AppSection.wiki.adminOnly)
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
