import Foundation
import XCTest
@testable import OrbitKit

/// SwiftUI doesn't exist on Linux, so nothing here compiles the login page or `AppModel`. These hold
/// them to the remembered account as the board has it (docs/mocks/login-remember-account/): the card
/// in the Email field's place, what is written when, what Sign out leaves, and the logo's double tap.
/// The rules themselves are RememberedAccountTests'; each check here reads the slice it is about.
final class RememberedAccountWiringTests: XCTestCase {
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

    private func count(_ pattern: String, in text: String) throws -> Int {
        try NSRegularExpression(pattern: pattern).numberOfMatches(in: text, range: NSRange(text.startIndex..., in: text))
    }

    private func loginView() throws -> String {
        code(try source("src/macos/OrbitApp/Sources/OrbitApp/Views/LoginView.swift"))
    }

    private func appModel() throws -> String {
        code(try source("src/macos/OrbitApp/Sources/OrbitApp/AppModel.swift"))
    }

    private func appModel(_ start: String, to end: String = "\n    }\n") throws -> String {
        try slice(try appModel(), from: start, to: end)
    }

    // MARK: - The page

    func testTheLogoOpensTheServerSheetOnADoubleTap() throws {
        let logo = try slice(try loginView(), from: "private func logo(_ size: CGFloat) -> some View {", to: "\n    }\n")
        XCTAssertTrue(logo.contains(".onTapGesture(count: 2) { serverSheet = true }"))
        XCTAssertFalse(logo.contains("count: 3"))
        XCTAssertTrue(logo.contains(".accessibilityAction(named: \"Change server\") { serverSheet = true }"))
    }

    /// The card stands where the Email field was, for the domain's account, unless "Use another account"
    /// put the full form back.
    func testTheCardTakesTheEmailFieldsPlace() throws {
        let view = try loginView()
        XCTAssertEqual(try count(#"if let card \{\s*accountCard\(card\)\s*\} else \{\s*LoginField\(label: "Email""#,
                                 in: view), 1)
        let card = try slice(view, from: "private var card: RememberedAccount? {", to: "\n    }\n")
        XCTAssertTrue(card.contains("model.usesAnotherAccount ? nil : model.rememberedAccount"))
        // Nothing takes the focus as the page appears: someone who just signed out may not be back.
        let page = try slice(view, from: "struct LoginView: View {", to: "\n}\n")
        XCTAssertFalse(page.contains(".onAppear"))
        XCTAssertEqual(try count(#"focus = "#, in: page), 1, "only the Email field's Next moves the focus")
    }

    /// LoginField's shape and fill; a 40pt photo or initial, the name, the email, the domain; not a
    /// button. The email is a text field the system reads as the username and nobody can edit.
    func testTheCardIsTheAccountAndItsDomain() throws {
        let card = try slice(try loginView(), from: "private struct AccountCard: View {", to: "\n}\n")
        XCTAssertTrue(card.contains("RoundedRectangle(cornerRadius: 14, style: .continuous)"))
        XCTAssertTrue(card.contains(".background(shape.fill(Color.secondary.opacity(0.1)))"))
        XCTAssertTrue(card.contains("AvatarPhoto(image: photo, diameter: 40)"))
        XCTAssertTrue(card.contains("AvatarMonogram(name: account.displayName, diameter: 40)"))
        XCTAssertTrue(card.contains("Text(account.displayName)"))
        XCTAssertTrue(card.contains("TextField(\"Email\", text: .constant(account.email))\n"
                                    + "                    .textContentType(.username)"))
        XCTAssertTrue(card.contains(".allowsHitTesting(false)"))
        XCTAssertTrue(card.contains("Image(systemName: \"globe\")"))
        XCTAssertTrue(card.contains("Text(domain)"))
        XCTAssertFalse(card.contains("Button"), "the card is not a button")
        XCTAssertFalse(card.contains("#if os("), "the Mac draws the same card")
        // The domain line names the server the way Settings does.
        let wiring = try slice(try loginView(), from: "private func accountCard(_ account: RememberedAccount) -> some View {",
                               to: "\n    }\n")
        XCTAssertTrue(wiring.contains("SettingsHome.instanceName(ServerURL.normalize(model.instanceField))"))
    }

    func testALongPressRemovesTheAccountFromThisDevice() throws {
        let wiring = try slice(try loginView(), from: "private func accountCard(_ account: RememberedAccount) -> some View {",
                               to: "\n    }\n")
        XCTAssertEqual(try count(#"\.contextMenu \{\s*Button\(role: \.destructive\) \{ model\.forgetRememberedAccount\(\) \} label: \{\s*Label\("Remove from this device", systemImage: "trash"\)"#,
                                 in: wiring), 1)
        XCTAssertTrue(wiring.contains(".accessibilityAction(named: \"Remove from this device\") { model.forgetRememberedAccount() }"))
    }

    func testUseAnotherAccountAndSignInAsGoBackAndForth() throws {
        let view = try loginView()
        XCTAssertTrue(view.contains("Button(\"Use another account\") { model.useAnotherAccount() }"))
        XCTAssertTrue(view.contains("let signInAs = \"Sign in as \\(remembered.displayName)\"\n"
                                    + "                            Button(signInAs) { model.useRememberedAccount() }"))
        XCTAssertEqual(try count(#"if card != nil \{\s*Button\("Use another account"\)"#, in: view), 1)
        XCTAssertEqual(try count(#"\} else if let remembered = model\.rememberedAccount \{"#, in: view), 1)
        // Text buttons in the link colour on both platforms (a borderless button is grey on the Mac).
        XCTAssertEqual(try count(#"\{ model\.(useAnotherAccount|useRememberedAccount)\(\) \}\s*\.linkButtonStyle\(\)"#, in: view), 2)
        // Neither forgets anything.
        for name in ["func useAnotherAccount() {", "func useRememberedAccount() {"] {
            XCTAssertFalse(try appModel(name).contains("forget"), name)
        }
        XCTAssertTrue(try appModel("func useAnotherAccount() {").contains("email = \"\""))
    }

    // MARK: - When it is written, and what Sign out leaves

    func testEachSignInIsRememberedOnlyOnceItSucceeds() throws {
        let password = try appModel("func login() async {")
        let google = try appModel("func loginWithGoogle() async {")
        for (body, step) in [(password, "rememberSignIn(.password)"), (google, "rememberSignIn(.google)")] {
            let me = try XCTUnwrap(body.range(of: "user = try? await api!.me()"))
            let remember = try XCTUnwrap(body.range(of: step), step)
            let signedIn = try XCTUnwrap(body.range(of: "signedIn = true"))
            let failed = try XCTUnwrap(body.range(of: "} catch"))
            XCTAssertLessThan(me.lowerBound, remember.lowerBound, "\(step): email and name are /users/me's")
            XCTAssertLessThan(remember.lowerBound, signedIn.lowerBound, step)
            XCTAssertLessThan(remember.lowerBound, failed.lowerBound, "\(step): a failed sign-in changes nothing")
        }
        // The pre-card key is the store's to delete now, never written again.
        XCTAssertFalse(try appModel().contains("orbit.email"))
        let remember = try appModel("private func rememberSignIn(_ method: RememberedAccount.Method) {")
        XCTAssertTrue(remember.contains("rememberedAccounts.signedIn(on: baseURL, email: signedInAs, name: user?.name, method: method)"))
    }

    /// While signed in — the first launch after the update included — the domain's account follows
    /// `user`, and the photo is written where it is fetched or saved.
    func testWhileSignedInTheAccountFollowsTheUserAndItsPhoto() throws {
        let user = try appModel("var user: User? {")
        XCTAssertTrue(user.contains("rememberUser()"))
        let follow = try appModel("private func rememberUser() {")
        XCTAssertTrue(follow.contains("guard signedIn, let baseURL, let user else { return }"))
        XCTAssertTrue(follow.contains("rememberedAccounts.keep(user, on: baseURL)"))
        let fetched = try appModel("private func refreshAvatar() {")
        XCTAssertTrue(fetched.contains("rememberedAccounts.keepPhoto(data, version: version, on: server)"))
        let saved = try appModel("func saveAvatar(_ jpeg: Data) async -> String? {")
        XCTAssertTrue(saved.contains("rememberedAccounts.keepPhoto(jpeg, version: version, on: baseURL)"))
    }

    /// Sign out and a 401 run the same `logout()`: it still revokes and deletes the tokens, keeps the
    /// account, and opens the page on its card.
    func testSignOutKeepsTheAccountAndStillRevokes() throws {
        let logout = try appModel("func logout() {")
        XCTAssertTrue(logout.contains("Task { await api.revokeRefreshToken(refreshToken) }"))
        XCTAssertTrue(logout.contains("tokenStore.setToken(nil, for: baseURL)"))
        XCTAssertTrue(logout.contains("tokenStore.setRefreshToken(nil, for: baseURL)"))
        XCTAssertTrue(logout.contains("showRememberedAccount()"))
        XCTAssertFalse(logout.contains("forget"))
        // Only Remove from this device forgets.
        XCTAssertEqual(try count(#"rememberedAccounts\.forget\("#, in: try appModel()), 1)
        XCTAssertTrue(try appModel("func forgetRememberedAccount() {").contains("rememberedAccounts.forget(on: server)"))
    }

    /// Another server in the Server sheet shows that domain's account; the page opens on the last one.
    func testTheCardIsTheShownDomainsOwn() throws {
        let field = try appModel("var instanceField = AppModel.defaultInstance {")
        XCTAssertTrue(field.contains("didSet { if instanceField != oldValue { showRememberedAccount() } }"))
        let show = try appModel("private func showRememberedAccount() {")
        XCTAssertTrue(show.contains("let server = ServerURL.normalize(instanceField)"))
        XCTAssertTrue(show.contains("rememberedAccount = server.flatMap(rememberedAccounts.account(on:))"))
        XCTAssertTrue(show.contains("email = rememberedAccounts.email(toShowOn: server)"))
        XCTAssertTrue(try appModel("init() {").contains("showRememberedAccount()"))
    }

    /// Nothing that signs anyone in reaches the store: no password, no token in any call to it.
    func testNoPasswordOrTokenIsRemembered() throws {
        let calls = try appModel().split(separator: "\n").filter { $0.contains("rememberedAccounts.") }
        XCTAssertGreaterThanOrEqual(calls.count, 7)
        for call in calls {
            XCTAssertFalse(call.lowercased().contains("password"), String(call))
            XCTAssertFalse(call.lowercased().contains("token"), String(call))
        }
    }
}
