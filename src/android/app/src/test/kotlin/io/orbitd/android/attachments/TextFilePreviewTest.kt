package io.orbitd.android.attachments

import org.junit.Assert.*
import org.junit.Test

/** OrbitKit TextFilePreviewTests (iOS b8d661967): which bytes the in-app reader shows as text, and how it counts their lines. */
class TextFilePreviewTest {
    @Test fun textIsDecodedAndMarkdownIsKnownByItsExtension() {
        assertEquals(TextFilePreview("# Title\n", true), TextFilePreview.of("# Title\n".encodeToByteArray(), "notes.md"))
        assertEquals(true, TextFilePreview.of("x".encodeToByteArray(), "dir/README.MARKDOWN")?.isMarkdown)
        assertEquals(false, TextFilePreview.of("x".encodeToByteArray(), "build.log")?.isMarkdown)
        assertEquals("中文", TextFilePreview.of(byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte()) + "中文".encodeToByteArray(), "a.txt")?.text)
        assertEquals("hi", TextFilePreview.of(byteArrayOf(0xFF.toByte(), 0xFE.toByte(), 'h'.code.toByte(), 0, 'i'.code.toByte(), 0), "a.txt")?.text)
        assertEquals("hi", TextFilePreview.of(byteArrayOf(0xFE.toByte(), 0xFF.toByte(), 0, 'h'.code.toByte(), 0, 'i'.code.toByte()), "a.txt")?.text)
        assertEquals("an empty file is a valid, empty text", TextFilePreview("", false), TextFilePreview.of(ByteArray(0), "empty.txt"))
    }

    @Test fun whatIsNotTextIsNotPreviewed() {
        assertNull("a binary format by name", TextFilePreview.of("PK plain".encodeToByteArray(), "archive.zip"))
        assertNull("an image by its bytes", TextFilePreview.of(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A), "shot.txt"))
        assertNull("a PDF by its bytes", TextFilePreview.of("%PDF-1.7".encodeToByteArray(), "paper"))
        assertNull("bytes that are not UTF-8", TextFilePreview.of(byteArrayOf(0xC3.toByte(), 0x28), "a.txt"))
        assertNull("control characters text never has", TextFilePreview.of(byteArrayOf('a'.code.toByte(), 0x00, 'b'.code.toByte()), "a.txt"))
        assertNull("UTF-16 cut in half", TextFilePreview.of(byteArrayOf(0xFF.toByte(), 0xFE.toByte(), 'h'.code.toByte()), "a.txt"))
        assertNotNull("tabs and newlines are text", TextFilePreview.of("a\tb\r\nc\u000Cd".encodeToByteArray(), "a.txt"))
    }

    @Test fun linesAreCountedAsAReaderCountsThem() {
        fun lines(text: String) = TextFilePreview(text, false).lineCount
        assertEquals(0, lines(""))
        assertEquals(1, lines("one"))
        assertEquals(1, lines("one\n"))
        assertEquals(2, lines("one\ntwo"))
        assertEquals(2, lines("one\r\ntwo\r\n"))
        assertEquals(3, lines("a\n\nb"))
    }
}
