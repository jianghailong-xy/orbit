import Foundation
import XCTest
@testable import OrbitKit

/// SwiftUI and AuthenticationServices don't exist on Linux, so nothing here compiles the login page,
/// `AppModel` or OrbitKit's sheet. These hold them to the source they are
/// (docs/google-sign-in-design.md §8.2): Continue with Google only where the page's server offers
/// it, asked again when the server changes, signing in the way the password does, in a sheet that
/// shares the browser's Google session. Each check reads the slice it is about.
final class GoogleSignInWiringTests: XCTestCase {
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

    private func appModel(_ start: String, to end: String = "\n    }\n") throws -> String {
        code(try slice(try source("src/macos/OrbitApp/Sources/OrbitApp/AppModel.swift"), from: start, to: end))
    }

    private func sheet() throws -> String {
        let kit = try source("src/macos/OrbitKit/Sources/OrbitKit/Auth/GoogleSignIn.swift")
        return code(try slice(kit, from: "#if canImport(AuthenticationServices)", to: "\n#endif"))
    }

    // MARK: OrbitKit's sheet

    func testTheSheetSharesTheBrowsersGoogleSessionAndAnswersOnTheAppsScheme() throws {
        let sheet = try sheet()
        XCTAssertTrue(sheet.contains("ASWebAuthenticationSession(url: url, callbackURLScheme: GoogleSignIn.callbackScheme)"))
        XCTAssertTrue(sheet.contains("session.prefersEphemeralWebBrowserSession = false"))
        XCTAssertTrue(sheet.contains("session.presentationContextProvider = self"))
        XCTAssertTrue(sheet.contains("ASWebAuthenticationSessionError)?.code == .canceledLogin"))
        XCTAssertTrue(sheet.contains("GoogleSignInError.cancelled"))
    }

    /// Everything the Linux run tests sits above the guard: none of it may need AuthenticationServices.
    func testOnlyTheGuardedHalfNeedsAuthenticationServices() throws {
        let kit = try source("src/macos/OrbitKit/Sources/OrbitKit/Auth/GoogleSignIn.swift")
        let guardStart = try XCTUnwrap(kit.range(of: "#if canImport(AuthenticationServices)"))
        let portable = code(String(kit[..<guardStart.lowerBound]))
        XCTAssertFalse(portable.contains("AuthenticationServices"))
        XCTAssertFalse(portable.contains("ASWebAuthentication"))
        XCTAssertFalse(portable.contains("ASPresentationAnchor"))
        XCTAssertTrue(try sheet().contains("import AuthenticationServices"))
    }

    // MARK: the login page

    func testTheLoginPageOffersGoogleOnlyWhereItsServerDoes() throws {
        let view = try loginView()
        let google = try slice(view, from: "@ViewBuilder private var googleSignIn: some View {", to: "\n    }\n")
        // Drawn in one place, and only inside the server's yes.
        XCTAssertEqual(try count(#"\bgoogleSignIn\b"#, in: view), 2)
        XCTAssertEqual(try count(#"if model\.signInMethods\.google \{\s*googleSignIn\s*\}"#, in: view), 1)
        XCTAssertEqual(try count("Continue with Google", in: view), try count("Continue with Google", in: google))
        XCTAssertTrue(google.contains("Task { await model.loginWithGoogle() }"))
        // The sign-up line only where Google opens accounts.
        XCTAssertEqual(try count(#"if model\.signInMethods\.googleSignup \{\s*Text\("New to Orbit\? Continue with Google to create an account\."\)"#,
                                 in: google), 1)
    }

    func testThePageAsksItsServerOnArrivalAndOnEveryChangeOfServer() throws {
        let view = try loginView()
        XCTAssertTrue(view.contains(".task(id: model.instanceField) { await model.loadSignInMethods() }"))
        XCTAssertEqual(try count("loadSignInMethods", in: view), 1)
    }

    func testOnlyThePagesServerAnswerIsShown() throws {
        let load = try appModel("func loadSignInMethods() async {")
        XCTAssertTrue(load.contains("APIClient(baseURL: url, tokenStore: tokenStore).signInMethods()"))
        // A server that can't say offers the password alone, as an old one (404) does.
        XCTAssertTrue(load.contains("?? .passwordOnly"))
        XCTAssertTrue(load.contains("if url != signInMethodsServer { signInMethods = .passwordOnly }"))
        XCTAssertTrue(load.contains("guard ServerURL.normalize(instanceField) == url else { return }"))
    }

    func testGoogleSignsInTheWayThePasswordDoes() throws {
        let google = try appModel("func loginWithGoogle() async {")
        for step in ["configure(url)",
                     "_ = try await GoogleSignIn.signIn(api: api!) { try await sheet.authenticate($0) }",
                     "UserDefaults.standard.set(instanceField, forKey: Self.instanceKey)",
                     "user = try? await api!.me()",
                     "signedIn = true",
                     "} catch GoogleSignInError.cancelled {",
                     "errorText = LoginFailure.googleMessage(for: error)"] {
            XCTAssertTrue(google.contains(step), step)
        }
        XCTAssertTrue(google.contains("GoogleWebAuthentication(anchor: anchor)"))
        // One sheet at a time, however fast the button is pressed again.
        XCTAssertTrue(google.contains("guard !busy, !googleBusy else { return }"))
        let guardAt = try XCTUnwrap(google.range(of: "guard !busy, !googleBusy"))
        let busyAt = try XCTUnwrap(google.range(of: "googleBusy = true"))
        XCTAssertLessThan(guardAt.lowerBound, busyAt.lowerBound)
    }

    /// macOS has to be told which window the sheet goes over (§8.2).
    func testTheSheetIsGivenAWindowOnEitherPlatform() throws {
        let anchor = try appModel("private var googleSignInAnchor: ASPresentationAnchor? {")
        let mac = try slice(anchor, from: "#if os(macOS)", to: "#else")
        XCTAssertTrue(mac.contains("NSApp.keyWindow ?? NSApp.mainWindow"))
        XCTAssertTrue(anchor.contains("isKeyWindow"))
        XCTAssertTrue(try appModel("func loginWithGoogle() async {").contains("guard let anchor = googleSignInAnchor else {"))
    }

    /// No sibling `async let` (iOS 27's runtime can abort tearing them down), and no ternary building
    /// an optional labelled tuple (Swift 6.4 on the Mac crashes compiling one), in what this added.
    func testWhatThisAddedAvoidsTheTwoKnownCrashes() throws {
        let added = [try loginView(),
                     try appModel("func loadSignInMethods() async {"),
                     try appModel("func loginWithGoogle() async {"),
                     try appModel("private var googleSignInAnchor: ASPresentationAnchor? {"),
                     try source("src/macos/OrbitKit/Sources/OrbitKit/Auth/GoogleSignIn.swift")]
        for text in added {
            XCTAssertFalse(text.contains("async let"), "sibling async lets abort on iOS 27")
            XCTAssertEqual(try count(#"\?\s*\([^()]*,[^()]*\)\s*:\s*nil"#, in: text), 0, "c ? (a, b) : nil crashes Swift 6.4")
        }
    }
}
