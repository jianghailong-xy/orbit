import Foundation
import XCTest

/// SwiftUI doesn't exist on Linux, so nothing here compiles the lists. These hold the refreshable
/// lists' top bands to their source: they go through `topInsetClearOfRefresh`, which moves the iOS
/// 26 refresh control off them by the tested `RefreshControlClearance` — a bare top inset on the
/// session list is what drew the pull's spinner over the "… needs you" bar.
final class TopInsetClearOfRefreshWiringTests: XCTestCase {
    private struct SourceMissing: Error, CustomStringConvertible {
        let path: String
        var description: String {
            "\(path) wasn't found above this test. If it moved, point this check at its new home — "
                + "don't delete the check."
        }
    }

    /// Found by walking up from this file; never a skip, so the check can't go quiet when a file moves.
    private func appSource(_ relative: String) throws -> String {
        let path = "src/macos/OrbitApp/Sources/OrbitApp/\(relative)"
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(path)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir.deleteLastPathComponent()
        }
        throw SourceMissing(path: path)
    }

    /// The text without its comment lines, which are free to talk about what the code must not do.
    private func code(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
    }

    func testTheSessionListsTopBandsStayClearOfTheRefreshControl() throws {
        let agents = code(try appSource("Views/AgentsView.swift"))
        XCTAssertTrue(agents.contains(".topInsetClearOfRefresh {"),
                      "the scope picker and the needs-you bar go through the modifier")
        XCTAssertFalse(agents.contains(".safeAreaInset(edge: .top"),
                       "a bare top inset on the refreshable list puts the pull's spinner on the bar")
    }

    func testTheRunnersAndSkillsNoticeStaysClearOfTheRefreshControl() throws {
        let runners = code(try appSource("Views/SkillsRunnersView.swift"))
        XCTAssertTrue(runners.contains(".topInsetClearOfRefresh {"),
                      "the load-failure notice over rows goes through the modifier")
        XCTAssertFalse(runners.contains(".safeAreaInset(edge: .top"),
                       "the phone's runners and skills lists pull to refresh too")
    }

    func testTheTestedRuleMovesOnlyTheNearestListsOwnControl() throws {
        let modifier = code(try appSource("Views/TopInsetClearOfRefresh.swift"))
        XCTAssertTrue(modifier.contains("RefreshControlClearance.shift("), "the tested rule decides")
        XCTAssertTrue(modifier.contains("control.superview?.superview is UINavigationBar"),
                      "only the arrangement that was measured is moved")
        XCTAssertTrue(modifier.contains("nearest.refreshControl != nil"),
                      "the nearest list, and only if it refreshes — never one further off")
        XCTAssertTrue(modifier.contains("VStack(spacing: 0) { bands }"),
                      "empty bands still report a frame, so a gone notice stops moving the control")
    }

    func testAListAFinishedRefreshLeftPastItsTopGoesBackUnlessTheReaderTookIt() throws {
        let modifier = code(try appSource("Views/TopInsetClearOfRefresh.swift"))
        XCTAssertTrue(modifier.contains("if wasRefreshing, !control.isRefreshing { refreshEnded() }"),
                      "watched from the moment iOS itself says the refresh has stopped")
        XCTAssertTrue(modifier.contains("RefreshControlClearance.returnsToTop("),
                      "the tested rule decides how far past its top is a refresh's doing")
        XCTAssertTrue(modifier.contains("if pan.state == .began { settling = nil }"),
                      "a drag after the refresh is the reader's, and nothing pulls it back")
        XCTAssertTrue(modifier.contains("placement.scrollView = nil"),
                      "off screen the list is let go, drag target included")
    }
}
