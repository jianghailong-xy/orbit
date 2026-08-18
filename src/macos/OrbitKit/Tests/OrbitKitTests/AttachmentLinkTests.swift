import XCTest
@testable import OrbitKit

final class AttachmentLinkTests: XCTestCase {

    func testAttachmentIDFromScheme() {
        XCTAssertEqual(AttachmentLink.attachmentID(URL(string: "orbit-attachment:abc123")!), "abc123")
        // Title syntax puts the file name outside the URL, but a hand-written link may inline it.
        XCTAssertEqual(AttachmentLink.attachmentID(URL(string: "orbit-attachment:abc123%20name")!), "abc123%20name")
        XCTAssertNil(AttachmentLink.attachmentID(URL(string: "https://example.com/a.png")!))
        XCTAssertNil(URL(string: "orbit-attachment:").flatMap(AttachmentLink.attachmentID))
    }

    func testRunnerLocalPathsAreUnreachable() {
        // The shape that started this: a Codex reply linking its own generated PNG.
        XCTAssertTrue(AttachmentLink.isRunnerLocalPath(
            URL(string: "/root/.codex/generated_images/t/exec-1.png")!))
        XCTAssertTrue(AttachmentLink.isRunnerLocalPath(URL(string: "/home/agent/out.svg")!))
        XCTAssertTrue(AttachmentLink.isRunnerLocalPath(URL(fileURLWithPath: "/tmp/x.pdf")))
        XCTAssertTrue(AttachmentLink.isRunnerLocalPath(URL(string: "/Users/me/Desktop/a%20b.png")!))
    }

    func testReachableLinksAreNotChipped() {
        XCTAssertFalse(AttachmentLink.isRunnerLocalPath(URL(string: "https://example.com/a.png")!))
        XCTAssertFalse(AttachmentLink.isRunnerLocalPath(URL(string: "orbit-attachment:abc123")!))
        XCTAssertFalse(AttachmentLink.isRunnerLocalPath(URL(string: "mailto:a@b.c")!))
        XCTAssertFalse(AttachmentLink.isRunnerLocalPath(URL(string: "/tasks/abc")!))   // site-relative
        XCTAssertFalse(AttachmentLink.isRunnerLocalPath(URL(string: "/tmp/x.png?v=1")!))
    }

    func testSuggestedFileNameSniffsExtension() {
        let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
        XCTAssertEqual(AttachmentLink.suggestedFileName(id: "abc123", data: png), "orbit-abc123.png")
        XCTAssertEqual(AttachmentLink.fileExtension(sniffing: Data([0xFF, 0xD8, 0xFF, 0xE0])), "jpg")
        XCTAssertEqual(AttachmentLink.fileExtension(sniffing: Data("%PDF-1.7".utf8)), "pdf")
        XCTAssertEqual(AttachmentLink.fileExtension(sniffing: Data("RIFF____WEBPVP8 ".utf8)), "webp")
        XCTAssertNil(AttachmentLink.fileExtension(sniffing: Data("<svg></svg>".utf8)))
        // Unknown bytes still produce a usable name, and a slash can never escape the temp dir.
        XCTAssertEqual(AttachmentLink.suggestedFileName(id: "../../etc/passwd", data: Data()), "orbit-etcpasswd")
    }
}
