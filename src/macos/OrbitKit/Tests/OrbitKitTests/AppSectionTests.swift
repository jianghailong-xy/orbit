import XCTest
@testable import OrbitKit

final class AppSectionTests: XCTestCase {

    /// The drawer — on iPhone, as the iPad's sidebar, and as the Mac's source list — leads with the
    /// work — projects and tasks — and the Wiki, set apart from, and above, the Workspaces. Following is
    /// not work you open: it has no row. Skills is no destination at all.
    func testWorkSectionsLead() {
        XCTAssertEqual(AppSection.workSections, [.projects, .tasks, .wiki])
        XCTAssertFalse(AppSection.workSections.contains(.skills))
    }

    /// The Wiki's row says the web sidebar's word and draws SF Symbols' book, the glyph AntD's
    /// `BookOutlined` stands for on the web (mock 06).
    func testTheWikiSectionsTitleAndGlyph() {
        XCTAssertEqual(AppSection.wiki.title, "Wiki")
        XCTAssertEqual(AppSection.wiki.systemImage, "book.closed")
    }

    /// The machines, the account pools and the API keys are one page, as the web's /infrastructure is
    /// since its Runners and Providers merged — Machines & models (docs/mocks/machines-and-models): the
    /// Mac's window title and Settings' row on every client say so, and open the same page.
    func testTheRunnersSectionIsMachinesAndModels() {
        XCTAssertEqual(AppSection.runners.title, "Machines & models")
        XCTAssertEqual(AppSection.runners.systemImage, "desktopcomputer")
        XCTAssertEqual(SettingsHome.title(.machinesAndModels), AppSection.runners.title)
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
