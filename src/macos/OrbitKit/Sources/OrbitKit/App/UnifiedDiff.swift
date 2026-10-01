import Foundation

/// One file of a unified diff: where it is, what happened to it, its `+/−` (both -1 for a binary
/// file, as the bar's changed-file list reads them) and its own slice of the patch.
public struct UnifiedDiffFile: Equatable, Sendable, Identifiable {
    public let path: String
    /// "M", "A", "D" or "R" — the letter the bar's diff list colours.
    public let status: String
    public let additions: Int
    public let deletions: Int
    public let patch: String
    public var id: String { path }
}

/// Splits one `git diff` — a merge recovery's complete candidate diff — into its files, so the
/// review sheet can list it the way the branch bar lists the session's own changes.
public enum UnifiedDiff {
    public static func files(_ patch: String) -> [UnifiedDiffFile] {
        var files: [UnifiedDiffFile] = []
        var lines: [Substring] = []
        func flush() {
            if let file = file(lines) { files.append(file) }
            lines = []
        }
        for line in patch.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("diff --git ") { flush() }
            // Anything before the first file header isn't part of a file.
            if line.hasPrefix("diff --git ") || !lines.isEmpty { lines.append(line) }
        }
        flush()
        return files
    }

    private static func file(_ lines: [Substring]) -> UnifiedDiffFile? {
        var lines = lines
        while lines.count > 1, lines.last?.isEmpty == true { lines.removeLast() }
        guard let header = lines.first else { return nil }
        var newPath: String?, oldPath: String?, renamedTo: String?
        var status = "M", additions = 0, deletions = 0, binary = false, inHunk = false
        for line in lines.dropFirst() {
            if line.hasPrefix("@@") { inHunk = true; continue }
            // Inside a hunk every line is content: a removed line can start `---` and is still a removal.
            if inHunk {
                if line.hasPrefix("+") { additions += 1 } else if line.hasPrefix("-") { deletions += 1 }
                continue
            }
            if line.hasPrefix("new file mode") { status = "A" }
            else if line.hasPrefix("deleted file mode") { status = "D" }
            else if line.hasPrefix("rename to ") { status = "R"; renamedTo = String(line.dropFirst("rename to ".count)) }
            else if line.hasPrefix("+++ ") { newPath = side(line.dropFirst(4), prefix: "b/") }
            else if line.hasPrefix("--- ") { oldPath = side(line.dropFirst(4), prefix: "a/") }
            else if line.hasPrefix("Binary files ") || line.hasPrefix("GIT binary patch") { binary = true }
        }
        let fromHeader = header.range(of: " b/", options: .backwards).map { String(header[$0.upperBound...]) }
        guard let path = newPath ?? renamedTo ?? oldPath ?? fromHeader else { return nil }
        return UnifiedDiffFile(path: path, status: status,
                               additions: binary ? -1 : additions, deletions: binary ? -1 : deletions,
                               patch: lines.joined(separator: "\n"))
    }

    /// `b/src/x.ts` → `src/x.ts`; `/dev/null` (the side a new or deleted file doesn't have) → nil.
    private static func side(_ raw: Substring, prefix: String) -> String? {
        var path = String(raw).trimmingCharacters(in: CharacterSet(charactersIn: "\t"))
        if path.count >= 2, path.hasPrefix("\""), path.hasSuffix("\"") { path = String(path.dropFirst().dropLast()) }
        if path == "/dev/null" { return nil }
        return path.hasPrefix(prefix) ? String(path.dropFirst(prefix.count)) : path
    }
}
