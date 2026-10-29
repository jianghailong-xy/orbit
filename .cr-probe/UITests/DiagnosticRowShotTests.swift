import XCTest

// TEMPORARY evidence probe (see ../../README.md). Drives the real shared sources against stub.py and
// photographs a recoverable diagnostic on this client, light and dark: Codex's model-catalog refresh that
// timed out ten times in one conversation (D1) is one grey row with its count, beside the runner's notice
// in the warning tone and an unrelated ERROR line in red. Every state a picture is meant to show is
// asserted, so a run that never reached it fails rather than leaving a picture of something else.
final class DiagnosticRowShotTests: ProbeCase {

    #if os(iOS)
    private let platform = "ios"
    #else
    private let platform = "mac"
    #endif

    /// Words that must be on screen for the picture about to be taken.
    private func expect(_ app: XCUIApplication, _ words: String, _ name: String, timeout: TimeInterval = 15) {
        if appears(app, words, timeout: timeout) {
            note("\(name): shows \(words.debugDescription)")
        } else {
            write(app.debugDescription, "missing-\(name).txt")
            XCTFail("\(name): \(words.debugDescription) never showed")
        }
    }

    /// The picture: the screen on the phone, the whole screen on the Mac, named by platform, scene and
    /// appearance.
    private func picture(_ app: XCUIApplication, _ scene: String, dark: Bool) {
        let name = "\(platform)-\(scene)-\(dark ? "dark" : "light")"
        #if os(iOS)
        shot(app, name)
        #else
        screen(name)
        #endif
    }

    func testTheRefreshIsOneGreyRowBesideTheNoticeAndTheError() throws {
        for dark in [false, true] {
            let scene = "diagnostic-row-\(dark ? "dark" : "light")"
            let words = "failed to refresh available models: request timed out"
            let app = launch(.session("D1"), until: words, dark: dark, scene)
            // One row for the ten reports: its label, the engine's words and the count.
            expect(app, "model_catalog · timeout", scene)
            expect(app, "×10", scene)
            // Beside it, the runner's notice and the unrelated ERROR line, each as it always was.
            expect(app, "Switched to Wikova · Pro", scene)
            expect(app, "stream error: request timed out", scene)
            note("\(scene): the logged preamble on screen: \(element(app, containing: "codex_models_manager").exists)")
            // The rows sit together at the conversation's foot, which it opens on: keep them in the picture.
            bring(app, element(app, containing: words), between: 100, and: 760, scene)
            picture(app, "diagnostic-row", dark: dark)
            write(app.debugDescription, "tree-\(platform)-\(scene).txt")
            app.terminate()
        }
    }
}
