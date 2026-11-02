import Foundation
import XCTest
@testable import OrbitKit

/// Which links may leave the app, and the doors that ask before one does. The rule is proved here; the
/// doors are SwiftUI and UIKit, which do not compile on Linux, so they are read over the source, the way
/// `RunnerArtifactWiringTests` does.
final class ExternalLinkTests: XCTestCase {

    private func url(_ text: String) throws -> URL {
        try XCTUnwrap(URL(string: text), text)
    }

    func testAnHTTPSLinkLeavesTheApp() throws {
        let link = try url("https://example.com/a?b=c#d")
        XCTAssertTrue(ExternalLink.mayLeaveTheApp(link))
        XCTAssertFalse(ExternalLink.isDead(link))
    }

    func testTheWebAndMailLeaveHoweverTheSchemeIsSpelled() throws {
        for text in ["http://example.com", "mailto:someone@example.com", "HTTPS://EXAMPLE.COM", "Http://example.com"] {
            let link = try url(text)
            XCTAssertTrue(ExternalLink.mayLeaveTheApp(link), text)
            XCTAssertFalse(ExternalLink.isDead(link), text)
        }
    }

    func testAFileLinkStaysInTheApp() throws {
        for text in ["file:///Applications/Example.app", "FILE:///usr/local/bin/example", "file:/opt/example", "File:///Volumes/x/y.txt"] {
            let link = try url(text)
            XCTAssertFalse(ExternalLink.mayLeaveTheApp(link), text)
            XCTAssertTrue(ExternalLink.isDead(link), text)
        }
    }

    func testACustomSchemeStaysInTheApp() throws {
        for text in ["example-app://open?x=1", "ssh://host", "tel:+15550100", "ftp://example.com/a",
                     "data:text/plain,hello", "javascript:void(0)", "orbitx://session/abc"] {
            let link = try url(text)
            XCTAssertFalse(ExternalLink.mayLeaveTheApp(link), text)
            XCTAssertTrue(ExternalLink.isDead(link), text)
        }
    }

    /// Nothing to go on is not a yes: a relative link has no scheme, and the system could do nothing with it.
    func testALinkWithNoSchemeStaysInTheApp() throws {
        for text in ["docs/readme", "/absolute/path", "#section", "//example.com/a"] {
            let link = try url(text)
            XCTAssertNil(link.scheme, text)
            XCTAssertFalse(ExternalLink.mayLeaveTheApp(link), text)
            XCTAssertTrue(ExternalLink.isDead(link), text)
        }
    }

    /// `orbit://` is the app's own scheme, which the system hands straight back to `onOpenURL`: a link
    /// to one record of a session gets there this way, and must keep working.
    func testTheAppsOwnSchemeComesBack() throws {
        let link = SessionRecordLink.url(session: "s", record: "r")
        XCTAssertEqual(link.scheme, DeepLink.scheme)
        XCTAssertTrue(ExternalLink.mayLeaveTheApp(link))
        XCTAssertFalse(ExternalLink.isDead(link))
    }

    /// The app's own links never leave, and they are not dead either: drawing one as prose would take
    /// away a reference to a task, or a wiki footnote's number.
    func testTheAppsOwnLinksStayLinksWithoutLeaving() throws {
        for text in ["orbit-task:abc", "orbit-session:abc", "orbit-project:abc", "orbit-list:abc", "orbit-wiki:abc",
                     "orbit-attachment:abc", "orbit-footnote://note?n=1", "orbit-mark://x", "orbit-cursor:start-elsewhere",
                     "orbit-wiki-status://run", "ORBIT-TASK:abc"] {
            let link = try url(text)
            XCTAssertFalse(ExternalLink.mayLeaveTheApp(link), text)
            XCTAssertFalse(ExternalLink.isDead(link), text)
        }
    }

    // MARK: the doors

    private func root() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent("src/ios/Sources").path) { return dir }
            dir = dir.deletingLastPathComponent()
        }
        throw NSError(domain: "ExternalLinkTests", code: 1)
    }

    private func source(_ relative: String) throws -> String {
        try String(contentsOf: root().appendingPathComponent(relative), encoding: .utf8)
    }

    private static let shells = ["src/macos/OrbitApp/Sources/OrbitApp/OrbitApp.swift", "src/ios/Sources/OrbitiOSApp.swift"]
    private static let closerToAView = [
        "src/macos/OrbitApp/Sources/OrbitApp/Views/WikiArticleView.swift",
        "src/macos/OrbitApp/Sources/OrbitApp/Views/WikiDocView.swift",
        "src/macos/OrbitApp/Sources/OrbitApp/Views/WikiActivityView.swift",
        "src/macos/OrbitApp/Sources/OrbitApp/Views/Console/AutoRetryCard.swift",
    ]

    /// The system's own action is named in one place, behind the rule. A new `OpenURLAction` that
    /// answers with it directly is a way round the list, whichever view it is set on.
    func testNoLinkReachesTheSystemWithoutAsking() throws {
        var sites: [String: Int] = [:]
        for tree in ["src/macos/OrbitApp/Sources", "src/ios/Sources"] {
            let start = try root().appendingPathComponent(tree)
            let walker = try XCTUnwrap(FileManager.default.enumerator(at: start, includingPropertiesForKeys: nil))
            for case let file as URL in walker where file.pathExtension == "swift" {
                let count = try String(contentsOf: file, encoding: .utf8).components(separatedBy: ".systemAction").count - 1
                if count > 0 { sites[file.lastPathComponent] = count }
            }
        }
        XCTAssertEqual(sites, ["OrbitLinkCards.swift": 1])
        let cards = try source("src/macos/OrbitApp/Sources/OrbitApp/OrbitLinkCards.swift")
        XCTAssertTrue(cards.contains("ExternalLink.mayLeaveTheApp(url) ? .systemAction : .discarded"))
    }

    func testBothShellsAskAfterTheAppsOwnLinks() throws {
        for path in Self.shells {
            XCTAssertTrue(try source(path).contains("model.openOrbitLink(url) ? .handled : .leaving(url)"), path)
        }
    }

    /// One of these replaces the shell's action rather than falling through to it.
    func testAnActionSetCloserToAViewAsksToo() throws {
        for path in Self.closerToAView {
            XCTAssertTrue(try source(path).contains(".leaving(url)"), path)
        }
    }

    func testALinkThatMayNotLeaveReadsAsProse() throws {
        let markdown = try source("src/macos/OrbitApp/Sources/OrbitApp/Views/MarkdownView.swift")
        XCTAssertTrue(markdown.contains("ReferenceLink.isInert($0) || ExternalLink.isDead($0)"))
        let text = try source("src/macos/OrbitApp/Sources/OrbitApp/Views/Console/SelectableText.swift")
        XCTAssertTrue(text.contains("else if ReferenceLink.isInert(link) || ExternalLink.isDead(link) {"))
    }

    /// The phone's transcript is a text view with its own handler, not a `Text`: a tap ends here.
    func testAPhoneTranscriptAsksBeforeItsDefaultAction() throws {
        let text = try source("src/macos/OrbitApp/Sources/OrbitApp/Views/Console/SelectableText.swift")
        XCTAssertTrue(text.contains("return ExternalLink.mayLeaveTheApp(url) ? defaultAction : nil"))
    }
}
