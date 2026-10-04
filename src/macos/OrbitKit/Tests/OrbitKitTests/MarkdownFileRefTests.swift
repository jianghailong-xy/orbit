import XCTest
@testable import OrbitKit

final class MarkdownFileRefTests: XCTestCase {
    func testUploadedScreenshotKeepsItsFilenameAndDescriptiveLabel() throws {
        let source = #"已验证。[查看实际页面截图](orbit-attachment:shot123 "runner-mobile.png") 完成。"#
        let match = try XCTUnwrap(MarkdownFileRef.matches(in: source).first)
        XCTAssertEqual(String(source[match.range]), #"[查看实际页面截图](orbit-attachment:shot123 "runner-mobile.png")"#)
        XCTAssertEqual(match.ref.href, "orbit-attachment:shot123")
        XCTAssertEqual(match.ref.label, "查看实际页面截图")
        XCTAssertEqual(match.ref.fileName, "runner-mobile.png")
        XCTAssertTrue(match.ref.isImage)
    }

    func testFilenameSurvivesTheMarkdownParserBeforeRendering() throws {
        let source = "[查看实际页面截图](orbit-attachment:shot123 '手机截图.PNG')"
        guard case .paragraph(let text) = parseMarkdownBlocks(source).first else {
            return XCTFail("The file link should remain a paragraph for card placement")
        }
        let ref = try XCTUnwrap(MarkdownFileRef.matches(in: text).first?.ref)
        XCTAssertEqual(ref.fileName, "手机截图.PNG")
        XCTAssertTrue(ref.isImage)
    }

    func testDocumentsAreNotClassifiedFromAnImageLabelWhenTheyHaveAFilename() throws {
        let source = #"[preview.png](orbit-attachment:doc123 "report.pdf") [notes](orbit-attachment:notes123 "notes.md")"#
        let refs = MarkdownFileRef.matches(in: source).map(\.ref)
        XCTAssertEqual(refs.map(\.fileName), ["report.pdf", "notes.md"])
        XCTAssertTrue(refs.allSatisfy { !$0.isImage })
    }

    func testLegacyLinksStillUseTheirPathOrLabel() {
        let refs = MarkdownFileRef.matches(in: "[查看截图](/tmp/card.png) [photo.jpg](orbit-attachment:old123) [查看附件](orbit-attachment:unknown123)").map(\.ref)
        XCTAssertEqual(refs.map(\.fileName), ["card.png", "photo.jpg", "查看附件"])
        XCTAssertEqual(refs.map(\.isImage), [true, true, false])
    }

    func testOtherLinksAndMarkdownImagesStayWithTheirExistingRenderer() {
        let source = "[site](https://example.com/card.png) ![image](orbit-attachment:shot123) [task](orbit-task:task123)"
        XCTAssertTrue(MarkdownFileRef.matches(in: source).isEmpty)
    }

    func testOnlyImagesAndUntypedAttachmentsAreLoadedBeforeATap() {
        let source = #"[截图](orbit-attachment:shot123 "screen.png") [附件](orbit-attachment:old123) [文档](orbit-attachment:doc123 "notes.pdf") [report.pdf](orbit-attachment:oldpdf123)"#
        XCTAssertEqual(MarkdownFileRef.matches(in: source).map(\.ref.shouldLoadImage), [true, true, false, false])
    }

    func testFilenamesWithSpacesAndQuotesSurviveParsing() throws {
        let source = #"[Screenshot](orbit-attachment:shot123 "before \"pause\".png")"#
        guard case .paragraph(let text) = parseMarkdownBlocks(source).first else {
            return XCTFail("Missing file paragraph")
        }
        let ref = try XCTUnwrap(MarkdownFileRef.matches(in: text).first?.ref)
        XCTAssertEqual(ref.fileName, #"before "pause".png"#)
        XCTAssertTrue(ref.isImage)
    }

    func testFileTitlesSurviveBesideProseAndMarkdownImages() {
        let source = #"Before [Screenshot](orbit-attachment:shot123 "screen.png") after ![other](orbit-attachment:other123) end"#
        XCTAssertEqual(parseMarkdownBlocks(source), [
            .paragraph(text: #"Before [Screenshot](orbit-attachment:shot123 "screen.png") after"#),
            .image(source: "orbit-attachment:other123", alt: "other"),
            .paragraph(text: "end"),
        ])
    }
}
