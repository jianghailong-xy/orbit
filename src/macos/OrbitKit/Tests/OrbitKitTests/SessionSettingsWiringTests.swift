import Foundation
import XCTest
@testable import OrbitKit

/// The session Settings sheet's wiring (docs/mocks/session-settings native.html ①–④): the iPhone's ⋯
/// menu has Settings… right after Tags…, the Mac's toolbar has it beside Move…, both open the one
/// sheet, which holds Session, Environment, Notifications and Info and pushes the Variables page.
///
/// SwiftUI doesn't exist on Linux, so these read the source, as the other wiring tests do.
final class SessionSettingsWiringTests: XCTestCase {
    private struct SourceMissing: Error, CustomStringConvertible {
        let path: String
        var description: String { "\(path) wasn't found above this test. If it moved, point this check at its new home." }
    }

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

    private func slice(_ text: String, from start: String, to end: String,
                       file: StaticString = #filePath, line: UInt = #line) throws -> String {
        let lower = try XCTUnwrap(text.range(of: start), "no `\(start)`", file: file, line: line)
        let upper = try XCTUnwrap(text.range(of: end, range: lower.upperBound..<text.endIndex),
                                  "no `\(end)` after `\(start)`", file: file, line: line)
        return String(text[lower.lowerBound..<upper.upperBound])
    }

    private func code(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
    }

    func testThePhonesMenuHasSettingsRightAfterTags() throws {
        let console = code(try appSource("Views/Console/ConsoleView.swift"))
        let menu = try slice(console, from: "private func sessionMenu(", to: ".orbitConfirmation(")
        let tags = try XCTUnwrap(menu.range(of: "Label(\"Tags…\", systemImage: \"tag\")"))
        let settings = try XCTUnwrap(menu.range(of: "Label(SessionSettingsPanel.menuItem, systemImage: \"gearshape\")"))
        XCTAssertLessThan(tags.upperBound, settings.lowerBound)
        let between = String(menu[tags.upperBound..<settings.lowerBound])
        XCTAssertEqual(between.components(separatedBy: "Label(").count, 1, "nothing between Tags… and Settings…")
        XCTAssertTrue(menu.contains("Button { settingsSession = session }"))
        XCTAssertEqual(SessionSettingsPanel.menuItem, "Settings…")
    }

    func testTheMacToolbarAndThePhoneOpenTheSameSheet() throws {
        let console = code(try appSource("Views/Console/ConsoleView.swift"))
        let mac = try slice(console, from: "ToolbarItem(placement: .primaryAction) {\n                if let session = appModel.session(id: sessionID), session.isLanding != true {",
                            to: "#endif")
        XCTAssertTrue(mac.contains("settingsSession = session"))
        XCTAssertEqual(console.components(separatedBy: ".sheet(item: $settingsSession)").count, 2, "one sheet")
        let sheet = try slice(console, from: ".sheet(item: $settingsSession)", to: ".environment(appModel)")
        XCTAssertTrue(sheet.contains("SessionSettingsSheet(sessionID: session.id,"))
        // Presented outside the platform branches, so both get it.
        let tail = String(console[console.range(of: ".sheet(item: $settingsSession)")!.lowerBound...])
        let before = String(console[..<console.range(of: ".sheet(item: $settingsSession)")!.lowerBound])
        XCTAssertGreaterThan(before.components(separatedBy: "#endif").count, before.components(separatedBy: "#else").count - 1)
        XCTAssertFalse(tail.prefix(400).contains("#if"))
    }

    func testTheSheetHoldsTheFourGroupsAndTheVariablesPage() throws {
        let sheet = code(try appSource("Views/SessionSettingsSheet.swift"))
        let form = try slice(sheet, from: "Form {", to: ".formStyle(.grouped)")
        let order = ["sessionSection", "environmentSection", "notificationsSection", "infoSection"]
        let positions = order.map { form.range(of: $0)?.lowerBound }
        XCTAssertFalse(positions.contains(nil), "every group is in the form")
        XCTAssertEqual(positions.compactMap { $0 }, positions.compactMap { $0 }.sorted(), "in the board's order")
        XCTAssertTrue(sheet.contains("Button(SessionSettingsPanel.done) { dismiss() }"))
        XCTAssertTrue(sheet.contains("NavigationLink(value: SessionSettingsRoute.variables)"))
        XCTAssertTrue(sheet.contains("SessionVariablesPage(model: model)"))
        let page = try slice(sheet, from: "struct SessionVariablesPage: View {", to: "struct VariableEdit")
        XCTAssertTrue(page.contains(".onDelete {"), "swipe left deletes a session variable")
        XCTAssertTrue(page.contains("SessionSettingsPanel.workspaceRows(settings)"))
        XCTAssertTrue(page.contains("SessionRestartBanner(model: model)"))
        // Nothing the composer offers.
        for composer in ["permissionMode", "fastMode", ".effort", "model:" + " session.model"] {
            XCTAssertFalse(sheet.contains(composer), "\(composer) belongs to the composer")
        }
    }
}
