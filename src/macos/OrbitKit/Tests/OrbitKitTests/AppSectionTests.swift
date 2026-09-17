import XCTest
@testable import OrbitKit

final class AppSectionTests: XCTestCase {

    func testVisibleGatesAdminByRole() {
        XCTAssertFalse(AppSection.visible(isAdmin: false, followingNeedsAttention: false).contains(.admin))
        XCTAssertTrue(AppSection.visible(isAdmin: true, followingNeedsAttention: false).contains(.admin))
    }

    func testSkillsHiddenFromNav() {
        // Skills is intentionally not a top-level nav destination for either role.
        XCTAssertFalse(AppSection.visible(isAdmin: false, followingNeedsAttention: true).contains(.skills))
        XCTAssertFalse(AppSection.visible(isAdmin: true, followingNeedsAttention: true).contains(.skills))
    }

    func testNavOrder() {
        // Runners first, then Agents, then Tasks (where Skills used to sit), then Settings. The two
        // conditional rows come last so neither can shift a fixed one: Following when a watch needs a
        // person, Admin for admins.
        XCTAssertEqual(AppSection.visible(isAdmin: false, followingNeedsAttention: false),
                       [.runners, .agents, .tasks, .settings])
        XCTAssertEqual(AppSection.visible(isAdmin: true, followingNeedsAttention: true),
                       [.runners, .agents, .tasks, .settings, .following, .admin])
    }

    /// Following is the watches page. Nearly every watch is one session waiting on the server for
    /// another, which that session's own header and row already narrate — so the row is offered only
    /// for the watches that need a person, and its absence is what tells a reader there are none.
    func testFollowingAppearsOnlyWhenAWatchNeedsAPerson() {
        for isAdmin in [false, true] {
            XCTAssertFalse(AppSection.visible(isAdmin: isAdmin, followingNeedsAttention: false).contains(.following))
            XCTAssertTrue(AppSection.visible(isAdmin: isAdmin, followingNeedsAttention: true).contains(.following))
            XCTAssertFalse(
                AppSection.managementSections(isAdmin: isAdmin, followingNeedsAttention: false).contains(.following))
            XCTAssertTrue(
                AppSection.managementSections(isAdmin: isAdmin, followingNeedsAttention: true).contains(.following))
        }
        // Gating the row must not cost the destination: a watch notification still deep-links into it.
        XCTAssertEqual(AppSection.forRoute(.watch("w1")), .following)
    }

    func testIPadManagementGroupKeepsNavOrderAndRoleGate() {
        XCTAssertEqual(AppSection.managementSections(isAdmin: false, followingNeedsAttention: false),
                       [.runners, .tasks, .settings])
        XCTAssertEqual(AppSection.managementSections(isAdmin: true, followingNeedsAttention: true),
                       [.runners, .tasks, .settings, .following, .admin])
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
