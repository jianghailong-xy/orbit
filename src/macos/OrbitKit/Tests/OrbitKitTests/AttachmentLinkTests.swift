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

    /// The one kind of runner-local path that is not hopeless: a file in the session's own
    /// directories, which the artifact route can fetch (the runner reads it). Everything else — the
    /// generated-images dir, /tmp, another session's checkout — stays a chip, because the API would
    /// only answer 404 and a button that always fails is worse than a label.
    func testOnlyTheSessionsOwnFilesAreFetchableByPath() {
        let session = "01a0c8ed-3b0b-742c-a7ee-93f0de502852"
        let publicID = PublicID.toPublic(session)

        // The pair that shipped broken: the client holds a public id (that is what the list and the
        // API hand it) while the path in the reply carries the UUID the agent wrote. Comparing
        // spellings instead of ids answered "no" to every such path, and the client never fetched.
        // The real case, from session 01a0c992: its public id and one of its own mocks.
        XCTAssertEqual(
            AttachmentLink.runnerArtifactPath(
                URL(string: "/root/.orbit/uploads/01a0c992-61c0-727a-bbbb-d985dd45d0e0/x.png")!,
                sessionID: "34THmsocmJ9D6ZiNAJTeK"),
            "/root/.orbit/uploads/01a0c992-61c0-727a-bbbb-d985dd45d0e0/x.png")
        // And the mirror: a public id in the path, a UUID in hand.
        XCTAssertEqual(
            AttachmentLink.runnerArtifactPath(
                URL(string: "/root/.orbit/worktrees/\(publicID)/docs/mocks/card.png")!, sessionID: session),
            "/root/.orbit/worktrees/\(publicID)/docs/mocks/card.png")

        XCTAssertEqual(
            AttachmentLink.runnerArtifactPath(
                URL(string: "/root/.orbit/worktrees/\(session)/docs/mocks/card.png")!, sessionID: session),
            "/root/.orbit/worktrees/\(session)/docs/mocks/card.png")
        XCTAssertEqual(
            AttachmentLink.runnerArtifactPath(
                URL(string: "/root/.orbit/uploads/\(session)/drill/out.json")!, sessionID: session),
            "/root/.orbit/uploads/\(session)/drill/out.json")
        // A checkout is named after whichever spelling the claim carried.
        XCTAssertEqual(
            AttachmentLink.runnerArtifactPath(
                URL(string: "/root/.orbit/worktrees/\(publicID)/docs/mocks/card.png")!, sessionID: session),
            "/root/.orbit/worktrees/\(publicID)/docs/mocks/card.png")

        for path in [
            "/root/.codex/generated_images/t/exec-1.png",              // the runner's, not the session's
            "/tmp/mock.png",
            "/root/.orbit/worktrees/\(session)",                        // the directory itself
            "/root/.orbit/worktrees/\(session)-other/card.png",         // a name that only looks like it
            "/root/.orbit/worktrees/01a0c8ec-f319-7345-9e22-2004b7535e93/card.png",   // another session's
            "https://example.com/card.png",
        ] {
            XCTAssertNil(AttachmentLink.runnerArtifactPath(URL(string: path)!, sessionID: session), path)
        }
    }

    func testRunnerArtifactPathFromASourceString() {
        let session = "01a0c8ed-3b0b-742c-a7ee-93f0de502852"
        XCTAssertEqual(
            AttachmentLink.runnerArtifactPath(source: "/root/.orbit/worktrees/\(session)/card.png", sessionID: session),
            "/root/.orbit/worktrees/\(session)/card.png")
        XCTAssertNil(AttachmentLink.runnerArtifactPath(source: "not a url", sessionID: session))
        XCTAssertNil(AttachmentLink.runnerArtifactPath(source: "", sessionID: session))
        XCTAssertNil(AttachmentLink.runnerArtifactPath(source: "/etc/passwd", sessionID: session))
    }

    /// Which files are worth fetching before anybody asks: a mock the agent drew is a picture, a
    /// document it wrote is not.
    func testLooksLikeImageReadsTheExtension() {
        for path in [
            "/root/.orbit/uploads/01a0c992-61c0-727a-bbbb-d985dd45d0e0/claude-title-slot-1-diagnosis-and-A.png",
            "/root/.orbit/worktrees/s/docs/mocks/card.JPEG",
            "/tmp/shot.heic",
            "/tmp/anim.webp",
        ] {
            XCTAssertTrue(AttachmentLink.looksLikeImage(path: path), path)
        }
        for path in [
            "/root/.orbit/uploads/s/report.pdf",
            "/root/.orbit/uploads/s/notes.md",
            "/root/.orbit/uploads/s/vector.svg",   // web draws it; neither native client decodes it
            "/root/.orbit/uploads/s/no-extension",
            "",
        ] {
            XCTAssertFalse(AttachmentLink.looksLikeImage(path: path), path)
        }
    }

    func testFileNameFromPath() {
        XCTAssertEqual(AttachmentLink.fileName(inPath: "/root/.orbit/worktrees/s/docs/mocks/card.png"), "card.png")
        XCTAssertEqual(AttachmentLink.fileName(inPath: "/root/.orbit/uploads/s/a%20b.pdf"), "a b.pdf")
        XCTAssertEqual(AttachmentLink.fileName(inPath: "/"), "file")
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
