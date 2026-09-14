import XCTest
@testable import OrbitKit

final class SessionPreviewImagesTests: XCTestCase {
    private let png = Data([0x89, 0x50, 0x4E, 0x47])
    private let jpeg = Data([0xFF, 0xD8, 0xFF])

    private func user(_ id: String, _ text: String = "", attachments: [TurnAttachment] = []) -> TranscriptItem {
        .user(UserBubble(id: id, text: text, attachments: attachments, pending: false))
    }

    private func assistant(_ id: String, _ text: String) -> TranscriptItem {
        .assistant(AssistantBubble(id: id, text: text, streamingText: "", seq: 1, turnId: nil))
    }

    private func thinking(_ id: String, _ text: String) -> TranscriptItem {
        .thinking(ThinkingBlock(id: id, text: text, streamingText: "", seq: 1))
    }

    private func tool(_ id: String, images: [Data], clipped: Bool = false) -> TranscriptItem {
        .toolCall(ToolCard(id: id, name: "Read", input: .null, result: nil,
                           resultImages: images, resultHasImage: clipped || !images.isEmpty, status: .ok))
    }

    private func keys(_ refs: [PreviewImageRef]) -> [String] { refs.map(\.key) }

    func testPagesFollowTheTranscriptAcrossMessagesToolCallsAndThinking() {
        let items: [TranscriptItem] = [
            user("u1", "see this", attachments: [TurnAttachment(id: "photo", mime: "image/png")]),
            thinking("th1", "compare with ![ref](orbit-attachment:ref)"),
            tool("toolu_1", images: [png, jpeg]),
            .interrupt(id: "int1", seq: 9),
            assistant("a1", "Here:\n\n![mock](orbit-attachment:mock1)\n\nand\n\n![mock](orbit-attachment:mock2)"),
            .error(id: "e1", message: "boom"),
        ]

        let refs = SessionPreviewImages.collect(items)

        XCTAssertEqual(keys(refs), [
            "u1/attachment/photo",
            "th1/markdown/orbit-attachment:ref",
            "toolu_1-img0",
            "toolu_1-img1",
            "a1/markdown/orbit-attachment:mock1",
            "a1/markdown/orbit-attachment:mock2",
        ])
        XCTAssertEqual(refs.map(\.source), [
            .attachment("photo"), .attachment("ref"), .data(png), .data(jpeg),
            .attachment("mock1"), .attachment("mock2"),
        ])
    }

    func testAUserTurnsThumbnailsComeBeforeImagesInItsWordsAndFilesAreSkipped() {
        let items = [user("u1", "![typed](orbit-attachment:typed)", attachments: [
            TurnAttachment(id: "notes", mime: "application/pdf", name: "notes.pdf"),
            TurnAttachment(id: "shot", mime: "image/jpeg"),
        ])]

        XCTAssertEqual(keys(SessionPreviewImages.collect(items)),
                       ["u1/attachment/shot", "u1/markdown/orbit-attachment:typed"])
    }

    func testOnlyAttachmentImagesInMarkdownArePages() {
        // A remote image isn't a tappable thumbnail, and a link to an attachment isn't an image.
        let items = [assistant("a1", "![web](https://example.com/x.png)\n\n[file](orbit-attachment:doc)")]

        XCTAssertEqual(SessionPreviewImages.collect(items), [])
    }

    func testTheSameImageInTwoMessagesIsTwoPagesButRepeatedInOneIsOne() {
        let markdown = "![a](orbit-attachment:same)\n\n![a](orbit-attachment:same)"

        XCTAssertEqual(keys(SessionPreviewImages.collect([assistant("a1", markdown), assistant("a2", markdown)])),
                       ["a1/markdown/orbit-attachment:same", "a2/markdown/orbit-attachment:same"])
    }

    func testAScreenshotAnOpenCardFetchedBackJoinsThePages() {
        // The server clipped the bytes from the preview: the card knows there was an image, and has none.
        let clipped = tool("toolu_9", images: [], clipped: true)
        XCTAssertEqual(SessionPreviewImages.collect([clipped]), [])

        let refs = SessionPreviewImages.collect([clipped]) { card in
            card.id == "toolu_9" ? [self.png] : card.resultImages
        }

        XCTAssertEqual(refs, [PreviewImageRef(key: "toolu_9-img0", source: .data(png))])
    }

    func testAReplyStillStreamingContributesTheImagesThatHaveArrived() {
        let streaming = TranscriptItem.assistant(AssistantBubble(
            id: "a1", text: "", streamingText: "![m](orbit-attachment:m1)\n\nstill wri", seq: nil, turnId: nil))

        XCTAssertEqual(keys(SessionPreviewImages.collect([streaming])), ["a1/markdown/orbit-attachment:m1"])
    }

    func testAttachmentIDFromAnImageSource() {
        XCTAssertEqual(AttachmentLink.attachmentID(source: "orbit-attachment:abc"), "abc")
        XCTAssertEqual(AttachmentLink.attachmentID(source: "orbit-attachment: abc def"), "abc")
        XCTAssertNil(AttachmentLink.attachmentID(source: "orbit-attachment:"))
        XCTAssertNil(AttachmentLink.attachmentID(source: "https://example.com/orbit-attachment:abc"))
    }
}
