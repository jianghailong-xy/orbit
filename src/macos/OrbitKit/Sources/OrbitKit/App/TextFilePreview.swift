import Foundation

/// Decoded file contents shared by the native attachment and source-file viewers.
public struct TextFilePreview: Equatable, Sendable {
    public let text: String
    public let isMarkdown: Bool

    public var lineCount: Int {
        guard !text.isEmpty else { return 0 }
        let separators = text.reduce(0) { $0 + ($1.isNewline ? 1 : 0) }
        return separators + (text.last?.isNewline == true ? 0 : 1)
    }

    public init?(data: Data, fileName: String) {
        let name = AttachmentLink.fileName(inPath: fileName)
        let ext = (name as NSString).pathExtension.lowercased()
        guard !Self.nonTextExtensions.contains(ext),
              AttachmentLink.fileExtension(sniffing: data) == nil else { return nil }

        let decoded: String?
        if data.starts(with: [0xEF, 0xBB, 0xBF]) {
            decoded = String(data: data.dropFirst(3), encoding: .utf8)
        } else if data.starts(with: [0xFF, 0xFE]) {
            guard data.count.isMultiple(of: 2) else { return nil }
            decoded = String(data: data.dropFirst(2), encoding: .utf16LittleEndian)
        } else if data.starts(with: [0xFE, 0xFF]) {
            guard data.count.isMultiple(of: 2) else { return nil }
            decoded = String(data: data.dropFirst(2), encoding: .utf16BigEndian)
        } else {
            decoded = String(data: data, encoding: .utf8)
        }
        guard let decoded, !decoded.unicodeScalars.contains(where: { scalar in
            switch scalar.value {
            case 0x00...0x08, 0x0E...0x1F, 0x7F...0x84, 0x86...0x9F: true
            default: false
            }
        }) else { return nil }

        text = decoded
        isMarkdown = ["md", "markdown", "mdown", "mkd", "mkdn"].contains(ext)
    }

    // Some binary containers have an ASCII header, so UTF-8 decoding alone is not enough.
    private static let nonTextExtensions: Set<String> = [
        "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "pages", "numbers", "key",
        "odt", "ods", "odp", "rtf", "rtfd", "epub",
        "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar", "dmg", "iso",
        "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "tif", "tiff", "ico", "avif",
        "mp3", "m4a", "aac", "wav", "aiff", "flac", "ogg", "mp4", "m4v", "mov", "avi", "mkv", "webm",
        "woff", "woff2", "ttf", "otf", "exe", "dll", "so", "dylib", "sqlite", "db",
    ]
}
