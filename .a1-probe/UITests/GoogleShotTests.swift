import XCTest
#if os(macOS)
import AppKit
#endif

// TEMPORARY evidence probe (see ../README.md). The login page on the iPhone and the Mac against each
// kind of server, then Continue with Google pressed for real: the system's sign-in sheet opens the
// stub's /start, comes back on orbit://auth/google, and the app trades the ticket for a session.
final class GoogleShotTests: ProbeCase {
    private static let button = "Continue with Google"
    private static let signup = "New to Orbit? Continue with Google to create an account."

    private func continueWithGoogle(_ app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", Self.button)).firstMatch
    }

    /// The page asked its server how it signs people in — so whatever it shows is that server's answer.
    private func expectAsked(_ port: Int) {
        if !waitUntil(15, { self.seen(port).contains("GET /api/auth/methods") }) {
            XCTFail("the login page never asked :\(port) for /api/auth/methods; it saw \(seen(port))")
        }
    }

    /// The page as it stands once its server has answered: the button, and the sign-up line, or not.
    private func page(port: Int, google: Bool, signup: Bool, dark: Bool = false, _ name: String) {
        let app = launch(port: port, until: google ? Self.button : "Welcome back", dark: dark, name)
        expectAsked(port)
        settle(2)   // an answer that would add the button has had its time
        XCTAssertEqual(continueWithGoogle(app).exists, google, "\(name): Continue with Google")
        XCTAssertEqual(element(app, containing: Self.signup).exists, signup, "\(name): the sign-up line")
        XCTAssertTrue(element(app, containing: "Sign In").exists, "\(name): the password form")
        shot(app, "\(platform)-\(name)")
        write(app.debugDescription, "\(platform)-tree-\(name).txt")
    }

    func test1GoogleOnAndOpeningAccounts() {
        page(port: 8765, google: true, signup: true, "1-google-on-signup-open")
    }

    func test2GoogleOnForExistingAccounts() {
        page(port: 8766, google: true, signup: false, "2-google-on-existing-accounts")
    }

    func test3GoogleOff() {
        page(port: 8767, google: false, signup: false, "3-google-off")
    }

    func test4ServerFromBeforeGoogleSignIn() {
        page(port: 8768, google: false, signup: false, "4-old-server-404")
    }

    func test5GoogleOnDark() {
        page(port: 8765, google: true, signup: true, dark: true, "5-google-on-signup-open-dark")
    }

    // MARK: pressing it

    /// Pressing Continue with Google; the system asks first ("… Wants to Use “127.0.0.1” to Sign In")
    /// because the sheet shares the browser's cookies. Answers whether the words came up meanwhile.
    private func signIn(_ app: XCUIApplication, until words: String, _ name: String) -> Bool {
        let button = continueWithGoogle(app)
        guard button.exists else {
            XCTFail("\(name): no Continue with Google to press")
            return false
        }
        press(button)
        var looked = 0
        let reached = waitUntil(90) {
            if self.element(app, containing: words).exists { return true }
            if self.acceptSignInPrompt(app) { self.settle(1) }
            looked += 1
            if [2, 4, 6, 8, 12, 16, 24].contains(looked) || looked % 30 == 0 {
                self.screen("\(self.platform)-\(name)-meanwhile-\(looked)")
            }
            return false
        }
        app.activate()
        return reached
    }

    /// The prompt's Continue, pressed wherever it shows; true when one was.
    private func acceptSignInPrompt(_ app: XCUIApplication) -> Bool {
        #if os(iOS)
        for (bundle, host) in [("springboard", XCUIApplication(bundleIdentifier: "com.apple.springboard")), ("app", app)] {
            let prompt = host.buttons["Continue"]
            if prompt.exists, prompt.isHittable {
                screen("\(platform)-sign-in-prompt")
                note("pressed Continue on the sign-in prompt in \(bundle)")
                press(prompt)
                return true
            }
        }
        return false
        #else
        return clickPromptContinue(app)
        #endif
    }

    #if os(macOS)
    /// On the Mac the prompt is drawn by AuthenticationServicesAgent, which XCUITest can't attach to
    /// (run 37540423283: "The app representing …AuthenticationServicesAgent could not be found").
    /// Its default button, Continue, is the only wide run of system blue (0, 122, 255) on the screen
    /// while it is up — measured on that run's capture at (571, 322) — so find it there and click it.
    private func clickPromptContinue(_ app: XCUIApplication) -> Bool {
        let shot = XCUIScreen.main.screenshot()
        guard let image = shot.image.cgImage(forProposedRect: nil, context: nil, hints: nil),
              let space = CGColorSpace(name: CGColorSpace.sRGB), shot.image.size.width > 0 else { return false }
        let width = image.width, height = image.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8,
                                          bytesPerRow: width * 4, space: space,
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else { return false }
        let scale = Double(width) / Double(shot.image.size.width)
        var sumX = 0.0, sumY = 0.0, rows = 0
        for y in Int(Double(height) * 0.08)..<Int(Double(height) * 0.80) {
            var run = 0
            for x in 0...width {
                var blue = false
                if x < width {
                    let i = (y * width + x) * 4
                    blue = pixels[i + 2] > 220 && pixels[i] < 45 && pixels[i + 1] > 90 && pixels[i + 1] < 170
                }
                if blue {
                    run += 1
                } else {
                    if Double(run) >= 60 * scale {
                        sumX += Double(x) - Double(run) / 2
                        sumY += Double(y)
                        rows += 1
                    }
                    run = 0
                }
            }
        }
        guard Double(rows) >= 8 * scale else { return false }
        let target = CGPoint(x: sumX / Double(rows) / scale, y: sumY / Double(rows) / scale)
        screen("\(platform)-sign-in-prompt")
        let window = app.windows.firstMatch
        let origin = window.frame.origin
        note("clicking the prompt's Continue at \(target) (window at \(origin), \(rows) rows of blue, scale \(scale))")
        window.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: target.x - origin.x, dy: target.y - origin.y)).click()
        settle(2)
        return true
    }
    #endif

    func test6ContinueWithGoogleSignsIn() {
        let app = launch(port: 8765, until: Self.button, "6-sign-in")
        guard signIn(app, until: "Signed in", "6-sign-in") else {
            write(app.debugDescription, "\(platform)-missing-signed-in.txt")
            screen("\(platform)-6-never-signed-in")
            return XCTFail("Continue with Google never signed in; the stub saw \(seen(8765)); the page says "
                           + "\(app.staticTexts.allElementsBoundByIndex.map(\.label))")
        }
        settle(1)
        shot(app, "\(platform)-6-signed-in-with-google")
        XCTAssertTrue(element(app, containing: "ada@example.com").exists, "the account was not read after the sign-in")
        XCTAssertTrue(element(app, containing: "Session kept in the Keychain").exists, "the session is not in the Keychain")
        let saw = seen(8765)
        note("stub saw: \(saw)")
        XCTAssertTrue(saw.contains("START client=native challenge=S256 state=present -> ok"), "\(saw)")
        XCTAssertTrue(saw.contains("EXCHANGE ticket=known pkce=ok"), "\(saw)")
    }

    func test7ARefusedGoogleSignInSaysWhy() {
        let app = launch(port: 8769, until: Self.button, "7-refused")
        let words = "No Orbit account uses this Google account yet"
        guard signIn(app, until: words, "7-refused") else {
            write(app.debugDescription, "\(platform)-missing-refusal.txt")
            return XCTFail("the refusal never showed; the stub saw \(seen(8769))")
        }
        settle(1)
        shot(app, "\(platform)-7-google-refused")
        XCTAssertFalse(element(app, containing: "Signed in").exists)
        XCTAssertFalse(element(app, containing: "Incorrect email or password").exists)
        let saw = seen(8769)
        note("stub saw: \(saw)")
        XCTAssertTrue(saw.contains("EXCHANGE ticket=known pkce=ok"), "\(saw)")
    }
}
