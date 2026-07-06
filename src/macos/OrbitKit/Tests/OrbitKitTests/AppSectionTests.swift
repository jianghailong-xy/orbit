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
        // Runners first, then Agents, then Tasks (where Skills used to sit), then Settings; Admin last for admins.
        XCTAssertEqual(AppSection.visible(isAdmin: false), [.runners, .agents, .tasks, .settings])
        XCTAssertEqual(AppSection.visible(isAdmin: true), [.runners, .agents, .tasks, .settings, .admin])
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
