import Foundation
import XCTest
@testable import OrbitKit

/// SwiftUI doesn't exist on Linux, so nothing here compiles the app shells. These hold Settings →
/// Access tokens to the source it is (docs/personal-access-token-design.md §9): on iOS a page of
/// Settings' sheet, on macOS a section of the one grouped form, both listing the account's tokens in
/// the same rows and revoking one only after asking — and neither ever issuing one, which is the
/// web's alone. Each check reads the slice of the file it is about, so a match elsewhere can't pass it.
final class AccessTokensWiringTests: XCTestCase {
    private struct SourceMissing: Error, CustomStringConvertible {
        let path: String
        var description: String {
            "\(path) wasn't found above this test. If it moved, point this check at its new home — "
                + "don't delete the check."
        }
    }

    /// Found by walking up from this file; never a skip, so the check can't go quiet when a file moves.
    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir.deleteLastPathComponent()
        }
        throw SourceMissing(path: relative)
    }

    private func appSource(_ relative: String) throws -> String {
        try source("src/macos/OrbitApp/Sources/OrbitApp/\(relative)")
    }

    /// From the first `start` through the next `end` after it.
    private func slice(_ text: String, from start: String, to end: String) throws -> String {
        let lower = try XCTUnwrap(text.range(of: start), "no `\(start)`")
        let upper = try XCTUnwrap(text.range(of: end, range: lower.upperBound..<text.endIndex),
                                  "no `\(end)` after `\(start)`")
        return String(text[lower.lowerBound..<upper.upperBound])
    }

    /// The text without its comment lines, which are free to talk about what the code must not do.
    private func code(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
    }

    private func iosPage() throws -> String {
        code(try slice(try appSource("Views/SettingsSheet.swift"),
                       from: "private struct AccessTokensSettingsPage: View {", to: "\n#endif"))
    }

    private func macSection() throws -> String {
        code(try slice(try appSource("Views/SettingsAdminView.swift"),
                       from: "private struct AccessTokensSection: View {", to: "\n#endif"))
    }

    /// Settings' Account group opens the page from its own row, which says how many tokens work.
    func testTheIOSRowOpensThePageAndCountsTheTokensThatWork() throws {
        XCTAssertEqual(SettingsHome.page(.accessTokens), .accessTokens)
        let sheet = try appSource("Views/SettingsSheet.swift")
        let pages = code(try slice(sheet, from: "private struct SettingsPageView: View {", to: "// MARK: - The list"))
        XCTAssertTrue(pages.contains("case .accessTokens:   AccessTokensSettingsPage()"))
        let list = code(try slice(sheet, from: "struct SettingsHomeView: View {", to: "private struct SettingsRowLabel: View {"))
        XCTAssertTrue(list.contains("return model.accessTokens?.activeCount.map(SettingsHome.accessTokensValue)"))
        XCTAssertTrue(list.contains(".task { await model.accessTokens?.load() }"),
                      "the row's count is read when Settings opens, as Shared links' is")
    }

    /// The iOS page lists the account's tokens in the web's two tabs, in the shared row, and a swipe
    /// or the context menu only asks: the revoke itself is the confirmation's destructive button.
    func testTheIOSPageListsTheTokensAndRevokesOnlyAfterAsking() throws {
        let page = try iosPage()
        XCTAssertTrue(page.contains("ForEach(AccessTokensList.Tab.allCases)"))
        XCTAssertTrue(page.contains("AccessTokensList.tokens(tokens, in: tab)"))
        XCTAssertTrue(page.contains("AccessTokenRow(token: token, now: Date())"))
        XCTAssertTrue(page.contains("Text(AccessTokensList.subtitle + \" \" + AccessTokensList.issuedOnTheWeb)"),
                      "the page says where a new token is made, since it can't make one")
        XCTAssertTrue(page.contains(".task { await model.accessTokens?.load() }"))
        XCTAssertTrue(page.contains(".refreshable { await model.accessTokens?.load() }"))

        let row = try slice(page, from: "private func row(_ token: AccessToken) -> some View {",
                            to: "private func revoke(_ token: AccessToken) async {")
        XCTAssertTrue(row.contains(".swipeActions(edge: .trailing) {"))
        XCTAssertTrue(row.contains(".contextMenu {"))
        XCTAssertTrue(row.contains("if AccessTokensList.canRevoke(token) {"), "only a working token offers Revoke")
        XCTAssertFalse(row.contains("revoke(token)"), "a swipe asks first; it never revokes by itself")
        XCTAssertTrue(row.contains("pendingRevoke = token"))

        XCTAssertTrue(page.contains(".confirmationDialog(pendingRevoke.map(AccessTokensList.revokeTitle)"))
        XCTAssertTrue(page.contains("Button(AccessTokensList.revoke, role: .destructive) { Task { await revoke(token) } }"))
        XCTAssertTrue(page.contains("Text(AccessTokensList.revokeDetail)"))
        XCTAssertTrue(page.contains("show(AccessTokensList.notRevoked(reason))"), "a failed revoke says why")
    }

    /// macOS: a section of the one grouped form, between Change password and Updates, read when the
    /// form opens, with each working token's Revoke button asking on its own row.
    func testTheMacFormHasTheSectionAndRevokesOnlyAfterAsking() throws {
        let form = code(try slice(try appSource("Views/SettingsAdminView.swift"),
                                  from: "#if os(macOS)\n/// macOS Settings", to: "private struct AccessTokensSection"))
        let order = ["Section(\"Change password\")", "AccessTokensSection()", "Section(\"Updates\")"]
            .map { form.range(of: $0)?.lowerBound }
        XCTAssertFalse(order.contains(where: { $0 == nil }), "the form lost one of \(order)")
        if let a = order[0], let b = order[1], let c = order[2] {
            XCTAssertTrue(a < b && b < c, "Access tokens sits between Change password and Updates")
        }
        XCTAssertTrue(form.contains(".task { await model.accessTokens?.load() }"))

        let section = try macSection()
        XCTAssertTrue(section.contains("Section(AccessTokensList.title) {"))
        XCTAssertTrue(section.contains("Text(AccessTokensList.subtitle + \" \" + AccessTokensList.issuedOnTheWeb)"))
        XCTAssertTrue(section.contains("ForEach(AccessTokensList.Tab.allCases)"))
        XCTAssertTrue(section.contains("AccessTokenRow(token: token, now: Date())"))
        XCTAssertTrue(section.contains("if AccessTokensList.canRevoke(token) {"))
        XCTAssertTrue(section.contains("Button(AccessTokensList.revoke + \"…\", role: .destructive) { pendingRevoke = token }"),
                      "the row's button only asks")
        XCTAssertTrue(section.contains(".confirmationDialog(AccessTokensList.revokeTitle(token), isPresented: revokeAsked(token)) {"))
        XCTAssertTrue(section.contains("Button(AccessTokensList.revoke, role: .destructive) { Task { await revoke(token) } }"))
        XCTAssertTrue(section.contains("Text(AccessTokensList.revokeDetail)"))
    }

    /// Both read one model per account, which `AppModel` builds with the others.
    func testOneModelPerAccountServesBoth() throws {
        let app = code(try appSource("AppModel.swift"))
        XCTAssertTrue(app.contains("private(set) var accessTokens: AccessTokensModel?"))
        XCTAssertTrue(app.contains("accessTokens = AccessTokensModel(baseURL: url, tokenStore: tokenStore)"))
        let model = code(try appSource("AccessTokensModel.swift"))
        XCTAssertTrue(model.contains("tokens = try await api.accessTokens()"))
        XCTAssertTrue(model.contains("try await api.revokeAccessToken(token.id)"))
    }

    /// v1 lists and revokes; issuing is the web's alone (§9) — no door for it in OrbitKit, and no
    /// press for it in either app. And no sibling `async let` in what this added: iOS 27's runtime
    /// can abort tearing several of them down (d22b276cc).
    func testTheAppsNeverIssueATokenAndUseNoAsyncLets() throws {
        let client = code(try source("src/macos/OrbitKit/Sources/OrbitKit/Net/APIClient.swift"))
        XCTAssertFalse(client.contains("post(\"access-tokens\""), "OrbitKit has no door that issues a token")
        let added = [try iosPage(), try macSection(),
                     code(try appSource("AccessTokensModel.swift")),
                     code(try appSource("Views/AccessTokenRow.swift"))]
        for text in added {
            XCTAssertFalse(text.contains("issueAccessToken"), "an app surface reaches for issuing a token")
            XCTAssertFalse(text.contains("\"access-tokens\""), "an app surface calls the token doors itself")
            XCTAssertFalse(text.contains("async let"), "sibling async lets abort on iOS 27")
        }
    }
}
