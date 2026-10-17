import Foundation
import XCTest
@testable import OrbitKit

final class TextFilePreviewTests: XCTestCase {
    private func preview(_ text: String, name: String = "notes.txt") -> TextFilePreview? {
        TextFilePreview(data: Data(text.utf8), fileName: name)
    }

    func testMarkdownNamesAndSourceLocations() throws {
        let text = "# Heading\n\n| A | B |\n| --- | --- |\n| one | two |\n"
        for name in ["notes.md", "NOTES.MD", "notes.markdown", "notes.mdown", "notes.mkd",
                     "notes.mkdn", "/tmp/notes.md:12", "/tmp/notes.MARKDOWN:12:3", "notes%20one.md"] {
            let result = try XCTUnwrap(preview(text, name: name), name)
            XCTAssertTrue(result.isMarkdown, name)
            XCTAssertEqual(result.text, text, name)
        }
    }

    func testCommonTextFormatsPreserveOriginalContents() throws {
        for (name, text) in [
            ("data.json", "{\"name\": \"示例\", \"value\": 1}\n"),
            ("config.yaml", "# Config\nname: sample\n"),
            ("config.yml", "name: sample\n"),
            ("data.csv", "name,value\n\"a,b\",1\n"),
            ("data.tsv", "name\tvalue\nexample\t1\n"),
            ("config.toml", "[section]\nname = \"sample\"\n"),
            ("data.xml", "<?xml version=\"1.0\"?><value>1</value>"),
            ("index.html", "<h1>Example</h1>"),
            ("image.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"),
            ("output.log", "first\r\n\r\nlast\r\n"),
            ("main.swift:12:3", "let value = \"**literal**\"\n"),
            ("script.py", "print(\"hello\")\n"),
            ("LICENSE", "Some terms\n"),
        ] {
            let result = try XCTUnwrap(preview(text, name: name), name)
            XCTAssertFalse(result.isMarkdown, name)
            XCTAssertEqual(result.text, text, name)
        }
    }

    func testUnicodeByteOrderMarks() throws {
        let text = "# 标题 😀\n\n第二行\n"
        let encodings: [([UInt8], String.Encoding)] = [
            ([0xEF, 0xBB, 0xBF], .utf8),
            ([0xFF, 0xFE], .utf16LittleEndian),
            ([0xFE, 0xFF], .utf16BigEndian),
        ]
        for (bom, encoding) in encodings {
            let data = Data(bom) + (try XCTUnwrap(text.data(using: encoding)))
            let result = try XCTUnwrap(TextFilePreview(data: data, fileName: "notes.md"))
            XCTAssertEqual(result.text, text)
            XCTAssertTrue(result.isMarkdown)
            XCTAssertEqual(result.lineCount, 3)
        }
    }

    func testBinaryFilesAndInvalidTextDoNotBecomeSourcePreviews() {
        for name in ["file.pdf", "file.PDF:2", "file.doc", "file.docx", "file.xls", "file.xlsx",
                     "file.ppt", "file.pptx", "file.zip", "file.rtf", "file.png", "file.mp4", "file.wav"] {
            XCTAssertNil(preview("ASCII-looking header", name: name), name)
        }
        XCTAssertNil(preview("%PDF-1.7\n1 0 obj\n<<>>\nendobj", name: "download"))
        XCTAssertNil(preview("GIF89a", name: "download"))
        let invalidBytes: [[UInt8]] = [
            [0xFF], [0xC3, 0x28], [0xFF, 0xFE, 0x01], [0xFE, 0xFF, 0x01],
            [0xFF, 0xFE, 0x00, 0xD8], [0xFE, 0xFF, 0xD8, 0x00],
        ]
        for bytes in invalidBytes {
            XCTAssertNil(TextFilePreview(data: Data(bytes), fileName: "notes.txt"))
        }
        for text in ["text\u{0000}data", "text\u{0001}data", "text\u{000E}data", "text\u{007F}data"] {
            XCTAssertNil(preview(text))
        }
    }

    func testEmptyFilesAndLogicalLineCounts() throws {
        for (text, count) in [("", 0), ("line", 1), ("line\n", 1), ("\n", 1), ("\n\n", 2),
                              ("one\n\nthree", 3), ("one\n\nthree\n", 3),
                              ("one\r\n\r\nthree\r\n", 3), ("one\r\rthree\r", 3)] {
            let result = try XCTUnwrap(preview(text))
            XCTAssertEqual(result.lineCount, count, String(reflecting: text))
            XCTAssertEqual(result.text, text)
        }
    }

    func testLongFilesAreNotTruncated() throws {
        let text = "# Long document\n\n" + String(repeating: "A paragraph with 中文.\n\n", count: 2_000)
        let result = try XCTUnwrap(preview(text, name: "long.md"))
        XCTAssertGreaterThan(text.count, 20_000)
        XCTAssertEqual(result.text, text)
        XCTAssertTrue(result.isMarkdown)
        XCTAssertEqual(result.lineCount, 4_002)
    }
}
