package io.orbitd.android.attachments

import java.nio.ByteBuffer
import java.nio.charset.Charset
import java.nio.charset.CodingErrorAction

/**
 * OrbitKit `TextFilePreview` (iOS b8d661967): a file's bytes as the text the in-app reader shows — when they are text. A format
 * known not to be (an office document, an archive, an image or media file) and bytes that sniff as an image or a PDF are not, nor
 * is anything that fails to decode or carries control characters text never has. An empty file is a valid, empty text.
 */
internal data class TextFilePreview(val text: String, val isMarkdown: Boolean) {
    /** Lines as the reader counts them: a newline ends one, and a last line without one still counts. */
    val lineCount: Int get() = if (text.isEmpty()) 0 else newline.findAll(text).count() + if (newline.matches(text.takeLast(1))) 0 else 1

    companion object {
        private val newline = Regex("\r\n|[\n\r\u000B\u000C\u0085  ]")
        private val markdown = setOf("md", "markdown", "mdown", "mkd", "mkdn")
        // Some binary containers have an ASCII header, so decoding alone is not enough.
        private val nonText = setOf("pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "pages", "numbers", "key",
            "odt", "ods", "odp", "rtf", "rtfd", "epub",
            "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar", "dmg", "iso",
            "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "tif", "tiff", "ico", "avif",
            "mp3", "m4a", "aac", "wav", "aiff", "flac", "ogg", "mp4", "m4v", "mov", "avi", "mkv", "webm",
            "woff", "woff2", "ttf", "otf", "exe", "dll", "so", "dylib", "sqlite", "db")

        fun of(bytes: ByteArray, fileName: String): TextFilePreview? {
            val name = fileName.substringAfterLast('/').ifEmpty { "file" }
            val ext = name.substringAfterLast('.', "").lowercase()
            if (ext in nonText || sniffed(bytes)) return null
            fun starts(vararg prefix: Int) = bytes.size >= prefix.size && prefix.indices.all { bytes[it] == prefix[it].toByte() }
            val text = when {
                starts(0xEF, 0xBB, 0xBF) -> decode(bytes, 3, Charsets.UTF_8)
                starts(0xFF, 0xFE) -> if (bytes.size % 2 != 0) null else decode(bytes, 2, Charsets.UTF_16LE)
                starts(0xFE, 0xFF) -> if (bytes.size % 2 != 0) null else decode(bytes, 2, Charsets.UTF_16BE)
                else -> decode(bytes, 0, Charsets.UTF_8)
            } ?: return null
            if (text.codePoints().anyMatch { it in 0x00..0x08 || it in 0x0E..0x1F || it in 0x7F..0x84 || it in 0x86..0x9F }) return null
            return TextFilePreview(text, ext in markdown)
        }

        /** AttachmentLink.fileExtension(sniffing:): an image or a PDF whatever the name says. */
        private fun sniffed(b: ByteArray): Boolean {
            if (b.size < 4) return false
            fun at(offset: Int, vararg prefix: Int) = b.size >= offset + prefix.size && prefix.indices.all { b[offset + it] == prefix[it].toByte() }
            return at(0, 0x89, 0x50, 0x4E, 0x47) || at(0, 0xFF, 0xD8, 0xFF) || at(0, 0x47, 0x49, 0x46, 0x38) || at(0, 0x25, 0x50, 0x44, 0x46) ||
                (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50))
        }

        /** Strict: bytes that are not valid in [charset] are not text. */
        private fun decode(bytes: ByteArray, skip: Int, charset: Charset): String? = runCatching {
            charset.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes, skip, bytes.size - skip)).toString()
        }.getOrNull()
    }
}
